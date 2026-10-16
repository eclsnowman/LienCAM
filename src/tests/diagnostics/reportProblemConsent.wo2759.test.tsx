// @vitest-environment jsdom
// WO-2759 fix round (astra audit, 2026-10-13): the report dialog's consent
// sequences, driven through the real dialog. Design sections 2, 3 and 5:
// - Clear (here or in another tab) ends the pending report: no chosen file,
//   choice or frozen copy from before it survives into Save.
// - No consent carries to a new incident: changing it returns every choice to
//   its default and drops chosen files.
// - Optional, off-by-default data is read only once its box is ticked.
//
// Order matters: the first two tests use the seeded earlier session, which the
// Clear tests remove.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import type { Operation, Tool } from '../../types'
import { typedMock } from '../support/typedMock'

const seed = vi.hoisted(() => ({
  olderId: 'earlier-session-0001',
  reads: { precise: 0, settings: 0 },
  saved: [] as Blob[],
}))

// An earlier session holding a failure, so there are two incidents to choose.
vi.mock('../../lib/diagnostics/history', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/diagnostics/history')>()
  class SeededStorage extends real.MemoryHistoryStorage {
    constructor() {
      super()
      const at = Date.now() - 60_000
      this.records.set(seed.olderId, {
        id: seed.olderId, startedAt: at, eventAt: [at], endedCleanly: true, dropped: 0, lastSeq: 1, generation: 0,
        omissions: { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 },
        events: [{ v: 1, code: 'machine.alarm', seq: 1, t: 0, fields: { code: 2, positionLost: false } }],
      })
    }
  }
  return typedMock<typeof import('../../lib/diagnostics/history')>({ ...real, MemoryHistoryStorage: SeededStorage })
})

// Count every read of an optional category's data.
vi.mock('../../lib/diagnostics/sources', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/diagnostics/sources')>()
  return typedMock<typeof import('../../lib/diagnostics/sources')>({
    ...real,
    probeBasicEnvironment: () => ({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', deviceMemory: 8, devicePixelRatio: 1, gpu: { vendor: 'NVIDIA', renderer: 'RTX 3060' },
    }),
    probePreciseEnvironment: () => ({
      deviceMemory: 8, devicePixelRatio: 1, hardwareConcurrency: 8, screen: { width: 1920, height: 1080 }, gpu: { vendor: 'NVIDIA', renderer: 'RTX 3060' },
    }),
    preciseEnvironment: (...args: Parameters<typeof real.preciseEnvironment>) => { seed.reads.precise += 1; return real.preciseEnvironment(...args) },
    operationSettings: (...args: Parameters<typeof real.operationSettings>) => { seed.reads.settings += 1; return real.operationSettings(...args) },
  })
})

vi.mock('../../lib/saveFile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/saveFile')>()
  return typedMock<typeof import('../../lib/saveFile')>({
    ...real,
    saveFile: async (_name: string, contents: string | Blob) => { seed.saved.push(contents as Blob); return 'download' },
  })
})

import { ReportProblemModal, openReportProblem, useReportProblem } from '../../components/modals/ReportProblemModal'
import { diagnosticHistory } from '../../lib/diagnostics'
import { useCamStore } from '../../store'

const OP = {
  id: 'op-1', name: 'Bracket', type: 'pocket_2d', enabled: true, status: 'ready', toolId: 'tool-1',
  geometrySelections: [], params: {}, heights: {},
  passes: { stepdown: 1.5, stepover: 3, stockToLeave: 0.2, finishPasses: 1, springPasses: 0 },
  linking: { entryType: 'ramp_helical', rampAngle: 2, rampLength: 0, leadInRadius: 1, leadOutRadius: 1, retractType: 'minimum', transitionType: 'safe_height' },
} as unknown as Operation
const TOOL = { id: 'tool-1', name: '6mm', type: 'flat_endmill', diameter: 6, fluteLength: 20, numberOfFlutes: 3 } as unknown as Tool

function selectOperation() {
  const cam = useCamStore.getState()
  const setup = cam.project.setups[0] ?? ({ id: 'setup-1' } as (typeof cam.project.setups)[number])
  useCamStore.setState({
    project: { ...cam.project, activeOperationId: OP.id, setups: [{ ...setup, operations: [OP] }] },
    toolLibrary: [TOOL],
  })
}

