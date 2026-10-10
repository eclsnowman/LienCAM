import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Embed/extract STL + STEP binary payloads for self-contained .camproject files
// (schema v4, ADR-0027).
//
// A saved .camproject is JSON. The 2D geometry (loops/sketches) already travels in
// that JSON, but STL mesh bytes and STEP source bytes live ONLY in per-browser
// IndexedDB caches (stlCache.ts / stepCache.ts), keyed by geometry id. So a project
// opened on another browser/machine ORPHANED every STL and STEP part. This module
// embeds those raw bytes (base64) under Project.binaries so the file is fully
// portable, and re-populates the caches on load BEFORE the scene restore runs
// (restoreScene.ts reads the caches).
//
// WO-1884 / Rule 11: a real imported STL/STEP part with NO cached bytes at save
// time no longer aborts the whole Save. One evicted cache entry used to make every
// other edit unsavable. The part is skipped (its bytes cannot be embedded), the
// console names it and the file it must be re-imported from, and the file is
// written with every other part, operation and setting intact. On the next open the
// missing part is named by the existing restore re-import message path (no new
// dialog). Nest-owned seed copies (ownerNestId set) are EXCLUDED: they render from
// their 2D loops via the nest and restore never loads mesh bytes for them
// (restoreGeometryToViewport skips ownedSeedIds), so they neither need nor get an
// embedded binary — matching exactly which geometries the restore path loads bytes
// for.

import type {
  ImportedGeometry,
  PortableBrepModelPayloadV1,
  ProjectBinaries,
  Project,
} from '../types'
import { strToU8, zipSync } from 'fflate'
import { dataUrlToBytes } from '../referenceImage/imageData'
import { fontOriginalFile } from './sketch/fontImport'
import type { BrepModelPayload } from './cam/geometry/occt/model/types'
import * as modelClient from './cam/geometry/occt/model/modelClient'
import { cacheSTL, loadCachedSTL } from './stlCache'
import * as stepCache from './stepCache'
import { AO_MIN_F32 } from './viewport/lighting/rigDescriptors'

/** Retained for the store's `instanceof` import. WO-1884 removed the only throw
 *  site: collectProjectBinaries now skips a part whose bytes are missing (Rule 11)
 *  instead of refusing the whole save, so this class is never constructed by this
 *  module any more. */
export class MissingGeometryBinaryError extends Error {
  public readonly geometryId: string
  public readonly geometryName: string
  public readonly format: 'stl' | 'step'
  constructor(geo: { id: string; name: string }, format: 'stl' | 'step') {
    super(
      operatorText('projectBinaries1', { value1: String(format.toUpperCase()), value2: String(geo.name) }),
    )
    this.name = 'MissingGeometryBinaryError'
    this.geometryId = geo.id
    this.geometryName = geo.name
    this.format = format
  }
}

/** A geometry whose binary bytes restoreScene will load = a root (non-nest-seed)
 *  STL or STEP part. Mirrors restoreGeometryToViewport's load conditions exactly
 *  (format stl/step AND id not an owned-seed copy). */
function needsBinary(
  geo: ImportedGeometry,
): geo is ImportedGeometry & { format: 'stl' | 'step' } {
  return (geo.format === 'stl' || geo.format === 'step') && geo.ownerNestId === undefined
}

// 32 KiB: chunk size for base64 so String.fromCharCode's argument count stays well
// under engine limits even for a many-megabyte STL.
const CHUNK = 0x8000

/** Raw bytes -> base64 (chunked so a large buffer never overflows the call stack). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** base64 -> raw bytes (the exact inverse of arrayBufferToBase64). */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SHA256_RE = /^[a-f0-9]{64}$/
export const MAX_PORTABLE_STEP_DISPLAY_BYTES = 256 * 1024 * 1024

