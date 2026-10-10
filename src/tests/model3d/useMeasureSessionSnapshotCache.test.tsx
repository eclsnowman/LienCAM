// @vitest-environment jsdom
//
// R1.5 rework (UI4.audit.json): useMeasureSession's snapshotCacheRef was
// keyed by bodyId alone, so a body regenerated under the SAME bodyId (the
// only regen path this app has, see UI4Demo's handleRegenerate doc comment)
// kept serving the pre-regen snapshot map forever. Fixed by keying on
// (bodyId, body.version) -- CachedBody.version is bumped on EVERY ingest of
// that bodyId (GeometryCache.ingest() doc comment), including a same-id
// regenerate, so it's the right invalidation signal without needing a
// separate cache-busting call.
//
// Drives the real GeomBridgeSession + PickEngine + GeometryCache against
// fakeGeomClient's box fixture (same stack UI4Demo itself uses) -- no DOM
// rendering needed, so this proves the hook-level fix directly rather than
// through a full component render.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { GeomBridgeSession, type CachedBody } from '../../viewport3d'
import { useMeasureSession, type SnapshotSource } from '../../components/model3d/measure'
import { createFakeGeomClient } from './fakeGeomClient'

afterEach(cleanup)

const RAY = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } } // hits the box's +Z face

describe('useMeasureSession snapshot cache', () => {
  it('re-fetches snapshots after the body regenerates under the same bodyId (new CachedBody.version)', async () => {
    const session = new GeomBridgeSession(createFakeGeomClient())
    await session.init()
    await session.createBox('box1', { featureId: 'F1', size: { x: 40, y: 20, z: 10 } })
    await session.tessellateProgressive('box1')

    // Return value's CONTENT is irrelevant to this test -- only whether/how
    // often snapshotsFor is called, and which CachedBody.version it was
    // called with, matters.
    const snapshotsFor = vi.fn(async (_bodyId: string, _body: CachedBody) => ({}))
    const snapshotSource: SnapshotSource = { snapshotsFor }

    const { result } = renderHook(() =>
      useMeasureSession({ session, snapshotSource, liveBodyIds: () => ['box1'], filterMode: 'face' }),
    )

    act(() => result.current.handlePointerClick(RAY))
    await waitFor(() => expect(snapshotsFor).toHaveBeenCalledTimes(1))
    const firstVersion = snapshotsFor.mock.calls[0][1].version

    // Same "clear -> pick again" round-trip a real second click would take;
    // proves the cache is consulted (not re-fetched) for an UNCHANGED body.
    act(() => result.current.handlePointerClick(RAY))
    await waitFor(() => expect(snapshotsFor).toHaveBeenCalledTimes(1))

    // Regenerate: dispose + re-create under the SAME bodyId (handleRegenerate's
    // exact pattern) -- GeometryCache.ingest() bumps version even across an
    // evict, so the new CachedBody's version strictly exceeds firstVersion.
    await session.disposeBody('box1')
    await session.createBox('box1', { featureId: 'F1', size: { x: 40, y: 20, z: 16 } })
    await session.tessellateProgressive('box1')

    act(() => result.current.handlePointerClick(RAY))
    await waitFor(() => expect(snapshotsFor).toHaveBeenCalledTimes(2))
    const secondVersion = snapshotsFor.mock.calls[1][1].version
    expect(secondVersion).toBeGreaterThan(firstVersion)
  })
})
