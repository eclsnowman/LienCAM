// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { BooleanRequest, HoleRequest } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

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

async function addTwoBodies(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  for (const id of ['F1', 'F2']) {
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined())
  }
}

async function forceInsertAndBuild(
  id: string,
  consumes: string[],
  payload: Record<string, unknown>,
  ref: string,
): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id,
    kind: 'feature',
    consumes,
    refs: [{ id: ref, kind: 'face-set' }],
    payload,
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

describe('UI-38 Boolean and Hole editability', () => {
  it('edits from tree/toolbar, preserves graph and topology, replays, undoes, and refuses invalid references', async () => {
    const booleanRequests: BooleanRequest[] = []
    const holeRequests: HoleRequest[] = []
    const client = createFakeGeomClient({
      makeHoleImpl: (request, mintHandle) => {
        holeRequests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    const applyBoolean = client.applyBoolean.bind(client)
    client.applyBoolean = async (request) => {
      booleanRequests.push(request)
      return applyBoolean(request)
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await addTwoBodies()

    await forceInsertAndBuild('F3', ['F1', 'F2'], {
      opType: 'boolean',
      targetFeatureId: 'F1',
      toolFeatureId: 'F2',
      boolOp: 'cut',
      name: 'Boolean F3',
    }, 'boolean-body-roles')

    fireEvent.contextMenu(screen.getByTestId('feature-row-F3'))
    const treeEdit = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(treeEdit.disabled).toBe(false)
    fireEvent.click(treeEdit)
    expect((screen.getByTestId('boolean-target-select') as HTMLSelectElement).value).toBe('F1')
    expect((screen.getByTestId('boolean-tool-select') as HTMLSelectElement).value).toBe('F2')
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F2' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F1' } })
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => {
      const node = hooks().dag.getNode('F3')
      expect(node?.payload).toMatchObject({ targetFeatureId: 'F2', toolFeatureId: 'F1', boolOp: 'fuse' })
      expect(node?.consumes).toEqual(['F2', 'F1'])
      expect(node?.refs).toEqual([{ id: 'boolean-body-roles', kind: 'face-set' }])
      expect(booleanRequests.at(-1)?.op).toBe('fuse')
    })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F3')?.payload).toMatchObject({ targetFeatureId: 'F1', toolFeatureId: 'F2', boolOp: 'cut' })
      expect(hooks().dag.getNode('F3')?.consumes).toEqual(['F1', 'F2'])
      expect(booleanRequests.at(-1)?.featureId).toBe('F3')
    })

    await forceInsertAndBuild('F4', ['F3'], {
      opType: 'hole',
      ownerId: 'F3',
      faceId: 'F3:FACE:top',
      points: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 12, z: 3 }],
      style: { kind: 'counterbore', diameter: 6, cbDiameter: 9, cbDepth: 2 },
      depth: { kind: 'blind', distance: 5 },
      seed: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 0, z: 1 },
      placement: { kind: 'linear', count: 2, spacing: 10 },
      name: 'Hole F4',
    }, 'F3:FACE:top')

    fireEvent.click(screen.getByTestId('feature-row-F4'))
    const toolbarEdit = screen.getByTestId('workbench-edit-feature') as HTMLButtonElement
    expect(toolbarEdit.disabled).toBe(false)
    fireEvent.click(toolbarEdit)
    expect((screen.getByTestId('hole-style-select') as HTMLSelectElement).value).toBe('counterbore')
    expect((screen.getByTestId('hole-depth-select') as HTMLSelectElement).value).toBe('blind')
    expect((screen.getByTestId('hole-placement-select') as HTMLSelectElement).value).toBe('linear')
    commitField('hole-diameter', '8')
    fireEvent.change(screen.getByTestId('hole-depth-select'), { target: { value: 'throughAll' } })
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'circular' } })
    commitField('hole-pattern-count', '3')
    commitField('hole-pattern-radius', '12')
    commitField('hole-pattern-start-angle', '30')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => {
      const node = hooks().dag.getNode('F4')
      expect(node?.payload).toMatchObject({
        ownerId: 'F3',
        faceId: 'F3:FACE:top',
        style: { kind: 'counterbore', diameter: 8, cbDiameter: 9, cbDepth: 2 },
        depth: { kind: 'throughAll' },
        placement: { kind: 'circular', count: 3, radius: 12, startAngleDeg: 30 },
      })
      expect(node?.payload.points).toHaveLength(3)
      expect(node?.consumes).toEqual(['F3'])
      expect(node?.refs).toEqual([{ id: 'F3:FACE:top', kind: 'face-set' }])
      expect(holeRequests.at(-1)).toMatchObject({
        face: 'F3:FACE:top',
        style: { kind: 'counterbore', diameter: 8, cbDiameter: 9, cbDepth: 2 },
        depth: { kind: 'throughAll' },
      })
      expect(holeRequests.at(-1)?.points).toHaveLength(3)
    })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('F4')?.payload).toMatchObject({
        style: { kind: 'counterbore', diameter: 6, cbDiameter: 9, cbDepth: 2 },
        depth: { kind: 'blind', distance: 5 },
        placement: { kind: 'linear', count: 2, spacing: 10 },
      })
      expect(hooks().dag.getNode('F4')?.payload.points).toHaveLength(2)
      expect(holeRequests.at(-1)?.depth).toEqual({ kind: 'blind', distance: 5 })
    })

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-BOOLEAN',
      kind: 'feature',
      consumes: [],
      payload: {
        opType: 'boolean',
        targetFeatureId: 'F1',
        toolFeatureId: 'F2',
        boolOp: 'cut',
        name: 'Broken Boolean',
      },
    }))
    const booleanBefore = hooks().dag.getNode('BAD-BOOLEAN')
    const invalidBooleanEntry = hooks().editEntryFor('BAD-BOOLEAN')
    if (invalidBooleanEntry === undefined || !('onEdit' in invalidBooleanEntry)) throw new Error('BAD-BOOLEAN must route to its edit dialog')
    invalidBooleanEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('boolean-reference-error').textContent).toMatch(/missing from the feature dependencies/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('BAD-BOOLEAN')).toEqual(booleanBefore)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-HOLE',
      kind: 'feature',
      consumes: [],
      payload: {
        opType: 'hole',
        ownerId: 'F4',
        faceId: 'F4:FACE:top',
        points: [{ x: 0, y: 0, z: 0 }],
        style: { kind: 'simple', diameter: 6 },
        depth: { kind: 'throughAll' },
        name: 'Broken Hole',
      },
    }))
    const holeBefore = hooks().dag.getNode('BAD-HOLE')
    const invalidHoleEntry = hooks().editEntryFor('BAD-HOLE')
    if (invalidHoleEntry === undefined || !('onEdit' in invalidHoleEntry)) throw new Error('BAD-HOLE must route to its edit dialog')
    invalidHoleEntry.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-reference-error').textContent).toMatch(/missing from the feature dependencies/i))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('BAD-HOLE')).toEqual(holeBefore)
  })
})
