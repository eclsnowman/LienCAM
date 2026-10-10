import { isReferenceImagePayload } from '../../../referenceImage/referenceImage'
// WO UI-3: design-tree extension for the 3D feature DAG (DOC-2's FeatureDag +
// DOC-5's RegenScheduler status model). Framework piece per the WO's ruling 1:
// renders whatever nodes the doc layer holds with live per-feature status
// badges; it does NOT know about extrude/revolve specifically (M4's INT-4
// wiring plugs those in as more DagNodeKind/payload shapes -- see kindIcon
// below, which already covers every DagNodeKind so a new feature kind falls
// back to a generic icon instead of rendering blank).
//
// Visual language matches src/components/panels/DesignTree.tsx (read-only
// reference, never edited by this WO): dark row list, --row-default height,
// --select-ui-bg on the active row, --surface-hover on hover, lucide-react
// icons, --text-muted secondary text -- all via src/theme/tokens.css so a
// future theme swap covers both trees identically.

import { Fragment, useState, type DragEvent, type ReactNode } from 'react'
import {
  Ban,
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  Image as ImageIcon,
  EyeOff,
  FileBox,
  Filter,
  Folder,
  FolderPlus,
  FolderX,
  PenTool,
  Layers,
  Rewind,
  Settings2,
  Target,
  X,
  Crosshair,
  Square,
} from 'lucide-react'
import {
  ORIGIN_NODE_ID, isGenesisNodeId, markerInsertIndex,
  type DagNodeKind, type FeatureDag, type RollbackMarker, type TreeFolder,
} from '../../../doc'
import { FeatureStatusBadge } from './FeatureStatusBadge'
import { useFeatureTreeStatuses, type FeatureStatusSnapshot, type FeatureStatusSource } from './useFeatureTreeStatuses'
import { filteredCountLabel, matchesFeatureFilter, parseFilterQuery, type FeatureFilterFacts } from './treeFilter'
import { DeleteConfirmDialog, TreeContextMenu } from './TreeContextMenu'
import { MODEL_ROW_ID, modelBodyExportable, openExportWindow } from '../../../lib/exportCenter'
import type { DagNodeSnapshot } from '../../../doc'

/** Drag payload marker rows use (MarkerRow.onDragStart) -- feature-row drags
 *  (WO UI-8, folder membership) use the node's OWN id as the payload instead,
 *  so a drop handler that only wants ONE of the two kinds can tell them apart
 *  by comparing against this sentinel rather than guessing from shape. */
const MARKER_DRAG_PAYLOAD = 'rollback-marker'

/** ROOT_DROP_ID: the reserved drop-target id for "remove this feature from
 *  its folder" -- distinct from any real TreeFolder.id (caller-assigned,
 *  never this literal) so onDrop can tell a real folder chip from the
 *  always-present root zone without a second boolean flag. */
const ROOT_DROP_ID = '__root__'

/**
 * WO UI-7 (BK-40): the draggable rollback-marker row + move controls.
 * Optional/additive, same contract as `suppress`/`visibility` above: a tree
 * with no `rollback` prop renders every row's rolled-back visual state
 * read-only (derived straight from `dag.isRolledBack`), only the marker ROW
 * itself (the interactive control) is gated on this prop. The caller is
 * expected to run `onMoveMarker` through CommandHistory
 * (SetRollbackMarkerCommand) for undo/redo; this component never touches
 * the dag directly.
 */
export interface FeatureTreeRollbackControls {
  marker: RollbackMarker
  onMoveMarker(marker: RollbackMarker): void
}

/** WO UI-6 (BK-39): suppress/unsuppress toggle, reachable from every row --
 *  any DagNodeKind can carry its own suppress flag. Entirely optional/
 *  additive, same contract as `visibility` above: a tree with no `suppress`
 *  prop renders exactly as it did before this WO (row greying/glyph still
 *  render -- those are read-only, derived straight from `dag` -- only the
 *  TOGGLE control is gated on this prop). The caller is expected to run the
 *  toggle through CommandHistory (SetSuppressedCommand) for undo/redo; this
 *  component never touches the dag directly. */
export interface FeatureTreeSuppressControls {
  onToggleSuppress(id: string): void
}

/** WO UI-53 / WO-215: persisted, display-only feature visibility. This is
 *  separate from body visibility and suppression (DAG/regen): it is rendered
 *  for sketches and user-authored construction planes, whose viewport
 *  presentations both consume the DAG's hidden flag. The caller routes
 *  mutations through SetHiddenCommand. */
export interface FeatureTreeHideControls {
  isHidden(id: string): boolean
  onToggleHidden(id: string): void
}

/** WO UI-4 acceptance #4: optional per-row hide/isolate controls, rendered
 *  only for 'body'-kind nodes -- feature/sketch/datum/parameter nodes have
 *  no viewport visibility concept of their own. Tree state reflects the
 *  viewport (isBodyVisible/isIsolated read back live) and drives it
 *  (onToggleVisible/onIsolate), both ways, per the WO's binding acceptance
 *  criterion. Entirely optional/additive -- a tree with no `visibility` prop
 *  renders exactly as it did before this WO. */
export interface FeatureTreeVisibilityControls {
  isBodyVisible(id: string): boolean
  isIsolated(id: string): boolean
  onToggleVisible(id: string): void
  onIsolate(id: string): void
}

/** UI-55: automatic face-sketch datum nodes are implementation details. They
 * stay in the DAG, while explicit construction planes are ordinary visible
 * design-tree features. Genesis datums remain visible reference geometry. */
export function isFeatureTreeNodeVisible(dag: FeatureDag, id: string): boolean {
  const node = dag.getNode(id)
  const privateFacePlane = node?.kind === 'datum' && node.payload.planeKind === 'face-plane' && !isGenesisNodeId(id)
  return node !== undefined && !privateFacePlane
}

export function visibleFeatureTreeOrder(dag: FeatureDag): string[] {
  return dag.featureOrder().filter((id) => isFeatureTreeNodeVisible(dag, id))
}

/** Rows whose own persisted hidden flag controls a first-class viewport
 * presentation. Permanent genesis planes use their separate preference-backed
 * control, while private face-plane datums never render a tree row. */
function hasPersistedTreeVisibility(node: DagNodeSnapshot): boolean {
  return node.kind === 'sketch' || (node.kind === 'datum' && (node.payload.planeKind === 'offset-plane' || isReferenceImagePayload(node.payload)))
}

/**
 * WO UI-8 (BK-42 mission #2): design-tree folders v1 (root-only, DISPLAY
 * grouping -- src/doc/folders.ts's TreeFolderStore backs this; feature
 * order/DAG semantics are NEVER touched by folder membership). Entirely
 * optional/additive, same contract as `suppress`/`rollback`/`visibility`
 * above: a tree with no `folders` prop renders exactly as it did before this
 * WO (no folder strip, no per-row folder tag). The caller owns persistence
 * and (for suppress cascades only) CommandHistory wiring; this component
 * never touches the store or the dag directly.
 */
export interface FeatureTreeFolderControls {
  /** All folders, id-sorted (TreeFolderStore.list()'s own order). */
  list: TreeFolder[]
  /** `nodeId`'s current folder id, or null if it lives at the root. */
  folderOf(nodeId: string): string | null
  isCollapsed(folderId: string): boolean
  /** True if the folder has at least one member and every member is root-suppressed. */
  isFolderSuppressed(folderId: string): boolean
  onToggleCollapse(folderId: string): void
  onCreateFolder(name: string): void
  onRenameFolder(folderId: string, name: string): void
  onDeleteFolder(folderId: string): void
  /** folderId null removes membership (back to root). */
  onMoveToFolder(nodeId: string, folderId: string | null): void
  onToggleFolderSuppress(folderId: string): void
}

