import type {
  ImportedGeometry,
  MachineConfig,
  Operation,
  PhysicalStock,
  Project,
  ResolvedHeightSnapshotV1,
  SceneStock,
  Setup,
  Tool,
} from '../../types'
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild'
import { normalizeToolCutHand } from '../tool/cutHand'
import { validatePersistedSmartHeightState } from './smartHeights/authority'

// Dependency inversion keeps the current engine independent of src/kernel.
// The composition root installs the same resolver used at the compute seam.
let generationEngineId: (type: Operation['type']) => string = () => 'current'
export function setGenerationEngineResolver(resolve: (type: Operation['type']) => string): void {
  generationEngineId = resolve
}

// WO-3153: the engine id names WHICH planner ran, never which version of it, so
// a path an older planner saved read as current beside a fresh one (Full
// Suite's Adaptive Clearing 1: 10 saved rapids, 2,736 today, one stamp). Every
// operation type names its generator revision here; the complete Record makes
// a new type impossible to add without one. A planner whose output changes for
// the same authored inputs bumps its entry, and a path saved before the bump
// then regenerates once (ADR-0040). Revision 1 is each planner as the stamp
// first hashed it and stays out of the stamp, so an unchanged planner's saved
// paths stay current.
//
// A number, not a hash of each planner's source: 327 commits touched the engine
// sources in the 14 days to 2026-10-27, nearly all through linking, entry and
// geometry code every family imports. A source hash would stale every saved
// path in every project about 23 times a day, comments and refactors included.
const GENERATOR_REVISIONS: Record<Operation['type'], number> = {
  face: 1,
  // Full Suite's Contour 2 moved under Generate All with its stamp unchanged.
  contour_2d: 2,
  pocket_2d: 1,
  // 2D adaptive linking/entry changed after Full Suite's 2026-10-16 regen
  // (WO-3054, WO-3056, WO-3083 among them).
  adaptive_clearing_2d: 2,
  // Full Suite's Drill 2 moved under Generate All with its stamp unchanged.
  drill: 2,
  bore: 1,
  thread_mill: 1,
  engrave: 1,
  vcarve: 1,
  chamfer: 1,
  pattern: 1,
  // Full Suite's 3D Finish 3 moved under Generate All with its stamp unchanged.
  parallel_3d: 2,
  waterline_3d: 1,
  // Full Suite's X part - 6mm rough and 3D Rough 1 moved the same way.
  adaptive_3d: 2,
  scallop_3d: 1,
  steep_shallow_3d: 1,
  pencil_3d: 1,
}
export function generatorRevision(type: Operation['type']): number | undefined {
  const revision = GENERATOR_REVISIONS[type]
  return revision > 1 ? revision : undefined
}
/** Tests stamp a path as another revision of its planner would have. */
export function withGeneratorRevision<T>(type: Operation['type'], revision: number, run: () => T): T {
  const saved = GENERATOR_REVISIONS[type]
  GENERATOR_REVISIONS[type] = revision
  try { return run() } finally { GENERATOR_REVISIONS[type] = saved }
}

const SAVED_HEIGHT_EPSILON = 1e-6

const HEIGHT_PLANE_NAMES = [
  'clearance', 'retract', 'feed', 'top', 'bottom',
] as const

// The wired 3D strategies all start and end at the traverse plane (parallel and
// adaptive through cam3d/pathbuild, waterline through its own linker with the
// same contract, WO-1176). That anchor is what distinguishes the translated
// world-space moves from the local-space CAM-17 failure. Keep this deliberately
// narrower than the 2D operation matrix: range + WCS agreement is universal,
// while an exact clearance point is a strategy-specific invariant.
const CLEARANCE_ANCHORED_OPERATION_TYPES: ReadonlySet<Operation['type']> = new Set([
  'parallel_3d',
  'waterline_3d',
  'steep_shallow_3d',
  'scallop_3d',
  'pencil_3d',
  'adaptive_3d',
])

// WO-3039: the 3D finishes whose planner lifts its traverse plane on a proven
// stock top to max(Clearance, stock top + TRAVERSE_STANDOFF_MM) (cam3d/pathbuild
// and waterline/link, WO-127; the store passes the stock top only when
// resolveProvenCam3dStockBounds proves it). Adaptive 3D lifts on its retained
// material top instead, which the saved result does not record; it keeps the
// strict Clearance bound.
const STOCK_LIFTED_TRAVERSE_OPERATION_TYPES: ReadonlySet<Operation['type']> = new Set([
  'parallel_3d',
  'waterline_3d',
  'steep_shallow_3d',
  'scallop_3d',
  'pencil_3d',
])

// WO-3196: the strategies that machine the part mesh a second side hands them
// turned over (store cam3dPartAsSetupHoldsIt). The turn is an input of their
// result only; every other family reads the same claim as before, and a first
// side has no flipOf, which canonical() drops.
const TURNED_PART_OPERATION_TYPES: ReadonlySet<Operation['type']> = new Set([
  'parallel_3d',
  'waterline_3d',
  'steep_shallow_3d',
  'scallop_3d',
  'pencil_3d',
  'adaptive_3d',
])

