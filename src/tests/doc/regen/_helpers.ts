// Shared fixtures for the regeneration-scheduler tests (WO DOC-5).
// Not a *.test.ts file, so vitest's include glob never runs it directly.

import type { Diag, ElementMapDelta, GeometrySnapshot, StableId } from '../../../geom/geom-service'
import type { DagNodeSnapshot } from '../../../doc/dag'
import type { FeatureOp } from '../../../doc/regen'

/** A planar face snapshot (the only surface type these scheduler tests need). */
export const plane = (
  centroid: GeometrySnapshot['centroid'],
  area: number,
  normal: GeometrySnapshot['normal'] = { x: 0, y: 0, z: 1 },
): GeometrySnapshot => ({ surfaceType: 'plane', centroid, area, normal })

/** A generate-only delta (a feature minting brand-new faces with inline geometry). */
export function genDelta(
  featureId: string,
  ids: StableId[],
  geometry?: Record<StableId, GeometrySnapshot>,
): ElementMapDelta {
  return { featureId, generated: ids, modified: {}, deleted: [], geometry }
}

/** Behavior of the mock worker seam for one node. */
export interface MockOp {
  /** default true; false -> the kernel op fails (ok:false). */
  ok?: boolean
  /** delta applied to the ElementMap on a successful op. */
  delta?: ElementMapDelta
  /** structured diagnostics the op returns (a failing op should carry a typed one). */
  diagnostics?: Diag[]
  /** if set, the op awaits this promise before returning -- the deterministic op-gate. */
  gate?: Promise<void>
  /** if set, the op REJECTS with this error instead of returning an OpResult --
   *  the worker-RPC-rejected path (distinct from a graceful ok:false result). */
  throws?: unknown
}

/**
 * A mock FeatureOp (the single-threaded worker seam). `ops` maps a node id to
 * either a fixed MockOp or a thunk (so a node can behave differently on a later
 * pass, e.g. fail then repair). `recorder` receives every node id the op is
 * CALLED for (in call order) -- this is AC #1's op-call recorder: an untouched
 * feature appearing here fails the over-regeneration guard.
 */
export function makeExecutor(
  ops: Record<string, MockOp | (() => MockOp)>,
  recorder: string[] = [],
): { executor: FeatureOp; recorder: string[] } {
  const executor: FeatureOp = async (node: DagNodeSnapshot) => {
    recorder.push(node.id)
    const entry = ops[node.id]
    const op: MockOp = (typeof entry === 'function' ? entry() : entry) ?? { ok: true }
    if (op.gate) await op.gate
    if ('throws' in op) throw op.throws
    const ok = op.ok !== false
    const diagnostics: Diag[] =
      op.diagnostics ??
      (ok ? [] : [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { feature: node.id } }])
    return { ok, elementMap: op.delta, diagnostics }
  }
  return { executor, recorder }
}

/** A one-shot op-gate: `reached` fires when the gated op is entered; `release` lets it return. */
export function makeGate(): { gate: Promise<void>; release: () => void; reached: Promise<void>; signalReached: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let signalReached!: () => void
  const reached = new Promise<void>((r) => {
    signalReached = r
  })
  return { gate, release, reached, signalReached }
}