/**
 * WO UI-9 (BK-41): drag-reorder a feature row to a new position in
 * featureOrder(), with the F360-style "explain-before-drop" dependency guard
 * -- a drop that would place the dragged feature above a producer it
 * consumes, or below a consumer of its own output, is refused. Entirely
 * optional/additive, same contract as `suppress`/`rollback`/`folders` above:
 * a tree with no `reorder` prop renders exactly as it did before this WO (no
 * feature-row drag-to-reorder, though a row may still be draggable for
 * folder membership if `folders` is wired). `checkReorder` is the SAME
 * read-only legality query FeatureDag.checkReorder (dag.ts) exposes --
 * reused directly by this component for BOTH the live drag-over indicator
 * and the actual drop decision, so the two can never disagree, and an
 * illegal drop never reaches `onReorder` at all (this component itself
 * refuses it, mirroring the mission's "explain BEFORE drop"). The caller is
 * expected to run `onReorder` through CommandHistory (ReorderNodeCommand)
 * for undo/redo; this component never touches the dag directly.
 */
export interface FeatureTreeReorderControls {
  checkReorder(id: string, targetIndex: number): { blockingId: string; direction: 'above' | 'below' } | null
  onReorder(id: string, targetIndex: number): void
}

/**
 * WO UI-12 (BK-73 mission #4): feature delete, wired behind the transitive-
 * consumer dependency guard. Entirely optional/additive, same contract as
 * every other FeatureTree*Controls interface: a tree with no `del` prop
 * renders exactly as before this WO (no context-menu "Delete..." item, no
 * Delete-key handler). `consumersOf` is a READ-ONLY query -- FeatureTree
 * never computes the transitive-consumer closure itself (FeatureDag.
 * transitiveConsumersOf is the one place that walk lives); this component
 * only renders whatever list it is handed for the confirm dialog. The caller
 * is expected to run `onDelete` through CommandHistory (a CompositeCommand of
 * RemoveNodeCommand per removed id, one undo step) for undo/redo; this
 * component never touches the dag directly.
 */
export interface FeatureTreeDeleteControls {
  /** Every node id that would ALSO be removed if `id` is deleted -- id's full transitive-consumer closure, EXCLUDING id itself. */
  consumersOf(id: string): string[]
  onDelete(id: string): void
}

/** Either branch a node's Edit item can take -- routed to the SAME edit entry
 *  point the caller's own canonical "Edit..." affordance uses (never a second,
 *  parallel edit path). `{ onEdit }` renders a clickable item that fires the
 *  exact same handler the canonical entry point would; `{ reason }` renders
 *  the item disabled with that reason as its title (never a silent no-op). */
export type FeatureTreeEditEntry = ({ onEdit(): void } | { reason: string }) & {
  referenceImage?: { onCalibrate?: () => void; scaleLocked: boolean; onToggleLock(): void }
}

/** WO UI-18 (D3): tree-row Edit, wired behind a per-node lookup so every
 *  feature kind resolves to a real decision -- clickable (routed to the SAME
 *  code path the canonical edit entry point uses) or disabled-with-reason.
 *  Entirely optional/additive, same contract as every other
 *  FeatureTree*Controls interface: a tree with no `edit` prop renders exactly
 *  as before this WO (no context-menu "Edit..." item). `editEntryFor`
 *  returning `undefined` omits the item entirely (genesis rows -- mirrors how
 *  `del`/`suppress`/`folders` already omit their own items for those rows). */
export interface FeatureTreeEditControls {
  editEntryFor(id: string): FeatureTreeEditEntry | undefined
}

/** WO UI-17 (criterion 5, Operator answer "always on + tree toggle"): per-genesis-row
 *  show/hide eye toggle for the always-visible plane/origin glyphs. Entirely
 *  optional/additive, same contract as every other FeatureTree*Controls
 *  interface: a tree with no `genesisVisibility` prop renders exactly as
 *  before this WO. The caller owns state + persistence (SolidsWorkbenchPage
 *  routes it through uiPrefs); this component never touches a store. */
export interface FeatureTreeGenesisVisibilityControls {
  isVisible(id: string): boolean
  onToggle(id: string): void
}

export interface FeatureTreeProps {
  dag: FeatureDag
  /** Optional -- a tree with no scheduler wired yet renders every node as
   *  'dirty' (DOC-5's DEFAULT_STATUS), which is an honest "never built" state. */
  scheduler?: FeatureStatusSource
  selectedId?: string | null
  onSelect?(id: string): void
  /** WO UI-17 (criterion 1): 'card' (default) keeps the standalone bordered/
   *  rounded look the demo pages mount; 'flush' drops the outer border/radius/
   *  background so the tree sits inside a CAM .panel-left/.tree-section frame
   *  that already provides that chrome. Pure presentation. */
  chrome?: 'card' | 'flush'
  genesisVisibility?: FeatureTreeGenesisVisibilityControls
  /**
   * WO SKC-15C (audit major #1): row hover, reported to the host so it can drive the SAME viewport
   * feedback selection drives (Operator Q-1: "hover = feedback, select = feedback, always"). Fired with
   * the row id on mouse-enter and with `null` on mouse-leave. Optional: a tree with no host that
   * cares about hover (the CAM lab) simply does not pass it, and the row's CSS hover is unaffected.
   */
  onHover?(id: string | null): void
  pollMs?: number
  visibility?: FeatureTreeVisibilityControls
  suppress?: FeatureTreeSuppressControls
  hide?: FeatureTreeHideControls
  rollback?: FeatureTreeRollbackControls
  folders?: FeatureTreeFolderControls
  reorder?: FeatureTreeReorderControls
  edit?: FeatureTreeEditControls
  del?: FeatureTreeDeleteControls
}

const KIND_ICON: Record<DagNodeKind, typeof Box> = {
  sketch: PenTool,
  datum: Settings2,
  feature: Box,
  body: Layers,
  import: FileBox,
  // MSH-3 wiring (INT-IMPORT-EDIT stage 4): a prismatic-mesh import (STL wrapped
  // as an editable model) is a file-import body producer just like a STEP import.
  meshImport: FileBox,
  parameter: Settings2,
}

/** WO SKC-15: the genesis rows read as reference geometry, not as features. Origin gets a crosshair,
 *  the three base planes get a plane glyph -- both distinct from the gear every other datum uses. */
function rowIcon(id: string, kind: DagNodeKind): typeof Box {
  if (id === ORIGIN_NODE_ID) return Crosshair
  if (isGenesisNodeId(id)) return Square
  return KIND_ICON[kind]
}

function diagSummary(diags: { code: string }[]): string | undefined {
  if (diags.length === 0) return undefined
  return diags.map((d) => d.code).join(', ')
}

function nodeLabel(id: string, payload: Record<string, unknown>): string {
  const name = payload.name
  return typeof name === 'string' && name.length > 0 ? name : id
}

/** WO UI-8 (mission #1): the `:type` filter's match target -- a feature's OWN
 *  opType (extrude/revolve/boolean/...) when its payload carries one, else
 *  its DagNodeKind (sketch/body/...). Matches the mission's own example list
 *  ("extrude/revolve/boolean/..."), which names opTypes, not DagNodeKinds. */
function featureTypeTag(kind: DagNodeKind, payload: Record<string, unknown>): string {
  return typeof payload.opType === 'string' && payload.opType.length > 0 ? payload.opType : kind
}

/** WO UI-8 (mission #1): builds one row's FeatureFilterFacts straight from
 *  the SAME `dag`/`statuses` reads the row's own rendering already performs
 *  (suppressedState/rolledBack/status) -- never a second parallel derivation
 *  that could drift from what the row actually shows. */
function featureFilterFacts(
  dag: FeatureDag,
  statuses: Map<string, FeatureStatusSnapshot>,
  id: string,
  node: DagNodeSnapshot,
): FeatureFilterFacts {
  const status = statuses.get(id)?.status ?? 'dirty'
  return {
    name: nodeLabel(id, node.payload),
    typeTag: featureTypeTag(node.kind, node.payload),
    hasErrors: node.degraded || status === 'failed' || status === 'degraded',
    suppressed: node.suppressed || dag.isEffectivelySuppressed(id) || dag.isRolledBack(id),
  }
}

