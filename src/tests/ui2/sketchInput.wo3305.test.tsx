// @vitest-environment jsdom
//
// WO-3305 (UI M2 W2-12): in the New UI a model sketch is operation geometry. The lane registers
// a Toolpath ribbon group whose action opens the Sketches window; the window lists the sketches
// of the open model (through the live model session, as the workbench registers it), Use adds the
// sketch's part, a sketch whose plane cannot be cut shows the app's own reason with Use
// unavailable, and leaving Model brings every sketch in use up to its edits.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import { useCamStore } from '../../store'
import { createModelSession } from '../../doc/modelSession'
import { registerModelSession } from '../../doc/documentHolder'
import { ElementMap } from '../../doc/element-map'
import { newSeededModelDag } from '../../doc/seedModelArchive'
import { resolveMessage } from '../../notices'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import type { FeatureDag } from '../../doc/dag'
import type { Project } from '../../types'
import { registration } from '../../ui2/sketch-input/registration'
import { closeSketchInput } from '../../ui2/sketch-input/state'

function rect(prefix: string, w: number, h: number): SketchEntity[] {
  const c = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
  return c.map((p, i) => ({ id: `${prefix}${i}`, kind: 'line', construction: false, start: p, end: c[(i + 1) % 4] }) as SketchEntity)
}

function sketch(id: string, w: number): Sketch {
  return { id, layerId: `${id}-layer`, entities: rect(id, w, 20), constraints: [], dimensions: [], solveStatus: null } as unknown as Sketch
}

function model(): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: 'sketch3d:top', kind: 'sketch', consumes: ['datum:XY'],
    payload: { sketch: sketch('top', 40), planeNodeId: 'datum:XY', externalRefs: [], dimensionDiagnostics: [], name: 'Top sketch' },
  })
  dag.insertNode({
    id: 'sketch3d:side', kind: 'sketch', consumes: ['datum:XZ'],
    payload: { sketch: sketch('side', 30), planeNodeId: 'datum:XZ', externalRefs: [], dimensionDiagnostics: [], name: 'Side sketch' },
  })
  return dag
}

let unregister: (() => void) | undefined
let dag: FeatureDag

function Windows() {
  return createElement(Fragment, null, ...(registration.windows ?? []).map((w) => createElement(w.Component, { key: w.id })))
}

const ribbonAction = () => {
  const group = registration.ribbonGroups?.find((g) => g.workspace === 'toolpath')
  return group?.actions[0]
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    workspace: 'cam',
    projectHistory: [],
    project: { ...s.project, geometry: [], modelItems: [], modelItemPlacements: [] } as unknown as Project,
  }))
  dag = model()
  unregister = registerModelSession(createModelSession({ modelItemId: 'legacy', dag, map: new ElementMap() }))
})

afterEach(() => {
  act(() => closeSketchInput())
  cleanup()
  unregister?.()
})

describe('WO-3305 sketch as toolpath input in the New UI', () => {
  it('registers a Toolpath ribbon group whose action opens the Sketches window', () => {
    expect(registration.owner).toBe('sketch-input')
    const action = ribbonAction()
    expect(action?.labelKey).toBe('ui2-sketch-input.wo3305:open')
    render(createElement(Windows))
    expect(screen.queryByTestId('sketch-input-dialog')).toBeNull()
    act(() => action!.run!())
    expect(screen.queryByTestId('sketch-input-dialog')).not.toBeNull()
    expect(screen.queryAllByText(resolveMessage('ui2-sketch-input.wo3305:title')).length).toBeGreaterThan(0)
  })

  it('lists the open model sketches; Use makes one a 2D part an operation can pick', () => {
    render(createElement(Windows))
    act(() => ribbonAction()!.run!())
    const top = screen.queryByTestId('sketch-input-row-legacy:sketch3d:top')
    expect(top, 'the Top sketch row').not.toBeNull()
    expect(within(top!).queryByText('Top sketch')).not.toBeNull()
    expect(within(top!).getByText(resolveMessage('ui2-sketch-input.wo3305:available'))).toBeTruthy()
    act(() => { fireEvent.click(screen.getByTestId('sketch-input-use-legacy:sketch3d:top')) })
    const parts = useCamStore.getState().project.geometry
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ format: 'sketch', type: 'curves_2d', name: 'Top sketch' })
    expect(parts[0].loops?.filter((l) => l.closed)).toHaveLength(1)
    expect(within(screen.getByTestId('sketch-input-row-legacy:sketch3d:top'))
      .getByText(resolveMessage('ui2-sketch-input.wo3305:inUse'))).toBeTruthy()
  })

  it('a sketch on a plane the setup cannot reach shows the app reason and Use is unavailable', () => {
    render(createElement(Windows))
    act(() => ribbonAction()!.run!())
    const side = screen.queryByTestId('sketch-input-row-legacy:sketch3d:side')
    expect(side, 'the Side sketch row').not.toBeNull()
    const reason = resolveMessage('console-and-operator-messages:modelEdgeChainBinding19', { value1: 'Side sketch', value2: '20' })
    expect(within(side!).queryAllByText(reason).length).toBeGreaterThan(0)
    expect(screen.getByTestId('sketch-input-use-legacy:sketch3d:side').getAttribute('data-unavailable')).toBe('true')
    act(() => { fireEvent.click(screen.getByTestId('sketch-input-use-legacy:sketch3d:side')) })
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
  })

  it('leaving Model brings a sketch in use up to its edit', () => {
    render(createElement(Windows))
    act(() => ribbonAction()!.run!())
    const use = screen.queryByTestId('sketch-input-use-legacy:sketch3d:top')
    expect(use, 'the Use button of Top sketch').not.toBeNull()
    act(() => { fireEvent.click(use!) })
    act(() => closeSketchInput())
    const width = () => {
      const xs = useCamStore.getState().project.geometry[0].loops!.flatMap((l) => l.points.map((p) => p.x))
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(width()).toBeCloseTo(40, 9)
    act(() => useCamStore.setState({ workspace: 'part' }))
    const node = dag.getNode('sketch3d:top')!
    dag.setPayload('sketch3d:top', { ...node.payload, sketch: sketch('top', 64) })
    act(() => useCamStore.setState({ workspace: 'cam' }))
    expect(width()).toBeCloseTo(64, 9)
  })
})
