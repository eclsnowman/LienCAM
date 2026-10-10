// viewport3d: orchestration class wiring one GeomService client to a bridge
// cache/pick/selection stack (WO UI-2, acceptance #1). Used directly by the
// Node integration test (a createLocalGeomService() client) and, in this WO's
// part 2, by a React component driving createGeomService()'s worker client --
// this module never spawns a worker or imports createGeomService/
// createLocalGeomService itself, so it stays decoupled from that choice and
// is trivially fakeable in tests with a hand-rolled GeomService.

import type {
  BodyHandle,
  BooleanRequest,
  Diag,
  GeomService,
  KernelInfo,
  MeasureResult,
  OpResult,
  StableId,
  Vec3,
} from '../geom/geom-service';
import type { CachedBody } from './GeometryCache';
import { GeometryCache } from './GeometryCache';
import { pickAcrossBodies } from './multiBodyPick';
import { PickEngine } from './PickEngine';
import {
  progressiveTessellate,
  progressiveTessellateAtQuality,
  type TessPaintPhase,
  type TierQualities,
} from './progressiveTessellate';
import { SelectionState } from './SelectionState';
import type { BodyId, PickHit, PickThresholds, RayLike, SelectionFilterMode } from './types';

export interface CreateBoxSpec {
  featureId: string;
  size: Vec3;
}

export interface CreateCutBoxSpec {
  featureId: string;
  size: Vec3;
  toolFeatureId: string;
  toolSize: Vec3;
}

/** One imported body's UI-facing summary (WO INT-1 "Open STEP" flow) -- the
 *  bodyId this session now tracks a handle for, plus whatever name/color the
 *  facade's importStep() resolved from the file's XCAF data (or its
 *  deterministic fallback -- see GEO-2.report.json, never undefined). */
export interface ImportedBodySummary {
  bodyId: BodyId;
  name: string;
  color?: [number, number, number];
}

/** One adopted body's UI-facing summary (WO UI-10, BK-60) -- mirrors
 *  ImportedBodySummary's shape (minus `color`, which adoptBody has no source
 *  for -- see adoptBody's own doc comment) so a caller can drop the result
 *  into the same body-list entry shape the import path already produces. */
export interface AdoptedBodySummary {
  bodyId: BodyId;
  name: string;
}

export class GeomBridgeSession {
  readonly cache = new GeometryCache();
  readonly pickEngine: PickEngine;
  readonly selection = new SelectionState();

  /** bodyId -> the worker-side handle this session is responsible for
   *  disposing. createCutBox tracks only the CUT RESULT under bodyId (see its
   *  doc comment) -- the target/tool handles it also mints are released in
   *  bulk by disposeAllBodies(), not individually. */
  private readonly handles = new Map<BodyId, BodyHandle>();
  private readonly client: GeomService;

  // Model's rendered cache also contains preview replacements, unlike this
  // measurement cache. Read its current presentation lazily at each pick.
  private readonly renderedBodies?: () => readonly CachedBody[];

  constructor(client: GeomService, renderedBodies?: () => readonly CachedBody[]) {
    this.renderedBodies = renderedBodies;
    this.client = client;
    this.pickEngine = new PickEngine(this.cache);
  }

  async init(onProgress?: (pct: number, phase: string) => void): Promise<KernelInfo> {
    return this.client.init(onProgress);
  }

  /** Create a single box body and track its handle under `bodyId`. */
  async createBox(bodyId: BodyId, spec: CreateBoxSpec): Promise<BodyHandle> {
    const result = await this.client.makeBox(spec.featureId, spec.size);
    this.assertOk(result, `createBox("${bodyId}")`);
    this.handles.set(bodyId, result.body as BodyHandle);
    return result.body as BodyHandle;
  }

