// WO-3035 (alpha.3 A3-23, step 4): the kernel freshness rule's unit tests.
// The two holes the characterisation tests settle on `current`
// (freshnessLiftedTraverse / freshnessFaceRestUngeneratedPocket .wo3035):
//   1. a lifted-traverse 3D finish stays current after reload;
//   2. a Face rest goes stale when a never-generated pocket's loops change.
// The lifted moves come from cam3d's real path builder (buildLinkedPath), the
// same builder Parallel 3D links through; nothing is hand-drawn.

import { describe, expect, it } from 'vitest'
import { buildLinkedPath, TRAVERSE_STANDOFF_MM, type ConnectorSampler } from '../../cam3d/pathbuild'
import {
  freshnessStamp,
  freshnessVerdict,
  generationRecord,
  resolveTraversePlane,
  type DeclaredPredecessor,
  type FreshnessInputs,
  type SavedMove,
} from '../../kernel/session/freshness'

// The G-15 scenario in machine mm: proven stock top 13, operator Clearance
// 0.5 above it, part (Material Start) 10, finish depth 1.5.
const STOCK_TOP = 13
const PLANES = { clearance: 13.5, retract: 13.5, feed: 13.25, top: 10, bottom: 8.5 }
const ANCHORED = { traverseAnchored: true }

const flat: ConnectorSampler = async xy => new Float64Array(xy.length / 2).fill(PLANES.top)
function pass(y: number): Float64Array {
  const points: number[] = []
  for (let x = 0; x <= 10; x++) points.push(x, y, PLANES.top)
  return new Float64Array(points)
}

/** Two raster passes too far apart to stay down: the link goes over the traverse plane. */
async function liftedFinishMoves(materialTopZ: number | undefined): Promise<SavedMove[]> {
  const moves = await buildLinkedPath(
    [pass(0), pass(20)],
    { clearanceZ: PLANES.clearance, retractZ: PLANES.retract, feedZ: PLANES.feed,
      ...(materialTopZ === undefined ? {} : { materialTopZ }) },
    { stepover: 2, cutterContactRadiusMm: 3 },
    flat,
  )
  return moves.map(move => ({ type: move.t === 'rapid' ? 'rapid' : 'feed', z: move.z }))
}

/** `null`: no proven material top. */
function finishInputs(stockTop: number | null = STOCK_TOP): FreshnessInputs {
  return {
    engineId: 'kernel',
    operation: { id: 'op-1', type: 'parallel_3d', params: { finishDepth: 1.5, stepover: 2 } },
    planes: { ...PLANES },
    traverse: resolveTraversePlane({
      clearanceMm: PLANES.clearance, provenMaterialTopMm: stockTop ?? undefined,
      standoffMm: TRAVERSE_STANDOFF_MM, proofIds: ['stock-1'],
    }),
    predecessors: [],
    context: { toolId: 'tool-1', stockId: 'stock-1' },
  }
}

/** Save -> Open: what survives is what JSON carries. */
const reload = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const rect = (cx: number, cy: number, hx: number, hy: number) =>
  [{ x: cx - hx, y: cy - hy }, { x: cx + hx, y: cy - hy }, { x: cx + hx, y: cy + hy }, { x: cx - hx, y: cy + hy }]

/** The pocket as DECLARED: its footprint loops and floor. It was never
 *  generated, and nothing here says whether it was. */
function pocket(loop = rect(0, 0, 20, 15)): DeclaredPredecessor {
  return { id: 'rest-prior', relation: 'subtracts', geometry: { loops: [loop], floorWcsMm: -6 } }
}
function faceRestInputs(predecessor = pocket()): FreshnessInputs {
  return {
    engineId: 'kernel',
    operation: { id: 'face-1', type: 'face', params: { boundarySource: 'rest' } },
    planes: { clearance: 26, retract: 21, feed: 21, top: 16, bottom: 11 },
    traverse: resolveTraversePlane({ clearanceMm: 26, standoffMm: TRAVERSE_STANDOFF_MM }),
    predecessors: [predecessor],
    context: { toolId: 'face-tool', stockId: 'stock-1' },
  }
}
const faceMoves: SavedMove[] = [
  { type: 'rapid', z: 26 }, { type: 'rapid', z: 21 }, { type: 'feed', z: 11 }, { type: 'feed', z: 11 }, { type: 'rapid', z: 26 },
]

