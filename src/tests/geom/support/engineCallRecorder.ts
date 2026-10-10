// WO UI-57-R5 -- THE DISPATCH CHOKE POINT (DECISIONS 2026-07-17, "UI-57 B1
// recorder: observe at the DISPATCH CHOKE POINT").
//
// THE R4 BLOCKER, VERBATIM: "the recorder does not give every catalogued
// producer invocation its own coverage window or actual returned delta. Every
// synchronous engine method calls push(..., false), ignoring the computed
// profiled flag. The catalogued synchronous debugAssignEditedIdsForTest
// producer therefore leaves its V8 counts pending until the next asynchronous
// call, while its direct delta-shaped return is recorded as delta:null because
// push only reads result.elementMap. The route log then unions the
// misattributed counters and the global merged-count assertion stays green."
//
// Its evidence: the GREEN census printed `makeBox calls=4 ... producers=
// [#assignEditedIds debugAssignEditedIdsForTest makeBox]`. makeBox cannot call
// either -- those counters were the PRECEDING synchronous call's, still pending
// because the sync branch never took a window.
//
// THAT DEFECT CANNOT BE PATCHED, BECAUSE THE MECHANISM WAS THE DEFECT. A V8
// coverage window answers "what ran BETWEEN two reads" -- a question about an
// INTERVAL, not about a call. Attribution then depends on the interval lining up
// with the call, which is an invariant every ordering change re-litigates: R2,
// R3 and R4 each failed on some version of it. The delta half had the same
// shape: `result.elementMap` is a guess about the return, and a guess that
// misses records `delta: null` and says nothing.
//
// SO THIS ROUND REPLACES BOTH. There is ONE recorder, at the ONE surface every
// dispatch route flows through, and it pairs each route with the value THAT CALL
// RETURNED -- synchronously, in the same expression that produced it (sync), or
// inside that promise's own .then (async). No profiler, no counters, no windows,
// no per-producer instrumentation, no interval to line up with anything.
// ATTRIBUTION IS TRUE BY CONSTRUCTION: THE ROUTE IS THE DISPATCH KEY, AND THE
// DELTA IS THE RETURN VALUE.
//
// True-by-construction is not the same as PROVEN, which is how the last three
// rounds' canaries died: a name-only canary passes whatever the mechanism does.
// So the census asserts the construction positively -- every delta STATES the
// featureId its call was handed, and every id it MINTS is rooted in that same
// featureId (#runtime-dispatch-delta-identity), with the sync-hook case
// committed as the delta-identity canary (#runtime-dispatch-delta-canary).
//
// WHERE THE CHOKE POINT IS. GeomEngine has no literal dispatch table; it is ~30
// public methods that geom-worker.ts:50-84 mirrors 1:1. The single surface they
// all pass through is a transparent Proxy over the ENGINE INSTANCE: one get-trap
// wraps every method, bound to the REAL target, so `#private` state and `this`
// resolve against the production instance and the code under census stays
// byte-for-byte the shipped engine. The Comlink surface is NOT wrapped: Node
// never boots the Web Worker (geom-worker.ts:15-16) and every api method is a
// proven 1:1 passthrough to an engine method, so it reaches the engine through
// this same Proxy -- it is cross-checked STATICALLY instead
// (#runtime-worker-api-cross-check).
import type { GeomEngine } from '../../../geom/worker/geom-engine.ts'
import type { StableId } from '../../../geom/geom-service.ts'
import { routesOfRequest, type DispatchRoute } from '../aliasDispatchRoutes.ts'

/** The three return shapes that carry a delta out of the engine's public
 *  surface. Every one is a shape production really ships; a fourth is a THROW
 *  (see extractDeltas), never a silent `delta: null`. */
export type DeltaShape =
  /** (a) An OpResult: the delta is `result.elementMap`. Every async producer. */
  | 'op-result-elementMap'
  /** (b) The sync hook debugAssignEditedIdsForTest returns its delta INLINE at
   *  top level -- {modified,generated,deleted,geometry}, NOT under .elementMap
   *  (geom-engine.ts:997-1002). THAT OBJECT IS THE CALL'S DELTA. Reading only
   *  .elementMap here is what recorded it as `delta: null` in R4. */
  | 'sync-inline-return'
  /** (c) importStep returns {bodies:[{elementMap}...]} -- one delta PER IMPORTED
   *  BODY, under no top-level `ok` (geom-engine.ts:4832, :4924). R4 recorded
   *  this genesis route's real deltas as null too; recording them is what lets
   *  #runtime-genesis-routes-truly-genesis actually examine importStep. */
  | 'imported-body-elementMap'

/** One delta, as the call that returned it stated it. */
export interface RecordedDelta {
  shape: DeltaShape
  /** The featureId THE DELTA ITSELF states (ElementMapDelta.featureId,
   *  geom-service.ts:65). `null` ONLY for the sync inline shape, which declares
   *  no such field -- never invented, so the census can tell "states nothing"
   *  from "states the wrong thing". */
  statedFeatureId: string | null
  modified: Record<StableId, StableId[]>
  generated: StableId[]
  deleted: StableId[]
  geometry: Record<StableId, unknown>
}

