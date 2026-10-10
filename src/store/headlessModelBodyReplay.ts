import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// IMPORT-FANOUT-HEADLESS: materialize a multi-body STEP "One item per body"
// split WITHOUT the Model-workspace round trip.
//
// WHY THIS EXISTS. Choosing "One item per body" at import used to route through
// `wrapImportedGeometryAsModelItem -> openModelItem`, which OPENS the Model
// workspace so SolidsWorkbenchPage's mount can regenerate the N body rows
// (the only producer of `syncModelBodies`' input was the React component's
// fullResync -> scheduler.run(executor) -> syncCamModelBodies). The result was
// correct -- N independent CAM rows -- but the user was briefly yanked to the
// Model tab and back for what should be a pure list operation. THIS module is
// the headless, off-React executor booked as IMPORT-MULTIBODY-HEADLESS-FANOUT:
// it replays the SAME stashed seed archive through a transient GeomClient and
// produces the EXACT `ModelBodySyncInput` the workbench's `syncCamModelBodies`
// would (SolidsWorkbenchPage.tsx), which the store then feeds to the already-
// pure `syncModelBodies` writer. No mount, no tab switch, no flicker.
//
// EQUIVALENCE (why the rows are identical to the round-trip path). A fan-out
// seed built by `buildMultiBodyImportedStepModelArchive` contains ONLY 'import'
// nodes (IMP1..IMPn, no `consumes`/`refs`), so there is nothing to schedule:
// each node is an independent body producer. This replays each node's kernel op
// exactly as the workbench executor's 'import' branch does (importStep -> select
// `bodies[bodyIndex]` -> dispose siblings, SolidsWorkbenchPage.tsx), tessellates
// each live body with the SAME `progressiveTessellate` + `GeometryCache` the
// workbench paint path uses, then gathers live+derived through the SAME shared
// helpers (`bodyFeatureIds`/`liveBodyFeatureIds`/`featureLabel`/
// `projectBodyLineages` in bodyLineage.ts, `modelBodyDisplayFromCached` in
// viewport3d) -- so `reconcileModelBodies` receives byte-equivalent input and
// adopts/appends the identical rows. `headlessImportFanout.equivalence.test`
// pins this against a real workbench mount and goes RED if the two diverge.
//
// FAIL LOUD (ADR-0003). A well-formed fan-out seed always succeeds, but a STEP
// whose cached bytes vanished or changed between import and replay (fewer solids
// than the seed's indices expect) MUST refuse by name rather than silently
// produce a partial/empty split. Any node's replay failure throws
// `HeadlessReplayError`; the store surfaces its named reason in the same
// `brepImportError` channel the import path uses and leaves the combined row
// untouched (the caller runs this BEFORE any store mutation).

import { createGeomService, type GeomClient } from '../geom'
import type { BodyHandle, ImportedBody, Diag } from '../geom/geom-service'
import { loadDocumentArchive, type LoadedDocument } from '../doc/persist'
import { seedRecordingElementMap } from '../doc/documentHolder'
import { applyFeatureDelta } from '../doc/replay'
import { loadCachedStep } from '../lib/stepCache'
import { GeometryCache } from '../viewport3d'
import { progressiveTessellate } from '../viewport3d/progressiveTessellate'
import { modelBodyDisplayFromCached } from '../viewport3d/modelBodyDisplay'
import {
  bodyFeatureIds,
  liveBodyFeatureIds,
  featureLabel,
  projectBodyLineages,
} from '../components/model3d/bodyLineage'
import type { DagNodeSnapshot } from '../doc/dag'
import type { ModelBodySyncInput, DerivedModelBody } from '../lib/cam/modelBodyAdapter'

/** Named, structured refusal (ADR-0003) for a headless replay that could not
 *  materialize every body. Carries the failing node id + the kernel's own
 *  diagnostics so the store can surface the exact reason in `brepImportError`. */
export class HeadlessReplayError extends Error {
  readonly nodeId: string
  readonly reason: string
  readonly diagnostics: Diag[]
  constructor(nodeId: string, reason: string, diagnostics: Diag[] = []) {
    super(reason)
    this.name = 'HeadlessReplayError'
    this.nodeId = nodeId
    this.reason = reason
    this.diagnostics = diagnostics
  }
}

