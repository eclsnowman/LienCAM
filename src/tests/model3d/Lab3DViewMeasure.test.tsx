// @vitest-environment jsdom
//
// WO INT-1 acceptance #3 ("MEASURE EXACTLY"): selecting a body shows its
// exact kernel-measured volume in the measure panel. Edge length is proven
// against the real kernel in geomBridgeSessionMeasureImport.integration.test.ts
// -- the fixed fake ray this suite uses only ever lands on the demo box's top
// FACE, not an edge (see fakeSceneRuntime.ts's FIXED_RAY), so edge coverage
// at the React layer isn't attempted here.
//
// WO INT-1-R1.2 (rework of a MAJOR audit finding): selecting a face used to
// settle on a mesh-derived approximation forever. It now shows that mesh
// value INSTANTLY as a labeled-approximate preview, then replaces it with
// the frozen facade's own measure('area', [faceId]) once that resolves --
// see Lab3DViewMeasureRealKernel.integration.test.tsx for the same proof
// against the REAL occt-wasm kernel (not this file's fake).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { RayLike } from '../../viewport3d'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime, createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Lab3DView measure panel', () => {
  it('shows "(nothing selected)" before any pick', async () => {
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await screen.findByTestId('body-visible-demoBody')
    expect(screen.getByTestId('lab3d-measure-panel').textContent).toBe('(nothing selected)')
  })

  it('clicking a body (body filter mode) shows its exact kernel-measured volume', async () => {
    const client = createFakeGeomClient({ measureResult: { kind: 'volume', value: 6800 } })
    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await screen.findByTestId('body-visible-demoBody')

    // Default filterMode is already 'body'.
    fireEvent.pointerDown(screen.getByTestId('lab3d-canvas'))

    await waitFor(() => {
      expect(screen.getByTestId('lab3d-measure-panel').textContent).toBe('Body volume: 6800.000 mm^3')
    })
    // BodyListPanel's own volume fetch (acceptance #3's "body panel shows
    // exact volume") also calls measure('volume') once on body creation, so
    // this is >= 1, not necessarily exactly 1.
    expect(client.measureCalls.length).toBeGreaterThanOrEqual(1)
    expect(client.measureCalls.every((c) => c.kind === 'volume')).toBe(true)
  })

  it('clicking a face shows the mesh preview INSTANTLY, then the kernel-exact value, honestly labeled', async () => {
    // A DIFFERENT number from the mesh-derived 800 (the top face's own exact
    // area) proves the settled value came from the kernel call, not the
    // preview -- a mesh-approximation regression would leave this at 800
    // forever and fail the second assertion below.
    const client = createFakeGeomClient({ measureResult: { kind: 'area', value: 812.5 } })
    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await screen.findByTestId('body-visible-demoBody')

    fireEvent.click(screen.getByTestId('lab3d-filter-face'))
    fireEvent.pointerDown(screen.getByTestId('lab3d-canvas'))

    // Instant preview: mesh-derived (FIXED_RAY hits the demo fixture's top
    // (+Z) face straight on -- default makeBoxTessBuffers() size is
    // 40x20x10, so the top face's exact area is 40*20=800), honestly
    // labeled approximate.
    expect(screen.getByTestId('lab3d-measure-panel').textContent).toMatch(
      /^Face area: 800\.000 mm\^2 \(mesh-derived/,
    )

    // FAILS-IF: a mesh-approximation regression never calls measure('area',
    // ids) at all, so this waitFor would time out (the panel would stay at
    // the preview above forever).
    await waitFor(() => {
      // Settled label: id-scoped FACE area straight from the kernel (BK-20
      // landed via GEO-3). The fixture value (812.5) deliberately differs
      // from the mesh preview (800) so this assertion still proves the
      // settled number came from the kernel call, not the preview.
      expect(screen.getByTestId('lab3d-measure-panel').textContent).toBe('Face area: 812.500 mm^2')
    })
    expect(client.measureCalls.some((c) => c.kind === 'area')).toBe(true)
  })

  it('deselecting a face clears the measure panel', async () => {
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await screen.findByTestId('body-visible-demoBody')

    fireEvent.click(screen.getByTestId('lab3d-filter-face'))
    const canvas = screen.getByTestId('lab3d-canvas')
    fireEvent.pointerDown(canvas)
    await waitFor(() => expect(screen.getByTestId('lab3d-measure-panel').textContent).not.toBe('(nothing selected)'))

    fireEvent.pointerDown(canvas) // toggles the same face off (fixed ray -> same id)
    await waitFor(() => expect(screen.getByTestId('lab3d-measure-panel').textContent).toBe('(nothing selected)'))
  })
})

// GEO-16 Fold 2 (auditor finding 5): a can-fail RENDER test that the edge-length
// measure display treats the worker's collision sentinel as a REFUSAL naming the
// requested id -- never 'NaN mm'. The worker refuses an unresolvable edge-length
// pick structurally: value NaN + aux.edgeIdCollisionCount >= 1 (the fail-closed
// backstop for a residual grammar collision). Reading the code path is not a gate;
// this drives a real edge pick through the fake facade and asserts the RENDERED
// panel text. RAY_BY_MODE.edge is aimed at the demo box's +X top-face edge
// midpoint (same construction as Lab3DViewHoverSelect.test.tsx's edge case).
const EDGE_RAY: RayLike = { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }

describe('Lab3DView edge-length refusal rendering (GEO-16 Fold 2, no "NaN mm")', () => {
  it('a collision sentinel {value:NaN, aux:{edgeIdCollisionCount:1}} renders a FAILED refusal that NAMES the picked id and never shows "NaN mm"', async () => {
    // Scope the sentinel to the edge-length call only: the demo body's own
    // volume fetch on mount also calls measure(), and must not be poisoned.
    const client = createFakeGeomClient({
      measureResultForHandle: (_h, kind) =>
        kind === 'length' ? { kind: 'length', value: NaN, aux: { edgeIdCollisionCount: 1 } } : undefined,
    })
    const runtime = createFakeSceneRuntime()
    runtime.rayOverride = EDGE_RAY
    render(<Lab3DView createClient={() => client} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')

    fireEvent.click(screen.getByTestId('lab3d-filter-edge'))
    fireEvent.pointerDown(screen.getByTestId('lab3d-canvas'))

    // The exact id the pick requested (derived from the measure call, not
    // hard-coded) -- the rendered refusal must NAME it.
    await waitFor(() => expect(client.measureCalls.some((c) => c.kind === 'length')).toBe(true))
    const lenCall = client.measureCalls.find((c) => c.kind === 'length')!
    const pickedId = lenCall.ids?.[0]
    expect(pickedId).toBeDefined()

    await waitFor(() => {
      const text = screen.getByTestId('lab3d-measure-panel').textContent ?? ''
      expect(text).toContain('FAILED')
      expect(text).toContain(pickedId!) // the refusal names the requested id
      expect(text).toContain('ambiguous') // and states WHY (collision refusal)
    })
    const finalText = screen.getByTestId('lab3d-measure-panel').textContent ?? ''
    // The load-bearing negative: a NaN value must NEVER reach value.toFixed().
    expect(finalText).not.toContain('NaN mm')
    expect(finalText).not.toContain('NaN')
  })
})
