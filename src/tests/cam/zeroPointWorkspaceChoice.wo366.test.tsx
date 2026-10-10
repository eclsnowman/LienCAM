// @vitest-environment jsdom
//
// WO-366: the setup-origin picker has two deliberate workspace workflows:
//   circular edge -> center + the edge's own Z, confirmed immediately
//   cylinder face -> show TOP and BOTTOM centers, then confirm one by click
// Bore and boss faces use the same second stage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord, PhysicalStock, Vec3 } from '../../types'
import {
  deriveModelBodyCircularEdgeOrigin,
  deriveModelBodyCircularOrigin,
} from '../../lib/cam/modelBodyDerive'
import {
  setModelBodyFaceSnapshotReader,
  setModelBodyHoleRecognizer,
} from '../../lib/cam/modelBodyHoleRecognition'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

const placements: ModelItemPlacementRecord[] = [{
  modelItemId: 'legacy',
  position: { x: 5, y: -2, z: 7 },
  rotation: { x: 0, y: 0, z: 0 },
}]

const FEATURE_STOCK: PhysicalStock = {
  id: 'stock-feature',
  name: 'Feature Stock',
  mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 100, y: 50, z: 12 },
    size: { x: 100, y: 50, z: 12 },
    center: { x: 50, y: 25, z: 6 },
  },
  position: { x: 0, y: 0, z: 0 },
}

const bossDisplay = {
  positions: [
    14, 12, 0,
    6, 12, 0,
    14, 12, 6,
    6, 12, 6,
  ],
  normals: [],
  indices: [0, 1, 2, 1, 2, 3],
  edgePositions: [],
  edgeOffsets: [],
  bbox: { min: [6, 12, 0] as [number, number, number], max: [14, 12, 6] as [number, number, number] },
  faceIds: ['BOSS:wall'],
  triFace: [0, 0],
}

const bossGeo = {
  id: 'modelbody:BOSS', name: 'Boss Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: { ref: { bodyId: 'BOSS', stableIds: ['BOSS:wall'], version: 1 }, display: bossDisplay },
} as unknown as ImportedGeometry

function bossVerdict(): FeatureVerdict {
  return {
    featureKey: 'loop:10:12:0',
    featureClass: 'boss', removable: true, effect: 'remove',
    faceIds: ['BOSS:wall'], neighbourIds: [],
    params: { centerX: 10, centerY: 12, centerZ: 0, spanX: 8, spanY: 8, depth: 6, faceCount: 2 },
  }
}

function bossSnapshot(): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: [10, 12, 3], normal: [1, 0, 0], area: 150,
    axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: 4,
  }
}

const bossEnds = deriveModelBodyCircularOrigin(
  bossGeo, placements, 'BOSS:wall', bossSnapshot(), [bossVerdict()],
)
const BOSS_TOP: Vec3 = { x: bossEnds.center[0], y: bossEnds.center[1], z: bossEnds.topZ }
const BOSS_BOTTOM: Vec3 = { x: bossEnds.center[0], y: bossEnds.center[1], z: bossEnds.bottomZ }

function circlePoints(cx: number, cy: number, z: number, radius: number, count = 48) {
  const points: Array<[number, number, number]> = []
  for (let index = 0; index <= count; index++) {
    const angle = (2 * Math.PI * index) / count
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z])
  }
  return points
}

const edgeRing = circlePoints(10, 12, 3, 4)
const edgeGeo = {
  id: 'modelbody:EDGE', name: 'Edge Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: {
    ref: { bodyId: 'EDGE', stableIds: ['EDGE:circle'], version: 1 },
    display: {
      positions: [], normals: [], indices: [],
      edgePositions: edgeRing.flat(),
      edgeOffsets: [0, edgeRing.length],
      edgeIds: ['EDGE:circle'],
      bbox: { min: [6, 8, 3], max: [14, 16, 3] },
    },
  },
} as unknown as ImportedGeometry

