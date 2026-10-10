// @vitest-environment jsdom
//
// WO SKC-15C (audit major #1, verbatim): "Acceptance criterion 1 requires both selection and hover
// to show Origin/base-plane viewport feedback, but the glyph effect depends only on selectedId. Row
// hover changes only the tree-row CSS background. The genesis tests exercise click/onSelect only."
//
// This is the render-gate test that finding asked for -- per state, through the REAL tree/scene
// boundary, asserting the VIEWPORT (the fake runtime's added/removed object log), not a CSS
// background. Operator's Q-1 bar: hover = feedback, select = feedback, always. So:
//   - hovering a genesis row draws that row's glyph (PREVIEW), over whatever is selected,
//   - leaving it removes the preview and falls back to the selected glyph (STICKY),
//   - hovering an ordinary feature draws nothing and does not disturb the selected glyph,
//   - every add is matched by a remove on the way out (no per-hover geometry leak -- charter item 5).
//
// The glyph objects carry `userData.genesisNodeId`, so the test asserts WHICH glyph is on screen,
// not merely that "a glyph" is -- a hover-preview that drew the SELECTED glyph would pass a weaker
// test.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import {
  ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_YZ_NODE_ID,
} from '../../doc'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

/** The genesis node id of every EMPHASIS glyph currently in the scene: added minus removed, matched
 *  by the exact object reference the effect added (so a stale object that was removed does not
 *  count).
 *
 *  WO UI-17 (criterion 5): the workbench now ALSO renders an always-on 'ambient' glyph per genesis
 *  node (Operator: "planes X Y Z should be visible in the space while orbiting") -- a separate layer
 *  with its own tests (SolidsWorkbenchPage.ui17.test.tsx AC4). THIS file's subject is unchanged --
 *  the hover/selection EMPHASIS treatment (Q-1) -- so the probe filters to that variant; "at rest,
 *  nothing genesis is drawn" now means "no EMPHASIS glyph at rest". */
function liveGlyphIds(runtime: FakeSceneRuntime): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((o) => !removed.has(o) && o.userData?.genesisVariant !== 'ambient')
    .map((o) => o.userData?.genesisNodeId as string | undefined)
    .filter((id): id is string => typeof id === 'string')
}

function row(id: string): HTMLElement {
  return screen.getByTestId(`feature-row-${id}`)
}

async function boot(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  // The genesis rows are seeded into every fresh document, so they render immediately.
  await waitFor(() => expect(screen.queryByTestId(`feature-row-${ORIGIN_NODE_ID}`)).toBeTruthy())
  return captured as unknown as FakeSceneRuntime
}

describe('SolidsWorkbenchPage: genesis viewport feedback on HOVER as well as selection (WO SKC-15C audit #1)', () => {
  it('at rest, nothing genesis is drawn', async () => {
    const runtime = await boot()
    expect(liveGlyphIds(runtime)).toEqual([])
  })

  it('hovering a base-plane row draws THAT plane glyph; leaving removes it (preview, then gone)', async () => {
    const runtime = await boot()
    fireEvent.mouseEnter(row(BASE_PLANE_XY_NODE_ID))
    // FAILS-IF the glyph effect still depends only on selectedId: hover drew nothing.
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([BASE_PLANE_XY_NODE_ID]))

    fireEvent.mouseLeave(row(BASE_PLANE_XY_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([]))
  })

  it('hovering the Origin row draws the Origin glyph', async () => {
    const runtime = await boot()
    fireEvent.mouseEnter(row(ORIGIN_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([ORIGIN_NODE_ID]))
  })

  it('selection is STICKY, hover is a PREVIEW on top: select XY, hover YZ, leave -> back to XY', async () => {
    const runtime = await boot()
    fireEvent.click(row(BASE_PLANE_XY_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([BASE_PLANE_XY_NODE_ID]))

    // Hover a DIFFERENT genesis row: the preview replaces the selected glyph (never both at once).
    fireEvent.mouseEnter(row(BASE_PLANE_YZ_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([BASE_PLANE_YZ_NODE_ID]))

    // Leave it: the selected XY glyph returns.
    fireEvent.mouseLeave(row(BASE_PLANE_YZ_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([BASE_PLANE_XY_NODE_ID]))
  })

  it('hovering an ORDINARY feature row draws nothing and leaves the selected genesis glyph alone', async () => {
    const runtime = await boot()
    // Build a rectangle sketch node (a non-genesis feature) to hover.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.queryByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(row(ORIGIN_NODE_ID))
    await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([ORIGIN_NODE_ID]))

    // Hover the ordinary sketch row: buildGenesisGlyph returns null for it, so nothing is drawn and
    // the sticky Origin glyph stays.
    fireEvent.mouseEnter(row('SK1'))
    await new Promise((r) => setTimeout(r, 0))
    expect(liveGlyphIds(runtime)).toEqual([ORIGIN_NODE_ID])
    fireEvent.mouseLeave(row('SK1'))
    expect(liveGlyphIds(runtime)).toEqual([ORIGIN_NODE_ID])
  })

  it('CLEANUP: every glyph added over a sweep of hovers is disposed -- adds and removes balance', async () => {
    const runtime = await boot()
    for (const id of [BASE_PLANE_XY_NODE_ID, BASE_PLANE_YZ_NODE_ID, ORIGIN_NODE_ID]) {
      fireEvent.mouseEnter(row(id))
      await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([id]))
      fireEvent.mouseLeave(row(id))
      await waitFor(() => expect(liveGlyphIds(runtime)).toEqual([]))
    }
    // Every EMPHASIS genesis object added was also removed -- no per-hover geometry leaked into the
    // scene. (The UI-17 always-on 'ambient' layer legitimately stays live for the page's lifetime;
    // its own add/remove balance is the ui17 planes test's subject.)
    const addedGenesis = runtime.addedObjects.filter((o) => typeof o.userData?.genesisNodeId === 'string' && o.userData?.genesisVariant !== 'ambient')
    const removedGenesis = runtime.removedObjects.filter((o) => typeof o.userData?.genesisNodeId === 'string' && o.userData?.genesisVariant !== 'ambient')
    expect(removedGenesis.length).toBe(addedGenesis.length)
    expect(addedGenesis.length).toBeGreaterThanOrEqual(3)
  })
})
