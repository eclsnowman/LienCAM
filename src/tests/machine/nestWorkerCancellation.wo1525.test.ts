// WO-1525 (BUG-531, family K12b): dispatchNest never registered the Worker it
// created anywhere removeNest/explodeNest could reach, so cancelling or
// replacing a still-packing nest left its worker computing to completion for
// no consumer. The fix gives nest workers a module-level `Map<nestId, Worker>`
// registry (mirrors the existing `sketchWorker` module-level-handle pattern):
// dispatchNest registers under payload.nestId and unregisters on its own
// terminate() call sites (NEST_COMPLETE / NEST_ERROR / onerror); removeNest
// and explodeNest look up + terminate + unregister before their own teardown.
//
// A real Worker never spawns in the headless test env (createNest/dispatchNest
// both guard on `typeof Worker`), so these tests install a spy-backed stub
// Worker (Tier 2 desk evidence: real dispatchNest/removeNest through the
// store, asserting the underlying Worker's terminate() was invoked) — the
// same technique nestRecord.test.ts's "recomputeNest transient compute state"
// test already uses for this file's dispatch guard.

import { describe, it, expect, vi } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D } from '../../types'

// -- Fixtures (mirrors src/tests/store/nestRecord.test.ts) --------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squareLoop(id: string, s: number): Loop2D {
  return {
    id,
    layerId: 'L',
    closed: true,
    type: 'contour',
    area: s * s,
    points: [
      { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
    ],
  }
}

function makeGeo(id: string, side: number): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
  } as ImportedGeometry
}

function installProject(geometry: ImportedGeometry[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests: [],
      setups: [],
      stocks: undefined,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

function createParams(over: Partial<Parameters<ReturnType<typeof useCamStore.getState>['createNest']>[0]> = {}) {
  return {
    sources: [{ geometryId: 'a', quantity: 4 }],
    sheet: { width: 100, height: 100 },
    style: 'ninety' as const,
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
    seed: 42,
    ...over,
  }
}

// -- Spy-backed stub Worker ----------------------------------------------------
// Tracks every instance dispatchNest creates (in creation order) so a test can
// grab "the worker for nest N" and assert terminate() on it specifically.

class StubWorker {
  static instances: StubWorker[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: { message?: string; filename?: string; lineno?: number; error?: unknown }) => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() {
    StubWorker.instances.push(this)
  }
}

function installStubWorker(): () => void {
  const orig = (globalThis as { Worker?: unknown }).Worker
  StubWorker.instances = []
  ;(globalThis as { Worker?: unknown }).Worker = StubWorker as unknown
  return () => {
    ;(globalThis as { Worker?: unknown }).Worker = orig
  }
}

describe('nest worker cancellation (WO-1525 / BUG-531)', () => {
  it('removeNest on a still-packing nest terminates its in-flight worker (acceptance 1)', () => {
    const restore = installStubWorker()
    try {
      installProject([makeGeo('a', 20)])
      const id = useCamStore.getState().createNest(createParams())
      expect(StubWorker.instances).toHaveLength(1)
      const worker = StubWorker.instances[0]
      expect(worker.terminate).not.toHaveBeenCalled()

      useCamStore.getState().removeNest(id)
      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(useCamStore.getState().project.nests).toHaveLength(0)

      // No dangling registration: a second removeNest for the same (now gone)
      // id is a no-op, never a double-terminate.
      useCamStore.getState().removeNest(id)
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('a naturally-completed worker unregisters itself; a later removeNest never double-terminates it (acceptance 2)', () => {
    const restore = installStubWorker()
    try {
      installProject([makeGeo('a', 20), makeGeo('b', 20)])
      const idA = useCamStore.getState().createNest(createParams({ sources: [{ geometryId: 'a', quantity: 4 }] }))
      useCamStore.getState().createNest(createParams({ sources: [{ geometryId: 'b', quantity: 4 }] }))
      expect(StubWorker.instances).toHaveLength(2)
      const [workerA, workerB] = StubWorker.instances

      // Simulate A's own onmessage handler delivering NEST_COMPLETE, exactly as
      // the real worker transport would -- this is A's OWN terminate() call
      // (dispatchNest's existing completion path), not the new cancellation one.
      workerA.onmessage?.({
        data: {
          type: 'NEST_COMPLETE', nestId: idA,
          placements: [], unplaced: [], utilization: 0,
          sheetUsed: { width: 100, height: 100 }, computeTimeMs: 1,
        },
      } as MessageEvent)
      expect(workerA.terminate).toHaveBeenCalledTimes(1)

      // The completed nest is still in the store (only the worker finished);
      // removing it now must find no live registration for A -> no accumulation,
      // no double-terminate.
      useCamStore.getState().removeNest(idA)
      expect(workerA.terminate).toHaveBeenCalledTimes(1)

      // B's own worker was never touched by any of the above.
      expect(workerB.terminate).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('re-Calculate (dispatch new, then removeNest the previous) terminates the PREVIOUS provisional only (acceptance 3)', () => {
    const restore = installStubWorker()
    try {
      installProject([makeGeo('a', 20)])
      const prevId = useCamStore.getState().createNest(createParams())
      const prevSeedId = useCamStore.getState().project.nests!.find((n) => n.id === prevId)!.sources[0].geometryId
      expect(StubWorker.instances).toHaveLength(1)
      const prevWorker = StubWorker.instances[0]

      // Mirrors NestModal.handleCalculate: dispatch the NEW provisional (copying
      // from the previous provisional's still-alive owned seed) BEFORE removing
      // the previous one.
      const newId = useCamStore.getState().createNest(
        createParams({ sources: [{ geometryId: prevSeedId, quantity: 4 }] }),
      )
      expect(StubWorker.instances).toHaveLength(2)
      const newWorker = StubWorker.instances[1]
      expect(newId).not.toBe(prevId)

      useCamStore.getState().removeNest(prevId)

      expect(prevWorker.terminate).toHaveBeenCalledTimes(1)
      expect(newWorker.terminate).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('explodeNest on a nest with a live in-flight worker also terminates it (acceptance 4)', () => {
    const restore = installStubWorker()
    try {
      installProject([makeGeo('a', 20)])
      const id = useCamStore.getState().createNest(createParams())
      expect(StubWorker.instances).toHaveLength(1)
      const worker = StubWorker.instances[0]
      expect(worker.terminate).not.toHaveBeenCalled()

      useCamStore.getState().explodeNest(id)
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})
