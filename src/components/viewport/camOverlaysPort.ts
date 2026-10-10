// WO SKC-14C: CAM's implementation of the sketcher package's reactive overlay port.
//
// This is the CAM half of the contract in src/lib/sketch/sketcher/overlays/port.ts, and it is the
// twin of `camSketchDocumentPort` (src/store/index.ts, WO SKC-14B): where that one is the
// document/commit/undo SINK the package pulls from, this one is the reactive READ surface the
// package's React tree subscribes to.
//
// WHY IT LIVES HERE AND NOT IN THE STORE: SKC-14B closed the CAM-store window and its WO froze
// `src/store/index.ts` -- reopening it is a bounce. Nothing here needs to: every member is either a
// `useCamStore` selector or a call to an action the store already exports. The file adds no state
// and no behavior. It is a translation table, and it is the only file in the CAM tree that knows
// both names for the same thing.
//
// WHY A MODULE CONSTANT rather than a `useMemo` in Viewport.tsx: the port's members are React
// hooks, called in render, so the object must be referentially stable for the life of the mount.
// The first cut built it with `useMemo(() => createCamOverlaysPort(() => viewportRef.current), [])`
// -- which is stable, and which the React Compiler lint correctly refuses: reading a ref inside a
// value produced during render is exactly the pattern it cannot prove safe, and it responded by
// SKIPPING COMPILATION of the whole Viewport component (4 new eslint errors, 0 on base). A module
// const has no such problem, is maximally stable, and matches how CAM already hands the package its
// other sink -- `camSketchDocumentPort` is a module const too. The surface arrives through the same
// mount effect that wires every other port.
import { useCamStore } from '../../store'
import type {
  SketcherOverlaysPort, SketcherOverlaySurface, SketchDimEditorState,
} from '../../lib/sketch/sketcher'
import type { Sketch, SketchConstraintKind, TextPathAlign } from '../../lib/sketch/types'
import type { Units } from '../../lib/ui/unitFormat'

/** The live projection surface, owned by the Viewport MOUNT and published here for the port. Null
 *  before the viewport exists and after it is disposed -- the overlays' rAF loops already bail on
 *  a null surface, which is the same guard they used when it was a `RefObject.current`. */
let camOverlaySurface: SketcherOverlaySurface | null = null

/** Called by the Viewport mount effect (and its cleanup). The one write path. */
export function setCamOverlaySurface(surface: SketcherOverlaySurface | null): void {
  camOverlaySurface = surface
}

/**
 * Build the port over CAM's store.
 *
 * `getSurface` is a parameter rather than a direct read of the module slot so a TEST can supply its
 * own fake viewport without touching global state. CAM's `CNCViewport` structurally satisfies
 * `SketcherOverlaySurface` (`worldToScreen` + `getLastSketchCursor`), so nothing adapts it -- which
 * is what keeps `CNCViewport.ts` frozen and unimported by the package.
 */
export function createCamOverlaysPort(
  getSurface: () => SketcherOverlaySurface | null,
): SketcherOverlaysPort {
  return {
    // ---- Reactive reads: zustand selectors, one per field. Each bails out on Object.is, so an
    //      unrelated store write (a toolpath recompute, a nest re-pack) re-renders no overlay. ----
    useIsSketchActive: () => useCamStore((s) => s.viewer.mode === 'sketch'),
    useSketch: () => useCamStore((s) => s.activeSketch),
    useDisplayUnits: () => useCamStore((s) => s.appSettings.displayUnits),
    useSelectedIds: () => useCamStore((s) => s.sketchSelectedIds),
    useDimEditor: () => useCamStore((s) => s.sketchDimEditor),
    useTextEditId: () => useCamStore((s) => s.sketchTextEditId),
    useBlockEditId: () => useCamStore((s) => s.sketchBlockEditId),
    // The LIVE string of the edited entity. Selected as a PRIMITIVE so the WYSIWYG input re-renders
    // on a text change and not on every solve -- the same selector the component used to hold.
    useTextDraft: () => useCamStore((s) => {
      const id = s.sketchTextEditId
      if (!id) return ''
      const e = s.activeSketch?.entities.find((x) => x.id === id)
      return e && e.kind === 'text' ? e.text : ''
    }),

    // ---- Imperative reads: the same values, sampled from the overlays' rAF loops. ----
    getSketch: (): Sketch | null => useCamStore.getState().activeSketch,
    getDisplayUnits: (): Units => useCamStore.getState().appSettings.displayUnits,
    getTextEditId: (): string | null => useCamStore.getState().sketchTextEditId,
    getSurface,

    // ---- Commands. Each is a document edit that owns its own undo step (or, for the dimension
    //      editor, pure UI state). None of them branch on the armed tool. ----
    toggleDimensionDriving: (dimId: string) =>
      useCamStore.getState().toggleDimensionDriving(dimId),
    commitDimensionValue: (dimId: string, value: number, expression?: string, half?: 'd1' | 'd2') =>
      useCamStore.getState().commitDimensionValue(dimId, value, expression, half),
    closeDimensionEditor: () => useCamStore.getState().closeDimensionEditor(),

    setTextValue: (value: string) => useCamStore.getState().setSketchTextValue(value),
    setTextCaretIndex: (index: number | null) =>
      useCamStore.getState().setSketchTextCaretIndex(index),
    commitTextEdit: () => useCamStore.getState().commitSketchTextEdit(),
    cancelTextEdit: () => useCamStore.getState().cancelSketchTextEdit(),
    setTextPathAlignById: (id: string, align: TextPathAlign) =>
      useCamStore.getState().setSketchTextPathAlignById(id, align),
    setTextPathFlipById: (id: string, flip: boolean) =>
      useCamStore.getState().setSketchTextPathFlipById(id, flip),
    setTextMirrorById: (id: string, mirrored: boolean) =>
      useCamStore.getState().setSketchTextMirrorById(id, mirrored),

    applyConstraint: (kind: SketchConstraintKind) =>
      useCamStore.getState().applySketchConstraint(kind),
    deleteSelection: () => useCamStore.getState().deleteSketchSelection(),

    groupSelectionIntoBlock: () => useCamStore.getState().groupSketchSelectionIntoBlock(),
    explodeSelectedBlock: () => useCamStore.getState().explodeSketchSelectedBlock(),
    insertInstance: () => useCamStore.getState().insertSketchBlockInstance(),
    setBlockScale: (blockId: string, scale: number) =>
      useCamStore.getState().setSketchBlockScale(blockId, scale),
    setBlockRotationDeg: (blockId: string, deg: number) =>
      useCamStore.getState().setSketchBlockRotation(blockId, deg),

    getBlockEditId: () => useCamStore.getState().sketchBlockEditId,
    beginBlockEdit: (blockId: string) => useCamStore.getState().beginSketchBlockEdit(blockId),
    finishBlockEdit: () => useCamStore.getState().finishSketchBlockEdit(),
    cancelBlockEdit: () => useCamStore.getState().cancelSketchBlockEdit(),
  }
}

/** THE port CAM's Viewport hands to `<SketcherOverlays/>`. One per process, like the document port
 *  it mirrors. Its hook members are therefore stable for the life of every mount, by construction
 *  rather than by a dependency array. */
export const camOverlaysPort: SketcherOverlaysPort =
  createCamOverlaysPort(() => camOverlaySurface)

export type { SketchDimEditorState }
