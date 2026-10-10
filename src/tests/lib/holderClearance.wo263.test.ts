import { describe, expect, it } from 'vitest'

import type { Tool, ToolHolder, ToolpathMove } from '../../types'
import { checkHolderAndShankClearance } from '../../lib/cam/holderClearance'
import {
  applyStockOperation,
  createStockState,
  isStockRegionEmpty,
  type StockState,
} from '../../lib/cam/stockState'

const STOCK_BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 20, maxZ: 10 }

const TOOL: Tool = {
  id: 'tool-1',
  name: '6 mm end mill',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 5,
  shankDiameter: 6,
  overallLength: 50,
  lengthBelowHolder: 8,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  holderId: 'holder-1',
  notes: '',
  feedsAndSpeeds: {},
}

const HOLDER: ToolHolder = {
  id: 'holder-1',
  name: '12 mm holder',
  segments: [{ height: 20, lowerDiameter: 12, upperDiameter: 12 }],
}

function carvedCorridor(z: number, stockTop: number = STOCK_BOUNDS.maxZ): StockState {
  return applyStockOperation(createStockState({ ...STOCK_BOUNDS, maxZ: stockTop }, 0.5), [{
    move: { x0: 5, y0: 10, z0: z, x1: 35, y1: 10, z1: z },
    cutter: { kind: 'flat', diameter: TOOL.diameter },
  }])
}

function move(x: number, z: number, type: ToolpathMove['type'] = 'feed'): ToolpathMove {
  return { type, x, y: 10, z, role: type === 'rapid' ? 'rapid' : 'cut' }
}

describe('WO-263 holder and shank clearance checking', () => {
  it('reports clear for ample stickout in a shallow pocket', () => {
    const moves = [move(10, 15, 'rapid'), move(10, 4), move(30, 4)]

    const report = checkHolderAndShankClearance({
      stock: carvedCorridor(4),
      moves,
      tool: { ...TOOL, lengthBelowHolder: 12 },
      holder: HOLDER,
    })

    expect(report.complete).toBe(true)
    expect(report.collisions).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('reproduces a too-short tool: flutes clear while the holder names exact moves', () => {
    const stock = carvedCorridor(0)
    const moves = [move(10, 15, 'rapid'), move(10, 4), move(10, 0), move(30, 0)]

    expect(isStockRegionEmpty(stock, {
      kind: 'swept-cutter',
      move: { x0: 10, y0: 10, z0: 0, x1: 30, y1: 10, z1: 0 },
      cutter: { kind: 'flat', diameter: TOOL.diameter },
    }), 'the cutting flute footprint was already removed').toBe(true)

    const report = checkHolderAndShankClearance({ stock, moves, tool: TOOL, holder: HOLDER })

    expect(report.collisions.map(({ moveIndex }) => moveIndex)).toEqual([2, 3])
    expect(report.collisions.map(({ components }) => components)).toEqual([
      ['holder'],
      ['holder'],
    ])
    expect(report.collisions[0].move).toBe(moves[2])
    expect(report.collisions[1].move).toBe(moves[3])
  })

  it.each([10, 38.1, 76.2, 101.6])(
    'treats a holder exactly grazing a %s mm stock top as a collision',
    (stockTop) => {
      const toolTipZ = stockTop - TOOL.lengthBelowHolder!
      const moves = [move(20, stockTop + 2, 'rapid'), move(20, toolTipZ)]

      const report = checkHolderAndShankClearance({
        stock: carvedCorridor(toolTipZ, stockTop),
        moves,
        tool: TOOL,
        holder: HOLDER,
      })

      expect(report.boundaryPolicy).toBe('contact-is-collision')
      expect(report.contactBiasMm).toBe(1e-6)
      expect(report.collisions.map(({ moveIndex }) => moveIndex)).toEqual([1])
      expect(report.collisions[0].components).toEqual(['holder'])
    },
  )

  it('reports shank contact separately from a clear holder', () => {
    const moves = [move(20, 15, 'rapid'), move(20, 4)]

    const report = checkHolderAndShankClearance({
      stock: carvedCorridor(4),
      moves,
      tool: { ...TOOL, shankDiameter: 10, lengthBelowHolder: 12 },
      holder: { ...HOLDER, segments: [{ height: 20, lowerDiameter: 6, upperDiameter: 6 }] },
    })

    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0]).toMatchObject({ moveIndex: 1, components: ['shank'] })
  })

  it('reports a missing holder profile quietly instead of guessing one (WO-1626)', () => {
    // An undefined holder is the operator's decision (Operator, 2026-09-16): the
    // check has nothing to add for the holder, but says nothing about it.
    const report = checkHolderAndShankClearance({
      stock: carvedCorridor(0),
      moves: [move(10, 0), move(30, 0)],
      tool: TOOL,
    })

    expect(report.complete).toBe(false)
    expect(report.holderStatus).toBe('missing-profile')
    expect(report.warnings).toEqual([])
    expect(report.collisions).toEqual([])
  })

  it('attributes sampled arc contact to the original arc move', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 10, y: 10, z: 15, role: 'rapid' },
      { type: 'arc_ccw', x: 20, y: 10, z: 0, cx: 15, cy: 10, role: 'cut' },
    ]

    const report = checkHolderAndShankClearance({
      stock: carvedCorridor(0),
      moves,
      tool: TOOL,
      holder: HOLDER,
    })

    expect(report.collisions.map(({ moveIndex }) => moveIndex)).toEqual([1])
    expect(report.collisions[0].move).toBe(moves[1])
  })
})
