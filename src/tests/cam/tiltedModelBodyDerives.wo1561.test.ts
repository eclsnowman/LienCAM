// WO-1561: every model-body derive works on a body at any Placement, not only
// Section at Z and the profile (WO-1543). The rule this file pins, for the
// picked face, drill targets, bore target, boss centre, circular-edge origin
// and edge chain: a derive on a body at placement P gives the result the
// operator gets by first applying P to the body and then deriving from it.
//
// Method: build the PLACED body (an upright block with a vertical through-hole,
// a boss and a round rim) in world coordinates. The control derives it with an
// identity placement - the untouched upright path. The subject is the same
// body un-placed into its local frame with this file's own Euler XYZ math, then
// derived at P. Both must agree for tilts, Z-then-X combinations and a flip.

import { describe, it, expect } from 'vitest'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, Loop2D, ModelItemPlacementRecord } from '../../types'
import {
  deriveModelBodyFace,
  deriveModelBodyDrillTargets,
  deriveModelBodyBoreTarget,
  deriveModelBodyCircularOrigin,
} from '../../lib/cam/modelBodyDerive'
import { deriveModelBodyEdges } from '../../store/modelEdgeChainBinding'
import { resolveSetupBoreOriginPick, resolveSetupCircleOriginPick } from '../../store'
import { transformLoopPoints } from '../../store/dispatchGeo'

interface Pt3 { x: number; y: number; z: number }
interface Pose { position: Pt3; rotation: Pt3 }

const ITEM = 'item-wo1561'
const BODY = 'body-wo1561'
const IDENTITY: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }

// ---- this file's own Euler XYZ (three.js order: R = Rx * Ry * Rz) ----------
const rad = (d: number) => (d * Math.PI) / 180
const rotX = (p: Pt3, a: number): Pt3 => ({ x: p.x, y: p.y * Math.cos(a) - p.z * Math.sin(a), z: p.y * Math.sin(a) + p.z * Math.cos(a) })
const rotY = (p: Pt3, a: number): Pt3 => ({ x: p.x * Math.cos(a) + p.z * Math.sin(a), y: p.y, z: -p.x * Math.sin(a) + p.z * Math.cos(a) })
const rotZ = (p: Pt3, a: number): Pt3 => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a), z: p.z })
const turn = (v: Pt3, r: Pt3) => rotX(rotY(rotZ(v, rad(r.z)), rad(r.y)), rad(r.x))
const unturn = (v: Pt3, r: Pt3) => rotZ(rotY(rotX(v, -rad(r.x)), -rad(r.y)), -rad(r.z))
const place = (p: Pt3, pose: Pose): Pt3 => {
  const t = turn(p, pose.rotation)
  return { x: t.x + pose.position.x, y: t.y + pose.position.y, z: t.z + pose.position.z }
}
const unplace = (w: Pt3, pose: Pose): Pt3 =>
  unturn({ x: w.x - pose.position.x, y: w.y - pose.position.y, z: w.z - pose.position.z }, pose.rotation)
const unplaceFlat = (flat: readonly number[], pose: Pose): number[] => {
  const out: number[] = []
  for (let i = 0; i < flat.length; i += 3) {
    const p = unplace({ x: flat[i], y: flat[i + 1], z: flat[i + 2] }, pose)
    out.push(p.x, p.y, p.z)
  }
  return out
}
const arr = (p: Pt3): [number, number, number] => [p.x, p.y, p.z]

// ---- the PLACED body, in world coordinates ---------------------------------
// Top face F_top at Z 10: 40x30 outline around a centred 10x10 opening.
// Side wall F_side at Y -15. Boss wall B_wall: r 4 at (-14, 9), Z 10..16.
// Vertical through-hole (dia 6, depth 10) at (0, 0), rim at Z 10.
// Round rim edge E_rim: r 3 around (0, 0) at Z 10.

interface WorldMesh { positions: number[]; indices: number[]; triFace: number[]; faceIds: string[] }

