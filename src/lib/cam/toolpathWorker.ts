// Web Worker — toolpath computation.
// Runs on a separate thread so the UI never freezes during computation.
// Vite builds this as a module worker via:
//   new Worker(new URL('./toolpathWorker.ts', import.meta.url), { type: 'module' })

import { buildContourToolpath }  from './contour2d'
import { buildPocketToolpath }   from './pocket2d'
import { buildDrillToolpath }    from './drill2d'
import { buildBoreToolpath }     from './bore2d'
import { buildChamferToolpath }  from './chamfer2d'
import { buildFaceToolpath }     from './face2d'
import { buildEngraveToolpath }  from './engrave2d'
import { buildVCarveToolpath, ensureVCarveClipperReady } from './vcarve2d'
import { buildThreadMillToolpath } from './threadmill2d'
import { ensureClipperReady }    from './face2d/clipperOffset'
import {
  checkHolderClearanceForToolpath,
  operationLabelForRequestType,
  trimToolpathToToolReach,
  wantsToolReachTrim,
  type OperationReachShortfall,
  type ToolReachInputs,
} from './holderClearanceGate'
import type { ToolpathWorkerRequestType } from './operationManifest'
import type { WorkerRequestMsg, WorkerResponseMsg } from './types'
import type { ToolpathMove } from '../../types'
import { resolveFeedrates } from './feedrates'

/** Progress reporter threaded into every builder (fraction 0..1 + phase). */
type ProgressReporter = (fraction: number, phase?: string) => void
/** Operator notice sink — what the generator substituted, fell back to or left out. */
type NoticeSink = (message: string) => void

/**
 * WO-1819. The worker's dispatch, as ONE table instead of the eleven-arm
 * if/else chain it replaces. Keyed by ToolpathWorkerRequestType, which is
 * derived from the WorkerRequestMsg union in types.ts, so adding a COMPUTE_*
 * request without an arm here is a COMPILE ERROR (`npm run build`) - the same
 * narrow exhaustiveness pattern the operation manifest uses against
 * OperationType. Each arm is its old branch verbatim, prerequisite warm-up
 * (clipper) included and in the same order, so no computation changes.
 *
 * The builders stay HERE rather than in operationManifest.ts on purpose: the
 * store imports the manifest, and naming these engines there would statically
 * pull every CAM builder into the main bundle.
 */
const TOOLPATH_BUILDERS = {
  COMPUTE_CONTOUR: async (payload, onProgress) => {
    // Contour roughing/finish offsets use clipper2 (robust self-overlap trim on
    // square/collinear corners that the miter offset leaves untrimmed); load it
    // once before computing. Cheap after the first call. buildContourToolpath
    // stays synchronous (offsetLoop is sync once clipper is ready).
    await ensureClipperReady()
    return buildContourToolpath(payload, onProgress)
  },
  COMPUTE_POCKET: async (payload, onProgress, notify) => {
    await ensureClipperReady()
    return buildPocketToolpath(payload, onProgress, notify)
  },
  COMPUTE_DRILL: (payload, onProgress) => buildDrillToolpath(payload, onProgress),
  COMPUTE_BORE: (payload, onProgress, notify) => buildBoreToolpath(payload, onProgress, notify),
  COMPUTE_CHAMFER: (payload, onProgress, notify) => buildChamferToolpath(payload, onProgress, notify),
  COMPUTE_FACE: async (payload, onProgress) => {
    // Face ring patterns (offset/spiral) use clipper2 for robust inward
    // offsetting; load it once before computing. Cheap after the first call.
    await ensureClipperReady()
    return buildFaceToolpath(payload, onProgress)
  },
  // Engrave/Trace offsets use the pure geometry helpers — no clipper needed.
  COMPUTE_ENGRAVE: (payload, onProgress) => buildEngraveToolpath(payload, onProgress),
  COMPUTE_VCARVE: async (payload, onProgress) => {
    // V-carve welds and offsets regions with its own clipper wrapper; the
    // flat-clearing role hands the floor to the pocket engine (face2d clipper).
    await ensureVCarveClipperReady()
    await ensureClipperReady()
    return buildVCarveToolpath(payload, onProgress)
  },
  // Thread milling: pure helix + lead arcs, no clipper. Builder fails loud
  // (ADR-0003) on orphaned holes / out-of-scope params / tool-too-big.
  COMPUTE_THREAD_MILL: (payload, onProgress) => buildThreadMillToolpath(payload, onProgress),
  COMPUTE_ADAPTIVE_CLEARING: async (payload, onProgress, notify) => {
    // FreeCAD-port engine (Phase 6). Async: the engine inits clipper2-wasm on first
    // use. Replaces the old planner under ./adaptiveClearing2d (retired, left unwired).
    const { buildAdaptiveClearingToolpath } = await import('./adaptiveClearing2d/engine')
    return buildAdaptiveClearingToolpath(payload, onProgress, notify)
  },
} satisfies {
  [T in ToolpathWorkerRequestType]: (
    payload: Extract<WorkerRequestMsg, { type: T }>['payload'],
    onProgress: ProgressReporter,
    notify: NoticeSink,
  ) => ToolpathMove[] | Promise<ToolpathMove[]>
}

