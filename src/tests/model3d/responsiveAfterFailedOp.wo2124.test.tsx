// @vitest-environment jsdom
//
// WO-2124: after a geometry operation fails, the Model screen answers again at once.
//
// Measured in the running app (src/tests/evidence/WO-2124/): Shell failing on the Form stage 4b part left
// the screen with no frame for 13-23 s at a time. The page's JavaScript was idle; the frames were held by
// ~70 full-model renders the page queued in one task each time an operation landed or failed. The Model
// runtime paints synchronously on every scene edit (createDefaultSceneRuntime, sceneRuntime.ts: requestRender,
// setSectionableVisible, add/removeObject, register/unregisterSectionable and syncSectionGeometry each go
// through its one `render` closure), and three page loops made one or two such edits per body: the fullResync
// visibility reset, its post-pass hide sweep, and the overlay repaint.
//
// This pins the outcome on the page itself: a failed operation on a five-body history costs a handful of
// paints, not a burst that grows with the history; and the failure is still handled as before (the body stays
// as it was, the failure still shows on the feature row).

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { BodyHandle, OpResult, ShellRequest } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

const FAILED_THICKNESS = 9
const SHELL_REASON = 'shell kernel stopped while constructing inward offsets for 126 retained face(s)'

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

/** The fake runtime, painting where the real one paints: every scene edit below paints unless the render
 *  gate is closed (the fake's own requestRender/resumeRender already count theirs). */
function paintingRuntime(): { runtime: FakeSceneRuntime; paints: () => number } {
  const runtime = createFakeSceneRuntime()
  let editPaints = 0
  const painting = ['setSectionableVisible', 'addObject', 'removeObject', 'registerSectionable', 'unregisterSectionable', 'syncSectionGeometry'] as const
  for (const name of painting) {
    const original = runtime[name] as (...args: unknown[]) => void
    ;(runtime as unknown as Record<string, unknown>)[name] = (...args: unknown[]): void => {
      if (!runtime.isRenderSuspended()) editPaints++
      original(...args)
    }
  }
  return { runtime, paints: () => runtime.requestRenderCallCount + editPaints }
}

function shellResult(request: ShellRequest, mintHandle: () => BodyHandle): OpResult {
  if (request.thickness === FAILED_THICKNESS) {
    return { ok: false, diagnostics: [{ code: 'SHELL_FAILED', severity: 'error', params: { reason: SHELL_REASON } }] }
  }
  return { ok: true, body: mintHandle(), diagnostics: [] }
}

async function addShell(id: string, ownerId: string, thickness: number): Promise<void> {
  const face = 'FAKEDISPLAY:BOX:face#5'
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id,
    kind: 'feature',
    consumes: [ownerId],
    refs: [{ id: face, kind: 'face-set' }],
    payload: { opType: 'shell', ownerId, removeFaces: [face], thickness, name: `Shell ${id}` },
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

function rowStatus(id: string): string | null {
  return screen.getByTestId(`feature-row-${id}`).querySelector('[data-testid="feature-status-badge"]')?.getAttribute('data-status') ?? null
}

describe('WO-2124: the Model screen stays responsive after a failed operation', () => {
  it('a failed Shell on a five-body history paints a handful of times, and the body stays as it was', async () => {
    const { runtime, paints } = paintingRuntime()
    const client = createFakeGeomClient({ applyShellImpl: shellResult })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // a history of five bodies, each superseding the last (the stage 4b part had ten)
    await addShell('S2', 'F1', 1)
    await addShell('S3', 'S2', 1)
    await addShell('S4', 'S3', 1)
    await addShell('S5', 'S4', 1)
    await waitFor(() => expect(hooks().getBodyPresentationVisible('S5')).toBe(true))
    const leafHandle = hooks().getBodyHandle('S5')
    expect(leafHandle).not.toBeUndefined()

    const before = paints()
    await addShell('S6', 'S5', FAILED_THICKNESS)
    await waitFor(() => expect(hooks().scheduler.statusOf('S6')).toBe('failed'))
    await waitFor(() => expect(rowStatus('S6')).toBe('failed'))
    const landingPaints = paints() - before

    // failure handling unchanged: no body for the failed Shell, its owner still live and drawn,
    // the ancestors still hidden, and the failure named on its row
    expect(hooks().getBodyHandle('S6')).toBeUndefined()
    expect(hooks().getBodyHandle('S5')).toBe(leafHandle)
    expect(hooks().getBodyPresentationVisible('S5')).toBe(true)
    for (const ancestor of ['F1', 'S2', 'S3', 'S4']) expect(hooks().getBodyPresentationVisible(ancestor)).toBe(false)
    // WO-2868: the row names the failure in plain words, never the diagnostic code
    const shellTooltip = screen.getByTestId('feature-row-S6').querySelector('[data-testid="feature-status-badge"]')?.getAttribute('data-tooltip')
    expect(shellTooltip).toMatch(/^Shell/)
    expect(shellTooltip).not.toMatch(/SHELL_FAILED/)

    // before WO-2124 this landing painted the whole model once or twice per body: 27 paints here (6 with it)
    expect(landingPaints).toBeLessThanOrEqual(8)
  }, 60_000)
})