/** One observed call through the engine's public surface -- the (route, returned
 *  delta) pair, as it flowed through dispatch. */
export interface EngineCall {
  method: string
  /** Routes this call pinned, derived from the ACTUAL request object. */
  routes: string[]
  /** The featureId THIS CALL'S REQUEST carried (see requestFeatureId). The other
   *  half of every identity assertion: a delta that states a different one is
   *  not this call's. */
  requestFeatureId: string | null
  /** EVERY delta THIS call returned, read off ITS OWN return value. `[]` means
   *  the call returned none -- which for an `ok:true` return is impossible by
   *  construction, because extractDeltas throws instead. */
  deltas: RecordedDelta[]
  /** Whether the op reported success -- a refusal drives no producer, and the
   *  census must be able to tell the two apart rather than counting a refusal
   *  as coverage (the R3 gap: `makeRevolve` "ran" while its add branch refused). */
  ok: boolean | null
  /** Refusal diagnostics, for a refused-route disposition to be checked against. */
  diagnostics: unknown[]
  /** The alias-carrying fixture live on the target body at call time, if any --
   *  set by the recipe via `withFixture`, so the carry-forward question is asked
   *  only where an inherited alias actually exists to carry. */
  fixture: { loser: string; winner: string; what: string } | null
}

export interface Recorder {
  /** The engine to drive. Identical behaviour to the real one; every public
   *  call through it is recorded. */
  engine: GeomEngine
  calls: EngineCall[]
  /** Mark every call made inside `fn` as running against a body that carries
   *  `fixture`'s inherited alias. */
  withFixture: <T>(fixture: { loser: string; winner: string; what: string }, fn: () => Promise<T>) => Promise<T>
}

/** The featureId a StableId is ROOTED IN. Every minting site in the engine and
 *  in stable-id.ts spells `${featureId}:<opCode>:...` (assignBoxFaceIds :190,
 *  assignCutFaceIds :490/:506, assignShellFaceIds :622/:644, #assignEditedIds
 *  :4199, #assignHealedIds :3675, patternInstanceId/patternMergeId
 *  sweep-lineage.ts:273/:282, extrudeCapId/revolveSurfId :286/:289, importStep
 *  :4911) -- so the id a call minted names the call that minted it, and a delta
 *  smeared from a NEIGHBOURING call carries the neighbour's root. */
