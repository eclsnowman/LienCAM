// @vitest-environment jsdom
//
// WO-1860: a DXF or SVG file lands as editable entities in the OPEN sketch --
// no CAM layer, no separate lift step the operator has to run. Drives
// toolController.importFileIntoSketch (the host-neutral commit path both
// SketchToolbox.tsx and WorkbenchToolRail.tsx wire) through a minimal
// SketchDocumentPort mock, same style as sketchClipboard.test.ts's
// keyboardFixture -- proves the WIRING (parse -> curve-fit -> lift -> commit)
// without a real host or CAM's store.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  bindSketcherDocument, importFileIntoSketch,
} from '../../lib/sketch/sketcher/toolController'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import type {
  Sketch, SketchArcEntity, SketchCircleEntity, SketchConstraint, SketchEntity, SketchLineEntity,
} from '../../lib/sketch/types'

function dxf(pairs: Array<[number | string, string]>): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}

// A rectangle (0,0)-(100,60) with the two BOTTOM corners filleted (R10) plus a
// standalone circle, well clear of the rectangle. Hand-computed so every
// LINE/ARC endpoint matches its neighbor exactly (joinSegments' JOIN_TOL is
// 0.05mm -- no slack needed, but exact keeps the fixture legible).
const RECT_TWO_FILLETS_PLUS_CIRCLE = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LINE'], [8, 'Cut'], [10, '10.0'], [20, '0.0'], [11, '90.0'], [21, '0.0'],
  [0, 'ARC'], [8, 'Cut'], [10, '90.0'], [20, '10.0'], [40, '10.0'], [50, '270.0'], [51, '360.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '100.0'], [20, '10.0'], [11, '100.0'], [21, '60.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '100.0'], [20, '60.0'], [11, '0.0'], [21, '60.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '60.0'], [11, '0.0'], [21, '10.0'],
  [0, 'ARC'], [8, 'Cut'], [10, '10.0'], [20, '10.0'], [40, '10.0'], [50, '180.0'], [51, '270.0'],
  [0, 'CIRCLE'], [8, 'Cut'], [10, '150.0'], [20, '30.0'], [40, '8.0'],
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

function dxfFile(name = 'part.dxf', text = RECT_TWO_FILLETS_PLUS_CIRCLE): File {
  return new File([text], name, { type: 'application/dxf' })
}

// A plain closed rectangle, straight edges only, no fillets, no arcs -- the
// canonical DXF shape the audit found collapsing toward a triangle: the
// curve fit's greedy pass over a closed loop's raw points never wraps its
// last segment back to the first, so this shape's closing edge (unlike the
// fillet fixture above, which happens to end on an arc) has nothing to mask
// the drop.
const PLAIN_RECT = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [11, '100.0'], [21, '0.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '100.0'], [20, '0.0'], [11, '100.0'], [21, '60.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '100.0'], [20, '60.0'], [11, '0.0'], [21, '60.0'],
  [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '60.0'], [11, '0.0'], [21, '0.0'],
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

// A closed D-shape (diameter line + cubic-bezier "bulge" back to the start),
// the same shape lift.test.ts's mixed line+arc case uses, but authored as an
// SVG cubic path -- the acceptance's "path with cubic segments" fixture.
const D_SHAPE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <path stroke="#4ac3ff" fill="none" d="M 0 10 L 40 10 C 40 -5, 0 -5, 0 10 Z"/>
</svg>`

function svgFile(name = 'part.svg', text = D_SHAPE_SVG): File {
  return new File([text], name, { type: 'image/svg+xml' })
}

function lines(es: SketchEntity[]): SketchLineEntity[] {
  return es.filter((e): e is SketchLineEntity => e.kind === 'line')
}
function arcs(es: SketchEntity[]): SketchArcEntity[] {
  return es.filter((e): e is SketchArcEntity => e.kind === 'arc')
}
function circles(es: SketchEntity[]): SketchCircleEntity[] {
  return es.filter((e): e is SketchCircleEntity => e.kind === 'circle')
}

/** A chain entity's endpoint counts as "chained" only when a coincident
 *  constraint names it -- accidental point equality is not enough (dragging
 *  one entity must move its neighbor, which only the solver constraint
 *  guarantees). Used both to prove the real import IS chained and, as the
 *  WO's required negative control, that the same check correctly reports
 *  UNCHAINED when the joint constraints are skipped. */
function allEndpointsConstrained(entityIds: string[], constraints: SketchConstraint[]): boolean {
  const sites = new Set<string>()
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    sites.add(`${c.a.entityId}:${c.a.site}`)
    sites.add(`${c.b.entityId}:${c.b.site}`)
  }
  return entityIds.every((id) => sites.has(`${id}:start`) && sites.has(`${id}:end`))
}

interface Fixture {
  getSketch: () => Sketch
  beginStepCalls: number
  notices: Array<{ message: string; severity?: string }>
}

function fixture(): Fixture {
  let sketch: Sketch = createBlankSketch('layer-under-test')
  let beginStepCalls = 0
  const notices: Array<{ message: string; severity?: string }> = []
  const port: SketchDocumentPort = {
    getSketch: () => sketch,
    ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 1,
    getProjectCandidates: () => [],
    getSelection: () => [],
    setSelection: () => {},
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: (message, severity) => { notices.push({ message, severity }) },
    beginStep: () => { beginStepCalls++ },
    append: (commit, inferred) => {
      sketch = {
        ...sketch,
        entities: [...sketch.entities, ...commit.entities],
        constraints: [...sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: () => {},
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
  bindSketcherDocument(port)
  return {
    getSketch: () => sketch,
    get beginStepCalls() { return beginStepCalls },
    notices,
  }
}

describe('importFileIntoSketch: DXF into an open sketch', () => {
  beforeEach(() => {
    bindSketcherDocument(null)
  })

  it('lands line, arc AND circle entities, chained with coincident joints -- no CAM layer involved', async () => {
    const f = fixture()
    await importFileIntoSketch(dxfFile())

    const sk = f.getSketch()
    // 4 straight sides, 2 R10 fillet arcs, 1 standalone circle -- the closed
    // rectangle's own last fillet arc already samples its way back within a
    // hair of the first LINE's start (real geometry, not the missing-edge
    // gap the audit found on a plain rectangle), so no extra closing edge is
    // added here.
    expect(lines(sk.entities)).toHaveLength(4)
    expect(arcs(sk.entities)).toHaveLength(2)
    expect(circles(sk.entities)).toHaveLength(1)
    expect(circles(sk.entities)[0].radius).toBeCloseTo(8, 1)

    // The outer chain (everything except the standalone circle) is fully
    // joined: every entity's start AND end site is named by a coincident
    // constraint -- immediately draggable as a connected chain.
    const chainIds = sk.entities.filter((e) => e.kind !== 'circle').map((e) => e.id)
    expect(allEndpointsConstrained(chainIds, sk.constraints)).toBe(true)
    // No fix constraints: under-defined blue is correct for a fresh import.
    expect(sk.constraints.every((c) => c.kind === 'coincident')).toBe(true)

    // NEGATIVE CONTROL (WO acceptance): skipping the chain-joint constraints
    // makes the SAME "immediately draggable as a chain" check fail -- proving
    // the positive assertion above actually exercises the defect it guards.
    expect(allEndpointsConstrained(chainIds, [])).toBe(false)
  })

  it('a plain closed rectangle (straight edges, no fillets) lands as FOUR lines, not three (WO-1860 audit)', async () => {
    const f = fixture()
    await importFileIntoSketch(dxfFile('rect.dxf', PLAIN_RECT))

    const sk = f.getSketch()
    // The bug: the curve fit's greedy pass never wraps a closed loop's last
    // segment back to its first point, so the closing edge was silently
    // dropped -- a plain rectangle landed as 3 lines (a deformed triangle)
    // instead of 4.
    expect(arcs(sk.entities)).toHaveLength(0)
    expect(circles(sk.entities)).toHaveLength(0)
    expect(lines(sk.entities)).toHaveLength(4)

    // Not just 4 entities -- 4 DISTINCT corners, each shared by exactly two
    // lines. A missing closing edge leaves the "closing" coincident
    // constraint naming two points that were never actually coincident.
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    const corners = new Map<string, number>()
    for (const l of lines(sk.entities)) {
      corners.set(key(l.start), (corners.get(key(l.start)) ?? 0) + 1)
      corners.set(key(l.end), (corners.get(key(l.end)) ?? 0) + 1)
    }
    expect(corners.size).toBe(4)
    expect([...corners.values()].every((count) => count === 2)).toBe(true)

    const chainIds = sk.entities.map((e) => e.id)
    expect(allEndpointsConstrained(chainIds, sk.constraints)).toBe(true)
  })

  it('is ONE undo step for the whole import', async () => {
    const f = fixture()
    await importFileIntoSketch(dxfFile())
    expect(f.beginStepCalls).toBe(1)
  })

  it('a second import of the SAME file into the SAME sketch does not collide ids', async () => {
    const f = fixture()
    const file = dxfFile()
    await importFileIntoSketch(file)
    const afterFirst = f.getSketch().entities.length
    await importFileIntoSketch(file)
    const sk = f.getSketch()

    expect(sk.entities).toHaveLength(afterFirst * 2)
    expect(new Set(sk.entities.map((e) => e.id)).size).toBe(sk.entities.length)
    expect(new Set(sk.constraints.map((c) => c.id)).size).toBe(sk.constraints.length)
    expect(f.beginStepCalls).toBe(2)
  })

  it('names the DXF unit conversion / gap-join report in one console line (WO-1840 reuse) and never silences a bad file', async () => {
    const f = fixture()
    await importFileIntoSketch(dxfFile('bracket.dxf'))
    expect(f.notices).toHaveLength(1)
    expect(f.notices[0].message).toContain('bracket.dxf')

    const f2 = fixture()
    await importFileIntoSketch(new File(['not a dxf'], 'notes.txt'))
    expect(f2.getSketch().entities).toHaveLength(0)
    expect(f2.notices).toHaveLength(1)
    expect(f2.notices[0].severity).toBe('warning')
  })
})

describe('importFileIntoSketch: SVG (cubic path) into an open sketch', () => {
  beforeEach(() => {
    bindSketcherDocument(null)
  })

  it('lands the cubic-bezier D-shape as chained, editable sketch geometry', async () => {
    const f = fixture()
    await importFileIntoSketch(svgFile())

    const sk = f.getSketch()
    expect(sk.entities.length).toBeGreaterThan(0)
    expect(sk.entities.every((e) => e.kind === 'line' || e.kind === 'arc')).toBe(true)
    const chainIds = sk.entities.map((e) => e.id)
    // Closed loop: every entity's endpoints are named by a joint (interior
    // joints plus the closing joint back to the first entity).
    expect(allEndpointsConstrained(chainIds, sk.constraints)).toBe(true)
    expect(allEndpointsConstrained(chainIds, [])).toBe(false)

    expect(f.beginStepCalls).toBe(1)
    expect(f.notices[0].message).toContain('curves fit to line/arc segments')
  })
})
