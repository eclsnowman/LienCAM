// @vitest-environment jsdom
//
// V08 walkthrough (10-09): Edit model on the shipped Lobed knob, edit its Form and Finish while the
// model's first rebuild was still running. When the second rebuild landed, the knob's body came back
// with its Bodies row unticked and the view empty, though nobody had hidden it.
//
// Cause: Finish starts a rebuild that resets every body's visibility, then waits for the running
// rebuild to stop. The stopped rebuild still ran its end-of-pass sweep, which hid every body that had
// no finished result yet - the final body among them - and the next rebuild never showed it again.
//
// This pins the outcome: a rebuild that interrupts an earlier one ends with the final body shown.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { ExtrudeRequest, OpResult } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

describe('V08: a rebuild that interrupts an earlier one keeps the final body on screen', () => {
  it('the final body is visible after the second rebuild lands', async () => {
    const client = createFakeGeomClient({ applyShellImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) })
    const extrude = client.makeExtrude.bind(client)
    // One extrude call can be held open, standing in for the long first rebuild of the knob.
    let hold: { release: () => void } | null = null
    let held = false
    client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
      if (hold !== null && !held) {
        held = true
        await new Promise<void>((resolve) => { hold!.release = resolve })
      }
      return extrude(req)
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => createFakeSceneRuntime()} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // The first rebuild: a new Shell on F1 is built for the first time, and F1's extrude is held.
    hold = { release: () => undefined }
    const face = 'FAKEDISPLAY:BOX:face#5'
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'S2',
      kind: 'feature',
      consumes: ['F1'],
      refs: [{ id: face, kind: 'face-set' }],
      payload: { opType: 'shell', ownerId: 'F1', removeFaces: [face], thickness: 1, name: 'Shell S2' },
    }))
    const first = hooks().fullResync(['F1'])
    await waitFor(() => expect(held).toBe(true))
    // Finish-like edit while it runs: a second rebuild of the same chain.
    const second = hooks().fullResync(['F1'])
    hold.release()
    expect((await first).cancelled).toBe(true)
    expect((await second).cancelled).toBe(false)

    await waitFor(() => expect(hooks().getBodyHandle('S2')).not.toBeUndefined())
    const body = hooks().getExportBodies?.().find((b) => b.id === 'S2')
    expect(body?.visible).toBe(true)
    expect(hooks().getBodyPresentationVisible('S2')).toBe(true)
    // the Shell's input stays hidden behind it, as after any rebuild
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
  }, 60_000)
})
