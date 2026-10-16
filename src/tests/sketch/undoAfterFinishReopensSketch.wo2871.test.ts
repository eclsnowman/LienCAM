// WO-2871 (the operator 2026-10-16, card Q-UNDO-RIGHT-AFTER-FINISH-EMPTIES): "Undo
// reopens the sketch with everything in it". Finish is ONE undo step: Undo
// right after Finish returns to the open sketch editor with every entity as it
// was, the next Undo removes the last drawn line, and Redo re-applies Finish.
// Driven through the production store actions the toolbar buttons call.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchEntrySnapshot: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
    projectFuture: [],
    sketchFuture: [],
    toolSlicesHistory: [],
    toolSlicesFuture: [],
  }))
})

const st = () => useCamStore.getState()
const partOf = (layerId: string) =>
  st().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
const layerLoops = (layerId: string) =>
  (partOf(layerId)?.loops ?? []).filter((lp) => lp.layerId === layerId)
const userLineIds = () =>
  (st().activeSketch?.entities ?? [])
    .filter((e) => e.kind === 'line' && !e.id.startsWith('__sketch_')).map((e) => e.id)
const tick = () => new Promise((r) => setTimeout(r, 0))

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Each line its own operator action (its own turn), as clicks are. */
async function drawRectangle(): Promise<void> {
  for (const e of [line('b', 0, 0, 10, 0), line('r', 10, 0, 10, 10), line('t', 10, 10, 0, 10), line('l', 0, 10, 0, 0)]) {
    st().addEntity(e)
    await tick()
  }
}

describe('WO-2871 Undo right after Finish reopens the sketch', () => {
  it('Finish -> Undo reopens with everything -> Undo removes last line -> Redo x2 re-finishes', async () => {
    st().startNewSketch()
    const layerId = st().activeSketch!.layerId
    await tick()
    await drawRectangle()
    st().finishSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    expect(st().activeSketch).toBeNull()
    expect(layerLoops(layerId)).toHaveLength(1)

    // Undo #1: the editor is open again with all four lines.
    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(st().activeSketch?.layerId).toBe(layerId)
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l'])
    expect(st().sketchEntrySnapshot).not.toBeNull()

    // Undo #2: the last line is gone, still in the editor.
    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't'])

    // Redo #1: the last line is back, still in the editor.
    st().redo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l'])

    // Redo #2: Finish re-applied - editor closed, the layer has its loop.
    st().redo()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    expect(st().activeSketch).toBeNull()
    expect(st().sketchEntrySnapshot).toBeNull()
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(partOf(layerId)?.sketches?.find((x) => x.layerId === layerId)?.entities
      .filter((e) => e.kind === 'line')).toHaveLength(4)
  })

  it('a re-opened sketch Finished again: Undo returns to the open edit with the edits', async () => {
    st().startNewSketch()
    const layerId = st().activeSketch!.layerId
    const geoId = st().activeSketch!.ownerGeometryId!
    await tick()
    await drawRectangle()
    st().finishSketch()
    await tick()

    expect(st().openSketchForLayer(layerId, geoId)).toBe(true)
    await tick()
    st().addEntity(line('d', 0, 0, 10, 10))
    await tick()
    st().finishSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')

    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l', 'd'])

    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l'])
  })

  // Decide-and-log (WO-2871 result): the reopened session began at the Undo,
  // so its Cancel discards only what happened since - the sketch stays
  // Finished as it was, never an emptied layer or lost work.
  it('Cancel in the reopened sketch returns to the Finished sketch as it was', async () => {
    st().startNewSketch()
    const layerId = st().activeSketch!.layerId
    await tick()
    await drawRectangle()
    st().finishSketch()
    await tick()
    st().undo()
    await tick()
    st().addEntity(line('d', 0, 0, 10, 10))
    await tick()
    st().cancelActiveSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    expect(st().activeSketch).toBeNull()
    expect(st().sketchEntrySnapshot).toBeNull()
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(partOf(layerId)?.sketches?.find((x) => x.layerId === layerId)?.entities
      .filter((e) => e.kind === 'line').map((e) => e.id)).toEqual(['b', 'r', 't', 'l'])
    // The Undo is still redo-able exactly as before the reopen.
    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l'])
  })
})

