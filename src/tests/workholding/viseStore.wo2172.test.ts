// WO-2172 (workholding assemblies, slice 2): make a vise from two bodies and
// set its opening, through the REAL store actions the screens call. The jaw's
// world bounds come from the one resolver (the pose CAM/simulation read in
// slice 3), and the viewport's draw poses are checked against it. The STL cache
// is the only stand-in (node has no IndexedDB); it serves real STL bytes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

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

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { resolveWorkholding, resolveWorkholdingPlacements } = await import('../../lib/workholding/resolveWorkholding')
const {
  viseDrawPoses, openingFromJawDrag, instancePoseFromComponentDrag, workholdingOfGeometry, viseOpening,
  defaultViseSlideAxis,
} = await import('../../lib/workholding/vise')
const { poseToMat4 } = await import('../../lib/workholding/pose')

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

function stlRow(id: string, size: Vec3, position: Vec3, rotation: Vec3): ImportedGeometry {
  return {
    id, name: id === 'geo-fixed' ? 'Fixed body' : 'Moving jaw', filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size: { ...size }, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position, rotation, loaded: true, workholding: true,
  } as ImportedGeometry
}

const ZERO = { x: 0, y: 0, z: 0 }
const SIZE = { x: 100, y: 20, z: 40 }

function state() { return useCamStore.getState() }
function historyDepth() { return state().projectHistory.length }
function viseId() { return state().project.workholding!.instances[0].id }
function opening() { return state().project.workholding!.instances[0].jointValuesMm.moving }

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

/** World bounds of each resolved body in the active setup, keyed by geometry id. */
async function resolvedBounds(): Promise<Record<string, Box>> {
  const project = state().project
  const { bodies } = await resolveWorkholding(project, project.activeSetupId)
  return Object.fromEntries(bodies.map((b) => [b.geometryId, boundsOf(b.mesh.positions)]))
}

function shifted(box: Box, d: Vec3): Box {
  return [box[0] + d.x, box[1] + d.x, box[2] + d.y, box[3] + d.y, box[4] + d.z, box[5] + d.z].map(r3) as Box
}

let savedBlobs: Blob[] = []

function seed(fixedPose: { position: Vec3; rotation: Vec3 }, jawPose: { position: Vec3; rotation: Vec3 }) {
  state().addGeometry(stlRow('geo-fixed', SIZE, fixedPose.position, fixedPose.rotation))
  state().addGeometry(stlRow('geo-jaw', SIZE, jawPose.position, jawPose.rotation))
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  cache.stl.clear()
  // Off-centre corners: the resolver's STL recentring must put both at their rows' display frames.
  cache.stl.set('geo-fixed', boxStl(SIZE, { x: 7, y: 3, z: 11 }))
  cache.stl.set('geo-jaw', boxStl(SIZE, { x: -2, y: 40, z: 0 }))
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2172' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  state().newProject()
})

