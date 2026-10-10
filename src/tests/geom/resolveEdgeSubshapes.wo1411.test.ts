// WO-1411: the kernel's "did this reference survive" check (GeomEngine.resolve,
// the frozen interrogation every CAM op's bound subshapes are re-checked
// against on each regen pass) used to build its lookup from FACES only, so
// every edge id came back 'lost' and a picked edge-chain contour degraded on
// the first regen pass after binding - whether or not its edge changed.
//
// Everything here runs on the REAL occt-wasm kernel. The store case drives
// the same steps SolidsWorkbenchPage.reresolveCamModelRefs runs: gather the
// op's ids, engine.resolve() against the live body, hand the reply to
// useCamStore.reresolveModelReferences (-> classifyOperation).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, StableId, TessBuffers } from '../../geom/geom-service.ts'
import { parseStableId, vertexId } from '../../doc/stable-id.ts'
import { healedStep } from './fixtures/healedStep.ts'
import { MODEL_EDGE_CHAIN_ROLE } from '../../store/modelEdgeChainBinding'
import { referenceStableIds, type BodyResolution } from '../../lib/cam/modelReferenceResolution'
import type { Operation, Setup } from '../../types'

const { useCamStore } = await import('../../store')

const BOX = { x: 60, y: 30, z: 12 }
const face = (tag: string): StableId => `F1:BOX:${tag}` as StableId

/** The ONE tessellated edge naming both faces. Fails loud on 0 or >1. */
function edgeNaming(tess: TessBuffers, a: StableId, b: StableId): StableId {
  const hits = tess.edgeIds.filter((id) => {
    const parsed = parseStableId(id as string)
    return parsed.kind === 'edge' && parsed.operands.length === 2 &&
      parsed.operands.some((o) => o.raw === a) && parsed.operands.some((o) => o.raw === b)
  })
  if (hits.length !== 1) throw new Error(`expected 1 edge naming ${a} and ${b}, found ${hits.length}: ${hits.join(', ')}`)
  return hits[0] as StableId
}

/** The hole's top rim: the one circular edge lying on the top plane about the
 *  given centre. Located geometrically, never by name. */
function holeRimEdgeId(tess: TessBuffers, cx: number, cy: number): StableId {
  const hits: string[] = []
  for (let e = 0; e < tess.edgeIds.length; e++) {
    const start = tess.edgeOffsets[e]
    const end = tess.edgeOffsets[e + 1]
    if (end - start < 3) continue
    let onTop = true
    let minR = Infinity, maxR = -Infinity
    for (let p = start; p < end; p++) {
      if (Math.abs(tess.edgePositions[p * 3 + 2] - BOX.z) > 1e-6) { onTop = false; break }
      const r = Math.hypot(tess.edgePositions[p * 3] - cx, tess.edgePositions[p * 3 + 1] - cy)
      minR = Math.min(minR, r)
      maxR = Math.max(maxR, r)
    }
    if (onTop && maxR - minR < 0.05 && maxR < 10) hits.push(tess.edgeIds[e])
  }
  if (hits.length !== 1) throw new Error(`expected 1 hole rim edge about (${cx},${cy}), found ${hits.length}`)
  return hits[0] as StableId
}

