// programContext - the frozen, session-owned manufacturing-intent snapshot
// bound to an exact loaded G-code program (WO-379).
//
// This is ADVISORY data only. It explains and compares; it never resets, homes,
// unlocks, arms, starts, holds, resumes, stops, probes, writes offsets, selects
// tools, or alters streamed lines. The parsed G-code and the streamer's own
// executable-line rules remain the sole motion authority.
//
// Immutability is enforced at the store boundary (freezeProgramContext) AND by
// buildProgramContext, both of which deep-copy into freshly-frozen plain values,
// so a caller cannot mutate nested data through a retained reference and a later
// live-project edit cannot reach back into a stored snapshot.

import type { ImportedGeometry, MachineConfig, Operation, Project, PhysicalStock, Setup, Tool } from '../../types'
import type { EmittedOperationSpan, PostConfig } from '../post/types'
import { isSendableGcodeLine, prepareProgram } from '../gcode/text'
import type { StreamerPhase } from './controller'
import { resolveSetupWorkOffset, WorkOffsetResolutionError } from '../post/workOffsets'
import { buildPostInput } from '../post/buildPostInput'
import {
  checkJobAgainstMachine,
  type TransferCheckJob,
  type TransferCheckResult,
  type TransferWorkOffset,
  type TransferWorkOffsetTable,
} from './transferCheck'
import { buildPreviewModel } from './previewGeometry'
import { isGrblFamily } from './machineChoice'

export const PROGRAM_CONTEXT_VERSION = 1 as const
/** WO-412: the multi-setup shape. Same schema name, same boundary; the
 *  snapshot additionally carries `setups` (see ProgramContextSetupSnapshot). */
export const PROGRAM_CONTEXT_VERSION_V2 = 2 as const
export type ProgramContextVersion = typeof PROGRAM_CONTEXT_VERSION | typeof PROGRAM_CONTEXT_VERSION_V2
export const PROGRAM_CONTEXT_SCHEMA = 'liencam-program-context' as const

/**
 * Where the snapshot came from. 'live-setup' is a direct post from the open
 * project (WO-379). 'verified-export' is a context recovered from the LCX1
 * envelope of a LienCAM-exported file whose payload digest, schema and motion
 * digest all verified (WO-381; minted only by mintVerifiedExportContext).
 * 'foreign' is reserved and refused at the boundary.
 */
export type ProgramContextSource = 'live-setup' | 'verified-export' | 'foreign'

/** One operation/section actually emitted by the postprocessor, in emitted
 *  order, with its verified source-line span. Repeated sections (nest expansion)
 *  appear as repeated entries sharing the same opId. */
export interface ProgramContextOperationDescriptor {
  readonly id: string
  readonly name: string
  readonly type: Operation['type']
  readonly toolId: string
  readonly tool: {
    readonly id: string
    readonly name: string
    readonly toolNumber: number | null
    readonly type: Tool['type']
    readonly diameter: number
    readonly cutHand: Tool['cutHand'] | null
  }
  readonly status: Operation['status']
  readonly generationFingerprint: string | null
  /** 1-based, inclusive line numbers in the RAW generated G-code text. */
  readonly startLine: number
  readonly endLine: number
  /** WO-412: the id of the listed setup that owns this operation. Present on
   *  every descriptor of a version-2 (multi-setup) context and REQUIRED there;
   *  absent on a version-1 context (whose single `setup` owns every span). */
  readonly setupId?: string
}

/** Compact snapshot of the physical stock the setup was resolved against. */
export interface ProgramContextStockSnapshot {
  readonly provenance: 'physical' | 'authored'
  readonly coordinateSpace: 'world' | 'setup-wcs'
  readonly id: string
  readonly name: string
  readonly mode: PhysicalStock['mode'] | 'authored'
  readonly primitive: Setup['stock']['type']
  readonly material: string
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly bounds: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number }
    readonly max: { readonly x: number; readonly y: number; readonly z: number }
  }
  /** The work offset this program was POSTED with - the resolved one, identical
   *  to `wcs.fixtureOffset` (WO-398: one snapshot, one offset). A physical
   *  stock's own assignment, or its absence, is captured by `fingerprint`. */
  readonly fixtureOffset: number
  readonly authored: {
    readonly type: Setup['stock']['type']
    readonly width: number | null
    readonly height: number | null
    readonly depth: number | null
    readonly diameter: number | null
    readonly length: number | null
    readonly offsetX: number
    readonly offsetY: number
    readonly offsetZTop: number
    readonly offsetZBottom: number
  }
  /** SHA-256 of the complete resolved + authored stock intent used by posting. */
  readonly fingerprint: string
}

/** Compact display proxy for one target part owned by the setup's stock. */
export interface ProgramContextTargetPartSnapshot {
  readonly id: string
  readonly name: string
  readonly format: ImportedGeometry['format']
  readonly bounds: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number }
    readonly max: { readonly x: number; readonly y: number; readonly z: number }
  }
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly rotation: { readonly x: number; readonly y: number; readonly z: number }
}

/** The work-offset snapshot a setup was posted with. */
export interface ProgramContextWcsSnapshot {
  readonly id: string
  readonly label: string
  readonly fixtureOffset: number
  readonly origin: { readonly x: number; readonly y: number; readonly z: number }
}

/** WO-412: ONE setup of a multi-setup (version 2) context - its own stock,
 *  WCS, target parts, notes and intent digest. Its operations are the
 *  top-level `operations` entries whose `setupId` is this setup's id (in
 *  emitted order, contiguous, the setups in the order they were emitted). */
export interface ProgramContextSetupSnapshot {
  readonly setup: { readonly id: string; readonly name: string }
  readonly wcs: ProgramContextWcsSnapshot
  readonly stock: ProgramContextStockSnapshot
  readonly targetParts: ReadonlyArray<ProgramContextTargetPartSnapshot>
  readonly notes: string
  /** This setup's own intent digest - the same bytes a version-1 context of
   *  this setup alone would carry - so the comparison verdict is per setup. */
  readonly projectFingerprint: string
}

/** The immutable run-context snapshot bound to a directly-posted program.
 *
 *  V1 BOUNDARY (WO-397): `version: 1` = one program, ONE setup. `setup` is a
 *  single setup, `buildProgramContext` takes a single Setup, and every emitted
 *  span must be owned by it (`validateEmittedOperationSpans` refuses any other
 *  setupId, by name). `loadFromSetup` posts exactly [setup] in combined mode.
 *
 *  V2 (WO-412, Operator 2026-08-20 "Yes I want multi setup eventually"):
 *  `version: 2` = one program, SEVERAL setups, listed in `setups` in emitted
 *  order. `operations` is every emitted operation of the whole program in
 *  order, each carrying the `setupId` of its owner; the top-level `setup`,
 *  `wcs`, `stock`, `targetParts` and `notes` are the LEAD (first emitted)
 *  setup's, so a reader that only knows the one-setup shape still sees a true
 *  statement about the start of the program (use `setupAtSourceLine` /
 *  `compareProgramContextPerSetup` for the rest). `projectFingerprint` is the
 *  digest over the per-setup fingerprints, in order. The boundary
 *  (`assertValidProgramContext`) refuses a version-1 context that carries
 *  `setups` and a version-2 context that does not - nothing V1 refused today
 *  is accepted under V2. */
