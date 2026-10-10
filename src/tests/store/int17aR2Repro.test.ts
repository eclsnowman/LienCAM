// INT-17A-R2 RED-FIRST REPRO of the audit's three major findings
// (coordination/reports/INT-17A-R1.audit.json).
//
// Every test in this file asserts the CURED behaviour using ONLY the APIs that
// already exist on the pre-cure tree, so it COMPILES AND RUNS against the tree
// as the auditor found it. That is what makes the RED log a reproduction rather
// than an import error: each failure below is the defect itself, and the three
// controls at the end pass in BOTH runs, which is what proves the RED is the
// bypass and not a broken harness.
//
// Findings reproduced:
//   1. dispatchGeo's __all__ coordinate/height resolvers never saw R1's
//      model-origin exclusion, so a loop-bearing modeled row both BLOCKED a
//      legitimate op (it has no stockId, by R1's own C3 rule) and LEAKED into
//      the model_top / model_bottom aggregates.
//   2. the display cache accepted a payload for any ModelBodyRef version, and
//      restoreScene patched it straight onto the live entry.
//
// The full cure surface (the new named seam, the bound, the project prune) is
// exercised in int17aR2Boundary.test.ts, which only compiles once the cure has
// landed. This file is the repro; that file is the proof.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ImportedGeometry, ModelBodyDisplay, PhysicalStock, Setup, SceneStock } from '../../types'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { resolveOwningStock, resolveTopZ, resolveModelBottomZ } =
  await import('../../store/dispatchGeo')
const { restoreGeometryToViewport } = await import('../../lib/viewport/restoreScene')

const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } }

function loopGeo(id: string, stockId: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, format: 'dxf', type: '2d',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { ...bbox.min }, max: { ...bbox.max } },
    stockId,
    loops: [{ id: `${id}-l0`, layerId: 'L0', points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ], closed: true, type: 'polyline' }],
    layers2d: [{ id: 'L0', name: 'L0', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The auditor's hostile row, verbatim in shape: model ORIGIN wearing type
 *  'brep' and real loops, no stockId (Stage 1 refuses to stock-bind it), and
 *  parked far off in Z so a leak shows up as a wrong NUMBER, not just a throw. */
function hostileModelGeo(z = 500): ImportedGeometry {
  return {
    id: 'mg1', name: 'Model F1', format: 'model', type: 'brep',
    position: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: -50 }, max: { x: 10, y: 10, z: 50 } },
    loops: [{ id: 'mg1-l0', layerId: 'L0', points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ], closed: true, type: 'polyline' }],
    layers2d: [{ id: 'L0', name: 'L0', color: '#fff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 3 } },
  } as unknown as ImportedGeometry
}

const stockA = {
  id: 'stock-a', name: 'Stock A', mode: 'explicit',
  position: { x: 0, y: 0, z: -12 },
  bounds: { size: { x: 100, y: 100, z: 12 } },
} as unknown as PhysicalStock

const setup = {
  id: 's1', name: 'Setup 1',
  wcs: { origin: { x: 0, y: 0, z: 0 }, stockId: 'stock-a' },
} as unknown as Setup

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

describe('R2 finding 1: __all__ coordinate/height resolution re-admits a modeled body', () => {
  it('BLOCKS a legitimate op: resolveOwningStock("__all__") must resolve, not throw', () => {
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    expect(resolveOwningStock('__all__', geometry, [stockA]).id).toBe('stock-a')
  })

  it('BLOCKS a legitimate op: resolveTopZ("stock_top","__all__") must resolve, not throw', () => {
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    expect(resolveTopZ('stock_top', 0, setup, sceneStock, geometry, '__all__', [stockA]))
      .toBeCloseTo(0, 6)
  })

  it('LEAKS into the aggregate: model_top over "__all__" must ignore the modeled body', () => {
    // Real parts top out at world z=5. The hostile row tops out at 550. Without
    // the guard the reference plane for every All-Parts cut moves 545 mm up.
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    expect(resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', []))
      .toBeCloseTo(5, 6)
  })

  it('LEAKS into the aggregate: model_bottom over "__all__" must ignore the modeled body', () => {
    // Real parts bottom out at world z=0; the hostile row at -550.
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo(-500)]
    expect(resolveModelBottomZ(geometry, '__all__', 0)).toBeCloseTo(0, 6)
  })
})

describe('R2 finding 2: the display cache is accepted for any ref version', () => {
  let idb: FakeIndexedDBHandle
  beforeEach(() => { idb = installFakeIndexedDB() })
  afterEach(() => { idb.restore() })

  function display(tag: number): ModelBodyDisplay {
    return {
      positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      edgePositions: [0, 0, 0, 1, 0, 0],
      edgeOffsets: [0, 2],
      bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
    }
  }

  it('a payload with NO version provenance must not be drawn onto a live ref', async () => {
    // Plant the R1 record shape - a bare display under a bare geometry id, which
    // is exactly what a browser profile running R1 has on disk right now. The
    // entry it lands on carries ref.version 7. Nothing in that record says which
    // version it was tessellated from, so it CANNOT be shown to be current, and
    // per ADR-0003 an unverifiable payload is refused rather than trusted.
    idb.seed('lien-cam-model-body-cache', 'model-body-display', 'modelbody:F1', display(1))

    const geo = {
      id: 'modelbody:F1', name: 'Model F1', format: 'model', type: 'brep',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { ...bbox.min }, max: { ...bbox.max } },
      modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 7 } },
    } as unknown as ImportedGeometry

    const addModelBody = vi.fn()
    const vp = {
      addSTL: vi.fn(async () => null), addModelBody, setSTLVisible: vi.fn(),
      setPartLoopsOnFacePlane: vi.fn(), setPartProjectedLoops: vi.fn(),
      add2DGeometry: vi.fn(), removeSTL: vi.fn(),
    }
    const patched: Array<[string, Partial<ImportedGeometry>]> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await restoreGeometryToViewport(vp as never, [geo], {
      patchGeometry: (id: string, p: Partial<ImportedGeometry>) => { patched.push([id, p]) },
    } as never)

    expect(addModelBody).not.toHaveBeenCalled()
    expect(patched).toHaveLength(0)
    // The refusal is NAMED, so a miss is greppable rather than an invisible blank.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('no-regression controls (must PASS in the RED run too)', () => {
  it('an ordinary all-parts project resolves exactly as before', () => {
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a')]
    expect(resolveOwningStock('__all__', geometry, [stockA]).id).toBe('stock-a')
    expect(resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', [])).toBeCloseTo(5, 6)
    expect(resolveModelBottomZ(geometry, '__all__', 0)).toBeCloseTo(0, 6)
  })

  it('a genuinely unassigned ORDINARY part still fail-louds (ADR-0003 intact)', () => {
    const orphan = loopGeo('c', 'stock-a')
    delete (orphan as { stockId?: string }).stockId
    expect(() => resolveOwningStock('__all__', [loopGeo('a', 'stock-a'), orphan], [stockA]))
      .toThrow(/not assigned to an existing stock/)
  })

  it('a single-geometry (non-__all__) resolution is untouched', () => {
    const geometry = [loopGeo('a', 'stock-a'), hostileModelGeo()]
    expect(resolveOwningStock('a', geometry, [stockA]).id).toBe('stock-a')
  })
})
