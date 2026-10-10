// @vitest-environment jsdom
//
// WO UI-6X: real SolidsWorkbenchPage command-surface coverage for the complete
// rail -> recognition picker -> apply -> tree/body -> undo -> redo chain.
// Actions are driven through rendered controls; assertions read the DAG,
// scheduler, kernel-handle seam, request spy, body-row testids, and console.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import {
  DEFEATURE_CLASSES,
  DEFEATURE_CLASS_DISPOSITIONS,
} from '../../components/model3d/dialogs/DefeatureDialog'
import type { BodyHandle, DefeatureRequest, DefeatureResult, FeatureClass, FeatureVerdict } from '../../geom/geom-service'
import { cornerRefusalReason } from '../../geom/worker/defeature'
import { useCamStore } from '../../store'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let workbenchMessages: string[] = []

beforeEach(() => {
  workbenchMessages = []
  // The Node invocation used by this Windows test fleet exposes a stub
  // localStorage without setItem. Replace only the action function read by
  // this mounted page; production routing remains covered by store tests.
  useCamStore.getState().addConsoleEvent = (event) => { workbenchMessages.push(event.message) }
})

afterEach(() => {
  cleanup()
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function buildBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  expect(screen.getByTestId('extrude-profile-select')).toBeTruthy()
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

const FILLET: FeatureVerdict = {
  featureKey: 'blend-radius-2',
  featureClass: 'filletPlanar',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:blend'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:side'],
  params: { radius: 2 },
}

const CHAMFER: FeatureVerdict = {
  featureKey: 'chamfer-distance-1',
  featureClass: 'chamferPlanar',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:chamfer'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:end'],
  params: { distance: 1 },
}

const REFUSED: FeatureVerdict = {
  featureKey: 'curved-corner-3',
  featureClass: 'filletCurvedCorner',
  removable: false,
  refuseReason: 'corner blend does not have a closed analytic support set',
  effect: 'add',
  faceIds: ['F1:FACE:corner'],
  neighbourIds: [],
  params: { radius: 3 },
}

/** GEO-21-R1 (BK-63): a chamferPlanar band declined because its corner untrim could
 *  not be built. A chamferPlanar decline is a case this dialog never carried a
 *  fixture for, and unlike REFUSED above (filletCurvedCorner, a class
 *  DEFEATURE_CLASS_DISPOSITIONS declines wholesale) this one is a per-verdict engine
 *  reason on a class the dialog otherwise offers, so it exercises the engine-reason
 *  path specifically.
 *
 *  The string is BUILT BY the engine's own mapping rather than pasted, so it cannot
 *  drift into asserting text the engine can no longer emit. It did: GEO-21 pinned
 *  "shared corner facet ... where three fillets/chamfers meet" here, and R1 both
 *  makes those bands removable and (audit MAJOR 2) stops claiming that topology for
 *  a generic construction failure — so that fixture was rendering a dead string. The
 *  box-corner bands on the real plate now HEAL; what still declines is a corner the
 *  construction genuinely cannot build, which is what this fixture carries. */
const CORNER_REFUSED: FeatureVerdict = {
  featureKey: 'band:chamferPlanar:-39.75:-39.75:-7',
  featureClass: 'chamferPlanar',
  removable: false,
  refuseReason: cornerRefusalReason('hostLineParallelToEndFace', "the hosts' sharp line runs parallel to end face @(-39.6667,-39.6667,-0.3333), so it never reaches it"),
  effect: 'add',
  faceIds: ['F1:FACE:band'],
  neighbourIds: ['F1:FACE:wallA', 'F1:FACE:wallB'],
  params: { width: 0.7071 },
}