function worldMesh(): WorldMesh {
  const positions: number[] = []
  const indices: number[] = []
  const triFace: number[] = []
  const faceIds = ['F_top', 'F_side', 'B_wall']
  const quad = (face: number, a: Pt3, b: Pt3, c: Pt3, d: Pt3) => {
    const base = positions.length / 3
    for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    triFace.push(face, face)
  }
  const outer = [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }]
  const inner = [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    quad(0, { ...outer[i], z: 10 }, { ...outer[j], z: 10 }, { ...inner[j], z: 10 }, { ...inner[i], z: 10 })
  }
  quad(1, { x: -20, y: -15, z: 0 }, { x: 20, y: -15, z: 0 }, { x: 20, y: -15, z: 10 }, { x: -20, y: -15, z: 10 })
  const n = 32
  for (let k = 0; k < n; k++) {
    const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n
    const p0 = { x: -14 + 4 * Math.cos(a0), y: 9 + 4 * Math.sin(a0) }
    const p1 = { x: -14 + 4 * Math.cos(a1), y: 9 + 4 * Math.sin(a1) }
    quad(2, { ...p0, z: 10 }, { ...p1, z: 10 }, { ...p1, z: 16 }, { ...p0, z: 16 })
  }
  return { positions, indices, triFace, faceIds }
}

/** Edge table: the outer rectangle and the inner opening of F_top, one
 *  straight edge each. */
function worldEdges(): { edgeIds: string[]; edgePositions: number[]; edgeOffsets: number[] } {
  const rings = [
    [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }],
    [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
  ]
  const edgeIds: string[] = []
  const edgePositions: number[] = []
  const edgeOffsets: number[] = [0]
  rings.forEach((ring, r) => ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]
    edgeIds.push(`E:${r}:${i}`)
    edgePositions.push(p.x, p.y, 10, q.x, q.y, 10)
    edgeOffsets.push(edgeOffsets[edgeOffsets.length - 1] + 2)
  }))
  return { edgeIds, edgePositions, edgeOffsets }
}

/** The body as it sits in ITS OWN frame when placed at `pose`. */
function bodyGeo(pose: Pose): ImportedGeometry {
  const mesh = worldMesh()
  const edges = worldEdges()
  return {
    id: 'modelbody:wo1561', name: 'Tilted part', filename: '', type: 'model', format: 'model',
    loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -20, y: -15, z: 0 }, max: { x: 20, y: 15, z: 16 },
      size: { x: 40, y: 30, z: 16 }, center: { x: 0, y: 0, z: 8 },
    },
    modelItemId: ITEM,
    modelBody: {
      ref: { bodyId: BODY, stableIds: [...mesh.faceIds, ...edges.edgeIds], version: 1 },
      display: {
        positions: unplaceFlat(mesh.positions, pose), normals: [], indices: mesh.indices,
        faceIds: mesh.faceIds, triFace: mesh.triFace,
        edgeIds: edges.edgeIds, edgePositions: unplaceFlat(edges.edgePositions, pose), edgeOffsets: edges.edgeOffsets,
        bbox: { min: [-20, -15, 0], max: [20, 15, 16] },
      },
    },
  } as unknown as ImportedGeometry
}

const records = (pose: Pose): ModelItemPlacementRecord[] => [{ modelItemId: ITEM, position: pose.position, rotation: pose.rotation }]

// ---- recognizer facts, in the body's own frame ----------------------------
const HOLE_RIM: Pt3 = { x: 0, y: 0, z: 10 }
const UP: Pt3 = { x: 0, y: 0, z: 1 }

function holeVerdict(pose: Pose): FeatureVerdict {
  const c = unplace(HOLE_RIM, pose)
  const a = unturn(UP, pose.rotation)
  return {
    featureKey: 'hole:wo1561:through', featureClass: 'throughHole', removable: true, effect: 'add',
    faceIds: ['H_wall'], neighbourIds: [],
    params: { diameter: 6, depth: 10, axisX: a.x, axisY: a.y, axisZ: a.z, centerX: c.x, centerY: c.y, centerZ: c.z },
  }
}
function holeSnapshot(pose: Pose): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: arr(unplace({ x: 3, y: 0, z: 5 }, pose)), normal: [1, 0, 0], area: 188,
    axis: arr(unturn(UP, pose.rotation)), axisPoint: arr(unplace({ x: 0, y: 0, z: 0 }, pose)), radius: 3,
  }
}

/** Base circle spans along the body's LOCAL X/Y, measured by sampling the
 *  placed boss's base circle - what the recognizer reports as spanX/spanY. */
