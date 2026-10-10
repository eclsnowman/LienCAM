// WO-1596 (mating S2): the sentence before Apply and the amber after come from
// ONE selector, and the `__all__` reference rule no longer counts workholding.
//
// Drives the REAL store: `previewGeometryMove` (the read-only selector the mate
// strip prints) against `updateGeometryTransform` (the write that does the
// outdating). Every case asserts the preview's list EQUALS the set of ops the
// write actually flipped - the mutation-proof shape GEO-UNIFY Stage 3 used for
// `promoteSketchPreview`: break the pipeline and both move together.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type {
  HeightParams, ImportedGeometry, LinkingParams, Loop2D, Operation, PassParams, SceneStock, Setup, Vec3, WCS,
} from '../../types'

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

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function wcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function op(id: string, over: Partial<Operation> = {}, status: Operation['status'] = 'ready'): Operation {
  return {
    id, name: id, type: 'contour_2d', enabled: true, status,
    toolId: 'tool-1', geometrySelections: [],
    heights, passes, linking, params: {},
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    ...over,
  }
}

function setup(id: string, operations: Operation[], w: WCS = wcs()): Setup {
  return {
    id, name: id, wcs: w,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations, notes: '',
  }
}

function squareLoop(id: string, min: Vec3, max: Vec3): Loop2D {
  return {
    id, layerId: `${id}-layer`, closed: true, type: 'contour',
    area: (max.x - min.x) * (max.y - min.y),
    points: [{ x: min.x, y: min.y }, { x: max.x, y: min.y }, { x: max.x, y: max.y }, { x: min.x, y: max.y }],
  }
}

function body(id: string, name: string, min: Vec3, max: Vec3, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
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
    ...over,
  }
}

const PART = body('part', 'Part 1', { x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 12 })
const OTHER = body('other', 'Part 2', { x: 60, y: 0, z: 0 }, { x: 90, y: 30, z: 12 })
const VISE = body('vise', 'Bench Vise', { x: -80, y: -60, z: -40 }, { x: 150, y: 90, z: -1 }, { workholding: true })

const state = () => useCamStore.getState()
const statusOf = (id: string) =>
  state().project.setups.flatMap((s) => s.operations).find((o) => o.id === id)?.status

function install(setups: Setup[], geometry: ImportedGeometry[] = [PART, OTHER, VISE]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project, geometry, setups, sceneStock: autoStock,
      modelItems: [], modelItemPlacements: [],
    },
    projectHistory: [], canUndo: false,
  }))
}

/** The ops a write actually flipped from ready to outdated. */
function flippedBy(write: () => void): string[] {
  const before = state().project.setups.flatMap((s) => s.operations).filter((o) => o.status === 'ready').map((o) => o.id)
  write()
  return before.filter((id) => statusOf(id) === 'outdated').sort()
}

const OPS = () => [
  op('Face part', { params: { geometryId: 'part' } }),
  op('Adaptive all', { params: { geometryId: '__all__' } }),
  op('Contour loop', { geometrySelections: ['part-outline'] }),
  op('Pocket other', { params: { geometryId: 'other' } }),
  op('Drill old', { params: { geometryId: 'part' } }, 'outdated'),
]

beforeEach(() => { state().newProject() })

