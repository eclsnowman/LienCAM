// @vitest-environment jsdom
//
// WO-1283: "undo brings the record back, but not the part."
//
// The defect the Spark peer MEASURED in the running app: DesignTree's delete ran
// `cleanupGeoResources` FIRST, purging the part's durable bytes, and only then
// called the store. Undo restored a `loaded: true` record into a project whose
// bytes no longer existed, so the viewport rebuild had nothing to draw. Undo was
// offered, appeared to work, and left the part unrenderable.
//
// WHY THESE TESTS ARE SHAPED THIS WAY. A test that asserts the RECORD came back
// passes against the defect - the record was never the problem. So every case
// here presses the tree's REAL delete control and then runs the REAL rebuild the
// undo path runs (`restoreGeometryToViewport`, called exactly as Viewport.tsx's
// `viewportRefreshTrigger` effect calls it, `checkDocumentConsistency: false`),
// and asserts the VIEWPORT was handed the part's bytes. The cache modules are
// mocked to Map-backed in-memory stores rather than to null-returning stubs, so
// a purge that runs too early really does make the restore fail here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, Loop2D, Layer2D, ModelBodyDisplay } from '../../types'
import { typedMock } from '../support/typedMock'
import { answerPendingConfirm } from '../components/confirmDialog.support'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(); install the in-memory shim BEFORE importing the store
// (same scaffolding as DesignTree.modelBodyBypasses.test.tsx).
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

// ── The durable caches, as REAL round-tripping stores ────────────────────────
// There is no IndexedDB in this environment, but the whole question this file
// asks is "were the bytes still there when the rebuild looked?" - so a stub that
// always returns null would answer it before the product ran. These hold what
// was written and give it back until something purges it.
const stlStore = new Map<string, ArrayBuffer>()
const stepStore = new Map<string, ArrayBuffer>()
const twoDStore = new Map<string, { loops: Loop2D[]; layers: Layer2D[] }>()
const displayStore = new Map<string, ModelBodyDisplay>()
const displayKey = (projectId: string, geometryId: string) => `${projectId}::${geometryId}`

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlStore.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlStore.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlStore.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepStore.set(id, buffer) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async (id: string, loops: Loop2D[], layers: Layer2D[]) => {
    twoDStore.set(id, { loops, layers })
  }),
  load2DGeometry: vi.fn(async (id: string) => twoDStore.get(id) ?? null),
  remove2DGeometry: vi.fn(async (id: string) => { twoDStore.delete(id) }),
}))
vi.mock('../../lib/modelBodyDisplayCache', () => typedMock<typeof import('../../lib/modelBodyDisplayCache')>({
  cacheModelBodyDisplay: vi.fn(async (
    scope: { projectId: string; geometryId: string }, d: ModelBodyDisplay,
  ) => { displayStore.set(displayKey(scope.projectId, scope.geometryId), d) }),
  loadCachedModelBodyDisplay: vi.fn(async (scope: { projectId: string; geometryId: string }) =>
    displayStore.get(displayKey(scope.projectId, scope.geometryId)) ?? null),
  removeCachedModelBodyDisplay: vi.fn(async (projectId: string, geometryId: string) => {
    displayStore.delete(displayKey(projectId, geometryId))
  }),
  pruneModelBodyDisplayCache: vi.fn(async () => {}),
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore, pendingGeometryBytePurgeIds } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { restoreGeometryToViewport } = await import('../../lib/viewport/restoreScene')

/** The store's cache purges are fire-and-forget promises; drain the microtask
 *  queue AND the timer turn before asserting a cache is (or is not) empty. */
const flushCacheIo = () => new Promise((resolve) => setTimeout(resolve, 0))

const bbox = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
  size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
}

function stlGeo(id: string, folderId?: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: bbox, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, folderId,
  }
}

/** Distinguishable bytes, so "the viewport got THIS part's mesh" is provable
 *  rather than "the viewport got something". */
function bytesFor(id: string): ArrayBuffer {
  const buf = new Uint8Array([id.charCodeAt(id.length - 1), 1, 2, 3])
  return buf.buffer
}

/** Seed one STL part exactly as an import leaves it: a store row plus its bytes
 *  in the durable cache. */
function seedStl(id: string, folderId?: string): ImportedGeometry {
  const geo = stlGeo(id, folderId)
  stlStore.set(id, bytesFor(id))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [...s.project.geometry, geo] } }))
  })
  return geo
}

function makeVp() {
  return {
    addSTL: vi.fn(async () => null),
    addModelBody: vi.fn(),
    addBrepModel: vi.fn(),
    setSTLVisible: vi.fn(),
    setPartLoopsOnFacePlane: vi.fn(),
    setPartProjectedLoops: vi.fn(),
    add2DGeometry: vi.fn(),
    removeSTL: vi.fn(),
    remove2DGeometry: vi.fn(),
  }
}

