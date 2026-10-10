import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, PhysicalStock, SceneStock, Setup } from '../../types'
import { resolveTopZ, resolveModelBottomZ } from '../../store/dispatchGeo'
import { NO_PLACEMENTS } from '../../store/dispatchGeo'
import { ModelOriginComputeError, OwningStockError } from '../../store/dispatchGeo'

// Helper to create a model-origin geometry with a bounding box
const createModelGeometry = (
  id: string,
  name: string,
  bbox: { min: [number, number, number]; max: [number, number, number] },
  stockId?: string,
  stockIdLocked?: boolean,
  modelItemId: string = 'item1',
  bodyId: string = 'body1',
): ImportedGeometry => ({
  id,
  name,
  type: 'model',
  format: 'model',
  modelItemId,
  modelBody: {
    ref: { bodyId, stableIds: [], version: 1 },
    display: {
      bbox,
      positions: [],
      normals: [],
      indices: [],
      edgePositions: [],
      edgeOffsets: [],
    },
  },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  stockId,
  stockIdLocked,
  loops: [{ id: 'loop1', points: [], closed: true, type: 'contour', layerId: 'layer1', area: 0 }],
  boundingBox: {
    min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] },
    max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] },
    size: {
      x: bbox.max[0] - bbox.min[0],
      y: bbox.max[1] - bbox.min[1],
      z: bbox.max[2] - bbox.min[2],
    },
    center: {
      x: (bbox.max[0] + bbox.min[0]) / 2,
      y: (bbox.max[1] + bbox.min[1]) / 2,
      z: (bbox.max[2] + bbox.min[2]) / 2,
    },
  },
  filename: '',
  loaded: true,
})

// Helper to create a non-model geometry (e.g., DXF/SVG)
const createNonModelGeometry = (
  id: string,
  name: string,
  position: { x: number; y: number; z: number },
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  stockId?: string,
  stockIdLocked?: boolean,
): ImportedGeometry => ({
  id,
  name,
  type: 'curves_2d',
  format: 'dxf',
  position,
  rotation: { x: 0, y: 0, z: 0 },
  stockId,
  stockIdLocked,
  loops: [{ id: 'loop1', points: [], closed: true, type: 'contour', layerId: 'layer1', area: 0 }],
  boundingBox: {
    min: bbox.min,
    max: bbox.max,
    size: {
      x: bbox.max.x - bbox.min.x,
      y: bbox.max.y - bbox.min.y,
      z: bbox.max.z - bbox.min.z,
    },
    center: {
      x: (bbox.max.x + bbox.min.x) / 2,
      y: (bbox.max.y + bbox.min.y) / 2,
      z: (bbox.max.z + bbox.min.z) / 2,
    },
  },
  filename: '',
  loaded: true,
})

// Helper to create a derived stock
const createTestDerivedStock = (id: string, name: string): PhysicalStock => ({
  id,
  name,
  mode: 'derived',
  bounds: {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
  },
  position: { x: 0, y: 0, z: 0 },
  workOffset: { x: 0, y: 0, z: 0 },
})

// Helper to create a scene stock
const createTestSceneStock = (): SceneStock => ({
  mode: 'auto',
  autoOffsetXY: 5,
  autoOffsetZTop: 5,
  autoStocks: [],
  fixedStocks: [],
  fixedWidth: 0,
  fixedHeight: 0,
  fixedDepth: 0,
})

// Helper to create a minimal setup
const createTestSetup = (wcsZ: number = 0): Setup => ({
  id: 'setup1',
  name: 'Setup 1',
  wcs: {
    id: 'wcs1',
    label: 'WCS 1',
    origin: { x: 0, y: 0, z: wcsZ },
    fixtureOffset: 0,
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  },
  stock: {
    type: 'rectangular',
    offsetX: 0,
    offsetY: 0,
    offsetZTop: 0,
    offsetZBottom: 0,
    material: '',
  },
  operations: [],
  notes: '',
})

