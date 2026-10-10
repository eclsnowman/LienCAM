import { describe, it, expect } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type {
  PocketParams, ContourParams, PocketWorkerPayload, ContourWorkerPayload, LoopData,
} from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// Pocket ring generation goes through clipper2 offsetLoop (same as the worker,
// which awaits this before COMPUTE_POCKET) — load it before exercising builders.
await ensureClipperReady()

// Regression for the silent "ready / Computed 0ms / nothing renders" bug
// (Operator 2026-06-13). Loop ids are minted fresh on every geometry re-derive
// (path2d.ts crypto.randomUUID); a stored op selection then references ids that
// no longer exist, and buildPocketToolpath USED TO filter to an empty set and
// `return moves` silently -> 0 moves, status "ready", no error, nothing renders.
// ADR 0003: a non-empty selection that matches nothing must FAIL LOUD.

const tool: Tool = {
  id: 't1', name: 'O3 flat', type: 'flat_end_mill',
  diameter: 3, fluteLength: 20, shankDiameter: 3, overallLength: 50,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as Tool

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
// A generous 40x40 closed square so generateRings cannot collapse with a 3mm tool.
const SQUARE: LoopData = {
  id: 'loop-current', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
}

function pocketPayload(loopIds: string[]): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: { geometryId: 'g', loopIds, direction: 'climb', orderStrategy: 'by_depth',
      fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
      helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1 } as PocketParams,
    heights, passes, linking, tool, loops: [SQUARE], wcsOrigin: { x: 0, y: 0, z: 0 },
  } as PocketWorkerPayload
}

function contourPayload(loopIds: string[]): ContourWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: { geometryId: 'g', loopIds, side: 'outer', direction: 'climb', tabs: false } as ContourParams,
    heights, passes, linking, tool, loops: [SQUARE], wcsOrigin: { x: 0, y: 0, z: 0 },
  } as ContourWorkerPayload
}

describe('loop-selection fail-loud (orphaned selection)', () => {
  it('pocket: a matching selection still generates a toolpath', () => {
    const moves = buildPocketToolpath(pocketPayload(['loop-current']))
    expect(moves.length).toBeGreaterThan(2)
  })

  it('pocket: empty selection (= all closed loops) still generates', () => {
    const moves = buildPocketToolpath(pocketPayload([]))
    expect(moves.length).toBeGreaterThan(2)
  })

  it('pocket: a STALE selection (no current loop matches) THROWS, never silent 0 moves', () => {
    expect(() => buildPocketToolpath(pocketPayload(['stale-uuid-that-no-longer-exists'])))
      .toThrow(/no longer exist/i)
  })

  it('contour: a STALE selection THROWS instead of returning empty', () => {
    expect(() => buildContourToolpath(contourPayload(['stale-uuid'])))
      .toThrow(/no longer exist/i)
  })
})
