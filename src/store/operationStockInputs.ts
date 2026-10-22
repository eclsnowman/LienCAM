// WO-2953: the store adapter for OperationStockAuthority. One authority per
// project epoch / setup / stock. Inputs are rebuilt from the LIVE store on every
// read, query and async settlement; nothing here caches a plannable answer.
//
// Coordinates: stored toolpath moves, stock bounds and Face regions are project
// world mm (scene space, Z up) - the frame the worker writes moves in and the
// legacy Smart Height "MachineMm" evidence fields actually carry. Setup WCS
// origin/axes are NOT applied here: they only relabel moves for the post.
import { frameRef, pointMm, vectorMm, rigidMap, mapPoint, mapVector, type FrameRef } from '../lib/geometry/coordinateFrames'
import {
  OperationStockAuthority, type OperationStockInputs, type StockOperationInput, type StockRemoval,
} from '../lib/cam/operationStockAuthority'
import type { StockCut } from '../lib/cam/stockState'
import { effectiveMoveRole, isStockCuttingRole } from '../lib/cam/stockCuttingRoles'
import { stockCutterOf } from './toolReachInputs'
import { operationGenerationIsCurrent } from '../lib/cam/generationFingerprint'
import type { Operation, Project, Setup, Tool, ToolpathMove, Vec3 } from '../types'

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
export function observeOperationStockState(epoch: string, project: Project, tools: readonly Tool[]): void {
  disposeOtherEpochs(epoch)
  observeFaces(epoch, project)
  const environment = environmentOf(project, tools)
  const changed = environment !== observedEnvironment
  if (changed) { observedEnvironment = environment; environmentSerial = ++serialCounter }
  for (const setup of project.setups) for (const op of setup.operations) opSerial(epoch, op)
  for (const domain of authorities.values()) domain.authority.reconcile()
}

export function operationStockAuthorityFor(
  epoch: string, setupId: string, stockId: string, getLatest: () => OperationStockInputs,
): OperationStockAuthority {
  disposeOtherEpochs(epoch)
  const key = JSON.stringify([epoch, setupId, stockId])
  let domain = authorities.get(key)
  if (!domain) {
    if (authorities.size === 0) environmentSerial = ++serialCounter
    authorities.set(key, domain = { epoch, authority: new OperationStockAuthority(getLatest) })
  }
  return domain.authority
}

export function operationStockWorldFrame(epoch: string): FrameRef<'world'> {
  return frameRef({ kind: 'world', projectEpoch: epoch, entityId: 'project-world', revision: 'scene-mm-v1' })
}

// ── Removal conversion ──────────────────────────────────────────────────────

const resultSerials = new WeakMap<readonly ToolpathMove[], number>()
let resultSerial = 0

/** A ramp piece may drop at most this far; each piece counts at its higher end. */
export const RAMP_PIECE_DROP_MM = 0.25
/** Largest chord sagitta an arc is split to (also capped at a tenth of the cutter radius). */
export const ARC_CHORD_SAGITTA_MM = 0.01
const MAX_PIECES_PER_MOVE = 4096

/** Stored world-mm moves to upward-open level/plunge sweeps that never remove
 * more than the real cut: retained stock can only be over-reported.
 * - A ramp (XY+Z together) is split into short level pieces, each swept at its
 *   HIGHER end, so no piece reaches below the cutter's real path.
 * - An arc (or helix) becomes chords. Each chord is swept by the cutter shrunk
 *   by the chord's sagitta s; a ball is also lifted by s so its centre height is
 *   unchanged. A disc/ball of radius R-s within s of the arc lies inside the real
 *   cutter of radius R there. An arc without a centre, or whose start and end
 *   coincide, removes nothing.
 * - A tool with no conservative removal shape (v-bit, chamfer, dovetail...)
 *   removes nothing, and so does a cutting move with no known start.
 * Only rotary endpoints are refused: the stock itself turns under them. */
