// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { imageToPlane, planeToImage, imageContainsPoint } from '../../referenceImage/place'
import { calibrateReferenceImage } from '../../referenceImage/calibrate'
import type { ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { buildReferenceImage, disposeReferenceImage } from '../../components/model3d/referenceImage/referenceImageScene'
import { localToWorld, type PlaneFrame } from '../../sketch3d/planeMath'

const picture: ReferenceImagePayload = { datumType: 'reference-image', name: 'ruler', planeNodeId: 'xy', image: { dataUrl: '', fileName: 'ruler.png', widthPx: 1000, heightPx: 500 }, widthMm: 500, heightMm: 250, opacity: 0.8, scaleLocked: true }
describe('WO-2304 plane-local picture placement', () => {
  it.each([0, 30, -90, 450])('applies angle %s and both flips to real quad vertices on an inclined plane without changing scale', (angleDeg) => {
    const frame: PlaneFrame = { origin: { x: 20, y: -10, z: 30 }, normal: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 }, xDir: { x: 1, y: 0, z: 0 } }
    for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
      const payload = { ...picture, center: { x: 40, y: -15 }, angleDeg, flipHorizontal, flipVertical }
      const root = buildReferenceImage('image', payload, frame, document.createElement('img'))
      const mesh = root.children[0] as THREE.Mesh<THREE.PlaneGeometry>
      mesh.updateWorldMatrix(true, false)
      const marks = [{ x: -200, y: 0 }, { x: 50, y: 0 }]
      const world = marks.map((p) => new THREE.Vector3(p.x, p.y, 0).applyMatrix4(mesh.matrixWorld))
      expect(world[0].distanceTo(world[1])).toBeCloseTo(250, 9)
      for (const [i, mark] of marks.entries()) {
        const mapped = imageToPlane(payload, mark), expected = localToWorld(frame, mapped)
        expect(world[i].distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z))).toBeLessThan(1e-9)
        const inverse = planeToImage(payload, mapped)
        expect(inverse.x).toBeCloseTo(mark.x, 9); expect(inverse.y).toBeCloseTo(mark.y, 9)
        expect(imageContainsPoint(payload, mapped)).toBe(true)
      }
      expect(imageContainsPoint(payload, imageToPlane(payload, { x: 251, y: 0 }))).toBe(false)
      const center = new THREE.Vector3().applyMatrix4(mesh.matrixWorld), expected = localToWorld(frame, payload.center)
      expect(center.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z))).toBeLessThan(1e-9)
      expect(mesh.geometry.parameters).toMatchObject({ width: 500, height: 250 })
      expect(calibrateReferenceImage(payload, imageToPlane(payload, marks[0]), imageToPlane(payload, marks[1]), 125)).toBe(payload)
      disposeReferenceImage(root)
    }
  })
  it('uses the plane origin and unturned, unflipped pose for older payloads', () => {
    expect(imageToPlane(picture, { x: -20, y: 10 })).toEqual({ x: -20, y: 10 })
    expect(planeToImage(picture, { x: -20, y: 10 })).toEqual({ x: -20, y: 10 })
  })
  it('recalibrates a turned and mirrored picture about the first mark', () => {
    const payload = { ...picture, scaleLocked: false, center: { x: 40, y: -15 }, angleDeg: 30, flipHorizontal: true, flipVertical: true }
    const first = { x: -200, y: 40 }, second = { x: 50, y: 40 }
    const anchor = imageToPlane(payload, first)
    const calibrated = calibrateReferenceImage(payload, anchor, imageToPlane(payload, second), 100)
    const nextFirst = imageToPlane(calibrated, { x: first.x * 0.4, y: first.y * 0.4 })
    expect(Math.hypot(nextFirst.x - anchor.x, nextFirst.y - anchor.y)).toBeLessThan(1e-9)
    expect(calibrated).toMatchObject({ angleDeg: 30, flipHorizontal: true, flipVertical: true })
  })
})
