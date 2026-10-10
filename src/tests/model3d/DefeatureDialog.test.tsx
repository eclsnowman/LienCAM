// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import {
  DefeatureDialog,
  type DefeaturePreviewIntent,
} from '../../components/model3d/dialogs/DefeatureDialog'
import { CommandHistory, FeatureDag } from '../../doc'
import type { FeatureVerdict } from '../../geom/geom-service'

afterEach(cleanup)

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

function setupCreate(): { dag: FeatureDag; history: CommandHistory } {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { name: 'Base body' } })
  return { dag, history: new CommandHistory(dag) }
}

function setupEdit(): { dag: FeatureDag; history: CommandHistory } {
  const { dag } = setupCreate()
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    payload: {
      opType: 'defeature',
      ownerId: 'F1',
      featureKeys: [FILLET.featureKey],
      name: 'Delete 1 fillet',
    },
  })
  return { dag, history: new CommandHistory(dag) }
}

const readyPreview = { kind: 'ready', message: 'Healed preview ready.' } as const

describe('DefeatureDialog preview adoption', () => {
  it('routes controlled create through preview adoption without authoring a duplicate node', async () => {
    const { dag, history } = setupCreate()
    const onApplied = vi.fn()
    const onClose = vi.fn()
    const onApplyPreview = vi.fn(async (_intent: DefeaturePreviewIntent) => undefined)

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET]}
        selectedKeys={new Set([FILLET.featureKey])}
        onToggleKey={() => {}}
        previewFeedback={readyPreview}
        onApplyPreview={onApplyPreview}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledWith({
      featureId: 'F2',
      payload: {
        opType: 'defeature',
        ownerId: 'F1',
        featureKeys: [FILLET.featureKey],
        name: 'Delete 1 fillet',
      },
    }))
    expect(dag.getNode('F2')).toBeUndefined()
    expect(history.canUndo()).toBe(false)
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('awaits controlled edit adoption without mutating the live DAG or local history', async () => {
    const { dag, history } = setupEdit()
    const onApplied = vi.fn()
    const onClose = vi.fn()
    const onApplyPreview = vi.fn(async (_intent: DefeaturePreviewIntent) => undefined)

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET, CHAMFER]}
        mode="edit"
        featureId="F2"
        initialFeatureKeys={[FILLET.featureKey]}
        selectedKeys={new Set([CHAMFER.featureKey])}
        onToggleKey={() => {}}
        previewFeedback={readyPreview}
        onApplyPreview={onApplyPreview}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledTimes(1))
    expect(onApplyPreview).toHaveBeenCalledWith({
      featureId: 'F2',
      payload: {
        opType: 'defeature',
        ownerId: 'F1',
        featureKeys: [CHAMFER.featureKey],
        name: 'Delete 1 chamfer',
      },
    })
    expect(dag.getNode('F2')?.payload.featureKeys).toEqual([FILLET.featureKey])
    expect(history.canUndo()).toBe(false)
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('locks selection, Apply, Close, Cancel, and Escape while adoption is pending', async () => {
    const { dag, history } = setupEdit()
    const onToggleKey = vi.fn()
    const onApplied = vi.fn()
    const onClose = vi.fn()
    let finishApply!: (error: string | undefined) => void
    const onApplyPreview = vi.fn(() => new Promise<string | undefined>((resolve) => {
      finishApply = resolve
    }))

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET, CHAMFER]}
        mode="edit"
        featureId="F2"
        initialFeatureKeys={[FILLET.featureKey]}
        selectedKeys={new Set([FILLET.featureKey])}
        onToggleKey={onToggleKey}
        previewFeedback={readyPreview}
        onApplyPreview={onApplyPreview}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledTimes(1))

    const filletCheck = screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement
    const chamferCheck = screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`) as HTMLInputElement
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    const close = screen.getByTestId('dialog-shell-close') as HTMLButtonElement
    const cancel = screen.getByTestId('dialog-shell-cancel') as HTMLButtonElement
    expect(filletCheck.disabled).toBe(true)
    expect(chamferCheck.disabled).toBe(true)
    expect(apply.disabled).toBe(true)
    expect(close.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)

    fireEvent.click(filletCheck)
    fireEvent.click(apply)
    fireEvent.click(close)
    fireEvent.click(cancel)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onToggleKey).not.toHaveBeenCalled()
    expect(onApplyPreview).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finishApply(undefined))
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('F2'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a returned named adoption error, unlocks, and remains open', async () => {
    const { dag, history } = setupEdit()
    const onApplied = vi.fn()
    const onClose = vi.fn()
    const failure = 'Defeature Apply refused: accepted preview expired.'

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET]}
        mode="edit"
        featureId="F2"
        initialFeatureKeys={[FILLET.featureKey]}
        selectedKeys={new Set([FILLET.featureKey])}
        onToggleKey={() => {}}
        previewFeedback={readyPreview}
        onApplyPreview={async () => failure}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('defeature-apply-error').textContent).toBe(failure))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).disabled).toBe(false)
    expect(dag.getNode('F2')?.payload.featureKeys).toEqual([FILLET.featureKey])
    expect(history.canUndo()).toBe(false)
    expect(onApplied).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('names a thrown adoption failure and remains open', async () => {
    const { dag, history } = setupEdit()
    const onClose = vi.fn()

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET]}
        mode="edit"
        featureId="F2"
        initialFeatureKeys={[FILLET.featureKey]}
        selectedKeys={new Set([FILLET.featureKey])}
        onToggleKey={() => {}}
        previewFeedback={readyPreview}
        onApplyPreview={async () => { throw new Error('accepted preview could not be adopted') }}
        onApplied={() => {}}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(screen.getByTestId('defeature-apply-error').textContent).toBe(
      'Defeature Apply failed: accepted preview could not be adopted',
    ))
    expect(history.canUndo()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('DefeatureDialog compatibility', () => {
  it('preserves standalone create behavior and its one history transaction', () => {
    const { dag, history } = setupCreate()
    const onApplied = vi.fn()
    const onClose = vi.fn()

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET, CHAMFER]}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature',
      ownerId: 'F1',
      featureKeys: [FILLET.featureKey, CHAMFER.featureKey],
      name: 'Delete 2 feature groups',
    })
    expect(history.canUndo()).toBe(true)
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy local edit command when no adoption callback is supplied', () => {
    const { dag, history } = setupEdit()
    const onApplied = vi.fn()
    const onClose = vi.fn()

    render(
      <DefeatureDialog
        dag={dag}
        history={history}
        ownerId="F1"
        verdicts={[FILLET, CHAMFER]}
        mode="edit"
        featureId="F2"
        initialFeatureKeys={[FILLET.featureKey]}
        onApplied={onApplied}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F2')?.payload.featureKeys).toEqual([FILLET.featureKey, CHAMFER.featureKey])
    expect(history.canUndo()).toBe(true)
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
