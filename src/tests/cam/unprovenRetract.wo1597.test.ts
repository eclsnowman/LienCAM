// WO-1597: a retract that cannot be proven clear does not happen.
//
// The trim backs out of a stretch of cut along its own path to a point where the
// whole lift column up to the link height is proven clear. When no point of the
// stretch could lift, the old code lifted from the stretch's start anyway - a
// rapid straight up a column nobody judged. Now the tool leaves up the column its
// own plunge into the stretch was proven down, or, when there is no such column,
// the stretch is left uncut and the console says why.
//
// FIXTURE. A 12 mm cutter on a 6 mm shank, no holder, working 5 mm off the table
// under an overhanging clamp nose. The nose's edge is 4.5 mm to the side of the
// path and 15 mm up: the shank slides under it, the 5 mm tall head clears it
// where it cuts, but the 12 mm head cannot come straight up past it. A post
// stands across the path so the stretch under the nose is not the last one.
// Every check below is measured from plain box geometry in this file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from '../../lib/cam/stockState'
import {
  buildSolidColumns, trimToolpathToAssemblyReach, type ClearanceMesh,
} from '../../lib/cam/holderClearance'
import { trimToolpathToToolReach } from '../../lib/cam/holderClearanceGate'

/** [minX, minY, minZ, maxX, maxY, maxZ] */
type Box = readonly [number, number, number, number, number, number]

const NOSE: Box = [-45, 4.5, 15, 5, 25, 20]
const POST: Box = [10, -10, 0, 12, 10, 20]
const CUT_Z = 5
const ALLOWANCE = 0.25
const HEAD_RADIUS = 6
const HEAD_HEIGHT = 5

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool-1', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: '', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const WIDE_HEAD = tool({
  name: '12 mm cutter on a 6 mm shank', diameter: 12, fluteLength: HEAD_HEIGHT, shankDiameter: 6,
})

const UNDER_THE_NOSE: ToolpathMove[] = [
  { type: 'rapid', role: 'rapid', x: -30, y: 0, z: CUT_Z },
  { type: 'feed', role: 'cut', x: 30, y: 0, z: CUT_Z, feed: 1000 },
]

/**
 * Every straight rise in the emitted program, as the head sweeps it: a cylinder of
 * the head's radius from its tip at the lower z to its top at the higher one.
 * Returns the smallest gap between that swept head and any box it overlaps in Z.
 */
function smallestRiseGap(moves: readonly ToolpathMove[], boxes: readonly Box[]): number {
  let gap = Number.POSITIVE_INFINITY
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (a.x !== b.x || a.y !== b.y || !(b.z > a.z)) continue
    for (const box of boxes) {
      const [, , z0, , , z1] = box
      if (a.z > z1 || b.z + HEAD_HEIGHT < z0) continue
      gap = Math.min(gap, xyDistanceToBox(b.x, b.y, box) - HEAD_RADIUS)
    }
  }
  return gap
}

