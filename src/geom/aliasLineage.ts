// WO UI-57-R1 blocker 2 - THE shared face-id alias lineage, in ONE place.
//
// Seam healing (geom-engine.ts #pairHealedFaces) performs a MANY-TO-ONE face
// merge: several PRE-EXISTING faces become one. The winner keeps its StableId;
// every losing id is recorded as an ALIAS pointing forward to the winner, so a
// caller still holding a loser id (a persisted face edit, a model reference, a
// selection, a face color, a hidden-face mask) keeps resolving instead of
// silently going dead.
//
// The alias map lives on the worker's BodyRecord and cannot cross the worker
// boundary -- ElementMapDelta (geom-service.ts, FROZEN) has no `aliases` field.
// It does not need one: every alias IS a contract-true `modified` entry, since
// an aliased id is an INPUT to the healing feature (it existed before it) and
// its sole SURVIVING OUTPUT is the winner. aliasesFromDelta() below reads that
// lineage straight back out of the delta, which is how BOTH sides get the same
// map from the same source of truth:
//
//   - the worker: geom-engine.ts restoreBody(), rebuilding rec.aliases after a
//     serialize/restore round trip;
//   - the UI: migrateStoredFaceIds() (workbench/faceIdMigration.ts), rewriting
//     the ids held in the selection / appearance / visibility stores.
//
// This module is PURE (no kernel, no THREE, no React) precisely so both lanes
// can import it.
import type { ElementMapDelta, StableId } from './geom-service.ts'

/**
 * THE SHARED FACE-ID RESOLVER. Follows an alias chain from `id` to its current
 * root: a merge-healed loser id forwards to the survivor it merged into, which
 * may itself have merged again in a later edit.
 *
 * Bounded by a `seen` set so a hypothetical cycle (which must never occur --
 * aliases only ever point toward a currently-live id) refuses by returning the
 * id unresolved rather than looping forever.
 */
export function resolveFaceIdVia(aliases: ReadonlyMap<StableId, StableId> | undefined, id: StableId): StableId {
  if (!aliases) return id
  let current = id
  const seen = new Set<StableId>()
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current)
    current = aliases.get(current) as StableId
  }
  return current
}

/**
 * Rebuild the alias map from a delta's `modified` lineage -- the exact inverse
 * of what #pairHealedFaces emits.
 *
 * The many-to-one merge signature is self-identifying:
 *     modified[loser]  = [winner]   with loser !== winner
 *     modified[winner] = [winner]   the "I am a live survivor" marker
 * Both halves are required. A split/retrim entry (a parent replaced by several
 * DIFFERENT children, or a parent whose single child is not itself a live
 * survivor) does NOT match and is left alone: this reconstructs merge aliases
 * only and never invents one, so an id that was genuinely replaced still
 * resolves 'lost' rather than being quietly rebound.
 */
export function aliasesFromDelta(map: ElementMapDelta): Map<StableId, StableId> {
  const aliases = new Map<StableId, StableId>()
  for (const [input, outputs] of Object.entries(map.modified)) {
    if (outputs.length !== 1) continue
    const winner = outputs[0]
    if (winner === input) continue
    const winnerOutputs = map.modified[winner]
    if (winnerOutputs === undefined || !winnerOutputs.includes(winner)) continue
    aliases.set(input as StableId, winner)
  }
  return aliases
}

/**
 * THE WRITE-SIDE HALF of the round trip, and the exact inverse of
 * aliasesFromDelta above: fold a body's INHERITED alias lineage into the delta
 * a derived feature is about to emit, so that delta is a COMPLETE statement of
 * the body's id lineage rather than a statement of what this one feature
 * happened to touch.
 *
 * WHY THIS EXISTS (UI-57-R2 blocker, DECISIONS 2026-07-17 "UI-57 second strike
 * on alias-lineage"). aliases live on the worker's BodyRecord and are carried
 * forward in memory by every derived #mint. They are NOT in ElementMapDelta
 * (the contract is frozen and has no `aliases` field), so restoreBody rebuilds
 * them from the delta it is handed -- and a delta that omits the historical
 * loser->winner pairs cannot be rebuilt from. The R1 auditor's repro:
 *
 *     heal (FB merges into FA; heal's OWN delta carries FB->FA)
 *       -> fillet (its delta never mentions FB -- the fillet did not touch it)
 *         -> serializeBody + restoreBody(fillet's delta)
 *           -> FB is LOST, though rec.aliases still held it before the save.
 *
 * The lineage is not the healing feature's private history: an aliased id IS an
 * input to EVERY later feature (it existed before each of them) whose sole
 * surviving output is the live root it now resolves to. So every derived
 * producer re-states it, and every delta stands alone.
 *
 * CONTRACT-TRUE, not a widening. Both entries this emits are ordinary
 * `modified` facts under the existing frozen shape:
 *     modified[loser] = [root]   loser's sole surviving output is root
 *     modified[root]  = [root]   root survived this feature as itself
 * The second is the "live survivor" marker aliasesFromDelta REQUIRES to accept
 * the first (it is what distinguishes a merge alias from a rename/split, so a
 * genuinely replaced id still resolves 'lost' rather than being quietly
 * rebound). Emitting only the first is a silent no-op on restore -- which is
 * why one helper owns both halves instead of each producer hand-rolling them.
 *
 * HONEST DEGRADATION, never invention. An alias whose root this feature
 * DELETED or split is skipped: the root has no surviving output, so the delta
 * claims none, and the id resolves 'lost' after a restore exactly as it does
 * in memory before one. Matching the in-memory answer -- not maximizing the
 * number of ids that resolve -- is the invariant (see the proof matrix in
 * src/tests/geom/aliasLineageMatrix.test.ts, which asserts resolve() agrees
 * across the round trip for EVERY id, including the ones that must stay lost).
 *
 * @param aliases    the target body's inherited alias map (rec.aliases /
 *                   target.aliases). `undefined` on a fresh body -> no-op.
 * @param isLive     is this id a live face on the feature's RESULT shape?
 *                   (producers pass their own `snapshots`/`faceMap` membership)
 * @param modified   the delta's `modified` record, mutated in place.
 * @param isGenerated optional: an id this feature MINTED. A generated id is an
 *                   output, never an input the contract can key on, so it is
 *                   refused as a `modified` key -- the same rule
 *                   #pairHealedFaces's own noteModified applies.
 */
export function foldAliasLineageIntoDelta(args: {
  aliases: ReadonlyMap<StableId, StableId> | undefined
  isLive: (id: StableId) => boolean
  modified: Record<StableId, StableId[]>
  isGenerated?: (id: StableId) => boolean
}): void {
  const { aliases, isLive, modified, isGenerated } = args
  if (aliases === undefined || aliases.size === 0) return
  const note = (input: StableId, output: StableId): void => {
    if (isGenerated?.(input) === true) return
    const cur = modified[input]
    if (cur === undefined) modified[input] = [output]
    else if (!cur.includes(output)) cur.push(output)
  }
  for (const loser of aliases.keys()) {
    // Path-compress through the SHARED resolver -- an inherited alias whose old
    // root merged again in a later feature must follow the second merge too, so
    // the entry emitted always points straight at a currently-live root.
    const root = resolveFaceIdVia(aliases, loser)
    if (root === loser) continue
    if (!isLive(root)) continue
    if (isGenerated?.(loser) === true) continue
    // Both halves or neither: emitting modified[loser] without the root's own
    // survivor marker is an entry aliasesFromDelta will reject on restore --
    // a silent lineage drop dressed up as a carry-forward.
    if (isGenerated?.(root) === true) continue
    note(loser, root)
    note(root, root)
  }
}
