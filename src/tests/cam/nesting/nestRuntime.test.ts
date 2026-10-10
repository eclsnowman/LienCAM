/* Tests for the PURE nest-level cut-time aggregation (ADR 0024 Amendment 1:
 * estimate must TIME the full expanded multi-copy stream, INCLUDING inter-copy
 * travel). src/lib/cam/nesting/nestRuntime.ts builds the expansion
 * (buildNestExpansion) and times it with estimateRuntimeMs, so totalMs now
 * counts the rapids linking placed copies — it is no longer a per-copy multiply.
 *
 * Gates:
 *   - SINGLE SOURCE: 1 source, 4 placements, one seed op with real moves ->
 *     totalMs >= per-copy cut x copies (travel only adds time), perSourceMs is
 *     the per-copy cut sum, instanceCount 4, travelExcluded false.
 *   - TWO SOURCES: each its own seed op + differing placement counts ->
 *     correct instanceCount + perSourceMs; totalMs > 0.
 *   - UNBOUND OP: an op whose params.geometryId is NOT a nest source is ignored.
 *   - UNCOMPUTED OP: an op with no toolpathMoves contributes nothing to totalMs.
 *   - PURITY: input nest + operations are not mutated.
 */

import { describe, it, expect } from 'vitest'
import type { NestRecord, Operation, ToolpathMove } from '../../../types/index'
import type { Placement } from '../../../lib/cam/nesting/types'
import { estimateNestCutTimeMs } from '../../../lib/cam/nesting/nestRuntime'

// A machine rapid rate used for inter-copy travel timing.
const RAPID = 5000 // mm/min

function placement(
  partial: Partial<Placement> & Pick<Placement, 'instanceId' | 'partId'>,
): Placement {
  return { x: 0, y: 0, rotationDeg: 0, depth: 0, ...partial }
}

/** A minimal seed-local cut toolpath: plunge then a feed cut, both with a
 *  baked feed so estimateRuntimeMs times them deterministically. `len` is the
 *  XY cut length (mm); `feed` is mm/min. */
function cutMoves(len: number, feed: number): ToolpathMove[] {
  return [
    { type: 'feed', x: 0, y: 0, z: 1, feed },
    { type: 'feed', x: len, y: 0, z: 1, feed },
  ]
}

function op(
  partial: Partial<Operation> & Pick<Operation, 'id'> & {
    geometryId?: string
    estimatedCutTimeMs?: number
    toolpathMoves?: ToolpathMove[]
  },
): Operation {
  const { geometryId, ...rest } = partial
  return {
    name: 'op',
    type: 'pocket_2d',
    enabled: true,
    status: 'ready',
    toolId: 't1',
    geometrySelections: [],
    heights: {} as Operation['heights'],
    passes: {} as Operation['passes'],
    linking: {} as Operation['linking'],
    params: geometryId !== undefined ? { geometryId } : {},
    ...rest,
  } as Operation
}

function nest(partial: Partial<NestRecord>): NestRecord {
  return {
    id: 'n1',
    name: 'Nest 1',
    sheet: { width: 100, height: 100 },
    style: 'ninety',
    spacing: {} as NestRecord['spacing'],
    seed: 1,
    sources: [],
    placements: [],
    unplaced: [],
    utilization: 0,
    ...partial,
  } as NestRecord
}

describe('estimateNestCutTimeMs - single source', () => {
  it('times the expanded stream: total >= per-copy cut x copies (travel adds)', () => {
    // 4 copies SPREAD apart so there is real inter-copy travel.
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 4 }],
      placements: [
        placement({ instanceId: 'i1', partId: 'g1', x: 0, y: 0 }),
        placement({ instanceId: 'i2', partId: 'g1', x: 40, y: 0 }),
        placement({ instanceId: 'i3', partId: 'g1', x: 0, y: 40 }),
        placement({ instanceId: 'i4', partId: 'g1', x: 40, y: 40 }),
      ],
    })
    // One seed op: 10mm cut at 1000 mm/min = 0.6 s per copy = 600 ms.
    const perCopyCutMs = (10 / 1000) * 60000 // 600
    const ops = [
      op({
        id: 'o1',
        geometryId: 'g1',
        estimatedCutTimeMs: perCopyCutMs,
        toolpathMoves: cutMoves(10, 1000),
      }),
    ]

    const out = estimateNestCutTimeMs(n, ops, RAPID)
    // perSourceMs = per-COPY cut sum (one copy of the source's ops).
    expect(out.perSourceMs).toBeCloseTo(perCopyCutMs, 3)
    expect(out.instanceCount).toBe(4)
    expect(out.travelExcluded).toBe(false)
    // The expanded stream is cut-of-4-copies PLUS inter-copy travel, so the
    // honest total STRICTLY exceeds the naive per-copy multiply.
    expect(out.totalMs).toBeGreaterThan(perCopyCutMs * 4)
  })
})

