// @vitest-environment jsdom
//
// WO-3000: the Model page follows the agent's edits, and the agent's Undo / Redo obey the page's
// guards. Drives the REAL page (real FeatureDag, CommandHistory, ParameterTable) through the REAL
// agent entry point (modelCommands.run, the route window.__liencam.model calls).
//
//   T1 model.parameter.set repaints the Parameters table with no user event.
//   T2 model.undo / model.redo repaint it the same way.
//   T3 a pending Resize Hole adoption: model.undo / model.redo are refused with the page's own
//      sentence and the history and the DAG are untouched; after the adoption settles, undo works.
//   T4 the page's own Undo button is unchanged (SolidsWorkbenchPage.workbenchUndo stays green).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { FaceEditRequest, OpResult } from '../../geom/geom-service'
import { modelCommands } from '../../lib/agent/commands'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function harness(): { createSceneRuntime: () => FakeSceneRuntime; runtime: () => FakeSceneRuntime } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as FakeSceneRuntime }
}

async function bootReady(createClient: () => GeomClient, createSceneRuntime: () => FakeSceneRuntime): Promise<void> {
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
}

function commitNumericField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('WO-3000 T1-T2: the Parameters table follows the agent', () => {
  it('model.parameter.set, model.undo and model.redo repaint the table with no user event', async () => {
    await bootReady(createFakeGeomClient, harness().createSceneRuntime)
    expect(screen.queryByTestId('param-expression-width')).toBeNull()

    const set = await modelCommands.run('model.parameter.set', { name: 'width', expression: '40' })
    expect(set.ok).toBe(true)
    await waitFor(() => expect((screen.getByTestId('param-expression-width') as HTMLInputElement).value).toBe('40'))
    expect(screen.getByTestId('param-value-width').textContent).toContain('40')

    const edit = await modelCommands.run('model.parameter.set', { name: 'width', expression: '55' })
    expect(edit.ok).toBe(true)
    await waitFor(() => expect((screen.getByTestId('param-expression-width') as HTMLInputElement).value).toBe('55'))

    const undone = await modelCommands.run('model.undo')
    expect(undone.ok).toBe(true)
    await waitFor(() => expect((screen.getByTestId('param-expression-width') as HTMLInputElement).value).toBe('40'))

    const redone = await modelCommands.run('model.redo')
    expect(redone.ok).toBe(true)
    await waitFor(() => expect((screen.getByTestId('param-expression-width') as HTMLInputElement).value).toBe('55'))

    // Undo twice: the parameter is gone from the table again.
    await modelCommands.run('model.undo')
    await modelCommands.run('model.undo')
    await waitFor(() => expect(screen.queryByTestId('param-expression-width')).toBeNull())
  }, 60_000)
})

describe('WO-3000 T3: the agent Undo / Redo obey the pending-adoption guard', () => {
  it('refuses with the page sentence during a held Resize Hole adoption, then undoes after it settles', async () => {
    const h = harness()
    const real = createLocalGeomService()
    let acceptedPreviewBody: OpResult['body']
    let gateAdoption = false
    let releaseAdoption: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter' && result.ok) acceptedPreviewBody = result.body
        return result
      },
      tessellate: (body, quality) => {
        if (gateAdoption && body === acceptedPreviewBody) {
          gateAdoption = false
          return new Promise((resolve, reject) => {
            releaseAdoption = () => { void real.tessellate(body, quality).then(resolve, reject) }
          })
        }
        return real.tessellate(body, quality)
      },
    }
    await bootReady(() => client, h.createSceneRuntime)

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitNumericField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-hole'))
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitNumericField('hole-diameter', '6')
    commitNumericField('hole-blind-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i), { timeout: 20_000 })
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })

    gateAdoption = true
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('solids-workbench-root').getAttribute('data-resize-hole-adoption-pending')).toBe('true'))

    const historyHeld = hooks().history.serialize()
    const orderHeld = hooks().dag.featureOrder()
    const undo = await modelCommands.run('model.undo')
    expect(undo).toMatchObject({ ok: false, code: 'refused' })
    if (!undo.ok) expect(undo.message).toBe('Feature editing is unavailable while the accepted Resize Hole is being applied.')
    const redo = await modelCommands.run('model.redo')
    expect(redo).toMatchObject({ ok: false, code: 'refused' })
    expect(hooks().history.serialize()).toEqual(historyHeld)
    expect(hooks().dag.featureOrder()).toEqual(orderHeld)

    releaseAdoption?.()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-root').getAttribute('data-resize-hole-adoption-pending')).not.toBe('true'), { timeout: 20_000 })
    const resizeId = (): string | undefined => hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    await waitFor(() => expect(resizeId()).not.toBeUndefined(), { timeout: 20_000 })

    const after = await modelCommands.run('model.undo')
    expect(after.ok).toBe(true)
    await waitFor(() => expect(resizeId()).toBeUndefined())
  }, 180_000)
})

describe('WO-3000 T5: the page repaint never rewrites the result the agent is handed', () => {
  it('set width=40 returns ok, 1/0 returns failed with PARAM_DIVISION_BY_ZERO, undo reports the settled status', async () => {
    await bootReady(createFakeGeomClient, harness().createSceneRuntime)

    const set = await modelCommands.run('model.parameter.set', { name: 'width', expression: '40' })
    expect(set.ok).toBe(true)
    if (set.ok) {
      expect((set.value as { status: string }).status).toBe('ok')
      expect(set.status['param:width']).toBe('ok')
    }

    const bad = await modelCommands.run('model.parameter.set', { name: 'width', expression: '1/0' })
    expect(bad.ok).toBe(true)
    if (bad.ok) {
      expect((bad.value as { status: string }).status).toBe('failed')
      expect(bad.diagnostics.some((d) => d.code === 'PARAM_DIVISION_BY_ZERO')).toBe(true)
    }

    const undone = await modelCommands.run('model.undo')
    expect(undone.ok).toBe(true)
    if (undone.ok) {
      expect(undone.status['param:width']).toBe('ok')
      expect(undone.diagnostics).toEqual([])
    }
    // The repaint itself still follows afterwards.
    await waitFor(() => expect((screen.getByTestId('param-expression-width') as HTMLInputElement).value).toBe('40'))
  }, 60_000)
})
