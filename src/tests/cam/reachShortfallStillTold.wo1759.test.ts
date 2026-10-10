import { beforeAll, describe, expect, it } from 'vitest'

import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { trimToolpathToToolReach } from '../../lib/cam/holderClearanceGate'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import type { ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolHolder } from '../../types'

type Box = readonly [number, number, number, number, number, number]

const STEM: Box = [-5, -5, 0, 5, 5, 10]
const LIP: Box = [-5.3, -5.3, 10, 0, 5.3, 15]

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) {
      for (const y of [y0, y1]) {
        for (const x of [x0, x1]) positions.push(x, y, z)
      }
    }
    for (const [a, b, c, d] of [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
      [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]) {
      indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

const HOLDER: ToolHolder = {
  id: 'holder-1',
  name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

const SHORT_NECK_LOLLIPOP = {
  id: 'tool-1', name: '6 mm lollipop, 3 mm neck', type: 'lollipop_mill',
  diameter: 6, fluteLength: 6, shankDiameter: 6, neckDiameter: 3, shoulderLength: 3,
  overallLength: 60, lengthBelowHolder: 40, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', holderId: HOLDER.id, notes: '',
  feedsAndSpeeds: {
    default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 },
  },
} as unknown as Tool

const HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 25, feedHeight: 20,
  topHeight: 10, topHeightMode: 'absolute',
  bottomHeight: 5, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = {
  stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0,
}
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const STEM_LOOP: LoopData = {
  id: 'stem', closed: true, type: 'contour',
  points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
}

beforeAll(ensureClipperReady)

describe('WO-1759: the WO-1571 stopped-short fixture is still told', () => {
  it('produces one WCS-framed summary line for the short-neck lip-T contour', () => {
    const payload = {
      opId: 'op-1', setupId: 'setup-1',
      params: { side: 'outer', direction: 'climb', geometryId: 'lip-t', loopIds: [], tabs: false },
      heights: HEIGHTS, passes: PASSES, linking: LINKING,
      tool: SHORT_NECK_LOLLIPOP, loops: [STEM_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    } as ContourWorkerPayload
    const moves = buildContourToolpath(payload)

    const result = trimToolpathToToolReach({
      operation: 'Contour',
      moves,
      tool: SHORT_NECK_LOLLIPOP,
      holder: HOLDER,
      stockBlock: { min: { x: -40, y: -40, z: 5 }, max: { x: 40, y: 40, z: 10 } },
      clearancePart: meshOf([STEM, LIP]),
      noEarlierOperations: true,
      clearanceAllowanceMm: 0.25,
      wcsLabel: 'G54',
    })

    expect(result.stops.length).toBeGreaterThan(0)
    expect(result.shortfall).toBeDefined()
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toMatch(
      /^Contour: cut stopped at G54 X -?[\d.]+ Y -?[\d.]+ Z -?[\d.]+ - the shank would come within 0.25 mm of the part(?: \(\d+ stops\))?\. [\d.]+ mm of cutting path was left uncut, up to G54 X -?[\d.]+ Y -?[\d.]+ Z -?[\d.]+, where it picks up again; reached Z -?[\d.]+ of Z -?[\d.]+ asked; a tool with a longer reach cuts the rest\.$/,
    )
  })
})
