// WO-2167 (workholding assemblies, slice 1): the ONE resolver places every
// workholding component in the world.
//
// Every expected number below is worked out by hand in the comment beside it,
// from the poses in the fixture - never from the resolver's own math. The
// shapes are plain boxes served by an injected reader (the resolver's own
// seam), except the STL-recentring case, which parses real STL bytes through
// the production cached reader (the STL cache is the only stand-in).

import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStepDisplay: vi.fn(async () => null),
}))

import {
  resolveJointValue, resolveWorkholding, resolveWorkholdingPlacements,
} from '../../lib/workholding/resolveWorkholding'
import { transformPoint } from '../../lib/workholding/pose'
import type { LocalMesh, WorkholdingShapeReader } from '../../lib/workholding/shapes'
import { resolveWorkholdingObstacles } from '../../store/fixtureObstacles'
import type {
  ImportedGeometry, ModelItemPlacementRecord, Project, Vec3, WorkholdingDefinition, WorkholdingInstance,
} from '../../types'

// ── Fixture helpers ──────────────────────────────────────────────────────────

type Box = { min: Vec3; max: Vec3 }

function boxLocal(min: Vec3, max: Vec3): LocalMesh {
  const positions: number[] = []
  for (const z of [min.z, max.z]) for (const y of [min.y, max.y]) for (const x of [min.x, max.x]) positions.push(x, y, z)
  const indices = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return { positions, indices }
}

function bounds(positions: ArrayLike<number>): Box {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i + 2 < positions.length; i += 3) {
    min.x = Math.min(min.x, positions[i]); max.x = Math.max(max.x, positions[i])
    min.y = Math.min(min.y, positions[i + 1]); max.y = Math.max(max.y, positions[i + 1])
    min.z = Math.min(min.z, positions[i + 2]); max.z = Math.max(max.z, positions[i + 2])
  }
  return { min, max }
}

function expectBox(actual: Box, expected: Box): void {
  for (const end of ['min', 'max'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual[end][axis], `${end}.${axis}`).toBeCloseTo(expected[end][axis], 4)
    }
  }
}

function expectPoint(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.z).toBeCloseTo(expected.z, 6)
}

function row(id: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 }, size: { x: 2, y: 2, z: 2 }, center: { x: 0, y: 0, z: 1 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

/** Serves the given local shapes by geometry id (null = the shape cannot be read). */
function readerOf(shapes: Record<string, LocalMesh | null>): WorkholdingShapeReader {
  return {
    stl: async (id) => shapes[id] ?? null,
    step: async (id) => shapes[id] ?? null,
  }
}

type WorkholdingProject = Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>

// ── The vise and the clamp ───────────────────────────────────────────────────
//
// Fixed body, its own frame: x -50..50, y -20..0, z 0..40. Local pose identity.
// Moving jaw, its own frame: x -50..50, y 0..20, z 0..40. Local pose y +10.
//   Its joint slides along (0, 2, 0) - normalised to +Y - over 0..100 mm.
// Instance: at (200, 100, 5), turned 90 deg about Z: (x, y, z) -> (-y, x, z).
//
//   Fixed:  world x = 200 - y in [200, 220]; y = 100 + x in [50, 150]; z in [5, 45].
//   Jaw at opening v: frame y in [10 + v, 30 + v] -> world x in [170 - v, 190 - v],
//           y in [50, 150], z in [5, 45].
//
// Clamp, its own frame: x 0..30, y -5..5, z 0..10. Local pose (5, 0, 0) turned
// 180 deg about Z: (x, y) -> (5 - x, -y) -> x in [-25, 5], y in [-5, 5].
// Instance at (-40, 10, 20), not turned: x in [-65, -35], y in [5, 15], z in [20, 30].

const SHAPES = {
  'geo-fixed': boxLocal({ x: -50, y: -20, z: 0 }, { x: 50, y: 0, z: 40 }),
  'geo-jaw': boxLocal({ x: -50, y: 0, z: 0 }, { x: 50, y: 20, z: 40 }),
  'geo-clamp': boxLocal({ x: 0, y: -5, z: 0 }, { x: 30, y: 5, z: 10 }),
}

const ZERO = { x: 0, y: 0, z: 0 }

function viseDefinition(axis: Vec3 = { x: 0, y: 2, z: 0 }): WorkholdingDefinition {
  return {
    id: 'def-vise', revision: 1, name: '6 inch vise', kind: 'vise',
    components: [
      { id: 'fixed', name: 'Fixed body', geometryId: 'geo-fixed', localPose: { position: ZERO, rotation: ZERO } },
      {
        id: 'moving', name: 'Moving jaw', geometryId: 'geo-jaw',
        localPose: { position: { x: 0, y: 10, z: 0 }, rotation: ZERO },
        joint: { kind: 'linear', axis, minMm: 0, maxMm: 100, closedAtMm: 0 },
      },
    ],
  }
}

const CLAMP: WorkholdingDefinition = {
  id: 'def-clamp', revision: 3, name: 'Toe clamp', kind: 'clamp',
  components: [{
    id: 'body', name: 'Clamp', geometryId: 'geo-clamp',
    localPose: { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 180 } },
  }],
}

