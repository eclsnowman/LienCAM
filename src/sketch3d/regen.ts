// Sketch3d <-> DOC regeneration integration (WO SKC-4, ruling 4).
//
// A Sketch3dDocument becomes an ordinary FeatureDag 'sketch' node
// (DagNodeKind already includes 'sketch' -- WO DOC-2, ruling: "Parameters are
// DAG nodes; dependents consume them via ORDINARY consumes edges -- no
// parallel dependency mechanism"). Its `consumes` edges are the parameter
// nodes referenced by its bound driving dimensions (dimensionBinding.ts's
// dimensionParameterRefs), so a parameter edit's dirty-closure
// (RegenScheduler.markDirty) reaches this node automatically, through the
// SAME shared scheduler DOC-4/DOC-5 already built -- no bespoke side channel,
// no second regeneration path (the WO's own AC #2).
//
// The interleaving invariant (ruling 4, standing rule) falls out of this for
// free: RegenScheduler.run() already serializes/cancels in-flight passes so a
// newer edit's committed value is what the final solve sees, never one
// staler than the newest committed table state -- see
// src/tests/sketch3d/interleaving.test.ts, which drives this executor
// through the same slow-op mock-gate seam DOC-4's own interleaving test used.
//
// This module is the WHOLE integration surface (mirrors params/executor.ts's
// makeParameterAwareExecutor exactly): scheduler.ts and dag.ts are read
// through their public API only, never forked/edited.

import { paramNodeId, type ElementMap, type FeatureDag, type FeatureOp } from '../doc'
import type { DagNodeSnapshot, RegenPassResult, RegenScheduler } from '../doc'
import type { Diag, ProfileRegion } from '../geom/geom-service'
import { isDatumPlanePayload, type DatumPlanePayload } from './datumPlane'
import { dimensionParameterRefs, evaluateDrivingDimensions, type Sketch3dDimensionDiagnostic } from './dimensionBinding'
import type { PlaneFrame } from './planeMath'
import { computeProfileRegions } from './regions'
import type { Sketch3dSolveService } from './solveService'
import type { Sketch3dDocument, Sketch3dSolveResult } from './types'

const PREFIX = 'sketch3d:'

/** A sketch3d document's FeatureDag node id -- namespaced so it can never
 *  collide with a bare feature/parameter id sharing the dag's single id
 *  namespace (mirrors params/node-id.ts's paramNodeId convention exactly). */
export function sketch3dNodeId(sketchId: string): string {
  return `${PREFIX}${sketchId}`
}

/** Inverse of sketch3dNodeId; undefined if `id` is not a sketch3d node id. */
export function sketch3dIdFromNodeId(id: string): string | undefined {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined
}

/** Legacy bookkeeping for fixed entities that old face-sketch entry auto-projected from the parent
 *  boundary. New explicit Project / Use copies are static and do not add this association. Degrade
 *  for the SOURCE face is
 *  entirely owned by the datum node's own `refs` (datumPlane.ts); this is
 *  never a second resolution mechanism, just "which entities in `document`
 *  came from projection, and which face they came from" for the UI/repair
 *  affordance to explain itself with. */
export interface Sketch3dExternalRef {
  sourceFaceId: string
  entityIds: string[]
}

/** The plain-JSON shape stored in a sketch3d node's DagNodeSnapshot.payload. */
export interface Sketch3dNodePayload extends Record<string, unknown> {
  document: Sketch3dDocument
  /** The most recent solve result (undefined until the node has executed once). */
  solveResult?: Sketch3dSolveResult
  /** Per-dimension expression-evaluation diagnostics from the most recent
   *  pass -- empty when every bound expression evaluated cleanly. */
  dimensionDiagnostics: Sketch3dDimensionDiagnostic[]
  /** WO SKC-5: the face-plane datum node (datumPlane.ts) this sketch is
   *  hosted on, if any -- a lab-only/origin-plane sketch has none. Bound as
   *  an ORDINARY `consumes` edge (see commitSketch3dDocument) so the datum's
   *  own dirty-closure (a moved/lost parent face) reaches this node exactly
   *  like any other upstream dependency -- never a second/parallel
   *  dependency mechanism. */
  planeNodeId?: string
  /** Legacy auto-projected parent-face-boundary entity association. */
  externalRefs: Sketch3dExternalRef[]
  /** WO SKC-5: the emitted ProfileRegion, recomputed every successful pass a
   *  plane-bound sketch resolves (see makeSketch3dExecutor) -- SAME field
   *  name/shape workbench/profileGeometry.ts's rectangle sketches already
   *  write, so extrude/revolve's executor (SolidsWorkbenchPage.tsx, which
   *  reads `sketchNode.payload.profile` off ANY 'sketch' node regardless of
   *  which flavor produced it) consumes a face-based sketch with ZERO
   *  changes to those dialogs. undefined while the sketch has no closed
   *  profile yet (mid-draw) or is not plane-bound. */
  profile?: ProfileRegion
  /** Every disjoint closed region in the solved sketch. The legacy `profile`
   * remains regions[0] so archives and features without an explicit region
   * selector keep their established geometry. */
  regions?: ProfileRegion[]
}

