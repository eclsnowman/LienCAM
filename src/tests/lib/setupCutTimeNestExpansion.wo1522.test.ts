/* WO-1522 (BUG-428): the setup header badge (DesignTree.tsx SetupNode) must
 * show a nest seed op's contribution as the nest's own EXPANDED multi-copy
 * total (estimateNestCutTimeMs — the same function the nest's own Properties
 * summary already uses), not the raw per-copy estimatedCutTimeMs summed
 * directly like a standalone operation. Before the fix, setupEnabledCutTimeMs
 * ignored a second (context) argument entirely and always naive-summed, so a
 * setup whose only operations were a nest's seed ops showed ONE copy's cut
 * time instead of the whole placed nest's.
 *
 * Gates:
 *   - Nest-only setup: setup total === the nest's own expanded total.
 *   - Standalone + nest mix: standalone-time + expanded-nest-time, once each.
 *   - Two nests: each counted once, no cross-nest double counting.
 *   - No nests: byte-identical to the pre-fix naive sum (regression guard).
 */

import { describe, it, expect } from 'vitest'
import { setupEnabledCutTimeMs } from '../../lib/cam/operationSuppression'
import { estimateNestCutTimeMs } from '../../lib/cam/nesting/nestRuntime'
import type { ImportedGeometry, NestRecord, Operation, ToolpathMove } from '../../types'
import type { Placement } from '../../lib/cam/nesting/types'

const RAPID = 5000 // mm/min, machine rapid rate

function placement(
  partial: Partial<Placement> & Pick<Placement, 'instanceId' | 'partId'>,
): Placement {
  return { x: 0, y: 0, rotationDeg: 0, depth: 0, ...partial }
}

/** Minimal seed-local cut toolpath with a baked feed (len mm at feed mm/min). */
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

function nest(partial: Partial<NestRecord> & Pick<NestRecord, 'id'>): NestRecord {
  return {
    name: 'Nest',
    sheet: { width: 300, height: 300 },
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

function ownedSeedGeo(id: string, nestId: string): Pick<ImportedGeometry, 'id' | 'ownerNestId'> {
  return { id, ownerNestId: nestId }
}

/** 8 placements spread across a grid so real inter-copy travel exists. */
function gridPlacements(partId: string, cols: number, rows: number, spacing: number): Placement[] {
  const out: Placement[] = []
  let i = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      i += 1
      out.push(placement({ instanceId: `i${i}`, partId, x: c * spacing, y: r * spacing }))
    }
  }
  return out
}

