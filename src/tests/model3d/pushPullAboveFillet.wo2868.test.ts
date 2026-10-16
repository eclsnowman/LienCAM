// @vitest-environment jsdom
//
// WO-2868 (sweep H2): a sketched box with a Fillet; the rollback marker moved
// above the Fillet, a Push/Pull added there, the marker rolled forward. The
// Fillet and every feature after it must rebuild on the moved face - the same
// edge, the same radius - instead of failing with a bare KERNEL_OP_FAILED.
// Where the upstream change truly removes the filleted edge, the Fillet row
// says so in plain words and nothing after it pretends to have applied.
//
// Driven through the REAL Model screen (SolidsWorkbenchPage) on the REAL
// in-process kernel: the box is a sketch + Extrude dialog, the Fillet and
// Chamfer go through their dialogs with a viewport edge pick, the marker moves
// with the tree's own up/down buttons and the Push/Pull goes through its
// button, face pick, typed distance, preview (Enter) and Apply (Enter). The
// kernel is read only to MEASURE a result.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')

const consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines.length = 0
  const original = useCamStore.getState().addConsoleEvent
  useCamStore.getState().addConsoleEvent = ((...args: Parameters<typeof original>) => {
    consoleLines.push(JSON.stringify(args))
  }) as typeof original
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

const status = (id: string) => `${id}: ${hooks().scheduler.statusOf(id)} ${JSON.stringify(hooks().scheduler.diagnosticsOf(id))}`

/** Sketch 40 x 20 at x 10, Extrude 20: the box x 10..50, y 0..20, z 0..20. */
async function mountBox(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
  return runtime
}

/** Fillet or Chamfer one edge through its dialog: arm, pick by ray, size, Apply. */
async function dressUp(runtime: FakeSceneRuntime, kind: 'fillet' | 'chamfer', ray: { x: number; y: number; z: number }, size: number): Promise<string> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId(`workbench-${kind}`))
  runtime.rayOverride = { origin: { x: ray.x, y: ray.y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(canvas())
  await waitFor(() => expect(screen.getByTestId(`${kind}-edge-count`).textContent).toMatch(/1 edge/))
  commitField(kind === 'fillet' ? 'fillet-radius' : 'chamfer-distance', String(size))
  await waitFor(() => expect(screen.getByTestId(`${kind}-preview-status`).getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(hooks().getBodyHandle(id!)).not.toBeUndefined()
  }, { timeout: 30_000 })
  return id!
}

/** Push/Pull through the Model screen: button, a pick on the face, typed
 *  distance, Enter to preview, Enter to apply. */
async function pushPull(runtime: FakeSceneRuntime, aim: { x: number; y: number; z: number }, delta: number): Promise<string> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  runtime.rayOverride = { origin: { x: aim.x, y: aim.y, z: aim.z + 0.5 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
  const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
  const refused = () => hint()?.className.includes('refusal') === true
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') !== null || refused()).toBe(true), { timeout: 30_000 })
  expect(refused(), `pick refused: ${hint()?.textContent}`).toBe(false)
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    const g = hooks().getPushPullTransactionState().gesture
    expect(!g.inFlight && (g.previewHandle !== null || refused())).toBe(true)
  }, { timeout: 60_000 })
  expect(refused(), `preview refused: ${hint()?.textContent}`).toBe(false)
  fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') === null || refused()).toBe(true), { timeout: 60_000 })
  expect(refused(), `apply refused: ${hint()?.textContent}`).toBe(false)
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(hooks().scheduler.statusOf(id!), status(id!)).toBe('ok')
  }, { timeout: 60_000 })
  return id!
}

async function markerUp(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const marker = JSON.stringify(hooks().dag.getRollbackMarker())
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(JSON.stringify(hooks().dag.getRollbackMarker())).not.toBe(marker))
  }
}
async function markerToEnd(): Promise<void> {
  while (hooks().dag.getRollbackMarker().kind !== 'end') {
    const marker = JSON.stringify(hooks().dag.getRollbackMarker())
    fireEvent.click(screen.getByTestId('rollback-marker-down'))
    await waitFor(() => expect(JSON.stringify(hooks().dag.getRollbackMarker())).not.toBe(marker))
  }
}

const PI = Math.PI
// r2 fillet along a 40 mm edge removes (r^2 - pi r^2 / 4) * 40.
const FILLET_R2_ALONG_40 = (4 - PI) * 40
// 1 mm chamfer along a 40 mm edge removes (d^2 / 2) * 40.
const CHAMFER_1_ALONG_40 = 0.5 * 40

