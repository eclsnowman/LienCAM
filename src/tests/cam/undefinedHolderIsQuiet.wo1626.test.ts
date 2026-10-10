// WO-1626 - an undefined holder (or stickout) is the operator's decision, and
// the computed toolpath ships quietly: no console line, notice, badge or
// status about it, on any operation, 2D or 3D. Every check that HAS its data
// still runs and still reports what it finds, so the SAME shape of job with a
// holder the operator DID define, and that genuinely collides, still refuses.
//
// Operator, 2026-09-16 (chat): "A user may not define their holder. So he can't
// have that be a blocker because it isn't defined. It's a recommendation to
// define it to look for collision issues, but it can't not do its work because
// it hasn't been defined. And we don't have to nag the user for everything
// they don't do. Things they don't do which could have ramifications for them
// is a decision they make, not us."
//
// Driven through the PRODUCTION compute path on both sides: the real worker
// entry point (self.onmessage in toolpathWorker.ts) for the 2D Pocket, and the
// real 3D operation adapter (computeParallel3dMoves) for Parallel 3D - the same
// entry points the app itself calls, not the gate function in isolation.

import { describe, expect, it, vi } from 'vitest'

import type {
  HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove,
} from '../../types'
import type {
  LoopData, PocketParams, PocketWorkerPayload, ToolpathStockBlock,
  WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import {
  computeParallel3dMoves,
  DEFAULT_PARALLEL3D_PARAMS,
} from '../../cam3d/integration/parallel3dOperation'
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { Box3 } from '../../cam3d/stock'
import type { Cam3dClient } from '../../cam3d/worker/client'
import type { IrMove } from '../../cam3d/ir/types'

// ── Shared tool/holder shape, matching WO-276/WO-278's own fixtures ─────────
// A short stickout under a real holder collides with an 8 mm deep pocket
// (the holder segment starts 5 mm above the tip and runs to 45 mm - well past
// the 8 mm depth); the same tool with no holder, or no stickout, has nothing
// of that shape for the check to report at all.

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 5, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 1.5 },
    },
    ...overrides,
  } as unknown as Tool
}

const POCKET_DEPTH_MM = 8

// ── Pocket 2D, through the real worker entry point ───────────────────────────

const STOCK: ToolpathStockBlock = { min: { x: 0, y: 0, z: -10 }, max: { x: 60, y: 60, z: 0 } }

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -POCKET_DEPTH_MM, bottomHeightMode: 'absolute',
} as unknown as HeightParams

const PASSES: PassParams = {
  stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0,
} as unknown as PassParams

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as unknown as LinkingParams

const POCKET_PARAMS: PocketParams = {
  geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
  fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
  helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
}

const POCKET_LOOP: LoopData = {
  id: 'loop-1', closed: true, type: 'contour',
  points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
}

type WorkerHandler = (event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void
let handler: WorkerHandler | undefined
const posted: WorkerResponseMsg[] = []

async function bootWorker(): Promise<WorkerHandler> {
  if (handler) return handler
  // toolpathWorker.ts installs self.onmessage at import and answers through
  // self.postMessage; node has no `self`, so stand one up and import the
  // module exactly as the worker runtime would.
  ;(globalThis as unknown as Record<string, unknown>).self = {
    set onmessage(fn: WorkerHandler) { handler = fn },
    postMessage: (message: WorkerResponseMsg) => { posted.push(message) },
  }
  await import('../../lib/cam/toolpathWorker')
  if (!handler) throw new Error('toolpathWorker.ts installed no self.onmessage')
  return handler
}

/** Post one request and return the terminal response (progress is not one). */
async function runWorker(message: unknown): Promise<WorkerResponseMsg> {
  const run = await bootWorker()
  posted.length = 0
  await run({ data: message } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal, 'the worker posted no terminal response').toHaveLength(1)
  return terminal[0]
}

function pocketRequest(toolOverrides: Partial<Tool>, holder?: ToolHolder): unknown {
  return {
    type: 'COMPUTE_POCKET',
    payload: {
      opId: 'op-1', setupId: 'setup-1',
      params: POCKET_PARAMS, heights: HEIGHTS, passes: PASSES, linking: LINKING,
      tool: tool(toolOverrides),
      loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
      ...(holder !== undefined ? { holder } : {}),
      stockBlock: STOCK,
    } satisfies PocketWorkerPayload,
  }
}

describe('WO-1626 Pocket 2D: an undefined holder or stickout computes quietly', () => {
  it('produces a ready result and no console line for a tool with no holder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = await runWorker(pocketRequest({ holderId: undefined }))
      expect(response.type).toBe('TOOLPATH_COMPLETE')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('produces a ready result and no console line for a holder with no stickout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = await runWorker(pocketRequest({ lengthBelowHolder: undefined }, HOLDER))
      expect(response.type).toBe('TOOLPATH_COMPLETE')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('still refuses the SAME shape of job once a defined holder actually collides', async () => {
    const response = await runWorker(pocketRequest({}, HOLDER))
    expect(response.type).toBe('TOOLPATH_ERROR')
    const message = (response as { message: string }).message
    expect(message).toMatch(/the holder would hit the stock/)
  })
})

// ── Parallel 3D, through the real operation adapter and the real seam ───────
//
// WO-1678 moved the 3D holder/shank check out of the adapter and onto ONE seam
// (store/toolReachInputs.ts trimToToolReachInPartFrame) that every 3D strategy's
// moves are trimmed through; the adapter itself no longer takes a holder or a
// stock block, never refuses, and its result carries no holderClearanceWarning.
// So the quiet-vs-collides proof now drives the real adapter for the moves and
// the real seam for the check, exactly as the store calls them in sequence.

const PART_MESH: PartMesh = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 60, 10]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [60, 60, 10] },
  source: 'fixture',
}

