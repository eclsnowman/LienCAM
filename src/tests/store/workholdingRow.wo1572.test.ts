// WO-1572: an imported vise or clamp is workholding - never stock, never a
// part, never cut. Drives the REAL store actions: addGeometry for a part and a
// vise, setGeometryWorkholding, undo, the all-parts source resolver, save
// through saveProjectToFile and reload through loadProjectFromFile, and a
// Model-workbench regen through syncModelBodies.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry, Loop2D, ModelBodyDisplay, Vec3 } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  // Save embeds each STL's bytes and refuses a missing one; any bytes will do.
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore, resolveOpGeometrySources } = await import('../../store')
const { computeSceneStockBounds, deriveAutoStockBounds } = await import('../../store/dispatchGeo')
const { pickDefaultSetupStock, getUnassignedGeometry } = await import('../../store/stockAssignment')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { createDocumentArchive } = await import('../../doc/persist')
const { FeatureDag } = await import('../../doc/dag')

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

/** An imported STL body with a projected outline, so it is a candidate for an
 *  all-parts pocket exactly like a real imported part. */
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

// The part sits at the origin; the vise is bigger and beside it, so any leak of
// the vise into the stock box moves every face of the box.
const PART = stlBody('part', 'Bracket', { x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 12 })
const VISE = stlBody('vise', 'Kurt vise', { x: -80, y: -60, z: -40 }, { x: 150, y: 90, z: 8 })

function sceneStockBox() {
  const { project } = useCamStore.getState()
  return computeSceneStockBounds(project.geometry, project.sceneStock, project.modelItemPlacements ?? [])
}

function derivedStockBoxes() {
  return (useCamStore.getState().project.stocks ?? [])
    .filter((s) => s.mode === 'derived')
    .map((s) => ({ id: s.id, min: s.bounds.min, max: s.bounds.max }))
}

function workholdingOf(id: string): boolean | undefined {
  return useCamStore.getState().project.geometry.find((g) => g.id === id)?.workholding
}

function freshProject(bodies: ImportedGeometry[]) {
  useCamStore.getState().newProject()
  useCamStore.getState().updateSceneStock({ mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1 })
  for (const body of bodies) useCamStore.getState().addGeometry(body)
}

let savedBlobs: Blob[] = []
// The stock the same project derives with the part ALONE (no vise imported),
// through the same store actions - the target every "marked" state must equal.
let partOnlyScene: ReturnType<typeof sceneStockBox> = null
let partOnlyDerived: ReturnType<typeof derivedStockBoxes> = []
const partOnlyBox = () => partOnlyScene

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1572' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  freshProject([PART])
  partOnlyScene = sceneStockBox()
  partOnlyDerived = derivedStockBoxes()
  freshProject([PART, VISE])
})

