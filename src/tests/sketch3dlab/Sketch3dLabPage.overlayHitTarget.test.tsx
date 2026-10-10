// @vitest-environment jsdom
//
// SKC-H2 criterion 1 (the BUG from SKC-H1's hitTargetProbe, coordination/reports/
// SKC-H1.report.json + SKC-H1-evidence/sketch3dlab-dev-hit-target-probe.png): in a real
// browser, the passive sketch3dlab-status and sketch3dlab-counts overlays sit on top of the
// canvas (position:absolute, z-index:2) and intercept clicks at valid sketch coordinates -
// world (0,40) maps to screen (60,80), whose native document.elementFromPoint resolved to
// sketch3dlab-counts, not the canvas; world (20,45) maps to screen (300,20), resolving to
// sketch3dlab-status. Both blocked line draws (entity count stayed 0); the same pattern below
// the overlays worked (entity count 1).
//
// jsdom cannot reproduce that native hit-test at all - this repo's jsdom (v29, no layout
// engine) doesn't even implement document.elementFromPoint (verified empirically: calling it
// throws 'not a function'), and Sketch3dLabPage.tsx's own header comment already documents that
// its canvas has a zero-size bounding rect here. A fireEvent dispatched at a target always
// reaches that exact target regardless of real CSS pointer-events/z-index layering, so no
// jsdom test can fire a "click at a screen coordinate" and let the browser decide who catches
// it. The fix IS a CSS declaration (pointer-events: none on the passive overlays so they never
// intercept a hit in a real browser) - so the correct-fidelity check this harness CAN make is
// asserting that declaration exists on exactly the reported overlays (and does NOT exist on the
// interactive tool buttons, which must keep receiving clicks). SKC-H1's own real-Chromium
// harness (tools/diag/skc-h1-measure.mjs, runLabHitTargetProbe) is the tool that proves the
// full native click pass-through; it is a manual diagnostic script outside node
// tools/run-suite.mjs's vitest gate.
import { describe, it, expect, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'

afterEach(cleanup)

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

describe('Sketch3dLabPage overlay hit-target fix (criterion 1, SKC-H1 hitTargetProbe)', () => {
  it('reproduces the exact probe coordinates from SKC-H1 (screen (60,80) and (300,20))', () => {
    // Pins this test to the SKC-H1 report's own numbers - if geometry2d's view ever changes,
    // this fails loudly instead of silently testing the wrong coordinates.
    expect(worldToScreen({ x: 0, y: 40 })).toEqual({ x: 60, y: 80 })
    expect(worldToScreen({ x: 20, y: 45 })).toEqual({ x: 300, y: 20 })
  })

  it('both reported overlays (sketch3dlab-counts, sketch3dlab-status) are pointer-events:none so they cannot intercept a canvas click', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    expect(screen.getByTestId('sketch3dlab-counts').style.pointerEvents).toBe('none')
    expect(screen.getByTestId('sketch3dlab-status').style.pointerEvents).toBe('none')
  })

  it('the sibling passive DOF-chip decoration is also pointer-events:none (same bug class, per the WO mission)', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    expect(screen.getByTestId('sketch3dlab-dof-chip').style.pointerEvents).toBe('none')
  })

  it('interactive controls (tool buttons + toolbar) are NOT pointer-events:none and still receive clicks', async () => {
    render(<Sketch3dLabPage />)
    await ready()

    expect(screen.getByTestId('sketch3dlab-tool-toolbar').style.pointerEvents).not.toBe('none')
    for (const tool of ['select', 'line', 'circle', 'arc', 'drag']) {
      expect(screen.getByTestId(`sketch3dlab-tool-${tool}`).style.pointerEvents).not.toBe('none')
    }

    fireEvent.click(screen.getByTestId('sketch3dlab-tool-line'))
    expect(screen.getByTestId('sketch3dlab-tool-line').getAttribute('aria-pressed')).toBe('true')
  })

  it('canvas draw-click handling at the exact probe coordinates is untouched by the overlay fix', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    fireEvent.click(screen.getByTestId('sketch3dlab-tool-line'))

    const canvas = screen.getByTestId('sketch3dlab-canvas')
    const p1 = worldToScreen({ x: 0, y: 40 })
    const p2 = worldToScreen({ x: 20, y: 45 })
    fireEvent.pointerDown(canvas, { clientX: p1.x, clientY: p1.y })
    fireEvent.pointerDown(canvas, { clientX: p2.x, clientY: p2.y })

    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))
  })
})
