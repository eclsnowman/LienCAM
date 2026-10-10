// Auto-constraint inference on draw (WP3.3, Architect ruling 4): while a line is being drawn,
// offer horizontal/vertical/coincident/tangent candidates the user can commit with a click (or
// have auto-applied), without ever silently mutating the sketch - inferLineDrawCandidates() only
// READS the document and returns candidate constraints; commitInferenceCandidate() is the one
// step that actually appends one.
//
// All thresholds live in ONE place (SKETCH3D_INFERENCE_THRESHOLDS) per the ruling - do not
// scatter magic numbers into call sites.
import { addConstraint } from './constraintTools'
import { sketch3dPointSamples } from './pointSamples'
import type {
  Sketch3dArcEntity,
  Sketch3dDocument,
  Sketch3dDrawToolState,
  Sketch3dInferenceCandidate,
  Sketch3dLineEntity,
  Sketch3dPointRef,
  Sketch3dVec2,
} from './types'

export const SKETCH3D_INFERENCE_THRESHOLDS = {
  // Line-angle snap tolerance for the horizontal/vertical candidates, in radians (~3deg).
  angleToleranceRad: (3 * Math.PI) / 180,
  // World-unit snap radius for "drawn endpoint is near an existing point" -> coincident.
  coincidentDistance: 0.75,
  // Tolerance, in radians, between the drawn line's direction and an arc's tangent direction
  // at a nearby endpoint before offering a tangent candidate (~3deg).
  tangentAngleToleranceRad: (3 * Math.PI) / 180,
} as const

// Angular distance between two directions, both taken mod pi (a line has no "arrowhead", so
// 179deg and -1deg are the same direction).
function angleDeltaModPi(a: number, b: number): number {
  const diff = Math.abs(a - b) % Math.PI
  return Math.min(diff, Math.PI - diff)
}

function findEntity(document: Sketch3dDocument, id: string) {
  const entity = document.entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`sketch3d inference: unknown entity id '${id}'`)
  return entity
}

function pointFromPolar(center: Sketch3dVec2, radius: number, angle: number): Sketch3dVec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

function arcTangentAngleAt(arc: Sketch3dArcEntity, site: 'start' | 'end'): number {
  const angle = site === 'start' ? arc.startAngle : arc.endAngle
  const point = pointFromPolar(arc.center, arc.radius, angle)
  // Tangent direction = radius vector rotated 90deg.
  return Math.atan2(point.x - arc.center.x, -(point.y - arc.center.y))
}

function endpointCandidates(
  document: Sketch3dDocument,
  line: Sketch3dLineEntity,
  site: 'start' | 'end',
  thresholds: typeof SKETCH3D_INFERENCE_THRESHOLDS,
): Sketch3dInferenceCandidate[] {
  const at = site === 'start' ? line.start : line.end
  const ref: Sketch3dPointRef = { entityId: line.id, site }
  const candidates: Sketch3dInferenceCandidate[] = []

  let nearest: { ref: Sketch3dPointRef; entityKind: string; site: string; distance: number } | null = null
  for (const sample of sketch3dPointSamples(document)) {
    if (sample.ref.entityId === line.id) continue // never snap a line's own endpoints together
    const distance = Math.hypot(sample.at.x - at.x, sample.at.y - at.y)
    if (distance > thresholds.coincidentDistance) continue
    if (!nearest || distance < nearest.distance) {
      const owner = findEntity(document, sample.ref.entityId)
      nearest = { ref: sample.ref, entityKind: owner.kind, site: sample.ref.site, distance }
    }
  }

  if (nearest) {
    candidates.push({
      kind: 'coincident',
      score: nearest.distance,
      constraint: {
        id: `${line.id}__infer_coincident_${site}`,
        kind: 'coincident',
        a: ref,
        b: nearest.ref,
      },
    })

    if (nearest.entityKind === 'arc' && (nearest.site === 'start' || nearest.site === 'end')) {
      const arc = findEntity(document, nearest.ref.entityId) as Sketch3dArcEntity
      const tangentAngle = arcTangentAngleAt(arc, nearest.site as 'start' | 'end')
      const lineAngle = Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x)
      if (angleDeltaModPi(lineAngle, tangentAngle) <= thresholds.tangentAngleToleranceRad) {
        candidates.push({
          kind: 'tangent',
          score: angleDeltaModPi(lineAngle, tangentAngle),
          constraint: {
            id: `${line.id}__infer_tangent_${site}`,
            kind: 'tangent',
            a: line.id,
            b: arc.id,
          },
        })
      }
    }
  }

  return candidates
}

// document must already contain the in-progress line entity (id === lineId) at its live draft
// endpoints - inference only reads positions, it never adds the line itself.
export function inferLineDrawCandidates(
  document: Sketch3dDocument,
  lineId: string,
  toolState: Sketch3dDrawToolState,
  thresholds: typeof SKETCH3D_INFERENCE_THRESHOLDS = SKETCH3D_INFERENCE_THRESHOLDS,
): Sketch3dInferenceCandidate[] {
  if (toolState.suppressInference) return []

  const entity = findEntity(document, lineId)
  if (entity.kind !== 'line') throw new Error(`sketch3d inference: entity '${lineId}' is not a line`)
  const line = entity

  const candidates: Sketch3dInferenceCandidate[] = []
  const length = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y)
  if (length > 0) {
    const angle = Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x)
    const angleModPi = ((angle % Math.PI) + Math.PI) % Math.PI
    const deltaFromHorizontal = Math.min(angleModPi, Math.PI - angleModPi)
    const deltaFromVertical = Math.abs(angleModPi - Math.PI / 2)
    if (deltaFromHorizontal <= thresholds.angleToleranceRad) {
      candidates.push({
        kind: 'horizontal',
        score: deltaFromHorizontal,
        constraint: { id: `${lineId}__infer_horizontal`, kind: 'horizontal', line: lineId },
      })
    }
    if (deltaFromVertical <= thresholds.angleToleranceRad) {
      candidates.push({
        kind: 'vertical',
        score: deltaFromVertical,
        constraint: { id: `${lineId}__infer_vertical`, kind: 'vertical', line: lineId },
      })
    }
  }

  candidates.push(...endpointCandidates(document, line, 'start', thresholds))
  candidates.push(...endpointCandidates(document, line, 'end', thresholds))

  return candidates.sort((a, b) => a.score - b.score)
}

export function commitInferenceCandidate(
  document: Sketch3dDocument,
  candidate: Sketch3dInferenceCandidate,
): Sketch3dDocument {
  return addConstraint(document, candidate.constraint)
}