let info: ReturnType<typeof vi.spyOn>
beforeEach(() => { info = vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { info.mockRestore() })

describe('WO-1597 a stretch of cut that nothing along could lift out of', () => {
  const workholding = [buildSolidColumns(meshOf([NOSE, POST]))!]

  it('is left uncut rather than retracted up a column nobody proved', () => {
    const result = trimToolpathToAssemblyReach({
      moves: UNDER_THE_NOSE, tool: WIDE_HEAD, workholding, allowanceMm: ALLOWANCE,
    })
    expect(result.trimmed).toBe(true)
    // Nothing under the nose was cut: every emitted position is past the post.
    expect(result.moves.length).toBeGreaterThan(0)
    for (const move of result.moves) expect(move.x).toBeGreaterThan(POST[3])
    // No straight rise sweeps the head through the nose or the post.
    expect(smallestRiseGap(result.moves, [NOSE, POST])).toBeGreaterThanOrEqual(ALLOWANCE)
    // The stretch is part of the stop's uncut length: from the path's start to the resume.
    expect(result.stops).toHaveLength(1)
    const stop = result.stops[0]
    expect(stop.stoppedAt).toBeUndefined()
    expect(stop.resumedAt!.x).toBeGreaterThan(POST[3] + HEAD_RADIUS)
    expect(stop.uncutMm).toBeCloseTo(stop.resumedAt!.x - UNDER_THE_NOSE[0].x, 1)
  })

  it('says what was left uncut and why, on the console, in plain words', () => {
    const result = trimToolpathToAssemblyReach({
      moves: UNDER_THE_NOSE, tool: WIDE_HEAD, workholding, allowanceMm: ALLOWANCE,
    })
    const said = result.warnings.join('\n')
    expect(said).toMatch(/mm of cutting path from X -30\.00 Y 0\.00 was left uncut: the tool could not lift out from anywhere along it without crossing the workholding\./)
    const logged = info.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toMatch(/\[workholding-clearance\] .*was left uncut.*WO-1597/)
  })

  it('reaches the operator console through the gate beside the stop, and does not refuse the job', () => {
    const gated = trimToolpathToToolReach({
      operation: 'Contour', moves: UNDER_THE_NOSE, tool: WIDE_HEAD,
      workholding: [meshOf([NOSE, POST])], clearanceAllowanceMm: ALLOWANCE,
    })
    expect(gated.moves.length).toBeGreaterThan(0)
    expect(gated.notices.join('\n')).toMatch(/Contour: .*was left uncut: the tool could not lift out from anywhere along it without crossing the workholding/)
  })
})

describe('WO-1597 a stretch whose only way out is the column it came down', () => {
  // A 6 mm lollipop on a 3 mm neck in solid stock: it may plunge (its neck follows
  // its own bore) but may not lift from anywhere on the plunge, because a lift is
  // judged as a column the tool did not bore.
  const cell = 0.25
  const bounds = { minX: -40, minY: -40, minZ: 0, maxX: 40, maxY: 40, maxZ: 15 }
  const nx = Math.round((bounds.maxX - bounds.minX) / cell)
  const ny = Math.round((bounds.maxY - bounds.minY) / cell)
  const block: StockState = {
    schemaVersion: 1, representation: 'z-dexel', bounds, requestedResolutionMm: cell, resolutionMm: cell,
    warnings: [], nx, ny, bottomZ: 0, topZ: new Float32Array(nx * ny).fill(15),
  } as StockState
  const LOLLIPOP = tool({
    name: '6 mm lollipop, 40 mm neck', type: 'lollipop_mill',
    diameter: 6, fluteLength: 6, shankDiameter: 6, neckDiameter: 3, shoulderLength: 40,
  })
  const moves: ToolpathMove[] = [
    { type: 'rapid', role: 'rapid', x: 10, y: 20, z: 5 },
    { type: 'feed', role: 'cut', x: 20, y: 20, z: 5, feed: 1000 },
    { type: 'feed', role: 'plunge', x: 20, y: 20, z: 0, feed: 300 },
    { type: 'feed', role: 'cut', x: 30, y: 20, z: 0, feed: 1000 },
    { type: 'feed', role: 'cut', x: 30, y: 20, z: 60, feed: 1000 },
    { type: 'feed', role: 'cut', x: 35, y: 20, z: 60, feed: 1000 },
  ]

  it('leaves up the plunge column it was proven down, and leaves nothing uncut for want of a way out', () => {
    const result = trimToolpathToAssemblyReach({ moves, tool: LOLLIPOP, stock: block, allowanceMm: ALLOWANCE })
    expect(result.trimmed).toBe(true)
    const plunge = result.moves.findIndex((move) => move.role === 'plunge')
    expect(plunge).toBeGreaterThan(0)
    const down = result.moves[plunge]
    const cameFrom = result.moves[plunge - 1]
    expect([cameFrom.x, cameFrom.y]).toEqual([down.x, down.y])
    // The first rise after the plunge is straight up that same column, to the height it came down from.
    const rise = result.moves.findIndex((move, i) => i > plunge && move.type === 'rapid')
    expect(rise).toBeGreaterThan(plunge)
    expect([result.moves[rise].x, result.moves[rise].y, result.moves[rise].z]).toEqual([down.x, down.y, cameFrom.z])
    expect(result.warnings.join('\n')).not.toMatch(/left uncut/)
  })
})