describe('setupEnabledCutTimeMs — nest-owned seed ops (WO-1522 / BUG-428)', () => {
  it('a setup whose only operations are one nest\'s seed ops equals the nest\'s own expanded total', () => {
    const n = nest({
      id: 'nestA',
      sources: [{ geometryId: 'gSeed1', quantity: 8 }],
      placements: gridPlacements('gSeed1', 4, 2, 40),
    })
    const op1Ms = (10 / 1000) * 60000 // 600ms per copy
    const op2Ms = (5 / 1000) * 60000  // 300ms per copy
    const ops = [
      op({ id: 'o1', geometryId: 'gSeed1', estimatedCutTimeMs: op1Ms, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'o2', geometryId: 'gSeed1', estimatedCutTimeMs: op2Ms, toolpathMoves: cutMoves(5, 1000) }),
    ]
    const geometry = [ownedSeedGeo('gSeed1', 'nestA')]

    const setupCutMs = setupEnabledCutTimeMs(ops, { geometry, nests: [n], rapidRate: RAPID })
    const nestTotal = estimateNestCutTimeMs(n, ops, RAPID).totalMs

    expect(setupCutMs).toBe(nestTotal)
    // Proves the fix actually expands: the pre-fix naive per-copy sum would be
    // far smaller (one copy vs. 8 placed copies + inter-copy travel).
    const naiveSum = op1Ms + op2Ms
    expect(setupCutMs).toBeGreaterThan(naiveSum * 8)
  })

  it('a standalone ready op plus one nest\'s seed ops sums standalone-time + expanded-nest-time once each', () => {
    const n = nest({
      id: 'nestB',
      sources: [{ geometryId: 'gSeed2', quantity: 3 }],
      placements: gridPlacements('gSeed2', 3, 1, 50),
    })
    const standaloneMs = 12_000
    const seedMs = (8 / 1000) * 60000 // 480ms per copy
    const ops = [
      op({ id: 'standalone', geometryId: 'gStandalone', estimatedCutTimeMs: standaloneMs }),
      op({ id: 'seed', geometryId: 'gSeed2', estimatedCutTimeMs: seedMs, toolpathMoves: cutMoves(8, 1000) }),
    ]
    const geometry = [ownedSeedGeo('gSeed2', 'nestB')]

    const setupCutMs = setupEnabledCutTimeMs(ops, { geometry, nests: [n], rapidRate: RAPID })
    const nestTotal = estimateNestCutTimeMs(n, ops, RAPID).totalMs

    expect(setupCutMs).toBe(standaloneMs + nestTotal)
  })

  it('a setup with two separate nests counts each nest once (no cross-nest double counting)', () => {
    const nA = nest({
      id: 'nestA',
      sources: [{ geometryId: 'gA', quantity: 2 }],
      placements: [
        placement({ instanceId: 'a1', partId: 'gA', x: 0, y: 0 }),
        placement({ instanceId: 'a2', partId: 'gA', x: 30, y: 0 }),
      ],
    })
    const nB = nest({
      id: 'nestB',
      sources: [{ geometryId: 'gB', quantity: 3 }],
      placements: [
        placement({ instanceId: 'b1', partId: 'gB', x: 0, y: 0 }),
        placement({ instanceId: 'b2', partId: 'gB', x: 30, y: 0 }),
        placement({ instanceId: 'b3', partId: 'gB', x: 60, y: 0 }),
      ],
    })
    const aMs = 600
    const bMs = 300
    const ops = [
      // Two seed ops bound to the SAME nestA source: nestA must count once,
      // not twice, even though two of its ops appear in the setup.
      op({ id: 'a1', geometryId: 'gA', estimatedCutTimeMs: aMs, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'a2', geometryId: 'gA', estimatedCutTimeMs: aMs, toolpathMoves: cutMoves(10, 1000) }),
      op({ id: 'b1', geometryId: 'gB', estimatedCutTimeMs: bMs, toolpathMoves: cutMoves(5, 1000) }),
    ]
    const geometry = [ownedSeedGeo('gA', 'nestA'), ownedSeedGeo('gB', 'nestB')]

    const setupCutMs = setupEnabledCutTimeMs(ops, { geometry, nests: [nA, nB], rapidRate: RAPID })
    const nestATotal = estimateNestCutTimeMs(nA, ops, RAPID).totalMs
    const nestBTotal = estimateNestCutTimeMs(nB, ops, RAPID).totalMs

    expect(setupCutMs).toBe(nestATotal + nestBTotal)
  })

  it('a suppressed seed op contributes nothing to the nest expansion (audit regression: line 70 passed the full unfiltered operations list, so a suppressed seed op was still timed across every placed copy)', () => {
    const n = nest({
      id: 'nestC',
      sources: [{ geometryId: 'gSeed3', quantity: 4 }],
      placements: gridPlacements('gSeed3', 4, 1, 40),
    })
    const enabledOp = op({
      id: 'enabled', geometryId: 'gSeed3', enabled: true, status: 'ready',
      estimatedCutTimeMs: 600, toolpathMoves: cutMoves(10, 1000),
    })
    const suppressedOp = op({
      id: 'suppressed', geometryId: 'gSeed3', enabled: false, status: 'ready',
      estimatedCutTimeMs: 12_000, toolpathMoves: cutMoves(200, 1000),
    })
    const ops = [enabledOp, suppressedOp]
    const geometry = [ownedSeedGeo('gSeed3', 'nestC')]

    const setupCutMs = setupEnabledCutTimeMs(ops, { geometry, nests: [n], rapidRate: RAPID })
    // The nest's honest total counting only the ops actually in the program
    // (enabled) -- the suppressed op's toolpath must not appear in the stream.
    const expected = estimateNestCutTimeMs(n, [enabledOp], RAPID).totalMs
    expect(setupCutMs).toBe(expected)

    // Demonstrates the regression directly: passing the FULL unfiltered ops
    // list (what line 70 did before this fix) times the suppressed op's 200mm
    // toolpath too, producing a much larger, wrong total.
    const unfilteredTotal = estimateNestCutTimeMs(n, ops, RAPID).totalMs
    expect(setupCutMs).toBeLessThan(unfilteredTotal)
  })

  it('an outdated seed op that is still enabled is included in the nest expansion, matching buildPostInput.ts (which filters only by enabled, not status, before collectToolpathSections)', () => {
    const n = nest({
      id: 'nestD',
      sources: [{ geometryId: 'gSeed4', quantity: 4 }],
      placements: gridPlacements('gSeed4', 4, 1, 40),
    })
    const readyOp = op({
      id: 'ready', geometryId: 'gSeed4', enabled: true, status: 'ready',
      estimatedCutTimeMs: 600, toolpathMoves: cutMoves(10, 1000),
    })
    const outdatedOp = op({
      id: 'outdated', geometryId: 'gSeed4', enabled: true, status: 'outdated',
      estimatedCutTimeMs: 300, toolpathMoves: cutMoves(6, 1000),
    })
    const ops = [readyOp, outdatedOp]
    const geometry = [ownedSeedGeo('gSeed4', 'nestD')]

    const setupCutMs = setupEnabledCutTimeMs(ops, { geometry, nests: [n], rapidRate: RAPID })
    const expected = estimateNestCutTimeMs(n, ops, RAPID).totalMs
    expect(setupCutMs).toBe(expected)
  })

  it('a setup with no nests is byte-identical to the naive direct sum (no regression)', () => {
    const ops = [
      op({ id: 'ready', estimatedCutTimeMs: 2_000 }),
      op({ id: 'suppressed', enabled: false, estimatedCutTimeMs: 9_000 }),
      op({ id: 'not-ready', status: 'computing', estimatedCutTimeMs: 5_000 }),
    ]
    const naiveSum = 2_000

    expect(setupEnabledCutTimeMs(ops)).toBe(naiveSum)
    expect(setupEnabledCutTimeMs(ops, { geometry: [], nests: [], rapidRate: RAPID })).toBe(naiveSum)
  })
})
