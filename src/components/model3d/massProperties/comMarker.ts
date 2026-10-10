// WO UI-4 acceptance #6: renderable center-of-mass marker (screenshot
// evidence requirement). A small sphere + 3 axis-tick lines, distinct from
// the body's own MeshStandardMaterial vertex-colored look (highlight.ts)
// and from the section cap's amber (sceneRuntime.ts) so it never gets
// mistaken for a picked/highlighted face in a screenshot.

import * as THREE from 'three'
import type { Vec3Plain } from './massProperties'

const MARKER_COLOR = 0x33d17a // green -- unused elsewhere in this WO's viewport palette

export function createComMarker(radius: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'com-marker'
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color: MARKER_COLOR, depthTest: false }),
  )
  sphere.renderOrder = 10
  group.add(sphere)

  const axisLength = radius * 4
  const points: number[] = []
  for (const axis of [0, 1, 2] as const) {
    const a: [number, number, number] = [0, 0, 0]
    const b: [number, number, number] = [0, 0, 0]
    a[axis] = -axisLength
    b[axis] = axisLength
    points.push(...a, ...b)
  }
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: MARKER_COLOR, depthTest: false }))
  lines.renderOrder = 10
  group.add(lines)

  return group
}

export function positionComMarker(marker: THREE.Group, com: Vec3Plain): void {
  marker.position.set(com.x, com.y, com.z)
}
