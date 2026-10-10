import { textFor, useText } from '../../i18n'
import { Fragment, useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { NumericInput } from '../ui/NumericInput'
import {
  ChevronRight, ChevronDown, Plus, Trash2,
  Settings2, Play, AlertCircle, AlertTriangle, CheckCircle2,
  Clock, Loader2, Layers, Wrench, FileBox, Box, Eye, EyeOff,
  Pencil, PenTool, Copy, Move3d, Wand2, Lock, Unlock, FilePlus2,
  Filter, X, ChevronsDownUp, ChevronsUpDown, ListTree, RefreshCw,
  Folder, FolderOpen, FolderPlus, LayoutGrid, GripVertical, Sprout, Ungroup,
  Power, PowerOff, Combine, Anchor, ArrowDownToLine, Hand,
} from 'lucide-react'
import { isValidReachShortfall, reachShortfallMessage } from '../cam/ReachShortfallNotice'
import { seedGeometryIds, nestOwnedGeometryIds } from '../../lib/cam/nesting/seedSelectors'
import { useCamStore, deferGeometryBytePurge, machineActionsOf, outdatedReasonText, setupListOrder } from '../../store'
import { isWorkholdingGeometry } from '../../store/dispatchGeo'
import { viseInstances } from '../../lib/workholding/vise'
import { viseOpeningLabel } from '../workholding/ViseEditor'
import { ClampTreeGroup, selectClamp, useClampUi } from '../workholding/ClampEditor'
import { importWorkholdingFromFile, isWorkholdingFileName } from '../workholding/WorkholdingReuse'
import { rowDrawnInstanceIds } from '../../lib/workholding/reuse'
import { clampDefinitions } from '../../lib/workholding/clamps'
import { useUiPrefs } from '../../store/uiPrefs'
import { unitLabel, fmtArea, areaLabel, type Units } from '../../lib/ui/unitFormat'
import { normalizeQuery, matchesFilter, isVisible, filteredCountLabel } from './treeFilter'
import { TreeContextMenu } from './TreeContextMenu'
import { collectExportGroups, openExportWindow } from '../../lib/exportCenter'
import { TreeRenameLabel } from './TreeRenameLabel'
import type { TreeContextTarget, TreeMenuAction } from '../../lib/tree/treeContextMenu'
import { setupEnabledCutTimeMs } from '../../lib/cam/operationSuppression'
import type { CutTimeMotion } from '../../lib/cam/runtime'
import { machineCutTimeMotion } from '../../lib/simulation/machineCutTimeMotion'
import { collectOperationFolderTreeIds } from '../../lib/tree/operationFolders'
import { optimizeLoops } from '../../lib/geometry/loopOptimizer'
import { projectSTLToLoopsInPlane, buildPlaneFrame } from '../../lib/geometry/stlProjection'
import { assignStableLoopIds } from '../../lib/geometry/loopId'
import type { ProjectionPlane, ProjectionZAnchor } from '../../types'
import { machineActionLabel } from '../../types'
import { removeCachedSTL, loadCachedSTL, cacheSTL } from '../../lib/stlCache'
import { removeCachedStep, loadCachedStep, cacheStep } from '../../lib/stepCache'
import { removeCachedModelBodyDisplay } from '../../lib/modelBodyDisplayCache'
import { isModelOriginGeometry, resolveOwningModelItemId, isWrappableGeometryRow } from '../../lib/cam/modelOrigin'
import { isMeshBooleanSourceRow, isBooleanResultRow, hasModelBooleanBody } from '../../lib/cam/booleanMeshModel'
import { readStep, setBrepPayload, removeBrepPayload, deriveSection } from '../../lib/cam/geometry/occt/model/modelClient'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { remove2DGeometry as removeCache2D, load2DGeometry, cache2DGeometry } from '../../lib/geometry2dCache'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { formatDurationHMS } from '../../lib/format'
import type { MachineAction, Operation, Setup, SceneStock, ImportedGeometry, GeometryFolder, ModelItemRecord, OperationFolder, Layer2D, Loop2D, FixedStockItem, AutoStockItem, PhysicalStock, NestRecord } from '../../types'
import { resolveStockMembershipState, derivedStockMembers } from '../../store/stockAssignment'
import { resolveSetupWorkOffset } from '../../lib/post/workOffsets'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { GeometryColorSwatch } from './GeometryColorSwatch'

// ── Viewport handle ────────────────────────────────────────────────────────────
import type { Vec3 } from '../../types'

const shellText = textFor('app-shell-settings-menus')

// Shared tooltip for the STL "slice" and STEP "section" buttons: both now run the
// SAME two-step flow (pick a horizontal slice height, then pick a placement plane)
// and carry the SAME Layers icon, so the user reads them as one capability.
const sliceToLoopsLabel = () => shellText('DesignTree.sliceTo2DLoops')

// ── Collapsed-row fail-up rollup (WO-1828) ──────────────────────────────────
// One rule, computed once, applied identically to every collapsible row kind
// (geometry folder, nest, operation folder, setup): error beats needs-recompute
// beats clear. Expanded rows are unaffected — their own per-row indicators
// (statusIcon, the nest recompute button, projectionStale) already show the
// real thing; the rollup badge exists only to surface it through a chevron.
type RollupTier = 'error' | 'stale' | null

const worseRollupTier = (a: RollupTier, b: RollupTier): RollupTier =>
  a === 'error' || b === 'error' ? 'error' : (a === 'stale' || b === 'stale') ? 'stale' : null

// Every OperationStatus enumerated (CAM-1-style exhaustiveness by inspection):
// 'error' | 'degraded' | 'unsupported' are the red/trouble statuses (AlertCircle/
// AlertTriangle/Box today) -> rollup 'error'. 'outdated' is the amber
// recompute-needed status (Clock) -> rollup 'stale'. 'pending' | 'computing' |
// 'ready' carry no fail-up signal -> clear.
const operationRollupTier = (op: Operation): RollupTier =>
  op.status === 'error' || op.status === 'degraded' || op.status === 'unsupported' ? 'error'
    : op.status === 'outdated' ? 'stale'
    : null

const nestRollupTier = (nest: Pick<NestRecord, 'status' | 'needsRecompute'>): RollupTier =>
  nest.status === 'error' ? 'error' : nest.needsRecompute ? 'stale' : null

const geometryRollupTier = (geo: Pick<ImportedGeometry, 'projectionStale'>): RollupTier =>
  geo.projectionStale ? 'stale' : null

// Trailing badge, appended after a collapsed row's own actions (matches the
// approved verdict-walkthrough mockup placement) so it reads as one more thing
// at the end of the row rather than a new visual language. Reuses the SAME
// icon vocabulary as the expanded per-operation status badge (statusIcon
// above/below): AlertCircle/status-error for error, Clock/status-outdated for
// needs-recompute. Report-only per Operator's rule-11 fence — no onClick, nothing
// it gates.
// Layout is inline, not a new .tree-rollup-badge CSS rule: this WO's owned
// paths cover DesignTree.tsx but not src/styles/app.css, and the row-actions
// autohide doctrine there (opacity 0.55->1 on hover) must NOT apply to this
// badge anyway -- it reports a fact about hidden content, not an action, so
// it stays fully visible at rest.
const ROLLUP_BADGE_STYLE = { display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: 4 } as const

const RollupBadge = ({ tier, testId }: { tier: RollupTier; testId: string }) => {
  useText('app-shell-settings-menus')
  if (tier === null) return null
  return tier === 'error'
    ? (
      <span style={ROLLUP_BADGE_STYLE} data-testid={testId} data-tier="error"
        data-tooltip={shellText('DesignTree.aCollapsedItemBelowNeedsAttentionError')}>
        <AlertCircle size={11} className="status-error" />
      </span>
    )
    : (
      <span style={ROLLUP_BADGE_STYLE} data-testid={testId} data-tier="stale"
        data-tooltip={shellText('DesignTree.aCollapsedItemBelowNeedsRecompute')}>
        <Clock size={11} className="status-outdated" />
      </span>
    )
}

// ── Determinate progress ring ────────────────────────────────────────────────
// Replaces the indeterminate spinner while an op recomputes: a 12px SVG ring
// filled to `fraction` plus a small %. A stalled % is itself a useful
// "this op may be stuck" signal. `phase` (e.g. "Z level 2/4") shows as a tooltip.
function ProgressRing({ fraction, phase }: { fraction: number; phase?: string }) {
  useText('app-shell-settings-menus')
  const f   = Math.max(0, Math.min(1, fraction))
  const pct = Math.round(f * 100)
  const r   = 5
  const c   = 2 * Math.PI * r
  return (
    <span className="tree-op-progress" data-tooltip={phase ?? shellText('DesignTree.computing', { pct: pct })}>
      <svg width={12} height={12} viewBox="0 0 12 12" className="status-computing">
        <circle cx={6} cy={6} r={r} fill="none" stroke="currentColor"
          strokeOpacity={0.25} strokeWidth={1.5} />
        <circle cx={6} cy={6} r={r} fill="none" stroke="currentColor" strokeWidth={1.5}
          strokeDasharray={c} strokeDashoffset={c * (1 - f)} strokeLinecap="round"
          transform="rotate(-90 6 6)" />
      </svg>
      <span className="tree-op-progress-pct">{pct}%</span>
    </span>
  )
}

export type VpHandle = {
  setSelectedPart?: (id: string | null) => void
  setPartPickMode?: (
    cb: ((id: string) => void) | null,
    allowedIds?: readonly string[],
    selectedIds?: readonly string[],
    presentation?: 'standard' | 'nest-membership',
    /** MW-PICKS-2: optional hover reporter -- fires on hover-target CHANGE
     *  only (never per pointermove frame), so callers can post a plain-words
     *  console line without hand-rolled dedup. */
    onHover?: ((id: string | null) => void) | null,
  ) => void
  setPartPickSelection?: (ids: readonly string[]) => void
  removeSTL?: (id: string) => void
  remove2DGeometry?: (id: string) => void
  rebuild2DGeometry?: (
    id: string,
    loops: ImportedGeometry['loops'],
    layers: ImportedGeometry['layers2d']
  ) => void
  set2DLayerVisible?: (geoId: string, layerId: string, visible: boolean) => void
  setPartColor?: (id: string, color: string) => void
  setPartTransform?: (id: string, position: Vec3, rotation: Vec3) => void
  setFixedStockPosition?: (stockId: string, position: Vec3) => void
  rebuildStock?: (config: SceneStock) => void
  fitAll?: () => void
  setLoopPickMode?: (cb: ((loopId: string, nowSelected: boolean) => void) | null, allowedGeoId?: string | null) => void
  setPickedLoops?: (loopIds: string[]) => void
  // Frame the camera onto a single loop line by id (Drill per-hole review "zoom to hole").
  focusOnLoop?: (loopId: string) => boolean
  // Capture / restore the camera pose (position + target + ortho zoom) so the
  // per-hole review can return the prior view on Back/Esc.
  saveCameraState?: () => { position: Vec3; target: Vec3; zoom: number }
  restoreCameraState?: (state: { position: Vec3; target: Vec3; zoom: number }) => void
  // B-rep face/edge pick mode (Stage 2 viewport API; the op wizard drives it in Stage 4)
  setBrepPickMode?: (
    kind: 'face' | 'edge' | null,
    cb?: ((sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean }, nowSelected: boolean) => void) | null,
    allowedGeoId?: string | null,
  ) => void
  setPickedBrepSelections?: (sels: Array<{ geoId: string; kind: 'face' | 'edge'; index: number }>) => void
  addSTL?: (buffer: ArrayBuffer, id: string, name: string, pos: Vec3, rot: Vec3, color?: string) => Promise<void>
  addBrepModel?: (id: string, payload: BrepModelPayload, name: string, pos: Vec3, rot: Vec3, color?: string) => void
  add2DGeometry?: (id: string, loops: ImportedGeometry['loops'], layers: ImportedGeometry['layers2d'], pos: Vec3, rot: Vec3) => void
  enterStockGizmoMode?: (
    stockId: string,
    position: Vec3,
    onChange: (id: string, pos: Vec3) => void,
    onFinish: (id: string, pos: Vec3) => void
  ) => void
  exitStockGizmoMode?: () => void
  setStockGizmoPosition?: (x: number, y: number, z: number) => void
  projectSTLToLoops?: (partId: string, options: { simplificationTolerance: number; minPerimeter: number; sliceZ?: number }) => { loops: Loop2D[]; layers: Layer2D[] } | null
  setPartProjectedLoops?: (partId: string, loops: Loop2D[], layers: Layer2D[]) => void
  setSTLVisible?: (id: string, visible: boolean) => void
  collectWorldPositions?: (geoId: string) => Float32Array | null
  enterSlicePlaneMode?: (partId: string, onConfirm: (sliceZ: number) => void, onCancel: () => void) => void
  // B-rep Section-at-Z scrub: same interaction as enterSlicePlaneMode, but the
  // preview loops come from previewProvider (async worker derive, MODEL coords)
  // and all Z values are MODEL Z. Returns false if refused (missing/tilted part).
  enterBrepSectionMode?: (
    geoId: string,
    initialModelZ: number,
    previewProvider: (modelZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>>,
    onConfirm: (modelZ: number) => void,
    onCancel: () => void,
  ) => boolean
  // B-rep WORLD-horizontal slice scrub: like enterBrepSectionMode but the cut is
  // a world-horizontal plane (tilted parts allowed, matching STL). previewProvider
  // returns loops already in WORLD XY; all Z values are WORLD Z.
  enterBrepWorldSliceMode?: (
    geoId: string,
    previewProvider: (worldZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean; type: string; area: number }>>,
    onConfirm: (worldZ: number) => void,
    onCancel: () => void,
  ) => boolean
  // M^-1 world-aligned model frame: makes sectionAtPlane flatten loops into WORLD XY.
  worldHorizontalSectionPlane?: (
    geoId: string,
    worldZ: number,
  ) => { origin: [number, number, number]; xAxis: [number, number, number]; yAxis: [number, number, number]; normal: [number, number, number] } | null
  exitSlicePlaneMode?: () => void
  enterTargetPlaneMode?: (geoId: string, onConfirm: (normal: {x:number;y:number;z:number}, centroid: {x:number;y:number;z:number}, zAnchor?: ProjectionZAnchor) => void, onCancel: () => void) => void
  exitTargetPlaneMode?: () => void
  showOptimizationPreview?: (partId: string, before: Loop2D[], after: Loop2D[], frame?: { origin:{x:number;y:number;z:number}; xAxis:{x:number;y:number;z:number}; yAxis:{x:number;y:number;z:number} }) => void
  hideOptimizationPreview?: () => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

// After moveFixedStockLive rides each member's geo.position in DATA, the member
// PART groups in the 3D scene must be repositioned too or they lag the stock box
// until a full viewportRefreshTrigger rebuild. This mirrors the proven part-drag
// sync (Viewport.tsx setGeometryTransform -> setPartTransform). Read geometry
// AFTER the ride so positions already reflect the move. O(members), cheap enough
// to call per live frame to match the stock-box move cadence.
function syncStockMembersToViewport(stockId: string): void {
  const vp = getVp()
  if (!vp?.setPartTransform) return
  const geometry = useCamStore.getState().project.geometry
  for (const g of geometry) {
    if (g.stockId !== stockId) continue
    vp.setPartTransform(g.id, g.position, g.rotation ?? { x: 0, y: 0, z: 0 })
  }
}

// ── Inline rename target (P2, clutter audit) ─────────────────────────────────
// The design tree holds ONE rename target at a time; TreeRenameLabel renders
// the in-place editor for whichever row matches and the commit routes through
// that row type's EXISTING store rename action. 'seed' is the nest's source
// child row — it renames the underlying geometry (updateGeometryName) but is a
// distinct kind so a geometry that is BOTH a root row and a nest source never
// shows two editors at once.
export type TreeRenameTarget =
  | { kind: 'project' }
  | { kind: 'geometry'; id: string }
  | { kind: 'seed'; id: string }
  | { kind: 'layer'; geoId: string; layerId: string }
  | { kind: 'loop'; geoId: string; loopId: string }
  | { kind: 'folder'; id: string }
  | { kind: 'model-item'; id: string }
  | { kind: 'nest'; id: string }
  | { kind: 'stock-fixed'; id: string }
  | { kind: 'stock-auto'; id: string }
  | { kind: 'setup'; id: string }
  | { kind: 'op'; setupId: string; opId: string }
  | { kind: 'op-folder'; setupId: string; folderId: string }
  // WO-2172: a placed vise (renames its definition via renameWorkholding).
  | { kind: 'workholding'; id: string }

// ── Helper ────────────────────────────────────────────────────────────────────
function loopLabel(loop: Loop2D, units: Units): string {
  if (loop.name?.trim()) return loop.name.trim()
  if (loop.type === 'open')    return shellText('DesignTree.openPath')
  const area = `${fmtArea(loop.area, units)} ${areaLabel(units)}`
  if (loop.type === 'hole')    return shellText('DesignTree.hole', { area: area })
  return shellText('DesignTree.contour', { area: area })
}

// ── Main component ─────────────────────────────────────────────────────────────
export function DesignTree() {
  useText('app-shell-settings-menus')
  const project              = useCamStore((s) => s.project)
  const cutTimeMotion        = useMemo(() => machineCutTimeMotion(project.machine), [project.machine])
  const viewer               = useCamStore((s) => s.viewer)
  const setActiveSetup            = useCamStore((s) => s.setActiveSetup)
  const setActiveOperation        = useCamStore((s) => s.setActiveOperation)
  const removeOperation           = useCamStore((s) => s.removeOperation)
  const removeSetup               = useCamStore((s) => s.removeSetup)
  const computeOperationToolpath  = useCamStore((s) => s.computeOperationToolpath)
  const computeAllToolpaths       = useCamStore((s) => s.computeAllToolpaths)
  const openEditOperation         = useCamStore((s) => s.openEditOperation)
  const openEditSetup             = useCamStore((s) => s.openEditSetup)
  // P2 inline rename: the SAME store actions the edit modals commit names
  // through (SetupModal -> updateSetup, NewOperationModal -> updateOperation).
  const updateSetup               = useCamStore((s) => s.updateSetup)
  const updateOperation           = useCamStore((s) => s.updateOperation)
  const duplicateOperation        = useCamStore((s) => s.duplicateOperation)
  const addGeometry          = useCamStore((s) => s.addGeometry)
  const removeGeometry       = useCamStore((s) => s.removeGeometry)
  const setSelectedGeometry  = useCamStore((s) => s.setSelectedGeometry)
  const updateGeometryColor  = useCamStore((s) => s.updateGeometryColor)
  // WO-1590 (mating S0): a body (or fixed stock) can be locked in place.
  const setGeometryLocked    = useCamStore((s) => s.setGeometryLocked)
  const setFixedStockLocked  = useCamStore((s) => s.setFixedStockLocked)
  const toggleGeometryLayer  = useCamStore((s) => s.toggleGeometryLayer)
  const updateGeometryLayer  = useCamStore((s) => s.updateGeometryLayer)
  const updateGeometryLoopName = useCamStore((s) => s.updateGeometryLoopName)
  const deleteGeometryLayer  = useCamStore((s) => s.deleteGeometryLayer)
  const addGeometryLayer     = useCamStore((s) => s.addGeometryLayer)
  const moveLoopToLayer      = useCamStore((s) => s.moveLoopToLayer)
  const addFixedStock        = useCamStore((s) => s.addFixedStock)
  const updateFixedStock     = useCamStore((s) => s.updateFixedStock)
  const moveFixedStockLive   = useCamStore((s) => s.moveFixedStockLive)
  const removeFixedStock     = useCamStore((s) => s.removeFixedStock)
  const addAutoStock         = useCamStore((s) => s.addAutoStock)
  const updateAutoStock      = useCamStore((s) => s.updateAutoStock)
  const removeAutoStock      = useCamStore((s) => s.removeAutoStock)
  const updateGeometryName   = useCamStore((s) => s.updateGeometryName)
  const setStockMembership   = useCamStore((s) => s.setStockMembership)
  const setGeometryNoStock   = useCamStore((s) => s.setGeometryNoStock)
  const setGeometryLoops            = useCamStore((s) => s.setGeometryLoops)
  const appendGeometryProjection    = useCamStore((s) => s.appendGeometryProjection)
  const patchGeometry        = useCamStore((s) => s.patchGeometry)
  // Active display unit (ADR-0022). Loop areas convert mm²->in² only for display.
  const displayUnits         = useCamStore((s) => s.appSettings.displayUnits)
  const pushHistory          = useCamStore((s) => s.pushHistory)
  const reorderOperations    = useCamStore((s) => s.reorderOperations)
  const addOperationFolder   = useCamStore((s) => s.addOperationFolder)
  const renameOperationFolder = useCamStore((s) => s.renameOperationFolder)
  const removeOperationFolder = useCamStore((s) => s.removeOperationFolder)
  const setOperationFolderEnabled = useCamStore((s) => s.setOperationFolderEnabled)
  const setOperationFolderId = useCamStore((s) => s.setOperationFolderId)
  const reorderSetups        = useCamStore((s) => s.reorderSetups)
  const reorderGeometry      = useCamStore((s) => s.reorderGeometry)
  const openModal            = useCamStore((s) => s.openModal)
  const updateProjectMeta    = useCamStore((s) => s.updateProjectMeta)
  const openSketchForLayer   = useCamStore((s) => s.openSketchForLayer)
  const promoteSketchPreview       = useCamStore((s) => s.promoteSketchPreview)
  const promoteSketchLayerToModel  = useCamStore((s) => s.promoteSketchLayerToModel)
  const requestConfirm             = useCamStore((s) => s.requestConfirm)
  const wrapImportedGeometryAsModelItem = useCamStore((s) => s.wrapImportedGeometryAsModelItem)
  const createSketchLayer    = useCamStore((s) => s.createSketchLayer)
  const importBrepGeometry   = useCamStore((s) => s.importBrepGeometry)
  const brepImportStatus     = useCamStore((s) => s.brepImportStatus)
  const brepImportError      = useCamStore((s) => s.brepImportError)
  const setBrepImportError   = useCamStore((s) => s.setBrepImportError)
  // Geometry folders (Stage A store actions; this component is Stage B UI).
  const addGeometryFolder    = useCamStore((s) => s.addGeometryFolder)
  const renameGeometryFolder = useCamStore((s) => s.renameGeometryFolder)
  const setGeometryFolderId  = useCamStore((s) => s.setGeometryFolderId)
  const removeGeometryFolder = useCamStore((s) => s.removeGeometryFolder)
  const reorderGeometryFolder = useCamStore((s) => s.reorderGeometryFolder)

  // WO INT-17C Stage C1 step 6: "Model Items" tree group + "New Model Item"
  // command, mirroring the Geometry-folders wiring immediately above.
  const workspace             = useCamStore((s) => s.workspace)
  const activeModelItemId     = useCamStore((s) => s.activeModelItemId)
  const addModelItem          = useCamStore((s) => s.addModelItem)
  const openModelItem         = useCamStore((s) => s.openModelItem)
  // WO INT-17C Stage C3: rename/delete for Model Items, mirroring the
  // Geometry-folder actions immediately above.
  const renameModelItem       = useCamStore((s) => s.renameModelItem)
  const removeModelItem       = useCamStore((s) => s.removeModelItem)
  // GEO-UNIFY Stage 2: placeholder folder membership, mirroring setGeometryFolderId.
  const setModelItemFolderId  = useCamStore((s) => s.setModelItemFolderId)

  // Nesting (P3.3 tree node + P3.4 temporary create trigger).
  const renameNest           = useCamStore((s) => s.renameNest)
  const removeNest           = useCamStore((s) => s.removeNest)
  const explodeNest          = useCamStore((s) => s.explodeNest)
  const setNestVisible       = useCamStore((s) => s.setNestVisible)
  const setNestEditTarget    = useCamStore((s) => s.setNestEditTarget)
  const recomputeNest        = useCamStore((s) => s.recomputeNest)
  const setSelectedNest      = useCamStore((s) => s.setSelectedNest)
  const setSelectedStock     = useCamStore((s) => s.setSelectedStock)
  const reorderNest          = useCamStore((s) => s.reorderNest)
  // PP-UTILITY Stage 3: layer/folder row selection, mirroring the nest row's
  // own setSelectedNest wiring above.
  const setSelectedLayer     = useCamStore((s) => s.setSelectedLayer)
  const setSelectedFolder    = useCamStore((s) => s.setSelectedFolder)

  // Tree expand/collapse now persists across reloads (uiPrefs). Subscribe to the
  // id lists / section flags so the render reacts to toggles; the Set views built
  // with useMemo keep every existing `.has()` call site unchanged. Bulk + toggle
  // store actions (pulled in below near the other useUiPrefs hooks) replace the
  // old setState calls.
  const expandedSetupIds = useUiPrefs((s) => s.expandedSetupIds)
  const expandedSetups   = useMemo(() => new Set(expandedSetupIds), [expandedSetupIds])
  const collapsedOperationFolderIds = useUiPrefs((s) => s.collapsedOperationFolderIds)
  const toggleOperationFolderCollapsed = useUiPrefs((s) => s.toggleOperationFolderCollapsed)
  const isOperationFolderCollapsed = (id: string) => collapsedOperationFolderIds.includes(id)
  const expandedLayerKeys = useUiPrefs((s) => s.expandedLayerKeys)               // "geoId:layerId"
  const expandedLayers   = useMemo(() => new Set(expandedLayerKeys), [expandedLayerKeys])
  const stockExpanded    = useUiPrefs((s) => s.treeStockExpanded)
  // P2 (clutter audit): ONE inline-rename target for EVERY named tree row.
  // TreeRenameLabel renders the in-place input for the matching row; commits
  // route through each row type's EXISTING store rename action (see the
  // TreeRenameTarget doc above). Replaces the per-row-type renaming states.
  const [renameTarget, setRenameTarget] = useState<TreeRenameTarget | null>(null)
  const cancelRename = useCallback(() => setRenameTarget(null), [])
  const [projectingId,    setProjectingId]    = useState<string | null>(null)
  const [optimizingId,   setOptimizingId]    = useState<string | null>(null)
  const [setupDragOverIdx, setSetupDragOverIdx] = useState<number | null>(null)
  const setupDragFromIdx = useRef<number>(-1)
  // Geometry drag-to-reorder. Indices are positions in project.geometry (the
  // real flat array), NOT the filtered render list — drop handlers map by geo.id
  // back to the real array so the reorder stays correct when rows are hidden.
  const [geoDragOverId, setGeoDragOverId] = useState<string | null>(null)
  const geoDragFromIdx = useRef<number>(-1)
  // Folder drag-into-organize + rename state. dragGeoId is the id of the
  // geometry currently being dragged (set on a geo-block drag start) so a drop
  // on a FOLDER row / the ROOT drop zone can re-parent it via setGeometryFolderId.
  // folderDropTargetId tracks which folder row is highlighted; rootDropActive
  // tracks the root drop zone highlight.
  const dragGeoId = useRef<string | null>(null)
  // GEO-UNIFY Stage 2: the SAME folder-row/root-drop-zone targets accept a
  // dragged empty-model PLACEHOLDER row too (it has no project.geometry
  // entry of its own, so it needs its own drag-id ref rather than reusing
  // dragGeoId — a folder/root onDrop checks both refs, mutually exclusive
  // since only one row is ever being dragged at a time).
  const dragModelItemId = useRef<string | null>(null)
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  // N1a reorder: folder-row and nest-row drag-to-reorder (independent of the
  // geo drag/dragGeoId path). dragFolderIdx / dragNestIdx record the ROOT-folder
  // / nest index of the row being dragged; the *DropOverId state drives a
  // drop-indicator highlight. Kept as refs (mid-drag, no re-render needed) +
  // state (highlight) at the TOP with the other hooks so the hooks order is
  // stable regardless of how many folders/nests exist.
  const dragFolderIdx = useRef<number>(-1)
  const dragNestIdx   = useRef<number>(-1)
  const [folderReorderOverId, setFolderReorderOverId] = useState<string | null>(null)
  const [nestReorderOverId,   setNestReorderOverId]   = useState<string | null>(null)
  const [pendingOptimization, setPendingOptimization] = useState<{
    geoId: string; layerId: string
    before: Loop2D[]; proposed: Loop2D[]; otherLoops: Loop2D[]; layers: Layer2D[]
    projectionPlane?: ProjectionPlane
  } | null>(null)
  // B20: which loop set the preview renders. Only ONE set ever shows (no 'both'
  // overdraw, no Z offset). Default 'after' = show the proposed clean result first.
  const [optPreviewSet, setOptPreviewSet] = useState<'before' | 'after'>('after')
  const geometryExpanded = useUiPrefs((s) => s.treeGeometryExpanded)
  const setupsExpanded   = useUiPrefs((s) => s.treeSetupsExpanded)
  const collapsedPartIds = useUiPrefs((s) => s.collapsedPartIds)                 // geoIds whose layers are folded
  const collapsedParts   = useMemo(() => new Set(collapsedPartIds), [collapsedPartIds])
  // Declutter (Tier 4): the default auto stock (id === DERIVED_STOCK_ID) starts
  // COLLAPSED so a fresh project shows the stock node as a one-liner (name +
  // gizmo + delete). Its dimensions/offsets stay fully editable via selecting
  // the stock -> Properties panel. Users can still expand any stock in-tree.
  // expandedStockIds defaults to [] so the collapsed default still holds; now
  // persisted so a refresh keeps whichever stock nodes the user opened.
  const expandedStockIds = useUiPrefs((s) => s.expandedStockIds)                 // stock ids whose fields are open
  const expandedStocks   = useMemo(() => new Set(expandedStockIds), [expandedStockIds])

  // ── Phase 7 (P12 / 7.2): right-click context menu ────────────────────────
  const [contextMenu, setContextMenu] = useState<{ at: { x: number; y: number }; target: TreeContextTarget } | null>(null)
  const openContextMenu = useCallback((e: React.MouseEvent, target: TreeContextTarget) => {
    e.preventDefault(); e.stopPropagation()
    setContextMenu({ at: { x: e.clientX, y: e.clientY }, target })
  }, [])
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // ── P2: F2 starts inline rename on the currently selected/active row ──────
  // Selection kinds are mutually exclusive in practice (setSelectedNest /
  // setSelectedStock / setSelectedGeometry clear each other); the precedence
  // below resolves the active setup/op fallback last because a project always
  // has an active setup. Ignored while typing in any form control, while a
  // modal or sketch session is open, or while a rename is already running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const s = useCamStore.getState()
      // WO INT-15 (F-1): this is a CAM-host WINDOW listener, registered once and living on
      // `window`, so the CAM host's display:none suspend never reaches it -- F2 pressed in the
      // Model workspace would silently open rename on the hidden CAM tree selection. DesignTree
      // receives no suspend signal (App.tsx is workspace-scoped to the modal boundary and cannot
      // thread one here), so it self-gates on the active workspace read from the store -- the same
      // workspace-ownership predicate the sibling CAM-global window listener uses
      // (useGlobalShortcuts.ts: `if (s.workspace !== 'cam') return`).
      if (s.workspace !== 'cam') return
      if (s.activeModal || s.activeSketch) return
      const { selectedNestId, selectedStockId, selectedGeometryId } = s.viewer
      const sc = s.project.sceneStock
      let target: TreeRenameTarget | null = null
      if (selectedNestId) {
        target = { kind: 'nest', id: selectedNestId }
      } else if (selectedStockId && (sc.fixedStocks ?? []).some(fs => fs.id === selectedStockId)) {
        target = { kind: 'stock-fixed', id: selectedStockId }
      } else if (selectedStockId && (sc.autoStocks ?? []).some(a => a.id === selectedStockId)) {
        target = { kind: 'stock-auto', id: selectedStockId }
      } else if (selectedGeometryId) {
        // An owned seed renders ONLY as a nest child row -> target that row.
        const geo = s.project.geometry.find(g => g.id === selectedGeometryId)
        target = geo?.ownerNestId
          ? { kind: 'seed', id: selectedGeometryId }
          : { kind: 'geometry', id: selectedGeometryId }
      } else if (s.project.activeOperationId) {
        const opId = s.project.activeOperationId
        const setup = s.project.setups.find(su => su.operations.some(op => op.id === opId))
        if (setup) target = { kind: 'op', setupId: setup.id, opId }
      } else if (s.project.activeSetupId) {
        target = { kind: 'setup', id: s.project.activeSetupId }
      }
      if (target) { e.preventDefault(); setRenameTarget(target) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Phase 6 (P10): filter + density ──────────────────────────────────────
  const [filterText, setFilterText] = useState('')
  const query = normalizeQuery(filterText)
  const treeDensity     = useUiPrefs((s) => s.treeDensity)
  // WO-1904: the ONE remembered DXF drawing-origin choice (Settings > DXF
  // import); passed to the shared import path so a DXF can keep its datum.
  const dxfKeepOrigin   = useUiPrefs((s) => s.dxfKeepOrigin)
  // Folder collapse persists across reloads (uiPrefs, Stage A). Subscribe to the
  // id list so the render reacts to toggles; helpers below read it.
  const collapsedFolderIds   = useUiPrefs((s) => s.collapsedFolderIds)
  const toggleFolderCollapsed = useUiPrefs((s) => s.toggleFolderCollapsed)
  const isFolderCollapsed    = (id: string) => collapsedFolderIds.includes(id)
  // Nest-node collapse persists across reloads (uiPrefs, N1a), mirroring folders.
  // Subscribe to the id list so the render reacts to expand/collapse toggles.
  const collapsedNestIds     = useUiPrefs((s) => s.collapsedNestIds)
  const toggleNestCollapsed  = useUiPrefs((s) => s.toggleNestCollapsed)
  const isNestCollapsed      = (id: string) => collapsedNestIds.includes(id)
  // Nest seed-child expand state (seed layer eyes). Default COLLAPSED, so we
  // store the EXPANDED ones; subscribe to the id list so the render reacts.
  const expandedSeedIds      = useUiPrefs((s) => s.expandedSeedIds)
  const toggleSeedExpanded   = useUiPrefs((s) => s.toggleSeedExpanded)
  const isSeedExpanded       = (id: string) => expandedSeedIds.includes(id)
  // Derived-geometry group expand state (R5). Auto-generated projection layers
  // collapse under one "Derived geometry (N)" row per part, COLLAPSED by default,
  // so we store the EXPANDED part ids (mirrors expandedSeedIds). Tree display only.
  const expandedDerivedGeoIds = useUiPrefs((s) => s.expandedDerivedGeoIds)
  const toggleDerivedExpanded = useUiPrefs((s) => s.toggleDerivedExpanded)
  const isDerivedExpanded    = (id: string) => expandedDerivedGeoIds.includes(id)
  // Persisted tree expand/collapse actions (refresh restores the last layout).
  const setTreeSectionExpanded = useUiPrefs((s) => s.setTreeSectionExpanded)
  const toggleTreeSection      = useUiPrefs((s) => s.toggleTreeSection)
  const setExpandedSetupIds    = useUiPrefs((s) => s.setExpandedSetupIds)
  const toggleExpandedSetup    = useUiPrefs((s) => s.toggleExpandedSetup)
  const setExpandedLayerKeys   = useUiPrefs((s) => s.setExpandedLayerKeys)
  const toggleExpandedLayer    = useUiPrefs((s) => s.toggleExpandedLayer)
  const setCollapsedPartIds    = useUiPrefs((s) => s.setCollapsedPartIds)
  const toggleCollapsedPart    = useUiPrefs((s) => s.toggleCollapsedPart)
  const setExpandedStockIds    = useUiPrefs((s) => s.setExpandedStockIds)
  const toggleExpandedStock    = useUiPrefs((s) => s.toggleExpandedStock)
  const addExpandedStock       = useUiPrefs((s) => s.addExpandedStock)

  // CVU-1 (CRASH-VERIFY-UAT 2026-07-26): a freshly loaded project's active
  // setup starts COLLAPSED, hiding every operation until the user manually
  // expands it -- a user following "load a project -> click a toolpath" has
  // nothing to click. Default-expand ONLY the active setup on a genuine
  // project load (project.id change): additive-only (never collapses a setup
  // the user already has expanded/left expanded via the persisted
  // expandedSetupIds prefs), and gated on project.id so it fires once per
  // load -- switching the active setup within an already-open project, or the
  // user collapsing it again later in the same session, is respected and not
  // re-forced open.
  useEffect(() => {
    const activeId = project.activeSetupId
    if (activeId !== null && !expandedSetupIds.includes(activeId)) {
      setExpandedSetupIds([...expandedSetupIds, activeId])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // WO-1455: name an open-shell STEP body's adoption on the console (COHESION-
  // STANDARD rule 13 / "use the console") instead of a tree badge. Fires once
  // per body id, not once per render -- notifiedOpenShellIds tracks which ids
  // already got their line, since project.geometry is a fresh array every
  // store update.
  const notifiedOpenShellIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const geo of project.geometry) {
      if (geo.format !== 'step' || geo.solidCount !== 0) continue
      if (notifiedOpenShellIds.current.has(geo.id)) continue
      notifiedOpenShellIds.current.add(geo.id)
      useCamStore.getState().addConsoleEvent({
        severity: 'warning',
        source: 'model',
        message: shellText('DesignTree.hasNoClosedSolidOpenShellMassVolumeAnd', { name: geo.name }),
        entityRef: { kind: 'geometry', id: geo.id },
      })
    }
  }, [project.geometry])
  const opTypeLabelRaw = (type: Operation['type']) =>
    type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  // Precompute, per geometry/setup, whether it (or a descendant) matches the
  // filter so rows hide while their matching descendants + ancestors stay.
  const geoVisibility = useMemo(() => {
    const map = new Map<string, { visible: boolean; layers: Map<string, boolean> }>()
    for (const geo of project.geometry) {
      const layerVis = new Map<string, boolean>()
      let anyChild = false
      for (const layer of geo.layers2d ?? []) {
        const loops = geo.loops?.filter(l => l.layerId === layer.id) ?? []
        const loopMatch = loops.some(l => matchesFilter(query, loopLabel(l, displayUnits), l.type))
        const self = matchesFilter(query, layer.name)
        const vis = isVisible(query, self, loopMatch)
        layerVis.set(layer.id, vis)
        if (self || loopMatch) anyChild = true
      }
      const selfMatch = matchesFilter(query, geo.name, geo.filename, geo.format)
      map.set(geo.id, { visible: isVisible(query, selfMatch, anyChild), layers: layerVis })
    }
    return map
  }, [project.geometry, query, displayUnits])

  // Seed (nest-source) ids: a geometry is a SEED iff some nest references it as a
  // source (ADR 0025 §2). Drives the seed badge on the geometry row and the nest's
  // source-child rows. Pure + memoized on project.nests.
  const seedIds = useMemo(() => seedGeometryIds(project), [project.nests])

  // Owned-seed ids: geometries that are a nest's integrated SEED COPY
  // (geo.ownerNestId set; created by createNest's deep-copy). These live ONLY
  // inside the nest, never as a standalone root/folder geometry row (ADR 0025 §2
  // deep-copy seed model); they still appear as the nest's child row. Memoized
  // on project.geometry (ownerNestId is a geometry field now, not a source flag).
  const ownedSeedIds = useMemo(() => nestOwnedGeometryIds(project), [project.geometry])

  // WO-1389: resolve each setup's controller work offset the same way post
  // does (resolveSetupWorkOffset), not the stored setup.wcs.label — a stock
  // fixture-offset override can leave the stored label stale. Resolution
  // errors (malformed/dangling stock binding) fall back to the raw label;
  // the post path independently refuses export loud on the same error.
  const resolvedWcsLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const setup of project.setups) {
      try {
        map.set(setup.id, resolveSetupWorkOffset(project, setup).setup.wcs.label)
      } catch {
        map.set(setup.id, setup.wcs.label)
      }
    }
    return map
  }, [project])

  const setupVisibility = useMemo(() => {
    const map = new Map<string, { visible: boolean; ops: Map<string, boolean> }>()
    for (const setup of project.setups) {
      const opVis = new Map<string, boolean>()
      let anyChild = false
      for (const op of setup.operations) {
        const self = matchesFilter(query, op.name, opTypeLabelRaw(op.type), op.type)
        opVis.set(op.id, self)
        if (self) anyChild = true
      }
      const selfMatch = matchesFilter(query, setup.name, setup.wcs.label)
      map.set(setup.id, { visible: isVisible(query, selfMatch, anyChild), ops: opVis })
    }
    return map
  }, [project.setups, query])

  const geoShown   = project.geometry.filter(g => geoVisibility.get(g.id)?.visible).length
  const setupShown = project.setups.filter(s => setupVisibility.get(s.id)?.visible).length

  // GEO-UNIFY Stage 1 (tree unification, plan sec 1.1): the separate "Model
  // Items" section is gone. A model item with >=1 owning geometry row needs
  // no extra row (its body rows already render below, format 'model'); a
  // model item that owns NO row yet (still empty / in-progress) synthesizes
  // one PRESENTATION-ONLY placeholder row here so it never hides. Ownership
  // test mirrors handleDeleteModelItem's own filter (resolveOwningModelItemId,
  // not the raw field, so a self-healed legacy item is covered too).
  const placeholderModelItems = useMemo(() => {
    const items = project.modelItems ?? []
    if (items.length === 0) return []
    return items.filter(
      (item) => !project.geometry.some((g) => resolveOwningModelItemId(g) === item.id),
    )
  }, [project.modelItems, project.geometry])
  const placeholderVisible = (item: ModelItemRecord) => matchesFilter(query, item.name, 'model')
  const placeholderShown = placeholderModelItems.filter(placeholderVisible).length

  // D4's owning-model-name meta (below) is rename-capable: double-click, or
  // the row's "Rename model..." context-menu item, opens an inline edit
  // right there. When an item owns 2+ body rows, only ONE of them may ever
  // carry the editable widget for a given renameTarget -- its first owning
  // row, in project.geometry order, stable across re-renders -- so a
  // multi-body item never mounts two autoFocus inputs for the SAME rename at
  // once (a real focus-fight found in Stage 1 testing: the second input
  // steals focus from the first, blurring = committing it a frame later).
  const firstOwningGeoIdByModelItem = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of project.geometry) {
      const id = resolveOwningModelItemId(g)
      if (id && !map.has(id)) map.set(id, g.id)
    }
    return map
  }, [project.geometry])

  const clearFilter = () => setFilterText('')

  const allFixedStockIds = () => (project.sceneStock.fixedStocks ?? []).map(fs => fs.id)

  // Collapse / expand every expandable node across all sections — now incl.
  // each manual (fixed) stock node (Operator ruling 2026-06-13: those were skipped).
  const expandAll = () => {
    setTreeSectionExpanded('stock', true); setTreeSectionExpanded('geometry', true); setTreeSectionExpanded('setups', true)
    setExpandedSetupIds(project.setups.map(s => s.id))
    const layerKeys: string[] = []
    for (const geo of project.geometry) {
      for (const layer of geo.layers2d ?? []) layerKeys.push(`${geo.id}:${layer.id}`)
    }
    setExpandedLayerKeys(layerKeys)
    setCollapsedPartIds([])
    setExpandedStockIds(allFixedStockIds())
  }
  const collapseAll = () => {
    setTreeSectionExpanded('stock', false); setTreeSectionExpanded('geometry', false); setTreeSectionExpanded('setups', false)
    setExpandedSetupIds([])
    setExpandedLayerKeys([])
    setCollapsedPartIds(project.geometry.map(g => g.id))
    setExpandedStockIds([])
  }

  // "Top level" (Operator 2026-06-13): show the outline — every SECTION open, but
  // every individual top-level item folded (each stock, part, and setup), so
  // you see section headers + item names with no children.
  const topLevel = () => {
    setTreeSectionExpanded('stock', true); setTreeSectionExpanded('geometry', true); setTreeSectionExpanded('setups', true)
    setExpandedSetupIds([])               // setups collapsed (no operations)
    setExpandedLayerKeys([])              // loop sub-lists closed
    setCollapsedPartIds(project.geometry.map(g => g.id))  // parts folded (no layers)
    setExpandedStockIds([])               // stock nodes folded (no fields)
  }

  const togglePartCollapsed = (geoId: string) => toggleCollapsedPart(geoId)

  const toggleStockExpanded = (stockId: string) => toggleExpandedStock(stockId)

  // Declutter (Tier 4): stock nodes start COLLAPSED (one-liners) on a fresh
  // project / File>New / Open. Dimensions/offsets stay editable via selecting
  // the stock -> Properties panel. (Formerly a project.id effect re-expanded the
  // default auto stock; removed so the collapsed default sticks across projects.)

  const colorInputRef  = useRef<HTMLInputElement>(null)
  const geoFileInputRef = useRef<HTMLInputElement>(null)
  // layerId === null → geometry-level color (STL); layerId string → 2D layer color
  const colorTarget   = useRef<{ geoId: string; layerId: string | null } | null>(null)

  const { sceneStock } = project
  const selectedGeoId  = viewer.selectedGeometryId
  // WO-2198: a vise placed again from one definition is selected as itself.
  const selectedWorkholdingId = useClampUi((s) => s.selectedClampId)

  // ── Geometry import ────────────────────────────────────────────────────────

  const handleImportGeometry = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // WO-2198: an exported vise or clamp comes in through the same Import.
    if (isWorkholdingFileName(file.name)) {
      await importWorkholdingFromFile(file)
      e.target.value = ''
      return
    }
    // ADR 0010 inline import, now via the shared helper so the New Nest modal's
    // "Add part..." uses the SAME path (STEP/STL/SVG/DXF branches + caching +
    // viewport push live in importGeometryFile).
    await importGeometryFile(file, { importBrepGeometry, addGeometry }, { keepOrigin: dxfKeepOrigin })
    e.target.value = ''
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const vpRebuild2D = useCallback((geo: ImportedGeometry) => {
    getVp()?.rebuild2DGeometry?.(geo.id, geo.loops, geo.layers2d)
  }, [])

  const toggleSetup = (id: string) => toggleExpandedSetup(id)

  const toggleLayer = (key: string) => toggleExpandedLayer(key)

  // ── Geometry handlers ──────────────────────────────────────────────────────

  const handleSelectGeo = (id: string) => {
    setSelectedGeometry(id); getVp()?.setSelectedPart?.(id)
  }

  const handleDuplicateGeo = useCallback(async (geo: ImportedGeometry) => {
    // INT-17A Stage 1: a model-backed entry MIRRORS a live Model-workbench body
    // (one card per body). A free-standing "copy" would be an orphan pointing at
    // the same bodyId that the next regen sync would immediately reconcile away -
    // duplication is not a meaningful action for model geometry. (The context
    // menu also hides the Duplicate item for model entries; this is the backstop.)
    if (geo.format === 'model') return
    const newId = crypto.randomUUID()
    const offset = { x: geo.position.x + 15, y: geo.position.y, z: geo.position.z }
    // Give the copy its OWN layer ids and re-point everything that references
    // them. DXF layer ids ARE the layer name, so a naive spread leaves the
    // copy sharing ids with the original - then edit-sketch / the chooser
    // resolve to whichever part is first. Remap layers -> new ids and carry
    // the map through loops (loop.layerId) and stored sketches (sketch.layerId)
    // so the duplicate is fully independent.
    const idMap = new Map<string, string>()
    for (const l of geo.layers2d ?? []) idMap.set(l.id, crypto.randomUUID())
    const remap = (lid: string) => idMap.get(lid) ?? lid
    const newGeo: ImportedGeometry = {
      ...geo,
      id: newId,
      name: `${geo.name} (copy)`,
      position: offset,
      layers2d: geo.layers2d?.map(l => ({ ...l, id: remap(l.id) })),
      // Namespace the copy's loops by its NEW geoId so they get fresh, stable,
      // collision-free ids (assignStableLoopIds ignores the incoming id). The
      // cache path below recomputes the SAME ids (deterministic) so a reload
      // restores matching ids instead of a fresh-uuid mismatch.
      loops: geo.loops
        ? assignStableLoopIds(geo.loops.map(l => ({ ...l, layerId: remap(l.layerId) })), newId)
        : undefined,
      sketches: geo.sketches?.map(sk => ({ ...sk, layerId: remap(sk.layerId) })),
    }
    addGeometry(newGeo)
    const vp = getVp()
    if (geo.format === 'stl') {
      const buf = await loadCachedSTL(geo.id)
      if (buf) {
        await cacheSTL(newId, buf)
        await vp?.addSTL?.(buf, newId, newGeo.name, offset, geo.rotation, geo.color)
      }
    } else if (geo.format === 'step') {
      const buf = await loadCachedStep(geo.id)
      if (buf) {
        await cacheStep(newId, buf)  // IDB clones synchronously; buf stays usable
        try {
          const payload = await readStep(newId, buf, newGeo.filename)
          setBrepPayload(newId, payload)
          vp?.addBrepModel?.(newId, payload, newGeo.name, offset, geo.rotation, geo.color)
        } catch (err) {
          setBrepImportError(shellText('DesignTree.sTEPDuplicateFailedFor', { name: geo.name, value: err instanceof Error ? err.message : String(err) }))
        }
      } else {
        setBrepImportError(shellText('DesignTree.sTEPDuplicateFailedForCachedSTEPBytesAreMissing', { name: geo.name }))
      }
    } else if (geo.format === 'svg' || geo.format === 'dxf') {
      const cached = await load2DGeometry(geo.id)
      const srcLoops  = cached?.loops  ?? geo.loops  ?? []
      const srcLayers = cached?.layers ?? geo.layers2d ?? []
      // Cache with the SAME remapped + namespaced ids the store + viewport use
      // (assignStableLoopIds is deterministic on content+newId, so this matches
      // newGeo.loops above), or a reload restores the copy with the original
      // part's layer ids and the crossover bug returns.
      const loops  = assignStableLoopIds(
        srcLoops.map(l => ({ ...l, layerId: remap(l.layerId) })), newId)
      const layers = srcLayers.map(l => ({ ...l, id: remap(l.id) }))
      if (loops.length && layers.length) {
        await cache2DGeometry(newId, loops, layers)
        vp?.add2DGeometry?.(newId, newGeo.loops, newGeo.layers2d, offset, geo.rotation)
      }
    }
  }, [addGeometry, setBrepImportError])

  // The NON-store part of removing one geometry: tear down its viewport mesh and
  // its IndexedDB / brep-payload caches. Factored out so a folder cascade delete
  // can run the SAME cleanup for every contained part before the store removes
  // the folder + its geometry in ONE undo step (the store's removeGeometryFolder
  // does store-side teardown only). Does NOT touch the store or selection.
  //
  // WO-1283: the two halves of that teardown are NOT the same kind of thing and
  // no longer happen at the same time.
  //  - The SESSION-LOCAL half (viewport mesh, the in-memory B-rep payload) runs
  //    now. It is heap, it is what makes the part disappear, and it is rebuilt
  //    from the durable bytes by restoreScene on any rebuild.
  //  - The DURABLE half (the IndexedDB cache entries holding the actual bytes)
  //    is REGISTERED, not run: `deferGeometryBytePurge` holds it until the
  //    geometry id is unreachable from the project and from every undo/redo
  //    snapshot. Running it here is what made undo restore the record without
  //    the part — the store's snapshot was of a project whose bytes were already
  //    gone, and no amount of snapshotting earlier could have helped, because
  //    the bytes were never in the Project object to snapshot. See the store's
  //    deferred-purge block for the retention/memory policy.
  // This is the one seam all three delete paths below reach (single row, folder
  // cascade, model-item cascade), so all three become genuinely undoable at
  // once. NOTE for whoever owns PropertiesPanel.tsx: its
  // `cleanupGeometryRowResources` is a deliberate 1:1 copy of this function and
  // still purges immediately, so the panel's own Delete row keeps the defect
  // until it adopts `deferGeometryBytePurge` the same way (out of this WO's
  // owned paths).
  const cleanupGeoResources = (geo: ImportedGeometry) => {
    const vp = getVp()
    if (geo.format === 'stl') {
      vp?.removeSTL?.(geo.id)
      deferGeometryBytePurge(geo.id, () => { removeCachedSTL(geo.id).catch(() => {}) })
    } else if (geo.format === 'step') {
      // B-rep parts live in partGroups like STLs; removal flows the same path.
      vp?.removeSTL?.(geo.id)
      // Heap, and re-derived from the retained STEP bytes by restoreBrepPart on
      // the undo rebuild — so this one stays immediate.
      removeBrepPayload(geo.id)
      deferGeometryBytePurge(geo.id, () => { removeCachedStep(geo.id).catch(() => {}) })
    } else if (geo.format === 'model') {
      // INT-17A Stage 1: a model body's mesh lives in partGroups (addModelBody),
      // so it tears down through removeSTL exactly like STL/STEP - routing to
      // remove2DGeometry (the old `else`) would leak the 3D mesh (census finding).
      // INT-17A-R1 C1: it DOES now have a durable cache entry (the display payload
      // that survives a localStorage refresh), so purge that too - same shape as
      // the STL/STEP branches above.
      vp?.removeSTL?.(geo.id)
      // INT-17A-R2 C2: project-scoped, so deleting a body here cannot evict the
      // identically-named body of another project the browser has cached. The
      // project id is captured NOW (WO-1283): the purge may run many actions
      // later, and it must still name the project that owned the body.
      {
        const projectId = useCamStore.getState().project.id
        deferGeometryBytePurge(geo.id, () => {
          removeCachedModelBodyDisplay(projectId, geo.id).catch(() => {})
        })
      }
    } else {
      vp?.remove2DGeometry?.(geo.id)
      deferGeometryBytePurge(geo.id, () => { removeCache2D(geo.id).catch(() => {}) })
    }
  }

  const removeGeo = (geo: ImportedGeometry) => {
    // INT-17A Stage 1: a model-backed entry mirrors a live body; deleting the CAM
    // card would resurrect on the next regen. Removal is done in the Model tab
    // (drives the B3 delete reconciliation). The delete button is hidden for model
    // entries; this is the backstop for any other caller.
    if (geo.format === 'model') return
    cleanupGeoResources(geo)
    removeGeometry(geo.id)
    if (selectedGeoId === geo.id) { setSelectedGeometry(null); getVp()?.setSelectedPart?.(null) }
  }

  // WO-1268: geometry deletion is destructive in practice -- the cached bytes
  // and the mesh are torn down before the store snapshots (WO-1283), so Undo
  // brings back the entry and not the part. That is exactly the case a prompt
  // is FOR (Operator, 2026-09-07), so the tree's Remove button, which used to
  // delete outright, now asks through the app's own themed dialog, the same
  // one the row menu and the Properties panel use.
  const confirmRemoveGeo = async (geo: ImportedGeometry): Promise<void> => {
    if (geo.format === 'model') return
    const ok = await requestConfirm({
      title: shellText('DesignTree.delete', { name: geo.name }),
      body: shellText('DesignTree.itsFileAndMeshAreRemovedFromThisProject'),
      confirmLabel: shellText('DesignTree.delete2'),
      cancelLabel: shellText('DesignTree.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    removeGeo(geo)
  }

  const handleRemoveGeo = (e: React.MouseEvent, geo: ImportedGeometry) => {
    e.stopPropagation()
    void confirmRemoveGeo(geo)
  }

  // ── Geometry folder handlers (Stage B) ──────────────────────────────────────
  // Create a new folder and immediately drop into inline rename so the user can
  // name it. addGeometryFolder pushes its own history entry.
  const handleCreateFolder = () => {
    const id = addGeometryFolder(shellText('DesignTree.newFolder'))
    setRenameTarget({ kind: 'folder', id })
  }

  // Cascade delete: run the per-geometry resource cleanup (viewport mesh +
  // IDB/brep caches) for EVERY contained part, then call store
  // removeGeometryFolder ONCE so the whole cascade is a single undo step (the
  // store action does store-side teardown only - see recon).
  const handleDeleteFolder = (folder: GeometryFolder) => {
    const contained = project.geometry.filter(g => g.folderId === folder.id)
    // INT-17A-R1 C4: modeled bodies are DELETED AROUND, not deleted. The store
    // cascade re-parents them to the root.
    const doomed = contained.filter(g => !isModelOriginGeometry(g))
    // Resource teardown ONLY for the entries actually being removed - tearing
    // down a kept body's mesh would blank it in the viewport until the next regen.
    for (const geo of doomed) cleanupGeoResources(geo)
    // If the selected part lived in this folder AND is being removed, clear the
    // selection (the store teardown drops it from project.geometry; mirror the
    // single-part behavior). A kept modeled body stays selected - it still exists.
    if (doomed.some(g => g.id === selectedGeoId)) {
      setSelectedGeometry(null); getVp()?.setSelectedPart?.(null)
    }
    removeGeometryFolder(folder.id)
  }

  // WO INT-17C Stage C3: cascade delete for a Model Item. Unlike
  // handleDeleteFolder immediately above, a model-backed CAM row here is NOT
  // kept-and-reparented — the item that could ever regenerate it is the thing
  // being deleted, so "delete around it" would just leave a permanent orphan
  // (the exact silent-orphan outcome the WO's own Stage C3 scope forbids).
  // Same UI/store split as the folder cascade: this runs the per-row
  // viewport-mesh/IndexedDB teardown (cleanupGeoResources) and the confirm
  // naming every dependent by name BEFORE calling the store's single-undo-step
  // removeModelItem, which does the store-side cascade (geometry rows,
  // placements, per-item document bytes, activeModelItemId).
  const handleDeleteModelItem = async (item: ModelItemRecord): Promise<void> => {
    // INT-MODEL-UNIFY: resolveOwningModelItemId, not the raw field -- the
    // legacy item's own rows never carry `modelItemId` themselves (same
    // reason the store's removeModelItem now resolves the same way).
    const dependents = project.geometry.filter((g) => resolveOwningModelItemId(g) === item.id)
    const n = dependents.length
    // WO-1268: themed dialog. Its dependents' meshes and cached bytes are torn
    // down before the store snapshots (WO-1283), so Undo restores the records,
    // not the parts; the prompt is legitimate.
    const ok = await requestConfirm({
      title: shellText('DesignTree.deleteModelItem', { name: item.name }),
      body: n > 0
        ? shellText('DesignTree.deleteModelDependents', { count: n, names: dependents.map((g) => g.name).join(', ') })
        : shellText('DesignTree.itIsEmpty'),
      confirmLabel: shellText('DesignTree.delete2'),
      cancelLabel: shellText('DesignTree.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    for (const geo of dependents) cleanupGeoResources(geo)
    if (dependents.some((g) => g.id === selectedGeoId)) {
      setSelectedGeometry(null); getVp()?.setSelectedPart?.(null)
    }
    removeModelItem(item.id)
  }

  // GEO-UNIFY Stage 3 (promote flow, D2 wording): convert a CAM sketch layer
  // into a new model as its base sketch (MOVE semantics). The plain warning is
  // shown FIRST and NAMES the dependent CAM ops (via the store's read-only
  // promoteSketchPreview, which uses the SAME listOpsReferencingGeo rule the
  // mutation ambers with) so nothing is silently rebound; on confirm the sketch
  // moves and the Model workspace opens on it.
  //
  // PROMOTE-SKETCH-FAIL round 2: the confirm is now the app's THEMED dialog
  // (requestConfirm) instead of native window.confirm -- Operator flagged the native
  // bubble as off-brand. Two things fall out of the async themed dialog:
  //  1. cohesion (on-theme surface), and
  //  2. it closes the race Operator hit: a native confirm blocks the JS thread, so a
  //     bake/compute queued behind it stayed pending until AFTER promote read the
  //     store (empty). The async dialog lets the event loop run while it is open,
  //     so a pending bake settles before the user clicks Convert. promote's own
  //     empty/pending guards (store) remain the last line of defence either way.
  const handleConvertLayerToModel = async (geoId: string, layerId: string) => {
    const preview = promoteSketchPreview(layerId, geoId)
    if (!preview.eligible) return  // button is only shown for eligible rows
    const ok = await requestConfirm({
      title: shellText('DesignTree.convertSketchToModel'),
      body: preview.opNames.length > 0
        ? shellText('DesignTree.convertSketchWithOperations', { names: preview.opNames.join(', ') })
        : shellText('DesignTree.itBecomesTheNewModelSBaseSketchAnd'),
      confirmLabel: shellText('DesignTree.convertToModel'),
      cancelLabel: shellText('DesignTree.cancel'),
    })
    if (!ok) return
    void promoteSketchLayerToModel(layerId, geoId)
  }

  // Re-parent a dragged geometry into a folder (folderId) or to the root (null).
  const handleDropGeoIntoFolder = (folderId: string | null) => {
    const geoId = dragGeoId.current
    dragGeoId.current = null
    setFolderDropTargetId(null)
    setRootDropActive(false)
    if (geoId) setGeometryFolderId(geoId, folderId)
  }

  // GEO-UNIFY Stage 2: same shape for a dragged empty-model placeholder row —
  // mirrors handleDropGeoIntoFolder exactly, writing through setModelItemFolderId
  // instead (the placeholder's folder membership lives on the ModelItemRecord,
  // not a project.geometry row).
  const handleDropModelItemIntoFolder = (folderId: string | null) => {
    const itemId = dragModelItemId.current
    dragModelItemId.current = null
    setFolderDropTargetId(null)
    setRootDropActive(false)
    if (itemId) setModelItemFolderId(itemId, folderId)
  }


  // Whole-part visibility toggle (STL/STEP/model — 2D parts toggle per layer).
  // INT-17A: a model body is a whole-part 3D mesh in partGroups, so it toggles
  // through setSTLVisible exactly like STL/STEP (and its `hidden` flag persists).
  const toggleGeoVisibility = (geo: ImportedGeometry) => {
    if (geo.format !== 'stl' && geo.format !== 'step' && geo.format !== 'model') return
    const next = !geo.hidden
    patchGeometry(geo.id, { hidden: next })
    getVp()?.setSTLVisible?.(geo.id, !next)
  }

  const PROJ_COLORS = ['#00e5ff', '#ff8c00', '#44ff88', '#ff44ff', '#ffd700', '#4488ff']

  const handleProjectSTL = useCallback((geo: ImportedGeometry) => {
    const vp = getVp()
    if (!vp?.enterSlicePlaneMode) return
    setProjectingId(geo.id)

    // Step 1 — Z-slider: user sets the horizontal slice height to define the 2D profile
    vp.enterSlicePlaneMode(
      geo.id,
      (sliceZ: number) => {
        const worldPos = vp.collectWorldPositions?.(geo.id)
        if (!worldPos) { setProjectingId(null); return }

        const tol = geo.projectionTolerance ?? useCamStore.getState().appSettings.projectionToleranceDefault ?? 0.02
        const sliceResult = projectSTLToLoopsInPlane(worldPos, {
          planeNormal: { x: 0, y: 0, z: 1 },
          planeOrigin: { x: 0, y: 0, z: sliceZ },
          simplificationTolerance: tol,
          minPerimeter: Math.max(0.1, tol * 6),
        })

        if (!sliceResult.loops.length) { setProjectingId(null); return }

        // Step 2 — Target plane picker: user selects where to place the sliced geometry
        vp.enterTargetPlaneMode?.(
          geo.id,
          (normal, centroid, zAnchor) => {
            const N = { x: normal.x, y: normal.y, z: normal.z }
            const { xAxis, yAxis } = buildPlaneFrame(N)
            // Item 4: a stock-relative preset carries a zAnchor so the placed
            // loops re-resolve their Z and ride the stock when it moves. A face
            // pick passes no zAnchor (absolute; follows the part).
            const targetFrame: ProjectionPlane = {
              origin: { x: centroid.x, y: centroid.y, z: centroid.z },
              xAxis, yAxis, normal: N,
              ...(zAnchor ? { zAnchor } : {}),
            }

            // Count existing projection layers to name this one
            const currentGeo = useCamStore.getState().project.geometry.find(g => g.id === geo.id)
            const projCount = (currentGeo?.layers2d ?? []).filter(l => l.projectionPlane).length
            const newLayerId = crypto.randomUUID()
            const newLayer: Layer2D = {
              id: newLayerId,
              name: shellText('DesignTree.sTLProjection', { value: projCount + 1 }),
              color: PROJ_COLORS[projCount % PROJ_COLORS.length],
              visible: true,
              projectionPlane: targetFrame,
            }
            const taggedLoops = sliceResult.loops.map(l => ({ ...l, layerId: newLayerId }))
            appendGeometryProjection(geo.id, taggedLoops, newLayer)
            setProjectingId(null)
          },
          () => setProjectingId(null),
        )
      },
      () => setProjectingId(null),
    )
  }, [appendGeometryProjection])

  // STEP counterpart of handleProjectSTL: the SAME two-step flow the user sees
  // for STL slicing. Step 1 is the live EXACT-OCCT slice scrub (pick a WORLD-
  // horizontal slice height); Step 2 is the projection-plane picker (presets +
  // face) that decides WHERE the 2D loops land. To match STL exactly, the cut is
  // a WORLD-horizontal plane (no tilt guard): worldHorizontalSectionPlane builds
  // the M^-1 world-aligned MODEL frame so sectionAtPlane flattens the loops
  // directly into WORLD XY -> placement (Step 2) is world-baked as-is, no
  // transformLoopPoints. Item 4's zAnchor then makes the placed layer ride the
  // stock. (The wizard's enterBrepSectionMode model-Z path is untouched.)
  const handleSectionStep = useCallback((geo: ImportedGeometry) => {
    const vp = getVp()
    if (!vp?.enterBrepWorldSliceMode || !vp.worldHorizontalSectionPlane) return

    setProjectingId(geo.id)

    // The world-horizontal section frame at worldZ, plus the scalar height along
    // its normal that sectionAtPlane expects (= origin . normal). Shared by the
    // live preview and the confirm re-derive.
    const sliceAt = (worldZ: number) => {
      const plane = vp.worldHorizontalSectionPlane!(geo.id, worldZ)
      if (!plane) return null
      const zScalar = plane.origin[0] * plane.normal[0]
        + plane.origin[1] * plane.normal[1]
        + plane.origin[2] * plane.normal[2]
      return { plane, zScalar }
    }

    // Step 1 — Slice scrub: user sets the world-horizontal slice height; the live
    // preview is the model worker's EXACT OCCT section, already in WORLD XY.
    const entered = vp.enterBrepWorldSliceMode(
      geo.id,
      (worldZ) => {
        const s = sliceAt(worldZ)
        if (!s) return Promise.resolve([])
        return deriveSection(geo.id, s.zScalar, s.plane).then(r => r.loops)
      },
      (worldZ) => {
        // Confirm: re-derive the exact world section, then run Step 2 (placement).
        // Failures surface via brepImportError (ADR 0003).
        const s = sliceAt(worldZ)
        if (!s) {
          useCamStore.getState().setBrepImportError(
            shellText('DesignTree.couldNotBeSlicedPartGeometryNotAvailable', { name: geo.name }))
          setProjectingId(null)
          return
        }
        deriveSection(geo.id, s.zScalar, s.plane)
          .then((result) => {
            if (!result.loops.length) { setProjectingId(null); return }

            // Loops are ALREADY in WORLD XY (the M^-1 world-aligned frame), so
            // they are baked as-is -- no transformLoopPoints conversion.
            // Step 2 — Projection-plane picker: user chooses where to PLACE the
            // 2D loops (presets + face), identical to the STL flow.
            vp.enterTargetPlaneMode?.(
              geo.id,
              (normal, centroid, zAnchor) => {
                const N = { x: normal.x, y: normal.y, z: normal.z }
                const { xAxis, yAxis } = buildPlaneFrame(N)
                // Item 4: world-baked section loops (like STL) carry a preset's
                // zAnchor so the PLACEMENT plane rides the stock. The loops are a
                // one-time exact cut; only the placement Z re-resolves (face pick
                // = no anchor = absolute/part-following).
                const targetFrame: ProjectionPlane = {
                  origin: { x: centroid.x, y: centroid.y, z: centroid.z },
                  xAxis, yAxis, normal: N,
                  ...(zAnchor ? { zAnchor } : {}),
                }

                // Name "Section N" by counting existing Section layers.
                const currentGeo = useCamStore.getState().project.geometry.find(g => g.id === geo.id)
                const sectionCount = (currentGeo?.layers2d ?? [])
                  .filter(l => l.name.startsWith('Section')).length
                const newLayerId = crypto.randomUUID()
                const newLayer: Layer2D = {
                  id: newLayerId,
                  name: shellText('DesignTree.section2', { value: sectionCount + 1 }),
                  color: PROJ_COLORS[sectionCount % PROJ_COLORS.length],
                  visible: true,
                  // World-baked (frame absent), EXACTLY like an STL projection,
                  // so dispatch sends the loops as-is and Item 4's zAnchor can
                  // ride it on the stock.
                  projectionPlane: targetFrame,
                }
                const taggedLoops: Loop2D[] = result.loops.map(l => ({
                  id: '',
                  points: l.points,
                  closed: l.closed,
                  type: l.type,
                  area: l.area,
                  layerId: newLayerId,
                }))
                appendGeometryProjection(geo.id, taggedLoops, newLayer)
                setProjectingId(null)
              },
              () => setProjectingId(null),
            )
          })
          .catch(() => {
            // deriveSection already surfaced the failure via brepImportError.
            setProjectingId(null)
          })
      },
      () => setProjectingId(null),
    )
    if (!entered) setProjectingId(null)
  }, [appendGeometryProjection])

  const handleOptimizeLayer = useCallback((geo: ImportedGeometry, layerId: string) => {
    if (!geo.loops || geo.loops.length === 0) return
    const key = `${geo.id}:${layerId}`
    setOptimizingId(key)
    setTimeout(() => {
      try {
        const tol        = geo.projectionTolerance ?? useCamStore.getState().appSettings.projectionToleranceDefault ?? 0.02
        const layerLoops = geo.loops!.filter(l => l.layerId === layerId)
        const otherLoops = geo.loops!.filter(l => l.layerId !== layerId)
        const proposed   = optimizeLoops(layerLoops, {
          tolerance:           tol * 0.5,
          resampleStep:        Math.max(0.2, tol * 0.3),
          projectionTolerance: tol,
        })
        // Get projection plane from the layer (not the geometry level)
        const layer = geo.layers2d?.find(l => l.id === layerId)
        const layerProjectionPlane = layer?.projectionPlane
        // B20: default toggle is 'after', so draw only the proposed (after) set
        // first ([] for the hidden before set) — never overlay both.
        getVp()?.showOptimizationPreview?.(geo.id, [], proposed, layerProjectionPlane)
        setOptPreviewSet('after')
        setPendingOptimization({
          geoId: geo.id, layerId,
          before: layerLoops, proposed, otherLoops, layers: geo.layers2d ?? [],
          projectionPlane: layerProjectionPlane,
        })
      } finally {
        setOptimizingId(null)
      }
    }, 10)
  }, [])

  const handleConfirmOptimization = useCallback(() => {
    if (!pendingOptimization) return
    const { geoId, proposed, otherLoops, layers } = pendingOptimization
    getVp()?.hideOptimizationPreview?.()
    // Pass layers as-is — projectionPlane lives on each Layer2D now, not on the geometry
    setGeometryLoops(geoId, [...otherLoops, ...proposed], layers)
    setPendingOptimization(null)
  }, [pendingOptimization, setGeometryLoops])

  const handleCancelOptimization = useCallback(() => {
    getVp()?.hideOptimizationPreview?.()
    setPendingOptimization(null)
  }, [])

  // B20: re-render the preview showing ONLY the chosen loop set. Pass [] for the
  // hidden set so exactly one set is ever drawn (no overdraw, no Z offset). Pure
  // presentation: reuses showOptimizationPreview, no viewport change.
  const handleSetOptPreview = useCallback((which: 'before' | 'after') => {
    if (!pendingOptimization) return
    setOptPreviewSet(which)
    const { geoId, before, proposed, projectionPlane } = pendingOptimization
    const beforeSet = which === 'before' ? before : []
    const afterSet  = which === 'after'  ? proposed : []
    getVp()?.showOptimizationPreview?.(geoId, beforeSet, afterSet, projectionPlane)
  }, [pendingOptimization])

  // ── Layer handlers ─────────────────────────────────────────────────────────

  const handleToggleVisible = (geo: ImportedGeometry, layer: Layer2D) => {
    toggleGeometryLayer(geo.id, layer.id)
    getVp()?.set2DLayerVisible?.(geo.id, layer.id, !layer.visible)
  }

  // Part-level show/hide for 2D geometry: flips ALL of a part's layers at once
  // (Operator 2026-06-13). If every layer is visible -> hide all; otherwise show
  // all. Each layer is set explicitly (not toggled) so a mixed state resolves
  // to a single consistent target.
  const handleToggleAllLayers = (geo: ImportedGeometry) => {
    const layers = geo.layers2d ?? []
    if (!layers.length) return
    const target = !layers.every((l) => l.visible)   // show all unless all already shown
    for (const l of layers) {
      if (l.visible !== target) {
        updateGeometryLayer(geo.id, l.id, { visible: target })
        getVp()?.set2DLayerVisible?.(geo.id, l.id, target)
      }
    }
  }

  // Color swatch click → forward to hidden <input type="color">
  const handleSwatchClick = (e: React.MouseEvent, geoId: string, layerId: string | null) => {
    e.stopPropagation()
    colorTarget.current = { geoId, layerId }
    colorInputRef.current?.click()
  }

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = colorTarget.current
    if (!target?.geoId) return
    const { geoId, layerId } = target
    const color = e.target.value

    if (layerId === null) {
      // Geometry-level color (STL)
      updateGeometryColor(geoId, color)
      getVp()?.setPartColor?.(geoId, color)
    } else {
      // 2D layer color
      updateGeometryLayer(geoId, layerId, { color })
      const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      if (geo) vpRebuild2D({ ...geo, layers2d: geo.layers2d?.map(l => l.id === layerId ? { ...l, color } : l) })
    }
  }

  const handleDeleteLayer = (e: React.MouseEvent | undefined, geo: ImportedGeometry, layerId: string) => {
    e?.stopPropagation()
    // C9: snapshot before deleting so Ctrl-Z restores the layer (immediate
    // delete is fine per Operator so long as undo works). Covers both the row
    // trash button and the context-menu 'layer-delete', which route here.
    pushHistory()
    deleteGeometryLayer(geo.id, layerId)
    setTimeout(() => {
      const updated = useCamStore.getState().project.geometry.find(g => g.id === geo.id)
      if (!updated) return
      if (updated.format === 'stl') {
        getVp()?.setPartProjectedLoops?.(updated.id, updated.loops ?? [], updated.layers2d ?? [])
      } else {
        // deleteGeometryLayer re-centers the remaining loops and compensates
        // the store position (B5 stale-bounds fix) — rebuild from the UPDATED
        // store transform, not the group's old one, so the part stays put and
        // the gizmo anchor (group origin) lands on the new bounds center.
        getVp()?.add2DGeometry?.(
          updated.id, updated.loops, updated.layers2d,
          updated.position, updated.rotation,
        )
      }
    }, 0)
  }

  const handleAddLayer = (e: React.MouseEvent, geo: ImportedGeometry) => {
    e.stopPropagation()
    const newLayer: Layer2D = {
      id: crypto.randomUUID(),
      name: shellText('DesignTree.layer', { value: (geo.layers2d?.length ?? 0) + 1 }),
      color: '#4ac3ff',
      visible: true,
    }
    addGeometryLayer(geo.id, newLayer)
  }

  const handleMoveLoop = (geo: ImportedGeometry, loopId: string, newLayerId: string) => {
    moveLoopToLayer(geo.id, loopId, newLayerId)
    setTimeout(() => {
      const updated = useCamStore.getState().project.geometry.find(g => g.id === geo.id)
      if (updated) vpRebuild2D(updated)
    }, 0)
  }

  // ── Stock ──────────────────────────────────────────────────────────────────

  const handleAddFixedStock = () => {
    const newStock: FixedStockItem = {
      id: crypto.randomUUID(),
      name: shellText('DesignTree.stock', { value: (sceneStock.fixedStocks?.length ?? 0) + 1 }),
      width:  sceneStock.fixedWidth,
      height: sceneStock.fixedHeight,
      depth:  sceneStock.fixedDepth,
      position: { x: 0, y: 0, z: 0 },
    }
    addFixedStock(newStock)
    addExpandedStock(newStock.id)  // open the new node for editing
    const updated = { ...sceneStock, fixedStocks: [...(sceneStock.fixedStocks ?? []), newStock] }
    getVp()?.rebuildStock?.(updated)
  }

  const handleUpdateFixedStock = useCallback((id: string, updates: Partial<FixedStockItem>) => {
    updateFixedStock(id, updates)
    // Rebuild from the store's POST-write sceneStock, not a re-merge of the
    // caller's raw `updates` — a locked stock's position edit is refused
    // (stripped) inside updateFixedStock, and re-merging `updates` here would
    // put the refused position back on screen (WO-1590 audit).
    getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
  }, [updateFixedStock])

  // ── Stock gizmo lifecycle (single shared owner) ──────────────────────────
  // The tree icon AND the viewport TransformControls both derive from the
  // SHARED viewer.selectedStockId (commit A). The stock-row gizmo button only
  // TOGGLES that owner (setSelectedStock); this effect is the ONE place that
  // imperatively drives the viewport gizmo to match, so there is no second
  // source of truth (the old DesignTree-local activeStockGizmoId is gone).
  //
  // No double history: we track the gizmo id we last DROVE in a ref and act
  // ONLY on an actual transition. pushHistory() fires exactly once per ENTER
  // (the snapshot before a drag), never on an unrelated re-render. Enter only
  // when selectedStockId resolves to a FIXED stock; otherwise (null OR a
  // non-fixed / auto stock id) we EXIT. The live-move + drag-end callbacks
  // live here once and nowhere else.
  const drivenGizmoIdRef = useRef<string | null>(null)
  const drivenGizmoPosRef = useRef<{ x: number; y: number; z: number } | null>(null)
  useEffect(() => {
    const sel = viewer.selectedStockId
    const fixed = (sceneStock.fixedStocks ?? []).find(fs => fs.id === sel) ?? null
    const targetId = fixed ? fixed.id : null   // the id the gizmo SHOULD be on

    if (drivenGizmoIdRef.current === targetId) {
      // Same stock still selected, but its POSITION may have changed via a TYPED
      // Properties edit (updateFixedStock). The store already holds the typed
      // value; move the gizmo HANDLE to track it instead of leaving it stale at
      // the old spot. Visual-only: no callback, no history push.
      if (fixed) {
        const prev = drivenGizmoPosRef.current
        const p = fixed.position
        if (!prev || prev.x !== p.x || prev.y !== p.y || prev.z !== p.z) {
          getVp()?.setStockGizmoPosition?.(p.x, p.y, p.z)
          drivenGizmoPosRef.current = { x: p.x, y: p.y, z: p.z }
        }
      }
      return  // no gizmo enter/exit transition needed
    }

    // Tear down whatever was active before re-pointing (covers fixed -> fixed,
    // fixed -> none, none -> fixed). Exit is idempotent in the viewport.
    if (drivenGizmoIdRef.current != null) {
      getVp()?.exitStockGizmoMode?.()
      const current = useCamStore.getState().project.sceneStock
      getVp()?.rebuildStock?.(current)
    }

    // WO-1590 (mating S0): a locked fixed stock refuses the gizmo - the write
    // path never starts, so moveFixedStockLive is never called for it (no
    // per-frame console spam). Say so once on the console, naming the stock,
    // and bounce the selection back so the row never looks stuck "active"
    // with no gizmo actually driving it.
    if (fixed?.locked) {
      useCamStore.getState().addConsoleEvent({
        severity: 'warning',
        source: 'model',
        message: shellText('DesignTree.isLockedAndDidNotMoveUnlockItIn', { name: fixed.name }),
      })
      setSelectedStock(null)
      drivenGizmoIdRef.current = null
      drivenGizmoPosRef.current = null
      return
    }

    if (fixed) {
      pushHistory()  // snapshot state once before drag starts (one per enter)
      drivenGizmoPosRef.current = { ...fixed.position }
      getVp()?.enterStockGizmoMode?.(
        fixed.id,
        fixed.position,
        (id, pos) => {                                // live update — no history per frame
          moveFixedStockLive(id, pos)
          getVp()?.setFixedStockPosition?.(id, pos)   // ride the stock BOX mesh live with the gizmo
          syncStockMembersToViewport(id)              // ride member meshes live with the box
        },
        (id, pos) => {                                // on drag end: final position + rebuild
          moveFixedStockLive(id, pos)
          syncStockMembersToViewport(id)
          const current = useCamStore.getState().project.sceneStock
          getVp()?.rebuildStock?.(current)
        }
      )
    }

    drivenGizmoIdRef.current = targetId
    if (!fixed) drivenGizmoPosRef.current = null
  }, [viewer.selectedStockId, sceneStock.fixedStocks, pushHistory, moveFixedStockLive, setSelectedStock])

  const handleRemoveFixedStock = (id: string) => {
    removeFixedStock(id)
    const updated = {
      ...sceneStock,
      fixedStocks: (sceneStock.fixedStocks ?? []).filter(fs => fs.id !== id),
    }
    getVp()?.rebuildStock?.(updated)
  }

  // Named AUTO stocks (multi-auto-stock). The store action sizes the twin
  // PhysicalStock to its members; rebuildStock then reads those member-derived
  // bounds (see CNCViewport.rebuildStock). We pass the FRESH sceneStock the
  // action just wrote so currentStockConfig.autoStocks is current.
  const handleAddAutoStock = () => {
    const newStock: AutoStockItem = {
      id: crypto.randomUUID(),
      name: shellText('DesignTree.autoStock', { value: (sceneStock.autoStocks?.length ?? 0) + 1 }),
      autoOffsetXY:   sceneStock.autoOffsetXY,
      autoOffsetZTop: sceneStock.autoOffsetZTop,
      autoOffsetZBottom: sceneStock.autoOffsetZBottom ?? 0,
    }
    addAutoStock(newStock)
    addExpandedStock(newStock.id)  // open the new node for editing
    getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
  }

  const handleUpdateAutoStock = useCallback((id: string, patch: Partial<Omit<AutoStockItem, 'id'>>) => {
    updateAutoStock(id, patch)
    getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
  }, [updateAutoStock])

  const handleRemoveAutoStock = (id: string) => {
    removeAutoStock(id)
    getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
  }

  // ── Setup / Op ────────────────────────────────────────────────────────────

  const handleActivateSetup = (id: string) => {
    // setActiveSetup now also clears activeOperationId in the store
    // Clearing geometry alone preserves stock selection (ADR 0025). Release
    // that Properties/gizmo owner when the operator selects the setup row.
    setSelectedStock(null)
    setActiveSetup(id); setSelectedGeometry(null); getVp()?.setSelectedPart?.(null)
  }

  const handleActivateOp = (setupId: string, opId: string) => {
    // Auto-switch to the operation's parent setup first, then select the operation.
    // setActiveSetup clears activeOperationId; setActiveOperation then sets it.
    setActiveSetup(setupId)
    setActiveOperation(opId)
    setSelectedGeometry(null); getVp()?.setSelectedPart?.(null)
  }

  const statusIcon = (op: Operation) => {
    const props = { size: 12 }
    switch (op.status) {
      case 'ready':     return <CheckCircle2 {...props} className="status-ready" />
      case 'computing':
        // Determinate ring once a fraction has arrived; fall back to the
        // indeterminate spinner before the first checkpoint fires.
        return typeof op.progress === 'number'
          ? <ProgressRing fraction={op.progress} phase={op.progressPhase} />
          : <Loader2 {...props} className="status-computing spin" />
      case 'error':     return <AlertCircle {...props} className="status-error" />
      case 'outdated':  return <Clock {...props} className="status-outdated" />
      // CAM-1: degraded = referenced model geometry is GONE. RED
      // (--status-degraded -> --status-error), distinct from amber 'outdated'
      // (stale-but-recomputable). Uses AlertTriangle so red-error and
      // red-degraded are still visually separable at a glance.
      case 'degraded':  return <AlertTriangle {...props} className="status-degraded" />
      case 'pending':   return <Clock {...props} className="status-pending" />
      // CAM-BINDING Stage 1: a modeled-body source with no Stage 2 compute path
      // yet. Box (not Clock, not AlertCircle/Triangle) so it reads as "this is a
      // MODEL thing, not a normal pending/error state" at a glance.
      case 'unsupported': return <Box {...props} className="status-unsupported" />
      default: {
        // Compiler-enforced exhaustiveness (CAM-1): a new OperationStatus with
        // no badge is a build error, not a silent grey clock.
        const _exhaustive: never = op.status
        return <Clock {...props} className="status-pending" data-unhandled={String(_exhaustive)} />
      }
    }
  }

  // Badge hover text. CAM-1: degraded/outdated ops carry a re-resolution note
  // (which model geometry moved or was lost); surface it so the red/amber badge
  // explains itself. Errors keep their existing errorMessage tooltip.
  const opStatusTooltip = (op: Operation): string | undefined => {
    if (op.status === 'error') return op.errorMessage ?? shellText('DesignTree.errorComputingToolpath')
    if (op.status === 'degraded')
      return op.modelReferenceNote ?? shellText('DesignTree.degradedReferencedModelGeometryIsGoneReSelectGeometry')
    if (op.status === 'outdated' && op.modelReferenceNote) return op.modelReferenceNote
    // WO-2663: every other outdated operation says why it went amber.
    if (op.status === 'outdated' && op.outdatedReason)
      return shellText('DesignTree.outdatedBecause', { reason: outdatedReasonText(op.outdatedReason) })
    // CAM-BINDING Stage 1: 'unsupported' carries its explanation in errorMessage
    // (the same generic "why can't this compute" slot 'error' uses).
    if (op.status === 'unsupported') return op.errorMessage ?? shellText('DesignTree.modeledBodySourceComputeNotYetSupported')
    return undefined
  }

  // WO-1683: an operation the reach trim stopped short of full depth says so on
  // itself - never a refusal, so this is a SEPARATE badge from statusIcon, shown
  // beside it whatever op.status is (the operation is still 'ready' and postable).
  const reachShortfallBadge = (op: Operation) => {
    if (!isValidReachShortfall(op.reachShortfall)) return null
    return (
      <span
        className="tree-op-reach-shortfall status-outdated"
        data-tooltip={reachShortfallMessage(op.reachShortfall)}
      >
        <ArrowDownToLine size={10} />
      </span>
    )
  }

  const opTypeLabel = (type: Operation['type']) =>
    operationTypeText(type)

  // WO-2451: Export... on a sketch / setup / operation opens the Export window on
  // that item's row (sketch:<geo>:<layer>, setups, toolpath:<setup>:<op>). The
  // entry is offered only when the window actually has that row.
  const exportRowFor = (target: TreeContextTarget): (() => void) | undefined => {
    const rowId = target.kind === 'op' ? `toolpath:${target.setupId}:${target.opId}`
      : target.kind === 'setup' ? 'setups'
      : target.kind === 'layer' ? `sketch:${target.geoId}:${target.layerId}`
      : null
    if (!rowId || !collectExportGroups().some((g) => g.rows.some((r) => r.id === rowId))) return undefined
    return () => openExportWindow(rowId)
  }

  // ── Phase 7 (7.2): dispatch a context-menu action through existing handlers ──
  // Every branch calls an EXISTING store action / existing tree handler. Delete
  // (op/setup/geometry) confirms first — destructive, irreversible from the menu.
  const dispatchContextAction = useCallback((action: TreeMenuAction, target: TreeContextTarget) => {
    if (target.kind === 'op') {
      const { setupId, opId } = target
      switch (action) {
        // NAV-PARITY-SMALLS gap 3: same destination as the row's inline
        // Settings2 "Edit operation" button.
        case 'op-edit':       openEditOperation(setupId, opId); break
        case 'op-regenerate': { handleActivateOp(setupId, opId); computeOperationToolpath(setupId, opId); break }
        case 'op-duplicate':  duplicateOperation(setupId, opId); break
        case 'op-rename':     setRenameTarget({ kind: 'op', setupId, opId }); break  // P2: inline rename in place
        case 'op-toggle-enabled':
          updateOperation(setupId, opId, { enabled: target.enabled === false })
          break
        case 'op-move-up':    if (target.index > 0) reorderOperations(setupId, target.index, target.index - 1); break
        case 'op-move-down':  if (target.index < target.count - 1) reorderOperations(setupId, target.index, target.index + 1); break
        case 'op-delete':     removeOperation(setupId, opId); break
      }
    } else if (target.kind === 'setup') {
      const { setupId } = target
      switch (action) {
        // NAV-PARITY-SMALLS gap 2: same destination as the row's inline
        // Settings2 "Edit setup" button.
        case 'setup-edit':    openEditSetup(setupId); break
        case 'setup-add-op':  setActiveSetup(setupId); openModal('new-operation'); break
        case 'setup-rename':  setRenameTarget({ kind: 'setup', id: setupId }); break  // P2: inline rename in place
        case 'setup-delete':  removeSetup(setupId); break
      }
    } else if (target.kind === 'layer') {
      // P13: layer menu — every branch reuses the row's own handler / store action.
      const geo = project.geometry.find(g => g.id === target.geoId)
      const layer = geo?.layers2d?.find(l => l.id === target.layerId)
      if (!geo || !layer) return
      switch (action) {
        case 'layer-edit-sketch':       openSketchForLayer(layer.id, geo.id); break  // self-guards STL/projection/locked
        case 'layer-convert-to-model':  void handleConvertLayerToModel(geo.id, layer.id); break  // GEO-UNIFY Stage 3 promote
        case 'layer-rename':            setRenameTarget({ kind: 'layer', geoId: geo.id, layerId: layer.id }); break
        case 'layer-toggle-visibility': handleToggleVisible(geo, layer); break
        case 'layer-toggle-lock':       updateGeometryLayer(geo.id, layer.id, { locked: !layer.locked }); break
        case 'layer-delete':            handleDeleteLayer(undefined, geo, layer.id); break  // same as row Trash button
      }
    } else if (target.kind === 'model-item') {
      // NAV-PARITY-SMALLS gap 4: every branch reuses the row's own handler —
      // Edit routes to the SAME openModelItem the row click + UI-EDIT-MODEL-
      // FROM-BODY's "Edit model" already use; Rename/Delete reuse the row's
      // always-on icon buttons' handlers.
      const item = (project.modelItems ?? []).find((m) => m.id === target.modelItemId)
      if (!item) return
      switch (action) {
        case 'model-item-edit':   openModelItem(item.id); break
        case 'model-item-rename': setRenameTarget({ kind: 'model-item', id: item.id }); break
        case 'model-item-delete': void handleDeleteModelItem(item); break
      }
    } else if (target.kind === 'stock-fixed') {
      // NAV-MENUS: every branch reuses the row's own handler — gizmo toggle is
      // the SAME setSelectedStock the Move3d button uses, Rename is the SAME
      // TreeRenameLabel mechanism, Delete is the SAME handleRemoveFixedStock
      // the row's Trash2 button calls (no confirm — matches the row exactly).
      const { stockId } = target
      switch (action) {
        case 'stock-fixed-toggle-gizmo':
          setSelectedStock(viewer.selectedStockId === stockId ? null : stockId)
          break
        case 'stock-fixed-rename': setRenameTarget({ kind: 'stock-fixed', id: stockId }); break
        case 'stock-fixed-delete': handleRemoveFixedStock(stockId); break
      }
    } else if (target.kind === 'stock-auto') {
      // NAV-MENUS: Rename/Delete reuse the row's own handlers verbatim.
      const { stockId } = target
      switch (action) {
        case 'stock-auto-rename': setRenameTarget({ kind: 'stock-auto', id: stockId }); break
        case 'stock-auto-delete': handleRemoveAutoStock(stockId); break
      }
    } else if (target.kind === 'folder') {
      // NAV-MENUS: Rename reuses the row's own TreeRenameLabel mechanism;
      // Delete reuses handleDeleteFolder verbatim (same confirm + modeled-body
      // re-parent cascade the row's Trash2 button already runs).
      const folder = (project.geometryFolders ?? []).find((f) => f.id === target.folderId)
      if (!folder) return
      switch (action) {
        case 'folder-rename': setRenameTarget({ kind: 'folder', id: folder.id }); break
        case 'folder-delete': handleDeleteFolder(folder); break
      }
    } else if (target.kind === 'op-folder') {
      // NAV-MENUS: every branch reuses the row's own handler — Rename is the
      // SAME TreeRenameLabel mechanism, enable/suppress-all is the SAME
      // setOperationFolderEnabled call the row's Power/PowerOff button makes
      // (target.enableState !== 'enabled' mirrors the row's own !allEnabled),
      // Delete is the SAME removeOperationFolder the row's Trash2 button calls
      // (no confirm — matches the row: operations move back to the setup root).
      const { setupId, folderId, enableState } = target
      switch (action) {
        case 'op-folder-rename': setRenameTarget({ kind: 'op-folder', setupId, folderId }); break
        case 'op-folder-toggle-enabled':
          setOperationFolderEnabled(setupId, folderId, enableState !== 'enabled')
          break
        case 'op-folder-delete': removeOperationFolder(setupId, folderId); break
      }
    } else if (target.kind === 'nest') {
      // NAV-MENUS: every branch reuses the row's own handler verbatim — Edit
      // nest is the SAME setNestEditTarget + openModal('new-nest') the row's
      // Pencil button calls, Rename is the SAME TreeRenameLabel mechanism,
      // Hide/Show/Recompute/Explode/Delete are the SAME setNestVisible /
      // recomputeNest / explodeNest / removeNest the row's icon buttons call
      // (including the same confirms for Explode/Delete).
      const { nestId, visible } = target
      switch (action) {
        case 'nest-edit':
          setNestEditTarget(nestId)
          openModal('new-nest')
          break
        case 'nest-rename': setRenameTarget({ kind: 'nest', id: nestId }); break
        case 'nest-toggle-visibility': setNestVisible(nestId, !visible); break
        case 'nest-recompute': recomputeNest(nestId); break
        case 'nest-explode': {
          const nest = (project.nests ?? []).find((n) => n.id === nestId)
          if (nest) explodeNest(nestId)
          break
        }
        case 'nest-delete': {
          const nest = (project.nests ?? []).find((n) => n.id === nestId)
          if (nest) removeNest(nestId)
          break
        }
      }
    } else {
      const geo = project.geometry.find(g => g.id === target.geoId)
      if (!geo) return
      switch (action) {
        // UI-EDIT-MODEL-FROM-BODY: routes to the SAME openModelItem the
        // placeholder 'model-item' rows use — discoverability fix, no new wiring.
        case 'geo-edit-model': if (target.modelItemId) openModelItem(target.modelItemId); break
        // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4: wrap the imported STEP
        // part or STL mesh row as a Model Item and open it (the action refuses
        // multi-body / missing bytes / curved mesh BY NAME; on success it ends
        // in openModelItem).
        case 'geo-edit-as-model': void wrapImportedGeometryAsModelItem(geo.id); break
        // IMPORT-MULTIBODY-CHOICE (Operator Q-76): re-open the import choice for a
        // still-combined multi-body STEP row, preselected to its stored pick
        // (edit-reuses-original-UI). Picking "one item per body" runs the same
        // fan-out the import flow does.
        case 'geo-choose-multibody-split':
          void useCamStore.getState().reopenMultiBodyImportChoice(geo.id)
          break
        // MSH-4-BOOLEAN-EDIT (nav path 1 + Edit): open the boolean-mesh picker
        // with this mesh preselected, or re-open a result row to re-run it.
        case 'geo-boolean-with-model': useCamStore.getState().openBooleanMeshDialog(geo.id); break
        case 'geo-edit-boolean': useCamStore.getState().openBooleanMeshDialog(null, geo.id); break
        // GEO-UNIFY Stage 1 sec 1.2: model-row affordance parity. Both reuse
        // the SAME renameModelItem / handleDeleteModelItem flow the
        // placeholder rows use — the model's own identity, distinct from
        // this row's own name (geo-rename below).
        case 'geo-rename-model':
          if (target.modelItemId) setRenameTarget({ kind: 'model-item', id: target.modelItemId })
          break
        case 'geo-delete-model': {
          if (!target.modelItemId) break
          const item = (project.modelItems ?? []).find((m) => m.id === target.modelItemId)
          if (item) void handleDeleteModelItem(item)
          break
        }
        case 'geo-rename': setRenameTarget({ kind: 'geometry', id: geo.id }); break  // P2: inline rename in place
        case 'geo-toggle-visibility': toggleGeoVisibility(geo); break
        case 'geo-delete':
          // INT-17A: a modeled part is removed in the Model tab, not from CAM.
          if (geo.format === 'model') {
            useCamStore.getState().addConsoleEvent({
              severity: 'warning',
              source: 'app',
              message: shellText('DesignTree.isAModeledPartToRemoveItFromCAM', { name: geo.name }),
            })
            break
          }
          void confirmRemoveGeo(geo)
          break
      }
    }
  }, [handleActivateOp, computeOperationToolpath, duplicateOperation,
      reorderOperations, removeOperation, updateOperation, setActiveSetup, openModal,
      removeSetup, project.geometry, project.modelItems, project.geometryFolders, project.nests,
      openSketchForLayer, updateGeometryLayer,
      handleToggleVisible, handleDeleteLayer, openModelItem, openEditOperation, openEditSetup,
      handleDeleteModelItem, setSelectedStock, viewer.selectedStockId, handleRemoveFixedStock,
      handleRemoveAutoStock, handleDeleteFolder, setOperationFolderEnabled, removeOperationFolder,
      setNestEditTarget, setNestVisible, recomputeNest, explodeNest, removeNest,
      wrapImportedGeometryAsModelItem])

  // ── Render ─────────────────────────────────────────────────────────────────

  // ── Geometry folders + block renderers (Stage B) ───────────────────────────
  // Root folders (parentId null/undefined). v1 renders only root folders.
  const rootFolders  = (project.geometryFolders ?? []).filter(f => f.parentId == null)
  // Root geometry = parts not in any folder, honoring the active filter.
  // Owned seeds (nest-modal imports) are suppressed from standalone rendering —
  // they appear ONLY as nest children (ADR 0024 / ADR 0025 refined seed model).
  // WO-1573: workholding (a vise/clamp/fixture) is suppressed here too — it
  // renders once, in its own group (renderWorkholdingGroup), regardless of
  // which folder (if any) it sits in.
  const rootGeometry = project.geometry.filter(
    g => (g.folderId == null) && (geoVisibility.get(g.id)?.visible) && !ownedSeedIds.has(g.id) &&
      !isWorkholdingGeometry(g),
  )
  // WO-1573: every visible workholding body, project-wide, in ONE derived
  // group — not a real GeometryFolder (no store shape, no drag/reparent).
  // Membership is purely geo.workholding, read live off dispatchGeo's
  // isWorkholdingGeometry, so toggling the Properties checkbox moves a body
  // between this group and its normal folder/root location on the next render.
  const workholdingGeometry = project.geometry.filter(
    g => isWorkholdingGeometry(g) && (geoVisibility.get(g.id)?.visible) && !ownedSeedIds.has(g.id),
  )
  const WORKHOLDING_GROUP_ID = '__workholding__'

  // Renders ONE geometry card (.tree-geo-block). Used at the root AND inside an
  // expanded folder so both paths share identical markup/behavior. Keeps the
  // reorder drag (geoDragFromIdx -> reorderGeometry) and records dragGeoId so a
  // drop on a folder row / root drop zone re-parents the part.
  const renderGeoBlock = (geo: ImportedGeometry) => (
            <div
              key={geo.id}
              className={`tree-geo-block${geoDragOverId === geo.id ? ' tree-geo-drag-over' : ''}`}
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                geoDragFromIdx.current = project.geometry.findIndex(g => g.id === geo.id)
                dragGeoId.current = geo.id  // for drop-into-folder / drop-to-root
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (geoDragOverId !== geo.id) setGeoDragOverId(geo.id)
              }}
              onDragLeave={() => setGeoDragOverId(null)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setGeoDragOverId(null)
                // Dropping a part onto a part in a DIFFERENT container re-parents
                // it into that container's folder (or root). Same-container drops
                // fall through to the existing reorder.
                const dragId = dragGeoId.current
                const dragged = dragId ? project.geometry.find(g => g.id === dragId) : null
                if (dragged && dragged.id !== geo.id &&
                    (dragged.folderId ?? null) !== (geo.folderId ?? null)) {
                  handleDropGeoIntoFolder(geo.folderId ?? null)
                  return
                }
                const from = geoDragFromIdx.current
                const to = project.geometry.findIndex(g => g.id === geo.id)
                if (from >= 0 && to >= 0 && from !== to) reorderGeometry(from, to)
                geoDragFromIdx.current = -1
                dragGeoId.current = null
              }}
              onDragEnd={() => { setGeoDragOverId(null); geoDragFromIdx.current = -1; dragGeoId.current = null }}
            >
              {/* Geometry card — two-row layout so the name is never truncated */}
              <div
                className={`tree-item-geo ${selectedGeoId === geo.id ? 'tree-item-geo-active' : ''}`}
                onClick={() => { if (renameTarget?.kind !== 'geometry') handleSelectGeo(geo.id) }}
                onContextMenu={(e) => openContextMenu(e, {
                  kind: 'geometry', geoId: geo.id,
                  canToggleVisibility: geo.format === 'stl' || geo.format === 'step' || geo.format === 'model',
                  hidden: !!geo.hidden,
                  // INT-MODEL-UNIFY: resolveOwningModelItemId covers a
                  // legacy-origin row (no modelItemId of its own) the same
                  // way as any other model-origin row, instead of the raw
                  // field leaving "Edit model" permanently unreachable for it.
                  modelItemId: resolveOwningModelItemId(geo),
                  // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 4: gates the "Edit
                  // as model" first item for a plain imported STEP part or STL
                  // mesh row (the shared isWrappableGeometryRow predicate the
                  // inline button + Model tab also gate on).
                  wrappable: isWrappableGeometryRow(geo),
                  // MSH-4-BOOLEAN-EDIT: "Boolean with model body..." (source row +
                  // a model body exists) and "Edit boolean..." (result row).
                  booleanSource: isMeshBooleanSourceRow(geo) && hasModelBooleanBody(project.geometry),
                  booleanResult: isBooleanResultRow(geo),
                  // IMPORT-MULTIBODY-CHOICE (Operator Q-76): "Choose body split..." on
                  // a still-combined multi-body STEP row (2+ solids, not yet split
                  // to model rows). A row already fanned out is format 'model', so
                  // the format guard alone excludes it.
                  multiBodySplit: geo.format === 'step' && (geo.solidCount ?? 0) > 1,
                })}
                data-tooltip={geo.filename}
                // WO-1455: an OPEN_SHELL STEP body (readStepShape found no TopAbs_SOLID
                // subshapes) names its own state via native title, not a badge (console rule) --
                // mass/volume/CoM are undefined for it.
                title={geo.format === 'step' && geo.solidCount === 0
                  ? shellText('DesignTree.openShellNoClosedSolidMassVolumeAndCenter')
                  : undefined}
              >
                {/* Row 1: icon + name + badges */}
                <div className="tree-item-geo-header">
                  {/* Drag-to-reorder handle (flat list; folders come later) */}
                  <span className="tree-geo-drag-handle" data-tooltip={shellText('DesignTree.dragToReorder')}>&#x283F;</span>
                  {/* Collapse the part's layers (chevron only when it has any) */}
                  {(geo.layers2d?.length ?? 0) > 0 ? (
                    <button
                      className="tree-icon-btn tree-part-collapse"
                      onClick={(e) => { e.stopPropagation(); togglePartCollapsed(geo.id) }}
                      data-tooltip={collapsedParts.has(geo.id) ? shellText('DesignTree.expandLayers') : shellText('DesignTree.collapseLayers')}
                      aria-label={collapsedParts.has(geo.id) ? shellText('DesignTree.expandLayers') : shellText('DesignTree.collapseLayers')}
                    >
                      {collapsedParts.has(geo.id) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    </button>
                  ) : (
                    <span className="tree-part-collapse-spacer" />
                  )}
                  <FileBox size={11} className="tree-item-geo-icon" />
                  <TreeRenameLabel
                    name={geo.name}
                    editing={renameTarget?.kind === 'geometry' && renameTarget.id === geo.id}
                    className="tree-item-label"
                    testId="tree-name-geometry"
                    tooltip={shellText('DesignTree.doubleClickToRename')}
                    onStart={() => setRenameTarget({ kind: 'geometry', id: geo.id })}
                    onCommit={(n) => { updateGeometryName(geo.id, n); setRenameTarget(null) }}
                    onCancel={cancelRename}
                  />
                  {seedIds.has(geo.id) && (
                    <span
                      className="tree-seed-badge"
                      data-testid="seed-badge-geo"
                      data-tooltip={shellText('DesignTree.seedNestSource')}
                      style={{ color: 'var(--vp-seed)', display: 'inline-flex', alignItems: 'center' }}
                    >
                      <Sprout size={11} />
                    </span>
                  )}
                  {(geo.format === 'dxf' || geo.format === 'svg')
                    && geo.layers2d?.some((layer) =>
                      layer.sourceOrigin === 'import' && layer.sourceEdited === true
                    ) && (
                      <span
                        className="badge badge-neutral"
                        data-testid={`import-edited-badge-${geo.id}`}
                        data-tooltip={shellText('DesignTree.editedInSketchThisGeometryMayNoLongerMatch')}
                      >{shellText('DesignTree.edited')}</span>
                    )}
                  {geo.booleanProvenance && (
                    <span
                      className={`badge ${geo.approximate ? 'badge-warning' : 'badge-neutral'}`}
                      data-testid={`boolean-badge-${geo.id}`}
                      data-tooltip={
                        shellText('DesignTree.booleanDescription', {
                          quality: geo.approximate ? shellText('DesignTree.approximate') : shellText('DesignTree.exact'),
                          operation: booleanOperationText(geo.booleanProvenance.op),
                          mesh: geo.booleanProvenance.sourceMeshName,
                          body: geo.booleanProvenance.modelBodyName,
                          details: geo.approximate
                          ? shellText('DesignTree.curvedSurfacesUseTheModelBodySDisplayMesh')
                          : shellText('DesignTree.onlyTheGeometryTypeChangedFlatFacesAreExact'),
                        })
                      }
                    >
                      {geo.approximate ? shellText('DesignTree.approx') : shellText('DesignTree.exact2')}
                    </span>
                  )}
                  <span className="tree-item-meta">{geo.format.toUpperCase()}</span>
                  {geo.format === 'stl' && geo.loops && geo.loops.length > 0 && (
                    <span className="tree-item-meta" style={{color:'var(--accent-cyan)'}}>{shellText('DesignTree.text2D', { length: geo.loops.length })}</span>
                  )}
                  {/* GEO-UNIFY Stage 1 D4: the owning model's name, shown only
                      when 2+ models exist (quiet in the dominant 0-1 case) —
                      or while THIS row is mid "Rename model..." (context
                      menu), so the inline edit has somewhere to land even in
                      a single-model project. Same inline-rename mechanism as
                      every other named row; commits through renameModelItem,
                      the model's OWN name — distinct from this row's name
                      (TreeRenameLabel above commits through updateGeometryName). */}
                  {(() => {
                    const modelItemId = resolveOwningModelItemId(geo)
                    if (!modelItemId) return null
                    const modelItems = project.modelItems ?? []
                    const owningItem = modelItems.find((m) => m.id === modelItemId)
                    if (!owningItem) return null
                    const isRenamingModel = renameTarget?.kind === 'model-item' && renameTarget.id === modelItemId
                    if (modelItems.length < 2 && !isRenamingModel) return null
                    // When an item owns 2+ body rows, letting every row mount
                    // its OWN autoFocus rename input for the SAME target at
                    // once is a focus fight (the later input steals focus
                    // from the earlier one, blurring = committing it a frame
                    // later — silently reverting the rename). Only the item's
                    // CANONICAL row (its first owning geometry row, stable
                    // across re-renders) ever gets the editable widget; every
                    // sibling row shows a plain, non-editable meta label.
                    const isCanonicalOwnerRow = firstOwningGeoIdByModelItem.get(modelItemId) === geo.id
                    if (!isCanonicalOwnerRow) {
                      return (
                        <span className="tree-item-meta" data-testid={`tree-name-model-owner-${geo.id}`}>
                          {owningItem.name}
                        </span>
                      )
                    }
                    return (
                      <TreeRenameLabel
                        name={owningItem.name}
                        editing={isRenamingModel}
                        className="tree-item-meta"
                        testId={`tree-name-model-owner-${geo.id}`}
                        tooltip={shellText('DesignTree.doubleClickToRenameModel')}
                        onStart={() => setRenameTarget({ kind: 'model-item', id: modelItemId })}
                        onCommit={(n) => { renameModelItem(modelItemId, n); setRenameTarget(null) }}
                        onCancel={cancelRename}
                      />
                    )
                  })()}
                </div>

                {/* Row 2: action buttons */}
                <div className="tree-item-geo-actions">
                  {/* Color swatch: PP-SWATCH ported this to the SHARED
                      GeometryColorSwatch component (same popup, same
                      handlers) so PropertiesPanel's imported-part action row
                      mounts the identical control, not a duplicate. */}
                  <GeometryColorSwatch geo={geo} />
                  {/* NAV-RENAME-PENCIL: dedicated inline rename affordance for
                      imported part rows (DXF/SVG/STL/legacy-STEP/sketch) --
                      every other named row type (folder, layer, loop,
                      model-item placeholder, nest, stock, setup, op) already
                      has this button; this row previously offered ONLY the
                      double-click-to-rename on the TreeRenameLabel above.
                      Same rename target + commit path as that label and the
                      context menu's "geo-rename" action (setRenameTarget ->
                      updateGeometryName). Omitted (not disabled) for
                      model-origin rows: a modeled body's own-row name is
                      still reachable via the same double-click, and its
                      MODEL identity already has its own dedicated pencil
                      (the owning-model meta widget above, once 2+ models
                      exist) plus "Rename model..." in the context menu. */}
                  {!isModelOriginGeometry(geo) && (
                    <button
                      className="tree-icon-btn"
                      data-testid={`rename-geo-btn-${geo.id}`}
                      onClick={(e) => { e.stopPropagation(); setRenameTarget({ kind: 'geometry', id: geo.id }) }}
                      data-tooltip={shellText('DesignTree.rename')}
                      aria-label={shellText('DesignTree.rename')}
                    ><Pencil size={10} /></button>
                  )}
                  {/* WO-1590 (mating S0): inline Lock/Unlock, same always-visible
                      icon-swap pattern as the Hide/Show button below. A locked
                      row shows a closed padlock; the three write paths that move
                      a body (transform action, viewport gizmo, mate/seat
                      command) all refuse it at updateGeometryTransform and say
                      so on the console. Model-origin rows already refuse any
                      transform write (INT-17C), so locking one is a no-op with
                      no affordance to show. */}
                  {!isModelOriginGeometry(geo) && (
                    <button
                      className="tree-icon-btn"
                      data-testid={`lock-geo-btn-${geo.id}`}
                      onClick={(e) => { e.stopPropagation(); setGeometryLocked(geo.id, !geo.locked) }}
                      data-tooltip={geo.locked ? shellText('DesignTree.unlock') : shellText('DesignTree.lockInPlace')}
                      aria-label={geo.locked ? shellText('DesignTree.unlock') : shellText('DesignTree.lockInPlace')}
                    >
                      {geo.locked ? <Lock size={10} /> : <Unlock size={10} />}
                    </button>
                  )}
                  {/* MSH-4-BOOLEAN-EDIT (nav path 2): inline Combine button. A
                      boolean RESULT row gets "Edit boolean" (re-open the picker
                      to re-run); any other imported mesh gets "Boolean with model
                      body" when a Model body exists. Same shared predicates the
                      context menu + PP button gate on. */}
                  {isBooleanResultRow(geo) ? (
                    <button
                      className="tree-icon-btn"
                      data-testid={`boolean-edit-btn-${geo.id}`}
                      onClick={(e) => { e.stopPropagation(); useCamStore.getState().openBooleanMeshDialog(null, geo.id) }}
                      data-tooltip={shellText('DesignTree.editBooleanReRun')}
                      aria-label={shellText('DesignTree.editBoolean')}
                    ><Combine size={10} /></button>
                  ) : (isMeshBooleanSourceRow(geo) && hasModelBooleanBody(project.geometry)) ? (
                    <button
                      className="tree-icon-btn"
                      data-testid={`boolean-btn-${geo.id}`}
                      onClick={(e) => { e.stopPropagation(); useCamStore.getState().openBooleanMeshDialog(geo.id) }}
                      data-tooltip={shellText('DesignTree.booleanWithModelBody')}
                      aria-label={shellText('DesignTree.booleanWithModelBody')}
                    ><Combine size={10} /></button>
                  ) : null}
                  {/* UI-EDIT-MODEL-FROM-BODY: same inline row-button pattern as
                      every other icon button here (size/style match), calling
                      the SAME openModelItem the context-menu "Edit model" item
                      and the selection-aware Model tab both use. Gated on
                      resolveOwningModelItemId (INT-MODEL-UNIFY), not the raw
                      field, so a legacy-origin row gets this button too. */}
                  {resolveOwningModelItemId(geo) && (
                    <button
                      className="tree-icon-btn"
                      data-testid={`model-edit-btn-${resolveOwningModelItemId(geo)}`}
                      onClick={(e) => { e.stopPropagation(); openModelItem(resolveOwningModelItemId(geo)!) }}
                      data-tooltip={shellText('DesignTree.editModel')}
                      aria-label={shellText('DesignTree.editModel')}
                    >
                      <PenTool size={10} />
                    </button>
                  )}
                  {/* GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4 (nav path 2):
                      inline "Edit as model" PenTool on a wrappable imported STEP
                      part OR STL mesh row -- byte-for-byte the pattern the model
                      row's "Edit model" button (immediately above) shipped with.
                      Omitted (not disabled) on ineligible rows (non-STEP/non-STL,
                      nest seeds) via the shared isWrappableGeometryRow predicate;
                      the wrap action refuses multi-body / missing bytes / curved
                      mesh BY NAME on click. A pending (already-wrapped, not-yet-
                      adopted) row still shows it -- harmless (re-wrap is a fresh
                      item), but the row usually flips to 'model' on next regen. */}
                  {isWrappableGeometryRow(geo) && (
                    <button
                      className="tree-icon-btn"
                      data-testid={`edit-as-model-btn-${geo.id}`}
                      onClick={(e) => { e.stopPropagation(); void wrapImportedGeometryAsModelItem(geo.id) }}
                      data-tooltip={shellText('DesignTree.editAsModel')}
                      aria-label={shellText('DesignTree.editAsModel')}
                    >
                      <PenTool size={10} />
                    </button>
                  )}
                  {(geo.format === 'stl' || geo.format === 'step' || geo.format === 'model') && (
                    <button
                      className="tree-icon-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = !geo.hidden
                        patchGeometry(geo.id, { hidden: next })
                        getVp()?.setSTLVisible?.(geo.id, !next)
                      }}
                      data-tooltip={geo.hidden ? shellText('DesignTree.showModel') : shellText('DesignTree.hideModel')}
                      aria-label={geo.hidden ? shellText('DesignTree.showModel') : shellText('DesignTree.hideModel')}
                    >
                      {geo.hidden ? <EyeOff size={10} /> : <Eye size={10} />}
                    </button>
                  )}
                  {/* Part-level show/hide for 2D parts: toggles ALL layers */}
                  {(geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch')
                    && (geo.layers2d?.length ?? 0) > 0 && (
                    <button
                      className="tree-icon-btn"
                      onClick={(e) => { e.stopPropagation(); handleToggleAllLayers(geo) }}
                      data-tooltip={(geo.layers2d ?? []).every((l) => l.visible)
                        ? shellText('DesignTree.hideAllLayers') : shellText('DesignTree.showAllLayers')}
                      aria-label={(geo.layers2d ?? []).every((l) => l.visible)
                        ? shellText('DesignTree.hideAllLayers') : shellText('DesignTree.showAllLayers')}
                    >
                      {(geo.layers2d ?? []).every((l) => l.visible)
                        ? <Eye size={10} /> : <EyeOff size={10} />}
                    </button>
                  )}
                  {geo.format === 'stl' && (
                    <>
                      <button
                        className={`tree-icon-btn${geo.projectionStale ? ' tree-proj-stale' : ''}`}
                        onClick={(e) => { e.stopPropagation(); handleProjectSTL(geo) }}
                        data-tooltip={geo.projectionStale
                          ? shellText('DesignTree.rotationChangedReSliceTo2DLoops')
                          : sliceToLoopsLabel()}
                        aria-label={geo.projectionStale
                          ? shellText('DesignTree.rotationChangedReSliceTo2DLoops')
                          : sliceToLoopsLabel()}
                        disabled={projectingId === geo.id}
                      >
                        {projectingId === geo.id ? <Loader2 size={10} className="spin" /> : <Layers size={10} />}
                      </button>
                    </>
                  )}
                  {geo.format === 'step' && (
                    <button
                      className="tree-icon-btn"
                      data-testid="tree-step-section"
                      onClick={(e) => { e.stopPropagation(); handleSectionStep(geo) }}
                      data-tooltip={sliceToLoopsLabel()}
                      aria-label={sliceToLoopsLabel()}
                      disabled={projectingId === geo.id}
                    >
                      {projectingId === geo.id ? <Loader2 size={10} className="spin" /> : <Layers size={10} />}
                    </button>
                  )}
                  {/* INT-17A Stage 1: a model-backed entry is a live mirror of a
                      Model-workbench body - it is not independently duplicable
                      from CAM (that stays a Model-tab-only action). */}
                  {geo.format !== 'model' && (
                    <button
                      className="tree-icon-btn"
                      onClick={(e) => { e.stopPropagation(); handleDuplicateGeo(geo) }}
                      data-tooltip={shellText('DesignTree.duplicateGeometry')}
                      aria-label={shellText('DesignTree.duplicateGeometry')}
                    ><Copy size={10} /></button>
                  )}
                  {/* GEO-UNIFY Stage 1 D5: delete parity for model rows. A
                      plain removeGeo() would just refuse (INT-17A backstop,
                      the resurrect-on-regen hazard) — this instead runs the
                      SAME full "delete model" cascade the row's own context
                      menu "Delete model" item does (confirm names every
                      dependent, one undo step). */}
                  {geo.format === 'model' ? (
                    resolveOwningModelItemId(geo) && (
                      <button
                        className="tree-icon-btn tree-icon-btn-danger"
                        data-testid={`delete-model-item-btn-${geo.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          const modelItemId = resolveOwningModelItemId(geo)!
                          const item = (project.modelItems ?? []).find((m) => m.id === modelItemId)
                          if (item) void handleDeleteModelItem(item)
                        }}
                        data-tooltip={shellText('DesignTree.deleteModel')}
                        aria-label={shellText('DesignTree.deleteModel')}
                      ><Trash2 size={10} /></button>
                    )
                  ) : (
                    <button
                      className="tree-icon-btn tree-icon-btn-danger"
                      onClick={(e) => handleRemoveGeo(e, geo)}
                      data-tooltip={shellText('DesignTree.removeGeometry')}
                      aria-label={shellText('DesignTree.removeGeometry')}
                    ><Trash2 size={10} /></button>
                  )}
                  {/* Coordinate hierarchy Phase 4 (Item 5): owning-stock read-out
                      + manual override. Shows which PhysicalStock this part rides
                      with; a lock marker means a manual override (auto-containment
                      won't re-sort it). "Auto" clears the lock. Only shown when the
                      project actually has stocks to choose between.

                      INT-17A-R1 C3 excluded a modeled body here (Stage 1 could not
                      cut one, so it was not stock-eligible). CAM-BINDING Stage 3
                      reverses that: a modeled body can now be picked as a NAMED
                      stock's member the SAME way an imported part already is -
                      "use this body as stock" is this exact dropdown, pointed at a
                      named Auto stock (create one with the tree's own "+ Auto"
                      button, then pick it here). The assigned stock's bounds
                      derive from the body's live tessellated bbox
                      (deriveStockBounds -> resolveModelReferenceFrame) and
                      re-derive automatically on every model edit
                      (store.syncModelBodies). */}
                   {(project.stocks?.length ?? 0) > 0 && !isWorkholdingGeometry(geo) && (
                     <span
                       className="tree-geo-stock"
                      data-tooltip={shellText('DesignTree.owningStockChooseNoneToExcludeThisPartFrom')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {geo.stockIdLocked && (
                        <Lock size={9} className="tree-geo-stock-lock" />
                      )}
                      {(() => {
                        // Selected value reflects resolved membership:
                        //  - 'none'          -> "__none__"
                        //  - 'named-stock'   -> geo.stockId (the owning stock)
                        //  - 'auto-catch-all'-> the default auto stock (shows as "Auto Stock 1")
                        const state = resolveStockMembershipState(geo, project.stocks ?? [])
                        const selected =
                          state === 'none' ? '__none__'
                          : state === 'named-stock' ? (geo.stockId as string)
                          : DERIVED_STOCK_ID
                        // Named stocks the user can pick: auto stocks + fixed stocks (by name).
                        const named = [
                          ...(sceneStock.autoStocks ?? []),
                          ...(sceneStock.fixedStocks ?? []),
                        ]
                        return (
                          <select
                            className="tree-geo-stock-select"
                            value={selected}
                            onChange={(e) => {
                              const v = e.target.value
                              if (v === '__none__') setGeometryNoStock(geo.id)
                              else setStockMembership(geo.id, v)
                            }}
                          >
                            <option value="__none__">{shellText('DesignTree.none')}</option>
                            {named.map((st) => (
                              <option key={st.id} value={st.id}>{st.name}</option>
                            ))}
                          </select>
                        )
                      })()}
                    </span>
                  )}
                  {/* Per-STL projection tolerance moved to global Settings
                      (Settings modal -> STL projection tolerance). The inline
                      per-model control was removed to de-crowd the geometry
                      action row; legacy projects keep any pinned per-model
                      value via the geo.projectionTolerance ?? global ?? 0.02
                      read chain. */}
                </div>
              </div>

              {/* Layer panel for 2D geometry — hidden while the part is folded */}
              {geo.layers2d && geo.layers2d.length > 0 && !collapsedParts.has(geo.id) && (
                <div className="tree-layer-list">
                  {/* Add layer button — SVG and DXF (both are sketchable now
                      that the sketch tool ties to layers). STL layers are
                      projection output, so no manual add there. */}
                  {(geo.format === 'svg' || geo.format === 'dxf') && (
                    <button
                      className="tree-layer-add-btn"
                      onClick={(e) => handleAddLayer(e, geo)}
                      data-tooltip={shellText('DesignTree.addNewLayer')}
                    >
                      <Plus size={9} />{shellText('DesignTree.newLayer')}</button>
                  )}

                  {(() => {
                    // R5: split base (intrinsic) layers from auto-derived
                    // projection layers (deriveBrepLayer sets layer.derived). Base
                    // layers render as before; derived ones collapse under one
                    // "Derived geometry (N)" group row (default COLLAPSED) so face/
                    // hole/cylinder picks don't flood the tree. The text-search
                    // filter (geoVisibility) is applied to BOTH up front so it keeps
                    // working on derived rows when revealed. Display-only: a layer's
                    // `visible`/viewport state and loop output are untouched.
                    const visibleLayers = (geo.layers2d ?? [])
                      .filter(layer => geoVisibility.get(geo.id)?.layers.get(layer.id) ?? true)
                    const baseLayers    = visibleLayers.filter(l => !l.derived)
                    const derivedLayers = visibleLayers.filter(l => l.derived)
                    const derivedOpen   = isDerivedExpanded(geo.id)
                    const renderLayerBlock = (layer: Layer2D) => {
                    const layerKey   = `${geo.id}:${layer.id}`
                    const isRenaming = renameTarget?.kind === 'layer'
                      && renameTarget.geoId === geo.id && renameTarget.layerId === layer.id
                    const isExpanded = expandedLayers.has(layerKey)
                    const layerLoops = geo.loops?.filter(l => l.layerId === layer.id) ?? []
                    // P13: same predicate as the hover Edit-sketch button (~1577).
                    const sketchEditable =
                      (geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch') &&
                      !layer.projectionPlane && !layer.locked
                    // PP-UTILITY Stage 3: layer selection drives the Properties
                    // panel's LayerProperties branch, same mutual-exclusion the
                    // nest row's own `selected` flag follows.
                    const layerSelected =
                      viewer.selectedLayerId === layer.id && viewer.selectedLayerGeoId === geo.id

                    return (
                      <div key={layer.id} className="tree-layer-block">
                        {/* Layer row. P13: double-clicking the row BODY opens sketch
                            edit for sketch-editable layers (the name span stops its
                            own dblclick for rename); right-click opens the layer
                            context menu whose FIRST item is Edit sketch. Single
                            click selects the layer (PP-UTILITY Stage 3), mirroring
                            the nest row's click-selects / chevron-toggles split. */}
                        <div
                          className={`tree-layer-row tree-layer-row-stacked${layerSelected ? ' tree-item-geo-active' : ''}`}
                          data-testid={`tree-layer-row-${geo.id}-${layer.id}`}
                          onClick={() => { if (!isRenaming) setSelectedLayer(layer.id, geo.id) }}
                          onDoubleClick={sketchEditable
                            ? () => openSketchForLayer(layer.id, geo.id)
                            : undefined}
                          onContextMenu={(e) => openContextMenu(e, {
                            kind: 'layer', geoId: geo.id, layerId: layer.id,
                            sketchEditable, canRename: true,
                            locked: !!layer.locked, visible: !!layer.visible,
                          })}
                        >
                          {/* WO-1295: name + identity on their own line so a
                              full row of action icons can never crush the name
                              to zero width (tree-layer-name has overflow:hidden,
                              so its flex automatic minimum size IS zero - it was
                              the only child allowed to disappear entirely). */}
                          <div className="tree-layer-row-main">
                            {/* Expand arrow */}
                            <button
                              className="tree-icon-btn tree-layer-expand"
                              onClick={(e) => { e.stopPropagation(); toggleLayer(layerKey) }}
                              data-tooltip={isExpanded ? shellText('DesignTree.collapse') : shellText('DesignTree.expandLoops')}
                              aria-label={isExpanded ? shellText('DesignTree.collapse') : shellText('DesignTree.expandLoops')}
                            >
                              {isExpanded
                                ? <ChevronDown size={9} />
                                : <ChevronRight size={9} />}
                            </button>

                            {/* Color swatch → opens color picker */}
                            <span
                              className="tree-layer-swatch"
                              style={{ background: layer.color, cursor: 'pointer' }}
                              data-tooltip={shellText('DesignTree.clickToChangeColor')}
                              onClick={(e) => handleSwatchClick(e, geo.id, layer.id)}
                            />

                            {/* Name — inline rename on double-click (shared P2 mechanism) */}
                            <TreeRenameLabel
                              name={layer.name}
                              editing={isRenaming}
                              className="tree-layer-name"
                              inputClassName="tree-layer-rename-input"
                              testId="tree-name-layer"
                              onStart={() => setRenameTarget({ kind: 'layer', geoId: geo.id, layerId: layer.id })}
                              onCommit={(n) => { updateGeometryLayer(geo.id, layer.id, { name: n }); setRenameTarget(null) }}
                              onCancel={cancelRename}
                            />

                            {layer.sectionSource !== undefined
                              && layer.sectionStale === true && (
                              <span
                                className="badge badge-warning"
                                data-testid={`section-stale-badge-${geo.id}-${layer.id}`}
                                data-tooltip={shellText('DesignTree.sourceModelChangedAfterThisSectionWasCreatedCreate')}
                              >{shellText('DesignTree.stale')}</span>
                            )}
                            <span className="tree-layer-count">{layerLoops.length}</span>
                          </div>

                          <div className="tree-layer-row-actions">
                            {/* Visibility toggle */}
                            <button
                              className="tree-icon-btn"
                              onClick={() => handleToggleVisible(geo, layer)}
                              data-tooltip={layer.visible ? shellText('DesignTree.hideLayer') : shellText('DesignTree.showLayer')}
                              aria-label={layer.visible ? shellText('DesignTree.hideLayer') : shellText('DesignTree.showLayer')}
                            >
                              {layer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                            </button>

                            {/* Lock toggle (Stage 6): a locked layer refuses
                                sketch editing (Edit-in-Sketch + entry chooser
                                + store guard, with a notice); visibility and
                                color stay free; project/use may still consume
                                it read-only. Persists on Layer2D.locked. */}
                            <button
                              className="tree-icon-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                updateGeometryLayer(geo.id, layer.id, { locked: !layer.locked })
                              }}
                              data-tooltip={layer.locked
                                ? shellText('DesignTree.unlockLayerAllowSketchEditing')
                                : shellText('DesignTree.lockLayerBlockSketchEditingVisibilityColorStayFree')}
                              aria-label={layer.locked ? shellText('DesignTree.unlockLayer') : shellText('DesignTree.lockLayer')}
                            >
                              {layer.locked ? <Lock size={10} /> : <Unlock size={10} />}
                            </button>

                            {/* Rename button */}
                            {!isRenaming && (
                              <button
                                className="tree-icon-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setRenameTarget({ kind: 'layer', geoId: geo.id, layerId: layer.id })
                                }}
                                data-tooltip={shellText('DesignTree.renameLayer')}
                                aria-label={shellText('DesignTree.renameLayer')}
                              >
                                <Pencil size={9} />
                              </button>
                            )}

                            {/* Edit sketch — stored parametric documents
                                re-open as-is (PLAN D5); imported DXF/SVG
                                layers are LIFTED into a new sketch on first
                                edit. STL-projected layers are read-only
                                (ADR-0011) and locked layers refuse edits, so
                                neither gets the button (the store action
                                guards them too, with a notice). */}
                            {(geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch') &&
                              !layer.projectionPlane && !layer.locked && (
                              <button
                                className="tree-icon-btn"
                                onClick={(e) => { e.stopPropagation(); openSketchForLayer(layer.id, geo.id) }}
                                data-tooltip={geo.sketches?.some((sk) => sk.layerId === layer.id)
                                  ? shellText('DesignTree.editSketchParametricReEdit')
                                  : shellText('DesignTree.editInSketchLiftImportedGeometry')}
                                aria-label={geo.sketches?.some((sk) => sk.layerId === layer.id) ? shellText('DesignTree.editSketch') : shellText('DesignTree.editInSketch')}
                              >
                                <PenTool size={9} />
                              </button>
                            )}

                            {/* GEO-UNIFY Stage 3: Convert to model — inline
                                affordance beside Edit sketch, omitted (not
                                disabled) on ineligible rows, SAME sketchEditable
                                gate. MOVES the sketch into a new model as its base
                                sketch; the confirm names any dependent CAM ops. */}
                            {sketchEditable && (
                              <button
                                className="tree-icon-btn"
                                data-testid={`layer-convert-model-${layer.id}`}
                                onClick={(e) => { e.stopPropagation(); void handleConvertLayerToModel(geo.id, layer.id) }}
                                data-tooltip={shellText('DesignTree.convertToModelMoveThisSketchIntoANew')}
                                aria-label={shellText('DesignTree.convertToModel')}
                              >
                                <Box size={9} />
                              </button>
                            )}

                            {/* Optimize layer (any imported 2D loops: STL
                                projections, DXF, SVG, brep sections). Sketch
                                layers are parametric - edit them in sketch mode
                                instead. The optimizer handles open polylines
                                (DXF) as well as closed contours. */}
                            {geo.format !== 'sketch' && layerLoops.length > 0 && (
                              <button
                                className="tree-icon-btn"
                                onClick={(e) => { e.stopPropagation(); handleOptimizeLayer(geo, layer.id) }}
                                data-tooltip={shellText('DesignTree.fitArcsMergeLinesForThisLayer')}
                                aria-label={shellText('DesignTree.fitArcsMergeLines')}
                                disabled={optimizingId === `${geo.id}:${layer.id}`}
                              >
                                {optimizingId === `${geo.id}:${layer.id}`
                                  ? <Loader2 size={9} className="spin" />
                                  : <Wand2 size={9} />}
                              </button>
                            )}

                            {/* Delete layer */}
                            <button
                              className="tree-icon-btn tree-icon-btn-danger"
                              onClick={(e) => handleDeleteLayer(e, geo, layer.id)}
                              data-tooltip={shellText('DesignTree.deleteLayerDeletesTheLayerSGeometry')}
                              aria-label={shellText('DesignTree.deleteLayer')}
                            >
                              <Trash2 size={9} />
                            </button>
                          </div>
                        </div>

                        {/* Loop sub-list */}
                        {isExpanded && layerLoops.length > 0 && (
                          <div className="tree-loop-list">
                            {layerLoops.map((loop) => {
                              const label = loopLabel(loop, displayUnits)
                              const isLoopRenaming = renameTarget?.kind === 'loop'
                                && renameTarget.geoId === geo.id
                                && renameTarget.loopId === loop.id
                              return (
                              <div key={loop.id} className="tree-loop-row">
                                <span className={`tree-loop-type tree-loop-type-${loop.type}`} />
                                <TreeRenameLabel
                                  name={label}
                                  editing={isLoopRenaming}
                                  className="tree-loop-label"
                                  inputClassName="tree-layer-rename-input"
                                  testId="tree-name-loop"
                                  onStart={() => setRenameTarget({ kind: 'loop', geoId: geo.id, loopId: loop.id })}
                                  onCommit={(name) => {
                                    updateGeometryLoopName(geo.id, loop.id, name)
                                    setRenameTarget(null)
                                  }}
                                  onCancel={cancelRename}
                                />
                                {!isLoopRenaming && (
                                  <button
                                    className="tree-icon-btn"
                                    data-tooltip={shellText('DesignTree.renameLoop')}
                                    aria-label={shellText('DesignTree.renameLoop')}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setRenameTarget({ kind: 'loop', geoId: geo.id, loopId: loop.id })
                                    }}
                                  >
                                    <Pencil size={9} />
                                  </button>
                                )}
                                {/* Move to layer dropdown */}
                                {(geo.layers2d?.length ?? 0) > 1 && (
                                  <select
                                    className="tree-loop-move"
                                    value={loop.layerId}
                                    data-tooltip={shellText('DesignTree.moveToLayer')}
                                    onChange={(e) => handleMoveLoop(geo, loop.id, e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {geo.layers2d!.map(l => (
                                      <option key={l.id} value={l.id}>{l.name}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                    }
                    return (
                      <>
                        {baseLayers.map(renderLayerBlock)}
                        {derivedLayers.length > 0 && (
                          <div className="tree-layer-block tree-derived-group">
                            {/* Group header row — toggles the derived layers'
                                visibility IN THE TREE only (uiPrefs, default
                                collapsed). Does not touch any layer.visible. */}
                            <div
                              className="tree-layer-row tree-derived-group-row"
                              onClick={() => toggleDerivedExpanded(geo.id)}
                              data-tooltip={derivedOpen ? shellText('DesignTree.collapseDerivedGeometry') : shellText('DesignTree.expandDerivedGeometry')}
                              style={{ cursor: 'pointer' }}
                            >
                              <button
                                className="tree-icon-btn tree-layer-expand"
                                onClick={(e) => { e.stopPropagation(); toggleDerivedExpanded(geo.id) }}
                                data-tooltip={derivedOpen ? shellText('DesignTree.collapse') : shellText('DesignTree.expandDerivedGeometry')}
                                aria-label={derivedOpen ? shellText('DesignTree.collapse') : shellText('DesignTree.expandDerivedGeometry')}
                              >
                                {derivedOpen
                                  ? <ChevronDown size={9} />
                                  : <ChevronRight size={9} />}
                              </button>
                              <span className="tree-layer-name">{shellText('DesignTree.derivedGeometry')}</span>
                              <span className="tree-layer-count">{derivedLayers.length}</span>
                            </div>
                            {derivedOpen && derivedLayers.map(renderLayerBlock)}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
  )

  // GEO-UNIFY Stage 1 (plan sec 1.1): renders ONE presentation-only
  // placeholder row for a model item that owns zero geometry rows yet
  // (still empty / in-progress — Operator's "visible immediately" default).
  // NEVER a real ImportedGeometry row (types/index.ts:437 invariant: a
  // modelBody is present IFF format === 'model') — this exists purely to
  // keep the model discoverable in the ONE unified Geometry list. Mirrors
  // renderGeoBlock's two-row card shape (icon+name+badges, then actions) so
  // it reads as one system with the real geometry rows around it. Reuses
  // the SAME 'model-item' context-menu kind + rename/delete handlers the
  // (removed) Model Items section rows used — zero new menu machinery.
  const renderPlaceholderModelRow = (item: ModelItemRecord) => {
    const active = workspace === 'part' && activeModelItemId === item.id
    const isRenaming = renameTarget?.kind === 'model-item' && renameTarget.id === item.id
    return (
      <div
        key={item.id}
        className="tree-geo-block"
        // GEO-UNIFY Stage 2 (plan sec 1.4): draggable OUT into a folder / the
        // root drop zone, the same "own container's drag id ref" shape
        // renderGeoBlock uses (dragModelItemId in place of dragGeoId) since
        // this row has no project.geometry entry of its own to key a drag
        // off of. Drop-ONTO a placeholder (reorder, drop-into-same-container)
        // is out of scope — only folder/root targets accept the drop.
        draggable
        onDragStart={(e) => { e.stopPropagation(); dragModelItemId.current = item.id; e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { dragModelItemId.current = null }}
      >
        <div
          className={`tree-item-geo ${active ? 'tree-item-geo-active' : ''}`}
          data-testid={`model-item-row-${item.id}`}
          onClick={() => { if (!isRenaming) openModelItem(item.id) }}
          onContextMenu={(e) => openContextMenu(e, { kind: 'model-item', modelItemId: item.id })}
          data-tooltip={shellText('DesignTree.open', { name: item.name })}
        >
          <div className="tree-item-geo-header">
            <span className="tree-part-collapse-spacer" />
            <Box size={11} className="tree-item-geo-icon" />
            <TreeRenameLabel
              name={item.name}
              editing={isRenaming}
              className="tree-item-label"
              testId="tree-name-model-item"
              tooltip={shellText('DesignTree.doubleClickToRenameModel')}
              onStart={() => setRenameTarget({ kind: 'model-item', id: item.id })}
              onCommit={(n) => { renameModelItem(item.id, n); setRenameTarget(null) }}
              onCancel={cancelRename}
            />
            {/* D1 default: Box icon + name + "MODEL (empty)" meta. */}
            <span className="tree-item-meta">{shellText('DesignTree.mODELEmpty')}</span>
          </div>
          <div className="tree-item-geo-actions">
            <button
              className="tree-icon-btn"
              data-testid={`rename-model-item-btn-${item.id}`}
              onClick={(e) => { e.stopPropagation(); setRenameTarget({ kind: 'model-item', id: item.id }) }}
              data-tooltip={shellText('DesignTree.renameModel')}
              aria-label={shellText('DesignTree.renameModel')}
            ><Pencil size={10} /></button>
            <button
              className="tree-icon-btn"
              data-testid={`model-placeholder-edit-btn-${item.id}`}
              onClick={(e) => { e.stopPropagation(); openModelItem(item.id) }}
              data-tooltip={shellText('DesignTree.editModel')}
              aria-label={shellText('DesignTree.editModel')}
            ><PenTool size={10} /></button>
            <button
              className="tree-icon-btn tree-icon-btn-danger"
              data-testid={`delete-model-item-btn-${item.id}`}
              onClick={(e) => { e.stopPropagation(); void handleDeleteModelItem(item) }}
              data-tooltip={shellText('DesignTree.deleteModel')}
              aria-label={shellText('DesignTree.deleteModel')}
            ><Trash2 size={10} /></button>
          </div>
        </div>
      </div>
    )
  }

  // Renders ONE folder row + (when expanded) the geometry it contains. Keyed by
  // the folder; collapse state persists via uiPrefs (collapsedFolderIds).
  const renderFolderRow = (folder: GeometryFolder, rootIdx: number, rootCount: number) => {
    const collapsed = isFolderCollapsed(folder.id)
    // Owned seeds (nest-modal imports) are suppressed from standalone folder
    // rendering too — they appear ONLY as nest children (ADR 0024 / ADR 0025).
    // WO-1573: workholding is suppressed here too — see rootGeometry's own
    // comment above.
    const contained = project.geometry.filter(
      g => g.folderId === folder.id && (geoVisibility.get(g.id)?.visible) && !ownedSeedIds.has(g.id) &&
        !isWorkholdingGeometry(g),
    )
    // GEO-UNIFY Stage 2 (plan sec 1.4): empty-model placeholder rows dragged
    // into THIS folder — same visibility-filter shape as `contained` above.
    const containedPlaceholders = placeholderModelItems.filter(
      (item) => item.folderId === folder.id && placeholderVisible(item),
    )
    const totalCount = project.geometry.filter(g => g.folderId === folder.id).length +
      placeholderModelItems.filter((item) => item.folderId === folder.id).length
    // Rollup ignores search-filter visibility (geoVisibility) — a collapsed
    // folder must report what is ACTUALLY inside it, not what the current
    // query happens to show.
    const rollupTier: RollupTier = collapsed
      ? project.geometry
          .filter(g => g.folderId === folder.id)
          .reduce<RollupTier>((worst, g) => worseRollupTier(worst, geometryRollupTier(g)), null)
      : null
    const isRenaming = renameTarget?.kind === 'folder' && renameTarget.id === folder.id
    const dropActive = folderDropTargetId === folder.id
    // Reorder is enabled only when there is more than one folder. The handle
    // GUTTER is always reserved (consistent layout) but the grip is inert with
    // a single folder.
    const canReorder = rootCount > 1
    const reorderOver = folderReorderOverId === folder.id
    // PP-UTILITY Stage 3: selecting drives FolderProperties; mirrors the nest
    // row's own click-selects / chevron-toggles split (2609 above) rather than
    // the folder row's PRIOR click-toggles-collapse behavior.
    const folderSelected =
      viewer.selectedFolderId === folder.id && viewer.selectedFolderKind === 'geometry'
    return (
      <div key={folder.id} className="tree-folder-block">
        <div
          className={`tree-folder-row${folderSelected ? ' tree-item-geo-active' : ''}${dropActive ? ' tree-folder-drag-over' : ''}${reorderOver ? ' tree-reorder-drag-over' : ''}`}
          data-testid={`tree-folder-row-${folder.id}`}
          onClick={() => { if (!isRenaming) setSelectedFolder(folder.id, 'geometry') }}
          onContextMenu={(e) => openContextMenu(e, { kind: 'folder', folderId: folder.id })}
          onDragOver={(e) => {
            // Folder-REORDER drop target (a folder is being dragged): independent
            // of the geo drag path. Geo drag (dragGeoId) re-parents INTO the
            // folder; a folder drag (dragFolderIdx) reorders folders.
            if (dragFolderIdx.current >= 0) {
              e.preventDefault(); e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              if (folderReorderOverId !== folder.id) setFolderReorderOverId(folder.id)
              return
            }
            // GEO-UNIFY Stage 2: a dragged placeholder row highlights the
            // folder exactly like a dragged geo row.
            if (!dragGeoId.current && !dragModelItemId.current) return
            e.preventDefault(); e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (folderDropTargetId !== folder.id) setFolderDropTargetId(folder.id)
          }}
          onDragLeave={() => { setFolderDropTargetId(null); setFolderReorderOverId(null) }}
          onDrop={(e) => {
            // Folder-reorder drop wins when a folder is being dragged.
            if (dragFolderIdx.current >= 0) {
              e.preventDefault(); e.stopPropagation()
              const from = dragFolderIdx.current
              dragFolderIdx.current = -1
              setFolderReorderOverId(null)
              if (from >= 0 && from !== rootIdx) reorderGeometryFolder(from, rootIdx)
              return
            }
            // GEO-UNIFY Stage 2: a dragged placeholder row re-parents via
            // setModelItemFolderId instead of setGeometryFolderId.
            if (dragModelItemId.current) {
              e.preventDefault(); e.stopPropagation()
              handleDropModelItemIntoFolder(folder.id)
              return
            }
            if (!dragGeoId.current) return
            e.preventDefault(); e.stopPropagation()
            handleDropGeoIntoFolder(folder.id)
          }}
        >
          {/* Reserve the drag-handle gutter on EVERY folder row (consistent
              layout); only make it draggable when there is more than one folder. */}
          <span
            className={`tree-reorder-handle${canReorder ? '' : ' tree-reorder-handle-disabled'}`}
            data-testid="folder-drag-handle"
            data-tooltip={canReorder ? shellText('DesignTree.dragToReorderFolder') : undefined}
            draggable={canReorder}
            onClick={(e) => e.stopPropagation()}
            onDragStart={canReorder ? (e) => {
              e.stopPropagation()
              dragFolderIdx.current = rootIdx
              e.dataTransfer.effectAllowed = 'move'
            } : undefined}
            onDragEnd={() => { dragFolderIdx.current = -1; setFolderReorderOverId(null) }}
          >
            <GripVertical size={11} />
          </span>
          <span
            className="tree-folder-chevron"
            onClick={(e) => { e.stopPropagation(); toggleFolderCollapsed(folder.id) }}
            data-tooltip={collapsed ? shellText('DesignTree.expandFolder') : shellText('DesignTree.collapseFolder')}
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </span>
          {collapsed
            ? <Folder size={12} className="tree-folder-icon" />
            : <FolderOpen size={12} className="tree-folder-icon" />}
          <TreeRenameLabel
            name={folder.name}
            editing={isRenaming}
            className="tree-folder-name"
            testId="tree-name-folder"
            tooltip={shellText('DesignTree.doubleClickToRenameFolder')}
            onStart={() => setRenameTarget({ kind: 'folder', id: folder.id })}
            onCommit={(n) => { renameGeometryFolder(folder.id, n); setRenameTarget(null) }}
            onCancel={cancelRename}
          />
          <span className="tree-folder-count">{totalCount}</span>
          <span className="tree-folder-actions">
            <button
              className="tree-icon-btn"
              onClick={(e) => { e.stopPropagation(); setRenameTarget({ kind: 'folder', id: folder.id }) }}
              data-tooltip={shellText('DesignTree.renameFolder')}
              aria-label={shellText('DesignTree.renameFolder')}
            ><Pencil size={9} /></button>
            <button
              className="tree-icon-btn tree-icon-btn-danger"
              onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder) }}
              data-tooltip={shellText('DesignTree.deleteFolderAndItsContents')}
              aria-label={shellText('DesignTree.deleteFolder')}
            ><Trash2 size={9} /></button>
          </span>
          <RollupBadge tier={rollupTier} testId={`tree-rollup-badge-folder-${folder.id}`} />
        </div>
        {!collapsed && (
          <div className="tree-folder-contents">
            {contained.length === 0 && containedPlaceholders.length === 0
              ? <div className="tree-folder-empty">{shellText('DesignTree.emptyDragPartsHere')}</div>
              : (<>
                  {containedPlaceholders.map(renderPlaceholderModelRow)}
                  {contained.map((geo) => renderGeoBlock(geo))}
                </>)}
          </div>
        )}
      </div>
    )
  }

  // WO-1573: the Workholding group — a flat, derived list of every body
  // marked workholding, always shown together so a vise/clamp reads as
  // fixture hardware rather than a stray part. Not draggable/renameable/
  // deletable (it is not a real GeometryFolder); collapse state reuses the
  // same collapsedFolderIds/toggleFolderCollapsed uiPrefs list real folders
  // use, keyed by the synthetic WORKHOLDING_GROUP_ID.
  const renderWorkholdingGroup = () => {
    if (workholdingGeometry.length === 0) return null
    const collapsed = isFolderCollapsed(WORKHOLDING_GROUP_ID)
    // WO-2172: a vise lists as ONE item with its bodies under it; bodies in
    // no vise stay flat beside it, exactly as before.
    const vises = viseInstances(project.workholding)
    const inVise = new Set(vises.flatMap(({ definition }) => definition.components.map((c) => c.geometryId)))
    // WO-2192: a clamp's shape body lists as that clamp (ClampTreeGroup), not as a loose body.
    for (const { definition } of clampDefinitions(project.workholding)) {
      for (const c of definition.components) inVise.add(c.geometryId)
    }
    const looseGeometry = workholdingGeometry.filter((g) => !inVise.has(g.id))
    return (
      <div className="tree-folder-block" data-testid="tree-workholding-group">
        <div
          className="tree-folder-row"
          data-testid="tree-workholding-row"
          onClick={() => toggleFolderCollapsed(WORKHOLDING_GROUP_ID)}
        >
          <span className="tree-reorder-handle tree-reorder-handle-disabled" />
          <span
            className="tree-folder-chevron"
            data-tooltip={collapsed ? shellText('DesignTree.expandWorkholding') : shellText('DesignTree.collapseWorkholding')}
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </span>
          <Anchor size={12} className="tree-folder-icon" />
          <span className="tree-folder-name" data-tooltip={shellText('DesignTree.visesClampsAndFixturesNeverStockNeverCut')}>{shellText('DesignTree.workholding')}</span>
          <span className="tree-folder-count">{workholdingGeometry.length}</span>
        </div>
        {!collapsed && (
          <div className="tree-folder-contents">
            {vises.map((vise) => renderViseBlock(vise))}
            <ClampTreeGroup />
            {looseGeometry.map((geo) => renderGeoBlock(geo))}
          </div>
        )}
      </div>
    )
  }

  // WO-2172: one placed vise. Selecting it selects its fixed body (the
  // Properties panel then shows the vise); renaming renames the vise; the bin
  // removes the vise and leaves both bodies as workholding where they sit.
  // WO-2198: a vise placed again from the same definition is its own row,
  // selected as itself; its bodies are listed once, under the first.
  const renderViseBlock = ({ instance, definition }: ReturnType<typeof viseInstances>[number]) => {
    const key = `vise:${instance.id}`
    const collapsed = isFolderCollapsed(key)
    const drawsRows = rowDrawnInstanceIds(project.workholding).has(instance.id)
    const bodies = !drawsRows ? [] : definition.components
      .map((c) => project.geometry.find((g) => g.id === c.geometryId))
      .filter((g): g is ImportedGeometry => !!g && !!geoVisibility.get(g.id)?.visible)
    const fixedId = definition.components.find((c) => !c.joint)?.geometryId ?? definition.components[0]?.geometryId
    const active = drawsRows
      ? definition.components.some((c) => c.geometryId === selectedGeoId)
      : selectedWorkholdingId === instance.id
    const moving = definition.components.find((c) => c.joint) ?? null
    const opening = viseOpeningLabel({ instance, moving }, displayUnits)
    const renaming = renameTarget?.kind === 'workholding' && renameTarget.id === instance.id
    return (
      <div key={key} className="tree-geo-block" data-testid={`tree-vise-${instance.id}`}>
        <div
          className={`tree-item-geo ${active ? 'tree-item-geo-active' : ''}`}
          data-testid="tree-vise-row"
          onClick={() => {
            if (renaming) return
            if (!drawsRows) selectClamp(instance.id)
            else if (fixedId) handleSelectGeo(fixedId)
          }}
        >
          <div className="tree-item-geo-header">
            <span className="tree-geo-drag-handle" />
            <button
              className="tree-icon-btn tree-part-collapse"
              onClick={(e) => { e.stopPropagation(); toggleFolderCollapsed(key) }}
              data-tooltip={collapsed ? shellText('DesignTree.showItsBodies') : shellText('DesignTree.hideItsBodies')}
              aria-label={collapsed ? shellText('DesignTree.showItsBodies') : shellText('DesignTree.hideItsBodies')}
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
            <Anchor size={11} className="tree-item-geo-icon" />
            <TreeRenameLabel
              name={definition.name}
              editing={renaming}
              className="tree-item-label"
              testId="tree-name-vise"
              tooltip={shellText('DesignTree.doubleClickToRename')}
              onStart={() => setRenameTarget({ kind: 'workholding', id: instance.id })}
              onCommit={(n) => { useCamStore.getState().renameWorkholding(instance.id, n); setRenameTarget(null) }}
              onCancel={cancelRename}
            />
            {opening && (
              <span className="tree-item-meta" data-testid="tree-vise-opening" data-tooltip={shellText('DesignTree.opening')}>{opening}</span>
            )}
            <button
              className="tree-icon-btn"
              data-testid={`rename-vise-btn-${instance.id}`}
              onClick={(e) => { e.stopPropagation(); setRenameTarget({ kind: 'workholding', id: instance.id }) }}
              data-tooltip={shellText('DesignTree.rename')}
              aria-label={shellText('DesignTree.renameVise')}
            ><Pencil size={10} /></button>
            <button
              className="tree-icon-btn"
              data-testid={`remove-vise-btn-${instance.id}`}
              onClick={(e) => { e.stopPropagation(); useCamStore.getState().removeWorkholding(instance.id) }}
              data-tooltip={shellText('DesignTree.removeViseItsBodiesStayAsWorkholding')}
              aria-label={shellText('DesignTree.removeVise')}
            ><Trash2 size={10} /></button>
          </div>
        </div>
        {!collapsed && bodies.length > 0 && (
          <div className="tree-folder-contents" data-testid="tree-vise-bodies">
            {bodies.map((geo) => renderGeoBlock(geo))}
          </div>
        )}
      </div>
    )
  }

  // ── Nesting (P3.3 tree node + P4.1 New Nest modal launch) ───────────────────
  const nests = project.nests ?? []

  // Seed layer row: the nest seed child expands to its owned-seed geometry's
  // per-layer rows. The owned seed is a DEEP COPY of the source part, so its
  // format / locked / projectionPlane gating is identical to a root geometry —
  // this row therefore reuses the SAME handlers + CSS classes + gating as the
  // root-geometry layer rows (handleSwatchClick / handleToggleVisible /
  // updateGeometryLayer / openSketchForLayer / handleDeleteLayer) so the seed
  // reads and behaves identically. The geo passed in IS the owned-seed geometry,
  // so geo.id is the correct id for every handler. NOTE (deferred to a follow-up
  // stage): edits still appear at the origin until the seed slot is repositioned.
  // Still NO whole-seed hide icon — per-layer visibility only (standing decision).
  // Plain render helper (returns JSX) — not a hook.
  const renderSeedLayerRow = (geo: ImportedGeometry, layer: Layer2D) => {
    const layerLoops = geo.loops?.filter(l => l.layerId === layer.id) ?? []
    // P13: same predicate as the root row. Seed layer names are plain spans
    // (no inline rename), so the context menu omits Rename (canRename: false).
    const sketchEditable =
      (geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch') &&
      !layer.projectionPlane && !layer.locked
    return (
      <div key={layer.id} className="tree-layer-block">
        <div
          className="tree-layer-row"
          data-testid="seed-layer-row"
          onDoubleClick={sketchEditable
            ? () => openSketchForLayer(layer.id, geo.id)
            : undefined}
          onContextMenu={(e) => openContextMenu(e, {
            kind: 'layer', geoId: geo.id, layerId: layer.id,
            sketchEditable, canRename: false,
            locked: !!layer.locked, visible: !!layer.visible,
          })}
        >
          {/* No expand arrow (loop sub-list deferred); reserve the gutter so the
              row aligns with root layer rows. */}
          <span className="tree-layer-expand" />
          <span
            className="tree-layer-swatch"
            style={{ background: layer.color, cursor: 'pointer' }}
            data-tooltip={shellText('DesignTree.clickToChangeColor')}
            onClick={(e) => handleSwatchClick(e, geo.id, layer.id)}
          />
          <span className="tree-layer-name" data-tooltip={layer.name}>{layer.name}</span>
          <span className="tree-layer-count">{layerLoops.length}</span>
          {/* Visibility toggle. Wired to the same handleToggleVisible the root
              rows use; the seed-slot render honours the flag via
              restoreNestsToViewport's loop filter. */}
          <button
            className="tree-icon-btn"
            data-testid="seed-layer-vis"
            onClick={() => handleToggleVisible(geo, layer)}
            data-tooltip={layer.visible ? shellText('DesignTree.hideLayer') : shellText('DesignTree.showLayer')}
            aria-label={layer.visible ? shellText('DesignTree.hideLayer') : shellText('DesignTree.showLayer')}
          >
            {layer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
          </button>

          {/* Lock toggle — same gating/handler as the root row (updateGeometryLayer
              with {locked}); a locked layer refuses sketch editing. */}
          <button
            className="tree-icon-btn"
            data-testid="seed-layer-lock"
            onClick={(e) => {
              e.stopPropagation()
              updateGeometryLayer(geo.id, layer.id, { locked: !layer.locked })
            }}
            data-tooltip={layer.locked
              ? shellText('DesignTree.unlockLayerAllowSketchEditing')
              : shellText('DesignTree.lockLayerBlockSketchEditingVisibilityColorStayFree')}
            aria-label={layer.locked ? shellText('DesignTree.unlockLayer') : shellText('DesignTree.lockLayer')}
          >
            {layer.locked ? <Lock size={10} /> : <Unlock size={10} />}
          </button>

          {/* Edit sketch — SAME gating as the root row: sketchable format,
              non-projection, non-locked. openSketchForLayer lifts imported
              DXF/SVG layers on first edit. */}
          {(geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch') &&
            !layer.projectionPlane && !layer.locked && (
            <button
              className="tree-icon-btn"
              data-testid="seed-layer-edit"
              onClick={(e) => { e.stopPropagation(); openSketchForLayer(layer.id, geo.id) }}
              data-tooltip={geo.sketches?.some((sk) => sk.layerId === layer.id)
                ? shellText('DesignTree.editSketchParametricReEdit')
                : shellText('DesignTree.editInSketchLiftImportedGeometry')}
              aria-label={geo.sketches?.some((sk) => sk.layerId === layer.id) ? shellText('DesignTree.editSketch') : shellText('DesignTree.editInSketch')}
            >
              <Pencil size={9} />
            </button>
          )}

          {/* Delete layer — same handler as the root row (deletes the layer's
              geometry; loopsVersion bumps so the seed slot re-renders). */}
          <button
            className="tree-icon-btn tree-icon-btn-danger"
            data-testid="seed-layer-delete"
            onClick={(e) => handleDeleteLayer(e, geo, layer.id)}
            data-tooltip={shellText('DesignTree.deleteLayerDeletesTheLayerSGeometry')}
            aria-label={shellText('DesignTree.deleteLayer')}
          >
            <Trash2 size={9} />
          </button>
        </div>
      </div>
    )
  }

  // N1a: a nest renders as a FOLDER-LIKE node INSIDE the Geometry section. The
  // ROW BODY click selects the nest (mutually exclusive with geometry/op, via
  // setSelectedNest); the chevron expands/collapses (persisted in uiPrefs,
  // mirroring folders) to reveal one child row per source geometry. The seed
  // child row is itself selectable (selects the owned-seed geometry) and
  // expandable to its per-layer visibility rows (seed layer eyes).
  // This is a plain render helper (returns JSX) — NOT a hook — so it never
  // changes the hooks order; it is defined unconditionally before the return.
  const renderNestFolderRow = (nest: NonNullable<typeof project.nests>[number], nestIdx: number, nestCount: number) => {
    const placed    = nest.placements.length
    const left      = nest.unplaced.reduce((sum, u) => sum + u.count, 0)
    const visible   = nest.visible ?? true
    // Once nest.status is populated it is the canonical job state (WO-1406):
    // a settled 'ready' result — including a deliberately Accepted zero-fit
    // (placed===0, left>0) — must read as done, never stuck "computing...".
    // The placed/left heuristic only covers the narrow pre-dispatch window
    // where status itself is not yet set (headless create, worker not back).
    const computing = nest.status ? nest.status === 'computing' : (placed === 0 && left > 0)
    const stale     = nest.needsRecompute === true  // seed edited -> pack outdated
    const collapsed = isNestCollapsed(nest.id)
    const rollupTier: RollupTier = collapsed ? nestRollupTier(nest) : null
    const isRenaming = renameTarget?.kind === 'nest' && renameTarget.id === nest.id
    const selected  = viewer.selectedNestId === nest.id
    // Reorder enabled only with more than one nest; handle gutter always
    // reserved for a consistent layout (mirrors folders).
    const canReorder = nestCount > 1
    const reorderOver = nestReorderOverId === nest.id
    return (
      <div key={nest.id} className="tree-folder-block">
        <div
          className={`tree-folder-row${selected ? ' tree-item-geo-active' : ''}${reorderOver ? ' tree-reorder-drag-over' : ''}`}
          onClick={() => { if (!isRenaming) setSelectedNest(nest.id) }}
          onContextMenu={(e) => openContextMenu(e, {
            kind: 'nest', nestId: nest.id, visible, stale,
          })}
          onDragOver={(e) => {
            // Nest-reorder drop target. Independent of folder/geo drags: only a
            // nest drag (dragNestIdx) is accepted here.
            if (dragNestIdx.current < 0) return
            e.preventDefault(); e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (nestReorderOverId !== nest.id) setNestReorderOverId(nest.id)
          }}
          onDragLeave={() => setNestReorderOverId(null)}
          onDrop={(e) => {
            if (dragNestIdx.current < 0) return
            e.preventDefault(); e.stopPropagation()
            const from = dragNestIdx.current
            dragNestIdx.current = -1
            setNestReorderOverId(null)
            if (from >= 0 && from !== nestIdx) reorderNest(from, nestIdx)
          }}
        >
          {/* Reserve the drag-handle gutter on EVERY nest row; only draggable
              when there is more than one nest. */}
          <span
            className={`tree-reorder-handle${canReorder ? '' : ' tree-reorder-handle-disabled'}`}
            data-testid="nest-drag-handle"
            data-tooltip={canReorder ? shellText('DesignTree.dragToReorderNest') : undefined}
            draggable={canReorder}
            onClick={(e) => e.stopPropagation()}
            onDragStart={canReorder ? (e) => {
              e.stopPropagation()
              dragNestIdx.current = nestIdx
              e.dataTransfer.effectAllowed = 'move'
            } : undefined}
            onDragEnd={() => { dragNestIdx.current = -1; setNestReorderOverId(null) }}
          >
            <GripVertical size={11} />
          </span>
          <span
            className="tree-folder-chevron"
            onClick={(e) => { e.stopPropagation(); toggleNestCollapsed(nest.id) }}
            data-tooltip={collapsed ? shellText('DesignTree.expandNest') : shellText('DesignTree.collapseNest')}
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </span>
          <LayoutGrid size={12} className="tree-folder-icon" />
          <TreeRenameLabel
            name={nest.name}
            editing={isRenaming}
            className="tree-folder-name"
            testId="tree-name-nest"
            tooltip={shellText('DesignTree.doubleClickToRename')}
            onStart={() => setRenameTarget({ kind: 'nest', id: nest.id })}
            onCommit={(n) => { renameNest(nest.id, n); setRenameTarget(null) }}
            onCancel={cancelRename}
          />
          {/* Declutter (Operator N1a review): the tree row no longer carries the
              placed/left/util/time detail — that lives in the Properties panel
              when the nest is selected. The row mirrors a folder: a quiet
              source-part count, plus a transient 'computing...' while packing. */}
          {computing
            ? <span className="tree-item-meta">{shellText('DesignTree.computing2')}</span>
            : <span className="tree-folder-count">{nest.sources.length}</span>}
          <span className="tree-folder-actions">
            <button
              className="tree-icon-btn"
              onClick={(e) => { e.stopPropagation(); setNestVisible(nest.id, !visible) }}
              data-tooltip={visible ? shellText('DesignTree.hideNest') : shellText('DesignTree.showNest')}
              aria-label={visible ? shellText('DesignTree.hideNest') : shellText('DesignTree.showNest')}
            >
              {visible ? <Eye size={9} /> : <EyeOff size={9} />}
            </button>
            <button
              className="tree-icon-btn"
              onClick={(e) => {
                e.stopPropagation()
                // Edit: reopen the New Nest modal PREFILLED from this record; on
                // Accept the modal deletes this nest and the recompute replaces it.
                setNestEditTarget(nest.id)
                openModal('new-nest')
              }}
              data-tooltip={shellText('DesignTree.editNest')}
              aria-label={shellText('DesignTree.editNest')}
            ><Pencil size={9} /></button>
            {stale && (
              <button
                className="tree-icon-btn tree-icon-btn-active"
                data-testid="nest-recompute"
                onClick={(e) => { e.stopPropagation(); recomputeNest(nest.id) }}
                data-tooltip={shellText('DesignTree.recomputeNestSeedChanged')}
                aria-label={shellText('DesignTree.recomputeNest')}
              ><RefreshCw size={9} /></button>
            )}
            <button
              className="tree-icon-btn"
              data-testid="nest-explode"
              onClick={(e) => {
                e.stopPropagation()
                explodeNest(nest.id)
              }}
              data-tooltip={shellText('DesignTree.explodeNestPartsBecomeIndependent')}
              aria-label={shellText('DesignTree.explodeNest')}
            ><Ungroup size={9} /></button>
            <button
              className="tree-icon-btn tree-icon-btn-danger"
              onClick={(e) => {
                e.stopPropagation()
                removeNest(nest.id)
              }}
              data-tooltip={shellText('DesignTree.removeNest')}
              aria-label={shellText('DesignTree.removeNest')}
            ><Trash2 size={9} /></button>
          </span>
          <RollupBadge tier={rollupTier} testId={`tree-rollup-badge-nest-${nest.id}`} />
        </div>
        {!collapsed && (
          <div className="tree-folder-contents">
            {nest.sources.length === 0
              ? <div className="tree-folder-empty">{shellText('DesignTree.noSourceParts')}</div>
              : nest.sources.map((src) => {
                  // The child's geometryId IS the owned-seed geometry (deep-copy
                  // seed model, ADR 0025 §2). Resolve it so the row can select it
                  // and expand to its layers.
                  const seedGeo = project.geometry.find(g => g.id === src.geometryId)
                  const srcName = seedGeo?.name ?? src.geometryId
                  const seedSelected = viewer.selectedGeometryId === src.geometryId
                  const seedLayers = seedGeo?.layers2d ?? []
                  const canExpand = seedLayers.length > 0
                  const expanded = canExpand && isSeedExpanded(src.geometryId)
                  return (
                    <div key={src.geometryId} className="tree-item-geo">
                      <div
                        className={`tree-item-geo-header${seedSelected ? ' tree-item-geo-active' : ''}`}
                        data-testid="nest-seed-row"
                        onClick={() => setSelectedGeometry(src.geometryId)}
                        style={{ cursor: 'pointer' }}
                      >
                        {/* Chevron expands the seed's layer rows (collapsed by
                            default). Reserve the gutter even when there are no
                            layers so the row aligns. */}
                        {canExpand ? (
                          <span
                            className="tree-folder-chevron"
                            data-testid="nest-seed-chevron"
                            onClick={(e) => { e.stopPropagation(); toggleSeedExpanded(src.geometryId) }}
                            data-tooltip={expanded ? shellText('DesignTree.collapseLayers') : shellText('DesignTree.expandLayers')}
                          >
                            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          </span>
                        ) : (
                          <span className="tree-part-collapse-spacer" />
                        )}
                        <FileBox size={11} className="tree-item-geo-icon" />
                        {/* P2: renames the owned-seed GEOMETRY through the same
                            updateGeometryName path; kind 'seed' keeps this row's
                            editor distinct from any root geometry row. */}
                        <TreeRenameLabel
                          name={srcName}
                          editing={renameTarget?.kind === 'seed' && renameTarget.id === src.geometryId}
                          className="tree-item-label"
                          testId="tree-name-seed"
                          onStart={() => setRenameTarget({ kind: 'seed', id: src.geometryId })}
                          onCommit={(n) => { updateGeometryName(src.geometryId, n); setRenameTarget(null) }}
                          onCancel={cancelRename}
                        />
                        {/* Every nest source IS a seed (ADR 0025 §2); show the
                            badge so the authoring source reads the same here as on
                            the geometry row. */}
                        <span
                          className="tree-seed-badge"
                          data-testid="seed-badge-nest-child"
                          data-tooltip={shellText('DesignTree.seedNestSource')}
                          style={{ color: 'var(--vp-seed)', display: 'inline-flex', alignItems: 'center' }}
                        >
                          <Sprout size={11} />
                        </span>
                        <span className="tree-item-meta">{shellText('DesignTree.x', { quantity: src.quantity })}</span>
                      </div>
                      {/* Per-layer rows. Reuses the shared renderSeedLayerRow
                          (visibility + lock + edit-sketch + delete, same handlers
                          and gating as the root layer rows). The "New layer"
                          button uses the SAME gating (svg/dxf) and handler
                          (handleAddLayer) as the root layer panel. Loop sub-lists
                          remain deferred; slot repositioning is a follow-up stage. */}
                      {expanded && (
                        <div className="tree-layer-list">
                          {(seedGeo!.format === 'svg' || seedGeo!.format === 'dxf') && (
                            <button
                              className="tree-layer-add-btn"
                              data-testid="seed-layer-add"
                              onClick={(e) => handleAddLayer(e, seedGeo!)}
                              data-tooltip={shellText('DesignTree.addNewLayer')}
                            >
                              <Plus size={9} />{shellText('DesignTree.newLayer')}</button>
                          )}
                          {seedLayers.map((layer) => renderSeedLayerRow(seedGeo!, layer))}
                        </div>
                      )}
                    </div>
                  )
                })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`panel design-tree${treeDensity === 'compact' ? ' tree-density-compact' : ''}`}>
      {/* Hidden inputs */}
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- this
          is the layer-color picker's own hidden <input type="color">
          (position:absolute so it never affects layout), unconditionally
          mounted -- the real live-session warning traced to THIS input, not
          the filter box below (both are direct-child <input>s of the panel
          root; DOM-path inspection in the headed capture confirmed which). */}
      <input
        ref={colorInputRef}
        type="color"
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
        onChange={handleColorChange}
        data-ui78-sanctioned=""
      />
      <input
        ref={geoFileInputRef}
        type="file"
        accept=".stl,.obj,.dxf,.svg,.step,.stp,.STEP,.STP,.igs,.iges,.json"
        data-testid="geo-file-input"
        style={{ display: 'none' }}
        onChange={handleImportGeometry}
      />

      <div className="panel-header">
        <div className="panel-title">
          <Layers size={13} style={{ flexShrink: 0 }} />
          <TreeRenameLabel
            name={project.name}
            editing={renameTarget?.kind === 'project'}
            className="panel-name"
            inputClassName="panel-project-rename"
            testId="tree-name-project"
            tooltip={shellText('DesignTree.doubleClickToRenameProject')}
            onStart={() => setRenameTarget({ kind: 'project' })}
            onCommit={(n) => { updateProjectMeta({ name: n }); setRenameTarget(null) }}
            onCancel={cancelRename}
          />
        </div>
      </div>

      {/* ── Tree toolbar (Phase 6, P10): filter + collapse/expand + density ── */}
      <div className="tree-toolbar">
        <div className="tree-filter">
          <Filter size={12} className="tree-filter-icon" />
          <input
            className="tree-filter-input"
            type="text"
            value={filterText}
            placeholder={shellText('DesignTree.filterByNameOrType')}
            aria-label={shellText('DesignTree.filterDesignTreeByNameOrType')}
            data-testid="tree-filter-input"
            // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
            // the tree's own filter box, positioned within its docked toolbar,
            // not a canvas overlay.
            data-ui78-sanctioned=""
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); clearFilter() } }}
          />
          {filterText && (
            <button
              className="tree-filter-clear"
              data-testid="tree-filter-clear"
              data-tooltip={shellText('DesignTree.clearFilter')}
              aria-label={shellText('DesignTree.clearFilter')}
              onClick={clearFilter}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className="icon-btn"
          data-testid="tree-collapse-all"
          data-tooltip={shellText('DesignTree.collapseAll')}
          aria-label={shellText('DesignTree.collapseAll')}
          onClick={collapseAll}
        >
          <ChevronsDownUp size={13} />
        </button>
        <button
          className="icon-btn"
          data-testid="tree-expand-all"
          data-tooltip={shellText('DesignTree.expandAll')}
          aria-label={shellText('DesignTree.expandAll')}
          onClick={expandAll}
        >
          <ChevronsUpDown size={13} />
        </button>
        <button
          className="icon-btn"
          data-testid="tree-top-level"
          data-tooltip={shellText('DesignTree.topLevelSectionsOpenEveryItemFoldedOutlineView')}
          aria-label={shellText('DesignTree.topLevel')}
          onClick={topLevel}
        >
          <ListTree size={13} />
        </button>
      </div>

      <div className="panel-body">

        {/* ── Stock ─────────────────────────────────────────────────────── */}
        <div className="tree-section">
          <div
            className="tree-section-header tree-section-header-btn"
            onClick={() => toggleTreeSection('stock')}
            // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
            // sticky within the docked tree panel, PANEL-INTERNAL in the
            // UI-70 census (not a canvas overlay).
            data-ui78-sanctioned=""
          >
            <Box size={11} /><span>{shellText('DesignTree.stock2')}</span>
            <span className="tree-section-header-chevron">
              {stockExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            {/* Auto and fixed stocks COEXIST, so both add buttons always show
                (independent of the AUTO/FIXED default-box mode toggle below). */}
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.addNamedAutoStockSizesToItsMemberParts')}
              data-testid="stock-add-auto"
              onClick={(e) => { e.stopPropagation(); handleAddAutoStock() }}
            >
              <Plus size={10} /><span className="tree-section-add-label">{shellText('DesignTree.auto')}</span>
            </button>
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.addFixedStockBlock')}
              data-testid="stock-add-fixed"
              onClick={(e) => { e.stopPropagation(); handleAddFixedStock() }}
            >
              <Plus size={10} /><span className="tree-section-add-label">{shellText('DesignTree.fixed')}</span>
            </button>
          </div>

          {stockExpanded && (
            <div className="stock-settings">
              {/* Auto and fixed stocks COEXIST and ALWAYS render together (no
                  AUTO/FIXED mode gating). A project always has >=1 default auto
                  stock, so the auto list is never empty. Per-part offsets live on
                  each node; per-block W/H/D live on each FixedStockNode. */}

              {/* Named AUTO stocks (member-derived). */}
              {(sceneStock.autoStocks ?? []).length > 0 && (
                <div className="fixed-stock-list" data-testid="auto-stock-list">
                  {(sceneStock.autoStocks ?? []).map((as) => (
                    <AutoStockNode
                      key={as.id}
                      stock={as}
                      geometry={project.geometry}
                      allStocks={project.stocks}
                      selected={viewer.selectedStockId === as.id}
                      expanded={expandedStocks.has(as.id)}
                      onSelect={() => setSelectedStock(as.id)}
                      onToggleExpanded={() => toggleStockExpanded(as.id)}
                      onUpdate={(u) => handleUpdateAutoStock(as.id, u)}
                      onRemove={() => handleRemoveAutoStock(as.id)}
                      renaming={renameTarget?.kind === 'stock-auto' && renameTarget.id === as.id}
                      onStartRename={() => setRenameTarget({ kind: 'stock-auto', id: as.id })}
                      onCommitRename={(n) => { handleUpdateAutoStock(as.id, { name: n }); setRenameTarget(null) }}
                      onCancelRename={cancelRename}
                      onContextMenu={(e) => openContextMenu(e, { kind: 'stock-auto', stockId: as.id })}
                    />
                  ))}
                </div>
              )}

              {/* Named FIXED stock blocks. */}
              {(sceneStock.fixedStocks ?? []).length > 0 && (
                <div className="fixed-stock-list">
                  {(sceneStock.fixedStocks ?? []).map((fs) => (
                    <FixedStockNode
                      key={fs.id}
                      stock={fs}
                      gizmoActive={viewer.selectedStockId === fs.id}
                      expanded={expandedStocks.has(fs.id)}
                      onToggleExpanded={() => toggleStockExpanded(fs.id)}
                      onUpdate={(u) => handleUpdateFixedStock(fs.id, u)}
                      onRemove={() => handleRemoveFixedStock(fs.id)}
                      renaming={renameTarget?.kind === 'stock-fixed' && renameTarget.id === fs.id}
                      onStartRename={() => setRenameTarget({ kind: 'stock-fixed', id: fs.id })}
                      onCommitRename={(n) => { handleUpdateFixedStock(fs.id, { name: n }); setRenameTarget(null) }}
                      onCancelRename={cancelRename}
                      // Both callbacks just TOGGLE the shared owner; the gizmo
                      // lifecycle effect (above) drives the viewport to match.
                      onEnterGizmo={() => setSelectedStock(viewer.selectedStockId === fs.id ? null : fs.id)}
                      onExitGizmo={() => setSelectedStock(null)}
                      onToggleLocked={() => setFixedStockLocked(fs.id, !fs.locked)}
                      onContextMenu={(e) => openContextMenu(e, {
                        kind: 'stock-fixed', stockId: fs.id,
                        gizmoActive: viewer.selectedStockId === fs.id,
                      })}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Geometry (GEO-UNIFY Stage 1: "everything is geometry" -- the
            separate Model Items section is gone; a model item with a body
            shows as its body rows below, an empty one as a placeholder row
            in this SAME list) ─────────────────────────────────────────── */}
        <div className="tree-section" data-testid="geometry-section">
          <div
            className="tree-section-header tree-section-header-btn"
            onClick={() => toggleTreeSection('geometry')}
            // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx).
            data-ui78-sanctioned=""
          >
            <FileBox size={11} /><span>{shellText('DesignTree.geometry')}</span>
            <span className="tree-count">
              {filteredCountLabel(
                geoShown + placeholderShown,
                project.geometry.length + placeholderModelItems.length,
                query,
              )}
            </span>
            <span className="tree-section-header-chevron">
              {geometryExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            {/* Header action order (Operator N1a review): Import, Empty Layer,
                Folder, Nest, New model. */}
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.importGeometrySTLDXFSVGOrAViseClamp')}
              aria-label={shellText('DesignTree.importGeometry')}
              onClick={(e) => { e.stopPropagation(); geoFileInputRef.current?.click() }}
            >
              <Plus size={10} />
            </button>
            {/* New empty layer (Stage 6): an empty Layer2D on its own new
                sketch part (same home a new sketch gets, WO-2189), sketchable
                immediately from the entry chooser / Edit-in-Sketch. Works
                for any project state - no import required. A layer on an
                EXISTING part is that part's own "add layer" button. */}
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.newEmptyLayerSketchable')}
              aria-label={shellText('DesignTree.newEmptyLayer')}
              onClick={(e) => { e.stopPropagation(); createSketchLayer() }}
            >
              <FilePlus2 size={10} />
            </button>
            {/* New folder (Stage B): creates a root folder and drops into rename. */}
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.newFolder2')}
              aria-label={shellText('DesignTree.newFolder2')}
              data-testid="tree-new-folder"
              onClick={(e) => { e.stopPropagation(); handleCreateFolder() }}
            >
              <FolderPlus size={10} />
            </button>
            {/* New nest (N1a): nests now live as folder-like nodes INSIDE this
                Geometry section, so the New Nest launcher moves here too. */}
            <button
              className="tree-section-add-btn"
              data-tooltip={shellText('DesignTree.newNest')}
              data-testid="tree-new-nest-geo"
              aria-label={shellText('DesignTree.newNest')}
              onClick={(e) => { e.stopPropagation(); setNestEditTarget(null); openModal('new-nest') }}
            >
              <LayoutGrid size={10} />
            </button>
            {/* GEO-UNIFY Stage 1 sec 1.1: "New model" joins the Geometry
                header's existing add affordances (same addModelItem() the
                removed Model Items section's own "+" called; testid kept so
                the INT-MODEL-UNIFY suites re-point cheaply). Opens the new
                item's isolated Editing Space immediately, as before. */}
            <button
              className="tree-section-add-btn"
              data-testid="add-model-item-btn"
              data-tooltip={shellText('DesignTree.newModel')}
              aria-label={shellText('DesignTree.newModel')}
              onClick={(e) => { e.stopPropagation(); addModelItem() }}
            >
              <Box size={10} />
            </button>
          </div>

          {/* STEP import progress: the geometry row appears only on MODEL_READY,
              so this is the user's only feedback while the model worker runs. */}
          {brepImportStatus && (
            <div className="tree-empty" data-testid="brep-import-status">
              <Loader2 size={10} className="spin" />{shellText('DesignTree.importing', { value: ' ', fileName: brepImportStatus.fileName, phase: brepImportStatus.phase })}</div>
          )}
          {/* STEP import / reload failure (ADR 0003: visible + named). */}
          {brepImportError && (
            <div
              className="tree-empty"
              data-testid="brep-import-error"
              style={{ color: '#e05252', cursor: 'pointer' }}
              data-tooltip={shellText('DesignTree.clickToDismiss')}
              onClick={() => setBrepImportError(null)}
            >
              <AlertCircle size={10} style={{ flexShrink: 0 }} /> {brepImportError}
            </div>
          )}

          {geometryExpanded && (
            project.geometry.length === 0 && rootFolders.length === 0 && nests.length === 0
              && placeholderModelItems.length === 0 ? (
              <div className="tree-empty">{shellText('DesignTree.importAFileCreateASketchOrStartA')}</div>
            ) : geoShown === 0 && placeholderShown === 0 && rootFolders.length === 0 && nests.length === 0 ? (
              <div className="tree-empty">{shellText('DesignTree.noMatchingGeometry')}</div>
            ) : (<>
            {/* Root folders first (parentId null). v1 shows only root folders;
                the recursive store model + a render keyed by parentId leave the
                door open to nested folders later without a structural rewrite. */}
            {rootFolders.map((folder, i) => renderFolderRow(folder, i, rootFolders.length))}
            {/* Nests (N1a): folder-like nodes grouped with the folders, before the
                root geometry drop-zone. The standalone "Nests" section is gone. */}
            {nests.map((nest, i) => renderNestFolderRow(nest, i, nests.length))}
            {/* Workholding (WO-1573): every marked body, grouped, before the
                root geometry drop-zone (same spot as folders/nests). */}
            {renderWorkholdingGroup()}
            {/* Empty-model placeholder rows at the root (folderId null/undefined —
                GEO-UNIFY Stage 2: folder-contained placeholders render inside their
                folder's own tree-folder-contents, in renderFolderRow above). */}
            {placeholderModelItems
              .filter((item) => (item.folderId ?? null) === null && placeholderVisible(item))
              .map(renderPlaceholderModelRow)}
            {/* Then root geometry (folderId null/undefined), as before. Wrapped in
                a drop zone so dragging a part here re-parents it OUT of any folder. */}
            <div
              className={`tree-folder-root-zone${rootDropActive ? ' tree-folder-drag-over' : ''}`}
              onDragOver={(e) => {
                if (!dragGeoId.current && !dragModelItemId.current) return
                e.preventDefault(); e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (!rootDropActive) setRootDropActive(true)
              }}
              onDragLeave={() => setRootDropActive(false)}
              onDrop={(e) => {
                // GEO-UNIFY Stage 2: a dragged placeholder row re-parents to the
                // root via setModelItemFolderId, same shape as the geo case below.
                if (dragModelItemId.current) {
                  e.preventDefault(); e.stopPropagation()
                  handleDropModelItemIntoFolder(null)
                  return
                }
                if (!dragGeoId.current) return
                e.preventDefault(); e.stopPropagation()
                handleDropGeoIntoFolder(null)
              }}
            >
              {rootGeometry.map((geo) => renderGeoBlock(geo))}
              {rootGeometry.length === 0 && rootFolders.length > 0 && (
                <div className="tree-folder-root-empty">{shellText('DesignTree.dragPartsHereToRemoveThemFromAFolder')}</div>
              )}
            </div>
          </>))}
        </div>

        {/* ── Setups ───────────────────────────────────────────────────── */}
        <div className="tree-section">
          <div
            className="tree-section-header tree-section-header-btn"
            onClick={() => toggleTreeSection('setups')}
            // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx).
            data-ui78-sanctioned=""
          >
            <Wrench size={11} /><span>{shellText('DesignTree.setups')}</span>
            <span className="tree-count">{filteredCountLabel(setupShown, project.setups.length, query)}</span>
            <span className="tree-section-header-chevron">
              {setupsExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            {/* Regenerate all toolpaths — only when there are operations */}
            {project.setups.some(s => s.operations.length > 0) && (
              <button
                className="tree-section-add-btn tree-section-regen-btn"
                onClick={(e) => { e.stopPropagation(); computeAllToolpaths() }}
                data-tooltip={shellText('DesignTree.regenerateAllToolpathsShiftG')}
              >
                <RefreshCw size={10} />
                <span>{shellText('DesignTree.rEGENALL')}</span>
              </button>
            )}
            <button
              className="tree-section-add-btn"
              onClick={(e) => { e.stopPropagation(); openModal('new-setup') }}
              data-tooltip={shellText('DesignTree.addSetup')}
              aria-label={shellText('DesignTree.addSetup')}
            >
              <Plus size={10} />
            </button>
          </div>

          {setupsExpanded && (project.setups.length === 0 ? (
            <div className="tree-empty">{shellText('DesignTree.noSetupsClickToAddOne')}</div>
          ) : setupShown === 0 ? (
            <div className="tree-empty">{shellText('DesignTree.noMatchingSetupsOrOperations')}</div>
          ) : project.setups.map((setup, setupIdx) => {
            if (!(setupVisibility.get(setup.id)?.visible ?? true)) return null
            // A WCS stockId is invalid only when it resolves to NO existing
            // stock. The default auto stock (DERIVED_STOCK_ID) and every named
            // auto stock live in project.stocks (the derived PhysicalStock
            // twins), NOT in sceneStock.fixedStocks — consulting fixedStocks
            // alone falsely flagged every auto-bound setup as dangling. Accept
            // any stockId present in project.stocks OR fixedStocks; a stockId
            // matching neither is a genuine dangling reference and stays flagged.
            const stockInvalid = !!(
              setup.wcs.stockId &&
              !(project.stocks ?? []).some(ps => ps.id === setup.wcs.stockId) &&
              !(sceneStock.fixedStocks ?? []).some(fs => fs.id === setup.wcs.stockId)
            )
            return (
              <div
                key={setup.id}
                className={`tree-setup-drag-wrapper${setupDragOverIdx === setupIdx ? ' tree-setup-drag-over' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.stopPropagation()
                  setupDragFromIdx.current = setupIdx
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  if (setupDragFromIdx.current !== setupIdx) setSetupDragOverIdx(setupIdx)
                }}
                onDragLeave={() => setSetupDragOverIdx(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSetupDragOverIdx(null)
                  const from = setupDragFromIdx.current
                  if (from >= 0 && from !== setupIdx) reorderSetups(from, setupIdx)
                  setupDragFromIdx.current = -1
                }}
                onDragEnd={() => { setSetupDragOverIdx(null); setupDragFromIdx.current = -1 }}
              >
                <SetupNode
                  setup={setup}
                  setupIdx={setupIdx}
                  opVisible={query ? setupVisibility.get(setup.id)?.ops : undefined}
                  expanded={expandedSetups.has(setup.id)}
                  active={project.activeSetupId === setup.id}
                  activeOpId={project.activeOperationId}
                  stockInvalid={stockInvalid}
                  wcsLabel={resolvedWcsLabels.get(setup.id) ?? setup.wcs.label}
                  geometry={project.geometry}
                  nests={project.nests ?? []}
                  rapidRate={project.machine.rapidRate}
                  cutTimeMotion={cutTimeMotion}
                  onToggle={() => toggleSetup(setup.id)}
                  onActivate={() => handleActivateSetup(setup.id)}
                  onActivateOp={(opId) => handleActivateOp(setup.id, opId)}
                  onEditSetup={() => openEditSetup(setup.id)}
                  onRemoveSetup={() => removeSetup(setup.id)}
                  onRemoveOp={(opId) => removeOperation(setup.id, opId)}
                  onEditOp={(opId) => openEditOperation(setup.id, opId)}
                  onDuplicateOp={(opId) => duplicateOperation(setup.id, opId)}
                  onComputeOp={(opId) => { handleActivateOp(setup.id, opId); computeOperationToolpath(setup.id, opId) }}
                  onNewOp={() => { setActiveSetup(setup.id); openModal('new-operation') }}
                  onNewOpFolder={() => {
                    const id = addOperationFolder(
                      setup.id,
                      shellText('DesignTree.operationFolder', { value: (setup.operationFolders?.length ?? 0) + 1 }),
                    )
                    setRenameTarget({ kind: 'op-folder', setupId: setup.id, folderId: id })
                  }}
                  onRemoveOpFolder={(folderId) => removeOperationFolder(setup.id, folderId)}
                  onSetOpFolderId={(opId, folderId) => setOperationFolderId(setup.id, opId, folderId)}
                  onSetOpFolderEnabled={(folderId, enabled) =>
                    setOperationFolderEnabled(setup.id, folderId, enabled)}
                  isOpFolderCollapsed={isOperationFolderCollapsed}
                  onToggleOpFolder={toggleOperationFolderCollapsed}
                  onToggleOpEnabled={(opId, enabled) => updateOperation(setup.id, opId, { enabled })}
                  onReorderOp={(fromIdx, toIdx) => reorderOperations(setup.id, fromIdx, toIdx)}
                  onSetupContextMenu={(e) => openContextMenu(e, { kind: 'setup', setupId: setup.id })}
                  onOpContextMenu={(e, opId, idx, opCount, status, enabled) => openContextMenu(e, {
                    kind: 'op', setupId: setup.id, opId, index: idx, count: opCount, status, enabled,
                  })}
                  onOpFolderContextMenu={(e, folderId, enableState, hasOperations) => openContextMenu(e, {
                    kind: 'op-folder', setupId: setup.id, folderId, enableState, hasOperations,
                  })}
                  statusIcon={statusIcon}
                  opStatusTooltip={opStatusTooltip}
                  reachShortfallBadge={reachShortfallBadge}
                  opTypeLabel={opTypeLabel}
                  renamingSetup={renameTarget?.kind === 'setup' && renameTarget.id === setup.id}
                  renamingOpId={renameTarget?.kind === 'op' && renameTarget.setupId === setup.id
                    ? renameTarget.opId : null}
                  renamingOpFolderId={
                    renameTarget?.kind === 'op-folder' && renameTarget.setupId === setup.id
                      ? renameTarget.folderId
                      : null
                  }
                  onStartRenameSetup={() => setRenameTarget({ kind: 'setup', id: setup.id })}
                  onCommitRenameSetup={(n) => { updateSetup(setup.id, { name: n }); setRenameTarget(null) }}
                  onCommitRenameOp={(opId, n) => { updateOperation(setup.id, opId, { name: n }); setRenameTarget(null) }}
                  onStartRenameOpFolder={(folderId) =>
                    setRenameTarget({ kind: 'op-folder', setupId: setup.id, folderId })}
                  onCommitRenameOpFolder={(folderId, name) => {
                    renameOperationFolder(setup.id, folderId, name)
                    setRenameTarget(null)
                  }}
                  onCancelRename={cancelRename}
                  selectedOpFolderId={
                    viewer.selectedFolderKind === 'operation' &&
                    viewer.selectedFolderSetupId === setup.id
                      ? viewer.selectedFolderId
                      : null
                  }
                  onSelectOpFolder={(folderId) => setSelectedFolder(folderId, 'operation', setup.id)}
                />
              </div>
            )
          }))}
        </div>

      </div>

      {/* ── Arc/Line optimization confirmation dialog ─────────────────────── */}
      {pendingOptimization && (
        <div className="opt-preview-overlay">
          <div className="opt-preview-dialog">
            <div className="opt-preview-title">{shellText('DesignTree.optimizationPreview')}</div>
            <div className="opt-preview-legend">
              <span className="opt-legend-dot" style={{ background: '#4488ff' }} />{shellText('DesignTree.before')}<span className="opt-legend-dot" style={{ background: '#ff8800' }} />{shellText('DesignTree.after')}</div>
            {/* B20: Before/After A/B toggle. One set shows at a time (no
                overdraw); node markers make the cleanup visible. */}
            <div className="opt-preview-toggle" role="group" aria-label={shellText('DesignTree.previewWhichLoopSet')}>
              <button
                className={`opt-toggle-btn${optPreviewSet === 'before' ? ' opt-toggle-btn-active' : ''}`}
                data-testid="opt-preview-before"
                onClick={() => handleSetOptPreview('before')}
              >{shellText('DesignTree.before2')}</button>
              <button
                className={`opt-toggle-btn${optPreviewSet === 'after' ? ' opt-toggle-btn-active' : ''}`}
                data-testid="opt-preview-after"
                onClick={() => handleSetOptPreview('after')}
              >{shellText('DesignTree.after2')}</button>
            </div>
            <div className="opt-preview-hint">{shellText('DesignTree.previewShownInViewportToggleBeforeAfterToCompare')}</div>
            <div className="opt-preview-actions">
              <button className="opt-btn-confirm" onClick={handleConfirmOptimization}>{shellText('DesignTree.apply')}</button>
              <button className="opt-btn-cancel" onClick={handleCancelOptimization}>{shellText('DesignTree.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 7 (7.2): right-click context menu for the targeted tree item. */}
      {contextMenu && (
        <TreeContextMenu
          at={contextMenu.at}
          target={contextMenu.target}
          onAction={(action) => dispatchContextAction(action, contextMenu.target)}
          onExport={exportRowFor(contextMenu.target)}
          onClose={closeContextMenu}
        />
      )}
    </div>
  )
}

// ── Fixed stock node ───────────────────────────────────────────────────────────
function FixedStockNode({
  stock, gizmoActive, expanded, onToggleExpanded, onUpdate, onRemove, onEnterGizmo, onExitGizmo,
  onToggleLocked,
  renaming, onStartRename, onCommitRename, onCancelRename, onContextMenu,
}: {
  stock: FixedStockItem
  gizmoActive: boolean
  // Controlled by the parent so Expand all / Collapse all / Top level reach
  // each manual stock node (they used to be invisible to those buttons).
  expanded: boolean
  onToggleExpanded: () => void
  onUpdate: (u: Partial<FixedStockItem>) => void
  onRemove: () => void
  onEnterGizmo: () => void
  onExitGizmo: () => void
  // WO-1590 (mating S0): lock/unlock this stock in place.
  onToggleLocked: () => void
  // P2: rename state lifted to DesignTree's single rename target so F2 and the
  // shared mechanism reach stock rows too. Commit goes through the parent's
  // handleUpdateFixedStock (store update + viewport stock rebuild).
  renaming: boolean
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  // NAV-MENUS: right-click menu mirroring this row's own gizmo/rename/remove
  // affordances (buildTreeContextMenu 'stock-fixed').
  onContextMenu: (e: React.MouseEvent) => void
}) {
  useText('app-shell-settings-menus')
  return (
    <div className={`fixed-stock-node${gizmoActive ? ' fixed-stock-node-gizmo' : ''}`}>
      <div
        className="fixed-stock-header"
        onClick={() => { if (!renaming) onToggleExpanded() }}
        onContextMenu={onContextMenu}
      >
        <span className="tree-chevron">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <Box size={10} />
        <TreeRenameLabel
          name={stock.name}
          editing={renaming}
          className="fixed-stock-name"
          testId="tree-name-stock-fixed"
          tooltip={shellText('DesignTree.doubleClickToRename')}
          onStart={onStartRename}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
        <button
          data-testid="fixed-stock-gizmo-btn"
          className={`tree-icon-btn${gizmoActive ? ' tree-icon-btn-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); gizmoActive ? onExitGizmo() : onEnterGizmo() }}
          data-tooltip={gizmoActive ? shellText('DesignTree.exitGizmo') : shellText('DesignTree.moveWithGizmo')}
          aria-label={gizmoActive ? shellText('DesignTree.exitGizmo') : shellText('DesignTree.moveWithGizmo')}
        ><Move3d size={9} /></button>
        {/* WO-1590 (mating S0): inline Lock/Unlock, mirrors the geometry row's
            own padlock button. A locked stock refuses the gizmo (the effect
            above) and any typed position edit (updateFixedStock, store). */}
        <button
          data-testid="fixed-stock-lock-btn"
          className="tree-icon-btn"
          onClick={(e) => { e.stopPropagation(); onToggleLocked() }}
          data-tooltip={stock.locked ? shellText('DesignTree.unlock') : shellText('DesignTree.lockInPlace')}
          aria-label={stock.locked ? shellText('DesignTree.unlock') : shellText('DesignTree.lockInPlace')}
        >{stock.locked ? <Lock size={9} /> : <Unlock size={9} />}</button>
        <button
          className="tree-icon-btn tree-icon-btn-danger"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          data-tooltip={shellText('DesignTree.removeStockBlock')}
          aria-label={shellText('DesignTree.removeStockBlock')}
        ><Trash2 size={9} /></button>
      </div>
      {/* Fixed-stock W/H/D + position stay editable IN THE TREE (expand the
          node) AND in the Properties panel when the stock is selected -- two
          locations, same numbers (per Operator). The tree still defaults to compact
          density + collapsed stock nodes; expanding shows these fields. */}
      {expanded && (
        <div className="fixed-stock-fields">
          <StockField label={shellText('DesignTree.widthX')}  unit="mm" value={stock.width}      min={1}     step={1} onChange={(v) => onUpdate({ width: v })} />
          <StockField label={shellText('DesignTree.heightY')} unit="mm" value={stock.height}     min={1}     step={1} onChange={(v) => onUpdate({ height: v })} />
          <StockField label={shellText('DesignTree.depthZ')}  unit="mm" value={stock.depth}      min={1}     step={1} onChange={(v) => onUpdate({ depth: v })} />
          <StockField label={shellText('DesignTree.posX')}      unit="mm" value={stock.position.x} min={-9999} step={1} onChange={(v) => onUpdate({ position: { ...stock.position, x: v } })} />
          <StockField label={shellText('DesignTree.posY')}      unit="mm" value={stock.position.y} min={-9999} step={1} onChange={(v) => onUpdate({ position: { ...stock.position, y: v } })} />
          <StockField label={shellText('DesignTree.posZ')}      unit="mm" value={stock.position.z} min={-9999} step={1} onChange={(v) => onUpdate({ position: { ...stock.position, z: v } })} />
        </div>
      )}
    </div>
  )
}

// ── Auto stock node ──────────────────────────────────────────────────────────
// Mirrors FixedStockNode but for a NAMED auto stock: it has no W/H/D/position
// (its box is DERIVED from its member parts), so the expanded body is the two
// offset fields plus a member PART-PICKER (the NestModal pattern): one checkbox
// per project geometry, checked when geo.stockId === this auto stock's id.
function AutoStockNode({
  stock, geometry, allStocks, selected, expanded, onSelect, onToggleExpanded, onUpdate, onRemove,
  renaming, onStartRename, onCommitRename, onCancelRename, onContextMenu,
}: {
  stock: AutoStockItem
  geometry: ReadonlyArray<ImportedGeometry>
  // AUTOSTOCK-MODEL-FAIL: the full PhysicalStock list, so the member list can
  // fold catch-all model rows via the shared derivedStockMembers resolver.
  allStocks: ReadonlyArray<PhysicalStock> | undefined
  selected: boolean
  expanded: boolean
  onSelect: () => void
  onToggleExpanded: () => void
  onUpdate: (u: Partial<Omit<AutoStockItem, 'id'>>) => void
  onRemove: () => void
  // P2: rename state lifted to DesignTree's single rename target (see
  // FixedStockNode). Commit goes through handleUpdateAutoStock.
  renaming: boolean
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  // NAV-MENUS: right-click menu mirroring this row's own rename/remove
  // affordances (buildTreeContextMenu 'stock-auto').
  onContextMenu: (e: React.MouseEvent) => void
}) {
  useText('app-shell-settings-menus')
  return (
    <div className="fixed-stock-node" data-testid="auto-stock-node">
      <div
        className={`fixed-stock-header${selected ? ' tree-item-geo-active' : ''}`}
        onClick={() => { if (!renaming) onSelect() }}
        onContextMenu={onContextMenu}
      >
        <span
          className="tree-chevron"
          data-testid="auto-stock-chevron"
          data-tooltip={expanded ? shellText('DesignTree.collapseAutoStock') : shellText('DesignTree.expandAutoStock')}
          onClick={(e) => {
            e.stopPropagation()
            if (!renaming) onToggleExpanded()
          }}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <Wand2 size={10} />
        <TreeRenameLabel
          name={stock.name}
          editing={renaming}
          className="fixed-stock-name"
          testId="tree-name-stock-auto"
          tooltip={shellText('DesignTree.doubleClickToRename')}
          onStart={onStartRename}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
        <button
          className="tree-icon-btn tree-icon-btn-danger"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          data-tooltip={shellText('DesignTree.removeAutoStock')}
          aria-label={shellText('DesignTree.removeAutoStock')}
        ><Trash2 size={9} /></button>
      </div>
      {expanded && (
        <div className="fixed-stock-fields">
          <StockField label={shellText('DesignTree.xYOffset')} unit="mm" value={stock.autoOffsetXY}   min={0} step={1} onChange={(v) => onUpdate({ autoOffsetXY: v })} />
          <StockField label={shellText('DesignTree.zTop')}     unit="mm" value={stock.autoOffsetZTop} min={0} step={1} onChange={(v) => onUpdate({ autoOffsetZTop: v })} />
          <StockField label={shellText('DesignTree.zBottom')}  unit="mm" value={stock.autoOffsetZBottom ?? 0} min={0} step={1} onChange={(v) => onUpdate({ autoOffsetZBottom: v })} />
          {/* READ-ONLY member list. AUTOSTOCK-MODEL-FAIL: uses the SAME shared
              resolver (derivedStockMembers) the rendered box uses, so an
              unassigned model part folded into the catch-all shows here too - the
              tree list, the Properties count and the drawn box never disagree.
              Assignment happens on the Geometry tab (per-part stock dropdown). */}
          {(() => {
            const twin = (allStocks ?? []).find((s) => s.id === stock.id && s.mode === 'derived')
            const members = twin
              ? derivedStockMembers(twin, geometry, allStocks ?? [])
              : geometry.filter((geo) => geo.stockId === stock.id)
            if (members.length === 0) return null
            return (
              <div className="auto-stock-members" data-testid="auto-stock-member-list">
                <div className="auto-stock-members-label">{shellText('DesignTree.memberParts')}</div>
                <div className="nest-part-list">
                  {members.map((geo) => (
                    <div key={geo.id} className="nest-part-row">
                      <span className="nest-part-name" data-tooltip={geo.name}>{geo.name}</span>
                    </div>
                  ))}
                </div>
                <div className="auto-stock-members-empty">{shellText('DesignTree.assignPartsOnTheGeometryTab')}</div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// ── Stock field ────────────────────────────────────────────────────────────────
// All stock fields are dimensioned lengths (mm canonical). ADR-0022: value/onChange
// STILL speak mm; only the displayed string + the user's draft convert when the
// active display unit is inch. The literal `unit` prop is now vestigial — the
// rendered suffix comes from the shim (unitLabel) so it tracks the display unit.
function StockField({ label, value, min, step, onChange }: {
  label: string; unit?: string; value: number; min: number; step: number
  onChange: (v: number) => void
}) {
  useText('app-shell-settings-menus')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  return (
    <div className="stock-field-row">
      <span className="stock-field-label">{label}</span>
      <div className="stock-field-input-wrap">
        <NumericInput
          className="stock-number-input"
          value={value}
          min={min}
          step={step}
          units={displayUnits}
          onChange={(v) => { if (v >= min) onChange(v) }}
        />
        <span className="stock-field-unit">{unitLabel(displayUnits)}</span>
      </div>
    </div>
  )
}

// ── Setup node ─────────────────────────────────────────────────────────────────
interface SetupNodeProps {
  setup: Setup; setupIdx: number; expanded: boolean; active: boolean; activeOpId: string | null
  stockInvalid: boolean
  // BUG-428: nest-aware context for setupEnabledCutTimeMs, so a nest seed op's
  // per-copy estimatedCutTimeMs is expanded via estimateNestCutTimeMs (matching
  // what the nest's own Properties summary shows) instead of summed raw.
  geometry: ImportedGeometry[]
  nests: NestRecord[]
  rapidRate: number
  cutTimeMotion: CutTimeMotion | null
  // WO-1389: the resolved work-offset label (resolveSetupWorkOffset), matching
  // what post/simulation/program context actually use — may differ from
  // setup.wcs.label when a bound stock's fixture offset overrides it.
  wcsLabel: string
  /** When filtering, the set of op ids to show (id -> visible). undefined = show all. */
  opVisible?: Map<string, boolean>
  onToggle: () => void; onActivate: () => void; onActivateOp: (id: string) => void
  onEditSetup: () => void; onRemoveSetup: () => void; onRemoveOp: (id: string) => void
  onEditOp: (id: string) => void; onDuplicateOp: (id: string) => void
  onComputeOp: (id: string) => void; onNewOp: () => void
  onNewOpFolder: () => void
  onRemoveOpFolder: (folderId: string) => void
  onSetOpFolderId: (opId: string, folderId: string | null) => void
  onSetOpFolderEnabled: (folderId: string, enabled: boolean) => void
  isOpFolderCollapsed: (folderId: string) => boolean
  onToggleOpFolder: (folderId: string) => void
  onToggleOpEnabled: (opId: string, enabled: boolean) => void
  onReorderOp: (fromIdx: number, toIdx: number) => void
  onSetupContextMenu: (e: React.MouseEvent) => void
  onOpContextMenu: (
    e: React.MouseEvent,
    opId: string,
    idx: number,
    opCount: number,
    status: string,
    enabled: boolean,
  ) => void
  // NAV-MENUS: right-click menu mirroring the op-folder row's own
  // enable/suppress-all + rename + delete icon buttons (buildTreeContextMenu
  // 'op-folder'). Args mirror what the row already computes for those buttons.
  onOpFolderContextMenu: (
    e: React.MouseEvent,
    folderId: string,
    enableState: 'enabled' | 'suppressed' | 'mixed',
    hasOperations: boolean,
  ) => void
  statusIcon: (op: Operation) => React.ReactNode
  opStatusTooltip: (op: Operation) => string | undefined
  reachShortfallBadge: (op: Operation) => React.ReactNode
  opTypeLabel: (t: Operation['type']) => string
  // P2 inline rename (shared TreeRenameLabel mechanism, state owned by DesignTree).
  // Commits route through updateSetup / updateOperation — the SAME store actions
  // the edit modals use for names.
  renamingSetup: boolean
  renamingOpId: string | null
  renamingOpFolderId: string | null
  onStartRenameSetup: () => void
  onCommitRenameSetup: (name: string) => void
  onCommitRenameOp: (opId: string, name: string) => void
  onStartRenameOpFolder: (folderId: string) => void
  onCommitRenameOpFolder: (folderId: string, name: string) => void
  onCancelRename: () => void
  // PP-UTILITY Stage 3: operation-folder row selection (drives the Properties
  // panel's FolderProperties branch). folderId is scoped to THIS setup — the
  // selection also carries selectedFolderSetupId (op-folder ids are only
  // unique within a setup), so a folder in a DIFFERENT setup never reads as
  // selected here even if the raw id happened to collide.
  selectedOpFolderId: string | null
  onSelectOpFolder: (folderId: string) => void
}

function SetupNode({
  setup, expanded, active, activeOpId, stockInvalid, wcsLabel, opVisible,
  geometry, nests, rapidRate, cutTimeMotion,
  onToggle, onActivate, onActivateOp, onEditSetup, onRemoveSetup,
  onRemoveOp, onEditOp, onDuplicateOp, onComputeOp, onNewOp,
  onNewOpFolder, onRemoveOpFolder, onSetOpFolderId, onSetOpFolderEnabled,
  isOpFolderCollapsed, onToggleOpFolder, onToggleOpEnabled, onReorderOp,
  onSetupContextMenu, onOpContextMenu, onOpFolderContextMenu,
  statusIcon, opStatusTooltip, reachShortfallBadge, opTypeLabel,
  renamingSetup, renamingOpId, renamingOpFolderId,
  onStartRenameSetup, onCommitRenameSetup,
  onCommitRenameOp, onStartRenameOpFolder,
  onCommitRenameOpFolder, onCancelRename,
  selectedOpFolderId, onSelectOpFolder,
}: SetupNodeProps) {
  useText('app-shell-settings-menus')
  const [opDragOverIdx, setOpDragOverIdx] = useState<number | null>(null)
  const [opFolderDropTargetId, setOpFolderDropTargetId] = useState<string | null>(null)
  const [opRootDropActive, setOpRootDropActive] = useState(false)
  const opDragFromIdx = useRef<number>(-1)
  const opDragId = useRef<string | null>(null)
  // WO-2437: machine actions (an operator stop, ...) are rows of the operation
  // list like the operations - drag to move, on/off, rename, click to edit in
  // Properties. Each shows after the operation it runs after.
  const updateMachineAction = useCamStore((s) => s.updateMachineAction)
  const removeMachineAction = useCamStore((s) => s.removeMachineAction)
  const moveSetupListItem = useCamStore((s) => s.moveSetupListItem)
  const [renamingActionId, setRenamingActionId] = useState<string | null>(null)
  const [actionDragOverId, setActionDragOverId] = useState<string | null>(null)
  const actionDragId = useRef<string | null>(null)
  const machineActions = machineActionsOf(setup)
  const listOrder = setupListOrder(setup.operations, machineActions)
  const setupOpIds = new Set(setup.operations.map((op) => op.id))
  const actionsAfter = (opId: string | null) => machineActions.filter((action) => action.afterOpId === opId)
  const orphanActions = machineActions.filter((action) => action.afterOpId !== null && !setupOpIds.has(action.afterOpId))
  // A row dragged down the list lands after the row it is dropped on, a row
  // dragged up lands before it - the way the operations already move.
  const dropBeforeId = (draggedId: string, targetId: string): string | null => {
    const from = listOrder.findIndex((item) => item.id === draggedId)
    const at = listOrder.findIndex((item) => item.id === targetId)
    return from < at ? listOrder[at + 1]?.id ?? null : targetId
  }
  // A dragged action dropped on the row `targetId`; false when the drag is not an action.
  const dropActionOn = (targetId: string): boolean => {
    const draggedId = actionDragId.current
    if (!draggedId) return false
    if (draggedId !== targetId) moveSetupListItem(setup.id, draggedId, dropBeforeId(draggedId, targetId))
    resetOpDrag()
    return true
  }
  const dropOnAction = (actionId: string) => {
    if (dropActionOn(actionId)) return
    const draggedOpId = opDragId.current
    if (draggedOpId) moveSetupListItem(setup.id, draggedOpId, dropBeforeId(draggedOpId, actionId))
    resetOpDrag()
  }
  const renderMachineAction = (action: MachineAction) => (
    <div
      key={action.id}
      draggable
      className={[
        'tree-op',
        activeOpId === action.id ? 'tree-op-active' : '',
        !action.enabled ? 'tree-op-disabled' : '',
        actionDragOverId === action.id ? 'tree-op-drag-over' : '',
      ].filter(Boolean).join(' ')}
      data-testid="tree-machine-action"
      data-action-kind={action.kind}
      onClick={() => onActivateOp(action.id)}
      onDragStart={(e) => {
        e.stopPropagation()
        actionDragId.current = action.id
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (actionDragId.current !== action.id) setActionDragOverId(action.id)
      }}
      onDragLeave={() => setActionDragOverId(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setActionDragOverId(null)
        dropOnAction(action.id)
      }}
      onDragEnd={() => { setActionDragOverId(null); resetOpDrag() }}
    >
      <span className="tree-op-drag-handle" data-tooltip="Drag to reorder">⠿</span>
      <span className="tree-op-num"><Hand size={10} /></span>
      <button
        className={`tree-icon-btn tree-op-enable-btn${action.enabled ? ' tree-icon-btn-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); updateMachineAction(setup.id, action.id, { enabled: !action.enabled }) }}
        data-tooltip={action.enabled ? 'Suppress operation (skipped by post)' : 'Unsuppress operation'}
        aria-label={action.enabled ? 'Suppress operation' : 'Unsuppress operation'}
      >
        {action.enabled ? <Power size={10} /> : <PowerOff size={10} />}
      </button>
      <TreeRenameLabel
        name={action.name || machineActionLabel(action.kind)}
        editing={renamingActionId === action.id}
        className="tree-op-label"
        testId="tree-name-machine-action"
        onStart={() => setRenamingActionId(action.id)}
        onCommit={(name) => { updateMachineAction(setup.id, action.id, { name }); setRenamingActionId(null) }}
        onCancel={() => setRenamingActionId(null)}
      />
      <div className="tree-op-actions">
        <button className="tree-icon-btn tree-icon-btn-danger" onClick={(e) => { e.stopPropagation(); removeMachineAction(setup.id, action.id) }} data-tooltip="Delete"
        aria-label="Delete"><Trash2 size={10} /></button>
      </div>
    </div>
  )
  const renderActionsAfter = (opId: string) => actionsAfter(opId).map(renderMachineAction)

  // A refused ready operation poisons the setup total: summing only the other
  // operations would show a plausible but incomplete duration. The compact
  // badge therefore refuses before considering the otherwise-valid sum.
  const setupCutTimeError = setup.operations.find(
    (op) => op.enabled && op.status === 'ready' && op.estimatedCutTimeMsError,
  )?.estimatedCutTimeMsError
  const setupCutMs = setupEnabledCutTimeMs(
    setup.operations, { geometry, nests, rapidRate, motion: cutTimeMotion },
  )
  // setup.operations is every operation in the setup regardless of which
  // folder (if any) holds it, so this already covers folders nested under it.
  const rollupTier: RollupTier = expanded
    ? null
    : setup.operations.reduce<RollupTier>((worst, op) => worseRollupTier(worst, operationRollupTier(op)), null)

  const opRows = setup.operations.map((op, idx) => ({ op, idx }))
  const visibleOpRows = (rows: Array<{ op: Operation; idx: number }>) =>
    opVisible ? rows.filter(({ op }) => opVisible.get(op.id) ?? false) : rows
  // CAM-12-R3 census fix: a malformed persisted operationFolders (present but
  // not actually an array -- a hand-edited/corrupted file) previously reached
  // `.filter` unguarded here and threw; `?? []` only substitutes for null/
  // undefined, not a wrong-typed truthy value.
  const opFolders = Array.isArray(setup.operationFolders) ? setup.operationFolders : []
  const rootFolders = opFolders.filter((folder) => folder.parentId == null)
  const rowsForFolder = (folderId: string | null) =>
    visibleOpRows(opRows.filter(({ op }) => (op.folderId ?? null) === folderId))
  const resetOpDrag = () => {
    setOpDragOverIdx(null)
    setOpFolderDropTargetId(null)
    setOpRootDropActive(false)
    opDragFromIdx.current = -1
    opDragId.current = null
    actionDragId.current = null
  }

  const dropDraggedIntoFolder = (folderId: string | null) => {
    const draggedId = opDragId.current
    if (draggedId) onSetOpFolderId(draggedId, folderId)
    resetOpDrag()
  }

  // Operation rows use double-click for their primary action: opening the
  // operation editor. Keep inline buttons and an active rename input isolated
  // from that row gesture; rename itself remains on F2 and the context menu.
  const handleOperationDoubleClick = (e: React.MouseEvent, opId: string) => {
    if ((e.target as HTMLElement).closest('button, input')) return
    onEditOp(opId)
  }

  const renderOperationRow = (op: Operation, idx: number, folderId: string | null) => (
    <Fragment key={op.id}>
    <div
      draggable
      className={[
        'tree-op',
        activeOpId === op.id ? 'tree-op-active' : '',
        !op.enabled ? 'tree-op-disabled' : '',
        opDragOverIdx === idx ? 'tree-op-drag-over' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onActivateOp(op.id)}
      onDoubleClick={(e) => handleOperationDoubleClick(e, op.id)}
      onContextMenu={(e) =>
        onOpContextMenu(e, op.id, idx, setup.operations.length, op.status, op.enabled)}
      onDragStart={(e) => {
        e.stopPropagation()
        opDragFromIdx.current = idx
        opDragId.current = op.id
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (opDragFromIdx.current !== idx) setOpDragOverIdx(idx)
      }}
      onDragLeave={() => setOpDragOverIdx(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (dropActionOn(op.id)) return
        const from = opDragFromIdx.current
        const draggedId = opDragId.current
        if (draggedId) onSetOpFolderId(draggedId, folderId)
        if (from >= 0 && from !== idx) onReorderOp(from, idx)
        resetOpDrag()
      }}
      onDragEnd={resetOpDrag}
    >
      <span className="tree-op-drag-handle" data-tooltip={shellText('DesignTree.dragToReorderOrMoveToFolder')}>::</span>
      <span className="tree-op-num">{idx + 1}</span>
      <button
        className={`tree-icon-btn tree-op-enable-btn${op.enabled ? ' tree-icon-btn-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleOpEnabled(op.id, !op.enabled) }}
        data-tooltip={op.enabled
          ? shellText('DesignTree.suppressOperationSkippedByRegenAllPostAndSimulation')
          : shellText('DesignTree.unsuppressOperation')}
        aria-label={op.enabled ? shellText('DesignTree.suppressOperation') : shellText('DesignTree.unsuppressOperation')}
      >
        {op.enabled ? <Power size={10} /> : <PowerOff size={10} />}
      </button>
      <span className="tree-op-status" data-tooltip={opStatusTooltip(op)}>{statusIcon(op)}</span>
      {reachShortfallBadge(op)}
      <TreeRenameLabel
        name={op.name || opTypeLabel(op.type)}
        editing={renamingOpId === op.id}
        className="tree-op-label"
        testId="tree-name-op"
        tooltip={shellText('DesignTree.doubleClickToEditOperation')}
        onStart={() => onEditOp(op.id)}
        onCommit={(name) => onCommitRenameOp(op.id, name)}
        onCancel={onCancelRename}
      />
      <div className="tree-op-actions">
        <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onEditOp(op.id) }} data-tooltip={shellText('DesignTree.editOperation')}
        aria-label={shellText('DesignTree.editOperation')}><Settings2 size={10} /></button>
        <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onDuplicateOp(op.id) }} data-tooltip={shellText('DesignTree.duplicateOperation')}
        aria-label={shellText('DesignTree.duplicateOperation')}><Copy size={10} /></button>
        <button
          className="tree-icon-btn tree-icon-btn-compute"
          disabled={op.status === 'computing' || !op.enabled}
          onClick={(e) => { e.stopPropagation(); onComputeOp(op.id) }}
          data-tooltip={!op.enabled
            ? shellText('DesignTree.unsuppressOperationBeforeComputing')
            : op.status === 'computing'
              ? shellText('DesignTree.computing3')
              : shellText('DesignTree.computeToolpathG')}
          aria-label={!op.enabled ? shellText('DesignTree.unsuppressOperation') : op.status === 'computing' ? shellText('DesignTree.computing3') : shellText('DesignTree.computeToolpath')}
        ><Play size={10} /></button>
        <button className="tree-icon-btn tree-icon-btn-danger" onClick={(e) => { e.stopPropagation(); onRemoveOp(op.id) }} data-tooltip={shellText('DesignTree.delete2')}
        aria-label={shellText('DesignTree.delete2')}><Trash2 size={10} /></button>
      </div>
    </div>
    {renderActionsAfter(op.id)}
    </Fragment>
  )

  const renderOperationFolder = (folder: OperationFolder) => {
    const collapsed = isOpFolderCollapsed(folder.id)
    const rows = rowsForFolder(folder.id)
    const folderIds = collectOperationFolderTreeIds(opFolders, folder.id)
    const folderOps = setup.operations.filter(
      (op) => op.folderId != null && folderIds.has(op.folderId),
    )
    const totalCount = folderOps.length
    const enabledCount = folderOps.filter((op) => op.enabled).length
    const allEnabled = totalCount > 0 && enabledCount === totalCount
    const allDisabled = enabledCount === 0
    const enableState = allEnabled ? 'enabled' : allDisabled ? 'suppressed' : 'mixed'
    // folderOps already walks every nested subfolder (collectOperationFolderTreeIds),
    // so this is the whole hidden subtree, not just direct children.
    const rollupTier: RollupTier = collapsed
      ? folderOps.reduce<RollupTier>((worst, op) => worseRollupTier(worst, operationRollupTier(op)), null)
      : null
    if (opVisible && rows.length === 0) return null
    const dropActive = opFolderDropTargetId === folder.id
    const renaming = renamingOpFolderId === folder.id
    // PP-UTILITY Stage 3: selecting drives FolderProperties, mirroring the
    // geometry-folder row's click-selects / chevron-toggles split above.
    const folderSelected = selectedOpFolderId === folder.id

    return (
      <div key={folder.id} className="tree-folder-block tree-op-folder-block">
        <div
          className={`tree-folder-row tree-op-folder-row${folderSelected ? ' tree-item-geo-active' : ''}${dropActive ? ' tree-folder-drag-over' : ''}`}
          data-testid={`tree-op-folder-row-${folder.id}`}
          onClick={() => { if (!renaming) onSelectOpFolder(folder.id) }}
          onContextMenu={(e) => onOpFolderContextMenu(e, folder.id, enableState, totalCount > 0)}
          onDragOver={(e) => {
            if (opDragFromIdx.current < 0) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setOpFolderDropTargetId(folder.id)
          }}
          onDragLeave={() => setOpFolderDropTargetId(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            dropDraggedIntoFolder(folder.id)
          }}
        >
          <span
            className="tree-folder-chevron"
            onClick={(e) => { e.stopPropagation(); onToggleOpFolder(folder.id) }}
            data-tooltip={collapsed ? shellText('DesignTree.expandFolder') : shellText('DesignTree.collapseFolder')}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          {collapsed
            ? <Folder size={12} className="tree-folder-icon" />
            : <FolderOpen size={12} className="tree-folder-icon" />}
          <TreeRenameLabel
            name={folder.name}
            editing={renaming}
            className="tree-folder-name"
            testId="tree-name-op-folder"
            tooltip={shellText('DesignTree.doubleClickToRenameOperationFolder')}
            onStart={() => onStartRenameOpFolder(folder.id)}
            onCommit={(name) => onCommitRenameOpFolder(folder.id, name)}
            onCancel={onCancelRename}
          />
          <span className="tree-folder-count">{totalCount}</span>
          <span className="tree-folder-actions">
            <button
              className={[
                'tree-icon-btn',
                'tree-op-enable-btn',
                allEnabled ? 'tree-icon-btn-active' : '',
                enableState === 'mixed' ? 'tree-op-enable-mixed' : '',
              ].filter(Boolean).join(' ')}
              disabled={totalCount === 0}
              onClick={(e) => {
                e.stopPropagation()
                onSetOpFolderEnabled(folder.id, !allEnabled)
              }}
              data-tooltip={totalCount === 0
                ? shellText('DesignTree.folderHasNoOperations')
                : allEnabled
                  ? shellText('DesignTree.suppressAllOperationsInThisFolder')
                  : enableState === 'mixed'
                    ? shellText('DesignTree.mixedOfEnabledClickToEnableAll', { enabledCount: enabledCount, totalCount: totalCount })
                    : shellText('DesignTree.enableAllOperationsInThisFolder')}
              aria-label={shellText('DesignTree.operations', { name: folder.name, enableState: enableState })}
              aria-pressed={allEnabled}
              data-enabled-state={enableState}
            >
              {allDisabled ? <PowerOff size={10} /> : <Power size={10} />}
            </button>
            <button
              className="tree-icon-btn"
              onClick={(e) => { e.stopPropagation(); onStartRenameOpFolder(folder.id) }}
              data-tooltip={shellText('DesignTree.renameOperationFolder')}
              aria-label={shellText('DesignTree.renameOperationFolder')}
            ><Pencil size={10} /></button>
            <button
              className="tree-icon-btn tree-icon-btn-danger"
              onClick={(e) => {
                e.stopPropagation()
                onRemoveOpFolder(folder.id)
              }}
              data-tooltip={shellText('DesignTree.deleteFolderAndKeepOperations')}
              aria-label={shellText('DesignTree.deleteFolderAndKeepOperations')}
            ><Trash2 size={10} /></button>
          </span>
          <RollupBadge tier={rollupTier} testId={`tree-rollup-badge-opfolder-${folder.id}`} />
        </div>
        {!collapsed && (
          <div className="tree-folder-contents tree-op-folder-contents">
            {rows.length === 0
              ? <div className="tree-folder-empty">{shellText('DesignTree.emptyDragOperationsHere')}</div>
              : rows.map(({ op, idx }) => renderOperationRow(op, idx, folder.id))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`tree-setup ${active ? 'tree-setup-active' : ''} ${stockInvalid ? 'tree-setup-invalid' : ''}`}>
      <div
        className="tree-setup-header"
        onClick={() => { if (!renamingSetup) { onActivate(); onToggle() } }}
        onContextMenu={onSetupContextMenu}
      >
        <span className="tree-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Wrench size={11} />
        <TreeRenameLabel
          name={setup.name}
          editing={renamingSetup}
          className="tree-setup-name"
          testId="tree-name-setup"
          onStart={onStartRenameSetup}
          onCommit={onCommitRenameSetup}
          onCancel={onCancelRename}
        />
        {stockInvalid && (
          <span data-tooltip={shellText('DesignTree.wCSStockReferenceIsMissingEditSetupToReassign')}>
            <AlertCircle size={11} className="tree-setup-invalid-icon" />
          </span>
        )}
        {setupCutTimeError ? (
          <span
            className="tree-setup-cuttime"
            data-testid="setup-cuttime-unavailable"
            data-tooltip={setupCutTimeError}
          >{shellText('DesignTree.unavailable')}</span>
        ) : setupCutMs > 0 && (
          <span className="tree-setup-cuttime" data-tooltip={shellText('DesignTree.totalEstimatedCutTimeForThisSetup')}>
            {formatDurationHMS(setupCutMs)}
          </span>
        )}
        <span className="tree-setup-meta">{wcsLabel}</span>
        <div className="tree-setup-actions">
          <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onNewOp() }} data-tooltip={shellText('DesignTree.addOperationN')}
          aria-label={shellText('DesignTree.addOperation')}>
            <Plus size={11} />
          </button>
          <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onNewOpFolder() }} data-tooltip={shellText('DesignTree.newOperationFolder')}
          aria-label={shellText('DesignTree.newOperationFolder')}>
            <FolderPlus size={11} />
          </button>
          <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onEditSetup() }} data-tooltip={shellText('DesignTree.editSetup')}
          aria-label={shellText('DesignTree.editSetup')}>
            <Settings2 size={11} />
          </button>
          <button className="tree-icon-btn tree-icon-btn-danger" onClick={(e) => { e.stopPropagation(); onRemoveSetup() }} data-tooltip={shellText('DesignTree.deleteSetup')}
          aria-label={shellText('DesignTree.deleteSetup')}>
            <Trash2 size={11} />
          </button>
        </div>
        <RollupBadge tier={rollupTier} testId={`tree-rollup-badge-setup-${setup.id}`} />
      </div>

      {(expanded || !!opVisible) && (
        <div
          className={`tree-ops tree-op-root-zone${opRootDropActive ? ' tree-folder-drag-over' : ''}`}
          onDragOver={(e) => {
            if (opDragFromIdx.current < 0 || opFolderDropTargetId != null) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setOpRootDropActive(true)
          }}
          onDragLeave={() => setOpRootDropActive(false)}
          onDrop={(e) => {
            e.preventDefault()
            dropDraggedIntoFolder(null)
          }}
        >
          {/* A stop before the first operation runs before every operation,
              folders included, so it shows above them. */}
          {!opVisible && actionsAfter(null).map(renderMachineAction)}
          {rootFolders.map(renderOperationFolder)}
          {setup.operations.length === 0 && rootFolders.length === 0 && machineActions.length === 0 ? (
            <div className="tree-empty tree-ops-empty">
              <button className="btn-ghost-sm" onClick={onNewOp}>
                <Plus size={11} />{shellText('DesignTree.addOperation2')}</button>
            </div>
          ) : setup.operations.map((op, idx) => {
            if (opVisible && !(opVisible.get(op.id) ?? false)) return null
            if (op.folderId != null) return null
            return (
            <Fragment key={op.id}>
            <div
              draggable
              className={[
                'tree-op',
                activeOpId === op.id ? 'tree-op-active' : '',
                !op.enabled       ? 'tree-op-disabled' : '',
                opDragOverIdx === idx ? 'tree-op-drag-over' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onActivateOp(op.id)}
              onDoubleClick={(e) => handleOperationDoubleClick(e, op.id)}
              onContextMenu={(e) =>
                onOpContextMenu(e, op.id, idx, setup.operations.length, op.status, op.enabled)}
              onDragStart={(e) => {
                e.stopPropagation()
                opDragFromIdx.current = idx
                opDragId.current = op.id
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (opDragFromIdx.current !== idx) setOpDragOverIdx(idx)
              }}
              onDragLeave={() => setOpDragOverIdx(null)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (dropActionOn(op.id)) return
                const from = opDragFromIdx.current
                const draggedId = opDragId.current
                if (draggedId) onSetOpFolderId(draggedId, null)
                if (from >= 0 && from !== idx) onReorderOp(from, idx)
                resetOpDrag()
              }}
              onDragEnd={resetOpDrag}
            >
              <span className="tree-op-drag-handle" data-tooltip={shellText('DesignTree.dragToReorder')}>⠿</span>
              <span className="tree-op-num">{idx + 1}</span>
              <button
                className={`tree-icon-btn tree-op-enable-btn${op.enabled ? ' tree-icon-btn-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleOpEnabled(op.id, !op.enabled) }}
                data-tooltip={op.enabled
                  ? shellText('DesignTree.suppressOperationSkippedByRegenAllPostAndSimulation')
                  : shellText('DesignTree.unsuppressOperation')}
                aria-label={op.enabled ? shellText('DesignTree.suppressOperation') : shellText('DesignTree.unsuppressOperation')}
              >
                {op.enabled ? <Power size={10} /> : <PowerOff size={10} />}
              </button>
              <span className="tree-op-status" data-tooltip={opStatusTooltip(op)}>{statusIcon(op)}</span>
              {reachShortfallBadge(op)}
              <TreeRenameLabel
                name={op.name || opTypeLabel(op.type)}
                editing={renamingOpId === op.id}
                className="tree-op-label"
                testId="tree-name-op"
                tooltip={shellText('DesignTree.doubleClickToEditOperation')}
                onStart={() => onEditOp(op.id)}
                onCommit={(n) => onCommitRenameOp(op.id, n)}
                onCancel={onCancelRename}
              />
              <div className="tree-op-actions">
                <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onEditOp(op.id) }} data-tooltip={shellText('DesignTree.editOperation')}
                aria-label={shellText('DesignTree.editOperation')}><Settings2 size={10} /></button>
                <button className="tree-icon-btn" onClick={(e) => { e.stopPropagation(); onDuplicateOp(op.id) }} data-tooltip={shellText('DesignTree.duplicateOperation')}
                aria-label={shellText('DesignTree.duplicateOperation')}><Copy size={10} /></button>
                <button
                  className="tree-icon-btn tree-icon-btn-compute"
                  disabled={op.status === 'computing' || !op.enabled}
                  onClick={(e) => { e.stopPropagation(); onComputeOp(op.id) }}
                  data-tooltip={op.status === 'computing' ? shellText('DesignTree.computing4') : shellText('DesignTree.computeToolpathG')}
                  aria-label={op.status === 'computing' ? shellText('DesignTree.computing4') : shellText('DesignTree.computeToolpath')}
                ><Play size={10} /></button>
                <button className="tree-icon-btn tree-icon-btn-danger" onClick={(e) => { e.stopPropagation(); onRemoveOp(op.id) }} data-tooltip={shellText('DesignTree.delete2')}
                aria-label={shellText('DesignTree.delete2')}><Trash2 size={10} /></button>
              </div>
            </div>
            {renderActionsAfter(op.id)}
            </Fragment>
            )
          })}
          {!opVisible && orphanActions.map(renderMachineAction)}
        </div>
      )}
    </div>
  )
}