/**
 * WO-1540. TOOLPATH_COMPLETE as this worker posts it: beside the moves, the
 * operator notices - short plain sentences saying what the generator did instead
 * of what was asked (substituted, fell back, left out, stopped early). Absent
 * when there is nothing to say. The store writes them to the app console.
 * WO-1683: `reachShortfall` rides the same way - the fact the reach trim stopped
 * this operation short, for the store to carry onto the operation itself.
 */
export type ToolpathCompleteWithNotices =
  Extract<WorkerResponseMsg, { type: 'TOOLPATH_COMPLETE' }> &
  { notices?: string[]; reachShortfall?: OperationReachShortfall }

console.log('[toolpathWorker] module loaded')

self.onmessage = async (event: MessageEvent<WorkerRequestMsg>) => {
  const msg = event.data
  const t0  = performance.now()

  // NEST runs on the SAME transport but produces placements, not moves, and keys
  // its response by nestId. Handle it FIRST so the rest of the body narrows to the
  // toolpath request types (whose payloads carry opId for onProgress below).
  if (msg.type === 'COMPUTE_NEST') {
    try {
      const { runNest } = await import('./nesting')
      const res = await runNest({
        parts: msg.payload.parts,
        sheet: msg.payload.sheet,
        style: msg.payload.style,
        spacing: msg.payload.spacing,
        solver: msg.payload.solver,
        seed: msg.payload.seed,
        rotationCount: msg.payload.rotationCount,
        timeBudgetMs: msg.payload.timeBudgetMs,
        curveTolerance: msg.payload.curveTolerance,
      })
      const done: WorkerResponseMsg = {
        type: 'NEST_COMPLETE',
        nestId: msg.payload.nestId,
        placements: res.placements,
        unplaced: res.unplaced,
        utilization: res.utilization,
        sheetUsed: res.sheetUsed,
        computeTimeMs: Math.round(performance.now() - t0),
      }
      self.postMessage(done)
    } catch (err) {
      console.error('[toolpathWorker] nest error:', err)
      const fail: WorkerResponseMsg = {
        type: 'NEST_ERROR',
        nestId: msg.payload.nestId,
        message: err instanceof Error ? err.message : String(err),
      }
      self.postMessage(fail)
    }
    return
  }

  // Progress callback threaded into each builder. Builders are synchronous, but
  // self.postMessage mid-run still reaches the main thread. Throttle to >=1%
  // advance or a phase change so a fine-grained builder cannot flood the main
  // thread with re-renders.
  let lastPosted = -1
  let lastPhase: string | undefined
  const onProgress = (fraction: number, phase?: string) => {
    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
    if (clamped - lastPosted < 0.01 && phase === lastPhase && clamped < 1) return
    lastPosted = clamped
    lastPhase  = phase
    const progressMsg: WorkerResponseMsg = {
      type: 'TOOLPATH_PROGRESS',
      opId: msg.payload.opId,
      progress: clamped,
      phase,
    }
    self.postMessage(progressMsg)
  }

  const notices: string[] = []
  const notify = (message: string) => { notices.push(message) }

  try {
    // WO-1819: ONE lookup over TOOLPATH_BUILDERS, replacing the eleven-arm
    // if/else chain. A request type with no arm still fails loud with the same
    // message it always did — a table miss is the only way to reach it now.
    if (!Object.prototype.hasOwnProperty.call(TOOLPATH_BUILDERS, msg.type)) {
      throw new Error(`Unknown worker message type: ${(msg as { type: string }).type}`)
    }
    // The table's key already picked the arm that matches this payload; the
    // checker cannot follow that across a union index, so the payload is handed
    // over untyped here and typed exactly inside each arm above.
    const build = TOOLPATH_BUILDERS[msg.type] as
      (p: unknown, onProgress: ProgressReporter, notify: NoticeSink) => ToolpathMove[] | Promise<ToolpathMove[]>
    let moves = await build(msg.payload, onProgress, notify)

    // WO-276 holder/shank crash guard. ONE call, on the single path every
    // strategy's response leaves through, so a strategy added tomorrow is
    // guarded the day it is added — the opposite of assertToolFluteReach's six
    // per-strategy call sites. A collision is a refusal (ADR-0003): the moves
    // are physically unrunnable, so they never reach the operation.
    //
    // WO-1565: a request that carries the PART is instead trimmed to what the
    // tool assembly reaches - the neck, shank and holder kept clear of the part
    // and the remaining stock, the cut stopped short where they would rub, and
    // the console told what was left uncut. Nothing is refused on that path.
    //
    // WO-1571: the store puts the clearance on every request (and the part when
    // the operation computes from a model body), so every operation in the app
    // is trimmed; a job with no part is trimmed against the stock. Only a
    // request carrying neither - a hand-built payload - still takes the refusal.
    //
    // WO-1575: a request carrying workholding is trimmed too - the jaws and clamps
    // are a third obstacle nothing of the tool, cutter included, comes near.
    const reachInputs = msg.payload as ToolReachInputs
    let reachShortfall: OperationReachShortfall | undefined
    if (wantsToolReachTrim(reachInputs)) {
      const reach = trimToolpathToToolReach({
        operation: operationLabelForRequestType(msg.type),
        moves,
        tool: msg.payload.tool,
        plungeRate: resolveFeedrates(msg.payload.tool, msg.payload.feedrateOverride).plungeRate,
        holder: msg.payload.holder,
        stockBlock: msg.payload.stockBlock,
        clearancePart: reachInputs.clearancePart,
        remainingStock: reachInputs.remainingStock,
        noEarlierOperations: reachInputs.noEarlierOperations,
        clearanceAllowanceMm: reachInputs.clearanceAllowanceMm,
        workholding: reachInputs.workholding,
        wcsLabel: reachInputs.wcsLabel,
      })
      moves = [...reach.moves]
      reachShortfall = reach.shortfall
      for (const notice of reach.notices) notify(notice)
      for (const limit of reach.uncheckedLimits) console.warn(`[toolpathWorker] ${limit}`)
    } else {
      const clearance = checkHolderClearanceForToolpath({
        operation: operationLabelForRequestType(msg.type),
        moves,
        tool: msg.payload.tool,
        holder: msg.payload.holder,
        stockBlock: msg.payload.stockBlock,
      })
      if (clearance.status === 'collision') throw new Error(clearance.message)
      if (clearance.status === 'not-checked') console.warn(`[toolpathWorker] ${clearance.message}`)
    }

    const response: ToolpathCompleteWithNotices = {
      type: 'TOOLPATH_COMPLETE',
      opId: msg.payload.opId,
      moves,
      computeTimeMs: Math.round(performance.now() - t0),
      ...(notices.length > 0 ? { notices } : {}),
      ...(reachShortfall ? { reachShortfall } : {}),
    }
    self.postMessage(response)
  } catch (err) {
    console.error('[toolpathWorker] error:', err)
    const response: WorkerResponseMsg = {
      type: 'TOOLPATH_ERROR',
      opId: msg.payload.opId,
      message: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