function finiteSavedHeightPlanes(value: unknown): value is Record<(typeof HEIGHT_PLANE_NAMES)[number], number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return HEIGHT_PLANE_NAMES.every((name) => Number.isFinite(record[name]))
}

/**
 * WO-3039. The proven stock top, in machine Z, for the operation's target
 * geometry, read from the project records the fingerprint already hashes
 * (setup WCS, geometry, stocks): the setup-bound stock must be the stock the
 * target geometry belongs to (the store's resolveProvenCam3dStockBounds gate),
 * and its persisted world box gives the top. lib/cam may not import the store's
 * resolver, so anything this cannot prove from the records - no binding, a
 * different stock, a malformed box - returns undefined and keeps the strict
 * Clearance bound. A lifted path must also have a rapid AT the plane, so a top
 * that differs from the one the planner used fails toward "outdated", never
 * toward a false "current"; a path that stays at Clearance is judged as before.
 */
function provenStockTopMachineZ(
  project: Project,
  setup: Setup,
  operation: Operation,
): number | undefined {
  const wcs = setup.wcs
  // Same rule as post/workOffsets wcsBoundStockId.
  const boundStockId = wcs.originBinding !== undefined
    ? (wcs.originBinding.kind === 'stock_corner' || wcs.originBinding.kind === 'part_feature'
        ? wcs.originBinding.stockId
        : undefined)
    : wcs.stockId
  const geometryId = operation.geometrySelections?.[0]
  const geometry = geometryId ? project.geometry?.find((candidate) => candidate.id === geometryId) : undefined
  if (boundStockId === undefined || !geometry) return undefined
  const operationStockId = geometry.ownerNestId !== undefined
    ? (project.nests ?? []).find((nest) => nest.id === geometry.ownerNestId)?.boundStockId
    : geometry.stockId
  if (operationStockId !== boundStockId) return undefined

  let bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | undefined
  const stocks = project.stocks ?? []
  if (stocks.length > 0) {
    const active = stocks.find((stock) => stock.id === boundStockId)
    if (!active?.bounds) return undefined
    // Same frames as store/stockAssignment stockWorldBounds.
    bounds = active.mode === 'explicit'
      ? {
          min: { ...active.position },
          max: {
            x: active.position?.x + active.bounds.size?.x,
            y: active.position?.y + active.bounds.size?.y,
            z: active.position?.z + active.bounds.size?.z,
          },
        }
      : { min: { ...active.bounds.min }, max: { ...active.bounds.max } }
  } else {
    if (project.sceneStock?.mode !== 'fixed') return undefined
    const active = (project.sceneStock.fixedStocks ?? []).find((stock) => stock.id === boundStockId)
    if (!active?.position) return undefined
    bounds = {
      min: { ...active.position },
      max: {
        x: active.position.x + active.width,
        y: active.position.y + active.height,
        z: active.position.z + active.depth,
      },
    }
  }
  if (
    ![bounds.min?.x, bounds.min?.y, bounds.min?.z, bounds.max?.x, bounds.max?.y, bounds.max?.z]
      .every((value) => Number.isFinite(value)) ||
    !(bounds.max.x > bounds.min.x && bounds.max.y > bounds.min.y && bounds.max.z > bounds.min.z)
  ) return undefined
  return bounds.max.z
}

/** WO-3039. The plane the planner sent this operation's rapids to. */
function savedTraversePlaneMachineZ(
  project: Project,
  setup: Setup,
  operation: Operation,
  clearance: number,
): number {
  if (!STOCK_LIFTED_TRAVERSE_OPERATION_TYPES.has(operation.type)) return clearance
  const stockTop = provenStockTopMachineZ(project, setup, operation)
  return stockTop === undefined ? clearance : Math.max(clearance, stockTop + TRAVERSE_STANDOFF_MM)
}

/**
 * CAM-17 persisted-result contract. The generation fingerprint proves that the
 * authored inputs and saved height snapshot still match. This companion check
 * proves that the saved moves actually live in that snapshot's MACHINE frame.
 *
 * Toolpaths are stored after world placement, so every saved move must be
 * contained by machine bottom/clearance. The wired 3D path builder additionally
 * guarantees an explicit rapid at clearance; checking that anchor catches a
 * translated local-Z path that can otherwise fit inside a wide envelope. The
 * machine/WCS records must differ by the setup WCS origin for every plane. Any
 * malformed legacy shape returns false rather than throwing on the file-open
 * path.
 *
 * WO-3039: a 3D finish over a proven stock top travels at
 * max(Clearance, stock top + standoff), not at Clearance. Rapids are bounded
 * by that resolved traverse plane, and a path with any rapid above Clearance
 * must have one AT that plane; every other move stays bounded by Clearance.
 * Without a proven stock top the plane IS Clearance and the rule is unchanged.
 */
