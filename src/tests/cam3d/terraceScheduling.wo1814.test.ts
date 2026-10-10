import { beforeAll, describe, expect, it } from 'vitest'
import { ensureGeom2dReady, type Ring } from '../../cam3d/geom2d'
import type { CutterSpec } from '../../cam3d/kernel/types'
import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import {
  scheduleAdaptiveDepthBranchesWithTerraces,
  type AdaptiveDepthComponentPlan,
} from '../../cam3d/rough/scheduleComponents'
import { terraceIntervals } from '../../cam3d/rough/terraceSchedule'
import {
  measureTerraceRemoval,
  terraceRemovalIsProductive,
} from '../../cam3d/rough/terraceMaterial'
import { ZDexelField } from '../../cam3d/stock'
import type { IrMove } from '../../cam3d/ir/types'
import { replayMovesIntoStock } from '../../cam3d/rough/replayStock'

function square(x0: number, y0: number, x1: number, y1: number): Ring {
  return new Float64Array([x0, y0, x1, y0, x1, y1, x0, y1])
}

function plan(
  originalIndex: number,
  levelIndex: number,
  z: number,
  boundary: Ring,
): AdaptiveDepthComponentPlan {
  const passes: AdaptivePass[] = [
    { type: 'entry', point: { x: boundary[0], y: boundary[1] }, radius: 0, mode: 'plunge' },
    { type: 'cut', points: [{ x: boundary[2], y: boundary[3] }] },
  ]
  return { originalIndex, levelIndex, z, component: { boundary, holes: [] }, passes }
}

