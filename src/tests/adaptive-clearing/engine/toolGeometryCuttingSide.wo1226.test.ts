// WO-1226 TIER 1 EVIDENCE: the cutting-SIDE split of cutArea, proven against CLOSED-FORM
// geometry -- cases whose answer is known by construction, never against the engine.
//
// The quantity under test: ToolGeometry.cutArea now also reports `leftArea` / `rightArea`
// (mm^2 of this step's cut lying left / right of the direction of travel) and `sideBalance`
// = (left - right) / (left + right). A measurement validated only against the thing it is
// meant to correct proves nothing, so every expectation below is an ANALYTIC number.
//
// The closed forms, for a tool of radius r stepping a distance s in a straight line:
//
//   crescent  = capsule(from -> to, r) \ disk(from, r).  Its area is EXACTLY 2 r s: the
//               capsule is pi r^2 + 2 r s and the disk it loses is pi r^2.
//   half-plane cuts. Put `cleared` at lateral offset c from the travel axis (positive =
//               left), covering everything below it. What is left to cut is
//               crescent inter { lateral >= c }, whose area is EXACTLY s (r - c) for
//               -r <= c <= r: the capsule's two round ends contribute one full circular
//               segment above the chord, and the disk at `from` subtracts exactly that
//               same segment, so both transcendental terms cancel and only the straight
//               body s (r - c) survives.
//   therefore   c >= 0 (a wall on the LEFT of travel):  left = s (r - c), right = 0.
//               c <= 0 (material spilling to the RIGHT): left = s r, right = s |c|.
//
// Tolerances are relative and generous by 0.6%, because the disk and capsule are POLYGONS:
// arcTol faceting makes every round part slightly smaller than the true circle, and the
// capsule's end caps and the disk at `from` are separately faceted, so the cancellation
// above is exact only in the limit. The faceting error is one-sided and small; the numbers
// printed by these tests land within ~0.2% of the analytic values at arcTol = 0.005 mm.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Pt, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'

const R = 2.0        // tool radius (mm)
const S = 3.0        // step length (mm)
const ARC = 0.005    // disk faceting (mm) -- finer than the engine default, for a tighter proof
const REL = 0.006    // 0.6% relative tolerance, faceting only

beforeAll(async () => { await ensureEngineClipperReady() })

const tool = () => createToolGeometry(R, 0.4, ARC)

interface Frame { F: Pt; u: Pt; n: Pt }

/** A travel frame: origin `F`, unit travel `u` at `theta`, LEFT normal `n = perp(u)`. */
function frame(F: Pt, theta: number): Frame {
  const u = { x: Math.cos(theta), y: Math.sin(theta) }
  return { F, u, n: { x: -u.y, y: u.x } }
}

/** World point `a` mm along travel and `b` mm to the LEFT of it, from `F`. */
function at({ F, u, n }: Frame, a: number, b: number): Pt {
  return { x: F.x + a * u.x + b * n.x, y: F.y + a * u.y + b * n.y }
}

const to = (f: Frame, s = S) => at(f, s, 0)

/** `cleared` = everything at lateral offset <= c (i.e. a wall standing on the LEFT at c). */
function clearedRightOf(f: Frame, c: number, L = 60): Loops {
  return [[at(f, -L, c), at(f, L, c), at(f, L, c - L), at(f, -L, c - L)]]
}

/** `cleared` = everything at lateral offset >= c (a wall standing on the RIGHT at c). */
function clearedLeftOf(f: Frame, c: number, L = 60): Loops {
  return [[at(f, -L, c), at(f, L, c), at(f, L, c + L), at(f, -L, c + L)]]
}

/** Rectangle in the travel frame: [a0,a1] along travel x [b0,b1] left of it. */
function rect(f: Frame, a0: number, a1: number, b0: number, b1: number): Loops {
  return [[at(f, a0, b0), at(f, a1, b0), at(f, a1, b1), at(f, a0, b1)]]
}

function expectRel(actual: number, expected: number, rel = REL): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * rel + 1e-9)
}

