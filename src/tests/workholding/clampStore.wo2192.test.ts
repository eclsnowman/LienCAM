// WO-2192 (workholding assemblies, slice 5): clamps along a stock or part
// edge, through the REAL store actions the screens call (makeClamp,
// placeClamp, moveClampOnEdge, duplicateClamps, removeWorkholdingInstance,
// moveClampsToSetup, copyClampsToSetup) and the real stock / part edits
// (updateFixedStock, updateGeometryTransform, removeGeometry). The pose each
// clamp gets is read back through the ONE resolver CAM and simulation read.
//
// SCENE (worked out by hand): a fixed stock 100 x 60 x 20 with its min corner
// at the origin - its edge runs counter-clockwise (0,0) -> (100,0) -> (100,60)
// -> (0,60), 320 mm long, top at Z 20. A clamp body 30 x 10 x 8 (X x Y x Z).
// A part block 40 x 20 x 10 at (200, 0, 0).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3, WorkholdingPose } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { resolveWorkholding } = await import('../../lib/workholding/resolveWorkholding')
const { clampEdgeLost, clampBoundaries, nearestBoundaryPoint } = await import('../../lib/workholding/clamps')

const ZERO = { x: 0, y: 0, z: 0 }

function blockRow(id: string, name: string, size: Vec3, position: Vec3, workholding: boolean): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size: { ...size }, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position, rotation: { ...ZERO }, loaded: true, ...(workholding ? { workholding: true } : {}),
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function history() { return state().projectHistory.length }
function instances() { return state().project.workholding?.instances ?? [] }
function instance(id: string) { return instances().find((i) => i.id === id)! }
const r3 = (n: number) => Math.round(n * 1000) / 1000
function pose(p: WorkholdingPose) {
  return [r3(p.position.x), r3(p.position.y), r3(p.position.z), r3(p.rotation.z)]
}

/** World XY bounds + Z range of the clamp body the resolver places for `instanceId`. */
async function resolvedBox(instanceId: string, setupId = state().project.activeSetupId) {
  const { bodies } = await resolveWorkholding(state().project, setupId)
  const body = bodies.find((b) => b.instanceId === instanceId)
  if (!body) return null
  const p = body.mesh.positions
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i])
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1])
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2])
  }
  return [minX, maxX, minY, maxY, minZ, maxZ].map(r3)
}

let clampDef = ''
const STOCK = { kind: 'stock' as const, id: 'stock-a', loopId: 'outline' }
const PART = { kind: 'part' as const, id: 'part-1', loopId: 'outline' }

beforeEach(() => {
  resetDocumentHolder()
  vi.stubGlobal('alert', vi.fn())
  state().newProject()
  state().addFixedStock({ id: 'stock-a', name: 'Plate', width: 100, height: 60, depth: 20, position: { ...ZERO } })
  state().addGeometry(blockRow('clamp-body', 'Strap clamp', { x: 30, y: 10, z: 8 }, { x: -80, y: -80, z: 0 }, true))
  state().addGeometry(blockRow('part-1', 'Block', { x: 40, y: 20, z: 10 }, { x: 200, y: 0, z: 0 }, false))
  const d0 = history()
  clampDef = state().makeClamp('clamp-body', 'Strap clamp')!
  expect(clampDef).toBeTruthy()
  expect(history()).toBe(d0 + 1)
})

