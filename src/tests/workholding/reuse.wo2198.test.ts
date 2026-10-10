// WO-2198 (workholding assemblies, slice 6): a vise made once is used again,
// through the REAL store actions the screens call.
//
//   - Place another: a second instance of the same definition with its own
//     pose and opening; the definition (shapes + joint) is stored once.
//   - Export -> Import: the definition copied into another project as that
//     project's own, resolving to the same bodies; later edits to the source
//     (its opening, its name, its shape bytes) never reach the copy.
//   - Save / reopen, one undo step each, CAM keep-out and simulation contact
//     seeing every instance (the slice 3 path).
//
// SCENE: two 100 x 20 x 40 boxes, the fixed body at the origin and the jaw at
// Y 50, made into a vise opening along +Y, travel 0-100, made at opening 0.
// At opening 20 the jaw spans Y 60..80; at 50, Y 90..110. "Place another"
// puts the copy one vise width (100) + 20 mm along +X: X 70..170.
// The STL cache is the only stand-in (node has no IndexedDB); it serves real
// STL bytes the production parser reads.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

const cache = vi.hoisted(() => ({
  stl: new Map<string, ArrayBuffer>(),
  stepDisplay: new Map<string, { positions: Float32Array; indices: Uint32Array }>(),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, bytes: ArrayBuffer) => { cache.stl.set(id, bytes) }),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async (id: string) => {
    const mesh = cache.stepDisplay.get(id)
    return mesh ? ({ payload: { mesh } } as unknown as Awaited<ReturnType<typeof import('../../lib/stepCache')['loadCachedStepDisplay']>>) : null
  }),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { resolveWorkholding } = await import('../../lib/workholding/resolveWorkholding')
const { viseDrawPoses, workholdingOfGeometry } = await import('../../lib/workholding/vise')
const { resolveWorkholdingObstacles } = await import('../../store/fixtureObstacles')
const { workholdingContactBodies } = await import('../../lib/workholding/contactBodies')
const { clampDrawPoses, clampDrawId } = await import('../../components/workholding/clampViewport')
const { parseWorkholdingFile } = await import('../../lib/workholding/reuse')

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

/** The same box as an indexed mesh (a STEP display tessellation), corner at `corner`. */
function boxMeshAt(size: Vec3, corner: Vec3) {
  const positions: number[] = []
  for (let i = 0; i < 8; i++) {
    positions.push(corner.x + (i & 1 ? size.x : 0), corner.y + (i & 2 ? size.y : 0), corner.z + (i & 4 ? size.z : 0))
  }
  const indices = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

const ZERO = { x: 0, y: 0, z: 0 }
const SIZE = { x: 100, y: 20, z: 40 }

function stlRow(id: string, position: Vec3): ImportedGeometry {
  return {
    id, name: id === 'geo-fixed' ? 'Fixed body' : 'Moving jaw', filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -SIZE.x / 2, y: -SIZE.y / 2, z: 0 }, max: { x: SIZE.x / 2, y: SIZE.y / 2, z: SIZE.z },
      size: { ...SIZE }, center: { x: 0, y: 0, z: SIZE.z / 2 },
    },
    position, rotation: { ...ZERO }, loaded: true, workholding: true,
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function historyDepth() { return state().projectHistory.length }

type Box = [number, number, number, number, number, number]
const r3 = (n: number) => Math.round(n * 1000) / 1000
function boundsOf(positions: ArrayLike<number>): Box {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i])
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1])
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2])
  }
  return [minX, maxX, minY, maxY, minZ, maxZ].map(r3) as Box
}

/** Resolved world bounds in `setupId`, keyed "<instance>/<component>", sorted by key. */
async function resolved(setupId = state().project.activeSetupId): Promise<Record<string, Box>> {
  const project = state().project
  const { bodies } = await resolveWorkholding(project, setupId)
  return Object.fromEntries(bodies.map((b) => [`${b.instanceId}/${b.componentId}`, boundsOf(b.mesh.positions)]).sort())
}

