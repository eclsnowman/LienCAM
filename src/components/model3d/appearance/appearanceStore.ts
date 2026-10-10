// WO UI-4 acceptance #5: per-body/per-face color assignment keyed by STABLE
// ID -- the visible payoff of the stable-id architecture (colors survive an
// edit that retrims a face but keeps its id; they're cleaned up, never
// orphaned, when an id is actually deleted).
//
// Framework-agnostic (no React, no THREE) -- mirrors SelectionState.ts's
// pub/sub shape so a caller wires it into a repaint loop the same way.
// Pruning is pull-based (pruneDeleted(isDeleted)), not an event subscription:
// RegenScheduler has no event emitter (see tree/useFeatureTreeStatuses.ts's
// own header) so nothing in this codebase can push "these ids just died" --
// every consumer polls a query surface. A caller polls (or calls once right
// after a regen `scheduler.run()` resolves) with `ElementMap.isDeleted`.

import type { StableId } from '../../../geom/geom-service'
import { PERSISTED_USER_DATA_REGISTRY } from '../../../store/persistedKeys'

export type RGB = readonly [number, number, number]
export type BodyId = string

export interface AppearanceSnapshot {
  faceColors: ReadonlyMap<StableId, RGB>
  bodyColors: ReadonlyMap<BodyId, RGB>
}

/** JSON-serializable shape for riding along in a document's generic
 *  `parameters: Record<string, JsonValue>` bag (src/doc/persist/format.ts) --
 *  see this WO's report interfaceConcerns for why that's the sanctioned
 *  piggyback point rather than a src/doc/** schema change. */
export interface SerializedAppearance {
  faces: Record<StableId, RGB>
  bodies: Record<BodyId, RGB>
}

export const APPEARANCE_PARAMETERS_KEY = PERSISTED_USER_DATA_REGISTRY.modelAppearance.key

export type AppearanceListener = () => void

export class AppearanceStore {
  private readonly faceColors = new Map<StableId, RGB>()
  private readonly bodyColors = new Map<BodyId, RGB>()
  private readonly listeners = new Set<AppearanceListener>()

  faceColor(id: StableId): RGB | undefined {
    return this.faceColors.get(id)
  }

  bodyColor(id: BodyId): RGB | undefined {
    return this.bodyColors.get(id)
  }

  setFaceColor(id: StableId, color: RGB): void {
    this.faceColors.set(id, color)
    this.emit()
  }

  clearFaceColor(id: StableId): void {
    if (!this.faceColors.delete(id)) return
    this.emit()
  }

  setBodyColor(id: BodyId, color: RGB): void {
    this.bodyColors.set(id, color)
    this.emit()
  }

  clearBodyColor(id: BodyId): void {
    if (!this.bodyColors.delete(id)) return
    this.emit()
  }

  /** Drop every face-color record whose id no longer survives regen
   *  (`isDeleted(id)` true, e.g. `ElementMap.isDeleted`). Body colors are
   *  NOT pruned here -- a BodyId is a caller-assigned session/document
   *  identity, not a StableId regen can delete out from under this store
   *  (see viewport3d/types.ts's BodyId doc comment); a body's own disposal
   *  is the caller's job (mirrors Lab3DView's bodyColorsRef.delete on
   *  handleDispose). Returns the pruned ids for a caller that wants to log
   *  or assert on it. */
  pruneDeleted(isDeleted: (id: StableId) => boolean): StableId[] {
    const pruned: StableId[] = []
    for (const id of [...this.faceColors.keys()]) {
      if (isDeleted(id)) {
        this.faceColors.delete(id)
        pruned.push(id)
      }
    }
    if (pruned.length > 0) this.emit()
    return pruned
  }

  /** WO UI-57-R1 blocker 2: rewrite every face-color key through `resolve`
   *  (the shared face-id resolver) after a seam-healing merge folded several
   *  faces into one. Pull-based, exactly like pruneDeleted above.
   *
   *  Without this a merged-away id is NOT pruned either -- it is not
   *  `deleted`, it has a survivor -- so its color entry would sit in this map
   *  forever, matching no live face: the face silently reverts to the body
   *  base color and the user's paint is gone with no error.
   *
   *  When a loser and its winner BOTH carry a color, the WINNER's own colour
   *  wins (the merged face keeps the identity it kept). Returns the migrated
   *  [from, to] pairs for a caller that wants to log or assert on it. */
  migrateFaceIds(resolve: (id: StableId) => StableId): Array<[StableId, StableId]> {
    const moved: Array<[StableId, StableId]> = []
    for (const [id, color] of [...this.faceColors]) {
      const root = resolve(id)
      if (root === id) continue
      this.faceColors.delete(id)
      if (!this.faceColors.has(root)) this.faceColors.set(root, color)
      moved.push([id, root])
    }
    if (moved.length > 0) this.emit()
    return moved
  }

  snapshot(): AppearanceSnapshot {
    return { faceColors: new Map(this.faceColors), bodyColors: new Map(this.bodyColors) }
  }

  serialize(): SerializedAppearance {
    return {
      faces: Object.fromEntries(this.faceColors),
      bodies: Object.fromEntries(this.bodyColors),
    }
  }

  /** Replace this store's contents from a previously serialize()d payload
   *  (e.g. document `parameters[APPEARANCE_PARAMETERS_KEY]` on load).
   *  Malformed entries are skipped rather than thrown -- appearance is
   *  cosmetic, never worth failing a whole document load over. */
  restore(data: unknown): void {
    this.faceColors.clear()
    this.bodyColors.clear()
    if (data === null || typeof data !== 'object') return
    const payload = data as Partial<SerializedAppearance>
    for (const [id, color] of Object.entries(payload.faces ?? {})) {
      if (isRgb(color)) this.faceColors.set(id, color)
    }
    for (const [id, color] of Object.entries(payload.bodies ?? {})) {
      if (isRgb(color)) this.bodyColors.set(id, color)
    }
    this.emit()
  }

  subscribe(listener: AppearanceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function isRgb(value: unknown): value is RGB {
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number')
}
