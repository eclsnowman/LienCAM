// WO-3032 (alpha.3 A3-10b): the material lifecycle. Replay is the source of
// truth: every cached answer equals a fresh replay; an edit to an upstream
// operation changes the chain fingerprint and invalidates every snapshot after
// it; snapshotAfter(N) is right for a non-adjacent later operation (rough,
// finish, rough); two runs are identical; nothing is persisted; nothing in the
// app calls the service (P0 by source scan). M-TIME-2 replay time is measured.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Tool, ToolpathMove } from '../../types'
import { remainingStockBefore } from '../../store/toolReachInputs'
import { restStartStockFor } from '../../cam3d/integration/adaptive3dOperation'
import { toolToCutterSpec } from '../../cam3d/integration/cutterSpec'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import { toolpathMovesToLinearSweeps } from '../../cam3d/rough/replayStock'
import { toolTypeMeta } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import {
  PARITY_POLICY, adaptiveHandoff, airAlong, chainFingerprint, createMaterialLifecycle, movesDigest, replaySnapshotAfter,
  sweepShape, topHeight, type MaterialOperation, type MaterialSnapshot,
} from '../../kernel/material'
import { makeTool } from '../post/helpers'

const bytes = (s: MaterialSnapshot) => Buffer.from(s.field.top.buffer, s.field.top.byteOffset, s.field.top.byteLength)

/** A small 2D chain, enough to edit: three pockets of zig-zag passes at falling depths. */
function zigzag(x0: number, y0: number, x1: number, y1: number, z: number, step: number): ToolpathMove[] {
  const out: ToolpathMove[] = [{ type: 'rapid', x: x0, y: y0, z: 5, role: 'rapid' }, { type: 'feed', x: x0, y: y0, z, role: 'plunge' }]
  for (let y = y0, row = 0; y <= y1 + 1e-9; y += step, row++) {
    const [a, b] = row % 2 ? [x1, x0] : [x0, x1]
    if (row) out.push({ type: 'feed', x: a, y, z, role: 'stepover' })
    out.push({ type: 'feed', x: b, y, z, role: 'cut' })
  }
  out.push({ type: 'rapid', x: out[out.length - 1].x, y: out[out.length - 1].y, z: 5, role: 'rapid' })
  return out
}

const STOCK = { minX: 0, minY: 0, minZ: -12, maxX: 60, maxY: 40, maxZ: 0 }
const flat6 = makeTool({ id: 'f6', type: 'flat_end_mill', diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60 })
const ball4 = makeTool({ id: 'b4', type: 'ball_end_mill', diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50 })
const bull8 = makeTool({ id: 'u8', type: 'bull_nose', diameter: 8, cornerRadius: 1, fluteLength: 20, shankDiameter: 8, overallLength: 60 })

function smallChain(): MaterialOperation[] {
  return [
    { id: 'a', type: 'pocket_2d', enabled: true, status: 'ready', tool: flat6, moves: zigzag(5, 5, 55, 35, -3, 2.4) },
    { id: 'b', type: 'pocket_2d', enabled: true, status: 'ready', tool: bull8, moves: zigzag(10, 8, 40, 30, -6, 3) },
    { id: 'c', type: 'pocket_2d', enabled: true, status: 'outdated', tool: flat6, moves: zigzag(0, 0, 60, 40, -11, 3) },
    { id: 'd', type: 'parallel_3d', enabled: true, status: 'ready', tool: ball4, moves: zigzag(12, 10, 30, 25, -8, 1.5) },
    { id: 'e', type: 'pocket_2d', enabled: true, status: 'ready', tool: flat6, moves: zigzag(30, 5, 55, 20, -9, 2.4) },
  ]
}

const REGIONS = [
  { minX: 0, minY: 0, maxX: 60, maxY: 40 }, { minX: 20, minY: 15, maxX: 25, maxY: 18 }, { minX: 44, minY: 10, maxX: 44, maxY: 10 },
  { minX: -5, minY: -5, maxX: 1, maxY: 1 }, { minX: 70, minY: 70, maxX: 80, maxY: 80 },
]

