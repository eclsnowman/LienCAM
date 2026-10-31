// @vitest-environment jsdom
// WO-3221 (WO-3176 Brief B), audit fix round 1: the tab removal contour posts
// on its own from the real Post Process dialog.
//
// The separate-program use: the tabbed contour was already cut, so the operator
// opens Post Process, unticks it, keeps only the cleanup and exports. Export
// stages the unticked source as excluded (stageOperationsForEmission), which
// outdates the predecessor-bound cleanup and recomputes it. Leaving the source
// out of THIS file is not suppressing it: the cleanup keeps its binding,
// recomputes the same motion and posts. A source really suppressed in the
// project still refuses the cleanup with its own reason.
//
// Route: the REAL store (computeOperationToolpath, createContourTabRemoval),
// the REAL toolpathWorker.ts in-process, the REAL modal, its operation
// checkboxes and its Export button.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { makeMachine } from './helpers'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, Setup, Tool, Vec3, WCS,
} from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} })

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

const SETUP_1 = 'setup-1'
const STOCK_ID = 'stock-1'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const END_MILL = {
  id: 'end-mill', name: 'Tab removal 6mm end mill', type: 'flat_end_mill', toolNumber: 3, cutHand: 'right',
  diameter: 6, fluteLength: 30, shankDiameter: 6, overallLength: 80, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

/** The brief's analytic fixture: a 100 x 60 x 6 block, a 60 x 30 part, one
 *  finish-only Contour with four box tabs W 8 x 1.5 and a 6 mm end mill. */
function installProject(): void {
  const points = [{ x: -30, y: -15 }, { x: 30, y: -15 }, { x: 30, y: 15 }, { x: -30, y: 15 }]
  const geometry = {
    id: 'part', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -30, y: -15, z: 0 }, { x: 30, y: 15, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID, stockIdLocked: true,
    loops: [{ id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 1800, points }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
  const params = {
    geometryId: 'part', loopIds: ['outline'], side: 'outer', direction: 'climb',
    tabs: true, tabWidth: 8, tabHeight: 1.5, tabCount: 4,
  }
  const source = {
    id: 'src', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: END_MILL.id, geometrySelections: [], heights: HEIGHTS, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: SETUP_1, heights: HEIGHTS, params, geometryIds: ['part'] }),
  } as unknown as Operation
  const stock = {
    id: STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -50, y: -30, z: 0 }, { x: 50, y: 30, z: 6 }), position: { x: -50, y: -30, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_1, name: 'Setup 1', notes: '', holdingMethod: 'screws',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -50, y: -30, z: 6 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [source],
  } as unknown as Setup
  const project = {
    ...useCamStore.getState().project, id: 'project-wo3221', name: 'WO-3221', machine: makeMachine(),
    geometry: [geometry], stocks: [stock], setups: [setup],
    activeSetupId: SETUP_1, activeOperationId: null, nests: [],
    modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
  } as unknown as Project
  act(() => {
    useCamStore.setState({
      project, toolLibrary: [END_MILL], toolpathBatch: null, consoleEvents: [],
      modelRefsVerifiedSinceLoad: true, activeModal: null,
    } as never)
  })
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()
let realSelf: unknown

beforeAll(async () => {
  realSelf = (globalThis as { self?: unknown }).self
  Object.defineProperty(globalThis, 'self', {
    value: {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
      location: window.location,
    },
    configurable: true, writable: true,
  })
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  Object.defineProperty(globalThis, 'self', { value: realSelf, configurable: true, writable: true })
})

let blobs: Blob[]

beforeEach(() => {
  workerQueue = Promise.resolve()
  activeShim = null
  blobs = []
  mem.clear()
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerQueue = workerQueue.then(async () => {
        activeShim = this
        await workerSelf.onmessage!({ data })
      })
    }
    terminate(): void { /* no thread */ }
  })
  // The worker is constructed from `new URL(...)`, so URL stays a constructor;
  // only its blob statics are stood in for, to capture the exported program.
  class CapturingURL extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:wo3221' })
    static revokeObjectURL = vi.fn()
  }
  vi.stubGlobal('URL', CapturingURL)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  installProject()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  act(() => { useCamStore.getState().closeModal(); useCamStore.setState({ toolpathBatch: null }) })
})

const ops = () => useCamStore.getState().project.setups.find((s) => s.id === SETUP_1)!.operations
const opById = (id: string) => ops().find((o) => o.id === id)!

async function generate(opId: string): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_1, opId) })
  await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull(), { timeout: 20_000 })
}

