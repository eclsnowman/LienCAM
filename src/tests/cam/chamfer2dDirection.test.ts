import { describe, expect, it } from 'vitest'

import { buildChamferToolpath } from '../../lib/cam/chamfer2d'
import type { ChamferParams, ChamferWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool } from '../../types'

const heights: HeightParams = {
  clearanceHeight: 10,
  clearanceHeightMode: 'absolute',
  retractHeight: 5,
  feedHeight: 1,
  topHeight: 0,
  topHeightMode: 'absolute',
  bottomHeight: -1,
  bottomHeightMode: 'absolute',
}

const passes: PassParams = {
  stepdown: 1,
  stepover: 1,
  stockToLeave: 0,
  finishPasses: 1,
  springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 3,
  rampLength: 0,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

const loop: LoopData = {
  id: 'outer',
  closed: true,
  type: 'contour',
  points: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 12 },
    { x: 0, y: 12 },
  ],
}

function payload(
  direction: 'climb' | 'conventional',
  cutHand: 'right' | 'left',
): ChamferWorkerPayload {
  const params: ChamferParams = {
    geometryId: 'geometry',
    loopIds: [loop.id],
    loopSides: { [loop.id]: 'outer' },
    direction,
    chamferWidth: 1,
    tipOffset: 0,
    overlapMm: 0,
    heightReference: 'geometry_face',
    planeOffset: 0,
  }
  const tool: Tool = {
    id: 'chamfer-tool',
    name: '90 deg chamfer',
    type: 'chamfer_mill',
    diameter: 10,
    fluteLength: 12,
    shankDiameter: 6,
    overallLength: 50,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    angleFromAxisDeg: 45,
    cutHand,
    feedsAndSpeeds: {
      default: {
        rpm: 10_000,
        feedRate: 700,
        plungeRate: 200,
        depthOfCut: 1,
        stepover: 1,
      },
    },
  }
  return {
    opId: 'chamfer',
    setupId: 'setup',
    params,
    heights,
    passes,
    linking,
    tool,
    loops: [loop],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

describe('Chamfer 2D tool-hand direction', () => {
  it('reverses the CW planner winding for a left-hand cutter', () => {
    const rightClimb = buildChamferToolpath(payload('climb', 'right'))
    const rightConventional = buildChamferToolpath(payload('conventional', 'right'))
    expect(rightClimb).not.toEqual(rightConventional)
    expect(buildChamferToolpath(payload('climb', 'left'))).toEqual(rightConventional)
    expect(buildChamferToolpath(payload('conventional', 'left'))).toEqual(rightClimb)
  })
})
