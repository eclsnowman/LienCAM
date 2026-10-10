// ============================================================
// Portable program-context envelope (WO-381)
// ============================================================
// Carries a compact subset of LienCAM setup intent through an exported G-code
// file as COMMENT-ONLY data written after normal program end, so a program
// that comes back through the raw-file loader can be bound to the same
// immutable ProgramContextV1 shape a direct setup load produces.
//
// Wire format (every line is a comment in the post's own comment syntax):
//
//   LCX1 v=1 n=<chunks> bytes=<payloadBytes>
//   LCX1 sha256=<payloadDigestHex>
//   LCX1 1/<n> <base64url>
//   ...
//   LCX1 <n>/<n> <base64url>
//   LCX1 end
//
// (The digest rides its own line: a single header carrying v/n/bytes AND a
// 64-hex digest is 102 characters in paren framing, over the 80-character
// limit every built-in post certifies; "( LCX1 sha256=<64 hex> )" is exactly 80.)
//
// Payload = canonical JSON (the digest's own byte rules, canonicalJson), UTF-8,
// NO compression in V1. The block is the last thing in the file (after the
// M30/M2 line); if the program ends with a closing '%' the block sits between
// the program end and that '%'.
//
// Advisory only. The block never changes motion: ordinary controllers discard
// comments, the streamer drops comment-only lines before sending, and the
// motion digest is computed over prepared executable lines so it is invariant
// to the block's presence.
//
// V1 (WO-381): one envelope = ONE setup (header `v=1`, payload `setup: {...}`).
// V2 (WO-412): one envelope = a SETUP LIST (header `v=2`, payload
// `setups: [...]`) for a combined export of several setups. A V1 reader
// refuses a V2 block with its existing sentence ("unknown LCX1 envelope
// version 2"); a V2 reader accepts both. A one-setup export still writes V1,
// byte for byte.

import {
  canonicalJson,
  isMultiSetupProgramContext,
  mintVerifiedExportContext,
  sha256Hex,
  PROGRAM_CONTEXT_SCHEMA,
  PROGRAM_CONTEXT_VERSION,
  PROGRAM_CONTEXT_VERSION_V2,
  type ProgramContextOperationDescriptor,
  type ProgramContextSetupSnapshot,
  type ProgramContextStockSnapshot,
  type ProgramContextTargetPartSnapshot,
  type ProgramContextV1,
  type ProgramContextWcsSnapshot,
} from '../machine/programContext'
import type { PostConfig } from './types'

export const PROGRAM_CONTEXT_ENVELOPE_TAG = 'LCX1' as const
export const PROGRAM_CONTEXT_ENVELOPE_VERSION = 1 as const
/** WO-412: the multi-setup wire version. */
export const PROGRAM_CONTEXT_ENVELOPE_VERSION_V2 = 2 as const
export type ProgramContextEnvelopeVersion = typeof PROGRAM_CONTEXT_ENVELOPE_VERSION | typeof PROGRAM_CONTEXT_ENVELOPE_VERSION_V2
/** The wire versions this reader accepts. A reader built for V1 alone is
 *  `[1]` (it refuses V2 with "unknown LCX1 envelope version 2"). */
export const PROGRAM_CONTEXT_ENVELOPE_READ_VERSIONS: ReadonlyArray<number> = [
  PROGRAM_CONTEXT_ENVELOPE_VERSION,
  PROGRAM_CONTEXT_ENVELOPE_VERSION_V2,
]
export const PROGRAM_CONTEXT_ENVELOPE_SCHEMA = 'liencam.program-context-envelope' as const

/** Hard limits, enforced on emit (refuse to emit) and on import (refuse to
 *  bind, load as an ordinary program). Each has a test. */
export const PROGRAM_CONTEXT_ENVELOPE_LIMITS = {
  /** Raw canonical-JSON payload bytes. */
  maxPayloadBytes: 64 * 1024,
  /** Chunk lines per block. */
  maxChunks: 512,
  /** Files larger than this are not scanned for a block at all. */
  maxFileBytes: 64 * 1024 * 1024,
  /** JSON nesting depth of the decoded payload (root object = depth 1). */
  maxDepth: 16,
  /** Any single JSON string value or key, in UTF-16 code units. */
  maxStringLength: 4 * 1024,
  /** Entries in any one array or object. */
  maxCollectionCount: 512,
  /** Controller line limit assumed when a post declares none. */
  defaultLineLength: 80,
} as const