  /** Demo boolean-cut body: makes a target box, makes a tool box, cuts the
   *  tool from the target, and tracks the CUT RESULT handle under `bodyId`.
   *  The tool body (and the target body, now superseded by the cut result)
   *  are intentionally NOT exposed as separately tracked bodyIds -- they're
   *  an implementation detail of this demo helper, matching the frozen
   *  facade's applyBoolean contract (it does not itself dispose target/tools).
   *  Their worker-side handles are released in bulk by disposeAllBodies();
   *  disposeBody(bodyId) only releases the tracked cut-result handle. */
  async createCutBox(bodyId: BodyId, spec: CreateCutBoxSpec): Promise<BodyHandle> {
    const target = await this.client.makeBox(spec.featureId, spec.size);
    this.assertOk(target, `createCutBox("${bodyId}") target makeBox`);
    const tool = await this.client.makeBox(spec.toolFeatureId, spec.toolSize);
    this.assertOk(tool, `createCutBox("${bodyId}") tool makeBox`);

    const req: BooleanRequest = {
      featureId: `${spec.featureId}:CUT`,
      op: 'cut',
      target: target.body as BodyHandle,
      tools: [tool.body as BodyHandle],
    };
    const cut = await this.client.applyBoolean(req);
    this.assertOk(cut, `createCutBox("${bodyId}") applyBoolean cut`);
    this.handles.set(bodyId, cut.body as BodyHandle);
    return cut.body as BodyHandle;
  }

  /** Coarse-then-display tessellation of the handle tracked under `bodyId`,
   *  ingested into this session's cache. Throws if `bodyId` has no tracked
   *  handle (createBox/createCutBox must run first). */
  async tessellateProgressive(
    bodyId: BodyId,
    onPaint?: (phase: TessPaintPhase, body: CachedBody) => void,
  ): Promise<{ coarse: CachedBody; display: CachedBody }> {
    const handle = this.handles.get(bodyId);
    if (handle === undefined) {
      throw new Error(`GeomBridgeSession: no tracked handle for bodyId "${bodyId}"`);
    }
    return progressiveTessellate(this.client, this.cache, bodyId, handle, onPaint);
  }

  /** Scale-relative progressive tessellation (WO INT-1): caller supplies
   *  qualities (typically `tessQualityForTier(bboxDiagonal, tier)` from the
   *  src/geom facade) instead of relying on this module's fixed-scale
   *  COARSE/DISPLAY constants -- needed for STEP-imported bodies, which can
   *  be any real-world size, unlike the hand-tuned 40mm demo box. */
  async tessellateProgressiveAtQuality(
    bodyId: BodyId,
    qualities: TierQualities,
    onPaint?: (phase: TessPaintPhase, body: CachedBody) => void,
  ): Promise<{ coarse: CachedBody; display: CachedBody }> {
    const handle = this.handles.get(bodyId);
    if (handle === undefined) {
      throw new Error(`GeomBridgeSession: no tracked handle for bodyId "${bodyId}"`);
    }
    return progressiveTessellateAtQuality(this.client, this.cache, bodyId, handle, qualities, onPaint);
  }

  /** Import every body from a STEP file and track each under a fresh bodyId
   *  (`${importId}:body#${index}`, stable within one import call). Returns
   *  the UI-facing summary (name always populated -- see ImportedBody's own
   *  "never undefined" guarantee in GEO-2.report.json) plus the facade's
   *  import diagnostics, unmodified. */
  async importStepFile(
    importId: string,
    bytes: ArrayBuffer,
  ): Promise<{ bodies: ImportedBodySummary[]; diagnostics: Diag[] }> {
    const result = await this.client.importStep(bytes, importId);
    const bodies: ImportedBodySummary[] = result.bodies.map((body, index) => {
      const bodyId = `${importId}:body#${index}`;
      this.handles.set(bodyId, body.handle);
      return { bodyId, name: body.name ?? bodyId, color: body.color };
    });
    return { bodies, diagnostics: result.diagnostics };
  }

