// Project-document migration chain (ADR-0027).
//
// The concrete first instance of the document-agnostic engine
// (schemaMigration.ts), applied to the portable `.camproject` Project document.
// A project with no `schemaVersion` field is version 0 (predates the stamp); the
// single v0->v1 step backfills the scene-stock defaults and the coordinate-
// hierarchy fields (wrapping the existing, pure/idempotent
// migrateProjectToHierarchy), so file-load and persist-rehydrate share ONE path.
// Behavior at v1 is byte-identical to today's inline load handling.

import type { Project, SceneStock, ToolpathMove } from '../../types'
import { estimateRuntimeMsOrError } from '../../lib/cam/runtime'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { machineCutTimeMotion } from '../../lib/simulation/machineCutTimeMotion'
import { migrateProjectToHierarchy } from '../migrateHierarchy'
import { resolveChamferCorner } from '../../lib/sketch/tools/theoreticalCorner'
import { normalizeToolCutHand } from '../../lib/tool/cutHand'
import { defaultHeightIntent, legacyHeightIntentForOperation } from '../../lib/cam/heightIntent'
import { CREATE_NEST_TEST_DEFAULTS } from '../../lib/cam/nesting/createNestDefaults'
import {
  type Migration,
  runMigrationChain,
} from './schemaMigration'

/** The schema version this build of the app produces and supports up to. */
export const CURRENT_PROJECT_SCHEMA_VERSION = 19

/** True when project-owned CAM state proves that a Model Item had authored
 * content, even if its modeling archive/checkpoint is now missing. A model
 * body row is the post-Finish projection of that document; pendingModelItemId
 * is the pre-adoption projection of an imported STEP/STL wrapper. Neither may
 * ever be reinterpreted as an intentionally blank genesis document. */
export function hasModelItemAuthoredEvidence(p: any, itemId: string): boolean {
  const geometry: any[] = Array.isArray(p?.geometry) ? p.geometry : []
  return geometry.some((row: any) => {
    if (row?.pendingModelItemId === itemId) return true
    if (row?.format !== 'model' || row?.modelBody == null) return false
    const owner = typeof row.modelItemId === 'string'
      ? row.modelItemId
      : MIGRATION_LEGACY_MODEL_ITEM_ID
    return owner === itemId
  })
}

/** v14 -> v15: old live/browser projects did not say whether a missing archive
 * meant "intentionally empty" or "authored bytes were lost on reload". Preserve
 * that ambiguity as unknown so entry fails safe. File Open resolves unknown
 * from the file's embedded archive fields before installing the project.
 *
 * Run unconditionally at every load boundary as well as in the v14 -> v15
 * step. This heals browser blobs briefly poisoned by the first v15 build,
 * which could stamp an authored item `empty` after skipping nested migration:
 * archive/body/import evidence always outranks that unsafe marker. */
export function migrateModelItemDocumentManifest(p: any): any {
  if (!Array.isArray(p?.modelItems)) return p
  return {
    ...p,
    modelItems: p.modelItems.map((item: any) => {
      const hasArchive = item?.id === MIGRATION_LEGACY_MODEL_ITEM_ID
        ? typeof p.document === 'string'
        : typeof p.modelItemDocuments?.[item?.id] === 'string'
      if (hasArchive || hasModelItemAuthoredEvidence(p, item?.id)) {
        return {
          ...item,
          documentState: 'authored',
        }
      }
      if (
        item?.documentState === 'empty' ||
        item?.documentState === 'authored' ||
        item?.documentState === 'unknown'
      ) return item
      return {
        ...item,
        documentState: 'unknown',
      }
    }),
  }
}

/** The default named tool library every tool belongs to absent an explicit one.
 *  Replicated here verbatim — NOT imported — so these migration functions stay
 *  free of store-internal imports (avoiding a circular dependency). */
export const DEFAULT_TOOL_LIBRARY_ID = 'lib-default'
export const MIGRATION_DEFAULT_TOOL_LIBRARY = { id: DEFAULT_TOOL_LIBRARY_ID, name: 'My Tools' }

/** v10 -> v11: preserve every legacy height value while attaching its authored
 * Reference + Offset meaning. Legacy values become user-owned because old files
 * cannot prove whether a value was untouched default or deliberate input. */
export function migrateHeightIntentSemantics(p: any): any {
  let changed = false
  const setups = Array.isArray(p?.setups) ? p.setups.map((setup: any) => {
    const operations = Array.isArray(setup?.operations) ? setup.operations.map((op: any) => {
      if (!op?.heights || op.heights.heightIntent?.version === 1) return op
      changed = true
      return {
        ...op,
        ...(op.status === 'ready' ? {
          status: 'outdated',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          estimatedCutTimeMs: undefined,
          estimatedCutTimeMsError: undefined,
          generationFingerprint: undefined,
          errorMessage: 'Legacy toolpath inputs require regeneration under the truthful height contract.',
        } : {}),
        heights: {
          ...op.heights,
          heightIntent: legacyHeightIntentForOperation(op),
        },
      }
    }) : setup?.operations
    return operations === setup?.operations ? setup : { ...setup, operations }
  }) : p?.setups
  return changed ? { ...p, setups } : p
}

/** v15 -> v16: materialize setup defaults while preserving every legacy
 * operation as an override. Old authored operation values must never begin
 * following a new setup-wide value merely because the project was opened. */
export function migrateSetupDefaultHeights(p: any): any {
  if (!Array.isArray(p?.setups)) return p
  return {
    ...p,
    setups: p.setups.map((setup: any) => ({
      ...setup,
      defaultHeightIntent:
        setup?.defaultHeightIntent?.version === 1
          ? setup.defaultHeightIntent
          : defaultHeightIntent(),
      operations: setup?.operations,
    })),
  }
}

/**
 * v16 -> v17: claim the persisted Adaptive Clearing semantics authored by the
 * current app: minimum helix radius, integral wall-follow budget, and the
 * physical milling direction represented by the legacy-backed `climb` bit.
 *
 * The transform is intentionally an identity. Genuine v16 documents need no
 * backfill, while a v17 stamp makes older builds fail loud instead of silently
 * ignoring these fields or interpreting their persisted values with obsolete
 * semantics.
 */
export function migrateAdaptiveClearingAuthoredSemantics(p: any): any {
  return p
}