function savedToolpathMatchesHeightSnapshot(
  project: Project,
  setup: Setup,
  operation: Operation,
  allowEmpty = false,
): boolean {
  const snapshot = operation.resolvedHeights
  const moves = operation.toolpathMoves
  const wcsOriginZ = setup?.wcs?.origin?.z
  if (
    snapshot?.version !== 1 ||
    !finiteSavedHeightPlanes(snapshot.wcs) ||
    !finiteSavedHeightPlanes(snapshot.machine) ||
    !Number.isFinite(wcsOriginZ) ||
    !Array.isArray(moves)
  ) return false

  const { clearance, retract, feed, top, bottom } = snapshot.machine
  if (
    clearance + SAVED_HEIGHT_EPSILON < retract ||
    retract + SAVED_HEIGHT_EPSILON < feed ||
    feed + SAVED_HEIGHT_EPSILON < top ||
    top + SAVED_HEIGHT_EPSILON < bottom
  ) return false

  for (const name of HEIGHT_PLANE_NAMES) {
    if (Math.abs((snapshot.machine[name] - snapshot.wcs[name]) - wcsOriginZ) > SAVED_HEIGHT_EPSILON) {
      return false
    }
  }

  // Live consumers need to distinguish a current operation that legitimately
  // produced no moves from a stale operation. Preserve that distinction so
  // Post can report OP_NO_TOOLPATH. Persisted-project reconciliation remains
  // strict and rejects an empty saved result because there is no path evidence
  // to validate after a reload.
  if (moves.length === 0) return allowEmpty

  const traverse = savedTraversePlaneMachineZ(project, setup, operation, clearance)
  let hasClearanceRapid = false
  let hasTraverseRapid = false
  let rapidAboveClearance = false
  for (const move of moves) {
    if (!move || typeof move !== 'object' || !Number.isFinite(move.z)) return false
    const ceiling = move.type === 'rapid' ? traverse : clearance
    if (move.z < bottom - SAVED_HEIGHT_EPSILON || move.z > ceiling + SAVED_HEIGHT_EPSILON) {
      return false
    }
    if (move.type !== 'rapid') continue
    if (Math.abs(move.z - clearance) <= SAVED_HEIGHT_EPSILON) hasClearanceRapid = true
    if (Math.abs(move.z - traverse) <= SAVED_HEIGHT_EPSILON) hasTraverseRapid = true
    if (move.z > clearance + SAVED_HEIGHT_EPSILON) rapidAboveClearance = true
  }
  // A path that never rises above Clearance is judged exactly as before
  // WO-3039, so nothing current today goes outdated. A lifted path must reach
  // the resolved traverse plane itself.
  if (rapidAboveClearance) return hasTraverseRapid
  return !CLEARANCE_ANCHORED_OPERATION_TYPES.has(operation.type) || hasClearanceRapid
}

// v3 (WO-1883): geometry is hashed through geometryGenerationInputs, not as
// the raw array. Stamps written by v2 recompute once (ADR-0040).
export const CAM_GENERATION_CONTRACT_VERSION = 4

export interface GenerationFingerprintInput {
  operation: Operation
  setup: Setup
  tool: Tool | undefined
  resolvedHeights: ResolvedHeightSnapshotV1
  geometry: readonly ImportedGeometry[]
  stocks: readonly PhysicalStock[]
  sceneStock: SceneStock
  machine: MachineConfig
  /** Ordered enabled operations before a generation-order-dependent operation. */
  predecessors?: readonly OperationPredecessorFingerprint[]
}

export interface OperationPredecessorFingerprint {
  id: string
  fingerprint: string
}

/** Live store calls provide this; saved-file reconciliation uses the project snapshot. */
type ToolResolver = (toolId: string) => Tool | undefined

/**
 * WO-1208 introduces this persisted operation field structurally because the
 * shared Operation interface is outside this work order's owned paths. WO-1210
 * owns that interface and can promote the field there with its rest-machining
 * UI. Until then, old Operation records remain valid and byte-identical.
 */
type PredecessorDependentOperation = Operation & {
  dependsOnPredecessors?: boolean
}

export function operationDependsOnPredecessors(operation: Operation): boolean {
  return (operation as PredecessorDependentOperation).dependsOnPredecessors === true
    || hasTabRemovalSource(operation)
}

/**
 * WO-3221: a tab removal contour is made from an earlier tabbed Contour, so it
 * reads that operation's live inputs through the predecessor fingerprints:
 * reordering, suppressing, deleting or editing the source outdates it, on the
 * store's compute path and on a saved file's reconciliation alike. The
 * binding is authored data, so no regeneration's derived flag can erase it.
 * Any value present counts, even one too malformed to compute from.
 */
