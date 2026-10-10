// WO-1626 review (safety path). The question: with the holder (or stickout)
// undefined now reading as quiet, is anything the software DID have the data
// to check - the shank, the flutes - ever reported clear or left untrimmed?
// Driven through the production paths: the real 2D worker entry point (both
// its trim branch and its refusal-gate branch) and the store's 3D seam
// trimToToolReachInPartFrame.

import { describe, expect, it, vi } from 'vitest'

import type {
  HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove,
} from '../../types'
import type {
  LoopData, PocketParams, ToolpathStockBlock, WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs'
import type { Box3 } from '../../cam3d/stock'

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

/** A 6 mm cutter with only 3 mm of flute on a 10 mm shank: any cut deeper than
 *  3 mm drives the shank into the material - data the check always has. */
function shortFluteTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: '6 mm stub', type: 'flat_end_mill',
    diameter: 6, fluteLength: 3, shankDiameter: 10, overallLength: 60,
    lengthBelowHolder: 30, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 1.5 },
    },
    ...overrides,
  } as unknown as Tool
}

const NO_HOLDER = { holderId: undefined, lengthBelowHolder: undefined } as Partial<Tool>
const NO_HOLDER_WITH_STICKOUT = { holderId: undefined } as Partial<Tool>

// ── 2D: the real worker ──────────────────────────────────────────────────────

const DEPTH = 8
const STOCK: ToolpathStockBlock = { min: { x: 0, y: 0, z: -10 }, max: { x: 60, y: 60, z: 0 } }
const HEIGHTS = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -DEPTH, bottomHeightMode: 'absolute',
} as unknown as HeightParams
const PASSES = { stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 } as unknown as PassParams
const LINKING = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as unknown as LinkingParams
const POCKET_PARAMS: PocketParams = {
  geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
  fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
  helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
}
const LOOP: LoopData = {
  id: 'loop-1', closed: true, type: 'contour',
  points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
}

type Handler = (event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void
let handler: Handler | undefined
const posted: WorkerResponseMsg[] = []

async function runWorker(message: unknown): Promise<WorkerResponseMsg> {
  if (!handler) {
    ;(globalThis as unknown as Record<string, unknown>).self = {
      set onmessage(fn: Handler) { handler = fn },
      postMessage: (m: WorkerResponseMsg) => { posted.push(m) },
    }
    await import('../../lib/cam/toolpathWorker')
  }
  posted.length = 0
  await handler!({ data: message } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((r) => r.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  return terminal[0]
}

function pocket(toolOverrides: Partial<Tool>, extra: Record<string, unknown> = {}, holder?: ToolHolder): unknown {
  return {
    type: 'COMPUTE_POCKET',
    payload: {
      opId: 'op-1', setupId: 'setup-1', params: POCKET_PARAMS, heights: HEIGHTS, passes: PASSES,
      linking: LINKING, tool: shortFluteTool(toolOverrides), loops: [LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
      ...(holder ? { holder } : {}), stockBlock: STOCK, ...extra,
    },
  }
}

function lowestZ(moves: readonly ToolpathMove[]): number {
  return moves.reduce((low, m) => Math.min(low, m.z), Number.POSITIVE_INFINITY)
}

describe('WO-1626 review: 2D - the shank is still checked with no holder defined', () => {
  for (const [label, overrides] of [
    ['no holder, no stickout', NO_HOLDER],
    ['no holder, stickout defined', NO_HOLDER_WITH_STICKOUT],
  ] as const) {
    // A 2D pocket deeper than the flutes never reaches the shank check: the
    // pocket's own flute-length reach refuses it first. That refusal reads the
    // flute length the operator DID define, holder or no holder.
    for (const [branch, extra] of [
      ['trim branch (the app path)', { clearanceAllowanceMm: 0.25 }],
      ['refusal-gate branch (no reach inputs)', {}],
    ] as const) {
      it(`${branch}: ${label} -> an 8 mm pocket on 3 mm flutes still refuses on the flute length`, async () => {
        const response = await runWorker(pocket(overrides, extra))
        expect(response.type).toBe('TOOLPATH_ERROR')
        expect((response as { message: string }).message).toMatch(/exceeds available flute length 3\.000 mm/)
      })
    }
  }

  it('defined holder, undefined stickout: long flutes compute; the holder cannot be placed (unchanged from main)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = await runWorker(
        pocket({ fluteLength: 20, shankDiameter: 6, lengthBelowHolder: undefined }, { clearanceAllowanceMm: 0.25 }, HOLDER))
      expect(response.type).toBe('TOOLPATH_COMPLETE')
      expect(lowestZ((response as unknown as { moves: ToolpathMove[] }).moves)).toBeCloseTo(-DEPTH, 6)
    } finally {
      warn.mockRestore()
    }
  })
})

// ── 3D: the store's seam ─────────────────────────────────────────────────────

const STOCK_3D: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 10 }
const FLOOR_Z = STOCK_3D.maxZ - DEPTH
const SLAB = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 60, 0, 60, 60, 0, 0, 0, 1, 60, 0, 1, 0, 60, 1, 60, 60, 1]),
  indices: new Uint32Array([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
  ]),
}
const MOVES_3D: ToolpathMove[] = [
  { type: 'rapid', x: 30, y: 30, z: 15, role: 'rapid' },
  { type: 'feed', x: 30, y: 30, z: FLOOR_Z, feed: 300, role: 'plunge' },
  { type: 'feed', x: 40, y: 30, z: FLOOR_Z, feed: 1000, role: 'cut' },
]

function seam(operation: string, toolOverrides: Partial<Tool>, holder?: ToolHolder) {
  return trimToToolReachInPartFrame({
    operation, moves: MOVES_3D, tool: shortFluteTool(toolOverrides),
    ...(holder ? { holder } : {}),
    stockBounds: STOCK_3D, part: SLAB, partToleranceMm: 0.05, params: {}, workholding: [],
    noEarlierOperations: true,
  })
}

describe('WO-1626 review: 3D seam - the shank is still trimmed with no holder defined', () => {
  for (const operation of ['Parallel 3D', 'Pocket 2D']) {
    for (const [label, overrides] of [
      ['no holder, no stickout', NO_HOLDER],
      ['no holder, stickout defined', NO_HOLDER_WITH_STICKOUT],
    ] as const) {
      it(`${operation}, ${label}: trimmed, and the stop names the shank`, () => {
        const reach = seam(operation, overrides)
        expect(reach.trimmed).toBe(true)
        expect(reach.notices.some((n) => /the shank would come within/.test(n))).toBe(true)
        expect(lowestZ(reach.moves)).toBeGreaterThan(FLOOR_Z)
      })
    }
  }

  it('the defined holder still trims when the shank alone would not (holder + stickout defined)', () => {
    const reach = seam('Parallel 3D', { fluteLength: 20, shankDiameter: 6, lengthBelowHolder: 5 }, HOLDER)
    expect(reach.trimmed).toBe(true)
    expect(reach.notices.some((n) => /the holder would come within/.test(n))).toBe(true)
  })
})