describe('modelStockHeights', () => {
  // 1. stock_top and stock_bottom resolve to model-derived stock's real bounds (including PLACED/translated model items)
  describe('stock_top and stock_bottom resolve to model-derived stock bounds', () => {
    it('resolves stock_top and stock_bottom for a model-derived stock with identity placement', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ]

      // stock_bottom = min.z (0) + autoOffsetZTop (0, since it's the bottom)
      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )
      // stock_top = max.z (10) + autoOffsetZTop (5)
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )

      expect(stockBottom).toBeCloseTo(0, 5)
      expect(stockTop).toBeCloseTo(15, 5)
    })

    it('resolves stock_top and stock_bottom for a model-derived stock with translated placement', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 100, y: 50, z: 5 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ]

      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )

      expect(stockBottom).toBeCloseTo(5, 5)
      expect(stockTop).toBeCloseTo(20, 5) // 10 (max.z) + 5 (autoOffsetZTop) + 5 (placement.z)
    })

    it('resolves stock_top and stock_bottom for a model-derived stock with rotated placement', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 90 },
        },
      ]

      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )

      expect(stockBottom).toBeCloseTo(0, 5)
      expect(stockTop).toBeCloseTo(15, 5) // 10 (max.z) + 5 (autoOffsetZTop)
    })

    it('resolves stock_top and stock_bottom for a model-derived stock with translated+rotated placement', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 100, y: 50, z: 5 },
          rotation: { x: 0, y: 0, z: 90 },
        },
      ]

      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )

      expect(stockBottom).toBeCloseTo(5, 5)
      expect(stockTop).toBeCloseTo(20, 5) // 10 (max.z) + 5 (autoOffsetZTop) + 5 (placement.z)
    })
  })

  // 2. Op with NO owning stock still fails loud with the existing named error
  describe('Op with NO owning stock fails loud', () => {
    it('fails with OwningStockError when stock has no members', () => {
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll: ImportedGeometry[] = []
      const stocks = [stock]

      expect(() =>
        resolveTopZ(
          'stock_top',
          0,
          setup,
          sceneStock,
          geometryAll,
          '__all__',
          stocks,
          [],
          undefined,
          [],
        )
      ).toThrow(OwningStockError)
    })

    it('fails with OwningStockError when stock has only unassigned model bodies', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        undefined, // No stockId
        false,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]

      expect(() =>
        resolveTopZ(
          'stock_top',
          0,
          setup,
          sceneStock,
          geometryAll,
          '__all__',
          stocks,
          [],
          undefined,
          [],
        )
      ).toThrow(OwningStockError)
    })
  })

  // 3. Non-model op's height resolution is byte-identical to before (regression pin)
  describe('Non-model op height resolution regression pin', () => {
    it('resolves stock_top and stock_bottom for non-model geometry byte-identically to pre-Stage-3', () => {
      const nonModelGeo = createNonModelGeometry(
        'geo1',
        'DXF 1',
        { x: 0, y: 0, z: 0 },
        {
          min: { x: -20, y: -15, z: 0 },
          max: { x: 20, y: 15, z: 10 },
        },
        'stock1',
        true,
      )
      // Use an explicit stock to avoid deriveStockBounds
      const stock: PhysicalStock = {
        id: 'stock1',
        name: 'Stock 1',
        mode: 'explicit',
        position: { x: 0, y: 0, z: 0 },
        bounds: {
          min: { x: -25, y: -20, z: 0 },
          max: { x: 25, y: 20, z: 15 },
          size: { x: 50, y: 40, z: 15 },
          center: { x: 0, y: 0, z: 7.5 },
        },
        workOffset: { x: 0, y: 0, z: 0 },
      }
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [nonModelGeo]
      const stocks = [stock]

      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        NO_PLACEMENTS, // No placement records (pre-Stage-3 behavior)
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        NO_PLACEMENTS,
      )

      expect(stockBottom).toBeCloseTo(0, 5)
      expect(stockTop).toBeCloseTo(15, 5) // 15 (stock.max.z)
    })
  })

  // 4. Edge cases
  describe('Edge cases', () => {
    it('fails gracefully for degenerate bbox (zero-volume model body)', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [0, 0, 0], max: [0, 0, 0] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ]

      expect(() =>
        resolveTopZ(
          'stock_top',
          0,
          setup,
          sceneStock,
          geometryAll,
          '__all__',
          stocks,
          [],
          undefined,
          placementRecords,
        )
      ).toThrow(OwningStockError)
    })

    it('falls back to pre-Stage-3 behavior when no placement records are provided', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      // Use an explicit stock to avoid deriveStockBounds
      const stock: PhysicalStock = {
        id: 'stock1',
        name: 'Stock 1',
        mode: 'explicit',
        position: { x: 0, y: 0, z: 0 },
        bounds: {
          min: { x: -25, y: -20, z: 0 },
          max: { x: 25, y: 20, z: 15 },
          size: { x: 50, y: 40, z: 15 },
          center: { x: 0, y: 0, z: 7.5 },
        },
        workOffset: { x: 0, y: 0, z: 0 },
      }
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]

      // Should resolve to stock bounds (no placement transformation)
      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        NO_PLACEMENTS,
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        NO_PLACEMENTS,
      )

      expect(stockBottom).toBeCloseTo(0, 5)
      expect(stockTop).toBeCloseTo(15, 5) // 15 (stock.max.z)
    })

    it('fails gracefully for model body with no tessellated display', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      // @ts-expect-error - Simulate missing display
      modelGeo.modelBody.display = null
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ]

      expect(() =>
        resolveTopZ(
          'stock_top',
          0,
          setup,
          sceneStock,
          geometryAll,
          '__all__',
          stocks,
          [],
          undefined,
          placementRecords,
        )
      ).toThrow(OwningStockError)
    })

    it('resolves composite bounds for multiple model bodies locked to the same stock', () => {
      const modelGeo1 = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const modelGeo2 = createModelGeometry(
        'geo2',
        'Model 2',
        { min: [-10, -10, 5], max: [10, 10, 15] },
        'stock1',
        true,
        'item2',
        'body2',
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo1, modelGeo2]
      const stocks = [stock]
      const placementRecords = [
        {
          modelItemId: 'item1',
          bodyId: 'body1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
        {
          modelItemId: 'item2',
          bodyId: 'body2',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ]

      const stockBottom = resolveTopZ(
        'stock_bottom',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )
      const stockTop = resolveTopZ(
        'stock_top',
        0,
        setup,
        sceneStock,
        geometryAll,
        '__all__',
        stocks,
        [],
        undefined,
        placementRecords,
      )

      expect(stockBottom).toBeCloseTo(0, 5) // min.z of both bodies (0)
      expect(stockTop).toBeCloseTo(20, 5) // max.z of both bodies (15) + autoOffsetZTop (5)
    })
  })

  // 5. Unassigned model rows are still refused
  describe('Unassigned model rows are refused', () => {
    it('throws ModelOriginComputeError when an unassigned model row is referenced by ID', () => {
      const modelGeo = createModelGeometry(
        'geo1',
        'Model 1',
        { min: [-20, -15, 0], max: [20, 15, 10] },
        undefined, // No stockId
        false,
      )
      const sceneStock = createTestSceneStock()
      const setup = createTestSetup()
      const geometryAll = [modelGeo]

      expect(() =>
        resolveTopZ(
          'model_top',
          0,
          setup,
          sceneStock,
          geometryAll,
          'geo1', // Explicitly reference the model row
          [],
          [],
        )
      ).toThrow(ModelOriginComputeError)
    })
  })

  // 6. Regression guard for the mistral-stock-heights audit's HIGH-severity
  // finding (coordination/model-trials/longhorizon-2026-07/mistral-stock-heights/
  // audit.md Q1): the SAME computeGeometryScope relaxation that lets a
  // stock-bound model row contribute to stock_top/stock_bottom must NOT leak
  // into resolveModelBottomZ, which reads g.position.z + g.boundingBox.min.z
  // DIRECTLY (a model row's position is always IDENTITY, per INT-17C - its
  // real world pose lives only in the Placement registry, never read here).
  // Adapted from the audit's scratch reproduction at
  // coordination/reports/tmp/q1-modelBottomZ-adversarial.test.ts, which
  // asserted the DEFECT (-50); this asserts the FIX (0).
  describe('resolveModelBottomZ stays STRICT for stock-bound model rows (Q1 regression guard)', () => {
    it('__all__ model_bottom ignores a stock-bound model row even when its LOCAL bbox extends below the DXF bottom', () => {
      // DXF geometry: flat at z=0, bottom also at 0.
      const dxfGeo = createNonModelGeometry(
        'dxf1',
        'DXF Part',
        { x: 0, y: 0, z: 0 },
        { min: { x: -50, y: -50, z: 0 }, max: { x: 50, y: 50, z: 0 } },
        'stock1',
        true,
      )
      // Stock-bound model body whose LOCAL bbox extends BELOW z=0 (min.z=-50).
      // position stays IDENTITY (INT-17C) regardless of any real placement -
      // resolveModelBottomZ never reads the Placement registry, so a leaked
      // row here can only ever contribute its wrong LOCAL bbox.
      const modelGeo = createModelGeometry(
        'model1',
        'Tall Model Body',
        { min: [-20, -15, -50], max: [20, 15, 10] },
        'stock1',
        true,
      )
      const stock = createTestDerivedStock('stock1', 'Stock 1')

      const bottomWithModelRow = resolveModelBottomZ(
        [dxfGeo, modelGeo],
        '__all__',
        0,
        [stock],
        [],
      )
      // Sanity control: DXF alone gives the same answer as with the model row
      // present - proving the model row's local -50 bbox is NOT contributing.
      const bottomDxfOnly = resolveModelBottomZ([dxfGeo], '__all__', 0, [stock], [])

      expect(bottomDxfOnly).toBe(0)
      // NOT -50. -50 is the audit's confirmed live defect value (the model
      // row's LOCAL bbox.min.z dragging the aggregate down).
      expect(bottomWithModelRow).toBe(0)
    })
  })
})