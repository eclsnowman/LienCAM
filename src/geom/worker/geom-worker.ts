/**
 * GEO-1 Comlink worker entry (browser). Hosts the FULL GeomEngine inside a Web
 * Worker and exposes it over Comlink.
 *
 * ARCHITECTURE (GEO-1-R1.5): this is the CUSTOM FULL-KERNEL COMLINK WORKER path
 * — the complete OcctKernel is hosted in this worker BY DESIGN. It is NOT an
 * extension of occt-wasm's curated OcctWorkerProxy (no such proxy patch exists
 * or is vendored); the Architect accepts this shipped design (no license or
 * monkey-patch fragility). Because the full kernel runs here, history-producing
 * ops — cutWithHistory — execute IN the worker with no curation gap.
 *
 * The wasm binary URL is provided by Vite's `?url` import and handed to the
 * engine, satisfying ruling #1 (explicit wasm URL; never bare brepjs.init()).
 *
 * This module is browser-only (Web Worker + `?url`); the Node test path drives
 * GeomEngine directly and never imports this file.
 */
import * as Comlink from 'comlink'
import wasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url'
import { GeomEngine } from './geom-engine.ts'
import { collectTransferables } from './transfer.ts'
import type {
  BodyHandle,
  BooleanRequest,
  ChamferRequest,
  DefeatureRequest,
  DraftRequest,
  ElementMapDelta,
  ExtrudeRequest,
  FaceEditRequest,
  FeatureQuery,
  FilletRequest,
  HoleRequest,
  LoftRequest,
  MeasureResult,
  PatternRequest,
  PlanarFaceSet,
  RevolveRequest,
  ShellRequest,
  StableId,
  SweepRequest,
  TessQuality,
  Vec3,
} from '../geom-service.ts'

const engine = new GeomEngine({ wasm: wasmUrl })

/** The Comlink surface. Mirrors the engine 1:1 except tessellate, which tags a
 *  transfer list so its ArrayBuffers move zero-copy (contract rule 4). */
const api = {
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
  tessellate: async (h: BodyHandle, q: TessQuality) => {
    const t = await engine.tessellate(h, q)
    return Comlink.transfer(t, collectTransferables(t))
  },
  resolve: (h: BodyHandle, ids: StableId[]) => engine.resolve(h, ids),
  measure: (h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]) => engine.measure(h, kind, ids),
  classifyFace: (h: BodyHandle, id: StableId) => engine.classifyFace(h, id),
  importStep: (bytes: ArrayBuffer, importId: string) => engine.importStep(bytes, importId),
  importIges: (bytes: ArrayBuffer, importId: string) => engine.importIges(bytes, importId), // WO-1824
  exportStep: (handles: BodyHandle[]) => engine.exportStep(handles),
  serializeBody: (h: BodyHandle) => engine.serializeBody(h),
  restoreBody: (bytes: ArrayBuffer, map: ElementMapDelta) => engine.restoreBody(bytes, map),
  snapshotsFor: (h: BodyHandle) => engine.snapshotsFor(h),
  bboxDiagonal: (h: BodyHandle) => engine.bboxDiagonal(h),
}

export type GeomWorkerApi = typeof api

Comlink.expose(api)
