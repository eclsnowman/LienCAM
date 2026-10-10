/* WO-1827: adjacent nested parts can share one cut line.
 *
 * Two halves, tested separately and then together:
 *
 *   SOLVER  (solver.ts applyCommonEdges / solveNest's `commonEdge` option) -
 *     which placements are allowed to weld onto one line, which keep their
 *     kerf, and which parts are excluded BY NAME. The precision cases run the
 *     PURE function on hand-built placements so the geometry is exact; the
 *     end-to-end cases run the real solver so the claim is about what the
 *     engine actually produces, packer float dust included.
 *
 *   EMITTER (instanceToolpath.ts expandNest) - the shared line is cut ONCE per
 *     op, ownership is recorded, the remaining contour of both owners is
 *     byte-identical to the unshared emission, and a WRONG share removes
 *     nothing.
 *
 * The last test writes the measured fixture grid into src/tests/evidence/
 * WO-1827/ (material saved, cut length saved, and the wrong-share control).
 *
 * FIXTURE DESIGN: 20 mm squares locked to 0 deg on a narrow, tall, width-locked
 * sheet. Per solver.test.ts's note the packer is exact in that regime - it
 * stacks a clean single column - so every number below is hand-derivable:
 * N squares at partGap g occupy N*20 + (N-1)*g of length unshared and exactly
 * N*20 shared, and the profile is 4*20 = 80 mm of cut per copy less 20 mm for
 * every shared line it does not re-cut.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import { evidenceOutDir } from '../../helpers/evidenceScratch'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  applyCommonEdges,
  solveNest,
  verifyCommonEdges,
  type CommonEdgeRequest,
  type SharedCutEdge,
} from '../../../lib/cam/nesting/solver'
import {
  expandNest,
  type SeedOpExpansionInput,
  type SharedCutLine,
} from '../../../lib/cam/nesting/instanceToolpath'
import type { NestPart, Placement, Spacing } from '../../../lib/cam/nesting/types'
import type { ToolpathMove, Vec2 } from '../../../types/index'

// ── fixtures ────────────────────────────────────────────────────────────────

const PART_GAP = 2
const SIZE = 20
const SHEET_WIDTH = 24

/** size x size square, lower-left at the local origin, CCW, rotation locked. */
function square(id: string, size = SIZE): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
    holes: [],
    lockedRotationDeg: 0,
  }
}

/** w x h rectangle, lower-left at the local origin, CCW, rotation locked. */
function rect(id: string, w: number, h: number): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    holes: [],
    lockedRotationDeg: 0,
  }
}

const SPACING: Spacing = { partGap: PART_GAP, sheetMargin: 0, windowGap: 0 }

function placement(partId: string, instanceId: string, x: number, y: number): Placement {
  return { partId, instanceId, x, y, rotationDeg: 0, depth: 0 }
}

/** Width-locked min-length solve of `quantity` squares; `commonEdge` toggles
 *  the WO-1827 option. Everything else is identical between the two runs. */
function columnRequest(quantity: number, commonEdge: boolean): CommonEdgeRequest {
  return {
    parts: [{ part: square('sq'), quantity }],
    sheet: { width: SHEET_WIDTH, height: 400 },
    style: 'ninety',
    spacing: SPACING,
    solver: { kind: 'fixQty', lockedAxis: 'width' },
    seed: 12345,
    ...(commonEdge ? { commonEdge: { enabled: true } } : {}),
  }
}

/** A seed-local closed profile for a `size` square, cut ON the outline (the
 *  common-edge case: the tool centre runs down the shared line, each part
 *  giving up half the kerf). Seam at the local origin. */
function squareProfileMoves(size = SIZE, cutZ = -1, clearZ = 5, feed = 800): ToolpathMove[] {
  return [
    { type: 'rapid', x: 0, y: 0, z: clearZ, role: 'rapid' },
    { type: 'feed', x: 0, y: 0, z: cutZ, role: 'plunge', feed },
    { type: 'feed', x: size, y: 0, z: cutZ, role: 'cut', feed },
    { type: 'feed', x: size, y: size, z: cutZ, role: 'cut', feed },
    { type: 'feed', x: 0, y: size, z: cutZ, role: 'cut', feed },
    { type: 'feed', x: 0, y: 0, z: cutZ, role: 'cut', feed },
    { type: 'rapid', x: 0, y: 0, z: clearZ, role: 'rapid' },
  ]
}

