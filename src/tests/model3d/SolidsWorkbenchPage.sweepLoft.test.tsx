// @vitest-environment jsdom
//
// WO UI-13A (INT-5 gate-premise catch): drives the REAL SolidsWorkbenchPage
// against the REAL in-process kernel (createLocalGeomService) through the
// actual Sweep/Loft toolbar buttons -- both dialogs pick existing sketches
// via a plain dropdown (the SAME convention ExtrudeDialog/BooleanDialog
// already establish), so no in-viewport picking is needed here (see
// SweepDialog.tsx/LoftDialog.tsx headers for why).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
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

async function sketchRectangle(width: string, height: string, offset: string, rowTestId: string): Promise<void> {
  await mintRectangleSketch({ width, height, offset, id: rowTestId.replace('feature-row-', '') })
  await waitFor(() => expect(screen.getByTestId(rowTestId)).toBeTruthy())
}

describe('SolidsWorkbenchPage Sweep/Loft wiring (WO UI-13A, real occt-wasm kernel)', () => {
  it('Sweep: profile sketch swept along world Z, apply, body updates, one undo removes it', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // 10x10 profile (area 100), offset 5 (kept off the world Z axis, same
    // convention every other profile-consuming test here already follows).
    await sketchRectangle('10', '10', '5', 'feature-row-SK1')

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('sweep-path-axis-select'), { target: { value: 'z' } })
    commitField('sweep-length', '30')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const vol = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    // Straight sweep: analytic = profile area * path length = 100 * 30.
    expect(Math.abs(vol.value - 3000) / 3000).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F1')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
  }, 60_000)

  it('Loft: two rectangle sections, apply, body updates, one undo removes it', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // Two coaxial rectangles (20x10 -> 10x6), same fixture shape GEO-5's own
    // loft.test.ts uses, stacked 12mm apart along Z by LoftDialog's own
    // `spacing` field (see its header for why this is needed).
    await sketchRectangle('20', '10', '0', 'feature-row-SK1')
    await sketchRectangle('10', '6', '0', 'feature-row-SK2')

    fireEvent.click(screen.getByTestId('workbench-loft'))
    fireEvent.change(screen.getByTestId('loft-section1-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('loft-section2-select'), { target: { value: 'SK2' } })
    commitField('loft-spacing', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const vol = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    // Prismatoid: h/6*(A1 + 4*Am + A2). A1=200, A2=60, Am=15*8=120, h=12.
    const expected = (12 / 6) * (200 + 4 * 120 + 60)
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F1')).toBeNull(), { timeout: 20_000 })
  }, 60_000)
})
