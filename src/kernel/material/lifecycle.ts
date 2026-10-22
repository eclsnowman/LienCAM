// WO-3032 (alpha.3 A3-10b, parity): the material lifecycle. Replay stays the
// source of truth; the service keeps an in-memory snapshot per operation, keyed
// by the fingerprint of the chain that produced it, and answers from it only
// while that key still matches (one validity test). Nothing is persisted
// (ADR-0040): no snapshot is written to a project, a file or storage, and a new
// lifecycle starts empty.
//
// The chain fingerprint is a hash chain: f(-1) names the stock block, the grid
// and the policy values that change replay; f(i) = hash(f(i-1), operation i's
// identity), where the identity is every fact replay reads (enabled, status,
// tool record, drill point length, profile shape, and a digest of every move
// value). An edit to an upstream operation changes its f(i) and every f after
// it, so each snapshot downstream fails the validity test; an edit downstream
// leaves the upstream snapshots valid.
//
// Deterministic: fixed order, no clock or RNG in any answer.
import type { ToolpathMove } from '../../types'
import { materialFingerprint } from './fingerprint'
import { DexelField, type Box3 } from './dexel'
import { PARITY_POLICY, type MaterialPolicy } from './policy'
import { PARITY_REPLAY_GRID, replayCutterFor, replayOperationInto, stockField, type MaterialOperation, type ReplayGrid } from './replay'

/** What remains after operation `afterIndex` of a chain (-1: the stock as loaded). */
export interface MaterialSnapshot {
  readonly backend: 'z-dexel'
  readonly stock: Readonly<Box3>
  /** Read-only by contract: queries never write it; replay works on a clone. */
  readonly field: DexelField
  readonly afterIndex: number
  /** Operations whose moves were swept out (0: nothing earlier was cut; today's "undefined"). */
  readonly operationsReplayed: number
  readonly replayedIds: readonly string[]
  /** One line per operation treated as not cut, or not replayed. */
  readonly notes: readonly string[]
  /** The chain fingerprint this snapshot answers for. */
  readonly fingerprint: string
}

const digests = new WeakMap<readonly ToolpathMove[], string>()

