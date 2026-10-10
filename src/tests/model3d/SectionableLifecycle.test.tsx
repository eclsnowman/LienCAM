// @vitest-environment jsdom
//
// WO UI-3 BK-25 rider: the fake scene runtime already implements the
// registerSectionable/unregisterSectionable surface (WO UI-H1), but no test
// ever asserted the lifecycle actually fires -- the UI-H1 audit flagged this
// gap. Mirrors Lab3DViewDispose.test.tsx's pattern (same body-add/body-dispose
// drive, same fake client/runtime), but asserts on the section-stencil
// register/unregister call log instead of addObject/removeObject.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Sectionable runtime lifecycle (BK-25)', () => {
  it('registers the body mesh/edge pair on add, and unregisters it on dispose', async () => {
    const client = createFakeGeomClient()
    const runtime = createFakeSceneRuntime()

    render(<Lab3DView createClient={() => client} createSceneRuntime={() => runtime} />)

    await screen.findByTestId('body-visible-demoBody')

    // Progressive tessellation paints coarse-then-display on the SAME
    // Mesh/LineSegments instances (paintBody's existing-object branch), so
    // registerSectionable must fire exactly ONCE for the demo body, not once
    // per tessellation tier -- fails if the register call is dropped
    // entirely OR fires on every repaint.
    expect(runtime.registerSectionableCalls.length).toBe(1)
    const { mesh, edgeLines } = runtime.registerSectionableCalls[0]
    expect(mesh.isMesh).toBe(true)
    expect(edgeLines.isLineSegments).toBe(true)
    expect(runtime.unregisterSectionableCalls.length).toBe(0)

    fireEvent.click(screen.getByTestId('body-dispose-demoBody'))

    await waitFor(() => {
      expect(runtime.unregisterSectionableCalls.length).toBe(1)
    })
    // The SAME mesh/edgeLines instances that were registered must be the
    // ones unregistered -- fails if dispose drops the call or targets stale
    // objects.
    expect(runtime.unregisterSectionableCalls[0].mesh).toBe(mesh)
    expect(runtime.unregisterSectionableCalls[0].edgeLines).toBe(edgeLines)
  })
})
