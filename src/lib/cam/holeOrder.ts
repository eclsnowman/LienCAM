type Pt = { x: number; y: number }

export type HoleOrderStrategy = 'none' | 'nearest_neighbor' | 'by_x' | 'by_y'

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function nearestNeighbourSort<T extends Pt>(pts: T[]): T[] {
  if (pts.length <= 1) return pts
  const remaining = [...pts]
  const sorted: T[] = [remaining.splice(0, 1)[0]]
  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1]
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(last, remaining[i])
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    sorted.push(remaining.splice(bestIdx, 1)[0])
  }
  return sorted
}

export function orderHoleLikePoints<T extends Pt>(
  pts: T[],
  strategy: HoleOrderStrategy,
): T[] {
  switch (strategy) {
    case 'nearest_neighbor': return nearestNeighbourSort(pts)
    case 'by_x':             return [...pts].sort((a, b) => a.x - b.x)
    case 'by_y':             return [...pts].sort((a, b) => a.y - b.y)
    case 'none':             return pts
  }
}