/**
 * v17 -> v18: make persisted open-contour entry intent match the behavior
 * every pre-v18 engine path actually produced. Open contours always entered
 * with a straight outside-stock plunge, even when an older document retained
 * a ramp entry selection, so claiming plunge here preserves the machined
 * motion while removing the false authored intent.
 *
 * PURE + copy-on-write: unaffected projects, setups, and operations retain
 * reference identity. An affected operation preserves every field and clones
 * only `linking` to replace `entryType`. Missing or malformed containers are
 * tolerated at this raw-document boundary instead of throwing.
 */
export function migrateOpenContourEntryTruth(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.setups)) return p

  let projectChanged = false
  const setups = p.setups.map((setup: any) => {
    if (setup == null || typeof setup !== 'object' || !Array.isArray(setup.operations)) {
      return setup
    }

    let setupChanged = false
    const operations = setup.operations.map((operation: any) => {
      if (
        operation == null ||
        typeof operation !== 'object' ||
        Array.isArray(operation) ||
        operation.type !== 'contour_2d' ||
        operation.params == null ||
        typeof operation.params !== 'object' ||
        Array.isArray(operation.params) ||
        operation.params.pathType !== 'open'
      ) {
        return operation
      }

      const linking =
        operation.linking != null &&
        typeof operation.linking === 'object' &&
        !Array.isArray(operation.linking)
          ? operation.linking
          : undefined
      if (linking?.entryType === 'plunge') return operation

      setupChanged = true
      return {
        ...operation,
        linking: {
          ...(linking ?? {}),
          entryType: 'plunge',
        },
      }
    })

    if (!setupChanged) return setup
    projectChanged = true
    return { ...setup, operations }
  })

  return projectChanged ? { ...p, setups } : p
}

/** v18 -> v19: retained as a schema-chain identity step. Smart Height V2 is
 * intentionally not synthesized from legacy scalar fields. Old operations
 * remain loadable and are refused individually until the user re-authors them. */
export function migrateSmartHeightAuthority(p: any): any {
  return p
}

/** Local replica of the store's `defaultSceneStock` (src/store/index.ts).
 *  Replicated here verbatim — NOT imported — so these migration functions stay
 *  free of store-internal imports (avoiding a circular dependency). The store's
 *  `defaultSceneStock` is exported, and projectMigration.test.ts asserts this
 *  replica `.toEqual` it, so the two can never silently drift. */
export const MIGRATION_DEFAULT_SCENE_STOCK: SceneStock = {
  mode: 'auto',
  autoOffsetXY: 5,
  autoOffsetZTop: 5,
  autoOffsetZBottom: 0,
  fixedWidth: 100,
  fixedHeight: 100,
  fixedDepth: 50,
  fixedStocks: [],
}

/**
 * Backfill the scene-stock defaults on a project. PURE — never mutates the
 * input. Replicates the exact inline load-path defaults from
 * loadProjectFromFile (src/store/index.ts:1758-1759):
 *   - sceneStock absent -> defaultSceneStock
 *   - sceneStock.fixedStocks absent -> []
 */
export function applySceneStockDefaults(p: Project): Project {
  const sceneStock: SceneStock = p.sceneStock ?? MIGRATION_DEFAULT_SCENE_STOCK
  const withFixed: SceneStock = sceneStock.fixedStocks
    ? sceneStock
    : { ...sceneStock, fixedStocks: [] }
  return { ...p, sceneStock: withFixed }
}

/**
 * Convert a single tool's legacy `tipAngle` into the canonical
 * `angleFromAxisDeg` (the half-angle from the tool axis). PURE — clones the
 * tool, never mutates the input. IDEMPOTENT — a tool already on the canonical
 * field (or with no angle at all) is returned byte-identical.
 *
 * Old stored `tipAngle` is MIXED:
 *  - imported / hand-entered angled tools stored the FROM-AXIS half-angle
 *    (real data: 22.5, 41, 45 — all physically < 90),
 *  - the old editor default and some drills stored the FULL INCLUDED point
 *    angle (118, etc. — always >= 90).
 * Physical from-axis angles are always < 90; included drill-point angles are
 * >= 90, so we can disambiguate by magnitude:
 *   angleFromAxisDeg = tipAngle >= 90 ? tipAngle / 2 : tipAngle
 * (e.g. a 90-included 45-deg chamfer's tipAngle=45 -> 45; a 118 drill -> 59).
 * The old `tipAngle` key is then dropped.
 */
function migrateToolAngle(tool: any): any {
  if (tool == null || typeof tool !== 'object') return tool
  const tipAngle = tool.tipAngle
  // Already canonical (or never had a legacy angle): leave byte-identical.
  if (typeof tipAngle !== 'number') return tool
  if (typeof tool.angleFromAxisDeg === 'number') {
    // Canonical field already present — drop the stale legacy key, keep the rest.
    const { tipAngle: _drop, ...rest } = tool
    return rest
  }
  const { tipAngle: _drop, ...rest } = tool
  return {
    ...rest,
    angleFromAxisDeg: tipAngle >= 90 ? tipAngle / 2 : tipAngle,
  }
}

/**
 * Upgrade every tool in `tools` from the legacy `tipAngle` field to the
 * canonical `angleFromAxisDeg`. PURE + IDEMPOTENT (see migrateToolAngle). The
 * SHARED helper for both the project-document chain and the persisted root
 * tool-library rehydration (src/store/index.ts), so the conversion lives in one
 * place. Returns a new array; tools needing no change are reused by reference.
 */
export function migrateToolLibraryAngles<T>(tools: T[] | undefined): T[] {
  if (!Array.isArray(tools)) return tools as unknown as T[]
  return tools.map((t) => migrateToolAngle(t))
}

/** Backfill/normalize cutter hand on a serialized tool library. Pure + idempotent. */
export function migrateToolLibraryCutHands<T>(tools: T[] | undefined): T[] {
  if (!Array.isArray(tools)) return tools as unknown as T[]
  return tools.map((tool) => {
    if (tool == null || typeof tool !== 'object') return tool
    const normalized = normalizeToolCutHand((tool as { cutHand?: unknown }).cutHand)
    return (tool as { cutHand?: unknown }).cutHand === normalized
      ? tool
      : { ...tool, cutHand: normalized }
  })
}

