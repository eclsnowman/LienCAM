// @vitest-environment jsdom

import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
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

async function createSketch(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
}

async function extrude(bodyId: string, distance: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', distance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined())
}

function bodyMesh(
  runtime: ReturnType<typeof createFakeSceneRuntime>,
  featureId: string,
): THREE.Mesh | undefined {
  return runtime.scene.children.find(
    (object): object is THREE.Mesh =>
      object instanceof THREE.Mesh && object.userData.workbenchFeatureId === featureId,
  )
}

describe('UI-47 Boolean-consumed body presentation', () => {
  it('presents only the Boolean leaf and unrelated bodies, while undo/delete restore both inputs', async () => {
    const client = createFakeGeomClient()
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
    await waitFor(() =>
      expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    )

    await createSketch()
    await extrude('F1', '10')
    await extrude('F2', '8')
    await extrude('F3', '6')

    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F4')).not.toBeUndefined())

    // Target and tool remain real DAG/history features, but they are not peer
    // live bodies in the normal body list or viewport.
    expect(hooks().dag.getNode('F4')?.consumes.slice().sort()).toEqual(['F1', 'F2'])
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(screen.getByTestId('feature-row-F2')).toBeTruthy()
    expect(screen.getByTestId('feature-row-F4')).toBeTruthy()
    expect(screen.queryByTestId('body-row-F1')).toBeNull()
    expect(screen.queryByTestId('body-row-F2')).toBeNull()
    expect(screen.getByTestId('body-row-F4')).toBeTruthy()
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
    expect(bodyMesh(runtime, 'F1')?.visible).toBe(false)
    expect(bodyMesh(runtime, 'F2')?.visible).toBe(false)
    expect(bodyMesh(runtime, 'F3')?.visible).toBe(true)
    expect(bodyMesh(runtime, 'F4')?.visible).toBe(true)
    expect(['F3', 'F4']).toContain(hooks().pickAt(0, 0)?.bodyId)

    // Undo removes the Boolean leaf and restores exactly its two inputs.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F4')).toBeNull())
    await waitFor(() => {
      expect(screen.getByTestId('body-row-F1')).toBeTruthy()
      expect(screen.getByTestId('body-row-F2')).toBeTruthy()
    })
    expect(bodyMesh(runtime, 'F1')?.visible).toBe(true)
    expect(bodyMesh(runtime, 'F2')?.visible).toBe(true)
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()

    // Redo consumes them again through the same replay path.
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(screen.getByTestId('body-row-F4')).toBeTruthy())
    expect(screen.queryByTestId('body-row-F1')).toBeNull()
    expect(screen.queryByTestId('body-row-F2')).toBeNull()
    expect(bodyMesh(runtime, 'F1')?.visible).toBe(false)
    expect(bodyMesh(runtime, 'F2')?.visible).toBe(false)

    // Deleting the Boolean feature also restores both inputs, without
    // disturbing the unrelated live body.
    fireEvent.keyDown(screen.getByTestId('feature-row-F4'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(hooks().dag.has('F4')).toBe(false))
    await waitFor(() => {
      expect(screen.getByTestId('body-row-F1')).toBeTruthy()
      expect(screen.getByTestId('body-row-F2')).toBeTruthy()
    })
    expect(bodyMesh(runtime, 'F1')?.visible).toBe(true)
    expect(bodyMesh(runtime, 'F2')?.visible).toBe(true)
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
    expect(bodyMesh(runtime, 'F3')?.visible).toBe(true)
  })
})
