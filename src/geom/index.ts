/**
 * GEO-1 client facade — the typed main-thread entry point to the geometry
 * service. Default path spawns the Web Worker (browser) and talks to it over
 * Comlink; `createLocalGeomService` runs the same engine on the calling thread
 * (Node tests + the ruling-#2 fallback (b) where history ops stay main-thread).
 *
 * Either way the returned object is a GeomService (the frozen contract) plus
 * two facade-only extras: `snapshotsFor` (the companion snapshot map, ruling
 * #3) and `terminate` (tear the worker/engine down).
 */
import * as Comlink from 'comlink'
import { GeomEngine, type GeomEngineOptions } from './worker/geom-engine.ts'
import type { GeomWorkerApi } from './worker/geom-worker.ts'
import type { DeltaSnapshots } from './worker/internal-types.ts'
import type {
  BodyHandle,
  BooleanRequest,
  ChamferRequest,
  DefeatureRequest,
  DefeatureResult,
  Diag,
  DraftRequest,
  ElementMapDelta,
  ExtrudeRequest,
  FaceEditRequest,
  FeatureQuery,
  FeatureVerdict,
  FilletRequest,
  GeomService,
  HoleRequest,
  IgesContent,
  ImportedBody,
  KernelInfo,
  LoftRequest,
  MeasureResult,
  OpResult,
  PatternRequest,
  PlanarFaceSet,
  RevolveRequest,
  ShellRequest,
  StableId,
  SubshapeType,
  SweepRequest,
  TessBuffers,
  TessQuality,
  Vec3,
} from './geom-service.ts'

export type GeomClient = GeomService & {
  /** Companion geometry-snapshot map for a body (DeltaSnapshots), retrievable
   *  alongside — never inside — the frozen ElementMapDelta. */
  snapshotsFor(h: BodyHandle): Promise<DeltaSnapshots>
  /** Bounding-box diagonal of a body — feeds tessQualityForTier() below. */
  bboxDiagonal(h: BodyHandle): Promise<number>
  /** Tear down the backing worker/engine and release all bodies. */
  terminate(): Promise<void>
}

export { GeomEngine } from './worker/geom-engine.ts'
export type { GeomEngineOptions } from './worker/geom-engine.ts'
export type { DeltaSnapshots, GeometrySnapshot } from './worker/internal-types.ts'
export { collectTransferables } from './worker/transfer.ts'

/**
 * GEO-2 acceptance #6: named tessellation-quality tiers. Facade-only (not
 * part of the frozen GeomService contract) — a pure function from a body's
 * bbox diagonal to a TessQuality, so the SAME tier reads correctly whether
 * the body is 10 mm or 1000 mm across (RELATIVE deflection, per the WO's
 * "computed from body bbox diagonal" requirement). `coarse` favors fast
 * first paint, `fine` is measure/display-grade. Factors were tuned and
 * measured against the largest real STEP fixture available in this
 * environment; see coordination/reports/GEO-2.report.json for the actual
 * numbers and the documented Tray.step (696-face) fixture gap.
 */
export type TessTier = 'coarse' | 'medium' | 'fine'

const TESS_TIER_DEFLECTION_FRACTION: Record<TessTier, number> = {
  coarse: 0.004,
  medium: 0.0012,
  fine: 0.0003,
}
const TESS_TIER_ANGULAR_DEFLECTION: Record<TessTier, number> = {
  coarse: 0.8,
  medium: 0.5,
  fine: 0.25,
}
/** Floor so a degenerate/near-zero bbox never yields a zero or negative deflection. */
const MIN_DEFLECTION = 1e-4

export function tessQualityForTier(bboxDiagonal: number, tier: TessTier): TessQuality {
  const deflection = Math.max(bboxDiagonal * TESS_TIER_DEFLECTION_FRACTION[tier], MIN_DEFLECTION)
  return { deflection, angularDeflection: TESS_TIER_ANGULAR_DEFLECTION[tier] }
}

/**
 * Spawn the geometry Web Worker and return a client. Browser-only (needs the
 * Worker + module-worker + `?url` toolchain — i.e. the Vite app bundle).
 */
