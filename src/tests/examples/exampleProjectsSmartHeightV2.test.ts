// @vitest-environment jsdom
//
// The three files under `Example Projects/` are test items (ADR-0040): they
// were authored before Smart Height V2 became the only runtime authority
// (2e5678b7), so every operation in them was refused on open. This file does
// two things with the SAME code path:
//
//   normal run      - loads each example through the store and PROVES that
//                     every operation carries valid V2 authority and that its
//                     family's Smart Height preflight resolves a plan. This is
//                     the feature tour's regression armor.
//   REGEN_EXAMPLE_PROJECTS=1
//                   - additionally re-authors every operation with the same
//                     production intent builders the New Operation modal uses
//                     (keeping the machinist's authored depths), sets it back to
//                     'pending', and rewrites the file exactly as
//                     saveProjectToFile would download it.
//
// Regenerate with:  REGEN_EXAMPLE_PROJECTS=1 npx vitest run src/tests/examples
//
// No worker is spawned: 'pending' is what the README promises ("open it and
// click Generate"), and the preflight is the same evidence gate the modal's
// Create button waits on.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'

const REGEN = process.env.REGEN_EXAMPLE_PROJECTS === '1'
const EXAMPLES_DIR = path.resolve(__dirname, '../../../Example Projects')

// In-memory binary caches so a load -> save round trip keeps every embedded
// STL/STEP byte-identical (the real ones live in IndexedDB).
const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
const stepDisplay = new Map<string, CachedStepDisplay>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytes.set(id, buffer) }),
    loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
    removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
    // Real signature (stepCache.ts:108): the caller hands the raw payload, not
    // a prebuilt record - the record is assembled here the same way the real
    // function assembles it, so a round trip through this fixture returns a
    // genuine `CachedStepDisplay` rather than a bare payload wearing its name.
    cacheStepDisplay: vi.fn(async (
      id: string,
      payload: BrepModelPayload,
      sourceSha256: string,
      tessellation: StepDisplayTessellation | null,
    ) => {
      stepDisplay.set(id, {
        displayContractVersion: 1, sourceSha256, tessellation, payload, byteLength: 0, updatedAt: 0,
      })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => stepDisplay.get(id) ?? null),
    removeCachedStepDisplay: vi.fn(async (id: string) => { stepDisplay.delete(id) }),
  })
})

// 3D families preview through the cam3d client; jsdom has no Worker, so the
// real BvhKernel + dispatcher run in-process (the pattern
// modelBodyStockBinding.wo305 and adaptive3dHeightTruth.cam16 use).
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const { Cam3dClient } = await import('../../cam3d/worker/client')
  const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
  let client: InstanceType<typeof Cam3dClient> | null = null
  const make = () => {
    const kernel = new BvhKernel()
    const fakeWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as never) },
      terminate(): void {},
    }
    const dispatcher = new Cam3dDispatcher(kernel, (message: unknown) => {
      fakeWorker.onmessage?.({ data: message } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker as never)
  }
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => (client ??= make()),
    disposeCam3dClient: () => { client = null },
  })
})

