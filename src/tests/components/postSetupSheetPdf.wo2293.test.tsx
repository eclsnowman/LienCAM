// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { buildSetupSheet } from '../../lib/post/setupSheet'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { stockWorldBounds } from '../../store/stockAssignment'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import type { Project, Setup } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(), getItem: (key: string) => mem.get(key) ?? null,
  key: (i: number) => [...mem.keys()][i] ?? null, removeItem: (key: string) => mem.delete(key), setItem: (key: string, value: string) => mem.set(key, String(value)),
} })
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')
let files: { name: string; parts: unknown[]; type: string }[]
let pending: { parts: unknown[]; type: string }
beforeEach(() => {
  files = []
  class CaptureBlob {
    parts: unknown[]; type: string
    constructor(parts: unknown[], options?: { type?: string }) { this.parts = parts; this.type = options?.type ?? '' }
  }
  vi.stubGlobal('Blob', CaptureBlob)
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(blob => { pending = blob; return 'blob:mock' }), revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    files.push({ name: this.download, ...pending })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function clickSheet(project: Project, mode: 'combined' | 'separate') {
  for (const setup of project.setups) for (const op of setup.operations) {
    stampGenerationCurrent(project, setup, op, project.toolLibrary.find(t => t.id === op.toolId)!)
  }
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ project, toolLibrary: project.toolLibrary, consoleEvents: [], consoleReadThroughId: 0 })
  })
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
  const context = screen.getByTestId('post-include-context-row').querySelector('input')!
  if ((context as HTMLInputElement).checked) fireEvent.click(context)
  if (mode === 'separate') {
    fireEvent.click(screen.getByText('All operations').closest('label')!.querySelector('input')!)
    fireEvent.click(screen.getByRole('button', { name: 'Separate files (one per setup)' }))
  }
  const sheet = screen.getByTestId('post-download-setup-sheet')
  expect(sheet.hasAttribute('disabled')).toBe(false)
  fireEvent.click(sheet)
  await waitFor(() => expect(useCamStore.getState().consoleEvents.filter(e => e.source === 'post' && e.severity === 'success')).toHaveLength(1), { timeout: 15000 })
  return useCamStore.getState().consoleEvents.filter(e => e.source === 'post' && e.severity === 'success')[0]
}

async function checkPair(project: Project, setups: Setup[], name: string, result: NonNullable<ReturnType<typeof postProject>['combined']>, index: number) {
  expect(files[index].name).toBe(name.replace(/\.nc$/, '.setup.txt'))
  expect(files[index].type).toBe('text/plain')
  expect(files[index].parts[0]).toBe(await buildSetupSheet(project, setups, UCCNC_CONFIG, result, name, stockWorldBounds))
  expect(files[index + 1].name).toBe(name.replace(/\.nc$/, '.setup.pdf'))
  expect(files[index + 1].type).toBe('application/pdf')
  expect(new TextDecoder().decode(files[index + 1].parts[0] as Uint8Array)).toMatch(/^%PDF-1.4/)
}

describe('WO-2293 real PostProcessModal setup-sheet pair', () => {
  it('Full Suite Setup 1 downloads the real production-generated text/PDF pair', async () => {
    // This snapshot is the store's actual generation of the repository example,
    // recorded by capture.mjs; none of its posted moves are hand-built.
    const project = JSON.parse(gunzipSync(readFileSync('src/tests/evidence/WO-2293/generated-project.json.gz')).toString('utf8')) as Project
    const setup = project.setups[0]
    const event = await clickSheet(project, 'combined')
    expect(files).toHaveLength(2)
    expect(screen.getByTestId('post-download-setup-sheet').getAttribute('data-tooltip')).toBe('Download the setup sheet (text and PDF) for this program')
    const filename = files[0].name.replace(/\.setup\.txt$/, '.nc')
    const posted = postProject(project, [setup], UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: filename.slice(0, -3), ext: 'nc' })
    expect(posted.ok).toBe(true)
    await checkPair(project, [setup], filename, posted.combined!, 0)
    const source = new TextDecoder().decode(files[1].parts[0] as Uint8Array)
    expect(source.match(/\/Subtype \/Form/g)).toHaveLength(3)
    const extractedRows = Array.from(source.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), m => Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')).filter(Boolean)
    expect(extractedRows).toEqual(String(files[0].parts[0]).split('\n').filter(Boolean))
    for (const file of files) expect(event.message).toContain(file.name)
  })

  it('Separate files emits one ordered text/PDF pair per setup and one success line naming all files', async () => {
    const tool = makeTool()
    const setups: Setup[] = [54, 55].map(offset => ({
      id: `s${offset}`, name: `Setup ${offset}`, wcs: makeWcs({ id: `w${offset}`, fixtureOffset: offset, label: `G${offset}` }),
      stock: makeStock(), operations: [makeOp({ id: `op${offset}`, toolId: tool.id })], notes: '',
    }))
    const project = { ...useCamStore.getState().project, name: 'Separate', machine: makeMachine(), toolLibrary: [tool], setups, stocks: [], activeSetupId: null, modelItems: [], geometry: [] } as Project
    const event = await clickSheet(project, 'separate')
    expect(files).toHaveLength(4)
    const posted = postProject(project, setups, UCCNC_CONFIG, { mode: 'separate', pauseBetweenSetups: false, baseName: 'Separate', ext: 'nc' })
    expect(posted.ok).toBe(true)
    for (const [i, file] of posted.files!.entries()) await checkPair(project, [setups[i]], file.filename, file.result, i * 2)
    for (const file of files) expect(event.message).toContain(file.name)
  })
})
