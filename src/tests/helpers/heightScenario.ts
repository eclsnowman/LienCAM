// WO-1604: the Smart Heights campaign harness (slices WO-1604..1608 share it).
//
// A scenario names a part, a stock set-up, where the part sits, one operation
// and its height settings. runHeightScenario builds that project the way the
// app does - store actions for geometry, stock, setup and operation, the Setup
// dialog's default work zero (front-left corner of the stock TOP), the
// operation dialog's own starting-policy selection and intent builders - then
// computes through useCamStore.getState().computeOperationToolpath with the
// REAL toolpathWorker behind a Worker shim (the int17aR3OpCompute.test.ts
// harness). It returns what the real moves did, in WCS Z.
//
// Rule 6: nothing here sends a hand-built payload to a generator. The only
// hand-written inputs are the ones an operator types or picks.

import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore, smartHeightStockBounds, setupProvenStockId } from '../../store'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import {
  buildContourSmartHeightIntent,
  buildFaceSmartHeightIntent,
  buildPlanarRoughSmartHeightIntent,
  buildChamferSmartHeightIntent,
  buildEngraveSmartHeightIntent,
  buildVCarveSmartHeightIntent,
  buildThreadMillSmartHeightIntent,
  withOperatorPlaneOverrides,
  deriveContourFeatureBindings,
  deriveDrillBoreFeatureBindings,
  deriveChamferEdgeBindings,
  type OperatorPlaneOverrides,
  type ResolvedHeightPlanV2,
} from '../../lib/cam/smartHeights'
import { buildDrillBoreAuthoringIntent } from '../../lib/cam/smartHeights/drillBoreAuthoring'
import {
  deriveOperationHeightDraft,
  selectStartingHeightPolicy,
} from '../../lib/cam/newOperationHeightDefaults'
import {
  defaultHeightIntent,
  operationSafetyHeightIntent,
  setupDefaultHeightIntent,
} from '../../lib/cam/heightIntent'
import { deriveHeightPlaneOffsetUpdate } from '../../lib/cam/heightReference'
import { normalizePocketEntryForFillStrategy } from '../../lib/cam/pocketEntryPolicy'
import { toWork } from '../../lib/program/coords'
import {
  defaultACParams, defaultBoreParams, defaultContourParams, defaultDrillParams, defaultFaceParams,
  defaultHeights, defaultLinking, defaultPasses, defaultPocketParams,
  defaultChamferParams, defaultEngraveParams, defaultVCarveParams, defaultThreadMillParams,
} from '../../components/modals/newOperationModalDefaults'
import type {
  AutoStockItem, FixedStockItem, HeightPlaneName, HeightReference, ImportedGeometry, Loop2D, Operation, Setup, Tool,
  ToolpathMove, Vec3, WCS,
} from '../../types'

// ─── scenario vocabulary ────────────────────────────────────────────────────

export type ScenarioOperation =
  | 'face' | 'pocket_2d' | 'adaptive_clearing_2d' | 'contour_2d' | 'drill' | 'bore'
  | 'chamfer' | 'engrave' | 'vcarve' | 'thread_mill'

export type ScenarioStock =
  | { kind: 'auto'; offsetXY: number; offsetZTop: number; offsetZBottom?: number }
  | { kind: 'fixed'; width: number; height: number; depth: number; position: Vec3 }

/** A closed 2D loop in part-local XY. */
export interface ScenarioLoop {
  id: string
  points: Array<{ x: number; y: number }>
}

export interface ScenarioPart {
  kind: 'sketch_2d'
  /** Every loop of the sketch. */
  loops: ScenarioLoop[]
  /** Machine Z of the sketch plane: 0 = lying on the table. The sketch is
   * raised the way the operator moves it: its row position Z (a 2D sketch's
   * world Z is its position, geometryWorldBounds). */
  z: number
}

/** WO-1605: a body marked as workholding (a vise), an axis-aligned box in
 * machine coordinates. It is imported as an STL row with no cached shape, so
 * the store keeps the tool clear of its bounding box - which is this box. */
export interface ScenarioWorkholding {
  name: string
  min: Vec3
  max: Vec3
}

/** The Bottom (or Top) Height row, as the operation dialog's row writes it. */
export interface BottomRowOverride {
  reference: 'stock_bottom' | 'stock_top' | 'wcs_plane'
  offsetMm: number
}

/** WO-1607: a Clearance/Retract/Feed row set by the operator, the way the
 * dialog's safety rows write into the Setup-inherited HeightIntentV1 before
 * `operationSafetyHeightIntent` projects it (NewOperationModalBody's
 * userSafetyOverridePlanes / WO-1602's rows). */
export interface SafetyRowOverride {
  plane: 'clearance' | 'retract' | 'feed'
  reference: 'stock_top' | 'wcs_plane' | 'retract' | 'top'
  offsetMm: number
}

/** WO-1622: Chamfer/Engrave/V-carve/Thread Mill carry their datum plane and
 * depth directly in their formula intent (there is no separate Bottom/Top
 * row mechanism for them - editing the Height row edits the formula itself,
 * exactly as NewOperationModalBody's setOpHeightReference does). Absent
 * fields fall back to the dialog's own default for that operation. */
export interface DatumFormulaOverride {
  /** The internal (smartHeights) reference vocabulary, e.g. 'geometry_plane'
   * for the UI's 'geometry_face', 'wcs_plane' for an absolute plane. */
  datumReference?: Exclude<HeightReference, HeightPlaneName>
  datumOffsetMm?: number
  /** chamferWidthMm / engrave depthMm / vcarve explicit flatDepthMm / thread threadDepthMm. */
  depthMm?: number
}

export interface HeightScenario {
  part: ScenarioPart
  stock: ScenarioStock
  operation: ScenarioOperation
  /** Loop ids the operator picks for the operation (Face ignores it: stock boundary). */
  loopIds: string[]
  /** Absent = the dialog's Smart default. */
  bottomRow?: BottomRowOverride
  /** WO-1607: the Top Height row, overridden the same way as Bottom. */
  topRow?: BottomRowOverride
  /** WO-1607: one Clearance/Retract/Feed row, overridden. */
  safetyOverride?: SafetyRowOverride
  /** WO-1622: Chamfer/Engrave/V-carve/Thread Mill's datum + depth formula. */
  datumFormula?: DatumFormulaOverride
  /** WO-1605: workholding under the part. */
  workholding?: ScenarioWorkholding
  toolDiameter?: number
}

export interface HeightReading {
  status: Operation['status']
  errorMessage?: string
  /** An authoring refusal thrown by the dialog path before Save. */
  authoringError?: string
  /** The real moves, converted world -> work with the post's own toWork. */
  moves: ToolpathMove[]
  /** WCS Z of the stock, from the store's own Smart Height stock proof. */
  stockTopWcs: number
  stockBottomWcs: number
  /** Stock XY footprint in the moves' frame (WCS). */
  stockXY: { minX: number; maxX: number; minY: number; maxY: number }
  /** WO-1605: machine Z of the stock, and of the WCS origin the moves are read in. */
  stockTopMachineZ: number
  stockBottomMachineZ: number
  wcsOriginMachineZ: number
  /** WO-1605: the deepest cut of the raw stored moves (machine frame). */
  deepestCutMachineZ: number
  /** WO-1605: the workholding box in the moves' frame (WCS), when there is one. */
  workholdingWcs?: { min: Vec3; max: Vec3 }
  deepestCutZ: number
  highestCuttingZ: number
  lowestRapidZ: number
  /** Lowest Z of any rapid whose XY lies over the stock. */
  lowestRapidOverStockZ: number
  plan?: ResolvedHeightPlanV2
  /** The two numbers the Heights tab rows show (PropertiesPanel's own reading). */
  heightsRow: { top?: number; bottom?: number; retract?: number; clearance?: number }
}

// ─── fixtures the operator would draw ───────────────────────────────────────

export function rectLoop(id: string, x0: number, y0: number, x1: number, y1: number): ScenarioLoop {
  return { id, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }
}

export function circleLoop(id: string, cx: number, cy: number, r: number, n = 48): ScenarioLoop {
  const points = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { id, points }
}

