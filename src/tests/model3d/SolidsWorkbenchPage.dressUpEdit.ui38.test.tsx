// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { BodyHandle, ChamferRequest, FilletRequest, OpResult } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO-2858: the hover readout names the body, never the edge key. The hovered
// key is the owner edge the pick highlight paints (a picked edge stays 'selected').
function hoveredEdgeOn(ownerId: string): string | undefined {
  const text = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
  expect(text).toMatch(/^Edge on /)
  const hovered = (hooks().getBodyEdgeIds(ownerId) ?? []).filter((id) => hooks().getPickHighlightState(id) === 'hovered')
  expect(hovered.length).toBeLessThanOrEqual(1)
  if (hovered[0] !== undefined) expect(text).not.toContain(hovered[0])
  return hovered[0]
}

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

async function addBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

async function openChamferCreate(runtime: FakeSceneRuntime): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-chamfer'))
  await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/0 edges/))
  expect((screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement).value).toMatch(/^2(\.0*)?$/)
  expect(screen.queryByTestId('solids-workbench-dressup-hint')).toBeNull()
  expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
  runtime.rayOverride = { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge/))
}

async function forceInsertAndBuild(
  id: string,
  ownerId: string,
  payload: Record<string, unknown>,
  edgeRef: string,
): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id,
    kind: 'feature',
    consumes: [ownerId],
    refs: [{ id: edgeRef, kind: 'face-set' }],
    payload,
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

