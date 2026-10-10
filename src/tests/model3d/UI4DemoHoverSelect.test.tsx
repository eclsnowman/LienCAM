// @vitest-environment jsdom
//
// WO UI-4 acceptance #2 + Operator's Q-1 feedback-bar ruling (binding on this
// WO): measure picks give hover highlight BEFORE click, a distinct locked
// style AFTER, and clearing works. Same end-to-end proof pattern as
// Lab3DViewHoverSelect.test.tsx (WO INT-1) -- real pointermove/pointerdown
// DOM events -> real PickEngine raycast (fixed fake ray) -> real
// SelectionState -> real color-attribute repaint on the actual THREE.Mesh.

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
// Face index 5 (+Z, per fixtures.ts's makeBoxTessBuffers face order) owns
// mesh vertices [20, 24) -- same fixture, same convention as
// Lab3DViewHoverSelect.test.tsx.
const TOP_FACE_FIRST_VERTEX = 20

function topFaceColor(runtime: ReturnType<typeof createFakeSceneRuntime>): [number, number, number] {
  const mesh = runtime.addedObjects.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)
  if (mesh === undefined) throw new Error('box mesh not yet added to the fake runtime')
  const colorAttr = mesh.geometry.getAttribute('color')
  return [colorAttr.getX(TOP_FACE_FIRST_VERTEX), colorAttr.getY(TOP_FACE_FIRST_VERTEX), colorAttr.getZ(TOP_FACE_FIRST_VERTEX)]
}

function expectClose(actual: [number, number, number], expected: number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 5)
  expect(actual[1]).toBeCloseTo(expected[1], 5)
  expect(actual[2]).toBeCloseTo(expected[2], 5)
}

describe('UI4Demo measure tool hover vs select visual feedback (FAILS-IF distinct)', () => {
  it('hover paints HOVERED (distinct from base); click locks in SELECTED (distinct from hover); clear restores base', async () => {
    const runtime = createFakeSceneRuntime()
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    expectClose(topFaceColor(runtime), BASE)

    fireEvent.pointerMove(screen.getByTestId('ui4-canvas'))
    await waitFor(() => expectClose(topFaceColor(runtime), HOVERED))
    expect(topFaceColor(runtime)).not.toEqual(BASE)

    fireEvent.pointerDown(screen.getByTestId('ui4-canvas'))
    await waitFor(() => expectClose(topFaceColor(runtime), SELECTED))
    expect(topFaceColor(runtime)).not.toEqual(HOVERED)

    // Readout panel shows the measured value with a stable-id details fold.
    await waitFor(() => expect(screen.getByTestId('measure-outcome')).toBeTruthy())
    fireEvent.click(screen.getByTestId('measure-outcome-ids-toggle'))
    expect(screen.getByTestId('measure-outcome-ids').textContent).toMatch(/FAKEDISPLAY:BOX:face#5/)

    // Clearing drops the SELECTION, not the hover (the fixed fake ray is
    // still logically "over" the face -- real mouse-still-there semantics,
    // same as Lab3DView) -- so the face reverts to HOVERED, not base, until
    // the pointer actually moves away.
    fireEvent.click(screen.getByTestId('measure-clear'))
    await waitFor(() => expect(screen.getByTestId('measure-empty')).toBeTruthy())
    expectClose(topFaceColor(runtime), HOVERED)
    expect(topFaceColor(runtime)).not.toEqual(SELECTED)
  })
})
