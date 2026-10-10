import type { Loop2D, LoopSegment, Vec2 } from '../../types'
import { optimizeLoops } from '../geometry/loopOptimizer'
import { bakeSketch } from './bake'
import type { Sketch } from './types'

const TAU = Math.PI * 2
const number = (v: number) => String(Number(v.toFixed(6)))
const point = (p: Vec2) => `${number(p.x)} ${number(p.y)}`
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const positive = (a: number) => ((a % TAU) + TAU) % TAU

function sweep(from: Vec2, arc: Extract<LoopSegment, { type: 'arc' }>): number {
  if (Math.hypot(from.x - arc.to.x, from.y - arc.to.y) < 1e-9) return TAU
  const a = Math.atan2(from.y - arc.center.y, from.x - arc.center.x)
  const b = Math.atan2(arc.to.y - arc.center.y, arc.to.x - arc.center.x)
  return positive(arc.clockwise ? a - b : b - a)
}

/** Fit only dense baked polylines. Exact baked line/arc chains stay exact. */
function fitted(loop: Loop2D): Loop2D {
  if ((loop.segments?.length ?? 0) < 8 || loop.segments?.some((s) => s.type === 'arc')) return loop
  const result = optimizeLoops([loop], { tolerance: 0.001, resampleStep: 0.1 })[0]
  const segments = [...(result.segments ?? [])]
  // The shared fitter leaves the closing edge implicit; SVG must retain it.
  if (loop.closed && segments.length && Math.hypot(segments.at(-1)!.to.x - result.points[0].x, segments.at(-1)!.to.y - result.points[0].y) > 1e-9) {
    segments.push({ type: 'line', to: result.points[0] })
  }
  return { ...result, segments }
}

/** Millimetre document from the CAM bake, with one Y flip and no model walk. */
export function exportSketchSvg(sketch: Sketch, name = 'Sketch'): string {
  const baked = bakeSketch(sketch).loops
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const include = (p: Vec2) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  for (const loop of baked) {
    loop.points.forEach(include)
    let from = loop.points[0]
    for (const s of loop.segments ?? []) {
      include(s.to)
      if (s.type === 'arc') {
        const start = Math.atan2(from.y - s.center.y, from.x - s.center.x)
        for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
          const travel = positive(s.clockwise ? start - angle : angle - start)
          if (travel <= sweep(from, s) + 1e-9) include({ x: s.center.x + s.radius * Math.cos(angle), y: s.center.y + s.radius * Math.sin(angle) })
        }
      }
      from = s.to
    }
  }
  if (!baked.length) { minX = minY = 0; maxX = maxY = 1 }
  // Empty and zero-span drawings still have a usable physical viewport.
  const width = maxX - minX || 1, height = maxY - minY || 1
  const shapes = baked.map(fitted).map((loop) => {
    const segments = loop.segments ?? []
    const circle = segments.length === 1 && segments[0].type === 'arc' && loop.closed ? segments[0] : null
    if (circle) return `    <circle cx="${number(circle.center.x)}" cy="${number(circle.center.y)}" r="${number(circle.radius)}"/>`
    let from = loop.points[0]
    const commands = [`M ${point(from)}`]
    for (const s of segments) {
      if (s.type === 'line') commands.push(`L ${point(s.to)}`)
      else commands.push(`A ${number(s.radius)} ${number(s.radius)} 0 ${sweep(from, s) > Math.PI ? 1 : 0} ${s.clockwise ? 0 : 1} ${point(s.to)}`)
      from = s.to
    }
    if (loop.closed) commands.push('Z')
    return `    <path d="${commands.join(' ')}"/>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}mm" height="${number(height)}mm" viewBox="${number(minX)} ${number(-maxY)} ${number(width)} ${number(height)}" overflow="visible">\n  <title>${xml(name)}</title>\n  <g id="${xml(name)}" transform="scale(1 -1)" fill="none" stroke="#000000" stroke-width="0.1">\n${shapes.join('\n')}\n  </g>\n</svg>\n`
}