function polygonArea(points: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

const GEO_ID = 'part-1'
const LAYER_ID = 'layer-1'
const SETUP_ID = 'setup-1'
const OP_ID = 'op-1'
const STOCK_ID = 'stock-1'

function sketchGeometry(part: ScenarioPart): ImportedGeometry {
  const xs = part.loops.flatMap(loop => loop.points.map(p => p.x))
  const ys = part.loops.flatMap(loop => loop.points.map(p => p.y))
  const min = { x: Math.min(...xs), y: Math.min(...ys), z: 0 }
  const max = { x: Math.max(...xs), y: Math.max(...ys), z: 0 }
  const loops: Loop2D[] = part.loops.map(loop => ({
    id: loop.id, points: loop.points.map(p => ({ ...p })), closed: true,
    type: 'contour', layerId: LAYER_ID, area: polygonArea(loop.points),
  }))
  return {
    id: GEO_ID, name: 'Sketch', filename: 'sketch.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min, max,
      size: { x: max.x - min.x, y: max.y - min.y, z: 0 },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: 0 },
    },
    position: { x: 0, y: 0, z: part.z }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops,
    layers2d: [{ id: LAYER_ID, name: 'Layer 1', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const WORKHOLDING_ID = 'vise-1'

/** An STL row the way an imported vise lands: bounding box local (XY centred,
 * bottom at 0), placed by its row position. */
function workholdingGeometry(body: ScenarioWorkholding): ImportedGeometry {
  const size = { x: body.max.x - body.min.x, y: body.max.y - body.min.y, z: body.max.z - body.min.z }
  const min = { x: -size.x / 2, y: -size.y / 2, z: 0 }
  const max = { x: size.x / 2, y: size.y / 2, z: size.z }
  return {
    id: WORKHOLDING_ID, name: body.name, filename: 'vise.stl', type: 'mesh', format: 'stl',
    boundingBox: { min, max, size, center: { x: 0, y: 0, z: size.z / 2 } },
    position: { x: (body.min.x + body.max.x) / 2, y: (body.min.y + body.max.y) / 2, z: body.min.z },
    rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as unknown as ImportedGeometry
}

function scenarioTool(scenario: HeightScenario): Tool {
  const drill = scenario.operation === 'drill'
  // WO-1622: Chamfer and V-carve need a real half-angle (angleFromAxisDeg);
  // Engrave/Thread Mill compute fine on a plain flat tool.
  const angled = scenario.operation === 'chamfer' || scenario.operation === 'vcarve'
  const type: Tool['type'] = drill
    ? 'drill'
    : scenario.operation === 'chamfer' ? 'chamfer_mill'
    : scenario.operation === 'vcarve' ? 'v_bit'
    : scenario.operation === 'thread_mill' ? 'thread_mill'
    : 'flat_end_mill'
  return {
    id: 'tool-1', name: drill ? 'Drill 5' : 'EM6',
    type,
    diameter: scenario.toolDiameter ?? (drill ? 5 : 6),
    fluteLength: 30, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', toolNumber: 1,
    ...(angled ? { angleFromAxisDeg: 45, tipDiameter: 0 } : {}),
  } as unknown as Tool
}

// ─── the real worker behind the Worker shim ─────────────────────────────────

let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined
let createdWindow = false

/** Call once at the top of a test file: installs the real toolpath worker, and
 * a viewport whose drawn stock box is the store's own stock proof (Face reads
 * the stock footprint from the rendered viewport, CNCViewport.getStockBounds). */
export function installRealToolpathWorker(): void {
  beforeAll(async () => {
    // The vitest environment here is node: no window. Give the store the one
    // viewport member it reads, and take it away again afterwards.
    const g = globalThis as unknown as { window?: Record<string, unknown> }
    createdWindow = g.window === undefined
    if (createdWindow) g.window = {}
    g.window!.__cncViewport = {
      getStockBounds: (stockId?: string) => {
        const project = useCamStore.getState().project
        return smartHeightStockBounds(project, stockId ?? STOCK_ID)
      },
    }
    ;(globalThis as { self?: unknown }).self = {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
    }
    await import('../../lib/cam/toolpathWorker')
    workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
    if (typeof workerSelf.onmessage !== 'function') {
      throw new Error('heightScenario: the real toolpathWorker did not install its handler')
    }
  })
  afterAll(() => {
    const g = globalThis as unknown as { window?: Record<string, unknown> }
    if (createdWindow) delete g.window
    else delete g.window?.__cncViewport
    delete (globalThis as { self?: unknown }).self
  })
  beforeEach(() => {
    activeShim = null
    OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(data: WorkerRequestMsg): void {
        activeShim = this
        void workerSelf.onmessage!({ data })
      }
      terminate(): void { activeShim = null }
    }
  })
  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
  })
}

// ─── building the project through store actions ─────────────────────────────

function buildProject(scenario: HeightScenario): { setup: Setup; stockId: string } {
  return buildProjectFrom({
    tools: [scenarioTool(scenario)], geometry: sketchGeometry(scenario.part),
    stock: scenario.stock, workholding: scenario.workholding,
  })
}

/** WO-1606: the project around any part row (a sketch or an imported solid). */
function buildProjectFrom(scenario: {
  tools: Tool[]
  geometry: ImportedGeometry
  stock: ScenarioStock
  workholding?: ScenarioWorkholding
}): { setup: Setup; stockId: string } {
  const store = useCamStore.getState()
  store.newProject()
  // SH-8: newProject keeps toolLibrary across scenarios (INT-21) and addTool
  // appends without an id check, so a stale tool from an earlier scenario in
  // the same file can shadow this scenario's tool of the same id (the compute
  // path finds the FIRST match). Clear only the ids this scenario is about to
  // add - never the whole library.
  for (const tool of scenario.tools) {
    if (useCamStore.getState().toolLibrary.some(t => t.id === tool.id)) {
      useCamStore.getState().removeTool(tool.id)
    }
    useCamStore.getState().addTool(tool)
  }
  useCamStore.getState().addGeometry(scenario.geometry)
  if (scenario.workholding) {
    useCamStore.getState().addGeometry(workholdingGeometry(scenario.workholding))
    // The design tree's "Workholding" mark (WO-1572).
    useCamStore.getState().setGeometryWorkholding(WORKHOLDING_ID, true)
  }

  if (scenario.stock.kind === 'auto') {
    const item: AutoStockItem = {
      id: STOCK_ID, name: 'Auto Stock 1',
      autoOffsetXY: scenario.stock.offsetXY,
      autoOffsetZTop: scenario.stock.offsetZTop,
      autoOffsetZBottom: scenario.stock.offsetZBottom ?? 0,
    }
    useCamStore.getState().addAutoStock(item)
  } else {
    const item: FixedStockItem = {
      id: STOCK_ID, name: 'Stock 1',
      width: scenario.stock.width, height: scenario.stock.height, depth: scenario.stock.depth,
      position: { ...scenario.stock.position },
    }
    useCamStore.getState().addFixedStock(item)
  }
  // The design tree's membership picker: the part belongs to this stock.
  useCamStore.getState().setStockMembership(GEO_ID, STOCK_ID)

  const project = useCamStore.getState().project
  const bounds = smartHeightStockBounds(project, STOCK_ID)
  if (!bounds) throw new Error('heightScenario: the store could not prove the stock bounds')
  // SetupModal's default: Front Left corner (row 2, col 0) of the stock TOP.
  const origin = { x: bounds.min.x, y: bounds.min.y, z: bounds.max.z }
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, fixtureOffsetOwner: 'setup',
    origin,
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    originBinding: { kind: 'stock_corner', stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
  } as unknown as WCS
  const setup = {
    id: SETUP_ID, name: 'Setup 1', wcs,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'aluminum',
    },
    fixtureStack: [],
    supportPlane: { mode: 'stock_bottom', offset: 0 },
    defaultHeightIntent: defaultHeightIntent(),
    operations: [], notes: '',
  } as unknown as Setup
  useCamStore.getState().addSetup(setup)
  const added = useCamStore.getState().project.setups.find(s => s.id === SETUP_ID)!
  return { setup: added, stockId: STOCK_ID }
}

// ─── authoring the operation the way the dialog does ────────────────────────

