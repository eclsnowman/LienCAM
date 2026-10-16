import { describe, expect, it } from 'vitest'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import type {
  ContourParams,
  ContourWorkerPayload,
  ACWorkerPayload,
  FaceParams,
  FaceWorkerPayload,
  LoopData,
  PocketParams,
  PocketWorkerPayload,
} from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool } from '../../types'

await ensureClipperReady()

function tool(fluteLength: number): Tool {
  return {
    id: 'tool', name: '6 mm flat', type: 'flat_end_mill',
    diameter: 6, fluteLength, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 },
    },
  } as Tool
}

function heights(bottomHeight: number): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight, bottomHeightMode: 'absolute',
  }
}

const linking: LinkingParams = {
  entryType: 'ramp_linear', rampAngle: 3, rampLength: 8,
  leadInRadius: 0, leadOutRadius: 0,
  retractType: 'minimum', transitionType: 'avoid_stock',
}

const passes: PassParams = {
  stepdown: 2, stepover: 2, stockToLeave: 0,
  floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
}

function square(id: string, x0 = 0): LoopData {
  return {
    id, closed: true, type: 'contour',
    points: [
      { x: x0, y: 0 }, { x: x0 + 40, y: 0 },
      { x: x0 + 40, y: 40 }, { x: x0, y: 40 },
    ],
  }
}

function openChain(id: string, y: number): LoopData {
  return {
    id, closed: false, type: 'open',
    points: [{ x: 10, y }, { x: 90, y }],
  }
}

function closedContourPayload(fluteLength: number): ContourWorkerPayload {
  const params: ContourParams = {
    side: 'outer', direction: 'climb', geometryId: 'geometry', loopIds: [], tabs: false,
  }
  return {
    opId: 'closed-contour', setupId: 'setup', params,
    heights: heights(-6), passes, linking,
    tool: tool(fluteLength), loops: [square('A'), square('B', 60)],
    loopBottoms: { A: -2, B: -8 },
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function openContourPayload(fluteLength: number): ContourWorkerPayload {
  const params: ContourParams = {
    pathType: 'open', openSide: 'right',
    side: 'outer', direction: 'climb', geometryId: 'geometry', loopIds: [], tabs: false,
  }
  return {
    opId: 'open-contour', setupId: 'setup', params,
    heights: heights(-6), passes, linking: { ...linking, entryType: 'plunge' },
    tool: tool(fluteLength), loops: [openChain('open-1', 30), openChain('open-2', 70)],
    loopBottoms: { 'open-1': -2, 'open-2': -20 },
    wcsOrigin: { x: 0, y: 0, z: 0 },
    stockBounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } },
  }
}

