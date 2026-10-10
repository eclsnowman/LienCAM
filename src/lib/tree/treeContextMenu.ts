// Pure model for the DesignTree right-click context menu (Phase 7, P12 / 7.2).
//
// Mirrors the sketch context-menu pattern (src/lib/sketch/contextMenu.ts): a
// pure builder returns a flat item list; the React component renders it and
// dispatches each item's `action` through the SAME store actions the hover-row
// buttons already use. Keeping the model pure makes the per-type item set and
// the "omit items that lack an existing action" rule unit-testable with no DOM.
//
// IN SCOPE actions only — every action below maps to an EXISTING store action or
// existing handler. Items whose capability has no existing action are simply not
// emitted (documented as omissions in findings/13-phase7-log.md), never stubbed.

export type TreeContextKind =
  | 'op' | 'setup' | 'geometry' | 'layer' | 'model-item'
  // NAV-MENUS: five row types PP-SELECTION-UTILITY.recon.md's Matrix 2 flagged
  // as having NO context menu at all (no TreeContextKind existed).
  | 'stock-fixed' | 'stock-auto' | 'folder' | 'op-folder' | 'nest'

export interface OpContext {
  kind: 'op'
  setupId: string
  opId: string
  /** Index of this op within its setup, for move up/down enablement. */
  index: number
  /** Operation count in the setup, for move-down enablement. */
  count: number
  status: string
  enabled?: boolean
}

export interface SetupContext {
  kind: 'setup'
  setupId: string
}

export interface GeometryContext {
  kind: 'geometry'
  geoId: string
  /** Only STL/STEP parts expose a whole-part Hide/Show today (see omissions). */
  canToggleVisibility: boolean
  hidden: boolean
  /**
   * UI-EDIT-MODEL-FROM-BODY: set only for model-origin CAM geometry rows
   * (imported from a Model workspace item). Gates the "Edit model" item,
   * which routes to openModelItem(modelItemId) — the SAME action the
   * placeholder 'model-item' rows use (GEO-UNIFY Stage 1). Also gates
   * "Rename model..." / "Delete model" (Stage 1 sec 1.2). Mirrors the
   * layer-edit-sketch precedent.
   */
  modelItemId?: string
  /**
   * GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4: set for a plain imported
   * STEP part OR STL mesh row that "Edit as model" can wrap into a Model Item
   * (isWrappableGeometryRow -- format 'step' or 'stl', not a nest seed). Gates
   * the "Edit as model" item, which is FIRST (the slot geo-edit-model occupies
   * on model rows); the two are mutually exclusive by format, so the menu never
   * shows both. Multi-body / missing bytes / curved-mesh are NOT pre-filtered
   * here -- the wrap action refuses them by name at click time (ADR-0003).
   */
  wrappable?: boolean
  /** MSH-4-BOOLEAN-EDIT (nav path 1): this row is an imported mesh eligible as a
   *  boolean mesh operand AND the project has at least one Model body to cut
   *  against (isMeshBooleanSourceRow && hasModelBooleanBody). Gates the
   *  "Boolean with model body..." item -> openBooleanMeshDialog(geoId). */
  booleanSource?: boolean
  /** MSH-4-BOOLEAN-EDIT: this row is a boolean RESULT (booleanProvenance set).
   *  Gates "Edit boolean..." -> openBooleanMeshDialog(null, geoId) to re-run a
   *  fresh snapshot (edit-reuses-original-UI). */
  booleanResult?: boolean
  /** IMPORT-MULTIBODY-CHOICE (Operator Q-76): this is a still-combined multi-body
   *  STEP row (format 'step', solidCount > 1, not yet split). Gates "Choose body
   *  split..." -> reopenMultiBodyImportChoice(geoId), which reopens the import
   *  choice preselected to the row's stored pick (edit-reuses-original-UI). */
  multiBodySplit?: boolean
}