/** Apply cutter-hand normalization to the project-embedded tool snapshot. */
export function migrateProjectToolCutHands(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.toolLibrary)) return p
  return { ...p, toolLibrary: migrateToolLibraryCutHands(p.toolLibrary) }
}

/**
 * Project migration step: convert the project's `toolLibrary` tools' legacy
 * `tipAngle` to canonical `angleFromAxisDeg`. PURE — clones the project. */
export function migrateToolAngleFromAxis(p: any): any {
  if (p == null || typeof p !== 'object') return p
  if (!Array.isArray(p.toolLibrary)) return p
  return { ...p, toolLibrary: migrateToolLibraryAngles(p.toolLibrary) }
}

/**
 * Project migration step: introduce named tool LIBRARIES and HOLDERS as
 * first-class project state. PURE — clones the project. IDEMPOTENT + fail-safe:
 *  - if toolLibraries is missing/empty, seed it with the default library,
 *  - give every toolLibrary tool a libraryId (default lib) when it lacks one,
 *  - if holders is missing, set it to [].
 * A project already carrying these fields is returned byte-stable (the default
 * library is not re-appended, tools with a libraryId are reused by reference).
 */
export function migrateToolLibrariesAndHolders(p: any): any {
  if (p == null || typeof p !== 'object') return p
  const toolLibraries =
    Array.isArray(p.toolLibraries) && p.toolLibraries.length > 0
      ? p.toolLibraries
      : [{ ...MIGRATION_DEFAULT_TOOL_LIBRARY }]
  const toolLibrary = Array.isArray(p.toolLibrary)
    ? p.toolLibrary.map((t: any) =>
        t != null && typeof t === 'object' && typeof t.libraryId !== 'string'
          ? { ...t, libraryId: DEFAULT_TOOL_LIBRARY_ID }
          : t,
      )
    : p.toolLibrary
  const holders = Array.isArray(p.holders) ? p.holders : []
  return { ...p, toolLibraries, toolLibrary, holders }
}

/**
 * Project migration step: introduce embedded STL/STEP binary payloads
 * (Project.binaries) that make a .camproject self-contained (ADR-0027 schema v4).
 * PURE no-op on existing in-memory documents: `binaries` is OPTIONAL and is
 * populated at SAVE time by collectProjectBinaries (src/lib/projectBinaries.ts),
 * never backfilled from a loaded document (a pre-v4 file simply has no binaries and
 * keeps reading mesh/brep bytes from IndexedDB). The step's role is to claim version
 * 4 so the chain is complete and the next format change appends cleanly at 5; it
 * also lets a v4 file fail loud on an older build (UnknownSchemaVersionError). */
export function migrateEmbedGeometryBinaries(p: any): any {
  // Intentionally byte-stable: nothing to backfill. A loaded pre-v4 document has no
  // embedded binaries and must not gain an (empty) one — collectProjectBinaries is
  // the sole producer, at save time. Returned unchanged.
  return p
}

/**
 * Project migration step: claim schema v5 for CAM MODEL-REFERENCE semantics
 * (WO CAM-1). CAM-1 added two PERSISTED, semantically-loaded shapes to an
 * Operation: the optional `modelReferences` array (a CAM op's dependency on
 * B-rep subshapes) and the widened `status` member `'degraded'` (the referenced
 * geometry is GONE — the op keeps its last-known toolpath, renders RED, and
 * BLOCKS posting). Both are additive at the JSON level, so an older build would
 * still parse a file carrying them at schemaVersion 4 — and then IGNORE the
 * dependency: it renders 'degraded' as an unknown/benign status, drops the
 * modelReferences, and would happily recompute/post without honoring the B-rep
 * link (WO CAM-1-R1 finding 3). Bumping the stamp to 5 forces that older build
 * through ADR-0027's newer-file refusal (UnknownSchemaVersionError) instead of a
 * silent semantic downgrade.
 *
 * The step itself is a pure NO-OP transform: a genuine pre-v5 file predates
 * CAM-1, so it carries no modelReferences and no degraded op to backfill — there
 * is nothing to add. Its ONLY role is to advance the version so old apps fail
 * loud (mirrors migrateEmbedGeometryBinaries). Returned byte-stable.
 */
export function migrateCamModelReferenceSemantics(p: any): any {
  return p
}

/**
 * Project migration step: claim schema v6 for the persisted `arcLength`
 * SketchDimension kind (WO UI-50B). The shape is additive at the JSON level,
 * so an older v5 build could otherwise parse the file and then mishandle or
 * silently omit the unknown dimension. The transform is intentionally an
 * identity: genuine v5 documents predate arcLength and need no backfill.
 */
export function migrateArcLengthDimensionSemantics(p: any): any {
  return p
}

/**
 * Pocket 2D outside-in clearing now enters on the scheduled outer profile.
 * The old helical entry is not compatible with that strategy, so migrate both
 * the explicit legacy combination and the omitted fill strategy (whose
 * historical runtime default is outside-in) to Profile Ramp.
 *
 * This transform was originally designed as v5->v6. Schema v6 is already an
 * immutable arc-length-dimension claim on current main, so the same conversion
 * is appended at v9->v10 instead of rewriting released migration history.
 * PURE + IDEMPOTENT: unrelated setups and operations retain their references.
 */
export function migratePocketOutsideInHelixEntry(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.setups)) return p

  let projectChanged = false
  const setups = p.setups.map((setup: any) => {
    if (setup == null || typeof setup !== 'object' || !Array.isArray(setup.operations)) {
      return setup
    }

    let setupChanged = false
    const operations = setup.operations.map((operation: any) => {
      const fillStrategy = operation?.params?.fillStrategy
      const shouldMigrate = operation?.type === 'pocket_2d'
        && (fillStrategy === undefined || fillStrategy === 'outside_in')
        && operation?.linking?.entryType === 'ramp_helical'
      if (!shouldMigrate) return operation

      setupChanged = true
      projectChanged = true
      return {
        ...operation,
        linking: {
          ...operation.linking,
          entryType: 'ramp_linear',
        },
      }
    })

    return setupChanged ? { ...setup, operations } : setup
  })

  return projectChanged ? { ...p, setups } : p
}

/** Named refusal installed when a pre-v7 cut-time claim cannot be safely
 *  rebuilt from the data carried by the loaded project. */
