// @vitest-environment jsdom
//
// GEO-18: Draft direction UI and face-frame persistence, using the same small
// "DAG + CommandHistory only, no page" harness as the original axis tests.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { DraftDialog } from '../../components/model3d/dialogs/DraftDialog'
import { draftFaceNormalPlane } from '../../components/model3d/dialogs/dressUpGeometry'
import { CommandHistory, FeatureDag } from '../../doc'

afterEach(cleanup)

function setup() {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } })
  const history = new CommandHistory(dag)
  return { dag, history }
}

describe('DraftDialog pull direction (GEO-18)', () => {
  it('UI-91 tells the truth before a managed viewport workflow has a neutral face', () => {
    const { dag, history } = setup()
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        faceIds={[]}
        selectionStep="neutral"
        onConfirmNeutral={() => {}}
        onReselectNeutral={() => {}}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId('draft-face-count').textContent).toBe('0 neutral faces, 0 draft faces')
    expect(screen.getByTestId('draft-face-frame-error').textContent).toMatch(/click a neutral face in the viewport/i)
    expect(screen.getByTestId('draft-face-frame-error').textContent).not.toMatch(/world axis/i)
  })

  it('UI-91 renders a movable non-modal command card with explicit neutral and draft-face roles', () => {
    const { dag, history } = setup()
    let closed = false
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['neutral-face', 'draft-face']}
        selectedFaceFrame={{ origin: { x: 4, y: 5, z: 6 }, normal: { x: 0, y: 1, z: 0 } }}
        selectionStep="faces"
        onConfirmNeutral={() => {}}
        onReselectNeutral={() => {}}
        onApplied={() => {}}
        onClose={() => { closed = true }}
      />,
    )

    expect(screen.getByTestId('draft-command-card')).toBeTruthy()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect(screen.getByTestId('draft-neutral-face-role').textContent).toMatch(/neutral face/i)
    expect(screen.getByTestId('draft-face-role').textContent).toMatch(/1 draft face/i)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closed).toBe(true)
  })

  it('UI-91 lets the command card move without leaving the viewport', () => {
    const { dag, history } = setup()
    render(
      <DraftDialog dag={dag} history={history} mode="create" ownerId="F1" faceIds={['face1']} onApplied={() => {}} onClose={() => {}} />,
    )
    const card = screen.getByTestId('draft-command-card')
    const header = card.querySelector('header')
    if (header === null) throw new Error('expected draft command header')
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const getBoundingClientRect = card.getBoundingClientRect
    card.getBoundingClientRect = () => ({
      x: 288,
      y: 76,
      width: 344,
      height: 420,
      top: 76,
      right: 632,
      bottom: 496,
      left: 288,
      toJSON: () => ({}),
    }) as DOMRect

    try {
      fireEvent.pointerDown(header, { pointerId: 9, clientX: 312, clientY: 100 })
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 512, clientY: 220 })
      fireEvent.pointerUp(window, { pointerId: 9 })
      expect(card.style.left).toBe('488px')
      expect(card.style.top).toBe('196px')
    } finally {
      card.getBoundingClientRect = getBoundingClientRect
      if (innerWidth === undefined) delete (window as { innerWidth?: number }).innerWidth
      else Object.defineProperty(window, 'innerWidth', innerWidth)
      if (innerHeight === undefined) delete (window as { innerHeight?: number }).innerHeight
      else Object.defineProperty(window, 'innerHeight', innerHeight)
    }
  })

  it('unlocks X and Y while keeping Z enabled', () => {
    const { dag, history } = setup()
    render(
      <DraftDialog dag={dag} history={history} mode="create" ownerId="F1" faceIds={['face1']} onApplied={() => {}} onClose={() => {}} />,
    )

    const x = screen.getByTestId('draft-pull-axis-option-x') as HTMLOptionElement
    const y = screen.getByTestId('draft-pull-axis-option-y') as HTMLOptionElement
    const z = screen.getByTestId('draft-pull-axis-option-z') as HTMLOptionElement

    expect(x.disabled).toBe(false)
    expect(y.disabled).toBe(false)
    expect(z.disabled).toBe(false)

    expect(x.text).toBe('X')
    expect(y.text).toBe('Y')
    expect(z.text).toBe('Z')
  })

  it('Z is the default selected pull axis (the working path) and Apply still inserts a real draft feature', () => {
    const { dag, history } = setup()
    let applied: string | null = null
    render(
      <DraftDialog dag={dag} history={history} mode="create" ownerId="F1" faceIds={['face1']} onApplied={(id) => (applied = id)} onClose={() => {}} />,
    )
    expect((screen.getByTestId('draft-pull-axis') as HTMLSelectElement).value).toBe('z')

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(applied).toBe('F2')
    expect(dag.getNode('F2')?.payload).toMatchObject({ opType: 'draft', pullAxis: 'z' })

    expect(history.undo()).toBe(true)
    expect(dag.has('F2')).toBe(false)
  })

  it('persists the selected face frame when face-normal mode is applied', () => {
    const { dag, history } = setup()
    const selectedFaceFrame = {
      origin: { x: 12, y: -3, z: 8 },
      normal: { x: 0, y: 3, z: 4 },
    }
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['face1', 'face2']}
        selectedFaceFrame={selectedFaceFrame}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    const faceOption = screen.getByTestId('draft-pull-axis-option-face-normal') as HTMLOptionElement
    expect(faceOption.disabled).toBe(false)
    fireEvent.change(screen.getByTestId('draft-pull-axis'), { target: { value: 'face-normal' } })
    expect(screen.getByTestId('draft-pull-summary').textContent).toMatch(/selected face/)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(dag.getNode('F2')?.payload).toMatchObject({
      opType: 'draft',
      pullMode: 'face-normal',
      faceFrame: selectedFaceFrame,
      faceFrameSourceId: 'face1',
      faces: ['face2'],
    })
  })

  it('surfaces an unavailable face frame and refuses degenerate face geometry', () => {
    const { dag, history } = setup()
    render(
      <DraftDialog dag={dag} history={history} mode="create" ownerId="F1" faceIds={['face1']} onApplied={() => {}} onClose={() => {}} />,
    )
    expect((screen.getByTestId('draft-pull-axis-option-face-normal') as HTMLOptionElement).disabled).toBe(true)
    expect(screen.getByTestId('draft-face-frame-error').textContent).toMatch(/unavailable/i)

    expect(
      draftFaceNormalPlane(
        { origin: { x: 1, y: 2, z: 3 }, normal: { x: 0, y: 0, z: 0 } },
        false,
        0,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/degenerate/i) })
  })

  it('existing draft render tests stay green unmodified: face count, offset, angle fields all still render', () => {
    const { dag, history } = setup()
    render(
      <DraftDialog dag={dag} history={history} mode="create" ownerId="F1" faceIds={['face1', 'face2']} onApplied={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByTestId('draft-face-count').textContent).toMatch(/2 faces selected/)
    expect(screen.getByTestId('draft-offset')).toBeTruthy()
    expect(screen.getByTestId('draft-angle')).toBeTruthy()
    expect(screen.getByTestId('draft-pull-summary').textContent).toMatch(/world -Z/)
  })

  it('UI-107 keeps controlled preview changes out of live history and adopts only a ready candidate', async () => {
    const { dag, history } = setup()
    const onPreviewIntent = vi.fn()
    const onApplyPreview = vi.fn(async () => undefined)
    const onApplied = vi.fn()
    const onClose = vi.fn()
    const props = {
      dag,
      history,
      mode: 'create' as const,
      ownerId: 'F1',
      faceIds: ['face1'],
      previewFeatureId: 'F2',
      onPreviewIntent,
      onApplyPreview,
      onApplied,
      onClose,
    }
    const view = render(<DraftDialog {...props} previewState={{ status: 'pending' } as const} />)

    await waitFor(() => expect(onPreviewIntent).toHaveBeenCalledTimes(1))
    const intent = onPreviewIntent.mock.calls[0][0]
    expect(intent).toMatchObject({
      featureId: 'F2',
      payload: { opType: 'draft', ownerId: 'F1', faces: ['face1'], angleDeg: 5 },
    })
    expect(history.size()).toBe(0)
    expect(dag.has('F2')).toBe(false)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    view.rerender(<DraftDialog {...props} previewState={{ status: 'ready' } as const} />)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledTimes(1))
    expect(onApplyPreview).toHaveBeenCalledWith(intent)
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(history.size()).toBe(0)
    expect(dag.has('F2')).toBe(false)
  })

  it('UI-107 surfaces a controlled preview refusal and never calls Apply', async () => {
    const { dag, history } = setup()
    const onApplyPreview = vi.fn(async () => undefined)
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['face1']}
        previewFeatureId="F2"
        previewState={{ status: 'refused', message: 'Draft preview refused: invalid face.' }}
        onPreviewIntent={() => {}}
        onApplyPreview={onApplyPreview}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId('draft-preview-status').textContent).toMatch(/invalid face/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(onApplyPreview).not.toHaveBeenCalled()
    expect(history.size()).toBe(0)
  })

  it('UI-107 freezes every mutating and cancel path while an accepted preview is being adopted', async () => {
    const { dag, history } = setup()
    let finishApply!: (value: string | undefined) => void
    const onApplyPreview = vi.fn(() => new Promise<string | undefined>((resolve) => { finishApply = resolve }))
    const onClose = vi.fn()
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['face1']}
        previewFeatureId="F2"
        previewState={{ status: 'ready' }}
        onPreviewIntent={() => {}}
        onApplyPreview={onApplyPreview}
        onApplied={() => {}}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId('draft-pull-axis') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByTestId('draft-pull-flip') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('draft-offset').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('draft-angle').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('dialog-shell-close') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('dialog-shell-cancel') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(onClose).not.toHaveBeenCalled()

    finishApply(undefined)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('UI-107 emits edit intents from saved selections without mutating the applied feature', async () => {
    const { dag, history } = setup()
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      refs: [{ id: 'face1', kind: 'single-face' }],
      payload: {
        opType: 'draft',
        ownerId: 'F1',
        faces: ['face1'],
        angleDeg: 5,
        pullAxis: 'z',
        pullFlip: false,
        pullMode: 'axis',
        offset: 0,
        name: 'Draft F2',
      },
    })
    const onPreviewIntent = vi.fn()
    const onApplyPreview = vi.fn(async () => undefined)
    const onApplied = vi.fn()
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="edit"
        featureId="F2"
        previewState={{ status: 'ready' }}
        onPreviewIntent={onPreviewIntent}
        onApplyPreview={onApplyPreview}
        onApplied={onApplied}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(onPreviewIntent).toHaveBeenCalled())
    onPreviewIntent.mockClear()

    const angleInput = screen.getByTestId('draft-angle').querySelector('input') as HTMLInputElement
    fireEvent.change(angleInput, { target: { value: '9' } })
    fireEvent.blur(angleInput)
    await waitFor(() => expect(onPreviewIntent).toHaveBeenCalled())
    const intent = onPreviewIntent.mock.calls.at(-1)?.[0]
    expect(intent).toMatchObject({
      featureId: 'F2',
      payload: { ownerId: 'F1', faces: ['face1'], angleDeg: 9, name: 'Draft F2' },
    })
    expect(dag.getNode('F2')?.payload.angleDeg).toBe(5)
    expect(history.size()).toBe(0)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(onApplyPreview).toHaveBeenCalledWith(intent))
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(dag.getNode('F2')?.payload.angleDeg).toBe(5)
    expect(history.size()).toBe(0)
  })
})