describe('estimateNestCutTimeMs - two sources', () => {
  it('counts instances + per-copy cut for each source; total > 0', () => {
    const n = nest({
      sources: [
        { geometryId: 'g1', quantity: 2 },
        { geometryId: 'g2', quantity: 3 },
      ],
      placements: [
        placement({ instanceId: 'i1', partId: 'g1', x: 0, y: 0 }),
        placement({ instanceId: 'i2', partId: 'g1', x: 30, y: 0 }),
        placement({ instanceId: 'i3', partId: 'g2', x: 0, y: 30 }),
        placement({ instanceId: 'i4', partId: 'g2', x: 30, y: 30 }),
        placement({ instanceId: 'i5', partId: 'g2', x: 60, y: 30 }),
      ],
    })
    const g1CutMs = (10 / 1000) * 60000 // 600
    const g2CutMs = (5 / 1000) * 60000  // 300
    const ops = [
      op({ id: 'o1', geometryId: 'g1', estimatedCutTimeMs: g1CutMs, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'o2', geometryId: 'g2', estimatedCutTimeMs: g2CutMs, toolpathMoves: cutMoves(5, 1000) }),
    ]

    const out = estimateNestCutTimeMs(n, ops, RAPID)
    // perSource = per-copy cut sum of one copy of each source's ops.
    expect(out.perSourceMs).toBeCloseTo(g1CutMs + g2CutMs, 3)
    expect(out.instanceCount).toBe(5)
    // Pure cut of all copies: g1 x2 + g2 x3; total must exceed that (travel).
    const pureCutAllCopies = g1CutMs * 2 + g2CutMs * 3
    expect(out.totalMs).toBeGreaterThan(pureCutAllCopies)
  })

  it('sums MULTIPLE seed ops bound to the same source into perSourceMs', () => {
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 2 }],
      placements: [
        placement({ instanceId: 'i1', partId: 'g1', x: 0, y: 0 }),
        placement({ instanceId: 'i2', partId: 'g1', x: 30, y: 0 }),
      ],
    })
    const aMs = (10 / 1000) * 60000 // 600
    const bMs = (2.5 / 1000) * 60000 // 150
    const ops = [
      op({ id: 'o1', geometryId: 'g1', estimatedCutTimeMs: aMs, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'o2', geometryId: 'g1', estimatedCutTimeMs: bMs, toolpathMoves: cutMoves(2.5, 1000) }),
    ]

    const out = estimateNestCutTimeMs(n, ops, RAPID)
    expect(out.perSourceMs).toBeCloseTo(aMs + bMs, 3)
    expect(out.instanceCount).toBe(2)
    expect(out.totalMs).toBeGreaterThan((aMs + bMs) * 2)
  })
})

describe('estimateNestCutTimeMs - irrelevant + uncomputed ops', () => {
  it('ignores an op whose geometryId is not a nest source', () => {
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 1 }],
      placements: [placement({ instanceId: 'i1', partId: 'g1' })],
    })
    const ops = [
      op({ id: 'o1', geometryId: 'g1', estimatedCutTimeMs: 600, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'o2', geometryId: 'gOTHER', estimatedCutTimeMs: 9999, toolpathMoves: cutMoves(999, 1000) }),
    ]

    const out = estimateNestCutTimeMs(n, ops, RAPID)
    // Only the g1 op's single copy contributes; the unbound op is ignored.
    expect(out.perSourceMs).toBeCloseTo(600, 3)
    expect(out.instanceCount).toBe(1)
    // Single copy, no inter-copy travel: total == that copy's cut time.
    expect(out.totalMs).toBeCloseTo(600, 3)
  })

  it('a seed op with no toolpathMoves contributes 0 to totalMs', () => {
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 1 }],
      placements: [placement({ instanceId: 'i1', partId: 'g1' })],
    })
    const ops = [op({ id: 'o1', geometryId: 'g1' })] // no toolpathMoves

    const out = estimateNestCutTimeMs(n, ops, RAPID)
    expect(out.perSourceMs).toBe(0)
    expect(out.totalMs).toBe(0)
    expect(out.instanceCount).toBe(1)
    expect(out.travelExcluded).toBe(false)
  })
})

describe('estimateNestCutTimeMs - feedless seed move (BK-137)', () => {
  it('surfaces a named totalMsError instead of throwing (or a misleading 0) when a seed move lacks a feed', () => {
    // A legacy/degraded seed op whose cutting move never got a baked feed.
    // estimateRuntimeMs now refuses this by name; the nest-level aggregation
    // (called from a React useMemo — PropertiesPanel.tsx) must catch it and
    // report a named error, never let the throw reach render.
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 1 }],
      placements: [placement({ instanceId: 'i1', partId: 'g1' })],
    })
    const feedlessMoves: ToolpathMove[] = [
      { type: 'feed', x: 0, y: 0, z: 1 },
      { type: 'feed', x: 10, y: 0, z: 1 },
    ]
    const ops = [op({ id: 'o1', geometryId: 'g1', toolpathMoves: feedlessMoves })]

    expect(() => estimateNestCutTimeMs(n, ops, RAPID)).not.toThrow()
    const out = estimateNestCutTimeMs(n, ops, RAPID)
    expect(out.totalMs).toBe(0)
    expect(out.totalMsError).toMatch(/finite positive feed/i)
    expect(out.instanceCount).toBe(1)
  })
})

describe('estimateNestCutTimeMs - purity', () => {
  it('does not mutate the input nest or operations', () => {
    const n = nest({
      sources: [{ geometryId: 'g1', quantity: 2 }],
      placements: [
        placement({ instanceId: 'i1', partId: 'g1', x: 0, y: 0 }),
        placement({ instanceId: 'i2', partId: 'g1', x: 30, y: 0 }),
      ],
    })
    const ops = [
      op({ id: 'o1', geometryId: 'g1', estimatedCutTimeMs: 600, toolpathMoves: cutMoves(10, 1000) }),
    ]

    const nestSnapshot = JSON.stringify(n)
    const opsSnapshot = JSON.stringify(ops)

    estimateNestCutTimeMs(n, ops, RAPID)

    expect(JSON.stringify(n)).toBe(nestSnapshot)
    expect(JSON.stringify(ops)).toBe(opsSnapshot)
  })
})