afterEach(() => {
  cleanup()
  useReportProblem.setState({ open: false })
})

const check = (id: string) => screen.getByTestId(`report-problem-check-${id}`) as HTMLInputElement
const previewOf = (name: string) => screen.queryByTestId(`report-problem-file-preview-${name}`)

async function openDialog() {
  await diagnosticHistory().whenReady()
  render(<ReportProblemModal />)
  act(() => openReportProblem())
  await waitFor(() => expect(previewOf('manifest.json')).not.toBeNull())
}

async function chooseProgram() {
  if (!check('originalProgram').checked) fireEvent.click(check('originalProgram'))
  const input = screen.getByTestId('report-problem-file-program')
  const file = new File(['(Customer job)\nG21\nG1 X10 Y20 F500\n'], 'job.nc', { type: 'text/plain' })
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
  await waitFor(() => expect(previewOf('program.nc')).not.toBeNull())
}

/** Let an async state change settle, then wait for the rebuilt preview. */
async function settled() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  await waitFor(() => expect(previewOf('manifest.json')).not.toBeNull())
}

async function savedEntries(): Promise<string[]> {
  seed.saved.length = 0
  await act(async () => { fireEvent.click(screen.getByTestId('report-problem-save')) })
  await waitFor(() => expect(seed.saved).toHaveLength(1))
  return Object.keys(unzipSync(new Uint8Array(await seed.saved[0].arrayBuffer()))).sort()
}

describe('WO-2759 report consent (audit fix round)', () => {
  it('changing the incident resets every choice and drops chosen files', async () => {
    selectOperation()
    await openDialog()
    const incident = screen.getByTestId('report-problem-incident') as HTMLSelectElement
    expect(incident.value).toBe(seed.olderId)
    await chooseProgram()
    fireEvent.click(check('preciseEnvironment'))
    fireEvent.click(check('operationSettings'))
    await waitFor(() => expect(previewOf('operation-settings.json')).not.toBeNull())

    fireEvent.change(incident, { target: { value: diagnosticHistory().currentSessionId } })
    await settled()

    expect(check('originalProgram').checked).toBe(false)
    expect(check('preciseEnvironment').checked).toBe(false)
    expect(check('operationSettings').checked).toBe(false)
    // Ticking the file box again shows no file carried over from the old incident.
    fireEvent.click(check('originalProgram'))
    await settled()
    expect(previewOf('program.nc')).toBeNull()
    expect(await savedEntries()).not.toContain('program.nc')
  })

  it('off-by-default data is read only after its box is ticked', async () => {
    selectOperation()
    seed.reads.precise = 0
    seed.reads.settings = 0
    await openDialog()
    expect(check('operationSettings').disabled).toBe(false)
    expect(seed.reads).toEqual({ precise: 0, settings: 0 })

    fireEvent.click(check('operationSettings'))
    await waitFor(() => expect(previewOf('operation-settings.json')).not.toBeNull())
    expect(seed.reads.settings).toBeGreaterThan(0)
    expect(seed.reads.precise).toBe(0)

    fireEvent.click(check('preciseEnvironment'))
    await waitFor(() => expect(previewOf('environment-precise.json')).not.toBeNull())
    expect(seed.reads.precise).toBeGreaterThan(0)
  })

  it('Clear drops the pending report: chosen file, its consent and the frozen events', async () => {
    diagnosticHistory().record('machine.state', { state: 'idle' })
    await openDialog()
    await chooseProgram()

    fireEvent.click(screen.getByTestId('report-problem-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('report-problem-clear-yes')) })
    await settled()

    expect(check('originalProgram').checked).toBe(false)
    expect(previewOf('program.nc')).toBeNull()
    expect(await savedEntries()).not.toContain('program.nc')
  })

  it('Clear in another tab drops this tab\'s pending report too', async () => {
    diagnosticHistory().record('machine.state', { state: 'idle' })
    await openDialog()
    await chooseProgram()
    const events = screen.getByTestId('report-problem-events').textContent

    // What the other tab's broadcast does here (index.ts clear channel).
    await act(async () => { await diagnosticHistory().clear() })
    await settled()

    expect(check('originalProgram').checked).toBe(false)
    expect(previewOf('program.nc')).toBeNull()
    expect(screen.getByTestId('report-problem-events').textContent).not.toBe(events)
    expect(await savedEntries()).not.toContain('program.nc')
  })
})