function viseInstance(openingMm: number | undefined, over: Partial<WorkholdingInstance> = {}): WorkholdingInstance {
  return {
    id: 'vise-1', definitionId: 'def-vise', definitionRevision: 1,
    setupScope: { kind: 'setups', setupIds: ['setup-top'] },
    worldPose: { position: { x: 200, y: 100, z: 5 }, rotation: { x: 0, y: 0, z: 90 } },
    jointValuesMm: openingMm === undefined ? {} : { moving: openingMm },
    placement: { kind: 'free' },
    ...over,
  }
}

const CLAMP_INSTANCE: WorkholdingInstance = {
  id: 'clamp-1', definitionId: 'def-clamp', definitionRevision: 3,
  setupScope: { kind: 'all' },
  worldPose: { position: { x: -40, y: 10, z: 20 }, rotation: ZERO },
  jointValuesMm: {},
}

function project(instances: WorkholdingInstance[], definitions = [viseDefinition(), CLAMP], geometry?: ImportedGeometry[]): WorkholdingProject {
  return {
    geometry: geometry ?? [row('geo-fixed'), row('geo-jaw'), row('geo-clamp'), row('part')],
    workholding: { definitions, instances },
  }
}

async function resolvedBoxes(p: WorkholdingProject, setupId: string | null = 'setup-top') {
  const result = await resolveWorkholding(p, setupId, { reader: readerOf(SHAPES) })
  return {
    result,
    box: (instanceId: string, componentId: string) => {
      const body = result.bodies.find((b) => b.instanceId === instanceId && b.componentId === componentId)
      expect(body, `${instanceId}/${componentId}`).toBeDefined()
      return bounds(body!.mesh.positions)
    },
  }
}

// ── Cases ────────────────────────────────────────────────────────────────────