function hasTabRemovalSource(operation: Operation): boolean {
  return operation.type === 'contour_2d'
    && (operation.params as { tabRemovalSource?: unknown } | undefined)?.tabRemovalSource !== undefined
}

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : value
  }
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

interface HashState { a: number; b: number }
function hashTextState(text: string, state?: HashState): HashState {
  let a = state?.a ?? 0x811c9dc5
  let b = state?.b ?? 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return { a, b }
}
function hashText(text: string, state?: HashState): string {
  const { a, b } = hashTextState(text, state)
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

function operationGenerationInputs(operation: Operation): Record<string, unknown> {
  return {
    id: operation.id,
    type: operation.type,
    enabled: operation.enabled,
    toolId: operation.toolId,
    geometrySelections: operation.geometrySelections,
    modelReferences: operation.modelReferences,
    // Smart Height V2 intent and the resolved snapshot below are the complete
    // height authority. Legacy scalar planes are intentionally excluded so
    // mutating stale V1 data cannot alter a valid V2 generation claim.
    smartHeight: operation.smartHeight,
    // WO-3104: independent operator travel policy, not a legacy scalar plane.
    // Omit checked/default so saved claims and programs retain their identity.
    ...(operation.heights?.minimizeZTravel === false
      ? { minimizeZTravel: false } : {}),
    passes: operation.passes,
    linking: operation.linking,
    feedrateOverride: operation.feedrateOverride,
    params: operation.params,
  }
}

/**
 * WO-1883: the geometry a generated toolpath depends on, without presentation.
 * Hashing the raw geometry array made renaming or recolouring ANY part outdate
 * EVERY operation, and Post then refused with OP_OUTDATED until everything was
 * recomputed - a refusal of a post the software can do (rule 11).
 *
 * Scene scope per operation family (which parts an operation's hash reads):
 *
 *   family                          | reads                  | why
 *   --------------------------------|------------------------|-------------------------------
 *   2D (contour, pocket, drill, ...) | every part's cut shape | all-parts ('__all__') cuts,
 *                                   |                        | owning-stock and model_top
 *                                   |                        | aggregates, stock sizing
 *   3D strategies (*_3d)            | every part's cut shape | the whole-scene mesh/stock
 *   rest / predecessor-dependent    | every part's cut shape | plus predecessor fingerprints
 *   nest seed operations            | every part's cut shape | seed copies are parts too
 *
 * Every family reads the whole scene's SHAPE and PLACEMENT, so moving any part
 * still outdates every operation, exactly as before. What no family reads is
 * presentation: a part's name, filename, colour, folder and position lock,
 * a loop's name, a layer's name and colour. Those never reach the hash.
 *
 * `hidden` is presentation EXCEPT for an operation that does not name one
 * specific part: the all-parts resolver omits hidden parts from the cut
 * (store/index.ts, the '__all__' filter), so hide/show changes what such an
 * operation cuts and stays in its hash.
 */
function hiddenDecidesWhatOperationCuts(operation: Operation): boolean {
  const geometryId = (operation.params as { geometryId?: unknown } | undefined)?.geometryId
  return typeof geometryId !== 'string' || geometryId === '' || geometryId === '__all__'
}

function geometryGenerationInputs(
  geometry: readonly ImportedGeometry[],
  operation: Operation,
): unknown[] {
  const keepHidden = hiddenDecidesWhatOperationCuts(operation)
  return geometry.map((part) => {
    const {
      name: _name,
      filename: _filename,
      color: _color,
      hidden,
      folderId: _folderId,
      locked: _locked,
      loops,
      layers2d,
      ...cutInputs
    } = part
    return {
      ...cutInputs,
      // Hide then show leaves `hidden: false`; that is the same cut as absent.
      ...(keepHidden && hidden === true ? { hidden: true } : {}),
      loops: loops?.map(({ name: _loopName, ...loop }) => loop),
      layers2d: layers2d?.map(({ name: _layerName, color: _layerColor, ...layer }) => layer),
    }
  })
}

/**
 * Machine inputs that can change an already-computed CAM result. The spindle
 * link is controller/session configuration: bridge connect legitimately seeds
 * or re-confirms it, but it does not change toolpath moves, heights, feeds or
 * cut-time estimates. Hashing it made a connection alone invalidate every
 * operation in the project (WO-1334). The tool table's measured lengths and
 * the probe choices are the same kind of record: the Control tab writes them
 * (measuring a tool; WO-1978's program load adding the program's tools) and no
 * CAM computation reads them. Hashing them made measuring one tool mark every
 * toolpath in the project outdated.
 */
function machineGenerationInputs(machine: MachineConfig): Record<string, unknown> {
  const {
    spindleLinkDefinition: _connectionManagedSpindleLink,
    toolTable: _toolTable,
    probeOverrides: _probeOverrides,
    probePads: _probePads,
    activeProbePadId: _activeProbePadId,
    ...generationInputs
  } = machine
  return generationInputs
}

/** WO-1334's selector, the one fingerprints were written with until WO-1978. */
function machineGenerationInputsBeforeWo1978(machine: MachineConfig): Record<string, unknown> {
  const { spindleLinkDefinition: _connectionManagedSpindleLink, ...generationInputs } = machine
  return generationInputs
}

type MachineGenerationInputSelector = (machine: MachineConfig) => unknown
type ToolGenerationInputSelector = (tool: Tool | undefined) => unknown

/**
 * Tool input as every CAM consumer sees it. Legacy tools omitted `cutHand`,
 * while the project-open migration materializes that same right-hand default.
 * Hash the semantic value so serializing and reopening cannot outdate an
 * unchanged toolpath merely by making the default explicit.
 */
function toolGenerationInputs(tool: Tool | undefined): unknown {
  return tool === undefined
    ? undefined
    : { ...tool, cutHand: normalizeToolCutHand(tool.cutHand) }
}

/** WO-2027's legacy selector: fingerprints written while right hand was absent. */
function toolGenerationInputsBeforeWo2027(tool: Tool | undefined): unknown {
  if (tool === undefined || normalizeToolCutHand(tool.cutHand) !== 'right') return tool
  const { cutHand: _migrationMaterializedDefault, ...legacyInputs } = tool
  return legacyInputs
}

// WO-3126: sorting/cloning/stringifying the same display tessellation for
// every operation dominated publication. Reference identity selects a witness,
// never proves currency: inspect all live content, including raw nested and
// typed-array edits, before reusing the exact canonical JSON bytes.
interface GeometryJson { witness: unknown; text: string; prefixes: Map<string, HashState> }
const geometryJson = new WeakMap<readonly ImportedGeometry[], Map<boolean, GeometryJson>>()
function sameGeometryData(live: unknown, witness: unknown): boolean {
  if (Object.is(live, witness)) return true
  if (!live || !witness || typeof live !== 'object' || typeof witness !== 'object') return false
  if (ArrayBuffer.isView(live) || ArrayBuffer.isView(witness)) {
    if (!ArrayBuffer.isView(live) || !ArrayBuffer.isView(witness)) return false
    const a = live as unknown as ArrayLike<number>, b = witness as unknown as ArrayLike<number>
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(live) || Array.isArray(witness)) {
    if (!Array.isArray(live) || !Array.isArray(witness) || live.length !== witness.length) return false
    for (let i = 0; i < live.length; i++) if (!sameGeometryData(live[i], witness[i])) return false
    return true
  }
  const a = live as Record<string, unknown>, b = witness as Record<string, unknown>
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !sameGeometryData(a[key], b[key])) return false
  }
  return true
}
function canonicalGeometryJson(geometry: readonly ImportedGeometry[], operation: Operation): GeometryJson {
  const mode = hiddenDecidesWhatOperationCuts(operation)
  let modes = geometryJson.get(geometry)
  const cached = modes?.get(mode)
  if (cached && sameGeometryData(geometry, cached.witness)) return cached
  const text = JSON.stringify(canonical(geometryGenerationInputs(geometry, operation)))
  modes ??= new Map()
  const entry = { witness: structuredClone(geometry), text, prefixes: new Map<string, HashState>() }
  modes.set(mode, entry)
  geometryJson.set(geometry, modes)
  return entry
}

