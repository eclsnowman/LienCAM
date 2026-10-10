import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
import { Fragment, useState, useEffect, useCallback, useMemo, useLayoutEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { X, MapPin, Keyboard, Move3d, Crosshair, Target, CircleDot, Loader2 } from 'lucide-react'
import {
  useCamStore, resolveSetupBoreOriginPick, resolveSetupCircleOriginPick, describeOriginSource,
  type OriginSourceStatus,
} from '../../store'
import { NumericInput } from '../ui/NumericInput'
import { fmtDim, unitLabel } from '../../lib/ui/unitFormat'
import type { FeatureRef, HeightIntentV1, HeightPlaneName, WCS, Setup, Vec3, Stock, OriginBinding, Project, ImportedGeometry } from '../../types'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { resolveOwningModelItemId } from '../../lib/cam/modelOrigin'
import { readModelBodyFaceFacts } from '../../lib/cam/modelBodyHoleRecognition'
import { ensureDocumentArchiveHydrated, DocumentHydrationFailedError } from '../../doc/documentHolder'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { ResizableSplit } from '../common/ResizableSplit'
import { PanelCollapseToggle, usePanelCollapsed } from '../common/CollapsiblePanel'
import { useUiPrefs, resolveUiScale } from '../../store/uiPrefs'

// WO-2435: the two panes sit in the shared resizable split. The work offset
// pane (second) carries the stored width; its default is the width the old
// 0.92fr / 1.08fr grid gave it in the 780px dialog. Its 350px minimum is the
// old grid's minmax(350px, ...) - the origin controls clip below that.
const SETUP_WCS_COLLAPSE_KEY = 'setupModal.wcsPane'
const SETUP_WCS_DEFAULT_PX = 390
const SETUP_WCS_MIN_PX = 350
const SETUP_WCS_MAX_PX = 560
const SETUP_BASICS_MIN_PX = 300
// Dialog width (unscaled) that holds both minimums, the bar and the dialog padding.
const SETUP_SPLIT_FIT_PX = 700
// app.css folds the dialog to one column at this width.
const NARROW_VIEWPORT_PX = 760
// The stylesheet is outside this work order's owned paths, so the pane header
// is styled inline (same recipe as .panel-title).
const PANE_HEADER_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
const PANE_TITLE_STYLE: CSSProperties = {
  flex: 1, fontSize: 'var(--font-size-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-caps)',
  textTransform: 'uppercase', color: 'var(--text-secondary)',
}
const PANE_SUMMARY_STYLE: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }

// WO-362 audit fix: the "genuinely cannot recover" branch's stated way
// forward. `DocumentHydrationFailedError` carries this module's internal
// vocabulary in its own `.message` ("durable checkpoint", a raw Model Item
// id) - useful in a console.error, useless (worse: confusing) shown raw to
// Operator, whose whole complaint was "if I am doing something wrong it is not
// intuitive what is wrong." Re-opening the project file is the one action
// that is actually true here: `loadProjectFromFile` decodes the file's own
// inline `document` blob directly (proven by this WO's first test describe
// block), bypassing the durable checkpoint this failure means could not be
// read - so it recovers even when the checkpoint genuinely cannot.
const DOCUMENT_HYDRATION_FAILED_MESSAGE = 'SetupModal.documentHydrationFailed' as const
import { deriveModelBodyCircularOrigin } from '../../lib/cam/modelBodyDerive'
import { effectiveStockIdForCompute, pickDefaultSetupStock, stockWorldBounds } from '../../store/stockAssignment'
import { conflictingWorkOffsetClaim, FIXTURE_OFFSETS, isFixtureOffset,
  setupOwnsFixtureOffset, usedFixtureOffsetsForStock, wcsBoundStockId,
  wcsStockCornerBinding } from '../../lib/post/workOffsets'
import {
  planSecondSideSetup,
  type FlipAxis,
  type SecondSidePlan,
  type SecondSideRefusal,
} from '../../lib/cam/flipSetup'
import {
  cloneHeightIntent,
  defaultHeightIntent,
  heightParamsFromSetupIntent,
  refreshSetupOwnedSmartHeightSafety,
  sameHeightIntent,
  setupDefaultHeightIntent,
} from '../../lib/cam/heightIntent'
import {
  resolveSetupSupportPlane,
  setupFixtureStack,
  setupSupportPlane,
  type FixtureStackItem,
  type FixtureStackItemType,
  type SetupSupportPlaneMode,
} from '../../lib/cam/types'

/** Resolve the stock already assigned to the model geometry used by a
 * circular-feature origin. This uses the same ownership resolver as CAM
 * compute, including nest seeds and the derived-stock model-body rule. */
export function resolveSetupFeatureStockId(project: Project, geoId: string): string | null {
  const geometry = project.geometry.find((candidate) => candidate.id === geoId)
  if (!geometry) return null
  const stockId = effectiveStockIdForCompute(
    geometry,
    project.nests ?? [],
    project.stocks ?? [],
  )
  return stockId && (project.stocks ?? []).some((stock) => stock.id === stockId)
    ? stockId
    : null
}

// WO-337: both ends of a picked bore/boss, so the Top/Bottom toggle is instant
// (no second kernel round trip) - populated only by a LIVE pick this session;
// a restored (edit-mode) binding has no snapshot to derive the other end from,
// so these stay undefined until the user re-picks, and the toggle hides.
type BoreBinding = {
  targetKind: 'cylinder' | 'circle'
  geoId: string
  bodyId: string
  modelItemId: string
  faceStableId?: string
  edgeStableId?: string
  localCenter: Vec3
  diameter: number
  topOrigin?: Vec3
  bottomOrigin?: Vec3
  topLocalCenter?: Vec3
  bottomLocalCenter?: Vec3
}

type VertexPickResult = { pos: Vec3; geoId?: string; localPt?: Vec3 }
type StockCornerPickResult = {
  stockId: string
  row: 0 | 1 | 2
  col: 0 | 1 | 2
  face: 'top' | 'bottom'
  pos: Vec3
}

type VpHandle = {
  getStockBounds?: (stockId?: string) => { min: Vec3; max: Vec3 } | null
  setWCSOrigin?: (origin: Vec3, label: string) => void
  enterWCSGizmoMode?: (origin: Vec3, onChange: (p: Vec3) => void) => void
  exitWCSGizmoMode?: () => void
  enterVertexPickMode?: (cb: (result: VertexPickResult) => void) => void
  exitVertexPickMode?: () => void
  enterStockCornerPickMode?: (
    cb: (result: StockCornerPickResult) => void,
    allowedStockIds?: readonly string[],
  ) => void
  exitStockCornerPickMode?: () => void
  setBrepPickMode?: (
    kind: 'face' | 'edge' | 'face-or-edge' | null,
    callback?:
      | ((
          sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean; isModelEdge?: boolean },
          nowSelected: boolean
        ) => void)
      | null,
    allowedGeoId?: string | null,
  ) => void
  // WO-337: attached SEPARATELY from setBrepPickMode (not a positional arg on
  // it) - the app's real CNCViewport subclass overrides setBrepPickMode and
  // would silently drop an extra argument there. A distinct method has no
  // override to fall through.
  setBrepPickHoverCallback?: (
    onHover:
      | ((
          sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean; isModelEdge?: boolean } | null,
        ) => void)
      | null,
  ) => void
  /** WO-337: viewport marker for "where the WCS zero will land" - null clears it. */
  setZeroPointPreview?: (origin: Vec3 | null) => void
  /** WO-366: labeled workspace targets; a second click confirms one. */
  setZeroPointChoices?: (
    choices: readonly { id: string; label: string; position: Vec3 }[] | null,
    onSelect?: ((id: string) => void) | null,
  ) => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

// 9 positions on each face (3×3 grid): [row, col, xFrac, yFrac]
// row 0 = back (Y max), row 2 = front (Y min)
// col 0 = left (X min), col 2 = right (X max)
const CORNER_DEFS = [
  { row: 0, col: 0, xF: 0,   yF: 1,   get label() { return words("SetupModal.back_left") }    },
  { row: 0, col: 1, xF: 0.5, yF: 1,   get label() { return words("SetupModal.back_center") }  },
  { row: 0, col: 2, xF: 1,   yF: 1,   get label() { return words("SetupModal.back_right") }   },
  { row: 1, col: 0, xF: 0,   yF: 0.5, get label() { return words("SetupModal.mid_left") }     },
  { row: 1, col: 1, xF: 0.5, yF: 0.5, get label() { return words("SetupModal.center") }       },
  { row: 1, col: 2, xF: 1,   yF: 0.5, get label() { return words("SetupModal.mid_right") }    },
  { row: 2, col: 0, xF: 0,   yF: 0,   get label() { return words("SetupModal.front_left") }   },
  { row: 2, col: 1, xF: 0.5, yF: 0,   get label() { return words("SetupModal.front_center") } },
  { row: 2, col: 2, xF: 1,   yF: 0,   get label() { return words("SetupModal.front_right") }  },
]

function cornerToWorld(
  c: (typeof CORNER_DEFS)[0],
  bounds: { min: Vec3; max: Vec3 },
  face: 'top' | 'bottom'
): Vec3 {
  return {
    x: bounds.min.x + c.xF * (bounds.max.x - bounds.min.x),
    y: bounds.min.y + c.yF * (bounds.max.y - bounds.min.y),
    z: face === 'top' ? bounds.max.z : bounds.min.z,
  }
}

const G_OFFSETS = FIXTURE_OFFSETS

const FLIP_AXES: ReadonlyArray<{ value: FlipAxis; label: string }> = [
  // Short enough to read whole inside the select (the long form truncated).
  { value: 'x', get label() { return words("SetupModal.x_front_and_back_swap") } },
  { value: 'y', get label() { return words("SetupModal.y_left_and_right_swap") } },
]

const FIXTURE_STACK_TYPES: ReadonlyArray<{ value: FixtureStackItemType; label: string }> = [
  { value: 'spoilboard', get label() { return words("SetupModal.spoilboard") } },
  { value: 'vise', get label() { return words("SetupModal.vise") } },
  { value: 'fixed_jaw', get label() { return words("SetupModal.fixed_jaw") } },
  { value: 'soft_jaw', get label() { return words("SetupModal.soft_jaw") } },
  { value: 'custom', get label() { return words("SetupModal.custom_riser") } },
]

const SUPPORT_PLANE_MODES: ReadonlyArray<{ value: SetupSupportPlaneMode; label: string }> = [
  { value: 'machine_table', get label() { return words("SetupModal.machine_table") } },
  { value: 'spoilboard', get label() { return words("SetupModal.spoilboard_top") } },
  { value: 'vise_bed', get label() { return words("SetupModal.vise_bed") } },
  { value: 'fixed_jaw_shelf', get label() { return words("SetupModal.fixed_jaw_shelf") } },
  { value: 'soft_jaw_step', get label() { return words("SetupModal.soft_jaw_step") } },
  { value: 'stock_bottom', get label() { return words("SetupModal.stock_bottom") } },
  { value: 'custom', get label() { return words("SetupModal.custom_plane") } },
]

function fixtureStackItem(type: FixtureStackItemType = 'spoilboard'): FixtureStackItem {
  const label = FIXTURE_STACK_TYPES.find((option) => option.value === type)?.label ?? words("SetupModal.fixture_layer")
  return {
    id: crypto.randomUUID(),
    name: label,
    type,
    height: 0,
    visible: true,
  }
}

const defaultStock = (): Stock => ({
  type: 'rectangular',
  offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0,
  // No material field exists yet; a stock has no material until the user can
  // set one (Operator ruling 2026-08-21: "where are you getting ... wood? I never
  // specified that"). The old 'wood' default leaked into the program card.
  material: '',
})

const MODAL_KEYBOARD_EXCLUSION_SELECTOR = [
  'button',
  'select',
  'option',
  'textarea',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-multiline="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
].join(',')

function isSafeModalEnterTarget(target: EventTarget | null, panel: HTMLElement | null): boolean {
  if (!(target instanceof Element) || panel === null || !panel.contains(target)) return false
  if (target.closest(MODAL_KEYBOARD_EXCLUSION_SELECTOR) !== null) return false

  const input = target.closest('input')
  if (!(input instanceof HTMLInputElement)) return true
  return !input.disabled && [
    'text', 'number', 'search', 'email', 'password', 'tel', 'url',
  ].includes(input.type)
}