describe('WO-3032 material lifecycle: replay is the source of truth, the cache only remembers it', () => {
  it('cached snapshots equal fresh replays, in any request order, and each operation is replayed once', () => {
    const chain = smallChain()
    const lifecycle = createMaterialLifecycle({ stock: STOCK })
    for (const n of [4, 1, 3, -1, 0, 2, 4, 2, 0]) {
      const cached = lifecycle.snapshotAfter(chain, n)
      const replayed = replaySnapshotAfter(STOCK, chain, n)
      expect(bytes(cached).equals(bytes(replayed)), `after ${n}`).toBe(true)
      expect(cached.fingerprint).toBe(replayed.fingerprint)
      expect(cached.operationsReplayed).toBe(replayed.operationsReplayed)
      expect(cached.notes).toEqual(replayed.notes)
      for (const region of REGIONS) expect(topHeight(cached, region)).toBe(topHeight(replayed, region))
      expect(lifecycle.isValid(cached, chain)).toBe(true)
    }
    const stats = lifecycle.stats()
    expect(stats.operationsReplayed).toBe(chain.length)
    expect(stats.hits).toBeGreaterThanOrEqual(4)
    expect(lifecycle.snapshotBefore(chain, 3).afterIndex).toBe(2)
    // Bull-nose replays as a ball of its diameter; the outdated operation is not cut and says so.
    expect(lifecycle.snapshotAfter(chain, 4).replayedIds).toEqual(['a', 'b', 'd', 'e'])
    expect(lifecycle.snapshotAfter(chain, 4).notes).toEqual(['c: not computed (status outdated): treated as not cut'])
  })

  it('editing an upstream operation changes the fingerprint and invalidates every snapshot after it, and only those', () => {
    const chain = smallChain()
    const lifecycle = createMaterialLifecycle({ stock: STOCK })
    const before = [-1, 0, 1, 2, 3, 4].map(n => lifecycle.snapshotAfter(chain, n))
    const edits: [string, number, (op: MaterialOperation) => MaterialOperation][] = [
      ['one move nudged 0.1 mm', 1, op => ({ ...op, moves: op.moves!.map((m, i) => (i === 5 ? { ...m, x: m.x + 0.1 } : m)) })],
      ['tool diameter', 1, op => ({ ...op, tool: { ...op.tool!, diameter: 7 } })],
      ['disabled', 0, op => ({ ...op, enabled: false })],
      ['now computed', 2, op => ({ ...op, status: 'ready' })],
      ['downstream move', 4, op => ({ ...op, moves: op.moves!.slice(0, -2) })],
    ]
    for (const [label, at, edit] of edits) {
      const edited = chain.map((op, i) => (i === at ? edit(op) : op))
      for (const snapshot of before) {
        const upstream = snapshot.afterIndex < at
        expect(lifecycle.isValid(snapshot, edited), `${label}: after ${snapshot.afterIndex}`).toBe(upstream)
      }
      const fresh = lifecycle.snapshotAfter(edited, 4)
      expect(fresh.fingerprint).not.toBe(before[5].fingerprint)
      expect(bytes(fresh).equals(bytes(replaySnapshotAfter(STOCK, edited, 4))), label).toBe(true)
    }
    // A nudge, a wider tool, a newly computed operation change the material; the cache served none of the old answers.
    const nudged = chain.map((op, i) => (i === 2 ? { ...op, status: 'ready' } : op))
    expect(bytes(lifecycle.snapshotAfter(nudged, 4)).equals(bytes(before[5]))).toBe(false)
    // The fingerprint hashes values, not identity: an equal copy of the moves is the same chain.
    const copied = chain.map(op => ({ ...op, moves: op.moves!.map(m => ({ ...m })) }))
    expect(chainFingerprint(STOCK, copied, 4)).toBe(before[5].fingerprint)
    expect(lifecycle.snapshotAfter(copied, 4)).toBe(lifecycle.snapshotAfter(chain, 4))
    expect(movesDigest(copied[0].moves)).toBe(movesDigest(chain[0].moves))
  })

  it('two runs are identical: fingerprints, columns, notes and air answers', () => {
    const run = () => {
      const lifecycle = createMaterialLifecycle({ stock: STOCK })
      const chain = smallChain()
      const snaps = [0, 1, 2, 3, 4].map(n => lifecycle.snapshotAfter(chain, n))
      const shape = sweepShape({ tool: flat6, profileKind: toolTypeMeta(flat6.type).profileKind, profile: buildToolProfile(flat6) })
      if (!shape.ok) throw new Error(shape.reason)
      const along = airAlong(snaps[4], zigzag(2, 2, 58, 38, -2, 2), shape.value)
      return { prints: snaps.map(s => s.fingerprint), cols: snaps.map(s => bytes(s).toString('base64')), notes: snaps.map(s => s.notes),
        air: Array.from(along.air), intr: Array.from(along.intrusionMm) }
    }
    expect(run()).toEqual(run())
  })

  it('nothing is persisted: no write API, no storage, a new lifecycle starts empty, snapshots are frozen', () => {
    const lifecycle = createMaterialLifecycle({ stock: STOCK })
    expect(Object.keys(lifecycle).sort()).toEqual(['clear', 'grid', 'isValid', 'policy', 'snapshotAfter', 'snapshotBefore', 'stats', 'stock'])
    expect(lifecycle.stats()).toEqual({ hits: 0, operationsReplayed: 0, held: 0 })
    const snap = lifecycle.snapshotAfter(smallChain(), 4)
    expect(Object.isFrozen(snap)).toBe(true)
    expect(lifecycle.stats().held).toBe(6)
    lifecycle.clear()
    expect(lifecycle.stats().held).toBe(0)
    const dir = 'src/kernel/material'
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8')
      expect(text, file).not.toMatch(/localStorage|indexedDB|IndexedDB|OPFS|node:fs|writeFile|serializeStockState/)
    }
  })

  it('P0: nothing in the app calls the material service (only its own files and tests import it)', () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) { if (path !== join('src', 'tests') && path !== join('src', 'kernel', 'material')) walk(path); continue }
        if (!/\.(ts|tsx|mts)$/.test(name)) continue
        if (/kernel\/material/.test(readFileSync(path, 'utf8'))) callers.push(path)
      }
    }
    walk('src')
    expect(callers).toEqual([])
  })
})