export const RUNTIME_ESTIMATE_RECOMPUTE_REQUIRED =
  'Cut time unavailable: this estimate was saved by an older version and must be recomputed.'

function hasFiniteMoveGeometry(moves: unknown[]): moves is ToolpathMove[] {
  return moves.every((move) => {
    if (move == null || typeof move !== 'object') return false
    const m = move as Partial<ToolpathMove>
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.z)) return false
    if ((m.type === 'arc_cw' || m.type === 'arc_ccw') &&
        (!Number.isFinite(m.cx) || !Number.isFinite(m.cy))) return false
    return true
  })
}

/**
 * Project migration step: retire cut-time numbers created before SIM-7 made a
 * feedless cutting move refuse by name. Both `.camproject` open and persisted
 * state rehydrate already enter through migrateProjectData, so the versioned
 * transform is the single truth path and CAM-12's load census can remain the
 * sole read-side lifecycle reconciliation after the two branches merge.
 *
 * Every pre-v7 numeric/non-undefined claim is cleared first. When the loaded
 * project carries finite move geometry and the rates needed to time its move
 * roles, the estimate is rebuilt through estimateRuntimeMsOrError. A feedless
 * cut therefore receives that helper's specific refusal. Missing moves, a bad
 * machine rapid, a missing tool for role-resolved moves, or malformed geometry
 * retain the named recompute-required refusal instead of guessing a number.
 * PURE: the input project, setups, operations, and moves are never mutated.
 */
export function migrateRuntimeEstimateTruth(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.setups)) return p

  const rapidRate = p.machine?.rapidRate
  const tools = Array.isArray(p.toolLibrary) ? p.toolLibrary : []
  let projectChanged = false

  const setups = p.setups.map((setup: any) => {
    if (setup == null || typeof setup !== 'object' || !Array.isArray(setup.operations)) return setup
    let setupChanged = false
    const operations = setup.operations.map((op: any) => {
      if (op == null || typeof op !== 'object' || op.estimatedCutTimeMs === undefined) return op

      setupChanged = true
      projectChanged = true
      const { estimatedCutTimeMs: _stale, ...withoutStaleEstimate } = op
      const refused = {
        ...withoutStaleEstimate,
        estimatedCutTimeMsError: RUNTIME_ESTIMATE_RECOMPUTE_REQUIRED,
      }
      const moves: unknown = op.toolpathMoves
      if (!Array.isArray(moves) || moves.length === 0 || !hasFiniteMoveGeometry(moves) ||
          !Number.isFinite(rapidRate) || rapidRate <= 0) return refused

      let fastTraverseRate = rapidRate
      let finishRate = rapidRate
      const needsResolvedRoleRates = moves.some(
        (move) => move.role === 'fast_traverse' || move.role === 'finish',
      )
      if (needsResolvedRoleRates) {
        const tool = tools.find((candidate: any) => candidate?.id === op.toolId)
        if (!tool) return refused
        const resolved = resolveFeedrates(tool, op.feedrateOverride, rapidRate)
        fastTraverseRate = resolved.fastTraverseRate
        finishRate = resolved.finishRate
        if (!Number.isFinite(fastTraverseRate) || fastTraverseRate <= 0 ||
            !Number.isFinite(finishRate) || finishRate <= 0) return refused
      }

      const rebuilt = estimateRuntimeMsOrError(
        moves, rapidRate, fastTraverseRate, finishRate, machineCutTimeMotion(p.machine),
      )
      if (rebuilt.error) {
        return { ...withoutStaleEstimate, estimatedCutTimeMsError: rebuilt.error }
      }
      const rebuiltMs = rebuilt.ms
      if (rebuiltMs === undefined || !Number.isFinite(rebuiltMs) || rebuiltMs < 0) return refused
      return { ...withoutStaleEstimate, estimatedCutTimeMs: rebuiltMs }
    })
    return setupChanged ? { ...setup, operations } : setup
  })

  return projectChanged ? { ...p, setups } : p
}

/**
 * Project migration step: claim schema v8 for the persisted `d1xd2` chamfer
 * setback-pair SketchDimension kind (WO UI-50C). Same precedent as v6's
 * arcLength claim: the shape is additive at the JSON level, so an older v7
 * build could otherwise parse the file and then mishandle or silently omit
 * the unknown two-valued dimension. The transform is intentionally an
 * identity: genuine v7 documents predate d1xd2 and need no backfill.
 */
export function migrateChamferSetbackDimensionSemantics(p: any): any {
  return p
}

/**
 * Project migration step: claim schema v9 for the embedded parametric modeling
 * document (`Project.document`, WO INT-14) -- the DOC-3 archive base64-encoded
 * so the model rides inside the .camproject.
 *
 * The transform is intentionally an IDENTITY (same precedent as v6's arcLength
 * claim and v8's d1xd2 claim above): a genuine v8 document predates the field
 * and has no model to backfill, so nothing is materialized on it -- a pre-v9
 * file loads byte-for-byte as it did before, with `document` simply absent
 * (`undefined`), which every consumer already treats as "this project has no
 * modeling document". Materializing an empty `document: ''` here would be
 * strictly worse: it would perturb every old file AND hand the loader a string
 * that is not a valid archive.
 *
 * The version is claimed rather than left implicit precisely so an OLDER build
 * fails loud (UnknownSchemaVersionError, store/index.ts:3905) on a v9 file
 * instead of parsing it and silently discarding the model it cannot represent
 * -- the ADR-0003 reason every additive claim step in this chain exists.
 */
export function migrateEmbeddedModelingDocument(p: any): any {
  return p
}

/**
 * Project migration step: claim schema v13 for the sketch `block` entity kind
 * (SKC-BLOCKS Stage 1). Same precedent as v6's arcLength / v8's d1xd2 / v9's
 * embedded-document claims: adding a new member to the SketchEntity union is
 * additive at the JSON level, so an older v12 build could otherwise parse a
 * block-bearing file and then MISHANDLE or silently drop the unknown 'block'
 * kind (its members, and any CAM op bound to the block's baked profile). The
 * transform is intentionally an IDENTITY -- a genuine v12 document predates
 * blocks and has no block to backfill -- but the version is claimed so an older
 * build fails loud (UnknownSchemaVersionError) instead of quietly discarding a
 * block it cannot represent (ADR-0003 / ADR-0027).
 */
