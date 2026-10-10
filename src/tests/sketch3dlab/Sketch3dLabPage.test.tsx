// @vitest-environment jsdom
//
// Sketch3d Lab page (WO INT-2, acceptance criteria 1-3): mounts the REAL Sketch3dLabPage against
// the REAL planegcs solve service (no fakes - same convention src/tests/sketch3d's own suite
// uses, since createSketch3dGcsWrapper's Node-path wasm load works fine under vitest's default
// 'node' test environment even with the jsdom DOM shimmed in for this file). Drives every click
// through real fireEvent pointer/click events on the canvas and toolbar, exactly as a real
// browser session (or the Playwright M2 demo script) would - no internal API bypass.
//
// The big integration test below recreates the M2 bracket demo end to end (draw a rough 3-line
// + 1-arc open profile, auto-constrain 2 of its 4 joints via an inference suggestion, add the
// other 9 explicit constraints one tool-click at a time, reach "Fully constrained", provoke a
// conflicting dimension, resolve it by deleting the glyph) - the same flow
// coordination/evidence/INT-2's real-Chromium script drives, proving it first against the fast,
// deterministic jsdom harness. Every explicit-constraint click position is read back from the
// page's own __sketch3dlabTestHooks.getDocument() right before clicking, never hard-coded to the
// as-drawn coordinates - a constraint solve moves entities, so a scripted driver (like a real
// user watching the screen) must click where things CURRENTLY are.
import { describe, it, expect, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'
import type { Sketch3dArcEntity, Sketch3dCircleEntity, Sketch3dLineEntity, Sketch3dVec2 } from '../../sketch3d'

afterEach(cleanup)

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

function click(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y })
}

function move(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerMove(canvas, { clientX: x, clientY: y })
}

function up(): void {
  fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))
}

function useTool(tool: 'select' | 'line' | 'circle' | 'arc' | 'drag'): void {
  fireEvent.click(screen.getByTestId(`sketch3dlab-tool-${tool}`))
}

function counts(): { entities: number; constraints: number } {
  return {
    entities: Number(screen.getByTestId('sketch3dlab-entity-count').textContent),
    constraints: Number(screen.getByTestId('sketch3dlab-constraint-count').textContent),
  }
}

function dofLabel(): string {
  return screen.getByTestId('sketch3dlab-dof-chip').textContent ?? ''
}

function currentEntity(id: string) {
  const doc = window.__sketch3dlabTestHooks!.getDocument()
  const entity = doc.entities.find((e) => e.id === id)
  if (!entity) throw new Error(`test: entity '${id}' not found in current document`)
  return entity
}

function linePoint(id: string, site: 'start' | 'end'): Sketch3dVec2 {
  const line = currentEntity(id) as Sketch3dLineEntity
  return site === 'start' ? line.start : line.end
}

function lineMid(id: string): Sketch3dVec2 {
  return linePointAt(id, 0.5)
}

// A non-midpoint entity-body pick point: an existing constraint glyph on this line (e.g. a
// horizontal/vertical constraint) anchors EXACTLY at the midpoint (entityAnchor in
// src/sketch3d/constraintGeometry.ts), so picking fraction 0.5 there would hit the glyph
// (checked first) instead of the entity body. Any other fraction lands on the segment away from
// both endpoints and that glyph.
function linePointAt(id: string, t: number): Sketch3dVec2 {
  const line = currentEntity(id) as Sketch3dLineEntity
  return { x: line.start.x + t * (line.end.x - line.start.x), y: line.start.y + t * (line.end.y - line.start.y) }
}

function arcRingPoint(id: string): Sketch3dVec2 {
  const arc = currentEntity(id) as Sketch3dArcEntity
  const angle = (arc.startAngle + arc.endAngle) / 2
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) }
}

// The arc's own 'start'/'end' constrainable POINTS (for point-level picks like coincident),
// distinct from arcRingPoint (a generic ring position for entity-level picks like tangent).
function arcPoint(id: string, site: 'start' | 'end' | 'center'): Sketch3dVec2 {
  const arc = currentEntity(id) as Sketch3dArcEntity
  if (site === 'center') return arc.center
  const angle = site === 'start' ? arc.startAngle : arc.endAngle
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) }
}

