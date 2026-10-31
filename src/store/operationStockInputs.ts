// WO-2953: the store adapter for OperationStockAuthority. One authority per
// project epoch / setup / stock. Every access checks LIVE content; changed
// snapshots are prepared once off-page and late preparation cannot publish.
//
// Coordinates: stored toolpath moves, stock bounds and Face regions are project
// world mm (scene space, Z up) - the frame the worker writes moves in and the
// legacy Smart Height "MachineMm" evidence fields actually carry. Setup WCS
// origin/axes are NOT applied here: they only relabel moves for the post.
import { frameRef, type FrameRef } from '../lib/geometry/coordinateFrames'
import {
  OperationStockAuthority, stockCutSteps, stockMoveMatchesJson, type PreparedMoveWitness, type OperationStockInputs, type StockOperationInput, type StockRemoval,
} from '../lib/cam/operationStockAuthority'
import type { StockCut } from '../lib/cam/stockState'
import { offPageStockBackend, prepareStockCutsOffPage, captureStockOffPage, prepareMoveWitnessOffPage } from './toolpathPostprocess'
import { stockCutterOf } from './toolReachInputs'
import { operationGenerationIsCurrent, operationDependsOnPredecessors } from '../lib/cam/generationFingerprint'
import { validatePersistedSmartHeightState } from '../lib/cam/smartHeights/authority'
import { operationReferencedGeometryIds } from './opModelOriginGuard'
import { isWorkholdingGeometry } from './dispatchGeo'
import { effectiveStockIdForCompute } from './stockAssignment'
import type { Operation, Project, Setup, Tool, ToolpathMove, Vec3 } from '../types'

// WO-3126/2953/3085: inspect every supplied value, including raw and ABA
// writes. Keep a per-operation witness across equal array/object replacements;
// array identity is only a lookup, never the currency contract.
type MoveWitness = PreparedMoveWitness & { revision: number }
const moveWitnesses = new WeakMap<readonly ToolpathMove[], MoveWitness>()
const operationMoveWitnesses = new Map<string, MoveWitness>()
type ObservedMoves = { epoch: string; project: Project; tools: readonly Tool[]; moves: Map<readonly ToolpathMove[], MoveWitness> }
// Valid only inside synchronous internal reconciliation after a complete exact
// scan. notify() revokes this BEFORE arbitrary subscriber code can edit moves.
let reconciliationScan: ObservedMoves | undefined
let stockCallbackSerial = 0
let moveRevision = 0
function moveWitness(moves: readonly ToolpathMove[] | undefined, owner?: string): MoveWitness | undefined {
  if (!moves) { if (owner) operationMoveWitnesses.delete(owner); return undefined }
  const scoped = reconciliationScan?.moves.get(moves)
  if (scoped) { if (owner) operationMoveWitnesses.set(owner, scoped); return scoped }
  const primed = moveWitnesses.get(moves)
  const previous = (owner && operationMoveWitnesses.get(owner)) || primed
  let copies: ToolpathMove[] | undefined
  let fieldCounts: number[] | undefined
  let fieldKeys: (readonly string[])[] | undefined
  for (let i = 0; i < moves.length; i++) {
    if (previous?.moves[i] && stockMoveMatchesJson(moves[i], previous.moves[i], previous.fieldKeys[i])) continue
    copies ??= previous ? [...previous.moves] : []
    fieldCounts ??= previous ? [...previous.fieldCounts] : []
    fieldKeys ??= previous ? [...previous.fieldKeys] : []
    // A generated result already owns an off-page snapshot. Adopt that copy
    // after checking live values instead of cloning the whole result on-page.
    const prepared = primed?.moves[i] && stockMoveMatchesJson(moves[i], primed.moves[i], primed.fieldKeys[i])
    const copy = prepared ? primed!.moves[i] : JSON.parse(JSON.stringify(moves[i])) as ToolpathMove
    copies[i] = copy
    fieldKeys[i] = prepared ? primed!.fieldKeys[i] : Object.keys(copy)
    fieldCounts[i] = fieldKeys[i].length
  }
  let witness = previous
  if (copies || previous?.moves.length !== moves.length) {
    copies ??= previous ? [...previous.moves] : []
    copies.length = moves.length
    fieldCounts ??= previous ? [...previous.fieldCounts] : []
    fieldCounts.length = moves.length
    fieldKeys ??= previous ? [...previous.fieldKeys] : []
    fieldKeys.length = moves.length
    witness = { revision: ++moveRevision, moves: copies, fieldCounts, fieldKeys }
  }
  moveWitnesses.set(moves, witness!)
  if (owner) operationMoveWitnesses.set(owner, witness!)
  return witness
}
function moveOwner(epoch: string, setupId: string, opId: string): string {
  return JSON.stringify([epoch, setupId, opId])
}