/** The same bodies with instance ids replaced by their order in the model (for comparing two projects). */
async function resolvedByOrder(setupId = state().project.activeSetupId): Promise<Box[]> {
  const project = state().project
  const order = new Map(project.workholding!.instances.map((i, n) => [i.id, n]))
  const { bodies } = await resolveWorkholding(project, setupId)
  return bodies
    .map((b) => ({ key: `${order.get(b.instanceId)}/${b.componentId}`, box: boundsOf(b.mesh.positions) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => b.box)
}

function makeVise(seed = true): string {
  if (seed) {
    state().addGeometry(stlRow('geo-fixed', ZERO))
    state().addGeometry(stlRow('geo-jaw', { x: 0, y: 50, z: 0 }))
  }
  return state().makeVise({
    name: 'Bench vise', fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
    slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 100, setupId: state().project.activeSetupId,
  })!
}

let savedBlobs: Blob[] = []

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  cache.stl.clear()
  cache.stepDisplay.clear()
  // Off-centre corners: the STL recentring must put both at their rows' display frames.
  cache.stl.set('geo-fixed', boxStl(SIZE, { x: 7, y: 3, z: 11 }))
  cache.stl.set('geo-jaw', boxStl(SIZE, { x: -2, y: 40, z: 0 }))
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2198' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  state().newProject()
})

const FIXED_1: Box = [-50, 50, -10, 10, 0, 40]
const JAW_1_AT_20: Box = [-50, 50, 60, 80, 0, 40]
const FIXED_2: Box = [70, 170, -10, 10, 0, 40]
const JAW_2_AT_50: Box = [70, 170, 90, 110, 0, 40]