/** FNV-1a over every value the replay reads from a move list. Cached per list. */
export function movesDigest(moves: readonly ToolpathMove[] | undefined): string {
  if (!moves) return 'none'
  const cached = digests.get(moves)
  if (cached) return cached
  const view = new DataView(new ArrayBuffer(8))
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  const word = (n: number) => {
    a = Math.imul(a ^ n, 0x01000193) >>> 0
    b = Math.imul(b ^ n, 0x85ebca6b) >>> 0
  }
  const num = (v: number | undefined) => {
    if (v === undefined) { word(0x7ff8dead); return }
    view.setFloat64(0, v)
    word(view.getUint32(0))
    word(view.getUint32(4))
  }
  const text = (s: string | undefined) => {
    if (s === undefined) { word(0xdead); return }
    for (let i = 0; i < s.length; i++) word(s.charCodeAt(i))
    word(0)
  }
  for (const m of moves) {
    text(m.type); text(m.role)
    num(m.x); num(m.y); num(m.z); num(m.cx); num(m.cy)
  }
  word(moves.length)
  const digest = `${moves.length}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
  digests.set(moves, digest)
  return digest
}

/** Every fact replay reads from one operation. */
function operationIdentity(operation: MaterialOperation, policy: MaterialPolicy) {
  const cutter = replayCutterFor(operation, policy)
  return {
    id: operation.id,
    type: operation.type,
    enabled: operation.enabled,
    status: operation.status,
    tool: operation.tool ?? null,
    cutter: cutter?.key ?? null,
    moves: movesDigest(operation.moves),
  }
}

/** f(-1): the stock block, the grid and the policy values replay reads. */
export function rootFingerprint(stock: Box3, grid: ReplayGrid = PARITY_REPLAY_GRID, policy: MaterialPolicy = PARITY_POLICY): string {
  return materialFingerprint({
    service: 'kernel-material-replay-v1',
    stock: { minX: stock.minX, minY: stock.minY, minZ: stock.minZ, maxX: stock.maxX, maxY: stock.maxY, maxZ: stock.maxZ },
    grid: { cellMm: grid.cellMm, budget: grid.budget },
    removed: policy.removed_definition,
    profileReplay: policy.profile_replay,
  })
}

/** f(-1) .. f(n): the chain fingerprint after each operation through `n`. */
export function chainFingerprints(stock: Box3, chain: readonly MaterialOperation[], n: number,
  grid: ReplayGrid = PARITY_REPLAY_GRID, policy: MaterialPolicy = PARITY_POLICY): string[] {
  const out = [rootFingerprint(stock, grid, policy)]
  for (let i = 0; i <= Math.min(n, chain.length - 1); i++) {
    out.push(materialFingerprint({ previous: out[out.length - 1], operation: operationIdentity(chain[i], policy) }))
  }
  return out
}

/** The chain fingerprint after operation `n` (-1: the stock as loaded). */
export function chainFingerprint(stock: Box3, chain: readonly MaterialOperation[], n: number,
  grid: ReplayGrid = PARITY_REPLAY_GRID, policy: MaterialPolicy = PARITY_POLICY): string {
  const all = chainFingerprints(stock, chain, n, grid, policy)
  return all[all.length - 1]
}

function checkIndex(chain: readonly MaterialOperation[], n: number): void {
  if (!Number.isInteger(n) || n < -1 || n >= chain.length) {
    throw new Error(`material snapshotAfter: operation index ${n} is outside the chain (0..${chain.length - 1}, or -1 for the stock).`)
  }
}

function freeze(snapshot: MaterialSnapshot): MaterialSnapshot {
  return Object.freeze({ ...snapshot, stock: Object.freeze({ ...snapshot.stock }),
    replayedIds: Object.freeze([...snapshot.replayedIds]), notes: Object.freeze([...snapshot.notes]) })
}

/** Continue a replay from `from` (the snapshot after operation from.afterIndex) through operation n. */
function extend(from: MaterialSnapshot, stock: Box3, chain: readonly MaterialOperation[], n: number,
  fingerprints: readonly string[], policy: MaterialPolicy, keep?: (snapshot: MaterialSnapshot) => void): MaterialSnapshot {
  let current = from
  for (let i = from.afterIndex + 1; i <= n; i++) {
    const field = current.field.clone()
    const result = replayOperationInto(field, chain[i], policy)
    current = freeze({
      backend: 'z-dexel', stock, field, afterIndex: i,
      operationsReplayed: current.operationsReplayed + (result.replayed ? 1 : 0),
      replayedIds: result.replayed ? [...current.replayedIds, chain[i].id] : current.replayedIds,
      notes: result.note ? [...current.notes, result.note] : current.notes,
      fingerprint: fingerprints[i + 1],
    })
    keep?.(current)
  }
  return current
}

function stockSnapshot(stock: Box3, grid: ReplayGrid, fingerprint: string): MaterialSnapshot {
  const field = stockField(stock, grid)
  return freeze({ backend: 'z-dexel', stock, field, afterIndex: -1, operationsReplayed: 0, replayedIds: [],
    notes: [...field.warnings], fingerprint })
}

/**
 * snapshotAfter(N) by replay alone, no cache: the source of truth every cached
 * answer must equal. Operations after N are never read.
 */
export function replaySnapshotAfter(stock: Box3, chain: readonly MaterialOperation[], n: number,
  grid: ReplayGrid = PARITY_REPLAY_GRID, policy: MaterialPolicy = PARITY_POLICY): MaterialSnapshot {
  checkIndex(chain, n)
  const fingerprints = chainFingerprints(stock, chain, n, grid, policy)
  return extend(stockSnapshot(stock, grid, fingerprints[0]), stock, chain, n, fingerprints, policy)
}

export interface MaterialLifecycleOptions {
  readonly stock: Box3
  /** The replay grid from the tolerance authority; today's 0.2 mm / 1 000 000 by default. */
  readonly grid?: ReplayGrid
  readonly policy?: MaterialPolicy
}

export interface MaterialLifecycleStats {
  /** Answers served from a valid cached snapshot. */
  hits: number
  /** Operations replayed (each one sweep of one operation's moves). */
  operationsReplayed: number
  /** Snapshots currently held. */
  held: number
}

/**
 * The in-memory snapshot cache. snapshotAfter(chain, N) answers from the
 * snapshot whose key is the chain fingerprint through N; on a miss it replays
 * from the longest valid prefix it holds (or the stock) and keeps every
 * snapshot it passes. Nothing is persisted; `clear()` forgets everything.
 */
export function createMaterialLifecycle(options: MaterialLifecycleOptions) {
  const stock = Object.freeze({ ...options.stock })
  const grid = options.grid ?? PARITY_REPLAY_GRID
  const policy = options.policy ?? PARITY_POLICY
  const snapshots = new Map<string, MaterialSnapshot>()
  const stats: MaterialLifecycleStats = { hits: 0, operationsReplayed: 0, held: 0 }
  const keep = (snapshot: MaterialSnapshot) => {
    snapshots.set(snapshot.fingerprint, snapshot)
    stats.held = snapshots.size
  }

  function snapshotAfter(chain: readonly MaterialOperation[], n: number): MaterialSnapshot {
    checkIndex(chain, n)
    const fingerprints = chainFingerprints(stock, chain, n, grid, policy)
    const hit = snapshots.get(fingerprints[n + 1])
    if (hit) { stats.hits++; return hit }
    let start: MaterialSnapshot | undefined
    for (let i = n - 1; i >= -1 && !start; i--) start = snapshots.get(fingerprints[i + 1])
    if (!start) { start = stockSnapshot(stock, grid, fingerprints[0]); keep(start) }
    stats.operationsReplayed += n - start.afterIndex
    return extend(start, stock, chain, n, fingerprints, policy, keep)
  }

  return {
    stock, grid, policy,
    snapshotAfter,
    /** What remains for operation `n` to cut: snapshotAfter(n - 1). */
    snapshotBefore: (chain: readonly MaterialOperation[], n: number) => snapshotAfter(chain, n - 1),
    /** The one validity test: the snapshot answers for this chain through its operation. */
    isValid(snapshot: MaterialSnapshot, chain: readonly MaterialOperation[]): boolean {
      if (snapshot.afterIndex >= chain.length) return false
      return snapshot.fingerprint === chainFingerprint(stock, chain, snapshot.afterIndex, grid, policy)
    },
    stats: (): Readonly<MaterialLifecycleStats> => ({ ...stats }),
    clear(): void {
      snapshots.clear()
      stats.held = 0
    },
  }
}

export type MaterialLifecycle = ReturnType<typeof createMaterialLifecycle>
