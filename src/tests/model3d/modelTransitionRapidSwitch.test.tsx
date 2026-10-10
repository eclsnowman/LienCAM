// @vitest-environment jsdom
//
// MODEL-TRANSITION-RELIABILITY: a model switch is a document transaction.
// If A's kernel boot resolves after the host has already switched to B, A may
// not publish tree/viewport state into B, and A's seed must remain available
// for a future reopen.

import { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { FeatureDag } from '../../doc/dag'
import {
  peekPendingDocumentSeed,
  resetDocumentHolder,
  stashLoadedDocument,
} from '../../doc/documentHolder'
import { createDocumentArchive } from '../../doc/persist'
import type { ExtrudeRequest, KernelInfo, OpResult } from '../../geom/geom-service'
import { useCamStore } from '../../store'
import { rectangleProfile } from '../../components/model3d/workbench/profileGeometry'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

function archiveWithFeature(id: string): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({
    id,
    kind: 'feature',
    payload: { opType: 'extrude', sketchId: `missing-${id}`, distance: 1 },
  })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

function archiveWithBody(id: string): Uint8Array {
  const dag = new FeatureDag()
  const sketchId = `${id}_SK`
  dag.insertNode({
    id: sketchId,
    kind: 'sketch',
    payload: {
      name: `Sketch ${sketchId}`,
      plane: 'xy',
      width: 20,
      height: 10,
      offset: 0,
      regions: [rectangleProfile({ sketchId, plane: 'xy', width: 20, height: 10, offset: 0 })],
    },
  })
  dag.insertNode({
    id,
    kind: 'feature',
    consumes: [sketchId],
    payload: {
      opType: 'extrude',
      sketchId,
      distance: 5,
      direction: 'up',
      boolMode: 'newBody',
      name: `Body ${id}`,
    },
  })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

const kernelInfo: KernelInfo = {
  backend: 'occt-wasm',
  occtVersion: 'late-test',
  capabilities: { defeature: false, xcaf: false, hlr: false },
}

afterEach(() => {
  cleanup()
  resetDocumentHolder()
  useCamStore.getState().newProject()
})

describe('MODEL-TRANSITION-RELIABILITY: rapid model switch', () => {
  it('A boot -> switch to B -> late A completion: only B remains published and A stays reopenable', async () => {
    resetDocumentHolder()
    stashLoadedDocument(archiveWithFeature('A_ONLY'), 'item-a')
    stashLoadedDocument(archiveWithFeature('B_ONLY'), 'item-b')

    let resolveA!: (value: KernelInfo) => void
    const clientA = createFakeGeomClient()
    clientA.init = () => new Promise<KernelInfo>((resolve) => { resolveA = resolve })
    const clientB = createFakeGeomClient()

    const view = render(
      <StrictMode>
        <SolidsWorkbenchPage
          embedded
          modelItemId="item-a"
          createClient={() => clientA}
          createSceneRuntime={fakeCreateSceneRuntime}
        />
      </StrictMode>,
    )

    // A is committed but its asynchronous kernel boot is intentionally held.
    expect(screen.getByTestId('feature-row-A_ONLY')).toBeTruthy()

    view.rerender(
      <StrictMode>
        <SolidsWorkbenchPage
          embedded
          modelItemId="item-b"
          createClient={() => clientB}
          createSceneRuntime={fakeCreateSceneRuntime}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    )
    expect(screen.getByTestId('feature-row-B_ONLY')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-A_ONLY')).toBeNull()

    // A resolves after B is already live. The cancelled A boot must not
    // overwrite B's hooks/tree/status, and A must retain a seed for reopening.
    await act(async () => {
      resolveA(kernelInfo)
      await Promise.resolve()
      await Promise.resolve()
    })

    const hooks = window.__solidsWorkbenchHooks
    expect(hooks?.dag.has('B_ONLY')).toBe(true)
    expect(hooks?.dag.has('A_ONLY')).toBe(false)
    expect(screen.getByTestId('feature-row-B_ONLY')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-A_ONLY')).toBeNull()
    expect(peekPendingDocumentSeed('item-a')?.seed.dag.has('A_ONLY')).toBe(true)
  })

  it('A late fullResync body completion cannot publish over B live body, viewport, or CAM state', async () => {
    resetDocumentHolder()
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [],
        modelItems: [
          { id: 'item-a', name: 'Item A' },
          { id: 'item-b', name: 'Item B' },
        ],
      },
    }))
    stashLoadedDocument(archiveWithBody('A_BODY'), 'item-a')
    stashLoadedDocument(archiveWithBody('B_BODY'), 'item-b')

    let releaseAExtrude!: () => void
    let markAExtrudeStarted!: () => void
    const aExtrudeGate = new Promise<void>((resolve) => { releaseAExtrude = resolve })
    const aExtrudeStarted = new Promise<void>((resolve) => { markAExtrudeStarted = resolve })
    const clientA = createFakeGeomClient()
    const runAExtrude = clientA.makeExtrude.bind(clientA)
    clientA.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
      markAExtrudeStarted()
      await aExtrudeGate
      return runAExtrude(req)
    }
    const clientB = createFakeGeomClient()

    const view = render(
      <StrictMode>
        <SolidsWorkbenchPage
          embedded
          modelItemId="item-a"
          createClient={() => clientA}
          createSceneRuntime={fakeCreateSceneRuntime}
        />
      </StrictMode>,
    )

    await aExtrudeStarted
    const hooksA = window.__solidsWorkbenchHooks!
    view.rerender(
      <StrictMode>
        <SolidsWorkbenchPage
          embedded
          modelItemId="item-b"
          createClient={() => clientB}
          createSceneRuntime={fakeCreateSceneRuntime}
        />
      </StrictMode>,
    )

    await waitFor(() => {
      const hooksB = window.__solidsWorkbenchHooks
      expect(hooksB?.dag.has('B_BODY')).toBe(true)
      expect(hooksB?.getBodyHandle('B_BODY')).toBeDefined()
      expect(hooksB?.hasSceneMesh('B_BODY')).toBe(true)
    })
    await waitFor(() => {
      const bRow = useCamStore.getState().project.geometry.find(
        (geo) => geo.modelItemId === 'item-b' && geo.modelBody?.ref.bodyId === 'B_BODY',
      )
      expect(bRow?.modelBody?.display?.positions.length).toBeGreaterThan(0)
    })

    await act(async () => {
      releaseAExtrude()
      await aExtrudeGate
    })
    await waitFor(() => expect(hooksA.scheduler.statusOf('A_BODY')).toBe('ok'))

    const hooksB = window.__solidsWorkbenchHooks!
    expect(hooksB.dag.has('B_BODY')).toBe(true)
    expect(hooksB.dag.has('A_BODY')).toBe(false)
    expect(hooksB.getBodyHandle('B_BODY')).toBeDefined()
    expect(hooksB.hasSceneMesh('B_BODY')).toBe(true)
    expect(
      useCamStore.getState().project.geometry.some(
        (geo) => geo.modelItemId === 'item-a' && geo.modelBody?.ref.bodyId === 'A_BODY',
      ),
    ).toBe(false)
    expect(
      useCamStore.getState().project.geometry.filter((geo) => geo.format === 'model'),
    ).toHaveLength(1)
    expect(peekPendingDocumentSeed('item-a')?.seed.dag.has('A_BODY')).toBe(true)
  })
})
