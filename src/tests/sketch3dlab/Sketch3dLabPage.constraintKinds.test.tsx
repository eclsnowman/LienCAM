// @vitest-environment jsdom
//
// Sketch3d Lab page (WO INT-2, acceptance criterion 1 + 6 mapping table): proves each of the 13
// required constraint kinds is applied through its OWN visible toolbar button, driven by real
// fireEvent clicks against the mounted page and the real planegcs solve service - not just the
// pure applyConstraintFromSelection unit tests (constraintActions.test.ts) that check the
// selection-to-constraint mapping in isolation. The M2 bracket recreation in
// Sketch3dLabPage.test.tsx already proves 6 of these 13 kinds (coincident, tangent, vertical,
// radius, distance, fixed) end to end to a real "Fully constrained" result; this file covers the
// remaining 7 (horizontal, parallel, perpendicular, equal, midpoint, angle, diameter) plus
// re-confirms the other 6 with a fresh, independent selection each, so every kind in the
// SKC-3-required vocabulary has its OWN dedicated assertion of "applied through a tool action"
// at the UI layer - the same per-kind completeness bar SKC-3's own glyphs.test.ts checklist used.
import { describe, it, expect, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'
import type { Sketch3dArcEntity, Sketch3dLineEntity, Sketch3dVec2 } from '../../sketch3d'

afterEach(cleanup)

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

function click(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y })
}

function useTool(tool: 'select' | 'line' | 'circle' | 'arc' | 'drag'): void {
  fireEvent.click(screen.getByTestId(`sketch3dlab-tool-${tool}`))
}

function constraintCount(): number {
  return Number(screen.getByTestId('sketch3dlab-constraint-count').textContent)
}

function setValue(v: string): void {
  fireEvent.change(screen.getByTestId('sketch3dlab-value-input'), { target: { value: v } })
}

function dismissInferenceIfAny(): void {
  if (screen.queryByTestId('sketch3dlab-inference-panel')) {
    fireEvent.click(screen.getByTestId('sketch3dlab-infer-skip'))
  }
}

function circleCenter(id: string): Sketch3dVec2 {
  return (currentEntity(id) as { center: Sketch3dVec2 }).center
}

function currentEntity(id: string) {
  const doc = window.__sketch3dlabTestHooks!.getDocument()
  const entity = doc.entities.find((e) => e.id === id)
  if (!entity) throw new Error(`test: entity '${id}' not found`)
  return entity
}

function linePoint(id: string, site: 'start' | 'end'): Sketch3dVec2 {
  const line = currentEntity(id) as Sketch3dLineEntity
  return site === 'start' ? line.start : line.end
}

function linePointAt(id: string, t: number): Sketch3dVec2 {
  const line = currentEntity(id) as Sketch3dLineEntity
  return { x: line.start.x + t * (line.end.x - line.start.x), y: line.start.y + t * (line.end.y - line.start.y) }
}

function arcRingPoint(id: string): Sketch3dVec2 {
  const arc = currentEntity(id) as Sketch3dArcEntity
  const angle = (arc.startAngle + arc.endAngle) / 2
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) }
}

// One click per applied constraint bumps the count by exactly 1 with no validation error.
function applyAndExpectOneMoreConstraint(kind: string): void {
  const before = constraintCount()
  fireEvent.click(screen.getByTestId(`sketch3dlab-constraint-${kind}`))
  expect(screen.queryByTestId('sketch3dlab-tool-error')).toBeNull()
  expect(constraintCount()).toBe(before + 1)
}