const edgeCenter = deriveModelBodyCircularEdgeOrigin(edgeGeo, placements, 'EDGE:circle', edgeRing)
const EDGE_ORIGIN: Vec3 = { x: edgeCenter.center[0], y: edgeCenter.center[1], z: edgeCenter.z }

type Selection = {
  geoId: string
  kind: 'face' | 'edge'
  index: number
  isModelFace?: boolean
  isModelEdge?: boolean
}

let pickMode: 'face' | 'edge' | 'face-or-edge' | null = null
let pickCallback: ((selection: Selection, nowSelected: boolean) => void) | null = null
let hoverCallback: ((selection: Selection | null) => void) | null = null
let choiceCallback: ((id: string) => void) | null = null
let choiceCalls: Array<readonly { id: string; label: string; position: Vec3 }[]>
let zeroPointPreview: ReturnType<typeof vi.fn>
let setWCSOrigin: ReturnType<typeof vi.fn>

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function loadGeometry(geometry: ImportedGeometry) {
  const assignedGeometry = { ...geometry, stockId: FEATURE_STOCK.id }
  useCamStore.setState((state) => ({
    activeModal: null,
    editingSetupId: null,
    project: {
      ...state.project,
      stocks: [FEATURE_STOCK],
      geometry: [assignedGeometry],
      setups: [],
      modelItemPlacements: placements,
    },
  }))
}

async function openCircularPicker() {
  render(<SetupModal />)
  act(() => { useCamStore.getState().openModal('new-setup') })
  fireEvent.click(screen.getByTestId('setup-origin-mode-bore'))
  fireEvent.click(screen.getByRole('button', { name: /pick circle \/ cylinder/i }))
  await flush()
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickMode = null
  pickCallback = null
  hoverCallback = null
  choiceCallback = null
  choiceCalls = []
  zeroPointPreview = vi.fn()
  setWCSOrigin = vi.fn()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 12 } }),
    setWCSOrigin,
    exitStockCornerPickMode: vi.fn(),
    exitWCSGizmoMode: vi.fn(),
    exitVertexPickMode: vi.fn(),
    setBrepPickMode: (
      kind: 'face' | 'edge' | 'face-or-edge' | null,
      callback?: ((selection: Selection, nowSelected: boolean) => void) | null,
    ) => {
      pickMode = kind
      pickCallback = kind ? (callback ?? null) : null
      if (!kind) hoverCallback = null
    },
    setBrepPickHoverCallback: (callback: ((selection: Selection | null) => void) | null) => {
      hoverCallback = callback
    },
    setZeroPointChoices: (
      choices: readonly { id: string; label: string; position: Vec3 }[] | null,
      callback?: ((id: string) => void) | null,
    ) => {
      choiceCallback = choices ? (callback ?? null) : null
      if (choices) choiceCalls.push(choices)
    },
    setZeroPointPreview: zeroPointPreview,
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  setModelBodyFaceSnapshotReader(null)
  setModelBodyHoleRecognizer(null)
})

describe('WO-366 circular-edge geometry', () => {
  it('derives one center and one Z from a closed horizontal circle', () => {
    expect(edgeCenter.center[0]).toBeCloseTo(15, 6)
    expect(edgeCenter.center[1]).toBeCloseTo(10, 6)
    expect(edgeCenter.z).toBeCloseTo(10, 6)
    expect(edgeCenter.localCenter.x).toBeCloseTo(10, 6)
    expect(edgeCenter.localCenter.y).toBeCloseTo(12, 6)
    expect(edgeCenter.localCenter.z).toBeCloseTo(3, 6)
    expect(edgeCenter.diameter).toBeCloseTo(8, 6)
  })

  it('refuses an open edge and a closed non-circle', () => {
    expect(() => deriveModelBodyCircularEdgeOrigin(
      edgeGeo, placements, 'EDGE:open', edgeRing.slice(0, -1),
    )).toThrow(/not closed/i)

    const ellipse = circlePoints(10, 12, 3, 1).map((point) => [
      10 + (point[0] - 10) * 4,
      12 + (point[1] - 12) * 9,
      point[2],
    ] as [number, number, number])
    expect(() => deriveModelBodyCircularEdgeOrigin(
      edgeGeo, placements, 'EDGE:ellipse', ellipse,
    )).toThrow(/not circular/i)
  })
})