describe('WO-3035 kernel freshness rule', () => {
  it('a lifted-traverse finish stays current after reload', async () => {
    const moves = await liftedFinishMoves(STOCK_TOP)
    // The case is real: the builder lifted every traverse above Clearance.
    const rapidTop = Math.max(...moves.filter(move => move.type === 'rapid').map(move => move.z))
    expect(rapidTop).toBeCloseTo(STOCK_TOP + TRAVERSE_STANDOFF_MM, 9)
    expect(rapidTop).toBeGreaterThan(PLANES.clearance)
    const inputs = finishInputs()
    expect(inputs.traverse).toEqual({ machineMm: 14, owner: 'proven_material_top', proofIds: ['stock-1'] })

    const saved = reload({ record: generationRecord(inputs), moves })
    expect(freshnessVerdict(saved.record, saved.moves, finishInputs(), ANCHORED)).toEqual({ current: true })
    // The traverse plane is an input: a proven stock top that moves the plane outdates the result.
    expect(freshnessVerdict(saved.record, saved.moves, finishInputs(STOCK_TOP + 2), ANCHORED))
      .toEqual({ current: false, reason: 'inputs_changed' })
  })

  it('a Face rest goes stale when the never-generated pocket\'s loops change', () => {
    const saved = reload({ record: generationRecord(faceRestInputs()), moves: faceMoves })
    expect(freshnessVerdict(saved.record, saved.moves, faceRestInputs(), { traverseAnchored: false }))
      .toEqual({ current: true })
    const edited = faceRestInputs(pocket(rect(0, 0, 10, 8)))
    expect(freshnessVerdict(saved.record, saved.moves, edited, { traverseAnchored: false }))
      .toEqual({ current: false, reason: 'inputs_changed' })
  })

  it('no spurious staleness: compute twice and reload, both scenarios, key order irrelevant', async () => {
    const first = generationRecord(finishInputs())
    const second = generationRecord(finishInputs())
    expect(second).toEqual(first)
    const movesA = await liftedFinishMoves(STOCK_TOP)
    const movesB = await liftedFinishMoves(STOCK_TOP)
    expect(movesB).toEqual(movesA)
    const shuffled = finishInputs()
    shuffled.operation = { params: { stepover: 2, finishDepth: 1.5 }, type: 'parallel_3d', id: 'op-1' }
    expect(freshnessStamp(shuffled)).toBe(first.stamp)
    const saved = reload({ record: first, moves: movesA })
    expect(freshnessVerdict(reload(saved.record), reload(saved.moves), shuffled, ANCHORED)).toEqual({ current: true })

    const face = reload(generationRecord(faceRestInputs()))
    expect(face).toEqual(generationRecord(faceRestInputs()))
    expect(freshnessVerdict(face, reload(faceMoves), faceRestInputs(), { traverseAnchored: false }))
      .toEqual({ current: true })
  })

  it('an unlifted plane is Clearance-owned and the check stays as strict as today\'s', async () => {
    // No proven material top: the builder and the rule both use Clearance.
    const moves = await liftedFinishMoves(undefined)
    const inputs = finishInputs(null)
    expect(inputs.traverse).toEqual({ machineMm: PLANES.clearance, owner: 'clearance', proofIds: [] })
    expect(freshnessVerdict(generationRecord(inputs), moves, inputs, ANCHORED)).toEqual({ current: true })
    // A move above the plane that produced it, or under Bottom, is still refused.
    const above = [...moves, { type: 'rapid', z: PLANES.clearance + 0.1 }]
    expect(freshnessVerdict(generationRecord(inputs), above, inputs, ANCHORED))
      .toEqual({ current: false, reason: 'moves_outside_plan' })
    const under = [...moves, { type: 'feed', z: PLANES.bottom - 0.1 }]
    expect(freshnessVerdict(generationRecord(inputs), under, inputs, ANCHORED))
      .toEqual({ current: false, reason: 'moves_outside_plan' })
    // The anchor: a 3D path with no rapid at its traverse plane is not this plan's.
    const unanchored = moves.filter(move => !(move.type === 'rapid' && move.z === PLANES.clearance))
    expect(freshnessVerdict(generationRecord(inputs), unanchored, inputs, ANCHORED))
      .toEqual({ current: false, reason: 'moves_outside_plan' })
    // Clearance at or above stock top + standoff is not lifted.
    expect(resolveTraversePlane({ clearanceMm: 14, provenMaterialTopMm: 13, standoffMm: 1, proofIds: ['s'] }))
      .toEqual({ machineMm: 14, owner: 'clearance', proofIds: [] })
  })

  it('malformed or empty saved results are never current on reload', () => {
    const inputs = faceRestInputs()
    const record = generationRecord(inputs)
    const options = { traverseAnchored: false }
    expect(freshnessVerdict(undefined, faceMoves, inputs, options)).toEqual({ current: false, reason: 'malformed_record' })
    expect(freshnessVerdict(record, undefined, inputs, options)).toEqual({ current: false, reason: 'malformed_record' })
    expect(freshnessVerdict({ ...record, version: 0 }, faceMoves, inputs, options))
      .toEqual({ current: false, reason: 'malformed_record' })
    expect(freshnessVerdict({ ...record, traverse: { ...record.traverse, machineMm: 40 } }, faceMoves, inputs, options))
      .toEqual({ current: false, reason: 'malformed_record' })
    expect(freshnessVerdict(record, [], inputs, options)).toEqual({ current: false, reason: 'moves_outside_plan' })
    expect(freshnessVerdict(record, [], inputs, { ...options, allowEmpty: true })).toEqual({ current: true })
    expect(() => resolveTraversePlane({ clearanceMm: 5, standoffMm: 0 })).toThrow(/standoff/)
  })
})
