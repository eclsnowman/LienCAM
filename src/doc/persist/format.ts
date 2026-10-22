import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import type { ElementMapDelta } from '../../geom/geom-service'
import { ElementMap } from '../element-map'
import { FeatureDag, type RollbackMarker } from '../dag'
import { TreeFolderStore, type TreeFolderSnapshot } from '../folders'
import { applyFeatureDelta } from '../replay'
import { compareIds } from '../stable-id'
import { CURRENT_SCHEMA_VERSION, migrateToCurrent, asJsonObject } from './versioning'
import { canonicalize, stableStringify, type JsonObject, type JsonValue } from './stable-json'

export interface BodyCacheInput {
  bodyId: string
  bytes: ArrayBuffer | Uint8Array
  elementMap: ElementMapDelta
  contentType?: string
}

export interface LoadedBodyCache {
  bodyId: string
  path: string
  bytes: Uint8Array
  elementMap: ElementMapDelta
  contentType: string
}

export interface DocumentSaveInput {
  dag: FeatureDag
  elementMapDeltas: ElementMapDelta[]
  parameters?: Record<string, JsonValue>
  bodyCaches?: BodyCacheInput[]
  sketches?: JsonValue
  camBindings?: JsonValue
  thumbnailPng?: ArrayBuffer | Uint8Array
  /**
   * WO UI-7 (BK-40): the rollback marker + explicit feature-timeline order,
   * an EXPLICIT caller-supplied field -- exactly like parameters/sketches/
   * camBindings above -- never auto-derived from `dag` here. This is what
   * keeps createDocumentArchive's insertion-order-independence golden test
   * (persist.test.ts: forward/reversed archives byte-identical) intact: two
   * FeatureDags built via different insertNode call orders produce different
   * featureOrder() sequences by design (see dag.ts's RollbackMarker comment),
   * so if this were derived automatically the archive would stop being
   * insertion-order independent. Omitted (or absent on load) defaults to an
   * id-sorted timeline with the marker at 'end' (nothing rolled back) -- a
   * pre-UI-7 archive opens exactly as before. No schemaVersion bump: this is
   * its own top-level document field, never folded into dag's own blob.
   */
  rollback?: { featureOrder: string[]; marker: RollbackMarker }
  /**
   * WO UI-8 (BK-42): design-tree folder grouping -- an EXPLICIT caller-supplied
   * top-level document field, exactly mirroring `rollback` above (never
   * auto-derived from `dag` here, own persistence seam, no schemaVersion bump).
   * Omitted (or absent on load) defaults to no folders/no membership -- a
   * pre-UI-8 archive opens exactly as before.
   */
  folders?: TreeFolderSnapshot
  /**
   * WO-2987 (WO-2750 Slice B): this Model Item's technical drawings, as the JSON
   * `{ documents: [...] }` that src/lib/drawing/document.ts writes. An EXPLICIT
   * caller-supplied top-level document field like `folders` above: no
   * schemaVersion bump, never derived from `dag`. The key is written only when
   * there is at least one drawing, so an archive without drawings is
   * byte-identical to one saved before this field existed. Drawings are opaque
   * here; document.ts decides what is readable and what is kept verbatim.
   */
  drawings?: JsonValue
}

export interface LoadedDocument {
  manifest: JsonObject
  document: JsonObject
  dag: FeatureDag
  elementMap: ElementMap
  elementMapDeltas: ElementMapDelta[]
  parameters: JsonObject
  bodyCaches: LoadedBodyCache[]
  migrationsApplied: number[]
  folders: TreeFolderStore
  /** WO-2987: the raw `{ documents }` the archive carried; `{ documents: [] }` when it had none. */
  drawings: JsonObject
}

interface FileEntry {
  path: string
  role: string
  bytes: Uint8Array
}

interface BodyCacheMetadata {
  bodyId: string
  path: string
  elementMap: ElementMapDelta
  contentType: string
}

const DOCUMENT_PATH = 'document.json'
const MANIFEST_PATH = 'manifest.json'
const THUMBNAIL_PATH = 'thumbnail.png'
const BREP_CONTENT_TYPE = 'application/x-liencam-brep'
const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

