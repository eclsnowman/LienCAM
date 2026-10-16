// WO SKC-14C: the REACTIVE HOST PORT for the sketch overlay DOM.
//
// SKC-14B moved the tool slice into this package and left rows 10-17 -- the eight sketch overlays
// -- living in `src/components/viewport/`, rendered directly by the CAM mount. Its report named the
// blocker precisely: the overlays read TOOL state (now package-owned, via `useSketcherTool`) but
// they also read DOCUMENT state -- the active sketch, the display units, the selection, the
// dimension editor, the text edit cursor -- REACTIVELY, and a store-free package cannot subscribe
// to a host's store.
//
// This file is the answer. It is the mirror image of `../ports.ts`:
//
//   * `SketchDocumentPort` (ports.ts) is what the PACKAGE calls to read and commit the document
//     from imperative code (the interaction layer, the tool controller). Pull, on demand.
//   * `SketcherOverlaysPort` (this file) is what the PACKAGE's REACT tree subscribes to. Push, on
//     change. It hands the package the host's own reactivity as a set of hooks, so the overlays
//     re-render exactly when the host's state changes and never learn what a store is.
//
// A host implements it once (CAM: `src/components/viewport/camOverlaysPort.ts`); S3's workbench
// will implement the same 23 members over its own DAG payload and get all eight overlays for free.
// There is no file in which a second version of the overlay DOM could be written -- the critic's
// law (docs/3d/SKETCH-CRITIC-REPORT.md), extended from behavior to pixels.
//
// WHY HOOKS AND NOT A subscribe/getSnapshot PAIR: a host already has reactivity, and its own is
// always cheaper and better-behaved than one synthesized on top of it. CAM's implementation is
// seven `useCamStore` selectors, each with zustand's equality bail-out. Handing the package a
// `subscribe` + `getState` pair instead would force `useSyncExternalStore` semantics onto every
// future mount and re-run every selector on every unrelated store write. The port object MUST be
// referentially stable for the life of the mount (the hooks are called in render): CAM satisfies
// that with a MODULE CONST (`camOverlaysPort`), the same way it hands over `camSketchDocumentPort`.
// Building it per-mount in a `useMemo` also works, but do not close over a ref to do it -- the
// React Compiler cannot prove that safe and silently skips compiling the whole mount.
//
// THE IMPERATIVE HALF exists because five of the eight overlays run a `requestAnimationFrame` loop
// that mutates label transforms directly rather than re-rendering per pointermove (the overlay
// doctrine SKC-6/SKC-11 established). A rAF callback cannot call a hook, so those loops read
// `getSketch()` / `getDisplayUnits()` / `getTextEditId()` -- the same values, sampled rather than
// subscribed.
import type { Sketch, SketchConstraintKind, TextPathAlign, Vec2 } from '../../types'
import type { Units } from '../../../ui/unitFormat'

/**
 * The projection surface the overlays need: world mm -> screen px, and the live plane-locked
 * cursor. This is a STRUCTURAL type, not an import of the mount -- CAM's `CNCViewport` already
 * satisfies it exactly, so its port implementation returns the viewport instance verbatim and the
 * package stays ignorant of it. (Before this WO each overlay took `viewportRef: RefObject<CNCViewport>`,
 * which is precisely the import a package must not have.)
 */
export interface SketcherOverlaySurface {
  /** Project a world point on the sketch plane to overlay-host-local screen pixels. */
  worldToScreen(x: number, y: number, z?: number): { x: number; y: number }
  /** The last plane-locked sketch cursor in world mm, or null before any sketch pointermove. */
  getLastSketchCursor(): Vec2 | null
}

/** CAM's `sketchDimEditor`: which dimension has its value editor open, and whether it was just
 *  placed (a fresh placement keeps its measured value on Esc). */
export interface SketchDimEditorState {
  dimId: string
  isNew: boolean
}

/**
 * Everything the eight overlays need from a host, and nothing else.
 *
 * Every member is one of four things, and the split is the contract:
 *   - a HOOK: reactive read of host-owned state. Re-renders the overlay when it changes.
 *   - a GETTER: the same value sampled from a rAF loop, where hooks cannot go.
 *   - a COMMAND: a document mutation the host owns (it also owns the undo step it opens).
 *   - the SURFACE: the host's projection.
 *
 * Note what is NOT here: the armed tool, the chain, the tool scalars, the snap flags. Those are
 * package state (`../toolStore.ts`) and the overlays read them directly through `useSketcherTool`.
 * A host cannot supply them, cannot observe them, and cannot disagree with them.
 */
export interface SketcherOverlaysPort {
  // ---- Reactive reads (called in render; the host's own reactivity) --------------------------