  /** Exact measure against the kernel measure API (WO INT-1 acceptance #3)
   *  for the handle tracked under `bodyId`. Throws if `bodyId` has no
   *  tracked handle, same fail-loud convention as tessellateProgressive. */
  async measure(bodyId: BodyId, kind: MeasureResult['kind'], ids?: StableId[]): Promise<MeasureResult> {
    const handle = this.handles.get(bodyId);
    if (handle === undefined) {
      throw new Error(`GeomBridgeSession: no tracked handle for bodyId "${bodyId}"`);
    }
    return this.client.measure(handle, kind, ids);
  }

  /** Register an EXISTING worker-side handle -- e.g. the result body of an
   *  in-place op like defeatureBatch, already minted on the worker -- under
   *  `bodyId`, with the same bookkeeping createBox/createCutBox/
   *  importStepFile give theirs (WO UI-10, BK-60): tessellateProgressive[
   *  AtQuality]/measure/disposeBody/getHandle all work on it afterward
   *  exactly as they do on a created/imported body. Unlike those methods,
   *  this one makes no client call of its own -- `handle` must already be
   *  live on the worker (the caller's op already produced it), so this is a
   *  synchronous bookkeeping step, not an async facade round trip.
   *
   *  `displayName` is NOT stored anywhere by this session -- this class
   *  tracks worker handles, not display names (names/colors are the
   *  caller's own state, e.g. Lab3DView's bodyColorsRef/BodyListPanel
   *  entries, same as they already are for created/imported bodies). It's
   *  threaded straight through onto the returned summary purely so a caller
   *  can build its body-list entry from the return value alone, the same
   *  way importStepFile's ImportedBodySummary lets it, without hand-rolling
   *  that object at the call site. */
  adoptBody(bodyId: BodyId, handle: BodyHandle, displayName: string): AdoptedBodySummary {
    this.handles.set(bodyId, handle);
    return { bodyId, name: displayName };
  }

  /** Read-only lookup of the worker-side handle tracked under `bodyId` --
   *  callers needing a facade-only capability this session doesn't wrap
   *  itself (e.g. GeomClient.bboxDiagonal, used to size progressive-tess
   *  quality tiers) can call the client directly with this handle without
   *  this module importing GeomClient/bboxDiagonal itself (keeps this class
   *  decoupled from the worker-vs-local client choice, per its header). */
  getHandle(bodyId: BodyId): BodyHandle | undefined {
    return this.handles.get(bodyId);
  }

  /** Pick across every cached body in `bodyIds`; nearest hit wins. */
  pick(
    bodyIds: readonly BodyId[],
    ray: RayLike,
    filter: SelectionFilterMode,
    thresholds?: PickThresholds,
  ): PickHit | null {
    return pickAcrossBodies(this.cache, this.pickEngine, bodyIds, ray, filter, thresholds, this.renderedBodies?.());
  }

  /** Evict `bodyId` from the bridge cache and, if this session tracks a
   *  worker-side handle for it, dispose that handle too. Safe to call on an
   *  untracked/unknown bodyId (no-op). */
  async disposeBody(bodyId: BodyId): Promise<void> {
    this.cache.evict(bodyId);
    const handle = this.handles.get(bodyId);
    if (handle !== undefined) {
      await this.client.dispose(handle);
      this.handles.delete(bodyId);
    }
  }

  /** Evict every cached body and release every worker-side body the client
   *  is holding (client.disposeAll(), not just this session's tracked
   *  handles -- so untracked target/tool handles from createCutBox are
   *  released too). */
  async disposeAllBodies(): Promise<void> {
    this.cache.disposeAll();
    await this.client.disposeAll();
    this.handles.clear();
  }

  private assertOk(result: OpResult, context: string): void {
    if (!result.ok || result.body === undefined) {
      throw new Error(`GeomBridgeSession: ${context} failed: ${JSON.stringify(result.diagnostics)}`);
    }
  }
}