// Presentation only: opTypeLabelRaw continues to feed the existing filter.
function operationTypeText(type: Operation["type"]): string {
  switch (type) {
    case 'face': return shellText('OperationTypes.face')
    case 'contour_2d': return shellText('OperationTypes.contour_2d')
    case 'pocket_2d': return shellText('OperationTypes.pocket_2d')
    case 'adaptive_clearing_2d': return shellText('OperationTypes.adaptive_clearing_2d')
    case 'drill': return shellText('OperationTypes.drill')
    case 'bore': return shellText('OperationTypes.bore')
    case 'thread_mill': return shellText('OperationTypes.thread_mill')
    case 'engrave': return shellText('OperationTypes.engrave')
    case 'vcarve': return shellText('OperationTypes.vcarve')
    case 'chamfer': return shellText('OperationTypes.chamfer')
    case 'parallel_3d': return shellText('OperationTypes.parallel_3d')
    case 'waterline_3d': return shellText('OperationTypes.waterline_3d')
    case 'adaptive_3d': return shellText('OperationTypes.adaptive_3d')
    case 'scallop_3d': return shellText('OperationTypes.scallop_3d')
    case 'steep_shallow_3d': return shellText('OperationTypes.steep_shallow_3d')
    case 'pencil_3d': return shellText('OperationTypes.pencil_3d')
  }
}

function booleanOperationText(operation: "difference" | "union" | "intersect"): string {
  switch (operation) {
    case 'difference': return shellText('BooleanOperations.difference')
    case 'union': return shellText('BooleanOperations.union')
    case 'intersect': return shellText('BooleanOperations.intersect')
  }
}