export interface ProgramContextV1 {
  readonly version: ProgramContextVersion
  readonly schemaName: typeof PROGRAM_CONTEXT_SCHEMA
  readonly source: ProgramContextSource
  readonly project: { readonly id: string; readonly name: string }
  readonly setup: { readonly id: string; readonly name: string }
  readonly units: PostConfig['format']['units']
  readonly wcs: ProgramContextWcsSnapshot
  readonly stock: ProgramContextStockSnapshot
  readonly targetParts: ReadonlyArray<ProgramContextTargetPartSnapshot>
  readonly notes: string
  readonly operations: ReadonlyArray<ProgramContextOperationDescriptor>
  readonly post: { readonly id: string; readonly label: string }
  /** Canonical SHA-256 digest of the executable motion (comments/blanks/percent
   *  excluded), identified as "sha256:<hex>". */
  readonly motionDigest: string
  /** SHA-256 digest ("sha256:<hex>") of the complete manufacturing intent that
   *  produced the program, used to detect live-project drift after loading. */
  readonly projectFingerprint: string
  readonly generatedAt: number
  /** WO-412: present (and non-empty) iff `version` is 2. */
  readonly setups?: ReadonlyArray<ProgramContextSetupSnapshot>
}

/** Prepare the transfer-check job at the program boundary. The shared path
 * builder is the ONE parser of a program on the Control side (WO-1075), so
 * every fact this check judges - travel, per-move feeds, canned-cycle plunges,
 * spindle speed - comes off its move list. Nothing here reads the text. */
export function transferCheckJobFromProgram(
  programText: string,
  postedFor?: TransferCheckJob['postedFor'],
): TransferCheckJob {
  const preview = buildPreviewModel(programText)
  return {
    moves: preview.moves,
    addressedAxes: preview.addressedAxes,
    machineCoordinateRanges: preview.machineCoordinateRanges,
    spindleRpmMax: preview.spindleRpmMax,
    postedFor,
  }
}

/** Run the load-time transfer check from the exact text and frozen source
 * machine identity when one exists. Travel and speed checks need only the
 * program text and Control machine, so context-less direct loads still run;
 * only the source-controller comparison waits for a trustworthy declaration. */
export function checkProgramContextAgainstMachine(
  context: ProgramContextV1 | null | undefined,
  programText: string,
  machine: MachineConfig,
  workOffset: TransferWorkOffset | TransferWorkOffsetTable | null | undefined,
  sourceMachine?: Pick<MachineConfig, 'id' | 'name' | 'controller'> | null,
): TransferCheckResult {
  const declaredController = context?.post.id
  const controller = declaredController === 'uccnc' || isGrblFamily(declaredController)
    || declaredController === 'linuxcnc' || declaredController === 'generic'
    ? declaredController
    : null
  return checkJobAgainstMachine(transferCheckJobFromProgram(
    programText,
    controller
      ? {
          id: sourceMachine?.id ?? context?.project.id ?? 'posted-program',
          name: sourceMachine?.name ?? context?.post.label ?? controller,
          controller,
        }
      : undefined,
  ), machine, workOffset)
}

/** WO-412: the multi-setup narrowing of the context shape. */
export type ProgramContextV2 = ProgramContextV1 & {
  readonly version: typeof PROGRAM_CONTEXT_VERSION_V2
  readonly setups: ReadonlyArray<ProgramContextSetupSnapshot>
}

/** WO-412: true for a version-2 context that lists several setups. */
export function isMultiSetupProgramContext(context: ProgramContextV1 | null | undefined): context is ProgramContextV2 {
  return !!context && context.version === PROGRAM_CONTEXT_VERSION_V2 && Array.isArray(context.setups)
}

/** WO-412: the setups a context binds, in emitted order - one entry for a
 *  version-1 context (its single setup), the list for version 2. */
export function programContextSetups(context: ProgramContextV1): ReadonlyArray<ProgramContextSetupSnapshot> {
  if (isMultiSetupProgramContext(context)) return context.setups
  return [{
    setup: context.setup,
    wcs: context.wcs,
    stock: context.stock,
    targetParts: context.targetParts,
    notes: context.notes,
    projectFingerprint: context.projectFingerprint,
  }]
}

/** WO-412: the Control chip text: "Setup: A (G54)" for one setup,
 *  "Setup: A -> B (G54, G55)" for several. */
export function programContextSetupChipLabel(context: ProgramContextV1): string {
  const setups = programContextSetups(context)
  return `Setup: ${setups.map((s) => s.setup.name).join(' -> ')} (${setups.map((s) => s.wcs.label).join(', ')})`
}

/** What a loaded program's context says against the live project.
 *  'no-context'      - the program carries no snapshot (a foreign file, a disk
 *                      load): the app knows nothing about it. NEVER 'current'.
 *  'current'         - verified: motion matches and the intent digest agrees.
 *  'project-changed' - the project (identity, setup, intent or post) moved on.
 *  'program-changed' - the program text no longer matches its snapshot. */
export type ProgramContextComparison = 'no-context' | 'current' | 'project-changed' | 'program-changed'