/** Test seam: override the transient GeomClient factory (production uses the
 *  Web-Worker-backed `createGeomService`; Node tests inject
 *  `createLocalGeomService`, which runs the real occt-wasm kernel on the calling
 *  thread -- the same client `importExecutorBodyIndex.intImportEdit.test.ts`
 *  already drives the workbench with). Mirrors documentHolder's storage-injection
 *  precedent: a module `let`, defaulted to production, replaceable for tests. */
let clientFactory: () => GeomClient = createGeomService

/** @internal test-only: point the headless replay at an injected GeomClient. */
export function __setHeadlessReplayClientFactoryForTests(factory: (() => GeomClient) | null): void {
  clientFactory = factory ?? createGeomService
}

function reasonOf(diagnostics: Diag[]): string {
  const err = diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0]
  const params = (err?.params ?? {}) as { reason?: unknown }
  return typeof params.reason === 'string' ? params.reason : operatorText('headlessModelBodyReplay1')
}

/**
 * Replay ONE 'import' node against the kernel and return its selected body
 * handle + element map. Mirrors the workbench executor's 'import' branch
 * (SolidsWorkbenchPage.tsx) verbatim in its selection + fail-loud logic; the
 * ONLY difference is that the world-bookkeeping (ownHandle/publishBody/
 * finalizeBody) is the caller's headless concern, not this pure replay.
 *
 * Throws HeadlessReplayError on any refusal, disposing every minted sibling
 * handle first so nothing leaks.
 */
async function replayImportNode(
  client: GeomClient,
  node: DagNodeSnapshot,
): Promise<{ handle: BodyHandle; elementMap: ImportedBody['elementMap'] }> {
  const fileName = typeof node.payload.fileName === 'string' ? node.payload.fileName : node.id
  const cacheKey = typeof node.payload.cacheKey === 'string' ? node.payload.cacheKey : node.id
  const bytes = await loadCachedStep(cacheKey)
  if (bytes === null) {
    throw new HeadlessReplayError(
      node.id,
      operatorText('headlessModelBodyReplay2', { value1: String(fileName) }),
    )
  }
  const imported = await client.importStep(bytes, node.id)
  const disposeAll = (bodies: readonly ImportedBody[]): Promise<unknown> =>
    Promise.all(bodies.map((b) => client.dispose(b.handle).catch(() => undefined)))

  const fatal = imported.diagnostics.find((d) => d.severity === 'error')
  if (fatal !== undefined) {
    await disposeAll(imported.bodies)
    throw new HeadlessReplayError(node.id, reasonOf(imported.diagnostics), imported.diagnostics)
  }
  if (imported.bodies.length === 0) {
    await disposeAll(imported.bodies)
    throw new HeadlessReplayError(node.id, operatorText('headlessModelBodyReplay3', { value1: String(fileName) }))
  }

  const bodyIndex = typeof node.payload.bodyIndex === 'number' ? node.payload.bodyIndex : undefined
  if (bodyIndex === undefined) {
    // A fan-out seed always carries a bodyIndex per node; a NO-index node on a
    // multi-body file keeps the INT-6A one-body-per-node contract (refuse by
    // name) rather than silently keeping bodies[0].
    if (imported.bodies.length > 1) {
      await disposeAll(imported.bodies)
      throw new HeadlessReplayError(
        node.id,
        operatorText('headlessModelBodyReplay4', { value1: String(fileName), value2: String(imported.bodies.length) }),
      )
    }
    const body = imported.bodies[0]
    return { handle: body.handle, elementMap: body.elementMap }
  }
  if (bodyIndex < 0 || bodyIndex >= imported.bodies.length) {
    await disposeAll(imported.bodies)
    throw new HeadlessReplayError(
      node.id,
      operatorText('headlessModelBodyReplay5', { value1: String(fileName), value2: String(bodyIndex + 1), value3: String(imported.bodies.length) }),
    )
  }
  const selected = imported.bodies[bodyIndex]
  // Dispose every sibling solid this node does NOT own (each sibling import node
  // re-imports the file and keeps only its own index), so nothing leaks.
  await disposeAll(imported.bodies.filter((_, i) => i !== bodyIndex))
  return { handle: selected.handle, elementMap: selected.elementMap }
}

