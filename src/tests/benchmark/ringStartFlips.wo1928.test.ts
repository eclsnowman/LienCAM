// WO-1928 -- THE STEERING COUNT DOES NOT DEPEND ON WHERE A RING STARTS.
//
// The flip counter treated a closed wall ring as an open run, so a reversal that
// fell across the ring's start/end seam was never counted and the same ring
// scored 6 or 8 depending only on where it began (WO-1879 measured it on the
// rest-pencil row). These tests move the start and require the count to stay.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ToolpathMove } from '../../types'

import { planChain } from './chainRunner'
import { pathMetrics } from './metrics'
import { CHAINS } from './registry'

const Z = -2

/** A ring with two known turn-direction reversals: a square with a notch cut
 *  into its top edge. Turn signs going round: L L L R L L L -> 2 cyclic flips. */
const RING: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [6, 10],
  [5, 7],
  [4, 10],
  [0, 10],
]

/** The ring started at vertex `start`: park there, cut round, end where it began. */
function ringFrom(start: number, closeIt = true): ToolpathMove[] {
  const [sx, sy] = RING[start]
  const moves: ToolpathMove[] = [{ type: 'rapid', role: 'rapid', x: sx, y: sy, z: Z }]
  const count = closeIt ? RING.length : RING.length - 1
  for (let step = 1; step <= count; step++) {
    const [x, y] = RING[(start + step) % RING.length]
    moves.push({ type: 'feed', role: 'cut', x, y, z: Z })
  }
  return moves
}

describe('WO-1928 a closed ring is counted the same wherever it starts', () => {
  it('gives every start vertex the same turns and flips', () => {
    for (let start = 0; start < RING.length; start++) {
      const metrics = pathMetrics(ringFrom(start))
      expect(metrics.turns, `start ${start}`).toBe(RING.length)
      expect(metrics.flips, `start ${start}`).toBe(2)
    }
  })

  it('keeps the open-run count when the last segment is removed', () => {
    // Points v0..v6, no return to v0: five turns (v1..v5), signs L L L R L, so
    // the L->R and R->L changes are 2 flips -- exactly what the counter did before.
    const metrics = pathMetrics(ringFrom(0, false))
    expect(metrics.turns).toBe(5)
    expect(metrics.flips).toBe(2)
    // Started elsewhere the open run is a different path and counts as one.
    const shifted = pathMetrics(ringFrom(4, false))
    expect(shifted.turns).toBe(5)
  })

  it('counts a seam-spanning reversal that the open-run rule missed', () => {
    // Start on the notch tip (vertex 4): the R turn is now the seam turn.
    const metrics = pathMetrics(ringFrom(4))
    expect(metrics.flips).toBe(2)
  })
})

interface Ring {
  from: number
  to: number
}

const isRingCut = (move: ToolpathMove): boolean =>
  move.role === 'cut' && (move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')

/** Maximal runs of same-z cuts (lines and arcs) that end where they began. */
function closedRings(moves: readonly ToolpathMove[]): Ring[] {
  const rings: Ring[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (!isRingCut(first)) {
      index++
      continue
    }
    let end = index
    while (
      end + 1 < moves.length &&
      isRingCut(moves[end + 1]) &&
      moves[end + 1].z === first.z
    ) {
      end++
    }
    const anchor = index > 0 ? moves[index - 1] : undefined
    const last = moves[end]
    if (
      anchor &&
      anchor.z === first.z &&
      end - index >= 3 &&
      Math.hypot(last.x - anchor.x, last.y - anchor.y) <= 1e-6
    ) {
      rings.push({ from: index, to: end })
    }
    index = end + 1
  }
  return rings
}

/** Re-start every ring at another vertex: park there, then run the ring's own
 *  moves (arcs keep their centres) round from that point and back to it. */
function rotateRings(moves: readonly ToolpathMove[], rings: readonly Ring[], pick: (n: number) => number): ToolpathMove[] {
  const out: ToolpathMove[] = []
  let cursor = 0
  for (const ring of rings) {
    out.push(...moves.slice(cursor, ring.from))
    const ringMoves = moves.slice(ring.from, ring.to + 1)
    const j = pick(ringMoves.length)
    const at = ringMoves[j]
    out.push({ type: 'rapid', role: 'rapid', x: at.x, y: at.y, z: at.z })
    out.push(...ringMoves.slice(j + 1), ...ringMoves.slice(0, j + 1))
    cursor = ring.to + 1
  }
  out.push(...moves.slice(cursor))
  return out
}

describe('WO-1928 the rest-pencil row: rotating each wall ring leaves its level unchanged', () => {
  it('holds turns, flips and the worst level when every ring starts elsewhere', { timeout: 600_000 }, async () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'engagement-pocket-rest-pencil')
    if (!chain) throw new Error('engagement-pocket-rest-pencil is missing from the benchmark registry')
    const planned = await planChain(chain)
    const rough = planned.steps.find((step) => step.stepId === 'rough-6-flat')
    if (!rough) throw new Error('rough-6-flat step missing')

    const rings = closedRings(rough.moves)
    expect(rings.length).toBeGreaterThan(0)

    const base = pathMetrics(rough.moves)
    const lines = [
      `rough-6-flat moves=${rough.moves.length} closedRings=${rings.length}`,
      `original    turns=${base.turns} flips=${base.flips} worstZFlipRatePct=${base.worstZFlipRatePct.toFixed(4)}`,
    ]
    for (const [label, pick] of [
      ['mid-ring  ', (n: number) => Math.floor(n / 2)],
      ['second    ', (n: number) => Math.min(1, n - 1)],
      ['last      ', (n: number) => n - 1],
    ] as const) {
      const rotated = pathMetrics(rotateRings(rough.moves, rings, pick))
      lines.push(`${label} turns=${rotated.turns} flips=${rotated.flips} worstZFlipRatePct=${rotated.worstZFlipRatePct.toFixed(4)}`)
      expect(rotated.turns, label).toBe(base.turns)
      expect(rotated.flips, label).toBe(base.flips)
      expect(rotated.worstZFlipRatePct, label).toBeCloseTo(base.worstZFlipRatePct, 9)
    }
    console.log(`\n[WO-1928 rest-pencil rotation]\n${lines.join('\n')}`)
    if (process.env.WRITE_EVIDENCE === '1') {
      const dir = join(process.cwd(), 'src/tests/evidence/WO-1928')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'rotation.txt'), `${lines.join('\n')}\n`, 'utf-8')
    }
  })
})
