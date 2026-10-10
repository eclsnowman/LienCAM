// WO-2167 (workholding assemblies, slice 1): the saved workholding model rides
// the store's own seams. Drives the REAL store actions, undo, File Save ->
// File Open, and the browser-reload persist legs, then resolves the reopened
// project through the one resolver and compares the world bodies. The STL cache
// is the only stand-in (node has no IndexedDB); it serves real STL bytes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3, WorkholdingDefinition, WorkholdingInstance } from '../../types'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, bytes: ArrayBuffer) => { cache.stl.set(id, bytes) }),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore, persistPartialize, persistMerge } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { resolveWorkholding } = await import('../../lib/workholding/resolveWorkholding')

/** A binary STL of an axis-aligned box with its corner at `corner`. */
function boxStl(size: Vec3, corner: Vec3): ArrayBuffer {
  const c = (i: number): Vec3 => ({
    x: corner.x + (i & 1 ? size.x : 0), y: corner.y + (i & 2 ? size.y : 0), z: corner.z + (i & 4 ? size.z : 0),
  })
  const tris = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  const count = tris.length / 3
  const buffer = new ArrayBuffer(84 + 50 * count)
  const view = new DataView(buffer)
  view.setUint32(80, count, true)
  for (let t = 0; t < count; t++) {
    const base = 84 + 50 * t
    for (let v = 0; v < 3; v++) {
      const p = c(tris[t * 3 + v])
      view.setFloat32(base + 12 + v * 12, p.x, true)
      view.setFloat32(base + 16 + v * 12, p.y, true)
      view.setFloat32(base + 20 + v * 12, p.z, true)
    }
  }
  return buffer
}

function stlRow(id: string, size: Vec3): ImportedGeometry {
  return {
    id, name: `${id}.stl`, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size: { ...size }, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as ImportedGeometry
}

const ZERO = { x: 0, y: 0, z: 0 }

// Fixed body 100 x 20 x 40, jaw 100 x 20 x 40 (both recentred by the STL reader
// to x -50..50, y -10..10, z 0..40). Jaw sits 20 mm +Y of the fixed body and
// slides +Y over 0..100 mm. Instance at (200, 100, 5) turned 90 about Z.
const VISE: WorkholdingDefinition = {
  id: 'def-vise', revision: 1, name: '6 inch vise', kind: 'vise',
  components: [
    { id: 'fixed', name: 'Fixed body', geometryId: 'geo-fixed', localPose: { position: ZERO, rotation: ZERO } },
    {
      id: 'moving', name: 'Moving jaw', geometryId: 'geo-jaw',
      localPose: { position: { x: 0, y: 20, z: 0 }, rotation: ZERO },
      joint: { kind: 'linear', axis: { x: 0, y: 1, z: 0 }, minMm: 0, maxMm: 100, closedAtMm: 0 },
    },
  ],
}

const INSTANCE: WorkholdingInstance = {
  id: 'vise-1', definitionId: 'def-vise', definitionRevision: 1,
  setupScope: { kind: 'all' },
  worldPose: { position: { x: 200, y: 100, z: 5 }, rotation: { x: 0, y: 0, z: 90 } },
  jointValuesMm: {},
  placement: { kind: 'free' },
}

function state() { return useCamStore.getState() }
function historyDepth() { return state().projectHistory.length }
function viseInstance() { return state().project.workholding?.instances.find((i) => i.id === 'vise-1') }

/** World x-range of the jaw: frame y in [10 + v, 30 + v] -> Rz90 -> x = 200 - y. */
function jawXRange(v: number) { return [170 - v, 190 - v] }

async function resolvedBoxes() {
  const project = state().project
  const result = await resolveWorkholding(project, project.activeSetupId)
  return result.bodies.map((b) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i + 2 < b.mesh.positions.length; i += 3) {
      minX = Math.min(minX, b.mesh.positions[i]); maxX = Math.max(maxX, b.mesh.positions[i])
      minY = Math.min(minY, b.mesh.positions[i + 1]); maxY = Math.max(maxY, b.mesh.positions[i + 1])
      minZ = Math.min(minZ, b.mesh.positions[i + 2]); maxZ = Math.max(maxZ, b.mesh.positions[i + 2])
    }
    const r = (n: number) => Math.round(n * 1000) / 1000
    return { id: `${b.instanceId}/${b.componentId}`, shape: b.shape, box: [minX, maxX, minY, maxY, minZ, maxZ].map(r) }
  })
}

let savedBlobs: Blob[] = []

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  cache.stl.clear()
  cache.stl.set('geo-fixed', boxStl({ x: 100, y: 20, z: 40 }, { x: 7, y: 3, z: 11 }))
  cache.stl.set('geo-jaw', boxStl({ x: 100, y: 20, z: 40 }, { x: -2, y: 40, z: 0 }))
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2167' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  state().newProject()
  state().addGeometry(stlRow('geo-fixed', { x: 100, y: 20, z: 40 }))
  state().addGeometry(stlRow('geo-jaw', { x: 100, y: 20, z: 40 }))
})