describe('WO-2167: a two-body vise resolves to measured world transforms', () => {
  const FIXED: Box = { min: { x: 200, y: 50, z: 5 }, max: { x: 220, y: 150, z: 45 } }
  const jawAt = (v: number): Box => ({ min: { x: 170 - v, y: 50, z: 5 }, max: { x: 190 - v, y: 150, z: 45 } })

  it.each([
    ['closed (joint min 0)', 0],
    ['mid travel (50)', 50],
    ['fully open (joint max 100)', 100],
  ])('%s: the fixed body stays put and the jaw slides along the turned axis', async (_label, opening) => {
    const { result, box } = await resolvedBoxes(project([viseInstance(opening)]))
    expectBox(box('vise-1', 'fixed'), FIXED)
    expectBox(box('vise-1', 'moving'), jawAt(opening))
    const jaw = result.bodies.find((b) => b.componentId === 'moving')!
    expect(jaw.jointValueMm).toBe(opening)
    expect(jaw.shape).toBe('exact')
    expect(jaw.definitionId).toBe('def-vise')
    expect(jaw.definitionRevision).toBe(1)
    expect(result.notices).toEqual([])
  })

  it('the jaw frame origin lands exactly: frame (0,0,0) -> +10 local -> +50 joint -> turned -> placed = (140, 100, 5)', () => {
    const { placements } = resolveWorkholdingPlacements(project([viseInstance(50)]), 'setup-top')
    const jaw = placements.find((p) => p.componentId === 'moving')!
    // (0, 0, 0) -> local pose (0, 10, 0) -> joint (0, 60, 0) -> Rz90 (-60, 0, 0) -> + (200, 100, 5).
    expectPoint(transformPoint(jaw.worldFromComponent, ZERO), { x: 140, y: 100, z: 5 })
    // The frame's +X corner (50, 0, 0): -> (50, 60, 0) -> Rz90 (-60, 50, 0) -> (140, 150, 5).
    expectPoint(transformPoint(jaw.worldFromComponent, { x: 50, y: 0, z: 0 }), { x: 140, y: 150, z: 5 })
  })

  it('an opening outside the travel is kept within it (a number, not a refusal); none saved = the closed value', async () => {
    expectBox((await resolvedBoxes(project([viseInstance(150)]))).box('vise-1', 'moving'), jawAt(100))
    expectBox((await resolvedBoxes(project([viseInstance(-10)]))).box('vise-1', 'moving'), jawAt(0))
    expectBox((await resolvedBoxes(project([viseInstance(undefined)]))).box('vise-1', 'moving'), jawAt(0))
    expect(resolveJointValue(viseDefinition().components[1].joint!, 150)).toEqual({ valueMm: 100, axis: { x: 0, y: 1, z: 0 } })
  })

  it('a zero or non-finite slide axis resolves the jaw at its zero with a named notice', async () => {
    for (const axis of [ZERO, { x: NaN, y: 1, z: 0 }]) {
      const { result, box } = await resolvedBoxes(project([viseInstance(60)], [viseDefinition(axis), CLAMP]))
      expectBox(box('vise-1', 'moving'), jawAt(0))
      expectBox(box('vise-1', 'fixed'), FIXED)
      expect(result.notices).toEqual([
        'the moving part "6 inch vise - Moving jaw" has no usable slide direction or travel, so it is shown at its zero position.',
      ])
    }
  })

  it('a tilted instance composes in three.js XYZ order: turned (90, 0, 90) takes frame +X to world +Z', () => {
    const tilted = viseInstance(0, { worldPose: { position: ZERO, rotation: { x: 90, y: 0, z: 90 } } })
    const fixed = resolveWorkholdingPlacements(project([tilted]), 'setup-top').placements[0]
    // R = Rx(90) * Rz(90): (1,0,0) -Rz-> (0,1,0) -Rx-> (0,0,1); (0,0,1) -Rz-> (0,0,1) -Rx-> (0,-1,0).
    expectPoint(transformPoint(fixed.worldFromComponent, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: 1 })
    expectPoint(transformPoint(fixed.worldFromComponent, { x: 0, y: 0, z: 1 }), { x: 0, y: -1, z: 0 })
    // Same answer as three.js itself, the viewport's placement math.
    const three = new THREE.Object3D()
    three.rotation.set(Math.PI / 2, 0, Math.PI / 2)
    three.updateMatrix()
    const probe = new THREE.Vector3(3, 4, 5).applyMatrix4(three.matrix)
    expectPoint(transformPoint(fixed.worldFromComponent, { x: 3, y: 4, z: 5 }), probe)
  })
})