// STEP parts tessellate through the browser model worker by default; hand the
// default tessellator the in-process OCCT core instead (the cam3d gate tests'
// pattern), so a STEP-based 3D operation can preview here.
vi.mock('../../cam3d/input/stepTessellatorWorker', async () => {
  const { readFileSync } = await import('node:fs')
  const nodePath = await import('node:path')
  const { loadOcctModel } = await import('../../lib/cam/geometry/occt/model/loader')
  const { makeOcctCoreTessellator } = await import('../../cam3d/input/occtCoreTessellator')
  const wasmPath = nodePath.resolve(__dirname, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')
  let tessellator: import('../../cam3d/input/types').StepTessellator | null = null
  const workerStepTessellator: import('../../cam3d/input/types').StepTessellator = async (bytes, params) => {
    tessellator ??= makeOcctCoreTessellator(await loadOcctModel({ wasmBinary: readFileSync(wasmPath) }))
    return tessellator(bytes, params)
  }
  return typedMock<typeof import('../../cam3d/input/stepTessellatorWorker')>({ workerStepTessellator })
})

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const {
  useCamStore, setupProvenStockId, resolveOpGeometrySources, smartHeightStockBounds,
  gatherUsedTools, gatherUsedToolLibraries, gatherUsedHolders,
} = await import('../../store')
const { collectProjectBinaries } = await import('../../lib/projectBinaries')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const {
  buildAdaptive3dSmartIntent,
  buildChamferSmartHeightIntent,
  buildContourSmartHeightIntent,
  buildDrillBoreAuthoringIntent,
  buildEngraveSmartHeightIntent,
  buildFaceSmartHeightIntent,
  buildParallel3dSmartIntent,
  buildPlanarRoughSmartHeightIntent,
  buildThreadMillSmartHeightIntent,
  deriveChamferEdgeBindings,
  deriveContourFeatureBindings,
  deriveDrillBoreFeatureBindings,
  deriveThreadMillFeatureBindings,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent, setupDefaultHeightIntent, operationSafetyHeightIntent } =
  await import('../../lib/cam/heightIntent')
const { intentReferenceForUiReference } = await import('../../lib/cam/heightReference')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')

import type {
  HeightPlaneName, HeightReference, ImportedGeometry, Operation, Setup,
} from '../../types'

type ChamferUiReference = Parameters<typeof intentReferenceForUiReference>[0]

const EXAMPLE_FILES = fs.readdirSync(EXAMPLES_DIR).filter(name => name.endsWith('.camproject'))

function sourcesFor(op: Operation, geometry: ImportedGeometry[]): ImportedGeometry[] {
  const params = op.params as { geometryId?: string }
  const geoId = params.geometryId ?? '__all__'
  return geoId === '__all__'
    ? resolveOpGeometrySources(geometry, '__all__', op.type)
    : geometry.filter(candidate => candidate.id === geoId)
}

function closedLoopIds(sources: ImportedGeometry[]): string[] {
  return sources.flatMap(source => (source.loops ?? []).filter(loop => loop.closed).map(loop => loop.id))
}

/** Author the V2 envelope for one loaded operation the way the modal would,
 * from the operation's own params and heights. */
interface Authored { smartHeight: Operation['smartHeight']; params?: Record<string, unknown> }

function authorSmartHeight(
  op: Operation, setup: Setup, geometry: ImportedGeometry[], stockId: string | undefined,
): Authored {
  // Safety planes: the Setup's default stack (Clearance off Retract, Retract
  // off the stock top, Feed off Top) - what the app authors for a new op. The
  // old files carried absolute numbers from a different frame; the machinist's
  // DEPTHS below are kept, the safety stack is re-derived.
  const safetyIntent = operationSafetyHeightIntent(setupDefaultHeightIntent(setup), new Set())
  const setupId = setup.id
  const params = op.params as Record<string, unknown>
  const sources = sourcesFor(op, geometry)
  const selectedLoops = Array.isArray(params.loopIds) ? (params.loopIds as string[]) : []
  const geometryIds = sources.map(source => source.id)
  const heights = op.heights
  const uiRef = (fallback: ChamferUiReference): ChamferUiReference =>
    (params.heightReference as ChamferUiReference | undefined) ?? fallback

  switch (op.type) {
    case 'contour_2d': {
      const loopIds = selectedLoops.length > 0 ? selectedLoops : closedLoopIds(sources)
      const derived = deriveContourFeatureBindings(sources, loopIds)
      if (derived.ok && derived.bindings.length > 0) {
        return { smartHeight: {
          kind: 'smart_v2',
          intent: buildContourSmartHeightIntent({
            setupId, safetyIntent, mode: 'selected_feature',
            features: derived.bindings.map(binding => binding.feature),
          }),
        } }
      }
      // A flat 2D profile has no physical floor to detect: keep the depth the
      // machinist authored (the Feature Tour cuts 5 mm, not through 25 mm of
      // stock).
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildContourSmartHeightIntent({
          setupId, safetyIntent, mode: 'explicit_depth', geometryIds,
          explicitTargetWcsMm: heights.bottomHeight,
        }),
      } }
    }
    case 'pocket_2d':
    case 'adaptive_clearing_2d': {
      // No source geometry = the op roughs the setup stock itself (the modal's
      // Stock boundary): V2's stock_rough variant, footprint of the one stock.
      const roughsStock = geometryIds.length === 0 || params.boundarySource === 'stock'
      if (roughsStock) {
        // Stock roughing can only be PROVEN against a STEP/B-rep target; a
        // stock that owns an STL mesh (the Feature Tour) is refused with
        // 'assign a complete STEP/B-rep target or use a manual end condition'.
        // The manual condition is the machinist's authored depth on the
        // bundled 2D profile, so that is the honest re-authoring there.
        const stockOwnsMesh = geometry.some(geo => geo.stockId === stockId && geo.type === 'mesh')
        if (!stockOwnsMesh) {
          return {
            smartHeight: {
              kind: 'smart_v2',
              intent: buildPlanarRoughSmartHeightIntent({
                setupId, operationType: op.type, safetyIntent, mode: 'stock_rough', stockId,
              }),
            },
          }
        }
        const profile = geometry.find(geo => geo.stockId === stockId && geo.type === 'curves_2d'
          && (geo.loops ?? []).some(loop => loop.closed))
        if (!profile) throw new Error(`${op.name}: stock roughing over a mesh needs a 2D profile boundary to re-author against`)
        const outer = [...(profile.loops ?? [])].filter(loop => loop.closed)
          .sort((a, b) => Math.abs(b.area ?? 0) - Math.abs(a.area ?? 0))[0]
        return {
          smartHeight: {
            kind: 'smart_v2',
            intent: buildPlanarRoughSmartHeightIntent({
              setupId, operationType: op.type, safetyIntent, mode: 'explicit_depth',
              geometryIds: [profile.id], explicitTargetWcsMm: heights.bottomHeight,
            }),
          },
          params: { ...params, boundarySource: 'geometry', geometryId: profile.id, loopIds: [outer.id] },
        }
      }
      return {
        smartHeight: {
          kind: 'smart_v2',
          intent: buildPlanarRoughSmartHeightIntent({
            setupId, operationType: op.type, safetyIntent, mode: 'explicit_depth',
            geometryIds, explicitTargetWcsMm: heights.bottomHeight,
          }),
        },
      }
    }
    case 'face':
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildFaceSmartHeightIntent({
          setupId, safetyIntent, mode: 'explicit_depth',
          stockId, explicitTargetWcsMm: heights.bottomHeight,
        }),
      } }
    case 'drill':
    case 'bore': {
      const loopIds = selectedLoops.length > 0 ? selectedLoops : closedLoopIds(sources)
      const detected = deriveDrillBoreFeatureBindings(sources, loopIds, op.type)
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildDrillBoreAuthoringIntent({
          operationType: op.type, setupId, safetyIntent, geometries: sources, selectedLoopIds: loopIds,
          draft: detected.ok
            ? { mode: 'detected_features', explicitStartWcsMm: heights.topHeight, explicitEndWcsMm: heights.bottomHeight }
            : { mode: 'explicit_depth', explicitStartWcsMm: heights.topHeight, explicitEndWcsMm: heights.bottomHeight },
        }),
      } }
    }
    case 'engrave': {
      const includeOpen = params.includeOpen !== false
      const includeClosed = params.includeClosed !== false
      const eligible = sources.flatMap(source => (source.loops ?? [])
        .filter(loop => (loop.closed && includeClosed) || (!loop.closed && includeOpen))
        .map(loop => loop.id))
      const loopIds = selectedLoops.length > 0 ? selectedLoops : eligible
      const depthMm = Math.max(0.1, heights.topHeight - heights.bottomHeight)
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildEngraveSmartHeightIntent({
          setupId, safetyIntent,
          datumReference: intentReferenceForUiReference(uiRef('geometry_face'), 'top') as Exclude<HeightReference, HeightPlaneName>,
          datumOffsetMm: typeof params.planeOffset === 'number' ? params.planeOffset : 0,
          axialOffsetMm: typeof params.axialOffset === 'number' ? params.axialOffset : 0,
          depth: params.useWidthForDepth === true && typeof params.targetLineWidth === 'number'
            ? { kind: 'line_width', targetLineWidthMm: params.targetLineWidth }
            : { kind: 'explicit', depthMm },
          scope: { geometryIds, loopIds, includeOpen, includeClosed },
        }),
      } }
    }
    case 'chamfer': {
      const loopIds = selectedLoops.length > 0 ? selectedLoops : closedLoopIds(sources)
      const derived = deriveChamferEdgeBindings(sources, loopIds)
      if (!derived.ok) throw new Error(derived.refusals.map(refusal => refusal.message).join(' '))
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildChamferSmartHeightIntent({
          setupId, safetyIntent,
          datumReference: intentReferenceForUiReference(uiRef('geometry_face'), 'top') as Exclude<HeightReference, HeightPlaneName>,
          datumOffsetMm: typeof params.planeOffset === 'number' ? params.planeOffset : 0,
          chamferWidthMm: params.chamferWidth as number,
          tipOffsetMm: (params.tipOffset as number | undefined) ?? 0,
          features: derived.bindings.map(binding => ({
            loopId: binding.loopId,
            feature: { ...binding.feature },
            fingerprint: binding.evidenceFingerprint,
          })),
        }),
      } }
    }
    case 'thread_mill': {
      const loopIds = selectedLoops.length > 0 ? selectedLoops : closedLoopIds(sources)
      const threadKind = params.threadKind === 'external' ? 'external' : 'internal'
      const externalReference = params.externalReference === 'base' ? 'base' : 'top'
      const detected = params.geometrySource === 'cylinder'
        ? deriveThreadMillFeatureBindings(sources, loopIds)
        : null
      const datumPlane: HeightPlaneName =
        threadKind === 'external' && externalReference === 'base' ? 'bottom' : 'top'
      const useDetected = detected?.ok === true && detected.bindings.length > 0
      const scopedGeometryIds = sources
        .filter(source => (source.loops ?? []).some(loop => loopIds.includes(loop.id)))
        .map(source => source.id)
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildThreadMillSmartHeightIntent({
          setupId, safetyIntent,
          source: useDetected ? 'detected_feature' : 'explicit_band',
          threadKind, externalReference,
          threadDepthMm: (params.threadDepth as number | undefined) ?? 0,
          planeOffsetMm: (params.planeOffset as number | undefined) ?? 0,
          datumReference: useDetected
            ? undefined
            : intentReferenceForUiReference(uiRef('geometry_face'), datumPlane) as Exclude<HeightReference, HeightPlaneName>,
          features: useDetected
            ? detected!.bindings.map(binding => ({
                loopId: binding.loopId, featureKind: binding.featureKind, feature: { ...binding.feature },
                topMachineMm: binding.topMm, floorMachineMm: binding.floorMm, fingerprint: binding.evidenceFingerprint,
              }))
            : undefined,
          geometryIds: useDetected ? undefined : (scopedGeometryIds.length > 0 ? scopedGeometryIds : geometryIds),
        }),
      } }
    }
    // The 3D families rebind DEFAULT-provenance safety planes to the target
    // model's own Material Start (a part can stand above the stock top), so
    // they get the untouched default intent, as the modal does for a new op.
    case 'parallel_3d':
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildParallel3dSmartIntent({ setupId, safetyIntent: defaultHeightIntent('parallel_3d'), geometryIds: op.geometrySelections }),
      } }
    case 'adaptive_3d':
      return { smartHeight: {
        kind: 'smart_v2',
        intent: buildAdaptive3dSmartIntent({ setupId, safetyIntent: defaultHeightIntent('adaptive_3d'), geometryIds: op.geometrySelections }),
      } }
    default:
      throw new Error(`${op.type} has no Smart Height V2 authoring path in this build.`)
  }
}

