// Construction toggle UX contract — headless store coverage.
//
// Stage 6-UX gate scenario 09 found the trap: clicking the Construction
// button with a (possibly stale/off-screen) entity selection silently
// flipped THOSE entities' flags — no flash notice, no button change — so
// a naive user believed they toggled draw-as-construction mode and then
// leaked the mode ON with a second click. The fixed contract:
//
//   1. SELECTION flip flashes the notice channel with what happened
//      ("Toggled construction on N entities") and flips the flags.
//   2. MODE toggle (no entity selection) flashes too ("Construction
//      mode ON - new geometry will be construction" / OFF variant).
//   3. A selection flip NEVER changes sketchConstructionMode — the
//      toolbox button's lit state reflects the MODE only, so it must
//      not move on a selection action.
//
// Store-import stubs: same pattern as layerLocking.test.ts (the toggle
// never touches the solver, so a no-op Worker suffices).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

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
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import binds the CAM document sink into the package (module-load
  // side effect), so it MUST come before anything drives sketcherTools.
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

const ENTITIES: SketchEntity[] = [
  { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
  { id: 'c1', kind: 'circle', construction: false, center: { x: 5, y: 2 }, radius: 1 },
]

function sketchWith(entities: SketchEntity[]): Sketch {
  const sk = createBlankSketch('layer-1')
  return { ...sk, entities }
}

beforeEach(() => {
  useCamStore.setState({
    activeSketch: sketchWith(ENTITIES),
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  // Tool state (armed tool, chain, construction mode) now lives in the package.
  sketcherToolStore.__reset()
})

describe('selection flip (entities selected)', () => {
  it('flips the flags AND flashes what happened (plural)', () => {
    useCamStore.setState({ sketchSelectedIds: ['l1', 'c1'] })
    sketcherTools.toggleConstruction()
    const s = useCamStore.getState()
    const byId = new Map(s.activeSketch!.entities.map((e) => [e.id, e]))
    expect(byId.get('l1')!.construction).toBe(true)
    expect(byId.get('c1')!.construction).toBe(true)
    expect(byId.get('l2')!.construction).toBe(false)
    // The flash names the action — never a silent flip (gate 09 trap).
    expect(s.sketchNotice).toBe('Toggled construction on 2 entities')
  })

  it('uses the singular for one entity', () => {
    useCamStore.setState({ sketchSelectedIds: ['l2'] })
    sketcherTools.toggleConstruction()
    expect(useCamStore.getState().sketchNotice)
      .toBe('Toggled construction on 1 entity')
  })

  it('NEVER changes the draw-as-construction mode (button state)', () => {
    useCamStore.setState({ sketchSelectedIds: ['l1', 'l2'] })
    sketcherTools.toggleConstruction()
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
    // And from the other mode polarity too.
    sketcherToolStore.setState({ constructionMode: true })
    sketcherTools.toggleConstruction()
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
  })

  it('counts only ids that are entities (mixed selection)', () => {
    useCamStore.setState({ sketchSelectedIds: ['l1', 'some-constraint-id'] })
    sketcherTools.toggleConstruction()
    const s = useCamStore.getState()
    expect(s.sketchNotice).toBe('Toggled construction on 1 entity')
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
  })
})

describe('mode toggle (no entity selection)', () => {
  it('flashes mode ON with the consequence spelled out', () => {
    sketcherTools.toggleConstruction()
    const s = useCamStore.getState()
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
    expect(s.sketchNotice)
      .toBe('Construction mode ON - new geometry will be construction')
    // Entities untouched.
    expect(s.activeSketch!.entities.every((e) => !e.construction)).toBe(true)
  })

  it('flashes mode OFF on the way back', () => {
    sketcherToolStore.setState({ constructionMode: true })
    sketcherTools.toggleConstruction()
    const s = useCamStore.getState()
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
    expect(s.sketchNotice)
      .toBe('Construction mode OFF - new geometry will be normal')
  })

  it('a selection of NON-entities falls back to the mode toggle, flashed', () => {
    useCamStore.setState({ sketchSelectedIds: ['some-constraint-id'] })
    sketcherTools.toggleConstruction()
    const s = useCamStore.getState()
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
    expect(s.sketchNotice)
      .toBe('Construction mode ON - new geometry will be construction')
  })
})
