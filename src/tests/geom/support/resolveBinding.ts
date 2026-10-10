// WO UI-57-R3 -- the MAJOR: "the matrix's advertised before/after resolve
// equality drops localIndex and type, comparing only id plus status. A silently
// wrong restored binding remains status 'fallback' and passes every producer
// cell."
//
// The auditor proved it: changing restoreBody so each rebuilt loser alias
// targeted THE FIRST DIFFERENT LIVE FACE instead of its winner left all 16/16
// matrix tests green with EXIT CODE 0. The loser still resolved, still reported
// 'fallback' -- it just pointed at the WRONG FACE. That is the stable-ID spec's
// explicitly forbidden silent wrong-face binding, and the matrix could not see
// it because it threw away the only fields that say WHICH face.
//
// WHY THE DROPPED FIELDS ARE NOT COSMETIC. `localIndex` is the face a caller
// actually gets. src/lib/cam/modelReferenceResolution.ts's RawResolution is
// {id, status, localIndex?, type?} -- the SAME four fields -- so a wrong
// localIndex flows straight into a persisted CAM model reference and machines
// the wrong face. "It resolved" was never the invariant; "it resolved to the
// RIGHT face" is.
//
// ---------------------------------------------------------------------------
// THE FIELD LIST IS PINNED BY THE COMPILER (WO amendment B3)
// ---------------------------------------------------------------------------
// The contract asks for the compared-field list to "derive from the binding type
// itself so a future field joins automatically". Taken literally that is
// unsatisfiable, and the amendment says so: geom-service.ts is FROZEN (so no
// named type may be added there to import), resolve()'s return element is an
// INLINE anonymous type (geom-service.ts:513-519), and TypeScript types are
// ERASED at runtime -- there is no value to enumerate at run time, ever.
//
// So the list is pinned at COMPILE time instead, which is strictly stronger than
// deriving it at run time would be: RESOLVE_BINDING_FIELD_MAP is
// `satisfies Record<keyof ResolveBinding, true>`, and that constraint bites in
// BOTH directions:
//
//   * add a 5th field to the frozen type -> Record<keyof ResolveBinding, true>
//     now requires a 5th key -> this map no longer satisfies it -> COMPILE
//     ERROR (`npm run build`), naming the missing field. It cannot be forgotten.
//   * remove a field -> the map's now-excess key fails the satisfies check ->
//     COMPILE ERROR. A stale field cannot linger either.
//
// `vitest strips types` (WORKER-CHARTER item 11), so this pin is enforced by
// `npm run build` -- which is exactly why the typecheck gate is a gate.
import type { GeomService } from '../../../geom/geom-service.ts'

/**
 * ONE element of the FROZEN resolve() contract's reply, taken from the
 * production signature itself rather than restated. Awaited<ReturnType<...>>
 * follows any future change to that signature automatically -- and geom-service
 * .ts is never edited to make this work.
 */
export type ResolveBinding = Awaited<ReturnType<GeomService['resolve']>>[number]

/**
 * THE EXHAUSTIVENESS PIN. Every key of the binding type, mapped to `true`.
 * The `satisfies` is the whole mechanism -- see the header.
 */
const RESOLVE_BINDING_FIELD_MAP = {
  id: true,
  status: true,
  localIndex: true,
  type: true,
} satisfies Record<keyof ResolveBinding, true>

/** The fields EVERY equality assertion iterates. Never hand-listed at a call
 *  site: one pinned list, so a comparison cannot quietly narrow. */
export const RESOLVE_BINDING_FIELDS = Object.keys(RESOLVE_BINDING_FIELD_MAP) as Array<keyof ResolveBinding>

/** The complete binding, every pinned field, for a before/after comparison. */
export function bindingOf(r: ResolveBinding): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of RESOLVE_BINDING_FIELDS) out[f] = r[f]
  return out
}

export const bindingsOf = (rs: readonly ResolveBinding[]): Array<Record<string, unknown>> => rs.map(bindingOf)
