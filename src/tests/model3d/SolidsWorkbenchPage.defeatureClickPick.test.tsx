// @vitest-environment jsdom
//
// DEFEATURE-CLICK-PICK (Q-68 item 3): the contextual-feedback surfaces that the
// new in-viewport pick adds to the Defeature dialog, proven through the REAL
// SolidsWorkbenchPage (the dialog runs CONTROLLED off the page's lifted accept
// mask here, exactly as in production -- the standalone-dialog path stays
// uncontrolled and is covered by SolidsWorkbenchPage.defeature.test.tsx).
//
// These three assertions do NOT need a real raycast (jsdom can't tessellate a
// body): the row->viewport hover direction, the running summary readout, and
// the toggle/hover console lines all drive off the list rows + the lifted mask,
// which is where the viewport face-pick lands too. The viewport->row raycast
// direction + the face-set tint are proven separately by the headed real-GPU
// capture (tools/capture/defeature-click-pick-exec.mjs).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import {
  defeatureVerdictForFace,
  disposeDefeatureVerdict,
} from '../../components/model3d/dialogs/DefeatureDialog'
import type { FeatureVerdict } from '../../geom/geom-service'
import { useCamStore } from '../../store'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let workbenchMessages: string[] = []

beforeEach(() => {
  workbenchMessages = []
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

const THROUGH_HOLE: FeatureVerdict = {
  featureKey: 'through-hole-6',
  featureClass: 'throughHole',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:bore-wall', 'F1:FACE:entry'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:bottom'],
  params: { diameter: 6 },
}

async function mount(client: FakeGeomClient): Promise<void> {
  render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
}

async function openDefeature(): Promise<FakeGeomClient> {
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
        totalVolumeDelta: 12.5,
        items: (req.featureKeys ?? []).map((featureKey) => ({
          featureKey,
          featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
          healed: true,
          volumeDelta: 12.5,
          effect: 'add',
        })),
      },
    }),
  })
  await mount(client)
  await buildBody()
  fireEvent.click(screen.getByTestId('workbench-defeature'))
  await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
  return client
}