/** Input to commitSketch3dDocument for a plane-bound (face) sketch. Omit
 *  entirely for a lab-style local sketch with no parent plane. */
export interface Sketch3dPlaneBinding {
  planeNodeId: string
  externalRefs: Sketch3dExternalRef[]
}

export function asSketch3dPayload(payload: Record<string, unknown>): Sketch3dNodePayload {
  return payload as Sketch3dNodePayload
}

/** Reads a sketch3d node's payload, or undefined if `sketchId` isn't (yet) a node. */
export function sketch3dPayloadOf(dag: FeatureDag, sketchId: string): Sketch3dNodePayload | undefined {
  const node = dag.getNode(sketch3dNodeId(sketchId))
  if (!node || node.kind !== 'sketch') return undefined
  return asSketch3dPayload(node.payload)
}

/** Parameter-value resolver read directly off the shared dag -- the exact
 *  same pattern params/executor.ts's evaluateParameterNode uses to resolve
 *  ANOTHER parameter's value, applied here to resolve a dimension's refs. */
function paramLookup(dag: FeatureDag): (name: string) => { ok: true; value: number } | { ok: false } {
  return (name) => {
    const producer = dag.getNode(paramNodeId(name))
    if (!producer || producer.kind !== 'parameter') return { ok: false }
    const value = (producer.payload as { value?: unknown }).value
    return typeof value === 'number' ? { ok: true, value } : { ok: false }
  }
}

/** Wraps a dimension's ParamDiag as a frozen-contract Diag so it can travel
 *  inside an OpResult.diagnostics (geom-service.ts's DiagCode union cannot
 *  grow a sketch3d-specific code -- same toKernelDiag pattern DOC-4
 *  established). `params.dimensionId` disambiguates WHICH bound dimension the
 *  diagnostic belongs to; `params.paramCode` carries DOC-4's own typed code
 *  verbatim, unchanged, never re-derived. */
function toDimensionKernelDiag(nodeId: string, d: Sketch3dDimensionDiagnostic): Diag {
  return {
    code: 'KERNEL_OP_FAILED',
    severity: 'warning',
    params: { id: nodeId, dimensionId: d.constraintId, paramCode: d.diag.code, ...d.diag.params },
  }
}

const SOLVABLE: ReadonlySet<Sketch3dSolveResult['status']> = new Set(['success', 'redundant'])

