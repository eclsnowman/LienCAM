// WO-1480: a refused construction click explains itself instead of doing nothing.
//
// BUG-542/BUG-543/BUG-395 (family K9): `circleClick` (3pt collinear third point),
// `arcClick` (3pt collinear third point, tangent-arc degenerate endpoint) and
// `arcSlotClick` (zero-width / over-wide fourth click) all returned the unchanged
// chain and a null commit with NOTHING attached explaining why -- the operator's
// click appeared to do nothing. `toolMachine.ts`'s smart-dimension branch already
// forwards a click result's `notice` into the `TickResult`, and toolController's
// single `click()` entry point already flashes `r.notice` unconditionally (ADR-0003).
// This file drives the REAL click path (`sketcherTools.click`, the same entry point
// the canvas uses) end to end and proves: a named notice fires, the staged chain
// survives the refusal untouched, and a valid correcting click still commits.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bindSketcherDocument, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import type { CircleChainState } from '../../lib/sketch/tools/circleTools'
import type { ArcChainState } from '../../lib/sketch/tools/arcTools'
import type { ArcSlotChainState } from '../../lib/sketch/tools/polygonSlotTools'

interface Harness {
  sketch: Sketch
  selection: string[]
  notices: string[]
  doc: SketchDocumentPort
}