/**
 * WO UI-9 (BK-41): plain, UI-ready refusal reason naming the blocking
 * feature by its DISPLAY name (nodeLabel) -- mirrors FeatureDag.
 * ReorderBlockedError's own message shape exactly (dag.ts), just swapped
 * from raw ids to display names, since only this UI layer knows a node's
 * `payload.name`. The single place both the live drag-over indicator and the
 * on-drop refusal build this string, so they can never say something
 * different for the same blocked pair.
 */
function reorderBlockedReason(
  dag: FeatureDag,
  movedId: string,
  blocked: { blockingId: string; direction: 'above' | 'below'; reason?: 'dependency' | 'genesis' },
): string {
  const movedName = nodeLabel(movedId, dag.getNode(movedId)?.payload ?? {})
  // WO SKC-15: a genesis refusal is not a dependency -- saying "X uses Origin" would be a lie.
  if (blocked.reason === 'genesis') return 'Origin and the XY/XZ/YZ planes always stay at the top'
  const blockingName = nodeLabel(blocked.blockingId, dag.getNode(blocked.blockingId)?.payload ?? {})
  return blocked.direction === 'above'
    ? `${movedName} uses ${blockingName} - it cannot move above it`
    : `${blockingName} uses ${movedName} - it cannot move below it`
}

/** WO UI-7 (BK-40): given a target slot index (0..order.length) within
 *  `order`, returns the RollbackMarker that puts the marker exactly there --
 *  the single place a slot index turns back into a marker value, mirroring
 *  markerInsertIndex's own forward direction (dag.ts). */
function markerForSlot(order: readonly string[], index: number): RollbackMarker {
  const clamped = Math.max(0, Math.min(index, order.length))
  if (clamped === 0) return { kind: 'start' }
  if (clamped === order.length) return { kind: 'end' }
  return { kind: 'after', nodeId: order[clamped - 1] }
}

interface MarkerRowProps {
  order: readonly string[]
  slot: number
  onMoveMarker(marker: RollbackMarker): void
  /** WO UI-12 (BK-72): flips FeatureTree's own `markerDragging` state so the
   *  per-row insertion indicator (distinct from the reorder indicator) can
   *  gate itself on "a marker drag is active" -- mirrors draggingId's own
   *  onDragStart/onDragEnd bookkeeping for feature-row drags above. */
  onMarkerDragStart(): void
  onMarkerDragEnd(): void
}

/** The draggable rollback-marker row: separates "active" features (above)
 *  from rolled-back ones (below). Real mouse drag (native HTML5 DnD, same
 *  idiom real timeline scrubbers use) PLUS up/down buttons as an
 *  accessible/test-friendly equivalent control -- matches this tree's
 *  established button-first idiom (suppress/visibility rows above never use
 *  drag either). */
function MarkerRow({ order, slot, onMoveMarker, onMarkerDragStart, onMarkerDragEnd }: MarkerRowProps) {
  return (
    <div
      data-testid="rollback-marker-row"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', MARKER_DRAG_PAYLOAD)
        // WO UI-12 (BK-72 mission #3): suppress the browser's free-floating
        // drag ghost -- an empty element leaves nothing to paint under the
        // cursor, so the marker's perceived motion is constrained to
        // vertical movement along the tree column instead of following the
        // mouse everywhere. Optional-chained: real browsers implement
        // setDragImage, but a plain-object DataTransfer test stub need not.
        e.dataTransfer.setDragImage?.(document.createElement('div'), 0, 0)
        onMarkerDragStart()
      }}
      onDragEnd={onMarkerDragEnd}
      onDragOver={(e) => e.preventDefault()}
      // WO UI-14A (D1, UI-14.report.json defects[1]): the marker row itself
      // was draggable and accepted onDragOver, but had NO onDrop at all --
      // so the dedicated row rendered when the marker IS ALREADY at 'end'
      // (FeatureTree.tsx's own bottom-of-tree render) was not a real drop
      // target, leaving no droppable surface anywhere that resolved to the
      // true bottom slot. Mirrors dropOnRow's own rollback branch, using
      // this row's OWN `slot` (already correct for wherever it renders).
      onDrop={(e) => {
        e.preventDefault()
        onMoveMarker(markerForSlot(order, slot))
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 20,
        padding: '2px 8px',
        cursor: 'grab',
        borderTop: '1px dashed var(--status-outdated, #caa53d)',
        borderBottom: '1px dashed var(--status-outdated, #caa53d)',
        background: 'rgba(202,165,61,0.12)',
        color: 'var(--status-outdated, #caa53d)',
        fontSize: 11,
      }}
    >
      <Rewind size={12} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>Rollback marker</span>
      <button
        type="button"
        data-testid="rollback-marker-up"
        data-tooltip="Move marker up (roll back one more feature)"
        aria-label="Move marker up"
        disabled={slot <= 0}
        onClick={(e) => {
          e.stopPropagation()
          onMoveMarker(markerForSlot(order, slot - 1))
        }}
        style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', padding: 2 }}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        data-testid="rollback-marker-down"
        data-tooltip="Move marker down (restore one more feature)"
        aria-label="Move marker down"
        disabled={slot >= order.length}
        onClick={(e) => {
          e.stopPropagation()
          onMoveMarker(markerForSlot(order, slot + 1))
        }}
        style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', padding: 2 }}
      >
        <ChevronDownIcon />
      </button>
    </div>
  )
}

function ChevronUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Reads a drag event's payload feature id, or null if this drop is not a
 *  feature-row drag (e.g. it's the rollback-marker drag, or nothing usable
 *  was set) -- the one place both folder-chip drop handlers below decide
 *  "is this actually a feature id" so the check can't drift between them. */
function draggedFeatureId(e: DragEvent): string | null {
  const payload = e.dataTransfer?.getData('text/plain')
  return payload !== undefined && payload !== '' && payload !== MARKER_DRAG_PAYLOAD ? payload : null
}

interface FolderChipProps {
  folder: TreeFolder
  collapsed: boolean
  suppressed: boolean
  /** WO UI-12 (BK-70 mission #2): true for the ENTIRE duration of a feature-
   *  row drag (not just while hovered) -- the discoverability fix: a chip
   *  lights up as a drop target the moment a drag starts, rather than only
   *  when the cursor happens to already be over it. */
  dragActive: boolean
  /** WO UI-12 (BK-70 mission #2): true when this folder has zero members --
   *  drives the persistent "drag features here" hint (always rendered while
   *  empty, not gated on hover/drag) so an empty folder never reads as a
   *  dead end. */
  isEmpty: boolean
  onToggleCollapse(): void
  onRename(name: string): void
  onDelete(): void
  onToggleSuppress(): void
  onDropFeature(nodeId: string): void
}

/** WO UI-8 (mission #2): one folder's management chip -- collapse toggle,
 *  inline rename (double-click the name), suppress-all toggle (rides the
 *  same Ban glyph/aria-pressed idiom every row's own suppress button uses),
 *  delete, and a drop target for "drag a feature INTO this folder". */
