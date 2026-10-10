// @vitest-environment jsdom
//
// WO UI-17, real occt-wasm kernel half:
//
//   AC8 (BK-93 fold): the bodies-panel volume LABEL refreshes on the
//       paramTable-driven regen path. The body itself always regenerated
//       (ui13b proves the kernel volume changes); the DEFECT was display-only
//       -- handleParamChanged bumped versions but never re-measured, so the
//       label kept the stale number. This asserts the LABEL, not the kernel.
//   AC5 (display mode): shaded/translucent use native depth-tested topology;
//       Unshaded swaps to a fat screen-space overlay, then shaded swaps back.
//       Every replacement preserves the exact topology endpoints.
//
// Fixture + mount pattern verbatim from SolidsWorkbenchPage.ui13b.test.tsx
// (box 40x20 extrude len=20 -> volume 16000; len=30 -> 24000).

import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO-270: the Classic pin that used to sit here is gone with the Viewport
// theme setting. It never mattered to these assertions anyway -- display
// semantics, not theme, choose the edge technique.

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function commitTextField(testId: string, raw: string): void {
  const el = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.change(el, { target: { value: raw } })
  fireEvent.blur(el)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
}

describe('WO UI-17 kernel half: BK-93 volume label + display mode (real occt-wasm)', () => {
  it('BK-93: the bodies-panel volume label refreshes when a parameter edit regenerates the extrude', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    commitTextField('param-new-name', 'len')
    commitTextField('param-new-expression', '20')
    fireEvent.click(screen.getByTestId('param-add'))
    await waitFor(() => expect(screen.getByTestId('param-value-len').textContent).toMatch(/20\.0000/))

    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitTextField('extrude-distance-expression', 'len')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // The label settles on the initial exact volume (16000 mm^3).
    await waitFor(() => expect(screen.getByTestId('body-volume-F1').textContent).toMatch(/16000\.00/), { timeout: 20_000 })

    // Drive the paramTable regen path -- NOT a dialog Apply.
    commitTextField('param-expression-len', '30')

    // FAILS-IF handleParamChanged does not re-measure: the body regenerates
    // to 24000 mm^3 but the LABEL keeps saying 16000.00 forever.
    await waitFor(() => expect(screen.getByTestId('body-volume-F1').textContent).toMatch(/24000\.00/), { timeout: 20_000 })
  }, 60_000)

  it('UI-84: display modes replace native and fat topology without changing endpoints or visibility', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // The rendered body mesh + its edge overlay, straight off the fake scene.
    // WO-035: match F1's OWN tagged mesh -- the extrude dialog's live preview
    // adds (and later removes) a ghost mesh first, so "first vertex-colored
    // mesh ever added" would resolve to the disposed ghost, not the body.
    const bodyMesh = (): THREE.Mesh => {
      const mesh = runtime.addedObjects.find(
        (o): o is THREE.Mesh =>
          (o as THREE.Mesh).isMesh === true &&
          o.userData.workbenchFeatureId === 'F1' &&
          ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).vertexColors === true,
      )
      if (mesh === undefined) throw new Error('no body mesh in the scene')
      return mesh
    }
    const edgeLines = (): THREE.LineSegments | LineSegments2 => {
      const lines = runtime.scene.children.find(
        (o): o is THREE.LineSegments | LineSegments2 =>
          o.userData.workbenchFeatureId === 'F1' &&
          ((o as THREE.LineSegments).isLineSegments === true ||
            (o as LineSegments2 & { isLineSegments2?: boolean }).isLineSegments2 === true),
      )
      if (lines === undefined) throw new Error('no edge overlay in the scene')
      return lines
    }
    const edgePositions = (): number[] => {
      const lines = edgeLines()
      if (lines instanceof THREE.LineSegments) {
        return Array.from(
          lines.geometry.getAttribute('position').array as ArrayLike<number>,
        )
      }
      const geometry = lines.geometry as LineSegmentsGeometry
      const starts = geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
      const ends = geometry.getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute
      const points: number[] = []
      for (let i = 0; i < starts.count; i += 1) {
        points.push(
          starts.getX(i), starts.getY(i), starts.getZ(i),
          ends.getX(i), ends.getY(i), ends.getZ(i),
        )
      }
      return points
    }
    await waitFor(() => expect(bodyMesh()).toBeTruthy(), { timeout: 20_000 })

    const material = bodyMesh().material as THREE.MeshStandardMaterial
    expect(material.wireframe).toBe(false) // default shaded-edges = baseline no-op
    expect(edgeLines()).toBeInstanceOf(THREE.LineSegments)
    expect(edgeLines()).not.toBeInstanceOf(LineSegments2)
    expect(edgeLines().visible).toBe(true)
    const shadedLines = edgeLines()
    const shadedPositions = edgePositions()

    // Translucent stays on the same native depth-tested topology object.
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    fireEvent.click(screen.getByTestId('workbench-shading-translucent'))
    await waitFor(() => expect(material.opacity).toBeLessThan(1))
    const translucentLines = edgeLines()
    const translucentPositions = edgePositions()
    expect(translucentLines).toBe(shadedLines)
    expect(translucentLines).toBeInstanceOf(THREE.LineSegments)
    expect(translucentPositions).toEqual(shadedPositions)
    expect(translucentLines.visible).toBe(true)

    // Unshaded crosses the technique boundary and replaces native lines with
    // one fat screen-space overlay while retaining the topology endpoints.
    fireEvent.click(screen.getByTestId('workbench-shading-unshaded'))
    await waitFor(() => expect(material.opacity).toBe(0))
    await waitFor(() => expect(edgeLines()).toBeInstanceOf(LineSegments2))
    expect(bodyMesh().visible).toBe(true)
    expect(material.wireframe).toBe(false)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    const unshadedLines = edgeLines()
    expect(unshadedLines).not.toBe(translucentLines)
    expect(edgeLines().visible).toBe(true)
    expect(runtime.setSectionableVisibleCalls.at(-1)).toEqual({
      mesh: bodyMesh(), visible: true,
    })

    const unshadedPositions = edgePositions()
    expect(unshadedPositions).toEqual(translucentPositions)
    expect(unshadedPositions).toHaveLength(12 * 2 * 3)
    for (let i = 0; i < unshadedPositions.length; i += 6) {
      const varyingAxes = [0, 1, 2].filter(
        (axis) => Math.abs(unshadedPositions[i + axis] - unshadedPositions[i + 3 + axis]) > 1e-6,
      )
      // A box topology edge varies on one axis. A tessellation diagonal varies
      // on two axes, so this assertion explicitly refuses face diagonals.
      expect(varyingAxes).toHaveLength(1)
    }

    // Back to shaded replaces the fat overlay with fresh native lines.
    fireEvent.click(screen.getByTestId('workbench-shading-shaded-edges'))
    await waitFor(() => expect((bodyMesh().material as THREE.MeshStandardMaterial).wireframe).toBe(false))
    await waitFor(() => {
      expect(edgeLines()).toBeInstanceOf(THREE.LineSegments)
      expect(edgeLines()).not.toBeInstanceOf(LineSegments2)
    })
    expect(material.transparent).toBe(false)
    expect(material.opacity).toBe(1)
    expect(material.depthWrite).toBe(true)
    expect(edgeLines()).not.toBe(unshadedLines)
    expect(edgeLines()).not.toBe(shadedLines)
    expect(edgePositions()).toEqual(shadedPositions)
    expect(edgeLines().visible).toBe(true)
    expect(runtime.setSectionableVisibleCalls.at(-1)).toEqual({
      mesh: bodyMesh(), visible: true,
    })
  }, 60_000)
})
