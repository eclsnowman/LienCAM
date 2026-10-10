// WO-1975: the tool-reach check models the cutting head by its real profile. A
// V-bit's cone is a cone, not a full-radius cylinder from the tip, so a V-bit
// sitting on a slope its cone clears keeps its path; a cone that truly enters
// the part is still trimmed; and ball / bull / flat heads only ever trim LESS
// than the old one-band-per-segment model (checked against that model, kept
// here as an independent oracle), never more.

import { describe, expect, it } from 'vitest'

import type { Tool, ToolpathMove } from '../../types'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import {
  trimToolpathToAssemblyReach,
  type SolidColumns,
} from '../../lib/cam/holderClearance'

const GOUGE_TOLERANCE = 0.05

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'wo1975-tool', name: 'WO-1975 tool', type: 'flat_end_mill',
    diameter: 6.35, fluteLength: 12, shankDiameter: 6.35, overallLength: 12,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 1, stepover: 1 },
    },
    ...overrides,
  } as unknown as Tool
}

// WO-1971's V-bit: 60 deg included (30 deg from the axis), 0.3 mm tip flat.
const VBIT = tool({ name: 'v-bit', type: 'v_bit', angleFromAxisDeg: 30, tipDiameter: 0.3 })
const TIP_R = 0.15

/** A height field z = f(x, y) as one solid span per column, from -30 up to f at
 *  the column centre. */
function heightField(
  f: (x: number, y: number) => number,
  minX: number, minY: number, maxX: number, maxY: number, cell: number,
): SolidColumns {
  const nx = Math.round((maxX - minX) / cell)
  const ny = Math.round((maxY - minY) / cell)
  const spanStart = new Uint32Array(nx * ny + 1)
  const spanZ = new Float64Array(nx * ny * 2)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const column = j * nx + i
      spanStart[column] = column * 2
      spanZ[column * 2] = -30
      spanZ[column * 2 + 1] = f(minX + (i + 0.5) * cell, minY + (j + 0.5) * cell)
    }
  }
  spanStart[nx * ny] = nx * ny * 2
  return { originX: minX, originY: minY, cell, nx, ny, spanStart, spanZ }
}

function feed(x: number, y: number, z: number): ToolpathMove {
  return { type: 'feed', role: 'cut', x, y, z, feed: 1000 }
}

/** The production verdict for the cutter standing at one point. */
function productionHits(t: Tool, part: SolidColumns, x: number, y: number, z: number): boolean {
  const moves = [feed(x, y, z)]
  const result = trimToolpathToAssemblyReach({ moves, tool: t, part, allowanceMm: 0 })
  if (!result.trimmed) return false
  expect(result.stops[0].blocker, `${t.name} at ${x},${y},${z}`)
    .toEqual({ component: 'cutter', obstacle: 'part' })
  return true
}

/** The pre-WO-1975 head model: one band per profile segment, as wide as the
 *  segment's widest end, from the segment's bottom. A plain scan. */
function oldModelHits(t: Tool, part: SolidColumns, x: number, y: number, z: number): boolean {
  const tolerance = Math.max(GOUGE_TOLERANCE, 2 * part.cell * Math.SQRT1_2)
  const slack = part.cell * Math.SQRT1_2
  const profile = buildToolProfile(t)
  const bands: { bottom: number, top: number, radius: number }[] = []
  for (let i = 0; i < profile.vertices.length - 1; i++) {
    const a = profile.vertices[i]
    const b = profile.vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const radius = Math.max(a.r, b.r) - tolerance + slack
    if (radius > 0) bands.push({ bottom: a.z, top: Math.min(b.z, profile.cuttingMaxZ), radius })
  }
  const reach = bands.reduce((widest, band) => Math.max(widest, band.radius), 0)
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = part
  const i0 = Math.max(0, Math.floor((x - reach - originX) / cell) - 1)
  const i1 = Math.min(nx - 1, Math.ceil((x + reach - originX) / cell) + 1)
  const j0 = Math.max(0, Math.floor((y - reach - originY) / cell) - 1)
  const j1 = Math.min(ny - 1, Math.ceil((y + reach - originY) / cell) + 1)
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const d = Math.hypot(originX + (i + 0.5) * cell - x, dy)
      for (const band of bands) {
        if (band.radius <= d) continue
        for (let k = spanStart[column]; k < spanStart[column + 1]; k += 2) {
          if (spanZ[k] < z + band.top && spanZ[k + 1] > z + band.bottom + tolerance) return true
        }
      }
    }
  }
  return false
}