function FolderChip({ folder, collapsed, suppressed, dragActive, isEmpty, onToggleCollapse, onRename, onDelete, onToggleSuppress, onDropFeature }: FolderChipProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(folder.name)

  const commitRename = (): void => {
    const trimmed = draft.trim()
    if (trimmed.length > 0 && trimmed !== folder.name) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div
      data-testid={`folder-chip-${folder.id}`}
      data-drop-active={dragActive}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const id = draggedFeatureId(e)
        if (id !== null) onDropFeature(id)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minHeight: 'var(--row-default)',
        padding: '0 8px',
        borderBottom: '1px solid var(--border-subtle)',
        background: dragActive ? 'var(--select-ui-bg)' : 'var(--surface-1)',
        outline: dragActive ? '1px dashed var(--text-muted)' : 'none',
        outlineOffset: -1,
      }}
    >
      <button
        type="button"
        data-testid={`folder-toggle-${folder.id}`}
        aria-label={collapsed ? 'Expand folder' : 'Collapse folder'}
        onClick={onToggleCollapse}
        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <Folder size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      {renaming ? (
        <input
          type="text"
          data-testid={`folder-rename-input-${folder.id}`}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') {
              setDraft(folder.name)
              setRenaming(false)
            }
          }}
          style={{ flex: 1, background: 'var(--surface-2, #10151b)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
      ) : (
        <span
          data-testid={`folder-name-${folder.id}`}
          onDoubleClick={() => {
            setDraft(folder.name)
            setRenaming(true)
          }}
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
          data-tooltip="Double-click to rename"
        >
          {folder.name}
        </span>
      )}
      {isEmpty && !renaming && (
        <span data-testid={`folder-empty-hint-${folder.id}`} style={{ color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic', flexShrink: 0 }}>
          drag features here
        </span>
      )}
      <button
        type="button"
        data-testid={`folder-suppress-${folder.id}`}
        aria-pressed={suppressed}
        data-tooltip={suppressed ? 'Unsuppress folder' : 'Suppress folder'}
        aria-label={suppressed ? 'Unsuppress folder' : 'Suppress folder'}
        onClick={onToggleSuppress}
        style={{
          background: suppressed ? 'var(--select-ui-bg)' : 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          display: 'flex',
          padding: 2,
        }}
      >
        <Ban size={13} />
      </button>
      <button
        type="button"
        data-testid={`folder-delete-${folder.id}`}
        data-tooltip="Delete folder (members return to root)"
        aria-label="Delete folder"
        onClick={onDelete}
        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
      >
        <FolderX size={13} />
      </button>
    </div>
  )
}