function profileOp(opId = 'contour', toolId = 'T1'): SeedOpExpansionInput {
  return {
    opId,
    toolId,
    sourceGeometryId: 'sq',
    localMoves: squareProfileMoves(),
    clearanceZ: 5,
    retractZ: 2,
    feedZ: 0,
  }
}

const ORIGIN: Vec2 = { x: 0, y: 0 }

// applyCommonEdges / verifyCommonEdges use the clipper engine for their
// overlap test (as placementSafety.ts does). solveNest initialises it itself;
// the direct-call tests below have to.
beforeAll(async () => {
  await ensureEngineClipperReady()
})

/** Total CUT distance in XY (mm) over a move stream: feed moves only, measured
 *  from the previous move's endpoint. A plunge contributes zero XY. */
function cutLengthXY(moves: readonly ToolpathMove[]): number {
  let total = 0
  for (let k = 1; k < moves.length; k++) {
    const move = moves[k]
    if (move.type !== 'feed') continue
    const prev = moves[k - 1]
    total += Math.hypot(move.x - prev.x, move.y - prev.y)
  }
  return total
}

/** Highest Y any placed part reaches (mm) - the length of stock the nest really
 *  consumes, independent of how the solver rounded the sheet. */
function usedLengthY(parts: readonly { part: NestPart }[], placements: readonly Placement[]): number {
  const partById = new Map(parts.map((e) => [e.part.id, e.part]))
  let maxY = 0
  for (const p of placements) {
    const src = partById.get(p.partId)
    if (!src) continue
    for (const v of src.outer) {
      const rad = (p.rotationDeg * Math.PI) / 180
      const wy = v.x * Math.sin(rad) + v.y * Math.cos(rad) + p.y
      if (wy > maxY) maxY = wy
    }
  }
  return maxY
}

/** The solver's shared edges as the emitter's line shape. */
function asCutLines(edges: readonly SharedCutEdge[]): SharedCutLine[] {
  return edges.map((e) => ({ a: e.a, b: e.b, owners: e.owners }))
}

// ── solver: which pairs may share ───────────────────────────────────────────