describe('WO-1975: the reach check sees a V-bit as a cone', () => {
  // A 45 deg slope rising in +X. The V-bit's flank stands at 60 deg from the
  // horizontal, so dropped onto it the tip flat's uphill edge is the contact and
  // the cone clears the slope everywhere else.
  const slope45 = heightField((x) => x, -8, -4, 8, 4, 0.05)
  const onSlope = (x: number) => x + TIP_R

  it('keeps a V-bit dropped exactly on a 45 deg slope (the old band model trimmed it)', () => {
    const moves: ToolpathMove[] = []
    for (let x = -3; x <= 3 + 1e-9; x += 0.5) moves.push(feed(x, 0.013, onSlope(x)))
    const result = trimToolpathToAssemblyReach({ moves, tool: VBIT, part: slope45, allowanceMm: 0.5 })
    expect(result.stops).toEqual([])
    expect(result.trimmed).toBe(false)
    expect(result.moves).toBe(moves)

    // The record: the one-band cone - a 6.35 mm cylinder from the tip - gouges
    // this slope at every one of those positions.
    for (const move of moves) {
      expect(oldModelHits(VBIT, slope45, move.x, move.y, move.z)).toBe(true)
    }
  })

  it('still trims a V-bit that is really pushed into the slope', () => {
    // 0.2 mm below the drop height: the tip flat and the cone both enter.
    expect(productionHits(VBIT, slope45, 0.3, 0.013, onSlope(0.3) - 0.2)).toBe(true)
  })

  it('still trims a V-bit whose cone enters a slope steeper than the cone (negative control)', () => {
    // 70 deg is steeper than the 60 deg flank: with the tip flat's edge on the
    // wall, the cone runs into it - about 1 mm deep at 1 mm out from the tip.
    const tan70 = Math.tan((70 * Math.PI) / 180)
    const wall = heightField((x) => Math.min(tan70 * x, 12), -8, -4, 8, 4, 0.05)
    const x0 = -0.4
    const z0 = tan70 * (x0 + TIP_R)
    expect(productionHits(VBIT, wall, x0, 0.013, z0)).toBe(true)

    const moves = [feed(-4, 0.013, tan70 * (-4 + TIP_R)), feed(x0, 0.013, z0)]
    const result = trimToolpathToAssemblyReach({ moves, tool: VBIT, part: wall, allowanceMm: 0.5 })
    expect(result.trimmed).toBe(true)
    expect(result.stops[0].blocker).toEqual({ component: 'cutter', obstacle: 'part' })
  })

  it('ball, bull and flat heads trim no position the old model kept', () => {
    const wave = heightField((x, y) => 2 * Math.sin(x / 3) * Math.cos(y / 4), -10, -10, 10, 10, 0.1)
    const heads = [
      tool({ name: 'flat', type: 'flat_end_mill' }),
      tool({ name: 'ball', type: 'ball_end_mill' }),
      tool({ name: 'bull', type: 'bull_nose', cornerRadius: 1 }),
      VBIT,
    ]
    const released: Record<string, number> = {}
    for (const head of heads) {
      let newlyTrimmed = 0
      let freed = 0
      let total = 0
      for (let x = -5.3; x <= 5; x += 0.9) {
        for (let y = -4.7; y <= 5; y += 1.1) {
          const surface = 2 * Math.sin(x / 3) * Math.cos(y / 4)
          for (const dz of [-0.4, -0.1, 0, 0.1, 0.3, 0.6, 1, 1.5]) {
            const z = surface + dz
            const now = productionHits(head, wave, x, y, z)
            const before = oldModelHits(head, wave, x, y, z)
            if (now && !before) newlyTrimmed++
            if (before && !now) freed++
            total++
          }
        }
      }
      expect(newlyTrimmed, `${head.name}: positions trimmed now that the old model kept`).toBe(0)
      released[head.name] = freed
      expect(total).toBeGreaterThan(500)
    }
    // A flat head has no sloped segment: its bands are unchanged.
    expect(released.flat).toBe(0)
    // The V-bit is where the old model was worst.
    expect(released['v-bit']).toBeGreaterThan(0)
    console.log(`WO-1975 positions released by the profile-following head: ${JSON.stringify(released)}`)
  })
})