export function migrateSketchBlockEntity(p: any): any {
  return p
}

/**
 * Project migration step: claim schema v14 for sketch block DEFINITIONS +
 * INSTANCES (SKC-BLOCKS Stage 5). Same precedent as v13's block-entity claim:
 * `Sketch.blockDefs` (a shared definition registry) and `SketchBlockEntity.defId`
 * (an instance pointer into it) are additive at the JSON level, so an older v13
 * build could otherwise parse a definition-bearing file and then MISHANDLE it --
 * it would find a block instance whose inline `members` are empty and whose
 * `defId` it does not understand, and render the instance as an empty block
 * (silently dropping the shared definition's geometry and any CAM op bound to an
 * instance's baked profile). The transform is intentionally an IDENTITY -- a
 * genuine v13 document predates definitions/instances and has nothing to
 * backfill -- but the version is claimed so an older build fails loud
 * (UnknownSchemaVersionError) instead of quietly discarding definition geometry
 * it cannot represent (ADR-0003 / ADR-0027).
 */
export function migrateSketchBlockDefinitions(p: any): any {
  return p
}

/**
 * Document-boundary backfill (WO UI-50C-R2, DECISIONS 2026-07-16 STOP
 * requirement 3): a PRE-R1 tool-built chamfer line carries no
 * `chamferSetback` identity marker at all -- SKC-41A (which built the
 * theoretical-corner rig) predates the marker; UI-50C-R1 introduced it, set
 * ONLY by `chamferTool.chamferLines`. Without this backfill, planDimension's
 * identity gate (dimTool.ts:618, `isChamferSetbackLine`) treats a genuine
 * legacy chamfer line as an ordinary line and a smart-dim click on it
 * measures the chamfer's hypotenuse instead of offering d1xd2 -- the R1
 * re-audit's MAJOR A regression, verbatim.
 *
 * WHERE (preflight section 4, case 9): runs UNCONDITIONALLY at the load
 * boundary -- NOT gated to the v7->v8 migration step. That step
 * (`migrateChamferSetbackDimensionSemantics`) is an intentional identity
 * transform and does not run at all for a document already stamped v8, and
 * a v7 file with an unmarked legacy rig legitimately exists TODAY (UI-50C-R6):
 * mainline independently reached v7 via the unrelated SIM-7 runtime-estimate
 * migration (`migrateRuntimeEstimateTruth`) while this marker writer and the
 * d1xd2 schema claim were still unmerged on wo/UI-50C, so any project a user
 * saved against that intervening main build carries v7 -- with no d1xd2
 * marker on its pre-existing chamfer lines. A migration-step-only backfill
 * would silently skip every one of those files forever.
 *
 * ELIGIBILITY, by construction (preflight section 4, cases 1-6): a line is
 * backfilled ONLY when its OWN `chamferSetback` field is completely ABSENT
 * (`undefined`) -- a line already carrying ANY value (the durable `true` a
 * genuine R1+ tool-built chamfer has, OR a malformed truthy-non-true value
 * like `"yes"`) is left BYTE-UNTOUCHED. Consequences, enumerated:
 *   (a) unmarked, COMPLETE valid rig -> backfilled to `chamferSetback: true`.
 *   (b) unmarked, no rig at all (an ordinary line) -> untouched -> plain
 *       distance (dimTool's existing unmarked-line default).
 *   (c) unmarked, INCOMPLETE rig (single pin / non-construction phantom /
 *       same host / parallel hosts / missing phantom) -> untouched -> ALSO
 *       plain distance -- never a refusal; an unmarked line must not
 *       regress. `resolveChamferCorner` (imported verbatim below, the EXACT
 *       rig test the dim tool itself applies) already returns `ok: false`
 *       for every one of these, so (b) and (c) fall out of the SAME check.
 *   (d) MARKED (`true`) but its rig cannot resolve (corrupted / re-solved
 *       parallel) -> untouched by this backfill (nothing to add) -- the
 *       EXISTING named refusal (dimTool.ts:620-627) still fires at dim time,
 *       unchanged.
 *   (e) ALREADY marked (`true`), rig resolves -> untouched -> idempotent,
 *       no duplicate warning, no reprocessing.
 *   (f) a FORGED `chamferSetback: true` on a line with NO rig -> untouched
 *       by this backfill (nothing to "repair") -> same named refusal as (d).
 *   (g) malformed rig FIELDS -- a truthy-non-true `chamferSetback` value on
 *       the CANDIDATE line itself ("yes", 1) -> untouched (its field is not
 *       `undefined`, so it is excluded from eligibility exactly like (d)/(e)
 *       -- never "repaired" to `true`). A non-construction phantom / single
 *       pin / same host / parallel hosts on an otherwise-UNMARKED line ->
 *       `resolveChamferCorner` refuses -> same as (c), untouched.
 *
 * ARCHITECT RULING -- FALSE POSITIVE (preflight section 4, case 7, decided
 * HERE, not left to the worker): a pre-R1 HAND-BUILT structure that is
 * byte-identical to the SKC-41A tool output (a line coincident-joined to two
 * distinct lines, with a construction point pinned to both) IS backfilled.
 * Structure IS identity at the pre-R1 boundary -- no tool provenance exists
 * pre-R1 to distinguish the two, and inventing a "tighter recognizer" would
 * only relocate the same ambiguity, not resolve it. Consequence, named
 * plainly: such a line gains the d1xd2 default instead of a plain length
 * dimension on its next smart-dim click -- recoverable, the dimension can be
 * deleted and re-placed as an ordinary two-point distance if the coincidence
 * was never intended as a chamfer.
 *
 * A visible event (console.warn, named per line), never a throw -- the
 * ADR-0003 downgrade-event precedent. PURE and byte-stable when nothing
 * qualifies for backfill.
 */
