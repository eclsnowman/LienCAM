// @vitest-environment jsdom
//
// R1.1 rework (UI4.audit.json): "Mass properties are not invalidated when
// the live body geometry is replaced by the demo edit/regenerate path" --
// the mass-properties effect's dependency array never included anything
// tracking the body itself, so a regenerate silently kept showing the
// pre-edit mass/CoM forever. Fixed via a `bodyVersion` state bumped from
// CachedBody.version on every paintCachedBody() call (boot AND regenerate).
//
// Drives the real UI4Demo + fakeGeomClient/fakeSceneRuntime harness (same
// stack as UI4DemoAppearanceVisibility.test.tsx) through an actual Regenerate
// click -- fakeGeomClient's measureResultForHandle option simulates the
// kernel reporting a genuinely different volume for the box's SECOND handle
// (handleRegenerate disposes then re-creates under the same bodyId, minting
// a fresh BodyHandle), matching the audit's own worked example numbers
// (8000 mm^3 @ 2.70 g/cm^3 aluminum -> 21.600 g).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { UI4Demo } from '../../components/model3d/demo'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('UI4Demo mass properties after regenerate (R1.1, FAILS-IF stale)', () => {
  it('reports the NEW box volume/mass after Regenerate, not the pre-edit reading', async () => {
    const client = createFakeGeomClient({
      measureResultForHandle: (handle, kind) => {
        if (kind !== 'volume') return undefined
        // handle 1 = initial createBox, handle 2 = regenerate's createBox
        // (disposeBody doesn't mint; createBox always does) -- exact
        // analytic volumes for DEMO_SIZE 40x20x10 and its regenerated
        // 40x20x16 (UI4Demo's handleRegenerate bumps z by +6).
        return { kind: 'volume', value: handle === 1 ? 8000 : 12800 }
      },
    })
    const runtime = createFakeSceneRuntime()
    render(<UI4Demo createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    // al-6061 (BUILTIN_MATERIALS[0], the default materialId), 2.70 g/cm^3:
    // 8000 mm^3 * 2.70 / 1000 = 21.600 g -- matches the audit's own cited
    // pre-regen readout exactly.
    await waitFor(() => expect(screen.getByTestId('mass-value').textContent).toMatch(/21\.600/))

    fireEvent.click(screen.getByTestId('ui4-regenerate'))

    // The stale 21.600 g reading must be GONE -- either a busy affordance or
    // (once settled) the NEW analytic mass: 12800 * 2.70 / 1000 = 34.560 g.
    await waitFor(() => expect(screen.getByTestId('mass-value').textContent).toMatch(/34\.560/))
    expect(screen.getByTestId('mass-value').textContent).not.toMatch(/21\.600/)
  })
})