/** Generate the tabbed source, create its cleanup from it, generate that. */
async function readyPair(): Promise<string> {
  await generate('src')
  expect([opById('src').status, opById('src').errorMessage]).toEqual(['ready', undefined])
  let outcome!: ReturnType<ReturnType<typeof useCamStore.getState>['createContourTabRemoval']>
  act(() => { outcome = useCamStore.getState().createContourTabRemoval(SETUP_1, 'src') })
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`)
  await generate(outcome.operationId)
  expect([opById(outcome.operationId).status, opById(outcome.operationId).errorMessage]).toEqual(['ready', undefined])
  return outcome.operationId
}

function openPost(): void {
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
}

/** Expand Setup 1's operation list in the dialog and untick one operation. */
function untick(name: string): void {
  const expand = screen.queryAllByRole('button', { name: /expand operations/i })
  if (expand.length > 0) fireEvent.click(expand[0])
  const box = screen.getByRole('checkbox', { name: name }) as HTMLInputElement
  expect(box.checked).toBe(true)
  fireEvent.click(box)
  expect(box.checked).toBe(false)
}

const postLines = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'post').map((e) => e.message)
const blockedLines = () => postLines().filter((m) => /blocked|refused/i.test(m))

/** Press Export and wait until it either writes a program or refuses. */
async function exportProgram(): Promise<{ program: string | null; blocked: string[] }> {
  const before = blobs.length
  const button = screen.getByRole('button', { name: /^Export \./ }) as HTMLButtonElement
  await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 20_000 })
  fireEvent.click(button)
  await vi.waitFor(() => expect(blobs.length > before || blockedLines().length > 0).toBe(true), { timeout: 20_000 })
  return { program: blobs.length > before ? await blobs[blobs.length - 1].text() : null, blocked: blockedLines() }
}
/** Every cutting Z the program feeds to (G1 with a Z word). */
const feedZs = (gcode: string) => gcode.split('\n')
  .filter((line) => /^(N\d+\s+)?G0?1\b/.test(line.trim()) || (/\bZ-?\d/.test(line) && !/^(N\d+\s+)?G0?0\b/.test(line.trim()) && !/^\(/.test(line.trim())))
  .map((line) => /\bZ(-?\d+(?:\.\d+)?)/.exec(line)?.[1])
  .filter((z): z is string => z !== undefined)
  .map(Number)

describe('WO-3221 Post Process: the tab removal contour on its own', () => {
  it('source unticked, cleanup alone: Export recomputes the cleanup and posts it, the source stays as it was', async () => {
    const cleanupId = await readyPair()
    const cleanupMoves = structuredClone(opById(cleanupId).toolpathMoves)
    const sourceBefore = JSON.stringify(opById('src'))
    const cleanupName = opById(cleanupId).name

    openPost()
    untick('Outline profile')
    const exported = await exportProgram()

    // THE DEFECT: staging switched the unticked source off for this file, the
    // cleanup's compute read that as a suppressed source and refused, and
    // Export wrote nothing.
    expect(exported.blocked).toEqual([])
    const program = exported.program!
    expect(program).toContain(cleanupName)
    expect(program).not.toContain('"Outline profile"')
    // The cleanup cuts the source's bottom (-6) with tabs off: no tab top at -4.5.
    const zs = feedZs(program)
    expect(Math.min(...zs)).toBeCloseTo(-6, 3)
    expect(zs.some((z) => Math.abs(z - -4.5) < 1e-6)).toBe(false)

    // Export puts the project back: the source untouched, the cleanup ready,
    // bound and with the same motion it was generated with.
    expect(JSON.stringify(opById('src'))).toBe(sourceBefore)
    const after = opById(cleanupId)
    expect([after.status, after.errorMessage]).toEqual(['ready', undefined])
    expect((after.params as { tabRemovalSource?: unknown }).tabRemovalSource).toBeDefined()
    expect(after.toolpathMoves).toEqual(cleanupMoves)
  })

  it('a source suppressed in the project still refuses the cleanup with its own reason', async () => {
    const cleanupId = await readyPair()
    act(() => useCamStore.getState().updateOperation(SETUP_1, 'src', { enabled: false }))
    await generate(cleanupId)
    const refused = opById(cleanupId)
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toMatch(/is suppressed/)
    expect(refused.toolpathMoves).toBeUndefined()

    openPost()
    const button = screen.getByRole('button', { name: /^Export \./ }) as HTMLButtonElement
    await vi.waitFor(() => expect(document.body.textContent ?? '').toMatch(/has an error - fix it before posting/), { timeout: 20_000 })
    expect(button.disabled).toBe(true)
    expect(blobs).toHaveLength(0)
  })
})