/** The versioned wire payload. Compact by construction: it is exactly the
 *  ProgramContextV1 snapshot fields (stock, WCS, setup identity and notes,
 *  operation descriptors with source spans, post provenance, fingerprints,
 *  motion digest) - no project body, geometry bytes, scripts, macros, URLs or
 *  actions. `setup.notes` is included by default; the export toggle removes
 *  the whole block. */
export interface ProgramContextEnvelopePayloadV1 {
  readonly version: typeof PROGRAM_CONTEXT_ENVELOPE_VERSION
  readonly schemaName: typeof PROGRAM_CONTEXT_ENVELOPE_SCHEMA
  readonly project: { readonly id: string; readonly name: string }
  readonly setup: { readonly id: string; readonly name: string; readonly notes: string }
  readonly units: ProgramContextV1['units']
  readonly wcs: ProgramContextWcsSnapshot
  readonly stock: ProgramContextStockSnapshot
  readonly targetParts: ReadonlyArray<ProgramContextTargetPartSnapshot>
  readonly operations: ReadonlyArray<ProgramContextOperationDescriptor>
  readonly post: { readonly id: string; readonly label: string }
  readonly generatedAt: number
  readonly motionDigest: string
  readonly projectFingerprint: string
}

/** WO-412: one setup of a V2 payload - its own stock/WCS/parts/notes, its own
 *  operations (emitted order, verified spans; the owner is implied by nesting
 *  so `setupId` is not repeated on the wire) and its own intent digest. */
export interface ProgramContextEnvelopeSetup {
  readonly setup: { readonly id: string; readonly name: string; readonly notes: string }
  readonly wcs: ProgramContextWcsSnapshot
  readonly stock: ProgramContextStockSnapshot
  readonly targetParts: ReadonlyArray<ProgramContextTargetPartSnapshot>
  readonly operations: ReadonlyArray<ProgramContextOperationDescriptor>
  readonly projectFingerprint: string
}

/** WO-412: the multi-setup wire payload (`v=2`). */
export interface ProgramContextEnvelopePayloadV2 {
  readonly version: typeof PROGRAM_CONTEXT_ENVELOPE_VERSION_V2
  readonly schemaName: typeof PROGRAM_CONTEXT_ENVELOPE_SCHEMA
  readonly project: { readonly id: string; readonly name: string }
  readonly setups: ReadonlyArray<ProgramContextEnvelopeSetup>
  readonly units: ProgramContextV1['units']
  readonly post: { readonly id: string; readonly label: string }
  readonly generatedAt: number
  readonly motionDigest: string
  /** The digest over the setups' fingerprints (multiSetupProjectFingerprint). */
  readonly projectFingerprint: string
}

export type ProgramContextEnvelopePayload = ProgramContextEnvelopePayloadV1 | ProgramContextEnvelopePayloadV2

export type ProgramContextEnvelopeEncodeResult =
  | { ok: true; lines: string[]; payloadBytes: number; chunks: number; version: ProgramContextEnvelopeVersion; setupCount: number }
  | { ok: false; reason: string }

export type ProgramContextEnvelopeDecodeResult =
  | { ok: true; payload: ProgramContextEnvelopePayload; context: ProgramContextV1 }
  | { ok: false; status: 'absent' }
  | { ok: false; status: 'invalid'; reason: string }

// ---------------------------------------------------------------------------
// Payload <-> context
// ---------------------------------------------------------------------------

