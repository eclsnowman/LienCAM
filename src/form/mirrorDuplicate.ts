// Form - Mirror duplicate: the form and its
// mirror image across a plane, joined along the plane. Points on the plane
// (within a small tolerance; snapped onto it) are shared by both halves; faces
// lying in the plane are dropped from both, so a half form whose seam is open,
// or closed with a face on the plane, becomes one whole symmetric form.
// Creases and weights are mirrored with their edges.

import type { Cage, Vec3 } from './cage'
import { edgeKey, parseEdgeKey } from './cage'
import { compactWithMap } from './topoTools'

export interface MirrorDuplicate {
  cage: Cage
  /** points shared by both halves (on the plane) */
  seam: number
  /** faces dropped because they lay in the plane */
  dropped: number
  /** points on the far side of the plane from most of the form: the copy overlaps them */
  across: number
}

/** The form and its mirror across n . p = at (`normal` any length). */
export function mirrorDuplicate(cage: Cage, normal: Vec3, at: number): MirrorDuplicate {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l]
  const P = cage.positions
  const lo = [0, 1, 2].map((c) => Math.min(...P.map((p) => p[c]))), hi = [0, 1, 2].map((c) => Math.max(...P.map((p) => p[c])))
  const tol = Math.max(1e-6, 1e-4 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
  const side = P.map((p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - at)
  const onPlane = side.map((d) => Math.abs(d) <= tol)
  // the side most of the form is on; points beyond the plane from it are overlapped by the copy
  const net = side.reduce((a, d) => a + d, 0)
  const across = side.filter((d, i) => !onPlane[i] && Math.sign(d) === -Math.sign(net || 1)).length
  const positions: Vec3[] = P.map((p, i) => onPlane[i] ? [p[0] - n[0] * side[i], p[1] - n[1] * side[i], p[2] - n[2] * side[i]] : [p[0], p[1], p[2]])
  const image = new Map<number, number>()
  P.forEach((p, i) => {
    if (onPlane[i]) { image.set(i, i); return }
    image.set(i, positions.length)
    positions.push([p[0] - 2 * n[0] * side[i], p[1] - 2 * n[1] * side[i], p[2] - 2 * n[2] * side[i]])
  })
  const inPlane = (f: readonly number[]) => f.every((p) => onPlane[p])
  const kept = cage.faces.filter((f) => !inPlane(f))
  const faces = [...kept.map((f) => [...f]), ...kept.map((f) => [...f].reverse().map((p) => image.get(p)!))]
  const mirrorKey = (k: string) => { const [a, b] = parseEdgeKey(k); return edgeKey(image.get(a)!, image.get(b)!) }
  const creases = [...new Set([...cage.creases, ...cage.creases.map(mirrorKey)])]
  const weights = cage.weights === undefined ? undefined
    : Object.fromEntries(Object.entries(cage.weights).flatMap(([k, w]) => [[k, w], [mirrorKey(k), w]]))
  const joined: Cage = { positions, faces, creases, ...(weights === undefined ? {} : { weights }) }
  const { cage: out } = compactWithMap(joined)
  return { cage: out, seam: onPlane.filter(Boolean).length, dropped: cage.faces.length - kept.length, across }
}