export function createDocumentArchive(input: DocumentSaveInput): Uint8Array {
  const entries: FileEntry[] = []
  const bodyCaches = normalizeBodyCaches(input.bodyCaches ?? [], entries)

  const document: JsonObject = {
    documentKind: 'liencam-3d-document',
    dag: JSON.parse(stableStringify(JSON.parse(input.dag.serialize()))) as JsonValue,
    elementMapDeltas: normalizeElementMapDeltas(input.elementMapDeltas) as unknown as JsonValue,
    parameters: canonicalize(input.parameters ?? {}) as JsonObject,
    sketches: canonicalize(input.sketches ?? []) as JsonValue,
    camBindings: canonicalize(input.camBindings ?? []) as JsonValue,
    bodyCaches: bodyCaches as unknown as JsonValue,
    rollback: canonicalize((input.rollback ?? { featureOrder: [], marker: { kind: 'end' } }) as unknown as JsonValue) as JsonValue,
    folders: canonicalize((input.folders ?? { folders: [], membership: {} }) as unknown as JsonValue) as JsonValue,
  }

  const drawings = drawingsToStore(input.drawings)
  if (drawings !== undefined) document.drawings = drawings

  entries.push({ path: DOCUMENT_PATH, role: 'document', bytes: strToU8(stableStringify(document)) })
  if (input.thumbnailPng) entries.push({ path: THUMBNAIL_PATH, role: 'thumbnail', bytes: cloneBytes(input.thumbnailPng) })

  const manifest: JsonObject = {
    format: 'liencam-3d-zip',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    files: entries
      .map((entry) => ({ path: entry.path, role: entry.role, bytes: entry.bytes.byteLength }))
      .sort((a, b) => a.path.localeCompare(b.path)) as unknown as JsonValue,
  }

  entries.push({ path: MANIFEST_PATH, role: 'manifest', bytes: strToU8(stableStringify(manifest)) })
  return zipEntries(entries)
}

export function loadDocumentArchive(bytes: ArrayBuffer | Uint8Array): LoadedDocument {
  const archive = unzipSync(cloneBytes(bytes))
  const manifestRaw = readJsonEntry(archive, MANIFEST_PATH)
  const documentRaw = readJsonEntry(archive, DOCUMENT_PATH)
  const migrated = migrateToCurrent(asJsonObject(manifestRaw, 'manifest'), asJsonObject(documentRaw, 'document'))
  const manifest = migrated.manifest
  const document = migrated.document

  const dag = FeatureDag.restore(stableStringify(requiredObject(document.dag, 'document.dag')))
  const elementMapDeltas = parseElementMapDeltas(document.elementMapDeltas)
  const elementMap = new ElementMap()
  for (const delta of elementMapDeltas) applyFeatureDelta(elementMap, delta)
  dag.regenerate(elementMap)
  dag.restoreRollbackState(parseRollbackState(document.rollback))
  const folders = TreeFolderStore.restore(parseFolderState(document.folders))

  const bodyCaches = parseBodyCaches(document.bodyCaches, archive)
  return {
    manifest,
    document,
    dag,
    elementMap,
    elementMapDeltas,
    parameters: requiredObject(document.parameters ?? {}, 'document.parameters'),
    bodyCaches,
    migrationsApplied: migrated.appliedMigrations,
    folders,
    drawings: parseDrawings(document.drawings),
  }
}

/**
 * WO-2987: the same archive with its drawings replaced (or removed when there
 * are none), every other entry byte-for-byte as it was. This is how the holder
 * keeps an unmounted item's pass-through bytes current when a drawing changes
 * without a decode/re-encode of the model it never opened.
 */
