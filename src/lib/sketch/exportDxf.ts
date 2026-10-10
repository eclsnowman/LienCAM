import type { Vec2 } from '../../types'
import { bakeSketch } from './bake'
import type { Sketch } from './types'

/** R2000 ASCII DXF, in sketch-local millimetres (DXF and sketches both use Y-up).
 * Use the same bake as SVG/CAM so blocks, text-on-path, font outlines and construction
 * filtering cannot diverge. Splines/ellipses/text retain every baked polyline vertex;
 * no curve fitting or decimal rounding is allowed at this interchange boundary.
 */
export function exportSketchDxf(sketch: Sketch): string {
  const lines: string[] = []
  const pair = (code: number, value: string | number) => { lines.push(String(code), String(value)) }
  const point = (p: Vec2, code = 10) => { pair(code, p.x); pair(code + 10, p.y); pair(code + 20, 0) }
  let handle = 256
  const entity = (kind: string, subclass: string) => {
    pair(0, kind); pair(5, (handle++).toString(16).toUpperCase())
    pair(100, 'AcDbEntity'); pair(8, '0'); pair(100, subclass)
  }
  const degrees = (p: Vec2, center: Vec2) => {
    const a = Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI
    return (a + 360) % 360
  }
  pair(0, 'SECTION'); pair(2, 'HEADER')
  pair(9, '$ACADVER'); pair(1, 'AC1015')
  pair(9, '$INSUNITS'); pair(70, 4)
  pair(9, '$MEASUREMENT'); pair(70, 1)
  pair(0, 'ENDSEC')
  pair(0, 'SECTION'); pair(2, 'ENTITIES')
  for (const loop of bakeSketch(sketch).loops) {
    const segments = loop.segments ?? []
    if (!segments.length) continue
    // A baked standalone circle is one full-turn arc. A full arc in a chain
    // is also a circle in DXF; ARC with equal angles would lose its full turn.
    if (segments.length > 1 && segments.every((s) => s.type === 'line')) {
      const vertices = [loop.points[0], ...segments.map((s) => s.to)]
      if (loop.closed && Math.hypot(vertices.at(-1)!.x - vertices[0].x, vertices.at(-1)!.y - vertices[0].y) < 1e-9) vertices.pop()
      entity('LWPOLYLINE', 'AcDbPolyline')
      pair(90, vertices.length); pair(70, loop.closed ? 1 : 0)
      for (const p of vertices) { pair(10, p.x); pair(20, p.y) }
      continue
    }
    let from = loop.points[0]
    for (const s of segments) {
      if (s.type === 'line') {
        entity('LINE', 'AcDbLine'); point(from); point(s.to, 11)
      } else {
        const full = Math.hypot(from.x - s.to.x, from.y - s.to.y) < 1e-9
        entity(full ? 'CIRCLE' : 'ARC', 'AcDbCircle')
        point(s.center); pair(40, s.radius)
        if (!full) {
          // DXF ARC is always CCW. Swapping endpoints retains a clockwise
          // baked hole's locus, including major sweeps and the 0-deg crossing.
          pair(100, 'AcDbArc')
          pair(50, degrees(s.clockwise ? s.to : from, s.center))
          pair(51, degrees(s.clockwise ? from : s.to, s.center))
        }
      }
      from = s.to
    }
  }
  pair(0, 'ENDSEC'); pair(0, 'EOF')
  return lines.join('\n') + '\n'
}