describe('WO-1827 solver: which adjacent parts may share one cut line', () => {
  it('two squares a kerf apart weld onto ONE line and end up touching', () => {
    const parts = [{ part: square('sq') }]
    const placements = [
      placement('sq', 'sq#0', 0, 0),
      placement('sq', 'sq#1', 0, SIZE + PART_GAP),
    ]
    const report = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 100 }, {
      enabled: true,
    })

    expect(report.sharedEdges).toHaveLength(1)
    const edge = report.sharedEdges[0]
    expect(edge.owners).toEqual(['sq#0', 'sq#1'])
    expect(edge.length).toBeCloseTo(SIZE, 9)
    // the upper square came DOWN by exactly the kerf; the lower one never moved
    expect(report.placements[0]).toMatchObject({ instanceId: 'sq#0', x: 0, y: 0 })
    expect(report.placements[1]).toMatchObject({ instanceId: 'sq#1', x: 0, y: SIZE })
    expect(verifyCommonEdges(parts, report.placements, report.sharedEdges).problems).toEqual([])
  })

  it('a whole column compacts: N-1 shared lines, every gap closed', () => {
    const parts = [{ part: square('sq') }]
    const placements = [0, 1, 2, 3].map((k) =>
      placement('sq', `sq#${k}`, 0, k * (SIZE + PART_GAP)),
    )
    const report = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 200 }, {
      enabled: true,
    })

    expect(report.sharedEdges).toHaveLength(3)
    expect(report.placements.map((p) => p.y)).toEqual([0, 20, 40, 60])
    expect(verifyCommonEdges(parts, report.placements, report.sharedEdges).ok).toBe(true)
  })

  it('facing edges of UNEQUAL length keep their kerf - no partial share', () => {
    const parts = [{ part: square('wide') }, { part: rect('narrow', 12, SIZE) }]
    const placements = [
      placement('wide', 'a#0', 0, 0),
      placement('narrow', 'b#0', 0, SIZE + PART_GAP),
    ]
    const report = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 100 }, {
      enabled: true,
    })

    expect(report.sharedEdges).toEqual([])
    expect(report.placements[1].y).toBe(SIZE + PART_GAP) // untouched, still spaced
  })

  it('equal edges SLID along their own direction keep their kerf', () => {
    // same 20 mm edges facing each other, but offset 5 mm sideways: welding them
    // would leave a 5 mm stub of each profile owned by nobody.
    const parts = [{ part: square('sq') }]
    const placements = [
      placement('sq', 'sq#0', 0, 0),
      placement('sq', 'sq#1', 5, SIZE + PART_GAP),
    ]
    const report = applyCommonEdges(parts, placements, SPACING, { width: 40, height: 100 }, {
      enabled: true,
    })
    expect(report.sharedEdges).toEqual([])
    expect(report.placements[1]).toMatchObject({ x: 5, y: SIZE + PART_GAP })
  })

  it('parts FURTHER apart than the requested kerf are never fetched together', () => {
    const parts = [{ part: square('sq') }]
    const placements = [
      placement('sq', 'sq#0', 0, 0),
      placement('sq', 'sq#1', 0, SIZE + PART_GAP * 5),
    ]
    const report = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 200 }, {
      enabled: true,
    })
    expect(report.sharedEdges).toEqual([])
    expect(report.placements[1].y).toBe(SIZE + PART_GAP * 5)
  })

  it('a part that cannot be defined by sharing is excluded BY NAME, not silently spaced', () => {
    const openContour: NestPart = { id: 'open', outer: [{ x: 0, y: 0 }, { x: SIZE, y: 0 }], holes: [] }
    const degenerate: NestPart = {
      id: 'flat',
      outer: [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE / 2, y: 0 }],
      holes: [],
    }
    const parts = [{ part: square('sq') }, { part: openContour }, { part: degenerate }]
    const placements = [
      placement('sq', 'sq#0', 0, 0),
      placement('open', 'open#0', 0, SIZE + PART_GAP),
    ]
    const report = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 100 }, {
      enabled: true,
      excludePartIds: ['sq'],
    })

    expect(report.excluded.map((e) => e.partId)).toEqual(['flat', 'open', 'sq'])
    const byId = new Map(report.excluded.map((e) => [e.partId, e.reason]))
    expect(byId.get('sq')).toContain('named by the caller')
    expect(byId.get('open')).toContain('open contour')
    expect(byId.get('flat')).toContain('open contour')
    // and the excluded parts kept their spacing rather than being welded
    expect(report.sharedEdges).toEqual([])
    expect(report.placements[1].y).toBe(SIZE + PART_GAP)
  })

  it('verifyCommonEdges names a WRONG share instead of accepting it', () => {
    const parts = [{ part: square('sq') }]
    const placements = [placement('sq', 'sq#0', 0, 0), placement('sq', 'sq#1', 0, SIZE)]
    const honest = applyCommonEdges(parts, placements, SPACING, { width: SHEET_WIDTH, height: 100 }, {
      enabled: true,
    })
    expect(verifyCommonEdges(parts, honest.placements, honest.sharedEdges).ok).toBe(true)

    // the SAME claimed line, but sq#1 nudged 1 mm away: the two parts no longer
    // meet there, so the claim is a lie and must be named as one.
    const moved = honest.placements.map((p) =>
      p.instanceId === 'sq#1' ? { ...p, y: p.y + 1 } : p,
    )
    const check = verifyCommonEdges(parts, moved, honest.sharedEdges)
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toContain('sq#1')
    expect(check.problems.join(' ')).toContain('do not meet there')
  })

  it('stacked (overlapping) owners are named, never accepted as a shared line', () => {
    const parts = [{ part: square('sq') }]
    const overlapped = [placement('sq', 'sq#0', 0, 0), placement('sq', 'sq#1', 0, SIZE / 2)]
    const claim: SharedCutEdge[] = [
      {
        a: { x: SIZE, y: SIZE / 2 },
        b: { x: 0, y: SIZE / 2 },
        length: SIZE,
        owners: ['sq#0', 'sq#1'],
        ownerPartIds: ['sq', 'sq'],
      },
    ]
    const check = verifyCommonEdges(parts, overlapped, claim)
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toContain('overlap by area')
  })
})

// ── solver: the request option, end to end ─────────────────────────────────

