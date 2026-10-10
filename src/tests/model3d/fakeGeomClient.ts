// 3D Lab tests: hand-rolled in-memory GeomClient fake -- the "worker faked at
// the facade boundary" the WO's render smoke test acceptance criterion
// requires. No real worker, no wasm kernel: makeBox/applyBoolean mint
// incrementing fake BodyHandles, tessellate returns the SAME small valid
// TessBuffers shapes viewport3d's own fixtures.ts mock builder produces (for
// consistency with the rest of the suite), dispose/disposeAll just record
// calls so tests can assert on them.

import type { GeomClient } from '../../geom'
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
  FeatureVerdict,
  FilletRequest,
  HoleRequest,
  IgesContent,
  ImportedBody,
  KernelInfo,
  MeasureResult,
  OpResult,
  RevolveRequest,
  ShellRequest,
  StableId,
  SubshapeType,
  TessBuffers,
  TessQuality,
  Vec3,
} from '../../geom/geom-service'
import { COARSE_TESS_QUALITY } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'

export interface FakeGeomClient extends GeomClient {
  /** Every handle dispose() was called with, in call order -- the
   *  worker-side half of the dispose acceptance criterion's count assertion. */
  disposedHandles: BodyHandle[]
  /** Every handle disposeAll() would have released, for completeness. */
  disposeAllCallCount: number
  initCallCount: number
  /** Every (bytes, importId) importStep() was called with, in call order --
   *  WO INT-1 "Open STEP" flow tests assert on this instead of re-parsing
   *  fake bytes. */
  importStepCalls: Array<{ bytes: ArrayBuffer; importId: string }>
  /** Every (handle, kind, ids) measure() was called with, in call order --
   *  WO INT-1 measure-readout tests assert the UI requested the right kind. */
  measureCalls: Array<{ handle: BodyHandle; kind: MeasureResult['kind']; ids?: StableId[] }>
  /** WO INT-4A-R1: every makeExtrude/makeRevolve/applyBoolean call, in call
   *  order, keyed by the request's own featureId -- the R1.3 over-
   *  regeneration guard test asserts an edit to feature A does not bump
   *  feature B's own call count. */
  opCalls: Array<{ op: 'makeExtrude' | 'makeRevolve' | 'applyBoolean'; featureId: string }>
  /** WO UI-10 (BK-60): exportStep() call count -- the defeature-flow test's
   *  "NO exportStep" spy assertion (acceptance #3). */
  exportStepCallCount: number
  /** WO UI-10 (BK-60): every defeatureBatch() request, in call order. */
  defeatureBatchCalls: DefeatureRequest[]
}

export interface FakeGeomClientOptions {
  /** WO INT-1: bodies importStep() resolves to (default: none, matching the
   *  original UI-2 fake's behavior). Each entry mints a fresh handle. */
  importedBodies?: Array<{ name?: string; color?: [number, number, number] }>
  /** Override measure()'s fixed return value per test. */
  measureResult?: MeasureResult
  /** WO UI-4-R1: per-HANDLE measure() override, checked before measureResult.
   *  Keyed by handle (not call count) deliberately -- tessellateProgressive
   *  paints coarse THEN display for the SAME handle (progressiveTessellate.ts),
   *  so a call-count-indexed sequence would misfire across those two paints;
   *  a real kernel's measure('volume') is invariant across tessellation tier
   *  and only actually changes when disposeBody+createBox mints a genuinely
   *  NEW handle (handleRegenerate's regenerate path) -- this mirrors that. */
  measureResultForHandle?: (handle: BodyHandle, kind: MeasureResult['kind']) => MeasureResult | undefined
  /** WO INT-4A-R1: override makeExtrude's behavior (default: mint a fresh
   *  handle, ok:true) -- lets a test drive a "succeeds once then fails on
   *  replay" scenario (R1.2's handle-leak regression). */
  makeExtrudeImpl?: (req: ExtrudeRequest, mintHandle: () => BodyHandle) => OpResult
  /** Override makeRevolve's behavior (default: mint a fresh handle, ok:true). */
  makeRevolveImpl?: (req: RevolveRequest, mintHandle: () => BodyHandle) => OpResult
  /** WO UI-10 (BK-60): recognizeFeatures()'s fixed return value (default:
   *  reject, matching this fake's prior "not used in 3D Lab tests"
   *  convention for capabilities no earlier WO needed). */
  recognizeFeaturesResult?: FeatureVerdict[]
  /** WO UI-10 (BK-60): defeatureBatch()'s behavior (default: reject, same
   *  convention) -- mints a fresh handle for the healed result via
   *  `mintHandle` so the adopt-in-place flow gets a handle distinct from
   *  the pre-defeature body's, same as the real kernel would. */
  defeatureBatchImpl?: (req: DefeatureRequest, mintHandle: () => BodyHandle) => DefeatureResult
  /** WO UI-51A-R3: applyFillet()'s behavior (default: reject, same
   *  "not used in 3D Lab tests" convention every other dress-up op stub
   *  follows) -- opt-in only, so every test that never overrides this keeps
   *  the exact prior reject-by-default behavior. */
  applyFilletImpl?: (req: FilletRequest, mintHandle: () => BodyHandle) => OpResult
  /** WO UI-51A-R3: applyChamfer()'s behavior (default: reject). */
  applyChamferImpl?: (req: ChamferRequest, mintHandle: () => BodyHandle) => OpResult
  /** WO UI-51A-R3: applyShell()'s behavior (default: reject). */
  applyShellImpl?: (req: ShellRequest, mintHandle: () => BodyHandle) => OpResult
  /** WO UI-51A-R3: applyDraft()'s behavior (default: reject). */
  applyDraftImpl?: (req: DraftRequest, mintHandle: () => BodyHandle) => OpResult
  /** WO UI-51A-R3: makeHole()'s behavior (default: reject). */
  makeHoleImpl?: (req: HoleRequest, mintHandle: () => BodyHandle) => OpResult
}

