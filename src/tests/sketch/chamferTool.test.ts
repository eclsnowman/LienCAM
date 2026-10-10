// Sketch chamfer tool (Tier 3a): equal-distance straight cut across the
// corner of two lines. Both legs trimmed back by the SAME setback from the
// corner; a chamfer line joins the two trim points; coincident constraints
// (NO tangent — a chamfer is straight) tie its ends to the moved corner
// sites; a setback that does not fit is rejected with the computed max.
// Mirrors filletTool.test.ts structure.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chamferLines, chamferClick, chamferChainPreview, chamferApplyAll,
  chamferSeedFromSelection, chamferMaxUsableSetback, chamferChainMaxSetback,
  __chamferPreviewComputeCount, __resetChamferChainPreviewMemo,
  type ChamferChainState,
} from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  SketchEntity, SketchConstraint, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `c-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
): SketchEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function doc(
  entities: SketchEntity[], constraints: SketchConstraint[] = [],
): SketchDoc {
  return { entities, constraints, dimensions: [] }
}

describe('chamferLines - perpendicular corner, setback 2', () => {
  // Corner at (10,0): A runs (0,0)->(10,0), B runs (10,0)->(10,10).
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = () => doc(
    [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    [corner],
  )

  it('trims both legs by the setback and inserts the connecting line', () => {
    const r = chamferLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const t = r.transform
    const a = t.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = t.entities.find((e) => e.id === 'B') as SketchLineEntity
    const ch = t.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    // A trimmed back to (8,0), B trimmed back to (10,2).
    expect(a.end.x).toBeCloseTo(8, 9)
    expect(a.end.y).toBeCloseTo(0, 9)
    expect(b.start.x).toBeCloseTo(10, 9)
    expect(b.start.y).toBeCloseTo(2, 9)
    // Chamfer line connects the two trim points.
    expect(ch.kind).toBe('line')
    expect(ch.start.x).toBeCloseTo(8, 9)
    expect(ch.start.y).toBeCloseTo(0, 9)
    expect(ch.end.x).toBeCloseTo(10, 9)
    expect(ch.end.y).toBeCloseTo(2, 9)
    // 45 deg cut across a square corner, setback 2 -> chamfer length 2*sqrt(2).
    expect(Math.hypot(ch.end.x - ch.start.x, ch.end.y - ch.start.y))
      .toBeCloseTo(2 * Math.SQRT2, 9)
  })

  it('adds two coincidents (NO tangent) and consumes the corner coincident', () => {
    const r = chamferLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const t = r.transform
    // The old corner coincident is gone.
    expect(t.constraints.map((c) => c.id)).not.toContain('c-corner')
    // Exactly two coincidents, and no tangent (chamfer is a straight cut).
    const coincs = t.constraints.filter((c) => c.kind === 'coincident')
    const tangents = t.constraints.filter((c) => c.kind === 'tangent')
    expect(coincs).toHaveLength(2)
    expect(tangents).toHaveLength(0)
    // Coincidents tie the chamfer line ends to the MOVED corner sites:
    // start<->A/end, end<->B/start.
    const pairs = coincs
      .map((c) => (c.kind === 'coincident'
        ? `${c.a.entityId === r.lineId ? c.a.site : ''}->${c.b.entityId}/${c.b.site}`
        : ''))
      .sort()
    expect(pairs).toEqual(['end->B/start', 'start->A/end'])
  })

  it('persists a passive theoretical corner and two driving setback dimensions', () => {
    const r = chamferLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const phantom = r.transform.entities.find((entity) => entity.id === r.phantomPointId)
    expect(phantom).toMatchObject({
      id: r.phantomPointId,
      kind: 'point',
      construction: true,
      at: { x: 10, y: 0 },
    })

    const pins = r.transform.constraints.filter(
      (constraint) => constraint.kind === 'point_on_object' &&
        constraint.point.entityId === r.phantomPointId,
    )
    expect(pins).toHaveLength(2)
    expect(pins.map((constraint) => constraint.kind === 'point_on_object'
      ? constraint.object : '').sort()).toEqual(['A', 'B'])
    expect(r.transform.constraints.some((constraint) => constraint.kind === 'fix' &&
      (constraint.point?.entityId === r.phantomPointId ||
        constraint.entityId === r.phantomPointId))).toBe(false)

    const setbackDims = r.transform.dimensions.filter(
      (dimension) => dimension.id === r.setbackDimAId || dimension.id === r.setbackDimBId,
    )
    expect(setbackDims).toHaveLength(2)
    expect(setbackDims.every((dimension) =>
      dimension.kind === 'distance' && dimension.driving && dimension.value === 2)).toBe(true)
    expect(setbackDims.map((dimension) => dimension.kind === 'distance'
      ? `${dimension.a.entityId}->${dimension.b.entityId}/${dimension.b.site}` : '').sort())
      .toEqual([
        `${r.phantomPointId}->A/end`,
        `${r.phantomPointId}->B/start`,
      ])
  })

  it('rejects an oversize setback and names the computed max', () => {
    // 10mm legs -> max usable setback = 10 (would consume the whole leg).
    const r = chamferLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 15, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit/)
    expect(r).toContain('10.00')
  })

  it('rejects a non-positive setback', () => {
    const r = chamferLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 0, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/positive/)
  })

  it('rejects parallel lines with a named reason', () => {
    const d = doc([line('A', 0, 0, 10, 0), line('B', 0, 5, 10, 5)])
    const r = chamferLines(d, 'A', 'B', { x: 5, y: 0 }, { x: 5, y: 5 }, 2, newId)
    expect(r).toMatch(/parallel/)
  })

  it('inherits construction only when BOTH legs are construction', () => {
    const mk = (aCon: boolean, bCon: boolean): SketchDoc => doc([
      { id: 'A', kind: 'line', construction: aCon, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: bCon, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ])
    const r1 = chamferLines(mk(true, true), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    const r2 = chamferLines(mk(true, false), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r1 === 'string' || typeof r2 === 'string') throw new Error('unexpected reject')
    const ch1 = r1.transform.entities.find((e) => e.id === r1.lineId)!
    const ch2 = r2.transform.entities.find((e) => e.id === r2.lineId)!
    expect(ch1.construction).toBe(true)
    expect(ch2.construction).toBe(false)
  })
})

describe('chamferLines - theoretical-corner relation repair', () => {
  it('moves real profile relations with the trim and retargets construction anchors', () => {
    const corner: SketchConstraint = {
      id: 'corner', kind: 'coincident',
      a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
    }
    const realTie: SketchConstraint = {
      id: 'real-tie', kind: 'coincident',
      a: { entityId: 'C', site: 'start' }, b: { entityId: 'B', site: 'start' },
    }
    const constructionTie: SketchConstraint = {
      id: 'construction-tie', kind: 'coincident',
      a: { entityId: 'K', site: 'end' }, b: { entityId: 'B', site: 'start' },
    }
    const d = doc([
      line('A', 0, 0, 10, 0),
      line('B', 10, 0, 10, 10),
      line('C', 10, 0, 15, 5),
      {
        id: 'K', kind: 'line', construction: true,
        start: { x: 0, y: -5 }, end: { x: 10, y: 0 },
      },
    ], [corner, realTie, constructionTie])
    const r = chamferLines(d, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)

    const b = r.transform.entities.find((entity) => entity.id === 'B') as SketchLineEntity
    const c = r.transform.entities.find((entity) => entity.id === 'C') as SketchLineEntity
    const construction = r.transform.entities.find(
      (entity) => entity.id === 'K') as SketchLineEntity
    expect(c.start).toEqual(b.start)
    expect(c.start).toEqual({ x: 10, y: 2 })
    expect(construction.end).toEqual({ x: 10, y: 0 })
    expect(r.transform.constraints.find((constraint) => constraint.id === 'real-tie'))
      .toEqual(realTie)
    expect(r.transform.constraints.find((constraint) => constraint.id === 'construction-tie'))
      .toEqual({
        id: 'construction-tie', kind: 'coincident',
        a: { entityId: 'K', site: 'end' },
        b: { entityId: r.phantomPointId, site: 'self' },
      })
  })
})

describe('chamferLines - non-perpendicular and short-leg cases', () => {
  it('60 deg corner: equal setback trims exact, chamfer length = 2*d*sin(theta/2)', () => {
    // 60 deg opening at the origin (same geometry as the fillet test).
    const d = doc([
      line('A', 10, 0, 0, 0),
      line('B', 0, 0, 10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)),
    ])
    const setback = 1.5
    const r = chamferLines(d, 'A', 'B', { x: 10, y: 0 },
      { x: 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3) }, setback, newId)
    if (typeof r === 'string') throw new Error(r)
    const ch = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    // A's trim point along +x at d; B's trim point along the 60 deg ray at d.
    expect(ch.start.x).toBeCloseTo(1.5, 9)
    expect(ch.start.y).toBeCloseTo(0, 9)
    expect(ch.end.x).toBeCloseTo(setback * Math.cos(Math.PI / 3), 9)
    expect(ch.end.y).toBeCloseTo(setback * Math.sin(Math.PI / 3), 9)
    // Isosceles triangle: chamfer length = 2*d*sin(theta/2), theta=60 -> 1.5.
    const len = Math.hypot(ch.end.x - ch.start.x, ch.end.y - ch.start.y)
    expect(len).toBeCloseTo(2 * setback * Math.sin(Math.PI / 6), 9)
  })

  it('setback larger than a short leg is rejected (does not fit)', () => {
    // A is only 3mm long: max usable setback = 3.
    const d = doc([line('A', 0, 0, 3, 0), line('B', 3, 0, 3, 10)])
    const r = chamferLines(d, 'A', 'B', { x: 0, y: 0 }, { x: 3, y: 10 }, 5, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit/)
    expect(r).toContain('3.00')
  })
})

describe('chamferClick - accumulate gestures', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = () => doc(
    [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    [corner],
  )

  it('clicking the shared corner STAGES the corner, click again removes it', () => {
    const r = chamferClick(null, base(), { x: 10, y: 0 }, 0.5)
    expect(r.notice).toBeNull()
    expect(r.chain?.corners).toHaveLength(1)
    expect(r.chain!.corners[0].at).toEqual({ x: 10, y: 0 })
    const r2 = chamferClick(r.chain, base(), { x: 10, y: 0 }, 0.5)
    expect(r2.chain?.corners).toHaveLength(0)
  })

  it('line-pair flow: first line pends, second line stages the corner', () => {
    const first = chamferClick(null, base(), { x: 5, y: 0 }, 0.5)
    expect(first.chain).toEqual({
      kind: 'chamfer', corners: [], pendingLineId: 'A', pendingClick: { x: 5, y: 0 },
    })
    const second = chamferClick(first.chain, base(), { x: 10, y: 5 }, 0.5)
    expect(second.notice).toBeNull()
    expect(second.chain!.pendingLineId).toBeNull()
    expect(second.chain!.corners).toHaveLength(1)
    const c = second.chain!.corners[0]
    expect([c.aId, c.bId].sort()).toEqual(['A', 'B'])
  })

  it('parallel second line is rejected with a notice, pending kept', () => {
    const d = doc([line('A', 0, 0, 10, 0), line('P', 0, 5, 10, 5)])
    const first = chamferClick(null, d, { x: 5, y: 0 }, 0.5)
    const r = chamferClick(first.chain, d, { x: 5, y: 5 }, 0.5)
    expect(r.notice).toMatch(/parallel/)
    expect(r.chain).toEqual(first.chain)
  })
})

describe('chamfer preview + batch apply (confirm overlay)', () => {
  // Open rectangle: three lines with two corners at (10,0) and (10,10).
  const rectDoc = () => doc([
    line('l1', 0, 0, 10, 0),
    line('l2', 10, 0, 10, 10),
    line('l3', 10, 10, 0, 10),
  ])
  const chainOf = (d: SketchDoc): ChamferChainState => ({
    kind: 'chamfer',
    corners: chamferSeedFromSelection(d.entities, ['l1', 'l2', 'l3']),
    pendingLineId: null,
    pendingClick: null,
  })

  it('preview-equals-commit: ghost lines match the applied chamfer lines', () => {
    const d = rectDoc()
    const chain = chainOf(d)
    expect(chain.corners).toHaveLength(2)
    const pv = chamferChainPreview(chain, d, 2)
    expect(pv.fits).toBe(2)
    expect(pv.misfits).toBe(0)
    // Staged-corner MARKERS: one per staged corner, at the corner point
    // (the viewport draws a selection ring there — same treatment fillet
    // already has, SKC-50 / T-SKC45-CHAMFER).
    expect(pv.corners).toHaveLength(2)
    const markerKeys = pv.corners
      .map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort()
    expect(markerKeys).toEqual(
      chain.corners.map((c) => `${c.at.x.toFixed(6)},${c.at.y.toFixed(6)}`).sort())
    const r = chamferApplyAll(d, chain.corners, 2, newId)
    expect(r.applied).toBe(2)
    expect(r.skipped).toHaveLength(0)
    // The committed document has the two original-id lines (trimmed) plus
    // two NEW chamfer lines; each ghost segment must equal a committed
    // chamfer line's endpoints (preview IS commit).
    const committed = r.transform!.entities.filter(
      (e): e is SketchLineEntity => e.kind === 'line' && !['l1', 'l2', 'l3'].includes(e.id))
    expect(committed).toHaveLength(2)
    for (const ghost of pv.lines) {
      const match = committed.some((cl) => {
        const fwd = Math.hypot(ghost[0].x - cl.start.x, ghost[0].y - cl.start.y) < 1e-9 &&
          Math.hypot(ghost[1].x - cl.end.x, ghost[1].y - cl.end.y) < 1e-9
        const rev = Math.hypot(ghost[0].x - cl.end.x, ghost[0].y - cl.end.y) < 1e-9 &&
          Math.hypot(ghost[1].x - cl.start.x, ghost[1].y - cl.start.y) < 1e-9
        return fwd || rev
      })
      expect(match).toBe(true)
    }
  })

  it('a setback that does not fit shows a warning and is SKIPPED on apply', () => {
    const d = doc([
      line('s1', 0, 0, 3, 0),     // short legs: max usable setback 3
      line('s2', 3, 0, 3, 3),
      line('l1', 3, 3, 23, 3),    // long corner elsewhere
      line('l2', 23, 3, 23, 23),
    ])
    const chain: ChamferChainState = {
      kind: 'chamfer',
      corners: chamferSeedFromSelection(d.entities, ['s1', 's2', 'l1', 'l2']),
      pendingLineId: null,
      pendingClick: null,
    }
    expect(chain.corners).toHaveLength(3) // s1/s2, s2/l1, l1/l2
    const pv = chamferChainPreview(chain, d, 5)
    expect(pv.misfits).toBeGreaterThan(0)
    expect(pv.warnings.length).toBe(pv.misfits)
    const r = chamferApplyAll(d, chain.corners, 5, newId)
    expect(r.applied).toBe(pv.fits)
    expect(r.skipped.length).toBe(pv.misfits)
    expect(r.skipped[0].reason).toMatch(/does not fit/)
  })

  it('nothing fits: apply returns no transform (no undo step)', () => {
    const d = doc([line('s1', 0, 0, 1, 0), line('s2', 1, 0, 1, 1)])
    const corners = chamferSeedFromSelection(d.entities, ['s1', 's2'])
    const r = chamferApplyAll(d, corners, 50, newId)
    expect(r.transform).toBeNull()
    expect(r.applied).toBe(0)
    expect(r.skipped).toHaveLength(1)
  })

  it('chamferSeedFromSelection finds only shared-endpoint line pairs', () => {
    const d = rectDoc()
    expect(chamferSeedFromSelection(d.entities, ['l1', 'l3'])).toHaveLength(0)
    expect(chamferSeedFromSelection(d.entities, ['l1', 'l2'])).toHaveLength(1)
  })

  it('corners is empty when nothing is staged', () => {
    const d = rectDoc()
    const chain: ChamferChainState = {
      kind: 'chamfer', corners: [], pendingLineId: null, pendingClick: null,
    }
    const pv = chamferChainPreview(chain, d, 2)
    expect(pv.corners).toHaveLength(0)
    expect(pv.lines).toHaveLength(0)
    expect(pv.warnings).toHaveLength(0)
  })
})

// ---- SKC-46-R2 requirement 5 (unconditional): the chamferLines ROUTING pin --------------------
//
// UI-50C-R2 (a sibling worktree, concurrently modifying this same file) writes its OWN marker
// inside `chamferLines` itself; that marker does not exist on wo/SKC-46, so it cannot be pinned
// here. What CAN and MUST be pinned on this branch is the ROUTING invariant the marker rides on:
// `chamferApplyAll` (chamferTool.ts:511-540) constructs every applied corner's committed segment
// by calling `chamferLines` (the :521 call site) -- there is no second, independent construction
// path. Two proofs: (a) a STRUCTURAL grep of the function body (only one call site, no duplicate
// `kind: 'line'` construction outside it); (b) a BEHAVIORAL proof that every segment
// `chamferApplyAll` commits for a real multi-corner batch is byte-identical (endpoints) to calling
// `chamferLines` directly, per corner, against the SAME sequentially-evolving document.
describe('SKC-46-R2: chamferLines routing pin (chamferApplyAll never bypasses chamferLines)', () => {
  it('STRUCTURAL: chamferApplyAll calls chamferLines exactly once, with no independent line construction', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'lib', 'sketch', 'tools', 'chamferTool.ts'), 'utf8')
    const start = src.indexOf('export function chamferApplyAll')
    expect(start, 'chamferApplyAll must exist in chamferTool.ts').toBeGreaterThanOrEqual(0)
    const nextExport = src.indexOf('\nexport ', start + 1)
    const body = src.slice(start, nextExport === -1 ? src.length : nextExport)
    const callSites = body.match(/\bchamferLines\(/g) ?? []
    expect(callSites, 'exactly ONE chamferLines call site inside chamferApplyAll').toHaveLength(1)
    // No second, independent line-entity construction (the shape a bypass would take: building a
    // `kind: 'line'` entity directly instead of routing through chamferLines).
    expect(body).not.toMatch(/kind:\s*'line'/)
  })

  it('BEHAVIORAL: every committed segment for a multi-corner batch matches calling chamferLines directly, per corner', () => {
    // Same open-rectangle fixture as the "preview + batch apply" describe block above.
    const d = doc([
      line('l1', 0, 0, 10, 0),
      line('l2', 10, 0, 10, 10),
      line('l3', 10, 10, 0, 10),
    ])
    const chain: ChamferChainState = {
      kind: 'chamfer',
      corners: chamferSeedFromSelection(d.entities, ['l1', 'l2', 'l3']),
      pendingLineId: null,
      pendingClick: null,
    }
    expect(chain.corners).toHaveLength(2)

    const r = chamferApplyAll(d, chain.corners, 2, newId)
    expect(r.applied).toBe(2)
    const committedSegments = r.transform!.entities.filter(
      (e): e is SketchLineEntity => e.kind === 'line' && !['l1', 'l2', 'l3'].includes(e.id),
    )
    expect(committedSegments).toHaveLength(2)

    // Replay chamferLines directly, per corner, against the SAME sequentially-evolving document
    // chamferApplyAll itself walks (the doc comment at chamferTool.ts:506-510) -- every committed
    // segment must be exactly what a direct chamferLines call would produce, corner by corner.
    let current: SketchDoc = d
    for (const corner of chain.corners) {
      const direct = chamferLines(current, corner.aId, corner.bId, corner.hintA, corner.hintB, 2, newId)
      expect(typeof direct).not.toBe('string')
      if (typeof direct === 'string') continue
      const directLine = direct.transform.entities.find(
        (e): e is SketchLineEntity => e.id === direct.lineId && e.kind === 'line',
      )
      expect(directLine).toBeDefined()
      const match = committedSegments.some((cl) =>
        Math.hypot(cl.start.x - directLine!.start.x, cl.start.y - directLine!.start.y) < 1e-9 &&
        Math.hypot(cl.end.x - directLine!.end.x, cl.end.y - directLine!.end.y) < 1e-9)
      expect(match, `committed segment for corner ${corner.aId}/${corner.bId} must match a direct chamferLines call`)
        .toBe(true)
      current = direct.transform
    }
  })
})

// ---- SKC-46: max-usable setback (default-derivation clamp) -------------------------------------

describe('chamferMaxUsableSetback / chamferChainMaxSetback (SKC-46)', () => {
  // A right-angle corner, both legs length 10: max usable setback = min(10, 10) = 10.
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const rightAngle = () => doc([line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)], [corner])

  it('SKC-46-R1 BLOCKER 1: is a STRICT ceiling chamferLines accepts AT the returned value -- not the bare geometric max', () => {
    const max = chamferMaxUsableSetback(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 })
    expect(max).not.toBeNull()
    // The bare geometric max (min(10,10) = 10) is NOT what's returned -- the auditor's evidence
    // was that seeding exactly this value staged an impossible preview (chamferLines requires
    // strictly LESS, by EPS_LEN).
    expect(max).toBeLessThan(10)
    expect(max).toBeCloseTo(10, 5)
    // The real regression proof: chamferLines FITS the returned ceiling AS-IS.
    const fitsAtCeiling = chamferLines(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, max!, newId)
    expect(typeof fitsAtCeiling).not.toBe('string')
    // ...and the bare geometric max (10) is REJECTED -- the auditor's reproduced failure.
    const rejectsAtGeometricMax = chamferLines(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 10, newId)
    expect(typeof rejectsAtGeometricMax).toBe('string')
  })

  it('BLOCKER 1 property sweep: the ceiling is accepted by the real fit function across many leg lengths', () => {
    const legLengths = [0.02, 0.05, 0.1, 0.5, 1, 2, 4, 7.3, 10, 25, 100, 1000]
    for (const leg of legLengths) {
      const d = doc([line('A', 0, 0, leg, 0), line('B', leg, 0, leg, leg)])
      const max = chamferMaxUsableSetback(d, 'A', 'B', { x: 0, y: 0 }, { x: leg, y: leg })
      expect(max, `leg=${leg}`).not.toBeNull()
      expect(Number.isFinite(max), `leg=${leg}`).toBe(true)
      if (max === null || max < 0.01) continue // sub-floor corners refuse instead (tested elsewhere)
      const r = chamferLines(d, 'A', 'B', { x: 0, y: 0 }, { x: leg, y: leg }, max, newId)
      expect(typeof r, `leg=${leg} max=${max}`).not.toBe('string')
    }
  })

  it('returns null for a non-resolvable pick (missing line / parallel / collinear)', () => {
    expect(chamferMaxUsableSetback(rightAngle(), 'A', 'ghost', { x: 0, y: 0 }, { x: 10, y: 10 })).toBeNull()
    const parallel = doc([line('A', 0, 0, 10, 0), line('B', 0, 1, 10, 1)])
    expect(chamferMaxUsableSetback(parallel, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 1 })).toBeNull()
  })

  // ---- SKC-46-R3 MAJOR 3: the derived refusal-construction census (R2 contract requirement 2,
  // constructions (b)/(d)/(e)) -- named separately from the missing/parallel pick above, mirrors
  // filletTool.test.ts's three named guard tests verbatim (both tools share the same trimSide /
  // angle-guard / entity-kind shapes).

  it('R2 2(b): a near-collinear pair whose intersection falls beyond a kept leg refuses (trimSide avail <= EPS_LEN)', () => {
    // A's infinite-line intersection with B lands at C=(-10,0) -- well PAST A's own (0,0)-(3,0)
    // segment. hintA picks the kept side toward A.start (away from C), so `avail` (measured from C
    // to A.start along the kept direction) comes out NEGATIVE: the corner is geometrically beyond
    // where A's kept leg reaches. B is a normal, well-resolved second line (its own trimSide
    // succeeds with plenty of avail) so this isolates A's guard specifically.
    const d = doc([
      line('A', 0, 0, 3, 0),
      line('B', 0, 1e-9, 10, 2e-9), // near-parallel to A (tilted ~1e-10 rad): denom stays >> 1e-12
    ])
    expect(chamferMaxUsableSetback(d, 'A', 'B', { x: -15, y: 0 }, { x: 0, y: 1e-9 })).toBeNull()
  })

  it('R2 2(d): a near-collinear (non-parallel-flagged) corner refuses on the angle guard, not the intersection guard', () => {
    // Same near-parallel construction as 2(b) but with hints chosen so BOTH trimSide calls succeed
    // (generous avail on the natural sides) -- the corner opening angle theta collapses to ~0,
    // strictly under EPS_ANG (1e-9 rad), while `lineLineIntersection`'s OWN denom guard (1e-12) does
    // NOT fire (these lines are not flagged as parallel). This isolates the theta<=EPS_ANG /
    // PI-theta<=EPS_ANG guard specifically.
    const d = doc([
      line('A', 0, 0, 10, 0),
      line('B', 0, 1e-9, 10, 2e-9),
    ])
    expect(chamferMaxUsableSetback(d, 'A', 'B', { x: 0, y: 0 }, { x: 0, y: 1e-9 })).toBeNull()
  })

  it('R2 2(e): an existing entity that is not a line refuses (distinct from a MISSING entity)', () => {
    const withCircle = doc([
      line('A', 0, 0, 10, 0),
      { id: 'circleB', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 2 } as SketchEntity,
    ])
    expect(chamferMaxUsableSetback(withCircle, 'A', 'circleB', { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull()
  })

  it('chamferChainMaxSetback is the MIN across every staged corner (the tighter corner governs)', () => {
    const shortB = doc(
      [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 4), line('C', 100, 0, 110, 0), line('D', 110, 0, 110, 10)],
    )
    const chain: ChamferChainState = {
      kind: 'chamfer',
      corners: [
        { aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 4 }, at: { x: 10, y: 0 } },
        { aId: 'C', bId: 'D', hintA: { x: 100, y: 0 }, hintB: { x: 110, y: 10 }, at: { x: 110, y: 0 } },
      ],
      pendingLineId: null, pendingClick: null,
    }
    // Minus the R1 CEILING_MARGIN safety margin (~2e-6mm) -- precision 5 comfortably covers it.
    const result = chamferChainMaxSetback(chain, shortB)
    expect(result.kind).toBe('finite-legal')
    if (result.kind === 'finite-legal') expect(result.value).toBeCloseTo(4, 5)
  })

  it('chamferChainMaxSetback returns "unresolvable" (SKC-46-R2) when NO staged corner resolves', () => {
    const chain: ChamferChainState = {
      kind: 'chamfer',
      corners: [{ aId: 'A', bId: 'ghost', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } }],
      pendingLineId: null, pendingClick: null,
    }
    expect(chamferChainMaxSetback(chain, rightAngle())).toEqual({ kind: 'unresolvable' })
  })

  it('chamferChainMaxSetback returns "no-corner" (SKC-46-R2) for an empty chain -- distinct from unresolvable', () => {
    const chain: ChamferChainState = { kind: 'chamfer', corners: [], pendingLineId: null, pendingClick: null }
    expect(chamferChainMaxSetback(chain, rightAngle())).toEqual({ kind: 'no-corner' })
  })
})

// ---- BK-136: chamferChainPreview memoizes one computation per (chain, doc, setback) ------------

describe('chamferChainPreview memoization (BK-136, SKC-46)', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const rightAngle = () => doc([line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)], [corner])
  const chain: ChamferChainState = {
    kind: 'chamfer',
    corners: [{ aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } }],
    pendingLineId: null, pendingClick: null,
  }

  beforeEach(() => {
    __resetChamferChainPreviewMemo()
  })

  it('two calls with the SAME chain reference, shallow-equal doc arrays, and setback compute ONCE', () => {
    const d = rightAngle()
    chamferChainPreview(chain, d, 2)
    chamferChainPreview(chain, { entities: [...d.entities], constraints: [...d.constraints], dimensions: [...d.dimensions] }, 2)
    expect(__chamferPreviewComputeCount()).toBe(1)
  })

  it('a different setback is a cache miss (recomputes)', () => {
    const d = rightAngle()
    chamferChainPreview(chain, d, 2)
    chamferChainPreview(chain, d, 3)
    expect(__chamferPreviewComputeCount()).toBe(2)
  })

  it('a different chain reference is a cache miss even with identical corner content', () => {
    const d = rightAngle()
    chamferChainPreview(chain, d, 2)
    chamferChainPreview({ ...chain, corners: [...chain.corners] }, d, 2)
    expect(__chamferPreviewComputeCount()).toBe(2)
  })

  it('the cached result is the exact same object (not a deep-equal copy) on a hit', () => {
    const d = rightAngle()
    const first = chamferChainPreview(chain, d, 2)
    const second = chamferChainPreview(chain, { entities: [...d.entities], constraints: [...d.constraints], dimensions: [...d.dimensions] }, 2)
    expect(second).toBe(first)
  })
})
