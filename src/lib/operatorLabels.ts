import { textFor } from '../i18n'
import { resolveOwningModelItemId, type ModelItemOwnedCandidate } from './cam/modelOrigin'
import type { BodyTransformRefusal, MirrorReferenceNotCarriedError } from '../doc/features/bodyTransform'

const words = textFor('sketch-and-model-workbench')
const mirrorWords = textFor('body-mirror.wo3244')

/** Display only: keep stable keys in documents, picks and diagnostic records. */
export function readableInternalIds(text: string): string {
  return text
    .replace(/(?:\b[Ee]dge\s+)?\([^()\n]*:[^()\n]*[∧^][^()\n]*\)/g, (token) => {
      const label = words('operatorLabels.edgeBetweenFaces')
      return token.startsWith('Edge ') ? label[0].toUpperCase() + label.slice(1) : label
    })
    // The surface role already identifies the target in a diagnostic. Remove
    // its quoted topology key rather than repeating "face (picked face)".
    .replace(/\b(face|cylinder|boss(?: wall)?|edge)\s+(?:\("[\w.-]+:(?:XTR|REV|BOX|CUT|FUS|INT|FIL|CHM|SHL|SWP|LFT|HOL|PAT|DELF|EDIT|step|stl|iges):[^"]+"\)|"[\w.-]+:(?:XTR|REV|BOX|CUT|FUS|INT|FIL|CHM|SHL|SWP|LFT|HOL|PAT|DELF|EDIT|step|stl|iges):[^"]+")/g, '$1')
    .replace(/\bsketch3d:SK(\d+)\b/g, (_, number: string) => words('operatorLabels.sketch', { number }))
    .replace(/\bdatum:SK(\d+)\b/g, (_, number: string) => words('operatorLabels.sketchPlane', { number }))
    .replace(/\bdatum:([\w.-]+)/g, (_, name: string) => words('operatorLabels.plane', { name }))
    .replace(/\b[\w.-]+:(?:XTR|REV|BOX|CUT|FUS|INT|FIL|CHM|SHL|SWP|LFT|HOL|PAT|DELF|EDIT|step|stl|iges):[^\s,;)'"}]+/g, (token) => words('operatorLabels.pickedFace') + (token.match(/[.!?]+$/)?.[0] ?? ''))
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, () => words('operatorLabels.item'))
}

/** Shared by feature-tree rows, filters, dialogs and CAM body projection. */
export function featureDisplayName(id: string, payload: Record<string, unknown>): string {
  const name = payload.name
  return typeof name === 'string' && name.trim().length > 0 && name !== id
    ? name
    : readableInternalIds(id)
}

/** Qualify a body at presentation time so model renames take effect immediately,
 * including legacy rows whose ownership field was deliberately omitted. */
export function geometryDisplayName(
  geo: ModelItemOwnedCandidate & { name: string },
  modelItems: readonly { id: string; name: string }[] | undefined,
): string {
  const ownerId = resolveOwningModelItemId(geo)
  const owner = ownerId === undefined ? undefined : modelItems?.find(item => item.id === ownerId)
  return owner && geo.name !== owner.name && !geo.name.startsWith(`${owner.name} - `)
    ? `${owner.name} - ${geo.name}`
    : geo.name
}

/** A durable CAM face reference has no analytic snapshot to name its surface.
 * Describe the picked face and its actual owning body without inventing one. */
export function pickedFaceDisplayName(bodyName?: string): string {
  return bodyName ? words('operatorLabels.pickedFaceOn', { name: bodyName }) : words('operatorLabels.pickedFace')
}

/** WO-3244: one wording for a Mirror replay refusal, used by the Model screen
 *  and the background replay alike. Ids shown are display names. */
export function bodyTransformRefusalText(refusal: BodyTransformRefusal): string {
  const nodeId = readableInternalIds(refusal.nodeId)
  switch (refusal.kind) {
    case 'malformed':
      return mirrorWords('refusedMalformed', { nodeId })
    case 'sourceNotLive':
      return mirrorWords('refusedSourceNotLive', { nodeId, sourceBodyId: readableInternalIds(refusal.sourceBodyId) })
    case 'planeUnresolved':
      return mirrorWords('refusedPlaneUnresolved', { nodeId, planeNodeId: readableInternalIds(refusal.planeNodeId) })
    case 'noTransform':
      return mirrorWords('refusedNoTransform', { nodeId })
  }
}

/** WO-3244: one wording for a later feature whose reference cannot be
 *  resolved through a Mirror at replay, on the Model screen and in the
 *  background replay alike. */
export function mirrorCarryReplayText(error: MirrorReferenceNotCarriedError, featureName?: string): string {
  const values = {
    feature: featureName !== undefined && featureName.length > 0 ? featureName : readableInternalIds(error.featureId),
    reference: readableInternalIds(error.reference),
    mirror: readableInternalIds(error.mirrorId),
  }
  return mirrorWords(error.kind === 'noPlane' ? 'replayNoPlane' : 'replayNotCarried', values)
}
