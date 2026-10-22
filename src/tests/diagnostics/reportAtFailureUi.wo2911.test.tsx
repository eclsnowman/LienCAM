// @vitest-environment jsdom
// WO-2911: "Report this problem" at the failure, driven through the real
// console, error screens and report dialog. The picture source is stubbed
// (jsdom draws no canvas); everything else is the production code.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import type { Operation, Tool } from '../../types'
import { typedMock } from '../support/typedMock'

const seed = vi.hoisted(() => ({
  saved: [] as Blob[],
  captures: 0,
  // When set, each picture waits until the test resolves it (out-of-order clicks).
  defer: false,
  pending: [] as Array<() => void>,
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 6, 0x90, 0, 0, 3, 0xd3, 8, 6, 0, 0, 0]),
}))

vi.mock('../../lib/diagnostics/capture', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/diagnostics/capture')>()
  return typedMock<typeof import('../../lib/diagnostics/capture')>({
    ...real,
    captureApp: async (askBrowser: boolean) => {
      seed.captures += 1
      if (seed.defer) await new Promise<void>((resolve) => seed.pending.push(resolve))
      return { ok: true, capture: { bytes: seed.png, kind: askBrowser ? 'browser-tab' : 'view-only', width: 1680, height: 979, takenAt: Date.now() }, skipped: null }
    },
  })
})
vi.mock('../../lib/saveFile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/saveFile')>()
  return typedMock<typeof import('../../lib/saveFile')>({
    ...real,
    saveFile: async (_name: string, contents: string | Blob) => { seed.saved.push(contents as Blob); return 'download' },
  })
})

import { ReportProblemModal, useReportProblem } from '../../components/modals/ReportProblemModal'
import { BottomConsole } from '../../components/panels/BottomConsole'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { ViewportErrorBoundary } from '../../components/viewport/ViewportErrorBoundary'
import { diagnosticHistory } from '../../lib/diagnostics'
import { useCamStore } from '../../store'

// jsdom has no object URLs; the preview only needs a string for <img src>.
Object.assign(URL, { createObjectURL: () => 'blob:report-image', revokeObjectURL: () => {} })

const OP = {
  id: 'op-1', name: 'Bracket pocket', type: 'pocket_2d', enabled: true, status: 'ready', toolId: 'tool-1',
  geometrySelections: [], params: {}, heights: {},
  passes: { stepdown: 1.5, stepover: 3, stockToLeave: 0.2, finishPasses: 1, springPasses: 0 },
  linking: { entryType: 'ramp_helical', rampAngle: 2, rampLength: 0, leadInRadius: 1, leadOutRadius: 1, retractType: 'minimum', transitionType: 'safe_height' },
} as unknown as Operation
const TOOL = { id: 'tool-1', name: '60mm', type: 'flat_endmill', diameter: 60, fluteLength: 20, numberOfFlutes: 3 } as unknown as Tool
const REFUSAL = '"Bracket pocket": region 1 of 1 stopped early because there was nothing left to cut; the 0 pass(es) planned before that are kept.'

beforeEach(async () => {
  await diagnosticHistory().whenReady()
  const cam = useCamStore.getState()
  const setup = cam.project.setups[0] ?? ({ id: 'setup-1', name: 'Setup 1' } as (typeof cam.project.setups)[number])
  useCamStore.setState({
    project: { ...cam.project, activeOperationId: null, setups: [{ ...setup, name: 'Setup 1', operations: [OP] }] },
    toolLibrary: [TOOL], consoleEvents: [], consoleReadThroughId: 0,
  })
  useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'project', message: 'Project opened: Bracket' })
  useCamStore.getState().addConsoleEvent({ severity: 'warning', source: 'toolpath', message: REFUSAL, entityRef: { kind: 'op', id: OP.id } })
  seed.captures = 0
  seed.defer = false
  seed.pending = []
})

