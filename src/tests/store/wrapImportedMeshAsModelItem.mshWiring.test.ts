// MSH-3 wiring / INT-IMPORT-EDIT stage 4 (REV-ENG rung 0): the STL half of the
// store action wrapImportedGeometryAsModelItem, driven through the REAL zustand
// store (same pattern as the STEP suite), with the IndexedDB STL cache mocked to
// an in-memory map. The prismatic converter (importStl + convertPrismaticMesh)
// runs FOR REAL against the shared MSH-3 mesh fixtures -- this is the wrap flow
// over the existing prismatic fixtures the WO gate requires.
//
// Proves:
//   - happy path (real unitCube STL): the mesh converts, the STL row is marked
//     pendingModelItemId (NOT modelItemId), a Model Item is minted, a seed doc
//     stashed + consumable once, the workspace opens on the item, the row is NOT
//     duplicated, the bytes are copied under a FRESH key, a whole-item placement
//     is seeded from the row pose (no-jump).
//   - REFUSALS (loud, named, NO mutation, NO partial solid, ADR-0003): a
//     non-watertight mesh (cube missing its top) is refused with the
//     CONVERTER'S OWN typed message; nothing is minted and the row stays a
//     plain STL row. Also missing cached bytes. A CURVED mesh is no longer
//     refused (WO-1935): it opens in the Model screen as a mesh, unconverted.
//   - undo: one Ctrl+Z restores the pre-wrap STL row (pending cleared) + drops
//     the item + placement.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'

// The only seam with no node equivalent: the IndexedDB STL byte cache.
const cache = new Map<string, ArrayBuffer>()
let stlWriteGate: Promise<void> | null = null
let announceStlWrite: ((key: string) => void) | null = null
let gateNextFreshStlWrite = false
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => {
    cache.set(id, buf)
    if (id !== 'geo-stl' && gateNextFreshStlWrite) {
      gateNextFreshStlWrite = false
      announceStlWrite?.(id)
      if (stlWriteGate !== null) await stlWriteGate
    }
  },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

import { useCamStore } from '../../store'
import { resetDocumentHolder, takePendingDocumentSeed } from '../../doc/documentHolder'
import { convertPrismaticMesh } from '../../mesh/prismatic'
import { importStl } from '../../mesh/stl'
import type { ImportedGeometry, SceneStock } from '../../types'
import { unitCube, cylinderApprox, cubeWithMissingTop, binaryStlFixture } from '../mesh/fixtures'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

/** A single imported STL row with a seated pose + a name/folder. */
function stlRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 4, y: -6, z: 0 }, rotation: { x: 0, y: 0, z: 45 }, loaded: true,
    color: '#abcdef', folderId: 'fold-2',
    ...over,
  }
}

const state = () => useCamStore.getState()
const geom = () => state().project.geometry
const items = () => state().project.modelItems ?? []
const rowById = (id: string) => geom().find((g) => g.id === id)

function seedCubeBytes(): void {
  cache.set('geo-stl', binaryStlFixture(unitCube(10)))
}

/**
 * Byte-for-byte copy of Operator's real Sample Parts/obj_1_Platte C.stl CAD export.
 * Unlike the hand-built flat plate fixture, this ordinary 2.5D machined plate
 * contains round bores and fillets, so it is the honest reachability probe for
 * the shipped flat-face-only converter.
 */
