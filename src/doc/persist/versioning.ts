import { stableStringify, type JsonObject, type JsonValue } from './stable-json'
import { compareIds } from '../stable-id'

export const CURRENT_SCHEMA_VERSION = 9
export const MIN_SCHEMA_VERSION = 1

export interface MigrationPackage {
  manifest: JsonObject
  document: JsonObject
}

export interface MigrationResult extends MigrationPackage {
  appliedMigrations: number[]
}

export type DocumentMigration = (pkg: MigrationPackage) => MigrationPackage

export class FutureSchemaVersionError extends Error {
  readonly fileVersion: number
  readonly currentVersion: number

  constructor(fileVersion: number, currentVersion = CURRENT_SCHEMA_VERSION) {
    super('LienCAM document schema ' + fileVersion + ' is newer than this loader supports (' + currentVersion + ').')
    this.name = 'FutureSchemaVersionError'
    this.fileVersion = fileVersion
    this.currentVersion = currentVersion
  }
}

export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaMigrationError'
  }
}

const migrations = new Map<number, DocumentMigration>()

export function registerMigration(fromVersion: number, migration: DocumentMigration): void {
  if (!Number.isInteger(fromVersion) || fromVersion < MIN_SCHEMA_VERSION) {
    throw new SchemaMigrationError("Invalid migration source version '" + fromVersion + "'.")
  }
  migrations.set(fromVersion, migration)
}

export function migrateToCurrent(manifest: JsonObject, document: JsonObject): MigrationResult {
  let version = readSchemaVersion(manifest)
  if (version > CURRENT_SCHEMA_VERSION) throw new FutureSchemaVersionError(version)
  if (version < MIN_SCHEMA_VERSION) {
    throw new SchemaMigrationError('Unsupported document schema ' + version + '; minimum supported is ' + MIN_SCHEMA_VERSION + '.')
  }

  let pkg: MigrationPackage = { manifest, document }
  const appliedMigrations: number[] = []
  while (version < CURRENT_SCHEMA_VERSION) {
    // WO-1085 / ADR-0040: v6 adds a JSON union member for multi-region
    // selectors. Existing payloads need no transformation. Keep the old
    // migration chain intact for its regression fixtures, but advance the
    // manifest stamp without inventing a legacy selector migration.
    if (version === 5) {
      pkg = {
        ...pkg,
        manifest: JSON.parse(stableStringify({ ...pkg.manifest, schemaVersion: 6 })) as JsonObject,
      }
      version = 6
      continue
    }
    // WO-3237: v8 lets an extrude's profileSelector be a sketch-chain built as
    // a Thin open wall (wallSide left / right / center of travel). Every v7
    // payload means what it meant, so nothing is rewritten; the stamp alone
    // advances. Its purpose is the other way round: a schema-7 build, which
    // only knows closed Thin, refuses a v8 file through FutureSchemaVersionError
    // instead of opening an open-chain wall it would rebuild as something else.
    if (version === 7) {
      pkg = {
        ...pkg,
        manifest: JSON.parse(stableStringify({ ...pkg.manifest, schemaVersion: 8 })) as JsonObject,
      }
      version = 8
      continue
    }
    // WO-3244: v9 adds the Body Transform feature (Mirror, opType
    // 'bodyTransform', src/doc/features/bodyTransform.ts). A v8 document holds
    // none, so - like v5 -> v6 and v7 -> v8 - the step is pure identity and only
    // advances the manifest stamp; a v8 reader meets a v9 file as a future
    // version and refuses it instead of showing its history without the mirror.
    if (version === 8) {
      pkg = {
        ...pkg,
        manifest: JSON.parse(stableStringify({ ...pkg.manifest, schemaVersion: 9 })) as JsonObject,
      }
      version = 9
      continue
    }
    const migration = migrations.get(version)
    if (!migration) throw new SchemaMigrationError('No migration registered from schema ' + version + ' to ' + (version + 1) + '.')
    pkg = migration(pkg)
    appliedMigrations.push(version)
    const nextVersion = readSchemaVersion(pkg.manifest)
    if (nextVersion !== version + 1) {
      throw new SchemaMigrationError(
        'Migration from schema ' + version + ' must produce schema ' + (version + 1) + ', produced ' + nextVersion + '.',
      )
    }
    version = nextVersion
  }
  return { ...pkg, appliedMigrations }
}