function authorOperation(scenario: HeightScenario, setup: Setup): Operation {
  const project = useCamStore.getState().project
  const geometries = project.geometry.filter(g => g.id === GEO_ID)
  const setupIntent = setupDefaultHeightIntent(setup)
  // WO-1607: a Clearance/Retract/Feed row the operator has set, the way the
  // dialog writes it into the operation's own HeightIntentV1 before
  // operationSafetyHeightIntent projects the 'user' provenance onto it.
  const safetyOverridePlanes = new Set<'clearance' | 'retract' | 'feed'>()
  if (scenario.safetyOverride) {
    const { plane, reference, offsetMm } = scenario.safetyOverride
    setupIntent[plane] = { reference, offset: offsetMm, provenance: 'user' }
    safetyOverridePlanes.add(plane)
  }
  const safetyIntent = operationSafetyHeightIntent(setupIntent, safetyOverridePlanes)
  const hasSetupStock = Boolean(setupProvenStockId(setup, project))
  const overrides: OperatorPlaneOverrides = {}
  if (scenario.topRow) {
    overrides.top = { ...scenario.topRow, owner: { kind: 'user_override' } }
  }
  const base = {
    id: OP_ID, enabled: true, status: 'pending' as const, toolId: 'tool-1',
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
  }
  // The dialog's projectFamily(): a fresh op's heights and height params come
  // from the Setup's default intent.
  const draftFor = (params: Record<string, unknown>) => deriveOperationHeightDraft({
    operationType: scenario.operation, setupIntent, currentParams: params,
  })

  if (scenario.operation === 'face') {
    const params = { ...defaultFaceParams }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const selection = selectStartingHeightPolicy('face', {
      hasSetupStock, hasSelectedGeometry: false, hasSelectedFeature: false,
      hasTargetSurface: false, explicitEndConfirmed: true,
    })
    // useNewOperationModalState: faceHeightDraft starts explicit_depth at WCS -5.
    const mode = selection.variant === 'target_face' ? 'target_face' : 'explicit_depth'
    if (scenario.bottomRow) {
      overrides.bottom = { ...scenario.bottomRow, owner: { kind: 'user_override' } }
    }
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildFaceSmartHeightIntent({
        setupId: setup.id, safetyIntent, mode,
        stockId: mode === 'explicit_depth' ? setupProvenStockId(setup, project) : undefined,
        explicitTargetWcsMm: mode === 'explicit_depth' ? -5 : undefined,
      }),
    }
    return {
      ...base, name: 'Face 1', type: 'face', geometrySelections: [],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight: withOperatorPlaneOverrides(smartHeight, overrides),
    } as unknown as Operation
  }

  if (scenario.operation === 'contour_2d') {
    const params = { ...defaultContourParams, geometryId: GEO_ID, loopIds: [...scenario.loopIds] }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const selection = selectStartingHeightPolicy('contour_2d', {
      hasSetupStock, hasSelectedGeometry: true,
      hasSelectedFeature: params.loopIds.length > 0 && deriveContourFeatureBindings(geometries, params.loopIds).ok,
      hasTargetSurface: true, explicitEndConfirmed: false,
    })
    const mode = selection.variant === 'selected_feature'
      ? 'selected_feature' as const
      : selection.variant === 'stock_bottom' ? 'stock_bottom' as const : 'explicit_depth' as const
    let features
    if (mode === 'selected_feature') {
      const derived = deriveContourFeatureBindings(geometries, params.loopIds)
      if (!derived.ok) throw new Error(derived.refusals.map(r => r.message).join(' '))
      features = derived.bindings.map(b => b.feature)
    }
    if (scenario.bottomRow) {
      overrides.bottom = { ...scenario.bottomRow, owner: { kind: 'user_override' } }
    }
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildContourSmartHeightIntent({
        setupId: setup.id, safetyIntent, mode,
        geometryIds: mode === 'selected_feature' ? undefined : [GEO_ID],
        features,
        explicitTargetWcsMm: mode === 'explicit_depth' ? -5 : undefined,
        throughAllowanceMm: undefined,
      }),
    }
    return {
      ...base, name: 'Contour 1', type: 'contour_2d', geometrySelections: [...params.loopIds],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight: withOperatorPlaneOverrides(smartHeight, overrides),
    } as unknown as Operation
  }

  if (scenario.operation === 'pocket_2d' || scenario.operation === 'adaptive_clearing_2d') {
    const isAdaptive = scenario.operation === 'adaptive_clearing_2d'
    let params: Record<string, unknown> = {
      ...(isAdaptive ? defaultACParams : defaultPocketParams),
      geometryId: GEO_ID, loopIds: [...scenario.loopIds],
    }
    const draft = draftFor(params)
    params = { ...params, ...draft.paramsPatch }
    let heights = { ...defaultHeights, ...draft.heights }
    if (scenario.bottomRow) {
      // NewOperationModalBody.editOperationHeightOffset: a geometry-bound
      // pocket / adaptive clearing Bottom row writes the end reference
      // (setPocketReferenceAndIntent) - a THIRD mechanism, not OperatorPlaneOverrides.
      const reference = scenario.bottomRow.reference
      heights = {
        ...heights,
        ...deriveHeightPlaneOffsetUpdate(
          scenario.operation, heights, { ...params, heightReference: reference } as never,
          reference, scenario.bottomRow.offsetMm,
        ),
      }
      params = { ...params, heightReference: reference, planeOffset: scenario.bottomRow.offsetMm }
    }
    const reference = (params.heightReference as string | undefined) ?? 'geometry_face'
    const offset = (params.planeOffset as number | undefined) ?? 0
    const mode = heights.bottomHeightMode === 'selected_face' || reference === 'geometry_face'
      ? 'geometry_floor' as const
      : reference === 'stock_bottom' && offset < 0 ? 'through_stock' as const : 'explicit_depth' as const
    // planarRoughExplicitTargetWcs()
    let explicitTargetWcsMm: number | undefined
    if (mode === 'explicit_depth') {
      if (reference === 'absolute') explicitTargetWcsMm = heights.bottomHeight
      else {
        const bounds = smartHeightStockBounds(project, setupProvenStockId(setup, project)!)!
        const stockZ = reference === 'stock_top' ? bounds.max.z : bounds.min.z
        explicitTargetWcsMm = stockZ - setup.wcs.origin.z + offset
      }
    }
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: setup.id, operationType: scenario.operation, safetyIntent, mode,
        geometryIds: [GEO_ID],
        throughAllowanceMm: mode === 'through_stock' ? Math.max(0, -offset) : undefined,
        explicitTargetWcsMm,
      }),
    }
    // useNewOperationModalState: a new pocket's entry follows its fill strategy
    // (adaptive clearing has no fillStrategy field - the engine plans its own entry).
    let linking = base.linking
    if (!isAdaptive) {
      linking = {
        ...base.linking,
        entryType: normalizePocketEntryForFillStrategy(
          params.fillStrategy as 'inside_out' | 'outside_in', base.linking.entryType,
        ),
      }
      if (params.fillStrategy !== 'outside_in') params = { ...params, stayDown: false }
    }
    return {
      ...base, linking, name: isAdaptive ? 'Adaptive 2D 1' : 'Pocket 1',
      type: scenario.operation, geometrySelections: [...scenario.loopIds],
      heights, params, smartHeight: withOperatorPlaneOverrides(smartHeight, overrides),
    } as unknown as Operation
  }

  // ── WO-1622: Chamfer, Engrave, V-carve, Thread Mill ────────────────────────
  // These four share one shape: a datum plane (reference + offset) and a depth
  // formula, authored directly (there is no separate Bottom/Top row override
  // mechanism - NewOperationModalBody's setOpHeightReference edits the same
  // fields this harness sets here). The store re-resolves the datum Z from
  // the intent's own datumPlane via resolveTopZ (store/index.ts), keyed off
  // op.params.geometryId/loopIds - so op.params here matters as much as the
  // intent itself.

  if (scenario.operation === 'chamfer') {
    const params = { ...defaultChamferParams, geometryId: GEO_ID, loopIds: [...scenario.loopIds] }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const derived = deriveChamferEdgeBindings(geometries, params.loopIds)
    if (!derived.ok) throw new Error(derived.refusals.map(r => r.message).join(' '))
    const datumReference = scenario.datumFormula?.datumReference ?? 'geometry_plane'
    const datumOffsetMm = scenario.datumFormula?.datumOffsetMm ?? 0
    const chamferWidthMm = scenario.datumFormula?.depthMm ?? defaultChamferParams.chamferWidth
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildChamferSmartHeightIntent({
        setupId: setup.id, safetyIntent, datumReference, datumOffsetMm,
        chamferWidthMm, tipOffsetMm: defaultChamferParams.tipOffset,
        features: derived.bindings.map(b => ({
          loopId: b.loopId, feature: { ...b.feature }, fingerprint: b.evidenceFingerprint,
        })),
      }),
    }
    return {
      ...base, name: 'Chamfer 1', type: 'chamfer', geometrySelections: [...params.loopIds],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight,
    } as unknown as Operation
  }

  if (scenario.operation === 'engrave') {
    const params = { ...defaultEngraveParams, geometryId: GEO_ID, loopIds: [...scenario.loopIds] }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const datumReference = scenario.datumFormula?.datumReference ?? 'stock_top'
    const datumOffsetMm = scenario.datumFormula?.datumOffsetMm ?? 0
    const depthMm = scenario.datumFormula?.depthMm ?? 1
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildEngraveSmartHeightIntent({
        setupId: setup.id, safetyIntent, datumReference, datumOffsetMm, axialOffsetMm: 0,
        depth: { kind: 'explicit', depthMm },
        scope: {
          geometryIds: [GEO_ID], loopIds: [...params.loopIds],
          includeOpen: params.includeOpen, includeClosed: params.includeClosed,
        },
      }),
    }
    return {
      ...base, name: 'Engrave 1', type: 'engrave', geometrySelections: [...params.loopIds],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight,
    } as unknown as Operation
  }

  if (scenario.operation === 'vcarve') {
    const params = { ...defaultVCarveParams, geometryId: GEO_ID, loopIds: [...scenario.loopIds] }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const datumReference = scenario.datumFormula?.datumReference ?? 'stock_top'
    const datumOffsetMm = scenario.datumFormula?.datumOffsetMm ?? 0
    const flatDepthMm = scenario.datumFormula?.depthMm
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildVCarveSmartHeightIntent({
        setupId: setup.id, safetyIntent, datumReference, datumOffsetMm, startDepthMm: 0,
        flatDepth: flatDepthMm !== undefined ? { kind: 'explicit', depthMm: flatDepthMm } : { kind: 'tool_limit' },
        scope: { geometryIds: [GEO_ID], loopIds: [...params.loopIds] },
      }),
    }
    return {
      ...base, name: 'V-carve 1', type: 'vcarve', geometrySelections: [...params.loopIds],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight,
    } as unknown as Operation
  }

  if (scenario.operation === 'thread_mill') {
    const params = { ...defaultThreadMillParams, geometryId: GEO_ID, loopIds: [...scenario.loopIds] }
    const draft = draftFor(params as unknown as Record<string, unknown>)
    const datumReference = scenario.datumFormula?.datumReference ?? 'geometry_plane'
    const datumOffsetMm = scenario.datumFormula?.datumOffsetMm ?? 0
    const threadDepthMm = scenario.datumFormula?.depthMm ?? defaultThreadMillParams.threadDepth ?? 9
    const smartHeight = {
      kind: 'smart_v2' as const,
      intent: buildThreadMillSmartHeightIntent({
        setupId: setup.id, safetyIntent, source: 'explicit_band', threadKind: 'internal',
        threadDepthMm, planeOffsetMm: datumOffsetMm, datumReference,
        geometryIds: [GEO_ID],
      }),
    }
    return {
      ...base, name: 'Thread Mill 1', type: 'thread_mill', geometrySelections: [...params.loopIds],
      heights: { ...defaultHeights, ...draft.heights },
      params: { ...params, ...draft.paramsPatch } as unknown as Record<string, unknown>,
      smartHeight,
    } as unknown as Operation
  }

  // drill / bore
  const isBore = scenario.operation === 'bore'
  const params = {
    ...(isBore ? defaultBoreParams : defaultDrillParams), geometryId: GEO_ID, loopIds: [...scenario.loopIds],
  }
  const draft = draftFor(params as unknown as Record<string, unknown>)
  const featureReady = deriveDrillBoreFeatureBindings(geometries, params.loopIds, isBore ? 'bore' : 'drill').ok
  const selection = selectStartingHeightPolicy(isBore ? 'bore' : 'drill', {
    hasSetupStock, hasSelectedGeometry: true, hasSelectedFeature: featureReady,
    hasTargetSurface: true, explicitEndConfirmed: false,
  })
  const mode = selection.variant === 'detected_features' ? 'detected_features' as const : 'explicit_depth' as const
  if (scenario.bottomRow) {
    overrides.bottom = { ...scenario.bottomRow, owner: { kind: 'user_override' } }
  }
  const smartHeight = {
    kind: 'smart_v2' as const,
    intent: buildDrillBoreAuthoringIntent({
      operationType: isBore ? 'bore' : 'drill', setupId: setup.id, safetyIntent, geometries,
      selectedLoopIds: params.loopIds,
      draft: { mode, explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
      perFeatureEndOverridesWcsMm: isBore
        ? (params as typeof defaultBoreParams).perBoreDepthOverrides
        : (params as typeof defaultDrillParams).perHoleDepthOverrides,
    }),
  }
  return {
    ...base, name: isBore ? 'Bore 1' : 'Drill 1', type: isBore ? 'bore' : 'drill',
    geometrySelections: [...params.loopIds],
    heights: { ...defaultHeights, ...draft.heights },
    params: {
      ...params, ...draft.paramsPatch,
      ...(isBore
        ? { perBoreDepth: mode === 'detected_features' }
        : { perHoleDepth: mode === 'detected_features' }),
    } as unknown as Record<string, unknown>,
    smartHeight: withOperatorPlaneOverrides(smartHeight, overrides),
  } as unknown as Operation
}