export function backfillChamferSetbackMarkers(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.geometry)) return p
  let touchedProject = false
  const geometry = p.geometry.map((g: any) => {
    if (g == null || typeof g !== 'object' || !Array.isArray(g.sketches)) return g
    let touchedGeometry = false
    const sketches = g.sketches.map((sk: any) => {
      if (sk == null || typeof sk !== 'object' ||
          !Array.isArray(sk.entities) || !Array.isArray(sk.constraints)) return sk
      let touchedSketch = false
      const entities = sk.entities.map((e: any) => {
        if (e == null || typeof e !== 'object' || e.kind !== 'line') return e
        // Case (d)/(e)/(f)/(g): ANY existing value (true, or a malformed
        // truthy-non-true one) means this line already has an opinion about
        // its own identity -- never touched, either direction.
        if (e.chamferSetback !== undefined) return e
        const resolved = resolveChamferCorner(sk.entities, sk.constraints, e.id)
        if (!resolved.ok) return e // cases (b)/(c): no rig, or an incomplete one
        touchedSketch = true
        console.warn(
          `[ADR-0003] project load: backfilling chamferSetback identity on line ${String(e.id)} ` +
          '(pre-R1 tool-built chamfer rig found with no durable marker -- WO UI-50C-R2).',
        )
        return { ...e, chamferSetback: true }
      })
      if (!touchedSketch) return sk
      touchedGeometry = true
      return { ...sk, entities }
    })
    if (!touchedGeometry) return g
    touchedProject = true
    return { ...g, sketches }
  })
  return touchedProject ? { ...p, geometry } : p
}

/**
 * Document-boundary backfill (NEST-MODAL-SPACING-VET): a nest record's
 * `spacing` (Spacing: partGap/sheetMargin/windowGap) and `sheet` (width/
 * height) are REQUIRED at the TypeScript type (NestRecord.spacing: Spacing,
 * NestRecord.sheet: {width,height}) but nothing enforces that at the JSON
 * load boundary — a hand-edited or externally-produced `.camproject`, or any
 * `nests[]` entry that reached the document through a path other than the
 * in-app New Nest modal (which always seeds complete values via
 * mergeNestSettings), can carry an absent or partial spacing/sheet. Every
 * `NumericInput` binding on NestModal's EDIT-open path reads these fields
 * straight from the stored record with NO fallback: `NumericInput` calls
 * `value.toFixed(10)` unconditionally on mount, so an undefined field throws
 * a TypeError the instant Edit opens (found in coordination/reports/
 * PP-UTILITY-S2.report.md via a hand-seeded capture fixture). `recomputeNest`
 * (src/store/index.ts) also forwards `nest.spacing` straight to the pack
 * worker, so a missing field could otherwise reach the engine as NaN instead
 * of a crash. Normalizing here — the single load boundary every project
 * passes through — fixes BOTH consumers at once instead of scattering
 * defensive fallbacks at each read site.
 *
 * Runs UNCONDITIONALLY at the end of migrateProjectData (same precedent as
 * `backfillChamferSetbackMarkers` below) — a malformed `nests[]` entry is not tied to any one schema-version
 * crossing. PURE + IDEMPOTENT: a record whose spacing/sheet are already
 * complete finite numbers is returned byte-stable; a visible console.warn
 * (the same downgrade-event precedent) fires only when a field is actually
 * backfilled.
 */
export function normalizeNestRecords(p: any): any {
  if (p == null || typeof p !== 'object' || !Array.isArray(p.nests)) return p
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  let projectChanged = false
  const nests = p.nests.map((n: any) => {
    if (n == null || typeof n !== 'object') return n
    const s = n.spacing
    const sh = n.sheet
    const spacingBad =
      s == null || typeof s !== 'object' || !fin(s.partGap) || !fin(s.sheetMargin) || !fin(s.windowGap)
    const sheetBad = sh == null || typeof sh !== 'object' || !fin(sh.width) || !fin(sh.height)
    if (!spacingBad && !sheetBad) return n
    projectChanged = true
    console.warn(
      `[ADR-0003] project load: normalizing nest "${String(n.id ?? n.name ?? '?')}" with ` +
      'incomplete spacing/sheet (NEST-MODAL-SPACING-VET) -- backfilled to engine defaults.',
    )
    return {
      ...n,
      spacing: {
        partGap: fin(s?.partGap) ? s.partGap : CREATE_NEST_TEST_DEFAULTS.spacing.partGap,
        sheetMargin: fin(s?.sheetMargin) ? s.sheetMargin : CREATE_NEST_TEST_DEFAULTS.spacing.sheetMargin,
        windowGap: fin(s?.windowGap) ? s.windowGap : CREATE_NEST_TEST_DEFAULTS.spacing.windowGap,
      },
      sheet: {
        width: fin(sh?.width) ? sh.width : CREATE_NEST_TEST_DEFAULTS.sheet.width,
        height: fin(sh?.height) ? sh.height : CREATE_NEST_TEST_DEFAULTS.sheet.height,
      },
    }
  })
  return projectChanged ? { ...p, nests } : p
}

/** Replicated here verbatim — NOT imported — so this migration function stays
 *  free of store-internal imports (the SAME precedent MIGRATION_DEFAULT_TOOL_LIBRARY
 *  and MIGRATION_DEFAULT_SCENE_STOCK above already follow). Must equal
 *  src/doc/documentHolder.ts's `LEGACY_MODEL_ITEM_ID` byte-for-byte —
 *  projectMigration.test.ts asserts this so the two can never silently drift,
 *  the same discipline MIGRATION_DEFAULT_SCENE_STOCK's own comment describes. */
export const MIGRATION_LEGACY_MODEL_ITEM_ID = 'legacy'

/** Deliberately plain, provisional display copy (mirrors nextModelItemName's
 *  own note in src/store/index.ts) — "exact display copy decided at
 *  implementation time, not this WO" (INT-17C.md Stage C1 deliverable). The
 *  ONE place this string lives. */
export const MIGRATION_LEGACY_MODEL_ITEM_NAME = 'Project Model'