// ─── rough, finish, rough: snapshotAfter(N) for a non-adjacent later operation ──

interface PlannedChain { box: typeof STOCK; rough: { tool: Tool; moves: ToolpathMove[] }; finish: { tool: Tool; moves: ToolpathMove[] } }
let planned: PlannedChain

beforeAll(async () => {
  const { alpha3Chains, toolById } = await import('../benchmark/registry')
  const { inventoryTools } = await import('../benchmark/alpha3Registry')
  const { chainScene, planChain } = await import('../benchmark/chainRunner')
  const chain = alpha3Chains().find(c => c.id === 'stepped-boss-rough-finish-declared')!
  const plan = await planChain(chain)
  const { box } = await chainScene(chain)
  const step = (id: string) => {
    const s = chain.steps.find(x => x.id === id)!
    return { tool: inventoryTools([toolById(s.toolId).libraryTool!])[0], moves: plan.steps.find(p => p.stepId === id)!.moves }
  }
  planned = { box, rough: step('rough-6-flat'), finish: step('finish-3-ball') }
}, 300_000)

describe('WO-3032 material lifecycle: rough, finish, rough', () => {
  it('snapshotAfter(finish) holds both earlier cuts for the second rough; the parity hand-off still starts it from the stock box', () => {
    const { box, rough, finish } = planned
    const chain: MaterialOperation[] = [
      { id: 'rough-1', type: 'adaptive_3d', enabled: true, status: 'ready', tool: rough.tool, moves: rough.moves },
      { id: 'finish', type: 'parallel_3d', enabled: true, status: 'ready', tool: finish.tool, moves: finish.moves },
      { id: 'rough-2', type: 'adaptive_3d', enabled: true, status: 'pending', tool: rough.tool, moves: undefined },
    ]
    const lifecycle = createMaterialLifecycle({ stock: box })
    const forRough2 = lifecycle.snapshotBefore(chain, 2)
    expect(forRough2.afterIndex).toBe(1)
    // Independent truth: today's field, today's sweep, both cuts in order.
    const truth = ZDexelField.fromBox(box, 0.2, 1_000_000)
    for (const op of [rough, finish]) {
      const cutter = toolToCutterSpec(op.tool) as Parameters<typeof removeSweep>[2]
      for (const sweep of toolpathMovesToLinearSweeps(op.moves, truth.cell / 4)) removeSweep(truth, sweep, cutter)
    }
    expect(bytes(forRough2).equals(Buffer.from(truth.top.buffer))).toBe(true)
    const today = remainingStockBefore(chain.slice(0, 2).map(op => ({ enabled: op.enabled, status: op.status, toolpathMoves: op.moves, tool: op.tool })),
      { min: { x: box.minX, y: box.minY, z: box.minZ }, max: { x: box.maxX, y: box.maxY, z: box.maxZ } })!
    expect(Buffer.from(today.stock.topZ.buffer).equals(bytes(forRough2))).toBe(true)
    // The finish took material the first rough left: the second rough's snapshot is not the first rough's.
    expect(bytes(lifecycle.snapshotAfter(chain, 0)).equals(bytes(forRough2))).toBe(false)

    // Parity: adjacent roughs only. The second rough follows a finish, so today starts it from the stock box.
    const facts = {
      retained: { sameClient: true, setupId: 's', opId: 'rough-1', geometryId: 'g', stockBounds: box, cellSize: 0.5, upstreamChainFingerprint: 'f' },
      setupId: 's', previous: { id: 'finish', type: 'parallel_3d', enabled: true, status: 'ready' }, geometryId: 'g', stockBounds: box,
      cellSize: 0.5, upstreamChainFingerprint: 'f',
    }
    const client = {} as never
    expect(restStartStockFor({ retained: { ...facts.retained, client, handle: {} as never }, client, setupId: 's', previousOp: facts.previous as never,
      geometryId: 'g', stockBounds: box, cellSize: 0.5, upstreamChainFingerprint: 'f' })).toBeUndefined()
    expect(adaptiveHandoff(facts).source).toBe('stock-box')
    // MD-52 as a policy value (OFF; CARD V02 first) would start it from that snapshot.
    expect(adaptiveHandoff(facts, { ...PARITY_POLICY, non_adjacent_handoff: true }, { lifecycle, chain, n: 2 }))
      .toEqual({ source: 'snapshot', afterIndex: 1 })
    expect(PARITY_POLICY.non_adjacent_handoff).toBe(false)
  })

  it('M-TIME-2: replay time of the planned chain is measured and recorded (no budget set yet)', () => {
    const { box, rough, finish } = planned
    const chain: MaterialOperation[] = [
      { id: 'rough', type: 'adaptive_3d', enabled: true, status: 'ready', tool: rough.tool, moves: rough.moves },
      { id: 'finish', type: 'parallel_3d', enabled: true, status: 'ready', tool: finish.tool, moves: finish.moves },
    ]
    const t0 = performance.now()
    const replayed = replaySnapshotAfter(box, chain, 1)
    const replayMs = performance.now() - t0
    const lifecycle = createMaterialLifecycle({ stock: box })
    lifecycle.snapshotAfter(chain, 1)
    const t1 = performance.now()
    const cached = lifecycle.snapshotAfter(chain, 1)
    const cachedMs = performance.now() - t1
    expect(bytes(cached).equals(bytes(replayed))).toBe(true)
    console.info(`[WO-3032] M-TIME-2 stepped-boss rough+finish (${rough.moves.length + finish.moves.length} moves, ` +
      `${replayed.field.nx}x${replayed.field.ny} columns at ${replayed.field.cell} mm): replay ${replayMs.toFixed(1)} ms, cached answer ${cachedMs.toFixed(2)} ms`)
    expect(replayMs).toBeGreaterThan(0)
  })
})