/** Prime only an unpublished result. Verify every supplied field against the
 * worker-owned copy before adoption; a concurrent raw edit falls back to the
 * normal exact observer, never an identity-only certificate. */
export async function primeOperationStockMoves(moves: readonly ToolpathMove[], signal?: AbortSignal): Promise<void> {
  const prepared = await prepareMoveWitnessOffPage(moves, signal)
  let matches = prepared.moves.length === moves.length
  for (let i = 0; matches && i < moves.length; i++) {
    matches = stockMoveMatchesJson(moves[i], prepared.moves[i], prepared.fieldKeys[i])
  }
  if (matches) moveWitnesses.set(moves, { revision: ++moveRevision, ...prepared })
  await new Promise<void>(resolve => setTimeout(resolve, 16))
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

/** Requested whole-cell size; coarsening is reported on the snapshot quality. */
export const OPERATION_STOCK_CELL_MM = 0.5
export const OPERATION_STOCK_MAX_COLUMNS = 1_000_000
/** Virtual tail of every setup: a draft operation not yet in the setup reads
 * the stock after ALL enabled operations, never the block as loaded. */
export const STOCK_END_OPERATION_ID = '\u0000end-of-setup'

// ── Semantic edit serials ───────────────────────────────────────────────────
// Bumped from a store subscription, which sees every setState including raw
// ones, so an unobserved edit-away/edit-back still renews revisions. Results,
// status and progress never bump; they enter the authority key as removals.

const LIFECYCLE_FIELDS = new Set([
  'name', 'folderId', 'status', 'modelReferenceNote', 'outdatedReason', 'resolvedHeights',
  'resolvedHeightPlan', 'generationFingerprint', 'toolpathMoves', 'computeTimeMs',
  'estimatedCutTimeMs', 'estimatedCutTimeMsError', 'errorMessage', 'progress', 'progressPhase',
  'diagnostics', 'reachShortfall', 'contourTabPreview', 'dependsOnPredecessors',
])
let serialCounter = 0
let environmentSerial = 0
let observedEnvironment = ''
let observedRemoval = ''
let removalRevision = 0
const opSerials = new Map<string, { content: string; serial: number }>()

function contentOf(op: Operation): string {
  return JSON.stringify(Object.entries(op).filter(([key]) => !LIFECYCLE_FIELDS.has(key))
    .sort(([a], [b]) => a.localeCompare(b)))
}

function opSerial(epoch: string, op: Operation): string {
  const key = `${epoch}\u0000${op.id}`
  const content = contentOf(op)
  let entry = opSerials.get(key)
  if (!entry || entry.content !== content) {
    opSerials.set(key, entry = { content, serial: ++serialCounter })
    environmentSerial = serialCounter
  }
  return `${entry.serial}`
}

// Bulk arrays (mesh/body/loop point data) enter the key by identity, never by
// content: stringifying a model body on every setState cost ~40 ms per write.
// A replaced array renews its token; small fields still compare by content.
const BULK_ARRAY_LENGTH = 64
const bulkTokens = new WeakMap<object, number>()
let bulkSerial = 0
function bulkToken(value: object): string {
  let token = bulkTokens.get(value)
  if (token === undefined) bulkTokens.set(value, token = ++bulkSerial)
  return `\u0000bulk:${token}`
}
function bulkByIdentity(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value) || (Array.isArray(value) && value.length > BULK_ARRAY_LENGTH)) return bulkToken(value as object)
  return value
}

/** Content catches raw/in-place edits of small fields; bulk arrays inside the
 * store-owned geometry compare by identity. Only store-owned data may take an
 * identity token: a list built here is new on every call. Lifecycle fields do
 * not participate. */