function makeHarness(entities: SketchEntity[]): Harness {
  const h = {
    sketch: {
      id: 'wo1480-sketch', layerId: 'l', entities, constraints: [], dimensions: [],
      solveStatus: null,
    } as Sketch,
    selection: [] as string[],
    notices: [] as string[],
  }
  const doc: SketchDocumentPort = {
    getSketch: () => h.sketch,
    ensureSketch: () => h.sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => h.selection,
    setSelection: (ids) => { h.selection = ids },
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: (m) => { h.notices.push(m) },
    beginStep: () => {},
    append: (commit, inferred) => {
      h.sketch = {
        ...h.sketch,
        entities: [...h.sketch.entities, ...commit.entities],
        constraints: [...h.sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...h.sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: (next) => { h.sketch = { ...h.sketch, ...next } },
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }
  return Object.assign(h, { doc })
}

beforeEach(() => {
  sketcherToolStore.__reset()
})

afterEach(() => {
  bindSketcherDocument(null)
})

describe('WO-1480: Circle (3pt) collinear third pick explains itself', () => {
  it('names the collinearity, keeps p1/p2 staged, and a correcting click still commits', () => {
    const h = makeHarness([])
    bindSketcherDocument(h.doc)
    sketcherTools.armTool('circle-3pt')

    sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false)
    sketcherTools.click({ x: 10, y: 0 }, 0.05, null, false)
    expect(h.notices).toHaveLength(0)

    // Third click collinear with the first two: refused, explained.
    sketcherTools.click({ x: 5, y: 0 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatch(/collinear/i)
    expect(h.sketch.entities).toHaveLength(0) // nothing committed

    const chain = sketcherToolStore.getState().chain as CircleChainState
    expect(chain?.kind).toBe('circle')
    expect(chain?.p1).toEqual({ x: 0, y: 0 })
    expect(chain?.p2).toEqual({ x: 10, y: 0 })

    // A valid correcting click still commits the circle (the refusal never latches).
    sketcherTools.click({ x: 5, y: 5 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1) // no new notice on the successful commit
    expect(h.sketch.entities).toHaveLength(1)
    expect(h.sketch.entities[0].kind).toBe('circle')
    expect(sketcherToolStore.getState().chain).toBeNull()
  })
})

describe('WO-1480: Tangent Arc endpoint-on-the-tangent-line explains itself', () => {
  it('names the degenerate endpoint, keeps the anchor staged, and a correcting click still commits', () => {
    // A line ending at (10,0), leaving direction (1,0) -> the tangent line at that
    // endpoint is y=0 (any point sharing that y is "on the tangent line").
    const anchorLine: SketchEntity = {
      id: 'anchor', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    const h = makeHarness([anchorLine])
    bindSketcherDocument(h.doc)
    sketcherTools.armTool('arc-tangent')

    // First click picks the endpoint (within tolerance of (10,0)).
    sketcherTools.click({ x: 10, y: 0 }, 0.05, null, false)
    expect(h.notices).toHaveLength(0)
    const armed = sketcherToolStore.getState().chain as ArcChainState
    expect(armed?.kind).toBe('arc')

    // Second click lands ON the tangent line: no finite arc exists there.
    sketcherTools.click({ x: 20, y: 0 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatch(/tangent/i)
    expect(h.notices[0]).toMatch(/no finite arc/i)
    expect(h.sketch.entities).toHaveLength(1) // still just the anchor line

    const chain = sketcherToolStore.getState().chain as ArcChainState
    expect(chain?.kind).toBe('arc')
    expect(chain?.mode).toBe('tangent')

    // A valid correcting click still commits the tangent arc.
    sketcherTools.click({ x: 15, y: 5 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1) // no new notice on the successful commit
    expect(h.sketch.entities).toHaveLength(2)
    expect(h.sketch.entities.some((e) => e.kind === 'arc')).toBe(true)
    expect(sketcherToolStore.getState().chain).toBeNull()
  })
})

describe('WO-1480: Arc Slot zero-width / over-wide fourth pick explains itself', () => {
  // Centerline start/end/thru all sit on a circle of radius 5 centered at the origin.
  const START = { x: -5, y: 0 }
  const END = { x: 5, y: 0 }
  const THRU = { x: 0, y: 5 }

  function stageCenterline(): void {
    sketcherTools.armTool('slot-arc')
    sketcherTools.click(START, 0.05, null, false)
    sketcherTools.click(END, 0.05, null, false)
    sketcherTools.click(THRU, 0.05, null, false)
  }

  it('zero-width click names the usable-range problem and keeps the centerline staged', () => {
    const h = makeHarness([])
    bindSketcherDocument(h.doc)
    stageCenterline()
    expect(h.notices).toHaveLength(0)

    // (3,4) sits exactly on the centerline circle (radius 5) -> zero width.
    sketcherTools.click({ x: 3, y: 4 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatch(/arc slot/i)
    expect(h.notices[0]).toMatch(/zero/i)
    expect(h.sketch.entities).toHaveLength(0)

    const chain = sketcherToolStore.getState().chain as ArcSlotChainState
    expect(chain?.kind).toBe('slotArc')
    expect(chain?.start).toEqual(START)
    expect(chain?.end).toEqual(END)
    expect(chain?.thru).toEqual(THRU)

    // A valid correcting width click still commits the arc slot.
    sketcherTools.click({ x: 0, y: 7 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1) // no new notice on the successful commit
    expect(h.sketch.entities.length).toBeGreaterThan(0)
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('over-wide click (inner boundary would invert) names the problem and keeps the centerline staged', () => {
    const h = makeHarness([])
    bindSketcherDocument(h.doc)
    stageCenterline()

    // The centerline center (0,0) is distance 5 from the circle -> half-width == radius
    // exactly, which would invert the inner boundary.
    sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatch(/arc slot/i)
    expect(h.notices[0]).toMatch(/wide/i)
    expect(h.sketch.entities).toHaveLength(0)

    const chain = sketcherToolStore.getState().chain as ArcSlotChainState
    expect(chain?.kind).toBe('slotArc')
    expect(chain?.thru).toEqual(THRU)

    // A valid correcting width click still commits the arc slot.
    sketcherTools.click({ x: 0, y: 7 }, 0.05, null, false)
    expect(h.notices).toHaveLength(1) // no new notice on the successful commit
    expect(h.sketch.entities.length).toBeGreaterThan(0)
    expect(sketcherToolStore.getState().chain).toBeNull()
  })
})