describe('WO-2167: the workholding model saves, reopens and undoes through the store', () => {
  it('every edit is one undo step; an edit that changes nothing writes none; undo restores', async () => {
    const d0 = historyDepth()
    state().addWorkholdingDefinition(VISE)
    expect(historyDepth()).toBe(d0 + 1)
    state().addWorkholdingDefinition(VISE) // same id: nothing
    expect(historyDepth()).toBe(d0 + 1)

    state().addWorkholdingInstance(INSTANCE)
    expect(historyDepth()).toBe(d0 + 2)
    // The opening is stored at once, at the joint's closed value.
    expect(viseInstance()?.jointValuesMm).toEqual({ moving: 0 })
    state().addWorkholdingInstance({ ...INSTANCE, id: 'orphan', definitionId: 'no-such-definition' })
    expect(historyDepth()).toBe(d0 + 2)

    expect(state().setWorkholdingJointValue('vise-1', 'moving', 50)).toBe(50)
    expect(historyDepth()).toBe(d0 + 3)
    expect(state().setWorkholdingJointValue('vise-1', 'moving', 50)).toBe(50) // same value: nothing
    expect(historyDepth()).toBe(d0 + 3)
    // Past the travel: kept within it, and the value actually used is returned.
    expect(state().setWorkholdingJointValue('vise-1', 'moving', 400)).toBe(100)
    expect(historyDepth()).toBe(d0 + 4)
    expect(state().setWorkholdingJointValue('vise-1', 'fixed', 10)).toBeNull() // no joint

    state().updateWorkholdingInstance('vise-1', { worldPose: INSTANCE.worldPose }) // unchanged
    expect(historyDepth()).toBe(d0 + 4)
    state().updateWorkholdingInstance('vise-1', { worldPose: { position: { x: 210, y: 100, z: 5 }, rotation: { x: 0, y: 0, z: 90 } } })
    expect(historyDepth()).toBe(d0 + 5)

    let bodies = await resolvedBoxes()
    expect(bodies.find((b) => b.id === 'vise-1/moving')?.box.slice(0, 2)).toEqual(jawXRange(100).map((x) => x + 10))

    state().undo() // the move
    expect(viseInstance()?.worldPose.position.x).toBe(200)
    state().undo() // opening 100 -> 50
    expect(viseInstance()?.jointValuesMm).toEqual({ moving: 50 })
    bodies = await resolvedBoxes()
    expect(bodies.find((b) => b.id === 'vise-1/moving')?.box.slice(0, 2)).toEqual(jawXRange(50))
    state().undo() // opening 50 -> 0
    expect(viseInstance()?.jointValuesMm).toEqual({ moving: 0 })
    state().redo()
    expect(viseInstance()?.jointValuesMm).toEqual({ moving: 50 })

    state().removeWorkholdingInstance('vise-1')
    expect(state().project.workholding?.instances).toEqual([])
    expect(state().project.workholding?.definitions.map((d) => d.id)).toEqual(['def-vise'])
    state().undo()
    expect(viseInstance()?.jointValuesMm).toEqual({ moving: 50 })
  })

  it('File Save -> File Open: the model comes back identical and resolves to the same world bodies', async () => {
    state().addWorkholdingDefinition(VISE)
    state().addWorkholdingInstance(INSTANCE)
    state().setWorkholdingJointValue('vise-1', 'moving', 63.5)
    const modelBefore = structuredClone(state().project.workholding)
    const bodiesBefore = await resolvedBoxes()
    // Hand check before trusting the round trip: fixed x = 200 - y, y in [-10, 10] -> [190, 210];
    // jaw frame y in [10 + 63.5, 30 + 63.5] -> x in [106.5, 126.5]; y = 100 + x in [50, 150]; z in [5, 45].
    expect(bodiesBefore).toEqual([
      { id: 'vise-1/fixed', shape: 'exact', box: [190, 210, 50, 150, 5, 45] },
      { id: 'vise-1/moving', shape: 'exact', box: [106.5, 126.5, 50, 150, 5, 45] },
    ])

    await state().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const fileText = await savedBlobs[0].text()
    expect(JSON.parse(fileText).workholding).toEqual(modelBefore)

    state().newProject()
    expect(state().project.workholding).toBeUndefined()
    await state().loadProjectFromFile(fileText)
    expect(state().project.workholding).toEqual(modelBefore)
    expect(await resolvedBoxes()).toEqual(bodiesBefore)
  })

  it('browser reload (localStorage persist legs): the model comes back identical', async () => {
    state().addWorkholdingDefinition(VISE)
    state().addWorkholdingInstance(INSTANCE)
    state().setWorkholdingJointValue('vise-1', 'moving', 25)
    const modelBefore = structuredClone(state().project.workholding)
    const bodiesBefore = await resolvedBoxes()

    const persisted = JSON.parse(JSON.stringify(persistPartialize(state())))
    expect(persisted.project.workholding).toEqual(modelBefore)
    state().newProject()
    useCamStore.setState(persistMerge(persisted, state()))
    expect(state().project.workholding).toEqual(modelBefore)
    expect(await resolvedBoxes()).toEqual(bodiesBefore)
  })

  it('adding workholding never outdates a generated operation (nothing that generates reads the model yet)', () => {
    const before = state().project.setups
    state().addWorkholdingDefinition(VISE)
    state().addWorkholdingInstance(INSTANCE)
    state().setWorkholdingJointValue('vise-1', 'moving', 10)
    expect(state().project.setups).toBe(before)
    expect(state().project.geometry.map((g) => g.id)).toEqual(['geo-fixed', 'geo-jaw'])
  })
})
