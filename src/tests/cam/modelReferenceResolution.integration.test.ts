// CAM-1 (D2) — REAL occt-wasm kernel proof of the resolve() -> mapping -> store
// leg. The pure unit test (modelReferenceResolution.test.ts) hand-writes resolve
// statuses; THIS test feeds the mapping the ACTUAL output of the frozen
// client.resolve() (via createLocalGeomService, the in-thread kernel facade the
// browser worker client mirrors), so the exact/lost outcomes driving the op flip
// are real, not asserted. Mirrors geomBridgeSession.integration.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom/index.ts'
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession'
import type { RayLike } from '../../viewport3d/types'
import type { Operation, Setup } from '../../types'
import { reresolveModelReferences, type BodyResolution, type RawResolution } from '../../lib/cam/modelReferenceResolution'

const BOX = { x: 40, y: 20, z: 10 }
function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  }
}

// A minimal ready op referencing bodyId 'BOX' with the given stableIds.
function opWith(stableIds: string[]): Operation {
  return {
    id: 'op-1', name: 'Contour', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 't', geometrySelections: [],
    modelReferences: [{ bodyId: 'BOX', stableIds, role: 'machining-boundary' }],
    heights: {} as never, passes: {} as never, linking: {} as never, params: {},
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 } as never],
  }
}
function setupWith(op: Operation): Setup {
  return { id: 's1', name: 'S1', wcs: {} as never, stock: {} as never, operations: [op], notes: '' }
}
// Build a BodyResolution straight from the kernel's own resolve() reply.
function fromResolve(bodyId: string, changed: boolean, reply: Array<{ id: string; status: string; localIndex?: number; type?: string }>): BodyResolution {
  const resolutions: RawResolution[] = reply.map(r => ({ id: r.id, status: r.status, localIndex: r.localIndex, type: r.type }))
  return { bodyId, changed, resolutions }
}

describe('ModelReference re-resolution against the REAL occt-wasm kernel', () => {
  let client: GeomClient

  beforeAll(async () => { client = createLocalGeomService() }, 60_000)
  afterAll(async () => { await client.terminate() })

  it('a REAL exact face id + regenerated body -> op flips to outdated (stale)', async () => {
    const session = new GeomBridgeSession(client)
    await session.init()
    const handle = await session.createBox('box', { featureId: 'FBX', size: BOX })
    await session.tessellateProgressive('box')

    const faceHit = session.pick(['box'], ray([20, 10, 100], [0, 0, -1]), 'face')
    if (faceHit === null || faceHit.kind !== 'face') throw new Error('expected a face pick')
    const reply = await client.resolve(handle, [faceHit.id])
    expect(reply[0].status).toBe('exact') // REAL kernel outcome, not asserted

    const { setups, changedOpIds } = reresolveModelReferences(
      [setupWith(opWith([faceHit.id]))],
      [fromResolve('BOX', true, reply)], // body regenerated this pass
    )
    expect(changedOpIds).toEqual(['op-1'])
    expect(setups[0].operations[0].status).toBe('outdated')
    // S5 audit DEFECT 1 ruling 2026-07-22: amber (outdated) RETAINS the
    // pre-edit toolpath, same as degraded below.
    expect(setups[0].operations[0].toolpathMoves).toBeDefined()

    // Same real exact id but body UNCHANGED -> op stays ready.
    const clean = reresolveModelReferences(
      [setupWith(opWith([faceHit.id]))],
      [fromResolve('BOX', false, reply)],
    )
    expect(clean.changedOpIds).toEqual([])
    expect(clean.setups[0].operations[0].status).toBe('ready')

    await session.disposeBody('box')
  }, 60_000)

  it('a REAL lost id -> op degrades, keeping its toolpath', async () => {
    const session = new GeomBridgeSession(client)
    await session.init()
    const handle = await session.createBox('box2', { featureId: 'FBX2', size: BOX })
    await session.tessellateProgressive('box2')

    // WO-1411: a picked edge id now resolves 'exact' on its own body. The
    // same edge named on a feature this body does not carry is genuinely
    // absent -- the kernel's real 'lost' reply for a removed reference.
    const edgeHit = session.pick(['box2'], ray([90, 20, 40], [-50, -10, -30]), 'edge')
    if (edgeHit === null || edgeHit.kind !== 'edge') throw new Error('expected an edge pick')
    const pickedId = typeof edgeHit.id === 'string' ? edgeHit.id : String(edgeHit.id)
    expect((await client.resolve(handle, [pickedId]))[0].status).toBe('exact')
    const edgeId = pickedId.split('FBX2:').join('FGONE:')
    expect(edgeId).not.toBe(pickedId)
    const reply = await client.resolve(handle, [edgeId])
    expect(reply[0].status).toBe('lost') // REAL kernel outcome

    const op = opWith([edgeId])
    const { setups, changedOpIds } = reresolveModelReferences([setupWith(op)], [fromResolve('BOX', false, reply)])
    expect(changedOpIds).toEqual(['op-1'])
    expect(setups[0].operations[0].status).toBe('degraded')
    expect(setups[0].operations[0].toolpathMoves).toBeDefined() // last-known toolpath retained

    await session.disposeBody('box2')
  }, 60_000)
})