// WO-2871 fix round 1 (astra audit, reproduced in the live app): an ordinary
// open of the Finished layer clones the undo stacks into its entry snapshot,
// and its Cancel restores those clones. The Finish step must still reopen the
// editor on Undo whatever opened and cancelled in between.
describe('WO-2871 Undo after Finish reopens after other sessions opened and cancelled', () => {
  async function drawAndFinish(): Promise<{ layerId: string; geoId: string }> {
    st().startNewSketch()
    const layerId = st().activeSketch!.layerId
    const geoId = st().activeSketch!.ownerGeometryId!
    await tick()
    await drawRectangle()
    st().finishSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    return { layerId, geoId }
  }

  async function expectUndoReopens(layerId: string): Promise<void> {
    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(st().activeSketch?.layerId).toBe(layerId)
    expect(userLineIds()).toEqual(['b', 'r', 't', 'l'])
    st().undo()
    await tick()
    expect(st().viewer.mode).toBe('sketch')
    expect(userLineIds()).toEqual(['b', 'r', 't'])
  }

  it('Finish -> open the same layer -> Cancel with no edits -> Undo reopens (the judge sequence)', async () => {
    const { layerId, geoId } = await drawAndFinish()
    expect(st().openSketchForLayer(layerId, geoId)).toBe(true)
    await tick()
    st().cancelActiveSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    await expectUndoReopens(layerId)
  })

  it('Finish -> open + edit + Cancel, twice -> Undo reopens', async () => {
    const { layerId, geoId } = await drawAndFinish()
    for (let i = 0; i < 2; i++) {
      expect(st().openSketchForLayer(layerId, geoId)).toBe(true)
      await tick()
      st().addEntity(line(`x${i}`, 0, 0, 10, 10))
      await tick()
      st().cancelActiveSketch()
      await tick()
    }
    await expectUndoReopens(layerId)
  })

  it('Finish -> start a new sketch -> Cancel -> Undo reopens the Finished one', async () => {
    const { layerId } = await drawAndFinish()
    st().startNewSketch()
    await tick()
    st().cancelActiveSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    await expectUndoReopens(layerId)
  })

  it('Finish -> open -> Save while sketching -> Cancel -> Undo reopens', async () => {
    const { layerId, geoId } = await drawAndFinish()
    expect(st().openSketchForLayer(layerId, geoId)).toBe(true)
    await tick()
    st().addEntity(line('d', 0, 0, 10, 10))
    await tick()
    void st().prepareProjectToFile().catch(() => undefined)
    expect(st().viewer.mode).toBe('sketch')
    st().cancelActiveSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    await expectUndoReopens(layerId)
  })

  it('Finish -> open -> switch to a new sketch -> Cancel -> Undo reopens', async () => {
    const { layerId, geoId } = await drawAndFinish()
    expect(st().openSketchForLayer(layerId, geoId)).toBe(true)
    await tick()
    st().startNewSketch()
    await tick()
    st().cancelActiveSketch()
    await tick()
    expect(st().viewer.mode).toBe('setup')
    await expectUndoReopens(layerId)
  })
})

// WO-2871 (moved from WO-2865, sweep 3 H12): the Fillet console line printed a
// dragged radius as R9.47922700765105. Lengths print at the dimension label's
// display precision and in the display units.
describe('WO-2871 fillet/chamfer Apply notices print lengths at display precision', () => {
  async function applyStagedCorner(
    kind: 'fillet' | 'chamfer', size: number, units: 'mm' | 'inch',
  ): Promise<string[]> {
    const { bindSketcherDocument, sketcherTools, sketcherToolStore } =
      await import('../../lib/sketch/sketcher')
    const sk = {
      layerId: 'L', entities: [line('a', -20, 0, 0, 0), line('b', 0, 0, 0, 20)],
      dimensions: [], constraints: [],
    } as unknown as import('../../lib/sketch/types').Sketch
    const notices: string[] = []
    const port = new Proxy({
      getSketch: () => sk,
      getDisplayUnits: () => units,
      notice: (m: string) => { notices.push(m) },
    } as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : () => undefined),
    })
    bindSketcherDocument(port as never)
    const corners = [{ aId: 'a', bId: 'b', hintA: { x: -10, y: 0 }, hintB: { x: 0, y: 10 }, at: { x: 0, y: 0 } }]
    sketcherToolStore.setState(kind === 'fillet'
      ? { tool: 'fillet', filletRadius: size, chain: { kind: 'fillet', corners, pendingLineId: null, pendingClick: null } }
      : { tool: 'chamfer', chamferSetback: size, chain: { kind: 'chamfer', corners, pendingLineId: null, pendingClick: null } } as never)
    sketcherTools.overlayApply()
    bindSketcherDocument(null)
    return notices
  }

  it('a dragged fillet radius reads R9.48, not R9.47922700765105', async () => {
    expect(await applyStagedCorner('fillet', 9.47922700765105, 'mm')).toEqual(['Filleted 1 corner (R9.48)'])
    expect(await applyStagedCorner('fillet', 9.47922700765105, 'inch')).toEqual(['Filleted 1 corner (R0.3732)'])
  })

  it('a dragged chamfer setback reads 2.35 mm, not the raw float', async () => {
    expect(await applyStagedCorner('chamfer', 2.3456789, 'mm')).toEqual(['Chamfered 1 corner (2.35 mm)'])
  })
})
