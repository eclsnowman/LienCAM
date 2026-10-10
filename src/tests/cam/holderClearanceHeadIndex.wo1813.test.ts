// WO-1813: the indexed cutting-head query must be exactly equivalent to the
// original band scan. These tests keep that scan here as an independent oracle
// and drive the optimized behavior only through trimToolpathToAssemblyReach.

import { describe, expect, it } from 'vitest'

import type { Tool, ToolpathMove } from '../../types'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import {
  trimToolpathToAssemblyReach,
  type SolidColumns,
} from '../../lib/cam/holderClearance'

interface Band {
  bottom: number
  top: number
  radius: number
}

const CELL = 0.01
const GOUGE_TOLERANCE = 0.05
const SLACK = CELL * Math.SQRT1_2

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'wo1813-tool', name: 'WO-1813 tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 5, shankDiameter: 6, overallLength: 5,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 1, stepover: 1 },
    },
    ...overrides,
  } as unknown as Tool
}

const TOOLS: readonly Tool[] = [
  tool({ name: 'flat', type: 'flat_end_mill' }),
  tool({ name: 'ball', type: 'ball_end_mill' }),
  tool({ name: 'bull', type: 'bull_nose', cornerRadius: 0.75 }),
  // WO-1975: a cone split into tolerance-high bands.
  tool({ name: 'v-bit', type: 'v_bit', angleFromAxisDeg: 30, tipDiameter: 0.3 }),
  tool({ name: 'lollipop', type: 'lollipop_mill', neckDiameter: 3, shoulderLength: 2 }),
  tool({ name: 'dovetail', type: 'dovetail_mill', angleFromAxisDeg: 60, neckDiameter: 3 }),
  tool({
    name: 'thread', type: 'thread_mill', threadPitch: 1, threadTeethCount: 4,
    threadFormAngleDeg: 60,
  }),
]

/** The head's bands as WO-1975 defines them: each sloped segment split into
 *  equal pieces no taller than the gouge tolerance, every piece as wide as its
 *  wider end. Vertical segments stay one band. */
function splitBands(t: Tool, tolerance: number, slack: number): Band[] {
  const profile = buildToolProfile(t)
  const bands: Band[] = []
  for (let i = 0; i < profile.vertices.length - 1; i++) {
    const a = profile.vertices[i]
    const b = profile.vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const top = Math.min(b.z, profile.cuttingMaxZ)
    const pieces = a.r === b.r ? 1 : Math.max(1, Math.ceil((top - a.z) / tolerance - 1e-9))
    if (pieces === 1) {
      const radius = Math.max(a.r, b.r) - tolerance + slack
      if (radius > 0) bands.push({ bottom: a.z, top, radius })
      continue
    }
    const radiusAt = (z: number) => a.r + (b.r - a.r) * ((z - a.z) / (b.z - a.z))
    for (let p = 0; p < pieces; p++) {
      const z0 = p === 0 ? a.z : a.z + (top - a.z) * (p / pieces)
      const z1 = p === pieces - 1 ? top : a.z + (top - a.z) * ((p + 1) / pieces)
      const radius = Math.max(radiusAt(z0), radiusAt(z1)) - tolerance + slack
      if (radius > 0) bands.push({ bottom: z0, top: z1, radius })
    }
  }
  return bands
}

function referenceBands(t: Tool): Band[] {
  return splitBands(t, GOUGE_TOLERANCE, SLACK)
}

function oneColumn(spans: readonly number[]): SolidColumns {
  return {
    originX: -CELL / 2,
    originY: -CELL / 2,
    cell: CELL,
    nx: 1,
    ny: 1,
    spanStart: Uint32Array.from([0, spans.length]),
    spanZ: Float64Array.from(spans),
  }
}

/** The pre-WO-1813 loop over every band, with the same arithmetic and comparisons
 *  (bands as WO-1975 splits them). */