function bossVerdict(pose: Pose): FeatureVerdict {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let k = 0; k < 7200; k++) {
    const a = (2 * Math.PI * k) / 7200
    const p = unplace({ x: -14 + 4 * Math.cos(a), y: 9 + 4 * Math.sin(a), z: 10 }, pose)
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const c = unplace({ x: -14, y: 9, z: 10 }, pose)
  return {
    featureKey: 'loop:wo1561:boss', featureClass: 'boss', removable: true, effect: 'remove',
    faceIds: ['B_wall'], neighbourIds: [],
    params: { centerX: c.x, centerY: c.y, centerZ: c.z, spanX: maxX - minX, spanY: maxY - minY, depth: 6, faceCount: 2 },
  }
}
function bossSnapshot(pose: Pose): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: arr(unplace({ x: -14, y: 13, z: 13 }, pose)), normal: [0, 1, 0], area: 150,
    axis: arr(unturn(UP, pose.rotation)), axisPoint: arr(unplace({ x: -14, y: 9, z: 10 }, pose)), radius: 4,
  }
}

function rimPoints(pose: Pose): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = []
  for (let k = 0; k <= 64; k++) {
    const a = (2 * Math.PI * (k % 64)) / 64
    pts.push(arr(unplace({ x: 3 * Math.cos(a), y: 3 * Math.sin(a), z: 10 }, pose)))
  }
  return pts
}

// ---- comparison ------------------------------------------------------------
const EPS = 1e-6

function area(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a) / 2
}

function expectSameLoops(got: readonly Loop2D[], want: readonly Loop2D[]) {
  expect(got.length).toBe(want.length)
  const byArea = (ls: readonly Loop2D[]) => [...ls].sort((a, b) => area(b.points) - area(a.points))
  const g = byArea(got), w = byArea(want)
  for (let i = 0; i < w.length; i++) {
    expect(g[i].type).toBe(w[i].type)
    expect(g[i].points.length).toBe(w[i].points.length)
    expect(Math.abs(area(g[i].points) - area(w[i].points))).toBeLessThan(1e-4)
    for (const p of w[i].points) {
      const nearest = Math.min(...g[i].points.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))
      expect(nearest).toBeLessThan(EPS)
    }
  }
}

// Tilts about X, Z-then-X combinations, a compound tilt, a part modelled on its
// side stood up by a 90 deg Placement, and an upside-down flip. Every one moves
// the part off (and back onto) world Z through its Placement.
const POSES: Array<[string, Pose]> = [
  ['30 deg about X', { position: { x: 5, y: -7, z: 3 }, rotation: { x: 30, y: 0, z: 0 } }],
  ['40 about Z then 30 about X', { position: { x: 5, y: -7, z: 3 }, rotation: { x: 30, y: 0, z: 40 } }],
  ['15 about Z, 20 about Y, -30 about X', { position: { x: -12, y: 4, z: 9 }, rotation: { x: -30, y: 20, z: 15 } }],
  ['on its side (90 about X)', { position: { x: 2, y: 3, z: 25 }, rotation: { x: 90, y: 0, z: 0 } }],
  ['upside down (180 about X)', { position: { x: 0, y: 0, z: 16 }, rotation: { x: 180, y: 0, z: 0 } }],
]