export const featureIdOf = (id: string): string => {
  const at = id.indexOf(':')
  return at < 0 ? id : id.slice(0, at)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const isThenable = (v: unknown): v is Promise<unknown> =>
  typeof (v as { then?: unknown } | null)?.then === 'function'

/** Delta-shaped: the three fields every ElementMapDelta and the sync hook's
 *  inline return both carry (geom-service.ts:63-79, geom-engine.ts:997-1002). */
const isDeltaShaped = (v: unknown): v is Record<string, unknown> =>
  isObject(v) && isObject(v.modified) && Array.isArray(v.generated) && Array.isArray(v.deleted)

function readDelta(method: string, shape: DeltaShape, value: unknown): RecordedDelta {
  if (!isDeltaShaped(value)) {
    throw new Error(
      `engineCallRecorder: ${method}() returned a ${shape} value that is NOT delta-shaped ` +
      `(no {modified,generated,deleted}): ${JSON.stringify(value)?.slice(0, 200)}. The recorder REFUSES to record it ` +
      `as delta:null -- a producer whose delta is silently null is the R4 blocker itself.`,
    )
  }
  return {
    shape,
    statedFeatureId: typeof value.featureId === 'string' ? value.featureId : null,
    modified: value.modified as Record<StableId, StableId[]>,
    generated: value.generated as StableId[],
    deleted: value.deleted as StableId[],
    geometry: isObject(value.geometry) ? value.geometry : {},
  }
}

/**
 * EVERY delta `result` carries, by the three shapes production really returns.
 *
 * FAILS LOUD, BY METHOD NAME, on a fourth: a return that reports `ok: true` and
 * matches no delta shape is a producer whose delta this recorder cannot see, and
 * recording it as nothing is precisely how R4's census stayed green over a
 * delta:null. The one thing this function may never do is shrug.
 *
 * A return with no `ok:true` and no delta shape is a READ (tessellate,
 * recognizeFeatures, snapshotsFor, exportStep) or a lifecycle call (init,
 * dispose*) -- it returns no delta because it produces none, and `[]` is the
 * true answer. #runtime-every-route-has-its-own-delta is what stops that
 * emptiness from ever standing in for a producer route's coverage.
 */
export function extractDeltas(method: string, result: unknown): RecordedDelta[] {
  if (!isObject(result)) return []
  // (a) OpResult -- the async producers.
  if (result.elementMap !== undefined) return [readDelta(method, 'op-result-elementMap', result.elementMap)]
  // (c) importStep -- one delta per imported body, and no top-level `ok`.
  if (Array.isArray(result.bodies)) {
    return result.bodies.map((b) => {
      if (!isObject(b) || b.elementMap === undefined) {
        throw new Error(`engineCallRecorder: ${method}() returned a body with no elementMap -- its delta would be invisible.`)
      }
      return readDelta(method, 'imported-body-elementMap', b.elementMap)
    })
  }
  // (b) the sync hook's inline delta.
  if (result.ok === true && isDeltaShaped(result)) return [readDelta(method, 'sync-inline-return', result)]
  if (result.ok === true) {
    throw new Error(
      `engineCallRecorder: ${method}() returned ok:true but its value matches NO recognized delta shape -- not an ` +
      `OpResult (.elementMap), not an inline {modified,generated,deleted} return, not {bodies:[{elementMap}]}. ` +
      `A producer this recorder cannot read must be RED, never recorded as delta:null (the R4 blocker, verbatim: ` +
      `"its direct delta-shaped return is recorded as delta:null because push only reads result.elementMap"). ` +
      `Teach extractDeltas the new shape. Got keys: ${Object.keys(result).join(', ')}`,
    )
  }
  return []
}

/**
 * The featureId the REQUEST carried, by the TWO structural forms the engine's
 * public surface actually uses -- not a per-method table anyone maintains:
 *
 *   1. a request OBJECT with a string `featureId` -- every op (editFeature,
 *      makeExtrude, applyFillet, ...);
 *   2. the positional convention -- the FIRST top-level string argument:
 *      makeBox('RCBOX', size), debugMakeCylinder('RCCYL', r, h),
 *      importStep(bytes, 'RCIMP'), debugAssignEditedIdsForTest(entries, probes,
 *      'RCDBG', 'faceOffset').
 *
 * NOTHING HERE IS TRUSTED. For every shape that STATES a featureId, the census
 * asserts the two agree (#runtime-dispatch-delta-identity) -- so a request whose
 * featureId this reads wrongly turns the gate RED naming both values rather than
 * quietly mis-attributing a delta. That cross-check is what makes a two-form
 * heuristic admissible evidence instead of a label.
 */
export function requestFeatureId(args: readonly unknown[]): string | null {
  const first = args[0]
  if (isObject(first) && typeof first.featureId === 'string') return first.featureId
  for (const a of args) if (typeof a === 'string') return a
  return null
}

/**
 * Wrap `engine` at the dispatch choke point: every public call is observed as a
 * (route, returned delta) pair.
 *
 * There is nothing to open and nothing to close. The R4 recorder had an
 * ORDERING contract ("the window opens HERE, after kernel init") because its
 * evidence was an interval; this one's evidence is a return value, so kernel
 * init, call order and sync/async interleaving cannot affect attribution at all.
 * That is the whole point of moving to the choke point.
 */
export function recordEngineCalls(engine: GeomEngine, routes: readonly DispatchRoute[]): Recorder {
  const calls: EngineCall[] = []
  let fixture: EngineCall['fixture'] = null

  const record = (method: string, args: unknown[], result: unknown): void => {
    const r = result as { ok?: boolean; diagnostics?: unknown[] } | undefined
    calls.push({
      method,
      // The route comes off the request the ENGINE really received -- not off a
      // label a recipe claims. This is the line that makes the driven-set an
      // observation.
      routes: routesOfRequest(routes, method, args[0]),
      requestFeatureId: requestFeatureId(args),
      // THE R4 FIX, and the reason this file was rewritten rather than patched:
      // the delta is read from THIS CALL'S OWN RETURN VALUE, in the same
      // expression that produced it. There is no state to read it from, no next
      // call to inherit it from, and no window to union it across.
      deltas: extractDeltas(method, result),
      ok: r?.ok ?? null,
      diagnostics: r?.diagnostics ?? [],
      fixture,
    })
  }

  const proxy = new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || typeof prop !== 'string') return value
      // Bound to the REAL engine: `#private` fields resolve against the actual
      // instance, so the code path under census is the production one.
      const bound = (value as (...a: unknown[]) => unknown).bind(target)
      return (...args: unknown[]) => {
        const out = bound(...args)
        if (!isThenable(out)) {
          // A SYNCHRONOUS method -- the R4 blocker's own case. Recorded HERE,
          // atomically with the value it returned, and its own value handed back
          // untouched (a Promise here would break every caller that reads the
          // result directly, e.g. the fixtures' snapshotsFor). R4's `void
          // push(..., false)` deferred this and lost both halves.
          record(prop, args, out)
          return out
        }
        return out.then(
          (r) => { record(prop, args, r); return r },
          // Recorded even when the call THREW: a route that reached the engine
          // and exploded has been attempted, and a RED message must say that
          // rather than report it as never driven.
          (e) => { record(prop, args, undefined); throw e },
        )
      }
    },
  }) as GeomEngine

  return {
    engine: proxy,
    calls,
    withFixture: async (f, fn) => {
      const prev = fixture
      fixture = f
      try { return await fn() } finally { fixture = prev }
    },
  }
}