describe('WO-2198: place another vise from one definition', () => {
  it('two instances at openings 20 and 50 resolve to their own jaws and share one definition; one undo step each', async () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)

    const d0 = historyDepth()
    const second = state().placeAnotherWorkholding(first)!
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(historyDepth()).toBe(d0 + 1)
    const model = state().project.workholding!
    // Shared, not copied: one definition, both instances on its id and revision.
    expect(model.definitions).toHaveLength(1)
    expect(model.instances.map((i) => [i.definitionId, i.definitionRevision])).toEqual([
      [model.definitions[0].id, model.definitions[0].revision],
      [model.definitions[0].id, model.definitions[0].revision],
    ])
    // Same opening to start with, beside the first.
    expect(model.instances[1].jointValuesMm).toEqual({ moving: 20 })

    expect(state().setWorkholdingJointValue(second, 'moving', 50)).toBe(50)
    expect(historyDepth()).toBe(d0 + 2)
    const bodies = await resolved()
    expect(bodies).toEqual({
      [`${first}/fixed`]: FIXED_1,
      [`${first}/moving`]: JAW_1_AT_20,
      [`${second}/fixed`]: FIXED_2,
      [`${second}/moving`]: JAW_2_AT_50,
    })

    // Moving the second vise moves only the second.
    state().updateWorkholdingInstance(second, { worldPose: { position: { x: 300, y: 0, z: 0 }, rotation: { ...ZERO } } })
    const moved = await resolved()
    expect(moved[`${first}/fixed`]).toEqual(FIXED_1)
    expect(moved[`${first}/moving`]).toEqual(JAW_1_AT_20)
    expect(moved[`${second}/fixed`]).toEqual([250, 350, -10, 10, 0, 40])

    // Undo: the move, the opening, then the placing - one step each; the first vise never changes.
    state().undo()
    expect(await resolved()).toEqual(bodies)
    state().undo()
    expect(state().project.workholding!.instances[1].jointValuesMm).toEqual({ moving: 20 })
    state().undo()
    expect(state().project.workholding!.instances.map((i) => i.id)).toEqual([first])
    expect(state().project.workholding!.instances[0].jointValuesMm).toEqual({ moving: 20 })
  })

  it('CAM keep-out and simulation contact see both instances (the slice 3 path)', async () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)
    const second = state().placeAnotherWorkholding(first)!
    state().setWorkholdingJointValue(second, 'moving', 50)
    const project = state().project
    const setupId = project.activeSetupId

    const cam = await resolveWorkholdingObstacles(
      project.geometry, project.modelItemPlacements, [], undefined, { workholding: project.workholding, setupId },
    )
    expect(cam.meshes.map((m) => boundsOf(m.positions)).sort()).toEqual([FIXED_1, JAW_1_AT_20, FIXED_2, JAW_2_AT_50].sort())
    expect(cam.notices).toEqual([])

    const contact = workholdingContactBodies(project, setupId)
    expect(contact.map((m) => boundsOf(m.positions)).sort()).toEqual([FIXED_1, JAW_1_AT_20, FIXED_2, JAW_2_AT_50].sort())
  })

  it('the viewport draws the first vise with its rows and the second as its own copy; a row names the first', () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)
    const second = state().placeAnotherWorkholding(first)!
    state().setWorkholdingJointValue(second, 'moving', 50)
    const project = state().project

    // The rows stay at the FIRST vise (a row dragged edits the instance it names).
    const rows = viseDrawPoses(project, project.activeSetupId)
    expect(rows.poses.get('geo-jaw')!.position).toEqual({ x: 0, y: 70, z: 0 })
    expect(rows.poses.get('geo-fixed')!.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(workholdingOfGeometry(project.workholding, 'geo-jaw')!.instance.id).toBe(first)

    // The second is drawn by a copy of each body, at its own pose and opening.
    const copies = clampDrawPoses()
    expect([...copies.keys()].sort()).toEqual([clampDrawId(second, 'fixed'), clampDrawId(second, 'moving')].sort())
    expect(copies.get(clampDrawId(second, 'fixed'))!.position).toEqual({ x: 120, y: 0, z: 0 })
    expect(copies.get(clampDrawId(second, 'moving'))!.position).toEqual({ x: 120, y: 100, z: 0 })
  })

  it('placed in another setup: each setup resolves and draws only its own vise', async () => {
    state().addGeometry(stlRow('geo-fixed', ZERO))
    state().addGeometry(stlRow('geo-jaw', { x: 0, y: 50, z: 0 }))
    type NewSetup = Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0]
    state().addSetup({ id: 'setup-a', name: 'Setup A', operations: [] } as unknown as NewSetup)
    state().addSetup({ id: 'setup-b', name: 'Setup B', operations: [] } as unknown as NewSetup)
    const setupA = 'setup-a'
    state().setActiveSetup(setupA)
    const first = makeVise(false)
    state().setWorkholdingJointValue(first, 'moving', 20)
    const second = state().placeAnotherWorkholding(first, 'setup-b')!
    state().setWorkholdingJointValue(second, 'moving', 50)

    expect(await resolved(setupA)).toEqual({ [`${first}/fixed`]: FIXED_1, [`${first}/moving`]: JAW_1_AT_20 })
    expect(await resolved('setup-b')).toEqual({ [`${second}/fixed`]: FIXED_2, [`${second}/moving`]: JAW_2_AT_50 })

    state().setActiveSetup('setup-b')
    const rows = viseDrawPoses(state().project, 'setup-b')
    expect(rows.poses.size).toBe(0) // the first vise is not in setup B: its rows are not drawn here
    expect([...clampDrawPoses().keys()].sort()).toEqual([clampDrawId(second, 'fixed'), clampDrawId(second, 'moving')].sort())
  })

  it('a clamp is not placed again by this action (clamps are placed on edges)', () => {
    state().addGeometry({ ...stlRow('geo-clamp', ZERO), name: 'Strap clamp' })
    cache.stl.set('geo-clamp', boxStl(SIZE, ZERO))
    const def = state().makeClamp('geo-clamp')!
    state().addWorkholdingInstance({
      id: 'clamp-1', definitionId: def, definitionRevision: 1, setupScope: { kind: 'all' },
      worldPose: { position: { ...ZERO }, rotation: { ...ZERO } }, jointValuesMm: {},
    })
    const d0 = historyDepth()
    expect(state().placeAnotherWorkholding('clamp-1')).toBeNull()
    expect(historyDepth()).toBe(d0)
  })
})