async function mount(client: FakeGeomClient, runtime?: FakeSceneRuntime): Promise<void> {
  render(<SolidsWorkbenchPage
    createClient={() => client}
    createSceneRuntime={runtime === undefined ? fakeCreateSceneRuntime : () => runtime}
  />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
}

function successfulDefeature(req: DefeatureRequest, body: BodyHandle): DefeatureResult {
  return {
    ok: true,
    body,
    diagnostics: [],
    report: {
      requested: req.featureKeys?.length ?? 0,
      healed: req.featureKeys?.length ?? 0,
      failed: 0,
      refused: 0,
      totalVolumeDelta: 100,
      items: (req.featureKeys ?? []).map((featureKey) => ({
        featureKey,
        featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
        healed: true,
        volumeDelta: 100,
        effect: 'add',
      })),
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function latestBodyVisibility(runtime: FakeSceneRuntime, bodyId: string): boolean | undefined {
  return runtime.setSectionableVisibleCalls
    .filter(({ mesh }) => mesh.userData.workbenchFeatureId === bodyId)
    .at(-1)?.visible
}

describe('SolidsWorkbenchPage defeature (WO UI-6X)', () => {
  it('keeps the rail verb disabled without a live body and names why', async () => {
    await mount(createFakeGeomClient())
    const button = screen.getByTestId('workbench-defeature') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('data-tooltip')).toBe('Defeature - create or import a live body first')
  })

  it('accepts every coherent engine-recognized group and declines only standalone slivers', () => {
    const dispositions = Object.entries(DEFEATURE_CLASS_DISPOSITIONS) as [FeatureClass, (typeof DEFEATURE_CLASS_DISPOSITIONS)[FeatureClass]][]
    expect(dispositions.map(([featureClass]) => featureClass).sort()).toEqual([
      'blindHole',
      'boss',
      'chamferPlanar',
      'counterboreStack',
      'engravedText',
      'filletCurvedCorner',
      'filletPlanar',
      'pocket',
      'sliver',
      'throughHole',
    ])
    expect([...DEFEATURE_CLASSES].sort()).toEqual([
      'blindHole',
      'boss',
      'chamferPlanar',
      'counterboreStack',
      'engravedText',
      'filletCurvedCorner',
      'filletPlanar',
      'pocket',
      'throughHole',
    ])
    const declined = dispositions.filter(([, disposition]) => disposition.kind === 'decline')
    expect(declined).toHaveLength(1)
    for (const [featureClass, disposition] of declined) {
      expect(disposition.kind === 'decline' ? disposition.reason : '').toContain(featureClass)
    }
  })

  it('keeps every recognized class in the picker and names every excluded class as declined', async () => {
    const domainVerdicts = (Object.keys(DEFEATURE_CLASS_DISPOSITIONS) as FeatureClass[]).map((featureClass, index): FeatureVerdict => ({
      featureKey: `domain-${featureClass}`,
      featureClass,
      removable: true,
      effect: 'add',
      faceIds: [`F1:FACE:${index}`],
      neighbourIds: [],
      params: { index },
    }))
    const client = createFakeGeomClient({ recognizeFeaturesResult: domainVerdicts })
    await mount(client)
    await buildBody()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())

    for (const verdict of domainVerdicts) {
      const row = screen.getByTestId(`defeature-row-${verdict.featureKey}`)
      const check = screen.getByTestId(`defeature-check-${verdict.featureKey}`) as HTMLInputElement
      const disposition = DEFEATURE_CLASS_DISPOSITIONS[verdict.featureClass]
      expect(row).toBeTruthy()
      expect(check.disabled).toBe(disposition.kind === 'decline')
      if (disposition.kind === 'decline') {
        expect(row.textContent).toContain(`Declined: ${disposition.reason}`)
      }
    }
  })

  it('states zero removable features plainly and disables every refused row with its reason', async () => {
    const client = createFakeGeomClient({ recognizeFeaturesResult: [REFUSED] })
    await mount(client)
    await buildBody()

    const button = screen.getByTestId('workbench-defeature') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('defeature-empty').textContent).toMatch(/No removable face groups/))

    const refusedCheck = screen.getByTestId(`defeature-check-${REFUSED.featureKey}`) as HTMLInputElement
    expect(refusedCheck.disabled).toBe(true)
    expect(screen.getByTestId(`defeature-row-${REFUSED.featureKey}`).getAttribute('data-tooltip')).toBe(REFUSED.refuseReason)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  // GEO-21 (BK-63): the 12 box-corner chamfer bands decline with a NEW engine
  // reason. This asserts the reason a user actually reads, on the real rendering
  // path, without touching DefeatureDialog.tsx (live wo/UI-56 collision).
  it('renders the GEO-21-R1 corner-untrim decline verbatim on a chamferPlanar row', async () => {
    const client = createFakeGeomClient({ recognizeFeaturesResult: [FILLET, CORNER_REFUSED] })
    await mount(client)
    await buildBody()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())

    const row = screen.getByTestId(`defeature-row-${CORNER_REFUSED.featureKey}`)
    const check = screen.getByTestId(`defeature-check-${CORNER_REFUSED.featureKey}`) as HTMLInputElement
    // unpickable, and it SAYS why — both inline and as the row tooltip.
    expect(check.disabled).toBe(true)
    expect(row.getAttribute('data-tooltip')).toBe(CORNER_REFUSED.refuseReason)
    expect(row.textContent).toContain(`Declined: ${CORNER_REFUSED.refuseReason}`)
    // the decline says WHERE and what it means for the user, and names the failing
    // construction so a bug report is actionable — without kernel internals.
    expect(row.textContent).toMatch(/@\(-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?\)/)
    expect(row.textContent).toMatch(/cannot be removed on its own yet/)
    expect(row.textContent).toMatch(/hostLineParallelToEndFace/)
    expect(row.textContent).not.toMatch(/untrim|planar-neighbour|webassembly/i)
    // ...and it does NOT strand the dialog: the removable fillet is still pickable.
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByTestId('defeature-empty')).toBeNull()
  })

  it('drives rail -> picker -> selected accept mask -> one body -> undo -> redo with authoritative readback after every input', async () => {
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET, CHAMFER, REFUSED],
      measureResult: { kind: 'volume', value: 8000 },
      defeatureBatchImpl: (req, mintHandle) => ({
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        report: {
          requested: req.featureKeys?.length ?? 0,
          healed: req.featureKeys?.length ?? 0,
          failed: 0,
          refused: 0,
          totalVolumeDelta: 100,
          items: (req.featureKeys ?? []).map((featureKey) => ({
            featureKey,
            featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
            healed: true,
            volumeDelta: 100,
            effect: 'add',
          })),
        },
      }),
    })
    await mount(client)
    await buildBody()
    const originalHandle = hooks().getBodyHandle('F1')
    expect(originalHandle).not.toBeUndefined()
    expect(screen.getAllByTestId(/^body-row-/)).toHaveLength(1)

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).checked).toBe(true)
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    const acceptedCallsBeforeApply = client.defeatureBatchCalls.filter((request) => request.featureId === 'F2')
    expect(acceptedCallsBeforeApply).toHaveLength(1)
    expect(acceptedCallsBeforeApply[0]).toMatchObject({
      featureId: 'F2',
      featureKeys: [FILLET.featureKey],
    })

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    // Apply adopts the exact accepted scratch candidate. It must not enter
    // defeatureBatch a second time and risk publishing geometry that differs
    // from the preview the user accepted.
    expect(client.defeatureBatchCalls.filter((request) => request.featureId === 'F2')).toHaveLength(1)
    expect(acceptedCallsBeforeApply[0]?.query).toBeUndefined()
    expect(hooks().dag.getNode('F2')?.consumes).toEqual(['F1'])
    expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey], name: 'Delete 1 fillet',
    })
    expect(screen.getByTestId('feature-row-F2').textContent).toMatch(/Delete 1 fillet/)
    await waitFor(() => expect(screen.getAllByTestId(/^body-row-/)).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
    expect(screen.getByTestId('body-row-F2')).toBeTruthy()
    expect(client.disposedHandles).toContain(originalHandle)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull())
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(screen.getAllByTestId(/^body-row-/)).toHaveLength(1)
    expect(screen.getByTestId('body-row-F1')).toBeTruthy()
    const restored = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    expect(restored).toEqual({ kind: 'volume', value: 8000 })

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(screen.getByTestId('feature-row-F2').textContent).toMatch(/Delete 1 fillet/)
    expect(screen.getAllByTestId(/^body-row-/)).toHaveLength(1)
    expect(client.defeatureBatchCalls.at(-1)?.featureKeys).toEqual([FILLET.featureKey])
  })

  it('refuses a partial preview by name and keeps the prior body live without authoring a node', async () => {
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET],
      defeatureBatchImpl: (_req, mintHandle) => ({
            ok: true,
            body: mintHandle(),
            diagnostics: [],
            report: {
              requested: 1, healed: 0, failed: 1, refused: 0, totalVolumeDelta: 0,
              items: [{
                featureKey: FILLET.featureKey,
                featureClass: 'filletPlanar',
                healed: false,
                reason: 'edge blend crossed seam',
                effect: 'add',
              }],
            },
          }),
    })
    await mount(client)
    await buildBody()
    const inputHandle = hooks().getBodyHandle('F1')

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('failed'))
    expect(screen.getByTestId('defeature-preview-status').textContent).toContain('edge blend crossed seam')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect(hooks().getBodyHandle('F1')).toBe(inputHandle)
    expect(screen.getByTestId('body-row-F1')).toBeTruthy()
    expect(screen.queryByTestId('body-row-F2')).toBeNull()
    expect(client.disposedHandles.some((handle) => handle !== inputHandle)).toBe(true)
  })

  it('shows a named healed-preview failure and keeps Apply disabled', async () => {
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET],
      defeatureBatchImpl: (_req) => ({
        ok: false,
        diagnostics: [{
          code: 'DEFEATURE_UNSUPPORTED',
          severity: 'error',
          params: { reason: 'heal did not reach a watertight solid' },
        }],
      }),
    })
    await mount(client)
    await buildBody()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))

    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('failed'))
    expect(screen.getByTestId('defeature-preview-status').textContent).toContain('heal did not reach a watertight solid')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
  })

  it('Cancel after a ready create preview restores the source presentation without authoring history', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET],
      defeatureBatchImpl: (req, mintHandle) => successfulDefeature(req, mintHandle()),
    })
    await mount(client, runtime)
    await buildBody()
    const sourceHandle = hooks().getBodyHandle('F1')
    const dagBefore = hooks().dag.serialize()
    const historyBefore = hooks().history.serialize()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(latestBodyVisibility(runtime, 'F1')).toBe(false)
    expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(true)

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('defeature-command-card')).toBeNull())
    await waitFor(() => expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(false))
    expect(latestBodyVisibility(runtime, 'F1')).toBe(true)
    expect(hooks().getBodyHandle('F1')).toBe(sourceHandle)
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expect(hooks().history.serialize()).toEqual(historyBefore)
  })

  it('Cancel after a ready edit preview restores the authored body and leaves its node/history untouched', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET, CHAMFER],
      defeatureBatchImpl: (req, mintHandle) => successfulDefeature(req, mintHandle()),
    })
    await mount(client, runtime)
    await buildBody()
    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    const authoredHandle = hooks().getBodyHandle('F2')
    const dagBefore = hooks().dag.serialize()
    const payloadBefore = structuredClone(hooks().dag.getNode('F2')?.payload)
    const historyBefore = hooks().history.serialize()
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(latestBodyVisibility(runtime, 'F2')).toBe(false)
    expect(hooks().hasSceneMesh('__defeature-preview-source__')).toBe(true)
    expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(true)

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('defeature-command-card')).toBeNull())
    await waitFor(() => expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(false))
    expect(hooks().hasSceneMesh('__defeature-preview-source__')).toBe(false)
    expect(latestBodyVisibility(runtime, 'F2')).toBe(true)
    expect(hooks().getBodyHandle('F2')).toBe(authoredHandle)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(payloadBefore)
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expect(hooks().history.serialize()).toEqual(historyBefore)
  })

  it('a superseded deferred preview cannot repaint or be adopted after a newer selection', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET, CHAMFER],
      defeatureBatchImpl: (req, mintHandle) => successfulDefeature(req, mintHandle()),
    })
    const runDefeature = client.defeatureBatch.bind(client)
    const gates = [deferred<void>(), deferred<void>()]
    let started = 0
    client.defeatureBatch = async (req) => {
      const gate = gates[started++]
      if (gate === undefined) throw new Error('unexpected extra Defeature evaluation')
      await gate.promise
      return runDefeature(req)
    }
    await mount(client, runtime)
    await buildBody()
    const historyBefore = hooks().history.serialize()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(started).toBe(1))
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))

    gates[0].resolve(undefined)
    await waitFor(() => expect(started).toBe(2))
    expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(false)
    expect(latestBodyVisibility(runtime, 'F1')).not.toBe(false)
    expect(hooks().history.serialize()).toEqual(historyBefore)

    gates[1].resolve(undefined)
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(client.defeatureBatchCalls.at(-1)?.featureKeys).toEqual([FILLET.featureKey, CHAMFER.featureKey])
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.featureKeys).toEqual([FILLET.featureKey, CHAMFER.featureKey]))
    expect(client.defeatureBatchCalls).toHaveLength(2)
  })

  it('a deferred preview completing after close cannot repaint or author a feature', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET],
      defeatureBatchImpl: (req, mintHandle) => successfulDefeature(req, mintHandle()),
    })
    const runDefeature = client.defeatureBatch.bind(client)
    const gate = deferred<void>()
    let started = false
    client.defeatureBatch = async (req) => {
      started = true
      await gate.promise
      return runDefeature(req)
    }
    await mount(client, runtime)
    await buildBody()
    const sourceHandle = hooks().getBodyHandle('F1')
    const dagBefore = hooks().dag.serialize()
    const historyBefore = hooks().history.serialize()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(started).toBe(true))
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('defeature-command-card')).toBeNull())

    gate.resolve(undefined)
    await waitFor(() => expect(client.defeatureBatchCalls).toHaveLength(1))
    await waitFor(() => expect(hooks().hasSceneMesh('__defeature-preview__')).toBe(false))
    expect(latestBodyVisibility(runtime, 'F1')).not.toBe(false)
    expect(hooks().getBodyHandle('F1')).toBe(sourceHandle)
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expect(hooks().history.serialize()).toEqual(historyBefore)
  })

  // BK-174 / UI-107: Edit reconstructs and recognizes the true pre-feature
  // body, then adopts the accepted candidate into the same node exactly once.
  it('BK-174: tree-menu Edit... reconstructs the pre-feature body, restores the stored mask, and adopts into the same node', async () => {
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET, CHAMFER],
      defeatureBatchImpl: (req, mintHandle) => ({
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        report: {
          requested: req.featureKeys?.length ?? 0,
          healed: req.featureKeys?.length ?? 0,
          failed: 0,
          refused: 0,
          totalVolumeDelta: 100,
          items: (req.featureKeys ?? []).map((featureKey) => ({
            featureKey,
            featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
            healed: true,
            volumeDelta: 100,
            effect: 'add',
          })),
        },
      }),
    })
    const recognizedHandles: BodyHandle[] = []
    const recognizeFeatures = client.recognizeFeatures.bind(client)
    client.recognizeFeatures = async (handle) => {
      recognizedHandles.push(handle)
      return recognizeFeatures(handle)
    }
    await mount(client)
    await buildBody()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    // Direct creation starts empty; pick FILLET for the create-time mask.
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    const liveDefeatureBody = hooks().getBodyHandle('F2')
    expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey],
    })

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)

    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    // Create recognition reads the live owner. Edit recognition must not read
    // the already-healed F2 body; it reads a scratch replay of F1 instead.
    expect(recognizedHandles.at(-1)).not.toBe(liveDefeatureBody)
    // Prefilled from the STORED accept mask over the freshly re-recognized set.
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`) as HTMLInputElement).checked).toBe(false)

    // Re-check CHAMFER and Apply -- rewrites the SAME node, no new feature row.
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    const editEvaluationsBeforeApply = client.defeatureBatchCalls.filter((request) => request.featureId === 'F2').length
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.featureKeys).toEqual([FILLET.featureKey, CHAMFER.featureKey]))
    expect(client.defeatureBatchCalls.filter((request) => request.featureId === 'F2')).toHaveLength(editEvaluationsBeforeApply)
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
  })
})