describe('WO-1827 solver: the commonEdge request option', () => {
  it('OFF (absent or disabled) is byte-identical to the pre-WO-1827 solve', async () => {
    const absent = await solveNest(columnRequest(4, false))
    const disabled = await solveNest({ ...columnRequest(4, false), commonEdge: { enabled: false } })
    expect(disabled).toEqual(absent)
    expect(absent.sharedEdges).toBeUndefined()
    expect(absent.commonEdgeExcluded).toBeUndefined()
  })

  it('ON: four packed squares share three cut lines and the stock gets shorter', async () => {
    const off = await solveNest(columnRequest(4, false))
    const on = await solveNest(columnRequest(4, true))

    expect(off.unplaced).toEqual([])
    expect(on.unplaced).toEqual([])
    expect(on.placements).toHaveLength(4) // nothing merged away
    expect(on.sharedEdges).toHaveLength(3)
    for (const edge of on.sharedEdges ?? []) expect(edge.length).toBeCloseTo(SIZE, 6)

    const parts = columnRequest(4, true).parts
    expect(verifyCommonEdges(parts, on.placements, on.sharedEdges ?? []).problems).toEqual([])

    // measured, not asserted: three closed kerfs of 2 mm each
    const usedOff = usedLengthY(parts, off.placements)
    const usedOn = usedLengthY(parts, on.placements)
    expect(usedOff - usedOn).toBeCloseTo(3 * PART_GAP, 3)
    expect(on.sheetUsed.width).toBe(SHEET_WIDTH) // locked axis untouched
    expect(on.sheetUsed.height).toBeLessThan(off.sheetUsed.height)
  })

  it('ON is deterministic: the same seed twice gives the same shared nest', async () => {
    const first = await solveNest(columnRequest(4, true))
    const second = await solveNest(columnRequest(4, true))
    expect(second).toEqual(first)
  })

  it('a caller-excluded part keeps its kerf and is reported by name', async () => {
    const off = await solveNest(columnRequest(4, false))
    const excluded = await solveNest({
      ...columnRequest(4, false),
      commonEdge: { enabled: true, excludePartIds: ['sq'] },
    })
    expect(excluded.sharedEdges).toEqual([])
    expect(excluded.commonEdgeExcluded).toEqual([
      {
        partId: 'sq',
        reason:
          'named by the caller as unable to share a cut line (tolerance or finish critical)',
      },
    ])
    expect(excluded.placements).toEqual(off.placements) // still kerf-spaced
  })
})

// ── emitter: one line, cut once, owned by two parts ────────────────────────