describe('WO-1561: every model-body derive on a tilted body matches the derive on the placement-applied body', () => {
  const control = bodyGeo(IDENTITY)

  for (const [label, pose] of POSES) {
    describe(label, () => {
      const geo = bodyGeo(pose)

      it('picked top face', () => {
        const want = deriveModelBodyFace(control, 'F_top', records(IDENTITY))
        const got = deriveModelBodyFace(geo, 'F_top', records(pose))
        expect(want.loops.map((l) => l.type).sort()).toEqual(['contour', 'hole'])
        expectSameLoops(got.loops, want.loops)
        expect(Math.abs(got.z - want.z)).toBeLessThan(EPS)
      })

      it('drill target of the vertical through-hole', () => {
        const want = deriveModelBodyDrillTargets(control, records(IDENTITY), [holeVerdict(IDENTITY)])
        const got = deriveModelBodyDrillTargets(geo, records(pose), [holeVerdict(pose)])
        expect(got.targets).toHaveLength(1)
        const g = got.targets[0], w = want.targets[0]
        expect(w).toMatchObject({ centerX: 0, centerY: 0, topZ: 10, bottomZ: 0, through: true })
        for (const k of ['centerX', 'centerY', 'topZ', 'bottomZ', 'diameter'] as const) {
          expect(Math.abs(g[k] - w[k])).toBeLessThan(EPS)
        }
        g.axis.forEach((v, i) => expect(Math.abs(v - w.axis[i])).toBeLessThan(EPS))
        expect(Math.abs(got.z - want.z)).toBeLessThan(EPS)
        expectSameLoops(got.loops, want.loops)
        expect(Math.abs(got.holes[0].topZ - want.holes[0].topZ)).toBeLessThan(EPS)
      })

      it('bore target of the same hole wall', () => {
        const want = deriveModelBodyBoreTarget(control, records(IDENTITY), 'H_wall', holeSnapshot(IDENTITY), [holeVerdict(IDENTITY)])
        const got = deriveModelBodyBoreTarget(geo, records(pose), 'H_wall', holeSnapshot(pose), [holeVerdict(pose)])
        expect(Math.abs(got.cylinder.center[0] - want.cylinder.center[0])).toBeLessThan(EPS)
        expect(Math.abs(got.cylinder.center[1] - want.cylinder.center[1])).toBeLessThan(EPS)
        expect(Math.abs(got.cylinder.topZ - want.cylinder.topZ)).toBeLessThan(EPS)
        expect(Math.abs(got.cylinder.bottomZ - want.cylinder.bottomZ)).toBeLessThan(EPS)
        expect(Math.abs(got.target.depth - want.target.depth)).toBeLessThan(EPS)
      })

      it('boss centre, through the Setup zero-point pick', () => {
        const direct = deriveModelBodyCircularOrigin(control, records(IDENTITY), 'B_wall', bossSnapshot(IDENTITY), [bossVerdict(IDENTITY)])
        expect(direct).toMatchObject({ faceKind: 'boss', topZ: 16, bottomZ: 10, diameter: 8 })
        const want = resolveSetupBoreOriginPick(control, BODY, 'B_wall', bossSnapshot(IDENTITY), [bossVerdict(IDENTITY)], records(IDENTITY))
        const got = resolveSetupBoreOriginPick(geo, BODY, 'B_wall', bossSnapshot(pose), [bossVerdict(pose)], records(pose))
        expect(Math.abs(got.origin.x - want.origin.x)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.y - want.origin.y)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.z - want.origin.z)).toBeLessThan(EPS)
      })

      it('bore centre, through the Setup zero-point pick', () => {
        const want = resolveSetupBoreOriginPick(control, BODY, 'H_wall', holeSnapshot(IDENTITY), [holeVerdict(IDENTITY)], records(IDENTITY))
        const got = resolveSetupBoreOriginPick(geo, BODY, 'H_wall', holeSnapshot(pose), [holeVerdict(pose)], records(pose))
        expect(Math.abs(got.origin.x - want.origin.x)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.y - want.origin.y)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.z - want.origin.z)).toBeLessThan(EPS)
      })

      it('circular-edge origin, through the Setup zero-point pick, with a local centre that places back onto it', () => {
        const want = resolveSetupCircleOriginPick(control, BODY, 'E_rim', rimPoints(IDENTITY), records(IDENTITY))
        const got = resolveSetupCircleOriginPick(geo, BODY, 'E_rim', rimPoints(pose), records(pose))
        expect(Math.abs(got.origin.x - want.origin.x)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.y - want.origin.y)).toBeLessThan(EPS)
        expect(Math.abs(got.origin.z - want.origin.z)).toBeLessThan(EPS)
        // Placement tracking (WO-1382) re-places the local centre with the full
        // rotation: it must land back on the picked world centre.
        const back = place(got.snapLocalPt, pose)
        expect(Math.abs(back.x - got.origin.x)).toBeLessThan(EPS)
        expect(Math.abs(back.y - got.origin.y)).toBeLessThan(EPS)
        expect(Math.abs(back.z - got.origin.z)).toBeLessThan(EPS)
      })

      it('edge chain (outline plus opening)', () => {
        const ids = worldEdges().edgeIds
        const want = deriveModelBodyEdges(control, ids, records(IDENTITY))
        const got = deriveModelBodyEdges(geo, ids, records(pose))
        expect(want.loops.map((l) => l.type).sort()).toEqual(['contour', 'hole'])
        expectSameLoops(got.loops, want.loops)
        expect(Math.abs(got.z - want.z)).toBeLessThan(EPS)
      })
    })
  }
})