// ---------------------------------------------------------------------------
// SHA-256 (pure, deterministic, browser + Node compatible). FIPS 180-4.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/** Lowercase hex SHA-256 digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const blockCount = ((bytes.length + 8) >> 6) + 1
  const padded = new Uint8Array(blockCount * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padded.length - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + SHA256_K[t] + w[t]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// Canonicalization + digests
// ---------------------------------------------------------------------------

/** Thrown when an intent input cannot be represented losslessly in the digest.
 *  A change detector's one forbidden failure is silent agreement (WO-398):
 *  rather than flattening a value to `{}` - where two different values would
 *  hash identically - the digest refuses, naming the type and the key path. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

function canonical(value: unknown, path = '$', ancestors: Set<object> = new Set()): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Infinity) return 'Infinity'
    if (value === -Infinity) return '-Infinity'
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new CanonicalizationError(`Cannot digest a ${typeof value} at ${path}.`)
  }
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) {
    throw new CanonicalizationError(`Cannot digest a cyclic structure (revisited at ${path}).`)
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) throw new CanonicalizationError(`Cannot digest a DataView at ${path}.`)
    return Array.from(value as unknown as ArrayLike<number>)
  }
  // Anything that is not a plain object or an array would fall through to
  // Object.keys(): a Map, a Set, a Date, a raw ArrayBuffer, a class instance with
  // state outside its own enumerable keys - all of them read as {} and two
  // different values agree. Refuse by name instead.
  if (value instanceof Map || value instanceof Set || value instanceof Date
    || value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
    || value instanceof RegExp || value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
    throw new CanonicalizationError(`Cannot digest a ${value.constructor.name} at ${path}; only plain objects, arrays, typed arrays and primitives are representable.`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry, index) => canonical(entry, `${path}[${index}]`, ancestors))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(`Cannot digest a ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain'} instance at ${path}; only plain objects are representable.`)
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined) continue
      out[key] = canonical(entry, `${path}.${key}`, ancestors)
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/** Canonical JSON: sorted keys, undefined dropped, -0 -> 0, non-finite numbers
 *  as strings, every unrepresentable value refused by name. The digest's byte
 *  rules, shared with the WO-381 envelope so its payload hashes the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function copyVec3(value: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: value.x, y: value.y, z: value.z }
}

/** The canonical prepared executable motion the streamer acts on: every
 *  sendable line, comments stripped, blanks and percent markers dropped. */
function preparedMotion(gcode: string): string {
  return prepareProgram(gcode).lines.map((line) => line.text).join('\n')
}

/**
 * Canonical SHA-256 digest of executable motion, identified as "sha256:<hex>".
 * Reuses the streamer's own line rules (prepareProgram), so comment-only,
 * blank-line, surrounding-whitespace, and percent-marker changes never change
 * it, while any change to the exact executable lines does.
 */
export function computeMotionDigest(gcode: string): string {
  return `sha256:${sha256Hex(preparedMotion(gcode))}`
}

// ---------------------------------------------------------------------------
// Manufacturing-intent fingerprint (drift detection)
// ---------------------------------------------------------------------------

interface IntentOperation {
  id: string
  name: string
  type: string
  enabled: boolean
  toolId: string
  status: string
  generationFingerprint: string | null
  folderId: string | null
  geometrySelections: unknown
  modelReferences: unknown
  heights: unknown
  smartHeight: unknown
  resolvedHeights: unknown
  resolvedHeightPlan: unknown
  passes: unknown
  linking: unknown
  feedrateOverride: unknown
  params: unknown
  tool: Tool | null
  feeds: unknown
  spindle: unknown
  coolant: unknown
  nestExpanded: boolean
  moveDigest: string
}

interface ProgramIntentInputs {
  project: { id: string; name: string }
  setup: { id: string; name: string; notes: string; flipOf: unknown }
  wcs: unknown
  stock: { resolved: PhysicalStock | null; authored: unknown; material: string }
  machine: unknown
  sceneStock: unknown
  targetParts: ProgramContextTargetPartSnapshot[]
  post: unknown
  operations: IntentOperation[]
}

/** The top-level project fields the intent digest READS, by reference, plus the
 *  live tool library (WO-396). A consumer that re-runs `compareProgramContext`
 *  may key its memo on exactly this tuple: when none of these references moved,
 *  `programIntentInputs` provably produces the same bytes (it reads nothing else
 *  of the project - pinned by a Proxy test that records every property read), so
 *  a click that only changes `activeSetupId` / `activeOperationId` re-hashes
 *  nothing. The tuple is a cache KEY over references, never a stored claim: a
 *  real edit replaces one of these references and the true digest is recomputed.
 *  Keep in step with programIntentInputs / buildPostInput / targetPartSnapshots. */
export function programIntentIdentity(project: Project, toolLibrary: Project['toolLibrary']): readonly unknown[] {
  return [
    project.id,
    project.name,
    project.setups,
    project.stocks,
    project.machine,
    project.geometry,
    project.nests,
    project.sceneStock,
    toolLibrary,
    // WO-2637: per-program tool numbers change what buildPostInput posts.
    project.postToolNumbers,
  ]
}
/** The project fields `programIntentIdentity` covers, for the read-set test. */
export const PROGRAM_INTENT_PROJECT_FIELDS: ReadonlyArray<keyof Project> = [
  'id', 'name', 'setups', 'stocks', 'machine', 'geometry', 'nests', 'sceneStock', 'toolLibrary', 'postToolNumbers',
]

/** The machine as the POST reads it. The tool table's measured lengths and the
 *  probe choices are the operator's shop-floor records on the same definition:
 *  no post reads them, and the Control tab writes them while a program is
 *  loaded (measuring a tool; WO-1978's load filling the table with the
 *  program's own tools). Hashing them marked a just-loaded LienCAM file
 *  "Setup changed since post" the moment its tools reached the table. */
function postedMachine(machine: MachineConfig): Omit<MachineConfig, 'toolTable' | 'probeOverrides' | 'probePads' | 'activeProbePadId'> {
  const { toolTable: _toolTable, probeOverrides: _probeOverrides, probePads: _probePads, activeProbePadId: _activeProbePadId, ...posted } = machine
  return posted
}

/** Derive the canonical intent inputs from the live project + resolved setup +
 *  post config. Shared by buildProgramContext and compareProgramContext so both
 *  hash the identical, order-stable bytes. */
function programIntentInputs(project: Project, setup: Setup, post: PostConfig): ProgramIntentInputs {
  const resolved = resolveSetupWorkOffset(project, setup)
  const stock =
    resolved.stockId === undefined
      ? null
      : (project.stocks ?? []).find((candidate) => candidate.id === resolved.stockId) ?? null

  // Rebuild the same resolved PostInput used by emission. This captures actual
  // nest-expanded section order and coordinates, resolved tools/feeds/spindle/
  // coolant, and the post freshness downgrade. It avoids trusting a stored
  // generation claim or raw setup order when either differs from what posts.
  const postInput = buildPostInput(project, setup)
  const operations = postInput.setup.operations
    .map(({ op: operation, tool, feeds, spindle, coolant, moves, nestExpanded }): IntentOperation => ({
      id: operation.id,
      name: operation.name,
      type: operation.type,
      enabled: operation.enabled,
      toolId: operation.toolId,
      status: operation.status,
      generationFingerprint: operation.generationFingerprint ?? null,
      folderId: operation.folderId ?? null,
      geometrySelections: operation.geometrySelections,
      modelReferences: operation.modelReferences,
      heights: operation.heights,
      smartHeight: operation.smartHeight,
      resolvedHeights: operation.resolvedHeights,
      resolvedHeightPlan: operation.resolvedHeightPlan,
      passes: operation.passes,
      linking: operation.linking,
      feedrateOverride: operation.feedrateOverride,
      params: operation.params,
      tool,
      feeds,
      spindle,
      coolant,
      nestExpanded: nestExpanded === true,
      moveDigest: `sha256:${sha256Hex(canonicalJson(moves))}`,
    }))

  return {
    project: { id: project.id, name: project.name },
    setup: { id: setup.id, name: setup.name, notes: setup.notes, flipOf: setup.flipOf },
    wcs: resolved.setup.wcs,
    stock: { resolved: stock, authored: setup.stock, material: setup.stock?.material ?? '' },
    machine: postedMachine(postInput.machine),
    sceneStock: project.sceneStock,
    targetParts: targetPartSnapshots(project, resolved.stockId),
    post,
    operations,
  }
}

function targetPartSnapshots(
  project: Project,
  stockId: string | undefined,
): ProgramContextTargetPartSnapshot[] {
  return project.geometry
    .filter((geometry) =>
      stockId === undefined ? geometry.stockId === undefined : geometry.stockId === stockId)
    .map((geometry) => ({
      id: geometry.id,
      name: geometry.name,
      format: geometry.format,
      bounds: {
        min: copyVec3(geometry.boundingBox.min),
        max: copyVec3(geometry.boundingBox.max),
      },
      position: copyVec3(geometry.position),
      rotation: copyVec3(geometry.rotation),
    }))
}

function authoredStockSnapshot(setup: Setup): ProgramContextStockSnapshot['authored'] {
  const stock = setup.stock
  return {
    type: stock.type,
    width: stock.width ?? null,
    height: stock.height ?? null,
    depth: stock.depth ?? null,
    diameter: stock.diameter ?? null,
    length: stock.length ?? null,
    offsetX: stock.offsetX ?? 0,
    offsetY: stock.offsetY ?? 0,
    offsetZTop: stock.offsetZTop ?? 0,
    offsetZBottom: stock.offsetZBottom ?? 0,
  }
}

function authoredStockBounds(setup: Setup): ProgramContextStockSnapshot['bounds'] {
  const stock = setup.stock
  if (stock.type === 'cylindrical') {
    const radius = Math.max(0, stock.diameter ?? 0) / 2
    const length = Math.max(0, stock.length ?? 0)
    return {
      min: { x: -radius, y: -radius, z: 0 },
      max: { x: radius, y: radius, z: length },
    }
  }
  return {
    min: { x: 0, y: 0, z: 0 },
    max: {
      x: Math.max(0, stock.width ?? 0),
      y: Math.max(0, stock.height ?? 0),
      z: Math.max(0, stock.depth ?? 0),
    },
  }
}

function stockSnapshot(
  setup: Setup,
  stock: PhysicalStock | null,
  fixtureOffset: number,
): ProgramContextStockSnapshot {
  const authored = authoredStockSnapshot(setup)
  const fingerprint = `sha256:${sha256Hex(canonicalJson({ resolved: stock, authored: setup.stock }))}`
  if (stock === null) {
    return {
      provenance: 'authored',
      coordinateSpace: 'setup-wcs',
      id: `setup-stock:${setup.id}`,
      name: `${setup.name} stock`,
      mode: 'authored',
      primitive: setup.stock.type,
      material: setup.stock.material,
      position: { x: 0, y: 0, z: 0 },
      bounds: authoredStockBounds(setup),
      fixtureOffset,
      authored,
      fingerprint,
    }
  }
  return {
    provenance: 'physical',
    coordinateSpace: 'world',
    id: stock.id,
    name: stock.name,
    mode: stock.mode,
    primitive: setup.stock.type,
    material: setup.stock.material,
    position: copyVec3(stock.position),
    bounds: {
      min: copyVec3(stock.bounds.min),
      max: copyVec3(stock.bounds.max),
    },
    fixtureOffset,
    authored,
    fingerprint,
  }
}

function programIntentDigest(inputs: ProgramIntentInputs): string {
  return `sha256:${sha256Hex(canonicalJson(inputs))}`
}

// ---------------------------------------------------------------------------
// Freeze / copy / validate (authoritative immutability boundary)
// ---------------------------------------------------------------------------

function deepFreezeCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out = value.map((entry) => deepFreezeCopy(entry))
    return Object.freeze(out) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object)) {
    out[key] = deepFreezeCopy((value as Record<string, unknown>)[key])
  }
  return Object.freeze(out) as unknown as T
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringRecord(value: unknown): value is Record<string, unknown> & { id: string; name: string } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function isVec3(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isBounds(value: unknown): boolean {
  return isRecord(value) && isVec3(value.min) && isVec3(value.max)
}

function isOperationDescriptor(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.type === 'string'
    && typeof value.toolId === 'string'
    && isRecord(value.tool)
    && typeof value.tool.id === 'string'
    && typeof value.tool.name === 'string'
    && (value.tool.toolNumber === null || isFiniteNumber(value.tool.toolNumber))
    && typeof value.tool.type === 'string'
    && isFiniteNumber(value.tool.diameter)
    && (value.tool.cutHand === null || value.tool.cutHand === 'right' || value.tool.cutHand === 'left')
    && typeof value.status === 'string'
    && (value.generationFingerprint === null || typeof value.generationFingerprint === 'string')
    && Number.isInteger(value.startLine)
    && Number.isInteger(value.endLine)
    && (value.startLine as number) >= 1
    && (value.endLine as number) >= (value.startLine as number)
}

function isAuthoredStockSnapshot(value: unknown): boolean {
  return isRecord(value)
    && (value.type === 'rectangular' || value.type === 'cylindrical' || value.type === 'from_model')
    && ['width', 'height', 'depth', 'diameter', 'length'].every((key) =>
      value[key] === null || isFiniteNumber(value[key]))
    && ['offsetX', 'offsetY', 'offsetZTop', 'offsetZBottom'].every((key) =>
      isFiniteNumber(value[key]))
}

function isStockSnapshot(value: unknown): boolean {
  return isStringRecord(value)
    && (value.provenance === 'physical' || value.provenance === 'authored')
    && (value.coordinateSpace === 'world' || value.coordinateSpace === 'setup-wcs')
    && (value.mode === 'derived' || value.mode === 'explicit' || value.mode === 'authored')
    && (value.primitive === 'rectangular' || value.primitive === 'cylindrical' || value.primitive === 'from_model')
    && typeof value.material === 'string'
    && isVec3(value.position)
    && isBounds(value.bounds)
    && (value.fixtureOffset === null || isFiniteNumber(value.fixtureOffset))
    && isAuthoredStockSnapshot(value.authored)
    && typeof value.fingerprint === 'string'
    && SHA256_DIGEST.test(value.fingerprint)
}

function isTargetPartSnapshot(value: unknown): boolean {
  return isStringRecord(value)
    && typeof value.format === 'string'
    && isBounds(value.bounds)
    && isVec3(value.position)
    && isVec3(value.rotation)
}

/** Contexts minted by the verified-export importer (WO-381). `source:
 *  'verified-export'` is accepted at the boundary ONLY for an object in this
 *  set - i.e. one that came through `mintVerifiedExportContext` after the
 *  envelope's payload digest, schema and motion digest were checked - so an
 *  arbitrary caller cannot self-assert export provenance on a hand-built object.
 *  'foreign' stays refused everywhere. */
const verifiedExportContexts = new WeakSet<object>()

function isAcceptedSource(value: Record<string, unknown>): boolean {
  if (value.source === 'live-setup') return true
  return value.source === 'verified-export' && verifiedExportContexts.has(value)
}

function isWcsSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isFiniteNumber(value.fixtureOffset)
    && isVec3(value.origin)
}

function isSetupSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isStringRecord(value.setup)
    && isWcsSnapshot(value.wcs)
    && isStockSnapshot(value.stock)
    && Array.isArray(value.targetParts)
    && value.targetParts.every(isTargetPartSnapshot)
    && typeof value.notes === 'string'
    && typeof value.projectFingerprint === 'string'
    && SHA256_DIGEST.test(value.projectFingerprint)
}

/** WO-412: the version-2 top-level fingerprint is the digest over the listed
 *  setups' own fingerprints, in order - one verdict per setup, one for the
 *  program, and neither can disagree with the other. */
export function multiSetupProjectFingerprint(setupFingerprints: ReadonlyArray<string>): string {
  return `sha256:${sha256Hex(canonicalJson(setupFingerprints))}`
}

function assertValidProgramContext(value: unknown): asserts value is ProgramContextV1 {
  if (!isRecord(value)
    || (value.version !== PROGRAM_CONTEXT_VERSION && value.version !== PROGRAM_CONTEXT_VERSION_V2)
    || value.schemaName !== PROGRAM_CONTEXT_SCHEMA
    || !isAcceptedSource(value)
    || !isStringRecord(value.project)
    || !isStringRecord(value.setup)
    || (value.units !== 'mm' && value.units !== 'inch')
    || !isWcsSnapshot(value.wcs)
    || !isStockSnapshot(value.stock)
    || !Array.isArray(value.targetParts)
    || !value.targetParts.every(isTargetPartSnapshot)
    || typeof value.notes !== 'string'
    || !Array.isArray(value.operations)
    || !value.operations.every(isOperationDescriptor)
    || !isRecord(value.post)
    || typeof value.post.id !== 'string'
    || typeof value.post.label !== 'string'
    || typeof value.motionDigest !== 'string'
    || !SHA256_DIGEST.test(value.motionDigest)
    || typeof value.projectFingerprint !== 'string'
    || !SHA256_DIGEST.test(value.projectFingerprint)
    || !isFiniteNumber(value.generatedAt)
  ) {
    throw new Error('Refusing an invalid program-context snapshot.')
  }

  let priorEnd = 0
  for (const operation of value.operations) {
    if (operation.startLine <= priorEnd) {
      throw new Error('Refusing a program-context snapshot with overlapping or unordered operation spans.')
    }
    priorEnd = operation.endLine
  }

  // WO-412: version 1 carries no setup list (exactly today's shape); version 2
  // carries one and every operation names a listed setup, grouped in setup
  // order, with the lead setup mirrored at the top level.
  if (value.version === PROGRAM_CONTEXT_VERSION) {
    if (value.setups !== undefined) {
      throw new Error('Refusing a version-1 program-context snapshot that carries a setup list.')
    }
    return
  }
  const setups = value.setups
  if (!Array.isArray(setups) || setups.length < 1 || !setups.every(isSetupSnapshot)) {
    throw new Error('Refusing an invalid program-context snapshot: version 2 must list its setups.')
  }
  const setupIds = setups.map((s) => (s as ProgramContextSetupSnapshot).setup.id)
  if (new Set(setupIds).size !== setupIds.length) {
    throw new Error('Refusing a program-context snapshot that lists the same setup twice.')
  }
  const lead = setups[0] as ProgramContextSetupSnapshot
  if (lead.setup.id !== (value.setup as { id: string }).id
    || canonicalJson({ setup: lead.setup, wcs: lead.wcs, stock: lead.stock, targetParts: lead.targetParts, notes: lead.notes })
      !== canonicalJson({ setup: value.setup, wcs: value.wcs, stock: value.stock, targetParts: value.targetParts, notes: value.notes })) {
    throw new Error('Refusing a program-context snapshot whose lead setup disagrees with its setup list.')
  }
  if (value.projectFingerprint !== multiSetupProjectFingerprint(setups.map((s) => (s as ProgramContextSetupSnapshot).projectFingerprint))) {
    throw new Error('Refusing a program-context snapshot whose project fingerprint disagrees with its setup fingerprints.')
  }
  const runs: string[] = []
  for (const operation of value.operations as ProgramContextOperationDescriptor[]) {
    if (typeof operation.setupId !== 'string' || !setupIds.includes(operation.setupId)) {
      throw new Error(`Refusing a program-context snapshot: operation '${operation.id}' names no listed setup.`)
    }
    if (runs[runs.length - 1] !== operation.setupId) runs.push(operation.setupId)
  }
  if (runs.length !== setupIds.length || runs.some((id, i) => id !== setupIds[i])) {
    throw new Error('Refusing a program-context snapshot whose operations are not grouped in the listed setup order (every listed setup owns at least one operation, contiguously).')
  }
}