/**
 * Builds the FeatureOp a RegenScheduler.run() pass drives for a sketch3d
 * node: re-evaluate every bound driving-dimension expression against the
 * dag's CURRENT parameter values, persist the result, then re-solve with
 * planegcs. A dimension-expression failure does NOT fail the whole op -- the
 * sketch stays solvable with that dimension's last-good value (AC #3) -- it
 * surfaces as a warning-severity diagnostic on this node instead. Only a
 * genuine solver failure/conflict fails the op (status 'failed').
 *
 * WO SKC-4-R1.2: `scheduler` is threaded in solely so this op can poll
 * scheduler.isCurrentPassCancelled() (a pure, read-only addition) immediately
 * before its own dag.setPayload write. Without this, a solve whose async
 * work (planegcs, or a test's deterministic op-gate) spans the moment a
 * newer edit cancels this pass would still commit its stale result directly
 * to the dag -- the scheduler's own chunk-boundary cancellation check (which
 * discards the OpResult and never applies an elementMap delta) cannot undo a
 * side effect this closure already made straight to the dag before
 * returning. Checked right before the write, after every await in this
 * function has already resolved, so nothing can flip cancelled between the
 * check and the write (both are synchronous, no yield in between).
 *
 * WO SKC-5: `map` is threaded in ONLY so a plane-bound sketch (payload has a
 * `planeNodeId`) can (a) recompute `profile` from the datum's current
 * `lastGoodFrame` after every successful solve -- the recon's own regen
 * ordering step 7 ("region extraction emits ProfileRegion with the datum
 * frame") -- and (b) independently re-resolve the datum's single-face ref
 * through the SAME ElementMap the datum's own executor used (datumPlane.ts),
 * so a lost parent face fails THIS node's op honestly (REFERENCE_UNRESOLVED,
 * status 'failed') instead of silently keeping a stale profile. This is a
 * SEPARATE, independent resolve call from the datum's own -- deliberately:
 * by the time this executor runs (sketch consumes datum, so datum always
 * executes first in topo order), `dag.getNode(planeNodeId).degraded` would
 * still read STALE (FeatureDag.regenerate() only runs once, AFTER the whole
 * executor loop, at the very end of RegenScheduler.pass()) -- re-resolving
 * against `map` directly is always CURRENT, never stale, and costs nothing
 * (ElementMap.resolve is a cheap pure lookup). A lab-only sketch (no `map`,
 * or no `planeNodeId`) skips all of this -- byte-identical to pre-SKC-5
 * behavior, zero cost, zero new failure mode.
 */
export function makeSketch3dExecutor(
  dag: FeatureDag,
  solveService: Sketch3dSolveService,
  scheduler: RegenScheduler,
  map?: ElementMap,
): FeatureOp {
  return async (node: DagNodeSnapshot) => {
    const payload = asSketch3dPayload(node.payload)
    const { document: evaluated, diagnostics } = evaluateDrivingDimensions(payload.document, paramLookup(dag))
    const solveResult = solveService.solve(evaluated)
    const solvable = SOLVABLE.has(solveResult.status)
    const solvedDocument = solvable ? { ...evaluated, entities: solveResult.entities } : evaluated

    const plane = resolvePlaneForSketch(dag, map, payload.planeNodeId)
    let profile: ProfileRegion | undefined
    let regions: ProfileRegion[] | undefined
    if (solvable && plane.frame !== undefined) {
      try {
        regions = await computeProfileRegions(solvedDocument, plane.frame)
        // Keep the pre-HOTEL-T4 implicit binding for old features while making
        // every region available to features that persist an explicit selector.
        profile = regions[0]
      } catch {
        // Open/branching profile (normal mid-draw state, chainEntitiesIntoLoops
        // fails loud on those) -- not a hard error, just "no profile yet".
        profile = undefined
        regions = undefined
      }
    }

    const nextPayload: Sketch3dNodePayload = {
      document: solvedDocument,
      solveResult,
      dimensionDiagnostics: diagnostics,
      planeNodeId: payload.planeNodeId,
      externalRefs: payload.externalRefs ?? [],
      profile,
      regions,
    }
    // A newer edit already superseded this pass -- the scheduler is about to
    // discard whatever we return, so skip the write entirely rather than
    // leave a stale payload behind for the superseding pass to (eventually,
    // maybe never, if nothing else dirties this node again) overwrite.
    if (scheduler.isCurrentPassCancelled()) {
      return { ok: false, diagnostics: [] }
    }
    dag.setPayload(node.id, nextPayload)

    const dimensionDiags = diagnostics.map((d) => toDimensionKernelDiag(node.id, d))
    if (!solvable) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'KERNEL_OP_FAILED',
            severity: 'error',
            params: { id: node.id, reason: solveResult.error ?? solveResult.status },
          },
          ...dimensionDiags,
        ],
      }
    }
    if (plane.lost) {
      return {
        ok: false,
        diagnostics: [
          { code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { id: node.id, planeNodeId: payload.planeNodeId ?? '' } },
          ...dimensionDiags,
        ],
      }
    }
    return { ok: true, diagnostics: dimensionDiags }
  }
}

/** Resolves a plane-bound sketch's current frame + whether its parent face
 *  is currently lost, per this function's own header above. Returns
 *  `{frame: undefined, lost: false}` for a lab-only sketch (no planeNodeId)
 *  or one whose datum has never resolved a frame yet (first pass ordering,
 *  or the datum itself failed outright). */
