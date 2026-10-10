// WO-2177 HARD LIMIT (Operator 09-28: never break what works): a project with no
// vise made by the new tools - every project today, marked workholding
// included - gets BYTE-IDENTICAL workholding for CAM and the same boxes for
// simulation contact as main.
//
// The digests below were recorded on main (2d4b6679e) BEFORE this order changed
// anything, by running this same file there. Each covers every float and index
// of every mesh, the mesh array types, and every notice, for each kind of
// marked body today's projects hold: an STL (real bytes, recentred), an STL
// whose shape cannot be read (its box stands in), a STEP display tessellation,
// a Model-workbench body through its placement, a Model body with no placement,
// a flat sketch, and a body the operation itself cuts. The 2D worker is fed
// exactly these meshes, so the same meshes mean the same moves.

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>(), step: new Map<string, unknown>() }))
vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStepDisplay: vi.fn(async (id: string) => (cache.step.get(id) ?? null) as Awaited<ReturnType<typeof import('../../lib/stepCache').loadCachedStepDisplay>>),
}))

import { resolveWorkholdingObstacles } from '../../store/fixtureObstacles'
import { workholdingContactBodies } from '../../lib/workholding/contactBodies'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import type { BoundingBox, ImportedGeometry, ModelItemPlacementRecord, Vec3 } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A binary STL of an axis-aligned box, deliberately off-centre so the display recentring runs. */
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
    for (let v = 0; v < 3; v++) {
      const p = c(tris[t * 3 + v])
      view.setFloat32(84 + 50 * t + 12 + v * 12, p.x, true)
      view.setFloat32(84 + 50 * t + 16 + v * 12, p.y, true)
      view.setFloat32(84 + 50 * t + 20 + v * 12, p.z, true)
    }
  }
  return buffer
}

function row(id: string, over: Partial<ImportedGeometry>): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -4, y: -3, z: 0 }, { x: 4, y: 3, z: 20 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
    ...over,
  } as ImportedGeometry
}

function modelRow(id: string, modelItemId: string, bodyId: string): ImportedGeometry {
  const positions: number[] = []
  for (const z of [0, 6]) for (const y of [0, 4]) for (const x of [0, 10]) positions.push(x, y, z)
  return row(id, {
    name: `Model ${id}`, format: 'model', modelItemId, position: { x: 999, y: 999, z: 999 },
    modelBody: {
      ref: { bodyId, stableIds: [], version: 1 },
      display: {
        positions, normals: [], edgePositions: [], edgeOffsets: [],
        indices: [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5],
        bbox: { min: [0, 0, 0], max: [10, 4, 6] },
      },
    },
  } as Partial<ImportedGeometry>)
}

/** Every kind of marked body a project holds today, plus an unmarked part. */
function todaysProject(): { geometry: ImportedGeometry[]; placements: ModelItemPlacementRecord[] } {
  cache.stl.clear()
  cache.step.clear()
  cache.stl.set('stl-jaw', boxStl({ x: 8, y: 6, z: 20 }, { x: 100, y: 50, z: 7 }))
  cache.stl.set('stl-fixed', boxStl({ x: 30, y: 12.5, z: 18 }, { x: -3.25, y: 7.1, z: 0.4 }))
  cache.step.set('step-plate', {
    payload: { mesh: { positions: [0, 0, 0, 20, 0, 0, 20, 15, 0, 0, 15, 0, 0, 0, 5, 20, 0, 5, 20, 15, 5, 0, 15, 5],
      indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) } },
  })
  const geometry: ImportedGeometry[] = [
    row('part', { workholding: undefined, format: 'dxf', type: 'curves_2d' } as Partial<ImportedGeometry>),
    row('stl-jaw', { name: 'Vise jaw', position: { x: 12.3, y: -7.7, z: 3 }, rotation: { x: 0, y: 0, z: 35 } }),
    row('stl-fixed', { name: 'Fixed jaw', position: { x: -40.125, y: 11, z: 0 }, rotation: { x: 3, y: -2, z: 117.5 } }),
    row('stl-unread', { name: 'Unread clamp', position: { x: 5, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }),
    row('step-plate', { name: 'Fixture plate', format: 'step', position: { x: 1.5, y: 2.5, z: -5 }, rotation: { x: 0, y: 0, z: 12 } }),
    modelRow('model-block', 'item-1', 'body-1'),
    modelRow('model-orphan', 'item-missing', 'body-9'),
    row('flat-sketch', { name: 'Flat', boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }) }),
  ]
  const placements: ModelItemPlacementRecord[] = [
    { modelItemId: 'item-1', position: { x: 30, y: 40, z: 2 }, rotation: { x: 0, y: 0, z: 90 } },
  ]
  return { geometry, placements }
}

function digest(value: { meshes: readonly ClearanceMesh[]; notices?: readonly string[] }): string {
  const plain = {
    meshes: value.meshes.map((m) => ({
      positionsType: m.positions.constructor.name,
      indicesType: m.indices.constructor.name,
      positions: Array.from(m.positions),
      indices: Array.from(m.indices),
    })),
    notices: value.notices ?? null,
  }
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex')
}

/** The scopes a generate call can pass for a project with no placed vise or clamp. */
const NO_ASSEMBLIES = [undefined, { workholding: undefined, setupId: 'setup-1' }, { workholding: { definitions: [], instances: [] }, setupId: null }]

// Recorded on main 2d4b6679e (see the header).
const MAIN = {
  camAll: '21561860e61c6eb6d986876624d0a0794479d9dd2dcf5cf6839675d3c15c89d2',
  camCutsJaw: '6a51bad57329b80bb47d74bbc51eaeebc04b40884e203d86dcdbb079f2193793',
  simulation: 'a618f6644ef0cf0bcd0c961f6b5be30856d7ab425ad39f63289767adc6649691',
}

describe('WO-2177: today\'s projects get exactly main\'s workholding', () => {
  it('CAM keep-out: every marked body, every float, every notice', async () => {
    const { geometry, placements } = todaysProject()
    for (const assemblies of NO_ASSEMBLIES) {
      const all = await resolveWorkholdingObstacles(geometry, placements, ['part'], undefined, assemblies)
      expect(all.meshes.length).toBe(5)
      expect(digest(all)).toBe(MAIN.camAll)
    }
  })

  it('CAM keep-out when the operation cuts a marked body: that body is left out, as on main', async () => {
    const { geometry, placements } = todaysProject()
    for (const assemblies of NO_ASSEMBLIES) {
      const cut = await resolveWorkholdingObstacles(geometry, placements, ['stl-jaw'], undefined, assemblies)
      expect(digest(cut)).toBe(MAIN.camCutsJaw)
    }
  })

  it('simulation contact: the same box for every marked body', () => {
    const { geometry } = todaysProject()
    for (const setupId of ['setup-1', null]) {
      for (const workholding of [undefined, { definitions: [], instances: [] }]) {
        expect(digest({ meshes: workholdingContactBodies({ geometry, workholding }, setupId) })).toBe(MAIN.simulation)
      }
    }
  })
})
