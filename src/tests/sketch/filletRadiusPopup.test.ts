// Fillet near-cursor RADIUS popup (V4): the radius can be set in-context
// beside the cursor instead of the bottom FilletRadiusRow field. The
// near-cursor box routes its typed value through commitDrawValueAt, which for
// the FILLET tool sets the persistent filletRadius scalar LIVE (no geometry
// commit) -- so the ghost arc restyles and the overlay Apply bakes the batch
// at that radius. The bottom field writes the SAME scalar (many paths to one
// value). This gate drives the real store pipeline the viewport routes pointer
// clicks + the box's Enter through.
//
// WO SKC-14B: the tool slice (armed tool, chain, filletRadius scalar, the
// commit/overlay-apply actions) moved out of the CAM store into the sketcher
// package. They are now driven through `sketcherTools` and read from
// `sketcherToolStore`; `activeSketch`/notice/history stay on the CAM store.
//
// Uses the stub-before-import EchoWorker harness (mirrorStoreFlow.test.ts):
// the worker echoes entities back; the fillet apply is a PURE transform, so
// this gate is about the radius scalar + click-toggle state, not solver math.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { SketchArcEntity } from '../../lib/sketch/types'

class EchoWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
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
    setTimeout(() => this.onmessage?.({ data }), 0)
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', EchoWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import MUST come first: loading src/store binds the CAM document
  // sink into the sketcher package, so `sketcherTools` has a document to drive.
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  sketcherToolStore.setState({ tool: 'select', chain: null, filletRadius: 2 })
})

const idle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const state = () => useCamStore.getState()
const sketch = () => state().activeSketch!
const click = (x: number, y: number) => sketcherTools.click({ x, y }, 0.5, null, false)

/** Draw one line through the REAL tool pipeline (viewport click path). */
function drawLine(x0: number, y0: number, x1: number, y1: number): void {
  sketcherTools.armTool('line')
  click(x0, y0)
  click(x1, y1)
  sketcherTools.end()
}

/** Stage the L-corner at (10,0) shared by the two drawn lines. */
async function armAndStageCorner(): Promise<void> {
  state().startNewSketch()
  drawLine(0, 0, 10, 0)     // horizontal leg
  drawLine(10, 0, 10, 10)   // vertical leg (shares the corner endpoint)
  await idle()
  sketcherTools.armTool('fillet')
  click(10, 0)              // shared-corner gesture toggles the corner IN
}

describe('fillet near-cursor radius popup: commit routing', () => {
  it('a plain click still toggles the corner into the fillet chain (selection intact)', async () => {
    await armAndStageCorner()
    expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'fillet' })
    const chain = sketcherToolStore.getState().chain
    expect(chain?.kind === 'fillet' && chain.corners.length).toBe(1)
  })

  it('typing a value routes to the radius scalar LIVE, without committing geometry', async () => {
    await armAndStageCorner()
    const beforeEntities = sketch().entities.length
    // The box's Enter -> commitDrawValueAt(value, cursor).
    sketcherTools.commitDrawValueAt(6, { x: 10, y: 0 })
    // Radius scalar updated (same scalar the bottom FilletRadiusRow writes).
    expect(sketcherToolStore.getState().filletRadius).toBe(6)
    // No geometry committed, and the staged corner is untouched.
    expect(sketch().entities.length).toBe(beforeEntities)
    const chain = sketcherToolStore.getState().chain
    expect(chain?.kind === 'fillet' && chain.corners.length).toBe(1)
  })

  it('the overlay Apply bakes the fillet at the popup-set radius', async () => {
    await armAndStageCorner()
    sketcherTools.commitDrawValueAt(3, { x: 10, y: 0 })
    expect(sketcherToolStore.getState().filletRadius).toBe(3)
    sketcherTools.overlayApply()
    await idle()
    const arc = sketch().entities.find(
      (e): e is SketchArcEntity => e.kind === 'arc',
    )
    expect(arc).toBeDefined()
    expect(arc!.radius).toBeCloseTo(3, 9)
  })

  it('a non-positive typed value is rejected; the radius scalar is unchanged', async () => {
    await armAndStageCorner()
    // SKC-46 seeds the staged radius from the remembered/derived default on this first corner
    // (its own tests cover that derivation); pin a known baseline so THIS test is purely about
    // the reject-and-keep-unchanged behavior, not the seed.
    sketcherToolStore.setState({ filletRadius: 2 })
    expect(sketcherToolStore.getState().filletRadius).toBe(2)
    sketcherTools.commitDrawValueAt(-4, { x: 10, y: 0 })
    expect(sketcherToolStore.getState().filletRadius).toBe(2)
    sketcherTools.commitDrawValueAt(0, { x: 10, y: 0 })
    expect(sketcherToolStore.getState().filletRadius).toBe(2)
  })
})
