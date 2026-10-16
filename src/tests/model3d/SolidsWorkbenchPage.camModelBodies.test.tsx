// @vitest-environment jsdom
//
// INT-17A Stage 1 gate G2 (live-update interleave, RUNTIME-GROUNDED): drives the
// REAL SolidsWorkbenchPage against the real executor + fake geom client and asserts
// the actual B4a hook wiring at the fullResync call site - the seam my fast unit
// tests do NOT exercise. Proves:
//  - modeling a body surfaces ONE CAM geometry entry per body (ruling 2), with a
//    stable id, drawn through the Model kernel identity (format/type 'model')
//  - editing ONE body among three re-derives ONLY that body (its ref.version
//    bumps; the others' versions and ids are byte-stable) - the interleave
//  - a workbench UNDO routes through the same fullResync pass and keeps the CAM
//    entries consistent (recon Q4: undo/redo do fire this hook)
//
// FAILS-IF: the syncCamModelBodies call at the fullResync site is removed or moved
// inside reresolveCamModelRefs (which early-returns in Stage 1) - no CAM entries
// ever appear; or the changed-only selection regresses to re-derive-all - the
// untouched bodies' versions bump on a single-body edit.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { ImportedGeometry } from '../../types'
import { mintRectangleSketch } from './mintRectangleSketch'

// In-memory localStorage shim BEFORE importing the store (persist()); mirrors
// SolidsWorkbenchPage.camModelRefRelineage.test.tsx - this file mutates the CAM
// store's project, so it needs the shim.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFeatureCommand } = await import('../../components/model3d/dialogs/createFeatureCommand')
const { EditFeaturePayloadCommand } = await import('../../components/model3d/dialogs/EditFeaturePayloadCommand')
const { makeBoxTessBuffers } = await import('../../viewport3d/fixtures')
const { COARSE_TESS_QUALITY } = await import('../../viewport3d/tessQuality')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function newRectangleSketch(): Promise<void> {
  await mintRectangleSketch()
}

async function extrudeNewBody(id: string, sketchId: string, name: string): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id, kind: 'feature', consumes: [sketchId],
    payload: { opType: 'extrude', sketchId, distance: 10, direction: 'up', boolMode: 'newBody', name },
  }))
  await hooks().fullResync([id])
}

const modelEntries = (): ImportedGeometry[] =>
  useCamStore.getState().project.geometry.filter((g) => g.format === 'model')
const byBody = (bodyId: string): ImportedGeometry | undefined =>
  modelEntries().find((g) => g.modelBody?.ref.bodyId === bodyId)

describe('INT-17A SolidsWorkbenchPage -> CAM model-body sync (G2 interleave)', () => {
  it('surfaces one CAM entry per body, and a single-body edit re-derives ONLY that body', async () => {
    useCamStore.getState().newProject()
    const client = createFakeGeomClient()
    // WO-2866: the fake's tessellation follows this height, so the F1 edit below is a real shape
    // change (an identical replay keeps its version by design). Only re-derived bodies re-tessellate.
    let height = 10
    client.tessellate = async (_h, q) => makeBoxTessBuffers({
      featureId: q.deflection === COARSE_TESS_QUALITY.deflection ? 'FAKECOARSE' : 'FAKEDISPLAY',
      size: { x: 40, y: 20, z: height },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // Model THREE independent bodies A(F1), B(F2), C(F3).
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await extrudeNewBody('F1', 'SK1', 'Body A')
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    await extrudeNewBody('F2', 'SK2', 'Body B')
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK3')).toBeTruthy())
    await extrudeNewBody('F3', 'SK3', 'Body C')

    // THREE CAM geometry entries, one per body, each with the Model-kernel identity.
    await waitFor(() => expect(modelEntries()).toHaveLength(3))
    for (const bodyId of ['F1', 'F2', 'F3']) {
      const geo = byBody(bodyId)!
      expect(geo.format).toBe('model')
      expect(geo.type).toBe('model')
      expect(geo.id).toBe(`modelbody:${bodyId}`)                 // stable id
      expect(geo.modelBody?.display?.positions.length).toBeGreaterThan(0) // drawable
      expect(geo.loops).toBeUndefined()                          // not op-pickable
    }

    // Snapshot versions + ids before the edit.
    const vA0 = byBody('F1')!.modelBody!.ref.version
    const vB0 = byBody('F2')!.modelBody!.ref.version
    const vC0 = byBody('F3')!.modelBody!.ref.version
    const idA0 = byBody('F1')!.id, idB0 = byBody('F2')!.id, idC0 = byBody('F3')!.id

    // Edit ONLY body A: a REAL shape edit (height 10 -> 20), then regenerate F1. WO-2866: an
    // identical replay keeps its version by design, so the version rises only for a real change.
    height = 20
    hooks().history.execute(new EditFeaturePayloadCommand('F1', { opType: 'extrude', sketchId: 'SK1', distance: 20, direction: 'up', boolMode: 'newBody', name: 'Body A' }))
    await hooks().fullResync(['F1'])

    await waitFor(() => expect(byBody('F1')!.modelBody!.ref.version).toBeGreaterThan(vA0))
    // The interleave: B and C were NOT re-derived - versions AND ids byte-stable.
    expect(byBody('F2')!.modelBody!.ref.version).toBe(vB0)
    expect(byBody('F3')!.modelBody!.ref.version).toBe(vC0)
    expect(byBody('F1')!.id).toBe(idA0)
    expect(byBody('F2')!.id).toBe(idB0)
    expect(byBody('F3')!.id).toBe(idC0)
    expect(modelEntries()).toHaveLength(3)   // no duplicate spawned
  })

  it('a workbench UNDO fires the same hook and keeps CAM entries consistent', async () => {
    useCamStore.getState().newProject()
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await extrudeNewBody('F1', 'SK1', 'Body A')
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    await extrudeNewBody('F2', 'SK2', 'Body B')
    await waitFor(() => expect(modelEntries()).toHaveLength(2))

    // Undo the last extrude (F2). Undo routes through fullResync -> syncCamModelBodies,
    // so F2's body leaves the live set and its CAM entry is reconciled away.
    hooks().history.undo()
    await hooks().fullResync([])
    await waitFor(() => expect(byBody('F2')).toBeUndefined())
    expect(byBody('F1')).toBeDefined()          // A survives, stable
    expect(byBody('F1')!.id).toBe('modelbody:F1')
  })

  it('projects a superseded body lineage to its sole live leaf without surfacing the retained ancestor', async () => {
    useCamStore.getState().newProject()
    const client = createFakeGeomClient({
      applyFilletImpl: (_request, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await extrudeNewBody('F1', 'SK1', 'Body A')
    await waitFor(() => expect(byBody('F1')).toBeDefined())

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F2', kind: 'feature', consumes: ['F1'],
      payload: { opType: 'fillet', ownerId: 'F1', edges: ['edge-1'], radius: 2, propagateTangent: true, name: 'Fillet F2' },
    }))
    await hooks().fullResync(['F2'])

    await waitFor(() => expect(byBody('F2')).toBeDefined())
    expect(byBody('F1')).toBeUndefined()
    expect(modelEntries()).toHaveLength(1)
    expect(byBody('F2')!.modelBody?.ref.lineageId).toBe('F1')
  })
})
