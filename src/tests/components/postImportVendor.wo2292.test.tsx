// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vendorJob } from '../post/fixtures/wo2292/job'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { useCamStore } = await import('../../store')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { syncUserPostControllers, postProject, UCCNC_CONFIG } = await import('../../lib/post')

beforeEach(() => {
  // Keep LCX1's generatedAt timestamp deterministic for byte-identical preview checks.
  vi.spyOn(Date, 'now').mockReturnValue(1790848000000)
  memory.clear(); syncUserPostControllers([])
  const project = vendorJob()
  act(() => useCamStore.setState({ project, toolLibrary: project.toolLibrary, consoleEvents: [], activeModal: null,
    appSettings: { ...useCamStore.getState().appSettings, exportUnits: 'mm' } }))
})
afterEach(() => { cleanup(); syncUserPostControllers([]); vi.restoreAllMocks() })

function pickPost(id: string) {
  fireEvent.click(screen.getByTestId('post-definition-select'))
  fireEvent.click(screen.getByTestId(`post-definition-select-option-${id}`))
}

async function importFixture(name: string) {
  const source = readFileSync(`src/tests/post/fixtures/wo2292/${name}`, 'utf8')
  await act(async () => {
    fireEvent.change(screen.getByTestId('post-import-input'), {
      target: { files: [{ name, size: source.length, text: async () => source }] },
    })
  })
  const [saved] = JSON.parse(memory.get('liencam.userPosts')!)
  return saved
}

function expectUnits(units: 'mm' | 'inch') {
  if (screen.getByTestId('disclosure-output-format').getAttribute('aria-expanded') === 'false') {
    fireEvent.click(screen.getByTestId('disclosure-output-format'))
  }
  expect((document.querySelector(`input[name="post-export-units"][value="${units}"]`) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByTestId('post-gcode-preview').textContent).toContain(units === 'mm' ? 'G21' : 'G20')
}

describe('WO-2292 production Import Post button', () => {
  for (const name of ['router-inch.pp', 'router-inch.cps']) {
    it(`restores built-in output after importing, selecting and reopening ${name}`, async () => {
      render(<PostProcessModal />)
      act(() => useCamStore.getState().openModal('post-process'))
      expectUnits('mm')
      const baseline = screen.getByTestId('post-gcode-preview').textContent
      const saved = await importFixture(name)
      expectUnits('inch')
      pickPost(UCCNC_CONFIG.id)
      expectUnits('mm')
      expect(screen.getByTestId('post-gcode-preview').textContent).toBe(baseline)
      pickPost(saved.id)
      expectUnits('inch')
      act(() => useCamStore.getState().closeModal())
      act(() => useCamStore.getState().openModal('post-process'))
      expect(screen.getByTestId('post-definition-select').textContent).toContain(UCCNC_CONFIG.label)
      expectUnits('mm')
      expect(screen.getByTestId('post-gcode-preview').textContent).toBe(baseline)
      expect(useCamStore.getState().appSettings.exportUnits).toBe('mm')
    })
  }

  for (const units of ['mm', 'inch'] as const) {
    it(`preserves an explicit built-in ${units} override through a vendor selection`, async () => {
      const globalUnits = units === 'mm' ? 'inch' : 'mm'
      act(() => useCamStore.setState({ appSettings: { ...useCamStore.getState().appSettings, exportUnits: globalUnits } }))
      render(<PostProcessModal />)
      act(() => useCamStore.getState().openModal('post-process'))
      expectUnits(globalUnits)
      fireEvent.click(document.querySelector(`input[name="post-export-units"][value="${units}"]`)!)
      expectUnits(units)
      const baseline = screen.getByTestId('post-gcode-preview').textContent
      await importFixture(`router-${globalUnits}.pp`)
      expectUnits(globalUnits)
      pickPost(UCCNC_CONFIG.id)
      expectUnits(units)
      expect(screen.getByTestId('post-gcode-preview').textContent).toBe(baseline)
      act(() => useCamStore.getState().closeModal())
      act(() => useCamStore.getState().openModal('post-process'))
      expectUnits(units)
      expect(useCamStore.getState().appSettings.exportUnits).toBe(globalUnits)
    })
  }

  for (const name of ['router-mm.pp', 'router-inch.pp', 'router-mm.cps', 'router-inch.cps']) {
    it(`saves, selects, reports and previews ${name}`, async () => {
      render(<PostProcessModal />)
      act(() => useCamStore.getState().openModal('post-process'))
      const input = screen.getByTestId('post-import-input') as HTMLInputElement
      fireEvent.click(screen.getByRole('button', { name: 'Import Post...' }))
      const source = readFileSync(`src/tests/post/fixtures/wo2292/${name}`, 'utf8')
      await act(async () => { fireEvent.change(input, { target: { files: [{ name, size: source.length, text: async () => source }] } }) })
      await waitFor(() => expect(JSON.parse(memory.get('liencam.userPosts') ?? '[]')).toHaveLength(1))
      expect(input.accept).toContain('.pp')
      expect(input.accept).toContain('.cps')
      const [saved] = JSON.parse(memory.get('liencam.userPosts')!)
      expect(saved.builtin).toBe(false)
      expect(screen.getByTestId('post-definition-select').textContent).toContain(saved.label)
      expect(screen.getByTestId('post-delete-custom')).not.toBeNull()
      const events = useCamStore.getState().consoleEvents
      expect(events.some((e) => e.message.startsWith('Mapped'))).toBe(true)
      expect(events.some((e) => e.message.startsWith('Defaulted'))).toBe(true)
      expect(events.some((e) => e.severity === 'error')).toBe(false)
      if (name.includes('-mm')) expect(events.some((e) => e.message.startsWith('Not supported:'))).toBe(true)
      const job = useCamStore.getState().project
      const result = postProject(job, job.setups, saved, { mode: 'combined', pauseBetweenSetups: false, baseName: 'ui', ext: 'nc' })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      // The modal's live production preview must also retain vendor precision and units.
      await waitFor(() => expect(document.body.textContent).toContain(name.includes('inch') ? 'X1.00049' : 'X25.4123'))
      expect(document.body.textContent).toContain(name.includes('inch') ? 'G20' : 'G21')
      expect(result.combined?.gcode).toContain('FOOTER')
    })
  }
})