describe('SolidsWorkbenchPage defeature click-pick (Q-68 item 3)', () => {
  it('posts the arm console line naming the pick when the dialog opens', async () => {
    await openDefeature()
    expect(workbenchMessages.some((m) =>
      m.startsWith('Pick faces to delete on') && m.includes('whole coherent group'),
    )).toBe(true)
  })

  it('maps a clicked through-hole face to the whole removable recognized group', () => {
    const verdict = disposeDefeatureVerdict(THROUGH_HOLE)
    expect(verdict.removable).toBe(true)
    expect(defeatureVerdictForFace([FILLET, verdict], 'F1:FACE:bore-wall')).toBe(verdict)
    expect(defeatureVerdictForFace([FILLET, verdict], 'F1:FACE:entry')?.faceIds).toEqual([
      'F1:FACE:bore-wall',
      'F1:FACE:entry',
    ])
  })

  it('shows a running n-of-m + type breakdown that tracks the accept mask', async () => {
    await openDefeature()
    const summary = () => screen.getByTestId('defeature-summary').textContent ?? ''
    // Direct create starts empty; the user's first action is a viewport/list pick.
    expect(summary()).toBe('0 of 2 selected')
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    expect(summary()).toBe('1 of 2 selected - 1 chamfer')
  })

  it('opens as a non-modal viewport command card and builds a healed preview for each selected mask', async () => {
    const client = await openDefeature()
    const card = screen.getByTestId('defeature-command-card')
    expect(card.getAttribute('data-primary-interaction')).toBe('viewport-pick')
    expect(card.hasAttribute('data-ui78-sanctioned')).toBe(true)
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(screen.getByTestId('defeature-preview-status').textContent).toContain('Healed preview ready')
    expect(client.defeatureBatchCalls.at(-1)).toMatchObject({
      featureId: 'F2',
      featureKeys: [FILLET.featureKey],
    })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps viewport face picking authoritative while the command card is open', async () => {
    const recognized: FeatureVerdict[] = []
    const client = createFakeGeomClient({
      recognizeFeaturesResult: recognized,
      defeatureBatchImpl: (req, mintHandle) => ({
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        report: {
          requested: req.featureKeys?.length ?? 0,
          healed: req.featureKeys?.length ?? 0,
          failed: 0,
          refused: 0,
          totalVolumeDelta: 4,
          items: (req.featureKeys ?? []).map((featureKey) => ({
            featureKey,
            featureClass: 'filletPlanar',
            healed: true,
            volumeDelta: 4,
            effect: 'add',
          })),
        },
      }),
    })
    await mount(client)
    await buildBody()

    const hit = hooks().pickAt(0, 0)
    expect(hit?.kind).toBe('face')
    if (hit === null || hit.kind !== 'face') throw new Error('expected the fixed test ray to hit a face')
    recognized.push({ ...FILLET, faceIds: [hit.id] })

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas, { clientX: 0, clientY: 0 })
    await waitFor(() => expect(screen.getByTestId(`defeature-row-${FILLET.featureKey}`).getAttribute('data-hovered')).toBe('true'))

    fireEvent.click(canvas, { clientX: 0, clientY: 0 })
    expect(screen.getByTestId('defeature-summary').textContent).toBe('1 of 1 selected - 1 fillet')
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(client.defeatureBatchCalls.at(-1)?.featureKeys).toEqual([FILLET.featureKey])
  })

  it('edit viewport picking raycasts the reconstructed pre-feature body rather than the healed live body', async () => {
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET],
      defeatureBatchImpl: (req, mintHandle) => ({
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        report: {
          requested: req.featureKeys?.length ?? 0,
          healed: req.featureKeys?.length ?? 0,
          failed: 0,
          refused: 0,
          totalVolumeDelta: 4,
          items: (req.featureKeys ?? []).map((featureKey) => ({
            featureKey,
            featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
            healed: true,
            volumeDelta: 4,
            effect: 'add',
          })),
        },
      }),
    })
    await mount(client)
    await buildBody()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    // The live healed body retains its already-painted FAKEDISPLAY ids. Every
    // newly tessellated edit candidate/source gets a distinct PRE_FEATURE id
    // namespace, so this face literally cannot be picked from F2.
    client.tessellate = async () => makeBoxTessBuffers({ featureId: 'PRE_FEATURE' })
    const preFeatureOnly: FeatureVerdict = {
      ...CHAMFER,
      featureKey: 'pre-feature-only-chamfer',
      faceIds: ['PRE_FEATURE:BOX:face#5'],
    }
    client.recognizeFeatures = async () => [
      { ...FILLET, faceIds: ['PRE_FEATURE:never-hit'] },
      preFeatureOnly,
    ]

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    expect(screen.getByTestId('defeature-summary').textContent).toBe('1 of 2 selected - 1 fillet')

    fireEvent.click(screen.getByTestId('solids-workbench-canvas'), { clientX: 0, clientY: 0 })
    expect(screen.getByTestId('defeature-summary').textContent).toBe('2 of 2 selected - 1 fillet, 1 chamfer')
    expect((screen.getByTestId(`defeature-check-${preFeatureOnly.featureKey}`) as HTMLInputElement).checked).toBe(true)
  })

  it('lets the user move the command card away from model geometry', async () => {
    await openDefeature()
    const card = screen.getByTestId('defeature-command-card')
    const header = card.querySelector('header')
    if (header === null) throw new Error('expected defeature command header')
    // The card bounds and the browser viewport are layout inputs to the
    // product's bounded drag calculation. jsdom supplies zero-sized layout
    // boxes and other suites can customize its viewport, so pin both inputs
    // here rather than accidentally testing their shared global state.
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const getBoundingClientRect = card.getBoundingClientRect
    card.getBoundingClientRect = () => ({
      x: 276,
      y: 76,
      width: 328,
      height: 280,
      top: 76,
      right: 604,
      bottom: 356,
      left: 276,
      toJSON: () => ({}),
    }) as DOMRect

    try {
      fireEvent.pointerDown(header, { pointerId: 7, clientX: 300, clientY: 100 })
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 500, clientY: 220 })

      // The viewport command card moves by the requested delta and remains
      // within its available workspace rather than staying on the geometry.
      // The position is React-rendered state, so await that exact pixel result
      // before pointer-up clears the drag instead of assuming a loaded worker
      // committed the render synchronously with pointermove.
      await waitFor(() => {
        expect(card.style.left).toBe('476px')
        expect(card.style.top).toBe('196px')
      })
      fireEvent.pointerUp(window, { pointerId: 7 })
    } finally {
      card.getBoundingClientRect = getBoundingClientRect
      if (innerWidth === undefined) delete (window as { innerWidth?: number }).innerWidth
      else Object.defineProperty(window, 'innerWidth', innerWidth)
      if (innerHeight === undefined) delete (window as { innerHeight?: number }).innerHeight
      else Object.defineProperty(window, 'innerHeight', innerHeight)
    }
  })

  it('highlights a list row on hover (row->viewport link) and names the feature in the console once per hover change', async () => {
    await openDefeature()
    const filletRow = screen.getByTestId(`defeature-row-${FILLET.featureKey}`)
    expect(filletRow.getAttribute('data-hovered')).toBeNull()

    fireEvent.mouseEnter(filletRow)
    expect(filletRow.getAttribute('data-hovered')).toBe('true')
    // FILLET starts unselected -> the hover line offers to INCLUDE it, and names
    // the feature the way its row does (label + face count), via the shared
    // defeatureVerdictLabel single source of truth.
    const hoverLine = 'Planar fillet radius 2 mm (1 face) - click to include in removal.'
    expect(workbenchMessages.filter((m) => m === hoverLine)).toHaveLength(1)

    fireEvent.mouseLeave(filletRow)
    expect(filletRow.getAttribute('data-hovered')).toBeNull()
  })

  it('posts a toggle console line naming the feature and the new count', async () => {
    await openDefeature()
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    expect(workbenchMessages).toContain('Included Planar chamfer distance 1 mm (1 face) in the removal (1 selected).')
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    expect(workbenchMessages).toContain('Excluded Planar chamfer distance 1 mm (1 face) from the removal (0 selected).')
  })
})