function facePayload(fluteLength: number): FaceWorkerPayload {
  const params: FaceParams = {
    boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 5, chipThinning: false, bothSidesPerLevel: false,
    floorStockToLeave: 0, finishPass: false,
    entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
    keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
    transition: 'straight', tolerance: 0.01,
  }
  return {
    opId: 'face', setupId: 'setup', params,
    heights: heights(-2), passes, linking,
    tool: tool(fluteLength), loops: [square('face-boundary')],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function pocketPayload(fluteLength: number): PocketWorkerPayload {
  const params: PocketParams = {
    geometryId: 'geometry', loopIds: ['pocket-boundary'],
    direction: 'climb', orderStrategy: 'by_depth', fillStrategy: 'outside_in',
    floorStockToLeave: 0, finishContour: false, helixDiameter: 80,
    overlapMm: 0.5, stepoverLeadIn: 'arc', stayDown: false, stayDownLift: 0.6,
  }
  return {
    opId: 'pocket', setupId: 'setup', params,
    heights: heights(-5), passes: { ...passes, stockToLeave: 0.2 }, linking,
    tool: tool(fluteLength), loops: [square('pocket-boundary')],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function adaptivePayload(fluteLength: number, bottomHeight = -5): ACWorkerPayload {
  return {
    opId: 'adaptive', setupId: 'setup',
    params: {
      geometryId: 'geometry', loopIds: [],
      targetEngagement: 0.4, maxEngagement: 0.6,
      stepDistance: 1, thetaMax: Math.PI / 3,
      climb: true, rampAngle: 3, completionTolerance: 1,
      helixDiameter: 90, tolerance: 0.02,
      floorFinish: false,
      heightReference: 'stock_top', planeOffset: bottomHeight,
    },
    heights: {
      ...heights(bottomHeight),
      topHeightMode: 'stock_top',
    },
    passes: { ...passes, stepdown: 2, stepover: 1.5, stockToLeave: 0.3 },
    linking,
    tool: tool(fluteLength), loops: [square('adaptive-boundary')],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

/** The refusal text; the operator never sees a loop's internal id (WO-2880). */
function refusal(build: () => unknown, ids: string[]): string {
  let message = ''
  try { build() } catch (e) { message = e instanceof Error ? e.message : String(e) }
  for (const id of ids) expect(message).not.toContain(`"${id}"`)
  return message
}

describe('tool flute reach refuses incomplete 2D toolpaths', () => {
  it('keeps valid closed Contour output byte-identical at the exact reach limit', () => {
    expect(buildContourToolpath(closedContourPayload(8)))
      .toEqual(buildContourToolpath(closedContourPayload(40)))
  })

  it('preflights every closed Contour loop and reports the shortfall', () => {
    expect(refusal(() => buildContourToolpath(closedContourPayload(7)), ['A', 'B'])).toMatch(
      /Contour: requested axial depth 8\.000 mm exceeds available flute length 7\.000 mm by 1\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  })

  it('uses the deepest emitted closed-Contour roughing cut when floor stock is left', () => {
    const atLimit = closedContourPayload(6)
    atLimit.passes = {
      ...atLimit.passes,
      stockToLeave: 0.3,
      floorStockToLeave: 2,
      finishPasses: 0,
    }
    expect(buildContourToolpath(atLimit))
      .toEqual(buildContourToolpath({ ...atLimit, tool: tool(40) }))

    expect(refusal(() => buildContourToolpath({ ...atLimit, tool: tool(5) }), ['A', 'B'])).toMatch(
      /Contour: requested axial depth 6\.000 mm exceeds available flute length 5\.000 mm by 1\.000 mm/i,
    )
  })

  it('refuses the supplied project Contour span instead of silently clipping it', () => {
    const payload = closedContourPayload(20)
    payload.heights = heights(-35)
    payload.loopBottoms = undefined
    expect(refusal(() => buildContourToolpath(payload), ['A', 'B'])).toMatch(
      /Contour: requested axial depth 35\.000 mm exceeds available flute length 20\.000 mm by 15\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  })

  it('keeps valid Open Contour output byte-identical at the exact reach limit', () => {
    expect(buildContourToolpath(openContourPayload(20)))
      .toEqual(buildContourToolpath(openContourPayload(40)))
  })

  it('preflights every Open Contour chain and reports the shortfall', () => {
    expect(refusal(() => buildContourToolpath(openContourPayload(19)), ['open-1', 'open-2'])).toMatch(
      /Open Contour: requested axial depth 20\.000 mm exceeds available flute length 19\.000 mm by 1\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  })

  it('uses the deepest emitted Open Contour roughing cut when floor stock is left', () => {
    const atLimit = openContourPayload(18)
    atLimit.passes = {
      ...atLimit.passes,
      stockToLeave: 0.3,
      floorStockToLeave: 2,
      finishPasses: 0,
    }
    expect(buildContourToolpath(atLimit))
      .toEqual(buildContourToolpath({ ...atLimit, tool: tool(40) }))

    expect(refusal(() => buildContourToolpath({ ...atLimit, tool: tool(17) }), ['open-1', 'open-2'])).toMatch(
      /Open Contour: requested axial depth 18\.000 mm exceeds available flute length 17\.000 mm by 1\.000 mm/i,
    )
  })

  it('keeps valid Pocket output byte-identical at the exact reach limit', () => {
    expect(buildPocketToolpath(pocketPayload(5)))
      .toEqual(buildPocketToolpath(pocketPayload(40)))
  })

  it('refuses Pocket instead of reporting a shortened toolpath as successful', () => {
    expect(() => buildPocketToolpath(pocketPayload(4))).toThrow(
      /Pocket: requested axial depth 5\.000 mm exceeds available flute length 4\.000 mm by 1\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  })

  it('keeps valid Face output byte-identical at the exact reach limit', () => {
    expect(buildFaceToolpath(facePayload(2)))
      .toEqual(buildFaceToolpath(facePayload(40)))
  })

  it('refuses Face instead of reporting a shortened toolpath as successful', () => {
    expect(() => buildFaceToolpath(facePayload(1))).toThrow(
      /Face: requested axial depth 2\.000 mm exceeds available flute length 1\.000 mm by 1\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  })

  it('keeps the supplied Adaptive height semantics byte-identical when flute reach is valid', async () => {
    expect(await buildAdaptiveClearingToolpath(adaptivePayload(5)))
      .toEqual(await buildAdaptiveClearingToolpath(adaptivePayload(40)))
  }, 120_000)

  it('refuses Adaptive Clearing before generating an unsafe full-depth path', async () => {
    await expect(buildAdaptiveClearingToolpath(adaptivePayload(20, -21))).rejects.toThrow(
      /Adaptive Clearing: requested axial depth 21\.000 mm exceeds available flute length 20\.000 mm by 1\.000 mm\..*longer flute\/relieved length.*reduce the bottom depth/i,
    )
  }, 120_000)

  it('checks the deepest emitted Adaptive cut when intentional floor stock is left', async () => {
    const atLimit = adaptivePayload(19, -21)
    atLimit.passes.floorStockToLeave = 2
    expect(await buildAdaptiveClearingToolpath(atLimit))
      .toEqual(await buildAdaptiveClearingToolpath({ ...atLimit, tool: tool(40) }))
  }, 120_000)
})