function generationFingerprintWithMachineInputs(
  input: Omit<GenerationFingerprintInput, 'resolvedHeights'> & Partial<Pick<GenerationFingerprintInput, 'resolvedHeights'>>,
  selectMachineInputs: MachineGenerationInputSelector,
  selectToolInputs: ToolGenerationInputSelector = toolGenerationInputs,
): string {
  const { operation, predecessors, ...rest } = input
  const operationInputs = operationGenerationInputs(operation)
  const fields: Record<string, unknown> = {
    contractVersion: CAM_GENERATION_CONTRACT_VERSION,
    engineId: generationEngineId(operation.type),
    generatorRevision: generatorRevision(operation.type),
    operation: operationInputs,
    ...(operationDependsOnPredecessors(operation) && predecessors && predecessors.length > 0
      ? { predecessors }
      : {}),
    setup: {
      id: rest.setup.id, wcs: rest.setup.wcs, stock: rest.setup.stock,
      ...(TURNED_PART_OPERATION_TYPES.has(operation.type) ? { flipOf: rest.setup.flipOf } : {}),
    },
    tool: selectToolInputs(rest.tool),
    resolvedHeights: rest.resolvedHeights,
    geometry: null,
    stocks: rest.stocks,
    sceneStock: rest.sceneStock,
    machine: selectMachineInputs(rest.machine),
  }
  const geometry = canonicalGeometryJson(rest.geometry, operation)
  // Keep exactly canonical()'s locale ordering, omission and JSON encoding.
  const keys = Object.keys(fields).filter(key => fields[key] !== undefined)
    .sort((a, b) => a.localeCompare(b))
  const at = keys.indexOf('geometry')
  const encode = (key: string) => JSON.stringify(key) + ':' + JSON.stringify(canonical(fields[key]))
  const prefix = '{' + keys.slice(0, at).map(encode).join(',') + ',"geometry":'
  let state = geometry.prefixes.get(prefix)
  if (!state) {
    state = hashTextState(geometry.text, hashTextState(prefix))
    geometry.prefixes.set(prefix, state)
  }
  // Continue the identical two character-by-character hashes after geometry;
  // its bytes and their incoming hash state have already been proved exact.
  const suffix = ',' + keys.slice(at + 1).map(encode).join(',') + '}'
  return `camgen-v${CAM_GENERATION_CONTRACT_VERSION}-${hashText(suffix, state)}`
}

