// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { ExtrudeRequest } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

describe('WO-241 product end-target lineage reachability', () => {
  it('replays an Up to part reference against the live body that absorbed its persisted target', async () => {
    const requests: ExtrudeRequest[] = []
    const client = createFakeGeomClient({
      makeExtrudeImpl: (request, mintHandle) => {
        requests.push(request)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })

    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await mintRectangleSketch()

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody',
        name: 'Persisted target',
      },
    }))
    await hooks().fullResync(['F1'])
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'END',
      kind: 'feature',
      // Body end targets are references, not material-consuming DAG edges.
      consumes: ['SK2'],
      payload: {
        opType: 'extrude', sketchId: 'SK2', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toPart', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', bodyFeatureId: 'F1' },
        name: 'Persisted end reference',
      },
    }))
    await hooks().fullResync(['END'])
    expect(hooks().scheduler.statusOf('END')).toBe('ok')
    expect(requests.findLast((request) => request.featureId === 'END')?.end).toMatchObject({
      kind: 'toPart',
      target: { identity: { bodyFeatureId: 'F1' } },
    })

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'MERGED',
      kind: 'feature',
      consumes: ['SK1', 'F1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 5, direction: 'up', boolMode: 'add',
        targetFeatureId: 'F1', name: 'Later absorbing feature',
      },
    }))
    await hooks().fullResync(['MERGED'])
    expect(hooks().scheduler.statusOf('MERGED')).toBe('ok')

    requests.length = 0
    await hooks().fullResync(['END'])

    expect(hooks().scheduler.statusOf('END')).toBe('ok')
    const replay = requests.findLast((request) => request.featureId === 'END')
    expect(replay?.end).toMatchObject({
      kind: 'toPart',
      target: { identity: { bodyFeatureId: 'MERGED' } },
    })
    expect(replay?.end.kind === 'toPart' ? replay.end.target.body : undefined)
      .toBe(hooks().getBodyHandle('MERGED'))
  })
})