export interface DecodedPortableBrepModelPayload {
  payload: BrepModelPayload
  sourceSha256: string
  tessellation: stepCache.StepDisplayTessellation | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isFiniteTuple3(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function finiteFloatArray(values: Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false
  return true
}

function validAoArray(value: unknown, vertexCount: number): value is Float32Array {
  if (!(value instanceof Float32Array) || value.length !== vertexCount) return false
  for (const factor of value) {
    if (!Number.isFinite(factor) || factor < AO_MIN_F32 || factor > 1) return false
  }
  return true
}

function rangesCover(
  ranges: Uint32Array,
  itemCount: number,
  totalLength: number,
  countMultiple: number,
  minimumCount: number,
): boolean {
  if (itemCount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) return false
  if (ranges.length !== itemCount * 2) return false
  let cursor = 0
  for (let i = 0; i < itemCount; i++) {
    const start = ranges[i * 2]
    const count = ranges[i * 2 + 1]
    if (start !== cursor || count < minimumCount
      || count % countMultiple !== 0 || start + count > totalLength) {
      return false
    }
    cursor += count
  }
  return cursor === totalLength
}

/** Accept only complete, internally consistent render/pick payloads. A corrupt
 *  optional cache entry must fall closed to raw STEP recovery, never reach Three. */
export function validateBrepModelPayload(value: unknown): BrepModelPayload | null {
  if (!isRecord(value)
    || !isCount(value.faceCount)
    || !isCount(value.edgeCount)
    || !isCount(value.solidCount)
    || !isRecord(value.bbox)
    || !isFiniteTuple3(value.bbox.min)
    || !isFiniteTuple3(value.bbox.max)
    || !isRecord(value.mesh)
    || !isRecord(value.edges)
    || !(value.mesh.positions instanceof Float32Array)
    || !(value.mesh.normals instanceof Float32Array)
    || !(value.mesh.indices instanceof Uint32Array)
    || !(value.mesh.faceRanges instanceof Uint32Array)
    || !(value.edges.positions instanceof Float32Array)
    || !(value.edges.edgeRanges instanceof Uint32Array)
    || !(value.faceTypes instanceof Uint8Array)) {
    return null
  }

  const rawAo = value.mesh.ao
  const payload = value as unknown as BrepModelPayload
  const vertexCount = payload.mesh.positions.length / 3
  const edgePointCount = payload.edges.positions.length / 3
  if (payload.solidCount < 1
    || payload.faceCount < 1
    || payload.mesh.positions.length < 9
    || payload.mesh.positions.length % 3 !== 0
    || payload.mesh.normals.length !== payload.mesh.positions.length
    || payload.mesh.indices.length % 3 !== 0
    || payload.edges.positions.length % 3 !== 0
    || payload.faceTypes.length !== payload.faceCount
    || !finiteFloatArray(payload.mesh.positions)
    || !finiteFloatArray(payload.mesh.normals)
    || !finiteFloatArray(payload.edges.positions)
    || payload.mesh.indices.length < 3
    || !rangesCover(payload.mesh.faceRanges, payload.faceCount, payload.mesh.indices.length, 3, 3)
    || !rangesCover(payload.edges.edgeRanges, payload.edgeCount, edgePointCount, 1, 2)) {
    return null
  }
  for (const index of payload.mesh.indices) if (index >= vertexCount) return null
  for (const faceType of payload.faceTypes) if (faceType > 10) return null
  for (let axis = 0; axis < 3; axis++) {
    if (payload.bbox.min[axis] > payload.bbox.max[axis]) return null
  }
  if (rawAo !== undefined) {
    const validAo = validAoArray(rawAo, vertexCount)
    // AO is an optional acceleration inside an otherwise complete selectable
    // display. Corrupt AO is ignored so the renderer can rebake and upgrade the
    // cache without throwing away the valid face/edge payload or parsing STEP.
    if (!validAo) return { ...payload, mesh: { ...payload.mesh, ao: undefined } }
  }
  return payload
}

function bytesForView(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  return bytes.slice().buffer
}

function encodeFloat32(values: Float32Array): string {
  if (IS_LITTLE_ENDIAN) return arrayBufferToBase64(bytesForView(values))
  const buffer = new ArrayBuffer(values.length * 4)
  const data = new DataView(buffer)
  for (let i = 0; i < values.length; i++) data.setFloat32(i * 4, values[i], true)
  return arrayBufferToBase64(buffer)
}

function encodeUint32(values: Uint32Array): string {
  if (IS_LITTLE_ENDIAN) return arrayBufferToBase64(bytesForView(values))
  const buffer = new ArrayBuffer(values.length * 4)
  const data = new DataView(buffer)
  for (let i = 0; i < values.length; i++) data.setUint32(i * 4, values[i], true)
  return arrayBufferToBase64(buffer)
}

function decodeBase64Strict(value: unknown): ArrayBuffer | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null
  try {
    return base64ToArrayBuffer(value)
  } catch {
    return null
  }
}

function decodeFloat32(value: unknown): Float32Array | null {
  const buffer = decodeBase64Strict(value)
  if (!buffer || buffer.byteLength % 4 !== 0) return null
  if (IS_LITTLE_ENDIAN) return new Float32Array(buffer)
  const data = new DataView(buffer)
  const result = new Float32Array(buffer.byteLength / 4)
  for (let i = 0; i < result.length; i++) result[i] = data.getFloat32(i * 4, true)
  return result
}

function decodeUint32(value: unknown): Uint32Array | null {
  const buffer = decodeBase64Strict(value)
  if (!buffer || buffer.byteLength % 4 !== 0) return null
  if (IS_LITTLE_ENDIAN) return new Uint32Array(buffer)
  const data = new DataView(buffer)
  const result = new Uint32Array(buffer.byteLength / 4)
  for (let i = 0; i < result.length; i++) result[i] = data.getUint32(i * 4, true)
  return result
}

function decodeUint8(value: unknown): Uint8Array | null {
  const buffer = decodeBase64Strict(value)
  return buffer ? new Uint8Array(buffer) : null
}

/** Encode every field needed by rendering and face/edge selection. Invalid
 *  runtime data is omitted because this cache is optional; raw STEP stays required. */
export function encodeBrepModelPayload(
  value: unknown,
  sourceSha256: string,
  tessellation: stepCache.StepDisplayTessellation | null,
): PortableBrepModelPayloadV1 | null {
  const payload = validateBrepModelPayload(value)
  if (!payload || !SHA256_RE.test(sourceSha256)) return null
  if (tessellation && (!Number.isFinite(tessellation.linearDeflection)
    || !Number.isFinite(tessellation.angularDeflection)
    || tessellation.linearDeflection <= 0
    || tessellation.angularDeflection <= 0)) return null
  const encoded: PortableBrepModelPayloadV1 = {
    version: 1,
    encoding: 'base64-le',
    displayContractVersion: stepCache.STEP_DISPLAY_CONTRACT_VERSION,
    sourceSha256,
    tessellation,
    faceCount: payload.faceCount,
    edgeCount: payload.edgeCount,
    solidCount: payload.solidCount,
    bbox: { min: [...payload.bbox.min], max: [...payload.bbox.max] },
    mesh: {
      positions: encodeFloat32(payload.mesh.positions),
      normals: encodeFloat32(payload.mesh.normals),
      indices: encodeUint32(payload.mesh.indices),
      faceRanges: encodeUint32(payload.mesh.faceRanges),
      ...(payload.mesh.ao ? { ao: encodeFloat32(payload.mesh.ao) } : {}),
    },
    edges: {
      positions: encodeFloat32(payload.edges.positions),
      edgeRanges: encodeUint32(payload.edges.edgeRanges),
    },
    faceTypes: arrayBufferToBase64(bytesForView(payload.faceTypes)),
    ...(payload.mesh.ao ? { aoVersion: stepCache.STEP_DISPLAY_AO_VERSION } : {}),
  }
  const encodedBytes = encoded.mesh.positions.length
    + encoded.mesh.normals.length
    + encoded.mesh.indices.length
    + encoded.mesh.faceRanges.length
    + (encoded.mesh.ao?.length ?? 0)
    + encoded.edges.positions.length
    + encoded.edges.edgeRanges.length
    + encoded.faceTypes.length
  return encodedBytes <= MAX_PORTABLE_STEP_DISPLAY_BYTES ? encoded : null
}

/** Decode and validate before constructing viewport geometry. Any malformed or
 *  internally inconsistent field returns null so restore uses raw STEP instead. */
export function decodeBrepModelPayload(value: unknown): DecodedPortableBrepModelPayload | null {
  if (!isRecord(value)
    || value.version !== 1
    || value.encoding !== 'base64-le'
    || value.displayContractVersion !== stepCache.STEP_DISPLAY_CONTRACT_VERSION
    || typeof value.sourceSha256 !== 'string'
    || !SHA256_RE.test(value.sourceSha256)
    || !(value.tessellation === null || (isRecord(value.tessellation)
      && typeof value.tessellation.linearDeflection === 'number'
      && Number.isFinite(value.tessellation.linearDeflection)
      && value.tessellation.linearDeflection > 0
      && typeof value.tessellation.angularDeflection === 'number'
      && Number.isFinite(value.tessellation.angularDeflection)
      && value.tessellation.angularDeflection > 0))
    || !isCount(value.faceCount)
    || !isCount(value.edgeCount)
    || !isCount(value.solidCount)
    || !isRecord(value.bbox)
    || !isFiniteTuple3(value.bbox.min)
    || !isFiniteTuple3(value.bbox.max)
    || !isRecord(value.mesh)
    || !isRecord(value.edges)) {
    return null
  }
  const encodedFields = [
    value.mesh.positions,
    value.mesh.normals,
    value.mesh.indices,
    value.mesh.faceRanges,
    value.edges.positions,
    value.edges.edgeRanges,
    value.faceTypes,
    ...(typeof value.mesh.ao === 'string' ? [value.mesh.ao] : []),
  ]
  if (encodedFields.some((field) => typeof field !== 'string'
    || field.length > MAX_PORTABLE_STEP_DISPLAY_BYTES)) return null
  const encodedBytes = (encodedFields as string[]).reduce((sum, field) => sum + field.length, 0)
  if (encodedBytes > MAX_PORTABLE_STEP_DISPLAY_BYTES) return null
  const positions = decodeFloat32(value.mesh.positions)
  const normals = decodeFloat32(value.mesh.normals)
  const indices = decodeUint32(value.mesh.indices)
  const faceRanges = decodeUint32(value.mesh.faceRanges)
  const edgePositions = decodeFloat32(value.edges.positions)
  const edgeRanges = decodeUint32(value.edges.edgeRanges)
  const faceTypes = decodeUint8(value.faceTypes)
  const ao = value.aoVersion === stepCache.STEP_DISPLAY_AO_VERSION
    && typeof value.mesh.ao === 'string'
    ? decodeFloat32(value.mesh.ao)
    : null
  if (!positions || !normals || !indices || !faceRanges || !edgePositions || !edgeRanges || !faceTypes) {
    return null
  }
  const payload = validateBrepModelPayload({
    faceCount: value.faceCount,
    edgeCount: value.edgeCount,
    solidCount: value.solidCount,
    bbox: { min: value.bbox.min, max: value.bbox.max },
    mesh: { positions, normals, indices, faceRanges, ...(ao ? { ao } : {}) },
    edges: { positions: edgePositions, edgeRanges },
    faceTypes,
  })
  if (!payload) return null
  return {
    payload,
    sourceSha256: value.sourceSha256,
    tessellation: value.tessellation as stepCache.StepDisplayTessellation | null,
  }
}

/**
 * Read every root STL/STEP part's cached bytes and return them base64-encoded as a
 * ProjectBinaries map keyed by geometry id. Returns undefined when the project has
 * NO such parts (or no bytes could be embedded at all), so a 2D-only project's save
 * stays byte-identical to the pre-v4 form (no empty `binaries` field).
 *
 * WO-1884 (Rule 11): a part whose bytes are missing from this browser's cache does
 * NOT abort the save. It is skipped — the file is written without that part's bytes
 * — and the console names the part and the file to re-import. Every other part,
 * operation and setting is saved as usual. When all bytes are present the output is
 * identical to the pre-WO-1884 form.
 */
export async function collectProjectBinaries(
  geometry: ImportedGeometry[],
): Promise<ProjectBinaries | undefined> {
  const binaries: ProjectBinaries = {}
  let any = false
  for (const geo of geometry) {
    if (!needsBinary(geo)) continue
    const buf = geo.format === 'stl'
      ? await loadCachedSTL(geo.id)
      : await stepCache.loadCachedStep(geo.id)
    if (!buf) {
      // A cache miss must never cost the operator the rest of his project. Say
      // which part and which source file to re-import, then carry on.
      console.warn(
        operatorText('projectBinaries2', { value1: String(geo.name), value2: String(geo.filename) }),
      )
      continue
    }
    if (geo.format === 'stl') {
      binaries[geo.id] = { stl: arrayBufferToBase64(buf) }
    } else {
      const sourceSha256 = typeof stepCache.computeStepSha256 === 'function'
        ? await stepCache.computeStepSha256(buf)
        : null
      let displayRecord: {
        payload: unknown
        sourceSha256: string
        tessellation: stepCache.StepDisplayTessellation | null
        displayContractVersion: number
      } | undefined
      try {
        displayRecord = typeof modelClient.getBrepPayloadRecord === 'function'
          ? modelClient.getBrepPayloadRecord(geo.id)
          : undefined
        if (!displayRecord && typeof stepCache.loadCachedStepDisplay === 'function') {
          displayRecord = (await stepCache.loadCachedStepDisplay(geo.id)) ?? undefined
        }
      } catch {
        displayRecord = undefined
      }
      const encoded = sourceSha256
        && displayRecord?.sourceSha256 === sourceSha256
        && displayRecord.displayContractVersion === stepCache.STEP_DISPLAY_CONTRACT_VERSION
        ? encodeBrepModelPayload(
            displayRecord.payload, sourceSha256, displayRecord.tessellation,
          )
        : null
      binaries[geo.id] = {
        step: arrayBufferToBase64(buf),
        ...(encoded ? { stepDisplay: encoded } : {}),
      }
    }
    any = true
  }
  return any ? binaries : undefined
}

/**
 * WO-1898: a Model Item's 'import'/'meshImport' node replays from its OWN cache
 * key (a fresh copy minted when the CAM row was wrapped), which is not an id in
 * the project geometry collection - so collectProjectBinaries never embeds it
 * and a cold open (cleared cache, another PC) reopens the edited model with no
 * bodies.
 * Read every such cache key out of the given Model Item document archives and
 * embed its bytes into `binaries` (load side is generic: it repopulates whatever
 * id an entry is keyed by). Keys already embedded are left alone; a cache miss
 * is skipped with a console note (Rule 11, same as collectProjectBinaries).
 * Returns the map to save, or undefined when there is still nothing to embed.
 */
export async function embedModelItemImportBinaries(
  archives: ReadonlyArray<Uint8Array>,
  binaries: ProjectBinaries | undefined,
): Promise<ProjectBinaries | undefined> {
  const { loadDocumentArchive } = await import('../doc/persist')
  let out = binaries
  for (const archive of archives) {
    const { dag } = loadDocumentArchive(archive)
    for (const nodeId of dag.nodeIds()) {
      const node = dag.getNode(nodeId)
      if (node?.kind !== 'import' && node?.kind !== 'meshImport') continue
      const cacheKey = (node.payload as { cacheKey?: unknown } | undefined)?.cacheKey
      if (typeof cacheKey !== 'string' || out?.[cacheKey]) continue
      const buf = node.kind === 'meshImport'
        ? await loadCachedSTL(cacheKey)
        : await stepCache.loadCachedStep(cacheKey)
      if (!buf) {
        console.warn(
          operatorText('projectBinaries3', { value1: String(cacheKey) }),
        )
        continue
      }
      out = {
        ...out,
        [cacheKey]: node.kind === 'meshImport'
          ? { stl: arrayBufferToBase64(buf) }
          : { step: arrayBufferToBase64(buf) },
      }
    }
  }
  return out
}

/** ZIP uses the exact Save snapshot; originals never come from edited geometry
 * or display tessellation. Colliding imports keep their names in numbered
 * subfolders, while repeated references to identical source bytes share a file. */
export async function createProjectBundleZip(project: Project, projectFileName: string): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null)
  const leafName = (name: string): string => {
    const leaf = name.replace(/\0/g, '').split(/[\\/]/).pop() || 'original'
    return leaf === '.' || leaf === '..' ? 'original' : leaf
  }
  entries[leafName(projectFileName)] = strToU8(JSON.stringify(project, null, 2))
  entries['originals/'] = new Uint8Array()
  const originals: { leaf: string; bytes: Uint8Array }[] = []
  const addBytes = (name: string, bytes: Uint8Array): void => {
    originals.push({ leaf: leafName(name), bytes })
  }
  const addOriginal = (original: { fileName: string; dataUrl: string } | undefined): void => {
    // Crash-recovery image metadata can precede hydration, just as in
    // saveOriginalFile. Do not invent an empty source file on a cache miss.
    if (original?.dataUrl) addBytes(original.fileName, dataUrlToBytes(original.dataUrl).bytes)
  }
  const addBinary = (name: string, key: string, format: 'stl' | 'step'): void => {
    // Old IGES rows have converted STEP bytes, not their picked IGES source.
    if (/\.(igs|iges)$/i.test(name)) return
    const encoded = project.binaries?.[key]?.[format]
    if (encoded) addBytes(name, new Uint8Array(base64ToArrayBuffer(encoded)))
  }
  for (const geo of project.geometry) {
    if (geo.originalFile) addOriginal(geo.originalFile)
    else if (geo.format === 'stl' || geo.format === 'step') addBinary(geo.filename, geo.id, geo.format)
  }
  for (const image of project.referenceImages2d ?? []) addOriginal(image.payload.image)
  for (const font of Object.values(project.fonts ?? {})) addOriginal(fontOriginalFile(font))

  // Model-only imports and 3D reference/relief pictures are owned by the
  // document DAG, not the CAM geometry list. Include cold/pass-through archives
  // too; requiring the Model workspace to mount would lose those originals.
  const archives = [project.document, ...Object.values(project.modelItemDocuments ?? {})].filter(Boolean)
  const { loadDocumentArchive } = archives.length ? await import('../doc/persist') : { loadDocumentArchive: undefined }
  for (const encoded of archives) {
    if (!encoded) continue
    const { dag } = loadDocumentArchive!(base64ToArrayBuffer(encoded))
    for (const id of dag.nodeIds()) {
      const node = dag.getNode(id)!
      const payload = node.payload as { fileName?: string; cacheKey?: string; image?: { fileName: string; dataUrl: string } }
      addOriginal(payload.image)
      if ((node.kind === 'import' || node.kind === 'meshImport') && payload.fileName && payload.cacheKey) {
        addBinary(payload.fileName, payload.cacheKey, node.kind === 'meshImport' ? 'stl' : 'step')
      }
    }
  }
  // Reserve every root filename before allocating numbered folders. A source
  // named "2" can arrive after a duplicate has already needed a subfolder.
  const rootNames = new Set(originals.map(({ leaf }) => leaf.toLowerCase()))
  const paths = new Map<string, Uint8Array>()
  for (const { leaf, bytes } of originals) {
    for (let number = 1; ; number++) {
      if (number > 1 && rootNames.has(String(number))) continue
      const path = `originals/${number === 1 ? '' : `${number}/`}${leaf}`
      const key = path.toLowerCase()
      const existing = paths.get(key)
      if (!existing) {
        paths.set(key, bytes)
        entries[path] = bytes
        break
      }
      if (existing.length === bytes.length && existing.every((byte, i) => byte === bytes[i])) break
    }
  }
  return zipSync(entries)
}