function readSchemaVersion(manifest: JsonObject): number {
  const raw = manifest.schemaVersion
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new SchemaMigrationError('Document manifest is missing integer schemaVersion.')
  }
  return raw
}

function migrationV1ToV2(pkg: MigrationPackage): MigrationPackage {
  const document = { ...pkg.document }
  if (document.documentKind === undefined) document.documentKind = 'liencam-3d-document'
  if (document.parameters === undefined) document.parameters = {}
  if (document.bodyCaches === undefined) document.bodyCaches = []
  if (document.elementMapDeltas === undefined) document.elementMapDeltas = []

  const manifest = {
    ...pkg.manifest,
    format: pkg.manifest.format ?? 'liencam-3d-zip',
    schemaVersion: 2,
  }
  return {
    manifest: JSON.parse(stableStringify(manifest)) as JsonObject,
    document: JSON.parse(stableStringify(document)) as JsonObject,
  }
}

registerMigration(1, migrationV1ToV2)

// WO UI-51A: extrude features gain an explicit DIRECTION ('up' | 'down' |
// 'midplane') and BOOLEAN MODE ('newBody' | 'add' | 'remove' | 'intersect').
// A pre-UI-51A (schema v2) extrude payload carries neither field; the honest
// default is up / newBody -- exactly the behavior the executor hardcoded
// before this WO (blind, along +normal, new body). Region behavior (the
// sketch truncated to its first canonical region) is unchanged and owned by
// UI-51C, so NO region field is added here; targetFeatureId is not added
// either (newBody needs no target). For every non-extrude node this is a pure
// identity step. Newer docs fail loud via FutureSchemaVersionError per this
// chain's own convention (migrateToCurrent).
function migrationV2ToV3(pkg: MigrationPackage): MigrationPackage {
  const document = { ...pkg.document }
  const dag = document.dag
  if (dag !== null && typeof dag === 'object' && !Array.isArray(dag)) {
    const nodes = (dag as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      const nextNodes = nodes.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const node = raw as { kind?: unknown; payload?: unknown }
        if (node.kind !== 'feature') return raw
        const payload = node.payload
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return raw
        const p = payload as Record<string, unknown>
        if (p.opType !== 'extrude') return raw
        return { ...node, payload: { ...p, direction: p.direction ?? 'up', boolMode: p.boolMode ?? 'newBody' } }
      })
      document.dag = { ...(dag as Record<string, unknown>), nodes: nextNodes }
    }
  }
  const manifest = { ...pkg.manifest, schemaVersion: 3 }
  return {
    manifest: JSON.parse(stableStringify(manifest)) as JsonObject,
    document: JSON.parse(stableStringify(document)) as JsonObject,
  }
}

registerMigration(2, migrationV2ToV3)