/**
 * The authoritative immutability boundary for any context entering the store.
 * Validates the version/schema/source shape, then deep-copies and deep-freezes
 * the value so a caller's retained (possibly mutable) reference cannot reach the
 * stored snapshot. Returns null for an explicit no-context, and throws (fail
 * loud, ADR-0003) on a structurally-invalid object.
 */
export function freezeProgramContext(value: ProgramContextV1 | null | undefined): ProgramContextV1 | null {
  if (value === null || value === undefined) return null
  // 'live-setup' is accepted on shape alone. 'verified-export' (WO-381) is
  // accepted only for an object minted by the envelope importer (see
  // verifiedExportContexts) - an arbitrary caller cannot self-assert trust by
  // writing the label. 'foreign' is refused.
  assertValidProgramContext(value)
  const frozen = deepFreezeCopy(value)
  if (frozen.source === 'verified-export') verifiedExportContexts.add(frozen)
  return frozen
}

/**
 * WO-381: the ONLY way a `source: 'verified-export'` context enters the store.
 * Called by the envelope importer (src/lib/post/programContextEnvelope.ts)
 * AFTER it has verified the block's framing, chunk count, payload byte count,
 * payload SHA-256, schema name and version. This function re-checks the two
 * facts the boundary owns - the context shape, and that the program text's
 * executable motion is exactly the motion the envelope describes - then returns
 * a deep-frozen copy registered as verified. Throws on any refusal.
 */
export function mintVerifiedExportContext(candidate: unknown, programText: string): ProgramContextV1 {
  if (!isRecord(candidate) || candidate.source !== 'verified-export') {
    throw new Error('Refusing to mint a verified-export context: source must be verified-export.')
  }
  const frozen = deepFreezeCopy(candidate) as Record<string, unknown>
  verifiedExportContexts.add(frozen)
  try {
    assertValidProgramContext(frozen)
    if (computeMotionDigest(programText) !== frozen.motionDigest) {
      throw new Error('Refusing a verified-export context whose motion digest does not match the program.')
    }
  } catch (err) {
    verifiedExportContexts.delete(frozen)
    throw err
  }
  return frozen
}