// ─── reading the real moves ─────────────────────────────────────────────────

/** Roles that enter, leave or link rather than cut at the operation's levels. */
const ENTRY_OR_LINK_ROLES = new Set([
  'rapid', 'helix', 'ramp', 'plunge', 'lead_in', 'lead_out', 'fast_traverse',
])

/** A rapid, or a link the generator tags as one (Drill feeds from clearance
 * to its R plane as a 'feed' move with role 'rapid'). */
export function isRapid(move: ToolpathMove): boolean {
  return move.type === 'rapid' || move.role === 'rapid'
}

export function isCutting(move: ToolpathMove, operation?: ScenarioOperation): boolean {
  if (isRapid(move)) return false
  // A drill's feed plunge IS its cut.
  if (operation === 'drill') return true
  return !ENTRY_OR_LINK_ROLES.has(move.role ?? 'cut')
}

/**
 * WO-1605: the moves whose tool enters a box (a workholding body), in the moves'
 * frame. Each segment from the previous move is sampled every 0.25 mm; the
 * cutter (a cylinder of `toolRadius` from the tip up) enters when the tip is
 * below the box top by more than 0.01 mm while the tip's XY is within the tool
 * radius of the box footprint.
 */
export function movesEnteringBox(
  moves: readonly ToolpathMove[],
  box: { min: Vec3; max: Vec3 },
  toolRadius: number,
): ToolpathMove[] {
  const hits: ToolpathMove[] = []
  const inside = (x: number, y: number, z: number) => {
    if (z >= box.max.z - 0.01 || z <= box.min.z) return false
    const dx = Math.max(box.min.x - x, 0, x - box.max.x)
    const dy = Math.max(box.min.y - y, 0, y - box.max.y)
    return Math.hypot(dx, dy) < toolRadius - 0.01
  }
  for (let i = 0; i < moves.length; i++) {
    const b = moves[i]
    const a = i > 0 ? moves[i - 1] : b
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.25))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      if (inside(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)) {
        hits.push(b)
        break
      }
    }
  }
  return hits
}