function resolvePlaneForSketch(dag: FeatureDag, map: ElementMap | undefined, planeNodeId: string | undefined): { frame: PlaneFrame | undefined; lost: boolean } {
  if (planeNodeId === undefined) return { frame: undefined, lost: false }
  const planeNode = dag.getNode(planeNodeId)
  if (planeNode === undefined || !isDatumPlanePayload(planeNode.payload)) return { frame: undefined, lost: false }
  const datumPayload = planeNode.payload as DatumPlanePayload
  let lost = false
  if (map !== undefined) {
    const ref = planeNode.refs.find((r) => r.kind === 'single-face')
    if (ref !== undefined) lost = map.resolve(ref.id, ref.kind).status === 'lost'
  }
  return { frame: datumPayload.lastGoodFrame, lost }
}

/**
 * Creates (if new) or updates (if it already exists) `document`'s sketch3d
 * node, rewires its `consumes` edges to exactly the parameters its bound
 * dimensions currently reference, and drives a fresh regeneration of its
 * downstream closure through the shared RegenScheduler -- the same
 * markDirty+run(executor) sequence params/table.ts's setExpression uses (no
 * bespoke side channel, per AC #2).
 *
 * WO SKC-4-R1.1: a bound dimension whose expression references a parameter
 * that does not exist (e.g. "2*missing") makes this node's own `consumes`
 * edge point at a nonexistent producer. The shared scheduler's DOC-4-R1.1
 * firstMissingUpstream isolation therefore degrades this WHOLE node and
 * skips makeSketch3dExecutor entirely (scheduler.ts's pass(), BEFORE the
 * kernel op is even called) -- makeSketch3dExecutor is the ONLY place that
 * writes dimensionDiagnostics, so without this, a user sees "sketch
 * degraded" and nothing naming WHICH dimension is wrong or why. Evaluating
 * every bound dimension here too -- reusing evaluateDrivingDimensions
 * verbatim, the SAME pure/cheap function the executor itself calls, against
 * the dag's CURRENT parameter state -- means the typed per-dimension
 * diagnostic (constraintId + PARAM_UNKNOWN_REFERENCE) survives even when the
 * scheduler goes on to degrade the node afterward. This does not fork or
 * bypass the scheduler: the degrade-before-kernel-op path is untouched, and
 * once the missing parameter is created the ordinary markDirty/run healing
 * path (below) still re-executes this node and the executor's own pass
 * recomputes the SAME diagnostics fresh (never stale, never a second source
 * of truth -- `document`'s constraint values are left exactly as given;
 * only dimensionDiagnostics is derived here).
 *
 * WO SKC-5: `planeBinding` (omit for a lab-only local sketch) additionally
 * `consumes` the given datum node -- an ORDINARY consumes edge, exactly like
 * a bound dimension's parameter -- so RegenScheduler.markDirty's downstream
 * closure reaches this node whenever the datum's own upstream (the parent
 * face's owning feature) changes. Omitting `planeBinding` on a later call
 * against an EXISTING plane-bound sketch (e.g. a plain constraint edit that
 * doesn't touch the plane) PRESERVES the node's current binding rather than
 * silently dropping it -- callers that only ever mutate `document` never
 * need to re-pass the binding on every call.
 */
export async function commitSketch3dDocument(
  dag: FeatureDag,
  scheduler: RegenScheduler,
  executor: FeatureOp,
  document: Sketch3dDocument,
  planeBinding?: Sketch3dPlaneBinding,
): Promise<RegenPassResult> {
  const id = sketch3dNodeId(document.id)
  const existing = dag.has(id) ? asSketch3dPayload(dag.getNode(id)!.payload) : undefined
  const planeNodeId = planeBinding ? planeBinding.planeNodeId : existing?.planeNodeId
  const externalRefs = planeBinding ? planeBinding.externalRefs : (existing?.externalRefs ?? [])
  const consumes = [...dimensionParameterRefs(document).map(paramNodeId), ...(planeNodeId !== undefined ? [planeNodeId] : [])]
  const { diagnostics } = evaluateDrivingDimensions(document, paramLookup(dag))
  const payload: Sketch3dNodePayload = { document, dimensionDiagnostics: diagnostics, planeNodeId, externalRefs }
  if (dag.has(id)) {
    dag.setConsumes(id, consumes)
    dag.setPayload(id, payload)
  } else {
    dag.insertNode({ id, kind: 'sketch', consumes, payload })
  }
  scheduler.markDirty(id)
  return scheduler.run(executor)
}