// WO UI-80 (AM2, single-format, no dual truth): direct push/pull edits used to
// live as invisible `payload.faceEdits[]` sub-records (kind 'faceOffset') on the
// OWNING body-producing feature node, replayed at regen by
// applyFaceEditsAndFinalize. UI-80 promotes each push/pull to its OWN first-class
// `kind: 'feature'`, `opType: 'pushPull'` DAG node (visible, deletable, editable).
// This converting migration turns every legacy faceOffset record into a sibling
// pushPull node so no document carries both formats after the merge; the retired
// replay path now REFUSES a surviving faceOffset by name.
//
// SCOPE (out-of-scope kinds preserved): only kind 'faceOffset' records are
// promoted. 'holeDiameter' (resize-hole, WO UI-58) and 'pocketDepth' stay as
// faceEdits on the owner -- they are explicitly out of UI-80 scope and still
// replay through applyFaceEditsAndFinalize.
//
// ORDER: a node's faceOffset records were replayed in array order, each chained
// onto the previous body. The promoted siblings preserve that chain -- the first
// consumes the owner, each subsequent one consumes the prior sibling -- so a
// migrated document regenerates the SAME body. The target face rides node.refs
// as a single-face FeatureRef (AM1, ElementMap-healed at regen), migrated from
// the record's raw `featureKey`. Legacy records carry no captured normal, so the
// promoted node stores a placeholder +Z normal (direction-display only; the
// kernel derives push direction from the resolved face, and the edit dialog reads
// direction from the delta sign, so the placeholder never affects geometry).
//
// SPLICE + REWIRE (UI-80-R1 blocker; UI-80-R3 carrier census): in the legacy
// format the owner's faceEdits were INTRINSIC to the owner's own regen -- the
// owner's OUTPUT body already carried the push/pull, and every downstream
// consumer of that owner saw the pushed geometry. After promotion the owner emits
// the UN-pushed body and the chain TAIL emits the pushed one, so the migration
// MUST rewire every pre-existing direct consumer of the owner onto the chain tail:
// the `consumes` edge AND EVERY payload field that names a feature whose BODY the
// regen executor consults via lookupLiveBody. That read-set is not one carrier --
// it is the full BODY_IDENTITY_PAYLOAD_CARRIERS census below: ownerId
// (fillet/chamfer/shell/draft/hole/defeature/pushPull), targetFeatureId (boolean +
// boolean-mode extrude) and toolFeatureId (boolean). Rewiring only `consumes` +
// `targetFeatureId` was the R2 blocker (a downstream fillet's payload.ownerId, and
// a boolean's payload.toolFeatureId, still named the superseded owner and failed
// "has no live body"). Only the chain HEAD keeps consuming the owner (it is the
// new node that legitimately wants the owner's un-pushed body). Nothing
// pre-existing consumed the un-pushed owner in the legacy doc, so the rewire is
// total. The census test carrierCensus.test.ts asserts this set is a superset of
// the executor's actual lookupLiveBody argument fields and fails on any new op
// that adds an unhandled identity field.
//
// ROLLBACK (UI-80-R1 blocker): the promoted chain is logically part of what the
// owner used to be, so each chain is spliced into document.rollback.featureOrder
// immediately AFTER its owner (its former post-op position), and a marker that
// named the owner (`after ownerId`) is remapped to name the chain TAIL -- so a
// timeline rolled to "just after the owner" still shows the owner WITH its
// committed push/pull, exactly as the legacy owner-intrinsic faceEdits did, and a
// marker above the owner still rolls the whole chain back with it. Left alone the
// promoted ids would be appended past the marker by restoreRollbackState and
// silently roll back a committed edit.
//
// A newer-than-current file still fails loud via FutureSchemaVersionError
// (migrateToCurrent), per ADR-0027.
type MigrationFaceEdit = { featureKey?: unknown; kind?: unknown; delta?: unknown }

