// @vitest-environment jsdom
//
// WO INT-1 acceptance #4 ("VISUAL SECTION"): the axis + position slider
// control drives SceneRuntime.setClipPlanes() with a real THREE.Plane, and
// switching axis or moving the slider re-applies it. jsdom has no WebGL
// clipping to visually assert against, so this asserts on the fake scene
// runtime's recorded setClipPlanes() calls (the same seam UI-2 established
// for requestRender/addObject/removeObject).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Lab3DView visual section control', () => {
  it('applies a clip plane on mount (fully open) and re-applies on slider move', async () => {
    const runtime = createFakeSceneRuntime()
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')

    await waitFor(() => expect(runtime.clipPlaneCalls.length).toBeGreaterThan(0))
    const initialCallCount = runtime.clipPlaneCalls.length
    const initialPlane = runtime.clipPlaneCalls[initialCallCount - 1][0]
    expect(initialPlane).toBeDefined()

    const slider = screen.getByTestId('lab3d-section-slider') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0' } })

    await waitFor(() => expect(runtime.clipPlaneCalls.length).toBeGreaterThan(initialCallCount))
    const movedPlane = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1][0]
    // Moving the slider changes the plane's constant (WO INT-1: constant ===
    // the slider's world-space position along the selected axis).
    expect(movedPlane.constant).not.toBe(initialPlane.constant)
    expect(movedPlane.constant).toBeCloseTo(0, 6)
  })

  it('switching axis changes the clip plane normal and resets to fully open', async () => {
    const runtime = createFakeSceneRuntime()
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')
    await waitFor(() => expect(runtime.clipPlaneCalls.length).toBeGreaterThan(0))

    fireEvent.click(screen.getByTestId('lab3d-section-axis-x'))

    await waitFor(() => {
      const latest = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1][0]
      expect(latest.normal.x).toBe(-1)
      expect(latest.normal.y).toBe(0)
      expect(latest.normal.z).toBe(0)
    })
  })
})
