// WO-3307 (UI M2 W2-2b): what the six 3D operation schemas share. Each 3D operation keeps its
// parameters in op.params (no passes or linking of its own), its source solid in
// geometrySelections[0] and, for the finishing passes, its finish depth both in op.params and in
// the Smart Height authority the old editors re-author on every finish-depth edit.
import { operationSafetyHeightIntent, operationSafetyUserOverridePlanes, setupDefaultHeightIntent } from '../../../cam/heightIntent'
import type { OperationHeightIntentV2 } from '../../../cam/smartHeights/types'
import type { HeightIntentV1, HeightParams, Operation, Setup } from '../../../../types'
import type { EditContext, OpContext, ParamChoice, ParamDecl, ParamGroup, ParamRange, ParamValue, StoredOperation } from '../..'
import type { MessageKey } from '../../../../notices/types'

export const AREA_3D = 'ui2-operation-card-3d.wo3307'

/** A field's name and help, shared by every 3D type ('Tolerance' is one word in four places). */
export const field = (name: string): MessageKey => `${AREA_3D}:field.${name}` as MessageKey
export const help = (name: string): MessageKey => `${AREA_3D}:help.${name}` as MessageKey
export const choices = (set: string, values: readonly string[]): readonly ParamChoice[] =>
  values.map(value => ({ value, labelKey: `${AREA_3D}:choice.${set}.${value}` as MessageKey }))

/** What a 3D card knows beyond the contract's tool diameter. The old dialog seeds a new
 *  operation's stepover from the tool's library stepover, so the card passes it when the tool has
 *  one (contract request: add it to OpContext). */
export interface Op3dContext extends OpContext {
  readonly libraryStepoverMm?: number
}

/** What a finish-depth edit needs beyond the contract's EditContext: the Setup that owns the
 *  operation, whose default heights the old Properties panel falls back to when the operation has
 *  no height intent of its own (contract request: add it to EditContext). */
export interface Edit3dContext extends EditContext {
  readonly setup?: Pick<Setup, 'id' | 'defaultHeightIntent'>
}

/** The source solid (geometrySelections[0]) and, for the finishing passes, the faces the pass is
 *  aimed at (params.faceScope): both are picked in the viewport, so the card's slot draws them. */
export const SOURCE_SOLID: ParamDecl = { key: 'geometrySelections', type: 'geometry', default: null, labelKey: field('sourceSolid'), group: 'geometry' }
export const FACE_SCOPE: ParamDecl = { key: 'params.faceScope', type: 'geometry', default: null, labelKey: field('faceScope'), helpKey: help('faceScope'), group: 'geometry' }
export const TOOL: ParamDecl = { key: 'toolId', type: 'tool', default: null, labelKey: field('tool'), group: 'tool' }

export const DIRECTIONS = ['climb', 'conventional'] as const

/** The dialog seeds a new operation's stepover from the tool's library stepover without holding
 *  it to the field's minimum, so a seed below that minimum lowers it to the seed: an untouched
 *  default is never reported out of range (LIENCAM.md rule 11). */
export function seededStepoverRange(key: string, seeded: number | undefined, declared: ParamRange): ParamRange | undefined {
  if (key !== 'params.stepover' || seeded === undefined || declared.min === undefined || seeded >= declared.min) return undefined
  return { ...declared, min: seeded }
}

/** A number field the old editors hold to [min, max]. */
export function length(key: string, name: string, def: ParamValue, group: ParamGroup, min: number, step: number, extra: Partial<ParamDecl> = {}): ParamDecl {
  return { key, type: 'number', quantity: 'length', step, range: { min }, default: def, labelKey: field(name), helpKey: help(name), group, ...extra }
}

/** The stored form of the two viewport picks: the solid as a one-entry selection list, the face
 *  scope as sorted unique ids (an empty pick removes the scope, which is the whole part). */
export function pickWrites(key: string, value: ParamValue): Record<string, unknown> | undefined {
  if (key === 'geometrySelections') {
    const id = Array.isArray(value) ? (value as unknown as readonly string[])[0] : value
    return { geometrySelections: typeof id === 'string' && id !== '' ? [id] : [] }
  }
  if (key === 'params.faceScope') {
    const ids = Array.isArray(value)
      ? value as unknown as readonly number[]
      : (value as { faceIds?: readonly number[] } | null)?.faceIds ?? []
    return { 'params.faceScope': ids.length > 0 ? { faceIds: [...new Set(ids)].sort((a, b) => a - b) } : undefined }
  }
  return undefined
}

/** Optional numbers the old editors store as undefined when blank ("full surface", "auto"):
 *  the card's empty field (null) stores undefined, never null, so the toolpath reads it as absent. */
export function blankAsUndefined(key: string, value: ParamValue, optional: readonly string[]): Record<string, unknown> | undefined {
  return optional.includes(key) && (value === null || value === undefined) ? { [key]: undefined } : undefined
}

/** A stored optional number reads as blank unless it is a finite number. */
export const finiteNumber = (stored: unknown) => typeof stored === 'number' && Number.isFinite(stored)

type IntentBuilder = (input: {
  setupId: string
  geometryIds: string[]
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  finishDepthMm?: number
}) => OperationHeightIntentV2

/** The Properties panel's finish-depth edit: the depth goes into op.params and the operation's
 *  Smart Height authority is re-authored with it, from the operation's own height intent (else the
 *  Setup default) with the planes the operator overrode on this operation kept as overrides. */
export function finishDepthWrites(build: IntentBuilder, value: ParamValue, op: StoredOperation, context: EditContext): Record<string, unknown> {
  const finishDepth = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const out: Record<string, unknown> = { 'params.finishDepth': finishDepth }
  const setup = (context as Edit3dContext).setup
  if (!setup) return out
  const heights = op.heights as HeightParams | undefined
  const base = heights?.heightIntent ?? setupDefaultHeightIntent(setup)
  const safetyIntent = operationSafetyHeightIntent(base, operationSafetyUserOverridePlanes(op as Pick<Operation, 'smartHeight'>))
  const geometryIds = Array.isArray(op.geometrySelections) ? [...op.geometrySelections as readonly string[]] : []
  try {
    out.smartHeight = { kind: 'smart_v2', intent: build({ setupId: setup.id, geometryIds, safetyIntent, finishDepthMm: finishDepth }) }
  } catch {
    // the builder refuses an operation with no source solid (the old panel's edit threw there and
    // stored nothing); the depth is kept and the authority left as it is (an operation with no
    // solid cannot compute)
  }
  return out
}