export async function runHeightScenario(scenario: HeightScenario): Promise<HeightReading> {
  const { setup, stockId } = buildProject(scenario)
  const project = useCamStore.getState().project
  const bounds = smartHeightStockBounds(project, stockId)!
  const wz = setup.wcs.origin.z
  const stockTopWcs = bounds.max.z - wz
  const stockBottomWcs = bounds.min.z - wz
  const stockXY = {
    minX: bounds.min.x - setup.wcs.origin.x, maxX: bounds.max.x - setup.wcs.origin.x,
    minY: bounds.min.y - setup.wcs.origin.y, maxY: bounds.max.y - setup.wcs.origin.y,
  }
  const wh = scenario.workholding
  const workholdingWcs = wh ? {
    min: { x: wh.min.x - setup.wcs.origin.x, y: wh.min.y - setup.wcs.origin.y, z: wh.min.z - wz },
    max: { x: wh.max.x - setup.wcs.origin.x, y: wh.max.y - setup.wcs.origin.y, z: wh.max.z - wz },
  } : undefined
  const frames = {
    stockTopMachineZ: bounds.max.z, stockBottomMachineZ: bounds.min.z, wcsOriginMachineZ: wz,
    workholdingWcs,
  }
  const empty: HeightReading = {
    status: 'error', moves: [], stockTopWcs, stockBottomWcs, stockXY, ...frames,
    deepestCutMachineZ: NaN, deepestCutZ: NaN, highestCuttingZ: NaN, lowestRapidZ: NaN, lowestRapidOverStockZ: NaN,
    heightsRow: {},
  }

  let op: Operation
  try {
    op = authorOperation(scenario, setup)
    useCamStore.getState().addOperation(setup.id, op)
  } catch (error) {
    return { ...empty, authoringError: error instanceof Error ? error.message : String(error) }
  }
  await useCamStore.getState().computeOperationToolpath(setup.id, OP_ID)

  const computed = useCamStore.getState().project.setups
    .find(s => s.id === setup.id)!.operations.find(o => o.id === OP_ID)!
  // Toolpath moves are stored in world (machine) coordinates; the post writes
  // them through toWork. Read them the way the program will.
  const worldMoves = computed.toolpathMoves ?? []
  const moves = worldMoves.map(m => ({ ...m, ...toWork(m, setup.wcs) }))
  const nonRapid = moves.filter(m => !isRapid(m))
  const cutting = moves.filter(m => isCutting(m, scenario.operation))
  const rapids = moves.filter(isRapid)
  const overStock = (m: ToolpathMove) =>
    m.x > stockXY.minX && m.x < stockXY.maxX && m.y > stockXY.minY && m.y < stockXY.maxY
  const min = (values: number[]) => values.length ? Math.min(...values) : NaN
  const max = (values: number[]) => values.length ? Math.max(...values) : NaN
  const plan = computed.resolvedHeightPlan?.version === 2 ? computed.resolvedHeightPlan : undefined
  // PropertiesPanel's resolvedBottomWcs, verbatim in meaning.
  const bottomRow = plan?.machining.cutterCenterEnd?.wcsMm
    ?? plan?.machining.featureEndpoints?.reduce<number | undefined>(
      (lowest, endpoint) => lowest === undefined
        ? endpoint.cutterCenterEnd.wcsMm
        : Math.min(lowest, endpoint.cutterCenterEnd.wcsMm),
      undefined,
    )
    ?? plan?.machining.physicalTarget?.wcsMm
  return {
    status: computed.status,
    errorMessage: computed.errorMessage,
    moves,
    stockTopWcs, stockBottomWcs, stockXY, ...frames,
    deepestCutMachineZ: min(worldMoves.filter(m => !isRapid(m)).map(m => m.z)),
    deepestCutZ: min(nonRapid.map(m => m.z)),
    highestCuttingZ: max(cutting.map(m => m.z)),
    lowestRapidZ: min(rapids.map(m => m.z)),
    lowestRapidOverStockZ: min(rapids.filter(overStock).map(m => m.z)),
    plan,
    heightsRow: {
      top: plan?.machining.materialStart.wcsMm,
      bottom: bottomRow,
      retract: plan?.safety.retract.wcsMm,
      clearance: plan?.safety.clearance.wcsMm,
    },
  }
}

// WO-2466: moved here from the two height test files that each carried a copy, so every
// height test checks rapids against the material left, not against the Feed plane.
// WO-2067: the Pocket 2D rapid check after WO-1972 (Operator ruling 2026-09-25: "This
// should be a staydown to the next stepdown"). A helix entry now begins 1 mm
// above the material and, between levels, the tool lifts off the floor it just
// cut and moves over the cleared area to the next helix - rapids below Retract
// by design. The check replays the operation's own moves against the stock:
// every non-rapid move removes material under a flat cutter; every rapid must
// stay above whatever material is still standing under the cutter at that
// moment (so never across uncut stock at any height below its top, and the
// entry drop only ever over air); and a rapid below `rapidFloorZ` is allowed
// only as part of the run of rapids leading straight into a helix, ramp or
// plunge - the stay-down link or the entry drop, nothing else.
/** Sloped cut moves (helix, ramp, plunge) are split into pieces this long, each
 *  read at its highest end, plus the cutter at the lower end at its own depth;
 *  rapids are sampled this often. */
const STEP = 0.1
const TOL = 0.01
/** The rapid's real cutter, full radius, may overlap material standing above
 *  its tip by no more than this (mm) - the same 0.01 as every other check here.
 *  Exact to that, not to a grid: an overlap wider than it always fails. */
const OVERLAP = 0.01
const BUCKET = 2
const ENTRY_ROLES = new Set(['helix', 'ramp', 'plunge'])

/** A piece of cut: every point within the tool radius of the segment is cut down to `z`. */
interface Swept { ax: number; ay: number; bx: number; by: number; z: number }

function sweptDistance(x: number, y: number, s: Swept): number {
  const dx = s.bx - s.ax
  const dy = s.by - s.ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (y - s.ay) * dy) / len2)) : 0
  return Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy)
}

export function rapidViolations(
  moves: readonly ToolpathMove[],
  stock: { minX: number; maxX: number; minY: number; maxY: number; topZ: number },
  toolRadius: number,
  rapidFloorZ: number,
): string[] {
  const r = toolRadius
  const swept: Swept[] = []
  const buckets = new Map<number, number[]>()
  const eachBucket = (x0: number, y0: number, x1: number, y1: number, visit: (key: number) => void) => {
    for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
      for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++) visit(i * 1_000_003 + j)
    }
  }
  const sweep = (s: Swept) => {
    const n = swept.push(s) - 1
    eachBucket(Math.min(s.ax, s.bx) - r, Math.min(s.ay, s.by) - r, Math.max(s.ax, s.bx) + r, Math.max(s.ay, s.by) + r,
      key => { const list = buckets.get(key); if (list) list.push(n); else buckets.set(key, [n]) })
  }
  // The height of material standing above `z` under the full cutter at (x, y),
  // or null when there is none. The disc (clipped to the stock) is split until
  // every part is either within the cutter's reach of a cut at or below the tip,
  // or holds a point beyond it: distance to the cuts is 1-Lipschitz, so a box of
  // diagonal d whose sample point is within reach - d + OVERLAP is covered whole.
  const standingOver = (x: number, y: number, z: number): number | null => {
    const seen = new Set<number>()
    const near: Swept[] = []
    eachBucket(x - r, y - r, x + r, y + r, key => {
      for (const n of buckets.get(key) ?? []) if (!seen.has(n)) { seen.add(n); near.push(swept[n]) }
    })
    const cutBelow = near.filter(s => s.z <= z + TOL)
    const reach = (qx: number, qy: number) => {
      let d = Infinity
      for (const s of cutBelow) d = Math.min(d, sweptDistance(qx, qy, s))
      return d
    }
    if (reach(x, y) <= OVERLAP) return null // on a cut at or below the tip: the whole disc was cut
    const boxes = [[Math.max(x - r, stock.minX), Math.max(y - r, stock.minY),
      Math.min(x + r, stock.maxX), Math.min(y + r, stock.maxY)]]
    while (boxes.length > 0) {
      const [x0, y0, x1, y1] = boxes.pop()!
      if (x0 > x1 || y0 > y1) continue
      const qx = Math.min(x1, Math.max(x0, x))
      const qy = Math.min(y1, Math.max(y0, y))
      if (Math.hypot(qx - x, qy - y) > r) continue // the box is outside the cutter
      const d = reach(qx, qy)
      if (d > r + OVERLAP / 2) {
        let height = stock.topZ
        for (const s of near) if (sweptDistance(qx, qy, s) <= r) height = Math.min(height, s.z)
        return height
      }
      if (d + Math.hypot(x1 - x0, y1 - y0) <= r + OVERLAP) continue
      const mx = (x0 + x1) / 2
      const my = (y0 + y1) / 2
      boxes.push([x0, y0, mx, my], [mx, y0, x1, my], [x0, my, mx, y1], [mx, my, x1, y1])
    }
    return null
  }
  const violations: string[] = []
  // Every move is checked, the first included: it has no move before it, so it is
  // read as a point at its own position (a first rapid below the stock top is
  // over material nothing has removed yet).
  for (let k = 0; k < moves.length; k++) {
    const a = moves[Math.max(0, k - 1)]
    const b = moves[k]
    if (b.type === 'arc_cw' || b.type === 'arc_ccw') {
      violations.push(`move ${k}: arc moves are not modelled by this check - extend it`)
      continue
    }
    const rapid = isRapid(b)
    if (rapid && b.z < rapidFloorZ - TOL) {
      let n = k
      while (n < moves.length && isRapid(moves[n])) n++
      if (n >= moves.length || !ENTRY_ROLES.has(moves[n].role ?? '')) {
        violations.push(`move ${k}: rapid at Z ${b.z.toFixed(3)} below ${rapidFloorZ} does not lead into an entry`)
      }
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / STEP))
    const at = (s: number) => {
      const t = s / steps
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
    }
    if (rapid) {
      for (let s = 0; s <= steps; s++) {
        const { x, y, z } = at(s)
        if (z >= stock.topZ - TOL) continue // nothing stands above the stock top
        const standing = standingOver(x, y, z)
        if (standing !== null) {
          violations.push(`move ${k}: rapid at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(3)}) ` +
            `crosses material standing at Z ${standing.toFixed(3)}`)
          break
        }
      }
    } else {
      for (let s = 1; s <= steps; s++) {
        const p = at(s - 1)
        const q = at(s)
        sweep({ ax: p.x, ay: p.y, bx: q.x, by: q.y, z: Math.max(p.z, q.z) })
        // ...and the cutter at the piece's end, at its own depth (a plunge's bottom).
        if (q.z < p.z) sweep({ ax: q.x, ay: q.y, bx: q.x, by: q.y, z: q.z })
      }
    }
  }
  return violations
}

