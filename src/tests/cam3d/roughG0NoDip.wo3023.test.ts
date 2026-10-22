// WO-3023 (WO-3019 item 5): the 3D adaptive cylinder row's G0 that dipped into stock.
//
// The dip was real motion, not a replay artifact (a uniform 1.077 mm layer under the whole
// cutter at replay cells 0.5 down to 0.01 mm), and not the 3D rougher's: its published path
// rapids down a shaft its own earlier cuts had cleared. The store's tool-reach trim
// (trimToolpathToAssemblyReach) then stopped the stretch HALF-WAY DOWN that rapid, where the
// shank first meets the stock, emitted the truncated rapid and lifted - with the cuts that had
// made the shaft air trimmed away. A stretch now never stops part-way down a rapid descent.
//
// FIXTURE. A 6 mm cutter with a 5 mm flute on a 10 mm shank, no holder, over a solid block
// whose top is Z15. The planned path rapids straight down to Z8 and cuts across: below about
// Z10 the 10 mm shank would meet the block, so everything from there on is trimmed. The block
// stands for the material the trimmed cuts no longer remove.
//
// The long production row (form-cylinder adaptive_3d, ~5 min) is an evidence capture, not a
// slice test: src/tests/evidence/WO-3023/cylinder-rapids.json records it before and after,
// and the last case here checks that committed record.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from '../../lib/cam/stockState'
import { trimToolpathToAssemblyReach } from '../../lib/cam/holderClearance'

const STOCK_TOP = 15
const ALLOWANCE = 0.25

const cell = 0.25
const bounds = { minX: -20, minY: -20, minZ: 0, maxX: 20, maxY: 20, maxZ: STOCK_TOP }
const nx = Math.round((bounds.maxX - bounds.minX) / cell)
const ny = Math.round((bounds.maxY - bounds.minY) / cell)
const block = {
  schemaVersion: 1, representation: 'z-dexel', bounds, requestedResolutionMm: cell, resolutionMm: cell,
  warnings: [], nx, ny, bottomZ: 0, topZ: new Float32Array(nx * ny).fill(STOCK_TOP),
} as StockState

const SHORT_FLUTE = {
  id: 'tool-1', name: '6 mm cutter, 5 mm flute, 10 mm shank', type: 'flat_end_mill',
  diameter: 6, fluteLength: 5, shankDiameter: 10, overallLength: 60,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: '', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const PLANNED: ToolpathMove[] = [
  { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 25 },
  { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 8 },
  { type: 'feed', role: 'cut', x: 10, y: 0, z: 8, feed: 1000 },
]

/** Every rapid whose end leaves the cutter's tip below the block's top over the block. */
function rapidsIntoStock(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter(m => m.type === 'rapid'
    && m.x >= bounds.minX && m.x <= bounds.maxX && m.y >= bounds.minY && m.y <= bounds.maxY
    && m.z < STOCK_TOP - 1e-9)
}

describe('WO-3023 the reach trim never stops part-way down a rapid', () => {
  it('leaves no truncated rapid inside the stock', () => {
    const result = trimToolpathToAssemblyReach({
      moves: PLANNED, tool: SHORT_FLUTE, stock: block, allowanceMm: ALLOWANCE,
    })
    expect(result.trimmed).toBe(true)
    // The assertion the order names: no rapid enters standing stock.
    expect(rapidsIntoStock(result.moves), JSON.stringify(result.moves)).toEqual([])
    // Nothing below the reach was cut, and the stop is still reported.
    for (const m of result.moves) expect(m.z).toBeGreaterThanOrEqual(STOCK_TOP)
    expect(result.stops.length).toBeGreaterThan(0)
  })

  it('keeps a rapid descent that the trim does not stop', () => {
    const shallow: ToolpathMove[] = [
      { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 25 },
      { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 16 },
      { type: 'feed', role: 'cut', x: 10, y: 0, z: 16, feed: 1000 },
    ]
    const result = trimToolpathToAssemblyReach({
      moves: shallow, tool: SHORT_FLUTE, stock: block, allowanceMm: ALLOWANCE,
    })
    expect(result.moves).toBe(shallow)
  })

  it('the committed cylinder-row capture has no rapid into stock after the fix', () => {
    const record = JSON.parse(readFileSync('src/tests/evidence/WO-3023/cylinder-rapids.json', 'utf8')) as {
      row: string; before: { rapidsIntoStock: number; worstMm: number }; after: { rapidsIntoStock: number; worstMm: number }
    }
    expect(record.row).toBe('form-cylinder-default')
    expect(record.before.rapidsIntoStock).toBeGreaterThan(0)
    expect(record.after.rapidsIntoStock).toBe(0)
    expect(record.after.worstMm).toBeLessThanOrEqual(1e-3)
  })
})
