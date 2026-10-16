// @vitest-environment jsdom
// WO-2694: a Face's smart bottom is the model top; the operator can override it.
//
// The operator 2026-10-09: "smart height should be model top, but user over ridable."
//
// The project is the 10-09 newcomer journey's scratch part (origin
// cloud/journey-1009, out/scratch-pocket/Untitled_Project.camproject, saved
// toolpaths stripped): a 100 x 60 x 15 extruded block, Auto Stock 1 with a 1 mm
// Z top allowance, so the part top is WCS Z-1 (WCS Z0 = stock top).
//
//   production New Operation (2D Face, the 6 mm flat, defaults) -> Create
//   -> store.computeOperationToolpath -> REAL toolpathWorker -> postProject(UCCNC)
//
// The only stand-in is the Worker thread (node has none): the stub hands each
// request to the real worker module in-process (WO-2516's harness).
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { Operation } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { UCCNC_CONFIG } = await import('../../lib/post')
const { postProject } = await import('../../lib/post/postProject')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
const { selectStartingHeightPolicy } = await import('../../lib/cam/newOperationHeightDefaults')
const { smartHeightStockBounds, setupProvenStockId } = await import('../../store')

// The Face's stock footprint is read through the viewport's stock box in the
// app; here the same first-class stock evidence stands in (WO-2051's shim).
;(window as unknown as Record<string, unknown>).__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(project.setups[0], project)!)
  },
}

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  location: Location
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = {
  postMessage: (msg) => { deliver?.(msg) }, onmessage: null, location: window.location,
}
class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

const FIXTURE = join(process.cwd(), 'src/tests/evidence/WO-2694/journey-1009-scratch.camproject')
const STOCK_ID = 'stock-derived-migrated'
const TOOL_NAME = '6mm Flat End Mill'
const PART_TOP_MACHINE = 15
const JOURNEY_FACE_ID = 'b1da9442-70d3-44d9-b3c0-b162b9ea69dd'
const OTHER_OPS = {
  adaptive: '21e5509b-da6b-4ed3-91ce-abe93b28dbff',
  contour: '1262da61-9c53-4e7f-b1bc-648ab7fe740f',
  pocket: '89d9ca05-1fa9-442f-a609-6c743a2c3988',
}

/** The journey's saved project, opened through the store's file open. With a
 *  different Z top allowance the file is the one the same journey saves when
 *  the allowance is typed before the setup is added: stock box and the
 *  stock-corner WCS origin both sit that far above the part top. */
async function openJourneyProject(topAllowanceMm: number): Promise<void> {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  if (topAllowanceMm !== 1) {
    const top = PART_TOP_MACHINE + topAllowanceMm
    file.sceneStock.autoStocks.find((item: { id: string }) => item.id === STOCK_ID).autoOffsetZTop = topAllowanceMm
    const stock = file.stocks.find((item: { id: string }) => item.id === STOCK_ID)
    stock.bounds.max.z = top
    stock.bounds.size.z = top - stock.bounds.min.z
    stock.bounds.center.z = (top + stock.bounds.min.z) / 2
    file.setups[0].wcs.origin.z = top
  }
  await act(async () => {
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  })
  act(() => useCamStore.getState().closeModal())
  expect(wcsOriginZ()).toBeCloseTo(PART_TOP_MACHINE + topAllowanceMm, 6)
  expect(smartHeightStockBounds(useCamStore.getState().project, STOCK_ID)!.max.z)
    .toBeCloseTo(PART_TOP_MACHINE + topAllowanceMm, 6)
}

/** Auto Stock 1 > Offset Z top, as the Properties panel edits it. */
function setTopAllowance(mm: number): void {
  act(() => useCamStore.getState().updateAutoStock(STOCK_ID, { autoOffsetZTop: mm }))
  expect(smartHeightStockBounds(useCamStore.getState().project, STOCK_ID)!.max.z)
    .toBeCloseTo(PART_TOP_MACHINE + mm, 6)
}

const setup = () => useCamStore.getState().project.setups[0]
const wcsOriginZ = () => setup().wcs.origin.z
const modelTopWcs = () => PART_TOP_MACHINE - wcsOriginZ()

