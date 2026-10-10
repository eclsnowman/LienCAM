// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import type { ExtrudeRequest } from '../../geom/geom-service'
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

async function addSketch(): Promise<void> {
  await mintRectangleSketch()
}

describe('UI-54 Edit Extrude topology controls', () => {
  it('edits profile/result/target, replays the new topology, and undoes as one history step', async () => {
    const requests: ExtrudeRequest[] = []
    const client = createFakeGeomClient({
      makeExtrudeImpl: (request, mintHandle) => {
        requests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await addSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    await addSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    commitField('extrude-distance', '6')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))

    const profile = screen.getByTestId('extrude-profile-select') as HTMLSelectElement
    const result = screen.getByTestId('extrude-boolmode-select') as HTMLSelectElement
    expect(profile.value).toBe('SK2')
    expect(result.value).toBe('newBody')

    fireEvent.change(profile, { target: { value: 'SK1' } })
    fireEvent.change(result, { target: { value: 'remove' } })
    const target = screen.getByTestId('extrude-target-select') as HTMLSelectElement
    expect([...target.options].map((option) => option.value)).toEqual(['F1'])
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => {
      expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
        sketchId: 'SK1',
        boolMode: 'remove',
        targetFeatureId: 'F1',
      })
      expect(hooks().dag.getNode('F2')?.consumes.slice().sort()).toEqual(['F1', 'SK1'])
      expect(requests.filter((request) => request.featureId === 'F2').at(-1)?.op).toBe('cut')
    })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      const restored = hooks().dag.getNode('F2')
      expect(restored?.payload).toMatchObject({ sketchId: 'SK2', boolMode: 'newBody' })
      expect(restored?.payload.targetFeatureId).toBeUndefined()
      expect(restored?.consumes).toEqual(['SK2'])
      expect(requests.filter((request) => request.featureId === 'F2').at(-1)?.op).toBe('newBody')
    })
  })
})
