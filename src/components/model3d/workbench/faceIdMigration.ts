// WO UI-57-R1 blocker 2 - the UI half of the shared face-id resolver.
//
// The worker resolves aliases on its own side (geom-engine.ts routes every
// engine consumer through resolveFaceIdVia / faceHashIndexVia / migrateEdgeIdVia).
// But the UI holds face StableIds of its own, in plain Sets and Maps, and
// compares them by STRING EQUALITY against the ids the tessellation paints from
// (body.faceIds). After a seam-healing merge only the WINNER appears there, so
// every stored LOSER id silently matches nothing:
//
//   - viewport3d/highlight.ts:105   a selected face stops highlighting
//   - appearance/applyAppearance.ts a painted face reverts to the body colour
//   - visibility/geometryVisibility.ts a hidden face REAPPEARS
//
// All three fail SILENTLY -- no error, no diagnostic, just the user's state
// quietly detaching from the model. And none is caught by pruneDeleted: a
// merged-away id is not `deleted`, it HAS a survivor.
//
// Resolving per-triangle at paint time would be the wrong cut (highlight.ts
// runs this compare for every triangle of every face, every repaint). Instead
// migrate ONCE, when the delta that created the merge lands: rewrite the stored
// ids from loser to winner and every downstream string compare is correct again
// with no per-frame cost.
//
// Derived edge ids need no separate pass here: geometryVisibility's
// deriveHiddenEdgeIds and workbench/faceBoundary's edgesOfFace both derive edge
// ids FROM the face ids in these stores at read time, so migrating the faces
// migrates them too. Persisted edge ids inside the kernel lane are migrated by
// geom-engine's migrateEdgeIdVia.
import type { ElementMapDelta, StableId } from '../../../geom/geom-service.ts'
import { aliasesFromDelta, resolveFaceIdVia } from '../../../geom/aliasLineage.ts'
import type { SelectionState } from '../../../viewport3d/SelectionState.ts'
import type { AppearanceStore } from '../appearance/appearanceStore.ts'
import type { VisibilityStore } from '../visibility/visibilityStore.ts'

export interface FaceIdMigrationStores {
  selection?: SelectionState | null
  appearance?: AppearanceStore | null
  visibility?: VisibilityStore | null
}

export interface FaceIdMigrationResult {
  /** How many alias (loser -> winner) pairs this delta declared. */
  aliasCount: number
  /** Migrated [from, to] pairs, per store. */
  selection: Array<[StableId, StableId]>
  appearance: Array<[StableId, StableId]>
  visibility: Array<[StableId, StableId]>
}

const EMPTY: FaceIdMigrationResult = { aliasCount: 0, selection: [], appearance: [], visibility: [] }

/**
 * Migrate every face StableId the UI holds across the merges declared by `map`.
 *
 * Reads the alias lineage out of the delta with the SAME rule the worker uses
 * to rebuild rec.aliases (geom/aliasLineage.ts) -- one resolver, one lineage
 * rule, two lanes. A delta with no merges is a no-op and touches no store, so
 * this is safe to call after EVERY edit rather than only after a healed one.
 */
export function migrateStoredFaceIds(map: ElementMapDelta | undefined, stores: FaceIdMigrationStores): FaceIdMigrationResult {
  if (map === undefined) return EMPTY
  const aliases = aliasesFromDelta(map)
  if (aliases.size === 0) return EMPTY
  const resolve = (id: StableId): StableId => resolveFaceIdVia(aliases, id)
  return {
    aliasCount: aliases.size,
    selection: stores.selection?.migrateFaceIds(resolve) ?? [],
    appearance: stores.appearance?.migrateFaceIds(resolve) ?? [],
    visibility: stores.visibility?.migrateFaceIds(resolve) ?? [],
  }
}
