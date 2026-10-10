// Mirror user-flow regression gate (STATUS.md KNOWN ISSUES 2026-06-11:
// "MIRROR DOES NOT WORK CORRECTLY" at final sign-off).
//
// Reproduced on main (scripts harness, real browser) as TWO flows the
// stage-6 machine gate never drove:
//
//   1. STALE-SELECTION RE-MIRROR: the mirror commit left the selection
//      live while the tool stayed armed, so the NEXT click on any line
//      re-entered selection-seeded mode and silently re-mirrored the
//      stale selection — duplicate copies stacked exactly on the first
//      mirror (invisible geometry + piling symmetric constraints).
//   2. REGULAR-LINE AXIS DEAD END: in click-accumulate mode, clicking
//      the intended axis line (non-construction) silently toggled it
//      into the set — no commit, no notice, no ghost, no way out.
//
// This suite drives the SAME store pipeline the viewport routes real
// pointer clicks to (sketchToolClick / setSketchTool / sketchToolEnd),
// with the stub-before-import counting-worker harness of
// solverDispatch.test.ts (worker echoes entities back; this gate is
// about tool-flow state, not solver math — mirrorTool.test.ts covers
// the real-planegcs loopback).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { SketchLineEntity } from '../../lib/sketch/types'

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
  // The store import binds the CAM document sink into the package (module-load
  // side effect), so it MUST come before anything drives sketcherTools.
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
  // Armed tool + chain now live in the package.
  sketcherToolStore.__reset()
})

const idle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const state = () => useCamStore.getState()
const sketch = () => state().activeSketch!
const click = (x: number, y: number) =>
  sketcherTools.click({ x, y }, 0.5, null, false)

/** Draw one line through the REAL tool pipeline (viewport click path). */
function drawLine(x0: number, y0: number, x1: number, y1: number): void {
  sketcherTools.armTool('line')
  click(x0, y0)
  click(x1, y1)
  sketcherTools.end() // end the polyline chain
}

/** The drawn line whose start is at (x, y). */
function lineAt(x: number, y: number): SketchLineEntity {
  const e = sketch().entities.find(
    (en) => en.kind === 'line' && en.start.x === x && en.start.y === y,
  )
  if (!e || e.kind !== 'line') throw new Error(`no line starting at ${x},${y}`)
  return e
}

const symCount = () =>
  sketch().constraints.filter((c) => c.kind === 'symmetric').length

describe('mirror flow: stale-selection re-mirror (user defect 1)', () => {
  it('commit consumes the selection; a follow-up click on the axis cannot duplicate the mirror', async () => {
    state().startNewSketch()
    drawLine(0, 0, 10, 0)    // the entity to mirror
    drawLine(20, -5, 20, 25) // the axis (a REGULAR line)
    await idle()
    const src = lineAt(0, 0)
    const axis = lineAt(20, -5)

    // Pre-select, arm mirror -> seeded as an OPEN set (confirmed:false).
    state().setSketchSelection([src.id])
    sketcherTools.armTool('mirror')
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'mirror', ids: [src.id], seeded: true, confirmed: false,
    })
    // Enter (Confirm) closes the set, THEN the axis click commits -> ONE
    // commit. (Seeding straight to axis-pick let a single lingering
    // selection hijack the next click as the axis: the tool-first bug.)
    sketcherTools.end()
    expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'mirror', confirmed: true })
    click(20, 10)
    await idle()
    // WO SKC-49: 3 user entities (src + axis + mirrored copy) + 3 injected anchors.
    expect(sketch().entities).toHaveLength(6)
    expect(symCount()).toBe(2)
    // The commit CONSUMED the selection (fillet-apply convention).
    expect(state().sketchSelectedIds).toEqual([])

    // The user keeps clicking (tool still armed): the same axis click
    // again. Pre-fix this re-entered selection-seeded mode and stacked
    // a duplicate mirror + 2 more symmetric constraints.
    click(20, 10)
    await idle()
    // WO SKC-49: 3 user entities (src + axis + mirrored copy) + 3 injected anchors.
    expect(sketch().entities).toHaveLength(6)
    expect(symCount()).toBe(2)
    // The click fell through to accumulate mode (no silent duplicate):
    // the axis line is now merely toggled into a fresh set.
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'mirror', ids: [axis.id],
    })
  })
})

describe('mirror flow: regular-line axis via Enter (user defect 2)', () => {
  it('accumulate -> regular-line click NOTICES the way out -> Enter closes the set -> axis click commits', async () => {
    state().startNewSketch()
    drawLine(0, 0, 10, 0)
    drawLine(20, -5, 20, 25) // intended axis, NOT construction
    await idle()
    const src = lineAt(0, 0)
    const axis = lineAt(20, -5)

    // Arm with nothing selected -> click-accumulate mode.
    sketcherTools.armTool('mirror')
    click(5, 0) // toggle the source line into the set
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'mirror', ids: [src.id],
    })

    // The naive axis click: pre-fix this silently toggled the line in
    // (no notice, no commit — the reported dead end).
    click(20, 10)
    expect(sketch().entities).toHaveLength(5) // no commit (2 user entities + 3 injected anchors)
    expect(state().sketchNotice).toMatch(/Enter/)
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'mirror', ids: [src.id, axis.id],
    })

    // Enter closes the set (the pattern-tool gesture)...
    sketcherTools.end()
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'mirror', confirmed: true,
    })

    // ...and the axis click now commits, mirroring about the REGULAR
    // line (the axis itself is never mirrored even though it sits in
    // the set).
    click(20, 10)
    await idle()
    // WO SKC-49: 3 user entities (src + axis + mirrored copy) + 3 injected anchors.
    expect(sketch().entities).toHaveLength(6)
    expect(symCount()).toBe(2)
    // WO SKC-49: exclude construction entities too -- the injected X/Y axis anchor LINES are also
    // kind 'line' with ids distinct from src/axis, and would otherwise be found first.
    const mirrored = sketch().entities.find(
      (e): e is SketchLineEntity =>
        e.kind === 'line' && !e.construction && e.id !== src.id && e.id !== axis.id,
    )!
    // Reflection of (0,0)-(10,0) about x = 20: (40,0)-(30,0).
    expect(mirrored.start.x).toBeCloseTo(40, 9)
    expect(mirrored.start.y).toBeCloseTo(0, 9)
    expect(mirrored.end.x).toBeCloseTo(30, 9)
    expect(mirrored.end.y).toBeCloseTo(0, 9)
    expect(sketcherToolStore.getState().chain).toBeNull()
  })
})