// UI-80-R3 CARRIER CENSUS: the COMPLETE set of single-value payload fields that
// name a feature whose BODY the regen executor resolves through lookupLiveBody
// (SolidsWorkbenchPage.tsx executor read-set -- every lookupLiveBody(p.<field>)
// argument, plus buildExtrudeRequest's lookupTarget(payload.targetFeatureId)).
// A v3->v4 promotion renames the body producer (owner -> chain tail); every one
// of these carriers on a PRE-EXISTING consumer must retarget the tail, exactly
// like the consumes edge, or the executor resolves a since-superseded id and
// fails "has no live body". This is the ground truth the census test
// (src/tests/doc/persist/carrierCensus.test.ts) pins: it derives the executor's
// actual lookupLiveBody argument fields from source and asserts they are a subset
// of this set, failing if a new op adds an unhandled identity field.
//
// RULED OUT (with reason, mirrored by the census test's negative assertions):
//   - sketchId / sectionIds[]: read via dag.getNode -> a SKETCH node, which is
//     never a promoted owner (only nodes whose faceEdits carry a faceOffset are
//     promoted), so no sketch id is ever renamed.
//   - refs[].id (single-face) / faceId (hole): ELEMENT-MAP / face stable-ids
//     resolved relative to the consumed body, not top-level feature-node ids;
//     promotion renames NODES, not faces.
//   - consumes[] edges and the rollback marker nodeId: rewired structurally in
//     the migration body below, not through this payload-carrier set.
// WO-3244: sourceBodyId (Mirror / bodyTransform) names the body it reflects
// and replaces, exactly like a dress-up's ownerId - a feature inserted at the
// rollback marker on that body must carry a rolled-back Mirror with it
// (commands.ts rewireRolledBackConsumers).
export const BODY_IDENTITY_PAYLOAD_CARRIERS = ['ownerId', 'targetFeatureId', 'toolFeatureId', 'sourceBodyId'] as const

/** Mint the next free `F<n>` feature id not already present in `used`; records
 *  the minted id in `used` so a chain of promotions never collides. Scans upward
 *  from 1, exactly like the runtime dialogs' nextId helper. */
function nextFreeFeatureId(used: Set<string>): string {
  let n = 1
  while (used.has('F' + n)) n++
  const id = 'F' + n
  used.add(id)
  return id
}