/**
 * Re-populate the STL + STEP IndexedDB caches from an embedded ProjectBinaries map.
 * MUST run on load BEFORE the scene restore (restoreScene reads the caches). Keyed
 * by which field is present (stl/step), never by a geometry lookup, so it is robust
 * regardless of how the caller iterates geometry.
 */
export async function hydrateCachesFromBinaries(
  binaries: ProjectBinaries,
): Promise<void> {
  const writes: Promise<void>[] = []
  for (const [id, entry] of Object.entries(binaries)) {
    if (entry.stl) writes.push(cacheSTL(id, base64ToArrayBuffer(entry.stl)))
    if (entry.step) {
      writes.push((async () => {
        const raw = base64ToArrayBuffer(entry.step!)
        const sourceSha256 = typeof stepCache.computeStepSha256 === 'function'
          ? await stepCache.computeStepSha256(raw)
          : null
        const hasEmbeddedDisplay = entry.stepDisplay !== undefined
        const display = hasEmbeddedDisplay
          ? decodeBrepModelPayload(entry.stepDisplay)
          : null
        let preservedAoUpgrade = false
        const preserveMatchingAoUpgrade = sourceSha256
          && display?.sourceSha256 === sourceSha256
          && display.payload.mesh.ao === undefined
          ? (cached: stepCache.CachedStepDisplay) => {
              const candidate = validateBrepModelPayload(cached.payload)
              const expected = display.payload
              const sameTessellation = JSON.stringify(cached.tessellation)
                === JSON.stringify(display.tessellation)
              preservedAoUpgrade = cached.displayContractVersion
                  === stepCache.STEP_DISPLAY_CONTRACT_VERSION
                && cached.aoVersion === stepCache.STEP_DISPLAY_AO_VERSION
                && cached.sourceSha256 === sourceSha256
                && sameTessellation
                && candidate?.mesh.ao !== undefined
                && candidate.faceCount === expected.faceCount
                && candidate.edgeCount === expected.edgeCount
                && candidate.solidCount === expected.solidCount
                && candidate.mesh.positions.length === expected.mesh.positions.length
                && candidate.mesh.normals.length === expected.mesh.normals.length
                && candidate.mesh.indices.length === expected.mesh.indices.length
                && candidate.mesh.faceRanges.length === expected.mesh.faceRanges.length
                && candidate.edges.positions.length === expected.edges.positions.length
                && candidate.edges.edgeRanges.length === expected.edges.edgeRanges.length
              return preservedAoUpgrade
            }
          : undefined
        // Legacy files have raw STEP but no portable display. Preserve a
        // browser-local acceleration only when its contract, exact source
        // digest, and full selection payload all validate. An embedded display
        // is authoritative for this load, so absent/corrupt/mismatched embedded
        // data still invalidates the prior same-id record atomically.
        await stepCache.cacheStep(
          id,
          raw,
          preserveMatchingAoUpgrade ?? (!hasEmbeddedDisplay && sourceSha256
            ? (cached) => cached.displayContractVersion === stepCache.STEP_DISPLAY_CONTRACT_VERSION
              && cached.sourceSha256 === sourceSha256
              && validateBrepModelPayload(cached.payload) !== null
            : undefined),
        )
        if (!hasEmbeddedDisplay) return
        if (!sourceSha256 || !display || display.sourceSha256 !== sourceSha256) {
          return
        }
        if (preservedAoUpgrade) return
        // Optional acceleration: quota/size failure cannot block raw hydration.
        if (typeof stepCache.cacheStepDisplay === 'function') {
          await stepCache.cacheStepDisplay(
            id, display.payload, display.sourceSha256, display.tessellation,
          ).catch(() => {})
        }
      })())
    }
  }
  await Promise.all(writes)
}
