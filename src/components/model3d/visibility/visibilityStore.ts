// WO UI-4 acceptance #4: per-body/per-face hide + isolate-selection +
// show-all. Framework-agnostic, mirrors SelectionState.ts's pub/sub shape.
//
// Isolate is stored as an ALREADY-RESOLVED set of body/face ids (the caller
// -- the demo harness -- resolves "isolate the current selection" into the
// concrete bodyIds/faceIds before calling isolateIds(), including the owning
// body of any isolated face) rather than this store trying to derive
// body-of-face itself: BodyId/StableId are two unrelated id spaces here
// (viewport3d/types.ts: BodyId is a caller-assigned session identity,
// StableId is document-rooted), and only the caller's CachedBody map knows
// which faceIds belong to which bodyId.

import type { StableId } from '../../../geom/geom-service'

export type BodyId = string

export interface VisibilitySnapshot {
  hiddenBodyIds: ReadonlySet<BodyId>
  hiddenFaceIds: ReadonlySet<StableId>
  isolate: { bodyIds: ReadonlySet<BodyId>; faceIds: ReadonlySet<StableId> } | null
}

export type VisibilityListener = () => void

export class VisibilityStore {
  private readonly hiddenBodyIds = new Set<BodyId>()
  private readonly hiddenFaceIds = new Set<StableId>()
  private isolateState: { bodyIds: Set<BodyId>; faceIds: Set<StableId> } | null = null
  private readonly listeners = new Set<VisibilityListener>()

  isBodyHidden(id: BodyId): boolean {
    return this.hiddenBodyIds.has(id)
  }

  isFaceHidden(id: StableId): boolean {
    return this.hiddenFaceIds.has(id)
  }

  get isolateActive(): boolean {
    return this.isolateState !== null
  }

  setBodyHidden(id: BodyId, hidden: boolean): void {
    const before = this.hiddenBodyIds.has(id)
    if (hidden) this.hiddenBodyIds.add(id)
    else this.hiddenBodyIds.delete(id)
    if (before !== hidden) this.emit()
  }

  toggleBodyHidden(id: BodyId): void {
    this.setBodyHidden(id, !this.hiddenBodyIds.has(id))
  }

  setFaceHidden(id: StableId, hidden: boolean): void {
    const before = this.hiddenFaceIds.has(id)
    if (hidden) this.hiddenFaceIds.add(id)
    else this.hiddenFaceIds.delete(id)
    if (before !== hidden) this.emit()
  }

  toggleFaceHidden(id: StableId): void {
    this.setFaceHidden(id, !this.hiddenFaceIds.has(id))
  }

  /** Isolate exactly `bodyIds` (+ within them, exactly `faceIds` if
   *  non-empty -- an empty faceIds set means "show every face of the
   *  isolated bodies", the common "isolate this body" case). */
  isolateIds(bodyIds: Iterable<BodyId>, faceIds: Iterable<StableId> = []): void {
    this.isolateState = { bodyIds: new Set(bodyIds), faceIds: new Set(faceIds) }
    this.emit()
  }

  clearIsolate(): void {
    if (this.isolateState === null) return
    this.isolateState = null
    this.emit()
  }

  /** WO UI-57-R1 blocker 2: rewrite every stored FACE id through `resolve`
   *  (the shared face-id resolver) after a seam-healing merge folded several
   *  faces into one -- both the explicit hidden set and an active isolate's
   *  face set. Pull-based, same shape as AppearanceStore.migrateFaceIds.
   *
   *  Without this a hidden face REAPPEARS the moment its id merges away (the
   *  stale id matches no live face), and an isolate silently widens to show
   *  the merged face. BodyIds are untouched: a BodyId is a caller-assigned
   *  session identity, never a StableId regen can merge (see pruneDeleted's
   *  reasoning in appearanceStore.ts). Returns the migrated [from, to] pairs. */
  migrateFaceIds(resolve: (id: StableId) => StableId): Array<[StableId, StableId]> {
    const moved: Array<[StableId, StableId]> = []
    const remap = (set: Set<StableId>): void => {
      for (const id of [...set]) {
        const root = resolve(id)
        if (root === id) continue
        set.delete(id)
        set.add(root)
        moved.push([id, root])
      }
    }
    remap(this.hiddenFaceIds)
    if (this.isolateState !== null) remap(this.isolateState.faceIds)
    if (moved.length > 0) this.emit()
    return moved
  }

  /** Clears explicit hides AND isolate -- acceptance #4's "show-all". */
  showAll(): void {
    const hadState = this.hiddenBodyIds.size > 0 || this.hiddenFaceIds.size > 0 || this.isolateState !== null
    this.hiddenBodyIds.clear()
    this.hiddenFaceIds.clear()
    this.isolateState = null
    if (hadState) this.emit()
  }

  isBodyVisible(id: BodyId): boolean {
    if (this.hiddenBodyIds.has(id)) return false
    if (this.isolateState !== null && !this.isolateState.bodyIds.has(id)) return false
    return true
  }

  isFaceVisible(bodyId: BodyId, faceId: StableId): boolean {
    if (!this.isBodyVisible(bodyId)) return false
    if (this.hiddenFaceIds.has(faceId)) return false
    if (this.isolateState !== null && this.isolateState.faceIds.size > 0 && !this.isolateState.faceIds.has(faceId)) return false
    return true
  }

  snapshot(): VisibilitySnapshot {
    return {
      hiddenBodyIds: new Set(this.hiddenBodyIds),
      hiddenFaceIds: new Set(this.hiddenFaceIds),
      isolate: this.isolateState === null ? null : { bodyIds: new Set(this.isolateState.bodyIds), faceIds: new Set(this.isolateState.faceIds) },
    }
  }

  subscribe(listener: VisibilityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
