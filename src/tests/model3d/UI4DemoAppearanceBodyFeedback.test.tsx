// @vitest-environment jsdom
//
// R1.3 rework (UI4.audit.json): appearance body-mode picks get the SAME
// hover-before-click / selected-after-click viewport feedback measure picks
// already have (Operator's binding Q-1 feedback bar). Same proof pattern as
// UI4DemoHoverSelect.test.tsx (measure tool), but through the Appearance
// tool's body filter -- a whole-body highlight paints EVERY mesh vertex
// (applyBodyHighlight), so any vertex index is a valid probe.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { UI4Demo } from '../../components/model3d/demo'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

const HOVERED = [1.0, 0.75, 0.2]
const SELECTED = [0.15, 0.55, 1.0]
const BASE = [0.8, 0.8, 0.82]

function bodyVertexColor(runtime: ReturnType<typeof createFakeSceneRuntime>, vertex = 0): [number, number, number] {
  const mesh = runtime.addedObjects.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)
  if (mesh === undefined) throw new Error('box mesh not yet added to the fake runtime')
  const colorAttr = mesh.geometry.getAttribute('color')
  return [colorAttr.getX(vertex), colorAttr.getY(vertex), colorAttr.getZ(vertex)]
}

function expectClose(actual: [number, number, number], expected: number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 5)
  expect(actual[1]).toBeCloseTo(expected[1], 5)
  expect(actual[2]).toBeCloseTo(expected[2], 5)
}

describe('UI4Demo appearance tool body-mode hover vs select visual feedback (R1.3, FAILS-IF stale)', () => {
  it('hover paints HOVERED before click; click locks SELECTED; switching filter/tool away restores base', async () => {
    const runtime = createFakeSceneRuntime()
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    fireEvent.click(screen.getByTestId('ui4-tool-appearance'))
    fireEvent.click(screen.getByTestId('appearance-filter-body'))
    expectClose(bodyVertexColor(runtime), BASE)

    // Hover-before-click: the fixed fake ray hits the body; body filter mode
    // resolves every hit to kind 'body' (PickEngine.pickBody).
    fireEvent.pointerMove(screen.getByTestId('ui4-canvas'))
    await waitFor(() => expectClose(bodyVertexColor(runtime), HOVERED))
    expect(bodyVertexColor(runtime)).not.toEqual(BASE)

    // Selected-after-click: a distinct locked style from hover.
    fireEvent.pointerDown(screen.getByTestId('ui4-canvas'))
    await waitFor(() => expect(screen.getByTestId('appearance-target-label').textContent).toMatch(/body: demoBody/))
    expectClose(bodyVertexColor(runtime), SELECTED)
    expect(bodyVertexColor(runtime)).not.toEqual(HOVERED)

    // Switching back to the measure tool must not leave the appearance
    // session's stale "selected" body highlight painted forever -- this is
    // the exact "stale state after change" theme the R1 rework targets:
    // repaint must repaint from whichever tool is ACTUALLY active.
    fireEvent.click(screen.getByTestId('ui4-tool-measure'))
    await waitFor(() => expectClose(bodyVertexColor(runtime), BASE))
  })
})
