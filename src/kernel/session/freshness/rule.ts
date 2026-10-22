// WO-3035 (alpha.3 A3-23, step 4; REQ-SESS-12): the kernel's freshness rule.
// A freshness mark decides whether an operation recomputes before posting, not
// what a compute produces. Today's rule (src/lib/cam/generationFingerprint.ts,
// not edited, still the app's) has two characterised gaps this rule's
// canonical inputs close:
//
//   G-15 (src/tests/kernel/freshnessLiftedTraverse.wo3035.test.ts, a REAL hole
//   on `current`): a 3D finish over proven stock lifts its traverse plane to
//   max(Clearance, material top + standoff) (cam3d/pathbuild, WO-127), and the
//   saved-height check bounds the moves by Clearance - so the operation is not
//   current after its own compute and is outdated on every reopen. Here the
//   traverse plane AS RESOLVED is an input and the saved moves are checked
//   against it, i.e. against the plan that produced them.
//
//   G-81 (src/tests/kernel/freshnessFaceRestUngeneratedPocket.wo3035.test.ts,
//   no hole on `current` because a rest Face generates its pockets first):
//   here a geometry digest of every DECLARED predecessor the operation
//   subtracts or reads is an input, taken from its declared geometry whether
//   or not it was ever generated, so a dependent does not rely on its
//   predecessors having run to see their edits.
//
// Headless: no imports. The planes are the heights service's resolved values
// (src/kernel/heights, read by the caller; importing it here would make this
// an app-side caller under WO-3020's boundary check). Nothing in the app calls
// this rule yet; while every type id is `current` no stored fingerprint moves.

export const KERNEL_FRESHNESS_VERSION = 1

const EPS = 1e-6

/** The five resolved planes, machine mm. */
export interface FreshnessPlanes {
  clearance: number
  retract: number
  feed: number
  top: number
  bottom: number
}

/** The lateral traverse plane a generator actually emits its rapids at. */
export interface ResolvedTraversePlane {
  machineMm: number
  /** 'clearance': the authored Clearance. 'proven_material_top': lifted above it. */
  owner: 'clearance' | 'proven_material_top'
  /** The material evidence a lifted plane rests on (stock / material record ids). */
  proofIds: readonly string[]
}

/** An earlier operation the dependent's result is built from. */
export interface DeclaredPredecessor {
  id: string
  relation: 'subtracts' | 'reads'
  /** What the dependent takes from it by declaration (footprint loops, floor),
   *  never its generated moves or whether it was generated. */
  geometry: unknown
}

export interface FreshnessInputs {
  engineId: string
  /** The operation's own generation inputs, as the caller canonicalises them. */
  operation: unknown
  planes: FreshnessPlanes
  traverse: ResolvedTraversePlane
  predecessors: readonly DeclaredPredecessor[]
  /** Tool, setup, stock, scene, machine: everything else the compute reads. */
  context?: unknown
}

/** What a compute stores beside its moves. */
export interface GenerationRecord {
  version: typeof KERNEL_FRESHNESS_VERSION
  stamp: string
  planes: FreshnessPlanes
  traverse: ResolvedTraversePlane
}

export interface SavedMove {
  type: string
  z: number
}

export interface FreshnessCheckOptions {
  /** The generator guarantees a rapid AT the traverse plane (the 3D strategies). */
  traverseAnchored: boolean
  /** A live check may accept a legitimately empty result; a reload may not. */
  allowEmpty?: boolean
}

export type FreshnessVerdict =
  | { current: true }
  | { current: false; reason: 'malformed_record' | 'inputs_changed' | 'moves_outside_plan' }

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : value
  }
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

const digest = (value: unknown) => hashText(JSON.stringify(canonical(value)) ?? 'undefined')

/** max(Clearance, proven material top + standoff), with its owner. The standoff
 *  is the generator's own (pathbuild 1 mm, Adaptive 3D 0.5 mm); no default. */