describe('WO-366 SetupModal workspace workflow', () => {
  it.each([
    ['top', BOSS_TOP],
    ['bottom', BOSS_BOTTOM],
  ] as const)('presents and confirms the boss %s exactly like a bore', async (end, expected) => {
    loadGeometry(bossGeo)
    setModelBodyFaceSnapshotReader(async () => bossSnapshot())
    setModelBodyHoleRecognizer(async () => [bossVerdict()])
    await openCircularPicker()

    expect(pickMode).toBe('face-or-edge')
    act(() => { pickCallback?.({ geoId: bossGeo.id, kind: 'face', index: 0, isModelFace: true }, true) })
    await flush()

    expect(choiceCalls.at(-1)).toEqual([
      { id: 'top', label: 'TOP', position: BOSS_TOP },
      { id: 'bottom', label: 'BOTTOM', position: BOSS_BOTTOM },
    ])
    expect(screen.getByTestId('setup-bore-pick-status').textContent).toMatch(/Choose TOP or BOTTOM/i)

    act(() => { choiceCallback?.(end) })
    await flush()
    expect(setWCSOrigin).toHaveBeenLastCalledWith(expected, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId(`setup-bore-end-${end}`).className).toMatch(/wcs-face-active/)
    expect((screen.getByTestId('setup-circular-stock-select') as HTMLSelectElement).value)
      .toBe(FEATURE_STOCK.id)
  })

  it('confirms a circular edge immediately and saves an honest circle_center binding', async () => {
    loadGeometry(edgeGeo)
    await openCircularPicker()

    const selection: Selection = { geoId: edgeGeo.id, kind: 'edge', index: 0, isModelEdge: true }
    act(() => { hoverCallback?.(selection) })
    expect(zeroPointPreview).toHaveBeenLastCalledWith(EDGE_ORIGIN)

    act(() => { pickCallback?.(selection, true) })
    await flush()

    expect(choiceCalls).toHaveLength(0)
    expect(screen.queryByTestId('setup-bore-end-toggle')).toBeNull()
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(/circle plane/i)
    expect(setWCSOrigin).toHaveBeenLastCalledWith(EDGE_ORIGIN, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: /Create Setup/i }))
    const created = useCamStore.getState().project.setups.at(-1)
    expect(created?.wcs.origin).toEqual(EDGE_ORIGIN)
    const binding = created?.wcs.originBinding
    expect(binding?.kind).toBe('part_feature')
    if (binding?.kind !== 'part_feature' || binding.featureRef.kind !== 'circle_center') {
      throw new Error('expected a circle_center part-feature binding')
    }
    expect(binding.geoId).toBe(edgeGeo.id)
    expect(binding.stockId).toBe(FEATURE_STOCK.id)
    expect(binding.featureRef.geoId).toBe(edgeGeo.id)
    expect(binding.featureRef.bodyId).toBe('EDGE')
    expect(binding.featureRef.modelItemId).toBe('legacy')
    expect(binding.featureRef.edgeStableId).toBe('EDGE:circle')
    expect(binding.featureRef.localCenter.x).toBeCloseTo(10, 6)
    expect(binding.featureRef.localCenter.y).toBeCloseTo(12, 6)
    expect(binding.featureRef.localCenter.z).toBeCloseTo(3, 6)
    expect(binding.featureRef.diameter).toBeCloseTo(8, 6)
  })
})