/** WO-1427: the origin panel claims only what the store could confirm. */
function originSourceText(status: OriginSourceStatus): string {
  if (status.state === 'unresolved') return words("SetupModal.not_tracking_using_the_last_known_point", { value1: status.reason })
  return status.state === 'tracking'
    ? words("SetupModal.tracking", { value1: status.sourceName })
    : words("SetupModal.fixed_point_on_follows_its_placement_not", { value1: status.sourceName })
}

export function SetupModal() {
  const words = useText('setup-stock-tools-machine-post')
  const activeModal    = useCamStore((s) => s.activeModal)
  const closeModal     = useCamStore((s) => s.closeModal)
  const addSetup       = useCamStore((s) => s.addSetup)
  const updateSetup    = useCamStore((s) => s.updateSetup)
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)
  const editingSetupId = useCamStore((s) => s.editingSetupId)
  const project        = useCamStore((s) => s.project)
  const displayUnits   = useCamStore((s) => s.appSettings.displayUnits)

  const isOpen     = activeModal === 'new-setup' || activeModal === 'edit-setup'
  const isEditMode = activeModal === 'edit-setup'
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // ── Local form state ──────────────────────────────────────────────────────
  const [name,            setName]            = useState<string>(words("SetupModal.setup_1"))
  const [fixture,         setFixture]         = useState<54|55|56|57|58|59>(54)
  const [originMode,      setOriginMode]      = useState<'corner' | 'manual' | 'gizmo' | 'snap' | 'bore'>('corner')
  const [cornerFace,      setCornerFace]      = useState<'top' | 'bottom'>('top')
  const [selCorner,       setSelCorner]       = useState<{ row: number; col: number }>({ row: 2, col: 0 })
  const [origin,          setOrigin]          = useState<Vec3>({ x: 0, y: 0, z: 0 })
  const [stockBounds,     setStockBounds]     = useState<{ min: Vec3; max: Vec3 } | null>(null)
  const [selectedStockId, setSelectedStockId] = useState<string | null>(null)
  const [isPickingStockCorner, setIsPickingStockCorner] = useState(false)
  const [stockPickError, setStockPickError] = useState<string | null>(null)
  const [isPickingVertex, setIsPickingVertex] = useState(false)
  const [snapGeoId,       setSnapGeoId]       = useState<string | undefined>(undefined)
  const [snapLocalPt,     setSnapLocalPt]     = useState<Vec3 | undefined>(undefined)
  // WO-1425: whether a REAL vertex pick has resolved in Snap mode this editing
  // session, tracked independently of `origin` - `origin` is shared, mutable
  // draft state that carries over from whichever mode was active before Snap,
  // so its coordinate values alone are not evidence a Snap pick ever happened.
  const [snapVertexPicked, setSnapVertexPicked] = useState(false)
  // WO-294: a setup origin bound to a picked internal bore wall on a modeled
  // body - X0/Y0 at the bore's axis centre, Z0 at its top rim. Durable
  // identity only; the derived world origin lives in `origin`/snapGeoId/
  // snapLocalPt exactly like the vertex-snap mode, so re-derivation rides
  // the same store mechanism (see store/index.ts applyGeoSnapToSetups).
  const [isPickingBoreFace, setIsPickingBoreFace] = useState(false)
  // True only while a picked face's kernel-mount/face-facts round trip is in
  // flight, so the banner can tell the operator the click registered instead
  // of appearing to do nothing (WO-335 audit).
  const [isBorePickResolving, setIsBorePickResolving] = useState(false)
  const [isChoosingBoreEnd, setIsChoosingBoreEnd] = useState(false)
  const [borePickError,   setBorePickError]   = useState<string | null>(null)
  const [boreBinding,     setBoreBinding]     = useState<BoreBinding | undefined>(undefined)
  // WO-337: which end of the picked bore/boss the origin sits on. Defaults to
  // today's behaviour (top) on every fresh pick - "Do not change the computed
  // origin for the default case" (WO-337).
  const [boreEnd,         setBoreEnd]         = useState<'top' | 'bottom'>('top')
  // WO-1427: the stored binding's "source could not be confirmed" reason,
  // restored on edit and carried through Save until a fresh pick replaces it.
  const [originSourceUnresolved, setOriginSourceUnresolved] = useState<string | undefined>(undefined)
  // True when a NEW setup has >1 geometry-bearing stock and the user has not yet
  // picked one: the picker comes up unselected and Create is blocked until a
  // choice is made (no silent default to the wrong cut stock). Cleared on any
  // stock pick and when editing an existing setup.
  const [mustPickStock,   setMustPickStock]   = useState(false)
  // WO-288: this NEW setup is the second side of an existing one - the same
  // block of material, turned over. Creation only; an existing setup is never
  // edited into a flip, so both live outside the edit-mode restore below.
  const [flipOfSetupId,   setFlipOfSetupId]   = useState<string | null>(null)
  const [flipAxis,        setFlipAxis]        = useState<FlipAxis>('x')
  const [setupHeightIntent, setSetupHeightIntent] = useState<HeightIntentV1>(defaultHeightIntent())
  const [fixtureStack, setFixtureStack] = useState<FixtureStackItem[]>([])
  const [supportPlaneMode, setSupportPlaneMode] = useState<SetupSupportPlaneMode>('machine_table')
  const [supportPlaneOffset, setSupportPlaneOffset] = useState(0)
  const [customPlaneZ, setCustomPlaneZ] = useState(0)

  const wcsCollapsed = usePanelCollapsed(SETUP_WCS_COLLAPSE_KEY)
  const uiScalePreference = useUiPrefs((s) => s.uiScale)
  // The same width/dpr tracking App.tsx uses to set --ui-scale: the dialog and
  // its controls scale with it, so the split's pixel sizes must too.
  const [displayMetrics, setDisplayMetrics] = useState(() => ({
    cssWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    dpr: typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1),
  }))
  const uiScale = resolveUiScale(uiScalePreference, displayMetrics.cssWidth, displayMetrics.dpr)
  // Stack the panes when the dialog (min(780, viewport - 32), all x uiScale)
  // cannot hold both scaled minimums: a scaled minimum never overflows the
  // dialog or crops the work offset controls at an intermediate width.
  const dialogCssWidth = Math.min(780 * uiScale, displayMetrics.cssWidth - 32 * uiScale)
  const narrowViewport = displayMetrics.cssWidth <= NARROW_VIEWPORT_PX
    || dialogCssWidth < SETUP_SPLIT_FIT_PX * uiScale
  // Stacked, the fill pane has no height of its own (the split has no fixed
  // height), so it would collapse to 0 and WCS would cover the basics. Its
  // minimum is the basics content height, measured after layout.
  const basicsRef = useRef<HTMLElement | null>(null)
  const [basicsStackH, setBasicsStackH] = useState(0)
  useLayoutEffect(() => {
    const h = (originMode === 'gizmo' || narrowViewport) ? (basicsRef.current?.scrollHeight ?? 0) : 0
    if (h !== basicsStackH) setBasicsStackH(h)
  })
  useEffect(() => {
    const onResize = () => {
      setDisplayMetrics({ cssWidth: window.innerWidth, dpr: window.devicePixelRatio || 1 })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const boundStockBottomZ = useMemo(() => {
    if ((originMode !== 'corner' && originMode !== 'bore') || !selectedStockId) return undefined
    const stock = (project.stocks ?? []).find((candidate) => candidate.id === selectedStockId)
    return stock ? stockWorldBounds(stock).min.z : undefined
  }, [originMode, project.stocks, selectedStockId])

  const resolvedSupportPlane = useMemo(() => resolveSetupSupportPlane({
    wcs: { label: `G${fixture}`, origin },
    fixtureStack,
    supportPlane: {
      mode: supportPlaneMode,
      offset: supportPlaneOffset,
      ...(supportPlaneMode === 'custom' ? { customZ: customPlaneZ } : {}),
    },
  }, boundStockBottomZ), [
    boundStockBottomZ,
    customPlaneZ,
    fixture,
    fixtureStack,
    origin,
    supportPlaneMode,
    supportPlaneOffset,
  ])

  const fixtureStackError = useMemo(() => {
    if (fixtureStack.some((item) => item.name.trim() === '')) return words("SetupModal.every_fixture_layer_needs_a_name")
    if (fixtureStack.some((item) => !Number.isFinite(item.height) || item.height < 0)) {
      return words("SetupModal.fixture_heights_must_be_finite_and_at")
    }
    // WO-2635: an unresolved planning grid cannot invalidate a setup. The
    // viewport keeps its machine-table grid; origin and cutting heights have
    // their own save gates and do not depend on this display-only reference.
    return null
  }, [fixtureStack])

  const projectedSetupHeights = useMemo(() => {
    try {
      return { heights: heightParamsFromSetupIntent(setupHeightIntent), error: null as string | null }
    } catch (error) {
      return {
        heights: null,
        error: error instanceof Error ? error.message : words("SetupModal.setup_height_defaults_are_invalid"),
      }
    }
  }, [setupHeightIntent])

  const setSetupHeightOffset = (plane: HeightPlaneName, offset: number) => {
    setSetupHeightIntent((current) => ({
      ...current,
      [plane]: { ...current[plane], offset, provenance: 'user' as const },
    }))
  }

  // Unified, MODE-AGNOSTIC stock list: every named stock the project carries,
  // auto twins (mode:'derived') and fixed twins (mode:'explicit') alike — each
  // has id + name. The picker is sourced from this (not the fixed-only list), so
  // a setup can bind to ANY named stock regardless of sceneStock.mode (which is
  // stuck 'auto' after the stock-model refactor). Show the picker whenever there
  // is >=1 selectable stock.
  const selectableStocks = project.stocks ?? []
  const hasStockPicker = selectableStocks.length >= 1

  // WO-288: the live second-side plan (or the refusal explaining why these two
  // setups cannot be two sides of one part). Recomputed against the CURRENT
  // stock selection, so re-pointing the stock picker away from the first side's
  // stock refuses instead of silently creating a flip across two blocks.
  const secondSide: SecondSidePlan | SecondSideRefusal | null = useMemo(() => {
    if (isEditMode || !flipOfSetupId) return null
    return planSecondSideSetup(project, {
      parentSetupId: flipOfSetupId,
      axis: flipAxis,
      ...(selectedStockId ? { stockId: selectedStockId } : {}),
    })
  }, [isEditMode, flipOfSetupId, flipAxis, project, selectedStockId])
  // A committed second side owns the stock, corner, offset and origin mode:
  // they follow from the first side rather than being typed in again.
  const secondSideLocked = secondSide?.ok === true
  // A held tab must LOOK held. app.css gives `.wcs-tab:hover` (0-2-0) more
  // weight than the global `button:disabled` colour (0-1-1), so a disabled tab
  // under the pointer still lit up as the live one - the row read as if Manual
  // were selected. Inline, because it outranks both, and using the same
  // disabled recipe as `.props-btn:disabled`; the stylesheet is outside this
  // work order's owned paths.
  const heldTabStyle: CSSProperties | undefined = secondSideLocked
    ? { opacity: 0.55, cursor: 'not-allowed', background: 'transparent' }
    : undefined

  // Same-stock setups may intentionally share an offset, while different
  // physical owners and legacy unbound setups reserve their slots. A circular
  // feature origin is model-driven but still belongs to a physical stock, so it
  // participates in the same collision rule.
  const editingSetupId_ = isEditMode ? editingSetupId : undefined
  const offsetStockId = originMode === 'corner' || originMode === 'bore'
    ? selectedStockId ?? undefined
    : undefined
  const usedOffsets = usedFixtureOffsetsForStock(project, offsetStockId, editingSetupId_ ?? undefined)
  const allOffsetsUsed = !isEditMode && G_OFFSETS.every((n) => usedOffsets.has(n))

  // Stock bounds for the corner pick = the RENDERED stock box, always (both auto
  // and fixed). The rendered stock is the source of truth the user sees: for auto
  // it already encompasses every part (incl. STL thickness) plus the XY/Z offsets,
  // so a Top pick lands on the visible top corner. The store-side re-derivation
  // (deriveAutoStockBounds) is a viewport-independent reconstruction that silently
  // DROPS any mesh whose stored boundingBox is still degenerate (un-healed legacy
  // STL / cache-miss), collapsing the box to just the 2D footprint + default Z
  // offset - that drift (Operator ruling 2026-06-13: corner floats off, Z 5.3 not 6.35) is
  // why the corner stopped snapping. Read what is drawn.
  const getBounds = useCallback((stockId?: string): { min: Vec3; max: Vec3 } | null => {
    return getVp()?.getStockBounds?.(stockId) ?? null
  }, [])

  // ── Reset & init when modal opens ─────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return

    setIsPickingVertex(false)
    setIsPickingStockCorner(false)
    setStockPickError(null)
    setSnapVertexPicked(false)
    setIsPickingBoreFace(false)
    setIsChoosingBoreEnd(false)
    setBorePickError(null)
    setBoreEnd('top')
    setOriginSourceUnresolved(undefined)
    // Never carry a second-side choice across an open (edit mode has none).
    setFlipOfSetupId(null)
    setFlipAxis('x')
    getVp()?.exitStockCornerPickMode?.()
    getVp()?.exitVertexPickMode?.()
    getVp()?.setBrepPickMode?.(null)
    getVp()?.setZeroPointChoices?.(null)

    if (isEditMode && editingSetupId) {
      // Editing restores the setup's stored stock. The corner-mode branch below
      // sets the force-choice gate when the restored stock is empty/unbound or
      // dangling (a legacy "All stocks" setup) so saving must bind a specific
      // stock under the new always-bind-a-stock rule. Non-corner modes never
      // gate, so clear it here as the default.
      setMustPickStock(false)
      const existing = project.setups.find(s => s.id === editingSetupId)
      if (existing) {
        setName(existing.name)
        setSetupHeightIntent(setupDefaultHeightIntent(existing))
        setFixtureStack(setupFixtureStack(existing))
        const storedSupportPlane = setupSupportPlane(existing)
        setSupportPlaneMode(storedSupportPlane.mode)
        setSupportPlaneOffset(storedSupportPlane.offset)
        setCustomPlaneZ(storedSupportPlane.customZ ?? 0)
        setFixture(fixtureForSetup(project, existing))
        setOrigin(existing.wcs.origin)
        getVp()?.setWCSOrigin?.(existing.wcs.origin, existing.wcs.label)

        const { wcs } = existing
        const stockBinding = wcsStockCornerBinding(wcs)
        if (stockBinding != null) {
          // Restore stock-corner binding. A corner origin must bind a SPECIFIC
          // stock; only restore wcs.stockId when it still resolves to an
          // existing stock. A legacy "All stocks" / unbound setup (no stockId)
          // or a dangling id (stock deleted) restores as UNSELECTED: the
          // "-- Select a stock --" placeholder shows and mustPickStock blocks
          // Save until a real stock is chosen (no crash on the missing id).
          setOriginMode('corner')
          setCornerFace(stockBinding.cornerFace)
          setSelCorner({ row: stockBinding.cornerRow, col: stockBinding.cornerCol })
          const stockId =
            stockBinding.stockId != null && (project.stocks ?? []).some(s => s.id === stockBinding.stockId)
              ? stockBinding.stockId
              : null
          setSelectedStockId(stockId)
          setMustPickStock(stockId == null)
          setSnapGeoId(undefined); setSnapLocalPt(undefined)
          setBoreBinding(undefined)
          setStockBounds(getBounds(stockId ?? undefined))
        } else if (wcs.originBinding?.kind === 'part_feature' &&
          (wcs.originBinding.featureRef.kind === 'bore_center' ||
            wcs.originBinding.featureRef.kind === 'circle_center')) {
          // Restore circular-feature binding - checked ahead of the plain
          // snapGeoId branch below since a bore-bound WCS also mirrors those
          // legacy fields (so the vertex-snap re-derivation rides unchanged).
          const featureBinding = wcs.originBinding as Extract<OriginBinding, { kind: 'part_feature' }>
          const fr = featureBinding.featureRef as Extract<FeatureRef, { kind: 'bore_center' | 'circle_center' }>
          if (fr.kind === 'bore_center') setBoreEnd(fr.end ?? 'top')
          const featureStockId = (
            featureBinding.stockId != null &&
            (project.stocks ?? []).some((stock) => stock.id === featureBinding.stockId)
          )
            ? featureBinding.stockId
            : resolveSetupFeatureStockId(project, fr.geoId)
          setOriginMode('bore'); setSelectedStockId(featureStockId)
          setMustPickStock(featureStockId == null)
          setSnapGeoId(fr.geoId)
          setSnapLocalPt(fr.localCenter)
          setOriginSourceUnresolved(featureBinding.sourceUnresolved)
          setBoreBinding(fr.kind === 'bore_center'
            ? {
                targetKind: 'cylinder',
                geoId: fr.geoId, bodyId: fr.bodyId, modelItemId: fr.modelItemId,
                faceStableId: fr.faceStableId, localCenter: fr.localCenter, diameter: fr.diameter,
                topOrigin: existing.wcs.origin,
              }
            : {
                targetKind: 'circle',
                geoId: fr.geoId, bodyId: fr.bodyId, modelItemId: fr.modelItemId,
                edgeStableId: fr.edgeStableId, localCenter: fr.localCenter, diameter: fr.diameter,
                topOrigin: existing.wcs.origin,
              })
          setStockBounds(getBounds(featureStockId ?? undefined))
        } else if (wcs.snapGeoId) {
          // Restore vertex-snap binding
          setOriginMode('snap'); setSelectedStockId(null)
          setSnapGeoId(wcs.snapGeoId)
          setSnapLocalPt(wcs.snapLocalPt)
          setSnapVertexPicked(true)
          setOriginSourceUnresolved(
            wcs.originBinding?.kind === 'part_feature' ? wcs.originBinding.sourceUnresolved : undefined,
          )
          setBoreBinding(undefined)
          setStockBounds(getBounds())
        } else {
          setOriginMode('manual'); setSelectedStockId(null)
          setSnapGeoId(undefined); setSnapLocalPt(undefined)
          setBoreBinding(undefined)
          setStockBounds(getBounds())
        }
      }
    } else {
      const n = project.setups.length + 1
      setName(words("SetupModal.setup", { value1: n }))
      setSetupHeightIntent(defaultHeightIntent())
      setFixtureStack([])
      setSupportPlaneMode('machine_table')
      setSupportPlaneOffset(0)
      setCustomPlaneZ(0)
      setOriginMode('corner')
      setCornerFace('top')
      setSelCorner({ row: 2, col: 0 })
      // SMART-PICK a NEW setup's stock (replaces the old hard DERIVED_STOCK_ID
      // default). pickDefaultSetupStock binds to the lone geometry-bearing stock
      // when there is exactly one (a nest's bound sheet counts — see
      // geometryBearingStockIds), forces an explicit choice when several exist
      // (mustPickStock -> picker unselected + Create blocked), and falls back to
      // DERIVED_STOCK_ID when none. This stops a nest setup from silently landing
      // on the thin auto stock while the seed ops resolve Z0 from the thick bound
      // sheet (the "Feed height below top height" fail-loud). The lone-stock and
      // no-nest flows are unchanged: when the single candidate IS the derived
      // stock, this picks DERIVED_STOCK_ID exactly as before.
      const pick = pickDefaultSetupStock(project)
      const forceChoice = 'forceChoice' in pick
      const defaultStockId: string | null = forceChoice ? null : pick.stockId
      setFixture(defaultFixtureForStock(project, defaultStockId))
      setMustPickStock(forceChoice)
      setSelectedStockId(defaultStockId)
      setSnapGeoId(undefined); setSnapLocalPt(undefined)
      setBoreBinding(undefined)

      const bounds = getBounds(defaultStockId ?? undefined)
      setStockBounds(bounds)

      if (bounds) {
        const def = CORNER_DEFS.find(c => c.row === 2 && c.col === 0)!
        const pos = cornerToWorld(def, bounds, 'top')
        setOrigin(pos)
        getVp()?.setWCSOrigin?.(pos, 'G54')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isEditMode, editingSetupId])

  // ── WCS gizmo lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    if (originMode === 'gizmo') {
      getVp()?.enterWCSGizmoMode?.(origin, (p) => {
        setOrigin(p)
        getVp()?.setWCSOrigin?.(p, `G${fixture}`)
      })
    } else {
      getVp()?.exitWCSGizmoMode?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originMode, isOpen])

  // The black-ring preview is temporary pick guidance only. Once an origin is
  // confirmed, applyOrigin moves the standard WCS indicator to that point; a
  // second preview sphere there would make bore/boss origins look different
  // from stock-corner origins. State changes therefore clear the preview while
  // in-flight circular-edge hover may still show it imperatively below.
  useEffect(() => {
    if (!isOpen) return
    getVp()?.setZeroPointPreview?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originMode, isOpen, boreBinding, boreEnd])

  // Cleanup gizmo / pick mode on unmount / close
  useEffect(() => () => {
    getVp()?.exitWCSGizmoMode?.()
    getVp()?.exitStockCornerPickMode?.()
    getVp()?.exitVertexPickMode?.()
    getVp()?.setBrepPickMode?.(null)
    getVp()?.setZeroPointChoices?.(null)
    getVp()?.setZeroPointPreview?.(null)
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const applyOrigin = useCallback((pos: Vec3) => {
    setOrigin(pos)
    getVp()?.setWCSOrigin?.(pos, `G${fixture}`)
  }, [fixture])

  // Get bounds for the currently selected stock (respects multi-stock selector)
  const getActiveBounds = useCallback((): { min: Vec3; max: Vec3 } | null => {
    return getBounds(selectedStockId ?? undefined)
  }, [selectedStockId, getBounds])

  const handleStockSelect = (id: string | null) => {
    setSelectedStockId(id)
    setFixture(defaultFixtureForStock(project, id, editingSetupId_ ?? undefined))
    // Only a REAL stock id satisfies the force-choice gate. The empty value is
    // the "-- Select a stock --" placeholder (nothing picked), which must keep
    // Create blocked — a corner origin has to bind a specific stock. (Reached
    // only via programmatic clears; the placeholder option is disabled+hidden.)
    setMustPickStock(id == null)
    const bounds = getBounds(id ?? undefined)
    setStockBounds(bounds)
    setStockPickError(bounds || id == null
      ? null
      : words("SetupModal.that_stock_is_not_rendered_right_now"))
    if (bounds) {
      const def = CORNER_DEFS.find(c => c.row === selCorner.row && c.col === selCorner.col) ?? CORNER_DEFS[6]
      applyOrigin(cornerToWorld(def, bounds, cornerFace))
    }
  }

  // Circular feature origins follow model geometry, but the setup still needs
  // an explicit physical-stock association for height and crash-clearance
  // proof. Changing this confirmation must not move the already-picked origin.
  const handleCircularStockSelect = (id: string | null) => {
    setSelectedStockId(id)
    setFixture(defaultFixtureForStock(project, id, editingSetupId_ ?? undefined))
    setMustPickStock(id == null)
    setStockBounds(getBounds(id ?? undefined))
  }

  const bindCircularFeatureStock = (geoId: string) => {
    const stockId = resolveSetupFeatureStockId(project, geoId)
    handleCircularStockSelect(stockId)
  }

  // WO-288: adopt everything the flip decides - the first side's stock, its
  // corner and face, its world origin (the block did not move) and the work
  // offset that stock owns. A refusal leaves the form untouched and shows why.
  const applySecondSide = (parentSetupId: string | null, axis: FlipAxis) => {
    setFlipOfSetupId(parentSetupId)
    setFlipAxis(axis)
    if (!parentSetupId) return
    const plan = planSecondSideSetup(project, { parentSetupId, axis })
    if (!plan.ok) return
    setOriginMode('corner')
    setSelectedStockId(plan.stockId)
    setMustPickStock(false)
    setCornerFace(plan.cornerFace)
    setSelCorner({ row: plan.cornerRow, col: plan.cornerCol })
    setFixture(plan.fixtureOffset)
    setStockPickError(null)
    setStockBounds(getBounds(plan.stockId))
    applyOrigin(plan.origin)
  }

  const handleCornerClick = (def: typeof CORNER_DEFS[0]) => {
    setSelCorner({ row: def.row, col: def.col })
    const bounds = getActiveBounds()
    if (!bounds) return
    applyOrigin(cornerToWorld(def, bounds, cornerFace))
  }

  const handleFaceToggle = (face: 'top' | 'bottom') => {
    setCornerFace(face)
    const bounds = getActiveBounds()
    if (!bounds) return
    const def = CORNER_DEFS.find(c => c.row === selCorner.row && c.col === selCorner.col)
    if (def) applyOrigin(cornerToWorld(def, bounds, face))
  }

  const handleStartStockCornerPick = () => {
    const vp = getVp()
    if (selectableStocks.length === 0) {
      setStockPickError(words("SetupModal.no_stock_is_available_to_pick_add"))
      return
    }
    if (!vp?.enterStockCornerPickMode) {
      setStockPickError(words("SetupModal.the_viewport_is_not_ready_for_stock"))
      return
    }
    const renderedStockIds = selectableStocks
      .filter((stock) => getBounds(stock.id) != null)
      .map((stock) => stock.id)
    if (renderedStockIds.length === 0) {
      setStockPickError(words("SetupModal.no_selected_stock_is_rendered_make_stock"))
      return
    }
    setStockPickError(null)
    setIsPickingStockCorner(true)
    vp.enterStockCornerPickMode((pick) => {
      vp.exitStockCornerPickMode?.()
      setIsPickingStockCorner(false)
      const bounds = getBounds(pick.stockId)
      if (!bounds) {
        setStockPickError(words("SetupModal.the_selected_stock_is_no_longer_rendered"))
        return
      }
      setSelectedStockId(pick.stockId)
      setMustPickStock(false)
      setStockBounds(bounds)
      setCornerFace(pick.face)
      setSelCorner({ row: pick.row, col: pick.col })
      applyOrigin(pick.pos)
    }, renderedStockIds)
  }

  const handleCancelStockCornerPick = () => {
    getVp()?.exitStockCornerPickMode?.()
    setIsPickingStockCorner(false)
  }

  const handleStartVertexPick = () => {
    setIsPickingVertex(true)
    getVp()?.enterVertexPickMode?.((result) => {
      setIsPickingVertex(false)
      getVp()?.exitVertexPickMode?.()
      applyOrigin(result.pos)
      setOriginMode('snap')
      setSnapGeoId(result.geoId)
      setSnapLocalPt(result.localPt)
      setSnapVertexPicked(true)
      setOriginSourceUnresolved(undefined)
    })
  }

  const handleCancelVertexPick = () => {
    setIsPickingVertex(false)
    getVp()?.exitVertexPickMode?.()
  }

  // WO-294: the bore pick is the SAME interaction the vertex pick is (armed by
  // the origin-mode tabs, cancelled by the same Escape/Cancel path, replaces
  // the modal with the same floating banner) - only the viewport picking API
  // and what a resolved hit means differ. Mirrors NewOperationModalBody's own
  // bore-wall pick (resolveModelFaceOwner -> readModelBodyFaceFacts ->
  // deriveModelBodyBoreTarget), simplified: a setup origin has no operation
  // type to gate a binding "mode" against, just "is this a modeled-body face".
  // WO-336: unlike NewOperationModalBody's Bore-cutting pick, a SETUP zero
  // point also accepts an external boss (resolveSetupBoreOriginPick ->
  // deriveModelBodyCircularOrigin) - this owner check stays face-kind-
  // agnostic; the actual bore-vs-boss-vs-refuse decision happens once the
  // face facts resolve, below.
  function resolveBoreFaceOwner(
    sel: { geoId: string; index: number; isModelFace?: boolean },
  ): { geo: ImportedGeometry; bodyId: string; faceStableId: string; modelItemId: string } | { error: string } {
    if (!sel.isModelFace) return { error: words("SetupModal.that_was_not_a_modeled_body_face") }
    if (!sel.geoId) return { error: words("SetupModal.the_picked_face_reported_no_owning_body") }
    const owner = project.geometry.find(g => g.id === sel.geoId)
    if (!owner) return { error: words("SetupModal.the_picked_face_belongs_to_a_body", { value1: sel.geoId }) }
    // WO-355: resolve the OWNING Model Item HERE, at the one boundary that can
    // fail, instead of letting an unresolved id ride into the headless-replay
    // layer where a silent LEGACY_MODEL_ITEM_ID default would read the wrong
    // (or no) document and misreport it as "this project has no 3D model to
    // read" - false and unactionable on a project whose model is plainly on
    // screen. resolveOwningModelItemId returns undefined for exactly the same
    // condition isModelOriginGeometry used to gate on, so this replaces that
    // check rather than adding a second one - one predicate, one accurate
    // refusal, the modelItemId threaded onward instead of re-derived.
    const modelItemId = resolveOwningModelItemId(owner)
    if (modelItemId === undefined) {
      return { error: words("SetupModal.is_not_a_modeled_body_pick_a", { value1: owner.name }) }
    }
    const faceStableId = owner.modelBody?.display?.faceIds?.[sel.index]
    const bodyId = owner.modelBody?.ref.bodyId
    if (!faceStableId || !bodyId) {
      return { error: words("SetupModal.could_not_resolve_the_picked_face_identity") }
    }
    return { geo: owner, bodyId, faceStableId, modelItemId }
  }

  function resolveCircularEdgeOwner(
    sel: { geoId: string; index: number; isModelEdge?: boolean },
  ): {
    geo: ImportedGeometry
    bodyId: string
    edgeStableId: string
    localPoints: Array<[number, number, number]>
  } | { error: string } {
    const owner = project.geometry.find((geometry) => geometry.id === sel.geoId)
    if (!owner) return { error: words("SetupModal.the_picked_edge_belongs_to_a_body", { value1: sel.geoId }) }
    if (resolveOwningModelItemId(owner) === undefined) {
      return { error: words("SetupModal.is_not_a_modeled_body_pick_a_2", { value1: owner.name }) }
    }
    const display = owner.modelBody?.display
    const bodyId = owner.modelBody?.ref.bodyId
    const edgeStableId = display?.edgeIds?.[sel.index]
    const start = display?.edgeOffsets?.[sel.index]
    const end = display?.edgeOffsets?.[sel.index + 1]
    if (!display || !bodyId || !edgeStableId || start === undefined || end === undefined || end <= start) {
      return { error: words("SetupModal.could_not_resolve_the_picked_edge_identity") }
    }
    const localPoints: Array<[number, number, number]> = []
    for (let index = start; index < end; index++) {
      localPoints.push([
        display.edgePositions[index * 3],
        display.edgePositions[index * 3 + 1],
        display.edgePositions[index * 3 + 2],
      ])
    }
    return { geo: owner, bodyId, edgeStableId, localPoints }
  }

  // Bumped on every start/cancel so a pick's async continuation (the
  // readModelBodyFaceFacts round trip) can tell it is stale and skip applying
  // a result after the user cancelled or re-armed the pick.
  const borePickTokenRef = useRef(0)

  const handleStartBorePick = () => {
    const vp = getVp()
    if (!vp?.setBrepPickMode || !vp.setZeroPointChoices) {
      setBorePickError(words("SetupModal.the_viewport_circular_feature_picker_is_unavailable"))
      return
    }
    setBorePickError(null)
    setIsPickingBoreFace(true)
    setIsBorePickResolving(false)
    setIsChoosingBoreEnd(false)
    vp.setZeroPointChoices(null)
    const token = ++borePickTokenRef.current
    const finish = (error: string | null) => {
      if (borePickTokenRef.current !== token) return
      vp.setBrepPickMode?.(null)
      vp.setZeroPointChoices?.(null)
      setIsPickingBoreFace(false)
      setIsBorePickResolving(false)
      setIsChoosingBoreEnd(false)
      setBorePickError(error)
    }
    // Scoped to this one arm session (a fresh binding every call, captured by
    // the picker callback below) rather than a ref, so it never needs
    // resetting across sessions: once this session ends, `finish` disarms
    // vp.setBrepPickMode entirely and no further clicks can reach the
    // callback that reads it.
    let resolving = false
    const hoverFallback = () => { getVp()?.setZeroPointPreview?.(null) }
    const handleHover = (
      sel: { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean; isModelEdge?: boolean } | null,
    ) => {
      if (borePickTokenRef.current !== token || resolving) return
      if (!sel) { hoverFallback(); return }
      // A circular edge is already unambiguous, so hover can preview its one
      // center point. A cylindrical face deliberately previews no end: Top and
      // Bottom are presented only after the face click, and the operator then
      // chooses one explicitly in the workspace.
      if (sel.kind !== 'edge') { hoverFallback(); return }
      const owner = resolveCircularEdgeOwner(sel)
      if ('error' in owner) { hoverFallback(); return }
      try {
        const picked = resolveSetupCircleOriginPick(
          owner.geo, owner.bodyId, owner.edgeStableId, owner.localPoints,
          project.modelItemPlacements ?? [],
        )
        getVp()?.setZeroPointPreview?.(picked.origin)
      } catch {
        hoverFallback()
      }
    }
    try {
      vp.setBrepPickMode('face-or-edge', (sel) => {
        if (borePickTokenRef.current !== token) return
        if (resolving) return

        if (sel.kind === 'edge') {
          const owner = resolveCircularEdgeOwner(sel)
          if ('error' in owner) { finish(owner.error); return }
          try {
            const picked = resolveSetupCircleOriginPick(
              owner.geo, owner.bodyId, owner.edgeStableId, owner.localPoints,
              project.modelItemPlacements ?? [],
            )
            const featureRef = picked.originBinding.kind === 'part_feature' &&
              picked.originBinding.featureRef.kind === 'circle_center'
              ? picked.originBinding.featureRef
              : null
            if (!featureRef) { finish(words("SetupModal.circular_edge_did_not_resolve_to_a")); return }
            setBoreBinding({
              targetKind: 'circle',
              geoId: featureRef.geoId,
              bodyId: featureRef.bodyId,
              modelItemId: featureRef.modelItemId,
              edgeStableId: featureRef.edgeStableId,
              localCenter: featureRef.localCenter,
              diameter: featureRef.diameter,
              topOrigin: picked.origin,
              topLocalCenter: featureRef.localCenter,
            })
            setBoreEnd('top')
            setOriginSourceUnresolved(undefined)
            setOriginMode('bore')
            setSnapGeoId(picked.snapGeoId)
            setSnapLocalPt(picked.snapLocalPt)
            bindCircularFeatureStock(owner.geo.id)
            applyOrigin(picked.origin)
            getVp()?.setZeroPointPreview?.(null)
            finish(null)
          } catch (err) {
            finish(err instanceof Error ? err.message : String(err))
          }
          return
        }

        const owner = resolveBoreFaceOwner(sel)
        if ('error' in owner) {
          finish(owner.error)
          return
        }
        const { geo, bodyId, faceStableId, modelItemId } = owner
        resolving = true
        setIsBorePickResolving(true)
        // WO-362: an ordinary browser refresh (or a session that never
        // visited the Model tab this load) leaves this item's document
        // un-hydrated in memory even though a durable checkpoint for it is
        // sitting right there - self-heal it here, the same recovery
        // `openModelItem` already does on Model-tab navigation, before
        // asking the headless replay for a document it would otherwise
        // wrongly report as never having existed.
        void ensureDocumentArchiveHydrated(
          project.id, modelItemId, project.modelItems?.find((m) => m.id === modelItemId),
        ).then(() => readModelBodyFaceFacts(bodyId, faceStableId, modelItemId)).then(({ snapshot, verdicts }) => {
          if (borePickTokenRef.current !== token) return
          const picked = resolveSetupBoreOriginPick(
            geo, bodyId, faceStableId, snapshot, verdicts, project.modelItemPlacements ?? [],
          )
          const featureRef = picked.originBinding.kind === 'part_feature' && picked.originBinding.featureRef.kind === 'bore_center'
            ? picked.originBinding.featureRef
            : null
          if (!featureRef) { finish(words("SetupModal.bore_pick_did_not_resolve_to_a")); return }
          // WO-337: the SAME picked.origin/featureRef.localCenter as before
          // (top rim, unchanged) plus the feature's bottom, from a second pure
          // read of the SAME already-fetched snapshot/verdicts - no extra
          // kernel round trip. Only the Z axis differs between a bore/boss's
          // two ends: deriveModelBodyBoreTarget/deriveModelBodyCircularOrigin
          // already refuse a non-Z-parallel axis, so X/Y is identical at both.
          const ends = deriveModelBodyCircularOrigin(
            geo, project.modelItemPlacements ?? [], faceStableId, snapshot, verdicts,
          )
          const depth = ends.topZ - ends.bottomZ
          const bottomOrigin: Vec3 = { ...picked.origin, z: picked.origin.z - depth }
          const bottomLocalCenter: Vec3 = { ...featureRef.localCenter, z: featureRef.localCenter.z - depth }
          const candidate: BoreBinding = {
            targetKind: 'cylinder',
            geoId: featureRef.geoId, bodyId: featureRef.bodyId, modelItemId: featureRef.modelItemId,
            faceStableId: featureRef.faceStableId, localCenter: featureRef.localCenter, diameter: featureRef.diameter,
            topOrigin: picked.origin, bottomOrigin,
            topLocalCenter: featureRef.localCenter, bottomLocalCenter,
          }

          // Stage two: the face click has resolved both honest centers. Remove
          // the face picker and let these two labeled points own the next click.
          vp.setBrepPickMode?.(null)
          setIsBorePickResolving(false)
          setIsChoosingBoreEnd(true)
          vp.setZeroPointChoices?.([
            { id: 'top', label: words("SetupModal.top"), position: picked.origin },
            { id: 'bottom', label: words("SetupModal.bottom"), position: bottomOrigin },
          ], (choiceId) => {
            if (borePickTokenRef.current !== token) return
            const end = choiceId === 'bottom' ? 'bottom' : choiceId === 'top' ? 'top' : null
            if (!end) return
            const nextOrigin = end === 'bottom' ? bottomOrigin : picked.origin
            const nextLocalCenter = end === 'bottom' ? bottomLocalCenter : featureRef.localCenter
            setBoreBinding({ ...candidate, localCenter: nextLocalCenter })
            setBoreEnd(end)
            setOriginSourceUnresolved(undefined)
            setOriginMode('bore')
            setSnapGeoId(picked.snapGeoId)
            setSnapLocalPt(nextLocalCenter)
            bindCircularFeatureStock(geo.id)
            applyOrigin(nextOrigin)
            getVp()?.setZeroPointPreview?.(null)
            finish(null)
          })
        }).catch((err: unknown) => {
          // Refuse rather than guess: leave the previous origin/binding
          // untouched - nothing above this line mutated any state.
          // WO-362 audit fix: a hydration failure is the "genuinely cannot
          // recover" case the dead-end rule covers - name a stated, actionable
          // way forward instead of this module's internal vocabulary.
          finish(
            err instanceof DocumentHydrationFailedError
              ? words(DOCUMENT_HYDRATION_FAILED_MESSAGE)
              : err instanceof Error ? err.message : String(err),
          )
        })
      }, null)
      vp.setBrepPickHoverCallback?.(handleHover)
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancelBorePick = () => {
    borePickTokenRef.current++
    getVp()?.setBrepPickMode?.(null)
    getVp()?.setZeroPointChoices?.(null)
    setIsPickingBoreFace(false)
    setIsBorePickResolving(false)
    setIsChoosingBoreEnd(false)
    // A hover preview from the cancelled attempt may still be showing. The
    // standard WCS indicator already remains at the last confirmed origin.
    getVp()?.setZeroPointPreview?.(null)
  }

  // WO-337: toggling moves the marker AND the value Save will persist -
  // instant, no re-pick, since both ends were already computed at pick time.
  const handleBoreEndChange = (end: 'top' | 'bottom') => {
    if (!boreBinding?.topOrigin || !boreBinding.bottomOrigin || !boreBinding.topLocalCenter || !boreBinding.bottomLocalCenter) return
    const nextOrigin = end === 'bottom' ? boreBinding.bottomOrigin : boreBinding.topOrigin
    const nextLocalCenter = end === 'bottom' ? boreBinding.bottomLocalCenter : boreBinding.topLocalCenter
    setBoreEnd(end)
    setBoreBinding({ ...boreBinding, localCenter: nextLocalCenter })
    setSnapLocalPt(nextLocalCenter)
    applyOrigin(nextOrigin)
  }

  const updateFixtureStackItem = (id: string, updates: Partial<FixtureStackItem>) => {
    setFixtureStack((current) => current.map((item) => item.id === id ? { ...item, ...updates } : item))
  }

  const moveFixtureStackItem = (index: number, direction: -1 | 1) => {
    setFixtureStack((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const canSave = projectedSetupHeights.heights != null
    && fixtureStackError == null
    && !allOffsetsUsed
    && !(mustPickStock && (originMode === 'corner' || originMode === 'bore'))
    // WO-294: a setup must never end up with an origin nobody chose - Bore
    // mode selected but no successful pick yet blocks Save exactly like the
    // stock force-choice gate above.
    && !(originMode === 'bore' && !boreBinding)
    // A named second side that the flip refuses is not creatable at all: a
    // setup must not be saved claiming a relationship the app just denied.
    && secondSide?.ok !== false
    // WO-288: a committed flip is a stock-corner setup by construction -
    // applySecondSide puts the form there and the origin-mode tabs are held
    // while it holds. This is the same refusal stated at the SAVE gate rather
    // than at the controls, so no path (a keyboard Create, a future control,
    // a state restore) can write flipOf onto a setup that binds no stock and
    // therefore cannot be shown to be the same block of material.
    && !(secondSide?.ok === true && originMode !== 'corner')

  const handleSave = () => {
    if (!projectedSetupHeights.heights) return
    // Auto-bind to the lone named stock when nothing is explicitly selected
    // (MODE-AGNOSTIC: any single stock, auto or fixed). Without this a setup
    // created against a one-stock project would leave the WCS unbound and the
    // re-derive would fall back to the whole-scene union.
    const autoStockId = (
      originMode === 'corner' &&
      !selectedStockId &&
      selectableStocks.length === 1
    ) ? selectableStocks[0].id : null

    const effectiveStockId = originMode === 'corner'
      ? selectedStockId ?? autoStockId
      : originMode === 'bore'
        ? selectedStockId
        : null

    // Coordinate hierarchy: keep wcs.originBinding FRESH at the write site so it
    // never goes stale relative to the legacy fields it mirrors. originBinding
    // is authoritative when present; the legacy fields remain populated so old
    // load paths stay readable. The mapping mirrors
    // migrateHierarchy.deriveOriginBinding so a migrated load and a fresh pick
    // agree: corner (explicit stock) -> stock_corner(stockId); corner with NO
    // explicit stock (AUTO mode) -> stock_corner(DERIVED_STOCK_ID) because such a
    // WCS IS corner-bound to the derived stock and re-derives when it changes —
    // labeling it 'manual' would be a Phase-5 landmine (B10 drift returns); snap
    // -> part_feature/vertex; bore -> part_feature/bore_center (WO-294); else
    // manual/gizmo (no binding).
    const originBinding: OriginBinding =
      originMode === 'corner'
        ? {
            kind: 'stock_corner',
            stockId: effectiveStockId ?? DERIVED_STOCK_ID,
            cornerRow: selCorner.row,
            cornerCol: selCorner.col,
            cornerFace,
          }
        : originMode === 'bore' && boreBinding
          ? {
              kind: 'part_feature',
              geoId: boreBinding.geoId,
              ...(effectiveStockId ? { stockId: effectiveStockId } : {}),
              ...(originSourceUnresolved !== undefined ? { sourceUnresolved: originSourceUnresolved } : {}),
              featureRef: boreBinding.targetKind === 'circle'
                ? {
                    kind: 'circle_center',
                    geoId: boreBinding.geoId,
                    bodyId: boreBinding.bodyId,
                    modelItemId: boreBinding.modelItemId,
                    edgeStableId: boreBinding.edgeStableId!,
                    localCenter: boreBinding.localCenter,
                    diameter: boreBinding.diameter,
                  }
                : {
                    kind: 'bore_center',
                    geoId: boreBinding.geoId,
                    bodyId: boreBinding.bodyId,
                    modelItemId: boreBinding.modelItemId,
                    faceStableId: boreBinding.faceStableId!,
                    localCenter: boreBinding.localCenter,
                    diameter: boreBinding.diameter,
                    end: boreEnd,
                  },
            }
          : originMode === 'snap' && snapGeoId
            ? {
                kind: 'part_feature',
                geoId: snapGeoId,
                featureRef: { kind: 'vertex', localPt: snapLocalPt ?? { x: 0, y: 0, z: 0 } },
                ...(originSourceUnresolved !== undefined ? { sourceUnresolved: originSourceUnresolved } : {}),
              }
            : { kind: 'manual' }

    const existing = isEditMode && editingSetupId
      ? project.setups.find((candidate) => candidate.id === editingSetupId)
      : undefined
    const fixtureWasEdited = existing
      ? fixture !== fixtureForSetup(project, existing)
      : true
    // An untouched legacy setup keeps its raw WCS and old stock-first offset
    // resolution byte-for-byte. New setups and explicit offset edits state the
    // new authority in the saved record instead of relying on file-version
    // migration (ADR-0040).
    const savedFixture = existing && !fixtureWasEdited
      ? existing.wcs.fixtureOffset
      : fixture
    const savedLabel = existing && !fixtureWasEdited
      ? existing.wcs.label
      : `G${fixture}`
    const fixtureOffsetOwner = !existing || fixtureWasEdited || setupOwnsFixtureOffset(existing.wcs)
      ? { fixtureOffsetOwner: 'setup' as const }
      : {}

    const wcs: WCS & { fixtureOffsetOwner?: 'setup' } = {
      id: crypto.randomUUID(),
      label: savedLabel,
      fixtureOffset: savedFixture,
      ...fixtureOffsetOwner,
      origin,
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      // Corner binding — origin auto-tracks stock movement
      stockId:    originMode === 'corner' && effectiveStockId ? effectiveStockId : undefined,
      cornerRow:  originMode === 'corner' ? selCorner.row : undefined,
      cornerCol:  originMode === 'corner' ? selCorner.col : undefined,
      cornerFace: originMode === 'corner' ? cornerFace    : undefined,
      // Snap / bore-centre binding — origin auto-tracks geometry movement
      // (WO-294: a bore-bound origin rides the SAME legacy mirror fields a
      // vertex-snapped one does, so it re-derives through the one proven path).
      snapGeoId:  (originMode === 'snap' || originMode === 'bore')   ? snapGeoId   : undefined,
      snapLocalPt: (originMode === 'snap' || originMode === 'bore')  ? snapLocalPt : undefined,
      // Unified binding (kept in sync with the legacy fields above).
      originBinding,
    }

    if (isEditMode && editingSetupId) {
      const setupDefaultsChanged = existing
        ? !sameHeightIntent(setupDefaultHeightIntent(existing), setupHeightIntent)
        : false
      const savedWcs = { ...wcs, id: existing?.wcs.id ?? wcs.id }
      const wcsChanged = existing ? generationWcsChanged(existing.wcs, savedWcs) : false
      const invalidatedOperationCount = existing?.operations.filter((op) =>
        op.status === 'ready' || (op.toolpathMoves?.length ?? 0) > 0,
      ).length ?? 0
      updateSetup(editingSetupId, {
        name: name.trim() || existing?.name || words("SetupModal.setup_2"),
        wcs: savedWcs,
        fixtureStack: fixtureStack.map((item) => ({ ...item })),
        supportPlane: {
          mode: supportPlaneMode,
          offset: supportPlaneOffset,
          ...(supportPlaneMode === 'custom' ? { customZ: customPlaneZ } : {}),
        },
        defaultHeightIntent: cloneHeightIntent(setupHeightIntent),
        operations: existing?.operations.map((op) => {
          if (setupDefaultsChanged) {
            const refreshed = refreshSetupOwnedSmartHeightSafety(
              op,
              editingSetupId,
              setupHeightIntent,
            )
            if (refreshed) return {
                ...op,
                ...refreshed,
                status: 'pending' as const,
                toolpathMoves: undefined,
                computeTimeMs: undefined,
                estimatedCutTimeMs: undefined,
                estimatedCutTimeMsError: undefined,
                resolvedHeightPlan: undefined,
                resolvedHeights: undefined,
                generationFingerprint: undefined,
                errorMessage: undefined,
                diagnostics: undefined,
            }
          }
          return wcsChanged
            ? {
                ...op,
                status: 'outdated' as const,
                toolpathMoves: undefined,
                computeTimeMs: undefined,
                estimatedCutTimeMs: undefined,
                estimatedCutTimeMsError: undefined,
                resolvedHeightPlan: undefined,
                resolvedHeights: undefined,
                generationFingerprint: undefined,
                errorMessage: words("SetupModal.setup_work_coordinate_system_changed_regenerate_this"),
                diagnostics: undefined,
              }
            : op
        }),
      })
      if (existing && (wcsChanged || setupDefaultsChanged) && invalidatedOperationCount > 0) {
        const reason = fixtureWasEdited
          ? words("SetupModal.work_offset_changed_from_g_to_g", { value1: fixtureForSetup(project, existing), value2: fixture })
          : wcsChanged
            ? words("SetupModal.work_coordinate_system_changed")
            : words("SetupModal.default_operation_heights_changed")
        addConsoleEvent({
          severity: 'warning',
          source: 'setup',
          message:
            words("SetupModal.setup_computed", { value1: existing.name, value2: reason, value3: invalidatedOperationCount }) +
            words("SetupModal.operation_must_be_regenerated", { value1: invalidatedOperationCount === 1 ? '' : 's' }),
        })
      }
    } else {
      const setup: Setup = {
        id: crypto.randomUUID(),
        name: name.trim() || words("SetupModal.setup", { value1: project.setups.length + 1 }),
        wcs,
        stock: defaultStock(),
        // WO-288: the relationship itself. Written only when the flip resolved;
        // canSave has already blocked the refusal case.
        ...(secondSide?.ok
          ? { flipOf: { setupId: secondSide.parentSetupId, axis: secondSide.axis } }
          : {}),
        fixtureStack: fixtureStack.map((item) => ({ ...item })),
        supportPlane: {
          mode: supportPlaneMode,
          offset: supportPlaneOffset,
          ...(supportPlaneMode === 'custom' ? { customZ: customPlaneZ } : {}),
        },
        defaultHeightIntent: cloneHeightIntent(setupHeightIntent),
        operations: [],
        notes: '',
      }
      addSetup(setup)
    }
    getVp()?.exitWCSGizmoMode?.()
    getVp()?.exitStockCornerPickMode?.()
    getVp()?.setZeroPointChoices?.(null)
    closeModal()
  }

  const handleClose = () => {
    getVp()?.exitWCSGizmoMode?.()
    getVp()?.exitStockCornerPickMode?.()
    getVp()?.exitVertexPickMode?.()
    getVp()?.setBrepPickMode?.(null)
    getVp()?.setZeroPointChoices?.(null)
    getVp()?.setZeroPointPreview?.(null)
    closeModal()
  }

  const isOpenRef = useRef(isOpen)
  const isPickingStockCornerRef = useRef(isPickingStockCorner)
  const isPickingVertexRef = useRef(isPickingVertex)
  const isPickingBoreFaceRef = useRef(isPickingBoreFace)
  const canSaveRef = useRef(canSave)
  const cancelStockCornerPickRef = useRef(handleCancelStockCornerPick)
  const cancelVertexPickRef = useRef(handleCancelVertexPick)
  const cancelBorePickRef = useRef(handleCancelBorePick)
  const saveRef = useRef(handleSave)
  const closeRef = useRef(handleClose)
  const pendingSaveRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    // Publish only committed render state. NumericInput commits during its own
    // keydown handler, so the deferred save must not retain the old payload.
    isOpenRef.current = isOpen
    isPickingStockCornerRef.current = isPickingStockCorner
    isPickingVertexRef.current = isPickingVertex
    isPickingBoreFaceRef.current = isPickingBoreFace
    canSaveRef.current = canSave
    cancelStockCornerPickRef.current = handleCancelStockCornerPick
    cancelVertexPickRef.current = handleCancelVertexPick
    cancelBorePickRef.current = handleCancelBorePick
    saveRef.current = handleSave
    closeRef.current = handleClose
  }, [
    canSave,
    isOpen,
    isPickingStockCorner,
    isPickingVertex,
    isPickingBoreFace,
    handleCancelStockCornerPick,
    handleCancelVertexPick,
    handleCancelBorePick,
    handleSave,
    handleClose,
  ])

  useEffect(() => {
    if (!isOpen) return

    const cancelPendingSave = (): void => {
      if (pendingSaveRef.current === null) return
      window.clearTimeout(pendingSaveRef.current)
      pendingSaveRef.current = null
    }
    const onKey = (event: KeyboardEvent): void => {
      // Bubble phase is deliberate: child controls can prevent or consume the
      // event before it becomes a modal command, and IME confirmation is inert.
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || event.key === 'Process'
      ) return

      const panel = document.querySelector<HTMLElement>('[data-testid="setup-modal-panel"]')
      if (event.key === 'Escape') {
        cancelPendingSave()
        event.preventDefault()
        event.stopImmediatePropagation()
        if (isPickingStockCornerRef.current) cancelStockCornerPickRef.current()
        else if (isPickingVertexRef.current) cancelVertexPickRef.current()
        else if (isPickingBoreFaceRef.current) cancelBorePickRef.current()
        else closeRef.current()
        return
      }

      if (
        event.key !== 'Enter'
        || isPickingStockCornerRef.current
        || isPickingVertexRef.current
        || isPickingBoreFaceRef.current
        || !canSaveRef.current
        || !isSafeModalEnterTarget(event.target, panel)
      ) return

      event.preventDefault()
      event.stopImmediatePropagation()
      if (pendingSaveRef.current !== null) return
      pendingSaveRef.current = window.setTimeout(() => {
        pendingSaveRef.current = null
        // React has committed any child numeric draft. Re-check every live gate
        // before invoking the latest save closure exactly once.
        if (
          !isOpenRef.current
          || isPickingStockCornerRef.current
          || isPickingVertexRef.current
          || isPickingBoreFaceRef.current
          || !canSaveRef.current
        ) return
        saveRef.current()
      }, 0)
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelPendingSave()
    }
  }, [isOpen])

  if (!isOpen) return null

  if (isPickingStockCorner) {
    return (
      <div className="vertex-pick-banner" data-testid="setup-stock-corner-pick-banner">
        <Target size={16} className="vertex-pick-icon" />
        <span className="vertex-pick-text">{words("SetupModal.click_the_stock_at_the_origin_point")}</span>
        <button
          className="vertex-pick-cancel-btn"
          onClick={handleCancelStockCornerPick}
        >{words("SetupModal.cancel_esc")}</button>
      </div>
    )
  }

  // While picking a vertex OR a bore wall, replace the modal with a compact
  // floating banner so the viewport canvas is fully clickable (modal would
  // block it otherwise). WO-294: the bore pick REUSES this same authoring
  // site with different words rather than growing a second banner surface -
  // it is the same "pick something in the viewport, apply it as the origin"
  // interaction the vertex pick already is.
  if (isPickingVertex || isPickingBoreFace) {
    return (
      <div
        className="vertex-pick-banner"
        data-testid={isPickingBoreFace ? 'setup-bore-pick-banner' : 'setup-vertex-pick-banner'}
        data-resolving={isPickingBoreFace && isBorePickResolving ? 'true' : undefined}
      >
        {isPickingBoreFace
          ? (isBorePickResolving
              ? <Loader2 size={16} className="vertex-pick-icon wcs-snap-picking-icon" />
              : isChoosingBoreEnd
                ? <Target size={16} className="vertex-pick-icon" />
                : <CircleDot size={16} className="vertex-pick-icon" />)
          : <Crosshair size={16} className="vertex-pick-icon" />}
        <span className="vertex-pick-text" data-testid={isPickingBoreFace ? 'setup-bore-pick-status' : undefined}>
          {isPickingBoreFace
            ? (isBorePickResolving
                ? words("SetupModal.reading_the_picked_face_hold_on")
                : isChoosingBoreEnd
                  ? words("SetupModal.choose_top_or_bottom_in_the_workspace")
                  : words("SetupModal.click_a_circular_edge_for_its_center"))
            : words("SetupModal.click_any_vertex_on_the_3d_model")}
        </span>
        <button className="vertex-pick-cancel-btn" onClick={isPickingBoreFace ? handleCancelBorePick : handleCancelVertexPick}>{words("SetupModal.cancel_esc")}</button>
      </div>
    )
  }

  const plainGrid = originMode === 'gizmo' || narrowViewport
  // Collapsing is a split-layout affordance; the compact pick card and the
  // one-column phone layout always show every control.
  const wcsHidden = wcsCollapsed && !plainGrid
  const basicsSection = (
              <section className="setup-modal-column setup-modal-basics" data-testid="setup-modal-basics" ref={basicsRef}>
                {/* Setup name */}
                <div className="mform-row">
                  <label className="mform-label">{words("SetupModal.name")}</label>
                  <input
                    className="mform-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={words("SetupModal.setup_1")}
                    autoFocus
                  />
                </div>

                <div className="mform-section-header">{words("SetupModal.fixture_stack_and_cam_grid")}</div>
                <div className="mform-row">
                  <label className="mform-label">{words("SetupModal.grid_support_plane")}</label>
                  <select
                    className="mform-select"
                    data-testid="setup-support-plane-mode"
                    value={supportPlaneMode}
                    onChange={(event) => setSupportPlaneMode(event.target.value as SetupSupportPlaneMode)}
                  >
                    {SUPPORT_PLANE_MODES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                {supportPlaneMode === 'custom' && (
                  <div className="mform-row">
                    <label className="mform-label">{words("SetupModal.custom_plane_z", { value1: unitLabel(displayUnits) })}</label>
                    <NumericInput
                      className="mform-input mform-input-mono"
                      ariaLabel={words("SetupModal.custom_support_plane_z")}
                      value={customPlaneZ}
                      step={0.5}
                      units={displayUnits}
                      onChange={setCustomPlaneZ}
                    />
                  </div>
                )}
                <div className="mform-row">
                  <label className="mform-label">{words("SetupModal.signed_plane_offset", { value1: unitLabel(displayUnits) })}</label>
                  <NumericInput
                    className="mform-input mform-input-mono"
                    ariaLabel={words("SetupModal.support_plane_signed_offset")}
                    value={supportPlaneOffset}
                    step={0.5}
                    units={displayUnits}
                    onChange={setSupportPlaneOffset}
                  />
                </div>
                <div
                  data-testid="setup-support-plane-readout"
                  className="mform-hint"
                  style={{ fontFamily: 'var(--font-mono)', marginBottom: 8 }}
                >
                  {resolvedSupportPlane.resolved ? (
                    <>{words("SetupModal.grid")}{resolvedSupportPlane.name}{words("SetupModal.at_z")}{fmtDim(resolvedSupportPlane.z, displayUnits)} {unitLabel(displayUnits)}
                      {' | '}{resolvedSupportPlane.wcsLabel}{words("SetupModal.z")}{resolvedSupportPlane.wcsOffsetZ >= 0 ? '+' : ''}{fmtDim(resolvedSupportPlane.wcsOffsetZ, displayUnits)}
                    </>
                  ) : (
                    <>{words("SetupModal.unresolved_grid_fallback")}</>
                  )}
                </div>
                {fixtureStackError && (
                  <div className="wcs-no-stock" role="alert" data-testid="setup-fixture-stack-error">
                    {fixtureStackError}
                  </div>
                )}
                <div data-testid="setup-fixture-stack">
                  {fixtureStack.map((item, index) => (
                    <div
                      key={item.id}
                      data-testid="setup-fixture-stack-row"
                      style={{ borderTop: '1px solid var(--border-subtle)', padding: '6px 0' }}
                    >
                      <div className="mform-row">
                        <input
                          className="mform-input"
                          aria-label={words("SetupModal.fixture_layer_name", { value1: index + 1 })}
                          value={item.name}
                          onChange={(event) => updateFixtureStackItem(item.id, { name: event.target.value })}
                        />
                        <select
                          className="mform-select"
                          aria-label={words("SetupModal.fixture_layer_type", { value1: index + 1 })}
                          value={item.type}
                          onChange={(event) => updateFixtureStackItem(item.id, {
                            type: event.target.value as FixtureStackItemType,
                          })}
                        >
                          {FIXTURE_STACK_TYPES.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="mform-row">
                        <label className="mform-label">{words("SetupModal.height", { value1: unitLabel(displayUnits) })}</label>
                        <NumericInput
                          className="mform-input mform-input-mono"
                          ariaLabel={words("SetupModal.fixture_layer_height", { value1: index + 1 })}
                          value={item.height}
                          min={0}
                          step={0.5}
                          units={displayUnits}
                          onChange={(height) => updateFixtureStackItem(item.id, { height })}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <label className="mform-hint" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                          <input
                            type="checkbox"
                            aria-label={words("SetupModal.show_fixture_layer", { value1: index + 1 })}
                            checked={item.visible}
                            onChange={(event) => updateFixtureStackItem(item.id, { visible: event.target.checked })}
                          />{words("SetupModal.show")}</label>
                        <button
                          type="button"
                          className="modal-btn modal-btn-ghost"
                          aria-label={words("SetupModal.move_fixture_layer_down", { value1: index + 1 })}
                          disabled={index === 0}
                          onClick={() => moveFixtureStackItem(index, -1)}
                        >{words("SetupModal.down")}</button>
                        <button
                          type="button"
                          className="modal-btn modal-btn-ghost"
                          aria-label={words("SetupModal.move_fixture_layer_up", { value1: index + 1 })}
                          disabled={index === fixtureStack.length - 1}
                          onClick={() => moveFixtureStackItem(index, 1)}
                        >{words("SetupModal.up")}</button>
                        <button
                          type="button"
                          className="modal-btn modal-btn-ghost"
                          aria-label={words("SetupModal.remove_fixture_layer", { value1: index + 1 })}
                          onClick={() => setFixtureStack((current) => current.filter((row) => row.id !== item.id))}
                        >{words("SetupModal.remove")}</button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="modal-btn modal-btn-ghost"
                  data-testid="setup-add-fixture-layer"
                  onClick={() => setFixtureStack((current) => [...current, fixtureStackItem()])}
                >{words("SetupModal.add_fixture_layer")}</button>

                <div className="mform-section-header">{words("SetupModal.default_operation_heights")}</div>
                <div data-testid="setup-default-heights-section">
                  {([
                    ['clearance', words("SetupModal.clearance_above_retract")],
                    ['retract', words("SetupModal.retract_above_stock_top")],
                    ['feed', words("SetupModal.feed_above_top")],
                    ['top', words("SetupModal.top_offset_from_stock")],
                    ['bottom', words("SetupModal.bottom_offset_from_top")],
                  ] as const).map(([plane, label]) => (
                    <Fragment key={plane}>
                      <div className="mform-row">
                        <label className="mform-label">
                          {/* Preserve main's four text nodes (and their kerning),
                              while the catalog can reorder label and unit. */}
                          {words("SetupModal.labelWithUnit", {
                            label: `${label}\u0000`, unit: `\u0000${unitLabel(displayUnits)}\u0000`,
                          }).split('\u0000')}
                        </label>
                        <NumericInput
                          className="mform-input mform-input-mono"
                          ariaLabel={words("SetupModal.setup_default_height", { value1: plane })}
                          value={setupHeightIntent[plane].offset}
                          step={plane === 'clearance' ? 1 : 0.5}
                          units={displayUnits}
                          onChange={(value) => setSetupHeightOffset(plane, value)}
                        />
                      </div>
                      
                    </Fragment>
                  ))}
                  {projectedSetupHeights.error && (
                    <div className="wcs-no-stock" role="alert" data-testid="setup-default-heights-error">
                      {projectedSetupHeights.error}
                    </div>
                  )}
                </div>
              </section>
  )

  const wcsSection = (
              <section className="setup-modal-column setup-modal-wcs" data-testid="setup-modal-wcs">
              {!plainGrid && (
                <div style={PANE_HEADER_STYLE} data-testid="setup-modal-wcs-header">
                  <span style={PANE_TITLE_STYLE}>{words("SetupModal.work_offset_and_origin")}</span>
                  {wcsCollapsed && (
                    <span style={PANE_SUMMARY_STYLE} data-testid="setup-modal-wcs-summary">{words("SetupModal.g_x_y_z", { value1: fixture, value2: fmtDim(origin.x, displayUnits), value3: fmtDim(origin.y, displayUnits), value4: fmtDim(origin.z, displayUnits) })}</span>
                  )}
                  <PanelCollapseToggle
                    panelKey={SETUP_WCS_COLLAPSE_KEY}
                    testId="setup-modal-wcs-collapse"
                    collapseTip={words("SetupModal.collapse_the_work_offset_and_origin_pane")}
                    expandTip={words("SetupModal.expand_the_work_offset_and_origin_pane")}
                  />
                </div>
              )}
              {!wcsHidden && (<>
                {/* ── Second side of another setup (WO-288) ──
                    Creation only: the same block of material, turned over. The
                    stock, corner and work offset below then follow from the first
                    side instead of being typed in again. */}
                {!isEditMode && project.setups.length > 0 && (
                  <>
                    <div className="mform-section-header">{words("SetupModal.second_side")}</div>
                    <div className="mform-row">
                      <label className="mform-label">{words("SetupModal.second_side_of")}</label>
                      <select
                        className="mform-select"
                        data-testid="setup-second-side-of"
                        value={flipOfSetupId ?? ''}
                        onChange={(e) => applySecondSide(e.target.value || null, flipAxis)}
                      >
                        <option value="">{words("SetupModal.not_a_second_side")}</option>
                        {project.setups.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                        ))}
                      </select>
                    </div>
                    {flipOfSetupId && (
                      <div className="mform-row">
                        <label className="mform-label">{words("SetupModal.turned_about")}</label>
                        <select
                          className="mform-select"
                          data-testid="setup-second-side-axis"
                          value={flipAxis}
                          onChange={(e) => applySecondSide(flipOfSetupId, e.target.value as FlipAxis)}
                        >
                          {FLIP_AXES.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {secondSide?.ok === false && (
                      <div className="wcs-no-stock" role="alert" data-testid="setup-second-side-refusal">
                        {secondSide.message}
                      </div>
                    )}
                  </>
                )}

                {/* WCS section */}
                <div className="mform-section-header">{words("SetupModal.work_coordinate_system")}</div>

                <div className="mform-row">
                  <label className="mform-label">{words("SetupModal.setup_work_offset")}</label>
                  <select
                    className="mform-select"
                    data-testid="stock-work-offset-select"
                    value={fixture}
                    disabled={secondSideLocked}
                    onChange={(e) => setFixture(parseInt(e.target.value) as typeof fixture)}
                  >
                    {G_OFFSETS.map(n => {
                      const inUse = usedOffsets.has(n)
                      const owner = inUse
                        ? conflictingWorkOffsetClaim(
                            project,
                            n,
                            offsetStockId,
                            editingSetupId_ ?? undefined,
                          )
                        : undefined
                      return (
                        <option key={n} value={n} disabled={inUse}>
                          {inUse
                            ? words("SetupModal.g_in_use", { value1: n, value2: owner ? words("SetupModal.offsetOwner", { kind: words(`SetupModal.ownerKinds.${owner.kind}`), name: owner.name }) : '' })
                            : `G${n}`}
                        </option>
                      )
                    })}
                  </select>
                </div>
                {allOffsetsUsed && (
                  <div className="wcs-no-stock">{words("SetupModal.all_work_offsets_g54_g59_are_owned")}</div>
                )}

            {/* Origin mode tabs.
                WO-288: this row is HELD while a flip is committed, exactly like
                the stock, corner, face and offset controls it sits with. A second
                side's origin FOLLOWS from the relationship - the same block, the
                same corner - so Snap, Manual and Gizmo would type (or drag) an
                origin over a relationship that says it was not typed, and the
                created setup would carry flipOf while bound to NO stock: the
                "same block of material" the order requires could not be shown at
                all. Stock Corner is held with them; it is the mode the flip
                already chose, and a hold with a live way out is not a hold. */}
            <div className="wcs-tabs">
              <button
                className={`wcs-tab${originMode === 'corner' ? ' wcs-tab-active' : ''}`}
                data-testid="setup-origin-mode-corner"
                disabled={secondSideLocked}
                style={heldTabStyle}
                onClick={() => setOriginMode('corner')}
              >
                <MapPin size={11} />{words("SetupModal.stock_corner")}</button>
              <button
                className={`wcs-tab${originMode === 'snap' ? ' wcs-tab-active' : ''}`}
                data-testid="setup-origin-mode-snap"
                disabled={secondSideLocked}
                style={heldTabStyle}
                onClick={() => setOriginMode('snap')}
              >
                <Crosshair size={11} />{words("SetupModal.snap")}</button>
              <button
                className={`wcs-tab${originMode === 'manual' ? ' wcs-tab-active' : ''}`}
                data-testid="setup-origin-mode-manual"
                disabled={secondSideLocked}
                style={heldTabStyle}
                onClick={() => setOriginMode('manual')}
              >
                <Keyboard size={11} />{words("SetupModal.manual")}</button>
              <button
                className={`wcs-tab${originMode === 'gizmo' ? ' wcs-tab-active' : ''}`}
                data-testid="setup-origin-mode-gizmo"
                disabled={secondSideLocked}
                style={heldTabStyle}
                onClick={() => setOriginMode(originMode === 'gizmo' ? 'corner' : 'gizmo')}
              >
                <Move3d size={11} /> {originMode === 'gizmo' ? words("SetupModal.exit_gizmo") : words("SetupModal.gizmo")}
              </button>
              <button
                className={`wcs-tab${originMode === 'bore' ? ' wcs-tab-active' : ''}`}
                data-testid="setup-origin-mode-bore"
                disabled={secondSideLocked}
                style={heldTabStyle}
                onClick={() => setOriginMode('bore')}
              >
                <CircleDot size={11} />{words("SetupModal.circular_center")}</button>
            </div>

            {/* ── Stock corner picker ── */}
            {originMode === 'corner' && (
              <div className="wcs-corner-picker">
                <button
                  className="modal-btn modal-btn-ghost"
                  data-testid="setup-pick-stock-corner"
                  disabled={selectableStocks.length === 0 || secondSideLocked}
                  onClick={handleStartStockCornerPick}
                >
                  <Target size={12} />{words("SetupModal.pick_stock_and_origin_in_viewport")}</button>
                {stockPickError && (
                  <div className="wcs-no-stock" role="alert">{stockPickError}</div>
                )}
                {/* Stock selector, top/bottom toggle, and the 3x3 grid are ALWAYS
                    visible below the pick-in-viewport button (Operator ruling 2026-07-24:
                    "The grid should NEVER be collapsed" — the prior <details>
                    disclosure hid this behind a "Choose from list/grid instead"
                    toggle; removed, flat layout only). */}
                {/* Stock selector — MODE-AGNOSTIC: shown whenever the project has
                    >=1 named stock, sourced from the unified project.stocks (auto
                    + fixed twins). The WCS binds to the chosen stock's corner and
                    re-derives only from that stock. */}
                {hasStockPicker && (
                  <div className="wcs-stock-select-row">
                    <label className="wcs-stock-select-label">{words("SetupModal.stock")}</label>
                    <select
                      className="mform-select wcs-stock-select"
                      value={selectedStockId ?? ''}
                      disabled={secondSideLocked}
                      onChange={(e) => handleStockSelect(e.target.value || null)}
                    >
                      {/* Placeholder for the "nothing picked" state. A corner
                          origin must ALWAYS bind a SPECIFIC stock (the old "All
                          stocks (combined bounds)" choice is gone — the combined
                          AABB of every stock is a geometrically ill-defined
                          corner). Disabled+hidden so it cannot be re-selected once
                          a real stock is chosen; it only shows while
                          selectedStockId is null/empty. */}
                      <option value="" disabled hidden>{words("SetupModal.select_a_stock")}</option>
                      {selectableStocks.map((st) => (
                        <option key={st.id} value={st.id}>
                          {words('SetupModal.stockOption', { name: st.name, mode: st.mode === 'explicit' ? words('SetupModal.fixed') : words('SetupModal.auto') })}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Force-choice gate: >1 geometry-bearing stock on a NEW setup means
                    the cut stock is ambiguous (e.g. a nest's bound sheet vs the auto
                    stock). Nothing is pre-selected and Create stays disabled until
                    the user picks one — no silent default to the wrong Z0. */}
                {mustPickStock && (
                  <div className="wcs-no-stock" data-testid="setup-must-pick-stock">{words("SetupModal.select_the_stock_this_setup_machines")}</div>
                )}

                {/* WO-288: while this setup IS a second side, the stock, corner,
                    offset and the way the origin is set are the first side's.
                    Changing any of them here would make the recorded relationship
                    a lie, so they are held until the user sets "Second side of"
                    back to "Not a second side". */}

                {!stockBounds && (
                  <div className="wcs-no-stock">{words("SetupModal.no_stock_bounds_available_import_geometry_first")}</div>
                )}

                {stockBounds && (
                  <>
                    {/* Z face toggle */}
                    <div className="wcs-face-toggle">
                      <button
                        className={`wcs-face-btn${cornerFace === 'top' ? ' wcs-face-active' : ''}`}
                        disabled={secondSideLocked}
                        onClick={() => handleFaceToggle('top')}
                      >{words("SetupModal.top_z")}</button>
                      <button
                        className={`wcs-face-btn${cornerFace === 'bottom' ? ' wcs-face-active' : ''}`}
                        disabled={secondSideLocked}
                        onClick={() => handleFaceToggle('bottom')}
                      >{words("SetupModal.bottom_z0")}</button>
                    </div>

                    {/* 3×3 corner grid */}
                    <div className="wcs-grid-wrap">
                      <div className="wcs-grid-label wcs-grid-label-back">{words("SetupModal.back_y")}</div>
                      <div className="wcs-grid">
                        {CORNER_DEFS.map((def) => {
                          const active = selCorner.row === def.row && selCorner.col === def.col
                          return (
                            <button
                              key={`${def.row}-${def.col}`}
                              className={`wcs-corner-btn${active ? ' wcs-corner-active' : ''}`}
                              data-tooltip={def.label}
                              aria-label={def.label}
                              disabled={secondSideLocked}
                              onClick={() => handleCornerClick(def)}
                            >
                              <span className="wcs-corner-dot" />
                            </button>
                          )
                        })}
                      </div>
                      <div className="wcs-grid-label wcs-grid-label-front">{words("SetupModal.front_y")}</div>
                      <div className="wcs-grid-axes">
                        <span style={{ color: 'var(--x-axis)' }}>{words("SetupModal.x")}</span>
                        <span style={{ color: 'var(--y-axis)' }}>{words("SetupModal.y")}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Snap to geometry ── */}
            {originMode === 'snap' && (
              <div className="wcs-snap">
                <button className="wcs-snap-btn" onClick={handleStartVertexPick}>
                  <Crosshair size={12} /> {snapGeoId ? words("SetupModal.re_pick_vertex") : words("SetupModal.pick_vertex")}
                </button>
                {snapGeoId && (
                  <div className="wcs-snap-picked" data-testid="setup-snap-picked">
                    {originSourceText(describeOriginSource(project.geometry, snapGeoId, 'vertex', originSourceUnresolved))}
                    <br />{words("SetupModal.point_x")}{fmtDim(origin.x, displayUnits)}{words("SetupModal.y_2")}{fmtDim(origin.y, displayUnits)}{words("SetupModal.z_2")}{fmtDim(origin.z, displayUnits)}
                  </div>
                )}
                {!snapGeoId && snapVertexPicked && (
                  <div className="wcs-snap-picked">{words("SetupModal.picked_no_tracking_x_y_z", { value1: fmtDim(origin.x, displayUnits), value2: fmtDim(origin.y, displayUnits), value3: fmtDim(origin.z, displayUnits) })}</div>
                )}
              </div>
            )}

            {/* Circular feature center (WO-294 / WO-336 / WO-366) */}
            {originMode === 'bore' && (
              <div className="wcs-snap">
                {hasStockPicker && (
                  <div className="wcs-stock-select-row">
                    <label className="wcs-stock-select-label" htmlFor="setup-circular-stock">{words("SetupModal.stock_containing_this_feature")}</label>
                    <select
                      id="setup-circular-stock"
                      className="mform-select wcs-stock-select"
                      data-testid="setup-circular-stock-select"
                      value={selectedStockId ?? ''}
                      disabled={secondSideLocked}
                      onChange={(event) => handleCircularStockSelect(event.target.value || null)}
                    >
                      <option value="" disabled hidden>{words("SetupModal.select_a_stock")}</option>
                      {selectableStocks.map((stock) => (
                        <option key={stock.id} value={stock.id}>
                          {words('SetupModal.stockOption', { name: stock.name, mode: stock.mode === 'explicit' ? words('SetupModal.fixed') : words('SetupModal.auto') })}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  className="wcs-snap-btn"
                  data-testid="setup-circular-pick-button"
                  onClick={handleStartBorePick}
                  disabled={secondSideLocked}
                >
                  <CircleDot size={12} /> {boreBinding ? words("SetupModal.re_pick_circle_cylinder") : words("SetupModal.pick_circle_cylinder")}
                </button>
                {borePickError && (
                  <div className="wcs-no-stock" role="alert" data-testid="setup-bore-pick-error">{borePickError}</div>
                )}
                {/* WO-337: "maybe I want the bottom of a hole, not the top" - one
                    control away, shown only once both ends are known (a live
                    pick this session; a restored setup needs a re-pick first,
                    same as changing anything else about the binding). */}
                {boreBinding?.targetKind === 'cylinder' && boreBinding.topOrigin && boreBinding.bottomOrigin && (
                  <div className="wcs-face-toggle" data-testid="setup-bore-end-toggle">
                    <button
                      type="button"
                      className={`wcs-face-btn${boreEnd === 'top' ? ' wcs-face-active' : ''}`}
                      data-testid="setup-bore-end-top"
                      disabled={secondSideLocked}
                      onClick={() => handleBoreEndChange('top')}
                    >{words("SetupModal.top_2")}</button>
                    <button
                      type="button"
                      className={`wcs-face-btn${boreEnd === 'bottom' ? ' wcs-face-active' : ''}`}
                      data-testid="setup-bore-end-bottom"
                      disabled={secondSideLocked}
                      onClick={() => handleBoreEndChange('bottom')}
                    >{words("SetupModal.bottom_2")}</button>
                  </div>
                )}
                {boreBinding && (
                  <div className="wcs-snap-picked" data-testid="setup-bore-picked">
                    {originSourceText(describeOriginSource(
                      project.geometry,
                      boreBinding.geoId,
                      boreBinding.targetKind === 'circle' ? 'circle_center' : 'bore_center',
                      originSourceUnresolved,
                    ))}
                    <br />{words("SetupModal.dia")}{fmtDim(boreBinding.diameter, displayUnits)} {unitLabel(displayUnits)}
                    <br />{words("SetupModal.x0_y0_center_z0")}{boreBinding.targetKind === 'circle'
                      ? words("SetupModal.circle_plane")
                      : boreEnd === 'bottom' ? words("SetupModal.bottom_3") : words("SetupModal.top_3")}{words("SetupModal.x_2")}{fmtDim(origin.x, displayUnits)}{words("SetupModal.y_2")}{fmtDim(origin.y, displayUnits)}{words("SetupModal.z_2")}{fmtDim(origin.z, displayUnits)}
                  </div>
                )}
                {!boreBinding && !borePickError && (
                  <div className="wcs-no-stock" data-testid="setup-bore-not-picked">{words("SetupModal.pick_a_circular_edge_bore_cylinder_or")}</div>
                )}
                {boreBinding && mustPickStock && (
                  <div className="wcs-no-stock" data-testid="setup-circular-must-pick-stock">{words("SetupModal.this_feature_has_no_confirmed_stock_select")}</div>
                )}
              </div>
            )}

            {/* ── Manual entry ── */}
            {originMode === 'manual' && (
              <div className="wcs-manual">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis} className="mform-row">
                    <label className="mform-label" style={{ color: `var(--${axis}-axis)` }}>
                      {axis.toUpperCase()}{words("SetupModal.symbol")}{unitLabel(displayUnits)}{words("SetupModal.symbol_2")}</label>
                    <NumericInput
                      className="mform-input mform-input-mono"
                      value={origin[axis]}
                      step={0.1}
                      units={displayUnits}
                      onChange={(v) => applyOrigin({ ...origin, [axis]: v })}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* ── Gizmo tab ── */}
            {originMode === 'gizmo' && (
              <div className="wcs-gizmo-info">
                <div className="wcs-gizmo-hint">{words("SetupModal.drag_the")}<strong>{words("SetupModal.gold_sphere")}</strong>{words("SetupModal.in_the_viewport_to_reposition_the_wcs")}<em>{words("SetupModal.exit_gizmo")}</em>{words("SetupModal.when_done")}</div>
                <div className="wcs-gizmo-coords">
                  <span style={{ color: 'var(--x-axis)' }}>{words("SetupModal.x_3", { value1: fmtDim(origin.x, displayUnits) })}</span>
                  <span style={{ color: 'var(--y-axis)' }}>{words("SetupModal.y_3", { value1: fmtDim(origin.y, displayUnits) })}</span>
                  <span style={{ color: 'var(--z-axis)' }}>{words("SetupModal.z_3", { value1: fmtDim(origin.z, displayUnits) })}</span>
                </div>
              </div>
            )}

                {/* Live origin display */}
                <div className="wcs-origin-display">
                  <span className="wcs-origin-label">{words("SetupModal.origin")}</span>
                  {/* MODAL-CONTRAST: --x-axis (red-500) measured 4.16:1 here, just
                      under the 4.5:1 text minimum -- Y/Z pass on their axis colors
                      (5.46:1 / 4.76:1) so only X needs the readable-red swap.
                      --text-danger is the vetted 6.69:1 red text tier; the shared
                      --x-axis token itself is left untouched (used app-wide for
                      viewport/gizmo axis coloring, out of this modal-only fix). */}
                  <span className="wcs-origin-val" style={{ color: 'var(--text-danger)' }}>{words("SetupModal.x_3", { value1: fmtDim(origin.x, displayUnits) })}</span>
                  <span className="wcs-origin-val" style={{ color: 'var(--y-axis)' }}>{words("SetupModal.y_3", { value1: fmtDim(origin.y, displayUnits) })}</span>
                  <span className="wcs-origin-val" style={{ color: 'var(--z-axis)' }}>{words("SetupModal.z_3", { value1: fmtDim(origin.z, displayUnits) })}</span>
                  <span className="wcs-origin-label">{unitLabel(displayUnits)}</span>
                </div>
              </>)}
              </section>
  )

  const gizmoMode = originMode === 'gizmo'

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim (incl. its transparent pick variant) in the UI-70 census.
    <div
      className={`modal-backdrop${gizmoMode ? ' modal-backdrop-transparent' : ''}`}
      data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget && !gizmoMode) handleClose() }}
    >
      <div
        className={`modal-container setup-modal${gizmoMode ? ' setup-modal-compact' : ''}`}
        data-testid="setup-modal-panel"
        ref={dialogFocusRef}
      >
        {/* Header */}
        <div className="modal-header">
          <Target size={14} className="modal-header-icon" />
          <span className="modal-title">{isEditMode ? words("SetupModal.edit_setup") : words("SetupModal.new_setup")}</span>
          <button className="modal-close-btn" onClick={handleClose}><X size={14} /></button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {/* One split in every layout, so switching layouts (viewport
              breakpoint, Gizmo pick) never unmounts the controls and an
              active numeric draft survives. The plain layouts stack the two
              panes at their content size with the bar at rest. */}
          <ResizableSplit
            prefKey="setupModal.wcsPane"
            testId={plainGrid ? 'setup-modal-grid' : 'setup-modal-split'}
            orientation={plainGrid ? 'vertical' : 'horizontal'}
            sizedPane="second"
            sizedCollapsed={plainGrid || wcsHidden}
            defaultSize={Math.round(SETUP_WCS_DEFAULT_PX * uiScale)}
            minSize={Math.round(SETUP_WCS_MIN_PX * uiScale)}
            maxSize={Math.round(SETUP_WCS_MAX_PX * uiScale)}
            fillMinSize={plainGrid ? basicsStackH : Math.round(SETUP_BASICS_MIN_PX * uiScale)}
            label={words("SetupModal.resize_the_setup_basics_and_work_offset")}
            first={basicsSection}
            second={wcsSection}
          />
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={handleClose}>{words("SetupModal.cancel")}</button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleSave}
            disabled={!canSave}
          >
            {isEditMode ? words("SetupModal.save_setup") : words("SetupModal.create_setup")}
          </button>
        </div>
      </div>
    </div>
  )
}

function fixtureForSetup(
  project: Project,
  setup: Setup,
): (typeof FIXTURE_OFFSETS)[number] {
  if (setupOwnsFixtureOffset(setup.wcs)) {
    return setup.wcs.fixtureOffset as (typeof FIXTURE_OFFSETS)[number]
  }
  const stockId = wcsBoundStockId(setup.wcs)
  const stockOffset = (project.stocks ?? [])
    .find((stock) => stock.id === stockId)?.fixtureOffset
  return isFixtureOffset(stockOffset)
    ? stockOffset
    : setup.wcs.fixtureOffset as (typeof FIXTURE_OFFSETS)[number]
}

function generationWcsChanged(a: WCS, b: WCS): boolean {
  const fingerprintFields = (wcs: WCS) => ({
    id: wcs.id,
    label: wcs.label,
    fixtureOffset: wcs.fixtureOffset,
    fixtureOffsetOwner: setupOwnsFixtureOffset(wcs) ? 'setup' : undefined,
    origin: wcs.origin,
    xAxis: wcs.xAxis,
    yAxis: wcs.yAxis,
    zAxis: wcs.zAxis,
    stockId: wcs.stockId,
    cornerRow: wcs.cornerRow,
    cornerCol: wcs.cornerCol,
    cornerFace: wcs.cornerFace,
    snapGeoId: wcs.snapGeoId,
    snapLocalPt: wcs.snapLocalPt,
    originBinding: wcs.originBinding,
  })
  return JSON.stringify(fingerprintFields(a)) !== JSON.stringify(fingerprintFields(b))
}

function defaultFixtureForStock(
  project: Project,
  stockId: string | null,
  exceptSetupId?: string,
): (typeof FIXTURE_OFFSETS)[number] {
  const stockOffset = (project.stocks ?? [])
    .find((stock) => stock.id === stockId)?.fixtureOffset
  if (isFixtureOffset(stockOffset)) return stockOffset
  const used = usedFixtureOffsetsForStock(
    project,
    stockId ?? undefined,
    exceptSetupId,
  )
  return FIXTURE_OFFSETS.find((offset) => !used.has(offset)) ?? 54
}