afterEach(() => {
  cleanup()
  useReportProblem.setState({ open: false, failure: null, capture: null })
})

const check = (id: string) => screen.getByTestId(`report-problem-check-${id}`) as HTMLInputElement
const previewOf = (name: string) => screen.queryByTestId(`report-problem-file-preview-${name}`)
const events = () => useCamStore.getState().consoleEvents

async function reportFromConsole() {
  render(<><BottomConsole defaultExpanded /><ReportProblemModal /></>)
  const warning = events().find((e) => e.severity === 'warning')!
  await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${warning.id}`)) })
  await waitFor(() => expect(previewOf('reproduction.md')).not.toBeNull())
}

async function savedZip(): Promise<Record<string, Uint8Array>> {
  seed.saved.length = 0
  await waitFor(() => expect((screen.getByTestId('report-problem-save') as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(screen.getByTestId('report-problem-save')) })
  await waitFor(() => expect(seed.saved).toHaveLength(1))
  return unzipSync(new Uint8Array(await seed.saved[0].arrayBuffer()))
}

describe('WO-2911 report at a console line', () => {
  it('only warning and error lines carry the action, and clicking it selects nothing', async () => {
    render(<BottomConsole defaultExpanded />)
    const [info, warning] = events()
    expect(screen.queryByTestId(`console-report-${info.id}`)).toBeNull()
    expect(screen.getByTestId(`console-report-${warning.id}`)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${warning.id}`)) })
    // The row's own click (select the operation) did not run: no accidental Apply.
    expect(useCamStore.getState().project.activeOperationId).toBeNull()
  })

  it('opens the report prefilled with what failed, the steps, the settings, the console lines and the picture', async () => {
    await reportFromConsole()
    expect(screen.getByTestId('report-problem-failure-text').textContent).toBe(REFUSAL)
    expect((screen.getByTestId('report-problem-actual') as HTMLTextAreaElement).value).toContain(REFUSAL)
    expect((screen.getByTestId('report-problem-steps') as HTMLTextAreaElement).value).toContain('select the operation "Bracket pocket" (pocket_2d)')
    for (const id of ['reproduction', 'consoleTail', 'operationSettings', 'appImage']) expect(check(id).checked, id).toBe(true)
    expect(check('currentProject').checked).toBe(false)
    expect(seed.captures).toBe(1)
    expect(screen.getByTestId('report-problem-capture-kind').textContent).toContain('3D view only')
    // The incident is this session's, not an earlier one.
    expect((screen.getByTestId('report-problem-incident') as HTMLSelectElement).value).toBe(diagnosticHistory().currentSessionId)
  })

  it('what the operator types is what reproduction.md holds, and Save writes the previewed bytes', async () => {
    await reportFromConsole()
    fireEvent.change(screen.getByTestId('report-problem-expected'), { target: { value: 'A pocket toolpath with passes' } })
    await waitFor(() => expect(previewOf('reproduction.md')?.textContent).toContain('A pocket toolpath with passes'))
    const files = await savedZip()
    expect(Object.keys(files).sort()).toEqual([
      'README.txt', 'app-image.png', 'app-versions.json', 'console-tail.txt', 'environment.json', 'events.jsonl',
      'manifest.json', 'operation-settings.json', 'reproduction.md',
    ])
    const md = strFromU8(files['reproduction.md'])
    expect(md).toContain('## Expected\nA pocket toolpath with passes')
    expect(md).toContain('Error text, exactly as shown:\n\n```text\n' + REFUSAL + '\n```')
    expect(strFromU8(files['console-tail.txt'])).toContain(`warning toolpath: ${REFUSAL}`)
    expect(JSON.parse(strFromU8(files['operation-settings.json'])).tool.diameter).toBe(60)
  })

  it('the picture comes first in reproduction.md, and the GitHub step says to drag it in (owner ask 10-17)', async () => {
    await reportFromConsole()
    const md = strFromU8((await savedZip())['reproduction.md'])
    expect(md).toContain('## What it looked like\n\n![The app when this was reported](app-image.png)\n\n- 3D view only')
    expect(md.indexOf('## What it looked like')).toBeLessThan(md.indexOf('## What failed'))
    fireEvent.click(screen.getByTestId('report-problem-github'))
    expect(screen.getByTestId('report-problem-prefill-image').textContent).toContain('drag app-image.png from the saved ZIP')
    fireEvent.click(screen.getByTestId('report-problem-remove-image'))
    await waitFor(() => expect(previewOf('app-image.png')).toBeNull())
    expect(strFromU8((await savedZip())['reproduction.md'])).not.toContain('## What it looked like')
  })

  it('Remove picture takes the image out before anything is saved', async () => {
    await reportFromConsole()
    expect(previewOf('app-image.png')).not.toBeNull()
    fireEvent.click(screen.getByTestId('report-problem-remove-image'))
    await waitFor(() => expect(previewOf('app-image.png')).toBeNull())
    expect(check('appImage').checked).toBe(false)
    expect(Object.keys(await savedZip())).not.toContain('app-image.png')
  })

  it('Capture the app takes a new picture with the dialog hidden', async () => {
    await reportFromConsole()
    fireEvent.click(screen.getByTestId('report-problem-remove-image'))
    await act(async () => { fireEvent.click(screen.getByTestId('report-problem-capture')) })
    await waitFor(() => expect(screen.getByTestId('report-problem-capture-kind').textContent).toContain('whole app tab'))
    expect(seed.captures).toBe(2)
    expect(screen.getByTestId('report-problem-backdrop').style.visibility).toBe('')
  })

  it('a stale picture says the project changed after it was taken', async () => {
    await reportFromConsole()
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, name: 'Changed' } })) })
    fireEvent.click(screen.getByTestId('report-problem-read-again'))
    await waitFor(() => expect(screen.getByTestId('report-problem-capture-stale')).toBeTruthy())
  })

  it('choosing another incident drops the failure, its picture and its description', async () => {
    const h = diagnosticHistory()
    await reportFromConsole()
    const incident = screen.getByTestId('report-problem-incident') as HTMLSelectElement
    const other = Array.from(incident.options).map((o) => o.value).find((v) => v !== h.currentSessionId)
    if (!other) return // one session only in this run: nothing to switch to
    fireEvent.change(incident, { target: { value: other } })
    await waitFor(() => expect(screen.queryByTestId('report-problem-failure')).toBeNull())
    expect(previewOf('app-image.png')).toBeNull()
    expect((screen.getByTestId('report-problem-actual') as HTMLTextAreaElement).value).toBe('')
  })

  it('closing drops the failure and picture; the next Help report starts clean', async () => {
    await reportFromConsole()
    fireEvent.click(screen.getByTestId('report-problem-close'))
    expect(useReportProblem.getState()).toMatchObject({ open: false, failure: null, capture: null })
  })

  it('the newest report always wins: an older picture finishing later never replaces it or its typed text (audit 1)', async () => {
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'model', message: 'Fillet refused: edge 4 is too short' })
    seed.defer = true
    render(<><BottomConsole defaultExpanded /><ReportProblemModal /></>)
    const [older, newer] = events().filter((e) => e.severity !== 'info')
    await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${older.id}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${newer.id}`)) })
    expect(seed.pending).toHaveLength(2)
    await act(async () => { seed.pending[1]() })
    await waitFor(() => expect(screen.getByTestId('report-problem-failure-text').textContent).toBe('Fillet refused: edge 4 is too short'))
    fireEvent.change(screen.getByTestId('report-problem-expected'), { target: { value: 'A 2 mm fillet' } })
    await act(async () => { seed.pending[0]() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.getByTestId('report-problem-failure-text').textContent).toBe('Fillet refused: edge 4 is too short')
    expect((screen.getByTestId('report-problem-expected') as HTMLTextAreaElement).value).toBe('A 2 mm fillet')
  })

  it('a picture still being taken never replaces a Help report asked for after it (audit 1)', async () => {
    seed.defer = true
    render(<><BottomConsole defaultExpanded /><ReportProblemModal /></>)
    const warning = events().find((e) => e.severity === 'warning')!
    await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${warning.id}`)) })
    const { openReportProblem } = await import('../../components/modals/ReportProblemModal')
    act(() => { openReportProblem() })
    await waitFor(() => expect(screen.getByTestId('report-problem')).toBeTruthy())
    fireEvent.change(screen.getByTestId('report-problem-expected'), { target: { value: 'typed in Help' } })
    await act(async () => { seed.pending[0]() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByTestId('report-problem-failure')).toBeNull()
    expect((screen.getByTestId('report-problem-expected') as HTMLTextAreaElement).value).toBe('typed in Help')
  })

  it('a Clear while the picture is still being taken ends that failure too (pre-audit)', async () => {
    seed.defer = true
    render(<><BottomConsole defaultExpanded /><ReportProblemModal /></>)
    const warning = events().find((e) => e.severity === 'warning')!
    await act(async () => { fireEvent.click(screen.getByTestId(`console-report-${warning.id}`)) })
    const before = diagnosticHistory().clearGeneration
    await act(async () => { await diagnosticHistory().clear() })
    expect(diagnosticHistory().clearGeneration).not.toBe(before)
    await act(async () => { seed.pending[0]() })
    await waitFor(() => expect(screen.getByTestId('report-problem')).toBeTruthy())
    expect(screen.queryByTestId('report-problem-failure')).toBeNull()
    expect(check('appImage').checked).toBe(false)
    expect((screen.getByTestId('report-problem-actual') as HTMLTextAreaElement).value).toBe('')
  })

  it('Clear clears: the unticked picture and the failure text never come back (audit 2)', async () => {
    await reportFromConsole()
    fireEvent.click(check('appImage'))
    await waitFor(() => expect(previewOf('app-image.png')).toBeNull())
    const before = diagnosticHistory().clearGeneration
    fireEvent.click(screen.getByTestId('report-problem-clear'))
    await act(async () => { fireEvent.click(screen.getByTestId('report-problem-clear-yes')) })
    await waitFor(() => expect(diagnosticHistory().clearGeneration).not.toBe(before))
    await waitFor(() => expect(screen.queryByTestId('report-problem-failure')).toBeNull())
    expect(check('appImage').checked).toBe(false)
    for (const id of ['consoleTail', 'operationSettings', 'currentProject']) expect(check(id).checked, id).toBe(false)
    expect((screen.getByTestId('report-problem-actual') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByTestId('report-problem-steps') as HTMLTextAreaElement).value).toBe('')
    const files = await savedZip()
    expect(Object.keys(files)).not.toContain('app-image.png')
    expect(strFromU8(files['reproduction.md'])).not.toContain('nothing left to cut')
  })

  it('personal paths in the console lines are listed and can be hidden from console-tail.txt', async () => {
    useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'project', message: 'Could not read C:\\Users\\jdoe\\parts\\bracket.step' })
    await reportFromConsole()
    await waitFor(() => expect(screen.getByTestId('report-problem-private').textContent).toContain('C:\\Users\\jdoe\\parts\\bracket.step'))
    fireEvent.click(screen.getByTestId('report-problem-hide-private'))
    await waitFor(() => expect(screen.getByTestId('report-problem-private').textContent).toContain('(hidden)'))
    const tail = strFromU8((await savedZip())['console-tail.txt'])
    expect(tail).not.toContain('jdoe')
    expect(tail).toContain('<path removed>')
  })
})