function setValue(v: string): void {
  fireEvent.change(screen.getByTestId('sketch3dlab-value-input'), { target: { value: v } })
}

// WO SKC-8F (R1 Major 2): jsdom's HTMLCanvasElement ships no 2D context backend at all
// (getContext('2d') returns null), so the page's paint effect silently no-ops there - the audit's
// exact finding is that no lab test would fail if the amber hover stroke were removed. This
// installs a minimal fake 2D context that records every stroke() call's CURRENT strokeStyle/
// lineWidth, and resets that log on clearRect() (the paint effect's first call each run), so
// strokes() always reflects only the latest paint - one entry per document.entities element, in
// that array's order, exactly matching the real paint loop's per-entity stroke() call.
type MockStroke = { strokeStyle: string; lineWidth: number }

function installStrokeRecordingCanvas(): { strokes: () => MockStroke[]; restore: () => void } {
  let strokes: MockStroke[] = []
  const ctx = {
    clearRect: () => { strokes = [] },
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    fillText: () => {},
    strokeStyle: '',
    lineWidth: 1,
    fillStyle: '',
    font: '',
    stroke: () => {},
  }
  ctx.stroke = () => { strokes.push({ strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth }) }
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext
  return {
    strokes: () => strokes,
    restore: () => { HTMLCanvasElement.prototype.getContext = original },
  }
}

describe('Sketch3dLabPage render smoke test', () => {
  it('mounts, boots the real solver, and reaches ready', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    expect(dofLabel()).toBe('Empty sketch')
    expect(counts()).toEqual({ entities: 0, constraints: 0 })
  })

  it('renders every draw/drag tool and every constraint tool button', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    for (const tool of ['select', 'line', 'circle', 'arc', 'drag']) {
      expect(screen.getByTestId(`sketch3dlab-tool-${tool}`)).toBeTruthy()
    }
    for (const kind of [
      'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal',
      'midpoint', 'distance', 'angle', 'radius', 'diameter', 'fixed',
    ]) {
      expect(screen.getByTestId(`sketch3dlab-constraint-${kind}`)).toBeTruthy()
    }
  })
})

describe('Sketch3dLabPage draw tools (criterion 1)', () => {
  it('line tool: 2 clicks create a line entity', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('line')
    click({ x: 1, y: 1 })
    click({ x: 8, y: 5 }) // oblique - no inference expected
    await waitFor(() => expect(counts().entities).toBe(1))
    expect(screen.queryByTestId('sketch3dlab-inference-panel')).toBeNull()
  })

  it('circle tool: 2 clicks (center, radius point) create a circle entity', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('circle')
    click({ x: 30, y: 30 })
    click({ x: 34, y: 30 })
    await waitFor(() => expect(counts().entities).toBe(1))
  })

  it('arc tool: 3 clicks (start, end, through-point) create an arc entity (WO SKC-8 A2)', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('arc')
    // Equivalent quarter circle to the old center=(40,5) r=5.4 fixture: start/end on the circle,
    // through-point on the minor arc between them.
    const center = { x: 40, y: 5 }
    const r = 5.4
    click({ x: center.x + r, y: center.y }) // start, angle 0
    click({ x: center.x, y: center.y + r }) // end, angle 90deg
    click({ x: center.x + r * Math.SQRT1_2, y: center.y + r * Math.SQRT1_2 }) // through, angle 45deg
    await waitFor(() => expect(counts().entities).toBe(1))
  })
})

describe('Sketch3dLabPage auto-constraint inference (criterion 2)', () => {
  it('a horizontal draw offers a horizontal suggestion, and applying it adds the constraint', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 40, y: 0 }) // perfectly horizontal
    await screen.findByTestId('sketch3dlab-infer-horizontal')
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-horizontal'))
    expect(counts().constraints).toBe(1)
    expect(screen.queryByTestId('sketch3dlab-inference-panel')).toBeNull()
  })

  it('skipping the suggestion leaves the entity but adds no constraint', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 40, y: 0 })
    await screen.findByTestId('sketch3dlab-infer-horizontal')
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-skip'))
    expect(counts()).toEqual({ entities: 1, constraints: 0 })
  })
})