export function envelopePayloadFromContext(context: ProgramContextV1): ProgramContextEnvelopePayload {
  if (isMultiSetupProgramContext(context)) {
    return {
      version: PROGRAM_CONTEXT_ENVELOPE_VERSION_V2,
      schemaName: PROGRAM_CONTEXT_ENVELOPE_SCHEMA,
      project: { id: context.project.id, name: context.project.name },
      setups: context.setups.map((snapshot): ProgramContextEnvelopeSetup => ({
        setup: { id: snapshot.setup.id, name: snapshot.setup.name, notes: snapshot.notes },
        wcs: snapshot.wcs,
        stock: snapshot.stock,
        targetParts: snapshot.targetParts,
        operations: context.operations
          .filter((operation) => operation.setupId === snapshot.setup.id)
          .map(({ setupId: _owner, ...rest }) => rest),
        projectFingerprint: snapshot.projectFingerprint,
      })),
      units: context.units,
      post: { id: context.post.id, label: context.post.label },
      generatedAt: context.generatedAt,
      motionDigest: context.motionDigest,
      projectFingerprint: context.projectFingerprint,
    }
  }
  return {
    version: PROGRAM_CONTEXT_ENVELOPE_VERSION,
    schemaName: PROGRAM_CONTEXT_ENVELOPE_SCHEMA,
    project: { id: context.project.id, name: context.project.name },
    setup: { id: context.setup.id, name: context.setup.name, notes: context.notes },
    units: context.units,
    wcs: context.wcs,
    stock: context.stock,
    targetParts: context.targetParts,
    operations: context.operations,
    post: { id: context.post.id, label: context.post.label },
    generatedAt: context.generatedAt,
    motionDigest: context.motionDigest,
    projectFingerprint: context.projectFingerprint,
  }
}

/** The plain (not yet frozen/verified) ProgramContextV1 shape a payload
 *  describes, labelled verified-export. Structural validation happens at the
 *  boundary (mintVerifiedExportContext -> assertValidProgramContext). A V2
 *  payload becomes the version-2 context: the setup list, every operation in
 *  order stamped with its owner, the lead setup mirrored at the top level. */
export function contextFromEnvelopePayload(payload: ProgramContextEnvelopePayload): ProgramContextV1 {
  if (payload.version === PROGRAM_CONTEXT_ENVELOPE_VERSION_V2) {
    const setups = payload.setups.map((entry): ProgramContextSetupSnapshot => ({
      setup: { id: entry.setup.id, name: entry.setup.name },
      wcs: entry.wcs,
      stock: entry.stock,
      targetParts: entry.targetParts,
      notes: entry.setup.notes,
      projectFingerprint: entry.projectFingerprint,
    }))
    const operations: ProgramContextOperationDescriptor[] = []
    for (const entry of payload.setups) {
      for (const operation of entry.operations ?? []) operations.push({ ...operation, setupId: entry.setup.id })
    }
    const lead = setups[0]
    return {
      version: PROGRAM_CONTEXT_VERSION_V2,
      schemaName: PROGRAM_CONTEXT_SCHEMA,
      source: 'verified-export',
      project: { id: payload.project.id, name: payload.project.name },
      setup: lead.setup,
      units: payload.units,
      wcs: lead.wcs,
      stock: lead.stock,
      targetParts: lead.targetParts,
      notes: lead.notes,
      operations,
      post: { id: payload.post.id, label: payload.post.label },
      motionDigest: payload.motionDigest,
      projectFingerprint: payload.projectFingerprint,
      generatedAt: payload.generatedAt,
      setups,
    }
  }
  return {
    version: PROGRAM_CONTEXT_VERSION,
    schemaName: PROGRAM_CONTEXT_SCHEMA,
    source: 'verified-export',
    project: { id: payload.project.id, name: payload.project.name },
    setup: { id: payload.setup.id, name: payload.setup.name },
    units: payload.units,
    wcs: payload.wcs,
    stock: payload.stock,
    targetParts: payload.targetParts,
    notes: payload.setup.notes,
    operations: payload.operations,
    post: { id: payload.post.id, label: payload.post.label },
    motionDigest: payload.motionDigest,
    projectFingerprint: payload.projectFingerprint,
    generatedAt: payload.generatedAt,
  }
}

// ---------------------------------------------------------------------------
// base64url (RFC 4648 section 5, no padding)
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64URL_INDEX: Record<string, number> = {}
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL[i]] = i

export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63]
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63]
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63]
  }
  return out
}