/** THE UNDO REBUILD, as the application runs it. Viewport.tsx's
 *  viewportRefreshTrigger effect clears the scene and calls
 *  restoreGeometryToViewport(vp, project.geometry, false) - the trailing
 *  `false` being the BOOT-ONLY document-consistency gate, which must stay off
 *  on the undo path. Same call here, same argument positions. */
async function rebuildViewportAfterUndo(vp: ReturnType<typeof makeVp>) {
  const { project } = useCamStore.getState()
  await restoreGeometryToViewport(
    vp as never,
    project.geometry,
    { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
    [], new Set(), project.id, () => true, false,
  )
}

afterEach(cleanup)
beforeEach(() => {
  stlStore.clear(); stepStore.clear(); twoDStore.clear(); displayStore.clear()
  vi.clearAllMocks()
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedDerivedGeoIds: [],
    })
  })
})

describe('WO-1283: undo after a tree delete restores the PART, not only the record', () => {
  it('the single-row Remove geometry button: undo puts the mesh back in the viewport', async () => {
    const geo = seedStl('g1')
    render(<DesignTree />)

    // The real control, not a store call: this is the button the Spark peer pressed.
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove geometry')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    expect(useCamStore.getState().canUndo).toBe(true)
    // The affordance is now honest: the bytes an undo would need are still held.
    expect(pendingGeometryBytePurgeIds()).toContain(geo.id)
    await flushCacheIo()
    expect(stlStore.has(geo.id)).toBe(true)

    await act(async () => { useCamStore.getState().undo() })
    const restored = useCamStore.getState().project.geometry
    expect(restored.map((g) => g.id)).toEqual([geo.id])
    expect(restored[0].loaded).toBe(true)

    // THE PART, not the record: the rebuild the undo triggers must hand the
    // viewport this part's actual mesh bytes.
    const vp = makeVp()
    await rebuildViewportAfterUndo(vp)
    expect(vp.addSTL).toHaveBeenCalledTimes(1)
    expect(vp.addSTL).toHaveBeenCalledWith(
      bytesFor(geo.id), geo.id, geo.name,
      expect.anything(), expect.anything(), undefined,
    )
  })

  it('the folder cascade: undo puts every contained part back in the viewport', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      act(() => {
        useCamStore.setState((s) => ({
          project: { ...s.project, geometryFolders: [{ id: 'f1', name: 'Folder', parentId: null }] },
        }))
      })
      const a = seedStl('ga', 'f1')
      const b = seedStl('gb', 'f1')
      render(<DesignTree />)

      await act(async () => { fireEvent.click(screen.getByLabelText('Delete folder')) })
    // NO PROMPT, and that is the point. WO-1268's census originally left folder
    // delete on the native prompt; WO-1284 then removed it, because Operator's
    // 2026-09-07 ruling is that a prompt is legitimate only when the software
    // genuinely CANNOT undo the thing - and this one it can, which the rest of
    // this test proves. The assertion is inverted rather than deleted so the
    // pair stays pinned: no question asked, and everything comes back.
    //
    // This drifted unnoticed because WO-1284's slice was components + ui and
    // did not reach src/tests/store/. A full sweep found it.
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(useCamStore.getState().project.geometry).toHaveLength(0)
      await flushCacheIo()
      expect(stlStore.has(a.id)).toBe(true)
      expect(stlStore.has(b.id)).toBe(true)

      await act(async () => { useCamStore.getState().undo() })
      const vp = makeVp()
      await rebuildViewportAfterUndo(vp)
      expect(vp.addSTL).toHaveBeenCalledTimes(2)
      for (const geo of [a, b]) {
        expect(vp.addSTL).toHaveBeenCalledWith(
          bytesFor(geo.id), geo.id, geo.name,
          expect.anything(), expect.anything(), undefined,
        )
      }
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('delete -> undo -> redo -> undo still redraws the part (the bytes are held for the whole stack)', async () => {
    const geo = seedStl('g1')
    render(<DesignTree />)

    await act(async () => { fireEvent.click(screen.getByLabelText('Remove geometry')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
    await act(async () => { useCamStore.getState().undo() })
    await act(async () => { useCamStore.getState().redo() })
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    await flushCacheIo()
    // Redo re-deletes it, and the pre-delete snapshot is still on the undo
    // stack, so the bytes must NOT have been released.
    expect(stlStore.has(geo.id)).toBe(true)

    await act(async () => { useCamStore.getState().undo() })
    const vp = makeVp()
    await rebuildViewportAfterUndo(vp)
    expect(vp.addSTL).toHaveBeenCalledTimes(1)
    expect(vp.addSTL).toHaveBeenCalledWith(
      bytesFor(geo.id), geo.id, geo.name,
      expect.anything(), expect.anything(), undefined,
    )
  })
})

// The WO's "establish first" question: does the same ordering exist for
// model-item delete? It does - handleDeleteModelItem runs the SAME
// cleanupGeoResources over every dependent row before calling the store - which
// is why the fix went into that shared seam rather than into removeGeo. This is
// the proof that the cascade came with it.
describe('WO-1283: the model-item cascade reaches the same seam and is undoable too', () => {
  const display: ModelBodyDisplay = {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], edgePositions: [0, 0, 0, 1, 0, 0], edgeOffsets: [0, 2],
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
  }

  function seedModelItem(geoId: string): string {
    const geo = {
      id: geoId, name: 'Bracket', filename: 'Bracket', type: 'brep', format: 'model',
      boundingBox: bbox, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      loaded: true, modelItemId: 'item-a',
      modelBody: { ref: { bodyId: `${geoId}-body`, stableIds: [`${geoId}-body:F0`], version: 1 }, display },
    } as ImportedGeometry
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [geo],
          modelItems: [{ id: 'item-a', name: 'Item A' }],
          modelItemPlacements: [
            { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          ],
        },
      }))
    })
    const projectId = useCamStore.getState().project.id
    displayStore.set(displayKey(projectId, geoId), display)
    return projectId
  }

  it('deleting the model item holds its body bytes, and undo redraws the body', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      const projectId = seedModelItem('mg1')
      render(<DesignTree />)

      await act(async () => { fireEvent.click(screen.getByTestId('delete-model-item-btn-mg1')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
      expect(useCamStore.getState().project.geometry).toHaveLength(0)
      await flushCacheIo()
      // The durable tessellation is HELD, not purged - the same deferral the STL
      // path gets, through the same seam.
      expect(pendingGeometryBytePurgeIds()).toContain('mg1')
      expect(displayStore.has(displayKey(projectId, 'mg1'))).toBe(true)

      await act(async () => { useCamStore.getState().undo() })
      expect(useCamStore.getState().project.geometry.map((g) => g.id)).toEqual(['mg1'])
      const vp = makeVp()
      await rebuildViewportAfterUndo(vp)
      expect(vp.addModelBody).toHaveBeenCalledTimes(1)
      expect(vp.addModelBody).toHaveBeenCalledWith(
        'mg1', expect.objectContaining({ positions: expect.any(Array) }), 'Bracket',
        expect.anything(), expect.anything(), undefined,
      )

      // And it is still bounded: delete it again and let the undo entry expire,
      // and the durable entry goes.
      await act(async () => { fireEvent.click(screen.getByTestId('delete-model-item-btn-mg1')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
      act(() => {
        // WO-1893: 52 actions -- the undo stack now holds fifty snapshots.
        for (let i = 0; i < 52; i++) useCamStore.getState().addGeometryFolder(`F${i}`)
      })
      await flushCacheIo()
      expect(displayStore.has(displayKey(projectId, 'mg1'))).toBe(false)
    } finally {
      confirmSpy.mockRestore()
    }
  })
})

describe('WO-1283 memory policy: retention is bounded by the undo depth', () => {
  it('the bytes ARE purged once no history entry can restore the record', async () => {
    const geo = seedStl('g1')
    render(<DesignTree />)
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove geometry')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
    await flushCacheIo()
    expect(stlStore.has(geo.id)).toBe(true)

    // WO-1893: 52 further undoable actions -- the undo stack now holds fifty
    // snapshots, so this is enough to drop the pre-delete one and make the part
    // unreachable.
    act(() => {
      for (let i = 0; i < 52; i++) useCamStore.getState().addGeometryFolder(`F${i}`)
    })
    await flushCacheIo()
    expect(stlStore.has(geo.id)).toBe(false)
    expect(pendingGeometryBytePurgeIds()).not.toContain(geo.id)
  })

  it('repeated delete/undo cycles do not grow what is retained', async () => {
    seedStl('g1')
    render(<DesignTree />)
    for (let i = 0; i < 6; i++) {
      await act(async () => { fireEvent.click(screen.getByLabelText('Remove geometry')) })
    // WO-1268 put a themed confirm on this button after this file was written.
    await answerPendingConfirm(true)
      await act(async () => { useCamStore.getState().undo() })
    }
    await flushCacheIo()
    // One id ever registered, one cache entry ever held - the registry is keyed
    // by geometry id, so a re-delete replaces its entry instead of adding one.
    expect(pendingGeometryBytePurgeIds()).toEqual(['g1'])
    expect(stlStore.size).toBe(1)
    expect(useCamStore.getState().project.geometry.map((g) => g.id)).toEqual(['g1'])
  })
})
