// @vitest-environment jsdom
//
// WO UI-13B (INT-5 gate-premise catch, batch B): drives the REAL
// SolidsWorkbenchPage against the REAL in-process kernel (createLocalGeomService,
// same seam SolidsWorkbenchPage.dressUp.test.tsx/.hole.test.tsx already use)
// through the three newly-wired surfaces: the params table (DOC-4 engine,
// brand-new UI), the UI-4 panel suite (measure/appearance/visibility/section/
// mass-properties, previously demo-only), and the BottomConsole (previously
// base-app-only).
//
// Body under test: same box fixture as the other UI-13A/UI-13B workbench
// tests (sketch 40x20 offset 10, extrude 20 -> box x:[10,50] y:[0,20]
// z:[0,20], volume 16000).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { INTERACTION_ORANGE } from '../../viewport3d'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

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

describe('SolidsWorkbenchPage params table + UI-4 panel suite + console (WO UI-13B, real occt-wasm kernel)', () => {
  it('Params: a named parameter drives an Extrude fx expression; editing the parameter changes body volume', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // Create the named parameter FIRST (acceptance #1's ordering).
    expect(screen.getByTestId('params-table')).toBeTruthy()
    commitTextField('param-new-name', 'len')
    commitTextField('param-new-expression', '20')
    fireEvent.click(screen.getByTestId('param-add'))
    await waitFor(() => expect(screen.getAllByTestId('param-row').length).toBe(2))
    await waitFor(() => expect(screen.getByTestId('param-value-len').textContent).toMatch(/20\.0000/))

    await buildBox()

    // Reference the parameter in the Extrude dialog's fx field instead of a literal.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitTextField('extrude-distance-expression', 'len')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const vol0 = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    expect(Math.abs(vol0.value - 16000) / 16000).toBeLessThan(1e-3)

    // Edit the parameter's value in the table -- the SAME body's volume must
    // change accordingly, through the SAME shared scheduler (no second regen
    // path, see paramTable.executor's own wiring comment).
    commitTextField('param-expression-len', '30')
    await waitFor(
      async () => {
        const handle = hooks().getBodyHandle('F1')
        expect(handle).not.toBeUndefined()
        const v = await hooks().client.measure(handle!, 'volume')
        expect(Math.abs(v.value - 24000) / 24000).toBeLessThan(1e-3)
      },
      { timeout: 20_000 },
    )
  }, 60_000)

  it('Params: deleting a parameter still referenced by a feature is refused, with the consumer named', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    commitTextField('param-new-name', 'w')
    commitTextField('param-new-expression', '5')
    fireEvent.click(screen.getByTestId('param-add'))
    await waitFor(() => expect(screen.getAllByTestId('param-row').length).toBe(2))

    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitTextField('extrude-distance-expression', 'w')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('param-delete-w'))
    await waitFor(() => expect(screen.getByTestId('param-delete-error-w').textContent).toMatch(/F1/))
    // Refused: the parameter is still there.
    expect(screen.getAllByTestId('param-row').length).toBe(2)
  }, 60_000)

  it('Body row selects and highlights the entire solid with Inspect collapsed and no tool active', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('body-row-F1')).toBeTruthy())

    const faceIds = hooks().getBodyFaceIds('F1')!
    const restingFaceColors = faceIds.map((faceId) => hooks().getBodyFaceColorSample('F1', faceId))
    const restingMaterial = hooks().getBodyMaterialSnapshot('F1')

    fireEvent.click(screen.getByTestId('workbench-section-inspect-header'))
    expect(screen.queryByTestId('workbench-ui4-tool-appearance')).toBeNull()

    fireEvent.click(screen.getByTestId('body-row-F1'))
    await waitFor(() => expect(screen.getByTestId('body-row-F1').getAttribute('aria-selected')).toBe('true'))
    await waitFor(() => {
      const selectedFaceColors = faceIds.map((faceId) => hooks().getBodyFaceColorSample('F1', faceId))
      expect(selectedFaceColors.every((color) => color !== undefined)).toBe(true)
      expect(selectedFaceColors).toEqual(restingFaceColors)
      expect(hooks().getBodyMaterialSnapshot('F1')).toEqual({
        color: INTERACTION_ORANGE,
        vertexColors: false,
        opacity: 1,
        transparent: false,
      })
      expect(hooks().getBodyInteractionSnapshot('F1')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'body-outline', variant: 'selected', linewidth: 5 }),
      ]))
    })
    expect(restingMaterial?.vertexColors).toBe(true)
    // Restore this persisted view preference for the remaining suite cases.
    fireEvent.click(screen.getByTestId('workbench-section-inspect-header'))
  }, 60_000)

  it('UI-4 panel suite drives the real workbench body: measure a distance, section, isolate/hide/show, appearance color, mass properties', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // -- Measure: distance between the top (z=20) and bottom (z=0) faces (~20mm). --
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    // The UI-4 bridge session tessellates F1 into its OWN pick cache
    // asynchronously the instant the tool arms (see hasBridgeBody's own doc
    // comment) -- a click before this resolves would pick against an empty
    // cache and silently miss.
    await waitFor(() => expect(hooks().hasBridgeBody('F1')).toBe(true), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('measure-mode-between'))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    // Both a Distance AND an Angle outcome render (the two picked faces are
    // parallel and planar, so measureAngle also succeeds, 0deg) -- assert on
    // the OUTCOME LIST text rather than a single measure-outcome node.
    await waitFor(() => expect(screen.getAllByTestId('measure-outcome').length).toBeGreaterThan(0), { timeout: 20_000 })
    const outcomesText = screen.getAllByTestId('measure-outcome').map((el) => el.textContent).join(' | ')
    expect(outcomesText).toMatch(/Distance: 20\.000 mm/)
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure')) // deactivate

    // -- Section: enabling drives a REAL setClipPlanes(...) call with an
    //    ACTUAL plane on the runtime (the disabled-state effect already
    //    called setClipPlanes([]) once on mount -- an empty array, not a
    //    real section -- so this asserts the LAST call is non-empty). --
    fireEvent.click(screen.getByTestId('section-enabled'))
    await waitFor(() => {
      const last = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1]
      expect(last).toBeDefined()
      expect(last.length).toBeGreaterThan(0)
    })

    // -- Visibility: VisibilityPanel reads its selection off the MEASURE
    //    tool's own selectedBodyIds (same wiring UI4Demo established -- see
    //    this page's selectedBodyIdsForVisibility) -- body-filter measure
    //    pick, then isolate -> show all. --
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    fireEvent.click(screen.getByTestId('measure-mode-single'))
    fireEvent.click(screen.getByTestId('workbench-measure-filter-body'))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('visibility-isolate') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByTestId('visibility-isolate'))
    await waitFor(() => expect(hooks().visibilityStore.isolateActive).toBe(true))
    expect(hooks().visibilityStore.isBodyVisible('F1')).toBe(true)

    fireEvent.click(screen.getByTestId('visibility-show-all'))
    await waitFor(() => expect(hooks().visibilityStore.isolateActive).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure')) // deactivate

    // -- Appearance: apply a color to the same body, verify the STORE (not
    //    just the panel echoing back its own input). --
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance'))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('appearance-target-label').textContent).toMatch(/capEnd/))
    await waitFor(() => expect(hooks().getBodyInteractionSnapshot('F1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'face-fill', variant: 'selected' }),
    ])))
    fireEvent.click(screen.getByTestId('appearance-filter-body'))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('appearance-target-label').textContent).toMatch(/body: F1/))
    await waitFor(() => {
      const interactions = hooks().getBodyInteractionSnapshot('F1')
      expect(interactions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'body-outline', variant: 'selected', linewidth: 5 }),
      ]))
      expect(interactions.some((entry) => entry.kind === 'face-fill')).toBe(false)
      expect(hooks().getBodyMaterialSnapshot('F1')).toEqual({
        color: INTERACTION_ORANGE,
        vertexColors: false,
        opacity: 1,
        transparent: false,
      })
    })
    fireEvent.change(screen.getByTestId('appearance-color-input'), { target: { value: '#ff0000' } })
    await waitFor(() => {
      const color = hooks().appearanceStore.bodyColor('F1')
      expect(color).toBeDefined()
      expect(color![0]).toBeCloseTo(1, 1)
      expect(color![1]).toBeCloseTo(0, 1)
      expect(color![2]).toBeCloseTo(0, 1)
    })
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance')) // deactivate
    await waitFor(() => {
      const material = hooks().getBodyMaterialSnapshot('F1')
      expect(material?.color).toBe(0xffffff)
      expect(material?.vertexColors).toBe(true)
    })

    // -- Mass properties: real body -> real volume readout. --
    await waitFor(() => expect(screen.getByTestId('mass-readout')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('mass-volume-value').textContent).toMatch(/16000\.000/)
  }, 60_000)

  it('Console: successful Apply logs success; a refused Fillet preview stays non-committable and preserves the model', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('console-strip').textContent).toMatch(/applied/i))

    const dagBeforeRefusal = hooks().dag.serialize()
    const historyBeforeRefusal = structuredClone(hooks().history.serialize())

    // A guaranteed refusal (same fixture SolidsWorkbenchPage.dressUp.test.tsx's
    // own "Fillet refusal" case uses: r=50 on a ~20mm adjacent-face extent).
    // UI-107 evaluates this in an isolated preview scheduler: the palette owns
    // the diagnostic, Apply remains disabled, and the live document/history
    // stay byte-for-byte unchanged.
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
    commitField('fillet-radius', '50')

    await waitFor(() => {
      const previewStatus = screen.getByTestId('fillet-preview-status')
      expect(previewStatus.getAttribute('data-status')).toBe('refused')
      expect(previewStatus.textContent).toMatch(/largest radius that fits/i)
    }, { timeout: 20_000 })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().dag.serialize()).toBe(dagBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
  }, 60_000)

  it('Render smoke: params table + full UI-4 panel suite + console mount together with no hooks-order crash', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    for (const id of ['params-table', 'measure-panel', 'appearance-panel', 'visibility-panel', 'section-controls', 'mass-properties-panel', 'console-strip']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }

    // Toggling every tool on/off and building a body is the same render path
    // the hooks-order rule cares about (measure/appearance hooks are called
    // unconditionally every render, per the rules of hooks) -- exercise it.
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance'))
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance'))
    await buildBox()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  }, 60_000)
})