function environmentOf(project: Project, tools: readonly Tool[]): string {
  return JSON.stringify([project.id, project.sceneStock, JSON.stringify(project.geometry, bulkByIdentity),
    project.modelItemPlacements, project.stocks, project.nests, project.machine,
    tools, project.setups.map(setup => [setup.id, setup.wcs, setup.stock,
      setup.operations.map(op => [op.id, contentOf(op)])])])
}

// ── Registry ────────────────────────────────────────────────────────────────

type Domain = { epoch: string; authority: OperationStockAuthority }
const authorities = new Map<string, Domain>()
let reconciling = false
let currentEpoch: string | undefined

function disposeOtherEpochs(epoch: string): void {
  if (currentEpoch === epoch) return
  const old = currentEpoch
  currentEpoch = epoch
  for (const [key, domain] of authorities) {
    if (domain.epoch === epoch) continue
    domain.authority.disposeProject(domain.epoch)
    authorities.delete(key)
  }
  if (old !== undefined) for (const key of [...opSerials.keys()]) if (key.startsWith(`${old}\u0000`)) opSerials.delete(key)
  operationMoveWitnesses.clear()
  restoredFaces.clear()
}

// ── Faces restored from a saved project ─────────────────────────────────────
// A Face on the shared stock is only trusted while the store holds an in-memory
// witness written when the Face was generated. A project open clears every
// witness, so a saved, ready, current Face would read as 'missing' for good.
// The first time this epoch sees such a Face READY it is a restored one: record
// the predecessor moves it was saved against. It stays trusted while those
// moves are unchanged; a predecessor regenerated afterwards changes the key and
// the Face is waited for again. A Face seen in any other status this epoch was
// (re)generated here, so the store's own witness decides.
type RestoredFace = { moves: readonly ToolpathMove[]; key: string }
const restoredFaces = new Map<string, RestoredFace | 'generated-here'>()

function isSharedStockFace(op: Operation): boolean {
  return op.type === 'face' &&
    !!op.resolvedHeightPlan?.machining.materialArtifact?.artifactId.startsWith('shared-stock:')
}

/** What a Face's shared-stock reading depended on: the enabled operations ahead
 * of it, with their actual moves (same witness the store writes at generation). */
function predecessorKey(setup: Setup, op: Operation): string {
  const end = setup.operations.findIndex(candidate => candidate.id === op.id)
  return JSON.stringify(setup.operations.slice(0, end).filter(candidate => candidate.enabled !== false).map(candidate =>
    [candidate.id, candidate.toolpathMoves, candidate.generationFingerprint, candidate.status]))
}

function observeFaces(epoch: string, project: Project): void {
  for (const setup of project.setups) for (const op of setup.operations) {
    if (op.type !== 'face') continue
    const id = `${epoch}\u0000${setup.id}\u0000${op.id}`
    if (op.status !== 'ready' || !op.toolpathMoves) { restoredFaces.set(id, 'generated-here'); continue }
    const seen = restoredFaces.get(id)
    if (seen === 'generated-here' || (seen && seen.moves === op.toolpathMoves)) continue
    restoredFaces.set(id, { moves: op.toolpathMoves, key: predecessorKey(setup, op) })
  }
}

function restoredFaceIsCurrent(ctx: OperationStockContext, op: Operation): boolean {
  if (!ctx.setup || !isSharedStockFace(op)) return false
  const seen = restoredFaces.get(`${ctx.epoch}\u0000${ctx.setup.id}\u0000${op.id}`)
  return !!seen && seen !== 'generated-here' && seen.moves === op.toolpathMoves &&
    seen.key === predecessorKey(ctx.setup, op) &&
    operationGenerationIsCurrent({ ...ctx.project, toolLibrary: [...ctx.toolLibrary] }, ctx.setup, op)
}

/** Call from a store subscription on EVERY change. Cheap when nothing relevant
 * moved; otherwise renews serials and reconciles live authorities eagerly. */