/** The exact snapshot saveProjectToFile writes, minus the model-document
 * flush: the source file's `document` / `modelItemDocuments` ride through
 * verbatim. Used only when the store's own save refuses because a Model Item
 * in the SOURCE file has no trustworthy checkpoint (that refusal is the
 * product's, and it predates this regeneration). */
async function serializeLikeSave(sourceFile: { document?: unknown; modelItemDocuments?: unknown }): Promise<string> {
  const { project, toolLibrary, toolLibraries, holders } = useCamStore.getState()
  const usedTools = gatherUsedTools(project, toolLibrary)
  const binaries = await collectProjectBinaries(project.geometry)
  const { document: _d, modelItemDocuments: _m, ...projectWithoutDocument } = project
  const snapshot = {
    ...projectWithoutDocument,
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    toolLibrary: usedTools,
    toolLibraries: gatherUsedToolLibraries(usedTools, toolLibraries),
    holders: gatherUsedHolders(usedTools, holders),
    ...(binaries ? { binaries } : {}),
    ...(typeof sourceFile.document === 'string' ? { document: sourceFile.document } : {}),
    ...(sourceFile.modelItemDocuments ? { modelItemDocuments: sourceFile.modelItemDocuments } : {}),
  }
  return JSON.stringify(snapshot, null, 2)
}

