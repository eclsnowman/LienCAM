// Design-tree folder grouping model (WO UI-8, BK-42 mission #2).
//
// Folders are DISPLAY-only grouping: membership NEVER touches FeatureDag's
// nodes/edges/timeline. This is intentionally a completely separate store
// from FeatureDag, mirroring dag.ts's own RollbackMarker precedent (WO UI-7):
// that field lives outside serialize()/restore() as its own top-level
// persisted field (persist/format.ts's `document.rollback`) precisely so
// FeatureDag's "pure function of nodes+edges" structural-identity golden test
// never has to account for it. Folders follow the identical shape --
// `document.folders`, additive, no schemaVersion bump (ADR-0027).
//
// v1 is root-only (WO UI-8 mission #2): every TreeFolder is a flat, unnested
// grouping. Removing a folder UNGROUPS its members (returns them to root) --
// it never deletes the features themselves. This deliberately does NOT mirror
// this repo's 2D geometryFolders precedent (src/store/index.ts's
// removeGeometryFolder), which cascade-deletes the contained parts: a 3D
// feature can be structurally consumed by downstream nodes via `consumes`
// edges, so silently deleting it because its folder was deleted would be a
// DAG-breaking side effect a pure display grouping must never cause.

import { compareIds } from './stable-id'
import { GenesisNodeError, isGenesisNodeId } from './genesis'

export interface TreeFolder {
  id: string
  name: string
}

export interface TreeFolderSnapshot {
  folders: TreeFolder[]
  /** nodeId -> TreeFolder.id. A nodeId absent here lives at the root (no folder). */
  membership: Record<string, string>
}

/**
 * Plain-data store: folders + node->folder membership. No undo/redo wiring
 * (unlike FeatureDag's mutators) -- folder CRUD is organisational/view state,
 * the same scoping SolidsWorkbenchPage already applies to WO UI-4's
 * visibility/isolate toggles (setFeatureVisible, onIsolate never go through
 * CommandHistory either). The one exception is folder suppress/unsuppress,
 * which rides UI-6's CommandHistory-tracked SetSuppressedCommand per member
 * (see folderSuppressCommand below) -- suppression is a DAG-level mutation
 * with real undo/redo stakes, membership is not.
 */
export class TreeFolderStore {
  private readonly folders = new Map<string, TreeFolder>()
  private readonly membership = new Map<string, string>()

  /** Caller-assigned id (never minted here), same discipline as FeatureDag.insertNode. */
  createFolder(id: string, name: string): void {
    if (this.folders.has(id)) throw new Error(`TreeFolderStore.createFolder: folder '${id}' already exists.`)
    this.folders.set(id, { id, name })
  }

  /** Renames a folder in place. Returns the PRIOR name. */
  renameFolder(id: string, name: string): string {
    const folder = this.requireFolder(id)
    const prior = folder.name
    folder.name = name
    return prior
  }

  /**
   * Removes a folder. v1 root-only: no descendant-folder cascade (see file
   * header for why members are UNGROUPED, never deleted). Returns the removed
   * folder + its former member ids (id-sorted) so a caller could restore it,
   * though no command currently does -- folder CRUD is not undo-tracked (see
   * class doc comment).
   */
  removeFolder(id: string): { folder: TreeFolder; memberIds: string[] } {
    const folder = this.requireFolder(id)
    const memberIds = this.membersOf(id)
    this.folders.delete(id)
    for (const nodeId of memberIds) this.membership.delete(nodeId)
    return { folder: { ...folder }, memberIds }
  }