export function stockCutsFromMoves(moves: readonly ToolpathMove[], tool: Tool | undefined, frame: FrameRef<'world'>): readonly StockCut[] | string {
  const replay = stockCutterOf(tool)
  if (!replay) return Object.freeze([])
  let result: readonly StockCut[] | string
  try {
    const cuts: StockCut[] = []
    // Stored endpoints already live in project world mm. The checked identity
    // ingress prevents applying geometry placement or WCS origin a second time.
    const ingress = rigidMap(frame, frame, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const axis = mapVector(ingress, vectorMm(frame, { x: 0, y: 0, z: 1 })).value
    if (axis.x !== 0 || axis.y !== 0 || axis.z !== 1) throw new Error('a tilted cutter')
    const radius = replay.cutter.diameter / 2
    const sweep = (from: Vec3, to: Vec3, shrinkMm: number) => {
      const cutter = shrinkMm > 0 ? { ...replay.cutter, diameter: replay.cutter.diameter - 2 * shrinkMm } : replay.cutter
      const lift = replay.liftMm + (replay.cutter.kind === 'ball' ? shrinkMm : 0)
      const planar = to.x !== from.x || to.y !== from.y
      const drop = Math.abs(to.z - from.z)
      // A plunge (or a level move) keeps its own ends; float noise on a level
      // move is taken at the HIGHER end like any ramp.
      const pieces = !planar ? 1 : drop <= 1e-9 ? 1 : Math.min(MAX_PIECES_PER_MOVE, Math.ceil(drop / RAMP_PIECE_DROP_MM))
      for (let k = 0; k < pieces; k++) {
        const a = k === 0 ? from : lerp(from, to, k / pieces)
        const b = k === pieces - 1 ? to : lerp(from, to, (k + 1) / pieces)
        const z0 = planar ? Math.max(a.z, b.z) : a.z
        const z1 = planar ? z0 : b.z
        cuts.push({ cutter, move: { x0: a.x, y0: a.y, z0: z0 + lift, x1: b.x, y1: b.y, z1: z1 + lift } })
      }
    }
    let tip: Vec3 | undefined
    for (const raw of moves) {
      if (raw.a !== undefined || raw.b !== undefined || raw.c !== undefined) throw new Error('a rotary endpoint')
      const move = { ...raw, ...mapPoint(ingress, pointMm(frame, raw)).value }
      if (tip && isStockCuttingRole(effectiveMoveRole(move))) {
        if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
          const chords = arcChords(tip, move, radius)
          for (let k = 1; chords && k < chords.points.length; k++) sweep(chords.points[k - 1], chords.points[k], chords.sagittaMm)
        } else {
          sweep(tip, move, 0)
        }
      }
      tip = { x: move.x, y: move.y, z: move.z }
    }
    result = Object.freeze(cuts)
  } catch (error) {
    result = `Material removal of ${error instanceof Error ? error.message : String(error)} is not supported.`
  }
  return result
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

/** Chord points along an arc/helix and the largest distance (mm) any chord
 * strays from it, or undefined when the arc cannot be enclosed by a cutter at
 * least half the real radius (it then removes nothing). */
function arcChords(start: Vec3, move: ToolpathMove, cutterRadius: number): { points: Vec3[]; sagittaMm: number } | undefined {
  const { cx, cy } = move
  if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) return undefined
  if (start.x === move.x && start.y === move.y) return undefined
  const r0 = Math.hypot(start.x - cx, start.y - cy)
  const r1 = Math.hypot(move.x - cx, move.y - cy)
  const rMax = Math.max(r0, r1)
  if (!(Math.min(r0, r1) > 0) || !Number.isFinite(rMax)) return undefined
  const a0 = Math.atan2(start.y - cy, start.x - cx)
  let span = Math.atan2(move.y - cy, move.x - cx) - a0
  if (move.type === 'arc_ccw') { while (span <= 0) span += 2 * Math.PI } else { while (span >= 0) span -= 2 * Math.PI }
  const tolerance = Math.min(ARC_CHORD_SAGITTA_MM, cutterRadius / 10)
  const halfStep = tolerance < rMax ? Math.acos(1 - tolerance / rMax) : Math.PI / 2
  const count = Math.min(MAX_PIECES_PER_MOVE, Math.max(1, Math.ceil(Math.abs(span) / (2 * halfStep))))
  // The chord sagitta, plus any start/end radius mismatch: the interpolated
  // spiral is within that of every reading of the arc's radius.
  const sagittaMm = rMax * (1 - Math.cos(Math.abs(span) / (2 * count))) + Math.abs(r1 - r0)
  if (!(sagittaMm < cutterRadius / 2)) return undefined
  const points: Vec3[] = [start]
  for (let k = 1; k < count; k++) {
    const t = k / count, angle = a0 + span * t, r = r0 + (r1 - r0) * t
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), z: start.z + (move.z - start.z) * t })
  }
  points.push({ x: move.x, y: move.y, z: move.z })
  return { points, sagittaMm }
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

function toolRevision(tool: Tool | undefined): string {
  const replay = stockCutterOf(tool)
  return replay ? JSON.stringify(tool) : `unsupported:${JSON.stringify(tool)}`
}

function removalOf(ctx: OperationStockContext, op: Operation, frame: FrameRef<'world'>,
  inputRevision: string, toolRev: string, tool: Tool | undefined): StockRemoval {
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
  const cuts = stockCutsFromMoves(op.toolpathMoves, tool, frame)
  if (typeof cuts === 'string') return { status: 'unsupported', reason: `'${op.name}': ${cuts}` }
  if (!resultSerials.has(op.toolpathMoves)) resultSerials.set(op.toolpathMoves, ++resultSerial)
  return { status: 'ready', resultRevision: `${op.generationFingerprint!}:${resultSerials.get(op.toolpathMoves)}`, inputRevision, toolRevision: toolRev, frame, cuts }
}

/** Current world/mm inputs for one setup/stock domain, in execution order,
 * disabled operations included, plus the virtual end-of-setup operation. */
export function buildOperationStockInputs(ctx: OperationStockContext): OperationStockInputs {
  const frame = operationStockWorldFrame(ctx.epoch)
  const b = ctx.stockBounds
  const operations: StockOperationInput[] = (ctx.setup?.operations ?? []).map(op => {
    const tool = ctx.toolLibrary.find(candidate => candidate.id === op.toolId)
    const inputRevision = `${opSerial(ctx.epoch, op)}`
    const toolRev = toolRevision(tool)
    return { id: op.id, enabled: op.enabled !== false, stockId: ctx.stockIdOf(op), inputRevision,
      toolRevision: toolRev, removal: op.enabled === false ? { status: 'missing' } : removalOf(ctx, op, frame, inputRevision, toolRev, tool) }
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

/** Resolve on the authority's next settlement/invalidation (or a 1 s safety tick). */
export function nextOperationStockChange(authority: OperationStockAuthority): Promise<void> {
  return new Promise(resolve => {
    const done = () => { off(); clearTimeout(timer); resolve() }
    const off = authority.subscribe(done)
    const timer = setTimeout(done, 1000)
  })
}