describe('WO-1827 emitter: a shared cut line is emitted once', () => {
  const parts = [{ part: square('sq') }]

  /** Two squares already welded onto one line, plus that line. */
  function weldedPair(): { placements: Placement[]; lines: SharedCutLine[] } {
    const report = applyCommonEdges(
      parts,
      [placement('sq', 'sq#0', 0, 0), placement('sq', 'sq#1', 0, SIZE + PART_GAP)],
      SPACING,
      { width: SHEET_WIDTH, height: 100 },
      { enabled: true },
    )
    expect(report.sharedEdges).toHaveLength(1)
    return { placements: report.placements, lines: asCutLines(report.sharedEdges) }
  }

  it('the line is cut ONCE, not twice, and the saving is the line length', () => {
    const { placements, lines } = weldedPair()
    const noShare = expandNest([profileOp()], placements, ORIGIN, 'by-operation')
    const shared = expandNest([profileOp()], placements, ORIGIN, 'by-operation', lines)

    expect(cutLengthXY(noShare.moves)).toBeCloseTo(2 * 4 * SIZE, 6)
    expect(cutLengthXY(shared.moves)).toBeCloseTo(2 * 4 * SIZE - SIZE, 6)

    // and only one pass in the whole stream actually traverses that line
    const passes = shared.moves.filter((move, index) => {
      if (index === 0 || move.type !== 'feed') return false
      const prev = shared.moves[index - 1]
      const [a, b] = [lines[0].a, lines[0].b]
      const near = (m: { x: number; y: number }, p: Vec2) => Math.hypot(m.x - p.x, m.y - p.y) < 1e-6
      return (near(prev, a) && near(move, b)) || (near(prev, b) && near(move, a))
    })
    expect(passes).toHaveLength(1)
  })

  it('ownership is recorded: one path, one cutter, one sharer', () => {
    const { placements, lines } = weldedPair()
    const shared = expandNest([profileOp()], placements, ORIGIN, 'by-operation', lines)

    expect(shared.unmatchedSharedCutLines).toEqual([])
    expect(shared.sharedCuts).toHaveLength(1)
    const record = shared.sharedCuts[0]
    expect(record.lineIndex).toBe(0)
    expect(record.opId).toBe('contour')
    expect(record.toolId).toBe('T1')
    expect(record.cutByInstanceId).toBe('sq#0')
    expect(record.sharedWithInstanceIds).toEqual(['sq#1'])
    expect(record.skippedSpanCount).toBe(1)
    // the two owners of the record are exactly the two owners of the line
    expect([record.cutByInstanceId, ...record.sharedWithInstanceIds].sort()).toEqual(
      [...lines[0].owners].sort(),
    )
  })

  it('both parts keep every OTHER move byte-identical to the unshared emission', () => {
    const { placements, lines } = weldedPair()
    const noShare = expandNest([profileOp()], placements, ORIGIN, 'by-part')
    const shared = expandNest([profileOp()], placements, ORIGIN, 'by-part', lines)

    expect(shared.sections.map((s) => s.opId)).toEqual(noShare.sections.map((s) => s.opId))
    // sq#0 cuts the line: its section is untouched, move for move.
    expect(shared.sections[0].moves).toEqual(noShare.sections[0].moves)

    // sq#1 skips it. Locate the span in the unshared stream, then assert the
    // shared stream is exactly that stream with the span replaced by a
    // retract -> rapid -> plunge seam and NOTHING else changed.
    const before = noShare.sections[1].moves
    const near = (m: { x: number; y: number }, p: Vec2) => Math.hypot(m.x - p.x, m.y - p.y) < 1e-6
    const k = before.findIndex((move, index) => {
      if (index === 0 || move.type !== 'feed') return false
      const prev = before[index - 1]
      return (
        (near(prev, lines[0].a) && near(move, lines[0].b)) ||
        (near(prev, lines[0].b) && near(move, lines[0].a))
      )
    })
    expect(k).toBeGreaterThan(0)

    const span = before[k]
    const prev = before[k - 1]
    const safeZ = 5 // profileOp clearanceZ, no retractMode -> the safe inter-copy plane
    const expected: ToolpathMove[] = [
      ...before.slice(0, k),
      { type: 'rapid', x: prev.x, y: prev.y, z: safeZ, role: 'rapid' },
      { type: 'rapid', x: span.x, y: span.y, z: safeZ, role: 'rapid' },
      { type: 'feed', x: span.x, y: span.y, z: span.z, role: 'plunge', feed: span.feed },
      ...before.slice(k + 1),
    ]
    expect(shared.sections[1].moves).toEqual(expected)
  })

  it('a WRONG share removes no cut - the claim is reported, the part stays whole', () => {
    const { placements, lines } = weldedPair()
    const honest = expandNest([profileOp()], placements, ORIGIN, 'by-operation', lines)

    // claim the SAME geometric line, but between sq#0 and a copy that is not
    // there at all, plus a line that lies on no part whatsoever.
    const wrong: SharedCutLine[] = [
      { a: lines[0].a, b: lines[0].b, owners: ['sq#0', 'sq#99'] },
      { a: { x: 500, y: 500 }, b: { x: 520, y: 500 }, owners: ['sq#0', 'sq#1'] },
    ]
    const emitted = expandNest([profileOp()], placements, ORIGIN, 'by-operation', wrong)

    // nothing was skipped: the full two-copy contour is still cut
    expect(cutLengthXY(emitted.moves)).toBeCloseTo(2 * 4 * SIZE, 6)
    expect(cutLengthXY(emitted.moves)).toBeGreaterThan(cutLengthXY(honest.moves))
    // line 1 matched no move anywhere; line 0 matched only its real owner
    expect(emitted.unmatchedSharedCutLines).toEqual([1])
    expect(emitted.sharedCuts).toHaveLength(1)
    expect(emitted.sharedCuts[0].sharedWithInstanceIds).toEqual([])
    expect(emitted.sharedCuts[0].skippedSpanCount).toBe(0)
  })

  it('two DIFFERENT ops over one profile both keep their pass', () => {
    // a rough and a finish down the same line are not redundant with each
    // other; only two copies of the SAME op are.
    const { placements, lines } = weldedPair()
    const rough = profileOp('rough', 'T1')
    const finish = profileOp('finish', 'T2')
    const shared = expandNest([rough, finish], placements, ORIGIN, 'by-operation', lines)

    expect(shared.sharedCuts.map((r) => r.opId)).toEqual(['rough', 'finish'])
    expect(shared.sharedCuts.map((r) => r.toolId)).toEqual(['T1', 'T2'])
    for (const record of shared.sharedCuts) {
      expect(record.cutByInstanceId).toBe('sq#0')
      expect(record.sharedWithInstanceIds).toEqual(['sq#1'])
    }
    // one line saved per op, not one in total
    expect(cutLengthXY(shared.moves)).toBeCloseTo(2 * (2 * 4 * SIZE - SIZE), 6)
  })

  it('no shared lines supplied -> the expansion is what it always was', () => {
    const { placements } = weldedPair()
    const before = expandNest([profileOp()], placements, ORIGIN, 'by-operation')
    expect(before.sharedCuts).toEqual([])
    expect(before.unmatchedSharedCutLines).toEqual([])
    expect(cutLengthXY(before.moves)).toBeCloseTo(2 * 4 * SIZE, 6)
  })
})

