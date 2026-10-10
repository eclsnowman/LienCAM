import type { ReferenceImagePayload } from './referenceImage'

export type ImagePoint = { x: number; y: number }

/** Scale about the first mark, retaining its plane position and the image aspect. */
export function calibrateReferenceImage(payload: ReferenceImagePayload, first: ImagePoint, second: ImagePoint, distanceMm: number): ReferenceImagePayload {
  const measured = Math.hypot(second.x - first.x, second.y - first.y)
  if (payload.scaleLocked || !(distanceMm > 0) || !Number.isFinite(distanceMm) || !(measured > 0)) return payload
  const factor = distanceMm / measured
  const center = payload.center ?? { x: 0, y: 0 }
  const widthMm = payload.widthMm * factor
  const heightMm = payload.heightMm * factor
  const nextCenter = { x: first.x + (center.x - first.x) * factor, y: first.y + (center.y - first.y) * factor }
  if (![widthMm, heightMm, nextCenter.x, nextCenter.y].every(Number.isFinite)) return payload
  return { ...payload, widthMm, heightMm, center: nextCenter }
}