export function resolveTraversePlane(input: {
  clearanceMm: number
  provenMaterialTopMm?: number
  standoffMm: number
  proofIds?: readonly string[]
}): ResolvedTraversePlane {
  if (!Number.isFinite(input.clearanceMm)) throw new Error('Traverse plane: Clearance must be finite.')
  if (!(input.standoffMm > 0) || !Number.isFinite(input.standoffMm)) {
    throw new Error('Traverse plane: the standoff must be a finite distance above zero.')
  }
  const top = input.provenMaterialTopMm
  if (top === undefined) return { machineMm: input.clearanceMm, owner: 'clearance', proofIds: [] }
  if (!Number.isFinite(top)) throw new Error('Traverse plane: the proven material top must be finite.')
  const floor = top + input.standoffMm
  return floor > input.clearanceMm + EPS
    ? { machineMm: floor, owner: 'proven_material_top', proofIds: [...(input.proofIds ?? [])].sort() }
    : { machineMm: input.clearanceMm, owner: 'clearance', proofIds: [] }
}

/** One digest over every declared predecessor's geometry, in setup order. */
export function predecessorGeometryDigest(predecessors: readonly DeclaredPredecessor[]): string {
  return digest(predecessors.map(({ id, relation, geometry }) => ({ id, relation, geometry })))
}

export function freshnessStamp(inputs: FreshnessInputs): string {
  return `kfresh-v${KERNEL_FRESHNESS_VERSION}-${digest({
    version: KERNEL_FRESHNESS_VERSION,
    engineId: inputs.engineId,
    operation: inputs.operation,
    planes: inputs.planes,
    traverse: inputs.traverse,
    predecessors: predecessorGeometryDigest(inputs.predecessors),
    context: inputs.context,
  })}`
}

export function generationRecord(inputs: FreshnessInputs): GenerationRecord {
  return {
    version: KERNEL_FRESHNESS_VERSION,
    stamp: freshnessStamp(inputs),
    planes: { ...inputs.planes },
    traverse: { ...inputs.traverse, proofIds: [...inputs.traverse.proofIds] },
  }
}

const PLANE_NAMES = ['clearance', 'retract', 'feed', 'top', 'bottom'] as const

function isRecord(value: unknown): value is GenerationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<GenerationRecord>
  const planes = record.planes as Record<string, unknown> | undefined
  const traverse = record.traverse as Partial<ResolvedTraversePlane> | undefined
  return record.version === KERNEL_FRESHNESS_VERSION
    && typeof record.stamp === 'string'
    && !!planes && PLANE_NAMES.every(name => Number.isFinite(planes[name]))
    && !!traverse && Number.isFinite(traverse.machineMm)
    && (traverse.owner === 'clearance' || traverse.owner === 'proven_material_top')
    && Array.isArray(traverse.proofIds)
}

/** The saved moves live in the plan that produced them: inside
 *  [Bottom, traverse plane], with the traverse anchor rapid when the generator
 *  guarantees one. */
export function savedMovesMatchPlan(
  record: GenerationRecord,
  moves: readonly SavedMove[],
  options: FreshnessCheckOptions,
): boolean {
  const { clearance, retract, feed, top, bottom } = record.planes
  const traverseZ = record.traverse.machineMm
  if (
    traverseZ + EPS < clearance || clearance + EPS < retract || retract + EPS < feed
    || feed + EPS < top || top + EPS < bottom
  ) return false
  if (moves.length === 0) return options.allowEmpty === true
  let anchored = false
  for (const move of moves) {
    if (!move || typeof move !== 'object' || !Number.isFinite(move.z)) return false
    if (move.z < bottom - EPS || move.z > traverseZ + EPS) return false
    if (move.type === 'rapid' && Math.abs(move.z - traverseZ) <= EPS) anchored = true
  }
  return !options.traverseAnchored || anchored
}

/** Is a stored result (possibly just reloaded from a file) still current? */
export function freshnessVerdict(
  stored: unknown,
  moves: unknown,
  live: FreshnessInputs,
  options: FreshnessCheckOptions,
): FreshnessVerdict {
  if (!isRecord(stored) || !Array.isArray(moves)) return { current: false, reason: 'malformed_record' }
  const expected = generationRecord(live)
  if (stored.stamp !== expected.stamp) return { current: false, reason: 'inputs_changed' }
  // The stamp covers the planes; a record whose planes disagree with it was
  // not written by this rule.
  if (digest({ planes: stored.planes, traverse: stored.traverse })
    !== digest({ planes: expected.planes, traverse: expected.traverse })) {
    return { current: false, reason: 'malformed_record' }
  }
  return savedMovesMatchPlan(stored, moves as SavedMove[], options)
    ? { current: true }
    : { current: false, reason: 'moves_outside_plan' }
}
