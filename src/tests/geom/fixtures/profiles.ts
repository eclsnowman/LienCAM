// GEO-3 shared profile fixtures for extrude/revolve tests. Profiles arrive as
// 2D loops in the request per the frozen contract (geom-service.ts
// ProfileRegion) — we author them here rather than depending on the sketch
// lane's not-yet-landed region output (SKC-4). Every segment carries a source
// sketch-entity id (srcId) that becomes the origin tag of the generated face.
import type { ProfileRegion } from '../../../geom/geom-service.ts'

/** XY-plane basis at a given Z (normal +Z, xDir +X). */
export function xyPlane(z = 0): ProfileRegion['plane'] {
  return { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
}

/** XZ-plane basis (local x -> world X, local y -> world Z), so a revolve about
 *  the world Z axis of a profile offset in +X sweeps a solid of revolution. */
export function xzPlane(): ProfileRegion['plane'] {
  return { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }
}

/** A CCW rectangle loop [x0,y0]->[x1,y1] with per-edge srcIds. */
export function rectLoop(
  prefix: string, x0: number, y0: number, x1: number, y1: number,
): ProfileRegion['loops'][number] {
  return [
    { kind: 'line', a: [x0, y0], b: [x1, y0], srcId: `${prefix}.e0` },
    { kind: 'line', a: [x1, y0], b: [x1, y1], srcId: `${prefix}.e1` },
    { kind: 'line', a: [x1, y1], b: [x0, y1], srcId: `${prefix}.e2` },
    { kind: 'line', a: [x0, y1], b: [x0, y0], srcId: `${prefix}.e3` },
  ]
}

/** Rectangle-with-circular-hole profile on the XY plane. */
export function rectWithHole(
  sketchId: string, w: number, h: number, cx: number, cy: number, r: number,
): ProfileRegion {
  return {
    sketchId,
    plane: xyPlane(0),
    loops: [
      rectLoop(sketchId, 0, 0, w, h),
      [{ kind: 'arc', c: [cx, cy], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.h0` }],
    ],
  }
}