function Boom({ message }: { message: string }): never { throw new Error(message) }

describe('WO-2911 report at an error screen', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.mocked(console.error).mockRestore() })

  it('the app error screen reports its error without reloading, and records where it failed', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    const before = diagnosticHistory().snapshot(diagnosticHistory().currentSessionId)!.events.length
    render(<ErrorBoundary><Boom message="Cannot read properties of undefined (reading 'setups')" /></ErrorBoundary>)
    await act(async () => { fireEvent.click(screen.getByTestId('app-error-boundary-report')) })
    await waitFor(() => expect(screen.getByTestId('report-problem-failure-text').textContent).toBe("Cannot read properties of undefined (reading 'setups')"))
    expect(reload).not.toHaveBeenCalled()
    const after = diagnosticHistory().snapshot(diagnosticHistory().currentSessionId)!.events
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)!.code).toBe('renderer.uncaught-error')
    expect(after.at(-1)!.fields).toMatchObject({ kind: 'boundary' })
  })

  it('the 3D view error screen reports its error with Retry not needed first', async () => {
    render(<><ViewportErrorBoundary><Boom message="WebGL context lost" /></ViewportErrorBoundary><ReportProblemModal /></>)
    await act(async () => { fireEvent.click(screen.getByTestId('viewport-error-boundary-report')) })
    await waitFor(() => expect(screen.getByTestId('report-problem-failure-text').textContent).toBe('WebGL context lost'))
    expect(screen.getByTestId('viewport-error-boundary')).toBeTruthy()
    expect((screen.getByTestId('report-problem-steps') as HTMLTextAreaElement).value).toContain('The error screen shows: WebGL context lost')
  })
})

