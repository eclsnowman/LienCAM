// B3 solver-dispatch hygiene (docs/planning/POST-MERGE-WORKPLAN.md).
//
// The B3 report: planegcs console churn on a BLANK new project. Measured
// root cause (instrumented Worker.postMessage in the real app): there is
// no idle dispatcher -- every solve is action-driven -- but newProject()
// left the OLD project's sketch document in activeSketch (a ghost: the
// viewer flips to setup mode, the document stays), so sketch actions kept
// feeding the solver on a supposedly blank project, and the per-entity
// definition probes of those solves print planegcs "Redundant solving"
// lines for every probed entity.
//
// This suite pins the dispatch contract at the store boundary with a
// COUNTING worker stub (the same stub-before-import harness as
// conflictResolution.test.ts, counting instead of solving):
//   - no sketch open  -> zero solver dispatches, ever (idle, newProject,
//     stray sketch actions: all guarded)
//   - sketch open + a line drawn -> solves happen (the feature works)
//   - sketch open but untouched  -> no further dispatches at idle
//   - newProject() while a sketch is open -> document CLOSED (no ghost),
//     and nothing dispatches afterwards

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'

// ---- Counting worker stub ---------------------------------------------------
// Records every SOLVE dispatch and answers with a canned clean solve (the
// entities echoed back, under-defined status). No WASM: this suite is
// about WHEN the store dispatches, not what the solver computes.

const dispatches: SketchWorkerRequestMsg['type'][] = []
let workersConstructed = 0

class CountingWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor() { workersConstructed++ }
  postMessage(msg: SketchWorkerRequestMsg): void {
    dispatches.push(msg.type)
    const { requestId, sketch } = msg.payload
    const data: SketchWorkerResponseMsg = {
      type: 'SKETCH_SOLVE_COMPLETE',
      requestId,
      entities: sketch.entities,
      status: {
        dof: sketch.entities.length > 0 ? 4 : 0,
        conflicting: [], redundant: [],
        fullyDefinedEntities: [],
      },
      computeTimeMs: 0,
    }
    // Async like the real worker: responses land on a later tick.
    setTimeout(() => this.onmessage?.({ data }), 0)
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', CountingWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
// The armed tool + chain now live in the sketcher package (WO SKC-14B).
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

beforeEach(() => {
  dispatches.length = 0
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  // Tool state lives in the package now.
  sketcherToolStore.setState({ tool: 'select', chain: null })
})

const idle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

// Draw one line through the REAL tool pipeline (the same path the
// viewport routes pointer clicks to).
function drawLine(): void {
  sketcherTools.armTool('line')
  sketcherTools.click({ x: 0, y: 0 }, 0.5, null, false)
  sketcherTools.click({ x: 40, y: 0 }, 0.5, null, false)
  sketcherTools.end()
}

describe('B3: solver dispatch hygiene', () => {
  it('app idle with no sketch open dispatches nothing (and never even creates the worker)', async () => {
    expect(useCamStore.getState().activeSketch).toBeNull()
    await idle()
    // Stray sketch-ish actions with no document are guarded no-ops.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCamStore.getState().solveSketch()           // warns, no dispatch
    useCamStore.getState().deleteSketchSelection() // empty selection no-op
    useCamStore.getState().endSketchDrag()         // no drag plan no-op
    warn.mockRestore()
    useCamStore.getState().newProject()
    await idle()
    expect(dispatches).toEqual([])
    expect(workersConstructed).toBe(0)
  })

  it('open sketch + draw one line -> solve dispatched; idle after -> no further dispatches', async () => {
    useCamStore.getState().startNewSketch()
    // A BLANK sketch (zero entities) must not solve on open.
    await idle()
    expect(dispatches).toEqual([])

    drawLine()
    await idle()
    const afterDraw = dispatches.length
    expect(afterDraw).toBeGreaterThan(0)
    expect(dispatches.every((t) => t === 'SOLVE_SKETCH')).toBe(true)
    // WO SKC-49: the drawn line + 3 injected origin/axis anchors.
    expect(useCamStore.getState().activeSketch?.entities.length).toBe(4)

    // Sketch open but UNCHANGED: idle produces zero additional solves.
    await idle(400)
    expect(dispatches.length).toBe(afterDraw)
  })

  it('newProject() closes the open sketch (no ghost document) and stops all dispatches', async () => {
    useCamStore.getState().startNewSketch()
    drawLine()
    await idle()
    // WO SKC-49: the drawn line + 3 injected origin/axis anchors.
    expect(useCamStore.getState().activeSketch?.entities.length).toBe(4)
    const beforeNew = dispatches.length
    expect(beforeNew).toBeGreaterThan(0)

    useCamStore.getState().newProject()
    // The B3 ghost: before the fix, activeSketch survived a New project.
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().sketchSolveStatus).toBeNull()
    expect(useCamStore.getState().viewer.mode).toBe('setup')

    // Idle + stray actions on the blank project: zero further dispatches.
    await idle(400)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCamStore.getState().deleteSketchSelection()
    useCamStore.getState().endSketchDrag()
    useCamStore.getState().solveSketch()
    warn.mockRestore()
    await idle()
    expect(dispatches.length).toBe(beforeNew)
  })

  it('loadProjectFromFile() while a sketch is open closes it and exits sketch mode (B3 sibling)', async () => {
    useCamStore.getState().startNewSketch()
    drawLine()
    await idle()
    // WO SKC-49: the drawn line + 3 injected origin/axis anchors.
    expect(useCamStore.getState().activeSketch?.entities.length).toBe(4)
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
    const beforeOpen = dispatches.length

    // Open a minimal valid project file while the sketch session is live.
    const file = JSON.stringify({
      id: 'opened-project', name: 'Opened', version: '1',
      machine: { id: 'm1', name: 'M' },
      geometry: [], setups: [],
    })
    useCamStore.getState().loadProjectFromFile(file)

    // Before the fix: activeSketch survived AND viewer.mode stayed 'sketch',
    // leaving the user inside a sketch that belongs to the previous project.
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().viewer.mode).toBe('setup')
    expect(useCamStore.getState().project.id).toBe('opened-project')

    await idle(400)
    expect(dispatches.length).toBe(beforeOpen)
  })
})