/** Fresh fake client per test -- handle numbering restarts at 1 each time so
 *  assertions never depend on cross-test ordering. */
export function createFakeGeomClient(opts: FakeGeomClientOptions = {}): FakeGeomClient {
  let nextHandle = 1
  const disposedHandles: BodyHandle[] = []
  const importStepCalls: Array<{ bytes: ArrayBuffer; importId: string }> = []
  const measureCalls: Array<{ handle: BodyHandle; kind: MeasureResult['kind']; ids?: StableId[] }> = []
  const opCalls: Array<{ op: 'makeExtrude' | 'makeRevolve' | 'applyBoolean'; featureId: string }> = []
  const defeatureBatchCalls: DefeatureRequest[] = []
  let disposeAllCallCount = 0
  let initCallCount = 0
  let exportStepCallCount = 0

  const mintHandle = (): BodyHandle => (nextHandle++ as BodyHandle)

  const client: FakeGeomClient = {
    disposedHandles,
    importStepCalls,
    measureCalls,
    opCalls,
    defeatureBatchCalls,
    get disposeAllCallCount() {
      return disposeAllCallCount
    },
    get initCallCount() {
      return initCallCount
    },
    get exportStepCallCount() {
      return exportStepCallCount
    },

    init: async (onProgress?: (pct: number, phase: string) => void): Promise<KernelInfo> => {
      initCallCount++
      onProgress?.(0, 'boot')
      onProgress?.(50, 'loading-kernel')
      onProgress?.(100, 'ready')
      return {
        backend: 'occt-wasm',
        occtVersion: 'fake-0.0',
        capabilities: { defeature: false, xcaf: false, hlr: false },
      }
    },
    dispose: async (h: BodyHandle): Promise<void> => {
      disposedHandles.push(h)
    },
    disposeAll: async (): Promise<void> => {
      disposeAllCallCount++
    },
    makeBox: async (_featureId: string, _size: Vec3): Promise<OpResult> => {
      return { ok: true, body: mintHandle(), diagnostics: [] }
    },
    makeExtrude: async (req: ExtrudeRequest): Promise<OpResult> => {
      opCalls.push({ op: 'makeExtrude', featureId: req.featureId })
      return opts.makeExtrudeImpl?.(req, mintHandle) ?? { ok: true, body: mintHandle(), diagnostics: [] }
    },
    makeRevolve: async (req: RevolveRequest): Promise<OpResult> => {
      opCalls.push({ op: 'makeRevolve', featureId: req.featureId })
      return opts.makeRevolveImpl?.(req, mintHandle) ?? { ok: true, body: mintHandle(), diagnostics: [] }
    },
    applyBoolean: async (req: BooleanRequest): Promise<OpResult> => {
      opCalls.push({ op: 'applyBoolean', featureId: req.featureId })
      return { ok: true, body: mintHandle(), diagnostics: [] }
    },
    applyFillet: async (req: FilletRequest): Promise<OpResult> => {
      if (opts.applyFilletImpl === undefined) {
        return Promise.reject(new Error('fakeGeomClient: applyFillet not used in 3D Lab tests'))
      }
      return opts.applyFilletImpl(req, mintHandle)
    },
    recognizeFeatures: async (): Promise<FeatureVerdict[]> => {
      if (opts.recognizeFeaturesResult === undefined) {
        throw new Error('fakeGeomClient: recognizeFeatures not used in 3D Lab tests')
      }
      return opts.recognizeFeaturesResult
    },
    queryFeatures: () => Promise.reject(new Error('fakeGeomClient: queryFeatures not used in 3D Lab tests')),
    defeatureBatch: async (req: DefeatureRequest): Promise<DefeatureResult> => {
      if (opts.defeatureBatchImpl === undefined) {
        throw new Error('fakeGeomClient: defeatureBatch not used in 3D Lab tests')
      }
      defeatureBatchCalls.push(req)
      return opts.defeatureBatchImpl(req, mintHandle)
    },
    editFeature: () => Promise.reject(new Error('fakeGeomClient: editFeature not used in 3D Lab tests')),
    applyChamfer: async (req: ChamferRequest): Promise<OpResult> => {
      if (opts.applyChamferImpl === undefined) {
        return Promise.reject(new Error('fakeGeomClient: applyChamfer not used in 3D Lab tests'))
      }
      return opts.applyChamferImpl(req, mintHandle)
    },
    applyShell: async (req: ShellRequest): Promise<OpResult> => {
      if (opts.applyShellImpl === undefined) {
        return Promise.reject(new Error('fakeGeomClient: applyShell not used in 3D Lab tests'))
      }
      return opts.applyShellImpl(req, mintHandle)
    },
    applyDraft: async (req: DraftRequest): Promise<OpResult> => {
      if (opts.applyDraftImpl === undefined) {
        return Promise.reject(new Error('fakeGeomClient: applyDraft not used in 3D Lab tests'))
      }
      return opts.applyDraftImpl(req, mintHandle)
    },
    makeSolidFromPlanarFaces: () => Promise.reject(new Error('fakeGeomClient: makeSolidFromPlanarFaces not used in 3D Lab tests')),
    makeSweep: () => Promise.reject(new Error('fakeGeomClient: makeSweep not used in 3D Lab tests')),
    makeLoft: () => Promise.reject(new Error('fakeGeomClient: makeLoft not used in 3D Lab tests')),
    makeHole: async (req: HoleRequest): Promise<OpResult> => {
      if (opts.makeHoleImpl === undefined) {
        return Promise.reject(new Error('fakeGeomClient: makeHole not used in 3D Lab tests'))
      }
      return opts.makeHoleImpl(req, mintHandle)
    },
    applyBodyPattern: () => Promise.reject(new Error('fakeGeomClient: applyBodyPattern not used in 3D Lab tests')),
    tessellate: async (_h: BodyHandle, q: TessQuality): Promise<TessBuffers> => {
      // Distinguishable fixtures per tier (different featureId) so a
      // wrong-buffers-landed bug would show up as a wrong faceId prefix, same
      // pattern as progressiveTessellate.test.ts.
      const isCoarse = q.deflection === COARSE_TESS_QUALITY.deflection
      return makeBoxTessBuffers({ featureId: isCoarse ? 'FAKECOARSE' : 'FAKEDISPLAY' })
    },
    resolve: async (_h: BodyHandle, ids: StableId[]) =>
      ids.map((id) => ({ id, status: 'exact' as const, type: 'face' as SubshapeType })),
    measure: async (h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]): Promise<MeasureResult> => {
      measureCalls.push({ handle: h, kind, ids })
      const perHandle = opts.measureResultForHandle?.(h, kind)
      if (perHandle !== undefined) return perHandle
      return opts.measureResult ?? { kind, value: 0 }
    },
    classifyFace: async () => 'plane',
    importStep: async (bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[] }> => {
      importStepCalls.push({ bytes, importId })
      const bodies: ImportedBody[] = (opts.importedBodies ?? []).map((b) => ({
        handle: mintHandle(),
        name: b.name,
        color: b.color,
        elementMap: { featureId: importId, modified: {}, generated: [], deleted: [] },
      }))
      return { bodies, diagnostics: [] }
    },
    // WO-1824 (out of that order's owned-paths, added because GeomClient gained
    // a method and this fake must still satisfy the interface for `tsc -b` to
    // pass): the minimum honest stand-in. It mints the same bodies importStep
    // does and reports an empty content census; no existing test calls it.
    importIges: async (bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[]; content: IgesContent }> => {
      importStepCalls.push({ bytes, importId })
      const bodies: ImportedBody[] = (opts.importedBodies ?? []).map((b) => ({
        handle: mintHandle(),
        name: b.name,
        color: b.color,
        elementMap: { featureId: importId, modified: {}, generated: [], deleted: [] },
      }))
      return { bodies, diagnostics: [], content: { solids: bodies.length, shells: 0, faces: 0, wires: 0, edges: 0 } }
    },
    exportStep: async (): Promise<ArrayBuffer> => {
      exportStepCallCount++
      return new ArrayBuffer(0)
    },
    serializeBody: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    restoreBody: async (_bytes: ArrayBuffer, _map: ElementMapDelta): Promise<BodyHandle> => mintHandle(),
    snapshotsFor: async () => ({}),
    bboxDiagonal: async (): Promise<number> => Math.hypot(40, 20, 10), // demo box's own diagonal -- a reasonable fake default
    terminate: async (): Promise<void> => {},
  }

  return client
}
