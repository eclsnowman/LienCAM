// Form stage 2 core: picking the cage over the skin, selections, transforms
// about the selection, and face extrusion. The UI glue (gizmo, pointer) is
// proven by the live-app captures; these prove the rules it runs on.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cloneCage, edgeKey, type Cage } from '../../form/cage'
import { validateCage } from '../../form/halfEdge'
import { boxCage, planeCage } from '../../form/starters'
import { pickCage } from '../../form/pick'
import { compileSkin, evaluateSkin } from '../../form/surface'
import { cagePositionArray } from '../../form/subdivide'
import { centroidOf, extrudeFaces, facesNormal, selectionPoints, transformPoints } from '../../form/topology'
import { applyPick, pruneSelection } from '../../form/formStore'

const W = 800, H = 600

/** A camera looking straight down -Y at the box (front view), and the live skin mesh. */
function scene(cage: Cage, from = new THREE.Vector3(0, -150, 20)) {
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 1000)
  camera.up.set(0, 0, 1)
  camera.position.copy(from)
  camera.lookAt(0, 0, 20)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const skin = compileSkin(cage, 3)
  const buf = evaluateSkin(skin, cagePositionArray(cage))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(skin.indices, 1))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.updateMatrixWorld(true)
  const screen = (p: readonly number[]) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera)
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }
  }
  const skinInput = { mesh, cageFaceOfTriangle: (t: number) => skin.cageFaceOfSkinFace[skin.skinFaceOfTriangle[t]] }
  return { camera, screen, skinInput }
}

describe('picking the cage over the smooth skin', () => {
  const cage = boxCage()
  const { camera, screen, skinInput } = scene(cage)

  it('a click on a front cage point picks that point', () => {
    const front = cage.positions.findIndex((p) => p[1] < -19 && Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 20) < 1e-9)
    const s = screen(cage.positions[front])
    expect(pickCage({ cage, camera, width: W, height: H, x: s.x + 3, y: s.y - 2, skin: skinInput })).toEqual({ kind: 'point', index: front })
  })

  it('a back point hidden behind the skin is not picked through it; the front face is', () => {
    // the back-centre point projects onto the same pixel as the front-centre point's face region
    const back = cage.positions.findIndex((p) => p[1] > 19 && Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 20) < 1e-9)
    const s = screen(cage.positions[back])
    const pick = pickCage({ cage, camera, width: W, height: H, x: s.x, y: s.y, skin: skinInput })
    // it lands on the front point (same line of sight), never on the hidden back one
    expect(pick).not.toEqual({ kind: 'point', index: back })
  })

  it('in cage-only display nothing is hidden: the same pixel may take a back point', () => {
    const noFront = cloneCage(cage)
    // move the front centre point away so only the back one sits under the pixel
    const front = noFront.positions.findIndex((p) => p[1] < -19 && Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 20) < 1e-9)
    noFront.positions[front] = [0, -20, 35]
    const back = noFront.positions.findIndex((p) => p[1] > 19 && Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 20) < 1e-9)
    const view = scene(noFront)
    const s = view.screen(noFront.positions[back])
    expect(pickCage({ cage: noFront, camera: view.camera, width: W, height: H, x: s.x, y: s.y, skin: null })).toEqual({ kind: 'point', index: back })
    const hidden = pickCage({ cage: noFront, camera: view.camera, width: W, height: H, x: s.x, y: s.y, skin: view.skinInput })
    expect(hidden).not.toEqual({ kind: 'point', index: back })
  })

  it('a click near the middle of a front edge picks the edge', () => {
    const a = cage.positions.findIndex((p) => p[1] < -19 && p[0] < -19 && Math.abs(p[2] - 20) < 1e-9)
    const b = cage.positions.findIndex((p) => p[1] < -19 && Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 20) < 1e-9)
    const sa = screen(cage.positions[a]), sb = screen(cage.positions[b])
    const pick = pickCage({ cage, camera, width: W, height: H, x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 + 3, skin: skinInput })
    expect(pick).toEqual({ kind: 'edge', key: edgeKey(a, b) })
  })

  it('a click on the skin inside a face picks the cage face that skin grew from', () => {
    // centre of the front-lower-left cage face: x in [-20,0], z in [0,20]
    const face = cage.faces.findIndex((f) => f.every((p) => cage.positions[p][1] < -19 && cage.positions[p][0] <= 1e-9 && cage.positions[p][2] <= 20 + 1e-9))
    const s = screen([-9, -20, 11])
    expect(pickCage({ cage, camera, width: W, height: H, x: s.x, y: s.y, skin: skinInput })).toEqual({ kind: 'face', index: face })
  })

  it('an orthographic view (the Model screen can use one) picks the front point, not a face behind it', () => {
    const cam = new THREE.OrthographicCamera(-60, 60, 45, -45, 0.1, 1000)
    cam.up.set(0, 0, 1)
    cam.position.set(80, -120, 110)
    cam.lookAt(0, 0, 20)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    const topCentre = cage.positions.findIndex((p) => p[2] > 39 && Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9)
    const v = new THREE.Vector3(...cage.positions[topCentre]).project(cam)
    const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H
    expect(pickCage({ cage, camera: cam, width: W, height: H, x, y, skin: skinInput })).toEqual({ kind: 'point', index: topCentre })
  })

  it('empty space picks nothing', () => {
    expect(pickCage({ cage, camera, width: W, height: H, x: 5, y: 5, skin: skinInput })).toBeNull()
  })
})

