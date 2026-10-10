import { describe, it, expect } from 'vitest'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { estimateRuntimeMs } from '../../lib/cam/runtime'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// WO-1886: a G83 peck cycle must RAPID back down to a small clearance above the
// previous peck depth and then feed only that clearance plus the next peck.
// Before the fix the re-approach was a plunge-RATE feed from the retract plane
// all the way down to just above the previous depth, so every peck crawled the
// whole drilled depth at plunge feed.

const CLEARANCE = 0.5
const PECK_DEPTH = 5
const TOP_Z = 0
const BOTTOM_Z = -20          // 20 mm deep hole, 5 mm pecks -> 4 pecks
const FEED_Z = 0.5            // = TOP_Z + clearance, so the first entry feed is peck + clearance
const RETRACT_Z = 5
const CLEARANCE_Z = 10
const PLUNGE_RATE = 150
const FEED_RATE = 600

function makeTool(): Tool {
  return {
    id: 't1', name: 'drill 5', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: FEED_RATE, plungeRate: PLUNGE_RATE, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: CLEARANCE_Z, clearanceHeightMode: 'absolute',
  retractHeight: RETRACT_Z, feedHeight: FEED_Z,
  topHeight: TOP_Z, topHeightMode: 'absolute',
  bottomHeight: BOTTOM_Z, bottomHeightMode: 'absolute',
}

const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// One square loop centred on the origin — drill works off the loop centroid.
const LOOPS: LoopData[] = [{
  id: 'h1', closed: true, type: 'contour', points: [
    { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
  ],
}]

function makeParams(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [], cycleType: 'peck', peckDepth: PECK_DEPTH,
    chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
    ...over,
  }
}

function build(params = makeParams()): ToolpathMove[] {
  const payload: DrillWorkerPayload = {
    opId: 'op', setupId: 'su', params, heights, passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
  return buildDrillToolpath(payload)
}

describe('WO-1886 peck re-approach returns at rapid, not plunge feed', () => {
  it('re-approach is a rapid to previous depth + clearance; no feed longer than peck + clearance', () => {
    const moves = build()

    // The hole's moves only (single hole at origin).
    const plungeFeeds = moves.filter(m => m.role === 'plunge')
    // 20 mm / 5 mm = 4 pecks -> exactly one plunge feed each; the re-approaches
    // between them are rapids, so they must not appear as plunge feeds.
    expect(plungeFeeds.length).toBe(4)
    expect(plungeFeeds.map(m => m.z)).toEqual([-5, -10, -15, -20])

    // No plunge feed at the hole may travel more than peckDepth + clearance
    // (the first entry feed starts at feedZ = topZ + clearance, so it is exact).
    let prev = moves[0]
    const plungeFeedLengths: number[] = []
    for (const m of moves.slice(1)) {
      if (m.type === 'feed' && m.role === 'plunge') plungeFeedLengths.push(Math.abs(m.z - prev.z))
      prev = m
    }
    expect(plungeFeedLengths.length).toBe(4)
    expect(Math.max(...plungeFeedLengths)).toBeLessThanOrEqual(PECK_DEPTH + CLEARANCE + 1e-9)

    // The move right after each full retract is a RAPID to (previous depth +
    // clearance) — never a plunge feed. This is the negative-control tripwire:
    // restore the old `feed(... 'plunge')` re-approach and this fails.
    const retractIndices = moves
      .map((m, i) => (m.type === 'rapid' && Math.abs(m.z - RETRACT_Z) < 1e-9 ? i : -1))
      .filter(i => i >= 0)
    // 3 inter-peck full retracts plus the final between-hole retract; only the
    // inter-peck ones are followed by a re-approach (the last is followed by the
    // final clearance retract).
    const reApproachRetracts = retractIndices.slice(0, -1)
    expect(reApproachRetracts.length).toBe(3)
    for (const i of reApproachRetracts) {
      const re = moves[i + 1]
      expect(re.type).toBe('rapid')
      // previous depth from the plunge just before the retract
      const prevZ = moves[i - 1].z
      expect(Math.abs(re.z - (prevZ + CLEARANCE))).toBeLessThan(1e-9)
    }

    // Hole depth, XY and final retract unchanged.
    const minZ = Math.min(...moves.filter(m => m.type === 'feed').map(m => m.z))
    expect(minZ).toBe(BOTTOM_Z)
    expect(moves.every(m => Math.abs(m.x) < 1e-9 && Math.abs(m.y) < 1e-9)).toBe(true)
    expect(moves[moves.length - 1].z).toBe(CLEARANCE_Z)
  })

  it('cycle-time estimate drops versus the old plunge-feed re-approach', () => {
    const moves = build()
    const after = estimateRuntimeMs(moves, 5000)

    // Old stream: same pecks but the re-approach is a plunge-RATE feed from the
    // retract plane down to previous depth + 1mm. Hand-built CONTROL, not
    // application truth — only here to make the acceptance-2 drop visible.
    const old: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: CLEARANCE_Z, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: FEED_Z, feed: FEED_RATE, role: 'rapid' },
    ]
    let currentZ = TOP_Z
    for (let p = 0; p < 4; p++) {
      const targetZ = Math.max(BOTTOM_Z, currentZ - PECK_DEPTH)
      old.push({ type: 'feed', x: 0, y: 0, z: targetZ, feed: PLUNGE_RATE, role: 'plunge' })
      if (targetZ > BOTTOM_Z) {
        old.push({ type: 'rapid', x: 0, y: 0, z: RETRACT_Z, role: 'rapid' })
        old.push({ type: 'feed', x: 0, y: 0, z: currentZ + 1, feed: PLUNGE_RATE, role: 'plunge' })
      }
      currentZ = targetZ
    }
    old.push({ type: 'rapid', x: 0, y: 0, z: RETRACT_Z, role: 'rapid' })
    old.push({ type: 'rapid', x: 0, y: 0, z: CLEARANCE_Z, role: 'rapid' })
    const before = estimateRuntimeMs(old, 5000)

    console.log(`WO-1886 cycle estimate ms: before=${before.toFixed(1)} after=${after.toFixed(1)}`)
    expect(after).toBeLessThan(before)
  })

  it('final depth and XY are identical to a same-geometry simple cycle', () => {
    const peck = build()
    const simple = build(makeParams({ cycleType: 'simple' }))
    const minZ = (ms: ToolpathMove[]) => Math.min(...ms.filter(m => m.type === 'feed').map(m => m.z))
    expect(minZ(peck)).toBe(minZ(simple))
    expect(peck[peck.length - 1].z).toBe(simple[simple.length - 1].z)
  })
})
