// @vitest-environment jsdom
//
// WO INT-4A: RevolveDialog render/behavior test -- mirrors ExtrudeDialog.test.tsx
// exactly, substituting angleDeg for distance (see that file's header).

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { RevolveDialog } from '../../components/model3d/dialogs'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { CommandHistory, FeatureDag } from '../../doc'
import { createLocalGeomService } from '../../geom'
import { useCamStore } from '../../store'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})
afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function setupWithSketch() {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1' } })
  const history = new CommandHistory(dag)
  return { dag, history }
}

// WO-1474: a minimal ProfileRegion on a plane with the given normal. The
// whole-sketch selector path only reads the region list and its plane.
function setupWithPlaneSketch(normal: { x: number; y: number; z: number }) {
  const dag = new FeatureDag()
  dag.insertNode({
    id: 'SK1',
    kind: 'sketch',
    payload: {
      name: 'Sketch SK1',
      regions: [{ sketchId: 'SK1', plane: { origin: { x: 0, y: 0, z: 0 }, normal, xDir: { x: 1, y: 0, z: 0 } }, loops: [] }],
    },
  })
  const history = new CommandHistory(dag)
  return { dag, history }
}

function axisWarnings() {
  return useCamStore.getState().consoleEvents.filter((event) => /revolve axis/i.test(event.message))
}

function applyButton(): HTMLButtonElement {
  return screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
}

describe('RevolveDialog (WO INT-4A)', () => {
  it('create mode inserts a feature node consuming the selected sketch, undo removes it', () => {
    const { dag, history } = setupWithSketch()
    let applied: string | null = null
    render(
      <RevolveDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        onApplied={(id) => (applied = id)}
        onClose={() => {}}
      />,
    )

    commitField('revolve-angle', '180')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(applied).toBe('F1')
    const node = dag.getNode('F1')
    expect(node?.consumes).toEqual(['SK1'])
    expect(node?.payload).toMatchObject({ opType: 'revolve', sketchId: 'SK1', angleDeg: 180 })

    expect(history.undo()).toBe(true)
    expect(dag.has('F1')).toBe(false)
  })

  it('edit mode changes only the angle through EditFeaturePayloadCommand, undo restores it', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 270, name: 'Revolve F1' } })

    render(<RevolveDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)

    const angleInput = screen.getByTestId('revolve-angle').querySelector('input') as HTMLInputElement
    expect(angleInput.value).toBe('270')
    expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect(screen.getByTestId('revolve-pick-profile')).toBeTruthy()

    commitField('revolve-angle', '90')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F1')?.payload).toMatchObject({ sketchId: 'SK1', angleDeg: 90 })
    expect(history.undo()).toBe(true)
    expect(dag.getNode('F1')?.payload.angleDeg).toBe(270)
  })

  it('WO INT-4A-R1.1: binding a driving expression sets payload.expression and consumes the referenced parameter', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'param:sweep', kind: 'parameter', payload: { name: 'sweep', expression: '90', value: 90 } })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 270, name: 'Revolve F1' } })

    render(<RevolveDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)

    fireEvent.change(screen.getByTestId('revolve-angle-expression'), { target: { value: 'sweep*4' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const node = dag.getNode('F1')
    expect(node?.payload.expression).toBe('sweep*4')
    expect(node?.consumes.slice().sort()).toEqual(['SK1', 'param:sweep'])
  })
})

describe('WO-1474: a profile whose plane normal is the world-Z revolve axis is refused with a stated reason', () => {
  it('dialog: an XY-plane profile disables Apply and writes exactly one app console warning, even across re-renders', () => {
    const { dag, history } = setupWithPlaneSketch({ x: 0, y: 0, z: 1 })
    const props = { dag, history, mode: 'create' as const, sketchOptions: [{ id: 'SK1', label: 'Sketch SK1' }], onApplied: () => {}, onClose: () => {} }
    const { rerender } = render(<RevolveDialog {...props} />)

    expect(applyButton().disabled).toBe(true)
    rerender(<RevolveDialog {...props} />)
    commitField('revolve-angle', '180')

    const warnings = axisWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ severity: 'warning', source: 'model' })
    expect(warnings[0].message).toMatch(/no solid/i)
  })

  it('dialog: an XZ-plane profile keeps Apply enabled and writes nothing to the console', () => {
    const { dag, history } = setupWithPlaneSketch({ x: 0, y: -1, z: 0 })
    render(<RevolveDialog dag={dag} history={history} mode="create" sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]} onApplied={() => {}} onClose={() => {}} />)

    expect(applyButton().disabled).toBe(false)
    expect(useCamStore.getState().consoleEvents).toHaveLength(0)
  })

  it('dialog: a region list the check cannot read a plane from leaves the dialog exactly as before', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
    const history = new CommandHistory(dag)
    render(<RevolveDialog dag={dag} history={history} mode="create" sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]} onApplied={() => {}} onClose={() => {}} />)

    expect(applyButton().disabled).toBe(false)
    expect(useCamStore.getState().consoleEvents).toHaveLength(0)
  })

  it('page, real kernel: switching between an XZ and an XY profile enables/disables Apply, commits nothing for XY, and names the reason once per change into the XY state', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )
    await mintRectangleSketch({ id: 'SK1', plane: 'xz' })
    await mintRectangleSketch({ id: 'SK2', plane: 'xy' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })

    const previewStatus = () => screen.getByTestId('revolve-preview-status').getAttribute('data-status')
    const select = () => screen.getByTestId('revolve-profile-select') as HTMLSelectElement

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    expect(select().value).toBe('SK1')
    await waitFor(() => expect(previewStatus()).toBe('ready'), { timeout: 20_000 })
    expect(applyButton().disabled).toBe(false)
    expect(axisWarnings()).toHaveLength(0)

    // Without the check the real kernel previews this "ready" and Apply commits
    // a zero-volume body; with it, Apply is disabled and no preview is sent.
    fireEvent.change(select(), { target: { value: 'SK2' } })
    await waitFor(() => expect(applyButton().disabled).toBe(true), { timeout: 20_000 })
    await waitFor(() => expect(previewStatus()).not.toBe('ready'), { timeout: 20_000 })
    expect(axisWarnings()).toHaveLength(1)
    expect(axisWarnings()[0]).toMatchObject({ severity: 'warning', source: 'model' })
    fireEvent.click(applyButton())
    expect(window.__solidsWorkbenchHooks?.dag.has('F1')).toBe(false)

    fireEvent.change(select(), { target: { value: 'SK1' } })
    await waitFor(() => expect(previewStatus()).toBe('ready'), { timeout: 20_000 })
    expect(applyButton().disabled).toBe(false)
    expect(axisWarnings()).toHaveLength(1)

    fireEvent.change(select(), { target: { value: 'SK2' } })
    await waitFor(() => expect(applyButton().disabled).toBe(true), { timeout: 20_000 })
    expect(axisWarnings()).toHaveLength(2)
  }, 90_000)
})