function referencePartHits(
  t: Tool,
  part: SolidColumns,
  x: number,
  y: number,
  z = 0,
  lift = 0,
): boolean {
  const tolerance = Math.max(GOUGE_TOLERANCE, 2 * part.cell * Math.SQRT1_2)
  const slack = part.cell * Math.SQRT1_2
  const bands = splitBands(t, tolerance, slack)
  const maxRadius = bands.reduce((widest, band) => Math.max(widest, band.radius), 0)
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = part
  const i0 = Math.max(0, Math.ceil((x - maxRadius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + maxRadius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - maxRadius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + maxRadius - originY) / cell - 0.5))
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      const dx = originX + (i + 0.5) * cell - x
      const d = Math.hypot(dx, dy)
      if (d > maxRadius) continue
      for (const band of bands) {
        if (band.radius <= d) continue
        const bottom = z + band.bottom + tolerance
        const top = z + lift + band.top
        for (let k = spanStart[column]; k < end; k += 2) {
          if (spanZ[k] < top && spanZ[k + 1] > bottom) return true
        }
      }
    }
  }
  return false
}

function referenceHits(t: Tool, spans: readonly number[], distance: number, z = 0, lift = 0): boolean {
  return referencePartHits(t, oneColumn(spans), distance, 0, z, lift)
}

function optimizedPointHits(t: Tool, spans: readonly number[], distance: number, z = 0): boolean {
  const move: ToolpathMove = { type: 'feed', role: 'cut', x: distance, y: 0, z }
  const moves = [move]
  const result = trimToolpathToAssemblyReach({
    moves, tool: t, part: oneColumn(spans), allowanceMm: 0,
  })
  if (!result.trimmed) {
    expect(result.moves).toBe(moves)
    return false
  }
  expect(result.moves).toHaveLength(0)
  expect(result.stops).toHaveLength(1)
  expect(result.stops[0].blocker).toEqual({ component: 'cutter', obstacle: 'part' })
  return true
}

const bits = new DataView(new ArrayBuffer(8))

function nextUp(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value
  if (Object.is(value, -0)) value = 0
  bits.setFloat64(0, value)
  let encoded = bits.getBigUint64(0)
  encoded = value >= 0 ? encoded + 1n : encoded - 1n
  bits.setBigUint64(0, encoded)
  return bits.getFloat64(0)
}

function nextDown(value: number): number {
  if (value === Number.NEGATIVE_INFINITY) return value
  if (Object.is(value, 0)) return -Number.MIN_VALUE
  bits.setFloat64(0, value)
  let encoded = bits.getBigUint64(0)
  encoded = value > 0 ? encoded - 1n : encoded + 1n
  bits.setBigUint64(0, encoded)
  return bits.getFloat64(0)
}