describe('UI-38 Fillet and Chamfer editability', () => {
  it('edits both operations from the shared tree/toolbar paths, preserves topology, replays, undoes, and refuses invalid refs', async () => {
    const filletRequests: FilletRequest[] = []
    const chamferRequests: ChamferRequest[] = []
    const client = createFakeGeomClient({
      applyFilletImpl: (request, mintHandle) => {
        filletRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyChamferImpl: (request, mintHandle) => {
        chamferRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()

    const initialFilletEdge = hooks().getBodyEdgeIds('F1')?.[0]
    if (initialFilletEdge === undefined) throw new Error('F1 must expose a selectable edge')

    await forceInsertAndBuild('F2', 'F1', {
      opType: 'fillet',
      ownerId: 'F1',
      edges: [initialFilletEdge],
      radius: 2,
      propagateTangent: true,
      name: 'Fillet F2',
    }, initialFilletEdge)

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const treeEdit = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(treeEdit.disabled).toBe(false)
    fireEvent.click(treeEdit)
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(screen.getByTestId('fillet-radius')).toBeTruthy()
    expect(screen.getByTestId('fillet-edge-instruction').textContent).toMatch(/click edges/i)
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-dressup-hint')).toBeNull()
    const filletStrip = screen.getByTestId('fillet-workspace-palette')
    expect(filletStrip.classList.contains('sketch-confirm-overlay')).toBe(true)
    expect(filletStrip.classList.contains('fillet-command-strip')).toBe(true)
    expect(filletStrip.getAttribute('role')).toBe('toolbar')
    expect(filletStrip.closest('[data-testid="dialog-shell"]')).toBeNull()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect(filletStrip.querySelector('.modal-header')).toBeNull()
    expect(filletStrip.querySelector('.modal-body')).toBeNull()
    expect(filletStrip.querySelector('.modal-footer')).toBeNull()
    expect(screen.queryByRole('dialog', { name: /fillet/i })).toBeNull()
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'))
    const filletAfterInitialPreview = filletRequests.length
    const radiusInput = screen.getByTestId('fillet-radius').querySelector('input') as HTMLInputElement

    // Operator keyboard/mouse acceptance: the first click selects the complete
    // stored value for type-over. The second mouse-up of a double-click
    // sequence is not captured, so the browser's normal caret/range behavior
    // remains available instead of re-selecting the whole field forever.
    fireEvent.focus(radiusInput)
    radiusInput.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(radiusInput)).toBe(false)
    expect(radiusInput.selectionStart).toBe(0)
    expect(radiusInput.selectionEnd).toBe(radiusInput.value.length)
    radiusInput.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(radiusInput, { detail: 2 })).toBe(true)
    expect(fireEvent.doubleClick(radiusInput, { detail: 2 })).toBe(true)
    expect(radiusInput.selectionStart).toBe(1)
    expect(radiusInput.selectionEnd).toBe(1)

    // A different editable control owns its own digits: Fillet must neither
    // focus nor rewrite the radius while that control has focus.
    const foreignEditor = document.createElement('textarea')
    document.body.appendChild(foreignEditor)
    foreignEditor.focus()
    fireEvent.keyDown(foreignEditor, { key: '7' })
    expect(document.activeElement).toBe(foreignEditor)
    expect(radiusInput.value).toMatch(/^2(\.0*)?$/)
    foreignEditor.remove()

    // With no other editor focused, both a leading decimal and a digit route
    // straight into the radius without a click, focus the field, and drive
    // live previews before Apply.
    ;(screen.getByTestId('workbench-undo') as HTMLButtonElement).focus()
    fireEvent.keyDown(window, { key: '.' })
    await waitFor(() => {
      expect(document.activeElement).toBe(radiusInput)
      expect(radiusInput.value).toBe('.')
    })
    fireEvent.change(radiusInput, { target: { value: '.5' } })
    await waitFor(() => {
      expect(filletRequests.at(-1)?.radius).toBe(0.5)
      expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready')
    })
    ;(screen.getByTestId('workbench-undo') as HTMLButtonElement).focus()
    fireEvent.keyDown(window, { key: '3' })
    await waitFor(() => {
      expect(document.activeElement).toBe(radiusInput)
      expect(radiusInput.value).toBe('3')
      expect(filletRequests.at(-1)?.radius).toBe(3)
      expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready')
    })
    expect(hooks().getPickHighlightState(initialFilletEdge)).toBe('selected')
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)

    let changedEdge: string | undefined
    for (const ray of [
      { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      { origin: { x: 0, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      { origin: { x: -20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
    ]) {
      runtime.rayOverride = ray
      fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
      const hovered = hoveredEdgeOn('F1')
      if (hovered !== undefined && hovered !== initialFilletEdge) {
        changedEdge = hovered
        break
      }
    }
    if (changedEdge === undefined) throw new Error('edit picker must expose a second owner-body edge')
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/2 edges/))
    expect(radiusInput.value).toBe('3')
    await waitFor(() => {
      expect(filletRequests.length).toBeGreaterThan(filletAfterInitialPreview)
      expect(filletRequests.at(-1)?.edges).toEqual([initialFilletEdge, changedEdge])
      expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready')
    })
    const filletAfterEdgePreview = filletRequests.length
    commitField('fillet-radius', '4')
    await waitFor(() => {
      const status = screen.getByTestId('fillet-preview-status')
      if (status.getAttribute('data-status') === 'refused') throw new Error(status.textContent ?? 'Fillet preview refused')
      expect(status.getAttribute('data-status')).toBe('ready')
      expect(filletRequests.length).toBeGreaterThan(filletAfterEdgePreview)
      expect(filletRequests.at(-1)?.radius).toBe(4)
    }, { timeout: 20_000 })
    const filletBeforeApply = filletRequests.length
    const historyBeforeApply = hooks().history.size()
    radiusInput.focus()
    fireEvent.keyDown(radiusInput, { key: 'Enter' })

    await waitFor(() => {
      const node = hooks().dag.getNode('F2')
      expect(node?.payload).toMatchObject({ radius: 4, ownerId: 'F1', edges: [initialFilletEdge, changedEdge] })
      expect(node?.consumes).toEqual(['F1'])
      expect(node?.refs).toEqual([])
      expect(filletRequests.at(-1)?.radius).toBe(4)
      expect(filletRequests).toHaveLength(filletBeforeApply)
      expect(hooks().history.size()).toBe(historyBeforeApply + 1)
    })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F2')?.payload.radius).toBe(2)
      expect(hooks().dag.getNode('F2')?.consumes).toEqual(['F1'])
      expect(hooks().dag.getNode('F2')?.refs).toEqual([{ id: initialFilletEdge, kind: 'face-set' }])
      expect(filletRequests.at(-1)?.radius).toBe(2)
    })

    await forceInsertAndBuild('F3', 'F2', {
      opType: 'chamfer',
      ownerId: 'F2',
      edges: ['F2:EDGE:side'],
      distance: 1,
      propagateTangent: true,
      name: 'Chamfer F3',
    }, 'F2:EDGE:side')

    fireEvent.click(screen.getByTestId('feature-row-F3'))
    const toolbarEdit = screen.getByTestId('workbench-edit-feature') as HTMLButtonElement
    expect(toolbarEdit.disabled).toBe(false)
    fireEvent.click(toolbarEdit)
    const chamferStrip = screen.getByTestId('chamfer-workspace-palette')
    expect(chamferStrip.classList.contains('sketch-confirm-overlay')).toBe(true)
    expect(chamferStrip.classList.contains('fillet-command-strip')).toBe(true)
    expect(chamferStrip.getAttribute('role')).toBe('toolbar')
    expect(chamferStrip.closest('[data-testid="dialog-shell"]')).toBeNull()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-dressup-hint')).toBeNull()
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge/)
    expect(screen.getByTestId('chamfer-edge-instruction').textContent).toMatch(/click edges/i)
    expect(hooks().getPickHighlightState('F2:EDGE:side')).toBe('selected')

    const distanceInput = screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement
    expect(distanceInput.value).toMatch(/^1(\.0*)?$/)
    fireEvent.focus(distanceInput)
    distanceInput.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(distanceInput)).toBe(false)
    expect(distanceInput.selectionStart).toBe(0)
    expect(distanceInput.selectionEnd).toBe(distanceInput.value.length)
    distanceInput.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(distanceInput, { detail: 2 })).toBe(true)
    expect(fireEvent.doubleClick(distanceInput, { detail: 2 })).toBe(true)
    expect(distanceInput.selectionStart).toBe(1)
    expect(distanceInput.selectionEnd).toBe(1)

    const foreignChamferEditor = document.createElement('textarea')
    document.body.appendChild(foreignChamferEditor)
    foreignChamferEditor.focus()
    fireEvent.keyDown(foreignChamferEditor, { key: '7' })
    expect(document.activeElement).toBe(foreignChamferEditor)
    expect(distanceInput.value).toMatch(/^1(\.0*)?$/)
    foreignChamferEditor.remove()

    ;(screen.getByTestId('workbench-undo') as HTMLButtonElement).focus()
    fireEvent.keyDown(window, { key: '3' })
    await waitFor(() => {
      expect(document.activeElement).toBe(distanceInput)
      expect(distanceInput.value).toBe('3')
      const status = screen.getByTestId('chamfer-preview-status')
      if (status.getAttribute('data-status') === 'refused') throw new Error(status.textContent ?? 'Chamfer preview refused')
      expect(status.getAttribute('data-status')).toBe('ready')
      expect(chamferRequests.at(-1)?.distance).toBe(3)
    }, { timeout: 20_000 })

    let changedChamferEdge: string | undefined
    for (const ray of [
      { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      { origin: { x: 0, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      { origin: { x: -20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
    ]) {
      runtime.rayOverride = ray
      fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
      const hovered = hoveredEdgeOn('F2')
      if (hovered !== undefined && hovered !== 'F2:EDGE:side') {
        changedChamferEdge = hovered
        break
      }
    }
    if (changedChamferEdge === undefined) throw new Error('Chamfer edit picker must expose a second owner-body edge')
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/2 edges/))
    await waitFor(() => {
      expect(chamferRequests.at(-1)?.edges).toEqual(['F2:EDGE:side', changedChamferEdge])
      expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready')
    })
    const chamferBeforeApply = chamferRequests.length
    distanceInput.focus()
    fireEvent.keyDown(distanceInput, { key: 'Enter' })

    await waitFor(() => {
      const node = hooks().dag.getNode('F3')
      expect(node?.payload).toMatchObject({ distance: 3, ownerId: 'F2', edges: ['F2:EDGE:side', changedChamferEdge] })
      expect(node?.consumes).toEqual(['F2'])
      expect(node?.refs).toEqual([])
      expect(chamferRequests).toHaveLength(chamferBeforeApply)
      expect(chamferRequests.at(-1)?.distance).toBe(3)
    })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F3')?.payload).toMatchObject({ distance: 1, edges: ['F2:EDGE:side'] })
      expect(hooks().dag.getNode('F3')?.consumes).toEqual(['F2'])
      expect(chamferRequests.at(-1)?.distance).toBe(1)
    })

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD',
      kind: 'feature',
      consumes: [],
      payload: {
        opType: 'fillet',
        ownerId: 'F2',
        edges: ['F2:EDGE:bad'],
        radius: 2,
        propagateTangent: true,
        name: 'Broken fillet',
      },
    }))
    const before = hooks().dag.getNode('BAD')
    const invalidEntry = hooks().editEntryFor('BAD')
    if (invalidEntry === undefined || !('onEdit' in invalidEntry)) throw new Error('BAD fillet must route to its edit dialog')
    invalidEntry.onEdit()

    await waitFor(() => expect(screen.getByTestId('fillet-reference-error').textContent).toMatch(/missing from the feature dependencies/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('BAD')).toEqual(before)

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD_CHAMFER',
      kind: 'feature',
      consumes: ['F2'],
      payload: {
        opType: 'chamfer',
        ownerId: 'F2',
        edges: { malformed: true },
        distance: 2,
        propagateTangent: true,
        name: 'Broken chamfer',
      },
    }))
    const malformedChamferEntry = hooks().editEntryFor('BAD_CHAMFER')
    if (malformedChamferEntry === undefined || !('onEdit' in malformedChamferEntry)) {
      throw new Error('BAD_CHAMFER must route to its named edit refusal')
    }
    expect(() => malformedChamferEntry.onEdit()).not.toThrow()
    await waitFor(() => expect(screen.getByTestId('chamfer-reference-error').textContent).toMatch(/no valid edge references/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  }, 60_000)

  it('edits a non-leaf Fillet at its timeline position, cancels to the exact live leaf, and replays only downstream after atomic adoption', async () => {
    const filletRequests: FilletRequest[] = []
    const chamferRequests: ChamferRequest[] = []
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      applyFilletImpl: (request, mintHandle) => {
        filletRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyChamferImpl: (request, mintHandle) => {
        chamferRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'fillet', ownerId: 'F1', edges: ['F1:EDGE:top'], radius: 2,
      propagateTangent: true, name: 'Fillet F2',
    }, 'F1:EDGE:top')
    await forceInsertAndBuild('F3', 'F2', {
      opType: 'chamfer', ownerId: 'F2', edges: ['F2:EDGE:side'], distance: 1,
      propagateTangent: true, name: 'Chamfer F3',
    }, 'F2:EDGE:side')

    const liveLeafBeforeCancel = hooks().getBodyHandle('F3')
    expect(hooks().getBodyPresentationVisible('F2')).not.toBe(true)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    const filletBeforeCancel = filletRequests.length
    const downstreamBeforeCancel = chamferRequests.length
    const firstEdit = hooks().editEntryFor('F2')
    if (firstEdit === undefined || !('onEdit' in firstEdit)) throw new Error('F2 must route to its Fillet edit dialog')
    firstEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(screen.getByTestId('fillet-radius')).toBeTruthy()
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('selected')
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    fireEvent.keyDown(screen.getByTestId('fillet-radius').querySelector('input') as HTMLInputElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('fillet-radius')).toBeNull())
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('none')
    expect(hooks().getBodyPresentationVisible('F1')).not.toBe(true)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().dag.getNode('F2')?.payload.radius).toBe(2)

    const modalCancelEdit = hooks().editEntryFor('F2')
    if (modalCancelEdit === undefined || !('onEdit' in modalCancelEdit)) throw new Error('F2 must remain editable after pick cancel')
    modalCancelEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('fillet-radius')).toBeTruthy())
    commitField('fillet-radius', '3')
    await waitFor(() => {
      const status = screen.getByTestId('fillet-preview-status')
      if (status.getAttribute('data-status') === 'refused') throw new Error(status.textContent ?? 'Fillet preview refused')
      expect(status.getAttribute('data-status')).toBe('ready')
    }, { timeout: 20_000 })
    expect(filletRequests.length).toBeGreaterThan(filletBeforeCancel)
    expect(chamferRequests).toHaveLength(downstreamBeforeCancel)
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__fillet-preview__')).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('fillet-preview-status')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload.radius).toBe(2)
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(chamferRequests).toHaveLength(downstreamBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F2')).not.toBe(true)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().getBodyPresentationVisible('__fillet-preview__')).toBeUndefined()

    const secondEdit = hooks().editEntryFor('F2')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F2 must route to its Fillet edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('fillet-radius')).toBeTruthy())
    runtime.rayOverride = { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    commitField('fillet-radius', '4')
    await waitFor(() => {
      const status = screen.getByTestId('fillet-preview-status')
      if (status.getAttribute('data-status') === 'refused') throw new Error(status.textContent ?? 'Fillet preview refused')
      expect(status.getAttribute('data-status')).toBe('ready')
    }, { timeout: 20_000 })
    const filletBeforeApply = filletRequests.length
    const downstreamBeforeApply = chamferRequests.length
    const historyBeforeApply = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.queryByTestId('fillet-preview-status')).toBeNull())
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBe(liveLeafBeforeCancel))
    const adoptedFilletHandle = hooks().getBodyHandle('F2')
    expect(hooks().dag.getNode('F2')?.payload.radius).toBe(4)
    expect(filletRequests).toHaveLength(filletBeforeApply)
    expect(chamferRequests).toHaveLength(downstreamBeforeApply + 1)
    expect(chamferRequests.at(-1)?.body).toBe(adoptedFilletHandle)
    expect(hooks().dag.getNode('F3')?.consumes).toEqual(['F2'])
    expect(hooks().dag.getNode('F3')?.payload).toMatchObject({
      opType: 'chamfer', ownerId: 'F2', edges: ['F2:EDGE:side'], distance: 1,
    })
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)
  }, 60_000)

  it('previews a new Chamfer, adopts the accepted body without a second kernel call, and remains one undo/redo action', async () => {
    const chamferRequests: ChamferRequest[] = []
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      applyChamferImpl: (request, mintHandle) => {
        chamferRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await openChamferCreate(runtime)
    commitField('chamfer-distance', '3')
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'))

    const callsBeforeApply = chamferRequests.length
    const historyBeforeApply = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.queryByTestId('chamfer-preview-status')).toBeNull())
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(chamferRequests).toHaveLength(callsBeforeApply)
    expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'chamfer', ownerId: 'F1', distance: 3,
    })
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')).toBeUndefined())
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.distance).toBe(3))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
  }, 60_000)

  it('surfaces a refused Chamfer preview without authoring or hiding the owner', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      applyChamferImpl: () => ({
        ok: false,
        diagnostics: [{ code: 'CHAMFER_FAILED', severity: 'error', params: { reason: 'distance exceeds adjacent faces' } }],
      }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await openChamferCreate(runtime)

    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('refused'))
    expect(screen.getByTestId('chamfer-preview-status').textContent).toMatch(/distance exceeds adjacent faces/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
  }, 60_000)

  it('cancels a pending Chamfer edit synchronously and ignores its stale completion', async () => {
    const client = createFakeGeomClient({
      applyChamferImpl: (_request, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'chamfer', ownerId: 'F1', edges: ['F1:EDGE:top'], distance: 2,
      propagateTangent: true, name: 'Chamfer F2',
    }, 'F1:EDGE:top')

    let resolvePreview: ((result: OpResult) => void) | undefined
    client.applyChamfer = async () => new Promise<OpResult>((resolve) => { resolvePreview = resolve })
    const historyBefore = hooks().history.size()
    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Chamfer edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('pending'))
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('selected')

    const pendingDistanceInput = screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement
    fireEvent.keyDown(pendingDistanceInput, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('chamfer-preview-status')).toBeNull())
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('none')
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(2)
    expect(hooks().history.size()).toBe(historyBefore)

    resolvePreview?.({ ok: true, body: 900 as BodyHandle, diagnostics: [] })
    await waitFor(() => expect(client.disposedHandles).toContain(900 as BodyHandle))
    expect(hooks().getBodyPresentationVisible('__chamfer-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(2)
    expect(hooks().history.size()).toBe(historyBefore)
  }, 60_000)

  it('edits a non-leaf Chamfer from its frozen baseline and replays only the downstream Fillet after adoption', async () => {
    const chamferRequests: ChamferRequest[] = []
    const filletRequests: FilletRequest[] = []
    const client = createFakeGeomClient({
      applyChamferImpl: (request, mintHandle) => {
        chamferRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyFilletImpl: (request, mintHandle) => {
        filletRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'chamfer', ownerId: 'F1', edges: ['F1:EDGE:top'], distance: 1,
      propagateTangent: true, name: 'Chamfer F2',
    }, 'F1:EDGE:top')
    await forceInsertAndBuild('F3', 'F2', {
      opType: 'fillet', ownerId: 'F2', edges: ['F2:EDGE:side'], radius: 1,
      propagateTangent: true, name: 'Fillet F3',
    }, 'F2:EDGE:side')

    const liveLeafBeforeCancel = hooks().getBodyHandle('F3')
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const firstTreeEdit = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(firstTreeEdit.disabled).toBe(false)
    fireEvent.click(firstTreeEdit)
    await waitFor(() => expect(screen.getByTestId('chamfer-distance')).toBeTruthy())
    commitField('chamfer-distance', '2')
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('selected')
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__chamfer-preview__')).toBe(true)
    const filletBeforeCancel = filletRequests.length
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('chamfer-preview-status')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(1)
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(filletRequests).toHaveLength(filletBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().getPickHighlightState('F1:EDGE:top')).toBe('none')

    expect(screen.getByTestId('feature-row-F2')).toBeTruthy()
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const secondTreeEdit = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(secondTreeEdit.disabled).toBe(false)
    fireEvent.click(secondTreeEdit)
    await waitFor(() => expect(screen.getByTestId('chamfer-distance')).toBeTruthy())
    commitField('chamfer-distance', '3')
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'))
    const chamferBeforeApply = chamferRequests.length
    const filletBeforeApply = filletRequests.length
    const historyBeforeApply = hooks().history.size()
    const replayFillet = client.applyFillet.bind(client)
    let releaseDownstreamReplay: (() => void) | undefined
    client.applyFillet = (request) => new Promise<OpResult>((resolve, reject) => {
      releaseDownstreamReplay = () => { void replayFillet(request).then(resolve, reject) }
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    // Interleave while the adopted Chamfer is waiting on its one downstream
    // replay. No partial history action is visible, every undo route is
    // blocked, and a second feature-edit intent cannot replace the session.
    await waitFor(() => expect(releaseDownstreamReplay).toBeDefined())
    expect(hooks().history.size()).toBe(historyBeforeApply)
    expect((screen.getByTestId('workbench-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workbench-redo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(true)
    const undoChord = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(undoChord)
    expect(undoChord.defaultPrevented).toBe(true)
    expect(hooks().history.size()).toBe(historyBeforeApply)
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(3)
    // The floating palette intentionally allows the tree to remain visible,
    // but the root capture guard must stop a real tree mutator before its
    // callback can append history or launch a competing fullResync.
    fireEvent.click(screen.getByTestId('feature-row-suppress-F3'))
    expect(hooks().dag.getNode('F3')?.suppressed).toBe(false)
    expect(hooks().history.size()).toBe(historyBeforeApply)
    expect(filletRequests).toHaveLength(filletBeforeApply)
    const blockedSecondEdit = hooks().editEntryFor('F3')
    expect(blockedSecondEdit).toMatchObject({
      reason: expect.stringMatching(/accepted Chamfer is being applied/i),
    })

    releaseDownstreamReplay?.()
    client.applyFillet = replayFillet

    await waitFor(() => expect(screen.queryByTestId('chamfer-preview-status')).toBeNull())
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBe(liveLeafBeforeCancel))
    const adoptedChamferHandle = hooks().getBodyHandle('F2')
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(3)
    expect(chamferRequests).toHaveLength(chamferBeforeApply)
    expect(filletRequests).toHaveLength(filletBeforeApply + 1)
    expect(filletRequests.at(-1)?.body).toBe(adoptedChamferHandle)
    expect(hooks().dag.getNode('F3')?.payload).toMatchObject({
      opType: 'fillet', ownerId: 'F2', edges: ['F2:EDGE:side'], radius: 1,
    })
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)

    // A post-publication downstream throw is not success. The unrecorded
    // Chamfer command is undone, the original target+leaf are replayed through
    // fullResync, and only then is a fresh preview offered in the still-open
    // dialog. No partial undo entry ever becomes visible.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('chamfer-distance')).toBeTruthy())
    commitField('chamfer-distance', '4')
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'))
    const historyBeforeReplayThrow = hooks().history.size()
    const chamferBeforeReplayThrow = chamferRequests.length
    const filletBeforeReplayThrow = filletRequests.length
    hooks().setChamferDownstreamReplayProbe(() => {
      throw new Error('injected downstream replay failure')
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('chamfer-apply-error').textContent).toMatch(/downstream replay failed/i))
    expect(screen.getByTestId('chamfer-apply-error').textContent).toMatch(/No changes were applied/)
    expect(hooks().dag.getNode('F2')?.payload.distance).toBe(3)
    expect(hooks().history.size()).toBe(historyBeforeReplayThrow)
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(chamferRequests).toHaveLength(chamferBeforeReplayThrow + 2)
    expect(chamferRequests.at(-2)?.distance).toBe(3)
    expect(chamferRequests.at(-1)?.distance).toBe(4)
    expect(filletRequests).toHaveLength(filletBeforeReplayThrow + 1)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__chamfer-preview__')).toBe(true)
  }, 60_000)
})
