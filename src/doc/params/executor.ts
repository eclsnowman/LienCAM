// Parameter-aware FeatureOp composition (DOC lane, WO DOC-4, ruling 2).
//
// "Parameters are DAG NODES; dependents consume them via ordinary DAG edges."
// A parameter node is regenerated through the EXACT SAME RegenScheduler pass
// as any feature node (WO DOC-5) -- there is no second/parallel regeneration
// path. This module supplies the one thing the scheduler needs that DOC-5
// did not build: a FeatureOp that knows how to "execute" a parameter node
// (recompute its expression) versus any other kind (delegate to the real/
// mock kernel FeatureOp the document/test provides). Composing this wrapper
// is the whole integration surface; scheduler.ts itself is untouched.
//
// Failure isolation for parameters reuses the scheduler's EXISTING upstream-
// failure isolation for free: if parameter A's own evaluation fails (typed
// diagnostic, status 'failed'), any node B that consumes A -- another
// parameter OR a feature -- is degraded by the scheduler's own
// firstFailedUpstream() check BEFORE B's op is ever called, exactly as it
// already does for a failed feature (WO DOC-5 AC #3). Nothing here
// special-cases "parameter vs feature" for that part.
//
// Idempotence note (mirrors DOC-5's own documented assumption in
// scheduler.ts): evaluateParameterNode's dag.setPayload call is a side effect
// that runs to completion inside one executor() call. It is never torn down
// mid-flight by the scheduler's cancellation (that only discards an
// in-flight node's RESULT at the next chunk boundary; a parameter op has no
// internal await, so it cannot straddle a chunk boundary). Even in the
// pathological case of a test gating a parameter op artificially, a stray
// extra write is harmless: recomputation is a pure function of already-
// committed upstream values, so the next full pass overwrites it with the
// correct value regardless.

import type { Diag, OpResult } from '../../geom/geom-service'
import type { DagNodeSnapshot, FeatureDag } from '../dag'
import type { FeatureOp } from '../regen'
import { evaluate } from './evaluator'
import { paramNodeId } from './node-id'
import type { ParamAst, ParamDiag, ParamDiagCode } from './types'

/** The plain-JSON shape stored in a parameter node's DagNodeSnapshot.payload. */
export interface ParameterPayload extends Record<string, unknown> {
  name: string
  expression: string
  ast: ParamAst
  /** Last successfully computed value (mm). Retained ("last-good") across an
   *  evaluation failure -- never overwritten with NaN/garbage/deleted. */
  value: number
}

export function asParameterPayload(payload: Record<string, unknown>): ParameterPayload {
  return payload as ParameterPayload
}

/** Wraps a ParamDiag as a frozen-contract Diag so it can travel inside an
 *  OpResult.diagnostics (geom-service.ts's DiagCode union cannot grow a
 *  parameter-specific code). The real code survives, structured, in
 *  params.paramCode -- never string-parsed by a reader (see paramDiagFromDiag). */
export function toKernelDiag(nodeId: string, diag: ParamDiag): Diag {
  return { code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, paramCode: diag.code, ...diag.params } }
}

const PARAM_DIAG_CODES: ReadonlySet<string> = new Set<ParamDiagCode>([
  'PARAM_SYNTAX_ERROR',
  'PARAM_UNKNOWN_REFERENCE',
  'PARAM_DIVISION_BY_ZERO',
  'PARAM_SELF_REFERENCE',
  'PARAM_CYCLE',
  'PARAM_UNKNOWN_FUNCTION',
  'PARAM_MATH_DOMAIN',
])

/** Recovers the structured ParamDiag from a Diag produced by toKernelDiag,
 *  or undefined if `diag` did not come from this module (e.g. UPSTREAM_FAILED,
 *  a scheduler-originated diagnostic on a dependent, not this parameter's own). */
export function paramDiagFromDiag(diag: Diag): ParamDiag | undefined {
  const paramCode = diag.params?.paramCode
  if (typeof paramCode !== 'string' || !PARAM_DIAG_CODES.has(paramCode)) return undefined
  const { paramCode: _drop, ...rest } = diag.params as Record<string, string>
  return { code: paramCode as ParamDiagCode, severity: 'error', params: rest }
}

async function evaluateParameterNode(dag: FeatureDag, node: DagNodeSnapshot): Promise<OpResult> {
  const payload = asParameterPayload(node.payload)
  const result = evaluate(payload.ast, (name) => {
    const producer = dag.getNode(paramNodeId(name))
    if (!producer || producer.kind !== 'parameter') return { ok: false }
    return { ok: true, value: asParameterPayload(producer.payload).value }
  })
  if (!result.ok) {
    return { ok: false, diagnostics: [toKernelDiag(node.id, result.diag)] }
  }
  dag.setPayload(node.id, { ...payload, value: result.value })
  return { ok: true, diagnostics: [] }
}

/**
 * Combines parameter recomputation with `kernelOp` (the real/mock geometry
 * worker seam for every non-parameter node) into the ONE executor a
 * RegenScheduler.run() pass drives. This is the entire integration point --
 * a document/test wires its own kernel FeatureOp in, and every parameter
 * node in the dirty closure recomputes automatically alongside it.
 */
export function makeParameterAwareExecutor(dag: FeatureDag, kernelOp: FeatureOp): FeatureOp {
  return async (node) => {
    if (node.kind === 'parameter') return evaluateParameterNode(dag, node)
    return kernelOp(node)
  }
}