describe('WO-2167: a one-body clamp and setup scope', () => {
  it('the clamp resolves through its turned local pose to measured world bounds', async () => {
    const { result, box } = await resolvedBoxes(project([CLAMP_INSTANCE]))
    expectBox(box('clamp-1', 'body'), { min: { x: -65, y: 5, z: 20 }, max: { x: -35, y: 15, z: 30 } })
    const clamp = result.bodies[0]
    expect(clamp.jointValueMm).toBeUndefined()
    expect(clamp.definitionRevision).toBe(3)
    // Frame corner (30, 5, 0) -> Rz180 + (5,0,0) = (-25, -5, 0) -> + (-40, 10, 20) = (-65, 5, 20).
    expectPoint(transformPoint(clamp.worldFromComponent, { x: 30, y: 5, z: 0 }), { x: -65, y: 5, z: 20 })
  })

  it('only instances in the setup\'s scope resolve; "all" is in every setup', async () => {
    const p = project([viseInstance(0), CLAMP_INSTANCE])
    const ids = async (setupId: string | null) =>
      (await resolveWorkholding(p, setupId, { reader: readerOf(SHAPES) })).bodies.map((b) => `${b.instanceId}/${b.componentId}`)
    expect(await ids('setup-top')).toEqual(['vise-1/fixed', 'vise-1/moving', 'clamp-1/body'])
    expect(await ids('setup-bottom')).toEqual(['clamp-1/body'])
    expect(await ids(null)).toEqual(['clamp-1/body'])
  })

  it('a shape that cannot be read stands in as its bounding box, named', async () => {
    const clampRow = row('geo-clamp', {
      name: 'clamp.stl',
      boundingBox: { min: { x: 0, y: -5, z: 0 }, max: { x: 30, y: 5, z: 10 }, size: { x: 30, y: 10, z: 10 }, center: { x: 15, y: 0, z: 5 } },
    })
    const p = project([CLAMP_INSTANCE], [CLAMP], [clampRow])
    const result = await resolveWorkholding(p, 'setup-top', { reader: readerOf({}) })
    expect(result.bodies).toHaveLength(1)
    expect(result.bodies[0].shape).toBe('bounding-box')
    expectBox(bounds(result.bodies[0].mesh.positions), { min: { x: -65, y: 5, z: 20 }, max: { x: -35, y: 15, z: 30 } })
    expect(result.notices).toEqual([
      'the shape of the workholding "Toe clamp - Clamp" could not be read, so the tool was kept clear of its bounding box.',
    ])
  })

  it('a row used as an assembly component is shape data, not also a marked body of its own', async () => {
    const p = project([CLAMP_INSTANCE], [CLAMP], [row('geo-clamp', { workholding: true })])
    const result = await resolveWorkholding(p, 'setup-top', { reader: readerOf(SHAPES) })
    expect(result.bodies.map((b) => b.source)).toEqual(['instance'])
  })
})