describe('WO-2192: clamps along an edge (store actions the Setup screen calls)', () => {
  it('places on a stock edge: pose from the edge direction, outward offset, on the stock top; one undo step', async () => {
    const d0 = history()
    // 1/8 of 320 = 40 mm along the first (front, +X) side: (40, 0), running +X, outward -Y.
    const id = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.125 })!
    expect(history()).toBe(d0 + 1)
    expect(pose(instance(id).worldPose)).toEqual([40, 0, 20, 0])
    // Straddles the edge, resting on the stock top: 30 along the edge, 10 across it.
    expect(await resolvedBox(id)).toEqual([25, 55, -5, 5, 20, 28])

    // On the right side (fraction 0.4 = 128 mm = 28 up the +X side), 4 mm outward: turned 90.
    const right = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.4, normalOffsetMm: 4 })!
    expect(pose(instance(right).worldPose)).toEqual([104, 28, 20, 90])
    expect(await resolvedBox(right)).toEqual([99, 109, 13, 43, 20, 28])
    expect(new Set(instances().map((i) => i.id)).size).toBe(2)

    state().undo()
    expect(instances().map((i) => i.id)).toEqual([id])
  })

  it('places on a part edge: the part outline at its scene pose', async () => {
    // Part block X 180..220, Y -10..10, top Z 10. Its outline starts at (180,-10); 0.25 of 120 = 30 -> (210,-10).
    const id = state().placeClamp({ definitionId: clampDef, target: PART, fraction: 0.25 })!
    expect(pose(instance(id).worldPose)).toEqual([210, -10, 10, 0])
    expect(await resolvedBox(id)).toEqual([195, 225, -15, -5, 10, 18])
    // The placer's pick: a click near the part's right side lands on it, turned 90.
    const hit = nearestBoundaryPoint(clampBoundaries(state().project, 'part'), { x: 223, y: 2 })!
    expect(hit.boundary.target).toEqual(PART)
    const onRight = state().placeClamp({ definitionId: clampDef, target: hit.boundary.target, fraction: hit.fraction })!
    expect(pose(instance(onRight).worldPose)).toEqual([220, 2, 10, 90])
  })

  it('slides along its edge, across the loop start, in one undo step; the same place writes nothing', () => {
    const id = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.95 })!
    // 0.95 of 320 = 304: on the left side (0, 60) -> (0, 0) at 304 - 260 = 44 down: (0, 16), running -Y.
    expect(pose(instance(id).worldPose)).toEqual([0, 16, 20, -90])
    const d0 = history()
    state().moveClampOnEdge(id, { fraction: 1.05 }) // past the start: 16 mm along the front side
    expect(history()).toBe(d0 + 1)
    expect(pose(instance(id).worldPose)).toEqual([16, 0, 20, 0])
    expect((instance(id).placement as { fraction: number }).fraction).toBeCloseTo(0.05, 12)
    state().moveClampOnEdge(id, { fraction: 0.05 })
    expect(history()).toBe(d0 + 1)
    state().undo()
    expect(pose(instance(id).worldPose)).toEqual([0, 16, 20, -90])
  })

  it('duplicate / delete / move and copy to setup B: one undo step each, distinct ids, pose kept', async () => {
    type NewSetup = Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0]
    state().addSetup({ id: 'setup-a', name: 'Setup A', operations: [] } as unknown as NewSetup)
    state().addSetup({ id: 'setup-b', name: 'Setup B', operations: [] } as unknown as NewSetup)
    state().setActiveSetup('setup-a')
    const setupA = state().project.activeSetupId!
    expect(setupA).toBe('setup-a')
    const id = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.125 })!

    let d = history()
    const [dup] = state().duplicateClamps([id])
    expect(history()).toBe(d + 1)
    expect(dup).not.toBe(id)
    // Beside it: one clamp length (30) + 10 further along the edge, at (80, 0).
    expect(pose(instance(dup).worldPose)).toEqual([80, 0, 20, 0])
    expect(instance(dup).setupScope).toEqual(instance(id).setupScope)

    d = history()
    state().removeWorkholdingInstance(dup)
    expect(history()).toBe(d + 1)
    expect(instances().map((i) => i.id)).toEqual([id])
    expect(state().project.workholding!.definitions.map((x) => x.id)).toEqual([clampDef]) // the definition stays

    d = history()
    const [copy] = state().copyClampsToSetup([id], 'setup-b')
    expect(history()).toBe(d + 1)
    expect(new Set([id, copy]).size).toBe(2)
    expect(await resolvedBox(copy, 'setup-b')).toEqual(await resolvedBox(id, setupA))
    expect(await resolvedBox(copy, setupA)).toBeNull()

    d = history()
    state().moveClampsToSetup([id], 'setup-b')
    expect(history()).toBe(d + 1)
    expect(await resolvedBox(id, setupA)).toBeNull()
    expect(await resolvedBox(id, 'setup-b')).toEqual([25, 55, -5, 5, 20, 28]) // no jump
    state().moveClampsToSetup([id], 'setup-b')
    expect(history()).toBe(d + 1)

    state().undo()
    expect(instance(id).setupScope).toEqual({ kind: 'setups', setupIds: [setupA] })
  })

  it('follows its stock when the stock moves or grows; the follow is part of that edit (no undo step of its own)', async () => {
    const id = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.4, normalOffsetMm: 4 })!
    const d0 = history()
    state().updateFixedStock('stock-a', { position: { x: 10, y: 5, z: 0 } })
    expect(history() - d0).toBeLessThanOrEqual(1)
    // Same 128 mm along the loop: 28 up the right side, now at X 110, Y 5 + 28.
    expect(pose(instance(id).worldPose)).toEqual([114, 33, 20, 90])
    expect(await resolvedBox(id)).toEqual([109, 119, 18, 48, 20, 28])
    const p = instance(id).placement as { lastResolvedWorldPose: WorkholdingPose }
    expect(pose(p.lastResolvedWorldPose)).toEqual([114, 33, 20, 90])

    state().updateFixedStock('stock-a', { width: 200, depth: 30 })
    // 520 mm loop: 0.4 -> 208 = 8 up the right side, now at X 210, top Z 30.
    expect(pose(instance(id).worldPose)).toEqual([214, 13, 30, 90])

    state().undo()
    expect(pose(instance(id).worldPose)).toEqual([114, 33, 20, 90])
  })

  it('follows its part when the part moves; its edge gone -> last pose kept, lost only on that clamp', async () => {
    const onPart = state().placeClamp({ definitionId: clampDef, target: PART, fraction: 0.25 })!
    const onStock = state().placeClamp({ definitionId: clampDef, target: STOCK, fraction: 0.125 })!
    state().updateGeometryTransform('part-1', { x: 300, y: 50, z: 0 }, { ...ZERO })
    expect(pose(instance(onPart).worldPose)).toEqual([310, 40, 10, 0])
    const before = await resolvedBox(onPart)

    state().removeGeometry('part-1')
    expect(pose(instance(onPart).worldPose)).toEqual([310, 40, 10, 0])
    expect(await resolvedBox(onPart)).toEqual(before)
    expect(clampEdgeLost(state().project, instance(onPart))).toBe(true)
    expect(clampEdgeLost(state().project, instance(onStock))).toBe(false)
    // A lost clamp is not slid anywhere (nothing written); it still duplicates, beside itself.
    const d = history()
    state().moveClampOnEdge(onPart, { fraction: 0.5 })
    expect(history()).toBe(d)
    const [dup] = state().duplicateClamps([onPart])
    expect(pose(instance(dup).worldPose)).toEqual([350, 40, 10, 0])
  })

  it('a project with no clamps is not touched by stock and part edits', () => {
    state().removeWorkholdingInstance('none')
    const before = state().project.workholding
    state().updateFixedStock('stock-a', { width: 150 })
    state().updateGeometryTransform('part-1', { x: 10, y: 10, z: 0 }, { ...ZERO })
    expect(state().project.workholding).toBe(before)
  })
})