describe('Sketch3dLabPage drag tool (drag-solve wired end to end)', () => {
  it('dragging a free point moves it and re-solves without throwing', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(counts().entities).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 }) // grab the line's end point
    move({ x: 10, y: 6 })
    up()
    await waitFor(() => expect(dofLabel()).not.toBe('solving...'))
    expect(linePoint('line1', 'end').y).toBeCloseTo(6, 3)
  })
})

describe('Sketch3dLabPage: recreates the M2 bracket profile interactively (criteria 1-3)', () => {
  it('draw + auto-constrain 2 joints + 9 explicit constraint kinds drives DOF to Fully constrained, then a provoked conflict is reported and resolved by deleting it', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    // --- draw a rough 3-line + 1-arc open profile, matching the committed M2 bracket fixture's
    // shape (src/tests/sketch3d/fixtures/bracketFixture.ts) --------------------------------------
    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 40, y: 0 }) // line1 (bl1): horizontal
    await screen.findByTestId('sketch3dlab-infer-horizontal')
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-horizontal')) // auto-constrain #1: bh1

    // WO SKC-8 (A2): the arc tool's input order is now start/end/through-point, not
    // center/start/end -- these 3 clicks are computed to reproduce the EXACT SAME arc
    // (center=(40,5), radius=sqrt(17), sweeping from the old "start" click's angle to the old
    // "end" click's angle) the previous center-start-end construction produced, so every
    // downstream assertion in this test (which reads arc1's actual geometry back rather than
    // hardcoding it) is unaffected by the construction-method change.
    const arc1Center = { x: 40, y: 5 }
    const arc1Radius = Math.hypot(41 - arc1Center.x, 1 - arc1Center.y) // sqrt(17)
    const arc1StartAngle = Math.atan2(1 - arc1Center.y, 41 - arc1Center.x)
    const arc1EndAngle = Math.atan2(5 - arc1Center.y, 45 - arc1Center.x) // 0
    const arc1Start = { x: 41, y: 1 } // deliberately NOT exactly on line1's end (see original comment)
    const arc1EndClick = { x: arc1Center.x + arc1Radius * Math.cos(arc1EndAngle), y: arc1Center.y + arc1Radius * Math.sin(arc1EndAngle) }
    const arc1Through = {
      x: arc1Center.x + arc1Radius * Math.cos(arc1StartAngle / 2),
      y: arc1Center.y + arc1Radius * Math.sin(arc1StartAngle / 2),
    }
    useTool('arc')
    click(arc1Start)
    click(arc1EndClick)
    click(arc1Through)
    await waitFor(() => expect(counts().entities).toBe(2))
    expect(screen.queryByTestId('sketch3dlab-inference-panel')).toBeNull()

    // draw() only uses the END click's ANGLE (not its distance) to close the arc, so arc1's
    // actual end point isn't necessarily exactly (45,5) - read it back rather than guess, the
    // same way a real user would click precisely on the arc's rendered endpoint.
    const arc1End = arcPoint('arc1', 'end')
    useTool('line')
    click(arc1End) // line2 (bl2) start, exactly on arc1's end
    click({ x: arc1End.x, y: arc1End.y + 15 }) // line2 end: vertical
    // drawing a vertical line whose start sits exactly on the arc's end offers all 3: vertical
    // (self angle), coincident (endpoint proximity) and tangent (arc tangent at that endpoint
    // happens to be vertical too) - accept coincident + tangent, skip vertical to prove the
    // EXPLICIT vertical tool separately below.
    await screen.findByTestId('sketch3dlab-infer-coincident')
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-coincident')) // auto-constrain #2: bco2
    await screen.findByTestId('sketch3dlab-infer-tangent')
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-tangent')) // auto-constrain #3: btan2
    if (screen.queryByTestId('sketch3dlab-inference-panel')) {
      fireEvent.click(screen.getByTestId('sketch3dlab-infer-skip'))
    }
    expect(screen.queryByTestId('sketch3dlab-inference-panel')).toBeNull()

    useTool('line')
    click({ x: 44, y: 21 }) // line3 (bl3) start - deliberately NOT on line2's end
    click({ x: 6, y: 23 }) // line3 end - deliberately oblique, nowhere near line1's start
    await waitFor(() => expect(counts().entities).toBe(4))
    expect(screen.queryByTestId('sketch3dlab-inference-panel')).toBeNull()
    expect(counts().constraints).toBe(3)

    // --- the remaining 9 constraints, all explicit (select 1-2 things, click a tool button) ---
    useTool('select')

    // bco1: line1.end - arc1.start
    click(linePoint('line1', 'end'))
    click(arcPoint('arc1', 'start'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-coincident'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bco3: line2.end - line3.start
    click(linePoint('line2', 'end'))
    click(linePoint('line3', 'start'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-coincident'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bco4: line3.end - line1.start
    click(linePoint('line3', 'end'))
    click(linePoint('line1', 'start'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-coincident'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // btan1: line1 - arc1 (line1 already carries a horizontal glyph anchored at its exact
    // midpoint, so pick off-center to hit the entity body, not that glyph)
    click(linePointAt('line1', 0.25))
    click(arcRingPoint('arc1'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-tangent'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bv2: line2 (explicit, the inference offer for this was skipped above)
    click(lineMid('line2'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-vertical'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // brad: arc1 radius 5
    click(arcRingPoint('arc1'))
    setValue('5')
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-radius'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bd1: line1 length 40
    click(linePoint('line1', 'start'))
    click(linePoint('line1', 'end'))
    setValue('40')
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-distance'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bd2: line2 length 20
    click(linePoint('line2', 'start'))
    click(linePoint('line2', 'end'))
    setValue('20')
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-distance'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    // bfix0: line1.start
    click(linePoint('line1', 'start'))
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-fixed'))
    expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()

    expect(counts().constraints).toBe(12)
    await waitFor(() => expect(dofLabel()).toBe('Fully constrained'), { timeout: 10_000 })

    // --- provoke a conflict: a second, incompatible distance on the SAME 2 points -------------
    click(linePoint('line1', 'start'))
    click(linePoint('line1', 'end'))
    setValue('999')
    fireEvent.click(screen.getByTestId('sketch3dlab-constraint-distance'))

    await waitFor(() => expect(dofLabel()).toBe('Conflicting constraints'))
    const conflictPanel = screen.getByTestId('sketch3dlab-conflict-panel')
    expect(conflictPanel.textContent).toMatch(/999/)

    // --- resolve: select the offending glyph from the conflict panel and delete it ------------
    const conflictEntry = conflictPanel.querySelector('[data-testid^="sketch3dlab-conflict-"]')
    expect(conflictEntry).not.toBeNull()
    fireEvent.click(conflictEntry as Element)
    fireEvent.click(screen.getByTestId('sketch3dlab-delete-constraint'))

    await waitFor(() => expect(dofLabel()).toBe('Fully constrained'))
    expect(screen.getByTestId('sketch3dlab-conflict-panel').textContent).toMatch(/none/)
  })
})

describe('Sketch3dLabPage: A3 hover highlight maps to the hovered ENTITY, not just a boolean (WO SKC-8-R1)', () => {
  it('hovering a line reports its entity id; moving off it clears the id; hovering a different entity updates it', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    useTool('circle')
    click({ x: 20, y: 10 })
    click({ x: 24, y: 10 }) // radius 4

    useTool('select')
    expect(screen.getByTestId('sketch3dlab-hover-grabbable').textContent).toBe('false')
    expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('')

    move({ x: 5, y: 0 }) // over line1's body
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('line1'))
    expect(screen.getByTestId('sketch3dlab-hover-grabbable').textContent).toBe('true')

    move({ x: 24, y: 10 }) // over circle1's ring -- a DIFFERENT entity
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('circle1'))

    move({ x: 60, y: 60 }) // empty canvas -- clears back to no hover
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe(''))
    expect(screen.getByTestId('sketch3dlab-hover-grabbable').textContent).toBe('false')
  })

  // WO SKC-8F (R1 Major 2, fold-in): the test above only proves the hovered-entity-id STATE;
  // it never exercises the canvas paint effect at all (jsdom's getContext('2d') returns null, so
  // the effect no-ops), so nothing would fail if the amber stroke itself were deleted from
  // Sketch3dLabPage.tsx's paint loop. This installs a fake 2D context to read back the REAL
  // stroke() calls the paint effect makes and asserts the actual '#ffcf5c'/3.5 amber styling on
  // the hovered entity, distinct from both entities' normal style and from the selected style.
  it('the hovered entity is actually painted with the amber #ffcf5c / 3.5 stroke, and a selected entity keeps its own style instead', async () => {
    const canvas = installStrokeRecordingCanvas()
    try {
      render(<Sketch3dLabPage />)
      await ready()

      useTool('line')
      click({ x: 0, y: 0 })
      click({ x: 10, y: 0 }) // line1
      useTool('circle')
      click({ x: 20, y: 10 })
      click({ x: 24, y: 10 }) // circle1, radius 4

      useTool('select')

      move({ x: 5, y: 0 }) // over line1's body
      await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('line1'))
      // entities paint in document.entities order: line1 first, then circle1.
      expect(canvas.strokes()).toEqual([
        { strokeStyle: '#ffcf5c', lineWidth: 3.5 }, // line1: hovered -> amber
        { strokeStyle: '#d8e0e8', lineWidth: 2 }, // circle1: untouched -> normal
      ])

      move({ x: 24, y: 10 }) // over circle1's ring -- a DIFFERENT entity
      await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('circle1'))
      expect(canvas.strokes()).toEqual([
        { strokeStyle: '#d8e0e8', lineWidth: 2 }, // line1: back to normal
        { strokeStyle: '#ffcf5c', lineWidth: 3.5 }, // circle1: hovered -> amber
      ])

      // Select line1 without starting a drag (pointerUp right after pointerDown clears the
      // armed grab before any move can consume it into a gesture), then hover it again: the
      // paint loop's `isHovered = !isSelected && ...` must keep selected and hover styles
      // distinct -- a selected+hovered entity renders as SELECTED (blue), never amber.
      click({ x: 5, y: 0 }) // pointerDown on line1's body: toggles selection, arms a grab
      up() // release before any move -- clears the arm, never begins a drag
      move({ x: 5, y: 0 }) // re-hover line1, now selected
      await waitFor(() => expect(screen.getByTestId('sketch3dlab-hover-grabbable-id').textContent).toBe('line1'))
      expect(canvas.strokes()).toEqual([
        { strokeStyle: '#4fb0ff', lineWidth: 2 }, // line1: selected wins over hover -> blue, not amber
        { strokeStyle: '#d8e0e8', lineWidth: 2 }, // circle1: still normal
      ])
    } finally {
      canvas.restore()
    }
  })
})

describe('Sketch3dLabPage: select-tool ring-grab preserves the grab offset (WO SKC-8-R1 Blocker 2, SKC-8F fold-in)', () => {
  it('pressing a circle ring point away from its center and dragging moves the center by exactly the gesture delta, not a snap to the raw cursor', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    useTool('circle')
    const center0 = { x: 20, y: 10 }
    const radius = 4
    click(center0)
    click({ x: center0.x + radius, y: center0.y })
    await waitFor(() => expect(counts().entities).toBe(1))

    useTool('select')
    // A ring point away from the center: pickGrabTarget resolves a circle ring hit to a 'point'
    // target on the entity's CENTER site (picking.ts), which sits `radius` away from this actual
    // click -- exactly the grab-offset case Blocker 2 fixed.
    const grabPoint = { x: center0.x, y: center0.y + radius } // top of the ring
    click(grabPoint) // pointerDown: arms the grab
    const dx = 3
    const dy = -2
    move({ x: grabPoint.x + dx, y: grabPoint.y + dy }) // first move: arm -> active offset-preserving drag
    up()

    await waitFor(() => expect(dofLabel()).not.toBe('solving...'))
    const center1 = (currentEntity('circle1') as Sketch3dCircleEntity).center
    // Offset preserved: the center moves by the gesture's own delta from its OWN starting
    // position, not to wherever the cursor ended up.
    expect(center1.x).toBeCloseTo(center0.x + dx, 3)
    expect(center1.y).toBeCloseTo(center0.y + dy, 3)
    // Fails-if (reintroducing the ring-grab snap): a snap-to-cursor regression instead sets the
    // center directly at the released cursor, which sits `radius` away from the correct result.
    expect(center1.y).not.toBeCloseTo(grabPoint.y + dy, 3)
  })
})