// ── measured evidence grid ─────────────────────────────────────────────────

describe('WO-1827 evidence: the saving is measured, not asserted', () => {
  it('writes the fixture grid to src/tests/evidence/WO-1827/', async () => {
    const evidenceDir = evidenceOutDir(join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'evidence',
      'WO-1827',
    ))
    mkdirSync(evidenceDir, { recursive: true })

    interface Row {
      copies: number
      sharedLines: number
      materialBeforeMm2: number
      materialAfterMm2: number
      materialSavedMm2: number
      cutLengthBeforeMm: number
      cutLengthAfterMm: number
      cutLengthSavedMm: number
      partsBefore: number
      partsAfter: number
      sharesVerified: boolean
      unmatchedLines: number
    }

    const rows: Row[] = []
    for (const copies of [2, 3, 4, 6]) {
      const parts = columnRequest(copies, true).parts
      const off = await solveNest(columnRequest(copies, false))
      const on = await solveNest(columnRequest(copies, true))
      expect(off.unplaced).toEqual([])
      expect(on.unplaced).toEqual([])

      const lines = asCutLines(on.sharedEdges ?? [])
      const emittedOff = expandNest([profileOp()], off.placements, ORIGIN, 'by-operation')
      const emittedOn = expandNest([profileOp()], on.placements, ORIGIN, 'by-operation', lines)

      const materialBefore = SHEET_WIDTH * usedLengthY(parts, off.placements)
      const materialAfter = SHEET_WIDTH * usedLengthY(parts, on.placements)
      rows.push({
        copies,
        sharedLines: lines.length,
        materialBeforeMm2: materialBefore,
        materialAfterMm2: materialAfter,
        materialSavedMm2: materialBefore - materialAfter,
        cutLengthBeforeMm: cutLengthXY(emittedOff.moves),
        cutLengthAfterMm: cutLengthXY(emittedOn.moves),
        cutLengthSavedMm: cutLengthXY(emittedOff.moves) - cutLengthXY(emittedOn.moves),
        partsBefore: off.placements.length,
        partsAfter: on.placements.length,
        sharesVerified: verifyCommonEdges(parts, on.placements, on.sharedEdges ?? []).ok,
        unmatchedLines: emittedOn.unmatchedSharedCutLines.length,
      })
    }

    // Every row must be a REAL saving on both axes, with no part lost and every
    // claimed line verified against the transformed geometry.
    for (const row of rows) {
      expect(row.sharedLines).toBe(row.copies - 1)
      expect(row.partsAfter).toBe(row.copies)
      expect(row.partsAfter).toBe(row.partsBefore)
      expect(row.sharesVerified).toBe(true)
      expect(row.unmatchedLines).toBe(0)
      expect(row.materialSavedMm2).toBeCloseTo(SHEET_WIDTH * (row.copies - 1) * PART_GAP, 2)
      expect(row.cutLengthSavedMm).toBeCloseTo((row.copies - 1) * SIZE, 6)
    }

    // ── the wrong-share control: a share that is not real must FAIL visibly ──
    const parts = columnRequest(4, true).parts
    const on = await solveNest(columnRequest(4, true))
    const honestLines = asCutLines(on.sharedEdges ?? [])
    // nudge one copy 1 mm away: two of the three claimed lines become lies
    const corrupted = on.placements.map((p) =>
      p.instanceId === 'sq#2' ? { ...p, y: p.y + 1 } : p,
    )
    const verdict = verifyCommonEdges(parts, corrupted, on.sharedEdges ?? [])
    const emittedWrong = expandNest([profileOp()], corrupted, ORIGIN, 'by-operation', honestLines)
    const emittedHonest = expandNest([profileOp()], on.placements, ORIGIN, 'by-operation', honestLines)

    const control = {
      verifierAccepted: verdict.ok,
      problems: verdict.problems,
      partsStillPlaced: corrupted.length,
      cutLengthHonestMm: cutLengthXY(emittedHonest.moves),
      cutLengthWrongMm: cutLengthXY(emittedWrong.moves),
      linesNoCopyTraced: emittedWrong.unmatchedSharedCutLines.length,
      linesThatLostTheirSharer: emittedWrong.sharedCuts.filter((r) => r.skippedSpanCount === 0)
        .length,
    }
    expect(control.verifierAccepted).toBe(false)
    expect(control.problems.length).toBeGreaterThan(0)
    // the wrong claim removed NOTHING it should not have: the corrupted nest
    // cuts MORE, never less, and no part was left open.
    expect(control.cutLengthWrongMm).toBeGreaterThan(control.cutLengthHonestMm)
    expect(control.partsStillPlaced).toBe(4)
    // the two lies are visible as lines whose second owner no longer traces
    // them, so nothing was skipped on their behalf.
    expect(control.linesThatLostTheirSharer).toBe(2)

    const payload = {
      workOrder: 'WO-1827',
      fixture: {
        part: `${SIZE} x ${SIZE} mm square, rotation locked to 0 deg`,
        sheet: `${SHEET_WIDTH} mm wide, length solved (fixQty, lockedAxis 'width')`,
        partGapMm: PART_GAP,
        sheetMarginMm: 0,
        seed: 12345,
        op: 'closed profile cut ON the outline, 80 mm per copy',
      },
      grid: rows,
      wrongShareControl: control,
    }
    writeFileSync(join(evidenceDir, 'common-edge-grid.json'), `${JSON.stringify(payload, null, 2)}\n`)

    const md = [
      '# WO-1827 evidence: adjacent nested parts share one cut line',
      '',
      'Generated by `src/tests/cam/nesting/commonEdge.wo1827.test.ts` - every number',
      'below is measured from the real solver and the real nest expander, not asserted.',
      '',
      `Fixture: ${SIZE} x ${SIZE} mm squares, rotation locked, on a ${SHEET_WIDTH} mm wide`,
      `sheet whose length the solver picks (fixQty / lockedAxis 'width'), partGap`,
      `${PART_GAP} mm, seed 12345. Each copy's profile is ${4 * SIZE} mm of cut.`,
      '',
      '| copies | shared lines | material before (mm2) | material after (mm2) | material saved (mm2) | cut before (mm) | cut after (mm) | cut saved (mm) | parts out | shares verified |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.copies} | ${r.sharedLines} | ${r.materialBeforeMm2.toFixed(2)} | ${r.materialAfterMm2.toFixed(2)} | ${r.materialSavedMm2.toFixed(2)} | ${r.cutLengthBeforeMm.toFixed(2)} | ${r.cutLengthAfterMm.toFixed(2)} | ${r.cutLengthSavedMm.toFixed(2)} | ${r.partsAfter} | ${r.sharesVerified ? 'yes' : 'NO'} |`,
      ),
      '',
      '## Wrong-share control',
      '',
      'One copy of the 4-square nest is nudged 1 mm away AFTER the shares are',
      'recorded, so two of the three claimed lines become lies. A wrong share has',
      'to fail where an operator can see it, and it does:',
      '',
      `- the verifier refuses the set: accepted = ${control.verifierAccepted}`,
      ...control.problems.map((p) => `  - ${p}`),
      `- no part is lost: ${control.partsStillPlaced} of 4 still placed`,
      `- the emitter removes NOTHING on a claim the geometry does not support:`,
      `  ${control.cutLengthWrongMm.toFixed(2)} mm of cut against ${control.cutLengthHonestMm.toFixed(2)} mm for the honest share`,
      `- lines no copy ever traced: ${control.linesNoCopyTraced}`,
      `- lines whose second owner no longer meets them (so nothing was skipped): ${control.linesThatLostTheirSharer}`,
      '',
    ].join('\n')
    writeFileSync(join(evidenceDir, 'README.md'), `${md}\n`)

    expect(rows).toHaveLength(4)
  }, 120_000)
})
