// @vitest-environment jsdom
// WO-2788: after a restart with a project restored, Post Process recomputes
// out-of-date operations itself instead of refusing them.
//
// the owner (2026-10-14, card answer): "Fix both before alpha.2". Item C: "reopen
// the app with a project restored, then Post Process: every operation is
// refused 'outdated - recompute it before posting', although the software
// could recompute them itself (rule 11)."
//
// Root cause of "restored reads as outdated": the browser copy of the project
// never carries toolpath moves (persistPartialize strips them for the
// localStorage quota), and the load census (reconcileLoadedOpLifecycle) turns
// every 'ready' operation without moves into 'outdated'. That is correct and
// stays; Post now does the recompute instead of refusing.
//
// The route runs through the production entry points: the REAL store's
// computeAllToolpaths (Regenerate All, the oracle) and computeOperationToolpath
// (what Post recomputes with), the REAL persistPartialize ->
// persistMigrate -> persistMerge restore, the REAL modal and its Export button,
// and the REAL toolpathWorker.ts run in-process.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { makeMachine } from '../post/helpers'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, Vec3, WCS,
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
const { useCamStore, persistPartialize, persistMigrate, persistMerge, PERSIST_STORE_VERSION } = await import('../../store')

const SETUP_1 = 'setup-1'
const STOCK_ID = 'stock-1'
const PLATE_TOP = 20

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const circle = (cx: number, cy: number, r: number) => Array.from({ length: 32 }, (_, i) => {
  const t = (2 * Math.PI * i) / 32
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }
})