describe('WO-1814 terrace dependency and material rules', () => {
  beforeAll(async () => ensureGeom2dReady())

  it('uses real adjacent full planes, including the stock-top and pinned intervals', () => {
    expect(terraceIntervals(20, [17, 13, 12, 8])).toEqual([
      { lowerLevelIndex: 0, lowerZ: 17, upperZ: 20, z: 18.5 },
      { lowerLevelIndex: 1, lowerZ: 13, upperZ: 17, z: 15 },
      { lowerLevelIndex: 2, lowerZ: 12, upperZ: 13, z: 12.5 },
      { lowerLevelIndex: 3, lowerZ: 8, upperZ: 12, z: 10 },
    ])
  })

  it('waits for every overlapping merge parent without blocking an unrelated branch', () => {
    const left = plan(0, 0, 10, square(0, 0, 4, 4))
    const right = plan(1, 0, 10, square(5, 0, 9, 4))
    const unrelated = plan(2, 0, 10, square(20, 0, 24, 4))
    const merged = plan(0, 1, 7, square(0, 0, 9, 4))
    const unrelatedDeep = plan(1, 1, 7, square(20, 0, 24, 4))
    const events = scheduleAdaptiveDepthBranchesWithTerraces(
      [left, right, unrelated, merged, unrelatedDeep],
      [{ id: 0, z: 8.5, upperZ: 10, lowerLevelIndex: 0, component: { boundary: square(0, 0, 9, 4), holes: [] } }],
      { x: 20, y: 0 },
    )
    const label = events.map(event => event.kind === 'terrace'
      ? 'terrace'
      : `bulk-${event.plan.levelIndex}-${event.plan.originalIndex}`)
    const terrace = label.indexOf('terrace')
    expect(terrace).toBeGreaterThan(label.indexOf('bulk-0-0'))
    expect(terrace).toBeGreaterThan(label.indexOf('bulk-0-1'))
    expect(terrace).toBeLessThan(label.indexOf('bulk-1-0'))
    expect(label.indexOf('bulk-1-1')).toBeLessThan(terrace)
  })

  it('labels an unclassified terrace, waits for its whole lower plane, and does not hold unrelated branches', () => {
    const left = plan(0, 0, 10, square(0, 0, 4, 4))
    const right = plan(1, 0, 10, square(5, 0, 9, 4))
    // A real parent on the upper plane: a deeper component that overlaps no
    // upper component would itself fall back to the whole upper plane.
    const farTop = plan(2, 0, 10, square(20, 0, 24, 4))
    const unrelatedDeep = plan(0, 1, 7, square(20, 0, 24, 4))
    const events = scheduleAdaptiveDepthBranchesWithTerraces(
      [left, right, farTop, unrelatedDeep],
      [{
        id: 0,
        z: 8.5,
        upperZ: 10,
        lowerLevelIndex: 0,
        component: { boundary: square(40, 0, 44, 4), holes: [] },
      }],
      { x: 22, y: 2 },
    )
    const terraceIndex = events.findIndex(event => event.kind === 'terrace')
    expect(terraceIndex).toBeGreaterThan(events.findIndex(event =>
      event.kind === 'bulk' && event.plan === left))
    expect(terraceIndex).toBeGreaterThan(events.findIndex(event =>
      event.kind === 'bulk' && event.plan === right))
    expect(events[terraceIndex]).toMatchObject({
      kind: 'terrace',
      conservativeFallback: true,
    })
    expect(events.findIndex(event =>
      event.kind === 'bulk' && event.plan === unrelatedDeep)).toBeLessThan(terraceIndex)
  })

  it('keeps the physical productivity verdict stable across grid and tool scales', () => {
    const results: Array<{ cell: number; diameter: number; productive: boolean; crossSection: number }> = []
    for (const cell of [0.5, 0.25]) {
      for (const diameter of [2, 4]) {
        const stock = ZDexelField.fromBox(
          { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 3 },
          cell,
        )
        const cutter: CutterSpec = { kind: 'flat', diameter }
        const moves: IrMove[] = [
          { t: 'rapid', x: 2, y: 10, z: 1, role: 'rapid' },
          { t: 'feed', x: 18, y: 10, z: 1, role: 'finish' },
        ]
        const metrics = measureTerraceRemoval(stock, cutter, moves, { x: 2, y: 10, z: 4 })
        results.push({
          cell,
          diameter,
          productive: terraceRemovalIsProductive(metrics, 0.05, 1),
          crossSection: metrics.freshCrossSectionMm2,
        })
      }
    }
    expect(results.every(result => result.productive)).toBe(true)
    for (const diameter of [2, 4]) {
      const sameTool = results.filter(result => result.diameter === diameter)
      expect(Math.max(...sameTool.map(result => result.crossSection))
        / Math.min(...sameTool.map(result => result.crossSection))).toBeLessThan(1.35)
    }

    const untouched = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 3 },
      0.25,
    )
    const zero = measureTerraceRemoval(
      untouched,
      { kind: 'flat', diameter: 4 },
      [
        { t: 'rapid', x: 2, y: 10, z: 4, role: 'rapid' },
        { t: 'feed', x: 18, y: 10, z: 4, role: 'finish' },
      ],
      { x: 2, y: 10, z: 4 },
    )
    expect(zero.removedVolumeMm3).toBe(0)
    expect(terraceRemovalIsProductive(zero, 0.05, 1)).toBe(false)
  })

  it('re-evaluates eligibility against material a prior operation already removed', () => {
    const cutter: CutterSpec = { kind: 'flat', diameter: 4 }
    const candidate: IrMove[] = [
      { t: 'rapid', x: 2, y: 10, z: 1, role: 'rapid' },
      { t: 'feed', x: 18, y: 10, z: 1, role: 'finish' },
    ]
    const full = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 3 },
      0.25,
    )
    const from = { x: 2, y: 10, z: 4 }
    const fresh = measureTerraceRemoval(full, cutter, candidate, from)
    expect(terraceRemovalIsProductive(fresh, 0.05, 1)).toBe(true)

    const retained = full.clone()
    replayMovesIntoStock(retained, cutter, candidate, from)
    const afterPrior = measureTerraceRemoval(retained, cutter, candidate, from)
    expect(afterPrior.removedVolumeMm3).toBe(0)
    expect(terraceRemovalIsProductive(afterPrior, 0.05, 1)).toBe(false)
  })
})
