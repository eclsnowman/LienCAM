// WO INT-4A-R1 (R1.1): extrude distance / revolve angle as DRIVING values --
// editable, expression-capable, re-evaluated on every regen pass -- the SAME
// edit-time-reject / eval-time-last-good contract src/sketch3d/dimensionBinding.ts
// already proved for sketch dimensions, reusing the SAME DOC-4 parser/
// evaluator that module itself wraps (../../../doc's public barrel -- no
// re-implementation of expression parsing, no forked semantics). This module
// is the model3d-side instantiation of that framework: an extrude/revolve
// FeatureDag 'feature' node's plain payload field (distance/angleDeg) is not
// a Sketch3dConstraint, so dimensionBinding.ts's own API can't type-check
// against it directly -- this is the minimal adapter, not a parallel engine.

import type { Diag } from '../../../geom/geom-service'
import {
  evaluate,
  paramNodeId,
  parseExpression,
  ParamParseError,
  type DagNodeSnapshot,
  type FeatureDag,
  type ParamDiag,
  type ParamLookup,
} from '../../../doc'

export interface FeatureExpressionValidation {
  ok: boolean
  diag?: ParamDiag
}

/** Edit-time validation only (mirrors bindDimensionExpression): a malformed
 *  expression is rejected immediately, before anything commits to the DAG. */
export function validateFeatureExpression(source: string): FeatureExpressionValidation {
  try {
    parseExpression(source)
    return { ok: true }
  } catch (e) {
    if (e instanceof ParamParseError) return { ok: false, diag: e.diagnostic }
    throw e
  }
}

/** Parameter names a bound expression references, sorted+deduped -- the set
 *  a feature node must ALSO `consumes` (alongside its sketch input) so a
 *  parameter edit's dirty-closure (RegenScheduler.markDirty) reaches it,
 *  exactly like dimensionParameterRefs does for a sketch3d node. */
export function featureExpressionRefs(expression: string | undefined): string[] {
  if (expression === undefined || expression.trim() === '') return []
  const refs = new Set(parseExpression(expression).refs)
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** `featureExpressionRefs`, already mapped to parameter node ids -- the
 *  extra `consumes` entries a dialog should union with its sketch input. */
export function featureExpressionParamConsumes(expression: string | undefined): string[] {
  return featureExpressionRefs(expression).map(paramNodeId)
}

/** Parameter-value resolver read directly off the shared dag -- the exact
 *  same pattern params/executor.ts and sketch3d/regen.ts already use to
 *  resolve a bound expression's references. */
function paramLookup(dag: FeatureDag): ParamLookup {
  return (name) => {
    const producer = dag.getNode(paramNodeId(name))
    if (producer === undefined || producer.kind !== 'parameter') return { ok: false }
    const value = (producer.payload as { value?: unknown }).value
    return typeof value === 'number' ? { ok: true, value } : { ok: false }
  }
}

/** Wraps a ParamDiag as a frozen-contract Diag (geom-service.ts's DiagCode
 *  cannot grow a feature-dimension-specific code) -- same toKernelDiag
 *  pattern params/executor.ts and sketch3d/regen.ts both already use. */
function toFeatureDimensionDiag(nodeId: string, field: string, diag: ParamDiag): Diag {
  return { code: 'KERNEL_OP_FAILED', severity: 'warning', params: { id: nodeId, field, paramCode: diag.code, ...diag.params } }
}

export interface DrivenFieldResult {
  value: number
  /** Present only when the bound expression FAILED to evaluate this pass --
   *  `value` is then the retained last-good number, never 0/NaN/dropped. */
  diag?: Diag
}

/**
 * Re-evaluates `field`'s bound expression (if any) against the shared dag's
 * CURRENT parameter values, persists a successful result back into the
 * node's payload (so it "replays": every regen pass re-reads live parameter
 * state, never a value captured once at Apply-time), and reports a warning
 * diagnostic (last-good value retained) on eval failure -- mirrors
 * evaluateDrivingDimensions's own success/failure split exactly. A feature
 * with no bound expression for `field` returns its literal payload value
 * unchanged (byte-identical to this WO's pre-R1.1 behavior).
 */
export function resolveDrivenField(dag: FeatureDag, node: DagNodeSnapshot, field: string): DrivenFieldResult {
  const payload = node.payload
  const literal = payload[field] as number
  const expression = payload.expression as string | undefined
  if (expression === undefined || expression.trim() === '') return { value: literal }
  const { ast } = parseExpression(expression)
  const result = evaluate(ast, paramLookup(dag))
  if (!result.ok) return { value: literal, diag: toFeatureDimensionDiag(node.id, field, result.diag) }
  if (result.value !== literal) dag.setPayload(node.id, { ...payload, [field]: result.value })
  return { value: result.value }
}