/** Capture what saveProjectToFile would hand the browser to download. */
async function captureSavedProjectText(): Promise<string> {
  let captured: Blob | null = null
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { captured = blob; return 'blob:captured' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    await useCamStore.getState().saveProjectToFile()
  } finally {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    clickSpy.mockRestore()
  }
  if (!captured) {
    const notice = useCamStore.getState().sketchNotice
    throw new Error(`saveProjectToFile produced no file (it refused): ${notice ?? '(no footer notice)'}`)
  }
  return await (captured as Blob).text()
}

beforeEach(() => {
  stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('Example Projects carry Smart Height V2 authority', () => {
  it.each(EXAMPLE_FILES)('%s: every operation is V2-authored and its preflight resolves', async (fileName) => {
    const filePath = path.join(EXAMPLES_DIR, fileName)
    await useCamStore.getState().loadProjectFromFile(fs.readFileSync(filePath, 'utf8'))
    const state = useCamStore.getState()
    const project = state.project
    expect(project.setups.length).toBeGreaterThan(0)

    if (REGEN) {
      // Binding a Setup to its stock is part of authoring under V2: every
      // family proves its material against the Setup's ONE stock. A setup
      // saved before that (no wcs.stockId) is bound here to the stock its
      // operations already target - the app's own auto stock when in doubt -
      // and any geometry it machines is owned by that stock. This is the
      // choice the Setup dialog would default to; the README records it.
      const stocks = project.stocks ?? []
      const setupsBound = project.setups.map(setup => {
        if (setupProvenStockId(setup, project)) return setup
        const targetIds = setup.operations.flatMap(op => [
          ...(op.geometrySelections ?? []),
          ...((op.params as { geometryId?: string }).geometryId ? [(op.params as { geometryId: string }).geometryId] : []),
        ])
        const owned = [...new Set(targetIds
          .map(id => project.geometry.find(geo => geo.id === id)?.stockId)
          .filter((id): id is string => typeof id === 'string' && stocks.some(stock => stock.id === id)))]
        const candidates = owned.length > 0 ? owned : stocks.map(stock => stock.id)
        // The stock whose corner grid comes closest to the saved origin is the
        // one the machinist authored the frame on (the Feature Tour's manual
        // origin sits exactly on its explicit stock's top-face centre).
        let chosen: string | undefined
        let bestDistance = Number.POSITIVE_INFINITY
        for (const candidate of candidates) {
          const box = smartHeightStockBounds(project, candidate)
          if (!box) continue
          for (const face of ['top', 'bottom'] as const) for (let row = 0; row <= 2; row++) for (let col = 0; col <= 2; col++) {
            const x = box.min.x + (col / 2) * (box.max.x - box.min.x)
            const y = box.min.y + (1 - row / 2) * (box.max.y - box.min.y)
            const z = face === 'top' ? box.max.z : box.min.z
            const d = Math.hypot(x - setup.wcs.origin.x, y - setup.wcs.origin.y, z - setup.wcs.origin.z)
            if (d < bestDistance) { bestDistance = d; chosen = candidate }
          }
        }
        chosen ??= candidates[0]
        if (!chosen) throw new Error(`${fileName}: setup ${setup.name} has no stock to bind to`)
        return { ...setup, wcs: { ...setup.wcs, stockId: chosen, originBinding: undefined } }
      })
      const boundStockIds = new Set(setupsBound.map(setup => setup.wcs.stockId).filter(Boolean) as string[])
      const geometry = project.geometry.map(geo => {
        if (geo.stockId && boundStockIds.has(geo.stockId)) return geo
        // Re-own machined geometry onto the one stock its setup is bound to.
        const owner = setupsBound.find(setup => setup.operations.some(op =>
          (op.geometrySelections ?? []).includes(geo.id)
          || (op.params as { geometryId?: string }).geometryId === geo.id))
        return owner?.wcs.stockId ? { ...geo, stockId: owner.wcs.stockId } : geo
      })
      useCamStore.setState(current => ({ project: { ...current.project, setups: setupsBound, geometry } }))
      // A manual origin cannot prove a stock (wcsBoundStockId); pin each
      // re-bound setup to the stock corner nearest its saved origin and snap
      // the origin onto that corner, the invariant applyStockToSetups keeps.
      const rebound = useCamStore.getState().project
      const pinned = rebound.setups.map(setup => {
        if (setup.wcs.originBinding !== undefined || !setup.wcs.stockId) return setup
        const box = smartHeightStockBounds(rebound, setup.wcs.stockId)
        if (!box) throw new Error(`${fileName}: setup ${setup.name} stock ${setup.wcs.stockId} has no provable bounds`)
        let best: { row: number; col: number; face: 'top' | 'bottom'; origin: { x: number; y: number; z: number }; d: number } | null = null
        for (const face of ['top', 'bottom'] as const) for (let row = 0; row <= 2; row++) for (let col = 0; col <= 2; col++) {
          const origin = {
            x: box.min.x + (col / 2) * (box.max.x - box.min.x),
            y: box.min.y + (1 - row / 2) * (box.max.y - box.min.y),
            z: face === 'top' ? box.max.z : box.min.z,
          }
          const d = Math.hypot(origin.x - setup.wcs.origin.x, origin.y - setup.wcs.origin.y, origin.z - setup.wcs.origin.z)
          if (!best || d < best.d) best = { row, col, face, origin, d }
        }
        return {
          ...setup,
          wcs: {
            ...setup.wcs,
            origin: best!.origin,
            originBinding: { kind: 'stock_corner' as const, stockId: setup.wcs.stockId, cornerRow: best!.row, cornerCol: best!.col, cornerFace: best!.face },
          },
        }
      })
      useCamStore.setState(current => ({ project: { ...current.project, setups: pinned } }))
      const bound = useCamStore.getState().project
      const setups = bound.setups.map(setup => {
        const stockId = setupProvenStockId(setup, bound)
        return {
          ...setup,
          operations: setup.operations.map(op => ({
            ...op,
            ...(() => { const a = authorSmartHeight(op, setup, bound.geometry, stockId); return { smartHeight: a.smartHeight, params: a.params ?? op.params } })(),
            status: 'pending' as const,
            errorMessage: undefined,
            toolpathMoves: undefined,
            computeTimeMs: undefined,
            estimatedCutTimeMs: undefined,
            estimatedCutTimeMsError: undefined,
            resolvedHeights: undefined,
            resolvedHeightPlan: undefined,
            generationFingerprint: undefined,
            progress: undefined,
            progressPhase: undefined,
          })),
        }
      })
      useCamStore.setState(current => ({ project: { ...current.project, setups } }))
    }

    const failures: string[] = []
    for (const setup of useCamStore.getState().project.setups) {
      for (const op of setup.operations) {
        const validated = validatePersistedSmartHeightState(op.smartHeight)
        if (!validated.ok) { failures.push(`${op.name} (${op.type}): ${validated.message}`); continue }
        try {
          const plan = await useCamStore.getState().previewOperationSmartHeightPlan(setup.id, op)
          expect(plan.version).toBe(2)
        } catch (error) {
          failures.push(`${op.name} (${op.type}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([])

    if (REGEN) {
      let text: string
      try {
        text = await captureSavedProjectText()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/no trustworthy document checkpoint/.test(message)) throw error
        console.log(`${fileName}: store save refused (${message}); writing the same snapshot with the source documents carried verbatim`)
        const sourceFile = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { document?: unknown; modelItemDocuments?: unknown }
        text = await serializeLikeSave(sourceFile)
      }
      // The cached STEP display tessellation is an optional cache the app
      // rebuilds on open; keep the source file's copy where the STEP bytes are
      // unchanged so the first open of an example stays fast.
      const source = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        binaries?: Record<string, { step?: string; stepDisplay?: unknown }>
      }
      const written = JSON.parse(text) as { binaries?: Record<string, { step?: string; stepDisplay?: unknown }> }
      for (const [id, entry] of Object.entries(written.binaries ?? {})) {
        const before = source.binaries?.[id]
        if (before?.stepDisplay && before.step && before.step === entry.step && !entry.stepDisplay) {
          entry.stepDisplay = before.stepDisplay
        }
      }
      fs.writeFileSync(filePath, JSON.stringify(written, null, 2), 'utf8')
    }
  }, 300_000)
})
