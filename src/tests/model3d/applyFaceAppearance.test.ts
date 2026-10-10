// WO UI-4 acceptance #5: applyFaceAppearance paints per-face/per-body custom
// colors onto the vertex-color attribute, composing with highlight.ts's
// hover/select precedence rather than overriding it (Operator's Q-1 feedback-bar
// ruling: a colored face must still show hover/select feedback on top).

import * as THREE from 'three'
import { describe, it, expect } from 'vitest'
import { GeometryCache, SelectionState, attachHighlightAttributes, applyFaceHighlights, DEFAULT_HIGHLIGHT_COLORS } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import { AppearanceStore, applyFaceAppearance } from '../../components/model3d/appearance'

function ingestBox() {
  const cache = new GeometryCache()
  const body = cache.ingest('box1', makeBoxTessBuffers({ featureId: 'F1' }))
  attachHighlightAttributes(body, DEFAULT_HIGHLIGHT_COLORS)
  return body
}

function colorAt(body: ReturnType<typeof ingestBox>, vertexIndex: number): [number, number, number] {
  const attr = body.geometry.getAttribute('color')
  return [attr.getX(vertexIndex), attr.getY(vertexIndex), attr.getZ(vertexIndex)]
}

/** Float32Array storage loses a hair of precision vs the JS-number literals
 *  above -- compare per-component with tolerance instead of toEqual. */
function expectColorCloseTo(actual: [number, number, number], expected: readonly [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 5)
  expect(actual[1]).toBeCloseTo(expected[1], 5)
  expect(actual[2]).toBeCloseTo(expected[2], 5)
}

const ZMAX_FACE = 'F1:BOX:face#5'
const ZMIN_FACE = 'F1:BOX:face#4'

describe('applyFaceAppearance', () => {
  it('paints a custom face color onto exactly that face triangles', () => {
    const body = ingestBox()
    const selection = new SelectionState()
    const appearance = new AppearanceStore()
    appearance.setFaceColor(ZMAX_FACE, [1, 0, 0])

    applyFaceAppearance(body, 'box1', selection, appearance)

    const index = body.geometry.getIndex()!
    let paintedFaceVertex = -1
    let otherFaceVertex = -1
    for (let t = 0; t < body.triFace.length; t++) {
      const faceId = body.faceIds[body.triFace[t]]
      const vi = index.getX(t * 3)
      if (faceId === ZMAX_FACE && paintedFaceVertex === -1) paintedFaceVertex = vi
      if (faceId === ZMIN_FACE && otherFaceVertex === -1) otherFaceVertex = vi
    }
    expect(paintedFaceVertex).toBeGreaterThanOrEqual(0)
    expect(otherFaceVertex).toBeGreaterThanOrEqual(0)
    expectColorCloseTo(colorAt(body, paintedFaceVertex), [1, 0, 0])
    expectColorCloseTo(colorAt(body, otherFaceVertex), DEFAULT_HIGHLIGHT_COLORS.base)
  })

  it('falls back to the body color for faces with no per-face override', () => {
    const body = ingestBox()
    const selection = new SelectionState()
    const appearance = new AppearanceStore()
    appearance.setBodyColor('box1', [0, 0, 1])

    applyFaceAppearance(body, 'box1', selection, appearance)

    const index = body.geometry.getIndex()!
    const vi = index.getX(0)
    expectColorCloseTo(colorAt(body, vi), [0, 0, 1])
  })

  it('writes non-primary sRGB appearance colors with CAM material linear semantics', () => {
    const body = ingestBox()
    const selection = new SelectionState()
    const appearance = new AppearanceStore()
    appearance.setBodyColor('box1', [1, 0x88 / 255, 0])

    applyFaceAppearance(body, 'box1', selection, appearance)

    const index = body.geometry.getIndex()!
    const camColor = new THREE.Color('#ff8800')
    const expected: [number, number, number] = [camColor.r, camColor.g, camColor.b]
    expectColorCloseTo(colorAt(body, index.getX(0)), expected)
    expect(colorAt(body, index.getX(0))[1]).not.toBeCloseTo(0x88 / 255, 5)
  })

  it('a hovered/selected face keeps its highlight color, not the custom appearance color', () => {
    const body = ingestBox()
    const selection = new SelectionState()
    const appearance = new AppearanceStore()
    appearance.setFaceColor(ZMAX_FACE, [1, 0, 0])
    selection.select(ZMAX_FACE)

    // Simulate the real repaint order: highlight first, then appearance.
    applyFaceHighlights(body, selection, DEFAULT_HIGHLIGHT_COLORS)
    applyFaceAppearance(body, 'box1', selection, appearance)

    const index = body.geometry.getIndex()!
    let selectedVertex = -1
    for (let t = 0; t < body.triFace.length; t++) {
      if (body.faceIds[body.triFace[t]] === ZMAX_FACE) {
        selectedVertex = index.getX(t * 3)
        break
      }
    }
    expectColorCloseTo(colorAt(body, selectedVertex), DEFAULT_HIGHLIGHT_COLORS.selected)
  })
})