export function createGeomService(): GeomClient {
  const worker = new Worker(new URL('./worker/geom-worker.ts', import.meta.url), { type: 'module' })
  const remote = Comlink.wrap<GeomWorkerApi>(worker)
  return {
    init: (onProgress?: (pct: number, phase: string) => void): Promise<KernelInfo> =>
      remote.init(onProgress ? Comlink.proxy(onProgress) : undefined),
    dispose: (h: BodyHandle): Promise<void> => remote.dispose(h),
    disposeAll: (): Promise<void> => remote.disposeAll(),
    makeBox: (featureId: string, size: Vec3): Promise<OpResult> => remote.makeBox(featureId, size),
    makeExtrude: (req: ExtrudeRequest): Promise<OpResult> => remote.makeExtrude(req),
    makeRevolve: (req: RevolveRequest): Promise<OpResult> => remote.makeRevolve(req),
    applyBoolean: (req: BooleanRequest): Promise<OpResult> => remote.applyBoolean(req),
    applyFillet: (req: FilletRequest): Promise<OpResult> => remote.applyFillet(req),
    applyChamfer: (req: ChamferRequest): Promise<OpResult> => remote.applyChamfer(req),
    applyShell: (req: ShellRequest): Promise<OpResult> => remote.applyShell(req),
    applyDraft: (req: DraftRequest): Promise<OpResult> => remote.applyDraft(req),
    makeSweep: (req: SweepRequest): Promise<OpResult> => remote.makeSweep(req), // GEO-5
    makeLoft: (req: LoftRequest): Promise<OpResult> => remote.makeLoft(req), // GEO-5
    makeHole: (req: HoleRequest): Promise<OpResult> => remote.makeHole(req), // GEO-5
    applyBodyPattern: (req: PatternRequest): Promise<OpResult> => remote.applyBodyPattern(req), // GEO-5
    makeSolidFromPlanarFaces: (req: PlanarFaceSet): Promise<OpResult> => remote.makeSolidFromPlanarFaces(req), // MSH-3
    recognizeFeatures: (h: BodyHandle): Promise<FeatureVerdict[]> => remote.recognizeFeatures(h) as Promise<FeatureVerdict[]>, // GEO-6
    queryFeatures: (h: BodyHandle, query: FeatureQuery): Promise<FeatureVerdict[]> => remote.queryFeatures(h, query) as Promise<FeatureVerdict[]>, // GEO-6
    defeatureBatch: (req: DefeatureRequest): Promise<DefeatureResult> => remote.defeatureBatch(req) as Promise<DefeatureResult>, // GEO-6
    editFeature: (req: FaceEditRequest): Promise<OpResult> => remote.editFeature(req), // GEO-6
    tessellate: (h: BodyHandle, q: TessQuality): Promise<TessBuffers> => remote.tessellate(h, q),
    resolve: (h: BodyHandle, ids: StableId[]) => remote.resolve(h, ids) as Promise<Array<{
      id: StableId; status: 'exact' | 'fallback' | 'lost'; localIndex?: number; type?: SubshapeType
    }>>,
    measure: (h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]): Promise<MeasureResult> =>
      remote.measure(h, kind, ids),
    classifyFace: (h: BodyHandle, id: StableId) => remote.classifyFace(h, id),
    importStep: (bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[] }> =>
      remote.importStep(bytes, importId),
    // WO-1824
    importIges: (bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[]; content: IgesContent }> =>
      remote.importIges(bytes, importId),
    exportStep: (handles: BodyHandle[]): Promise<ArrayBuffer> => remote.exportStep(handles),
    serializeBody: (h: BodyHandle): Promise<ArrayBuffer> => remote.serializeBody(h),
    restoreBody: (bytes: ArrayBuffer, map: ElementMapDelta): Promise<BodyHandle> => remote.restoreBody(bytes, map),
    snapshotsFor: (h: BodyHandle): Promise<DeltaSnapshots> => remote.snapshotsFor(h),
    bboxDiagonal: (h: BodyHandle): Promise<number> => remote.bboxDiagonal(h),
    terminate: async (): Promise<void> => {
      remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}

/**
 * Run the engine on the calling thread (no worker). Used by the Node test suite
 * with the real wasm kernel and available as the ruling-#2 fallback (b).
 */
export function createLocalGeomService(opts: GeomEngineOptions = {}): GeomClient {
  const engine = new GeomEngine(opts)
  return {
    init: (onProgress?: (pct: number, phase: string) => void) => engine.init(onProgress),
    dispose: (h: BodyHandle) => engine.dispose(h),
    disposeAll: () => engine.disposeAll(),
    makeBox: (featureId: string, size: Vec3) => engine.makeBox(featureId, size),
    makeExtrude: (req: ExtrudeRequest) => engine.makeExtrude(req),
    makeRevolve: (req: RevolveRequest) => engine.makeRevolve(req),
    applyBoolean: (req: BooleanRequest) => engine.applyBoolean(req),
    applyFillet: (req: FilletRequest) => engine.applyFillet(req),
    applyChamfer: (req: ChamferRequest) => engine.applyChamfer(req),
    applyShell: (req: ShellRequest) => engine.applyShell(req),
    applyDraft: (req: DraftRequest) => engine.applyDraft(req),
    makeSweep: (req: SweepRequest) => engine.makeSweep(req), // GEO-5
    makeLoft: (req: LoftRequest) => engine.makeLoft(req), // GEO-5
    makeHole: (req: HoleRequest) => engine.makeHole(req), // GEO-5
    applyBodyPattern: (req: PatternRequest) => engine.applyBodyPattern(req), // GEO-5
    makeSolidFromPlanarFaces: (req: PlanarFaceSet) => engine.makeSolidFromPlanarFaces(req), // MSH-3
    recognizeFeatures: (h: BodyHandle) => engine.recognizeFeatures(h), // GEO-6
    queryFeatures: (h: BodyHandle, query: FeatureQuery) => engine.queryFeatures(h, query), // GEO-6
    defeatureBatch: (req: DefeatureRequest) => engine.defeatureBatch(req), // GEO-6
    editFeature: (req: FaceEditRequest) => engine.editFeature(req), // GEO-6
    tessellate: (h: BodyHandle, q: TessQuality) => engine.tessellate(h, q),
    resolve: (h: BodyHandle, ids: StableId[]) => engine.resolve(h, ids),
    measure: (h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]) => engine.measure(h, kind, ids),
    classifyFace: (h: BodyHandle, id: StableId) => engine.classifyFace(h, id),
    importStep: (bytes: ArrayBuffer, importId: string) => engine.importStep(bytes, importId),
    importIges: (bytes: ArrayBuffer, importId: string) => engine.importIges(bytes, importId), // WO-1824
    exportStep: (handles: BodyHandle[]) => engine.exportStep(handles),
    serializeBody: (h: BodyHandle) => engine.serializeBody(h),
    restoreBody: (bytes: ArrayBuffer, map: ElementMapDelta) => engine.restoreBody(bytes, map),
    snapshotsFor: async (h: BodyHandle) => engine.snapshotsFor(h),
    bboxDiagonal: async (h: BodyHandle) => engine.bboxDiagonal(h),
    // Full deterministic teardown: release bodies AND dispose the wasm kernel
    // (GEO-1-R1.1), matching the worker path where terminate() kills the thread.
    terminate: () => engine.disposeKernel(),
  }
}
