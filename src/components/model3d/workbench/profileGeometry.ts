// WO INT-4A: minimal parametric-rectangle profile builder feeding the frozen
// geom-service.ts ProfileRegion contract directly -- the same plain segment
// literals src/tests/geom/fixtures/profiles.ts's rectLoop/xyPlane/xzPlane
// already prove correct against the real occt-wasm kernel (extrude.test.ts,
// revolve.test.ts). This WO owns UI wiring, not a freehand sketch canvas
// (out of scope: src/sketch3d/**, src/lib/sketch/** are read-only/frozen for
// this WO) -- a width/height/offset dialog is the minimum "pick a profile"
// affordance that produces a REAL ProfileRegion for makeExtrude/makeRevolve,
// consistent with the WO's own "no new UX inventions" instruction.
//
// One shape serves both ops: the 'xz' plane variant is offset from the
// world Z axis by `offset` (must stay > 0), so the SAME rectangle is a valid
// revolve profile (no self-intersection) as well as a valid extrude profile.

import type { ProfileRegion } from '../../../geom/geom-service'

export type SketchPlaneKind = 'xy' | 'xz'

export interface RectangleProfileOptions {
  sketchId: string
  plane: SketchPlaneKind
  width: number
  height: number
  /** Offset of the rectangle's near edge from the origin along the plane's
   *  local x-axis. For the 'xz' plane this is also the clearance from the
   *  world Z axis a revolve needs to avoid self-intersection. */
  offset: number
}

function planeFor(kind: SketchPlaneKind): ProfileRegion['plane'] {
  return kind === 'xy'
    ? { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    : { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }
}

/** CCW rectangle loop (matches the codebase's own proven fixture winding --
 *  traversing right/up/left/down from the near-bottom corner). */
export function rectangleProfile(opts: RectangleProfileOptions): ProfileRegion {
  const { sketchId, plane, width, height, offset } = opts
  const x0 = offset
  const x1 = offset + width
  const y0 = 0
  const y1 = height
  const loop: ProfileRegion['loops'][number] = [
    { kind: 'line', a: [x0, y0], b: [x1, y0], srcId: `${sketchId}.e0` },
    { kind: 'line', a: [x1, y0], b: [x1, y1], srcId: `${sketchId}.e1` },
    { kind: 'line', a: [x1, y1], b: [x0, y1], srcId: `${sketchId}.e2` },
    { kind: 'line', a: [x0, y1], b: [x0, y0], srcId: `${sketchId}.e3` },
  ]
  return { sketchId, plane: planeFor(plane), loops: [loop] }
}

/** World-space corner points (closed, 5 points) for drawing the sketch
 *  outline in the 3D view -- visual-only, never fed back into a geometry
 *  request (the ProfileRegion above is the single source of truth for that). */
export function rectangleWorldCorners(opts: RectangleProfileOptions): Array<{ x: number; y: number; z: number }> {
  const { plane, width, height, offset } = opts
  const x0 = offset
  const x1 = offset + width
  const corners =
    plane === 'xy'
      ? [
          { x: x0, y: 0, z: 0 },
          { x: x1, y: 0, z: 0 },
          { x: x1, y: height, z: 0 },
          { x: x0, y: height, z: 0 },
        ]
      : [
          { x: x0, y: 0, z: 0 },
          { x: x1, y: 0, z: 0 },
          { x: x1, y: 0, z: height },
          { x: x0, y: 0, z: height },
        ]
  return [...corners, corners[0]]
}