export function observeOperationStockState(epoch: string, project: Project, tools: readonly Tool[]): ObservedMoves | undefined {
  if (reconciliationScan?.epoch === epoch && reconciliationScan.project === project && reconciliationScan.tools === tools) return reconciliationScan
  disposeOtherEpochs(epoch)
  observeFaces(epoch, project)
  const environment = environmentOf(project, tools)
  const changed = environment !== observedEnvironment
  if (changed) { observedEnvironment = environment; environmentSerial = ++serialCounter }
  for (const setup of project.setups) for (const op of setup.operations) opSerial(epoch, op)
  // WO-3085: a progress message used to clone and fingerprint every completed
  // toolpath once per outstanding stock request. Full Suite spent 75 seconds
  // in capture() alone. Keep eager invalidation for actual inputs/results,
  // including raw in-place move edits; progress and timing are not removal.
  const scan: ObservedMoves = { epoch, project, tools, moves: new Map() }
  const inspected = (moves: readonly ToolpathMove[] | undefined, owner: string) => {
    if (!moves) { operationMoveWitnesses.delete(owner); return undefined }
    let witness = scan.moves.get(moves)
    if (!witness) { witness = moveWitness(moves, owner)!; scan.moves.set(moves, witness) }
    operationMoveWitnesses.set(owner, witness)
    return witness.revision
  }
  const removal = JSON.stringify([epoch, environmentSerial, project.setups.map(setup => [setup.id,
    setup.operations.map(op => [op.name, op.status, op.errorMessage, op.generationFingerprint,
      op.resolvedHeights, op.resolvedHeightPlan, operationDependsOnPredecessors(op), inspected(op.toolpathMoves, moveOwner(epoch, setup.id, op.id))])])])
  if (removal === observedRemoval) return scan
  observedRemoval = removal
  ++removalRevision
  if (reconciling) return scan
  reconciling = true
  const callbacksBefore = stockCallbackSerial
  reconciliationScan = scan
  try { for (const domain of authorities.values()) domain.authority.reconcile() }
  finally { reconciling = false; reconciliationScan = undefined }
  // A callback may have changed live content without a store notification.
  return callbacksBefore === stockCallbackSerial ? scan : undefined
}

export function operationStockAuthorityFor(
  epoch: string, setupId: string, stockId: string, getContext: () => OperationStockContext,
): OperationStockAuthority {
  disposeOtherEpochs(epoch)
  const key = JSON.stringify([epoch, setupId, stockId])
  let domain = authorities.get(key)
  if (!domain) {
    if (authorities.size === 0) environmentSerial = ++serialCounter
    let preparedRevision = -1
    let prepared: Promise<OperationStockInputs>
    const revision = (request: import('../lib/cam/operationStockAuthority').StockBeforeRequest) => {
      let ctx = getContext()
      const scan = observeOperationStockState(ctx.epoch, ctx.project, ctx.toolLibrary)
      if (!scan) ctx = getContext()
      const end = request.beforeOperationId === STOCK_END_OPERATION_ID ? ctx.setup?.operations.length ?? 0
        : ctx.setup?.operations.findIndex(op => op.id === request.beforeOperationId) ?? -1
      // A target's computing/ready write must not revoke the material it is
      // currently using. Only enabled predecessors in this stock enter capture.
      return JSON.stringify([ctx.epoch, environmentSerial, ctx.setup?.operations.slice(0, Math.max(0, end))
        .filter(op => op.enabled !== false && (ctx.stockIdOf(op) === null || ctx.stockIdOf(op) === ctx.stockId))
        .map(op => [op.id, op.name, op.status, op.errorMessage, op.generationFingerprint,
          op.resolvedHeights, op.resolvedHeightPlan, operationDependsOnPredecessors(op),
          (op.toolpathMoves && scan?.moves.get(op.toolpathMoves) || moveWitness(op.toolpathMoves, moveOwner(ctx.epoch, ctx.setup!.id, op.id)))?.revision])])
    }
    const prepare = () => {
      if (!prepared || preparedRevision !== removalRevision) {
        preparedRevision = removalRevision
        prepared = prepareOperationStockInputs(getContext())
      }
      return prepared
    }
    authorities.set(key, domain = { epoch, authority: new OperationStockAuthority(
      () => buildOperationStockInputs(getContext()), offPageStockBackend,
      { revision, prepare, capture: captureStockOffPage,
        beforeNotify: () => { reconciliationScan = undefined; ++stockCallbackSerial } },
    ) })
  }
  return domain.authority
}

