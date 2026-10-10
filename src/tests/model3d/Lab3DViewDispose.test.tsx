// @vitest-environment jsdom
//
// WO UI-2 acceptance #4's dispose count assertions, both sides, against the
// faked client (the real-kernel proof already lives in part 1's
// geomBridgeSession.integration.test.ts -- this is the React layer's proof
// that clicking "dispose" in the body list actually drives
// GeomBridgeSession.disposeBody() through to completion):
//  (a) bridge/cache side -- the body row disappears from the rendered list,
//      proving the React state (and transitively session.cache, since
//      GeometryCache.evict ran inside disposeBody) no longer holds it.
//  (b) worker side -- the fake client's disposedHandles array grew by
//      exactly one entry, matching the handle minted for the demo body's cut
//      result (createCutBox tracks the CUT RESULT handle under bodyId, not
//      the target/tool handles -- see geomBridgeSession.ts).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime, createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Lab3DView dispose (count assertions both sides)', () => {
  it('dispose removes the body from the list AND releases exactly one worker-side handle', async () => {
    const client = createFakeGeomClient()

    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)

    // Wait for the demo body to land in the list (async boot).
    await screen.findByTestId('body-visible-demoBody')
    expect(client.disposedHandles).toEqual([]);

    fireEvent.click(screen.getByTestId('body-dispose-demoBody'))

    // (a) bridge/cache side: the row is gone from the rendered list.
    await waitFor(() => {
      expect(screen.queryByTestId('body-visible-demoBody')).toBeNull()
    })

    // (b) worker side: exactly one dispose() call landed, and it targeted a
    // handle this fake client actually minted (createCutBox mints 3 handles
    // -- target, tool, cut result -- and tracks only the cut result under
    // bodyId "demoBody"; disposeBody releases just that one).
    expect(client.disposedHandles.length).toBe(1)
    expect(typeof client.disposedHandles[0]).toBe('number')
  })

  it('the Object3D mesh/edge pair is detached from the scene runtime on dispose', async () => {
    const client = createFakeGeomClient()
    const runtime = createFakeSceneRuntime()

    render(<Lab3DView createClient={() => client} createSceneRuntime={() => runtime} />)

    await screen.findByTestId('body-visible-demoBody')
    // Progressive tessellation adds the mesh once on first (coarse) paint,
    // then reassigns geometry in place on refine -- addObject should have
    // been called exactly twice total (mesh + edge lines), not once per tier.
    expect(runtime.addedObjects.length).toBe(2)

    fireEvent.click(screen.getByTestId('body-dispose-demoBody'))

    await waitFor(() => {
      expect(runtime.removedObjects.length).toBe(2)
    })
  })
})
