// @vitest-environment jsdom
//
// WO UI-51A-R3 (audit MAJOR 2, disclose-and-pass -- coordination/reports/
// UI-51A-R2.audit.json / UI-51A-R3.md): reresolveCamModelRefs
// (SolidsWorkbenchPage.tsx, the CAM-1 re-resolution hook fired at the end of
// every fullResync pass) used to gate on `handle !== undefined` alone. A
// DELETED body already degraded correctly (no handle -> "lost"), but a
// CONSUMED-but-retained body -- superseded by a later feature, its kernel
// handle deliberately kept alive for undo (liveBodyFeatureIds' own header
// comment) -- still HAD a handle, so client.resolve() ran against it and the
// CAM op silently kept resolving as if the referenced body were still
// current. The prior census entry called this out by name: "DISCLOSED, not
// proven safe... a CONSUMED-but-retained body currently resolves as if still
// current" -- a disclosed exception is not a fix.
//
// This proves the closed gate: a CAM op's ModelReference pointing at a body
// that later gets consumed by a downstream feature degrades (status
// 'degraded', RED, keeps its last-known toolpath -- CAM-1's documented
// lost-id mapping) on the VERY NEXT regen, instead of silently staying
// resolved against the superseded body's stale geometry. A baseline case
// (still-live body, no change) proves the same gate does NOT over-filter a
// genuinely current reference -- both directions, same file.
//
// FAILS-IF: reresolveCamModelRefs's live-set gate (`handle === undefined ||
// !liveBodyIds.has(bodyId)`) reverts to the bare `handle === undefined`
// check -- the "consumed body degrades" case below breaks (op stays 'ready'
// instead of flipping to 'degraded').

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import type { Operation, Setup } from '../../types'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { mintRectangleSketch } from './mintRectangleSketch'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors src/tests/components/*.smoke.test.tsx's own precedent --
// this file is the first SolidsWorkbenchPage test to actually mutate
// useCamStore's project, so it is also the first in this directory to need
// the shim; every prior test's camStore project stayed empty, so
// reresolveCamModelRefs's own early-return (`idsByBody.size === 0`) never
// reached a persisted `set()` call).
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

async function forceInsertAndBuild(id: string, consumes: string[], payload: Record<string, unknown>): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, { id, kind: 'feature', consumes, payload }))
  await hooks().fullResync([id])
}

function opReferencing(bodyId: string): Operation {
  return {
    id: 'op-1', name: 'Boundary op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 't1', geometrySelections: [],
    modelReferences: [{ bodyId, stableIds: ['face1'], role: 'machining-boundary' }],
    heights: {} as never, passes: {} as never, linking: {} as never, params: {},
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 } as never],
  }
}
function setupWith(op: Operation): Setup {
  return { id: 'setup-1', name: 'Setup 1', wcs: {} as never, stock: {} as never, operations: [op], notes: '' }
}

describe('SolidsWorkbenchPage CAM-1 model-reference re-resolution (WO UI-51A-R3, audit MAJOR 2)', () => {
  it('a ModelReference pointing at a LIVE body stays untouched, then degrades the instant that body is CONSUMED by a downstream feature', async () => {
    useCamStore.getState().newProject()
    const client = createFakeGeomClient({ applyFilletImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // F1: a plain new-body extrude, built through the REAL executor.
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // A CAM op whose ONLY ModelReference points at F1.
    useCamStore.getState().addSetup(setupWith(opReferencing('F1')))

    // Baseline: F1 is still LIVE -- a resync with no dirty nodes must resolve
    // clean and leave the op exactly as it was (regression guard: the gate
    // must not over-filter a genuinely current reference either).
    await hooks().fullResync([])
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')

    // F2: a fillet that CONSUMES F1 -- F1 is now superseded, its handle
    // retained-for-undo (never disposed). The SAME op's ModelReference still
    // names F1 by id (unchanged -- CAM-2's relineage is out of this WO's
    // scope, see the census entry).
    await forceInsertAndBuild('F2', ['F1'], { opType: 'fillet', ownerId: 'F1', edges: ['e1'], radius: 2, propagateTangent: true, name: 'Fillet F2' })
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    // THE PROOF: the op degrades -- CAM never silently resolves a stableId
    // against F1's superseded, retained-for-undo handle as if it were current.
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.status, JSON.stringify(op)).toBe('degraded')
    expect(op.modelReferenceNote).toBeDefined()
  })
})