describe('WO-2911 picture sources (the real capture module)', () => {
  const real = () => vi.importActual<typeof import('../../lib/diagnostics/capture')>('../../lib/diagnostics/capture')
  const g = globalThis as { liencamHost?: unknown }
  afterEach(() => { delete g.liencamHost; Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }) })

  it('the desktop window capture comes first and needs no prompt', async () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true })
    g.liencamHost = { captureApp: async () => seed.png }
    const result = await (await real()).captureApp(true)
    expect(result).toMatchObject({ ok: true, capture: { kind: 'app-window', width: 1680, height: 979 }, skipped: null })
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it('a report opened from a console line never raises the browser share prompt', async () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true })
    const result = await (await real()).captureApp(false)
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(result.ok).toBe(false) // jsdom has no 3D view canvas: an honest "no picture", not a substitute
  })

  it('a share granted after the timeout is stopped at once: every track ends, no picture is taken (audit round 2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stop = [vi.fn(), vi.fn()]
      let grant: (stream: MediaStream) => void = () => {}
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getDisplayMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve })) }, configurable: true,
      })
      const pending = (await real()).captureApp(true)
      await vi.advanceTimersByTimeAsync(8_001)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.ok ? null : result.reason).toContain('timed out')
      grant({ getTracks: () => stop.map((fn) => ({ stop: fn })) } as unknown as MediaStream)
      await vi.advanceTimersByTimeAsync(0)
      for (const fn of stop) expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a share granted after the report was closed is stopped at once and nothing is drawn (pre-audit, round 2)', async () => {
    const stop = vi.fn()
    let grant: (stream: MediaStream) => void = () => {}
    const getDisplayMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true })
    const createElement = vi.spyOn(document, 'createElement')
    let wanted = true
    const pending = (await real()).captureApp(true, () => wanted)
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalled())
    wanted = false // the operator closed the report while the share prompt was open
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    const result = await pending
    expect(stop).toHaveBeenCalledTimes(1)
    expect(createElement.mock.calls.map(([tag]) => tag)).not.toContain('video')
    expect(result.ok ? null : result.reason).toContain('cancelled')
    createElement.mockRestore()
  })

  it('a declined share prompt is reported, never relabelled', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(async () => { throw new Error('Permission denied') }) }, configurable: true,
    })
    const result = await (await real()).captureApp(true)
    expect(result).toEqual({ ok: false, reason: 'Permission denied' })
  })
})
