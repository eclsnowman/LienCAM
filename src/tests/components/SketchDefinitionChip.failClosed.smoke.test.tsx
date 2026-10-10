// @vitest-environment jsdom
//
// WO-201: green definition badges require a successful solver verdict.
// Exercise the rendered CAM toolbox and workbench rail against their real
// host stores, including the workbench's getter-backed async boot transition.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { Sketch } from '../../lib/sketch/types'
import type {
  SketchSessionDeps,
} from '../../components/model3d/workbench/sketchSessionStore'
import type { SolverAvailability } from '../../components/model3d/workbench/solverAvailability'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

// Hold every production solve request forever. These regressions care about
// the state visible while a current verdict is pending, including a worker
// that never answers.
const heldWorkerRequests: unknown[] = []
class HoldingWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(message: unknown): void { heldWorkerRequests.push(message) }
  terminate(): void {}
}
vi.stubGlobal('Worker', HoldingWorker)

const { SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox')
const { WorkbenchToolRail } = await import('../../components/model3d/workbench/WorkbenchToolRail')
const { sketchSessionStore } = await import('../../components/model3d/workbench/sketchSessionStore')
const {
  workbenchSketchDocumentPort,
  __resetSketchDocumentPort,
} = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
const { useCamStore, camSketchDocumentPort } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')

function workbenchSketch(solveStatus: Sketch['solveStatus']): Sketch {
  return {
    id: 'wo-201-workbench',
    layerId: 'workbench',
    entities: [],
    constraints: [],
    dimensions: [],
    solveStatus,
  }
}

function persistedDefinedCamSketch(): Sketch {
  return {
    id: 'wo-204-cam',
    layerId: 'wo-204-layer',
    entities: [
      { id: 'wo-204-user-point', kind: 'point', construction: false, at: { x: 4, y: 7 } },
    ],
    constraints: [],
    dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function directVerdictCamSketch(): Sketch {
  const success = { dof: 0, conflicting: [], redundant: [] }
  return {
    id: 'wo-204-direct-verdict',
    layerId: 'wo-204-layer',
    entities: [
      {
        id: 'wo-204-line',
        kind: 'line',
        construction: false,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 2 },
      },
    ],
    constraints: [],
    dimensions: [
      {
        id: 'wo-204-driving-dim',
        kind: 'distance',
        driving: true,
        value: 10,
        a: { entityId: 'wo-204-line', site: 'start' },
        b: { entityId: 'wo-204-line', site: 'end' },
      },
      {
        id: 'wo-204-reference-dim',
        kind: 'distance',
        driving: false,
        value: 10,
        a: { entityId: 'wo-204-line', site: 'start' },
        b: { entityId: 'wo-204-line', site: 'end' },
      },
    ],
    solveStatus: success,
  }
}

function bindWorkbenchSolver(
  readWrapper: () => GcsWrapper | null,
  readStatus: () => SolverAvailability,
): void {
  sketchSessionStore.bindDeps({
    // The rail reads the active sketch's name for the import row. These cases
    // have no persisted node; a real DAG would return undefined, not lack getNode.
    dag: { getNode: () => undefined } as unknown as SketchSessionDeps['dag'],
    history: {} as SketchSessionDeps['history'],
    scheduler: {} as SketchSessionDeps['scheduler'],
    get wrapper() { return readWrapper() },
    get solverStatus() { return readStatus() },
    notice: () => {},
    onDocumentChanged: () => {},
    onHistoryStep: () => {},
  })
}

function renderWorkbenchRail(): void {
  render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={() => {}}
    />,
  )
}

beforeEach(() => {
  heldWorkerRequests.length = 0
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  act(() => {
    useCamStore.setState({
      activeSketch: createBlankSketch('wo-201-cam', () => 'blank'),
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchDimEditor: null,
    })
  })
})

afterEach(() => {
  cleanup()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

describe('WO-201 CAM definition chip', () => {
  it.each([
    {
      path: 'applySketchConstraint',
      dispatch: () => {
        useCamStore.getState().setSketchSelection(['wo-204-line'])
        useCamStore.getState().applySketchConstraint('horizontal')
      },
    },
    {
      path: 'commitDimensionValue',
      dispatch: () => useCamStore.getState().commitDimensionValue('wo-204-driving-dim', 12),
    },
    {
      path: 'reference-to-driving toggleDimensionDriving',
      dispatch: () => useCamStore.getState().toggleDimensionDriving('wo-204-reference-dim'),
    },
    {
      path: 'placed-dimension camSketchDocumentPort.append',
      dispatch: () => camSketchDocumentPort.append({
        entities: [],
        constraints: [],
        dimensions: [{
          id: 'wo-204-placed-dim',
          kind: 'distance',
          driving: true,
          value: 10,
          a: { entityId: 'wo-204-line', site: 'start' },
          b: { entityId: 'wo-204-line', site: 'end' },
        }],
      }, [], { openDimensionEditor: true }),
    },
  ])('revokes stale success while $path waits forever for a verdict', async ({ dispatch }) => {
    const persisted = directVerdictCamSketch()
    act(() => {
      useCamStore.setState({ activeSketch: persisted, sketchSolveStatus: persisted.solveStatus })
    })
    render(<SketchToolbox />)
    expect(screen.getByTestId('cam-sketch-dof-chip').textContent).toContain('Fully defined')
    const dispatchesBefore = heldWorkerRequests.length

    act(dispatch)

    const pending = useCamStore.getState()
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(heldWorkerRequests).toHaveLength(dispatchesBefore + 1)
    expect(pending.sketchSolveStatus).toBeNull()
    expect(pending.activeSketch?.solveStatus).toBeNull()
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(chip.textContent).toContain('Not solved')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('clears persisted success when reopen dispatches a solve that never answers', async () => {
    const persisted = persistedDefinedCamSketch()
    act(() => {
      useCamStore.setState({ activeSketch: persisted, sketchSolveStatus: persisted.solveStatus })
    })
    render(<SketchToolbox />)
    expect(screen.getByTestId('cam-sketch-dof-chip').textContent).toContain('Fully defined')

    act(() => useCamStore.getState().setActiveSketch(persisted))

    const pending = useCamStore.getState()
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(heldWorkerRequests).toHaveLength(1)
    expect(pending.sketchSolveStatus).toBeNull()
    expect(pending.activeSketch?.solveStatus).toBeNull()
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(chip.textContent).toContain('Not solved')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('revokes a stored blank success on reopen without dispatching a solve', () => {
    const layerId = 'wo-210-blank-layer'
    const legacyBlank: Sketch = {
      ...createBlankSketch(layerId, () => 'wo-210-blank'),
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
    act(() => {
      useCamStore.setState((state) => ({
        activeSketch: null,
        sketchSolveStatus: null,
        sketchEntrySnapshot: null,
        lastNonSketchMode: 'setup',
        viewer: { ...state.viewer, mode: 'setup', selectedGeometryId: null },
        project: {
          ...state.project,
          geometry: [{
            id: 'wo-210-sketch-container',
            name: 'Sketches',
            filename: '',
            type: 'curves_2d',
            format: 'sketch',
            boundingBox: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 0, y: 0, z: 0 },
              size: { x: 0, y: 0, z: 0 },
              center: { x: 0, y: 0, z: 0 },
            },
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            loaded: true,
            loops: [],
            layers2d: [{
              id: layerId,
              name: 'Blank legacy sketch',
              color: '#ffd740',
              visible: true,
              sourceType: 'sketch',
            }],
            sketches: [legacyBlank],
          }],
        },
      }))
    })
    const dispatchesBefore = heldWorkerRequests.length

    let opened = false
    act(() => { opened = useCamStore.getState().openSketchForLayer(layerId) })
    render(<SketchToolbox />)

    const reopened = useCamStore.getState()
    const stored = reopened.project.geometry[0].sketches?.[0]
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(opened).toBe(true)
    expect(heldWorkerRequests).toHaveLength(dispatchesBefore)
    expect(reopened.sketchSolveStatus).toBeNull()
    expect(reopened.activeSketch?.solveStatus).toBeNull()
    expect(stored?.solveStatus).toBeNull()
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(chip.textContent).toContain('Not solved')
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('deleting the final user content stores no synthetic success verdict', async () => {
    const persisted = persistedDefinedCamSketch()
    act(() => useCamStore.getState().setActiveSketch(persisted))
    const dispatchesAfterOpen = heldWorkerRequests.length

    // Model the current open solve having returned a real success before the
    // user deletes the final content. The deletion itself must revoke it.
    act(() => {
      useCamStore.setState((state) => ({
        sketchSolveStatus: persisted.solveStatus,
        activeSketch: { ...state.activeSketch!, solveStatus: persisted.solveStatus },
      }))
    })
    render(<SketchToolbox />)
    expect(screen.getByTestId('cam-sketch-dof-chip').textContent).toContain('Fully defined')

    act(() => useCamStore.getState().deleteSketchItems(['wo-204-user-point']))

    const empty = useCamStore.getState()
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(empty.activeSketch?.entities.some((entity) => !entity.construction)).toBe(false)
    expect(empty.sketchSolveStatus).toBeNull()
    expect(empty.activeSketch?.solveStatus).toBeNull()
    expect(heldWorkerRequests).toHaveLength(dispatchesAfterOpen)
    expect(chip.className).not.toContain('sketch-def-chip-defined')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('starts blank with no synthetic verdict and stays fail-closed while no worker verdict arrives', async () => {
    expect(createBlankSketch('L', () => 'id').solveStatus).toBeNull()

    render(<SketchToolbox />)
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(chip.textContent).toContain('Not solved')
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(screen.queryByText('Fully defined')).toBeNull()

    // Model a worker/module promise that never settles: neither host state
    // changes during the wait, so the rendered claim must remain neutral.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(chip.textContent).toContain('Not solved')
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('notifies the mounted host through failed, recovered-defined, and under-defined verdicts', () => {
    render(<SketchToolbox />)
    const chip = () => screen.getByTestId('cam-sketch-dof-chip')

    act(() => {
      useCamStore.setState({
        sketchSolveStatus: {
          dof: 0,
          conflicting: [],
          redundant: [],
          solveFailed: true,
          failureMessage: 'worker crashed',
        },
      })
    })
    expect(chip().textContent).toContain('Solve failed')
    expect(chip().className).not.toContain('sketch-def-chip-defined')

    act(() => {
      useCamStore.setState({ sketchSolveStatus: { dof: 0, conflicting: [], redundant: [] } })
    })
    expect(chip().textContent).toContain('Fully defined')
    expect(chip().className).toContain('sketch-def-chip-defined')

    act(() => {
      useCamStore.setState({ sketchSolveStatus: { dof: 3, conflicting: [], redundant: [] } })
    })
    expect(chip().textContent).toContain('3 DoF')
    expect(chip().className).not.toContain('sketch-def-chip-defined')
  })
})

describe('WO-201 workbench definition chip', () => {
  it('rejects a stale dof-0 payload while the solver is loading or unavailable', async () => {
    let wrapper: GcsWrapper | null = null
    let availability: SolverAvailability = 'loading'
    bindWorkbenchSolver(() => wrapper, () => availability)
    sketchSessionStore.begin(
      'sketch3d:wo-201',
      BASE_PLANE_FRAMES.xy,
      workbenchSketch({ dof: 0, conflicting: [], redundant: [] }),
    )
    renderWorkbenchRail()

    const chip = () => screen.getByTestId('workbench-sketch-dof-chip')
    expect(chip().textContent).toContain('Solver not ready')
    expect(chip().className).not.toContain('sketch-def-chip-defined')

    availability = 'unavailable'
    await waitFor(() => expect(chip().textContent).toContain('Solver unavailable'))
    expect(chip().className).not.toContain('sketch-def-chip-defined')
    expect(screen.queryByText('Fully defined')).toBeNull()
  })

  it('notifies a mounted rail when async boot becomes ready, then accepts only new verdicts', async () => {
    let wrapper: GcsWrapper | null = null
    let availability: SolverAvailability = 'loading'
    bindWorkbenchSolver(() => wrapper, () => availability)
    sketchSessionStore.begin(
      'sketch3d:wo-201',
      BASE_PLANE_FRAMES.xy,
      workbenchSketch(null),
    )
    renderWorkbenchRail()

    const chip = () => screen.getByTestId('workbench-sketch-dof-chip')
    expect(chip().textContent).toContain('Solver not ready')

    wrapper = {} as GcsWrapper
    availability = 'ready'
    await waitFor(() => expect(chip().textContent).toContain('Not solved'))
    expect(screen.queryByText('Fully defined')).toBeNull()

    act(() => {
      sketchSessionStore.setState({
        sketch: workbenchSketch({ dof: 0, conflicting: [], redundant: [] }),
      })
    })
    expect(chip().textContent).toContain('Fully defined')

    act(() => {
      sketchSessionStore.setState({
        sketch: workbenchSketch({ dof: 4, conflicting: [], redundant: [] }),
      })
    })
    expect(chip().textContent).toContain('4 DoF')
    expect(chip().className).not.toContain('sketch-def-chip-defined')
  })

  it('replaces stale success with a rendered failure when an actual solve call crashes', () => {
    let payload: Record<string, unknown> = {
      sketch: workbenchSketch({ dof: 0, conflicting: [], redundant: [] }),
    }
    const dag = {
      getNode: () => ({ payload }),
      setPayload: (_id: string, next: Record<string, unknown>) => { payload = next },
    } as unknown as SketchSessionDeps['dag']
    const failingWrapper = new Proxy({}, {
      get: () => { throw new Error('solver crashed during mapping') },
    }) as GcsWrapper

    sketchSessionStore.bindDeps({
      dag,
      history: {} as SketchSessionDeps['history'],
      scheduler: {} as SketchSessionDeps['scheduler'],
      wrapper: failingWrapper,
      solverStatus: 'ready',
      notice: () => {},
      onDocumentChanged: () => {},
      onHistoryStep: () => {},
    })
    sketchSessionStore.begin(
      'sketch3d:wo-201',
      BASE_PLANE_FRAMES.xy,
      workbenchSketch(null),
    )
    renderWorkbenchRail()
    expect(screen.getByTestId('workbench-sketch-dof-chip').textContent).toContain('Not solved')

    const current = sketchSessionStore.getState().sketch!
    act(() => {
      workbenchSketchDocumentPort.replace({
        entities: current.entities,
        constraints: current.constraints,
        dimensions: current.dimensions,
      })
    })

    const chip = screen.getByTestId('workbench-sketch-dof-chip')
    expect(chip.textContent).toContain('Solve failed')
    expect(chip.className).toContain('sketch-def-chip-failed')
    expect(chip.textContent).not.toContain('Fully defined')
  })
})