export function generationFingerprint(input: GenerationFingerprintInput): string {
  return generationFingerprintWithMachineInputs(input, machineGenerationInputs)
}

/**
 * How a predecessor that is computing RIGHT NOW counts. A result is stamped
 * with what it actually read: an earlier operation still computing had no
 * toolpath to read, so it counts as no result ('absent', the default). A check
 * also accepts the other reading ('ready'): a computing predecessor is
 * regenerating from inputs that are hashed here, so the result it is about to
 * publish is the one the later operation was built on (WO-2272).
 */
export type ComputingPredecessorReading = 'absent' | 'ready'

/**
 * WO-2272: an earlier operation enters a later one's claim through its INPUTS
 * and whether it currently has a result - never through what its compute
 * writes (resolved heights, its own fingerprint). Those were cleared the
 * moment it started computing, so computing an operation turned every
 * rest-stock operation after it outdated even when the new result was the old
 * one. The setup, stock, scene and machine are already in the later
 * operation's own claim; what is particular to the earlier operation is its
 * own inputs, its tool, and which hidden parts it cuts when it cuts all parts.
 */
function predecessorFingerprint(
  project: Project,
  candidate: Operation,
  computingReads: ComputingPredecessorReading,
  resolveTool: ToolResolver | undefined,
  selectToolInputs: ToolGenerationInputSelector,
): string {
  const tool = resolveTool
    ? resolveTool(candidate.toolId)
    : project.toolLibrary.find((libraryTool) => libraryTool.id === candidate.toolId)
  const hasResult = candidate.status === 'ready'
    || (candidate.status === 'computing' && computingReads === 'ready')
  return `camgen-predecessor-v2-${hashText(JSON.stringify(canonical({
    operation: operationGenerationInputs(candidate),
    engineId: generationEngineId(candidate.type),
    generatorRevision: generatorRevision(candidate.type),
    tool: selectToolInputs(tool),
    hiddenParts: hiddenDecidesWhatOperationCuts(candidate)
      ? project.geometry.filter((part) => part.hidden === true).map((part) => part.id)
      : undefined,
    result: hasResult ? 'ready' : 'none',
    dependsOnPredecessors: operationDependsOnPredecessors(candidate) || undefined,
  })))}`
}

function precedingOperationFingerprints(
  project: Project,
  setup: Setup,
  operation: Operation,
  resolveTool?: ToolResolver,
  selectToolInputs: ToolGenerationInputSelector = toolGenerationInputs,
  computingReads: ComputingPredecessorReading = 'absent',
): OperationPredecessorFingerprint[] | undefined {
  if (!operationDependsOnPredecessors(operation)) return undefined
  const operationIndex = setup.operations.findIndex((candidate) => candidate.id === operation.id)
  if (operationIndex <= 0) return undefined
  const predecessors = setup.operations
    .slice(0, operationIndex)
    .filter((candidate) => candidate.enabled)
    .map((candidate) => ({
      id: candidate.id,
      fingerprint: predecessorFingerprint(project, candidate, computingReads, resolveTool, selectToolInputs),
    }))
  return predecessors.length > 0 ? predecessors : undefined
}

function projectOperationFingerprintWithMachineInputs(
  project: Project,
  setup: Setup,
  operation: Operation,
  resolvedHeights: ResolvedHeightSnapshotV1,
  toolOverride?: Tool,
  resolveTool?: ToolResolver,
  selectMachineInputs: MachineGenerationInputSelector = machineGenerationInputs,
  selectToolInputs: ToolGenerationInputSelector = toolGenerationInputs,
  computingReads: ComputingPredecessorReading = 'absent',
): string {
  return generationFingerprintWithMachineInputs({
    operation,
    setup,
    tool: toolOverride ?? (resolveTool
      ? resolveTool(operation.toolId)
      : project.toolLibrary.find((tool) => tool.id === operation.toolId)),
    resolvedHeights,
    geometry: project.geometry,
    stocks: project.stocks ?? [],
    sceneStock: project.sceneStock,
    machine: project.machine,
    predecessors: precedingOperationFingerprints(
      project, setup, operation, resolveTool, selectToolInputs, computingReads,
    ),
  }, selectMachineInputs, selectToolInputs)
}

