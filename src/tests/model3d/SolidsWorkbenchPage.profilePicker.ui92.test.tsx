// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import type { ExtrudeRequest } from '../../geom/geom-service'
import type { SketchEntity as CamSketchEntity } from '../../lib/sketch/sketcher'

afterEach(cleanup)

// WO-123: this single scenario intentionally covers create, edit, replay,
// revolve, and undo. Loaded slice runs measured it crossing Vitest's 5s
// default, so give only this long integration scenario scheduler headroom.
const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function pickXzProfile(runtime: ReturnType<typeof createFakeSceneRuntime>, sketchId: string, x = 20): void {
  runtime.rayOverride = { origin: { x, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }
  const canvas = screen.getByTestId('solids-workbench-canvas')
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
  expect(screen.getByTestId('workbench-profile-hover-readout').textContent).toContain(sketchId)
  fireEvent.click(canvas, { clientX: 400, clientY: 300 })
}

function pickXyProfile(runtime: ReturnType<typeof createFakeSceneRuntime>, sketchId: string, x = 20): void {
  runtime.rayOverride = { origin: { x, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  const canvas = screen.getByTestId('solids-workbench-canvas')
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
  expect(screen.getByTestId('workbench-profile-hover-readout').textContent).toContain(sketchId)
  fireEvent.click(canvas, { clientX: 400, clientY: 300 })
}

function chosenRegionOverlayCount(runtime: ReturnType<typeof createFakeSceneRuntime>): number {
  return runtime.scene.children.filter((object) => typeof object.userData.profilePickRegionKey === 'string').length
}

function doneProfilePick(): void {
  fireEvent.click(screen.getByTestId('workbench-done-profile-pick'))
}

describe('UI-92 Extrude and Revolve viewport profile workflow', () => {
  it('keeps a movable palette present and supports viewport hover/pick in create and edit for both features', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch({ id: 'SK1', plane: 'xy' })
    await mintRectangleSketch({ id: 'SK2', plane: 'xz' })

    await waitFor(() => expect((screen.getByTestId('workbench-extrude') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-profile-pick-hint')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    expect(screen.getByTestId('revolve-pick-profile')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('extrude-pick-profile').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    pickXzProfile(runtime, 'SK2')
    doneProfilePick()
    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK2')
    expect(chosenRegionOverlayCount(runtime)).toBe(1)
    fireEvent.click(screen.getByTestId('extrude-use-whole-sketch'))
    expect(chosenRegionOverlayCount(runtime)).toBe(0)
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    pickXzProfile(runtime, 'SK2')
    doneProfilePick()
    expect(chosenRegionOverlayCount(runtime)).toBe(1)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(chosenRegionOverlayCount(runtime)).toBe(0)

    const lastGoodF1 = hooks().getBodyHandle('F1')
    const sk2BeforeLoss = hooks().dag.getNode('SK2')
    const sk2Regions = sk2BeforeLoss?.payload.regions
    expect(Array.isArray(sk2Regions)).toBe(true)
    hooks().dag.setPayload('SK2', {
      ...sk2BeforeLoss?.payload,
      regions: (sk2Regions as Array<{ loops: Array<Array<{ srcId: string }>> }>).map((region) => ({
        ...region,
        loops: region.loops.map((loop) => loop.map((segment) => ({
          ...segment,
          srcId: `changed:${segment.srcId}`,
        }))),
      })),
    })
    await hooks().fullResync(['F1'])
    expect(hooks().scheduler.diagnosticsOf('F1').some((diag) =>
      String(diag.params?.reason ?? '').includes('region-not-found'),
    )).toBe(true)
    expect(hooks().getBodyHandle('F1')).toBe(lastGoodF1)
    hooks().dag.setPayload('SK2', sk2BeforeLoss!.payload)
    await hooks().fullResync(['F1'])
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')

    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect(chosenRegionOverlayCount(runtime)).toBe(1)
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    pickXyProfile(runtime, 'SK1')
    doneProfilePick()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.sketchId).toBe('SK1'))
    expect(chosenRegionOverlayCount(runtime)).toBe(0)
    expect(hooks().dag.getNode('F1')?.consumes).toContain('SK1')
    expect(hooks().dag.getNode('F1')?.consumes).not.toContain('SK2')

    await mintRectangleSketch({ id: 'SK3', plane: 'xz', offset: 70 })
    await mintRectangleSketch({ id: 'SK4', plane: 'xz' })

    await waitFor(() => expect((screen.getByTestId('workbench-revolve') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    pickXzProfile(runtime, 'SK4')
    expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK4')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect(chosenRegionOverlayCount(runtime)).toBe(1)
    expect(screen.getByTestId('revolve-pick-profile')).toBeTruthy()
    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    pickXzProfile(runtime, 'SK3', 80)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.sketchId).toBe('SK3'))
    expect(chosenRegionOverlayCount(runtime)).toBe(0)
    expect(hooks().dag.getNode('F2')?.consumes).toContain('SK3')
    expect(hooks().dag.getNode('F2')?.consumes).not.toContain('SK4')

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.sketchId).toBe('SK4'))
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)
})

// WO BUG-MODEL-REGION-PICK (Operator, 2026-08-05 screenshot). The UI-92 flow above proves the palette
// and the picker; this proves the thing Operator actually could not do. It drives the WHOLE page: a real
// finished sketch node (payload.sketch, the shape Finish writes), the page's own
// recomputeSketchProfileInDag producing the region list through the real accept point, a real
// viewport click, and the real Extrude executor -- and asserts the kernel receives ONLY the clicked
// sub-region, whose boundary is assembled from two different source profiles.
describe('BUG-MODEL-REGION-PICK: extruding an enclosed sub-region picked in the viewport', () => {
  const SKETCH_NODE = 'sketch3d:SKREG'
  const PLANE_NODE = 'datum:XY'

  const seg = (id: string, ax: number, ay: number, bx: number, by: number): CamSketchEntity =>
    ({ id, kind: 'line', construction: false, start: { x: ax, y: ay }, end: { x: bx, y: by } })

  const rect = (prefix: string, x0: number, y0: number, x1: number, y1: number): CamSketchEntity[] => ([
    seg(`${prefix}0`, x0, y0, x1, y0),
    seg(`${prefix}1`, x1, y0, x1, y1),
    seg(`${prefix}2`, x1, y1, x0, y1),
    seg(`${prefix}3`, x0, y1, x0, y0),
  ])

  /** a = [0,10]x[0,10] crossed by b = [6,16]x[4,14], plus the stray spur that used to refuse the
   *  whole sketch ("vertex ... has degree 1"). Overlap = 4 x 6 = 24 mm^2. */
  const CROSSING_WITH_SPUR: CamSketchEntity[] = [
    ...rect('a', 0, 0, 10, 10),
    ...rect('b', 6, 4, 16, 14),
    seg('spur', 16, 14, 24, 20),
  ]

  function loopArea(loop: Array<{ kind: string }>): number {
    const pts = loop.map((s) => (s as { kind: 'line'; a: [number, number] }).a)
    let sum = 0
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]
      const [bx, by] = pts[(i + 1) % pts.length]
      sum += ax * by - bx * ay
    }
    return Math.abs(sum) / 2
  }

  function clickAt(runtime: ReturnType<typeof createFakeSceneRuntime>, x: number, y: number): void {
    runtime.rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
  }

  it('sends the kernel ONLY the clicked region, and never the whole first profile', async () => {
    const extrudeRequests: ExtrudeRequest[] = []
    const runtime = createFakeSceneRuntime()
    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient({
          makeExtrudeImpl: (req, mintHandle) => {
            extrudeRequests.push(req)
            return { ok: true, body: mintHandle(), diagnostics: [] }
          },
        })}
        createSceneRuntime={() => runtime}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    hooks().dag.insertNode({
      id: SKETCH_NODE, kind: 'sketch', consumes: [PLANE_NODE], refs: [],
      payload: {
        sketch: {
          id: 'skreg', layerId: 'workbench', entities: CROSSING_WITH_SPUR,
          constraints: [], dimensions: [], solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
        planeNodeId: PLANE_NODE, externalRefs: [], dimensionDiagnostics: [],
      },
    })
    await hooks().fullResync([SKETCH_NODE])

    // The page's OWN recompute produced three enclosed regions from a sketch that used to produce
    // none at all (the stray spur alone refused it).
    const regions = hooks().dag.getNode(SKETCH_NODE)?.payload.regions as Array<{ loops: Array<Array<{ kind: string }>> }>
    expect(regions).toHaveLength(3)

    await waitFor(() => expect((screen.getByTestId('workbench-extrude') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))

    // Click inside the 4x6 overlap -- an area no whole profile covers on its own.
    clickAt(runtime, 8, 7)
    doneProfilePick()
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe(SKETCH_NODE)

    // PREVIEW: exactly one chosen-region outline, and it is the overlap, not a whole rectangle.
    expect(chosenRegionOverlayCount(runtime)).toBe(1)
    const selector = screen.getByTestId('extrude-selected-profile-region')
    expect(selector.textContent).toMatch(/chosen/i)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // APPLY: every kernel request -- WO-035's live preview evaluation AND the
    // committed replay -- carries the overlap region and nothing else. The
    // whole first profile never reaches the kernel on any path.
    expect(extrudeRequests.length).toBeGreaterThanOrEqual(1)
    for (const request of extrudeRequests) {
      expect(request.profiles).toHaveLength(1)
      const profile = request.profiles![0]
      expect(profile.loops).toHaveLength(1)
      expect(loopArea(profile.loops[0])).toBeCloseTo(24, 6)
      expect([...new Set(profile.loops[0].map((s) => s.srcId))].sort()).toEqual(['a1', 'a2', 'b0', 'b3'])
    }

    // The persisted selector is the region, not the sketch -- so a regen replays the same region.
    expect((hooks().dag.getNode('F1')?.payload.profileSelector as { kind: string; signature: string[] }))
      .toEqual({ kind: 'region', signature: ['a1', 'a2', 'b0', 'b3'] })
  })

  it('toggles several regions in one session and persists the remaining picks in order', async () => {
    const extrudeRequests: ExtrudeRequest[] = []
    const runtime = createFakeSceneRuntime()
    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient({
          makeExtrudeImpl: (req, mintHandle) => {
            extrudeRequests.push(req)
            return { ok: true, body: mintHandle(), diagnostics: [] }
          },
        })}
        createSceneRuntime={() => runtime}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    hooks().dag.insertNode({
      id: SKETCH_NODE, kind: 'sketch', consumes: [PLANE_NODE], refs: [],
      payload: {
        sketch: {
          id: 'skreg', layerId: 'workbench', entities: CROSSING_WITH_SPUR,
          constraints: [], dimensions: [], solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
        planeNodeId: PLANE_NODE, externalRefs: [], dimensionDiagnostics: [],
      },
    })
    await hooks().fullResync([SKETCH_NODE])

    await waitFor(() => expect((screen.getByTestId('workbench-extrude') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    clickAt(runtime, 2, 2)
    clickAt(runtime, 8, 7)
    clickAt(runtime, 14, 12)
    expect(chosenRegionOverlayCount(runtime)).toBe(3)
    clickAt(runtime, 8, 7)
    expect(screen.getByTestId('solids-workbench-profile-pick-hint').textContent).toContain('2 selected')
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))

    expect(screen.getByTestId('extrude-selected-profile-region').textContent).toContain('2 of 3 regions')
    expect(chosenRegionOverlayCount(runtime)).toBe(2)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    const selector = hooks().dag.getNode('F1')?.payload.profileSelector as { kind: string; regions: unknown[] }
    expect(selector.kind).toBe('regions')
    expect(selector.regions).toHaveLength(2)
    expect(extrudeRequests.at(-1)?.profiles).toHaveLength(2)
    expect(screen.getByTestId('feature-row-F1').textContent).toContain('2 of 3 regions')
  })

  it('refuses BY NAME instead of substituting a region when the picked boundary is gone', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    hooks().dag.insertNode({
      id: SKETCH_NODE, kind: 'sketch', consumes: [PLANE_NODE], refs: [],
      payload: {
        sketch: {
          id: 'skreg', layerId: 'workbench', entities: CROSSING_WITH_SPUR,
          constraints: [], dimensions: [], solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
        planeNodeId: PLANE_NODE, externalRefs: [], dimensionDiagnostics: [],
      },
    })
    await hooks().fullResync([SKETCH_NODE])

    await waitFor(() => expect((screen.getByTestId('workbench-extrude') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    clickAt(runtime, 8, 7)
    doneProfilePick()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    const lastGood = hooks().getBodyHandle('F1')

    // Pull the second rectangle out of the sketch: the overlap region ceases to exist.
    const node = hooks().dag.getNode(SKETCH_NODE)!
    hooks().dag.setPayload(SKETCH_NODE, {
      ...node.payload,
      sketch: {
        ...(node.payload.sketch as { entities: CamSketchEntity[] }),
        entities: rect('a', 0, 0, 10, 10),
      },
    })
    await hooks().fullResync([SKETCH_NODE, 'F1'])

    // Named refusal, last-good body retained -- never silently re-bound to the surviving rectangle.
    expect(hooks().scheduler.diagnosticsOf('F1').some((diag) =>
      String(diag.params?.reason ?? '').includes('region-not-found'),
    )).toBe(true)
    expect(hooks().getBodyHandle('F1')).toBe(lastGood)
  })
})