/**
 * Replay a stashed multi-body import seed headlessly and return the exact
 * `ModelBodySyncInput` the workbench's `syncCamModelBodies` would produce for
 * the same document, scoped to `modelItemId`. The store hands the result to
 * `syncModelBodies`, which adopts the pending row as body 1 and appends the
 * remaining solids -- with NO Model-workspace mount.
 *
 * `seed` is the already-decoded document (the value `stashLoadedDocument`
 * returns), so no bytes are decoded twice. A transient GeomClient is spun up,
 * used, and always torn down (finally), even on a fail-loud refusal.
 */
export async function replayImportedBodiesHeadless(
  seed: LoadedDocument,
  modelItemId: string,
): Promise<ModelBodySyncInput> {
  const dag = seed.dag
  // Seed the live map from the document's own deltas exactly as a mount would
  // (seedRecordingElementMap) -- empty for a fresh import seed; each replayed
  // import's elementMap is appended below so a later save persists the lineage.
  const map = seedRecordingElementMap(seed)

  const importNodes = dag
    .nodeIds()
    .map((id) => dag.getNode(id))
    .filter((n): n is DagNodeSnapshot => n !== undefined && n.kind === 'import')

  const client = clientFactory()
  try {
    await client.init()

    const bodyHandles = new Map<string, BodyHandle>()
    for (const node of importNodes) {
      const { handle, elementMap } = await replayImportNode(client, node)
      applyFeatureDelta(map, elementMap)
      bodyHandles.set(node.id, handle)
    }

    // live/derived gathered through the SAME shared helpers the workbench uses,
    // so reconcileModelBodies receives equivalent input (see module header).
    const bodyIds = bodyFeatureIds(dag)
    const liveIds = liveBodyFeatureIds(dag, (id) => bodyHandles.has(id))
    const live = projectBodyLineages(dag, bodyIds, liveIds).map(({ bodyId, lineageId }) => ({
      bodyId,
      lineageId,
      name: featureLabel(dag, lineageId),
    }))

    const cache = new GeometryCache()
    const derived: DerivedModelBody[] = []
    try {
      for (const { bodyId, lineageId } of live) {
        const handle = bodyHandles.get(bodyId)
        if (handle === undefined) {
          // Cannot happen -- live is derived from bodyHandles -- but refuse by
          // name rather than tessellate an undefined handle (ADR-0003).
          throw new HeadlessReplayError(bodyId, operatorText('headlessModelBodyReplay6', { value1: String(bodyId) }))
        }
        // Same fixed COARSE->DISPLAY two-phase pass paintFeatureBody drives, so
        // the CachedBody (and thus version/faceIds/edgeIds/display) matches the
        // workbench's first-regen tessellation.
        await progressiveTessellate(client, cache, bodyId, handle)
        const cached = cache.get(bodyId)
        if (cached === undefined) {
          throw new HeadlessReplayError(bodyId, operatorText('headlessModelBodyReplay7', { value1: String(bodyId) }))
        }
        derived.push({
          bodyId,
          lineageId,
          version: cached.version,
          stableIds: [...cached.faceIds, ...cached.edgeIds],
          display: modelBodyDisplayFromCached(cached),
        })
      }
    } finally {
      cache.disposeAll()
    }

    return { live, derived, modelItemId }
  } finally {
    await client.terminate().catch(() => undefined)
  }
}

/** Convenience for callers holding raw seed bytes rather than a decoded
 *  LoadedDocument (decodes then replays). The store already holds the decoded
 *  seed from `stashLoadedDocument`, so it uses `replayImportedBodiesHeadless`
 *  directly; this exists for standalone/test callers. */
export async function replayImportedBodiesHeadlessFromArchive(
  seedBytes: Uint8Array,
  modelItemId: string,
): Promise<ModelBodySyncInput> {
  return replayImportedBodiesHeadless(loadDocumentArchive(seedBytes), modelItemId)
}
