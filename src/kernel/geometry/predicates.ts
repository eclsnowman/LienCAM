import type { Location, Loop, Loops, Point } from './contracts'

export function signedArea(loop: Loop): number {
  let sum = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
function onSegment(a: Point, b: Point, p: Point): boolean {
  return cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
}
function winding(point: Point, loop: Loop): number | 'boundary' {
  let count = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    if (onSegment(a, b, point)) return 'boundary'
    const side = cross(a, b, point)
    if (a.y <= point.y && b.y > point.y && side > 0) count++
    if (a.y > point.y && b.y <= point.y && side < 0) count--
  }
  return count
}
/** Exact boundary test, with no new snap epsilon or coordinate quantisation. */
export function locatePoint(point: Point, loops: Loops, fill: 'EvenOdd' | 'NonZero' | 'Positive' = 'NonZero'): Location {
  let sum = 0
  for (const loop of loops) {
    const value = winding(point, loop)
    if (value === 'boundary') return 'boundary'
    sum += value
  }
  return (fill === 'EvenOdd' ? Math.abs(sum) % 2 !== 0 : fill === 'Positive' ? sum > 0 : sum !== 0) ? 'inside' : 'outside'
}
/** Boundary membership must be chosen explicitly by the future consumer. */
export function containsRegion(point: Point, loops: Loops, fill: 'EvenOdd' | 'NonZero' | 'Positive', boundary: 'include' | 'exclude'): boolean {
  const location = locatePoint(point, loops, fill)
  return location === 'inside' || (location === 'boundary' && boundary === 'include')
}
export function selfIntersects(input: Loop): boolean {
  // Explicit repeated closing vertex is retained for the backend, but is not
  // itself an intersection. Include touches and overlaps of non-neighbour edges.
  const first = input[0], last = input[input.length - 1]
  const loop = first && last && first.x === last.x && first.y === last.y ? input.slice(0, -1) : input
  const n = loop.length
  // Sweep over x so only edges whose boxes overlap are tested (WO-2996: a
  // 20 000-point Contour loop took ~4 s per offset with every pair tested).
  // Two edges that touch or cross always have overlapping boxes, and each pair
  // is tested in the same (lower, higher) index order as the full pair scan.
  const minX = new Float64Array(n), maxX = new Float64Array(n), minY = new Float64Array(n), maxY = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n]
    minX[i] = Math.min(a.x, b.x); maxX[i] = Math.max(a.x, b.x)
    minY[i] = Math.min(a.y, b.y); maxY[i] = Math.max(a.y, b.y)
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => minX[p] - minX[q])
  for (let s = 0; s < n; s++) {
    const e = order[s]
    for (let t = s + 1; t < n && minX[order[t]] <= maxX[e]; t++) {
      const f = order[t]
      if (maxY[f] < minY[e] || minY[f] > maxY[e]) continue
      const i = Math.min(e, f), j = Math.max(e, f)
      if (j - i < 2 || (i === 0 && j === n - 1)) continue
      const a = loop[i], b = loop[(i + 1) % n], c = loop[j], d = loop[(j + 1) % n]
      if (onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return true
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true
    }
  }
  return false
}