describe('WO-1596: previewGeometryMove names exactly what updateGeometryTransform outdates', () => {
  it('moving a PART: the ops that name it, directly, by loop or as all-parts - and nothing else', () => {
    install([setup('s1', OPS())])
    const to = { x: 5, y: 0, z: 0 }, rot = { x: 0, y: 0, z: 0 }

    const preview = state().previewGeometryMove('part', to, rot)
    expect(preview.moved).toBe(true)
    expect([...preview.opNames].sort()).toEqual(['Adaptive all', 'Contour loop', 'Face part'])

    const flipped = flippedBy(() => state().updateGeometryTransform('part', to, rot))
    expect(flipped).toEqual([...preview.opIds].sort())
    expect(statusOf('Pocket other')).toBe('ready')
  })

  it('moving WORKHOLDING outdates every ready op (what they keep clear of moved), and the preview says so', () => {
    install([setup('s1', OPS())])
    const to = { x: 0, y: 3, z: 0 }, rot = { x: 0, y: 0, z: 0 }

    const preview = state().previewGeometryMove('vise', to, rot)
    expect([...preview.opNames].sort()).toEqual(['Adaptive all', 'Contour loop', 'Face part', 'Pocket other'])
    expect(flippedBy(() => state().updateGeometryTransform('vise', to, rot))).toEqual([...preview.opIds].sort())
  })

  it('a corner-pinned work origin that rides the part: its setup ambers, and the preview counts it', () => {
    // Setup 2's origin is pinned to the auto stock corner; its only op names
    // Part 2, so it goes outdated ONLY because the part moved the stock box.
    const pinned = wcs({ id: 'wcs-2', cornerRow: 0, cornerCol: 0, cornerFace: 'top' })
    install([setup('s1', OPS()), setup('s2', [op('Chamfer other', { params: { geometryId: 'other' } })], pinned)])
    // Seed the pinned origin where the unmoved scene puts it.
    state().updateGeometryTransform('other', { x: 0, y: 0, z: 0.5 }, { x: 0, y: 0, z: 0 })
    install(state().project.setups.map((s) => ({
      ...s, operations: s.operations.map((o) => (o.id === 'Drill old' ? o : { ...o, status: 'ready' as const })),
    })), state().project.geometry)

    const to = { x: -20, y: 0, z: 0 }, rot = { x: 0, y: 0, z: 0 }
    const preview = state().previewGeometryMove('part', to, rot)
    expect(preview.opNames).toContain('Chamfer other')
    expect(flippedBy(() => state().updateGeometryTransform('part', to, rot))).toEqual([...preview.opIds].sort())
  })

  it('a LOCKED body or a zero move outdates nothing, and the preview agrees', () => {
    install([setup('s1', OPS())], [{ ...PART, locked: true }, OTHER, VISE])
    const to = { x: 9, y: 9, z: 0 }, rot = { x: 0, y: 0, z: 0 }
    expect(state().previewGeometryMove('part', to, rot)).toEqual({ moved: false, opIds: [], opNames: [] })
    expect(flippedBy(() => state().updateGeometryTransform('part', to, rot))).toEqual([])

    install([setup('s1', OPS())])
    const here = PART.position
    expect(state().previewGeometryMove('part', here, PART.rotation).opNames).toEqual([])
  })

  it('is read-only: a preview changes no status and pushes no undo step', () => {
    install([setup('s1', OPS())])
    const before = JSON.stringify(state().project.setups)
    state().previewGeometryMove('vise', { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 })
    expect(JSON.stringify(state().project.setups)).toBe(before)
    expect(state().projectHistory).toHaveLength(0)
  })
})

describe('WO-1596: workholding is not one of "all parts" in the shared reference rule', () => {
  it('re-deriving a VISE outline leaves an all-parts op ready; re-deriving a PART outline still ambers it', () => {
    install([setup('s1', [
      op('Adaptive all', { params: { geometryId: '__all__' } }),
      op('Face vise', { params: { geometryId: 'vise' } }),
    ])])
    const viseLoop = squareLoop('vise-outline-2', { x: -80, y: -60, z: 0 }, { x: 150, y: 90, z: 0 })
    state().setGeometryLoops('vise', [viseLoop], VISE.layers2d ?? [])
    // An op that NAMES the vise is still its dependent; the wildcard is not.
    expect(statusOf('Face vise')).toBe('outdated')
    expect(statusOf('Adaptive all')).toBe('ready')

    const partLoop = squareLoop('part-outline-2', { x: 0, y: 0, z: 0 }, { x: 41, y: 30, z: 0 })
    state().setGeometryLoops('part', [partLoop], PART.layers2d ?? [])
    expect(statusOf('Adaptive all')).toBe('outdated')
  })
})
