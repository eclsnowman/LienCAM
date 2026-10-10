// Text as a dimension POINT operand (text plan item 8, H/V position dims).
//
// FREE text is dimmable by its baseline anchor (the one gcs point a text
// carries, site 'start'): a two-point distance to the anchor, oriented to
// distanceX/distanceY at placement, is a driving H/V position dimension --
// an ordinary gcs point dim, NOT covered by ADR-0033 (which governs the
// harder ON-PATH root-find). The PICK target is the whole text BOX (the big
// target from the 8e2f834 pick fix), while the operand resolves to the
// anchor. ON-PATH text is explicitly NOT dimmable here: its anchor is the
// ignored free anchor, so a gcs dim would not move the visible glyphs -- it
// must be refused (no silent-wrong constraint), pending the ADR-0033
// sketch-level along-arc dimension.

import { describe, it, expect } from 'vitest'
import { pickDimOperand, planDimension } from '../../lib/sketch/tools/dimTool'
import { textLocalBBox } from '../../lib/sketch/text'
import type {
  SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'

const FREE: SketchTextEntity = {
  id: 'ft', kind: 'text', construction: false,
  at: { x: 10, y: 20 }, text: 'AB', height: 8, rotation: 0, fontStyle: 'single-line',
}
const PT: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 10, y: 50 } }
const LINE: SketchLineEntity = {
  id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
}
// On-path text: free anchor parked FAR from the path (its glyphs draw on the
// line, the anchor is ignored). Any gcs dim on that anchor is a no-op.
const ONPATH: SketchTextEntity = {
  id: 'ot', kind: 'text', construction: false,
  at: { x: 200, y: 200 }, text: 'AB', height: 8, rotation: 0,
  fontStyle: 'single-line', pathId: 'ln', pathOffsetMm: 20,
}

// A world point inside the FREE text's box (anchor + local bbox center).
const box = textLocalBBox('AB', 8)!
const insideBox = { x: FREE.at.x + (box.minX + box.maxX) / 2, y: FREE.at.y + (box.minY + box.maxY) / 2 }

describe('pickDimOperand: FREE text is pickable by its box; on-path text is not', () => {
  it('a click inside the FREE text box picks the text (as a point operand)', () => {
    expect(pickDimOperand([FREE], insideBox, 1)).toBe('ft')
  })

  it('a click far from the free text does not pick it', () => {
    expect(pickDimOperand([FREE], { x: 500, y: 500 }, 1)).toBeNull()
  })

  it('ON-PATH text is NOT pickable for a dimension (even at its anchor)', () => {
    // Only the line is present besides the on-path text; a click at the
    // ignored anchor hits neither (text -> Infinity, line far away).
    expect(pickDimOperand([LINE, ONPATH], { x: 200, y: 200 }, 5)).toBeNull()
  })

  it('a point entity strictly nearer than the text box wins the pick', () => {
    // Click 3mm LEFT of the box edge (box distance ~3), with a point sitting
    // exactly under the click (distance 0): nearest wins -> the point.
    const click = { x: FREE.at.x + box.minX - 3, y: FREE.at.y + (box.minY + box.maxY) / 2 }
    const near: SketchEntity = { id: 'pn', kind: 'point', construction: false, at: click }
    expect(pickDimOperand([FREE, near], click, 5)).toBe('pn')
  })
})

describe('planDimension: FREE text anchor dimensions like any point', () => {
  it('free text + point -> a two-point distance (anchor to point)', () => {
    const out = planDimension([FREE, PT], ['ft', 'p0'])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.kind).toBe('distance')
    if (out.plan.kind !== 'distance') return
    // The text operand resolved to its anchor (site 'start').
    const refs = [out.plan.a, out.plan.b]
    expect(refs).toContainEqual({ entityId: 'ft', site: 'start' })
    expect(refs).toContainEqual({ entityId: 'p0', site: 'self' })
    expect(out.plan.value).toBeCloseTo(30, 9) // |(10,20)-(10,50)|
  })

  it('free text + line -> perpendicular point-to-line distance', () => {
    const out = planDimension([FREE, LINE], ['ft', 'ln'])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.kind).toBe('distancePL')
    if (out.plan.kind !== 'distancePL') return
    expect(out.plan.point).toEqual({ entityId: 'ft', site: 'start' })
    expect(out.plan.line).toBe('ln')
    expect(out.plan.value).toBeCloseTo(20, 9) // anchor y=20 above the y=0 line
  })

  it('a single free text waits for a partner (cannot dimension alone)', () => {
    const out = planDimension([FREE], ['ft'])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.incomplete).toBe(true) // keep the operand, add a partner
  })
})

describe('planDimension: ON-PATH text is refused as a dim point (no silent-wrong)', () => {
  it('on-path text + point (whole-entity pick) is rejected, not dimensioned', () => {
    const out = planDimension([LINE, ONPATH, PT], ['ot', 'p0'])
    expect(out.ok).toBe(false)
  })

  it('on-path text with an EXPLICIT start site is still refused', () => {
    const out = planDimension([LINE, ONPATH, PT], [{ entityId: 'ot', site: 'start' }, 'p0'])
    expect(out.ok).toBe(false)
  })
})