export function operationStockWorldFrame(epoch: string): FrameRef<'world'> {
  return frameRef({ kind: 'world', projectEpoch: epoch, entityId: 'project-world', revision: 'scene-mm-v1' })
}

// ── Removal conversion ──────────────────────────────────────────────────────

const resultSerials = new WeakMap<readonly ToolpathMove[], number>()
let resultSerial = 0

// The identical converter is shared by worker and cooperative fallback.
export { RAMP_PIECE_DROP_MM, ARC_CHORD_SAGITTA_MM } from '../lib/cam/operationStockAuthority'
export function stockCutsFromMoves(moves: readonly ToolpathMove[], tool: Tool | undefined, frame: FrameRef<'world'>): readonly StockCut[] | string {
  const steps = stockCutSteps(moves, stockCutterOf(tool), frame)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface OperationStockContext {
  epoch: string
  project: Project
  setup: Setup | undefined
  toolLibrary: readonly Tool[]
  stockId: string
  stockBounds: { min: Vec3; max: Vec3 } | null
  /** Explicit stock membership; null is unresolved, never "empty". */
  stockIdOf: (op: Operation) => string | null
  /** The store's own generation currency (fingerprint + saved heights). */
  resultIsCurrent: (op: Operation) => boolean
}

/** The stock an operation's material belongs to: its geometry's stock, else its
 * Smart Height stock-footprint scope, else the setup's proven stock. Null is
 * unresolved (geometry on more than one stock, or nothing to read), never
 * "no stock". WO-3096: the same reading as the store's operationMaterialStockId
 * (src/store/index.ts), which feeds getOperationStockDomain; the store keeps
 * its own copy until it imports this one. */
export function operationMaterialStockIdOf(project: Project, op: Operation, provenStockId: () => string | undefined): string | null {
  const references = operationReferencedGeometryIds(op)
  const ids = references.includes('__all__')
    ? project.geometry.filter(geo => !isWorkholdingGeometry(geo)).map(geo => geo.id)
    : references.filter(id => id !== '__stock__')
  if (ids.length) {
    const memberships = ids.map(id => {
      const geo = project.geometry.find(candidate => candidate.id === id)
      return geo ? effectiveStockIdForCompute(geo, project.nests ?? [], project.stocks ?? []) : undefined
    })
    return memberships.every(id => id && id === memberships[0]) ? memberships[0]! : null
  }
  const validated = validatePersistedSmartHeightState(op.smartHeight)
  const scope = validated.ok ? validated.state.intent.machining.scope.value : undefined
  if (scope?.kind === 'stock_footprint') return scope.stockId
  return provenStockId() ?? null
}

function toolRevision(tool: Tool | undefined): string {
  const replay = stockCutterOf(tool)
  return replay ? JSON.stringify(tool) : `unsupported:${JSON.stringify(tool)}`
}

function removalOf(ctx: OperationStockContext, op: Operation, frame: FrameRef<'world'>,
  inputRevision: string, toolRev: string, tool: Tool | undefined,
  cutsOf: (op: Operation, tool: Tool | undefined, frame: FrameRef<'world'>) => readonly StockCut[] | string): StockRemoval {
  switch (op.status) {
    case 'computing': return { status: 'computing' }
    case 'error': return { status: 'error', reason: `'${op.name}' failed: ${op.errorMessage ?? 'no result'}` }
    case 'unsupported':
    case 'degraded': return { status: 'unsupported', reason: `'${op.name}' is ${op.status}.` }
    case 'ready': break
    default: return { status: 'missing', reason: `'${op.name}' has no current toolpath.` }
  }
  if (!op.toolpathMoves || !(ctx.resultIsCurrent(op) || restoredFaceIsCurrent(ctx, op))) return { status: 'missing', reason: `'${op.name}' has no current toolpath.` }
  const axis = ctx.setup?.wcs.zAxis
  if (!axis || Math.abs(axis.x) > 1e-10 || Math.abs(axis.y) > 1e-10 || Math.abs(axis.z - 1) > 1e-10) {
    return { status: 'unsupported', reason: 'Remaining stock does not support a tilted cutter axis.' }
  }
  const cuts = cutsOf(op, tool, frame)
  if (typeof cuts === 'string') return { status: 'unsupported', reason: `'${op.name}': ${cuts}` }
  if (!resultSerials.has(op.toolpathMoves)) resultSerials.set(op.toolpathMoves, ++resultSerial)
  return { status: 'ready', resultRevision: `${op.generationFingerprint!}:${resultSerials.get(op.toolpathMoves)}`, inputRevision, toolRevision: toolRev, frame, cuts }
}

/** Current world/mm inputs for one setup/stock domain, in execution order,
 * disabled operations included, plus the virtual end-of-setup operation. */
export function buildOperationStockInputs(ctx: OperationStockContext,
  cutsOf = (op: Operation, tool: Tool | undefined, frame: FrameRef<'world'>) => stockCutsFromMoves(op.toolpathMoves!, tool, frame),
): OperationStockInputs {
  const frame = operationStockWorldFrame(ctx.epoch)
  const b = ctx.stockBounds
  const operations: StockOperationInput[] = (ctx.setup?.operations ?? []).map(op => {
    const tool = ctx.toolLibrary.find(candidate => candidate.id === op.toolId)
    const inputRevision = `${opSerial(ctx.epoch, op)}`
    const toolRev = toolRevision(tool)
    return { id: op.id, enabled: op.enabled !== false, stockId: ctx.stockIdOf(op), inputRevision,
      toolRevision: toolRev, removal: op.enabled === false ? { status: 'missing' } : removalOf(ctx, op, frame, inputRevision, toolRev, tool, cutsOf) }
  })
  operations.push({ id: STOCK_END_OPERATION_ID, enabled: false, stockId: ctx.stockId,
    inputRevision: 'end', toolRevision: 'end', removal: { status: 'missing' } })
  return {
    projectEpoch: ctx.epoch,
    changeRevision: environmentSerial,
    setupId: ctx.setup?.id ?? '',
    stockId: ctx.stockId,
    frame,
    initial: {
      // Missing stock bounds leave the identity empty: the authority refuses it.
      revision: b ? JSON.stringify([b.min, b.max]) : '',
      bounds: b ? { minX: b.min.x, minY: b.min.y, minZ: b.min.z, maxX: b.max.x, maxY: b.max.y, maxZ: b.max.z }
        : { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      resolutionMm: OPERATION_STOCK_CELL_MM,
      maxColumns: OPERATION_STOCK_MAX_COLUMNS,
    },
    operations,
  }
}

const preparedCuts = new WeakMap<MoveWitness, Map<string, Promise<readonly StockCut[] | string>>>()

async function prepareOperationStockInputs(ctx: OperationStockContext): Promise<OperationStockInputs> {
  const pending = new Map<string, Promise<readonly StockCut[] | string>>()
  const inputs = buildOperationStockInputs(ctx, (op, tool, frame) => {
    const witness = moveWitness(op.toolpathMoves, moveOwner(ctx.epoch, ctx.setup!.id, op.id))!
    const replay = stockCutterOf(tool)
    const key = JSON.stringify([frame, replay])
    let tasks = preparedCuts.get(witness)
    if (!tasks) preparedCuts.set(witness, tasks = new Map())
    let task = tasks.get(key)
    if (!task) {
      task = prepareStockCutsOffPage(witness.moves, replay, frame)
      tasks.set(key, task)
      // A transport/backend failure may be retried on the next dirty snapshot.
      void task.catch(() => tasks!.delete(key))
    }
    pending.set(op.id, task)
    return []
  })
  const operations = await Promise.all(inputs.operations.map(async op => {
    const task = pending.get(op.id)
    if (!task || op.removal.status !== 'ready') return op
    const cuts = await task
    return { ...op, removal: typeof cuts === 'string'
      ? { status: 'unsupported' as const, reason: `'${ctx.setup?.operations.find(item => item.id === op.id)?.name}': ${cuts}` }
      : { ...op.removal, cuts } }
  }))
  return { ...inputs, operations }
}

/** Resolve on the authority's next settlement/invalidation (or a 1 s safety tick). */
export function nextOperationStockChange(authority: OperationStockAuthority): Promise<void> {
  return new Promise(resolve => {
    const done = () => { off(); clearTimeout(timer); resolve() }
    const off = authority.subscribe(done)
    const timer = setTimeout(done, 1000)
  })
}