// ─── WO-1606: imported 3D solids and operation sequences ────────────────────
//
// A solid scenario imports one of the repo's STEP fixtures as the app's own
// brep row, and runs one or more operations IN ORDER in one Setup, so a later
// operation sees what an earlier one left (rest machining, current material).
// The test file routes four browser-only transports to node with vi.mock (they
// are module mocks, so they cannot live in this helper):
//   - lib/stepCache.loadCachedStep                          -> solidStepBytes
//   - cam3d/integration/parallel3dOperation.acquirePartMesh -> tessellateSolid
//   - cam3d/integration/appClient.getCam3dClient            -> inProcessCam3dClient
//   - lib/cam/geometry/occt/model/modelClient.deriveHoles   -> deriveHolesInProcess
// Each replaces only a worker or IndexedDB transport; the kernel code behind it
// is the product's own (the benchmark chain runner's substitution).

export type SolidPartName = 'tray' | 'plate_holes' | 'closed_box'

export const SOLID_FILES: Record<SolidPartName, string> = {
  tray: 'src/tests/geom/fixtures/tray.step',
  plate_holes: 'src/tests/geom/fixtures/plate-holes.step',
  closed_box: 'src/tests/model3d/fixtures/wo1455/closed-box-30x20x10.step',
}

export type AdaptiveMaterialSource = 'current_material' | 'initial_stock' | 'rest' | 'bounded_band'

export type SolidOperation =
  | {
      kind: 'adaptive_3d'
      source: AdaptiveMaterialSource
      /** The Explicit WCS band's Top and Bottom (bounded_band only). */
      band?: { topWcsMm: number; bottomWcsMm: number }
      toolDiameter: number
      axialStockToLeave?: number
      params?: Record<string, unknown>
      /** WO-1622: one Clearance/Retract/Feed row, overridden the same way
       * the 2D authoring path's SafetyRowOverride does. */
      safetyOverride?: SafetyRowOverride
    }
  | { kind: 'parallel_3d'; toolDiameter: number; params?: Record<string, unknown> }
  | { kind: 'waterline_3d'; toolDiameter: number; params?: Record<string, unknown> }
  | {
      kind: 'drill'
      toolDiameter: number
      /** Detect holes, then pick the holes of these diameters (absent = all). */
      holeDiameters?: number[]
    }

export interface SolidScenario {
  part: SolidPartName
  /** Machine Z of the part's lowest point: 0 = on the table. */
  z: number
  stock: ScenarioStock
  workholding?: ScenarioWorkholding
  operations: SolidOperation[]
}

export interface SolidHoleReading {
  center: [number, number]
  diameter: number
  topWcs: number
  bottomWcs: number
  through: boolean
}

export interface SolidOperationReading extends HeightReading {
  opId: string
  kind: SolidOperation['kind']
  /** The raw stored moves (machine frame). */
  worldMoves: ToolpathMove[]
  /** Where the part's lowest and highest points lie (WCS). */
  partTopWcs: number
  partBottomWcs: number
  /** Drill: the holes Detect holes found (WCS Z). */
  holes?: SolidHoleReading[]
  /** Console lines the compute wrote. */
  consoleMessages: string[]
}

type PartMesh = import('../../cam3d/kernel/types').PartMesh
type Cam3dClientType = import('../../cam3d/worker/client').Cam3dClient

let solidFileByGeometryId = new Map<string, string>()

async function readRepoBytes(file: string): Promise<ArrayBuffer> {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const buf = readFileSync(join(process.cwd(), file))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** stepCache.loadCachedStep for the scenario's part row. */
export async function solidStepBytes(geoId: string): Promise<ArrayBuffer | null> {
  const file = solidFileByGeometryId.get(geoId)
  return file ? readRepoBytes(file) : null
}

let occtModelPromise: Promise<unknown> | undefined
function occtModel(): Promise<never> {
  occtModelPromise ??= (async () => {
    const { loadOcctModel } = await import('../../lib/cam/geometry/occt/model/loader')
    const wasm = await readRepoBytes('src/lib/cam/geometry/occt/model/vendor/occt-model.wasm')
    return loadOcctModel({ wasmBinary: wasm } as never)
  })()
  return occtModelPromise as Promise<never>
}

/** parallel3dOperation.acquirePartMesh for STEP bytes: the production importer
 * with the in-process occt tessellator in place of the tessellator worker. */
export async function tessellateSolid(
  source: { format: 'stl' | 'step'; bytes: ArrayBuffer },
  camTolerance: number,
): Promise<PartMesh> {
  if (source.format !== 'step') throw new Error('heightScenario: solid scenarios import STEP only')
  const { importStepToPartMesh } = await import('../../cam3d/input/step')
  const { makeOcctCoreTessellator } = await import('../../cam3d/input/occtCoreTessellator')
  const oc = await occtModel()
  const imported = await importStepToPartMesh(source.bytes, {
    camTolerance, tessellator: makeOcctCoreTessellator(oc),
  })
  return imported.mesh
}

/** modelClient.deriveHoles: the model worker's own holeFeatures, on the shape
 * the worker would hold, read in-process. */
export async function deriveHolesInProcess(geoId: string): Promise<import('../../types').HoleFeature[]> {
  const bytes = await solidStepBytes(geoId)
  if (!bytes) throw new Error(`heightScenario: no STEP bytes for ${geoId}`)
  const { readStepShape } = await import('../../lib/cam/geometry/occt/model/core')
  const { holeFeatures } = await import('../../lib/cam/geometry/occt/model/derive')
  const oc = await occtModel()
  const { shape } = readStepShape(oc, new Uint8Array(bytes), 'part.step')
  try {
    return holeFeatures(oc, shape)
  } finally {
    shape.delete()
  }
}

let cam3dClient: Cam3dClientType | undefined
let cam3dClientPromise: Promise<void> | undefined

/** Build the in-process cam3d client once: the real BvhKernel and the real
 * opencamlib slicer behind a Cam3dDispatcher, over an in-process channel. */
export async function prepareInProcessCam3dClient(): Promise<void> {
  cam3dClientPromise ??= (async () => {
    const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
    const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
    const { Cam3dClient } = await import('../../cam3d/worker/client')
    const { createOclWaterlineSlicer } = await import('../../cam3d/kernel/oclWaterline')
    const { createRequire } = await import('node:module')
    const nodeRequire = createRequire(import.meta.url)
    const slicer = createOclWaterlineSlicer({
      load: async () => nodeRequire('@opencamlib/opencamlib/lib/emscripten/index.js') as never,
    })
    const fakeWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as never) },
      terminate(): void {},
    }
    const dispatcher = new Cam3dDispatcher(new BvhKernel(), (message: unknown) => {
      fakeWorker.onmessage?.({ data: message } as MessageEvent)
    }, { slicer })
    cam3dClient = new Cam3dClient(fakeWorker as never)
  })()
  await cam3dClientPromise
}

/** appClient.getCam3dClient. */
export function inProcessCam3dClient(): Cam3dClientType {
  if (!cam3dClient) throw new Error('heightScenario: prepareInProcessCam3dClient() has not run')
  return cam3dClient
}