/** Strict decode: only the base64url alphabet, no padding, no whitespace; a
 *  length of 4k+1 is impossible and refused. Returns null on any violation. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null
  const fullGroups = Math.floor(text.length / 4)
  const rem = text.length % 4
  const out = new Uint8Array(fullGroups * 3 + (rem === 0 ? 0 : rem - 1))
  let o = 0
  let i = 0
  const at = (k: number): number => {
    const v = B64URL_INDEX[text[k]]
    return v === undefined ? -1 : v
  }
  for (; i + 3 < text.length; i += 4) {
    const a = at(i), b = at(i + 1), c = at(i + 2), d = at(i + 3)
    if (a < 0 || b < 0 || c < 0 || d < 0) return null
    const n = (a << 18) | (b << 12) | (c << 6) | d
    out[o++] = (n >> 16) & 255
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  if (rem === 2) {
    const a = at(i), b = at(i + 1)
    if (a < 0 || b < 0) return null
    if ((b & 15) !== 0) return null // non-canonical trailing bits
    out[o++] = ((a << 18) | (b << 12)) >> 16 & 255
  } else if (rem === 3) {
    const a = at(i), b = at(i + 1), c = at(i + 2)
    if (a < 0 || b < 0 || c < 0) return null
    if ((c & 3) !== 0) return null
    const n = (a << 18) | (b << 12) | (c << 6)
    out[o++] = (n >> 16) & 255
    out[o++] = (n >> 8) & 255
  }
  return out
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/** The line limit the envelope wraps to for this post: the envelope
 *  capability's certified limit, else the post's declared controller limit,
 *  else 80. */
export function programContextEnvelopeLineLength(config: PostConfig): number {
  const declared = config.capabilities.programContextEnvelope?.maxLineLength
    ?? config.capabilities.maxLineLength
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? Math.floor(declared)
    : PROGRAM_CONTEXT_ENVELOPE_LIMITS.defaultLineLength
}

/** True when the post has declared the envelope certified. Absent = not
 *  ready = the export toggle is off and disabled. */
export function postSupportsProgramContextEnvelope(config: PostConfig): boolean {
  return config.capabilities.programContextEnvelope?.ready === true
}

function wrapComment(content: string, style: PostConfig['capabilities']['comment']): string {
  return style === 'semicolon' ? `; ${content}` : `( ${content} )`
}

/** Characters of comment framing per line for a style: "( " + " )" or "; ". */
function commentOverhead(style: PostConfig['capabilities']['comment']): number {
  return style === 'semicolon' ? 2 : 4
}

const UTF8_ENCODER = new TextEncoder()

/**
 * Encode a context as the comment-only LCX1 block for a post. Pure: returns
 * the lines to append, or a plain-language refusal (size caps, line limit too
 * short to carry a chunk). Never throws on a representable context.
 */
export function encodeProgramContextEnvelope(
  context: ProgramContextV1,
  config: PostConfig,
): ProgramContextEnvelopeEncodeResult {
  const payload = envelopePayloadFromContext(context)
  // Never emit what the importer would refuse: the parser limits bind here too.
  const limitViolation = findJsonLimitViolation(payload)
  if (limitViolation) {
    return { ok: false, reason: `the setup information exceeds a parser limit (${limitViolation})` }
  }
  const json = canonicalJson(payload)
  const bytes = UTF8_ENCODER.encode(json)
  if (bytes.length > PROGRAM_CONTEXT_ENVELOPE_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      reason: `the setup information is ${bytes.length} bytes, over the ${PROGRAM_CONTEXT_ENVELOPE_LIMITS.maxPayloadBytes}-byte limit`,
    }
  }
  const digest = sha256Hex(json)
  const encoded = base64urlEncode(bytes)
  const style = config.capabilities.comment
  const lineLength = programContextEnvelopeLineLength(config)
  const maxChunks = PROGRAM_CONTEXT_ENVELOPE_LIMITS.maxChunks
  // Fixed chunk width sized for the widest possible chunk prefix
  // ("LCX1 <n>/<n> " with n <= maxChunks) so every chunk line fits the limit
  // regardless of its index.
  const widestPrefix = `${PROGRAM_CONTEXT_ENVELOPE_TAG} ${maxChunks}/${maxChunks} `.length
  const chunkWidth = lineLength - commentOverhead(style) - widestPrefix
  if (chunkWidth < 8) {
    return {
      ok: false,
      reason: `the post's ${lineLength}-character line limit is too short to carry setup information`,
    }
  }
  const header = `${PROGRAM_CONTEXT_ENVELOPE_TAG} v=${payload.version} n=%N% bytes=${bytes.length}`
  const digestLine = wrapComment(`${PROGRAM_CONTEXT_ENVELOPE_TAG} sha256=${digest}`, style)
  if (wrapComment(header.replace('%N%', String(maxChunks)), style).length > lineLength || digestLine.length > lineLength) {
    return {
      ok: false,
      reason: `the post's ${lineLength}-character line limit is too short for the setup-information header`,
    }
  }
  const chunkCount = Math.max(1, Math.ceil(encoded.length / chunkWidth))
  if (chunkCount > maxChunks) {
    return {
      ok: false,
      reason: `the setup information needs ${chunkCount} comment lines, over the ${maxChunks}-line limit at this post's ${lineLength}-character line length`,
    }
  }
  const lines: string[] = [wrapComment(header.replace('%N%', String(chunkCount)), style), digestLine]
  for (let i = 0; i < chunkCount; i++) {
    const piece = encoded.slice(i * chunkWidth, (i + 1) * chunkWidth)
    lines.push(wrapComment(`${PROGRAM_CONTEXT_ENVELOPE_TAG} ${i + 1}/${chunkCount} ${piece}`, style))
  }
  lines.push(wrapComment(`${PROGRAM_CONTEXT_ENVELOPE_TAG} end`, style))
  return {
    ok: true,
    lines,
    payloadBytes: bytes.length,
    chunks: chunkCount,
    version: payload.version,
    setupCount: payload.version === PROGRAM_CONTEXT_ENVELOPE_VERSION_V2 ? payload.setups.length : 1,
  }
}