/** Production New Operation: 2D Face, the 6 mm flat, every height left at its default. */
async function newFace(userBottomWcs?: number): Promise<Operation> {
  render(createElement(NewOperationModal))
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('2D Face'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getAllByText(TOOL_NAME)[0])
  if (userBottomWcs !== undefined) {
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.change(screen.getByTestId('face-height-mode'), { target: { value: 'explicit_depth' } })
    const input = screen.getByTestId('face-explicit-target').querySelector('input')!
    fireEvent.change(input, { target: { value: String(userBottomWcs) } })
    fireEvent.blur(input)
    expect((screen.getByTestId('face-height-mode') as HTMLSelectElement).value).toBe('explicit_depth')
  }
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  await waitFor(() => expect(create.disabled, create.getAttribute('data-tooltip') ?? '').toBe(false))
  const before = setup().operations.length
  fireEvent.click(create)
  const operations = setup().operations
  expect(operations.length).toBe(before + 1)
  cleanup()
  return operations.at(-1)!
}

async function compute(opId: string): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath(setup().id, opId) })
  const op = setup().operations.find(candidate => candidate.id === opId)!
  expect(op.status, op.errorMessage).toBe('ready')
}

/** Post through the real post and return each kept operation's own lines. */
function post(opIds: string[]): Record<string, string[]> {
  const project = useCamStore.getState().project
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2694', ext: 'nc',
    selectedOpIds: { [project.setups[0].id]: opIds },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const lines = result.gcode.split('\n')
  return Object.fromEntries(opIds.map(opId => {
    const span = result.operationSpans!.find(s => s.opId === opId)!
    return [opId, lines.slice(span.startLine - 1, span.endLine)]
  }))
}

/** Lowest Z any posted feed move of the operation reaches (WCS). */
function deepestFeedZ(lines: readonly string[]): number {
  let modal = ''
  let deepest = Infinity
  for (const raw of lines) {
    const line = raw.replace(/\(.*?\)/g, '').trim()
    const g = /\bG0?([0-3])\b/.exec(line)
    if (g) modal = g[1]
    const z = /\bZ(-?[\d.]+)/.exec(line)
    if (z && modal !== '0') deepest = Math.min(deepest, Number(z[1]))
  }
  return deepest
}

const results: Record<string, unknown> = {}
const ORIGINAL_WORKER = globalThis.Worker
const ORIGINAL_SELF = globalThis.self

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
  await ensureClipperReady()
}, 120_000)
afterAll(() => {
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  ;(globalThis as { self: unknown }).self = ORIGINAL_SELF
  console.info('[WO-2694] results', JSON.stringify(results))
})
afterEach(cleanup)

