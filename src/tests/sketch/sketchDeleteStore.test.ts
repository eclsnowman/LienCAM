// Store-level delete regression (Stage 3 fix): deleteSketchSelection
// removes selected demo entities with constraint cleanup as ONE undo
// step, and undo restores the document. Worker + persist storage are
// stubbed (node env) — the solve dispatch is exercised but its response
// is not (solver correctness is covered by the solver suite).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

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
let buildDemoSketch: typeof import('../../lib/sketch/demoSeed').buildDemoSketch

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ buildDemoSketch } = await import('../../lib/sketch/demoSeed'))
})

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
})

describe('deleteSketchSelection', () => {
  it('deletes the selected demo entity with constraint/dimension cleanup', () => {
    const s = useCamStore.getState()
    s.setActiveSketch(buildDemoSketch())
    s.setSketchSelection(['demo-rect-bottom'])
    useCamStore.getState().deleteSketchSelection()

    const after = useCamStore.getState()
    const sk = after.activeSketch!
    expect(sk.entities.map((e) => e.id)).not.toContain('demo-rect-bottom')
    expect(sk.constraints.map((c) => c.id)).not.toContain('demo-h-bottom')
    expect(sk.constraints.map((c) => c.id)).not.toContain('demo-fix-bl')
    expect(sk.dimensions.map((d) => d.id)).not.toContain('demo-dim-width')
    expect(after.sketchSelectedIds).toEqual([])
  })

  it('undo restores the deleted entity (one history step)', () => {
    const s = useCamStore.getState()
    s.setActiveSketch(buildDemoSketch())
    const before = useCamStore.getState().activeSketch!
    s.setSketchSelection(['demo-circle'])
    useCamStore.getState().deleteSketchSelection()
    expect(useCamStore.getState().activeSketch!.entities.length)
      .toBe(before.entities.length - 1)

    useCamStore.getState().undo()
    const restored = useCamStore.getState().activeSketch!
    expect(restored.entities.length).toBe(before.entities.length)
    expect(restored.entities.map((e) => e.id)).toContain('demo-circle')
    expect(restored.constraints.map((c) => c.id)).toContain('demo-tangent')
  })

  it('no-ops cleanly with nothing selected or no sketch', () => {
    useCamStore.getState().deleteSketchSelection() // no sketch: no throw
    const s = useCamStore.getState()
    s.setActiveSketch(buildDemoSketch())
    const n = useCamStore.getState().activeSketch!.entities.length
    useCamStore.getState().deleteSketchSelection() // empty selection
    expect(useCamStore.getState().activeSketch!.entities.length).toBe(n)
  })

  it('deleting EVERYTHING leaves a valid empty sketch (no solve crash path)', () => {
    const s = useCamStore.getState()
    s.setActiveSketch(buildDemoSketch())
    const all = useCamStore.getState().activeSketch!.entities.map((e) => e.id)
    s.setSketchSelection(all)
    useCamStore.getState().deleteSketchSelection()
    const sk = useCamStore.getState().activeSketch!
    // WO SKC-49: "everything" (all, including the three injected anchors) still leaves the
    // protected origin/axis anchors behind -- the delete guard refuses them by name.
    expect(sk.entities).toHaveLength(3)
    expect(sk.entities.every((e) => e.construction)).toBe(true)
    expect(sk.constraints).toHaveLength(3)
    expect(sk.dimensions).toHaveLength(0)
  })
})