describe('WO-1561: a feature that is not vertical AS PLACED is named, never the body tilt', () => {
  // The body built upright in its own frame, then tilted 30 deg about X by its
  // Placement: every feature ends up 30 deg off world Z.
  const tilt: Pose = { position: { x: 5, y: -7, z: 3 }, rotation: { x: 30, y: 0, z: 0 } }
  const geo = bodyGeo(IDENTITY)
  const bodyTiltWording = /is tilted [\d.]+ deg off the Z axis|Reset the Placement's rotation/

  const refusal = (fn: () => unknown): string => {
    try { fn() } catch (err) { return (err as Error).message }
    throw new Error('expected a refusal')
  }

  it('drill: names the hole whose axis is off world Z', () => {
    const msg = refusal(() => deriveModelBodyDrillTargets(geo, records(tilt), [holeVerdict(IDENTITY)]))
    expect(msg).toContain('hole:wo1561:through')
    expect(msg).toMatch(/tilted off world Z at the body's placement \(\|nz\|=0\.866\)/)
    expect(msg).not.toMatch(bodyTiltWording)
  })

  it('face: names the picked face that is not level as placed', () => {
    const msg = refusal(() => deriveModelBodyFace(geo, 'F_top', records(tilt)))
    expect(msg).toContain('"F_top"')
    expect(msg).toMatch(/not flat and horizontal as placed/)
    expect(msg).not.toMatch(bodyTiltWording)
  })

  it('boss: names the boss whose axis is off world Z', () => {
    const msg = refusal(() => deriveModelBodyCircularOrigin(geo, records(tilt), 'B_wall', bossSnapshot(IDENTITY), [bossVerdict(IDENTITY)]))
    expect(msg).toContain('"B_wall"')
    expect(msg).toMatch(/tilted off world Z at the body's placement/)
    expect(msg).not.toMatch(bodyTiltWording)
  })

  it('circular edge: names the rim that is not horizontal as placed', () => {
    const msg = refusal(() => resolveSetupCircleOriginPick(geo, BODY, 'E_rim', rimPoints(IDENTITY), records(tilt)))
    expect(msg).toContain('"E_rim"')
    expect(msg).toMatch(/not horizontal at the body's placement/)
    expect(msg).not.toMatch(bodyTiltWording)
  })

  it('edge chain: refuses edges that are not level as placed', () => {
    const msg = refusal(() => deriveModelBodyEdges(geo, worldEdges().edgeIds, records(tilt)))
    expect(msg).toMatch(/not all on one flat, horizontal plane as placed/)
    expect(msg).not.toMatch(bodyTiltWording)
  })

  it('the side wall of the same body stood on its end IS a level face', () => {
    // Rotating the part -90 deg about X lays the Y -15 side wall flat.
    const side: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: -90, y: 0, z: 0 } }
    const { loops, z } = deriveModelBodyFace(geo, 'F_side', records(side))
    expect(loops).toHaveLength(1)
    expect(Math.abs(area(loops[0].points) - 400)).toBeLessThan(1e-6)
    expect(Math.abs(z - 15)).toBeLessThan(EPS)
  })
})

describe('WO-1561: an upright (Z-only) Placement keeps the local derive + XY rotation', () => {
  const pose: Pose = { position: { x: 4, y: -6, z: 2 }, rotation: { x: 0, y: 0, z: 37 } }
  const geo = bodyGeo(IDENTITY)

  it('face and edge chain loops are the identity derive rotated into world XY, bit for bit', () => {
    const face0 = deriveModelBodyFace(geo, 'F_top', records(IDENTITY))
    const face = deriveModelBodyFace(geo, 'F_top', records(pose))
    expect(face.loops.map((l) => l.points)).toEqual(face0.loops.map((l) => transformLoopPoints(l.points, pose)))
    expect(face.z).toBe(face0.z + pose.position.z)

    const ids = worldEdges().edgeIds
    const edges0 = deriveModelBodyEdges(geo, ids, records(IDENTITY))
    const edges = deriveModelBodyEdges(geo, ids, records(pose))
    expect(edges.loops.map((l) => l.points)).toEqual(edges0.loops.map((l) => transformLoopPoints(l.points, pose)))
    expect(edges.z).toBe(edges0.z + pose.position.z)
  })

  it('drill target centre is the local centre rotated into world XY', () => {
    const got = deriveModelBodyDrillTargets(geo, records(pose), [holeVerdict(IDENTITY)])
    const [c] = transformLoopPoints([{ x: 0, y: 0 }], pose)
    expect(got.targets[0].centerX).toBe(c.x)
    expect(got.targets[0].centerY).toBe(c.y)
    expect(got.targets[0].topZ).toBe(12)
    expect(got.targets[0].bottomZ).toBe(2)
  })
})