  /**
   * Sets (folderId a real folder id) or clears (folderId null) a node's folder
   * membership. Returns the PRIOR folderId (null if none) -- the same
   * prior-return pattern FeatureDag's mutators use. Never touches FeatureDag:
   * feature order/DAG edges are completely unaffected by folder membership
   * (WO UI-8 mission #2's binding invariant).
   */
  setMembership(nodeId: string, folderId: string | null): string | null {
    // WO SKC-15C (audit major #3): THE JOIN POINT refuses a genesis id. Origin and the base planes
    // are permanent top-level fixtures -- they cannot join a folder. Before this guard, a genesis id
    // COULD be added to a folder (the audit built a mixed folder `[F1, datum:XY]`); folderSuppress
    // then swept it into a CompositeCommand whose genesis member threw mid-flight, leaving F1
    // suppressed with no undo entry. Refused here, at the one place membership is set, so the
    // downstream composite never sees a genesis member and a collapsed folder can never hide a
    // genesis row. Clearing membership (folderId null) is always allowed -- it can only ever remove a
    // stale entry, and refusing it would strand one.
    if (folderId !== null && isGenesisNodeId(nodeId)) throw new GenesisNodeError(nodeId, 'added to a folder')
    if (folderId !== null) this.requireFolder(folderId)
    const prior = this.membership.get(nodeId) ?? null
    if (folderId === null) this.membership.delete(nodeId)
    else this.membership.set(nodeId, folderId)
    return prior
  }

  /** `nodeId`'s current folder, or null if it lives at the root. */
  folderOf(nodeId: string): string | null {
    return this.membership.get(nodeId) ?? null
  }

  /** Member node ids of `folderId`, id-sorted (deterministic, mirrors FeatureDag.nodeIds()). */
  membersOf(folderId: string): string[] {
    return [...this.membership.entries()]
      .filter(([, f]) => f === folderId)
      .map(([nodeId]) => nodeId)
      .sort(compareIds)
  }

  hasFolder(id: string): boolean {
    return this.folders.has(id)
  }

  getFolder(id: string): TreeFolder | undefined {
    const f = this.folders.get(id)
    return f ? { ...f } : undefined
  }

  /** All folders, id-sorted (deterministic; mirrors FeatureDag.nodeIds()'s own discipline). */
  list(): TreeFolder[] {
    return [...this.folders.keys()].sort(compareIds).map((id) => ({ ...(this.folders.get(id) as TreeFolder) }))
  }

  serialize(): TreeFolderSnapshot {
    const membership: Record<string, string> = {}
    for (const nodeId of [...this.membership.keys()].sort(compareIds)) {
      membership[nodeId] = this.membership.get(nodeId) as string
    }
    return { folders: this.list(), membership }
  }

  /** Tolerant restore: absent/malformed input (a pre-UI-8 archive) yields an empty store -- byte-for-byte the pre-UI-8 behavior, same tolerance dag.ts's restoreRollbackState applies to a pre-UI-7 archive. A membership entry naming a folder that isn't also declared is dropped rather than trusted blindly. */
  static restore(input?: Partial<TreeFolderSnapshot> | null): TreeFolderStore {
    const store = new TreeFolderStore()
    for (const f of input?.folders ?? []) {
      if (f && typeof f.id === 'string' && typeof f.name === 'string' && !store.folders.has(f.id)) {
        store.folders.set(f.id, { id: f.id, name: f.name })
      }
    }
    for (const [nodeId, folderId] of Object.entries(input?.membership ?? {})) {
      // WO SKC-15C (audit major #3): a persisted/hand-edited archive that lists a genesis id as a
      // folder member is UNTRUSTED input, dropped rather than obeyed -- the same fail-closed stance
      // FeatureDag.restore takes on a corrupt genesis node. "TreeFolderStore.restore accepted origin
      // membership" was the audit's exact wording; it no longer does. A membership naming an undeclared
      // folder is dropped too (the pre-existing tolerance).
      if (typeof folderId === 'string' && store.folders.has(folderId) && !isGenesisNodeId(nodeId)) {
        store.membership.set(nodeId, folderId)
      }
    }
    return store
  }

  private requireFolder(id: string): TreeFolder {
    const f = this.folders.get(id)
    if (!f) throw new Error(`TreeFolderStore: no such folder '${id}'.`)
    return f
  }
}
