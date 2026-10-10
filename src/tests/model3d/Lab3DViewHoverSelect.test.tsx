// @vitest-environment jsdom
//
// WO INT-1 acceptance #5 (Operator's standing UX requirement, binding ruling 2):
// "hovering any pickable thing gives visible feedback, selecting gives
// DISTINCT visible feedback... FAILS-IF: removing the hover style must fail
// the test." Lower-level proof that applyFaceHighlights/applyEdgeHighlights
// paint distinct hover/selected colors already exists
// (src/tests/viewport3d/highlight.test.ts, WO UI-2) -- this test proves the
// SAME thing end to end through the real Lab3DView component: real
// pointermove/pointerdown DOM events -> real PickEngine raycast (via the
// fixed fake ray) -> real SelectionState -> real color-attribute repaint on
// the actual THREE.Mesh added to the scene.
//
// FIXED_RAY (fakeSceneRuntime.ts) always resolves to the SAME face
// (the demo fixture box's top/+Z face, faceIndex 5) regardless of pointer
// position in this jsdom setup (no real screen geometry) -- so this proves
// hover-then-select distinctness on one id over TIME, which is exactly what
// the FAILS-IF guard needs: delete either color-application call and one of
// the two assertions below breaks.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import type { RayLike } from '../../viewport3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

const HOVERED: [number, number, number] = [1.0, 0.75, 0.2]
const SELECTED: [number, number, number] = [0.15, 0.55, 1.0]
const BASE = [0.8, 0.8, 0.82]
// Face index 5 (+Z, per fixtures.ts's makeBoxTessBuffers face order) owns
// mesh vertices [20, 24) -- 4 unique vertices per face, per-face-unique
// (highlight.test.ts's own convention, confirmed against fixtures.ts).
const TOP_FACE_FIRST_VERTEX = 20

function topFaceColor(runtime: ReturnType<typeof createFakeSceneRuntime>): [number, number, number] {
  const mesh = runtime.addedObjects[0] as THREE.Mesh
  const colorAttr = mesh.geometry.getAttribute('color')
  return [colorAttr.getX(TOP_FACE_FIRST_VERTEX), colorAttr.getY(TOP_FACE_FIRST_VERTEX), colorAttr.getZ(TOP_FACE_FIRST_VERTEX)]
}

function expectClose(actual: [number, number, number], expected: number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 5)
  expect(actual[1]).toBeCloseTo(expected[1], 5)
  expect(actual[2]).toBeCloseTo(expected[2], 5)
}

describe('Lab3DView hover vs select visual feedback (FAILS-IF distinct)', () => {
  it('hover paints the HOVERED color; base beforehand', async () => {
    const runtime = createFakeSceneRuntime()
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')
    fireEvent.click(screen.getByTestId('lab3d-filter-face'))

    expectClose(topFaceColor(runtime), BASE)

    fireEvent.pointerMove(screen.getByTestId('lab3d-canvas'))

    await waitFor(() => expectClose(topFaceColor(runtime), HOVERED))
    // Explicit FAILS-IF: the hovered color must NOT equal base -- if the
    // hover-paint call is ever removed, this line is what catches it.
    expect(topFaceColor(runtime)).not.toEqual(BASE)
  })

  it('select paints the SELECTED color, DISTINCT from hover, even while still hovered', async () => {
    const runtime = createFakeSceneRuntime()
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')
    fireEvent.click(screen.getByTestId('lab3d-filter-face'))

    const canvas = screen.getByTestId('lab3d-canvas')
    fireEvent.pointerMove(canvas)
    await waitFor(() => expectClose(topFaceColor(runtime), HOVERED))

    fireEvent.pointerDown(canvas) // same fixed ray -> same face id, now also selected

    await waitFor(() => expectClose(topFaceColor(runtime), SELECTED))
    // FAILS-IF: selected must render DISTINCTLY from hovered (selection
    // precedence beats hover per SelectionState.highlightFor) -- if selection
    // painting were ever removed/broken, this face would still read as
    // HOVERED and this assertion would fail.
    const selectedColor = topFaceColor(runtime)
    expect(selectedColor).not.toEqual(HOVERED)
    expect(selectedColor).not.toEqual(BASE)
  })
})

