// Analytic unit controls only; application evidence comes from planChain.
import { ZDexelField } from '../../cam3d/stock'
import type { ToolpathMove } from '../../types'
import { makeTool } from '../post/helpers'
import { collectAlpha3, type CollectorInput } from './metrics.alpha3'
export const bounds = { minX: 0, minY: 0, minZ: -5, maxX: 40, maxY: 20, maxZ: 0 }
export const tool = makeTool({ diameter: 2, fluteLength: 4, feedsAndSpeeds: { default: { rpm: 12000, feedRate: 1000, plungeRate: 100, stepover: 1, depthOfCut: 1 } } })
export const move = (x: number, y: number, z: number, extra: Partial<ToolpathMove> = {}): ToolpathMove => ({ type: 'feed', role: 'cut', feed: 1000, x, y, z, ...extra })
export function control(moves: ToolpathMove[], extras: Partial<CollectorInput> = {}) {
  return collectAlpha3({ planned: { stepId: 'control', setupId: 'unit', planMs: 0, status: 'ready', cutTimeMs: 60000, moves },
    tool, opType: 'pocket_2d', stock: { field: ZDexelField.fromBox(bounds, 0.1), bounds, cutter: { kind: 'flat', diameter: 2 } }, ...extras })
}