describe('selection', () => {
  it('a plain pick replaces, an additive pick adds and toggles off', () => {
    let s = applyPick({ points: [], edges: [], faces: [] }, { kind: 'point', index: 3 }, false)
    s = applyPick(s, { kind: 'face', index: 2 }, true)
    s = applyPick(s, { kind: 'edge', key: '1:4' }, true)
    expect(s).toEqual({ points: [3], edges: ['1:4'], faces: [2] })
    s = applyPick(s, { kind: 'point', index: 3 }, true)
    expect(s.points).toEqual([])
    expect(applyPick(s, { kind: 'point', index: 9 }, false)).toEqual({ points: [9], edges: [], faces: [] })
    expect(applyPick(s, null, false)).toEqual({ points: [], edges: [], faces: [] })
  })

  it('selection points gather points, edge ends and face corners; stale entries are pruned', () => {
    const cage = planeCage({ segments: { x: 2, y: 2, z: 1 } })
    expect(selectionPoints(cage, { points: [8], edges: [edgeKey(0, 1)], faces: [0] })).toEqual([0, 1, 3, 4, 8])
    expect(pruneSelection(cage, { points: [8, 99], edges: ['0:1', '0:8'], faces: [3, 4] })).toEqual({ points: [8], edges: ['0:1'], faces: [3] })
  })
})

describe('transforms about the selection', () => {
  it('translate, rotate and scale move only the selected points, from their drag-start positions', () => {
    const cage = boxCage({ segments: { x: 1, y: 1, z: 1 } })
    const pts = [0, 1]
    const from = pts.map((p) => cage.positions[p])
    const c = new THREE.Vector3(...centroidOf(cage, pts))
    const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeScale(2, 2, 2))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
    const moved = transformPoints(cage, from, pts, m.elements)
    for (let i = 0; i < cage.positions.length; i++) {
      const expected = pts.includes(i) ? new THREE.Vector3(...cage.positions[i]).applyMatrix4(m) : new THREE.Vector3(...cage.positions[i])
      expect(moved.positions[i][0]).toBeCloseTo(expected.x, 9)
      expect(moved.positions[i][1]).toBeCloseTo(expected.y, 9)
      expect(moved.positions[i][2]).toBeCloseTo(expected.z, 9)
    }
    // the centroid is the fixed point of rotate + scale
    expect(new THREE.Vector3(...centroidOf(moved, pts)).distanceTo(c)).toBeLessThan(1e-9)
  })
})

describe('extrude faces', () => {
  it('one face of a box: closed, valid, one side quad per rim edge, copies ride with the face', () => {
    const cage = boxCage({ segments: { x: 1, y: 1, z: 1 } })
    const top = cage.faces.findIndex((f) => f.every((p) => cage.positions[p][2] > 39))
    const r = extrudeFaces(cage, [top])
    const v = validateCage(r.cage, true)
    expect(v.problems).toEqual([])
    expect(r.cage.faces).toHaveLength(6 + 4)
    expect(r.cage.positions).toHaveLength(8 + 4)
    expect(r.sideFaces).toHaveLength(4)
    expect(r.movedPoints).toEqual([8, 9, 10, 11])
    expect(r.cage.faces[top].every((p) => p >= 8)).toBe(true)
    // pull the copies out along the face normal: the top rises, the rest stays
    const n = facesNormal(cage, [top])
    expect(n[2]).toBeCloseTo(1, 9)
    const from = r.movedPoints.map((p) => r.cage.positions[p])
    const pulled = transformPoints(r.cage, from, r.movedPoints, new THREE.Matrix4().makeTranslation(0, 0, 15).elements)
    expect(validateCage(pulled, true).ok).toBe(true)
    expect(Math.max(...pulled.positions.map((p) => p[2]))).toBeCloseTo(55, 9)
    expect(pulled.positions.slice(0, 8)).toEqual(cage.positions)
  })

  it('a region of faces extrudes as one piece: interior points move, only the rim gets side quads', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const topFaces = cage.faces.map((f, i) => (f.every((p) => cage.positions[p][2] > 39) ? i : -1)).filter((i) => i >= 0)
    expect(topFaces).toHaveLength(4)
    const r = extrudeFaces(cage, topFaces)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.sideFaces).toHaveLength(8) // the top's rim has 8 edges
    const centre = cage.positions.findIndex((p) => p[2] > 39 && Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9)
    expect(r.movedPoints).toContain(centre) // interior point is not copied, it moves
    expect(r.cage.positions).toHaveLength(26 + 8)
  })

  it('an open plane face extrudes too (its open edges get side quads)', () => {
    const cage = planeCage({ segments: { x: 1, y: 1, z: 1 } })
    const r = extrudeFaces(cage, [0])
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.sideFaces).toHaveLength(4)
  })

  it('creases inside the region follow it; creases on the rim stay', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const topFaces = cage.faces.map((f, i) => (f.every((p) => cage.positions[p][2] > 39) ? i : -1)).filter((i) => i >= 0)
    const centre = cage.positions.findIndex((p) => p[2] > 39 && Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9)
    const mid = cage.positions.findIndex((p) => p[2] > 39 && p[0] > 19 && Math.abs(p[1]) < 1e-9)
    const rimA = cage.positions.findIndex((p) => p[2] > 39 && p[0] > 19 && p[1] > 19)
    const withCreases: Cage = { ...cage, creases: [edgeKey(centre, mid), edgeKey(mid, rimA)] }
    const r = extrudeFaces(withCreases, topFaces)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.cage.creases).toContain(edgeKey(mid, rimA))
    expect(r.cage.creases.some((k) => k !== edgeKey(mid, rimA) && k.split(':').map(Number).includes(centre))).toBe(true)
  })
})