function realCadPlateBytes(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function resetStore(): void {
  resetDocumentHolder()
  cache.clear()
  stlWriteGate = null
  announceStlWrite = null
  gateNextFreshStlWrite = false
  seedCubeBytes()
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, activeModelItemId: null, brepImportError: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

describe('MSH-3 wiring: wrapImportedGeometryAsModelItem (STL) — happy path', () => {
  beforeEach(resetStore)

  it('converts the mesh, marks the STL row pending, mints the item, opens it, stashes a seed once', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-stl')

    expect(res.ok).toBe(true)
    const itemId = res.itemId!
    expect(itemId).toBeTruthy()

    // Row NOT duplicated; SAME row, now pending (still format:'stl').
    expect(geom()).toHaveLength(1)
    const row = rowById('geo-stl')!
    expect(row.format).toBe('stl')
    expect(row.pendingModelItemId).toBe(itemId)
    expect(row.modelItemId).toBeUndefined()   // pending must NOT light up model-row UI

    // Item minted (named after the row), folder inherited, workspace opened.
    expect(items().map((m) => m.id)).toContain(itemId)
    expect(items().find((m) => m.id === itemId)?.name).toBe('Plate')
    expect(items().find((m) => m.id === itemId)?.folderId).toBe('fold-2')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)

    // Seed stashed against the item, consumable exactly once.
    expect(takePendingDocumentSeed(itemId)).not.toBeNull()
    expect(takePendingDocumentSeed(itemId)).toBeNull()
  })

  it('copies the STL bytes under a FRESH cache key (decoupled from the geo id)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    const keysBefore = new Set(cache.keys())
    await state().wrapImportedGeometryAsModelItem('geo-stl')
    const newKeys = [...cache.keys()].filter((k) => !keysBefore.has(k))
    expect(newKeys).toHaveLength(1)                  // exactly one copy made
    expect(newKeys[0]).not.toBe('geo-stl')            // NOT the source geo id
    expect(cache.get('geo-stl')).toBeDefined()        // original left intact (undo-safe)
  })

  it('seeds a whole-item placement from the STL row pose (no-jump)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-stl')
    const placement = (state().project.modelItemPlacements ?? []).find((p) => p.modelItemId === res.itemId)
    expect(placement).toBeDefined()
    expect(placement?.bodyId).toBeUndefined()         // whole-item, not body-filtered
    expect(placement?.position).toEqual({ x: 4, y: -6, z: 0 })
    expect(placement?.rotation).toEqual({ x: 0, y: 0, z: 45 })
  })
})

describe('MSH-3 wiring: wrapImportedGeometryAsModelItem (STL) — named refusals (no mutation, no partial solid)', () => {
  beforeEach(resetStore)

  async function expectRefusal(row: ImportedGeometry, reasonPrefix: string, messageIncludes: string): Promise<void> {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } }))
    const before = JSON.stringify(state().project.geometry)
    const res = await state().wrapImportedGeometryAsModelItem(row.id)
    expect(res.ok).toBe(false)
    expect(res.reason?.startsWith(reasonPrefix)).toBe(true)
    expect(items()).toHaveLength(0)                                    // nothing minted (no partial solid)
    expect(state().workspace).toBe('cam')                             // no nav
    expect(state().brepImportError).toContain(messageIncludes)         // converter's OWN named message
    expect(JSON.stringify(state().project.geometry)).toBe(before)      // no mutation; row stays plain STL
  }

  // WO-1935 (Operator 2026-09-23): a CURVED mesh is no longer refused. It opens in
  // the Model screen as a mesh-backed body: not converted, no item minted from
  // it, no adoption marker, the row untouched. These two cases pinned the old
  // refusal; they now pin that contract.
  async function expectOpenedAsMesh(row: ImportedGeometry): Promise<void> {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } }))
    const before = JSON.stringify(state().project.geometry)
    const res = await state().wrapImportedGeometryAsModelItem(row.id)
    expect(res).toEqual({ ok: true })
    expect(state().modelStlGeoId).toBe(row.id)
    expect(state().workspace).toBe('part')
    expect(state().brepImportError).toBeNull()
    expect(JSON.stringify(state().project.geometry)).toBe(before)      // row untouched: still format 'stl', no pending marker
    expect(items().every((item) => item.documentState !== 'authored')).toBe(true)  // nothing seeded from the STL
    expect(takePendingDocumentSeed(state().activeModelItemId ?? '')).toBeNull()
  }

  it('opens a curved mesh (cylinder wall) in the Model screen as a mesh, unconverted (WO-1935)', async () => {
    cache.set('geo-stl', binaryStlFixture(cylinderApprox()))
    await expectOpenedAsMesh(stlRow())
  })

  it('real CAD-exported 2.5D plate: the converter still refuses it, and it opens as a mesh instead (WO-1935)', async () => {
    const bytes = realCadPlateBytes()
    const conversion = convertPrismaticMesh(importStl(bytes).mesh)
    expect(conversion.ok).toBe(false)
    if (conversion.ok) return
    expect(conversion.kind).toBe('refused-curved')
    if (conversion.kind !== 'refused-curved') return
    expect(conversion.report.faceCount).toBe(14)
    expect(conversion.curvedRegions).toHaveLength(19)
    expect(conversion.curvedRegions.some((region) => region.shapeHint === 'cylinder-like')).toBe(true)

    cache.set('geo-stl', bytes)
    await expectOpenedAsMesh(stlRow({
      name: 'obj_1_Platte C',
      filename: 'obj_1_Platte C.stl',
    }))
  })

  it('refuses a non-watertight mesh (cube missing its top) with the converter message', async () => {
    cache.set('geo-stl', binaryStlFixture(cubeWithMissingTop()))
    await expectRefusal(stlRow(), 'mesh-non-watertight', 'watertight')
  })

  it('refuses when cached bytes are missing by name', async () => {
    cache.delete('geo-stl')
    await expectRefusal(stlRow(), 'missing-bytes', 'missing')
  })

  it('refuses a nest seed STL copy by name', async () => {
    await expectRefusal(stlRow({ ownerNestId: 'nest-3' }), 'nest-seed', 'nest seed')
  })
})

