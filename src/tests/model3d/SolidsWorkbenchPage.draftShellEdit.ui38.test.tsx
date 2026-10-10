// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { InsertNodeCommand } from '../../doc'
import type { BodyHandle, DraftRequest, OpResult, ShellRequest } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

const LOAD_TOLERANT_ASYNC_TIMEOUT_MS = 20_000

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

async function forceInsertAndBuild(
  id: string,
  ownerId: string,
  payload: Record<string, unknown>,
  faceRef: string,
): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id,
    kind: 'feature',
    consumes: [ownerId],
    refs: [{ id: faceRef, kind: 'face-set' }],
    payload,
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

describe('UI-38 Draft and Shell editability', () => {
  it('rebuilds the same Draft edit preview after a transient Apply preparation failure', async () => {
    const draftRequests: DraftRequest[] = []
    const client = createFakeGeomClient({
      applyDraftImpl: (request, mintHandle) => {
        draftRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'draft',
      ownerId: 'F1',
      faces: ['F1:FACE:side'],
      angleDeg: 5,
      pullAxis: 'x',
      pullFlip: false,
      pullMode: 'axis',
      offset: 0,
      name: 'Draft F2',
    }, 'F1:FACE:side')

    const draftEditEntry = hooks().editEntryFor('F2')
    if (draftEditEntry === undefined || !('onEdit' in draftEditEntry)) throw new Error('F2 must route to its Draft edit dialog')
    draftEditEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready'))
    const draftRequestsBeforeAngleChange = draftRequests.length
    commitField('draft-angle', '9')
    await waitFor(() => {
      expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready')
      expect(draftRequests.length).toBeGreaterThan(draftRequestsBeforeAngleChange)
      expect(draftRequests.at(-1)?.angleDeg).toBe(9)
    }, { timeout: LOAD_TOLERANT_ASYNC_TIMEOUT_MS })

    const historyBeforeApply = hooks().history.size()
    const tessellate = client.tessellate.bind(client)
    let failNextTessellation = true
    client.tessellate = async (handle, quality) => {
      if (failNextTessellation) {
        failNextTessellation = false
        throw new Error('transient accepted-candidate tessellation failure')
      }
      return tessellate(handle, quality)
    }
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('draft-apply-error').textContent).toMatch(/transient accepted-candidate/i))
    expect(hooks().dag.getNode('F2')?.payload.angleDeg).toBe(5)
    expect(hooks().history.size()).toBe(historyBeforeApply)
    await waitFor(() => expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready'))

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.queryByTestId('draft-command-card')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload.angleDeg).toBe(9)
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)
    expect(draftRequests.at(-1)?.angleDeg).toBe(9)
  })

  it('keeps the accepted Shell visible while a newer preview is pending, then restores the owner on refusal', async () => {
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      applyShellImpl: (_request, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()

    fireEvent.click(screen.getByTestId('workbench-shell'))
    runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)

    let resolvePending: ((result: OpResult) => void) | undefined
    client.applyShell = () => new Promise<OpResult>((resolve) => { resolvePending = resolve })
    const historyBefore = hooks().history.serialize()
    commitField('shell-thickness', '4')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('pending'))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)

    resolvePending?.({
      ok: false,
      diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'use a smaller thickness' } }],
    })
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('refused'))
    expect(screen.getByTestId('shell-preview-status').textContent).toMatch(/smaller thickness/i)
    expect((screen.getByTestId('shell-thickness').querySelector('input') as HTMLInputElement).value).toBe('4')
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).not.toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    expect(hooks().history.serialize()).toEqual(historyBefore)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
  })

  it('refuses and disposes an accepted Shell candidate when the document fingerprint changes before Apply', async () => {
    let acceptedCandidate: BodyHandle | undefined
    const runtime = createFakeSceneRuntime()
    const client = createFakeGeomClient({
      applyShellImpl: (_request, mintHandle) => {
        acceptedCandidate = mintHandle()
        return { ok: true, body: acceptedCandidate, diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()

    const sourceHandle = hooks().getBodyHandle('F1')
    fireEvent.click(screen.getByTestId('workbench-shell'))
    const runtimeCanvas = screen.getByTestId('solids-workbench-canvas')
    runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(runtimeCanvas)
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(acceptedCandidate).not.toBeUndefined()
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)

    hooks().history.execute(new InsertNodeCommand({
      id: 'param:external-fingerprint-change',
      kind: 'parameter',
      payload: { name: 'external', expression: '9', value: 9 },
    }))
    const mutatedDag = hooks().dag.serialize()
    const mutatedHistory = hooks().history.serialize()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('shell-apply-error').textContent).toMatch(/model changed after the preview/i))
    await waitFor(() => expect(client.disposedHandles).toContain(acceptedCandidate))
    expect(hooks().dag.serialize()).toBe(mutatedDag)
    expect(hooks().history.serialize()).toEqual(mutatedHistory)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect(hooks().getBodyHandle('F1')).toBe(sourceHandle)
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
  })

  it('cancels a pending Shell edit synchronously and disposes its stale completion', async () => {
    const client = createFakeGeomClient({
      applyShellImpl: (_request, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'shell', ownerId: 'F1', removeFaces: ['FAKEDISPLAY:BOX:face#5'], thickness: 2,
      name: 'Shell F2',
    }, 'FAKEDISPLAY:BOX:face#5')

    let resolvePreview: ((result: OpResult) => void) | undefined
    client.applyShell = async () => new Promise<OpResult>((resolve) => { resolvePreview = resolve })
    const historyBefore = hooks().history.serialize()
    const leafBefore = hooks().getBodyHandle('F2')
    hooks().setPickHighlightState(['PRESESSION:SELECTED'], 'PRESESSION:HOVERED')
    expect(hooks().getPickHighlightState('PRESESSION:SELECTED')).toBe('selected')
    expect(hooks().getPickHighlightState('PRESESSION:HOVERED')).toBe('hovered')
    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Shell edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('pending'))
    expect(hooks().getPickHighlightState('FAKEDISPLAY:BOX:face#5')).toBe('selected')

    const pendingThicknessInput = screen.getByTestId('shell-thickness').querySelector('input') as HTMLInputElement
    fireEvent.keyDown(pendingThicknessInput, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('shell-preview-status')).toBeNull())
    expect(hooks().getPickHighlightState('FAKEDISPLAY:BOX:face#5')).toBe('none')
    expect(hooks().getPickHighlightState('PRESESSION:SELECTED')).toBe('selected')
    expect(hooks().getPickHighlightState('PRESESSION:HOVERED')).toBe('hovered')
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().getBodyHandle('F2')).toBe(leafBefore)
    expect(hooks().dag.getNode('F2')?.payload.thickness).toBe(2)
    expect(hooks().history.serialize()).toEqual(historyBefore)

    resolvePreview?.({ ok: true, body: 901 as BodyHandle, diagnostics: [] })
    await waitFor(() => expect(client.disposedHandles).toContain(901 as BodyHandle))
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().getBodyHandle('F2')).toBe(leafBefore)
    expect(hooks().history.serialize()).toEqual(historyBefore)
    expect(hooks().getPickHighlightState('PRESESSION:SELECTED')).toBe('selected')
    expect(hooks().getPickHighlightState('PRESESSION:HOVERED')).toBe('hovered')
  }, 60_000)

  it('edits a non-leaf Shell at its timeline position and replays downstream atomically', async () => {
    const shellRequests: ShellRequest[] = []
    const draftRequests: DraftRequest[] = []
    const client = createFakeGeomClient({
      applyShellImpl: (request, mintHandle) => {
        shellRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyDraftImpl: (request, mintHandle) => {
        draftRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()
    await forceInsertAndBuild('F2', 'F1', {
      opType: 'shell', ownerId: 'F1', removeFaces: ['FAKEDISPLAY:BOX:face#5'], thickness: 1,
      name: 'Shell F2',
    }, 'FAKEDISPLAY:BOX:face#5')
    await forceInsertAndBuild('F3', 'F2', {
      opType: 'draft', ownerId: 'F2', faces: ['F2:FACE:side'], angleDeg: 5,
      pullAxis: 'x', pullFlip: false, pullMode: 'axis', offset: 0, name: 'Draft F3',
    }, 'F2:FACE:side')

    const liveLeafBeforeCancel = hooks().getBodyHandle('F3')
    const historyBeforeCancel = hooks().history.serialize()
    const firstEdit = hooks().editEntryFor('F2')
    if (firstEdit === undefined || !('onEdit' in firstEdit)) throw new Error('F2 must route to its Shell edit dialog')
    firstEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('shell-thickness')).toBeTruthy())
    commitField('shell-thickness', '2')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(hooks().getPickHighlightState('FAKEDISPLAY:BOX:face#5')).toBe('selected')
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)
    const draftBeforeCancel = draftRequests.length
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('shell-preview-status')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload.thickness).toBe(1)
    expect(hooks().getBodyHandle('F3')).toBe(liveLeafBeforeCancel)
    expect(draftRequests).toHaveLength(draftBeforeCancel)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().getPickHighlightState('FAKEDISPLAY:BOX:face#5')).toBe('none')
    expect(hooks().history.serialize()).toEqual(historyBeforeCancel)

    const secondEdit = hooks().editEntryFor('F2')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F2 must route to its Shell edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('shell-thickness')).toBeTruthy())
    commitField('shell-thickness', '3')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    const shellBeforeApply = shellRequests.length
    const draftBeforeApply = draftRequests.length
    const historyBeforeApply = hooks().history.size()
    const replayDraft = client.applyDraft.bind(client)
    let releaseDownstreamReplay: (() => void) | undefined
    client.applyDraft = (request) => new Promise<OpResult>((resolve, reject) => {
      releaseDownstreamReplay = () => { void replayDraft(request).then(resolve, reject) }
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(releaseDownstreamReplay).toBeDefined())
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('applying'))
    expect(screen.getByTestId('shell-preview-status').textContent).toMatch(/Applying/i)
    expect(screen.getByTestId('shell-workspace-palette').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('solids-workbench-root').getAttribute('aria-busy')).toBe('true')
    expect(hooks().history.size()).toBe(historyBeforeApply)
    const applyButton = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    const cancelButton = screen.getByTestId('dialog-shell-cancel') as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    expect((screen.getByTestId('workbench-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workbench-redo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(true)
    const undoChord = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(undoChord)
    expect(undoChord.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByTestId('feature-row-suppress-F3'))
    expect(hooks().dag.getNode('F3')?.suppressed).toBe(false)
    expect(hooks().history.size()).toBe(historyBeforeApply)
    expect(draftRequests).toHaveLength(draftBeforeApply)
    expect(hooks().editEntryFor('F3')).toMatchObject({
      reason: expect.stringMatching(/accepted Shell is being applied/i),
    })
    fireEvent.click(cancelButton)
    fireEvent.keyDown(screen.getByTestId('shell-thickness').querySelector('input') as HTMLInputElement, { key: 'Escape' })
    expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('applying')
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)

    releaseDownstreamReplay?.()
    client.applyDraft = replayDraft
    await waitFor(() => expect(screen.queryByTestId('shell-preview-status')).toBeNull())
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBe(liveLeafBeforeCancel))
    const adoptedShellHandle = hooks().getBodyHandle('F2')
    expect(hooks().dag.getNode('F2')?.payload.thickness).toBe(3)
    expect(shellRequests).toHaveLength(shellBeforeApply)
    expect(draftRequests).toHaveLength(draftBeforeApply + 1)
    expect(draftRequests.at(-1)?.body).toBe(adoptedShellHandle)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)

    const thirdEdit = hooks().editEntryFor('F2')
    if (thirdEdit === undefined || !('onEdit' in thirdEdit)) throw new Error('F2 must route to its Shell edit dialog')
    thirdEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('shell-thickness')).toBeTruthy())
    commitField('shell-thickness', '4')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    const historyBeforeReplayThrow = hooks().history.size()
    const shellBeforeReplayThrow = shellRequests.length
    const draftBeforeReplayThrow = draftRequests.length
    hooks().setShellDownstreamReplayProbe(() => {
      throw new Error('injected downstream replay failure')
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('shell-apply-error').textContent).toMatch(/downstream replay failed/i))
    expect(screen.getByTestId('shell-apply-error').textContent).toMatch(/No changes were applied/)
    expect(hooks().dag.getNode('F2')?.payload.thickness).toBe(3)
    expect(hooks().history.size()).toBe(historyBeforeReplayThrow)
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(shellRequests).toHaveLength(shellBeforeReplayThrow + 2)
    expect(shellRequests.at(-2)?.thickness).toBe(3)
    expect(shellRequests.at(-1)?.thickness).toBe(4)
    expect(draftRequests).toHaveLength(draftBeforeReplayThrow + 1)
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)
  }, 60_000)

  it('previews a non-leaf Draft at its timeline position and replays only downstream after adoption', async () => {
    const shellRequests: ShellRequest[] = []
    const draftRequests: DraftRequest[] = []
    const client = createFakeGeomClient({
      applyShellImpl: (request, mintHandle) => {
        shellRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyDraftImpl: (request, mintHandle) => {
        draftRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()

    await forceInsertAndBuild('F2', 'F1', {
      opType: 'draft',
      ownerId: 'F1',
      faces: ['F1:FACE:side'],
      angleDeg: 5,
      pullAxis: 'x',
      pullFlip: false,
      pullMode: 'axis',
      offset: 0,
      name: 'Draft F2',
    }, 'F1:FACE:side')
    await forceInsertAndBuild('F3', 'F2', {
      opType: 'shell',
      ownerId: 'F2',
      removeFaces: ['F2:FACE:top'],
      thickness: 2,
      name: 'Shell F3',
    }, 'F2:FACE:top')

    expect(hooks().getBodyPresentationIdentity('F2').mesh?.visible).not.toBe(true)
    expect(hooks().getBodyPresentationIdentity('F3').mesh?.visible).toBe(true)
    const f3PayloadBeforeEdit = structuredClone(hooks().dag.getNode('F3')?.payload)
    const f3ConsumesBeforeEdit = [...(hooks().dag.getNode('F3')?.consumes ?? [])]
    const downstreamRequestsBeforePreview = shellRequests.length
    const draftRequestsBeforePreview = draftRequests.length
    const draftEditEntry = hooks().editEntryFor('F2')
    if (draftEditEntry === undefined || !('onEdit' in draftEditEntry)) throw new Error('F2 must route to its Draft edit dialog')
    draftEditEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('draft-command-card')).toBeTruthy())
    commitField('draft-angle', '9')
    // WO-123: the prior preview can still report "ready" until the new
    // field-change effect starts. Await the request for this exact value,
    // not the stale generic status from the previous candidate.
    await waitFor(() => {
      expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready')
      expect(draftRequests.length).toBeGreaterThan(draftRequestsBeforePreview)
      expect(draftRequests.at(-1)?.angleDeg).toBe(9)
    }, { timeout: LOAD_TOLERANT_ASYNC_TIMEOUT_MS })

    expect(shellRequests).toHaveLength(downstreamRequestsBeforePreview)
    expect(hooks().dag.getNode('F2')?.payload.angleDeg).toBe(5)
    expect(hooks().getBodyPresentationIdentity('F3').mesh?.visible).toBe(false)
    expect(hooks().getBodyPresentationIdentity('__draft-preview__').mesh?.visible).toBe(true)

    const draftRequestsBeforeApply = draftRequests.length
    const shellRequestsBeforeApply = shellRequests.length
    const historyBeforeApply = hooks().history.size()
    const f2HandleBeforeApply = hooks().getBodyHandle('F2')
    const f3HandleBeforeApply = hooks().getBodyHandle('F3')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(shellRequests).toHaveLength(shellRequestsBeforeApply + 1))
    await waitFor(() => expect(screen.queryByTestId('draft-command-card')).toBeNull())
    const adoptedF2Handle = hooks().getBodyHandle('F2')
    expect(draftRequests).toHaveLength(draftRequestsBeforeApply)
    expect(adoptedF2Handle).not.toBe(f2HandleBeforeApply)
    expect(shellRequests.at(-1)?.body).toBe(adoptedF2Handle)
    expect(hooks().getBodyHandle('F3')).not.toBe(f3HandleBeforeApply)
    expect(hooks().history.size()).toBe(historyBeforeApply + 1)
    expect(hooks().dag.getNode('F2')?.payload.angleDeg).toBe(9)
    expect(hooks().getBodyPresentationIdentity('F2').mesh?.visible).not.toBe(true)
    expect(hooks().getBodyPresentationIdentity('F3').mesh?.visible).toBe(true)
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3PayloadBeforeEdit)
    expect(hooks().dag.getNode('F3')?.consumes).toEqual(f3ConsumesBeforeEdit)
  }, 60_000)

  it('edits both operations from tree/toolbar, preserves topology, replays, undoes, and refuses invalid refs', async () => {
    const shellRequests: ShellRequest[] = []
    const draftRequests: DraftRequest[] = []
    const client = createFakeGeomClient({
      applyShellImpl: (request, mintHandle) => {
        shellRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
      applyDraftImpl: (request, mintHandle) => {
        draftRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addBody()

    await forceInsertAndBuild('F2', 'F1', {
      opType: 'shell',
      ownerId: 'F1',
      removeFaces: ['FAKEDISPLAY:BOX:face#5'],
      thickness: 2,
      name: 'Shell F2',
    }, 'FAKEDISPLAY:BOX:face#5')

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const treeEdit = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(treeEdit.disabled).toBe(false)
    fireEvent.click(treeEdit)
    expect(screen.getByTestId('shell-workspace-palette')).toBeTruthy()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect((screen.getByTestId('shell-thickness').querySelector('input') as HTMLInputElement).value).toMatch(/^2(\.0*)?$/)
    expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i)
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    // Toggle the saved top face off, then select the +X face. Edit picking is
    // live and the changed removeFaces set must be persisted with matching refs.
    runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/0 faces to open/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    runtime.rayOverride = { origin: { x: 100, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i))
    commitField('shell-thickness', '4')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'))
    const shellRequestsBeforeApply = shellRequests.length
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => {
      const node = hooks().dag.getNode('F2')
      expect(node?.payload).toMatchObject({ thickness: 4, ownerId: 'F1', removeFaces: ['FAKEDISPLAY:BOX:face#1'] })
      expect(node?.consumes).toEqual(['F1'])
      expect(node?.refs).toEqual([{ id: 'FAKEDISPLAY:BOX:face#1', kind: 'face-set' }])
      expect(shellRequests.at(-1)?.thickness).toBe(4)
    })
    // Apply adopts the accepted preview body; it never invokes applyShell a
    // second time for the same settings.
    expect(shellRequests).toHaveLength(shellRequestsBeforeApply)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F2')?.payload.thickness).toBe(2)
      expect(hooks().dag.getNode('F2')?.consumes).toEqual(['F1'])
      expect(hooks().dag.getNode('F2')?.payload.removeFaces).toEqual(['FAKEDISPLAY:BOX:face#5'])
      expect(shellRequests.at(-1)?.thickness).toBe(2)
    })

    await forceInsertAndBuild('F3', 'F2', {
      opType: 'draft',
      ownerId: 'F2',
      faces: ['F2:FACE:side'],
      angleDeg: 5,
      pullAxis: 'x',
      pullFlip: false,
      pullMode: 'axis',
      offset: 1,
      name: 'Draft F3',
    }, 'F2:FACE:side')

    fireEvent.click(screen.getByTestId('feature-row-F3'))
    const toolbarEdit = screen.getByTestId('workbench-edit-feature') as HTMLButtonElement
    expect(toolbarEdit.disabled).toBe(false)
    fireEvent.click(toolbarEdit)
    expect(screen.getByTestId('draft-command-card')).toBeTruthy()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect((screen.getByTestId('draft-pull-axis') as HTMLSelectElement).value).toBe('x')
    expect((screen.getByTestId('draft-offset').querySelector('input') as HTMLInputElement).value).toMatch(/^1(\.0*)?$/)
    expect((screen.getByTestId('draft-angle').querySelector('input') as HTMLInputElement).value).toMatch(/^5(\.0*)?$/)
    expect(hooks().getPickHighlightState('F2:FACE:side')).toBe('selected')
    const draftEditHistorySize = hooks().history.size()
    fireEvent.change(screen.getByTestId('draft-pull-axis'), { target: { value: 'y' } })
    fireEvent.click(screen.getByTestId('draft-pull-flip'))
    commitField('draft-offset', '3')
    commitField('draft-angle', '8')
    await waitFor(() => {
      const status = screen.getByTestId('draft-preview-status')
      if (status.getAttribute('data-status') === 'refused') {
        throw new Error(status.textContent ?? 'Draft edit preview was refused')
      }
      expect(status.getAttribute('data-status')).toBe('ready')
      expect(draftRequests.at(-1)?.angleDeg).toBe(8)
    }, { timeout: LOAD_TOLERANT_ASYNC_TIMEOUT_MS })
    // Editing is a scratch preview: the authored node/history remain exactly
    // at the pre-edit state until Apply adopts this accepted body.
    expect(hooks().dag.getNode('F3')?.payload.angleDeg).toBe(5)
    expect(hooks().history.size()).toBe(draftEditHistorySize)
    const requestsBeforeApply = draftRequests.length
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => {
      const node = hooks().dag.getNode('F3')
      expect(node?.payload).toMatchObject({
        faces: ['F2:FACE:side'],
        angleDeg: 8,
        pullAxis: 'y',
        pullFlip: true,
        pullMode: 'axis',
        offset: 3,
      })
      expect(node?.consumes).toEqual(['F2'])
      expect(node?.refs).toEqual([{ id: 'F2:FACE:side', kind: 'face-set' }])
      expect(draftRequests.at(-1)).toMatchObject({
        angleDeg: 8,
        pullDir: { x: 0, y: -1, z: 0 },
        neutralPlane: { origin: { x: 0, y: -3, z: 0 }, normal: { x: 0, y: -1, z: 0 } },
      })
    })
    // Apply adopts the already-rendered result; it must not issue a second
    // kernel Draft request whose answer could differ from the preview.
    expect(draftRequests).toHaveLength(requestsBeforeApply)
    expect(hooks().history.size()).toBe(draftEditHistorySize + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F3')?.payload).toMatchObject({
        angleDeg: 5,
        pullAxis: 'x',
        pullFlip: false,
        offset: 1,
      })
      expect(hooks().dag.getNode('F3')?.consumes).toEqual(['F2'])
      expect(draftRequests.at(-1)).toMatchObject({
        angleDeg: 5,
        pullDir: { x: 1, y: 0, z: 0 },
        neutralPlane: { origin: { x: 1, y: 0, z: 0 } },
      })
    })

    // A second edit proves Cancel is byte/handle exact: the current feature is
    // hidden only as presentation while the changed candidate is previewed.
    const restoredHandle = hooks().getBodyHandle('F3')
    fireEvent.click(screen.getByTestId('feature-row-F3'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    commitField('draft-angle', '11')
    await waitFor(() => {
      expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready')
      expect(draftRequests.at(-1)?.angleDeg).toBe(11)
    }, { timeout: LOAD_TOLERANT_ASYNC_TIMEOUT_MS })
    expect(hooks().dag.getNode('F3')?.payload.angleDeg).toBe(5)
    expect(hooks().getBodyHandle('F3')).toBe(restoredHandle)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('draft-command-card')).toBeNull())
    expect(hooks().dag.getNode('F3')?.payload.angleDeg).toBe(5)
    expect(hooks().getBodyHandle('F3')).toBe(restoredHandle)
    expect(hooks().getPickHighlightState('F2:FACE:side')).toBe('none')

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-SHELL',
      kind: 'feature',
      consumes: [],
      payload: {
        opType: 'shell',
        ownerId: 'F3',
        removeFaces: ['F3:FACE:bad'],
        thickness: 2,
        name: 'Broken shell',
      },
    }))
    const shellBefore = hooks().dag.getNode('BAD-SHELL')
    const invalidShellEntry = hooks().editEntryFor('BAD-SHELL')
    if (invalidShellEntry === undefined || !('onEdit' in invalidShellEntry)) throw new Error('BAD-SHELL must route to its edit dialog')
    invalidShellEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('shell-reference-error').textContent).toMatch(/missing from the feature dependencies/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('BAD-SHELL')).toEqual(shellBefore)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-DRAFT',
      kind: 'feature',
      consumes: [],
      payload: {
        opType: 'draft',
        ownerId: 'F3',
        faces: ['F3:FACE:bad'],
        angleDeg: 5,
        pullAxis: 'z',
        pullFlip: true,
        pullMode: 'axis',
        offset: 0,
        name: 'Broken draft',
      },
    }))
    const draftBefore = hooks().dag.getNode('BAD-DRAFT')
    const invalidDraftEntry = hooks().editEntryFor('BAD-DRAFT')
    if (invalidDraftEntry === undefined || !('onEdit' in invalidDraftEntry)) throw new Error('BAD-DRAFT must route to its edit dialog')
    invalidDraftEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('draft-reference-error').textContent).toMatch(/missing from the feature dependencies/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('BAD-DRAFT')).toEqual(draftBefore)
  })
})