export interface LayerContext {
  kind: 'layer'
  geoId: string
  layerId: string
  /**
   * P13: sketch-editable per the SAME predicate the hover Edit-sketch button
   * uses — (format dxf|svg|sketch) && !projectionPlane && !locked. Gates the
   * "Edit sketch" item, which must be FIRST when present.
   */
  sketchEditable: boolean
  /**
   * Root layer rows carry the shared inline rename (TreeRenameLabel); seed
   * layer rows render a plain name span with no rename path, so Rename is
   * omitted for them (matching the row's own capability).
   */
  canRename: boolean
  /** Layer.locked — drives the Lock/Unlock label. */
  locked: boolean
  /** Layer.visible — drives the Hide/Show label. */
  visible: boolean
}

export interface ModelItemContext {
  kind: 'model-item'
  modelItemId: string
}

// NAV-MENUS: Fixed stock. Mirrors the row's own icon buttons — gizmo
// enter/exit (Move3d), Trash2 remove — plus Rename (TreeRenameLabel, reachable
// today only via double-click, same mechanism op-rename/geo-rename dispatch to).
export interface StockFixedContext {
  kind: 'stock-fixed'
  stockId: string
  /** viewer.selectedStockId === stockId — drives the Enter/Exit gizmo label,
   *  mirroring the row's own tree-icon-btn-active state. */
  gizmoActive: boolean
}

// NAV-MENUS: Auto stock. No gizmo (its box is member-derived, not directly
// positioned) — only Rename + the row's Trash2 remove.
export interface StockAutoContext {
  kind: 'stock-auto'
  stockId: string
}

// NAV-MENUS: Geometry folder. Mirrors the row's Pencil rename + Trash2 delete
// (handleDeleteFolder) — no editor beyond the two icon buttons exists.
export interface FolderContext {
  kind: 'folder'
  folderId: string
}

// NAV-MENUS: Operation folder. Mirrors the row's Power/PowerOff enable-all
// toggle + Pencil rename + Trash2 delete (which keeps the operations, per the
// row's own "Delete folder and keep operations" title).
export interface OpFolderContext {
  kind: 'op-folder'
  setupId: string
  folderId: string
  /** Same enableState the row computes (allEnabled/allDisabled/mixed) to pick
   *  the Power/PowerOff icon + tooltip. */
  enableState: 'enabled' | 'suppressed' | 'mixed'
  /** Row disables the toggle button when the folder has zero operations. */
  hasOperations: boolean
}

// NAV-MENUS: Nest. Mirrors the row's five icon buttons (Eye/EyeOff, Pencil
// "Edit nest", conditional RefreshCw recompute, Ungroup explode, Trash2
// delete) plus Rename (TreeRenameLabel, double-click only today).
export interface NestContext {
  kind: 'nest'
  nestId: string
  visible: boolean
  /** Gates the Recompute item — same nest.needsRecompute the row's
   *  conditional RefreshCw button gates on. */
  stale: boolean
}

export type TreeContextTarget =
  | OpContext
  | SetupContext
  | GeometryContext
  | LayerContext
  | ModelItemContext
  | StockFixedContext
  | StockAutoContext
  | FolderContext
  | OpFolderContext
  | NestContext

// Each item names an intent; the component switches on `action` to call the
// concrete store action. Strings (not closures) keep the model serializable and
// trivially testable.
export type TreeMenuAction =
  | 'op-edit'
  | 'op-regenerate'
  | 'op-duplicate'
  | 'op-rename'
  | 'op-toggle-enabled'
  | 'op-delete'
  | 'op-move-up'
  | 'op-move-down'
  | 'setup-edit'
  | 'setup-add-op'
  | 'setup-rename'
  | 'setup-delete'
  | 'geo-edit-model'
  | 'geo-edit-as-model'
  | 'geo-choose-multibody-split'
  | 'geo-boolean-with-model'
  | 'geo-edit-boolean'
  | 'geo-rename-model'
  | 'geo-delete-model'
  | 'geo-rename'
  | 'geo-toggle-visibility'
  | 'geo-delete'
  | 'layer-edit-sketch'
  | 'layer-convert-to-model'
  | 'layer-rename'
  | 'layer-toggle-visibility'
  | 'layer-toggle-lock'
  | 'layer-delete'
  | 'model-item-edit'
  | 'model-item-rename'
  | 'model-item-delete'
  | 'stock-fixed-toggle-gizmo'
  | 'stock-fixed-rename'
  | 'stock-fixed-delete'
  | 'stock-auto-rename'
  | 'stock-auto-delete'
  | 'folder-rename'
  | 'folder-delete'
  | 'op-folder-rename'
  | 'op-folder-toggle-enabled'
  | 'op-folder-delete'
  | 'nest-edit'
  | 'nest-rename'
  | 'nest-toggle-visibility'
  | 'nest-recompute'
  | 'nest-explode'
  | 'nest-delete'