describe('WO-1813 indexed cutting-head clearance', () => {
  it('matches the old scan at every radial and axial boundary for monotone and undercut profiles', () => {
    let comparisons = 0
    for (const t of TOOLS) {
      const bands = referenceBands(t)
      for (const band of bands) {
        const bottom = band.bottom + GOUGE_TOLERANCE
        const top = band.top
        const spanCases = [
          [bottom - 0.001, bottom],
          [bottom - 0.001, nextUp(bottom)],
          [nextDown(top), top + 0.001],
          [top, top + 0.001],
          [bottom - 0.001, top + 0.001],
        ]
        for (const distance of [nextDown(band.radius), band.radius, nextUp(band.radius)]) {
          for (const spans of spanCases) {
            const expected = referenceHits(t, spans, distance)
            expect(optimizedPointHits(t, spans, distance, 0),
              `${t.name}: radius=${distance}, spans=${spans.join(',')}`).toBe(expected)
            comparisons++
          }
        }
      }
    }
    expect(comparisons).toBeGreaterThan(1_000)
  })

  it('matches empty columns and multiple disjoint Z spans without unioning axial gaps', () => {
    const ball = TOOLS.find((t) => t.name === 'ball')!
    const bands = referenceBands(ball)
    const radius = nextDown(bands[Math.floor(bands.length / 2)].radius)
    const spans = [
      -2, -1,
      bands[2].top, bands[4].bottom + GOUGE_TOLERANCE,
      bands[10].bottom + GOUGE_TOLERANCE + 1e-6, bands[10].top + 1e-6,
      20, 21,
    ]
    expect(optimizedPointHits(ball, [], radius)).toBe(referenceHits(ball, [], radius))
    expect(optimizedPointHits(ball, spans, radius)).toBe(referenceHits(ball, spans, radius))
  })

  it('uses the same positive-lift verdict when deciding whether a clear run can retract', () => {
    const flat = TOOLS[0]
    const cell = 0.25
    const originX = -20
    const nx = 160
    const spanStart = new Uint32Array(nx + 1)
    const spanZ: number[] = []
    for (let i = 0; i < nx; i++) {
      spanStart[i] = spanZ.length
      const center = originX + (i + 0.5) * cell
      if (center < -2) spanZ.push(6, 7)
      else if (center <= 2) spanZ.push(0.1, 1)
    }
    spanStart[nx] = spanZ.length
    const part: SolidColumns = {
      originX, originY: -cell / 2, cell, nx, ny: 1,
      spanStart, spanZ: Float64Array.from(spanZ),
    }
    expect(referencePartHits(flat, part, -10, 0, 0, 0)).toBe(false)
    expect(referencePartHits(flat, part, -10, 0, 0, 10)).toBe(true)

    const result = trimToolpathToAssemblyReach({
      moves: [
        { type: 'feed', role: 'cut', x: -10, y: 0, z: 0, feed: 1000 },
        { type: 'feed', role: 'cut', x: 0, y: 0, z: 0, feed: 1000 },
        { type: 'feed', role: 'cut', x: 10, y: 0, z: 10, feed: 1000 },
      ],
      tool: flat, part, allowanceMm: 0,
    })
    expect(result.trimmed).toBe(true)
    expect(result.moves.length).toBeGreaterThan(0)
    expect(result.moves.every((move) => move.x > 0)).toBe(true)
    expect(result.warnings.join('\n')).toMatch(/could not lift out.*part/)
  })

  it('preserves the old bisection boundary through the public trim result', () => {
    const flat = TOOLS[0]
    const nx = 81
    const spanStart = new Uint32Array(nx + 1)
    const spanZ: number[] = []
    for (let i = 0; i < nx; i++) {
      spanStart[i] = spanZ.length
      const center = -10 + (i + 0.5) * 0.25
      if (center >= 0) spanZ.push(0.1, 1)
    }
    spanStart[nx] = spanZ.length
    const part: SolidColumns = {
      originX: -10, originY: -0.125, cell: 0.25, nx, ny: 1,
      spanStart, spanZ: Float64Array.from(spanZ),
    }
    const moves: ToolpathMove[] = [
      { type: 'feed', role: 'cut', x: -8, y: 0, z: 0, feed: 1000 },
      { type: 'feed', role: 'cut', x: 8, y: 0, z: 0, feed: 1000 },
    ]
    const result = trimToolpathToAssemblyReach({ moves, tool: flat, part, allowanceMm: 0 })
    expect(result.trimmed).toBe(true)
    expect(result.stops).toHaveLength(1)
    expect(result.stops[0].blocker).toEqual({ component: 'cutter', obstacle: 'part' })
    let clearT = 0
    let blockedT = 1
    const steps = 64
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      const x = -8 + 16 * t
      if (referencePartHits(flat, part, x, 0)) {
        blockedT = t
        clearT = (step - 1) / steps
        break
      }
    }
    for (let i = 0; i < 14; i++) {
      const mid = (clearT + blockedT) / 2
      if (referencePartHits(flat, part, -8 + 16 * mid, 0)) blockedT = mid
      else clearT = mid
    }
    expect(result.stops[0].stoppedAt?.x).toBe(-8 + 16 * clearT)
    expect(result.stops[0].resumedAt).toBeUndefined()
  })
})