describe('WO-2694: a new Face with smart heights stops at the model top', () => {
  it('(a) Auto Stock top allowance 1 mm: the posted Face never goes below the part top', async () => {
    await openJourneyProject(1)
    expect(modelTopWcs()).toBeCloseTo(-1, 6)
    const face = await newFace()
    await compute(face.id)
    const deepest = deepestFeedZ(post([face.id])[face.id])
    results.a = deepest
    expect(deepest).toBeCloseTo(-1, 3)
    // The bottom is the model top the policy owns (re-read on every compute),
    // not a number written into the operation.
    expect(face.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { machining: { end: {
      owner: { kind: 'operation_policy' },
      value: { kind: 'bounded_plane', plane: { reference: 'model_top', offsetMm: 0 } },
    } } } })
  }, 300_000)

  it('(b) the default allowance (5 mm): the Face ends at the model top, and still does after the allowance is edited', async () => {
    await openJourneyProject(5)
    expect(modelTopWcs()).toBeCloseTo(-5, 6)
    const face = await newFace()
    await compute(face.id)
    const deepest = deepestFeedZ(post([face.id])[face.id])
    results.b = deepest
    expect(deepest).toBeCloseTo(-5, 3)

    // The operator lowers the allowance afterwards and regenerates: the Face
    // still ends at the model top in whatever WCS the setup now has.
    setTopAllowance(1)
    await compute(face.id)
    const after = deepestFeedZ(post([face.id])[face.id])
    results.bAfterAllowance1 = { deepest: after, modelTopWcs: modelTopWcs() }
    expect(after).toBeCloseTo(modelTopWcs(), 3)
  }, 300_000)

  it('starting policy: a model in the stock makes the smart end ready; no model still asks', () => {
    expect(selectStartingHeightPolicy('face', { hasSetupStock: true, hasModelTop: true }))
      .toEqual({ operationType: 'face', variant: 'explicit_depth', ready: true, basis: 'geometry' })
    expect(selectStartingHeightPolicy('face', { hasSetupStock: true }))
      .toEqual({ operationType: 'face', variant: 'explicit_depth', ready: false, basis: 'explicit' })
  })

  it('(c) a Face bottom the operator sets below the model top is honoured exactly', async () => {
    await openJourneyProject(1)
    const face = await newFace(-3)
    await compute(face.id)
    const deepest = deepestFeedZ(post([face.id])[face.id])
    results.c = deepest
    expect(deepest).toBeCloseTo(-3, 3)

    // The journey's own Face, saved with its bottom as an operator plane at
    // WCS -5, keeps exactly that plane on load and regenerate.
    await compute(JOURNEY_FACE_ID)
    const saved = deepestFeedZ(post([JOURNEY_FACE_ID])[JOURNEY_FACE_ID])
    results.cSavedFace = saved
    expect(saved).toBeCloseTo(-5, 3)
  }, 300_000)

  it('(e) Properties and the editor name Model top and show the resolved plane; a typed plane can go back', async () => {
    await openJourneyProject(1)
    // The editor: Model top is the recommended choice and the preflight names it.
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getAllByText(TOOL_NAME)[0])
    fireEvent.click(screen.getByText('Heights'))
    const mode = screen.getByTestId('face-height-mode') as HTMLSelectElement
    expect(mode.value).toBe('model_top')
    expect([...mode.options].map(option => option.textContent))
      .toEqual(['Model top (recommended)', 'Selected model face', 'Explicit WCS plane'])
    await waitFor(() => expect(screen.getByTestId('face-height-preflight').textContent)
      .toContain('Smart recommendation: Face / Model top'))
    cleanup()

    const face = await newFace()
    await compute(face.id)
    act(() => useCamStore.setState(s => ({ project: { ...s.project, activeOperationId: face.id } })))
    render(createElement(PropertiesPanel))
    expect(screen.getByTestId('props-face-model-top-source').textContent).toBe('Model top')
    await waitFor(() => expect(
      (screen.getByTestId('props-face-model-top-value').querySelector('input') as HTMLInputElement).value,
    ).toBe('-1'))
    expect(screen.getByTestId('props-face-model-top-value').textContent).toContain('mm WCS')
    results.ePropertiesRow = screen.getByTestId('props-face-model-top').textContent

    // Typing replaces the smart plane with the operator's own, kept as typed ...
    const input = screen.getByTestId('props-face-model-top-value').querySelector('input')!
    fireEvent.change(input, { target: { value: '-3' } })
    fireEvent.blur(input)
    const current = () => setup().operations.find(candidate => candidate.id === face.id)!
    await waitFor(() => expect(current().smartHeight).toMatchObject({ intent: { machining: { end: {
      owner: { kind: 'user_override' },
      value: { plane: { reference: 'wcs_plane', offsetMm: -3 } },
    } } } }))
    // ... and the row offers the way back to the smart Model top.
    fireEvent.click(await screen.findByTestId('props-face-use-model-top'))
    expect(current().smartHeight).toMatchObject({ intent: { machining: { end: {
      owner: { kind: 'operation_policy' },
      value: { plane: { reference: 'model_top', offsetMm: 0 } },
    } } } })
    cleanup()
    await compute(face.id)
    expect(deepestFeedZ(post([face.id])[face.id])).toBeCloseTo(-1, 3)
  }, 300_000)

  it('(d) the same project\'s Adaptive, Contour and Pocket post byte-identical to main', async () => {
    await openJourneyProject(1)
    await compute(JOURNEY_FACE_ID)
    for (const opId of Object.values(OTHER_OPS)) await compute(opId)
    const spans = post(Object.values(OTHER_OPS))
    const digests = Object.fromEntries(Object.entries(OTHER_OPS).map(([name, opId]) => [
      name,
      createHash('sha256').update(spans[opId].join('\n')).digest('hex').slice(0, 16),
    ]))
    results.d = digests
    // Pinned from main (3541a0aa7) with this same test; see evidence/WO-2694/proof.md.
    expect(digests).toEqual(MAIN_DIGESTS)
  }, 600_000)
})

const MAIN_DIGESTS: Record<string, string> = {
  // WO-2701 repin: main's adaptive plunges alternated F1000 / F300 (D8); now every re-entry plunge is F300.
  // Diff is exactly those 5 plunge lines: src/tests/evidence/WO-2701/wo2694-adaptive-{main,branch}.nc.
  // WO-2713 repin: the Adaptive (no loops picked = All loops) now clears the part's
  // through hole (fresh profile, current placement) instead of six reach-trim dips; see adaptiveCutsOnASimplePart.wo2713.test.ts.
  // WO-2838: landed WO-2787 (1f65317369 / b5f0240fc7) prices complete
  // reposition + cleanup programs; only Adaptive changes on this project.
  adaptive: 'c75618a02bb93fb1',
  // WO-2701 repin: contour's one re-entry plunge F1000 -> F300 (wo2694-contour-{main,branch}.nc).
  contour: '623c82d0e9c24b75',
  pocket: '4ef8fc8cca792099',
}
