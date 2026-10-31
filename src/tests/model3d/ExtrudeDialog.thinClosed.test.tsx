// @vitest-environment jsdom
//
// WO-3234: Thin in the Extrude dialog (DAG + CommandHistory, no kernel).
//
//  - Create: the Thin toggle, thickness and side write wallMode 'thin' +
//    wallThickness + wallSide in ONE history step; undo removes it.
//  - Default side is Inside (owner decision, recorded in the order).
//  - The preview intent carries thickness and side, and changes when either does.
//  - Thin with a target-driven end says so in one line, emits no preview and
//    keeps Apply off -- the end condition is never switched to Blind.
//  - Edit: thickness/side changes are one undo step; Thin off writes an
//    explicit solid and drops the old thickness/side.
//  - With Thin off a stale, invalid thickness on the payload is never checked.
//  - The thickness field has no floor: a typed 0.005 mm reaches the payload and
//    the preview exactly; 0 or a negative wall is refused with its reason at
//    the field (no preview, Apply off) and never replaced by another value.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExtrudeDialog } from '../../components/model3d/dialogs'
import type { ExtrudePreviewIntent } from '../../components/model3d/dialogs/ExtrudeDialog'
import { CommandHistory, FeatureDag } from '../../doc'
import { textFor } from '../../i18n'

const thinText = textFor('thin-extrude.wo3234')
const thinEndsText = textFor('thin-extrude-ends.wo3235')

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function setup(extrude?: Record<string, unknown>) {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1' } })
  if (extrude !== undefined) {
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', name: 'Extrude F1', ...extrude } })
  }
  return { dag, history: new CommandHistory(dag) }
}

function applyButton(): HTMLButtonElement {
  return screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
}

