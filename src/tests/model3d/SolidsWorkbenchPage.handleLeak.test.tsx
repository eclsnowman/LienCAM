// @vitest-environment jsdom
//
// WO INT-4A-R1 (R1.2): fullResync replayed a dirty body feature without
// disposing its PRIOR kernel BodyHandle -- a leak on every successful
// replay, and on a FAILED replay the stale pre-edit handle stayed in
// bodyHandlesRef, silently reachable from export/measure/UI as if it were
// current. Drives the real SolidsWorkbenchPage (worker faked at the facade
// boundary, per fakeGeomClient's own precedent) through a real edit whose
// kernel replay is made to fail, and asserts BOTH halves of the fix: the
// pre-edit handle was disposed (no leak) and no handle at all is left
// reachable for the feature afterward (no stale exportable handle). Must
// FAIL against pre-R1: pre-fix, the executor only ever calls
// bodyHandlesRef.current.set() on a SUCCESSFUL result, so a failed replay
// leaves the ORIGINAL handle sitting in the map, un-disposed, forever.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
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

describe('SolidsWorkbenchPage body-handle disposal on replay (WO INT-4A-R1.2)', () => {
  it('disposes the prior handle before a replay, and leaves no stale handle when the replay fails', async () => {
    // WO-035: the dialog's live preview also evaluates makeExtrude (scratch
    // candidates), and its Apply guard refuses a commit whose preview failed
    // -- so "fail every call after the first" would refuse Apply before the
    // replay path under test ever ran. The failure is ARMED from the test at
    // the exact moment the edit's accepted preview exists, so only the
    // COMMITTED replay fails.
    let extrudeCalls = 0
    let failNextExtrude = false
    const client = createFakeGeomClient({
      makeExtrudeImpl: (_req, mintHandle) => {
        extrudeCalls++
        if (failNextExtrude) {
          return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'forced replay failure' } }] }
        }
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })

    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    const originalHandle = hooks().getBodyHandle('F1')!

    // Edit the SAME feature -- this is a REPLAY. Wait for the edit's preview
    // to accept, then arm the fake so the NEXT call (the committed replay,
    // and only it) fails.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    commitField('extrude-distance', '20')
    await waitFor(() => expect(screen.getByTestId('extrude-preview-status').getAttribute('data-status')).toBe('ready'))
    const callsBeforeApply = extrudeCalls
    failNextExtrude = true
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(extrudeCalls).toBe(callsBeforeApply + 1))
    await waitFor(() => expect(client.disposedHandles).toContain(originalHandle))

    // No stale exportable handle survives the failed replay.
    expect(hooks().getBodyHandle('F1')).toBeUndefined()
    await expect(hooks().exportStep(['F1'])).rejects.toThrow()
  })
})