describe('WO-1226 cutArea cutting-side split: closed-form cases', () => {
  it('symmetric slot: a full-width cut engages both sides equally', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const m = tool().cutArea(f.F, to(f), [])
    // crescent = 2 r s exactly
    expectRel(m.area, 2 * R * S)
    expectRel(m.leftArea, R * S)
    expectRel(m.rightArea, R * S)
    expect(Math.abs(m.sideBalance)).toBeLessThan(0.01)
  })

  it('LEFT wall: material only to the left of travel -> the left of the tool cuts, alone', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const m = tool().cutArea(f.F, to(f), clearedRightOf(f, 0))
    expectRel(m.area, R * S)      // s (r - 0), half the crescent
    expectRel(m.leftArea, R * S)
    expect(m.rightArea).toBeLessThan(R * S * 1e-3)
    expectRel(m.sideBalance, 1)
  })

  it('RIGHT wall: the mirror image reads -1, and removes the SAME area', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const m = tool().cutArea(f.F, to(f), clearedLeftOf(f, 0))
    expectRel(m.area, R * S)
    expect(m.leftArea).toBeLessThan(R * S * 1e-3)
    expectRel(m.rightArea, R * S)
    expectRel(m.sideBalance, -1)
  })

  it('LEFT wall standing off the axis (c = r/2): area s (r - c), still all left', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const m = tool().cutArea(f.F, to(f), clearedRightOf(f, R / 2))
    expectRel(m.area, S * (R - R / 2))
    expectRel(m.leftArea, S * (R - R / 2))
    expect(m.rightArea).toBeLessThan(S * R * 1e-3)
    expectRel(m.sideBalance, 1)
  })

  it('asymmetric (c = -r/2): left s r, right s r/2, balance exactly 1/3', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const m = tool().cutArea(f.F, to(f), clearedRightOf(f, -R / 2))
    expectRel(m.area, S * (R + R / 2))
    expectRel(m.leftArea, S * R)
    expectRel(m.rightArea, S * R / 2)
    expectRel(m.sideBalance, 1 / 3, 0.02)
  })

  it('the split follows TRAVEL, not the world axes: the same three cases at 37 and 135 deg', () => {
    for (const deg of [37, 135, -108]) {
      const f = frame({ x: -11, y: 7 }, (deg * Math.PI) / 180
      )
      const t = tool()
      const wallLeft = t.cutArea(f.F, to(f), clearedRightOf(f, 0))
      expectRel(wallLeft.leftArea, R * S)
      expect(wallLeft.rightArea).toBeLessThan(R * S * 1e-3)

      const wallRight = t.cutArea(f.F, to(f), clearedLeftOf(f, 0))
      expect(wallRight.leftArea).toBeLessThan(R * S * 1e-3)
      expectRel(wallRight.rightArea, R * S)

      const skewed = t.cutArea(f.F, to(f), clearedRightOf(f, -R / 2))
      expectRel(skewed.leftArea, S * R)
      expectRel(skewed.rightArea, S * R / 2)
    }
  })

  it('reversing the direction of travel swaps left and right', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const t = tool()
    const cleared = clearedRightOf(f, -R / 2) // wall parallel to the axis: symmetric under reversal
    const fwd = t.cutArea(f.F, to(f), cleared)
    const back = t.cutArea(to(f), f.F, cleared)
    expectRel(back.area, fwd.area)
    expectRel(back.leftArea, fwd.rightArea)
    expectRel(back.rightArea, fwd.leftArea)
    expectRel(back.sideBalance, -fwd.sideBalance, 0.02)
  })

  it('a NOTCH out of the upper half: the left side is two pieces, and still measures 5.2 mm2', () => {
    // Beyond x = r the crescent is the capsule's straight body, full width |lateral| <= r,
    // so a 0.4 x (>= r) notch bitten out of its upper half removes EXACTLY 0.4 r = 0.8 mm2
    // and splits the left half in two (one piece before the notch, one after). Sutherland-
    // Hodgman must bridge those pieces along the axis; a wrong bridge shows up here as area.
    const f = frame({ x: 5, y: -3 }, 0)
    const cleared = rect(f, 2.5, 2.9, 0, 10)
    const m = tool().cutArea(f.F, to(f), cleared)
    const notch = 0.4 * R
    expectRel(m.area, 2 * R * S - notch)
    expectRel(m.leftArea, R * S - notch)
    expectRel(m.rightArea, R * S)
    expectRel(m.sideBalance, (R * S - notch - R * S) / (2 * R * S - notch), 0.02)
  })

  it('left + right sums back to area on every case above (the abs-sum convention holds)', () => {
    const f = frame({ x: 5, y: -3 }, 0.7)
    const t = tool()
    const cases: Loops[] = [
      [], clearedRightOf(f, 0), clearedLeftOf(f, 0), clearedRightOf(f, R / 2),
      clearedRightOf(f, -R / 2), clearedLeftOf(f, -R / 3), rect(f, 2.5, 2.9, 0, 10),
      rect(f, 0.5, 4.5, -0.4, 0.4), rect(f, -10, 10, -10, 10),
    ]
    for (const cleared of cases) {
      const m = t.cutArea(f.F, to(f), cleared)
      expect(m.leftArea + m.rightArea).toBeCloseTo(m.area, 9)
      expect(m.leftArea).toBeGreaterThanOrEqual(0)
      expect(m.rightArea).toBeGreaterThanOrEqual(0)
      expect(m.sideBalance).toBeGreaterThanOrEqual(-1)
      expect(m.sideBalance).toBeLessThanOrEqual(1)
    }
  })

  it('THE MOTIVATING CASE: two candidate headings with the same load, opposite sides', () => {
    // This is what the steering search could not see. Two probes at +-25 deg off a common
    // heading, each riding a wall on the opposite side, remove the SAME area per distance --
    // `areaPerDist` alone cannot tell them apart -- and now report opposite sideBalance.
    const t = tool()
    const base = { x: 5, y: -3 }
    const lf = frame(base, (25 * Math.PI) / 180)
    const rf = frame(base, (-25 * Math.PI) / 180)
    const leftCand = t.cutArea(base, to(lf), clearedRightOf(lf, -R / 4))
    const rightCand = t.cutArea(base, to(rf), clearedLeftOf(rf, R / 4))

    // 1e-3 relative, not 0: the two probes are mirror images of each other, but the disk is
    // a POLYGON whose facets do not mirror exactly across a 25 deg axis. Their loads agree
    // to 0.004% -- far inside any band the steering search could resolve them by.
    expectRel(rightCand.areaPerDist, leftCand.areaPerDist, 1e-3)  // indistinguishable by load
    expect(leftCand.sideBalance).toBeGreaterThan(0.5)             // distinguishable by side
    expect(rightCand.sideBalance).toBeLessThan(-0.5)
    expectRel(leftCand.sideBalance, -rightCand.sideBalance, 1e-3)
  })

  it('a step that cuts nothing reports no side at all', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const t = tool()
    const still = t.cutArea(f.F, f.F, [])
    expect(still).toEqual({ area: 0, areaPerDist: 0, leftArea: 0, rightArea: 0, sideBalance: 0 })
    const buried = t.cutArea(f.F, to(f), rect(f, -20, 20, -20, 20))
    expect(buried.area).toBeLessThan(1e-6)
    expect(buried.leftArea).toBe(0)
    expect(buried.rightArea).toBe(0)
    expect(buried.sideBalance).toBe(0)
  })
})

describe('WO-1226 is a PURE ADDITION: area and areaPerDist are untouched', () => {
  it('area still equals the analytic crescent and areaPerDist still equals area / distance', () => {
    const f = frame({ x: 5, y: -3 }, 0)
    const t = tool()
    for (const s of [0.4, 1.0, S, 6.0]) {
      const m = t.cutArea(f.F, to(f, s), [])
      expectRel(m.area, 2 * R * s)
      expect(m.areaPerDist).toBeCloseTo(m.area / s, 9)
    }
  })

  it('the side split never reads material the area did not count', () => {
    // Whatever `cleared` is, neither side may exceed the total: the split partitions the
    // SAME clipped polygon the area was measured on, it does not re-derive geometry.
    const f = frame({ x: 5, y: -3 }, 2.1)
    const t = tool()
    for (const c of [-2, -1, -0.5, 0, 0.5, 1, 1.9]) {
      const m = t.cutArea(f.F, to(f), clearedRightOf(f, c))
      expect(m.leftArea).toBeLessThanOrEqual(m.area + 1e-9)
      expect(m.rightArea).toBeLessThanOrEqual(m.area + 1e-9)
      expectRel(m.area, S * (R - c))
    }
  })
})