/**
 * Project migration step: claim schema v12 for the keyed Model Item registry
 * (WO INT-17C Stage C1). Wraps a pre-existing single modeling document
 * (`Project.document`) as one legacy Model Item, tags every model-backed
 * geometry row with its owning item, and backfills a body-filtered Placement
 * record per row — the WO's own v12 migration steps 1-2 (INT-17C.md, "v12
 * migration" section; preflight section 3's dry-run).
 *
 * WHAT DOES NOT MOVE, deliberately (a disclosed, reasoned deviation from the
 * WO's literal step-4 wording "Remove Project.document on successful
 * conversion"): `Project.document` itself is left BYTE-UNTOUCHED here, not
 * deleted or renamed. The legacy Model Item's id is minted as the SAME
 * constant (`MIGRATION_LEGACY_MODEL_ITEM_ID`) every pre-C1 code path already
 * uses as documentHolder's default key (LEGACY_MODEL_ITEM_ID) — so
 * `document` continues to mean exactly what it always meant, "the legacy
 * item's own archive", with zero change to how loadProjectFromFile stashes
 * it or saveProjectToFile re-collects it (both already default to that same
 * key, unchanged). Deleting/renaming the field here would require ALSO
 * generalizing the save/load boundary to read N items' archives out of a
 * new shape — real, useful future work (Stage C2/C3 territory, or a
 * follow-up WO), but not needed for THIS migration to be lossless, and
 * doing it here would trade a small, safe, single-purpose step for a much
 * riskier one with no correctness benefit: there is only ONE archive-
 * carrying mechanism today, and the legacy item is defined to alias it
 * exactly. No "dual truth" is introduced — there was only ever one
 * mechanism, now also listed in `modelItems` for tree visibility.
 *
 * PURE + IDEMPOTENT: a project already carrying a `modelItems` entry with
 * this id is returned byte-stable (guards against a double-run on an
 * already-migrated document, e.g. schemaVersion already 12 replayed through
 * runMigrationChain's own from===current no-op guard — this function is
 * never actually invoked in that case, but idempotency is proven directly by
 * projectMigration.test.ts regardless, matching every sibling step's own
 * discipline). A genuine v11 file with NO `document` (the common case — a
 * 2D-only project, or a project that never opened the Model workspace) is
 * also returned byte-stable: nothing to wrap, matching v9/v6/v8's own
 * "claims the version, identity transform when there is nothing to migrate"
 * precedent immediately above.
 */
export function migrateModelItemRegistry(p: any): any {
  if (p == null || typeof p !== 'object') return p
  const hasDocument = typeof p.document === 'string' && p.document.length > 0
  const existingItems: any[] = Array.isArray(p.modelItems) ? p.modelItems : []
  const alreadyWrapped = existingItems.some((m) => m?.id === MIGRATION_LEGACY_MODEL_ITEM_ID)
  if (!hasDocument || alreadyWrapped) return p

  const modelItems = [
    ...existingItems,
    { id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME },
  ]

  const geometryRows: any[] = Array.isArray(p.geometry) ? p.geometry : []
  const isUnclaimedModelRow = (g: any) =>
    g != null && typeof g === 'object' && g.format === 'model' && g.modelBody != null &&
    typeof g.modelItemId !== 'string'

  const geometry = geometryRows.map((g) =>
    isUnclaimedModelRow(g) ? { ...g, modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID } : g,
  )

  const existingPlacements: any[] = Array.isArray(p.modelItemPlacements) ? p.modelItemPlacements : []
  const placementKeys = new Set(
    existingPlacements.map((pl) => `${pl?.modelItemId}:${pl?.bodyId ?? ''}`),
  )
  const newPlacements = geometryRows
    .filter(isUnclaimedModelRow)
    .map((g) => ({
      modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID,
      bodyId: g.modelBody?.ref?.bodyId,
      // Identity for every row today (confirmed by the preflight: nothing
      // currently writes non-identity pose onto a model row), preserved
      // faithfully either way — this line preserves whatever the row
      // actually carries, not an assumed default.
      position: g.position ?? { x: 0, y: 0, z: 0 },
      rotation: g.rotation ?? { x: 0, y: 0, z: 0 },
    }))
    .filter((pl) => typeof pl.bodyId === 'string' && !placementKeys.has(`${pl.modelItemId}:${pl.bodyId}`))

  return {
    ...p,
    modelItems,
    geometry,
    modelItemPlacements: [...existingPlacements, ...newPlacements],
  }
}

/** The ordered project migration chain. v0 (pre-stamp legacy file / persisted
 *  blob) -> v1: scene-stock defaults + coordinate-hierarchy fields. v1 -> v2:
 *  tool tipAngle (mixed included/from-axis) -> canonical angleFromAxisDeg. v2 ->
 *  v3: named tool libraries + holders as first-class project state. v3 -> v4:
 *  embedded STL/STEP binaries for self-contained portable files. v4 -> v5: CAM
 *  model-reference semantics (op.modelReferences + the 'degraded' status) claim a
 *  version so an older build fails loud instead of silently ignoring the B-rep
 *  dependency. v5 -> v6: arcLength sketch-dimension semantics claim a version
 *  so older builds fail loud rather than accepting an unknown dimension kind.
 *  v6 -> v7: pre-SIM-7 numeric cut-time claims are invalidated and rebuilt only
 *  from load data that can produce a fail-loud estimate. v7 -> v8: d1xd2
 *  chamfer setback-pair sketch-dimension semantics claim a version for the
 *  same reason (UI-50C). v8 -> v9: embedded parametric modeling document
 *  semantics. v9 -> v10: legacy outside-in Pocket 2D helical entries become
 *  Profile Ramp on the scheduled outer ring. v10 -> v11: versioned authored
 *  height intent (Reference + Offset + provenance). v11 -> v12: the keyed
 *  Model Item registry (WO INT-17C Stage C1) — wraps a pre-existing single
 *  modeling document as one legacy Model Item + body-filtered Placements.
 *  v16 -> v17: persisted Adaptive Clearing minimum-helix-radius,
 *  integral-wall-follow-budget, and physical milling-direction semantics claim
 *  a version so older builds fail loud rather than silently ignoring them.
 *  v17 -> v18: open-contour entry intent is normalized to the straight plunge
 *  behavior that every pre-v18 engine path actually emitted. v18 -> v19:
 *  every existing CAM operation is explicitly frozen behind its complete V1
 *  Smart Height resolver authority without changing toolpaths. */