/** Verify an explicit context before any controller/streamer state is changed. */
export function assertProgramContextMatchesProgram(
  context: ProgramContextV1 | null | undefined,
  programText: string | null,
): void {
  if (context === null || context === undefined) return
  assertValidProgramContext(context)
  if (programText === null || computeMotionDigest(programText) !== context.motionDigest) {
    throw new Error('Refusing a program-context snapshot whose motion digest does not match the program.')
  }
  const rawLines = programText.split(/\r?\n/)
  for (const operation of context.operations) {
    if (operation.endLine > rawLines.length) {
      throw new Error('Refusing a program-context snapshot whose source spans exceed the program.')
    }
    const sourceSlice = rawLines.slice(operation.startLine - 1, operation.endLine).join('\n')
    if (prepareProgram(sourceSlice).lines.length === 0) {
      throw new Error('Refusing a program-context snapshot whose source span contains no executable lines.')
    }
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build the immutable ProgramContextV1 from the SAME authoritative inputs the
 * direct setup load used to post: the live project, the resolved setup, the
 * resolved physical stock, the ordered emitted operations (with post-verified
 * source-line spans), the selected post, and the exact generated G-code. Never
 * reconstructed later from whatever project state happens to be current.
 *
 * Line-span convention: `operationSpans` line numbers are 1-based and refer to
 * the RAW generated G-code text (the `gcode` string), not to prepared/streamed
 * executable-line indices. The motion digest is instead computed over the
 * prepared executable motion.
 */
export function buildProgramContext(
  project: Project,
  setup: Setup,
  post: PostConfig,
  gcode: string,
  operationSpans: ReadonlyArray<EmittedOperationSpan>,
): ProgramContextV1 {
  const resolved = resolveSetupWorkOffset(project, setup)
  const stock =
    resolved.stockId === undefined
      ? null
      : (project.stocks ?? []).find((candidate) => candidate.id === resolved.stockId) ?? null

  const spans = validateEmittedOperationSpans(gcode, setup, operationSpans)
  const operations = operationDescriptors(project, setup, spans)

  const context: ProgramContextV1 = {
    version: PROGRAM_CONTEXT_VERSION,
    schemaName: PROGRAM_CONTEXT_SCHEMA,
    source: 'live-setup',
    project: { id: project.id, name: project.name },
    setup: { id: setup.id, name: setup.name },
    units: post.format.units,
    wcs: wcsSnapshot(resolved),
    stock: stockSnapshot(setup, stock, resolved.fixtureOffset),
    targetParts: targetPartSnapshots(project, resolved.stockId),
    notes: setup.notes,
    operations,
    post: { id: post.id, label: post.label },
    motionDigest: computeMotionDigest(gcode),
    projectFingerprint: programIntentDigest(programIntentInputs(project, setup, post)),
    generatedAt: Date.now(),
  }

  return deepFreezeCopy(context)
}

function wcsSnapshot(resolved: ReturnType<typeof resolveSetupWorkOffset>): ProgramContextWcsSnapshot {
  return {
    id: resolved.setup.wcs.id,
    label: resolved.setup.wcs.label,
    fixtureOffset: resolved.fixtureOffset,
    origin: copyVec3(resolved.setup.wcs.origin),
  }
}

/** The per-setup snapshot (WO-412) - the same fields a version-1 context of
 *  this setup alone carries, including its own intent digest. */
function setupSnapshot(project: Project, setup: Setup, post: PostConfig): ProgramContextSetupSnapshot {
  const resolved = resolveSetupWorkOffset(project, setup)
  const stock =
    resolved.stockId === undefined
      ? null
      : (project.stocks ?? []).find((candidate) => candidate.id === resolved.stockId) ?? null
  return {
    setup: { id: setup.id, name: setup.name },
    wcs: wcsSnapshot(resolved),
    stock: stockSnapshot(setup, stock, resolved.fixtureOffset),
    targetParts: targetPartSnapshots(project, resolved.stockId),
    notes: setup.notes,
    projectFingerprint: programIntentDigest(programIntentInputs(project, setup, post)),
  }
}

/** Match one setup's validated spans to the sections the post resolved for it
 *  and describe each emitted operation. Shared by the one-setup and the
 *  multi-setup builders. */
function operationDescriptors(
  project: Project,
  setup: Setup,
  spans: ReadonlyArray<EmittedOperationSpan>,
  setupIdOnDescriptor = false,
): ProgramContextOperationDescriptor[] {
  // INVARIANT shared with src/lib/post/emit.ts (operationSpans / closeSpan): the
  // emitter records a span only for a section that emitted at least one line,
  // and buildPostInput's CAM-12 re-add path hands moveless operations back so
  // post validation refuses them BEFORE emission - so every resolved section has
  // exactly one span, in order. Neither side enforces the other; this check is
  // where a broken chain surfaces, and it names the operation that lost its span.
  const emittedSections = buildPostInput(project, setup).setup.operations
  if (emittedSections.length !== spans.length) {
    const spanned = new Set(spans.map((span) => span.opId))
    const missing = emittedSections.filter((section) => !spanned.has(section.op.id)).map((section) => `'${section.op.name}' (${section.op.id})`)
    const extra = spans.filter((span) => !emittedSections.some((section) => section.op.id === span.opId)).map((span) => `'${span.opId}'`)
    throw new Error(
      `Refusing program context: post resolved ${emittedSections.length} sections but emitted ${spans.length} spans`
      + (missing.length ? `; no span for ${missing.join(', ')}` : '')
      + (extra.length ? `; span with no section for ${extra.join(', ')}` : '')
      + '.',
    )
  }
  return spans.map((span, index): ProgramContextOperationDescriptor => {
    const section = emittedSections[index]
    const op = section.op
    if (op.id !== span.opId) {
      throw new Error(
        `Refusing program context: emitted span '${span.opId}' does not match section '${op.id}'.`,
      )
    }
    const tool = section.tool
    return {
      id: span.opId,
      name: op.name,
      type: op.type,
      toolId: tool.id,
      tool: {
        id: tool.id,
        name: tool.name,
        toolNumber: tool.toolNumber ?? null,
        type: tool.type,
        diameter: tool.diameter,
        cutHand: tool.cutHand ?? null,
      },
      status: op.status,
      generationFingerprint: op.generationFingerprint ?? null,
      startLine: span.startLine,
      endLine: span.endLine,
      ...(setupIdOnDescriptor ? { setupId: setup.id } : {}),
    }
  })
}

/**
 * WO-412: build the version-2 context for a COMBINED program of several
 * setups, from the same authoritative inputs `buildProgramContext` uses. The
 * setups are listed in the order given (the combined emit order); every span
 * must name one of them (`validateEmittedOperationSpansForSetups` refuses any
 * other setup, a disabled or unknown operation, a bad or overlapping span, and
 * a listed setup that emitted nothing), and each setup's spans are matched to
 * the sections the post resolved for it exactly as the one-setup build does.
 * Requires at least two setups: one setup is the version-1 shape, built by
 * `buildProgramContext` (see `buildProgramContextForSetups`).
 */
export function buildMultiSetupProgramContext(
  project: Project,
  setups: ReadonlyArray<Setup>,
  post: PostConfig,
  gcode: string,
  operationSpans: ReadonlyArray<EmittedOperationSpan>,
): ProgramContextV2 {
  if (setups.length < 2) {
    throw new Error('Refusing a multi-setup program context for fewer than two setups; one setup is a version-1 context.')
  }
  const spans = validateEmittedOperationSpansForSetups(gcode, setups, operationSpans)
  const operations: ProgramContextOperationDescriptor[] = []
  for (const setup of setups) {
    operations.push(...operationDescriptors(project, setup, spans.filter((span) => span.setupId === setup.id), true))
  }
  const snapshots = setups.map((setup) => setupSnapshot(project, setup, post))
  const lead = snapshots[0]
  const context: ProgramContextV2 = {
    version: PROGRAM_CONTEXT_VERSION_V2,
    schemaName: PROGRAM_CONTEXT_SCHEMA,
    source: 'live-setup',
    project: { id: project.id, name: project.name },
    setup: lead.setup,
    units: post.format.units,
    wcs: lead.wcs,
    stock: lead.stock,
    targetParts: lead.targetParts,
    notes: lead.notes,
    operations,
    post: { id: post.id, label: post.label },
    motionDigest: computeMotionDigest(gcode),
    projectFingerprint: multiSetupProjectFingerprint(snapshots.map((s) => s.projectFingerprint)),
    generatedAt: Date.now(),
    setups: snapshots,
  }
  return deepFreezeCopy(context)
}

/** WO-412: one setup -> the version-1 context; several -> version 2. */
export function buildProgramContextForSetups(
  project: Project,
  setups: ReadonlyArray<Setup>,
  post: PostConfig,
  gcode: string,
  operationSpans: ReadonlyArray<EmittedOperationSpan>,
): ProgramContextV1 {
  if (setups.length === 0) throw new Error('Refusing a program context for no setups.')
  return setups.length === 1
    ? buildProgramContext(project, setups[0], post, gcode, operationSpans)
    : buildMultiSetupProgramContext(project, setups, post, gcode, operationSpans)
}

function validateEmittedOperationSpans(
  gcode: string,
  setup: Setup,
  spans: ReadonlyArray<EmittedOperationSpan>,
): ReadonlyArray<EmittedOperationSpan> {
  const executableLines = prepareProgram(gcode).lines
  if (executableLines.length > 0 && spans.length === 0) {
    throw new Error('Refusing to build a live program context without emitted operation spans.')
  }

  const rawLines = gcode.split(/\r?\n/)
  const opById = new Map(setup.operations.map((operation) => [operation.id, operation]))
  let priorEnd = 0
  for (const span of spans) {
    if (!opById.get(span.opId)?.enabled) {
      throw new Error(`Refusing an emitted span for unknown or disabled operation '${span.opId}'.`)
    }
    if (span.setupId !== setup.id) {
      throw new Error(
        `Refusing an emitted span owned by setup '${span.setupId}' in context '${setup.id}': `
        + 'a V1 program context binds exactly ONE setup - posting several setups to the machine as one program is not supported (WO-397).',
      )
    }
    priorEnd = validateSpanLines(rawLines, span, priorEnd)
  }
  return spans
}

/** The span-geometry rules shared by the one-setup and multi-setup validators:
 *  integer 1-based lines inside the program, in order, non-overlapping, and
 *  holding at least one executable line. Returns the span's end line. */
function validateSpanLines(rawLines: ReadonlyArray<string>, span: EmittedOperationSpan, priorEnd: number): number {
  if (!Number.isInteger(span.startLine)
    || !Number.isInteger(span.endLine)
    || span.startLine < 1
    || span.endLine < span.startLine
    || span.endLine > rawLines.length
    || span.startLine <= priorEnd
  ) {
    throw new Error(`Refusing invalid or overlapping emitted lines ${span.startLine}-${span.endLine}.`)
  }
  const sourceSlice = rawLines.slice(span.startLine - 1, span.endLine).join('\n')
  if (prepareProgram(sourceSlice).lines.length === 0) {
    throw new Error(`Refusing a non-executable emitted span for operation '${span.opId}'.`)
  }
  return span.endLine
}

/**
 * WO-412: the multi-setup span check. Accepts a span from every listed setup
 * and refuses any other (by name), an unknown or disabled operation in its
 * setup, any bad or overlapping span, spans not grouped in the listed setup
 * order, and a listed setup that owns no span.
 */
export function validateEmittedOperationSpansForSetups(
  gcode: string,
  setups: ReadonlyArray<Setup>,
  spans: ReadonlyArray<EmittedOperationSpan>,
): ReadonlyArray<EmittedOperationSpan> {
  const executableLines = prepareProgram(gcode).lines
  if (executableLines.length > 0 && spans.length === 0) {
    throw new Error('Refusing to build a live program context without emitted operation spans.')
  }
  const rawLines = gcode.split(/\r?\n/)
  const setupById = new Map(setups.map((setup) => [setup.id, setup]))
  const listed = setups.map((setup) => `'${setup.id}'`).join(', ')
  let priorEnd = 0
  const runs: string[] = []
  for (const span of spans) {
    const owner = span.setupId === undefined ? undefined : setupById.get(span.setupId)
    if (owner === undefined) {
      throw new Error(
        `Refusing an emitted span owned by setup '${String(span.setupId)}': this program context binds only the setups ${listed}.`,
      )
    }
    if (!owner.operations.find((operation) => operation.id === span.opId)?.enabled) {
      throw new Error(`Refusing an emitted span for unknown or disabled operation '${span.opId}' in setup '${owner.id}'.`)
    }
    priorEnd = validateSpanLines(rawLines, span, priorEnd)
    if (runs[runs.length - 1] !== owner.id) runs.push(owner.id)
  }
  const order = setups.map((setup) => setup.id)
  if (runs.length !== order.length || runs.some((id, i) => id !== order[i])) {
    throw new Error(
      `Refusing emitted spans not grouped in the listed setup order (${listed}): every listed setup must own at least one span, contiguously, in order.`,
    )
  }
  return spans
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare a frozen snapshot against the live project, live post config, and
 * loaded text. Program drift wins (the executable text no longer matches its
 * context); project drift (identity, intent, or post-config change) is next;
 * otherwise the snapshot is current. Never mutates the snapshot.
 */
export function compareProgramContext(
  context: ProgramContextV1 | null,
  liveProject: Project,
  liveProgramText: string | null,
  livePost: PostConfig,
  liveMotionDigest?: string,
): ProgramContextComparison {
  // WO-397: a program the app knows nothing about is 'no-context', never the word
  // that means "verified to match" (the F2 trap: WO-380/381 and any run guard read
  // this value).
  if (context === null) return 'no-context'
  if ((liveMotionDigest ?? computeMotionDigest(liveProgramText ?? '')) !== context.motionDigest) {
    return 'program-changed'
  }
  // Project identity first, explicitly (WO-397): a context from another project is
  // 'project-changed' before any setup lookup or the expensive digest - today the
  // project id is inside the intent digest so the answer was the same, but that was
  // incidental, and a same-named setup id in another project must never be compared.
  if (liveProject.id !== context.project.id) return 'project-changed'
  // WO-412: a multi-setup context is current only when EVERY listed setup is;
  // one stale setup makes the program 'project-changed' (the per-setup view is
  // compareProgramContextPerSetup).
  for (const snapshot of programContextSetups(context)) {
    if (compareSetupIntent(snapshot, liveProject, livePost) !== 'current') return 'project-changed'
  }
  return 'current'
}

/** One setup's intent verdict against the live project: 'current' or
 *  'project-changed'. Motion is the caller's business. */
function compareSetupIntent(
  snapshot: ProgramContextSetupSnapshot,
  liveProject: Project,
  livePost: PostConfig,
): 'current' | 'project-changed' {
  const liveSetup = liveProject.setups.find((setup) => setup.id === snapshot.setup.id)
  if (liveSetup === undefined) return 'project-changed'
  // WO-398: only a NAMED, expected condition reads as drift - the live setup can
  // no longer resolve its work offset (its stock is gone or its offset invalid),
  // which is a project change that blocks posting. Every other fault propagates:
  // a defect in buildPostInput or the canonical walk must never be dressed up
  // as a plausible 'project-changed' badge (ADR-0003).
  try {
    const liveDigest = programIntentDigest(programIntentInputs(liveProject, liveSetup, livePost))
    return liveDigest === snapshot.projectFingerprint ? 'current' : 'project-changed'
  } catch (err) {
    if (err instanceof WorkOffsetResolutionError) return 'project-changed'
    throw err
  }
}

/** WO-412: the verdict for ONE listed setup of a context. */
export interface ProgramContextSetupVerdict {
  readonly setup: { readonly id: string; readonly name: string }
  readonly wcsLabel: string
  readonly verdict: ProgramContextComparison
}

/**
 * WO-412: the comparison per setup - one entry per listed setup in emitted
 * order (one entry for a version-1 context), so one stale setup does not hide
 * the others. Program drift (motion) applies to every setup; project identity
 * drift applies to every setup; otherwise each setup answers for its own
 * intent. Empty for no context.
 */
export function compareProgramContextPerSetup(
  context: ProgramContextV1 | null,
  liveProject: Project,
  liveProgramText: string | null,
  livePost: PostConfig,
  liveMotionDigest?: string,
): ReadonlyArray<ProgramContextSetupVerdict> {
  if (context === null) return []
  const setups = programContextSetups(context)
  const blanket: ProgramContextComparison | null =
    (liveMotionDigest ?? computeMotionDigest(liveProgramText ?? '')) !== context.motionDigest
      ? 'program-changed'
      : liveProject.id !== context.project.id
        ? 'project-changed'
        : null
  return setups.map((snapshot) => ({
    setup: snapshot.setup,
    wcsLabel: snapshot.wcs.label,
    verdict: blanket ?? compareSetupIntent(snapshot, liveProject, livePost),
  }))
}

/** WO-412: the listed setup whose operations contain a 1-based RAW source
 *  line, else null (header, footer, a gap between setups, prelude line 0).
 *  For a version-1 context this is its single setup. */
export function setupAtSourceLine(
  context: ProgramContextV1 | null | undefined,
  rawLine: number,
): ProgramContextSetupSnapshot | null {
  const hit = operationAtSourceLine(context, rawLine)
  if (!hit || !context) return null
  return setupOfOperation(context, hit.operation)
}

/** WO-412: the listed setup that owns an operation descriptor (the single
 *  setup for a version-1 context). */
export function setupOfOperation(
  context: ProgramContextV1,
  operation: Pick<ProgramContextOperationDescriptor, 'setupId'>,
): ProgramContextSetupSnapshot | null {
  const setups = programContextSetups(context)
  if (!isMultiSetupProgramContext(context)) return setups[0] ?? null
  return setups.find((s) => s.setup.id === operation.setupId) ?? null
}

// ---------------------------------------------------------------------------
// WO-382: operation-semantic progress
// ---------------------------------------------------------------------------
//
// Everything below is a PURE read of (frozen context, loaded text, the
// streamer's canonical progress). It describes where the controller is in the
// manufacturing plan; it never advances, arms or alters the machine cursor.
// The only cursor it reads is the streamer's acked source line (the 1-based
// raw line of the most recently ACKED executable line), so comments, blanks,
// '%' markers and prelude lines (sourceLine 0) can never move an operation.

/** Plain-words kind label for an operation type, shown beside its name. */
export const OPERATION_KIND_LABEL: Readonly<Record<Operation['type'], string>> = {
  face: 'facing',
  contour_2d: '2D contour',
  pocket_2d: '2D pocket',
  adaptive_clearing_2d: '2D adaptive',
  drill: 'drilling',
  bore: 'boring',
  thread_mill: 'thread milling',
  engrave: 'engraving',
  vcarve: 'V-carve',
  chamfer: 'chamfer',
  parallel_3d: '3D parallel',
  waterline_3d: '3D waterline',
  adaptive_3d: '3D adaptive',
  scallop_3d: '3D scallop',
  steep_shallow_3d: '3D steep and shallow',
  pencil_3d: '3D pencil',
}

export function operationKindLabel(type: Operation['type']): string {
  return OPERATION_KIND_LABEL[type] ?? String(type).replace(/_/g, ' ')
}

/** The operation whose verified span contains a 1-based RAW source line, or
 *  null when the line is outside every span (header, footer, tool-change gap,
 *  prelude line 0). Pure span lookup; no executable test. */
export function operationAtSourceLine(
  context: ProgramContextV1 | null | undefined,
  rawLine: number,
): { readonly index: number; readonly operation: ProgramContextOperationDescriptor } | null {
  if (!context || !Number.isInteger(rawLine) || rawLine < 1) return null
  for (let i = 0; i < context.operations.length; i++) {
    const operation = context.operations[i]
    if (rawLine >= operation.startLine && rawLine <= operation.endLine) return { index: i + 1, operation }
  }
  return null
}

export interface OperationExecutableBounds {
  /** First and last source lines inside the span that the streamer will
   *  actually send (isSendableGcodeLine). Spans are verified to hold at least
   *  one executable line at the store boundary, so both are always >= 1. */
  readonly firstExecutableLine: number
  readonly lastExecutableLine: number
}

const boundsCache = new WeakMap<ProgramContextV1, { text: string; bounds: ReadonlyArray<OperationExecutableBounds> }>()

/** Per-operation executable boundaries, computed once per (context, text). */
export function operationExecutableBounds(
  context: ProgramContextV1,
  programText: string,
): ReadonlyArray<OperationExecutableBounds> {
  const cached = boundsCache.get(context)
  if (cached && cached.text === programText) return cached.bounds
  const rawLines = programText.split(/\r?\n/)
  const bounds = context.operations.map((operation): OperationExecutableBounds => {
    let first = 0
    let last = 0
    for (let line = operation.startLine; line <= operation.endLine && line <= rawLines.length; line++) {
      if (!isSendableGcodeLine(rawLines[line - 1])) continue
      if (first === 0) first = line
      last = line
    }
    // A span with no executable line cannot exist past the boundary asserts;
    // fall back to the raw span so the derivation still cannot throw.
    return { firstExecutableLine: first || operation.startLine, lastExecutableLine: last || operation.endLine }
  })
  boundsCache.set(context, { text: programText, bounds })
  return bounds
}

export type OperationProgressStatus = 'skipped' | 'pending' | 'active' | 'completed'

export interface OperationProgressEntry extends OperationExecutableBounds {
  /** 1-based position in emitted order ("operation N of M"). */
  readonly index: number
  readonly operation: ProgramContextOperationDescriptor
  readonly status: OperationProgressStatus
  /** WO-412: the listed setup this operation belongs to, named in the label
   *  for a multi-setup program; null for a one-setup (version-1) context. */
  readonly setup: { readonly id: string; readonly name: string } | null
}

/** Plain-words run state the display prefixes the operation with. */
export type OperationProgressState = 'armed' | 'running' | 'held' | 'failed' | 'complete'

export interface OperationProgress {
  readonly total: number
  /** The source line the derivation read: the acked source line, or the armed
   *  start line while nothing of the program has been acked yet. */
  readonly cursor: number
  readonly state: OperationProgressState
  readonly entries: ReadonlyArray<OperationProgressEntry>
  /** The operation the controller is inside (active) or about to enter
   *  (pending); null once the cursor is past the last operation. */
  readonly current: OperationProgressEntry | null
  readonly completedCount: number
  readonly allComplete: boolean
  /** "Face 1 (facing), operation 2 of 5" - the operation clause alone. */
  readonly operationLabel: string | null
  /** The full row text: "Running Face 1 (facing), operation 2 of 5". */
  readonly headline: string
  /** WO-412: the listed setup the machine is in or about to enter (the current
   *  operation's owner); the last setup once past every operation; the single
   *  setup of a version-1 context. */
  readonly activeSetup: ProgramContextSetupSnapshot | null
}

export interface OperationProgressInput {
  readonly phase: StreamerPhase
  readonly ackedSourceLine: number
  /** First program source line of the armed job when it was armed mid-program
   *  (run-from-line, Step Back, a guided re-arm); null/undefined = from the top.
   *  Used ONLY while no program line has been acked yet (armed, prelude). */
  readonly armedFromLine?: number | null
}

export function operationLabel(entry: Pick<OperationProgressEntry, 'index' | 'operation'> & Partial<Pick<OperationProgressEntry, 'setup'>>, total: number): string {
  const setupPrefix = entry.setup ? `${entry.setup.name}: ` : ''
  return `${setupPrefix}${entry.operation.name} (${operationKindLabel(entry.operation.type)}), operation ${entry.index} of ${total}`
}

function progressState(phase: StreamerPhase): OperationProgressState {
  switch (phase) {
    case 'ready': return 'armed'
    case 'streaming': return 'running'
    case 'paused': return 'held'
    case 'failed': return 'failed'
    case 'complete': return 'complete'
    default: return 'armed'
  }
}

/**
 * Derive the operation-semantic view of the streamer's progress. Returns null
 * when there is nothing to say: no context, no operations, or no armed job
 * (phase 'empty' - after Stop/Reset the cursor is gone and the line-only UI
 * stands). The caller is responsible for passing a context whose comparison
 * is 'current'; a stale or foreign program must not reach this function.
 *
 * Boundaries: an operation is `completed` once its LAST executable source
 * line has been acked, `active` while the acked cursor sits inside its
 * executable range, `pending` before its first executable line, and `skipped`
 * when the job was armed past its last executable line. In a gap between
 * operations (tool change, header) the next operation is `current` as pending.
 */
export function deriveOperationProgress(
  context: ProgramContextV1 | null | undefined,
  programText: string | null | undefined,
  input: OperationProgressInput,
): OperationProgress | null {
  if (!context || !programText || context.operations.length === 0) return null
  if (input.phase === 'empty') return null
  const bounds = operationExecutableBounds(context, programText)
  const total = context.operations.length
  const acked = Number.isInteger(input.ackedSourceLine) && input.ackedSourceLine > 0 ? input.ackedSourceLine : 0
  const armedFrom =
    Number.isInteger(input.armedFromLine) && (input.armedFromLine as number) > 1 ? (input.armedFromLine as number) : 1
  // Before any program line is acked the cursor sits just BEFORE the armed
  // start line; after that it is the acked line itself.
  const cursor = acked > 0 ? acked : armedFrom
  const beforeCursor = acked === 0
  // WO-412: a multi-setup program names the setup as well as the operation.
  const multi = isMultiSetupProgramContext(context)
  const entries: OperationProgressEntry[] = context.operations.map((operation, i) => {
    const b = bounds[i]
    let status: OperationProgressStatus
    if (b.lastExecutableLine < armedFrom) status = 'skipped'
    else if (beforeCursor) status = 'pending'
    else if (cursor >= b.lastExecutableLine) status = 'completed'
    else if (cursor >= b.firstExecutableLine) status = 'active'
    else status = 'pending'
    const setup = multi ? setupOfOperation(context, operation)?.setup ?? null : null
    return { index: i + 1, operation, status, setup, ...b }
  })
  const current = entries.find((e) => e.status === 'active') ?? entries.find((e) => e.status === 'pending') ?? null
  const completedCount = entries.filter((e) => e.status === 'completed').length
  const allComplete = current === null
  const state = progressState(input.phase)
  const label = current ? operationLabel(current, total) : null
  let headline: string
  if (state === 'complete') {
    headline = completedCount === total
      ? `All ${total} operations complete`
      : `Program complete - ${completedCount} of ${total} operations ran`
  } else if (current === null) {
    headline = state === 'failed'
      ? `Failed after the last operation (${total} of ${total})`
      : `Past the last operation (${total} of ${total})`
  } else if (current.status === 'pending') {
    headline = state === 'failed' ? `Failed before ${label}` : state === 'held' ? `Held before ${label}` : `Next: ${label}`
  } else {
    headline = state === 'failed' ? `Failed in ${label}` : state === 'held' ? `Held in ${label}` : `Running ${label}`
  }
  const activeSetup = current
    ? setupOfOperation(context, current.operation)
    : setupOfOperation(context, context.operations[context.operations.length - 1])
  return { total, cursor, state, entries, current, completedCount, allComplete, operationLabel: label, headline, activeSetup }
}

/**
 * Name the operation a cycle event happened in, for the cycle log and recovery
 * review: "Face 1 (facing), operation 2 of 5". Null when the program is past
 * every operation or there is nothing to say.
 */
export function describeOperationAtProgress(
  context: ProgramContextV1 | null | undefined,
  programText: string | null | undefined,
  input: OperationProgressInput,
): string | null {
  return deriveOperationProgress(context, programText, input)?.operationLabel ?? null
}