/** The claim a compute stamps: a computing predecessor counts as no result. */
export function projectOperationFingerprint(
  project: Project,
  setup: Setup,
  operation: Operation,
  resolvedHeights: ResolvedHeightSnapshotV1,
  toolOverride?: Tool,
  resolveTool?: ToolResolver,
): string {
  return projectOperationFingerprintWithMachineInputs(
    project, setup, operation, resolvedHeights, toolOverride, resolveTool,
  )
}

/**
 * WO-3153: what regenerating this operation reads - the claim a compute would
 * stamp, without the heights that compute resolves for itself. Equal keys mean
 * the same inputs; editing the operation, its tool, the scene, the machine or
 * an earlier result it reads changes the key.
 */
export function operationRegenerationInputsKey(
  project: Project,
  setup: Setup,
  operation: Operation,
  resolveTool?: ToolResolver,
): string {
  return generationFingerprintWithMachineInputs({
    operation,
    setup,
    tool: resolveTool
      ? resolveTool(operation.toolId)
      : project.toolLibrary.find((tool) => tool.id === operation.toolId),
    geometry: project.geometry,
    stocks: project.stocks ?? [],
    sceneStock: project.sceneStock,
    machine: project.machine,
    predecessors: precedingOperationFingerprints(project, setup, operation, resolveTool),
  }, machineGenerationInputs)
}

function hasComputingPredecessor(setup: Setup, operation: Operation): boolean {
  if (!operationDependsOnPredecessors(operation)) return false
  for (const candidate of setup.operations) {
    if (candidate.id === operation.id) return false
    if (candidate.enabled && candidate.status === 'computing') return true
  }
  return false
}

/**
 * WO-2272: does a stamped claim still describe this operation? It does when it
 * equals the claim a compute would stamp now, or - while an earlier operation
 * it was built on is recomputing - the claim with that predecessor's coming
 * result counted. A predecessor that settles to a different state (an error, a
 * changed input, a result where there was none) still breaks the claim.
 */
export function projectOperationFingerprintMatches(
  fingerprint: string | undefined,
  project: Project,
  setup: Setup,
  operation: Operation,
  resolvedHeights: ResolvedHeightSnapshotV1,
  toolOverride?: Tool,
  resolveTool?: ToolResolver,
): boolean {
  if (fingerprint === undefined) return false
  if (fingerprint === projectOperationFingerprint(
    project, setup, operation, resolvedHeights, toolOverride, resolveTool,
  )) return true
  return hasComputingPredecessor(setup, operation)
    && fingerprint === projectOperationFingerprintWithMachineInputs(
      project, setup, operation, resolvedHeights, toolOverride, resolveTool,
      machineGenerationInputs, toolGenerationInputs, 'ready',
    )
}

function isLegacyProjectOperationFingerprint(
  fingerprint: string | undefined,
  project: Project,
  setup: Setup,
  operation: Operation,
  resolvedHeights: ResolvedHeightSnapshotV1,
  toolOverride?: Tool,
  resolveTool?: ToolResolver,
): boolean {
  // Older fingerprints hashed the complete machine record (pre-WO-1334), the
  // tool table and probe records (pre-WO-1978), or a legacy right-hand tool
  // with `cutHand` absent (pre-WO-2027). Reconciliation accepts each exact
  // historical input combination once and rewrites it to the current
  // fingerprint. Live checks remain single-format so a later input change
  // cannot keep an un-migrated claim green.
  if (fingerprint === undefined) return false
  const machineSelectors: MachineGenerationInputSelector[] = [
    (machine) => machine,
    machineGenerationInputsBeforeWo1978,
  ]
  const toolSelectors: ToolGenerationInputSelector[] = [
    toolGenerationInputs,
    toolGenerationInputsBeforeWo2027,
  ]
  return machineSelectors.some((selectMachineInputs) =>
    toolSelectors.some((selectToolInputs) =>
      fingerprint === projectOperationFingerprintWithMachineInputs(
        project,
        setup,
        operation,
        resolvedHeights,
        toolOverride,
        resolveTool,
        selectMachineInputs,
        selectToolInputs,
      )))
}

function staleGeneratedOperation(operation: Operation): Operation {
  return {
    ...operation,
    status: 'outdated' as const,
    toolpathMoves: undefined,
    computeTimeMs: undefined,
    estimatedCutTimeMs: undefined,
    progress: undefined,
    progressPhase: undefined,
    resolvedHeightPlan: undefined,
    generationFingerprint: undefined,
    errorMessage: 'Saved toolpath inputs cannot be verified; regenerate this operation.',
  }
}

/**
 * Re-check only operations that opt into generation-order dependency. Store
 * mutations call this after constructing their next project, so reorder,
 * suppression, edit and delete observe the final ordered predecessor list in
 * the same atomic state write.
 */