describe('WO-2868 a Push/Pull inserted above a Fillet by rollback', () => {
  it('top face +2 above the Fillet: the Fillet and the Chamfer after it rebuild on the moved face', async () => {
    const runtime = await mountBox()
    // top edge y 0, x 10..50 - midpoint (30, 0, 20)
    const fillet = await dressUp(runtime, 'fillet', { x: 30, y: 0, z: 20 }, 2)
    // the opposite top edge y 20, x 10..50 - midpoint (30, 20, 20)
    const chamfer = await dressUp(runtime, 'chamfer', { x: 30, y: 20, z: 20 }, 1)
    expect(await volumeOf(chamfer)).toBeCloseTo(16000 - FILLET_R2_ALONG_40 - CHAMFER_1_ALONG_40, 1)

    // marker above the Fillet: after F1, the box
    await markerUp(2)
    expect(hooks().dag.isRolledBack(fillet)).toBe(true)
    expect(hooks().dag.isRolledBack(chamfer)).toBe(true)
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // the top face, well away from the edges
    const pp = await pushPull(runtime, { x: 30, y: 10, z: 20 }, 2)
    expect(await volumeOf(pp)).toBeCloseTo(40 * 20 * 22, 1)

    await markerToEnd()
    await waitFor(() => {
      expect(hooks().scheduler.statusOf(fillet), status(fillet)).toBe('ok')
      expect(hooks().scheduler.statusOf(chamfer), status(chamfer)).toBe('ok')
    }, { timeout: 60_000 })
    // the same edge, the same radius - on the 22 mm-tall box
    await waitFor(() => expect(hooks().getBodyHandle(chamfer)).not.toBeUndefined(), { timeout: 30_000 })
    expect(await volumeOf(fillet)).toBeCloseTo(40 * 20 * 22 - FILLET_R2_ALONG_40, 1)
    expect(await volumeOf(chamfer)).toBeCloseTo(40 * 20 * 22 - FILLET_R2_ALONG_40 - CHAMFER_1_ALONG_40, 1)
    // the Chamfer is the one body on screen
    expect(screen.getByTestId(`body-row-${chamfer}`)).toBeTruthy()
    expect(screen.queryByTestId(`body-row-${pp}`)).toBeNull()
    // Undo walks back the marker moves, then the Push/Pull itself, and the
    // Fillet has its box back.
    for (let i = 0; i < 6 && hooks().dag.has(pp); i++) {
      const marker = JSON.stringify(hooks().dag.getRollbackMarker())
      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(() => expect(!hooks().dag.has(pp) || JSON.stringify(hooks().dag.getRollbackMarker()) !== marker).toBe(true))
    }
    expect(hooks().dag.has(pp)).toBe(false)
    expect(hooks().dag.getNode(fillet)?.consumes).toEqual(['F1'])
    expect(hooks().dag.getNode(fillet)?.payload.ownerId).toBe('F1')
  }, 240_000)

  it('a Fillet inserted above on the same edge takes the edge away: the later Fillet says so in plain words, and an edit of it never reports applied', async () => {
    const runtime = await mountBox()
    const fillet = await dressUp(runtime, 'fillet', { x: 30, y: 0, z: 20 }, 2)
    await markerUp(1)
    expect(hooks().dag.isRolledBack(fillet)).toBe(true)
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    const first = await dressUp(runtime, 'fillet', { x: 30, y: 0, z: 20 }, 1)
    expect(hooks().dag.getNode(fillet)?.payload.ownerId).toBe(first)

    consoleLines.length = 0
    await markerToEnd()
    await waitFor(() => expect(hooks().scheduler.statusOf(fillet), status(fillet)).toBe('failed'), { timeout: 60_000 })
    const diag = hooks().scheduler.diagnosticsOf(fillet)
    expect(diag.map((d) => d.code), status(fillet)).toEqual(['REFERENCE_UNRESOLVED'])
    // the tree row carries the reason in plain words, not the code
    const badge = () => screen.getByTestId(`feature-row-${fillet}`).querySelector('[data-testid="feature-status-badge"]')
    await waitFor(() => expect(badge()?.getAttribute('data-status')).toBe('failed'))
    expect(badge()?.getAttribute('data-tooltip')).toBe('The picked edge or face is no longer on the model - pick it again')
    // and rolling forward said so once in the console, naming the Fillet
    await waitFor(() => expect(consoleLines.filter((line) => /refused/.test(line))).toHaveLength(1))
    const refusedLine = JSON.parse(consoleLines.find((line) => /refused/.test(line))!)[0] as { severity: string; message: string }
    expect(refusedLine.severity).toBe('error')
    expect(refusedLine.message).toMatch(new RegExp(`${fillet}.* refused: the picked edge or face is no longer on the model - pick it again$`))
    expect(refusedLine.message).not.toMatch(/REFERENCE_UNRESOLVED/)
    expect(consoleLines.filter((line) => /applied/i.test(line))).toEqual([])

    // Editing it: the preview refuses in the same words and Apply stays off, so
    // nothing can log "applied" for a Fillet that cannot build.
    consoleLines.length = 0
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${fillet}`))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('fillet-radius')).toBeTruthy())
    commitField('fillet-radius', '1.5')
    const preview = () => screen.getByTestId('fillet-preview-status')
    await waitFor(() => expect(preview().getAttribute('data-status')).toBe('refused'), { timeout: 30_000 })
    expect(preview().textContent).toMatch(/no longer on the model - pick it again/)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(consoleLines.filter((line) => /applied/i.test(line))).toEqual([])
    expect(hooks().scheduler.statusOf(fillet)).toBe('failed')
  }, 240_000)
})
