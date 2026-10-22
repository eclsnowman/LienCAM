// WO-3048 (WO-3028 item 5, split): the tool-reach trim leaves no empty visits.
//
// form-cylinder adaptive_3d, switch ON: the strategy cuts down to Z0.83, and the store's
// tool-reach trim (trimToolpathToToolReachFor3d -> trimToolpathToAssemblyReach) stops every
// cut below the 6 mm tool's reach floor (Z16.42). It kept each deep level's retract, rapid
// over and descent, so each trimmed level became clearance -> feed plunge -> retract with
// nothing cut (16 of them at the end of the published path). With the caller's switch ON
// (the adaptive route passes WO-3028's ADAPTIVE_ENTRY_POLICY.entriesAtMaterial) such a visit
// goes whole and its neighbours join with one traverse at the top. The reach floor is the same.
//
// FIXTURE (WO-3023's): a 6 mm cutter with a 5 mm flute on a 10 mm shank, no holder, over a
// solid block whose top is Z15. Below about Z10 the shank meets the block. The planned path
// cuts one level at Z16 (reachable), then two deep levels at Z8 (trimmed), each left by a
// rapid retract, then a last reachable level at Z16.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from '../../lib/cam/stockState'
import { trimToolpathToToolReachFor3d } from '../../lib/cam/holderClearanceGate'
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs'

const STOCK_TOP = 15
const TOP = 25

const cell = 0.25
const bounds = { minX: -30, minY: -30, minZ: 0, maxX: 30, maxY: 30, maxZ: STOCK_TOP }
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

const rapid = (x: number, y: number, z: number): ToolpathMove => ({ type: 'rapid', role: 'rapid', x, y, z })
const cut = (x: number, y: number, z: number): ToolpathMove => ({ type: 'feed', role: 'cut', x, y, z, feed: 1000 })

/** A deep level the shank cannot reach: over, down, across, and a rapid retract that
 *  rises through the reach floor, crosses at Z20 and climbs back to the top. */
const deepLevel = (x0: number, x1: number): ToolpathMove[] => [
  rapid(x0, 0, TOP), rapid(x0, 0, 8), cut(x1, 0, 8),
  rapid(x1, 0, 20), rapid(x1 + 2, 2, 20), rapid(x1 + 2, 2, TOP),
]

const PLANNED: ToolpathMove[] = [
  rapid(-20, -20, TOP),
  rapid(-20, -20, 16), cut(-10, -20, 16), rapid(-10, -20, TOP),
  ...deepLevel(-15, -5),
  ...deepLevel(5, 15),
  rapid(20, 20, TOP), rapid(20, 20, 16), cut(10, 20, 16), rapid(10, 20, TOP),
]

const trim = (moves: readonly ToolpathMove[], dropEmptyVisits?: boolean) => trimToolpathToToolReachFor3d({
  operation: 'Adaptive 3D', moves, tool: SHORT_FLUTE, remainingStock: block, clearanceAllowanceMm: 0.25,
  ...(dropEmptyVisits !== undefined ? { dropEmptyVisits } : {}),
})

const isTraverse = (m: ToolpathMove) => m.type === 'rapid' || m.role === 'rapid'

/** Every visit (from a move at the path's top down and back up to the top) whose moves
 *  are all rapids or straight feed descents: it goes somewhere and cuts nothing. */
function emptyVisits(moves: readonly ToolpathMove[]): number[][] {
  const top = Math.max(...moves.map(m => m.z))
  const atTop = (m: ToolpathMove) => m.z >= top - 1e-6
  const visits: number[][] = []
  let from = moves.findIndex(atTop)
  while (from >= 0) {
    let back = from + 1
    while (back < moves.length && !atTop(moves[back])) back++
    if (back >= moves.length) break
    const inside = moves.slice(from + 1, back + 1)
    const cutsNothing = inside.every((m, k) => {
      const previous = moves[from + k]
      return isTraverse(m) || (m.x === previous.x && m.y === previous.y && m.z < previous.z)
    })
    if (back > from + 1 && cutsNothing) visits.push([from + 1, back])
    from = back
  }
  return visits
}

const cuts = (moves: readonly ToolpathMove[]) => moves.filter(m => m.role === 'cut')

