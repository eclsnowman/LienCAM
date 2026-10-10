// WO-1590 (mating S0): a body or fixed stock can be locked in place. Drives
// the REAL store actions - setGeometryLocked / setFixedStockLocked, the write
// paths that move a body (updateGeometryTransform, updateFixedStock,
// moveFixedStockLive), undo, and save/reload - the same shape WO-1572's
// workholdingRow test uses for its own persisted flag.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry, Loop2D, Vec3, FixedStockItem } from '../../types'
import { typedMock } from '../support/typedMock'
import { commitTransformAxis } from '../../components/panels/PropertiesPanel'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function squareLoop(id: string, min: Vec3, max: Vec3): Loop2D {
  return {
    id,
    points: [
      { x: min.x, y: min.y }, { x: max.x, y: min.y }, { x: max.x, y: max.y }, { x: min.x, y: max.y },
    ],
    closed: true, type: 'contour', layerId: `${id}-layer`,
    area: (max.x - min.x) * (max.y - min.y),
  }
}

function stlBody(id: string, name: string, min: Vec3, max: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { ...min }, max: { ...max },
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outline`, min, max)],
    layers2d: [{ id: `${id}-outline-layer`, name: 'Outline', color: '#00e5ff', visible: true }],
  }
}

const VISE = stlBody('vise', 'Kurt vise', { x: -80, y: -60, z: -40 }, { x: 150, y: 90, z: 8 })

function geoOf(id: string): ImportedGeometry | undefined {
  return useCamStore.getState().project.geometry.find((g) => g.id === id)
}

function lastConsoleMessage(): string | undefined {
  const events = useCamStore.getState().consoleEvents
  return events[events.length - 1]?.message
}

let savedBlobs: Blob[] = []

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1590' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.getState().newProject()
  useCamStore.getState().addGeometry(VISE)
})

describe('WO-1590: a locked geometry body does not move', () => {
  it('the transform action leaves position unchanged and names the body on the console', () => {
    useCamStore.getState().setGeometryLocked('vise', true)
    expect(geoOf('vise')?.locked).toBe(true)

    const before = geoOf('vise')!.position
    useCamStore.getState().updateGeometryTransform('vise', { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 })

    expect(geoOf('vise')?.position).toEqual(before)
    expect(lastConsoleMessage()).toMatch(/"Kurt vise" is locked and did not move/)
    expect(lastConsoleMessage()).toMatch(/Unlock/)
  })

  it('unlocking restores the same transform action', () => {
    useCamStore.getState().setGeometryLocked('vise', true)
    useCamStore.getState().updateGeometryTransform('vise', { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 })
    expect(geoOf('vise')?.position).toEqual({ x: 0, y: 0, z: 0 })

    useCamStore.getState().setGeometryLocked('vise', false)
    useCamStore.getState().updateGeometryTransform('vise', { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 })
    expect(geoOf('vise')?.position).toEqual({ x: 50, y: 50, z: 50 })
  })

  it('a zero-delta commit on a locked body writes no console line (nothing was actually refused)', () => {
    useCamStore.getState().setGeometryLocked('vise', true)
    const depth = useCamStore.getState().consoleEvents.length
    useCamStore.getState().updateGeometryTransform('vise', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(useCamStore.getState().consoleEvents.length).toBe(depth)
  })

  it('Undo of the lock restores movability; setting the mark it already has writes no undo step', () => {
    useCamStore.getState().setGeometryLocked('vise', true)
    const depth = useCamStore.getState().projectHistory.length
    useCamStore.getState().setGeometryLocked('vise', true)
    useCamStore.getState().setGeometryLocked('no-such-row', true)
    expect(useCamStore.getState().projectHistory.length).toBe(depth)

    useCamStore.getState().undo()
    expect(geoOf('vise')?.locked).not.toBe(true)
    useCamStore.getState().updateGeometryTransform('vise', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(geoOf('vise')?.position).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('locking never marks operations outdated or changes any other field', () => {
    const before = { ...geoOf('vise')! }
    useCamStore.getState().setGeometryLocked('vise', true)
    const after = geoOf('vise')!
    expect(after.loops).toEqual(before.loops)
    expect(after.stockId).toEqual(before.stockId)
    expect(after.workholding).toEqual(before.workholding)
  })

  it('save, reload: the lock survives', async () => {
    useCamStore.getState().setGeometryLocked('vise', true)
    await useCamStore.getState().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const fileText = await savedBlobs[0].text()

    useCamStore.getState().newProject()
    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(geoOf('vise')?.locked).toBe(true)
  })

  it('audit fix: a refused move snaps the 3D view back, not only the store (WO-1590 audit)', async () => {
    // Every real caller (typed Properties field, gizmo drag-end, seat command)
    // pushes the moved pose into the scene BEFORE this guard ever runs (that
    // is what the audit reproduced: data held, picture stayed moved). Stub
    // the viewport handle the guard restores through and assert it is told
    // the PRE-move pose, not just that the store kept it.
    // This file runs in vitest's default (node) environment - no ambient
    // `window` - so getViewportHandle()'s `typeof window === 'undefined'`
    // guard normally no-ops it here. Stub a minimal `window` for this one
    // test to reach the real restore call.
    const setPartTransform = vi.fn()
    vi.stubGlobal('window', { __cncViewport: { setPartTransform } })

    try {
      useCamStore.getState().setGeometryLocked('vise', true)
      const before = geoOf('vise')!.position
      useCamStore.getState().updateGeometryTransform('vise', { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 })

      // The restore runs on the microtask queue (audit round 2: a synchronous
      // restore here loses the race against a caller that stomps it on ITS
      // very next line, e.g. commitTransformAxis below) - flush it.
      await Promise.resolve()

      expect(setPartTransform).toHaveBeenCalledWith('vise', before, { x: 0, y: 0, z: 0 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('audit round 2 fix: the typed Properties field cannot stomp the restore on its own next line', async () => {
    // Reproduces the exact defect: commitTransformAxis (PropertiesPanel.tsx)
    // calls updateGeometryTransform, then unconditionally pushes the SAME
    // typed pose to the viewport on the very next line, regardless of
    // whether the store just refused it. Drive the REAL caller, not a
    // stand-in, and assert the LAST pose the viewport handle received is the
    // restored (pre-move) one, not the typed value.
    const setPartTransform = vi.fn()
    vi.stubGlobal('window', { __cncViewport: { setPartTransform } })

    try {
      useCamStore.getState().setGeometryLocked('vise', true)
      const before = geoOf('vise')!.position

      commitTransformAxis(geoOf('vise')!, 'position', 'x', 55)

      // commitTransformAxis's own unconditional setPartTransform call runs
      // synchronously with the typed (refused) pose; the store's restore is
      // queued behind it on the microtask queue and must win the race.
      expect(setPartTransform).toHaveBeenLastCalledWith('vise', { x: 55, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      await Promise.resolve()
      expect(setPartTransform).toHaveBeenLastCalledWith('vise', before, { x: 0, y: 0, z: 0 })
      expect(geoOf('vise')?.position).toEqual(before)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('WO-1590: a locked fixed stock does not move', () => {
  const STOCK: FixedStockItem = {
    id: 'vise-block', name: 'Vise block', width: 100, height: 60, depth: 40,
    position: { x: 0, y: 0, z: 0 },
  }

  beforeEach(() => {
    useCamStore.getState().updateSceneStock({ mode: 'fixed' })
    useCamStore.getState().addFixedStock({ ...STOCK })
  })

  function stockOf(id: string): FixedStockItem | undefined {
    return (useCamStore.getState().project.sceneStock.fixedStocks ?? []).find((fs) => fs.id === id)
  }

  it('updateFixedStock strips a position move on a locked stock but keeps other fields, naming it on the console', () => {
    useCamStore.getState().setFixedStockLocked('vise-block', true)
    expect(stockOf('vise-block')?.locked).toBe(true)

    useCamStore.getState().updateFixedStock('vise-block', { position: { x: 99, y: 99, z: 99 }, name: 'Renamed' })

    expect(stockOf('vise-block')?.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(stockOf('vise-block')?.name).toBe('Renamed')
    expect(lastConsoleMessage()).toMatch(/"Vise block" is locked and did not move/)
  })

  it('moveFixedStockLive no-ops on a locked stock', () => {
    useCamStore.getState().setFixedStockLocked('vise-block', true)
    useCamStore.getState().moveFixedStockLive('vise-block', { x: 42, y: 42, z: 42 })
    expect(stockOf('vise-block')?.position).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('unlocking restores both write paths', () => {
    useCamStore.getState().setFixedStockLocked('vise-block', true)
    useCamStore.getState().setFixedStockLocked('vise-block', false)

    useCamStore.getState().moveFixedStockLive('vise-block', { x: 5, y: 5, z: 5 })
    expect(stockOf('vise-block')?.position).toEqual({ x: 5, y: 5, z: 5 })

    useCamStore.getState().updateFixedStock('vise-block', { position: { x: 10, y: 10, z: 10 } })
    expect(stockOf('vise-block')?.position).toEqual({ x: 10, y: 10, z: 10 })
  })

  it('setting the mark it already has writes no undo step', () => {
    useCamStore.getState().setFixedStockLocked('vise-block', true)
    const depth = useCamStore.getState().projectHistory.length
    useCamStore.getState().setFixedStockLocked('vise-block', true)
    useCamStore.getState().setFixedStockLocked('no-such-stock', true)
    expect(useCamStore.getState().projectHistory.length).toBe(depth)
  })
})