describe('WO-2198: export a vise and import it into another project', () => {
  it('export -> import into a fresh project gives the same resolved bodies, as that project\'s own copy; one undo step', async () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)
    const sourceBodies = await resolvedByOrder()
    const sourceDefinition = structuredClone(state().project.workholding!.definitions[0])

    const d0 = historyDepth()
    const exported = (await state().exportWorkholdingFile(first))!
    expect(historyDepth()).toBe(d0) // exporting writes nothing to the project
    expect(exported.fileName).toBe('Bench vise.workholding.json')
    expect(exported.notices).toEqual([])
    const file = parseWorkholdingFile(exported.text)!
    expect(file.definition.components.map((c) => c.geometryId)).toEqual(['shape-1', 'shape-2'])

    state().newProject()
    const d1 = historyDepth()
    const imported = (await state().importWorkholdingFile(exported.text))!
    expect(historyDepth()).toBe(d1 + 1)
    const model = state().project.workholding!
    expect(model.definitions).toHaveLength(1)
    expect(model.instances).toHaveLength(1)
    const definition = model.definitions[0]
    // The project's own: new ids, new shape rows, their own cached bytes.
    expect(definition.id).toBe(imported.definitionId)
    expect(definition.id).not.toBe(sourceDefinition.id)
    expect(definition.components.map((c) => c.geometryId)).toEqual(imported.rowIds)
    for (const id of imported.rowIds) {
      expect(['geo-fixed', 'geo-jaw']).not.toContain(id)
      expect(cache.stl.has(id)).toBe(true)
      expect(state().project.geometry.find((g) => g.id === id)?.workholding).toBe(true)
    }
    expect(definition.name).toBe('Bench vise')
    expect(definition.kind).toBe('vise')
    expect(definition.components.find((c) => c.joint)!.joint).toEqual(sourceDefinition.components.find((c) => c.joint)!.joint)
    expect(model.instances[0].jointValuesMm).toEqual({ moving: 20 })
    // In the active setup (a fresh project has none yet: every setup).
    const active = state().project.activeSetupId
    expect(model.instances[0].setupScope).toEqual(active ? { kind: 'setups', setupIds: [active] } : { kind: 'all' })

    expect(await resolvedByOrder()).toEqual(sourceBodies)

    // One undo step takes the whole import away - rows, definition and vise.
    state().undo()
    expect(state().project.workholding?.definitions ?? []).toEqual([])
    expect(state().project.geometry.filter((g) => imported.rowIds.includes(g.id))).toEqual([])
  })

  it('editing the source afterwards leaves the importer unchanged', async () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)
    const exported = (await state().exportWorkholdingFile(first))!
    const imported = (await state().importWorkholdingFile(exported.text))!
    const copy = imported.instanceId!
    const copyBodies = Object.fromEntries(Object.entries(await resolved()).filter(([k]) => k.startsWith(`${copy}/`)))
    expect(copyBodies[`${copy}/moving`]).toEqual(JAW_1_AT_20)

    // Change the source every way it can change: opening, pose, name, shape bytes.
    state().setWorkholdingJointValue(first, 'moving', 80)
    state().updateWorkholdingInstance(first, { worldPose: { position: { x: -500, y: 0, z: 0 }, rotation: { ...ZERO } } })
    state().renameWorkholding(first, 'Renamed source')
    cache.stl.set('geo-jaw', boxStl({ x: 10, y: 10, z: 10 }, ZERO))
    cache.stl.set('geo-fixed', boxStl({ x: 10, y: 10, z: 10 }, ZERO))

    const after = await resolved()
    expect(Object.fromEntries(Object.entries(after).filter(([k]) => k.startsWith(`${copy}/`)))).toEqual(copyBodies)
    const model = state().project.workholding!
    expect(model.definitions.find((d) => d.id === imported.definitionId)!.name).toBe('Bench vise')
    // The source did change (the control).
    expect(after[`${first}/moving`]).not.toEqual(JAW_1_AT_20)
  })

  it('a STEP body is written as an STL with its frame folded in: the import resolves where the export did', async () => {
    state().addGeometry({ ...stlRow('geo-fixed', { x: 5, y: -7, z: 0 }), format: 'step', filename: 'fixed.step' })
    state().addGeometry(stlRow('geo-jaw', { x: 0, y: 50, z: 0 }))
    // A STEP display is NOT recentred: its corner is off the origin in its own frame.
    cache.stepDisplay.set('geo-fixed', boxMeshAt(SIZE, { x: 13, y: -4, z: 9 }))
    const first = state().makeVise({
      name: 'Step vise', fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 100, setupId: state().project.activeSetupId,
    })!
    state().setWorkholdingJointValue(first, 'moving', 20)
    const sourceBodies = await resolvedByOrder()
    expect(sourceBodies[0]).toEqual([18, 118, -11, 9, 9, 49]) // the STEP body where it is drawn

    const exported = (await state().exportWorkholdingFile(first))!
    state().newProject()
    await state().importWorkholdingFile(exported.text)
    expect(await resolvedByOrder()).toEqual(sourceBodies)
  })

  it('a file that cannot be read imports nothing', async () => {
    makeVise()
    const before = structuredClone(state().project.workholding)
    const d0 = historyDepth()
    for (const text of ['not json', '{}', JSON.stringify({ format: 'liencam-workholding', version: 1 })]) {
      expect(await state().importWorkholdingFile(text)).toBeNull()
    }
    expect(historyDepth()).toBe(d0)
    expect(state().project.workholding).toEqual(before)
  })

  it('a clamp exports and imports as a definition to place on edges', async () => {
    state().addGeometry({ ...stlRow('geo-clamp', { x: 0, y: 0, z: 0 }), name: 'Strap clamp' })
    cache.stl.set('geo-clamp', boxStl(SIZE, { x: 1, y: 2, z: 3 }))
    const def = state().makeClamp('geo-clamp', 'Strap clamp')!
    state().addWorkholdingInstance({
      id: 'clamp-1', definitionId: def, definitionRevision: 1, setupScope: { kind: 'all' },
      worldPose: { position: { x: 10, y: 20, z: 0 }, rotation: { ...ZERO } }, jointValuesMm: {},
    })
    const exported = (await state().exportWorkholdingFile('clamp-1'))!
    expect(parseWorkholdingFile(exported.text)!.placedAt).toBeUndefined()
    state().newProject()
    const imported = (await state().importWorkholdingFile(exported.text))!
    expect(imported.instanceId).toBeNull()
    const definition = state().project.workholding!.definitions[0]
    expect(definition.kind).toBe('clamp')
    expect(definition.name).toBe('Strap clamp')
    expect(state().project.workholding!.instances).toEqual([])
  })
})

describe('WO-2198: save and reopen keep every instance', () => {
  it('File Save -> File Open (cold cache): two placed vises and an imported one reopen exactly', async () => {
    const first = makeVise()
    state().setWorkholdingJointValue(first, 'moving', 20)
    const second = state().placeAnotherWorkholding(first)!
    state().setWorkholdingJointValue(second, 'moving', 50)
    const exported = (await state().exportWorkholdingFile(first))!
    const imported = (await state().importWorkholdingFile(exported.text))!
    state().updateWorkholdingInstance(imported.instanceId!, {
      worldPose: { position: { x: 0, y: 300, z: 0 }, rotation: { x: 0, y: 0, z: 90 } },
    })
    const model = structuredClone(state().project.workholding)
    const bodies = await resolved()
    expect(Object.keys(bodies)).toHaveLength(6)

    await state().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const text = await savedBlobs[0].text()
    state().newProject()
    cache.stl.clear() // another browser: the file carries every shape
    await state().loadProjectFromFile(text)
    expect(state().project.workholding).toEqual(model)
    expect(await resolved()).toEqual(bodies)
  })
})