function migrationV3ToV4(pkg: MigrationPackage): MigrationPackage {
  const document = { ...pkg.document }
  const dag = document.dag
  if (dag !== null && typeof dag === 'object' && !Array.isArray(dag)) {
    const nodes = (dag as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      // Every id already claimed by the document -- new sibling ids must avoid all.
      const used = new Set<string>()
      const originalIds: string[] = []
      for (const raw of nodes) {
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          const id = (raw as { id?: unknown }).id
          if (typeof id === 'string') {
            used.add(id)
            originalIds.push(id)
          }
        }
      }

      const promoted: Record<string, unknown>[] = []
      // ownerId -> its promoted chain ids in order (head..tail). Used to rewire
      // every pre-existing consumer of the owner onto the tail and to splice the
      // chain into the rollback timeline at the owner's post-op position.
      const promotedByOwner = new Map<string, string[]>()
      const nextNodes = nodes.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const node = raw as { id?: unknown; kind?: unknown; payload?: unknown }
        if (node.kind !== 'feature' || typeof node.id !== 'string') return raw
        const payload = node.payload
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return raw
        const p = payload as Record<string, unknown>
        const faceEdits = p.faceEdits
        if (!Array.isArray(faceEdits) || faceEdits.length === 0) return raw

        const kept: MigrationFaceEdit[] = []
        const offsets: MigrationFaceEdit[] = []
        for (const edit of faceEdits as MigrationFaceEdit[]) {
          if (edit !== null && typeof edit === 'object' && edit.kind === 'faceOffset') offsets.push(edit)
          else kept.push(edit)
        }
        if (offsets.length === 0) return raw

        // Chain the promoted siblings: owner -> pushPull_1 -> pushPull_2 -> ...
        const ownerId = node.id
        const chain: string[] = []
        let parentId = ownerId
        for (const edit of offsets) {
          const id = nextFreeFeatureId(used)
          const featureKey = typeof edit.featureKey === 'string' ? edit.featureKey : ''
          const delta = typeof edit.delta === 'number' ? edit.delta : 0
          promoted.push({
            id,
            kind: 'feature',
            consumes: [parentId],
            refs: [{ id: featureKey, kind: 'single-face' }],
            payload: {
              opType: 'pushPull',
              ownerId: parentId,
              delta,
              normal: { x: 0, y: 0, z: 1 },
              name: 'Push/Pull ' + id,
            },
            degraded: false,
            diagnostics: [],
            lastGoodBoundTo: {},
            suppressed: false,
            hidden: false,
          })
          chain.push(id)
          parentId = id
        }
        promotedByOwner.set(ownerId, chain)

        // The owner keeps only the non-faceOffset faceEdits (holeDiameter/pocketDepth).
        return { ...node, payload: { ...p, faceEdits: kept } }
      })

      if (promotedByOwner.size > 0) {
        // Rewire every PRE-EXISTING consumer of a promoted owner onto that
        // owner's chain tail. The chain head (in `promoted`, never in
        // `nextNodes`) legitimately keeps consuming the owner; every original
        // node that consumed the owner in the legacy doc was consuming the
        // owner's INTRINSIC (pushed) body and must now consume the tail.
        const tailOf = (ownerId: string): string => {
          const chain = promotedByOwner.get(ownerId) as string[]
          return chain[chain.length - 1]
        }
        for (const raw of nextNodes) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
          const node = raw as { id?: unknown; consumes?: unknown; payload?: unknown }
          if (Array.isArray(node.consumes)) {
            node.consumes = (node.consumes as unknown[]).map((c) =>
              typeof c === 'string' && promotedByOwner.has(c) ? tailOf(c) : c,
            )
          }
          // Retarget EVERY payload identity carrier the executor resolves through
          // lookupLiveBody (BODY_IDENTITY_PAYLOAD_CARRIERS) -- ownerId,
          // targetFeatureId AND toolFeatureId. Rewiring only targetFeatureId was
          // the R2 blocker: a downstream fillet still carried payload.ownerId=F1
          // and a boolean payload.toolFeatureId=F1, both of which the executor
          // resolves via lookupLiveBody and which fail "has no live body" once the
          // promoted chain supersedes the owner.
          const payload = node.payload
          if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            const p = payload as Record<string, unknown>
            for (const carrier of BODY_IDENTITY_PAYLOAD_CARRIERS) {
              const v = p[carrier]
              if (typeof v === 'string' && promotedByOwner.has(v)) {
                p[carrier] = tailOf(v)
              }
            }
          }
        }

        // Reconcile the rollback timeline: splice each chain immediately after
        // its owner (former post-op position) and remap an `after ownerId`
        // marker onto the chain tail. Mirrors FeatureDag.restoreRollbackState's
        // own reconciliation (declared order filtered to live ids, unknown ids
        // appended id-sorted) so a declared featureOrder is preserved verbatim
        // and only truly-missing ids fall back to the deterministic id sort.
        const rb =
          document.rollback !== null && typeof document.rollback === 'object' && !Array.isArray(document.rollback)
            ? (document.rollback as Record<string, unknown>)
            : {}
        const rawOrder = Array.isArray(rb.featureOrder)
          ? (rb.featureOrder as unknown[]).filter((id): id is string => typeof id === 'string')
          : []
        const originalIdSet = new Set(originalIds)
        const declared: string[] = []
        const declaredSet = new Set<string>()
        for (const id of rawOrder) {
          if (originalIdSet.has(id) && !declaredSet.has(id)) {
            declared.push(id)
            declaredSet.add(id)
          }
        }
        const missing = originalIds.filter((id) => !declaredSet.has(id)).sort(compareIds)
        const baseOrder = [...declared, ...missing]
        const featureOrder: string[] = []
        for (const id of baseOrder) {
          featureOrder.push(id)
          const chain = promotedByOwner.get(id)
          if (chain) featureOrder.push(...chain)
        }

        const rawMarker = rb.marker !== null && typeof rb.marker === 'object' && !Array.isArray(rb.marker) ? (rb.marker as Record<string, unknown>) : undefined
        let marker: JsonValue = { kind: 'end' }
        if (rawMarker) {
          if (rawMarker.kind === 'after' && typeof rawMarker.nodeId === 'string') {
            const nodeId = promotedByOwner.has(rawMarker.nodeId) ? tailOf(rawMarker.nodeId) : rawMarker.nodeId
            marker = { kind: 'after', nodeId }
          } else if (rawMarker.kind === 'start' || rawMarker.kind === 'end') {
            marker = { kind: rawMarker.kind as string }
          }
        }
        document.rollback = { featureOrder, marker } as unknown as JsonValue
      }

      document.dag = { ...(dag as Record<string, unknown>), nodes: [...nextNodes, ...promoted] }
    }
  }
  const manifest = { ...pkg.manifest, schemaVersion: 4 }
  return {
    manifest: JSON.parse(stableStringify(manifest)) as JsonObject,
    document: JSON.parse(stableStringify(document)) as JsonObject,
  }
}

