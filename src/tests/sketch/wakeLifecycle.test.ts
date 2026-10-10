// Store-level hover-wake lifecycle (Stage 4 user addition): hovering a
// snappable point through the sketcher snap engine WAKES it into the package
// tool store's wakeRefs; a remote-aligned commit creates the real two-point
// horizontal/vertical constraint to the woken site and clears the set; Esc /
// tool change / off-guide commits leave no constraint and no stale wake state.
// Worker + persist storage are stubbed (node env) — solver correctness is
// covered by the solver suite.
//
// WO SKC-14B: the tool slice moved out of the CAM store into the sketcher
// package. The armed tool, the chain, the snap engine and the woken alignment
// refs are now driven through `sketcherTools` and read from
// `sketcherToolStore`; `activeSketch`/history stay on the CAM store.

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
let createBlankSketch: typeof import('../../lib/sketch/blankSketch').createBlankSketch
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import MUST come first: loading src/store binds the CAM document
  // sink into the sketcher package, so `sketcherTools` has a document to drive.
  ;({ useCamStore } = await import('../../store'))
  ;({ createBlankSketch } = await import('../../lib/sketch/blankSketch'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

const WPP = 0.1 // snap radius 1 mm
const TOL = 0.5

const st = () => useCamStore.getState()

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  sketcherTools.armTool('select') // clears chain, pending snaps, wake refs
  st().setActiveSketch(createBlankSketch('wake-test-layer'))
})

/** Draw one line (0,0)->(10,0) with the REAL tool path; returns its id. */
function drawSeedLine(): string {
  sketcherTools.armTool('line')
  sketcherTools.click({ x: 0, y: 0 }, TOL, null, false)
  sketcherTools.click({ x: 10, y: 0 }, TOL, null, false)
  sketcherTools.end()
  const sk = st().activeSketch!
  // WO SKC-49: the blank sketch already owns three injected anchors (appended AFTER any prior
  // entities, never before) -- the drawn line is the one non-construction entity, not entities[0].
  const drawn = sk.entities.filter((e) => !e.construction)
  expect(drawn).toHaveLength(1)
  return drawn[0].id
}

describe('hover-wake store lifecycle', () => {
  it('hovering an endpoint through sketchSnap wakes it', () => {
    const lineId = drawSeedLine()
    sketcherTools.armTool('line')
    const hover = sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP)
    expect(hover?.kind).toBe('endpoint')
    expect(sketcherToolStore.getState().wakeRefs).toEqual([
      { point: { x: 10, y: 0 }, ref: { entityId: lineId, site: 'end' } },
    ])
  })

  it('remote-aligned commit creates the two-point constraint and clears the set', () => {
    const lineId = drawSeedLine()
    sketcherTools.armTool('line')
    sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP) // wake the endpoint
    sketcherTools.click({ x: 0, y: -20 }, TOL, null, false) // chain anchor (off-axis)
    // Cursor far right, level with the woken endpoint: remote h-align.
    const snap = sketcherTools.snap({ x: 30, y: 0.3 }, WPP)
    expect(snap?.kind).toBe('h-align')
    expect(snap!.point).toEqual({ x: 30, y: 0 })
    expect(snap!.alignFrom).toEqual({ x: 10, y: 0 })

    sketcherTools.click(snap!.point, TOL, snap, false) // commit the segment
    const sk = st().activeSketch!
    // WO SKC-49: 2 user lines + 3 injected anchors.
    expect(sk.entities).toHaveLength(5)
    const drawnLines = sk.entities.filter((e) => !e.construction)
    expect(drawnLines).toHaveLength(2)
    const newLine = drawnLines[1]
    const hv = sk.constraints.find(
      (c) => c.kind === 'horizontal' && 'points' in c && c.points
    )
    expect(hv).toBeDefined()
    expect(hv).toMatchObject({
      kind: 'horizontal',
      points: [
        { entityId: newLine.id, site: 'end' },
        { entityId: lineId, site: 'end' },
      ],
    })
    // Commit cleared the woken references.
    expect(sketcherToolStore.getState().wakeRefs).toEqual([])
  })

  it('committing OFF-guide creates no alignment constraint', () => {
    const lineId = drawSeedLine()
    sketcherTools.armTool('line')
    sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP) // wake
    sketcherTools.click({ x: 0, y: -20 }, TOL, null, false)
    // Cursor nowhere near the woken Y or X: no snap at all.
    const snap = sketcherTools.snap({ x: 30, y: -12 }, WPP)
    expect(snap).toBeNull()
    sketcherTools.click({ x: 30, y: -12 }, TOL, snap, false)
    const sk = st().activeSketch!
    // WO SKC-49: 2 user lines + 3 injected anchors.
    expect(sk.entities).toHaveLength(5)
    expect(
      sk.constraints.some((c) => c.kind === 'horizontal' || c.kind === 'vertical')
    ).toBe(false)
    void lineId
  })

  it('Esc clears the wake set', () => {
    drawSeedLine()
    sketcherTools.armTool('line')
    sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP)
    expect(sketcherToolStore.getState().wakeRefs).toHaveLength(1)
    expect(sketcherTools.escape()).toBe(true) // ARMED -> SELECT
    expect(sketcherToolStore.getState().wakeRefs).toEqual([])
  })

  it('tool change clears the wake set', () => {
    drawSeedLine()
    sketcherTools.armTool('line')
    sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP)
    expect(sketcherToolStore.getState().wakeRefs).toHaveLength(1)
    sketcherTools.armTool('rect-corner')
    expect(sketcherToolStore.getState().wakeRefs).toEqual([])
  })

  it('the smart-dimension tool never wakes references', () => {
    drawSeedLine()
    sketcherTools.armTool('smart-dimension')
    sketcherTools.snap({ x: 10.2, y: 0.1 }, WPP)
    expect(sketcherToolStore.getState().wakeRefs).toEqual([])
  })
})