const solidMeshCache = new Map<SolidPartName, Promise<PartMesh>>()
/** The part's mesh, for its bounding box only (the store tessellates its own). */
export function solidMesh(part: SolidPartName): Promise<PartMesh> {
  let cached = solidMeshCache.get(part)
  if (!cached) {
    cached = readRepoBytes(SOLID_FILES[part]).then(bytes => tessellateSolid({ format: 'step', bytes }, 0.1))
    solidMeshCache.set(part, cached)
  }
  return cached
}

function solidGeometry(scenario: SolidScenario, mesh: PartMesh): ImportedGeometry {
  const [minX, minY, minZ] = mesh.bounds.min
  const [maxX, maxY, maxZ] = mesh.bounds.max
  return {
    id: GEO_ID, name: scenario.part, filename: `${scenario.part}.step`, type: 'brep', format: 'step',
    boundingBox: {
      min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    },
    // A B-rep keeps its model coordinates; the row position seats the part's
    // lowest point at the scenario's machine Z (the "Drop to floor" placement).
    position: { x: 0, y: 0, z: scenario.z - minZ }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as unknown as ImportedGeometry
}

function solidTool(op: SolidOperation, index: number): Tool {
  const type = op.kind === 'drill' ? 'drill' : op.kind === 'parallel_3d' ? 'ball_end_mill' : 'flat_end_mill'
  return {
    id: `tool-${index + 1}`, name: `${type} ${op.toolDiameter}`, type, diameter: op.toolDiameter,
    fluteLength: 40, shankDiameter: op.toolDiameter, overallLength: 80, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', toolNumber: index + 1, notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 1200, plungeRate: 400, depthOfCut: 2, stepover: op.toolDiameter * 0.4 },
    },
  } as unknown as Tool
}

async function authorSolidOperation(spec: SolidOperation, index: number, setup: Setup): Promise<Operation> {
  const smart = await import('../../lib/cam/smartHeights')
  const setupIntent = setupDefaultHeightIntent(setup)
  // WO-1622: Adaptive 3D's own Clearance/Retract/Feed row, set the way the
  // 2D authoring path's SafetyRowOverride writes it (operationSafetyHeightIntent
  // projects the 'user' provenance onto whichever plane the operator touched).
  const safetyOverridePlanes = new Set<'clearance' | 'retract' | 'feed'>()
  if (spec.kind === 'adaptive_3d' && spec.safetyOverride) {
    const { plane, reference, offsetMm } = spec.safetyOverride
    setupIntent[plane] = { reference, offset: offsetMm, provenance: 'user' }
    safetyOverridePlanes.add(plane)
  }
  const safetyIntent = operationSafetyHeightIntent(setupIntent, safetyOverridePlanes)
  const base = {
    id: `op-${index + 1}`, enabled: true, status: 'pending' as const, toolId: `tool-${index + 1}`,
    passes: { ...defaultPasses }, linking: { ...defaultLinking }, geometrySelections: [GEO_ID],
  }
  // The dialog's projectFamily(): a fresh op's heights come from the Setup intent.
  const draftHeights = (params: Record<string, unknown>) => ({
    ...defaultHeights,
    ...deriveOperationHeightDraft({ operationType: spec.kind, setupIntent, currentParams: params }).heights,
  })

  if (spec.kind === 'adaptive_3d') {
    const { DEFAULT_ADAPTIVE3D_PARAMS } = await import('../../cam3d/integration/adaptive3dOperation')
    const params = {
      ...DEFAULT_ADAPTIVE3D_PARAMS, ...(spec.params ?? {}),
      ...(spec.axialStockToLeave !== undefined ? { axialStockToLeave: spec.axialStockToLeave } : {}),
    } as unknown as Record<string, unknown>
    return {
      ...base, name: `3D Rough ${index + 1}`, type: 'adaptive_3d', heights: draftHeights(params), params,
      smartHeight: {
        kind: 'smart_v2',
        intent: smart.buildAdaptive3dSmartIntent({
          setupId: setup.id, geometryIds: [GEO_ID], safetyIntent, mode: spec.source,
          boundedBand: spec.source === 'bounded_band' ? spec.band : undefined,
        }),
      },
    } as unknown as Operation
  }
  if (spec.kind === 'parallel_3d' || spec.kind === 'waterline_3d') {
    const parallel = spec.kind === 'parallel_3d'
    const defaults = parallel
      ? (await import('../../cam3d/integration/parallel3dOperation')).DEFAULT_PARALLEL3D_PARAMS
      : (await import('../../cam3d/integration/waterline3dOperation')).DEFAULT_WATERLINE_PARAMS
    const params = { ...defaults, ...(spec.params ?? {}) } as unknown as Record<string, unknown>
    const input = {
      setupId: setup.id, geometryIds: [GEO_ID], safetyIntent,
      finishDepthMm: params.finishDepth as number | undefined,
    }
    return {
      ...base,
      name: parallel ? `3D Finish ${index + 1}` : `Waterline Finish ${index + 1}`,
      type: spec.kind, heights: draftHeights(params), params,
      smartHeight: {
        kind: 'smart_v2',
        intent: parallel ? smart.buildParallel3dSmartIntent(input) : smart.buildWaterline3dSmartIntent(input),
      },
    } as unknown as Operation
  }

  // Drill: the dialog's "Detect holes" (deriveBrepLayer 'holes'), then the
  // operator's pick among the detected circles.
  const layersBefore = useCamStore.getState().project.geometry.find(g => g.id === GEO_ID)?.layers2d?.length ?? 0
  await useCamStore.getState().deriveBrepLayer(GEO_ID, 'holes')
  const geo = useCamStore.getState().project.geometry.find(g => g.id === GEO_ID)!
  const layer = (geo.layers2d ?? []).slice(layersBefore)[0]
  if (!layer) throw new Error('Detect holes landed no layer.')
  const loopIds = (layer.holes ?? [])
    .filter(hole => !spec.holeDiameters || spec.holeDiameters.some(d => Math.abs(d - hole.diameter) < 0.01))
    .map(hole => hole.loopId)
    .filter((id): id is string => Boolean(id))
  const params = { ...defaultDrillParams, geometryId: GEO_ID, loopIds }
  const draft = deriveOperationHeightDraft({
    operationType: 'drill', setupIntent, currentParams: params as unknown as Record<string, unknown>,
  })
  const featureReady = deriveDrillBoreFeatureBindings([geo], loopIds, 'drill').ok
  const selection = selectStartingHeightPolicy('drill', {
    hasSetupStock: Boolean(setupProvenStockId(setup, useCamStore.getState().project)),
    hasSelectedGeometry: true, hasSelectedFeature: featureReady,
    hasTargetSurface: true, explicitEndConfirmed: false,
  })
  const mode = selection.variant === 'detected_features' ? 'detected_features' as const : 'explicit_depth' as const
  return {
    ...base, name: `Drill ${index + 1}`, type: 'drill', geometrySelections: [...loopIds],
    heights: { ...defaultHeights, ...draft.heights },
    // runBrepDerive('holes') turns per-hole depth on when holes were found.
    params: { ...params, ...draft.paramsPatch, perHoleDepth: true } as unknown as Record<string, unknown>,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreAuthoringIntent({
        operationType: 'drill', setupId: setup.id, safetyIntent, geometries: [geo],
        selectedLoopIds: loopIds,
        draft: { mode, explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
        perFeatureEndOverridesWcsMm: params.perHoleDepthOverrides,
      }),
    },
  } as unknown as Operation
}

/** Build the solid project, then author and compute every operation in order,
 * each one added to the Setup only after the one before it has computed (the
 * way an operator builds a sequence). */