registerMigration(3, migrationV3ToV4)

// WO-214: extrude end conditions become explicit persisted intent. Historical
// documents already encode Symmetric through direction='midplane'; every other
// historical extrude is Blind. The migration records that truth without
// inventing a target identity or offset which never existed in the old file.
// Target-driven modes created at schema v5 persist their full endTarget object
// (Model Item + body feature/stable subshape lineage, or a standalone datum
// plane feature id) verbatim through the DAG's stable JSON serializer.
function migrationV4ToV5(pkg: MigrationPackage): MigrationPackage {
  const document = { ...pkg.document }
  const dag = document.dag
  if (dag !== null && typeof dag === 'object' && !Array.isArray(dag)) {
    const nodes = (dag as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      const nextNodes = nodes.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const node = raw as { kind?: unknown; payload?: unknown }
        if (node.kind !== 'feature') return raw
        const payload = node.payload
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return raw
        const p = payload as Record<string, unknown>
        if (p.opType !== 'extrude') return raw
        const endCondition = p.endCondition ?? (p.direction === 'midplane' ? 'symmetric' : 'blind')
        return { ...node, payload: { ...p, endCondition } }
      })
      document.dag = { ...(dag as Record<string, unknown>), nodes: nextNodes }
    }
  }
  const manifest = { ...pkg.manifest, schemaVersion: 5 }
  return {
    manifest: JSON.parse(stableStringify(manifest)) as JsonObject,
    document: JSON.parse(stableStringify(document)) as JsonObject,
  }
}

registerMigration(4, migrationV4ToV5)

// WO-3234: extrudes gain an explicit wall mode -- 'solid' or 'thin' (with
// wallThickness and wallSide). No schema-6 reader ever honoured a wall field:
// makeExtrude ignored the kernel request's `thin` until WO-3233 and no payload
// field reached it, so every schema-6 extrude was built solid. The migration
// records exactly that, wallMode 'solid', and leaves every other key as it
// was -- an old opaque `thin` object stays inert data (only wallMode makes an
// extrude thin) and no thickness is backfilled. Files written at schema 7 may
// carry wallMode 'thin'; a schema-6 build refuses them through the
// FutureSchemaVersionError check in migrateToCurrent.
function migrationV6ToV7(pkg: MigrationPackage): MigrationPackage {
  const document = { ...pkg.document }
  const dag = document.dag
  if (dag !== null && typeof dag === 'object' && !Array.isArray(dag)) {
    const nodes = (dag as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      const nextNodes = nodes.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const node = raw as { kind?: unknown; payload?: unknown }
        if (node.kind !== 'feature') return raw
        const payload = node.payload
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return raw
        const p = payload as Record<string, unknown>
        if (p.opType !== 'extrude') return raw
        return { ...node, payload: { ...p, wallMode: 'solid' } }
      })
      document.dag = { ...(dag as Record<string, unknown>), nodes: nextNodes }
    }
  }
  const manifest = { ...pkg.manifest, schemaVersion: 7 }
  return {
    manifest: JSON.parse(stableStringify(manifest)) as JsonObject,
    document: JSON.parse(stableStringify(document)) as JsonObject,
  }
}

registerMigration(6, migrationV6ToV7)

export function asJsonObject(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaMigrationError(label + ' must be a JSON object.')
  }
  return value
}