export interface TreeMenuItem {
  id: string
  label: string
  action: TreeMenuAction
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
}

export function buildTreeContextMenu(target: TreeContextTarget): TreeMenuItem[] {
  switch (target.kind) {
    case 'op': {
      const computing = target.status === 'computing'
      const enabled = target.enabled !== false
      return [
        // NAV-PARITY-SMALLS gap 3: "Edit operation" FIRST, mirroring geo-edit-model /
        // layer-edit-sketch. Same destination as the row's inline Settings2 button
        // (onEditOp -> openEditOperation(setupId, opId)).
        { id: 'op-edit', label: 'Edit operation', action: 'op-edit' },
        {
          id: 'op-regen',
          label: 'Regenerate',
          action: 'op-regenerate',
          disabled: computing || !enabled,
        },
        {
          id: 'op-enabled',
          label: enabled ? 'Suppress' : 'Unsuppress',
          action: 'op-toggle-enabled',
        },
        { id: 'op-dup', label: 'Duplicate', action: 'op-duplicate' },
        { id: 'op-rename', label: 'Rename', action: 'op-rename' },
        {
          id: 'op-up', label: 'Move up', action: 'op-move-up',
          disabled: target.index <= 0, separatorBefore: true,
        },
        {
          id: 'op-down', label: 'Move down', action: 'op-move-down',
          disabled: target.index >= target.count - 1,
        },
        { id: 'op-del', label: 'Delete', action: 'op-delete', danger: true, separatorBefore: true },
      ]
    }
    case 'setup':
      return [
        // NAV-PARITY-SMALLS gap 2: "Edit setup" FIRST, mirroring geo-edit-model /
        // layer-edit-sketch. Same destination as the row's inline Settings2 button
        // (onEditSetup -> openEditSetup(setupId)).
        { id: 'setup-edit', label: 'Edit setup', action: 'setup-edit' },
        { id: 'setup-add', label: 'Add operation', action: 'setup-add-op' },
        { id: 'setup-rename', label: 'Rename', action: 'setup-rename' },
        { id: 'setup-del', label: 'Delete', action: 'setup-delete', danger: true, separatorBefore: true },
      ]
    case 'geometry': {
      // UI-EDIT-MODEL-FROM-BODY: "Edit model" is the FIRST item (primary
      // action) for a model-origin row, mirroring where layer-edit-sketch
      // sits for sketch layers. Routes to openModelItem(modelItemId) — the
      // same path the (now-removed) Model Items tree section rows used.
      const items: TreeMenuItem[] = []
      const isModelRow = !!target.modelItemId
      // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4 (nav path 1): "Edit as
      // model" is FIRST for a wrappable imported STEP part OR STL mesh row -- the
      // exact slot "Edit model" occupies on a model row; the two are mutually
      // exclusive by format so the menu never shows both. Routes to
      // wrapImportedGeometryAsModelItem (which refuses multi-body / missing bytes
      // / curved mesh BY NAME and, on success, opens the Model workspace). After
      // the wrap the row IS model-origin, so the model-row items above take over
      // for every later edit.
      const isWrappable = !isModelRow && !!target.wrappable
      // MSH-4-BOOLEAN-EDIT: a boolean RESULT row's primary edit is "Edit
      // boolean..." (re-run the recorded boolean as a fresh snapshot) - FIRST,
      // the slot every other "Edit X" verb occupies.
      const isBooleanResult = !isModelRow && !!target.booleanResult
      if (isBooleanResult) {
        items.push({ id: 'geo-edit-boolean', label: 'Edit boolean...', action: 'geo-edit-boolean' })
      }
      if (isWrappable) {
        items.push({ id: 'geo-edit-as-model', label: 'Edit as model', action: 'geo-edit-as-model' })
      }
      // IMPORT-MULTIBODY-CHOICE (Operator Q-76): a still-combined multi-body STEP row
      // can be re-split at any time -- reopen the same import choice, preselected
      // to the stored pick. Sits right after "Edit as model" (both wrap-family
      // verbs for an imported STEP part).
      if (target.multiBodySplit) {
        items.push({ id: 'geo-choose-multibody-split', label: 'Choose body split...', action: 'geo-choose-multibody-split' })
      }
      // MSH-4-BOOLEAN-EDIT (nav path 1): "Boolean with model body..." on any
      // imported mesh row when a Model body exists to cut against.
      const canBooleanWithModel = !isModelRow && !!target.booleanSource
      if (canBooleanWithModel) {
        items.push({ id: 'geo-boolean-with-model', label: 'Boolean with model body...', action: 'geo-boolean-with-model' })
      }
      if (isModelRow) {
        items.push({ id: 'geo-edit-model', label: 'Edit model', action: 'geo-edit-model' })
        // GEO-UNIFY Stage 1 sec 1.2: model-row affordance parity — the
        // Model Items section is gone, so its Rename/Delete verbs move onto
        // this row's menu, right after Edit model. "Rename model..." renames
        // the MODEL identity (renameModelItem); "Delete model" is the full
        // cascade (handleDeleteModelItem) — distinct from the plain "Rename"
        // below, which renames just this CAM row's own name.
        items.push({ id: 'geo-rename-model', label: 'Rename model...', action: 'geo-rename-model' })
        items.push({ id: 'geo-delete-model', label: 'Delete model', action: 'geo-delete-model', danger: true })
      }
      // P2: Rename starts the shared inline rename (TreeRenameLabel), the same
      // mechanism op-rename / setup-rename dispatch to.
      items.push({ id: 'geo-rename', label: 'Rename', action: 'geo-rename', separatorBefore: isModelRow || isWrappable || isBooleanResult || canBooleanWithModel })
      if (target.canToggleVisibility) {
        items.push({
          id: 'geo-vis',
          label: target.hidden ? 'Show' : 'Hide',
          action: 'geo-toggle-visibility',
        })
      }
      // A model row's delete is "Delete model" above (D5: full cascade,
      // reachable from any of the item's rows) — the generic Delete here
      // would only re-show the "removed in the Model tab" refusal, a
      // confusing second delete item beside one that actually works.
      if (!isModelRow) {
        items.push({
          id: 'geo-del', label: 'Delete', action: 'geo-delete', danger: true,
          separatorBefore: items.length > 0,
        })
      }
      return items
    }
    case 'layer': {
      // P13: promote "Edit sketch" — it is the FIRST item for a sketch-editable
      // layer (dispatched to the SAME openSketchForLayer the hover PenTool uses).
      // The remaining items mirror the row's own icon buttons: Rename (root rows
      // only), Hide/Show, Lock/Unlock, Delete — each reusing its existing handler.
      const items: TreeMenuItem[] = []
      if (target.sketchEditable) {
        items.push({ id: 'layer-edit-sketch', label: 'Edit sketch', action: 'layer-edit-sketch' })
        // GEO-UNIFY Stage 3 (D2 wording): "Convert to model..." sits directly
        // below "Edit sketch" on a sketch-editable layer — it MOVES the sketch
        // into a new model as its base sketch (promoteSketchLayerToModel). Same
        // gate as Edit sketch (target.sketchEditable), so it is omitted (not
        // disabled) on an ineligible row.
        items.push({ id: 'layer-convert-to-model', label: 'Convert to model...', action: 'layer-convert-to-model' })
      }
      if (target.canRename) {
        items.push({ id: 'layer-rename', label: 'Rename', action: 'layer-rename' })
      }
      items.push({
        id: 'layer-vis',
        label: target.visible ? 'Hide' : 'Show',
        action: 'layer-toggle-visibility',
      })
      items.push({
        id: 'layer-lock',
        label: target.locked ? 'Unlock' : 'Lock',
        action: 'layer-toggle-lock',
      })
      items.push({
        id: 'layer-del', label: 'Delete', action: 'layer-delete', danger: true,
        separatorBefore: true,
      })
      return items
    }
    case 'model-item': {
      // NAV-PARITY-SMALLS gap 4: Model Items tree-section rows had no context
      // menu at all. Edit (FIRST) mirrors geo-edit-model's destination — the
      // SAME openModelItem(id) the row's own click and the Model tab already
      // use. Rename/Delete mirror the row's own always-on icon buttons.
      return [
        { id: 'model-item-edit', label: 'Edit model', action: 'model-item-edit' },
        { id: 'model-item-rename', label: 'Rename', action: 'model-item-rename' },
        {
          id: 'model-item-del', label: 'Delete', action: 'model-item-delete', danger: true,
          separatorBefore: true,
        },
      ]
    }
    case 'stock-fixed':
      // NAV-MENUS: gizmo toggle occupies the "editor" slot (direct-manipulation
      // entry, the closest thing this row has to an Edit action), then Rename,
      // then Delete last — same order convention as every other kind above.
      return [
        {
          id: 'stock-fixed-gizmo',
          label: target.gizmoActive ? 'Exit gizmo' : 'Move with gizmo',
          action: 'stock-fixed-toggle-gizmo',
        },
        { id: 'stock-fixed-rename', label: 'Rename', action: 'stock-fixed-rename' },
        {
          id: 'stock-fixed-del', label: 'Delete', action: 'stock-fixed-delete', danger: true,
          separatorBefore: true,
        },
      ]
    case 'stock-auto':
      // NAV-MENUS: no editor/gizmo for auto stock (member-derived box) — just
      // Rename then Delete, mirroring the row's only always-visible button.
      return [
        { id: 'stock-auto-rename', label: 'Rename', action: 'stock-auto-rename' },
        {
          id: 'stock-auto-del', label: 'Delete', action: 'stock-auto-delete', danger: true,
          separatorBefore: true,
        },
      ]
    case 'folder':
      // NAV-MENUS: geometry folder — Rename then Delete, the row's only two
      // icon buttons (handleDeleteFolder already confirms + re-parents modeled
      // bodies, reused verbatim).
      return [
        { id: 'folder-rename', label: 'Rename', action: 'folder-rename' },
        {
          id: 'folder-del', label: 'Delete', action: 'folder-delete', danger: true,
          separatorBefore: true,
        },
      ]
    case 'op-folder': {
      // NAV-MENUS: Rename, then the structural enable/suppress-all toggle
      // (disabled when the folder is empty, mirroring the row's own disabled
      // guard), then Delete last (keeps operations — same as the row's title).
      return [
        { id: 'op-folder-rename', label: 'Rename', action: 'op-folder-rename' },
        {
          id: 'op-folder-enable',
          label: target.enableState === 'enabled' ? 'Suppress all' : 'Enable all',
          action: 'op-folder-toggle-enabled',
          disabled: !target.hasOperations,
        },
        {
          id: 'op-folder-del', label: 'Delete', action: 'op-folder-delete', danger: true,
          separatorBefore: true,
        },
      ]
    }
    case 'nest': {
      // NAV-MENUS: Edit nest FIRST (reopens the New Nest modal prefilled — a
      // real editor), then Rename, then the row's structural buttons
      // (Hide/Show, conditional Recompute, Explode), Delete last.
      const items: TreeMenuItem[] = [
        { id: 'nest-edit', label: 'Edit nest', action: 'nest-edit' },
        { id: 'nest-rename', label: 'Rename', action: 'nest-rename' },
        {
          id: 'nest-vis',
          label: target.visible ? 'Hide' : 'Show',
          action: 'nest-toggle-visibility',
        },
      ]
      if (target.stale) {
        items.push({ id: 'nest-recompute', label: 'Recompute', action: 'nest-recompute' })
      }
      items.push({ id: 'nest-explode', label: 'Explode', action: 'nest-explode' })
      items.push({
        id: 'nest-del', label: 'Delete', action: 'nest-delete', danger: true,
        separatorBefore: true,
      })
      return items
    }
  }
}
