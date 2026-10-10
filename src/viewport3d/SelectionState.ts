// viewport3d: hover/selection state machine (WO UI-1 AC3).
//
// Framework-agnostic: no DOM, no React, no THREE.Object3D references. State
// changes are surfaced via subscribe() callbacks; a UI layer (React or
// otherwise) reads highlightFor(id) to decide how to color a given
// face/edge/vertex/body. Precedence is fixed and total: a selected element
// always reads 'selected' even while also hovered -- there is exactly one
// rule, applied the same way for every id, so precedence can never depend on
// call order.

import type { HighlightKind, SelectionChangeEvent, StableId } from './types';

export type SelectionListener = (event: SelectionChangeEvent) => void;

function sameIdSet(a: ReadonlySet<StableId>, b: ReadonlySet<StableId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export class SelectionState {
  private hoverId: StableId | null = null;
  /** WO UI-58: multi-face hover paint (e.g. hovering one face of a recognized hole highlights the
   *  WHOLE feature's face set). Mutually exclusive with `hoverId` -- setting one clears the other, so
   *  `highlightFor` never has to arbitrate between two live hover sources. null whenever no multi-hover
   *  is active; single-id hover (`hoverId`) is untouched by this and remains the only hover path every
   *  pre-existing caller (push-pull/dress-up/sketch-on-face) uses. */
  private hoverSet: ReadonlySet<StableId> | null = null;
  private readonly selected = new Set<StableId>();
  private readonly listeners = new Set<SelectionListener>();

  get hovered(): StableId | null {
    return this.hoverId;
  }

  get selection(): ReadonlySet<StableId> {
    return this.selected;
  }

  isSelected(id: StableId): boolean {
    return this.selected.has(id);
  }

  /** Deterministic precedence: selected beats hovered (single-id or multi-set) beats none. */
  highlightFor(id: StableId): HighlightKind {
    if (this.selected.has(id)) return 'selected';
    if (this.hoverId === id) return 'hovered';
    if (this.hoverSet !== null && this.hoverSet.has(id)) return 'hovered';
    return 'none';
  }

  setHover(id: StableId | null): void {
    if (this.hoverId === id && this.hoverSet === null) return;
    this.hoverId = id;
    this.hoverSet = null;
    this.emit('hover');
  }

  /** Multi-id hover paint (WO UI-58). Pass null/empty to clear -- same effect as `setHover(null)`.
   *  Setting a multi-hover clears any single-id hover (and vice versa via setHover): the two are one
   *  logical "current hover", just carrying either one id or a set. */
  setHoverSet(ids: readonly StableId[] | null): void {
    const next = ids !== null && ids.length > 0 ? new Set(ids) : null;
    if (next === null) {
      this.setHover(null);
      return;
    }
    if (this.hoverId === null && this.hoverSet !== null && sameIdSet(this.hoverSet, next)) return;
    this.hoverId = null;
    this.hoverSet = next;
    this.emit('hover');
  }

  /** Replace the selection with exactly {id}. */
  select(id: StableId): void {
    if (this.selected.size === 1 && this.selected.has(id)) return;
    this.selected.clear();
    this.selected.add(id);
    this.emit('select');
  }

  /** Replace the selection with exactly `ids` (WO UI-58: selecting every face of a recognized
   *  multi-face feature, e.g. a hole, at once). Mirrors `select`'s single-id "replace the whole
   *  selection" semantics, generalized to a set. */
  selectMany(ids: readonly StableId[]): void {
    const next = new Set(ids);
    if (sameIdSet(this.selected, next)) return;
    this.selected.clear();
    for (const id of next) this.selected.add(id);
    this.emit('select');
  }

  /** Add id to a multi-selection (shift/ctrl-click) without disturbing the rest. */
  addToSelection(id: StableId): void {
    if (this.selected.has(id)) return;
    this.selected.add(id);
    this.emit('select');
  }

  toggleSelection(id: StableId): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.emit('select');
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.emit('select');
  }

  /** WO UI-57-R1 blocker 2: rewrite every held id through `resolve` (the shared
   *  face-id resolver) after a seam-healing merge folded several faces into
   *  one. Pull-based, matching AppearanceStore/VisibilityStore.migrateFaceIds.
   *
   *  highlightFor() compares a held id against the ids the viewport paints from
   *  (body.faceIds, straight off the tessellation), and only the merge WINNER
   *  appears there. So without this, selecting a face and then push/pulling a
   *  neighbour flush with it silently DESELECTS it -- the id is still in this
   *  set, matching nothing, with no error anywhere. Emits at most one 'select'
   *  and one 'hover' event. Returns the migrated [from, to] pairs. */
  migrateFaceIds(resolve: (id: StableId) => StableId): Array<[StableId, StableId]> {
    const moved: Array<[StableId, StableId]> = [];
    let selectionChanged = false;
    for (const id of [...this.selected]) {
      const root = resolve(id);
      if (root === id) continue;
      this.selected.delete(id);
      this.selected.add(root);
      moved.push([id, root]);
      selectionChanged = true;
    }
    let hoverChanged = false;
    if (this.hoverId !== null) {
      const root = resolve(this.hoverId);
      if (root !== this.hoverId) {
        moved.push([this.hoverId, root]);
        this.hoverId = root;
        hoverChanged = true;
      }
    }
    if (this.hoverSet !== null) {
      const next = new Set<StableId>();
      for (const id of this.hoverSet) {
        const root = resolve(id);
        if (root !== id) { moved.push([id, root]); hoverChanged = true; }
        next.add(root);
      }
      if (hoverChanged) this.hoverSet = next;
    }
    if (selectionChanged) this.emit('select');
    if (hoverChanged) this.emit('hover');
    return moved;
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: SelectionChangeEvent['type']): void {
    const event: SelectionChangeEvent = {
      type,
      hovered: this.hoverId,
      selected: this.selected,
    };
    for (const listener of this.listeners) listener(event);
  }
}
