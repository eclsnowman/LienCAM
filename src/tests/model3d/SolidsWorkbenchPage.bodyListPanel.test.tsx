// @vitest-environment jsdom
//
// WO UI-25: real-workbench render tests for the two BodyListPanel fixes.
// Same real in-process kernel + fakeSceneRuntime seam as
// SolidsWorkbenchPage.ui13b.test.tsx (createLocalGeomService, real occt-wasm).
//
// A2: clicking the embedded workbench's body-visible-<id> checkbox must flip
// its OWN .checked state (SolidsWorkbenchPage.tsx's onToggleVisibility only
// touched visibleRef + the THREE mesh before this fix -- the `bodies` state
// the checkbox's `checked` prop reads never refreshed, so the box silently
// stayed ticked while the body actually hid).
//
// A3: the new body-list color swatch must both (a) update the appearance
// STORE and (b) repaint the REAL rendered vertex-color buffer -- a
// state-only assertion would pass even if the repaint wiring were broken
// (BK-114 lesson: assert the rendered color attribute, not only store state).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

async function applyTopEdgeFillet(runtime: ReturnType<typeof createFakeSceneRuntime>): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
  commitField('fillet-radius', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage body list panel (WO UI-25 A2/A3 real-workbench render tests)', () => {
  it('A2: clicking body-visible-F1 on the embedded workbench flips its .checked state', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    const checkbox = screen.getByTestId('body-visible-F1') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))

    // Round-trip back, proving this is a genuine toggle, not a one-way stick.
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))
  }, 60_000)

  it('A3: the body-list color control calls setBodyColor AND repaints the rendered face buffer (state-AND-render, BK-114)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    // Sanity: no color assigned yet.
    expect(hooks().appearanceStore.bodyColor('F1')).toBeUndefined()

    fireEvent.change(screen.getByTestId('body-color-input-F1'), { target: { value: '#00ff00' } })

    // STATE: the store itself was updated by the swatch, not just echoed by a
    // panel reading its own input back.
    await waitFor(() => {
      const color = hooks().appearanceStore.bodyColor('F1')
      expect(color).toBeDefined()
      expect(color![0]).toBeCloseTo(0, 1)
      expect(color![1]).toBeCloseTo(1, 1)
      expect(color![2]).toBeCloseTo(0, 1)
    })

    // RENDER: the actual vertex-color buffer for the body's faces turned
    // green too -- sample every face since body scope colors all of them.
    await waitFor(() => {
      const faceIds = hooks().getBodyFaceIds('F1') ?? []
      expect(faceIds.length).toBeGreaterThan(0)
      const greenFaces = faceIds.filter((fid) => {
        const sample = hooks().getBodyFaceColorSample('F1', fid)
        return sample !== undefined && Math.abs(sample[0] - 0) < 0.15 && Math.abs(sample[1] - 1) < 0.15 && Math.abs(sample[2] - 0) < 0.15
      })
      // WO UI-25-R1 (audit MAJOR): body-scope color must repaint EVERY face, not
      // just one -- a partial repaint through the new body-list swatch entry
      // point must fail this assertion.
      expect(greenFaces.length).toBe(faceIds.length)
    })
  }, 60_000)

  it('A3: the swatch background itself tracks the assigned body color', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.change(screen.getByTestId('body-color-input-F1'), { target: { value: '#0000ff' } })
    await waitFor(() => {
      const swatch = screen.getByTestId('body-color-F1') as HTMLElement
      // backgroundColor, not the background shorthand (UI-25-R1 audit major fix)
      expect(swatch.style.backgroundColor).toMatch(/#0000ff|rgb\(0,\s*0,\s*255\)/i)
    })
  }, 60_000)

  it('UI-28: a fillet keeps the original body identity and UI-4 bridge history while every row action targets the live leaf', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await applyTopEdgeFillet(runtime)

    // WO-073: the UI-4 bridge intentionally retains the historical F1 body
    // alongside live F2 for inspection/history bookkeeping. The Bodies row
    // assertions below remain the counter-proof that this raw bridge census
    // does not widen the user-facing row/action surface beyond the live leaf.
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    await waitFor(() => {
      expect(hooks().hasBridgeBody('F1')).toBe(true)
      expect(hooks().hasBridgeBody('F2')).toBe(true)
    }, { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))

    const bodiesSection = screen.getByTestId('workbench-section-bodies')
    const row = await screen.findByTestId('body-row-F2')
    expect(bodiesSection.querySelector('.tree-count')?.textContent).toBe('1')
    expect(screen.queryByTestId('body-row-F1')).toBeNull()
    expect(row.getAttribute('data-lineage-id')).toBe('F1')
    expect(row.textContent).toContain('Extrude F1')
    expect(row.textContent).not.toContain('Fillet F2')
    expect(screen.getByTestId('body-visible-F2')).toBeTruthy()
    expect(screen.getByTestId('body-color-F2')).toBeTruthy()

    // UI-94: selecting the consumed history row keeps F1 as the authored
    // selection/edit target while the lineage body row presents live owner F2.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('false')

    // A non-body tree selection clears the body presentation; clicking the
    // lineage row still selects the current leaf F2 rather than historical F1.
    fireEvent.click(screen.getByTestId('feature-row-SK1'))
    expect(row.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('true')

    // Color is stored and painted on F2, never the historical F1 handle.
    expect(hooks().appearanceStore.bodyColor('F1')).toBeUndefined()
    fireEvent.change(screen.getByTestId('body-color-input-F2'), { target: { value: '#00ff00' } })
    await waitFor(() => expect(hooks().appearanceStore.bodyColor('F2')).toEqual([0, 1, 0]))
    expect(hooks().appearanceStore.bodyColor('F1')).toBeUndefined()
    await waitFor(() => {
      const faceIds = hooks().getBodyFaceIds('F2') ?? []
      expect(faceIds.length).toBeGreaterThan(0)
      expect(faceIds.every((faceId) => {
        const sample = hooks().getBodyFaceColorSample('F2', faceId)
        return sample !== undefined && Math.abs(sample[0]) < 0.15 && Math.abs(sample[1] - 1) < 0.15 && Math.abs(sample[2]) < 0.15
      })).toBe(true)
    })

    const leafVisibility = screen.getByTestId('body-visible-F2') as HTMLInputElement
    fireEvent.click(leafVisibility)
    await waitFor(() => expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(false))
    fireEvent.click(screen.getByTestId('body-visible-F2'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true))

    // WO UI-56: the visibility checkbox is now routed through the same
    // undoable SetHiddenCommand history as every other feature edit
    // (deliverable 3), so each of the two round-trip clicks above pushed its
    // own history entry -- pop both before the single undo below tests the
    // FILLET's own undo, or it would just replay the visibility toggle.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.hidden).toBe(true))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.hidden).toBe(false))

    // Undo exposes the then-live ancestor without changing its original name.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull(), { timeout: 20_000 })
    const restored = screen.getByTestId('body-row-F1')
    expect(restored.getAttribute('data-lineage-id')).toBe('F1')
    expect(restored.textContent).toContain('Extrude F1')
    expect(bodiesSection.querySelector('.tree-count')?.textContent).toBe('1')
  }, 60_000)
})
