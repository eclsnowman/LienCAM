// WO SKETCH-PLANE-INWORKSPACE (Operator Q-68 item 4): shared test helper for the in-workspace base-plane
// sketch entry that REPLACED the removed SketchPlaneDialog chooser.
//
// Before: "New sketch" opened a modal; a suite selected the XY radio and clicked "Start sketch"
//   (dialog-shell-apply). After: "New sketch" arms an in-workspace plane pick directly, and the
//   operator clicks the XY/XZ/YZ glyph in the viewport. This helper is the one place that knows the
//   new gesture, so the ~11 workbench suites that only need "a package sketch on a base plane" as
//   scaffolding migrate with a single call instead of open-coding the ray+click each.
//
// Requires SolidsWorkbenchPage mounted+ready and a fake scene runtime whose screenToRay honors
// `rayOverride` (createFakeSceneRuntime) -- the same seam SolidsWorkbenchPage.visualPlanePick.test.tsx
// drives the real production pick path through.

import { fireEvent, screen } from '@testing-library/react'
import * as THREE from 'three'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import type { BasePlaneKind } from '../../sketch3d'
import type { RayLike } from '../../viewport3d'

/** A ray straight down a plane's own normal onto a point on it -- unambiguously that plane, derived
 *  from the canonical frame so a new base-plane kind needs no hand-maintained ray table here. */
export function rayForPlane(kind: BasePlaneKind): RayLike {
  const frame = BASE_PLANE_FRAMES[kind]
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  const xDir = new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z).normalize()
  const yDir = normal.clone().cross(xDir).normalize()
  const target = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
    .addScaledVector(xDir, 20)
    .addScaledVector(yDir, 20)
  const origin = target.clone().addScaledVector(normal, 100)
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

/** Minimal runtime shape this helper drives: only the rayOverride seam matters. */
interface RayOverridable {
  rayOverride: RayLike | null
}

/**
 * Arms the New-sketch in-workspace plane pick and clicks the given base plane's glyph, entering an
 * EMPTY package sketch session on it -- the exact end state the removed
 * `New sketch -> XY radio -> Start sketch` dialog flow produced. Two separate fireEvents so React
 * flushes the arm (sketchMode -> 'pick-base-plane') before the canvas click resolves against it.
 */
export function enterBasePlaneSketchViaPick(runtime: RayOverridable, kind: BasePlaneKind = 'xy'): void {
  fireEvent.click(screen.getByTestId('workbench-new-sketch'))
  runtime.rayOverride = rayForPlane(kind)
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}
