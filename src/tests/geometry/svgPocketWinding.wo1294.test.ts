// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest'
import { importSVG } from '../../lib/import/svgImporter'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { LinkingParams, PassParams, Tool } from '../../types'
import type { PocketParams, PocketWorkerPayload } from '../../lib/cam/types'
import { installSvgPathGeometry } from '../import/svgPathGeometryPolyfill'

const CLOCKWISE_OUTLINE = `
<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">
  <path fill="none" stroke="#000" d="M 5 5 L 45 5 L 45 45 L 5 45 Z"/>
</svg>`

// Both paths deliberately use the same source winding. Import flips SVG Y into
// world Y, so both would previously be stamped "hole" from their signed area.
const OUTLINE_WITH_HOLE = `
<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="60mm" viewBox="0 0 60 60">
  <path fill="none" stroke="#000" d="M 5 5 L 55 5 L 55 55 L 5 55 Z"/>
  <path fill="none" stroke="#000" d="M 20 20 L 40 20 L 40 40 L 20 40 Z"/>
</svg>`

const tool = {
  id: 'tool-1', name: '6 mm flat', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 2 } },
} as Tool

const passes: PassParams = {
  stepdown: 2, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function pocketPayload(svg: string): PocketWorkerPayload {
  const imported = importSVG(svg)
  const params: PocketParams = {
    geometryId: 'svg-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  return {
    opId: 'pocket-1', setupId: 'setup-1', params,
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
    },
    passes, linking, tool, loops: imported.loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

beforeAll(async () => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
  await ensureClipperReady()
})

describe('WO-1294 SVG winding at the real importer and Pocket 2D builder', () => {
  it('pockets a single closed clockwise world-space outline', () => {
    const payload = pocketPayload(CLOCKWISE_OUTLINE)
    expect(payload.loops).toHaveLength(1)
    expect(payload.loops[0]).toMatchObject({ closed: true, type: 'contour' })
    expect(buildPocketToolpath(payload).length).toBeGreaterThan(0)
  })

  it('keeps a nested loop as a real hole even when both source paths share winding', () => {
    const payload = pocketPayload(OUTLINE_WITH_HOLE)
    expect(payload.loops.map(loop => loop.type).sort()).toEqual(['contour', 'hole'])

    const moves = buildPocketToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
    const engagedInsideHole = moves.filter(move =>
      (move.type === 'feed' || move.z <= 0) &&
      move.x > -10 && move.x < 10 && move.y > -10 && move.y < 10)
    expect(engagedInsideHole).toHaveLength(0)
  })
})