describe('WO-1572: a vise marked workholding is never stock, never a part', () => {
  it('before the mark the vise grows the stock (the defect this order removes)', () => {
    const box = sceneStockBox()!
    expect(box.min).toEqual({ x: -82, y: -62, z: -40 })
    expect(box).not.toEqual(partOnlyBox())
    expect(derivedStockBoxes()).not.toEqual(partOnlyDerived)
  })

  it('marking the vise makes the derived stock bounds equal the part alone', () => {
    useCamStore.getState().setGeometryWorkholding('vise', true)
    expect(workholdingOf('vise')).toBe(true)
    expect(workholdingOf('part')).toBeUndefined()

    const expected = partOnlyBox()!
    expect(expected).toEqual(deriveAutoStockBounds([PART], useCamStore.getState().project.sceneStock))
    expect(expected.min).toEqual({ x: -2, y: -2, z: 0 })
    expect(expected.max).toEqual({ x: 42, y: 32, z: 13 })
    expect(sceneStockBox()).toEqual(expected)
    // The rendered derived stock (its own per-stock offsets) also equals the
    // part-alone project's.
    expect(partOnlyDerived.length).toBeGreaterThan(0)
    expect(derivedStockBoxes()).toEqual(partOnlyDerived)
  })

  it('an all-parts pocket sees only the part: no boundary or island from the vise', () => {
    const before = resolveOpGeometrySources(useCamStore.getState().project.geometry, '__all__', 'pocket_2d')
    expect(before.map((g) => g.id).sort()).toEqual(['part', 'vise'])

    useCamStore.getState().setGeometryWorkholding('vise', true)
    const after = resolveOpGeometrySources(useCamStore.getState().project.geometry, '__all__', 'pocket_2d')
    expect(after.map((g) => g.id)).toEqual(['part'])
    const loopIds = after.flatMap((g) => (g.loops ?? []).map((l) => l.id))
    expect(loopIds).toEqual(['part-outline'])
  })

  it('workholding bears no stock and is never reported as an unassigned part', () => {
    const vise = { ...VISE, workholding: true, stockId: undefined }
    const stocks = useCamStore.getState().project.stocks ?? []
    expect(getUnassignedGeometry([vise], stocks)).toEqual([])
    expect(pickDefaultSetupStock({ geometry: [vise], stocks, nests: [] } as never))
      .toEqual(pickDefaultSetupStock({ geometry: [], stocks, nests: [] } as never))
  })

  it('Undo of the mark restores the previous stock bounds; unmarking is also one step', () => {
    const unmarkedScene = sceneStockBox()
    const unmarkedDerived = derivedStockBoxes()

    useCamStore.getState().setGeometryWorkholding('vise', true)
    expect(sceneStockBox()).toEqual(partOnlyBox())

    useCamStore.getState().undo()
    expect(workholdingOf('vise')).not.toBe(true)
    expect(sceneStockBox()).toEqual(unmarkedScene)
    expect(derivedStockBoxes()).toEqual(unmarkedDerived)

    useCamStore.getState().setGeometryWorkholding('vise', true)
    useCamStore.getState().setGeometryWorkholding('vise', false)
    expect(workholdingOf('vise')).not.toBe(true)
    expect(sceneStockBox()).toEqual(unmarkedScene)
    useCamStore.getState().undo()
    expect(workholdingOf('vise')).toBe(true)
    expect(sceneStockBox()).toEqual(partOnlyBox())
  })

  it('setting the mark it already has writes no undo step', () => {
    useCamStore.getState().setGeometryWorkholding('vise', true)
    const depth = useCamStore.getState().projectHistory.length
    useCamStore.getState().setGeometryWorkholding('vise', true)
    useCamStore.getState().setGeometryWorkholding('part', false)
    useCamStore.getState().setGeometryWorkholding('no-such-row', true)
    expect(useCamStore.getState().projectHistory.length).toBe(depth)
  })

  it('save, reload: the vise is still workholding and the stock still ignores it', async () => {
    useCamStore.getState().setGeometryWorkholding('vise', true)
    await useCamStore.getState().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const fileText = await savedBlobs[0].text()

    useCamStore.getState().newProject()
    expect(useCamStore.getState().project.geometry).toHaveLength(0)

    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(workholdingOf('vise')).toBe(true)
    expect(workholdingOf('part')).toBeUndefined()
    expect(sceneStockBox()).toEqual(partOnlyBox())
    expect(derivedStockBoxes()).toEqual(partOnlyDerived)
    const sources = resolveOpGeometrySources(useCamStore.getState().project.geometry, '__all__', 'pocket_2d')
    expect(sources.map((g) => g.id)).toEqual(['part'])
  })
})

function display(max: number): ModelBodyDisplay {
  return {
    positions: [0, 0, 0, max, 0, 0, max, max, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], edgePositions: [0, 0, 0, max, 0, 0], edgeOffsets: [0, 2],
    bbox: { min: [0, 0, 0], max: [max, max, max] },
  }
}

describe('WO-1572: a body built in the Model workbench can be workholding', () => {
  it('the mark survives a model regen and the body never sizes the stock', () => {
    useCamStore.getState().newProject()
    const itemId = useCamStore.getState().addModelItem()
    stashLoadedDocument(createDocumentArchive({ dag: new FeatureDag(), elementMapDeltas: [] }), itemId)
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'clamp', name: 'Strap clamp' }],
      derived: [{ bodyId: 'clamp', version: 1, stableIds: ['clamp:F0'], display: display(10) }],
      modelItemId: itemId,
    })
    const row = useCamStore.getState().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'clamp')!
    useCamStore.getState().setGeometryWorkholding(row.id, true)
    expect(workholdingOf(row.id)).toBe(true)

    // A model edit re-derives the body: same row, new display, mark kept.
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'clamp', name: 'Strap clamp' }],
      derived: [{ bodyId: 'clamp', version: 2, stableIds: ['clamp:F0'], display: display(25) }],
      modelItemId: itemId,
    })
    const regen = useCamStore.getState().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'clamp')!
    expect(regen.id).toBe(row.id)
    expect(regen.boundingBox.max.x).toBe(25)
    expect(regen.workholding).toBe(true)

    // Alone in the project, the clamp gives the auto stock nothing to wrap.
    useCamStore.getState().updateSceneStock({ mode: 'auto' })
    expect(sceneStockBox()).toBeNull()
    for (const stock of derivedStockBoxes()) {
      expect(stock.max.x - stock.min.x).toBe(0)
    }
  })
})