describe('WO-2167: today\'s marked workholding resolves exactly where it does today', () => {
  it('a marked STL body, turned and moved: same world mesh fixtureObstacles gives it, in every setup', async () => {
    const jaw = row('marked-jaw', {
      name: 'Vise jaw', workholding: true,
      position: { x: 12, y: -7, z: 3 }, rotation: { x: 0, y: 0, z: 35 },
    })
    const geometry = [jaw, row('part')]
    const reader = readerOf({ 'marked-jaw': boxLocal({ x: -4, y: -3, z: 0 }, { x: 4, y: 3, z: 20 }) })
    const today = await resolveWorkholdingObstacles(geometry, undefined, [], reader)
    for (const setupId of ['setup-top', 'setup-bottom', null]) {
      const now = await resolveWorkholding({ geometry }, setupId, { reader })
      expect(now.bodies.map((b) => [b.source, b.instanceId, b.definitionId])).toEqual([['marked-geometry', 'marked-jaw', null]])
      expect(now.bodies[0].mesh.positions.length).toBe(today.meshes[0].positions.length)
      for (let i = 0; i < today.meshes[0].positions.length; i++) {
        expect(now.bodies[0].mesh.positions[i]).toBeCloseTo(today.meshes[0].positions[i], 4)
      }
      expect(now.notices).toEqual(today.notices)
    }
    // A body the operation cuts is not an obstacle to it, as today.
    expect((await resolveWorkholding({ geometry }, 'setup-top', { reader, cutGeometryIds: ['marked-jaw'] })).bodies).toEqual([])
  })

  it('a marked body whose shape cannot be read: the same bounding box and the same notice as today', async () => {
    const jaw = row('marked-jaw', {
      name: 'Vise jaw', workholding: true, position: { x: 5, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 90 },
      boundingBox: { min: { x: -4, y: -3, z: 0 }, max: { x: 4, y: 3, z: 20 }, size: { x: 8, y: 6, z: 20 }, center: { x: 0, y: 0, z: 10 } },
    })
    const today = await resolveWorkholdingObstacles([jaw], undefined, [], readerOf({}))
    const now = await resolveWorkholding({ geometry: [jaw] }, 'setup-top', { reader: readerOf({}) })
    expectBox(bounds(now.bodies[0].mesh.positions), bounds(today.meshes[0].positions))
    // By hand: x = 5 - y in [2, 8], y = 5 + x in [1, 9].
    expectBox(bounds(now.bodies[0].mesh.positions), { min: { x: 2, y: 1, z: 0 }, max: { x: 8, y: 9, z: 20 } })
    expect(now.notices).toEqual(today.notices)
    expect(now.bodies[0].shape).toBe('bounding-box')
  })

  it('a Model body resolves through its Model Item placement to where the display draws it', async () => {
    // Display tessellation, body frame: x 0..10, y 0..4, z 0..6.
    const display = boxLocal({ x: 0, y: 0, z: 0 }, { x: 10, y: 4, z: 6 })
    const modelRow = row('model-fixture', {
      name: 'Fixture plate', format: 'model', workholding: true, modelItemId: 'item-1',
      // The row's own position is NOT where a Model body is drawn - its placement is.
      position: { x: 999, y: 999, z: 999 },
      modelBody: {
        ref: { bodyId: 'body-1', stableIds: [], version: 1 },
        display: {
          positions: Array.from(display.positions), normals: [], indices: Array.from(display.indices), edgePositions: [], edgeOffsets: [],
          bbox: { min: [0, 0, 0], max: [10, 4, 6] },
        },
      },
    } as Partial<ImportedGeometry>)
    const placements: ModelItemPlacementRecord[] = [
      { modelItemId: 'item-1', position: { x: 30, y: 40, z: 2 }, rotation: { x: 0, y: 0, z: 90 } },
    ]
    const now = await resolveWorkholding({ geometry: [modelRow], modelItemPlacements: placements }, 'setup-top', { reader: readerOf({}) })
    // By hand: Rz90 (x, y) -> (-y, x): x = 30 - y in [26, 30], y = 40 + x in [40, 50], z in [2, 8].
    const expected = { min: { x: 26, y: 40, z: 2 }, max: { x: 30, y: 50, z: 8 } }
    expectBox(bounds(now.bodies[0].mesh.positions), expected)
    expect(now.bodies[0].shape).toBe('exact')
    const today = await resolveWorkholdingObstacles([modelRow], placements, [], readerOf({}))
    expectBox(bounds(today.meshes[0].positions), expected)
  })

  it('an STL body is recentred exactly as the viewport draws it (xy centre, bottom on 0), then posed', async () => {
    // Real STL bytes of an 8 x 6 x 20 box whose corner sits at (100, 50, 7) in the file.
    cache.stl.set('stl-jaw', boxStl({ x: 8, y: 6, z: 20 }, { x: 100, y: 50, z: 7 }))
    const jaw = row('stl-jaw', {
      name: 'STL jaw', workholding: true, position: { x: 10, y: 20, z: 5 }, rotation: { x: 0, y: 0, z: 90 },
    })
    // Production reader (no injection): recentred to x -4..4, y -3..3, z 0..20;
    // turned 90 about Z: x = 10 - y in [7, 13], y = 20 + x in [16, 24]; z in [5, 25].
    const now = await resolveWorkholding({ geometry: [jaw] }, 'setup-top')
    const expected = { min: { x: 7, y: 16, z: 5 }, max: { x: 13, y: 24, z: 25 } }
    expectBox(bounds(now.bodies[0].mesh.positions), expected)
    expect(now.bodies[0].shape).toBe('exact')
    const today = await resolveWorkholdingObstacles([jaw], undefined)
    expectBox(bounds(today.meshes[0].positions), expected)

    // The same STL as a vise component: its own recentred frame is placed by the instance, not by the row.
    const def: WorkholdingDefinition = {
      id: 'def-stl', revision: 1, name: 'STL vise', kind: 'vise',
      components: [{ id: 'jaw', name: 'Jaw', geometryId: 'stl-jaw', localPose: { position: ZERO, rotation: ZERO } }],
    }
    const inst: WorkholdingInstance = {
      id: 'stl-vise', definitionId: 'def-stl', definitionRevision: 1, setupScope: { kind: 'all' },
      worldPose: { position: { x: 100, y: 0, z: 0 }, rotation: ZERO }, jointValuesMm: {},
    }
    const asComponent = await resolveWorkholding({ geometry: [jaw], workholding: { definitions: [def], instances: [inst] } }, 'setup-top')
    expect(asComponent.bodies).toHaveLength(1)
    expectBox(bounds(asComponent.bodies[0].mesh.positions), { min: { x: 96, y: -3, z: 0 }, max: { x: 104, y: 3, z: 20 } })
  })
})

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
