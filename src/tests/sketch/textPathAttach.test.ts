// REGRESSION: "Attach to path" for sketch text-on-path binds the clicked curve.
//
// The store side is correct (the CONTROL test proves it): the pick-path
// interception inside store.sketchToolClick binds the text whenever it runs.
// The original bug was in the VIEWPORT click routing. The attach gesture is
// reached from SELECT mode (double-click a placed text -> edit; then "Attach
// to path" arms the pick), so sketchTool === 'select' and sketchToolArmed()
// is false. The armed-tool branch that calls click() is skipped, and the
// binding click fell into the SELECT branch (CNCViewport.ts, the
// "Click (no meaningful drag)" block) which committed the text edit (clearing
// BOTH sketchTextEditId and sketchPickPathForTextId) and merely selected the
// curve -- sketchToolClick's pick interception was never reached.
//
// The FIX routes a stationary select-mode click through click() ->
// sketchToolClick whenever isPickingTextPath() is true, BEFORE the
// isEditingText() commit can eat the pending pick. This test models that
// FIXED routing decision precisely (the CNCViewport pointer-up ordering) and
// asserts the text ends up bound. The real-viewport PointerEvent path is the
// ultimate gate; a faithful headless viewport test would need THREE/WebGL, so
// the routing decision is modeled at the store/handler seam here.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SketchTextEntity } from '../../lib/sketch/types'

// WO-1052: the `../../lib/geometry/worker` vi.mock this file used to carry
// mocked a module specifier that resolves to nothing in src/ and an export
// (`getGeometryWorker`) referenced nowhere else in the repo - dead code left
// over from an earlier architecture. Removed rather than typed (there is no
// real module to type against) and rather than left untyped (nothing in this
// file or in src/ ever imports it, so the mock was a no-op); the Worker global
// stub immediately below is what the sketch worker path actually exercises.
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', NoopWorker)

describe('text-on-path attach: select-mode click routing', () => {
  let useCamStore: typeof import('../../store').useCamStore
  // The armed tool + chain and the tool click now live in the sketcher package
  // (WO SKC-14B); import it dynamically alongside the store.
  let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
  let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
    ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [
          { id: 'tx', kind: 'text', construction: false, at: { x: 1, y: 2 }, text: 'HI', height: 5, rotation: 0, fontStyle: 'single-line' },
          { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchPickPathForTextId: null,
      sketchTextPathId: null, sketchTextPathOffsetMm: 0, sketchTextPathFlip: false,
    } as never)
    // Tool state lives in the package now.
    sketcherToolStore.setState({ tool: 'select', chain: null })
  })
  const txt = () =>
    useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'tx') as SketchTextEntity

  // Faithful model of CNCViewport.handleSketchPointerUp for a stationary
  // left-click in SELECT mode (tool === 'select', so sketchToolArmed() is
  // false -> the armed-tool branch is skipped and we land in the "Click (no
  // meaningful drag)" block). Mirrors the FIXED ordering:
  //   1. If a text-on-path pick is pending (isPickingTextPath), route the
  //      click through sketchToolClick -- its pick interception binds the
  //      curve -- and STOP (do not commit/select).
  //   2. Otherwise the live text edit commits on click-away, then the normal
  //      selection click runs.
  // `world` is the clicked point; `selected` collects the resulting selection.
  function simulateSelectModeClick(world: { x: number; y: number }, selected: string[]): void {
    const h = useCamStore.getState()
    // FIX: pending attach-to-path pick is consumed here, before the commit.
    if (h.sketchPickPathForTextId != null) {
      sketcherTools.click(world, 0.5, null, false)
      return
    }
    // A live text edit commits on click-away.
    if (h.sketchTextEditId != null) h.commitSketchTextEdit()
    // Then the normal selection click runs (pick under cursor).
    const hit = h.activeSketch!.entities.find(
      (e) => e.kind === 'line' && Math.abs(world.y) < 0.5,
    )
    if (hit) selected.splice(0, selected.length, hit.id)
  }

  it('CONTROL: store binds when sketchToolClick actually runs (armed-tool path)', () => {
    // Proves the STORE side is correct: when the pick-path interception in
    // sketchToolClick is reached, the text binds.
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().beginPickTextPath('tx')
    sketcherTools.click({ x: 10, y: 0.1 }, 0.5, null, false)
    expect(txt().pathId).toBe('ln')
  })

  it('FIXED: the select-mode binding click attaches the text to the curve', () => {
    // 1. User double-clicks the placed text -> edit opens (select mode only).
    useCamStore.getState().beginSketchTextEdit('tx')
    // 2. User clicks "Attach to path" -> pick mode armed.
    useCamStore.getState().beginPickTextPath('tx')
    expect(useCamStore.getState().sketchPickPathForTextId).toBe('tx')
    // 3. User clicks the line to bind it. With the fix, the viewport routes
    //    this through sketchToolClick (the pick interception).
    const selected: string[] = []
    simulateSelectModeClick({ x: 10, y: 0.1 }, selected)
    // The text is now bound to the line...
    expect(txt().pathId).toBe('ln')
    // ...and the click was consumed by the pick, NOT the select/commit path
    // (no spurious selection, edit not committed as a click-away select).
    expect(selected).toEqual([])
  })

  it('does not hijack a normal select-mode click when NO pick is pending', () => {
    // A plain click with no attach pending still selects the curve normally.
    const selected: string[] = []
    simulateSelectModeClick({ x: 10, y: 0.1 }, selected)
    expect(txt().pathId).toBeUndefined()
    expect(selected).toEqual(['ln'])
  })
})
