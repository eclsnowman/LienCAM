import type { Pt } from './clipperEngine'

/** Simplify against every original point, never against an already merged tail.
 * Protected transition points split the problem and remain exact. */
export function boundedCleanPath(path: Pt[], tolerance: number, protectedPoints?: ReadonlySet<Pt>): Pt[] {
  if (path.length < 3) return path.slice()
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('boundedCleanPath: invalid tolerance')
  const keep = new Uint8Array(path.length)
  keep[0] = keep[path.length - 1] = 1
  const anchors = [0]
  for (let i = 1; i < path.length - 1; i++) {
    if (protectedPoints?.has(path[i])) { keep[i] = 1; anchors.push(i) }
  }
  anchors.push(path.length - 1)
  const stack: [number, number][] = []
  for (let i = 1; i < anchors.length; i++) stack.push([anchors[i - 1], anchors[i]])
  const limit = tolerance * tolerance
  while (stack.length) {
    const [first, last] = stack.pop()!
    const a = path[first], b = path[last]
    const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy
    let worst = limit, split = -1
    for (let i = first + 1; i < last; i++) {
      const p = path[i]
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0
      const ex = p.x - a.x - t * dx, ey = p.y - a.y - t * dy
      const error = ex * ex + ey * ey
      if (error > worst) { worst = error; split = i }
    }
    if (split >= 0) {
      keep[split] = 1
      stack.push([first, split], [split, last])
    }
  }
  return path.filter((_, i) => keep[i])
}