describe('WO-3234 ExtrudeDialog Thin', () => {
  it('create: Thin with thickness and side writes the wall keys in one undoable step', () => {
    const { dag, history } = setup()
    render(
      <ExtrudeDialog dag={dag} history={history} mode="create" sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]} onApplied={() => {}} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('extrude-thin-thickness')).toBeNull()
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    expect((screen.getByTestId('extrude-thin-side') as HTMLSelectElement).value).toBe('inside')
    commitField('extrude-distance', '8')
    commitField('extrude-thin-thickness', '2')
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'outside' } })
    fireEvent.click(applyButton())

    expect(dag.getNode('F1')?.payload).toEqual({
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 8,
      direction: 'up',
      endCondition: 'blind',
      boolMode: 'newBody',
      wallMode: 'thin',
      wallThickness: 2,
      wallSide: 'outside',
      name: 'Extrude F1',
    })
    expect(history.size()).toBe(1)
    expect(history.undo()).toBe(true)
    expect(dag.has('F1')).toBe(false)
  })

  it('create with Thin off writes the ordinary solid payload, with no wall keys', () => {
    const { dag, history } = setup()
    render(
      <ExtrudeDialog dag={dag} history={history} mode="create" sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]} onApplied={() => {}} onClose={() => {}} />,
    )
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    commitField('extrude-thin-thickness', '3')
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    fireEvent.click(applyButton())
    const payload = dag.getNode('F1')!.payload
    expect(payload).not.toHaveProperty('wallMode')
    expect(payload).not.toHaveProperty('wallThickness')
    expect(payload).not.toHaveProperty('wallSide')
  })

  it('the preview intent carries thickness and side, and the summary names the side', () => {
    const { dag, history } = setup()
    const intents: Array<ExtrudePreviewIntent | null> = []
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        onApplied={() => {}}
        onClose={() => {}}
        previewState={{ status: 'idle' }}
        onPreviewIntent={(intent) => intents.push(intent)}
      />,
    )
    expect(intents.at(-1)).not.toHaveProperty('wallMode')
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    expect(intents.at(-1)).toMatchObject({ wallMode: 'thin', wallThickness: 1, wallSide: 'inside' })
    expect(screen.getByTestId('extrude-thin-summary').textContent).toBe(thinText('summaryInside', { thickness: '1' }))

    commitField('extrude-thin-thickness', '2')
    expect(intents.at(-1)).toMatchObject({ wallMode: 'thin', wallThickness: 2, wallSide: 'inside' })
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'center' } })
    expect(intents.at(-1)).toMatchObject({ wallMode: 'thin', wallThickness: 2, wallSide: 'center' })
    expect(screen.getByTestId('extrude-thin-summary').getAttribute('data-side')).toBe('center')
    expect(screen.getByTestId('extrude-thin-summary').textContent).toBe(thinText('summaryCenter', { thickness: '2', half: '1' }))

    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    const solid = intents.at(-1)!
    expect(solid).not.toHaveProperty('wallMode')
    expect(solid).not.toHaveProperty('wallThickness')
    expect(solid).not.toHaveProperty('wallSide')
  })

  it('Thin with a target-driven end is accepted and carries its one-line note, never falling back to Blind', () => {
    const { dag, history } = setup()
    const intents: Array<ExtrudePreviewIntent | null> = []
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        bodyOptions={[{ id: 'B0', label: 'Body B0' }]}
        onApplied={() => {}}
        onClose={() => {}}
        previewState={{ status: 'idle' }}
        onPreviewIntent={(intent) => intents.push(intent)}
      />,
    )
    // WO-3235 supports every Thin end condition. Through all is accepted, the
    // chosen end condition is retained, and the old blanket refusal is gone.
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'throughAll' } })
    expect(screen.queryByTestId('extrude-thin-end-unavailable')).toBeNull()
    expect(screen.queryByTestId('extrude-thin-end-note')).toBeNull()
    expect((screen.getByTestId('extrude-end-condition-select') as HTMLSelectElement).value).toBe('throughAll')
    expect(intents.at(-1)).toMatchObject({ endCondition: 'throughAll', wallMode: 'thin' })
    expect(applyButton().disabled).toBe(false)

    // Up to next carries the one-line note that the wall stops on its own section.
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'upToNext' } })
    expect(screen.getByTestId('extrude-thin-end-note').textContent).toBe(thinEndsText('wallsStopOnTheirOwnSection'))
    expect((screen.getByTestId('extrude-end-condition-select') as HTMLSelectElement).value).toBe('upToNext')

    // Symmetric is a Thin end with no note.
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'symmetric' } })
    expect(screen.queryByTestId('extrude-thin-end-note')).toBeNull()
    expect(intents.at(-1)).toMatchObject({ endCondition: 'symmetric', direction: 'midplane', wallMode: 'thin' })
    expect(applyButton().disabled).toBe(false)

    // The ordinary solid keeps every end condition and no Thin note.
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'throughAll' } })
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    expect(screen.queryByTestId('extrude-thin-end-note')).toBeNull()
    expect(intents.at(-1)).toMatchObject({ endCondition: 'throughAll' })
  })

  it('edit: thickness and side change in one undo step', () => {
    const { dag, history } = setup({ distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', wallMode: 'thin', wallThickness: 1, wallSide: 'inside' })
    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    expect((screen.getByTestId('extrude-thin-toggle') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('extrude-thin-thickness').querySelector('input') as HTMLInputElement).value).toBe('1')
    commitField('extrude-thin-thickness', '1.5')
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'outside' } })
    fireEvent.click(applyButton())
    expect(dag.getNode('F1')!.payload).toMatchObject({ wallMode: 'thin', wallThickness: 1.5, wallSide: 'outside' })
    expect(history.size()).toBe(1)
    expect(history.undo()).toBe(true)
    expect(dag.getNode('F1')!.payload).toMatchObject({ wallMode: 'thin', wallThickness: 1, wallSide: 'inside' })
  })

  it('edit: Thin off writes an explicit solid and drops the old thickness and side', () => {
    const { dag, history } = setup({ distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', wallMode: 'thin', wallThickness: 1, wallSide: 'center' })
    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    fireEvent.click(applyButton())
    const payload = dag.getNode('F1')!.payload
    expect(payload.wallMode).toBe('solid')
    expect(payload).not.toHaveProperty('wallThickness')
    expect(payload).not.toHaveProperty('wallSide')
  })

  it('edit: a stale invalid thickness on a solid is not validated and Apply works', () => {
    const { dag, history } = setup({ distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', wallMode: 'solid', wallThickness: -4, wallSide: 'sideways' })
    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    expect((screen.getByTestId('extrude-thin-toggle') as HTMLInputElement).checked).toBe(false)
    expect(applyButton().disabled).toBe(false)
    commitField('extrude-distance', '9')
    fireEvent.click(applyButton())
    expect(screen.queryByTestId('extrude-apply-error')).toBeNull()
    const payload = dag.getNode('F1')!.payload
    expect(payload).toMatchObject({ distance: 9, wallMode: 'solid' })
    expect(payload).not.toHaveProperty('wallThickness')
  })

  it('edit: a reopened pre-Thin extrude (explicit solid) stays explicit through a distance edit', () => {
    const { dag, history } = setup({ distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', wallMode: 'solid' })
    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    commitField('extrude-distance', '12')
    fireEvent.click(applyButton())
    expect(dag.getNode('F1')!.payload).toMatchObject({ distance: 12, wallMode: 'solid' })
  })

  it('a small positive thickness (0.005 mm) reaches the preview and the payload exactly as typed', () => {
    const { dag, history } = setup()
    const intents: Array<ExtrudePreviewIntent | null> = []
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        onApplied={() => {}}
        onClose={() => {}}
        previewState={{ status: 'idle' }}
        onPreviewIntent={(intent) => intents.push(intent)}
      />,
    )
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    commitField('extrude-thin-thickness', '0.005')
    expect(intents.at(-1)).toMatchObject({ wallMode: 'thin', wallThickness: 0.005, wallSide: 'inside' })
    expect(screen.queryByTestId('extrude-thin-thickness-invalid')).toBeNull()
    expect(applyButton().disabled).toBe(false)
    fireEvent.click(applyButton())
    expect(dag.getNode('F1')!.payload).toMatchObject({ wallMode: 'thin', wallThickness: 0.005, wallSide: 'inside' })
  })

  it('a zero or negative thickness is refused with its reason at the field, never substituted', () => {
    const { dag, history } = setup()
    const intents: Array<ExtrudePreviewIntent | null> = []
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        onApplied={() => {}}
        onClose={() => {}}
        previewState={{ status: 'idle' }}
        onPreviewIntent={(intent) => intents.push(intent)}
      />,
    )
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    for (const [raw, shown] of [['0', '0'], ['-2', '-2']] as const) {
      commitField('extrude-thin-thickness', raw)
      expect((screen.getByTestId('extrude-thin-thickness').querySelector('input') as HTMLInputElement).value).toBe(shown)
      expect(screen.getByTestId('extrude-thin-thickness-invalid').textContent)
        .toBe(thinText('thicknessMustBePositive', { thickness: shown }))
      expect(screen.queryByTestId('extrude-thin-summary')).toBeNull()
      expect(intents.at(-1)).toBeNull()
      expect(applyButton().disabled).toBe(true)
    }
    fireEvent.click(applyButton())
    expect(dag.has('F1')).toBe(false)
    expect(history.size()).toBe(0)
  })
})
