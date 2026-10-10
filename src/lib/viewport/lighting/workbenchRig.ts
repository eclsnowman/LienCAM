// GEO-23 L5 / preflight A4-3b: the ONE construction point for the fixed
// modeled-body studio rig shared by CAM and Model.
//
// sceneRuntime.ts builds its hemisphere + key/fill/rim lights by calling
// buildWorkbenchRig(), and the geo22-blind-hole-render-truth.test.ts derives its
// litResponse() lighting model from the SAME builder's output and asserts that
// output matches the rig descriptors (its sync-check). Because the runtime and
// the test both flow through this function, the Node test can never assert
// against a stale rig, and a future edit that made the runtime bypass the shared
// descriptors would move the builder output away from the descriptors and turn
// the test's sync-check red (the A4-3b mutation proof).
//
// This module imports THREE (it constructs light objects), but THREE.Light
// subclasses construct fine in plain Node with no WebGL context, so the Node
// vitest suite imports it without a renderer.

import * as THREE from 'three'
import {
  WORKBENCH_HEMISPHERE,
  WORKBENCH_KEY_COLOR,
  WORKBENCH_FILL_COLOR,
  WORKBENCH_RIM_COLOR,
  WORKBENCH_ACCENT_LIGHTS,
} from './rigDescriptors.ts'

const ACCENT_COLOR: Record<string, number> = {
  key: WORKBENCH_KEY_COLOR,
  fill: WORKBENCH_FILL_COLOR,
  rim: WORKBENCH_RIM_COLOR,
}

export interface WorkbenchRig {
  readonly hemisphere: THREE.HemisphereLight
  /** key, fill, rim in WORKBENCH_ACCENT_LIGHTS order. */
  readonly accents: THREE.DirectionalLight[]
}

/** Construct the workbench hemisphere + directional accent lights from the
 *  shared rig descriptors. Pure object construction (no WebGL); the caller adds
 *  the lights to its scene. */
export function buildWorkbenchRig(): WorkbenchRig {
  const hemisphere = new THREE.HemisphereLight(
    WORKBENCH_HEMISPHERE.sky, WORKBENCH_HEMISPHERE.ground, WORKBENCH_HEMISPHERE.intensity,
  )
  hemisphere.name = 'workbench-cad-hemisphere'
  hemisphere.position.set(0, 0, 1)

  const accents = WORKBENCH_ACCENT_LIGHTS.map((desc) => {
    const light = new THREE.DirectionalLight(ACCENT_COLOR[desc.role], desc.intensity)
    light.name = `workbench-cad-${desc.role}`
    light.position.set(desc.position[0], desc.position[1], desc.position[2])
    return light
  })

  return { hemisphere, accents }
}

/** Preferred name for new callers. The legacy export remains for the existing
 * render-truth harness; both names construct the identical fixed world rig. */
export const buildModeledBodyStudioRig = buildWorkbenchRig