function sketch(): ImportedGeometry {
  return {
    id: 'sketch', name: 'Outline', filename: 'outline.svg', type: 'curves_2d', format: 'svg',
    boundingBox: bbox({ x: 10, y: 10, z: PLATE_TOP }, { x: 70, y: 50, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID, stockIdLocked: true,
    loops: [
      { id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 2400, points: rect(10, 10, 70, 50) },
      { id: 'hole', closed: true, type: 'hole', layerId: 'L1', area: Math.PI * 9, points: circle(55, 30, 3) },
    ],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    // cutHand as every tool reads after the project migration a restore runs.
    id: 'tool', name: 'tool', type: 'flat_end_mill', toolNumber: 1, cutHand: 'right',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}
const END_MILL = tool({ id: 'end-mill', name: 'WO-2788 6mm end mill', toolNumber: 1 })
const DRILL = tool({ id: 'drill', name: 'WO-2788 5mm drill', type: 'drill', diameter: 5, toolNumber: 2 })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -3, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }

function op(id: string, name: string, type: Operation['type'], toolId: string, params: Record<string, unknown>): Operation {
  return {
    id, name, type, enabled: true, status: 'pending', toolId, geometrySelections: [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: SETUP_1, heights: HEIGHTS, params, geometryIds: ['sketch'], stockId: STOCK_ID, explicitDepthMm: 3,
    }),
  } as unknown as Operation
}

/** Setup 1: Drill 1 -> Contour 2, both 2D, both never computed. */
function installProject(): void {
  const stock = {
    id: STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 60, fixedDepth: PLATE_TOP,
    fixedStocks: [],
  } as unknown as SceneStock
  const setup = {
    id: SETUP_1, name: 'Setup 1', notes: '',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [
      op('drill', 'Drill 1', 'drill', DRILL.id, {
        geometryId: 'sketch', loopIds: ['hole'], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
        dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
      }),
      { ...op('contour', 'Contour 2', 'contour_2d', END_MILL.id, {
        geometryId: 'sketch', loopIds: ['outline'], side: 'outer', direction: 'climb', tabs: false,
      }), passes: { ...PASSES, finishPasses: 1 } },
    ],
  } as unknown as Setup
  const project = {
    ...useCamStore.getState().project, id: 'project-wo2788', name: 'WO-2788', machine: makeMachine(),
    geometry: [sketch()], stocks: [stock], setups: [setup],
    sceneStock, activeSetupId: SETUP_1, activeOperationId: null, nests: [], modelItemPlacements: [],
  } as unknown as Project
  act(() => {
    useCamStore.setState({
      project, toolLibrary: [END_MILL, DRILL], toolpathBatch: null, consoleEvents: [],
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
    static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:wo2788' })
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
const postLines = () => useCamStore.getState().consoleEvents
  .filter((e) => e.source === 'post').map((e) => e.message)

async function regenerateAll(): Promise<void> {
  await act(async () => { await useCamStore.getState().computeAllToolpaths() })
  await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull(), { timeout: 10_000 })
  expect(ops().map((o) => [o.id, o.status, o.errorMessage])).toEqual([['drill', 'ready', undefined], ['contour', 'ready', undefined]])
}

/** Close the app and start it again: the real localStorage persist round trip. */
function restart(): void {
  const state = useCamStore.getState()
  const serialized = JSON.parse(JSON.stringify(persistPartialize(state)))
  const reloaded = persistMerge(persistMigrate(serialized, PERSIST_STORE_VERSION), state)
  act(() => {
    useCamStore.setState({
      project: reloaded.project, toolLibrary: reloaded.toolLibrary, consoleEvents: [],
      toolpathBatch: null, modelRefsVerifiedSinceLoad: true, activeModal: null,
    } as never)
  })
}

function openPost(): void {
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
}

function closePost(): void {
  act(() => useCamStore.getState().closeModal())
  cleanup()
}

async function exportProgram(): Promise<string> {
  const before = blobs.length
  const button = screen.getByRole('button', { name: /^Export \./ }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  // The program-context block stamps the posting time; one clock for both
  // posts keeps the comparison to what the program says, byte for byte.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 14, 6, 6))
  try {
    fireEvent.click(button)
    await vi.waitFor(() => expect(blobs.length).toBe(before + 1), { timeout: 10_000 })
  } finally {
    clock.mockRestore()
  }
  return blobs[blobs.length - 1].text()
}

const OUTDATED_REFUSAL = /out of date - recompute it before posting/
const withoutContextBlock = (program: string) => program.split('\n').filter((line) => !/LCX1/.test(line)).join('\n')

describe('WO-2788 Post Process recomputes outdated operations after a restart', () => {
  it('restore -> Post: recomputes, says so in one line, and posts the same bytes as after Regenerate All', async () => {
    await regenerateAll()
    openPost()
    const beforeRestart = await exportProgram()
    closePost()

    restart()
    // The restore itself: no toolpath moves survive, every operation reads out of date.
    expect(ops().map((o) => [o.id, o.status, o.toolpathMoves])).toEqual([
      ['drill', 'outdated', undefined], ['contour', 'outdated', undefined],
    ])
    const restored = useCamStore.getState().project

    // The oracle: the restored project, Regenerate All pressed by hand, posted.
    await regenerateAll()
    openPost()
    const afterRegenAll = await exportProgram()
    closePost()
    expect(postLines().filter((m) => /recomputed/i.test(m))).toEqual([])

    // The same restored project, straight into Post Process.
    act(() => useCamStore.setState({ project: restored, consoleEvents: [] }))
    openPost()
    // THE DEFECT (main): the preview refused every operation with OP_OUTDATED
    // and nothing recomputed them. Fixed: Post recomputes them itself.
    await vi.waitFor(() => {
      expect(ops().map((o) => o.status)).toEqual(['ready', 'ready'])
      expect(postLines().filter((m) => /recomputed/i.test(m))).toHaveLength(1)
    }, { timeout: 10_000 })
    expect(postLines().filter((m) => /recomputed/i.test(m))).toEqual([
      'Post Process recomputed 2 out-of-date operations before posting: "Drill 1", "Contour 2".',
    ])
    await vi.waitFor(() => expect(document.body.textContent ?? '').not.toMatch(OUTDATED_REFUSAL))

    const afterRestore = await exportProgram()
    expect(afterRestore).toBe(afterRegenAll)
    // Still one recompute line: Export found nothing left to recompute.
    expect(postLines().filter((m) => /recomputed/i.test(m))).toHaveLength(1)
    // And the moves are the ones posted before the restart (the context block
    // carries the restored project's fingerprint, so only it may differ).
    expect(withoutContextBlock(afterRestore)).toBe(withoutContextBlock(beforeRestart))
  })

  it('Export pressed while Post is still recomputing waits for it and writes the same program', async () => {
    await regenerateAll()
    restart()
    const restored = useCamStore.getState().project
    await regenerateAll()
    openPost()
    const afterRegenAll = await exportProgram()
    closePost()

    act(() => useCamStore.setState({ project: restored, consoleEvents: [] }))
    openPost()
    // Pressed at once: the recompute is still running, and Export is not
    // disabled behind the operations it is computing.
    expect(ops().map((o) => o.status)).not.toEqual(['ready', 'ready'])
    const program = await exportProgram()
    expect(ops().map((o) => o.status)).toEqual(['ready', 'ready'])
    expect(program).toBe(afterRegenAll)
    expect(postLines().filter((m) => /recomputed/i.test(m))).toEqual([
      'Post Process recomputed 2 out-of-date operations before posting: "Drill 1", "Contour 2".',
    ])
  })

  it('a genuine compute failure still refuses with that operation\'s own reason', async () => {
    await regenerateAll()
    restart()
    // The Contour's loop is gone: it cannot be computed, whatever Post does.
    act(() => {
      const project = useCamStore.getState().project
      useCamStore.setState({
        project: {
          ...project,
          setups: project.setups.map((s) => ({
            ...s,
            operations: s.operations.map((o) => o.id !== 'contour' ? o : {
              ...o, params: { ...(o.params as Record<string, unknown>), loopIds: ['no-such-loop'] },
            }),
          })),
        },
      })
    })

    openPost()
    await vi.waitFor(() => {
      expect(ops().find((o) => o.id === 'drill')!.status).toBe('ready')
      expect(ops().find((o) => o.id === 'contour')!.status).toBe('error')
      expect(useCamStore.getState().toolpathBatch).toBeNull()
    }, { timeout: 10_000 })
    const contour = ops().find((o) => o.id === 'contour')!
    await vi.waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('Operation "Contour 2" has an error - fix it before posting.')
      if (contour.errorMessage) expect(text).toContain(contour.errorMessage)
      expect(text).not.toMatch(OUTDATED_REFUSAL)
    })
    expect((screen.getByRole('button', { name: /^Export \./ }) as HTMLButtonElement).disabled).toBe(true)
    // Only what was really recomputed is named.
    expect(postLines().filter((m) => /recomputed/i.test(m))).toEqual([
      'Post Process recomputed 1 out-of-date operation before posting: "Drill 1".',
    ])
  })

  it('an out-of-date operation recomputes and posts; a pending one in the same setup stays omitted', async () => {
    // Audit route (astra, 2026-10-14): Drill 1 out of date with no moves, and a
    // never-generated Contour 2 that could not compute anyway (its loop is
    // gone). Post recomputes ONLY Drill 1; the pending Contour stays omitted
    // (WO-2043) and does not block the program the Drill makes.
    await regenerateAll()
    restart()
    act(() => {
      const project = useCamStore.getState().project
      useCamStore.setState({
        project: {
          ...project,
          setups: project.setups.map((s) => ({
            ...s,
            operations: s.operations.map((o) => o.id !== 'contour' ? o : {
              ...o, name: 'Pending Contour', status: 'pending' as const,
              toolpathMoves: undefined, generationFingerprint: undefined,
              params: { ...(o.params as Record<string, unknown>), loopIds: ['no-such-loop'] },
            }),
          })),
        },
      })
    })
    expect(ops().map((o) => [o.id, o.status])).toEqual([['drill', 'outdated'], ['contour', 'pending']])

    openPost()
    await vi.waitFor(() => {
      expect(ops().find((o) => o.id === 'drill')!.status).toBe('ready')
      expect(postLines().filter((m) => /recomputed/i.test(m))).toHaveLength(1)
    }, { timeout: 10_000 })
    await vi.waitFor(() => expect(document.body.textContent ?? '').not.toMatch(OUTDATED_REFUSAL))
    // The pending Contour was never computed: still pending, still no moves.
    const contour = ops().find((o) => o.id === 'contour')!
    expect([contour.status, contour.toolpathMoves, contour.errorMessage]).toEqual(['pending', undefined, undefined])
    expect(postLines().filter((m) => /recomputed/i.test(m))).toEqual([
      'Post Process recomputed 1 out-of-date operation before posting: "Drill 1".',
    ])
    const text = document.body.textContent ?? ''
    expect(text).toContain('"Setup 1 / Pending Contour"')
    expect(text).not.toContain('has an error - fix it before posting')

    // Export is enabled and writes the Drill's program without the Contour.
    const program = await exportProgram()
    expect(program).toMatch(/\bT2\b/)
    expect(program).not.toMatch(/\bT1\b/)
    expect(ops().find((o) => o.id === 'contour')!.status).toBe('pending')
  })
})