/**
 * Append the block to a finished program. It goes after the last line (the
 * program-end word, or the user's custom end); when the program closes with a
 * '%' marker the block goes before that marker. Preserves the program's
 * trailing-newline convention (PostResult.gcode ends with '\n').
 */
export function appendProgramContextEnvelope(gcode: string, blockLines: ReadonlyArray<string>): string {
  const trailingNewline = gcode.endsWith('\n')
  const body = trailingNewline ? gcode.slice(0, -1) : gcode
  const lines = body.length === 0 ? [] : body.split('\n')
  let insertAt = lines.length
  // A closing '%' (possibly followed by blank lines) stays last.
  let k = lines.length - 1
  while (k >= 0 && lines[k].trim() === '') k--
  if (k >= 0 && lines[k].trim() === '%') insertAt = k
  const out = [...lines.slice(0, insertAt), ...blockLines, ...lines.slice(insertAt)]
  return out.join('\n') + (trailingNewline ? '\n' : '')
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** The LCX1 content of a comment-only line in either comment style, else
 *  null. Accepts both styles on import: the file may come from any dialect and
 *  the streamer strips both. Only a line that is NOTHING but one comment counts. */
function envelopeLineContent(rawLine: string): string | null {
  const line = rawLine.trim()
  let content: string
  if (line.startsWith(';')) {
    content = line.slice(1).trim()
  } else if (line.startsWith('(') && line.endsWith(')') && line.indexOf(')') === line.length - 1) {
    content = line.slice(1, -1).trim()
  } else {
    return null
  }
  return content.startsWith(PROGRAM_CONTEXT_ENVELOPE_TAG + ' ') || content === PROGRAM_CONTEXT_ENVELOPE_TAG
    ? content
    : null
}

const HEADER_RE = /^LCX1 v=(\d+) n=(\d+) bytes=(\d+)$/
const DIGEST_RE = /^LCX1 sha256=([0-9a-f]{64})$/
const CHUNK_RE = /^LCX1 (\d+)\/(\d+) ([A-Za-z0-9_-]+)$/
const FOOTER = 'LCX1 end'

export type ProgramContextEnvelopeLimits = typeof PROGRAM_CONTEXT_ENVELOPE_LIMITS

/** Walk a decoded JSON value enforcing the nesting / string / collection
 *  limits. Returns a reason on the first violation, else null. */
function findJsonLimitViolation(
  value: unknown,
  depth = 1,
  path = '$',
  L: ProgramContextEnvelopeLimits = PROGRAM_CONTEXT_ENVELOPE_LIMITS,
): string | null {
  if (depth > L.maxDepth) return `nesting deeper than ${L.maxDepth} at ${path}`
  if (typeof value === 'string') {
    return value.length > L.maxStringLength ? `string longer than ${L.maxStringLength} at ${path}` : null
  }
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    if (value.length > L.maxCollectionCount) return `array of more than ${L.maxCollectionCount} entries at ${path}`
    for (let i = 0; i < value.length; i++) {
      const v = findJsonLimitViolation(value[i], depth + 1, `${path}[${i}]`, L)
      if (v) return v
    }
    return null
  }
  const keys = Object.keys(value as object)
  if (keys.length > L.maxCollectionCount) return `object of more than ${L.maxCollectionCount} keys at ${path}`
  for (const key of keys) {
    if (key.length > L.maxStringLength) return `key longer than ${L.maxStringLength} at ${path}`
    const v = findJsonLimitViolation((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`, L)
    if (v) return v
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Find and decode the LCX1 block in a raw program text. Does NOT verify the
 * motion digest against the program (that is the importer's job, below) and
 * does not freeze anything; it verifies framing, chunk count and order,
 * payload byte count and SHA-256, canonical form, parser limits, schema and
 * version, and that the payload has the shape of a context.
 */
export function decodeProgramContextEnvelope(
  text: string,
  /** Overridable so each limit can be exercised by a test without building a
   *  64 MiB string; production callers use the default. */
  L: ProgramContextEnvelopeLimits = PROGRAM_CONTEXT_ENVELOPE_LIMITS,
  /** The wire versions this reader accepts (WO-412). Production readers accept
   *  V1 and V2; a test pins a V1-only reader with `[1]` to prove it refuses a
   *  V2 block with the existing sentence. */
  acceptedVersions: ReadonlyArray<number> = PROGRAM_CONTEXT_ENVELOPE_READ_VERSIONS,
): ProgramContextEnvelopeDecodeResult {
  const invalid = (reason: string): ProgramContextEnvelopeDecodeResult => ({ ok: false, status: 'invalid', reason })
  if (text.length > L.maxFileBytes) {
    return invalid(`the file is larger than ${L.maxFileBytes} bytes, so it was not scanned for setup information`)
  }
  const rawLines = text.split(/\r?\n/)
  const entries: string[] = []
  for (const raw of rawLines) {
    const content = envelopeLineContent(raw)
    if (content !== null) entries.push(content)
  }
  if (entries.length === 0) return { ok: false, status: 'absent' }

  const headers = entries.filter((e) => e.startsWith('LCX1 v='))
  if (headers.length === 0) return invalid('LCX1 lines are present but no header line was found')
  if (headers.length > 1) return invalid(`${headers.length} LCX1 header lines were found; a file may carry exactly one block`)
  const footers = entries.filter((e) => e === FOOTER)
  if (footers.length !== 1) return invalid(footers.length === 0 ? 'the LCX1 block has no end line (truncated)' : 'more than one LCX1 end line was found')
  const headerIndex = entries.indexOf(headers[0])
  const footerIndex = entries.indexOf(FOOTER)
  if (headerIndex !== 0 || footerIndex !== entries.length - 1) {
    return invalid('LCX1 lines were found outside the header..end block')
  }
  const headerMatch = HEADER_RE.exec(headers[0])
  if (!headerMatch) return invalid('the LCX1 header line is malformed')
  const version = Number(headerMatch[1])
  if (!acceptedVersions.includes(version)) return invalid(`unknown LCX1 envelope version ${version}`)
  const declaredChunks = Number(headerMatch[2])
  const declaredBytes = Number(headerMatch[3])
  const digestLines = entries.filter((e) => e.startsWith('LCX1 sha256='))
  if (digestLines.length !== 1 || entries[1] !== digestLines[0]) {
    return invalid(digestLines.length === 0 ? 'the LCX1 block has no digest line' : 'the LCX1 digest line is missing, repeated or misplaced')
  }
  const digestMatch = DIGEST_RE.exec(digestLines[0])
  if (!digestMatch) return invalid('the LCX1 digest line is malformed')
  const declaredDigest = digestMatch[1]
  if (!Number.isInteger(declaredChunks) || declaredChunks < 1 || declaredChunks > L.maxChunks) {
    return invalid(`the LCX1 header declares ${declaredChunks} chunks; the limit is ${L.maxChunks}`)
  }
  if (!Number.isInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > L.maxPayloadBytes) {
    return invalid(`the LCX1 header declares ${declaredBytes} payload bytes; the limit is ${L.maxPayloadBytes}`)
  }
  const chunkEntries = entries.slice(2, -1)
  if (chunkEntries.length !== declaredChunks) {
    return invalid(`the LCX1 block has ${chunkEntries.length} chunk lines but the header declares ${declaredChunks} (truncated or tampered)`)
  }
  // Bound the decode work before doing it: base64url of the declared bytes.
  const maxEncodedLength = Math.ceil(declaredBytes / 3) * 4
  let encoded = ''
  for (let i = 0; i < chunkEntries.length; i++) {
    const m = CHUNK_RE.exec(chunkEntries[i])
    if (!m) return invalid(`LCX1 chunk line ${i + 1} is malformed`)
    if (Number(m[1]) !== i + 1 || Number(m[2]) !== declaredChunks) {
      return invalid(`LCX1 chunk lines are out of order or mislabelled at chunk ${i + 1}`)
    }
    encoded += m[3]
    if (encoded.length > maxEncodedLength) return invalid('the LCX1 block carries more data than its header declares')
  }
  const bytes = base64urlDecode(encoded)
  if (bytes === null) return invalid('the LCX1 payload is not valid base64url')
  if (bytes.length !== declaredBytes) {
    return invalid(`the LCX1 payload decodes to ${bytes.length} bytes but the header declares ${declaredBytes}`)
  }
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return invalid('the LCX1 payload is not valid UTF-8')
  }
  if (sha256Hex(json) !== declaredDigest) return invalid('the LCX1 payload digest does not match its header (tampered or corrupted)')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return invalid('the LCX1 payload is not valid JSON')
  }
  const limitViolation = findJsonLimitViolation(parsed, 1, '$', L)
  if (limitViolation) return invalid(`the LCX1 payload exceeds a parser limit: ${limitViolation}`)
  let canonicalForm: string
  try {
    canonicalForm = canonicalJson(parsed)
  } catch (err) {
    return invalid(`the LCX1 payload is not canonical: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (canonicalForm !== json) return invalid('the LCX1 payload is not in canonical form')
  if (!isRecord(parsed)) return invalid('the LCX1 payload is not an object')
  if (parsed.version !== version) return invalid(`unknown LCX1 payload version ${String(parsed.version)}`)
  if (parsed.schemaName !== PROGRAM_CONTEXT_ENVELOPE_SCHEMA) return invalid(`unknown LCX1 payload schema ${String(parsed.schemaName)}`)
  if (!isRecord(parsed.project) || !isRecord(parsed.post)) {
    return invalid('the LCX1 payload is missing its setup, project or post')
  }
  if (version === PROGRAM_CONTEXT_ENVELOPE_VERSION_V2) {
    const setups = parsed.setups
    if (!Array.isArray(setups) || setups.length < 1
      || !setups.every((entry) => isRecord(entry) && isRecord(entry.setup) && typeof entry.setup.notes === 'string' && Array.isArray(entry.operations))) {
      return invalid('the LCX1 payload is missing its setup list')
    }
  } else if (!isRecord(parsed.setup) || typeof parsed.setup.notes !== 'string') {
    return invalid('the LCX1 payload is missing its setup, project or post')
  }
  const payload = parsed as unknown as ProgramContextEnvelopePayload
  return { ok: true, payload, context: contextFromEnvelopePayload(payload) }
}

export interface ProgramContextImportResult {
  /** A frozen, verified-export context bound to `text`, or null. */
  context: ProgramContextV1 | null
  /** Plain-language reason the file loads as an ordinary no-context program.
   *  null when the file simply carries no block, or when import succeeded. */
  warning: string | null
}

/**
 * The raw-file loader's entry point: recover a verified context from a
 * program text BEFORE the streamer strips comments. On ANY failure (missing,
 * malformed, oversized, duplicate, digest mismatch, unknown version) the result
 * is null context - the file still loads as an ordinary program - with one
 * advisory warning when a block was present but refused.
 */
export function importProgramContextFromGcode(text: string): ProgramContextImportResult {
  const decoded = decodeProgramContextEnvelope(text)
  if (!decoded.ok) {
    return {
      context: null,
      warning: decoded.status === 'absent' ? null : `Ignoring the LienCAM setup information in this file: ${decoded.reason}. The program loads without it.`,
    }
  }
  try {
    return { context: mintVerifiedExportContext(decoded.context, text), warning: null }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      context: null,
      warning: `Ignoring the LienCAM setup information in this file: ${detail} The program loads without it.`,
    }
  }
}