export function FeatureTree({ dag, scheduler, selectedId = null, onSelect, onHover, pollMs, chrome = 'card', genesisVisibility, visibility, suppress, hide, rollback, folders, reorder, del, edit }: FeatureTreeProps) {
  // WO UI-7 (BK-40): featureOrder() (the explicit, insertion/insert-at-marker
  // timeline) replaces nodeIds() (id-sort) as the row sequence, so the
  // marker row can sit at a meaningful position between two adjacent rows --
  // nodeIds()' alphabetical sort has no relationship to "above/below the
  // marker". For any dag built the way every existing caller already does
  // (producers created before their consumers), featureOrder() and nodeIds()
  // agree in practice; this only matters once a marker exists at all.
  const order = dag.featureOrder()
  const visibleOrder = visibleFeatureTreeOrder(dag)
  const statuses = useFeatureTreeStatuses(scheduler, order, pollMs)
  // WO SKC-5-R1 originally folded auto-created face-plane datums under their
  // sketches. UI-55 supersedes that presentation: the rows are now private,
  // while this relationship map remains the structural metadata used by the
  // stable display-order pass below. A datum is associated when
  // exactly one live 'sketch' node's payload.planeNodeId points at it (the
  // sketch3d executor's own linkage, see sketch3d/regen.ts's Sketch3dNodePayload);
  // any other shape (unconsumed datum, or a future multi-consumer case) is
  // left as a normal top-level row rather than guessing which parent to fold
  // under. datumFoldTargets: datumId -> the ONE sketch id it folds under;
  // sketchToFoldedDatum is its inverse for the display-order pass below.
  const datumFoldTargets = new Map<string, string>()
  for (const id of order) {
    const node = dag.getNode(id)
    if (node === undefined || node.kind !== 'sketch') continue
    const planeNodeId = (node.payload as { planeNodeId?: unknown }).planeNodeId
    if (typeof planeNodeId !== 'string') continue
    const planeNode = dag.getNode(planeNodeId)
    if (planeNode === undefined || planeNode.kind !== 'datum') continue
    // WO SKC-15: a base plane is consumed by every sketch drawn on it, but it is a PERMANENT
    // top-level item -- never folded away under the first sketch that happened to use it. Only the
    // auto-created face-plane datums SKC-5-R1 Finding 2 was written for fold.
    if (isGenesisNodeId(planeNodeId) || planeNode.payload.planeKind !== 'face-plane') continue
    if (!datumFoldTargets.has(planeNodeId)) datumFoldTargets.set(planeNodeId, id)
  }
  const sketchToFoldedDatum = new Map<string, string>()
  for (const [datumId, sketchId] of datumFoldTargets) sketchToFoldedDatum.set(sketchId, datumId)
  // -1 (never a real slot: markerInsertIndex's range is 0..order.length)
  // when `rollback` is unwired -- keeps every `markerSlot === index` /
  // `markerSlot === order.length` comparison below a plain number compare
  // instead of an `undefined`-narrowing dance.
  const markerSlot = rollback !== undefined ? markerInsertIndex(order, rollback.marker) : -1

  // WO UI-8 (BK-42 mission #1): filter is pure component-local UI state --
  // it never reads or writes anything on `dag`, which is what makes "filtered
  // state -> document byte-identical" true by construction rather than by a
  // discipline someone has to remember. Always-on (no gating prop), unlike
  // suppress/rollback/folders: a filter with nothing typed matches everything,
  // so there is no "pre-UI-8 tree" behavior change to preserve.
  const [filterText, setFilterText] = useState('')
  const query = parseFilterQuery(filterText)

  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // WO UI-9 (BK-41): reorder drag state -- component-local, same "pure UI
  // state" discipline filterText/creatingFolder above already establish.
  // `draggingId` is set directly from the row's OWN closure id at
  // onDragStart, never read back out of DataTransfer during dragover: real
  // browsers restrict DataTransfer.getData to the 'dragstart'/'drop' phases
  // (dragover only exposes `.types`), so an in-memory id is the only way a
  // live legal/illegal indicator can work outside jsdom's more permissive
  // stub. `dragOverIndex` is the row currently hovered (raw featureOrder()
  // index -- the SAME 0..order.length-1 range FeatureDag.checkReorder's own
  // `targetIndex` expects; a full N-row order and an N-1-length
  // post-removal timeline both have exactly N valid insertion slots, so no
  // index adjustment is needed here).
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [reorderRefusal, setReorderRefusal] = useState<string | null>(null)

  // WO UI-12 (BK-72 mission #3): marker-drag state, the SAME "in-memory,
  // never read back out of DataTransfer mid-drag" discipline draggingId
  // above already establishes -- `markerDragging` flips true for the ENTIRE
  // duration of a rollback-marker drag (MarkerRow's own onDragStart/
  // onDragEnd), `markerDragOverIndex` is the row slot currently hovered.
  // Kept entirely separate from draggingId/dragOverIndex (never shared
  // state) so the marker indicator and the reorder indicator can never both
  // read "active" from the same drag -- they gate on which of these two
  // ids/flags is actually set, which a single drag can only ever set one of.
  const [markerDragging, setMarkerDragging] = useState(false)
  const [markerDragOverIndex, setMarkerDragOverIndex] = useState<number | null>(null)

  // WO UI-12 (BK-70/72/73): context menu + delete-confirm dialog state --
  // component-local, same "pure UI state" discipline every other transient
  // interaction state in this file already follows (filterText,
  // creatingFolder, draggingId, ...). `contextMenu` holds the row id the menu
  // was opened for plus the viewport position to render it at (mouse click
  // position for a real right-click, the row's own bounding rect for the
  // keyboard-opened case). `deleteRequestId` is set either by the context
  // menu's "Delete..." item OR directly by the Delete key on a focused row
  // (mission #1's "same delete flow" -- there is exactly one dialog, two
  // ways to reach it).
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [deleteRequestId, setDeleteRequestId] = useState<string | null>(null)

  const dropOnRow = (index: number) => (e: DragEvent) => {
    const featureId = draggedFeatureId(e)
    if (featureId !== null) {
      // WO UI-9: a feature-row-onto-feature-row drop -- the reorder path.
      // Never falls through to the marker-move branch below.
      setDraggingId(null)
      setDragOverIndex(null)
      if (reorder === undefined) return
      e.preventDefault()
      const blocked = reorder.checkReorder(featureId, index)
      if (blocked) {
        // WO UI-9 mission #2: refused HERE, before onReorder is ever called
        // -- the "explain-before-drop" guard, using the exact same
        // checkReorder the live hover indicator already used.
        setReorderRefusal(reorderBlockedReason(dag, featureId, blocked))
        return
      }
      setReorderRefusal(null)
      reorder.onReorder(featureId, index)
      return
    }
    // WO UI-8: rows are now ALSO drag sources (folder membership) once
    // `folders` is wired -- a feature-row-onto-feature-row drop must not be
    // misread as a marker move. An absent/empty payload (jsdom's fireEvent
    // drop with no dataTransfer, or any pre-UI-8 caller) falls through as a
    // marker move exactly like before.
    if (rollback === undefined) return
    e.preventDefault()
    // WO UI-14A (D1, UI-14.report.json defects[1]): dropOnRow(index) alone
    // can only ever reach markerForSlot(order, index) -- index ranges
    // 0..order.length-1 (real row positions), so slot=order.length ('end',
    // nothing rolled back) was NEVER reachable by drag, only by the down-
    // arrow button. Dropping on the BOTTOM HALF of the LAST row now reaches
    // 'end'; the TOP half still reaches slot=order.length-1 (roll back just
    // the last feature) exactly as before, so no existing drag target is
    // lost.
    if (index === order.length - 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const relativeY = e.clientY - rect.top
      if (relativeY >= rect.height / 2) {
        rollback.onMoveMarker(markerForSlot(order, order.length))
        return
      }
    }
    rollback.onMoveMarker(markerForSlot(order, index))
  }

  const matchedCount = visibleOrder.filter((id) => {
    const node = dag.getNode(id)
    if (!node) return false
    return matchesFeatureFilter(query, featureFilterFacts(dag, statuses, id, node))
  }).length

  // WO UI-12 (BK-70 mission #2): which folders currently have at least one
  // member -- drives FolderChip's persistent "drag features here" hint for
  // the ones that don't. Scanned straight from `folders.folderOf` over the
  // user-visible order (private datum membership cannot make an empty folder
  // look occupied), same "read
  // the same source the rows already read" discipline featureFilterFacts
  // above follows.
  const foldersWithMembers = new Set<string>()
  if (folders !== undefined) {
    for (const id of visibleOrder) {
      const fid = folders.folderOf(id)
      if (fid !== null) foldersWithMembers.add(fid)
    }
  }
  // WO UI-12 (BK-70 mission #2): a feature-row drag is active for the WHOLE
  // duration of the drag (draggingId set at onDragStart, cleared at
  // onDragEnd/drop) -- folder chips read this directly rather than their own
  // per-chip hover state, so every chip lights up together the instant the
  // drag begins (the discoverability fix), not one at a time as the cursor
  // happens to cross each one.
  const folderDragActive = draggingId !== null

  return (
    <div
      data-testid="feature-tree"
      style={{
        background: chrome === 'flush' ? 'transparent' : 'var(--surface-1)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--font-size-md)',
        border: chrome === 'flush' ? 'none' : '1px solid var(--border-subtle)',
        borderRadius: chrome === 'flush' ? 0 : 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* WO UI-8 (BK-42 mission #1): the filter bar. Plain text matches name/
          type; :errors, :suppressed, :type <kind> operators AND together with
          each other and with any remaining free text (treeFilter.ts). Always
          rendered (not gated on a prop) -- see filterText's own comment. */}
      <div
        data-testid="tree-filter-bar"
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Filter size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          type="text"
          data-testid="tree-filter-input"
          value={filterText}
          placeholder="Filter by name, :errors, :suppressed, :type <kind>..."
          aria-label="Filter design tree"
          onChange={(e) => setFilterText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setFilterText('')
            }
          }}
          style={{ flex: 1, background: 'transparent', color: 'var(--text-primary)', border: 'none', outline: 'none' }}
        />
        {filterText.length > 0 && (
          <button
            type="button"
            data-testid="tree-filter-clear"
            data-tooltip="Clear filter"
            aria-label="Clear filter"
            onClick={() => setFilterText('')}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
          >
            <X size={13} />
          </button>
        )}
        <span data-testid="tree-filter-count" style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
          {filteredCountLabel(matchedCount, visibleOrder.length, query)}
        </span>
      </div>

      {/* WO UI-8 (mission #2): folder management strip -- entirely gated on
          the `folders` prop, same optional/additive contract as suppress/
          rollback/visibility above. */}
      {folders !== undefined && (
        <div data-testid="tree-folder-strip">
          <div
            data-testid={`folder-chip-${ROOT_DROP_ID}`}
            data-drop-active={folderDragActive}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const id = draggedFeatureId(e)
              if (id !== null) folders.onMoveToFolder(id, null)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              fontSize: 11,
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border-subtle)',
              background: folderDragActive ? 'var(--select-ui-bg)' : 'transparent',
              outline: folderDragActive ? '1px dashed var(--text-muted)' : 'none',
              outlineOffset: -1,
            }}
          >
            <span>Root (drop here to ungroup)</span>
          </div>
          {folders.list.map((folder) => (
            <FolderChip
              key={folder.id}
              folder={folder}
              collapsed={folders.isCollapsed(folder.id)}
              suppressed={folders.isFolderSuppressed(folder.id)}
              dragActive={folderDragActive}
              isEmpty={!foldersWithMembers.has(folder.id)}
              onToggleCollapse={() => folders.onToggleCollapse(folder.id)}
              onRename={(name) => folders.onRenameFolder(folder.id, name)}
              onDelete={() => folders.onDeleteFolder(folder.id)}
              onToggleSuppress={() => folders.onToggleFolderSuppress(folder.id)}
              onDropFeature={(nodeId) => folders.onMoveToFolder(nodeId, folder.id)}
            />
          ))}
          {creatingFolder ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}>
              <input
                type="text"
                data-testid="tree-new-folder-input"
                value={newFolderName}
                autoFocus
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const trimmed = newFolderName.trim()
                    if (trimmed.length > 0) folders.onCreateFolder(trimmed)
                    setNewFolderName('')
                    setCreatingFolder(false)
                  } else if (e.key === 'Escape') {
                    setNewFolderName('')
                    setCreatingFolder(false)
                  }
                }}
                style={{ flex: 1, background: 'var(--surface-2, #10151b)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              />
              <button
                type="button"
                data-testid="tree-new-folder-confirm"
                data-tooltip="Create folder"
                aria-label="Create folder"
                onClick={() => {
                  const trimmed = newFolderName.trim()
                  if (trimmed.length > 0) folders.onCreateFolder(trimmed)
                  setNewFolderName('')
                  setCreatingFolder(false)
                }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
              >
                <FolderPlus size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="tree-new-folder-button"
              data-tooltip="New folder"
              onClick={() => setCreatingFolder(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px 8px',
                fontSize: 11,
              }}
            >
              <FolderPlus size={13} /> New folder
            </button>
          )}
        </div>
      )}

      {/* WO UI-9 (BK-41 mission #2): "explain-before-drop" -- the plain
          reason (naming the blocking feature) an illegal drop was refused,
          set by dropOnRow, cleared on the next drag start or dismiss. */}
      {reorderRefusal !== null && (
        <div
          data-testid="reorder-refusal-message"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 11, color: '#e5484d', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Ban size={12} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{reorderRefusal}</span>
          <button
            type="button"
            data-testid="reorder-refusal-dismiss"
            aria-label="Dismiss"
            onClick={() => setReorderRefusal(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', padding: 2 }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {visibleOrder.length === 0 ? (
        <div style={{ padding: 10, color: 'var(--text-muted)' }}>(no features)</div>
      ) : (
        (() => {
          // WO SKC-5-R1 (Finding 2): every row still renders exactly once,
          // in the SAME per-id computation as before (including marker-row
          // placement, bound to `index` in the ORIGINAL structural `order` --
          // untouched below). Only the on-screen POSITION of a folded
          // datum's row is deliberately reshuffled afterward (see
          // displayOrder below), because DAG insertion order always puts a
          // datum BEFORE the sketch that consumes it (the datum must regen
          // first), which is the opposite of "nested under its sketch".
          const rowById = new Map<string, ReactNode>()
          order.forEach((id, index) => {
          const node = dag.getNode(id)
          if (node === undefined) return
          const Icon = isReferenceImagePayload(node.payload) ? ImageIcon : rowIcon(id, node.kind) ?? Box
          const snap = statuses.get(id)
          const status = snap?.status ?? 'dirty'
          const isSelected = id === selectedId
          // WO UI-6 (BK-39, mission #1): "root" (this node's own flag) vs
          // "cascade" (inherited from a suppressed upstream node it
          // consumes) are two DISTINCT states, both derived live from `dag`
          // -- never conflated, and never dependent on a scheduler being
          // wired (dag.isEffectivelySuppressed is pure DAG structure).
          const suppressedRoot = node.suppressed
          const suppressedCascade = !suppressedRoot && dag.isEffectivelySuppressed(id)
          const suppressedState: 'root' | 'cascade' | 'none' = suppressedRoot ? 'root' : suppressedCascade ? 'cascade' : 'none'
          // WO UI-7 (BK-40): rolled-back is a THIRD, independent state --
          // always computed (read-only, regardless of whether `rollback` is
          // wired) so `data-rolled-back` never lies; the ROW's visual
          // treatment (icon/opacity/strikethrough) defers to suppress first
          // (mission's "a user-suppressed feature stays suppressed when the
          // marker passes it" -- suppression is the more specific, directly-
          // authored state) and only falls through to the rollback glyph
          // when the row isn't ALSO suppressed.
          const rolledBack = dag.isRolledBack(id)
          const visualState: 'root' | 'cascade' | 'rolledBack' | 'none' =
            suppressedState !== 'none' ? suppressedState : rolledBack ? 'rolledBack' : 'none'
          // WO UI-8 (mission #1/#2): whether THIS row draws at all -- a
          // filtered-out OR folder-collapsed row is simply not rendered, but
          // (critically) the loop keeps iterating the SAME full `order` at
          // the SAME index either way, so markerSlot === index (below) is
          // never affected by either one -- "the marker binds to feature
          // ORDER, not the folder view" (mission #4) falls out of this for
          // free rather than needing a second position recomputation.
          const matchesFilter = matchesFeatureFilter(query, featureFilterFacts(dag, statuses, id, node))
          // WO SKC-15C (audit major #3, defense in depth): a genesis row is a permanent top-level
          // fixture and can never sit in a folder -- TreeFolderStore.setMembership/restore now refuse
          // a genesis id at the join point, so `folderOf` returns null for one. Forcing it to null
          // HERE too means even a store that somehow held a genesis membership could not hide the row
          // by collapsing its folder. The auditor's phrasing: "FeatureTree applies folderCollapsed to
          // every ID without a genesis exception." This is that exception.
          const folderId = isGenesisNodeId(id) ? null : (folders?.folderOf(id) ?? null)
          const folderCollapsed = folderId !== null && folders !== undefined && folders.isCollapsed(folderId)
          const shouldRenderRow = matchesFilter && !folderCollapsed
          const userVisibleNode = isFeatureTreeNodeVisible(dag, id)
          // WO UI-9 (BK-41): the live legal/illegal drop indicator -- only
          // computed for the row currently under the cursor DURING an
          // active feature-row drag (draggingId set at onDragStart, see its
          // own comment above). Reuses reorder.checkReorder directly (never
          // a second parallel legality derivation), so hover and drop can
          // never disagree.
          const reorderPreview =
            reorder !== undefined && draggingId !== null && dragOverIndex === index ? reorder.checkReorder(draggingId, index) : undefined
          const dropIndicator: 'legal' | 'illegal' | 'none' = reorderPreview === undefined ? 'none' : reorderPreview === null ? 'legal' : 'illegal'
          // WO SKC-15 (criterion 1): Origin and the base planes are never draggable -- not into a
          // folder, not to another timeline slot. dag.checkReorder/reorderNode refuse them by name
          // regardless; this stops the drag from ever starting, so the user gets no affordance that
          // would only end in a refusal.
          const isGenesisRow = isGenesisNodeId(id)
          const draggableRow = (folders !== undefined || reorder !== undefined) && !isGenesisRow
          // WO SKC-5-R1 (Finding 2): this row's fold parent, if it is an
          // auto-created face-plane datum folded under its consuming sketch
          // (see datumFoldTargets above) -- undefined for every other row.
          const foldedUnderId = datumFoldTargets.get(id)
          const row = !shouldRenderRow ? null : (
            <div
              key={id}
              className="wb-tree-row"
              data-testid={`feature-row-${id}`}
              data-suppressed={suppressedState}
              data-rolled-back={rolledBack}
              data-reorder-drop={dropIndicator}
              data-folded-under={foldedUnderId ?? undefined}
              role="treeitem"
              hidden={!userVisibleNode}
              aria-hidden={!userVisibleNode || undefined}
              aria-selected={isSelected}
              tabIndex={userVisibleNode ? 0 : -1}
              onClick={() => onSelect?.(id)}
              onContextMenu={(e) => {
                // WO UI-12 (BK-70/72/73 mission #1): native right-click ->
                // the tree context menu, positioned at the real cursor
                // location. preventDefault suppresses the browser's own
                // context menu (never both at once).
                e.preventDefault()
                e.stopPropagation()
                onSelect?.(id)
                setContextMenu({ nodeId: id, x: e.clientX, y: e.clientY })
              }}
              onKeyDown={(e) => {
                // WO UI-12 (mission #1): keyboard-equivalent menu open (menu
                // key / Shift+F10 -- the two standard "open context menu"
                // key combos) positions the SAME menu at the row's own
                // bounding rect (no mouse coordinates available from a
                // keyboard event). Delete on a focused row skips the menu
                // entirely and opens the delete-confirm dialog directly --
                // "the same delete flow" mission #1 requires, not a second
                // one.
                if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  setContextMenu({ nodeId: id, x: rect.left, y: rect.bottom })
                } else if (e.key === 'Delete' && del !== undefined && !isGenesisRow) {
                  // WO SKC-15: Delete on a focused Origin/base-plane row does nothing -- it never
                  // even opens the confirm dialog. dag.removeNode would throw GenesisNodeError.
                  e.preventDefault()
                  setDeleteRequestId(id)
                }
              }}
              draggable={draggableRow}
              onDragStart={
                draggableRow
                  ? (e) => {
                      e.dataTransfer.setData('text/plain', id)
                      setDraggingId(id)
                      setReorderRefusal(null)
                    }
                  : undefined
              }
              onDragEnd={
                draggableRow
                  ? () => {
                      setDraggingId(null)
                      setDragOverIndex(null)
                    }
                  : undefined
              }
              onDragOver={
                rollback !== undefined || reorder !== undefined
                  ? (e) => {
                      e.preventDefault()
                      if (reorder !== undefined) setDragOverIndex(index)
                      // WO UI-12 (BK-72 mission #3): tracks the marker's own
                      // live insertion indicator, entirely separate from
                      // dragOverIndex above -- markerDragging can only be
                      // true while a marker drag (not a feature-row drag) is
                      // in flight, see its own state comment.
                      if (rollback !== undefined && markerDragging) {
                        // WO UI-14A-R1 (D1 fix, UI-14A.audit.json findings[2]):
                        // dropOnRow below resolves the LAST row's bottom half
                        // to slot=order.length (the end slot), not slot=index
                        // -- mirror that SAME half-slot test here so the live
                        // indicator never previews "before the last row" for a
                        // drop that actually lands after it. Every other row
                        // (and the last row's top half) is unaffected.
                        if (index === order.length - 1) {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const relativeY = e.clientY - rect.top
                          if (relativeY >= rect.height / 2) {
                            setMarkerDragOverIndex(order.length)
                            return
                          }
                        }
                        setMarkerDragOverIndex(index)
                      }
                    }
                  : undefined
              }
              onDragLeave={
                reorder !== undefined || rollback !== undefined
                  ? () => {
                      if (reorder !== undefined) setDragOverIndex((cur) => (cur === index ? null : cur))
                      // Clears whichever of the two slots THIS row's dragover
                      // above may have set (index, or order.length via the
                      // last-row bottom-half shortcut) -- leaving either must
                      // not strand the indicator lit.
                      if (rollback !== undefined) {
                        setMarkerDragOverIndex((cur) => (cur === index || (index === order.length - 1 && cur === order.length) ? null : cur))
                      }
                    }
                  : undefined
              }
              onDrop={rollback !== undefined || reorder !== undefined ? dropOnRow(index) : undefined}
              data-tooltip={dropIndicator === 'illegal' && draggingId !== null ? (reorderPreview ? reorderBlockedReason(dag, draggingId, reorderPreview) : undefined) : undefined}
              style={{
                display: userVisibleNode ? 'flex' : 'none',
                alignItems: 'center',
                gap: 6,
                minHeight: foldedUnderId !== undefined ? 'var(--row-compact, 22px)' : 'var(--row-default)',
                // Folded datum rows nest visually under their consuming
                // sketch row (Finding 2) -- extra left padding is the ONLY
                // signal a plain child div needs to read as "nested", same
                // technique FolderChip's own child rows already use.
                padding: foldedUnderId !== undefined ? '0 8px 0 26px' : '0 8px',
                cursor: onSelect ? 'pointer' : 'default',
                background: isSelected ? 'var(--select-ui-bg)' : 'transparent',
                // UI-BRAND-B2-1: selected-row chrome parity with the CAM Design
                // Tree's setup rows (.tree-setup-active, app.css) -- same fill
                // token (--select-ui-bg/--bg-active both alias --surface-selected)
                // PLUS the same 2px left accent stripe (--accent-blue, the
                // doctrine-conformant "blue = UI rows" token, tokens.css:176-178).
                // Deliberately NOT the geo/op rows' rgba+accent-cyan pattern --
                // that pairing is the drifted one Rank-7/B2-5 owns; this batch is
                // chrome-only and must not pre-empt that separately-gated call.
                borderLeft: isSelected ? '2px solid var(--accent-blue)' : '2px solid transparent',
                borderBottom: '1px solid var(--border-subtle)',
                borderTop: dropIndicator === 'legal' ? '2px solid #4caf50' : dropIndicator === 'illegal' ? '2px solid #e5484d' : '2px solid transparent',
                opacity: foldedUnderId !== undefined ? 0.85 : visualState === 'none' ? 1 : 0.5,
                fontSize: foldedUnderId !== undefined ? 'var(--font-size-sm, 12px)' : undefined,
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'var(--surface-hover)'
                // WO SKC-15C (audit major #1): report the hover to the host, which drives the same
                // viewport glyph selection drives. The CSS background above is the row-local feedback;
                // this is the VIEWPORT feedback the audit found missing.
                onHover?.(id)
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'transparent'
                onHover?.(null)
              }}
            >
              {visualState === 'none' ? (
                <Icon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              ) : visualState === 'rolledBack' ? (
                <Rewind
                  size={14}
                  data-testid={`feature-row-rolledback-glyph-${id}`}
                  aria-label="Rolled back"
                  style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                />
              ) : (
                <Ban
                  size={14}
                  data-testid={`feature-row-suppressed-glyph-${id}`}
                  aria-label={visualState === 'root' ? 'Suppressed' : 'Suppressed (upstream)'}
                  style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                />
              )}
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textDecoration: visualState === 'none' ? 'none' : visualState === 'rolledBack' ? 'none' : 'line-through',
                  fontStyle: visualState === 'rolledBack' ? 'italic' : 'normal',
                }}
              >
                {nodeLabel(id, node.payload)}
                {suppressedState === 'cascade' && (
                  <span style={{ marginLeft: 6, fontStyle: 'italic', textDecoration: 'none' }}>(upstream suppressed)</span>
                )}
                {visualState === 'rolledBack' && <span style={{ marginLeft: 6 }}>(rolled back)</span>}
              </span>
              {/* WO UI-17 (criterion 5): the genesis rows' show/hide eye for their always-on
                  viewport glyph -- the ONE row action a permanent reference item carries. Sits at
                  ~0.55 opacity at rest, full on row hover (.wb-row-action, the autohide doctrine,
                  COHESION-STANDARD section 3), never fully hidden. */}
              {genesisVisibility !== undefined && isGenesisRow && (
                <button
                  type="button"
                  className="wb-row-action"
                  data-testid={`genesis-visible-${id}`}
                  aria-pressed={genesisVisibility.isVisible(id)}
                  data-tooltip={genesisVisibility.isVisible(id) ? 'Hide in viewport' : 'Show in viewport'}
                  aria-label={genesisVisibility.isVisible(id) ? 'Hide in viewport' : 'Show in viewport'}
                  onClick={(e) => {
                    e.stopPropagation()
                    genesisVisibility.onToggle(id)
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 2,
                  }}
                >
                  {genesisVisibility.isVisible(id) ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              )}
              {/* WO SKC-15: no suppress affordance on a genesis row -- suppressing Origin or a base
                  plane would only strand every sketch that consumes it (dag.setSuppressed refuses). */}
              {suppress !== undefined && !isGenesisRow && (
                <button
                  type="button"
                  data-testid={`feature-row-suppress-${id}`}
                  aria-pressed={suppressedRoot}
                  data-tooltip={suppressedRoot ? 'Unsuppress' : 'Suppress'}
                  aria-label={suppressedRoot ? 'Unsuppress' : 'Suppress'}
                  onClick={(e) => {
                    e.stopPropagation()
                    suppress.onToggleSuppress(id)
                  }}
                  style={{
                    background: suppressedRoot ? 'var(--select-ui-bg)' : 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 2,
                  }}
                >
                  <Ban size={13} />
                </button>
              )}
              {hide !== undefined && hasPersistedTreeVisibility(node) && (
                <button
                  type="button"
                  className="wb-row-action"
                  data-testid={`feature-row-hide-${id}`}
                  aria-pressed={hide.isHidden(id)}
                  data-tooltip={hide.isHidden(id) ? 'Show' : 'Hide'}
                  aria-label={hide.isHidden(id) ? 'Show' : 'Hide'}
                  onClick={(e) => {
                    e.stopPropagation()
                    hide.onToggleHidden(id)
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 2,
                  }}
                >
                  {hide.isHidden(id) ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
              {visibility !== undefined && node.kind === 'body' && (
                <>
                  <button
                    type="button"
                    data-testid={`feature-row-isolate-${id}`}
                    aria-pressed={visibility.isIsolated(id)}
                    data-tooltip="Isolate"
                    aria-label="Isolate"
                    onClick={(e) => {
                      e.stopPropagation()
                      visibility.onIsolate(id)
                    }}
                    style={{
                      background: visibility.isIsolated(id) ? 'var(--select-ui-bg)' : 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 2,
                    }}
                  >
                    <Target size={13} />
                  </button>
                  <button
                    type="button"
                    data-testid={`feature-row-visible-${id}`}
                    aria-pressed={visibility.isBodyVisible(id)}
                    data-tooltip={visibility.isBodyVisible(id) ? 'Hide' : 'Show'}
                    aria-label={visibility.isBodyVisible(id) ? 'Hide' : 'Show'}
                    onClick={(e) => {
                      e.stopPropagation()
                      visibility.onToggleVisible(id)
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 2,
                    }}
                  >
                    {visibility.isBodyVisible(id) ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                </>
              )}
              {folders !== undefined && folderId !== null && (
                <button
                  type="button"
                  data-testid={`feature-row-folder-tag-${id}`}
                  data-tooltip={`In folder '${folders.list.find((f) => f.id === folderId)?.name ?? folderId}' -- click to remove`}
                  aria-label="Remove from folder"
                  onClick={(e) => {
                    e.stopPropagation()
                    folders.onMoveToFolder(id, null)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    background: 'transparent',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm, 3px)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0 4px',
                    fontSize: 10,
                    flexShrink: 0,
                  }}
                >
                  <Folder size={11} />
                </button>
              )}
              <FeatureStatusBadge status={status} tooltip={diagSummary(snap?.diagnostics ?? [])} />
            </div>
          )
          rowById.set(
            id,
            <Fragment key={id}>
              {/* WO UI-12 (BK-72 mission #3): the marker's OWN live insertion
                  indicator -- gated on markerDragging (a rollback-marker drag
                  specifically), so it can never render during a feature-row
                  drag, and visually distinct from the reorder indicator
                  above (a dashed amber bar vs. the row's own green/red top
                  border), reusing the exact same slot index math
                  (markerForSlot/index) the real MarkerRow placement below
                  already uses. */}
              {rollback !== undefined && markerDragging && markerDragOverIndex === index && (
                <div
                  data-testid={`marker-drag-indicator-${id}`}
                  data-marker-drag-indicator="true"
                  style={{ height: 3, margin: '0 6px', borderRadius: 2, background: 'var(--status-outdated, #caa53d)' }}
                />
              )}
              {rollback !== undefined && markerSlot === index && (
                <MarkerRow
                  order={order}
                  slot={markerSlot}
                  onMoveMarker={rollback.onMoveMarker}
                  onMarkerDragStart={() => setMarkerDragging(true)}
                  onMarkerDragEnd={() => {
                    setMarkerDragging(false)
                    setMarkerDragOverIndex(null)
                  }}
                />
              )}
              {row}
            </Fragment>,
          )
          })
          // Stable display order keeps each private datum adjacent to its
          // owning sketch in the DOM projection. UI-55 marks that row hidden,
          // inert, and absent from all user-facing counts; the adjacency is
          // retained only for structural marker placement and old documents.
          const displayOrder: string[] = []
          for (const id of order) {
            if (datumFoldTargets.has(id)) continue
            displayOrder.push(id)
            const foldedDatumId = sketchToFoldedDatum.get(id)
            if (foldedDatumId !== undefined) displayOrder.push(foldedDatumId)
          }
          return displayOrder.map((id) => rowById.get(id) ?? null)
        })()
      )}
      {rollback !== undefined && markerSlot === order.length && (
        <MarkerRow
          order={order}
          slot={markerSlot}
          onMoveMarker={rollback.onMoveMarker}
          onMarkerDragStart={() => setMarkerDragging(true)}
          onMarkerDragEnd={() => {
            setMarkerDragging(false)
            setMarkerDragOverIndex(null)
          }}
        />
      )}
      {/* WO UI-14A (D1, UI-14.report.json defects[1]): a persistent trailing
          drop-zone below every row AND below the marker-at-end row itself --
          the second, independent way (alongside the last row's bottom half
          above) to reach slot=order.length by drag: dropping in the
          "trailing empty space" past the last real row. Reuses markerForSlot
          with order.length directly, same as dropOnRow's own rollback
          branch. T-M4: a visible drop indicator (not just a hit-testable
          div) while a marker drag is over it. */}
      {rollback !== undefined && (
        <div
          data-testid="rollback-marker-trailing-dropzone"
          onDragOver={(e) => {
            e.preventDefault()
            if (markerDragging) setMarkerDragOverIndex(order.length)
          }}
          onDragLeave={() => setMarkerDragOverIndex((cur) => (cur === order.length ? null : cur))}
          onDrop={(e) => {
            if (draggedFeatureId(e) !== null) return // feature/folder drag, not a marker drag
            e.preventDefault()
            rollback.onMoveMarker(markerForSlot(order, order.length))
          }}
          style={{
            minHeight: 14,
            borderTop: markerDragging && markerDragOverIndex === order.length ? '2px solid var(--status-outdated, #caa53d)' : '2px solid transparent',
          }}
        />
      )}
      {contextMenu !== null &&
        (() => {
          // Rebound to plain locals immediately: `contextMenu`/`suppress`/
          // `del`/`folders` are narrowed here, but that narrowing does not
          // reliably persist into the nested closures below (TS's control-
          // flow analysis does not follow captured outer bindings into
          // callback bodies) -- these locals carry the narrowed, non-null
          // type into every closure instead.
          const menuNodeId = contextMenu.nodeId
          const menuX = contextMenu.x
          const menuY = contextMenu.y
          const activeSuppress = suppress
          const activeHide = hide
          const activeDel = del
          const activeFolders = folders
          const activeEdit = edit
          const menuNode = dag.getNode(menuNodeId)
          if (menuNode === undefined) return null
          // WO SKC-15 (criterion 1): a genesis row's context menu offers no Delete, no Suppress and
          // no "move to folder" -- all three would be refused by name at the DAG. Passing `undefined`
          // is how TreeContextMenu omits an item, so the menu simply does not present them.
          const genesisMenu = isGenesisNodeId(menuNodeId)
          // WO UI-18 (D3): same omission convention -- a genesis row has no Edit item at all (not
          // even disabled); every other row asks the caller's per-node lookup, which itself decides
          // clickable vs disabled-with-reason.
          const editEntry = activeEdit !== undefined && !genesisMenu ? activeEdit.editEntryFor(menuNodeId) : undefined
          return (
            <TreeContextMenu
              x={menuX}
              y={menuY}
              suppressed={activeSuppress !== undefined && !genesisMenu ? menuNode.suppressed : undefined}
              hidden={activeHide !== undefined && hasPersistedTreeVisibility(menuNode) ? activeHide.isHidden(menuNodeId) : undefined}
              onToggleHidden={activeHide !== undefined && hasPersistedTreeVisibility(menuNode) ? () => activeHide.onToggleHidden(menuNodeId) : undefined}
              onToggleSuppress={activeSuppress !== undefined && !genesisMenu ? () => activeSuppress.onToggleSuppress(menuNodeId) : undefined}
              onDeleteRequest={activeDel !== undefined && !genesisMenu ? () => setDeleteRequestId(menuNodeId) : undefined}
              editEntry={editEntry}
              onExport={modelBodyExportable(dag, menuNodeId) ? () => openExportWindow(MODEL_ROW_ID) : undefined}
              folderMenu={
                activeFolders !== undefined && !genesisMenu
                  ? {
                      currentFolderId: activeFolders.folderOf(menuNodeId),
                      options: activeFolders.list,
                      onMoveToFolder: (folderId) => activeFolders.onMoveToFolder(menuNodeId, folderId),
                      onCreateFolder: (name) => activeFolders.onCreateFolder(name),
                      onRemoveFromFolder: () => activeFolders.onMoveToFolder(menuNodeId, null),
                    }
                  : undefined
              }
              onClose={() => setContextMenu(null)}
            />
          )
        })()}
      {del !== undefined &&
        deleteRequestId !== null &&
        (() => {
          const activeDel = del
          const targetId = deleteRequestId
          const targetNode = dag.getNode(targetId)
          if (targetNode === undefined) return null
          const consumerIds = activeDel.consumersOf(targetId)
          return (
            <DeleteConfirmDialog
              targetName={nodeLabel(targetId, targetNode.payload)}
              consumerNames={consumerIds.map((cid) => nodeLabel(cid, dag.getNode(cid)?.payload ?? {}))}
              onCancel={() => setDeleteRequestId(null)}
              onConfirm={() => {
                activeDel.onDelete(targetId)
                setDeleteRequestId(null)
              }}
            />
          )
        })()}
    </div>
  )
}
