// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import {
  TOOL_FOLLOW_PREF_KEY,
  TOOL_FOLLOW_RESPONSE_MS,
  advanceToolFollowPoint,
  toggleToolFollowEnabled,
} from '../../components/machine/ProgramPreview'
import { useUiPrefs } from '../../store/uiPrefs'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'

function headlessViewport(programTranslation = new THREE.Vector3()) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
  const target = new THREE.Vector3(3, 4, 5)
  camera.position.set(23, -26, 45)
  const programFrameGroup = new THREE.Group()
  programFrameGroup.position.copy(programTranslation)
  programFrameGroup.updateMatrixWorld(true)

  // CNCViewport explicitly supports method-only Object.create fixtures. The
  // production method needs only these camera/focus collaborators, not WebGL.
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  Object.assign(viewport, {
    camera,
    controls: { target },
    programFrameGroup,
    orbitFocusWorld: new THREE.Vector3(),
    orbitFocusDelta: new THREE.Vector3(),
    orbitFocusActive: false,
  })
  return { viewport, camera, target, programFrameGroup }
}

function expectVector(actual: THREE.Vector3, expected: THREE.Vector3) {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.y).toBeCloseTo(expected.y, 10)
  expect(actual.z).toBeCloseTo(expected.z, 10)
}

beforeEach(() => {
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  localStorage.clear()
})

afterEach(() => {
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  localStorage.clear()
})

describe('WO-1358 tool-follow camera', () => {
  it('centres the cutter in its translated program frame without changing distance or angle', () => {
    const { viewport, camera, target } = headlessViewport(new THREE.Vector3(100, -40, 7))
    const offsetBefore = camera.position.clone().sub(target)
    const distanceBefore = offsetBefore.length()
    const angleBefore = offsetBefore.clone().normalize()

    viewport.setOrbitFocus({ x: 8, y: 9, z: -2 })

    expectVector(target, new THREE.Vector3(108, -31, 5))
    const offsetAfter = camera.position.clone().sub(target)
    expect(offsetAfter.length()).toBeCloseTo(distanceBefore, 10)
    expectVector(offsetAfter.normalize(), angleBefore)
  })

  it('preserves an orbit and treats an explicit pan as a durable follow offset', () => {
    const { viewport, camera, target } = headlessViewport()
    viewport.setOrbitFocus({ x: 0, y: 0, z: 0 })

    // Stand in for OrbitControls after the operator orbits to a new angle.
    const orbitedOffset = new THREE.Vector3(-12, 18, 27)
    camera.position.copy(target).add(orbitedOffset)
    viewport.setOrbitFocus({ x: 10, y: 2, z: 1 })
    expectVector(camera.position.clone().sub(target), orbitedOffset)

    // OrbitControls pans camera and target together. The next cutter delta must
    // carry that nudge forward rather than snapping target back onto the tool.
    const pan = new THREE.Vector3(4, -3, 2)
    target.add(pan)
    camera.position.add(pan)
    viewport.setOrbitFocus({ x: 14, y: 8, z: 5 })
    expectVector(target, new THREE.Vector3(14, 8, 5).add(pan))
    expectVector(camera.position.clone().sub(target), orbitedOffset)
  })

  it('leaves the camera untouched when follow ends and recentres only when re-enabled', () => {
    const { viewport, camera, target } = headlessViewport()
    viewport.setOrbitFocus({ x: 5, y: 6, z: 7 })
    const stoppedCamera = camera.position.clone()
    const stoppedTarget = target.clone()

    viewport.setOrbitFocus(null)
    expectVector(camera.position, stoppedCamera)
    expectVector(target, stoppedTarget)

    viewport.setOrbitFocus({ x: 20, y: 30, z: 40 })
    expectVector(target, new THREE.Vector3(20, 30, 40))
    expectVector(camera.position.clone().sub(target), stoppedCamera.sub(stoppedTarget))
  })

  it('eases status-rate position changes without overshoot and stays frame-rate independent', () => {
    const start = advanceToolFollowPoint(null, { x: 0, y: 0, z: 0 }, 0)
    const oneFrame = advanceToolFollowPoint(start, { x: 100, y: -50, z: 20 }, 16)
    const twoFrames = advanceToolFollowPoint(oneFrame, { x: 100, y: -50, z: 20 }, 16)
    const oneTimeConstant = advanceToolFollowPoint(start, { x: 100, y: -50, z: 20 }, TOOL_FOLLOW_RESPONSE_MS)

    expect(oneFrame.x).toBeGreaterThan(0)
    expect(twoFrames.x).toBeGreaterThan(oneFrame.x)
    expect(twoFrames.x).toBeLessThan(100)
    expect(oneFrame.y).toBeLessThan(0)
    expect(oneFrame.y).toBeGreaterThan(-50)
    expect(oneTimeConstant.x).toBeCloseTo(100 * (1 - Math.exp(-1)), 10)
  })

  it('persists follow mode through the existing UI-preferences reload path', async () => {
    expect(useUiPrefs.getState().collapsedPropsGroups[TOOL_FOLLOW_PREF_KEY]).toBeUndefined()
    toggleToolFollowEnabled()
    expect(useUiPrefs.getState().collapsedPropsGroups[TOOL_FOLLOW_PREF_KEY]).toBe(true)

    const storageKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
    const saved = localStorage.getItem(storageKey)
    expect(saved).not.toBeNull()

    // Simulate a new in-memory store loading the exact persisted record.
    useUiPrefs.setState({ collapsedPropsGroups: {} })
    localStorage.setItem(storageKey, saved!)
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().collapsedPropsGroups[TOOL_FOLLOW_PREF_KEY]).toBe(true)
  })
})