describe('MSH-3 wiring: wrapImportedGeometryAsModelItem (STL) — undo', () => {
  beforeEach(resetStore)

  it('undo closes the removed item and redo restores both the wrap and its Model workspace', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    const wrapped = await state().wrapImportedGeometryAsModelItem('geo-stl')
    const itemId = wrapped.itemId!
    expect(items()).toHaveLength(1)

    state().undo()
    const row = rowById('geo-stl')!
    expect(row.format).toBe('stl')
    expect(row.pendingModelItemId).toBeUndefined()    // clean pre-wrap row
    expect(items()).toHaveLength(0)                    // item gone
    expect(state().project.modelItemPlacements ?? []).toHaveLength(0)  // placement gone
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()

    state().redo()
    expect(rowById('geo-stl')?.pendingModelItemId).toBe(itemId)
    expect(items().map((item) => item.id)).toEqual([itemId])
    expect(state().project.modelItemPlacements ?? []).toHaveLength(1)
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)
  })

  it('a repeated Edit as model reopens the same pending STL item without duplicating it', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    const first = await state().wrapImportedGeometryAsModelItem('geo-stl')
    const historyAfterFirst = state().projectHistory.length

    const repeated = await state().wrapImportedGeometryAsModelItem('geo-stl')

    expect(repeated).toEqual({ ok: true, itemId: first.itemId })
    expect(items()).toHaveLength(1)
    expect(state().projectHistory).toHaveLength(historyAfterFirst)
  })

  it('a stale post-write STL wrap releases its fresh key without touching replacement state', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } }))
    let releaseWrite!: () => void
    let markWriteStarted!: (key: string) => void
    stlWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeStarted = new Promise<string>((resolve) => { markWriteStarted = resolve })
    announceStlWrite = markWriteStarted
    gateNextFreshStlWrite = true

    const pending = state().wrapImportedGeometryAsModelItem('geo-stl')
    const staleOwnedKey = await writeStarted
    expect(cache.has(staleOwnedKey)).toBe(true)

    state().newProject()
    seedCubeBytes()
    useCamStore.setState({ brepImportError: 'replacement sentinel' })
    const replacementId = state().project.id
    const replacementSnapshot = JSON.stringify(state().project)

    releaseWrite()
    const result = await pending
    stlWriteGate = null
    announceStlWrite = null

    expect(result).toEqual({ ok: false, reason: 'project-replaced' })
    expect(cache.has(staleOwnedKey)).toBe(false)
    expect(cache.has('geo-stl')).toBe(true) // source/replacement bytes were never attempt-owned
    expect(state().project.id).toBe(replacementId)
    expect(JSON.stringify(state().project)).toBe(replacementSnapshot)
    expect(state().brepImportError).toBe('replacement sentinel')
  })
})
