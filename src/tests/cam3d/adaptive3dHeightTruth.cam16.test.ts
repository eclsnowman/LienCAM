import { describe, expect, it, vi } from 'vitest'

import { engagementPocket, pocketBox } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
} from '../../cam3d/integration/adaptive3dOperation'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import {
  envelopeFromResolvedMachineHeights,
  legacyHeightIntentForOperation,
  localizeMachineHeightOriginZ,
  operationHeightPlaneNames,
  operationHeightPlaneDisplay,
  snapshotHeightEnvelope,
  worldPlaceResolvedHeights,
} from '../../lib/cam/heightIntent'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { buildAdaptive3dSmartIntent } from '../../lib/cam/smartHeights'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import type {
  FixedStockItem,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

const TOOL: Tool = {
  id: 'tool-flat-3',
  name: 'Flat 3 mm',
  type: 'flat_end_mill',
  diameter: 3,
  fluteLength: 15,
  shankDiameter: 3,
  overallLength: 40,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
}

describe('CAM-16 Adaptive 3D regenerated height truth', () => {
  it('returns the stock top and authored floor that Properties and the viewport must display', { timeout: 60_000 }, async () => {
    const partMesh = pocketBox(
      { x: 24, y: 20, z: 12 },
      { x: 10, y: 8, depth: 5 },
    )
    const stockBounds = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 24,
      maxY: 20,
      maxZ: 16,
    }
    const requestedHeights = {
      clearanceZ: 20,
      retractZ: 18,
      feedZ: 18,
      topZ: stockBounds.maxZ,
      // Operator's exact failure shape: rough only the first 5 mm of stock.
      bottomZ: stockBounds.maxZ - 5,
    }
    const client = makeClient()
    try {
      const result = await computeAdaptive3dMoves({
        partMesh,
        tool: TOOL,
        params: {
          ...DEFAULT_ADAPTIVE3D_PARAMS,
          maxStepdown: 3,
          tolerance: 0.2,
          cellSize: 1,
        },
        stockBounds,
        stockBoundsAreRealStock: true,
        resolvedHeights: requestedHeights,
        client,
      })
      const heightTruth = result.heightTruth

      expect(heightTruth).toBeDefined()
      expect(heightTruth.clearanceZ).toBe(20)
      expect(heightTruth.retractZ).toBe(18)
      expect(heightTruth.topZ).toBe(stockBounds.maxZ)
      expect(heightTruth.bottomZ).toBe(requestedHeights.bottomZ)

      const geometryPositionZ = 7
      const worldWcsOriginZ = 2
      expect(localizeMachineHeightOriginZ(worldWcsOriginZ, geometryPositionZ)).toBe(-5)
      const worldHeightTruth = worldPlaceResolvedHeights(heightTruth, geometryPositionZ)
      expect(worldHeightTruth).toEqual({
        clearanceZ: heightTruth.clearanceZ + geometryPositionZ,
        retractZ: heightTruth.retractZ + geometryPositionZ,
        feedZ: heightTruth.feedZ + geometryPositionZ,
        topZ: heightTruth.topZ + geometryPositionZ,
        bottomZ: heightTruth.bottomZ + geometryPositionZ,
      })
      const envelope = envelopeFromResolvedMachineHeights(worldHeightTruth, worldWcsOriginZ)
      const displayed = operationHeightPlaneDisplay({
        heights: {
          clearanceHeight: 20,
          clearanceHeightMode: 'absolute',
          retractHeight: 18,
          feedHeight: 18,
          topHeight: 12,
          topHeightMode: 'model_top',
          bottomHeight: 0,
          bottomHeightMode: 'model_bottom',
        },
        resolvedHeights: snapshotHeightEnvelope(envelope),
      } as Pick<Operation, 'heights' | 'resolvedHeights'>, worldWcsOriginZ)
      expect(displayed!.clearance).toBe(heightTruth.clearanceZ + geometryPositionZ)
      expect(displayed!.top).toBe(stockBounds.maxZ + geometryPositionZ)
      expect(displayed!.bottom).toBe(heightTruth.bottomZ + geometryPositionZ)

      // Rapids: the traverse plane is Clearance (the highest rapid, and the
      // one Properties shows). Below it, rapids are the entry descent to Feed
      // Height (1962cecd), the guard's proven descents to just above the
      // in-process stock (WO-096) and its proven Stay Down links - this run
      // declares its stock real, so the field can prove them - and the short
      // vertical lift off a cut. Every one of them stays at or above the
      // authored floor (asserted below) and none is above Clearance.
      const rapids = result.moves.filter((move) => move.role === 'rapid')
      const rapidZ = new Set(rapids.map((move) => move.z))
      expect(Math.max(...rapidZ)).toBe(heightTruth.clearanceZ)
      expect(rapids.some((move) => move.z === heightTruth.clearanceZ)).toBe(true)
      expect(Math.min(...result.moves.map((move) => move.z))).toBeGreaterThanOrEqual(
        heightTruth.bottomZ,
      )

      // The adaptive emitter's material-removal roles are cut/finish/stepover.
      // Ramp/plunge are entry descents and legitimately begin above stock top.
      const cuttingRoles = new Set(['cut', 'finish', 'stepover'])
      const cuttingMoves = result.moves.filter((move) => cuttingRoles.has(move.role ?? ''))
      expect(cuttingMoves.length).toBeGreaterThan(0)
      // Keep a role-labelled failure payload so any future strategy role change
      // cannot silently escape the asserted cutting envelope.
      const outsideCuttingEnvelope = cuttingMoves
        .filter((move) => move.z < heightTruth.bottomZ || move.z > heightTruth.topZ)
        .map((move) => ({ role: move.role, z: move.z }))
      expect(outsideCuttingEnvelope).toEqual([])
      for (const move of cuttingMoves) {
        expect(move.z).toBeGreaterThanOrEqual(heightTruth.bottomZ)
        expect(move.z).toBeLessThanOrEqual(heightTruth.topZ)
      }
      for (const move of result.moves) {
        expect(move.z).toBeGreaterThanOrEqual(heightTruth.bottomZ)
        expect(move.z).toBeLessThanOrEqual(heightTruth.clearanceZ)
      }
      const entryMoves = result.moves.filter((move) => move.role === 'ramp' || move.role === 'plunge')
      expect(entryMoves.length).toBeGreaterThan(0)
      expect(entryMoves.some((move) => move.z <= heightTruth.topZ)).toBe(true)

      const worldMoves = result.moves.map((move) => ({ ...move, z: move.z + geometryPositionZ }))
      for (const move of worldMoves) {
        expect(move.z).toBeGreaterThanOrEqual(worldHeightTruth.bottomZ)
        expect(move.z).toBeLessThanOrEqual(worldHeightTruth.clearanceZ)
      }

      // Feed Height is a displayed plane of its own since the smart feed
      // heights (1962cecd).
      expect(operationHeightPlaneNames('adaptive_3d')).toEqual([
        'clearance', 'retract', 'feed', 'top', 'bottom',
      ])
      expect(operationHeightPlaneNames('parallel_3d')).toContain('feed')
      expect(operationHeightPlaneNames('pocket_2d')).toContain('feed')
    } finally {
      await client.dispose()
    }
  })

  it('keeps proven Stay Down links through the production store call', { timeout: 60_000 }, async () => {
    vi.resetModules()

    const partMesh = engagementPocket()
    const stayDownTool: Tool = {
      ...TOOL,
      id: 'tool-flat-6-wo140',
      name: 'Flat 6 mm',
      diameter: 6,
      shankDiameter: 6,
    }
    const acquirePartMesh = vi.fn().mockResolvedValue(partMesh)
    const client = makeClient()
    const generateAdaptiveRough = client.generateAdaptiveRough.bind(client)
    let safetyCounters: Record<string, unknown> | undefined
    vi.spyOn(client, 'generateAdaptiveRough').mockImplementation(async (...args) => {
      const result = await generateAdaptiveRough(...args)
      safetyCounters = result.ir.meta.params
      return result
    })

    vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
      ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
      acquirePartMesh,
    }))
    vi.doMock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
      ...await importOriginal<typeof import('../../lib/stlCache')>(),
      loadCachedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    }))
    vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
      ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
      getCam3dClient: () => client,
    }))

    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', {
      localStorage,
      __cncViewport: {
        getStockBounds: () => ({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 90, y: 60, z: 16 },
        }),
      },
    })

    try {
      const { useCamStore } = await import('../../store')
      const fixedStock: FixedStockItem = {
        id: 'stock-wo140', name: 'WO-140 stock', width: 90, height: 60, depth: 16,
        position: { x: 0, y: 0, z: 0 },
      }
      const sceneStock: SceneStock = {
        mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
        fixedWidth: 90, fixedHeight: 60, fixedDepth: 16, fixedStocks: [fixedStock],
      }
      const physicalStock: PhysicalStock = {
        id: fixedStock.id,
        name: fixedStock.name,
        mode: 'explicit',
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 90, y: 60, z: 16 },
          size: { x: 90, y: 60, z: 16 },
          center: { x: 45, y: 30, z: 8 },
        },
        position: { x: 0, y: 0, z: 0 },
      }
      const geometry: ImportedGeometry = {
        id: 'geo-wo140', name: 'WO-140 engagement pocket', filename: 'wo140.stl',
        type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 90, y: 60, z: 16 },
          size: { x: 90, y: 60, z: 16 }, center: { x: 45, y: 30, z: 8 },
        },
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        loaded: true,
        stockId: fixedStock.id,
      }
      const operation: Operation = stampSmartHeightAuthority({
        id: 'op-wo140',
        name: 'WO-140 adaptive proof',
        type: 'adaptive_3d',
        enabled: true,
        status: 'pending',
        toolId: stayDownTool.id,
        geometrySelections: [geometry.id],
        heights: {
          clearanceHeight: 20,
          clearanceHeightMode: 'absolute',
          retractHeight: 18,
          feedHeight: 18,
          topHeight: 0,
          topHeightMode: 'model_top',
          bottomHeight: 0,
          bottomHeightMode: 'model_bottom',
        },
        passes: {
          stepdown: 3, stepover: 0.4, stockToLeave: 0, finishPasses: 0, springPasses: 0,
        },
        linking: {
          entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
          leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
        },
        params: {
          maxStepdown: 3,
          stepover: 0.4,
          tolerance: 0.2,
          helixDiameter: 3,
          cellSize: 0,
        },
      }, { setupId: 'setup-wo140', geometryIds: [geometry.id], stockId: fixedStock.id })
      const setup: Setup = {
        id: 'setup-wo140',
        name: 'WO-140 setup',
        wcs: {
          id: 'wcs-wo140', label: 'G54', fixtureOffset: 54,
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 },
          stockId: fixedStock.id,
        },
        stock: {
          type: 'rectangular', offsetX: 0, offsetY: 0,
          offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
        },
        operations: [operation],
        notes: '',
      }

      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          id: 'project-wo140',
          geometry: [geometry],
          setups: [setup],
          stocks: [physicalStock],
          sceneStock,
          toolLibrary: [stayDownTool],
          activeSetupId: setup.id,
        },
        toolLibrary: [stayDownTool],
        toolpathBatch: null,
      }))

      await useCamStore.getState().computeOperationToolpath(setup.id, operation.id)

      const storedOperation = useCamStore.getState().project.setups[0].operations[0]
      expect(storedOperation.status).toBe('ready')
      // "Keeps proven Stay Down": the field is proven and no link is rerouted
      // for being UNPROVABLE. A link rerouted because the field shows standing
      // material in its corridor is the guard doing its job (WO-266 judges the
      // whole cutter: 8 such links here, the worst 11.95 mm into material) -
      // pinning traverseRerouted to 0 froze a pre-WO-266 count, and the pinned
      // 35 checks was another. Re-pinned 2026-08-19 (WO-402d follow-up).
      expect(safetyCounters).toMatchObject({
        stockProven: true,
        traverseReroutedUnprovable: 0,
      })
      expect(safetyCounters?.traverseReroutedHitMaterial).toBe(safetyCounters?.traverseRerouted)
      expect(Number(safetyCounters?.traverseChecked)).toBeGreaterThan(0)
    } finally {
      await client.dispose()
      vi.doUnmock('../../cam3d/integration/parallel3dOperation')
      vi.doUnmock('../../lib/stlCache')
      vi.doUnmock('../../cam3d/integration/appClient')
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it.each(['parallel_3d', 'adaptive_3d'] as const)(
    'keeps %s store dispatch, world moves, snapshots, and freshness in one translated frame',
    async (operationType) => {
      vi.resetModules()

      const partMesh = {
        positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 6]),
        indices: new Uint32Array([0, 1, 2]),
        bounds: { min: [0, 0, 0], max: [4, 4, 6] },
        source: 'stl' as const,
      }
      const localMoves = (heights: {
        clearanceZ: number
        bottomZ: number
      }): ToolpathMove[] => [
        { type: 'rapid', x: 0, y: 0, z: heights.clearanceZ, role: 'rapid' },
        { type: 'feed', x: 1, y: 1, z: heights.bottomZ, feed: 300, role: 'cut' },
      ]
      const acquirePartMesh = vi.fn().mockResolvedValue(partMesh)
      const computeParallel3dMoves = vi.fn().mockImplementation(async (args: {
        resolvedHeights: {
          clearanceZ: number
          retractZ: number
          feedZ: number
          topZ: number
          bottomZ: number
        }
      }) => ({
        moves: localMoves(args.resolvedHeights),
        computeTimeMs: 1,
      }))
      const adaptiveTruth = (heights: {
        clearanceZ: number
        retractZ: number
        feedZ: number
        topZ: number
        bottomZ: number
      }) => {
        const topZ = heights.topZ + 1
        const feedZ = Math.max(heights.feedZ, topZ)
        const retractZ = Math.max(heights.retractZ, feedZ)
        const clearanceZ = Math.max(heights.clearanceZ, retractZ)
        return {
          clearanceZ,
          retractZ,
          feedZ,
          topZ,
          bottomZ: heights.bottomZ + 0.5,
        }
      }
      const computeAdaptive3dMoves = vi.fn().mockImplementation(async (args: {
        resolvedHeights: {
          clearanceZ: number
          retractZ: number
          feedZ: number
          topZ: number
          bottomZ: number
        }
      }) => {
        // Deliberately differ from the pre-dispatch mesh envelope. The store
        // must persist this returned strategy truth and fingerprint that exact
        // snapshot, not the requested envelope used for the stale-write guard.
        const heightTruth = adaptiveTruth(args.resolvedHeights)
        return {
          moves: localMoves(heightTruth),
          computeTimeMs: 1,
          carvedStock: undefined,
          carvedStockWarning: undefined,
          diagnostics: undefined,
          heightTruth,
          // Unused by this test: computeAdaptive3dMoves itself is replaced, so
          // nothing reads the grid this run "planned on". The real export
          // requires it, so a genuine (if arbitrary) number stands in rather
          // than a cast.
          cellSize: 1,
        }
      })
      // getCam3dClient's real signature returns a Cam3dClient, not `{}` - the
      // store never calls its methods here (computeParallel3dMoves and
      // computeAdaptive3dMoves are both replaced above), so a real
      // in-process client, unused, stands in for the type instead of a cast.
      const fakeClient = makeClient()

      vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
        ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
        acquirePartMesh,
        computeParallel3dMoves,
      }))
      vi.doMock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/adaptive3dOperation')>({
        ...await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>(),
        computeAdaptive3dMoves,
      }))
      vi.doMock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
        ...await importOriginal<typeof import('../../lib/stlCache')>(),
        loadCachedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }))
      vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
        ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
        getCam3dClient: () => fakeClient,
      }))

      const localStorage = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      }
      vi.stubGlobal('localStorage', localStorage)
      vi.stubGlobal('window', {
        localStorage,
        __cncViewport: {
          getStockBounds: () => ({
            min: { x: 0, y: 0, z: 0 },
            max: { x: 20, y: 20, z: 13 },
          }),
        },
      })

      try {
        const { useCamStore } = await import('../../store')
        const geometryPositionZ = 7
        const worldWcsOriginZ = 2
        const fixedStock: FixedStockItem = {
          id: 'stock-cam16', name: 'CAM-16 stock', width: 20, height: 20, depth: 13,
          position: { x: 0, y: 0, z: 0 },
        }
        const sceneStock: SceneStock = {
          mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
          fixedWidth: 20, fixedHeight: 20, fixedDepth: 12, fixedStocks: [fixedStock],
        }
        const physicalStock: PhysicalStock = {
          id: fixedStock.id,
          name: fixedStock.name,
          mode: 'explicit',
          bounds: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 20, y: 20, z: 13 },
            size: { x: 20, y: 20, z: 13 },
            center: { x: 10, y: 10, z: 6.5 },
          },
          position: { x: 0, y: 0, z: 0 },
        }
        const geometry: ImportedGeometry = {
          id: 'geo-cam16', name: 'Translated solid', filename: 'translated.stl',
          type: 'mesh', format: 'stl',
          boundingBox: {
            min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 6 },
            size: { x: 4, y: 4, z: 6 }, center: { x: 2, y: 2, z: 3 },
          },
          position: { x: 0, y: 0, z: geometryPositionZ },
          rotation: { x: 0, y: 0, z: 0 },
          loaded: true,
          stockId: fixedStock.id,
        }
        const operationHeights = {
          clearanceHeight: 20,
          clearanceHeightMode: 'absolute' as const,
          // Retract/feed are authored as absolute WCS planes under V2's
          // safety-plane ordering (Clearance >= Retract >= Feed >= Material
          // Start, resolved from the owning stock's proven top, 11 here) so
          // both must clear the stock top; bumped from the pre-cutover
          // 10/8 (which V2 correctly refuses as unsafely low).
          retractHeight: 15,
          feedHeight: 12,
          topHeight: 0,
          topHeightMode: 'stock_top' as const,
          bottomHeight: -3,
          bottomHeightMode: 'absolute' as const,
        }
        const operationBase: Operation = {
          id: `op-${operationType}`,
          name: operationType,
          type: operationType,
          enabled: true,
          status: 'pending',
          toolId: TOOL.id,
          geometrySelections: [geometry.id],
          heights: operationHeights,
          passes: {
            stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0,
          },
          linking: {
            entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
            leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
          },
          params: {},
        }
        // Adaptive 3D's live V2 policy never reads authored Top/Bottom for
        // its default (current_material/target_surface) variant - the floor
        // comes from the target mesh, not the operation's `heights`. This
        // test pins a specific authored floor (WCS -3 -> local -8), so it
        // must author an explicit bounded_band intent to make that floor the
        // V2 truth, the same way the operation dialog would for a user who
        // picked an explicit Top/Bottom instead of "follow the model".
        const operation: Operation = operationType === 'adaptive_3d'
          ? {
              ...operationBase,
              smartHeight: {
                kind: 'smart_v2',
                intent: buildAdaptive3dSmartIntent({
                  setupId: 'setup-cam16',
                  geometryIds: [geometry.id],
                  safetyIntent: legacyHeightIntentForOperation(operationBase),
                  mode: 'bounded_band',
                  boundedBand: {
                    topWcsMm: fixedStock.depth - worldWcsOriginZ,
                    bottomWcsMm: operationHeights.bottomHeight,
                  },
                }),
              },
            }
          : stampSmartHeightAuthority(operationBase, {
              setupId: 'setup-cam16', geometryIds: [geometry.id], stockId: fixedStock.id,
            })
        const setup: Setup = {
          id: 'setup-cam16',
          name: 'CAM-16 setup',
          wcs: {
            id: 'wcs-cam16', label: 'G54', fixtureOffset: 54,
            origin: { x: 0, y: 0, z: worldWcsOriginZ },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 },
            stockId: fixedStock.id,
          },
          stock: {
            type: 'rectangular', offsetX: 0, offsetY: 0,
            offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
          },
          operations: [operation],
          notes: '',
        }

        useCamStore.setState((state) => ({
          project: {
            ...state.project,
            id: `project-${operationType}`,
            geometry: [geometry],
            setups: [setup],
            stocks: [physicalStock],
            sceneStock,
            toolLibrary: [TOOL],
            activeSetupId: setup.id,
          },
          toolLibrary: [TOOL],
          toolpathBatch: null,
        }))

        await useCamStore.getState().computeOperationToolpath(setup.id, operation.id)

        const compute = operationType === 'parallel_3d'
          ? computeParallel3dMoves
          : computeAdaptive3dMoves
        expect(compute).toHaveBeenCalledOnce()
        const localHeights = compute.mock.calls[0][0].resolvedHeights
        // World WCS 2 becomes local WCS -5 before the strategy sees it.
        // An absolute clearance offset of 20 therefore resolves to local Z 15.
        expect(localHeights.clearanceZ).toBe(15)
        if (operationType === 'parallel_3d') {
          expect(localHeights.stockTopZ).toBe(6)
        } else {
          const computeArgs = computeAdaptive3dMoves.mock.calls[0][0]
          expect(computeArgs.stockBounds.maxZ).toBe(6)
          expect(computeArgs.stockBoundsAreRealStock).toBe(true)
          // WCS origin is local Z -5 and the authored Bottom is WCS -3,
          // therefore Adaptive must dispatch a local cutting floor of -8.
          // Before the fix this silently became the mesh floor (Z0).
          expect(localHeights.bottomZ).toBe(-8)
        }

        const storedProject = useCamStore.getState().project
        const storedSetup = storedProject.setups[0]
        const storedOperation = storedSetup.operations[0]
        const expectedTruth = operationType === 'adaptive_3d'
          ? adaptiveTruth(localHeights)
          : localHeights
        expect(storedOperation.errorMessage).toBeUndefined()
        expect(storedOperation.status).toBe('ready')
        expect(storedOperation.toolpathMoves?.map((move) => move.z)).toEqual([
          expectedTruth.clearanceZ + geometryPositionZ,
          expectedTruth.bottomZ + geometryPositionZ,
        ])
        expect(storedOperation.resolvedHeights?.machine).toMatchObject({
          clearance: expectedTruth.clearanceZ + geometryPositionZ,
          retract: expectedTruth.retractZ + geometryPositionZ,
          feed: expectedTruth.feedZ + geometryPositionZ,
          top: expectedTruth.topZ + geometryPositionZ,
          bottom: expectedTruth.bottomZ + geometryPositionZ,
        })
        expect(operationGenerationIsCurrent(storedProject, storedSetup, storedOperation)).toBe(true)
      } finally {
        await fakeClient.dispose()
        vi.doUnmock('../../cam3d/integration/parallel3dOperation')
        vi.doUnmock('../../cam3d/integration/adaptive3dOperation')
        vi.doUnmock('../../lib/stlCache')
        vi.doUnmock('../../cam3d/integration/appClient')
        vi.unstubAllGlobals()
        vi.resetModules()
      }
    },
    // This store-dispatch integration path completes in about 3 seconds alone,
    // but the frozen 10-file regression band can push it past Vitest's 5-second
    // default under CPU contention. Keep the behavior pin unchanged while giving
    // the full-band run a bounded load budget.
    20_000,
  )
})