describe('WO-1411: GeomEngine.resolve() sees edges and vertices (real kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  async function drill(body: BodyHandle, featureId: string, x: number, y: number, diameter: number): Promise<BodyHandle> {
    const r = await engine.makeHole({
      featureId, body, face: face('zMax'),
      points: [{ x, y, z: BOX.z }],
      style: { kind: 'simple', diameter },
      depth: { kind: 'throughAll' },
    })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    return r.body!
  }

  it('#1 an unchanged edge and vertex resolve exact, and stay exact through an unrelated edit elsewhere', async () => {
    const box = await engine.makeBox('F1', BOX)
    expect(box.ok).toBe(true)
    const tess = await engine.tessellate(box.body!, { deflection: 0.1 })
    const edge = edgeNaming(tess, face('xMax'), face('zMax'))
    const corner = vertexId([face('xMax'), face('yMax'), face('zMax')])

    const [e0, v0] = await engine.resolve(box.body!, [edge, corner])
    expect(e0).toMatchObject({ id: edge, status: 'exact', type: 'edge' })
    expect(e0.localIndex).toBeGreaterThanOrEqual(0)
    expect(v0).toMatchObject({ id: corner, status: 'exact', type: 'vertex' })
    expect(v0.localIndex).toBeGreaterThanOrEqual(0)

    // An unrelated edit: a hole through the middle of the top, nowhere near
    // the xMax/zMax edge or its corner.
    const drilled = await drill(box.body!, 'H1', 30, 15, 8)
    const [e1, v1] = await engine.resolve(drilled, [edge, corner])
    expect(e1).toMatchObject({ id: edge, status: 'exact', type: 'edge' })
    expect(v1).toMatchObject({ id: corner, status: 'exact', type: 'vertex' })
    await engine.disposeAll()
  }, 120_000)

  it('#2 an edge whose adjacent face merged away resolves fallback onto its lineage survivor, never lost', async () => {
    const { merge, body, before } = await healedStep(engine)
    const preTess = await engine.tessellate(before, { deflection: 0.1 })
    const persisted = preTess.edgeIds.filter((id) => {
      const parsed = parseStableId(id as string)
      return parsed.kind === 'edge' && parsed.disambiguator === undefined && parsed.operands.length === 2 &&
        parsed.operands.every((o) => !o.isSeam && !o.isOrphan) && parsed.operands.some((o) => o.raw === merge.loser)
    }) as StableId[]
    expect(persisted.length, `fixture: expected pre-edit edges naming ${merge.loser}`).toBeGreaterThan(0)

    // Every live edge of the healed body, keyed by the local index resolve()
    // reports for it -- so a fallback's localIndex names a real survivor.
    const postTess = await engine.tessellate(body, { deflection: 0.1 })
    const liveByIndex = new Map<number, StableId>()
    for (const r of await engine.resolve(body, postTess.edgeIds as StableId[])) {
      expect(r, `live edge ${r.id} must resolve exact on its own body`).toMatchObject({ status: 'exact', type: 'edge' })
      liveByIndex.set(r.localIndex!, r.id)
    }
    expect(postTess.edgeIds.some((id) => (id as string).includes(merge.loser as string))).toBe(false)

    const replies = await engine.resolve(body, persisted)
    for (const [i, id] of persisted.entries()) {
      expect(replies[i], `persisted edge ${id}`).toMatchObject({ id, status: 'fallback', type: 'edge' })
      // The survivor it binds to is the lineage edge: it names the merge winner
      // where the persisted id named the loser.
      const survivor = liveByIndex.get(replies[i].localIndex!)
      expect(survivor, `persisted edge ${id} bound to no live edge`).toBeDefined()
      const ops = (parseStableId(survivor as string) as { operands: Array<{ raw: string }> }).operands
      expect(ops.map((o) => o.raw), `persisted edge ${id} -> survivor ${survivor}`).toContain(merge.winner)
    }
    await engine.disposeAll()
  }, 120_000)

  it('#3 an edge (and its corner) genuinely removed by an edit resolves lost', async () => {
    const box = await engine.makeBox('F1', BOX)
    const tess = await engine.tessellate(box.body!, { deflection: 0.1 })
    const edge = edgeNaming(tess, face('xMax'), face('zMax'))
    const corner = vertexId([face('xMax'), face('yMax'), face('zMax')])
    const filleted = await engine.applyFillet({ featureId: 'FIL1', body: box.body!, edges: [edge], radius: 2, propagateTangent: true })
    expect(filleted.ok, JSON.stringify(filleted.diagnostics)).toBe(true)
    const after = await engine.tessellate(filleted.body!, { deflection: 0.1 })
    expect(after.edgeIds, 'fixture: the fillet must remove the picked edge').not.toContain(edge)

    const [e, v] = await engine.resolve(filleted.body!, [edge, corner])
    expect(e).toEqual({ id: edge, status: 'lost' })
    expect(v).toEqual({ id: corner, status: 'lost' })
    await engine.disposeAll()
  }, 120_000)

  it('#4 STORE: a picked edge-chain contour is NOT degraded by the regen pass after an unrelated model edit', async () => {
    const box = await engine.makeBox('F1', BOX)
    const plate = await drill(box.body!, 'H1', 30, 15, 8)
    const rim = holeRimEdgeId(await engine.tessellate(plate, { deflection: 0.05 }), 30, 15)

    const op = {
      id: 'op-1', name: 'Contour', type: 'contour_2d', enabled: true, status: 'ready',
      toolId: 't', geometrySelections: [],
      modelReferences: [{ bodyId: 'F1', stableIds: [rim], role: MODEL_EDGE_CHAIN_ROLE }],
      heights: {}, passes: {}, linking: {}, params: {},
      toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    } as unknown as Operation
    const setup = { id: 's1', name: 'S1', wcs: {}, stock: {}, operations: [op], notes: '' } as unknown as Setup
    useCamStore.setState((s) => ({
      lastModelReresolveSeq: 0,
      activeModelItemId: null,
      project: { ...s.project, setups: [setup] },
    }) as never)

    // The unrelated edit: a second, small hole in a far corner of the plate.
    const edited = await drill(plate, 'H2', 8, 8, 4)

    // The regen pass, step for step as reresolveCamModelRefs runs it.
    const idsByBody = new Map<string, Set<string>>()
    const expectedOps = new Map<string, Operation>()
    for (const s of useCamStore.getState().project.setups) {
      for (const candidate of s.operations) {
        if (!candidate.modelReferences?.length) continue
        expectedOps.set(candidate.id, candidate)
        for (const ref of candidate.modelReferences) {
          const set = idsByBody.get(ref.bodyId) ?? new Set<string>()
          for (const id of referenceStableIds(ref, `op "${candidate.id}"`)) set.add(id)
          idsByBody.set(ref.bodyId, set)
        }
      }
    }
    const bodies: BodyResolution[] = []
    for (const [bodyId, idSet] of idsByBody) {
      const resolved = await engine.resolve(edited, [...idSet] as StableId[])
      bodies.push({
        bodyId, changed: true,
        resolutions: resolved.map((r) => ({ id: r.id, status: r.status, localIndex: r.localIndex, type: r.type })),
      })
    }
    useCamStore.getState().reresolveModelReferences(bodies, 1, expectedOps)

    const after = useCamStore.getState().project.setups[0].operations[0]
    expect(after.status).not.toBe('degraded')
    expect(after.status).toBe('outdated') // the body changed: amber, not red
    expect(after.modelReferenceNote ?? '').not.toMatch(/removed|lost/i)
    await engine.disposeAll()
  }, 120_000)
})