export const projectMigrations: Migration<any>[] = [
  {
    to: 1,
    description: 'coordinate hierarchy + scene-stock defaults',
    up: (p) => migrateProjectToHierarchy(applySceneStockDefaults(p)),
  },
  {
    to: 2,
    description:
      'tool tipAngle (mixed included/from-axis) -> canonical angleFromAxisDeg (half-angle)',
    up: migrateToolAngleFromAxis,
  },
  {
    to: 3,
    description:
      'named tool libraries + holders as first-class project state (default lib-default)',
    up: migrateToolLibrariesAndHolders,
  },
  {
    to: 4,
    description:
      'embedded STL/STEP binaries for self-contained portable .camproject files',
    up: migrateEmbedGeometryBinaries,
  },
  {
    to: 5,
    description:
      "CAM model-reference semantics (op.modelReferences + 'degraded' status) -- claims the version so older builds fail loud (no-op transform)",
    up: migrateCamModelReferenceSemantics,
  },
  {
    to: 6,
    description:
      "arcLength sketch-dimension semantics -- claims the version so older builds fail loud (identity transform)",
    up: migrateArcLengthDimensionSemantics,
  },
  {
    to: 7,
    description:
      'runtime estimate feed truth -- invalidate pre-SIM-7 numeric claims and safely rebuild when load data permits',
    up: migrateRuntimeEstimateTruth,
  },
  {
    to: 8,
    description:
      "d1xd2 chamfer setback-pair sketch-dimension semantics -- claims the version so older builds fail loud (identity transform)",
    up: migrateChamferSetbackDimensionSemantics,
  },
  {
    to: 9,
    description:
      'embedded parametric modeling document (Project.document, WO INT-14) -- claims the version so older builds fail loud rather than drop the model (identity transform)',
    up: migrateEmbeddedModelingDocument,
  },
  {
    to: 10,
    description:
      'outside-in Pocket 2D helical entries -> Profile Ramp on the scheduled outer ring',
    up: migratePocketOutsideInHelixEntry,
  },
  {
    to: 11,
    description:
      'versioned authored height intent (Reference + Offset + provenance)',
    up: migrateHeightIntentSemantics,
  },
  {
    to: 12,
    description:
      'keyed Model Item registry (WO INT-17C Stage C1) -- wrap a pre-existing single modeling document as one legacy Model Item + body-filtered Placements',
    up: migrateModelItemRegistry,
  },
  {
    to: 13,
    description:
      "sketch 'block' entity kind (SKC-BLOCKS) -- claims the version so older builds fail loud rather than drop an unknown block (identity transform)",
    up: migrateSketchBlockEntity,
  },
  {
    to: 14,
    description:
      "sketch block DEFINITIONS + INSTANCES (SKC-BLOCKS Stage 5: Sketch.blockDefs + SketchBlockEntity.defId) -- claims the version so older builds fail loud rather than render a def-backed instance as an empty block (identity transform)",
    up: migrateSketchBlockDefinitions,
  },
  {
    to: 15,
    description:
      'durable per-Model-Item document manifest (empty vs authored vs legacy-unknown)',
    up: migrateModelItemDocumentManifest,
  },
  {
    to: 16,
    description:
      'setup-level height defaults + explicit per-operation inheritance ownership',
    up: migrateSetupDefaultHeights,
  },
  {
    to: 17,
    description:
      'persisted Adaptive Clearing minimum helix radius, integral wall-follow budget, and physical milling direction semantics -- identity claim so older builds fail loud instead of silently ignoring authored values',
    up: migrateAdaptiveClearingAuthoredSemantics,
  },
  {
    to: 18,
    description:
      'open Contour 2D entry truth -- normalize persisted ramp selections to the straight outside-stock plunge behavior pre-v18 engines actually emitted',
    up: migrateOpenContourEntryTruth,
  },
  {
    to: 19,
    description:
      'reserve durable Smart Height V2 authority without synthesizing legacy operation heights',
    up: migrateSmartHeightAuthority,
  },
]

/** Read a project document's schema version. A document with no numeric
 *  `schemaVersion` predates the stamp and is treated as version 0. */
export function readProjectSchemaVersion(raw: unknown): number {
  const v = (raw as any)?.schemaVersion
  return typeof v === 'number' ? v : 0
}

/**
 * Migrate a raw (possibly legacy / persisted) project document up to the current
 * schema version and stamp it. Throws UnknownSchemaVersionError (ADR-0003) if the
 * document is newer than this build supports.
 */
export function migrateProjectData(raw: unknown): Project {
  const from = readProjectSchemaVersion(raw)
  const migrated = runMigrationChain(
    raw as any,
    from,
    CURRENT_PROJECT_SCHEMA_VERSION,
    projectMigrations,
  )
  const stamped = { ...migrated, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION }
  // UI-50C-R2: runs on EVERY load, not just a version-crossing migration
  // step -- see backfillChamferSetbackMarkers' own doc. (WO-1858 removed the
  // companion d1xd2 driving-invariant pass: a driving chamfer setback pair
  // is a legitimate document state now, and forcing it back to a readout on
  // load was the reload half of the bug that order closed.)
  const cutHandsBackfilled = migrateProjectToolCutHands(stamped)
  const identityBackfilled = backfillChamferSetbackMarkers(cutHandsBackfilled)
  const drivingNormalized = identityBackfilled
  // INT-MODEL-UNIFY: same UNCONDITIONAL-load-boundary precedent as the two
  // steps immediately above (not gated to the v11->v12 transition itself).
  // `migrateModelItemRegistry`'s own v12 step only fires while CROSSING
  // v11->v12; a project that reached v12 by any other route (modeled
  // in-app through the plain Model tab before this fix existed, then
  // saved -- the exact gap INT-MODEL-UNIFY closes) never ran it, so its
  // legacy-scoped model rows stayed unclaimed on every subsequent load.
  // Re-running here catches that case; a project whose legacy item is
  // already wrapped is returned byte-stable (the function's own PURE +
  // IDEMPOTENT contract, see its doc comment) so this is a no-op for
  // every already-correct v12 file.
  const modelItemsRegistered = migrateModelItemRegistry(drivingNormalized)
  // The unconditional legacy catch-up above can mint a Model Item AFTER the
  // ordinary v14->v15 step already ran. Apply the idempotent manifest backfill
  // once more so that late-created record cannot slip through as implicit
  // empty and mount genesis after a browser reload.
  const modelItemManifestsRegistered = migrateModelItemDocumentManifest(modelItemsRegistered)
  // NEST-MODAL-SPACING-VET: same unconditional-load-boundary precedent as the
  // steps above — a malformed nests[] entry can arrive at ANY schema version
  // (hand-edited file, non-modal writer), so this is not gated to a version
  // crossing either.
  const normalized = normalizeNestRecords(modelItemManifestsRegistered)
  return normalized as Project
}
