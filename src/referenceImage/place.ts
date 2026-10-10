import type { ReferenceImagePayload } from './referenceImage'
import type { ImagePoint } from './calibrate'

/** Image-local mm -> plane-local mm. Flips happen before rotation, about the center. */
export function imageToPlane(payload: ReferenceImagePayload, point: ImagePoint): ImagePoint {
  const angle = (payload.angleDeg ?? 0) * Math.PI / 180
  const x = point.x * (payload.flipHorizontal ? -1 : 1)
  const y = point.y * (payload.flipVertical ? -1 : 1)
  return { x: (payload.center?.x ?? 0) + x * Math.cos(angle) - y * Math.sin(angle),
    y: (payload.center?.y ?? 0) + x * Math.sin(angle) + y * Math.cos(angle) }
}

export function planeToImage(payload: ReferenceImagePayload, point: ImagePoint): ImagePoint {
  const angle = (payload.angleDeg ?? 0) * Math.PI / 180
  const x = point.x - (payload.center?.x ?? 0), y = point.y - (payload.center?.y ?? 0)
  return { x: (x * Math.cos(angle) + y * Math.sin(angle)) * (payload.flipHorizontal ? -1 : 1),
    y: (-x * Math.sin(angle) + y * Math.cos(angle)) * (payload.flipVertical ? -1 : 1) }
}

export function imageContainsPoint(payload: ReferenceImagePayload, point: ImagePoint): boolean {
  const local = planeToImage(payload, point)
  return Math.abs(local.x) <= payload.widthMm / 2 && Math.abs(local.y) <= payload.heightMm / 2
}

export const IMAGE_CORNERS = [
  { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 },
] as const
export type ImagePlacement = Pick<ReferenceImagePayload, 'center' | 'widthMm' | 'heightMm'>

export function imageCorner(payload: ReferenceImagePayload, corner: ImagePoint): ImagePoint {
  return imageToPlane(payload, { x: corner.x * payload.widthMm / 2, y: corner.y * payload.heightMm / 2 })
}

/** Project onto the original diagonal: uniform scale, with the opposite corner fixed.
 * A positive minimum prevents crossing the anchor from silently flipping the picture. */
export function scaleImageCorner(payload: ReferenceImagePayload, corner: ImagePoint, point: ImagePoint): ImagePlacement {
  if (payload.scaleLocked) return { center: payload.center, widthMm: payload.widthMm, heightMm: payload.heightMm }
  const anchor = imageCorner(payload, { x: -corner.x, y: -corner.y })
  const moving = imageCorner(payload, corner)
  const dx = moving.x - anchor.x, dy = moving.y - anchor.y
  const projected = ((point.x - anchor.x) * dx + (point.y - anchor.y) * dy) / (dx * dx + dy * dy)
  const factor = Math.max(0.001 / Math.min(payload.widthMm, payload.heightMm), Number.isFinite(projected) ? projected : 1)
  return { widthMm: payload.widthMm * factor, heightMm: payload.heightMm * factor,
    center: { x: anchor.x + dx * factor / 2, y: anchor.y + dy * factor / 2 } }
}