// WO INT-1-R1.1 (rework of the M1-gate blocker): the suite above only ever
// proved the FACE kind. Audit verbatim: "Body hover clears hover state and
// body select only measures volume; vertex hover paints adjacent edges but
// vertex select has no branch at all. The new FAILS-IF test exercises one
// face id only." This block iterates ALL FOUR pickable kinds against the
// SAME fixed ray (via each kind's own filter-mode button) and asserts, per
// kind: hover-visual != none, select-visual != none. `hasColor` scans BOTH
// the body mesh's and its edge-lines' color attributes rather than a single
// known vertex index, because body/edge/vertex highlights land in different
// places than face highlights (whole-mesh tint for body, edge-segment
// colors for edge/vertex) -- this keeps one assertion shape usable for every
// kind without hard-coding internal mesh layout per kind.
function hasColor(attr: THREE.BufferAttribute, color: readonly [number, number, number]): boolean {
  for (let i = 0; i < attr.count; i++) {
    if (
      Math.abs(attr.getX(i) - color[0]) < 1e-4 &&
      Math.abs(attr.getY(i) - color[1]) < 1e-4 &&
      Math.abs(attr.getZ(i) - color[2]) < 1e-4
    ) {
      return true
    }
  }
  return false
}

// FIXED_RAY (fakeSceneRuntime.ts) is aimed at the demo box's top face
// CENTER -- fine for body/face (any hit anywhere on the body/face resolves),
// but edge/vertex picks are threshold-proximity tests (PickEngine.ts) that a
// face-center ray is far too distant from any edge/vertex to trigger. The
// demo box here is the FAKE fixture's default 40x20x10 box centered at the
// origin (fakeGeomClient.tessellate ignores featureId/size and always
// returns makeBoxTessBuffers()'s default), so its top face (z=5) perimeter
// runs along x=+-20/y=+-10 -- these rays are aimed at that face's +X edge
// midpoint and its (+X,+Y) corner, straight down from above, same shape as
// the FIXED_RAY.
const RAY_BY_MODE: Record<'body' | 'face' | 'edge' | 'vertex', RayLike | null> = {
  body: null,
  face: null,
  edge: { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
  vertex: { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
}

function colorPresent(runtime: ReturnType<typeof createFakeSceneRuntime>, color: readonly [number, number, number]): boolean {
  const mesh = runtime.addedObjects[0] as THREE.Mesh
  const edgeLines = runtime.addedObjects[1] as THREE.LineSegments
  return (
    hasColor(mesh.geometry.getAttribute('color') as THREE.BufferAttribute, color) ||
    hasColor(edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute, color)
  )
}

describe.each(['body', 'face', 'edge', 'vertex'] as const)(
  'Lab3DView hover vs select visual feedback for every pickable kind (WO INT-1-R1.1): %s',
  (mode) => {
    it(`hover shows a visible ${mode} highlight (hover-visual != none)`, async () => {
      const runtime = createFakeSceneRuntime()
      runtime.rayOverride = RAY_BY_MODE[mode]
      render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
      await screen.findByTestId('body-visible-demoBody')
      fireEvent.click(screen.getByTestId(`lab3d-filter-${mode}`))

      expect(colorPresent(runtime, HOVERED)).toBe(false)

      fireEvent.pointerMove(screen.getByTestId('lab3d-canvas'))

      // FAILS-IF: removing this kind's hover styling leaves this false
      // forever (demonstrated once for 'body' during R1 -- see
      // INT-1-R1.report.json for the record of that run).
      await waitFor(() => expect(colorPresent(runtime, HOVERED)).toBe(true))
    })

    it(`select shows a visible ${mode} highlight, distinct from hover (select-visual != none, != hover-visual)`, async () => {
      const runtime = createFakeSceneRuntime()
      runtime.rayOverride = RAY_BY_MODE[mode]
      render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
      await screen.findByTestId('body-visible-demoBody')
      fireEvent.click(screen.getByTestId(`lab3d-filter-${mode}`))

      const canvas = screen.getByTestId('lab3d-canvas')
      fireEvent.pointerMove(canvas)
      await waitFor(() => expect(colorPresent(runtime, HOVERED)).toBe(true))

      fireEvent.pointerDown(canvas)

      // FAILS-IF: removing this kind's select styling leaves this false
      // forever, even though hover (a DIFFERENT color) is already showing.
      await waitFor(() => expect(colorPresent(runtime, SELECTED)).toBe(true))
    })
  },
)