describe('Sketch3dLabPage: every required constraint kind is applied through its own visible tool (criteria 1 + 6)', () => {
  it('applies all 13 kinds via the toolbar against a fresh line/circle/arc scratch layout', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    // scratch geometry: 3 lines (2 roughly perpendicular, 1 of a different length for a
    // meaningful "equal"), 1 circle, 1 arc - independent entities, no shared points yet
    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 }) // line1: horizontal-ish
    dismissInferenceIfAny()

    useTool('line')
    click({ x: 20, y: 0 })
    click({ x: 20, y: 10 }) // line2: vertical-ish
    dismissInferenceIfAny()

    useTool('line')
    click({ x: 0, y: 20 })
    click({ x: 15, y: 20 }) // line3: different length than line1, for "equal" to have an effect
    dismissInferenceIfAny()

    useTool('circle')
    click({ x: 30, y: 30 })
    click({ x: 35, y: 30 }) // circle1, radius 5

    // WO SKC-8 (A2): arc tool input order is now start/end/through-point, not center/start/end.
    // These 3 clicks reproduce the SAME arc (center=(50,50), radius=6, sweeping 0deg -> 90deg)
    // the old center-start-end construction produced, so arcRingPoint's (startAngle+endAngle)/2
    // read-back below still lands on the same ring position.
    useTool('arc')
    click({ x: 56, y: 50 }) // start, angle 0
    click({ x: 50, y: 56 }) // end, angle 90deg
    click({ x: 50 + 6 * Math.SQRT1_2, y: 50 + 6 * Math.SQRT1_2 }) // through, angle 45deg (arc1)

    await waitFor(() => expect(screen.getByTestId('sketch3dlab-entity-count').textContent).toBe('5'))
    expect(constraintCount()).toBe(0)

    useTool('select')

    // 1. coincident: line1.end + line2.start
    click(linePoint('line1', 'end'))
    click(linePoint('line2', 'start'))
    applyAndExpectOneMoreConstraint('coincident')

    // 2. horizontal: line3 (explicit toolbar use, independent of any inference suggestion)
    click(linePointAt('line3', 0.3))
    applyAndExpectOneMoreConstraint('horizontal')

    // 3. vertical: line2
    click(linePointAt('line2', 0.3))
    applyAndExpectOneMoreConstraint('vertical')

    // 4. parallel: line1 + line3 (both roughly horizontal)
    click(linePointAt('line1', 0.3))
    click(linePointAt('line3', 0.3))
    applyAndExpectOneMoreConstraint('parallel')

    // 5. perpendicular: line1 + line2
    click(linePointAt('line1', 0.7))
    click(linePointAt('line2', 0.7))
    applyAndExpectOneMoreConstraint('perpendicular')

    // 6. tangent: line1 + arc1
    click(linePointAt('line1', 0.5))
    click(arcRingPoint('arc1'))
    applyAndExpectOneMoreConstraint('tangent')

    // 9. distance: line1's own two endpoints, value 12 -- WO SKC-8: moved ahead of #7 (equal).
    // With line1's DOF still fully open, tangent+parallel+perpendicular leave the whole
    // line1/line3/arc1 subsystem under-determined -- 'equal' alone (no absolute size pinned
    // anywhere yet) admits a degenerate "both lines collapse to zero length" solution as a
    // valid (if useless) fixed point, and which branch the shared nonlinear solve lands in is
    // sensitive to the exact incoming floating-point state (WO SKC-8's arc reconstruction
    // moved this from center-start-end to start-end-through -- numerically ~1e-13 different,
    // but that was enough to tip this specific step into the degenerate branch). Pinning
    // line1's length FIRST removes that branch outright (equal can then only resolve line3 to
    // the SAME nonzero length), independent of solver path-sensitivity -- a structural fix,
    // not a numeric-coincidence one.
    click(linePoint('line1', 'start'))
    click(linePoint('line1', 'end'))
    setValue('12')
    applyAndExpectOneMoreConstraint('distance')

    // 13. fixed: line2's start point -- WO SKC-8: also moved ahead (same reasoning as #9 above).
    // Pinning line2's own anchor early, alongside line1's now-fixed length, leaves the REST of
    // the system (line3 via equal, line2's free end via angle/perpendicular) with a unique local
    // solution instead of a family of valid configurations reachable through rigid translation/
    // rotation -- removing the same class of solver path-sensitivity, not just the one instance
    // 'equal' happened to hit.
    click(linePoint('line2', 'start'))
    applyAndExpectOneMoreConstraint('fixed')

    // 7. equal: line1 + line3 (started at different lengths, 10 vs 15; line1 now pinned to 12)
    click(linePointAt('line1', 0.1))
    click(linePointAt('line3', 0.1))
    applyAndExpectOneMoreConstraint('equal')

    // 8. midpoint: circle1's center on line1
    click(circleCenter('circle1'))
    click(linePointAt('line1', 0.9))
    applyAndExpectOneMoreConstraint('midpoint')

    // 10. angle: line1 + line2, value pi/2 (already roughly perpendicular by construction)
    click(linePointAt('line1', 0.2))
    click(linePointAt('line2', 0.2))
    setValue(String(Math.PI / 2))
    applyAndExpectOneMoreConstraint('angle')

    // 11. radius: circle1, value 8
    const c1 = circleCenter('circle1')
    click({ x: c1.x + 5, y: c1.y })
    setValue('8')
    applyAndExpectOneMoreConstraint('radius')

    // 12. diameter: arc1, value 10
    click(arcRingPoint('arc1'))
    setValue('10')
    applyAndExpectOneMoreConstraint('diameter')

    expect(constraintCount()).toBe(13)
  })
})