export function replaceArchiveDrawings(bytes: ArrayBuffer | Uint8Array, drawings: JsonValue | undefined): Uint8Array {
  const archive = unzipSync(cloneBytes(bytes))
  const document = asJsonObject(readJsonEntry(archive, DOCUMENT_PATH), 'document')
  const stored = drawingsToStore(drawings)
  if (stored === undefined) delete document.drawings
  else document.drawings = stored
  const documentBytes = strToU8(stableStringify(document))
  const manifest = asJsonObject(readJsonEntry(archive, MANIFEST_PATH), 'manifest')
  if (Array.isArray(manifest.files)) {
    manifest.files = manifest.files.map((f) =>
      f !== null && typeof f === 'object' && !Array.isArray(f) && f.path === DOCUMENT_PATH ? { ...f, bytes: documentBytes.byteLength } : f,
    )
  }
  archive[DOCUMENT_PATH] = documentBytes
  archive[MANIFEST_PATH] = strToU8(stableStringify(manifest))
  const zippable: Zippable = {}
  for (const path of Object.keys(archive).sort((a, b) => a.localeCompare(b))) zippable[path] = [archive[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

export function normalizeElementMapDelta(delta: ElementMapDelta): ElementMapDelta {
  const modified: Record<string, string[]> = {}
  for (const parent of Object.keys(delta.modified).sort(compareIds)) {
    modified[parent] = [...delta.modified[parent]].sort(compareIds)
  }

  const normalized: ElementMapDelta = {
    featureId: delta.featureId,
    generated: [...delta.generated].sort(compareIds),
    modified,
    deleted: [...delta.deleted].sort(compareIds),
  }
  if (delta.geometry) {
    const geometry: ElementMapDelta['geometry'] = {}
    for (const id of Object.keys(delta.geometry).sort(compareIds)) geometry[id] = delta.geometry[id]
    normalized.geometry = geometry
  }
  return JSON.parse(stableStringify(normalized)) as ElementMapDelta
}

export function normalizeElementMapDeltas(deltas: ElementMapDelta[]): ElementMapDelta[] {
  return deltas.map((delta) => normalizeElementMapDelta(delta))
}

function normalizeBodyCaches(inputs: BodyCacheInput[], entries: FileEntry[]): BodyCacheMetadata[] {
  const sorted = [...inputs].sort((a, b) => compareIds(a.bodyId, b.bodyId))
  const seenPaths = new Set<string>()
  return sorted.map((cache) => {
    const path = 'bodies/' + encodeURIComponent(cache.bodyId) + '.brep'
    if (seenPaths.has(path)) throw new Error("Duplicate body cache path '" + path + "'.")
    seenPaths.add(path)
    entries.push({ path, role: 'body-cache', bytes: cloneBytes(cache.bytes) })
    return {
      bodyId: cache.bodyId,
      path,
      contentType: cache.contentType ?? BREP_CONTENT_TYPE,
      elementMap: normalizeElementMapDelta(cache.elementMap),
    }
  })
}

function zipEntries(entries: FileEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const zippable: Zippable = {}
  for (const entry of sorted) zippable[entry.path] = [entry.bytes, ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

function readJsonEntry(archive: Record<string, Uint8Array>, path: string): JsonValue {
  const entry = archive[path]
  if (!entry) throw new Error("LienCAM document archive is missing '" + path + "'.")
  return JSON.parse(strFromU8(entry)) as JsonValue
}

function requiredObject(value: unknown, label: string): JsonObject {
  const canonical = canonicalize(value)
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new Error(label + ' must be a JSON object.')
  }
  return canonical
}

function parseElementMapDeltas(value: unknown): ElementMapDelta[] {
  if (!Array.isArray(value)) throw new Error('document.elementMapDeltas must be an array.')
  return value.map((delta) => normalizeElementMapDelta(delta as ElementMapDelta))
}

/** WO UI-7 (BK-40): tolerant parse of the separate `document.rollback` field -- absent (pre-UI-7 archive) or malformed input yields `undefined`, which FeatureDag.restoreRollbackState already treats as "nothing rolled back, id-sorted timeline". */
function parseRollbackState(value: unknown): { featureOrder?: string[]; marker?: RollbackMarker } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const featureOrder = Array.isArray(obj.featureOrder) ? (obj.featureOrder.filter((id) => typeof id === 'string') as string[]) : undefined
  const marker = obj.marker && typeof obj.marker === 'object' ? (obj.marker as RollbackMarker) : undefined
  return { featureOrder, marker }
}

/** WO UI-8 (BK-42): tolerant parse of the separate `document.folders` field -- absent (pre-UI-8 archive) or malformed input yields `undefined`, which TreeFolderStore.restore already treats as "no folders". */
function parseFolderState(value: unknown): Partial<TreeFolderSnapshot> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const folders = Array.isArray(obj.folders) ? (obj.folders as TreeFolderSnapshot['folders']) : undefined
  const membership =
    obj.membership && typeof obj.membership === 'object' && !Array.isArray(obj.membership)
      ? (obj.membership as Record<string, string>)
      : undefined
  return { folders, membership }
}

/** WO-2987: the `drawings` field to store, or undefined when there are no drawings (the key is then left out). */
function drawingsToStore(value: JsonValue | undefined): JsonValue | undefined {
  const parsed = parseDrawings(value === undefined ? undefined : canonicalize(value))
  return (parsed.documents as JsonValue[]).length === 0 ? undefined : parsed
}

/** WO-2987: tolerant parse of `document.drawings` -- absent (every pre-drawing archive) or not shaped `{ documents: [] }` reads as no drawings. Entries are kept verbatim; src/lib/drawing/document.ts classifies them. */
function parseDrawings(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { documents: [] }
  const documents = (value as Record<string, unknown>).documents
  return { documents: Array.isArray(documents) ? (canonicalize(documents) as JsonValue[]) : [] }
}

function parseBodyCaches(value: unknown, archive: Record<string, Uint8Array>): LoadedBodyCache[] {
  if (!Array.isArray(value)) throw new Error('document.bodyCaches must be an array.')
  return value.map((raw) => {
    const rec = requiredObject(raw, 'document.bodyCaches[]') as unknown as BodyCacheMetadata
    const bytes = archive[rec.path]
    if (!bytes) throw new Error("Body cache '" + rec.bodyId + "' is missing zip entry '" + rec.path + "'.")
    return {
      bodyId: rec.bodyId,
      path: rec.path,
      bytes: cloneBytes(bytes),
      contentType: rec.contentType ?? BREP_CONTENT_TYPE,
      elementMap: normalizeElementMapDelta(rec.elementMap),
    }
  })
}

function cloneBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes)
  return new Uint8Array(bytes.slice(0))
}