describe('WO-3048 the tool-reach trim leaves no empty visits', () => {
  it('no visit without a cut after the reach trim (switch on)', () => {
    const result = trim(PLANNED, true)
    expect(result.stops.length).toBeGreaterThan(0)
    expect(emptyVisits(result.moves), JSON.stringify(result.moves)).toEqual([])
    // The reach floor is the same: every cut the trim kept is still there, in order.
    expect(cuts(result.moves)).toEqual(cuts(trim(PLANNED, false).moves))
    expect(result.moves.every(m => m.z >= 10 - 1e-6 || m.role !== 'cut')).toBe(true)
  })

  it('switch off: the trimmed moves are exactly what the trim made (the empty visits stay)', () => {
    const off = trim(PLANNED, false)
    const absent = trim(PLANNED)
    expect(off.moves).toEqual(absent.moves)
    expect(off.notices).toEqual(absent.notices)
    // The fixture really does make the defect the order names.
    expect(emptyVisits(off.moves).length).toBeGreaterThan(0)
  })

  it('switch on: the neighbours join with one traverse at the top, then the next cut', () => {
    const on = trim(PLANNED, true).moves
    const lift = on.findIndex(m => m.x === -10 && m.y === -20 && m.z === TOP)
    // Lift off the first level, one straight traverse at the top, descend into the last level.
    expect(on.slice(lift, lift + 3)).toEqual([rapid(-10, -20, TOP), rapid(20, 20, TOP), rapid(20, 20, 16)])
  })

  it('switch on, nothing stopped: the moves object is untouched', () => {
    const shallow: ToolpathMove[] = [
      rapid(0, 0, TOP), rapid(0, 0, 16), cut(10, 0, 16), rapid(10, 0, TOP),
      // A visit that cuts nothing, but the trim stopped nothing, so it is not the trim's to drop.
      rapid(12, 0, TOP), rapid(12, 0, 18), rapid(12, 0, TOP),
    ]
    const result = trim(shallow, true)
    expect(result.stops).toEqual([])
    expect(result.moves).toBe(shallow)
  })

  it('switch on: a visit with a cut in it stays', () => {
    const on = trim(PLANNED, true).moves
    expect(on.filter(m => m.role === 'cut' && m.z >= 15)).toHaveLength(cuts(PLANNED).filter(m => m.z >= 15).length)
  })

  it('the store seam passes the option through; only the adaptive_3d route sets it, from the WO-3028 switch', () => {
    const seam = (dropEmptyVisits?: boolean) => trimToToolReachInPartFrame({
      operation: 'Adaptive 3D', moves: PLANNED, tool: SHORT_FLUTE, part: { positions: [], indices: [] },
      partToleranceMm: 0.05, params: { clearanceAllowanceMm: 0.25 }, workholding: [], remainingStock: block,
      ...(dropEmptyVisits !== undefined ? { dropEmptyVisits } : {}),
    }).moves
    expect(emptyVisits(seam(true))).toEqual([])
    expect(seam(false)).toEqual(seam())
    expect(emptyVisits(seam()).length).toBeGreaterThan(0)
    const store = readFileSync('src/store/index.ts', 'utf8')
    const sets = [...store.matchAll(/dropEmptyVisits: ADAPTIVE_ENTRY_POLICY\.entriesAtMaterial/g)]
    expect(sets).toHaveLength(1)
    expect(store.match(/dropEmptyVisits/g)).toHaveLength(1)
    // The one setter is the adaptive_3d strategy's own trim: the nearest trim call above it
    // comes after the adaptive strategy ran, with no other 3D strategy in between.
    const before = store.slice(0, sets[0].index)
    const call = before.lastIndexOf('trimToToolReachInPartFrame(')
    expect(call).toBeGreaterThan(before.lastIndexOf('strategyResult = await runAdaptive3dStrategy()'))
  })

  it('the committed stick record: switch off identical, switch on no empty adaptive visits and every other step identical', () => {
    // The long production runs (planChain over every alpha.3 chain, ~70 min a side) are an evidence capture, not a slice
    // test: src/tests/evidence/WO-3048/p0Capture.capture.ts wrote this record, compare.py compared it.
    const record = JSON.parse(readFileSync('src/tests/evidence/WO-3048/benchmark-before-after.json', 'utf8')) as {
      off: { chainsBefore: number; chainsAfter: number; differences: string[] }
      on: { adaptive3dStepsChanged: { chain: string; step: string; emptyVisits: [number, number] }[]
        otherStepDifferences: string[]; adaptive3dRows: Record<string, { status: [string, string]; 'M-SAFE-2': [number, number] }> }
    }
    expect(record.off.chainsBefore).toBe(56)
    expect(record.off.chainsAfter).toBe(56)
    expect(record.off.differences).toEqual([])
    const cylinder = record.on.adaptive3dStepsChanged.find(s => s.chain === 'form-cylinder-default' && s.step === 'adaptive_3d')
    expect(cylinder?.emptyVisits).toEqual([14, 0])
    for (const step of record.on.adaptive3dStepsChanged) expect(step.emptyVisits[1], step.chain).toBe(0)
    // Other steps plan the same moves; only finish rows scored on the changed rough's stock move.
    expect(record.on.otherStepDifferences.every(key => key.endsWith('(scored row)') && key.includes('/finish-'))).toBe(true)
    for (const [key, row] of Object.entries(record.on.adaptive3dRows)) {
      expect(row.status[1], key).toBe(row.status[0])
      if (typeof row['M-SAFE-2'][0] === 'number') expect(row['M-SAFE-2'][1], key).toBeLessThanOrEqual(row['M-SAFE-2'][0])
    }
  })
})
