// @vitest-environment jsdom
//
// WO UI-18 (D2, Operator's annotated screenshot operator-02-confirm-bar-wedged.png):
// the ONE shared WorkbenchConfirmBar now backs all four workbench pick-flow
// hint bars (unified New Sketch, N-pick, push/pull, dress-up). This file proves, per
// flow: the message text renders, the SAME testids/actions survive the
// refactor (Done/Cancel), and push/pull's refusal state renders the red
// variant class. The real-browser bounding-box-vs-.view-cube-wrap proof
// (acceptance #2's other half) is coordination/evidence/UI-18/'s capture
// script + committed screenshot, not reproducible in jsdom (no real layout).
//
// Same "REAL SolidsWorkbenchPage against the REAL in-process kernel" seam
// SolidsWorkbenchPage.dressUp.test.tsx/.pushPull.test.tsx already establish
// (createLocalGeomService + createFakeSceneRuntime's rayOverride), reusing
// their exact box fixture (sketch 40x20 offset 10, extrude 20 -> box
// x:[10,50] y:[0,20] z:[0,20]).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO FLAKE-1-R1: fireEvent.change + fireEvent.blur back to back assumes the
// 'change' dispatch has already landed (React's setState applied, input.value
// updated) before 'blur' fires. Under heavy scheduler contention (>=24-way
// concurrent vitest, or a full model3d-slice campaign running alongside)
// this dispatch can go missing entirely -- reproduced naturally twice
// (coordination/evidence/FLAKE-1-R1/ROOT-CAUSE.md): once with
// NumericInput.commit logging the PRE-change draft ("0" instead of the
// just-typed "-25", so runPushPullPreview was never even called -- no
// product guard involved), and once where input.value stayed stuck at "0"
// through a full 1s waitFor (not a brief scheduling delay -- the dispatch
// itself never took effect). A single wait-then-blur is not sufficient:
// RETRY the change dispatch itself (bounded, so a genuine NumericInput
// regression still fails loud rather than hanging) until the DOM confirms
// it landed, only then commit via blur.
async function commitField(testId: string, raw: string): Promise<void> {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  const attempts = 5
  for (let attempt = 1; attempt <= attempts; attempt++) {
    fireEvent.change(input, { target: { value: raw } })
    try {
      await waitFor(() => expect(input.value).toBe(raw), { timeout: 1_000 })
      fireEvent.blur(input)
      return
    } catch (err) {
      if (attempt === attempts) throw err
    }
  }
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
  await commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage shared confirm bar (WO UI-18 D2)', () => {
  it('N-pick: renders the shared bar with its message + Cancel, non-refusal styling, no full-width/edge-anchored inline positioning', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    fireEvent.keyDown(window, { key: 'n' })
    const bar = await waitFor(() => screen.getByTestId('solids-workbench-npick-hint'))
    expect(bar.className).toContain('workbench-confirm-bar')
    expect(bar.className).not.toContain('workbench-confirm-bar--refusal')
    expect(bar.textContent).toMatch(/look normal to it/i)
    // The old bespoke bar set bottom:0/left:0/right:0 as an INLINE style
    // (position:absolute set directly on the element); the shared bar's
    // geometry now lives entirely in the .workbench-confirm-bar CSS class,
    // so the element itself carries no such inline override.
    expect(bar.style.left).toBe('')
    expect(bar.style.right).toBe('')

    fireEvent.click(screen.getByTestId('workbench-cancel-npick'))
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  }, 30_000)

  it('unified New Sketch renders the shared bar, message text, hover readout slot, and Cancel restores the rail', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    const bar = screen.getByTestId('solids-workbench-plane-pick-hint')
    expect(bar.className).toContain('workbench-confirm-bar')
    // e149adaa (WO-193) added visible construction planes as a valid target,
    // widening this hint's wording.
    expect(bar.textContent).toMatch(/click a base plane, visible construction plane, or flat face/i)

    fireEvent.click(screen.getByTestId('workbench-cancel-plane-pick'))
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
  }, 30_000)

  it('Chamfer uses the accepted wrapperless command strip immediately, with no legacy Done bar or modal chrome', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-chamfer'))
    const strip = await waitFor(() => screen.getByTestId('chamfer-workspace-palette'))
    expect(strip.classList.contains('sketch-confirm-overlay')).toBe(true)
    expect(strip.classList.contains('fillet-command-strip')).toBe(true)
    expect(strip.getAttribute('role')).toBe('toolbar')
    expect(strip.textContent).toMatch(/Chamfer.*0 edges selected.*Distance.*mm.*Apply.*Cancel/i)
    expect(strip.closest('[data-testid="dialog-shell"]')).toBeNull()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-dressup-hint')).toBeNull()
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()

    // top edge y=0, x:[10,50] -- midpoint (30,0,20), same ray dressUp.test.tsx uses.
    runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge/))
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('chamfer-workspace-palette')).toBeNull())
  }, 30_000)

  it('push/pull: arm message, then an overcut delta drives the refusal-red variant with the diagnostic text, through the SAME shared bar element', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    const armedBar = screen.getByTestId('solids-workbench-pushpull-hint')
    expect(armedBar.className).not.toContain('workbench-confirm-bar--refusal')
    expect(armedBar.textContent).toMatch(/click a planar face to push\/pull/i)

    // Pick the top face (z=20 of the 40x20x20 box) -> mounts the gizmo + the
    // WO UI-57 Design 2/3 anchored value entry (relocated OUT of this confirm
    // bar into the shared AnchoredValueEntry -- "pulling this stuff into
    // interactive workspace selectors", Operator verdict per that component's own
    // header comment; this test's own concern -- the confirm bar's red
    // refusal variant -- is unaffected by WHERE the delta is typed).
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    // AnchoredValueEntry renders nothing while its anchor point projects to
    // null (off-screen/behind camera) -- the fake runtime's own default
    // (same "pre-arm it" contract SolidsWorkbenchPage.resizeHole.test.tsx's
    // own captureRuntime() helper documents).
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy())

    // WO-011: the mounted hint must stay READABLE. The pre-fix 138-char
    // message measured 763px against the bar's 444px message slot (real-app
    // probe across 1280-1920, src/tests/evidence/WO-011/results-before.json)
    // and ellipsized mid-word ("Apply (Enter) comm...") at EVERY width in the
    // sweep. jsdom has no layout, so the guard is the string itself: the full
    // replacement sentence (measured 403px - fits the slot), plus a char
    // budget (~80 chars = the 444px slot at the measured ~5.5px/char) so a
    // future regrow fails HERE instead of silently ellipsizing again.
    const mountedBar = screen.getByTestId('solids-workbench-pushpull-hint')
    expect(mountedBar.textContent).toContain(
      'Drag the arrow or type a distance - Apply (Enter) commits, Esc cancels...')
    const mountedMsg = mountedBar.querySelector('.workbench-confirm-message')?.textContent ?? ''
    expect(mountedMsg.length,
      'mounted push/pull hint must stay within the measured 444px message slot (~80 chars)',
    ).toBeLessThanOrEqual(80)

    const preview = installOvercutPreviewCompletionProbe()
    try {
      // -25mm overcuts the 20mm block; pushPull.test.tsx AC4 proves this engine
      // refusal class, while this test drives the shared bar's red variant.
      // Design 3's two-stage Enter: the FIRST Enter on a changed draft ADJUSTS
      // (runs the preview) without completing -- exactly the refusal path
      // this test needs, never reaching (or needing) the second Enter.
      const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: '-25' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await preview.waitForCompletion()
      await waitFor(() => {
        const bar = screen.getByTestId('solids-workbench-pushpull-hint')
        expect(bar.className).toContain('workbench-confirm-bar--refusal')
      }, { timeout: 20_000 })
      expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toMatch(/DEFEATURE_UNSUPPORTED|solid|out-of-class/i)
    } finally {
      // WO FLAKE-1 audit (minor finding 3): a throw from waitForCompletion() or
      // the assertions above must still release the monkey-patched editFeature,
      // or a flipped run leaks the wrapper onto hooks().client.
      preview.restore()
    }

    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-pushpull-hint')).toBeNull())
  }, 30_000)
})

function installOvercutPreviewCompletionProbe(): {
  waitForCompletion(): Promise<void>
  restore(): void
} {
  const client = hooks().client
  const originalEditFeature = client.editFeature
  const delayMs = Number(process.env.FLAKE1_CONSTRUCTED_STARVATION_MS ?? '0')
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`FLAKE1_CONSTRUCTED_STARVATION_MS must be a finite non-negative number, got ${delayMs}`)
  }

  let completion: Promise<void> | undefined
  client.editFeature = (request) => {
    const result = originalEditFeature.call(client, request)
    if (request.kind !== 'faceOffset' || request.delta !== -25) return result

    const delayed = delayMs === 0
      ? result
      : result.then(async (value) => {
          console.info(`[FLAKE-1 constructed] delaying the resolved -25 preview by ${delayMs}ms`)
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
          return value
        })
    completion = delayed.then(() => undefined)
    return delayed
  }

  return {
    waitForCompletion: async () => {
      if (completion === undefined) {
        throw new Error('the -25 faceOffset preview was not dispatched')
      }
      await completion
    },
    restore: () => {
      client.editFeature = originalEditFeature
    },
  }
}