describe('WO-2172: make a vise from two bodies and set its opening (store actions the screens call)', () => {
  it('opening 20 / 5 / 80 on travel 0-60: the jaw moves by exactly the change along its axis; 80 is set to 60', async () => {
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    const before = await resolvedBounds()
    // Before: two marked bodies where their rows sit.
    expect(before['geo-fixed']).toEqual([-50, 50, -10, 10, 0, 40])
    expect(before['geo-jaw']).toEqual([-50, 50, 40, 60, 0, 40])

    const d0 = historyDepth()
    const id = state().makeVise({
      name: 'Bench vise', fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: state().project.activeSetupId,
    })
    expect(id).toBe(viseId())
    expect(historyDepth()).toBe(d0 + 1) // definition + instance: ONE undo step
    expect(opening()).toBe(0) // starts at the minimum: where the jaw sits
    // Making it moved nothing, and wrote no geometry row.
    expect(await resolvedBounds()).toEqual(before)
    expect(state().project.geometry.map((g) => [g.id, g.position, g.rotation])).toEqual([
      ['geo-fixed', ZERO, ZERO], ['geo-jaw', { x: 0, y: 50, z: 0 }, ZERO],
    ])

    expect(state().setWorkholdingJointValue(id!, 'moving', 20)).toBe(20)
    let now = await resolvedBounds()
    expect(now['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 0, y: 20, z: 0 }))
    expect(now['geo-fixed']).toEqual(before['geo-fixed'])

    expect(state().setWorkholdingJointValue(id!, 'moving', 5)).toBe(5)
    now = await resolvedBounds()
    expect(now['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 0, y: 5, z: 0 }))

    expect(state().setWorkholdingJointValue(id!, 'moving', 80)).toBe(60) // the value used
    expect(opening()).toBe(60)
    now = await resolvedBounds()
    expect(now['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 0, y: 60, z: 0 }))
    expect(historyDepth()).toBe(d0 + 4)

    // Undo / redo, one step each.
    state().undo()
    expect(opening()).toBe(5)
    state().undo()
    expect(opening()).toBe(20)
    state().redo()
    expect(opening()).toBe(5)
    state().undo(); state().undo()
    expect(opening()).toBe(0)
    state().undo() // the making itself
    expect(state().project.workholding?.instances ?? []).toEqual([])
    expect(await resolvedBounds()).toEqual(before)
    state().redo()
    expect(opening()).toBe(0)
  })

  it('a turned vise: the axis is the jaw\'s own; the jaw moves along it in the world', async () => {
    // Both bodies turned 90 about Z at (200, 100, 5): the jaw's own Y is world -X.
    const rot = { x: 0, y: 0, z: 90 }
    seed({ position: { x: 200, y: 100, z: 5 }, rotation: rot }, { position: { x: 150, y: 100, z: 5 }, rotation: rot })
    const before = await resolvedBounds()
    expect(before['geo-jaw']).toEqual([140, 160, 50, 150, 5, 45])
    const id = state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, openingNowMm: 30, setupId: null,
    })!
    expect(opening()).toBe(30)
    expect(await resolvedBounds()).toEqual(before) // made at 30: nothing moved
    state().setWorkholdingJointValue(id, 'moving', 60)
    // Away from the fixed body (world -X), by 30 mm.
    expect((await resolvedBounds())['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: -30, y: 0, z: 0 }))
    state().setWorkholdingJointValue(id, 'moving', 0)
    expect((await resolvedBounds())['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 30, y: 0, z: 0 }))
  })

  it('a picked clamping face: the vise opens away from it (opposite its outward normal)', async () => {
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    const before = await resolvedBounds()
    // The jaw's clamping face (facing the fixed body) has outward normal -Y.
    const id = state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'clamping-face', normal: { x: 0, y: -1, z: 0 } }, minMm: 0, maxMm: 60, setupId: null,
    })!
    state().setWorkholdingJointValue(id, 'moving', 25)
    expect((await resolvedBounds())['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 0, y: 25, z: 0 }))
  })

  it('a signed jaw axis is the way the jaw opens; the first guess opens away from the fixed jaw end', async () => {
    // An L-shaped fixed body: a long base (210 x 60) with the fixed jaw at its +X end,
    // and the moving jaw ON the base near that end. Opening moves the jaw -X (along
    // the base, away from the fixed jaw) even though the base's middle is at -X of it.
    const base = { ...stlRow('geo-fixed', { x: 210, y: 60, z: 55 }, ZERO, ZERO) }
    const jaw = { ...stlRow('geo-jaw', { x: 30, y: 60, z: 40 }, { x: 45, y: 0, z: 15 }, ZERO) }
    state().addGeometry(base)
    state().addGeometry(jaw)
    expect(defaultViseSlideAxis(state().project, 'geo-fixed', 'geo-jaw')).toBe('-x')
    // Two separate blocks: the jaw opens away from the fixed block.
    state().newProject()
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    expect(defaultViseSlideAxis(state().project, 'geo-fixed', 'geo-jaw')).toBe('y')
    const before = await resolvedBounds()
    const id = state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: '-y' }, minMm: 0, maxMm: 60, setupId: null,
    })!
    state().setWorkholdingJointValue(id, 'moving', 10)
    expect((await resolvedBounds())['geo-jaw']).toEqual(shifted(before['geo-jaw'], { x: 0, y: -10, z: 0 }))
  })

  it('the viewport draw poses ARE the resolver\'s transforms, and a jaw drag reads back as an opening', async () => {
    const rot = { x: 10, y: -20, z: 35 }
    seed({ position: { x: 12, y: -8, z: 3 }, rotation: rot }, { position: { x: 12, y: 42, z: 3 }, rotation: rot })
    const id = state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'x' }, minMm: -10, maxMm: 90, openingNowMm: 12, setupId: state().project.activeSetupId,
    })!
    state().setWorkholdingJointValue(id, 'moving', 47)
    const project = state().project
    const { placements } = resolveWorkholdingPlacements(project, project.activeSetupId)
    const { poses, hidden } = viseDrawPoses(project, project.activeSetupId)
    expect(hidden.size).toBe(0)
    for (const p of placements.filter((q) => q.source === 'instance')) {
      const drawn = poseToMat4(poses.get(p.geometryId))
      drawn.forEach((v, i) => expect(v).toBeCloseTo(p.worldFromComponent[i], 9))
    }

    // Dragging the jaw 7 mm along its slide axis (plus sideways noise) asks for 47 + 7.
    const membership = workholdingOfGeometry(project.workholding, 'geo-jaw')!
    const jaw = placements.find((p) => p.geometryId === 'geo-jaw')!.worldFromComponent
    const inst = poseToMat4(membership.instance.worldPose)
    const a = membership.component.joint!.axis
    const len = Math.hypot(a.x, a.y, a.z)
    const w = { x: (inst[0] * a.x + inst[4] * a.y + inst[8] * a.z) / len, y: (inst[1] * a.x + inst[5] * a.y + inst[9] * a.z) / len, z: (inst[2] * a.x + inst[6] * a.y + inst[10] * a.z) / len }
    // A sideways direction perpendicular to w.
    const side = { x: w.y, y: -w.x, z: 0 }
    const sl = Math.hypot(side.x, side.y) || 1
    const dropped = {
      x: jaw[12] + 7 * w.x + 3 * side.x / sl, y: jaw[13] + 7 * w.y + 3 * side.y / sl, z: jaw[14] + 7 * w.z,
    }
    expect(openingFromJawDrag(project, membership, dropped)).toBeCloseTo(54, 9)

    // Dragging the fixed body moves the whole vise: the instance pose that puts it there.
    const fixed = workholdingOfGeometry(project.workholding, 'geo-fixed')!
    const moved = { position: { x: 30, y: 5, z: 3 }, rotation: rot }
    const pose = instancePoseFromComponentDrag(fixed.component, moved)
    expect(pose.position).toEqual(moved.position)
    expect(pose.rotation.x).toBeCloseTo(rot.x, 9)
    expect(pose.rotation.y).toBeCloseTo(rot.y, 9)
    expect(pose.rotation.z).toBeCloseTo(rot.z, 9)
  })

  it('a vise placed in one setup is drawn only there; in another setup its bodies are not drawn', () => {
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    state().addSetup({ id: 'setup-a', name: 'Op 1', operations: [] } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    state().setActiveSetup('setup-a')
    const setupA = state().project.activeSetupId
    expect(setupA).toBe('setup-a')
    state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: setupA,
    })
    expect(viseDrawPoses(state().project, setupA).poses.size).toBe(2)
    expect(state().project.workholding!.instances[0].setupScope).toEqual({ kind: 'setups', setupIds: ['setup-a'] })
    const other = viseDrawPoses(state().project, 'some-other-setup')
    expect(other.poses.size).toBe(0)
    expect([...other.hidden].sort()).toEqual(['geo-fixed', 'geo-jaw'])
  })

  it('File Save -> File Open: the opening reopens the same, and so does the jaw', async () => {
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    const id = state().makeVise({
      name: 'Bench vise', fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: state().project.activeSetupId,
    })!
    state().setWorkholdingJointValue(id, 'moving', 37.5)
    const model = structuredClone(state().project.workholding)
    const bounds = await resolvedBounds()
    expect(bounds['geo-jaw']).toEqual([-50, 50, 77.5, 97.5, 0, 40])

    await state().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const text = await savedBlobs[0].text()
    state().newProject()
    await state().loadProjectFromFile(text)
    expect(state().project.workholding).toEqual(model)
    expect(opening()).toBe(37.5)
    const membership = workholdingOfGeometry(state().project.workholding, 'geo-jaw')!
    expect(viseOpening(membership.instance, membership.moving!)).toEqual({ valueMm: 37.5, minMm: 0, maxMm: 60 })
    expect(await resolvedBounds()).toEqual(bounds)
  })

  it('rename and remove are one undo step each; removing leaves both bodies where they sit, still workholding', async () => {
    seed({ position: ZERO, rotation: ZERO }, { position: { x: 0, y: 50, z: 0 }, rotation: ZERO })
    const before = await resolvedBounds()
    const id = state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: null,
    })!
    expect(state().project.workholding!.definitions[0].name).toBe('Vise')
    // A body already in a vise is not made into a second one.
    expect(state().makeVise({
      fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: null,
    })).toBeNull()
    state().setWorkholdingJointValue(id, 'moving', 40)

    const d0 = historyDepth()
    state().renameWorkholding(id, '  6 inch Kurt  ')
    expect(state().project.workholding!.definitions[0].name).toBe('6 inch Kurt')
    expect(historyDepth()).toBe(d0 + 1)
    state().renameWorkholding(id, '6 inch Kurt') // unchanged: nothing
    state().renameWorkholding(id, '   ') // blank: nothing
    expect(historyDepth()).toBe(d0 + 1)

    state().removeWorkholding(id)
    expect(historyDepth()).toBe(d0 + 2)
    expect(state().project.workholding).toEqual({ definitions: [], instances: [] })
    expect(state().project.geometry.every((g) => g.workholding === true)).toBe(true)
    // Back to two marked bodies where their rows sit (the jaw is not left at 40).
    expect(await resolvedBounds()).toEqual(before)

    state().undo()
    expect(opening()).toBe(40)
    expect(state().project.workholding!.definitions[0].name).toBe('6 inch Kurt')
  })
})