export async function runSolidScenario(scenario: SolidScenario): Promise<SolidOperationReading[]> {
  await prepareInProcessCam3dClient()
  const mesh = await solidMesh(scenario.part)
  solidFileByGeometryId = new Map([[GEO_ID, SOLID_FILES[scenario.part]]])
  const { setup, stockId } = buildProjectFrom({
    tools: scenario.operations.map(solidTool), geometry: solidGeometry(scenario, mesh),
    stock: scenario.stock, workholding: scenario.workholding,
  })
  const bounds = smartHeightStockBounds(useCamStore.getState().project, stockId)
  if (!bounds) throw new Error('heightScenario: the store could not prove the solid stock bounds')
  const origin = setup.wcs.origin
  const stockXY = {
    minX: bounds.min.x - origin.x, maxX: bounds.max.x - origin.x,
    minY: bounds.min.y - origin.y, maxY: bounds.max.y - origin.y,
  }
  const wh = scenario.workholding
  const workholdingWcs = wh ? {
    min: { x: wh.min.x - origin.x, y: wh.min.y - origin.y, z: wh.min.z - origin.z },
    max: { x: wh.max.x - origin.x, y: wh.max.y - origin.y, z: wh.max.z - origin.z },
  } : undefined
  const partBottomWcs = scenario.z - origin.z
  const partTopWcs = partBottomWcs + (mesh.bounds.max[2] - mesh.bounds.min[2])
  const consoleLines = () =>
    ((useCamStore.getState() as unknown as { consoleEvents?: Array<{ message: string }> }).consoleEvents ?? [])
      .map(event => event.message)

  const readings: SolidOperationReading[] = []
  for (let index = 0; index < scenario.operations.length; index++) {
    const spec = scenario.operations[index]
    const opId = `op-${index + 1}`
    const consoleBefore = consoleLines().length
    const frame = {
      opId, kind: spec.kind, partTopWcs, partBottomWcs, workholdingWcs, stockXY,
      stockTopWcs: bounds.max.z - origin.z, stockBottomWcs: bounds.min.z - origin.z,
      stockTopMachineZ: bounds.max.z, stockBottomMachineZ: bounds.min.z, wcsOriginMachineZ: origin.z,
    }
    try {
      const current = useCamStore.getState().project.setups.find(s => s.id === setup.id)!
      useCamStore.getState().addOperation(setup.id, await authorSolidOperation(spec, index, current))
    } catch (error) {
      readings.push({
        ...frame, status: 'error', moves: [], worldMoves: [], consoleMessages: [],
        authoringError: error instanceof Error ? error.message : String(error),
        deepestCutMachineZ: NaN, deepestCutZ: NaN, highestCuttingZ: NaN, lowestRapidZ: NaN,
        lowestRapidOverStockZ: NaN, heightsRow: {},
      })
      continue
    }
    await useCamStore.getState().computeOperationToolpath(setup.id, opId)

    const project = useCamStore.getState().project
    const computed = project.setups.find(s => s.id === setup.id)!.operations.find(o => o.id === opId)!
    const worldMoves = computed.toolpathMoves ?? []
    const moves = worldMoves.map(m => ({ ...m, ...toWork(m, setup.wcs) }))
    const family: ScenarioOperation | undefined = spec.kind === 'drill' ? 'drill' : undefined
    const rapids = moves.filter(isRapid)
    const overStock = (m: ToolpathMove) =>
      m.x > stockXY.minX && m.x < stockXY.maxX && m.y > stockXY.minY && m.y < stockXY.maxY
    // A 3D path can carry 100k moves: no spread into Math.min / Math.max.
    const min = (values: number[]) => values.length ? values.reduce((a, b) => (b < a ? b : a)) : NaN
    const max = (values: number[]) => values.length ? values.reduce((a, b) => (b > a ? b : a)) : NaN
    const plan = computed.resolvedHeightPlan?.version === 2 ? computed.resolvedHeightPlan : undefined
    const bottomRow = plan?.machining.cutterCenterEnd?.wcsMm
      ?? plan?.machining.featureEndpoints?.reduce<number | undefined>(
        (lowest, endpoint) => lowest === undefined
          ? endpoint.cutterCenterEnd.wcsMm
          : Math.min(lowest, endpoint.cutterCenterEnd.wcsMm),
        undefined,
      )
      ?? plan?.machining.physicalTarget?.wcsMm
    const geo = project.geometry.find(g => g.id === GEO_ID)!
    readings.push({
      ...frame,
      status: computed.status, errorMessage: computed.errorMessage,
      worldMoves, moves,
      holes: spec.kind === 'drill'
        ? (geo.layers2d ?? []).flatMap(layer => layer.holes ?? []).map(hole => ({
            center: hole.center, diameter: hole.diameter, through: hole.through,
            topWcs: hole.topZ + geo.position.z - origin.z, bottomWcs: hole.bottomZ + geo.position.z - origin.z,
          }))
        : undefined,
      consoleMessages: consoleLines().slice(consoleBefore),
      deepestCutMachineZ: min(worldMoves.filter(m => !isRapid(m)).map(m => m.z)),
      deepestCutZ: min(moves.filter(m => !isRapid(m)).map(m => m.z)),
      highestCuttingZ: max(moves.filter(m => isCutting(m, family)).map(m => m.z)),
      lowestRapidZ: min(rapids.map(m => m.z)),
      lowestRapidOverStockZ: min(rapids.filter(overStock).map(m => m.z)),
      plan,
      heightsRow: {
        top: plan?.machining.materialStart.wcsMm, bottom: bottomRow,
        retract: plan?.safety.retract.wcsMm, clearance: plan?.safety.clearance.wcsMm,
      },
    })
  }
  return readings
}

/**
 * WO-1606: how far the cutter goes INTO the part, mm (0 = never). Every
 * non-rapid move is sampled every 0.25 mm along its segment and the exact
 * drop-cutter contact of the tool on the part mesh (the kernel's own contact
 * math, BvhKernel.dropPath) is compared with the tip Z. The moves are the raw
 * stored machine-frame moves; the part mesh sits at `partPositionZ`.
 */
export async function solidGougeMm(input: {
  part: SolidPartName
  partPositionZ: number
  worldMoves: readonly ToolpathMove[]
  cutter: { kind: 'flat' | 'ball'; diameter: number }
  /** Radial slack: the cutter is measured this much smaller in radius, so a
   * wall the tool only touches is not read as a cut into it. */
  shrinkMm?: number
  /** Material the tool must leave above the surface (axial stock to leave). */
  leaveMm?: number
  /** Measure rapids too (a rapid must never pass through the part either). */
  includeRapids?: boolean
}): Promise<{ maxGougeMm: number; samplesOverPart: number; worst?: { x: number; y: number; z: number; contactZ: number; role?: string } }> {
  const mesh = await solidMesh(input.part)
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const kernel = new BvhKernel()
  const meshHandle = kernel.uploadMesh(mesh)
  const cutterHandle = kernel.makeCutter({
    kind: input.cutter.kind, diameter: input.cutter.diameter - 2 * (input.shrinkMm ?? 0),
  })
  const zSeed = mesh.bounds.min[2] - 1e4
  const points: Array<{ x: number; y: number; z: number; role?: string }> = []
  const moves = input.worldMoves
  for (let i = 1; i < moves.length; i++) {
    const b = moves[i]
    if (isRapid(b) && !input.includeRapids) continue
    const a = moves[i - 1]
    const z = (t: number) => a.z + (b.z - a.z) * t - input.partPositionZ - (input.leaveMm ?? 0)
    // An arc is sampled ON the arc about its centre. Stepping its end points in a
    // straight line cut the chord across a corner the tool actually goes round,
    // and read that chord as a gouge (WO-1614 disproved finding SH-4 this way).
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
      const radius = Math.hypot(a.x - b.cx, a.y - b.cy)
      const start = Math.atan2(a.y - b.cy, a.x - b.cx)
      let end = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw') { while (end <= start) end += 2 * Math.PI }
      else { while (end >= start) end -= 2 * Math.PI }
      const steps = Math.max(1, Math.ceil(Math.hypot(Math.abs(end - start) * radius, b.z - a.z) / 0.25))
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const angle = start + (end - start) * t
        points.push({ x: b.cx + radius * Math.cos(angle), y: b.cy + radius * Math.sin(angle), z: z(t), role: b.role })
      }
      continue
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.25))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: z(t), role: b.role })
    }
  }
  try {
    let maxGougeMm = 0
    let samplesOverPart = 0
    let worst: { x: number; y: number; z: number; contactZ: number; role?: string } | undefined
    const xy = new Float64Array(points.length * 2)
    points.forEach((p, i) => { xy[i * 2] = p.x; xy[i * 2 + 1] = p.y })
    const dropped = await kernel.dropPath(meshHandle, cutterHandle, xy, zSeed)
    points.forEach((p, i) => {
      if (dropped[i] <= zSeed) return
      samplesOverPart++
      if (dropped[i] - p.z > maxGougeMm) {
        maxGougeMm = dropped[i] - p.z
        worst = { x: p.x, y: p.y, z: p.z, contactZ: dropped[i], role: p.role }
      }
    })
    return { maxGougeMm, samplesOverPart, ...(worst ? { worst } : {}) }
  } finally {
    kernel.releaseCutter(cutterHandle)
    kernel.releaseMesh(meshHandle)
  }
}