function reconcileProjectPredecessorFreshness(
  project: Project,
  setupId: string,
  previousProject?: Project,
  resolveTool?: ToolResolver,
): Project {
  let changed = false
  const previousSetup = previousProject?.setups.find((setup) => setup.id === setupId)
  const previouslyDependentIds = new Set(
    previousSetup?.operations
      .filter(operationDependsOnPredecessors)
      .map((operation) => operation.id) ?? [],
  )
  const setups = project.setups.map((setup) => {
    if (setup.id !== setupId) return setup
    let setupChanged = false
    const operations = setup.operations.map((operation) => {
      if (
        operation.status !== 'ready' ||
        (!operationDependsOnPredecessors(operation) &&
          !previouslyDependentIds.has(operation.id)) ||
        operation.resolvedHeights?.version !== 1
      ) return operation
      const current = projectOperationFingerprint(
        project, setup, operation, operation.resolvedHeights, undefined, resolveTool,
      )
      if (operation.generationFingerprint === current) return operation
      // WO-2272: an earlier operation recomputing does not decide this one yet.
      if (projectOperationFingerprintMatches(
        operation.generationFingerprint,
        project, setup, operation, operation.resolvedHeights, undefined, resolveTool,
      )) return operation
      if (isLegacyProjectOperationFingerprint(
        operation.generationFingerprint,
        project, setup, operation, operation.resolvedHeights, undefined, resolveTool,
      )) {
        changed = true
        setupChanged = true
        return { ...operation, generationFingerprint: current }
      }
      changed = true
      setupChanged = true
      return staleGeneratedOperation(operation)
    })
    return setupChanged ? { ...setup, operations } : setup
  })
  return changed ? { ...project, setups } : project
}

export function reconcileProjectGenerationFreshness(
  project: Project,
  predecessorDependencySetupId?: string,
  previousProject?: Project,
  resolveTool?: ToolResolver,
): Project {
  if (predecessorDependencySetupId !== undefined) {
    return reconcileProjectPredecessorFreshness(
      project, predecessorDependencySetupId, previousProject, resolveTool,
    )
  }
  let changed = false
  const setups = project.setups.map((setup) => {
    let setupChanged = false
    const operations = setup.operations.map((operation) => {
      if (operation.status !== 'ready') return operation
      const current = operation.resolvedHeights
        && operation.resolvedHeightPlan?.version === 2
        && savedSmartHeightAuthorityIsCurrent(operation)
        ? projectOperationFingerprint(
            project, setup, operation, operation.resolvedHeights, undefined, resolveTool,
          )
        : null
      if (
        current !== null &&
        (operation.generationFingerprint === current ||
          projectOperationFingerprintMatches(
            operation.generationFingerprint,
            project, setup, operation, operation.resolvedHeights!, undefined, resolveTool,
          )) &&
        savedToolpathMatchesHeightSnapshot(project, setup, operation)
      ) return operation
      if (
        current !== null &&
        isLegacyProjectOperationFingerprint(
          operation.generationFingerprint,
          project, setup, operation, operation.resolvedHeights!, undefined, resolveTool,
        ) &&
        savedToolpathMatchesHeightSnapshot(project, setup, operation)
      ) {
        changed = true
        setupChanged = true
        return { ...operation, generationFingerprint: current }
      }
      changed = true
      setupChanged = true
      // CAM-12's stale-green rule applies here too: a downgrade must clear the
      // PRIOR compute claim in the same object, not just flip status, or the
      // Cut time / Computed cells keep showing a number the now-'outdated'
      // toolpath can no longer back up (the exact lie CAM-12 closed for the
      // toolpath-emptiness downgrade in store/index.ts's stripComputeClaim -
      // this is the same class of leak, one bounce over, for the fingerprint
      // downgrade this function owns).
      return staleGeneratedOperation(operation)
    })
    return setupChanged ? { ...setup, operations } : setup
  })
  return changed ? { ...project, setups } : project
}

/** A saved operation is only as current as the authority compute will accept:
 * the same validation the runtime boundary applies (kind, versions, active
 * variant, safety planes) plus the family match, so a load never reports
 * 'ready' for an operation the next compute refuses. */
function savedSmartHeightAuthorityIsCurrent(operation: Operation): boolean {
  const validated = validatePersistedSmartHeightState(operation.smartHeight)
  return validated.ok && validated.state.intent.policy.operationType === operation.type
}

export function operationGenerationIsCurrent(
  project: Project,
  setup: Setup,
  operation: Operation,
): boolean {
  return operation.status === 'ready'
    && savedSmartHeightAuthorityIsCurrent(operation)
    && operation.resolvedHeightPlan?.version === 2
    && operation.resolvedHeights?.version === 1
    && typeof operation.generationFingerprint === 'string'
    && savedToolpathMatchesHeightSnapshot(project, setup, operation, true)
    && projectOperationFingerprintMatches(
      operation.generationFingerprint, project, setup, operation, operation.resolvedHeights,
    )
}