  /** True while a sketch session is live (CAM: `viewer.mode === 'sketch'`). Every overlay gates
   *  on it -- at rest the sketch DOM does not exist. */
  useIsSketchActive(): boolean
  /** The open document, or null. Reference-stable between solves. */
  useSketch(): Sketch | null
  /** ADR-0022: the document is always millimeters; the host chooses what the user reads. */
  useDisplayUnits(): Units
  /** Document-scoped selection. Reference-stable when unchanged. */
  useSelectedIds(): string[]
  /** The open dimension value editor, or null. */
  useDimEditor(): SketchDimEditorState | null
  /** The text entity open for editing (placement or double-click), or null. */
  useTextEditId(): string | null
  /** SKC-BLOCKS Stage 4: the block currently open for edit-in-place, or null.
   *  OPTIONAL (like the document port's block-edit members): only a host that
   *  offers block edit-in-place implements it -- a mount that omits it never
   *  shows the "Editing block..." banner. */
  useBlockEditId?(): string | null
  /** The LIVE string of the entity `useTextEditId()` names, or '' when nothing is open. The
   *  WYSIWYG input is controlled by it: typing mutates the entity, the entity re-renders on
   *  canvas, and the field re-renders in lockstep -- one source of truth. */
  useTextDraft(): string

  // ---- Imperative reads (called from rAF; same values, sampled) ------------------------------

  getSketch(): Sketch | null
  getDisplayUnits(): Units
  getTextEditId(): string | null
  /** Null until the mount has a live surface (first render, or after unmount). */
  getSurface(): SketcherOverlaySurface | null
  /** Active measurement connector only: sketch-LOCAL mm -> overlay-local pixels,
   *  including the host's display pose. Omit when the surface already projects
   *  local coordinates (workbench plane). Null means no live surface. This does
   *  not change the existing final-label/editor projection contract. */
  projectDimensionPreview?(point: Vec2): Vec2 | null

  // ---- Dimension commands --------------------------------------------------------------------

  /** Flip a dimension between driving and reference (driven). */
  toggleDimensionDriving(dimId: string): void
  /** Commit a typed value in MILLIMETERS (angles: RADIANS). The host runs its verdict solve and
   *  may reject a conflicting value; the overlay converts from display units at its edge.
   *  `expression`: "sketch-dim equations wiring" hitlist item -- the raw "=..." source text
   *  (src/lib/sketch/dimExpr.ts#resolveDimInput) the value was resolved from, or undefined for a
   *  plain typed number. The host stores it alongside `value` (SketchDimensionBase#expression) so
   *  reopening the editor shows the equation again; a plain-number commit must clear any prior
   *  expression on that dimension. `half` names WHICH number of a two-valued dimension the edit
   *  sets -- only the chamfer setback pair ('d1xd2') has two, and omitting it means the base
   *  value (d1), so every single-valued caller is unchanged (WO-1858). */
  commitDimensionValue(
    dimId: string, value: number, expression?: string, half?: 'd1' | 'd2',
  ): void
  closeDimensionEditor(): void

  // ---- Text commands (row 9 / row 22 of the SKC-14B inventory: document cursors + patches) ----

  setTextValue(value: string): void
  /** Mirror of the DOM caret, so the sketch layer can draw the in-canvas caret (M1b). */
  setTextCaretIndex(index: number | null): void
  /** May COMMIT or DISCARD: the host owns the semantics (a fresh empty placement is removed with a
   *  notice; typed work is never silently destroyed). */
  commitTextEdit(): void
  cancelTextEdit(): void
  setTextPathAlignById(id: string, align: TextPathAlign): void
  setTextPathFlipById(id: string, flip: boolean): void
  setTextMirrorById(id: string, mirrored: boolean): void

  // ---- Selection commands (the context menu shares these with the panels) ---------------------

  applyConstraint(kind: SketchConstraintKind): void
  deleteSelection(): void

  // ---- Block commands (SKC-BLOCKS: the context menu shares these with panels) --------------

  /** Group the current selection into ONE rigid block (one undo step). Refuses
   *  by name via a notice on empty / nested / cross-boundary selections. */
  groupSelectionIntoBlock(): void
  /** Explode the selected block back into ordinary entities (one undo step). */
  explodeSelectedBlock(): void
  /** SKC-BLOCKS Stage 5: place ANOTHER instance of the selected block (one undo
   *  step). Hoists the block into a shared DEFINITION on first reuse; editing
   *  the block thereafter updates every instance. Refuses by name (a notice) if
   *  the selection is not a single block. */
  insertInstance(): void
  /** SKC-BLOCKS Stage 2: direct-edit the named block's uniform SCALE factor
   *  (ADR-0033 inert pattern -- rewrites the entity field, no gcs constraint).
   *  Refuses a non-positive/non-finite value via the host's own notice sink;
   *  a no-op edit (value unchanged) commits nothing. */
  setBlockScale(blockId: string, scale: number): void
  /** SKC-BLOCKS Stage 2: direct-edit the named block's ROTATION, in DEGREES
   *  (converted to the entity's stored radians at this boundary, matching
   *  every other degree-typed sketch field). Same inert/notice contract as
   *  setBlockScale. */
  setBlockRotationDeg(blockId: string, deg: number): void

  // ---- Block edit-in-place commands (SKC-BLOCKS Stage 4; OPTIONAL, see useBlockEditId) -------

  /** Imperative read counterpart of useBlockEditId, for non-reactive callers
   *  (the context menu's dispatch, the toolbox banner's click handlers). */
  getBlockEditId?(): string | null
  /** Enter edit-in-place on `blockId` (context menu "Edit block" / double-click). */
  beginBlockEdit?(blockId: string): void
  /** Exit edit-in-place, re-freezing the current members into the block. */
  finishBlockEdit?(): void
  /** Cancel edit-in-place, reverting to the pre-edit block. */
  cancelBlockEdit?(): void
}