const STOCK_3D: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 10 }
const FLOOR_Z = STOCK_3D.maxZ - POCKET_DEPTH_MM

/** A closed 60 x 60 x 1 mm slab at the bottom of the block, clear of the floor
 *  cut at FLOOR_Z - so only the stock block, not the part, can stop the holder
 *  (same fixture as src/tests/cam3d/holderClearance3d.wo278.test.ts). */
const SLAB = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 60, 0, 60, 60, 0, 0, 0, 1, 60, 0, 1, 0, 60, 1, 60, 60, 1]),
  indices: new Uint32Array([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
  ]),
}

const IR_MOVES: IrMove[] = [
  { t: 'rapid', x: 30, y: 30, z: 15, role: 'rapid' },
  { t: 'feed', x: 30, y: 30, z: FLOOR_Z, role: 'plunge' },
  { t: 'feed', x: 40, y: 30, z: FLOOR_Z, role: 'cut' },
]

function parallelClient(): Cam3dClient {
  return {
    generateParallelFinish: async () => ({
      moves: IR_MOVES,
      meta: { strategyId: 'parallel_finish', cutterId: 'wo1626' },
    }),
  } as unknown as Cam3dClient
}

function parallelJob(toolOverrides: Partial<Tool>) {
  return computeParallel3dMoves({
    partMesh: PART_MESH,
    tool: tool(toolOverrides),
    params: { ...DEFAULT_PARALLEL3D_PARAMS },
    resolvedHeights: {
      clearanceZ: 15, retractZ: 12, feedZ: 12, topZ: 10, bottomZ: 0, stockTopZ: STOCK_3D.maxZ,
    },
    client: parallelClient(),
  })
}

/** The store's seam, as every 3D compute calls it straight after its strategy. */
function seam(moves: readonly ToolpathMove[], toolOverrides: Partial<Tool>, holder?: ToolHolder) {
  return trimToToolReachInPartFrame({
    operation: 'Parallel 3D',
    moves,
    tool: tool(toolOverrides),
    ...(holder !== undefined ? { holder } : {}),
    stockBounds: STOCK_3D,
    part: SLAB,
    partToleranceMm: 0.05,
    params: {},
    workholding: [],
    noEarlierOperations: true,
  })
}

describe('WO-1626 Parallel 3D: an undefined holder or stickout computes quietly', () => {
  it('produces a ready result and no holder notice for a tool with no holder', async () => {
    const { moves } = await parallelJob({ holderId: undefined })
    const reach = seam(moves, { holderId: undefined })
    expect(reach.moves).toEqual(moves)
    expect(reach.notices).toEqual([])
    expect(reach.uncheckedLimits).toEqual([])
  })

  it('produces a ready result and no holder notice for a holder with no stickout', async () => {
    const { moves } = await parallelJob({ lengthBelowHolder: undefined })
    const reach = seam(moves, { lengthBelowHolder: undefined }, HOLDER)
    expect(reach.moves).toEqual(moves)
    expect(reach.notices).toEqual([])
    expect(reach.uncheckedLimits).toEqual([])
  })

  it('still trims the SAME shape of job once a defined holder actually collides (WO-1678: trimmed, not refused)', async () => {
    const { moves } = await parallelJob({})
    const reach = seam(moves, {}, HOLDER)
    expect(reach.notices.some((notice) => /the holder would come within/.test(notice))).toBe(true)
  })
})
