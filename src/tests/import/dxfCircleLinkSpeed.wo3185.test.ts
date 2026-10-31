import { describe, expect, it } from 'vitest'
import { importDXF, linkAnalyticCircles } from '../../lib/import/dxfImporter'

// WO-3185: WO-3135 linked every loop to every CIRCLE (4,000 circles took the
// import from 4.1 s to 10.8 s). The links themselves must not change.
type Pairs = Array<[number | string, number | string]>
const dxf = (pairs: Pairs) => pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n'
const circle = (layer: string, x: number, y: number, radius: number): Pairs =>
  [[0, 'CIRCLE'], [8, layer], [10, x], [20, y], [40, radius]]
const diameter = (loop: object) => (loop as { importedCircleDiameter?: number }).importedCircleDiameter

function drawing(circles: Pairs[]): string {
  return dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...circles.flat(), [0, 'ENDSEC'], [0, 'EOF']])
}

describe('WO-3185 DXF circle links', () => {
  it('every circle in a dense grid keeps its own diameter', () => {
    // 4,000 equal holes on one layer: every loop has the same sample count,
    // so the old scan compared each loop with every circle.
    const circles: Pairs[] = []
    const radii: number[] = []
    for (let i = 0; i < 80; i++) for (let j = 0; j < 50; j++) {
      circles.push(circle('A', i * 10, j * 10, 3))
      radii.push(3)
    }
    const started = performance.now()
    const { loops } = importDXF(drawing(circles))
    const elapsed = performance.now() - started
    console.log(`WO-3185 4000 circles imported in ${elapsed.toFixed(0)} ms`)
    expect(loops).toHaveLength(4000)
    for (const loop of loops) expect(diameter(loop)).toBe(6)
  })

  it('links each loop by looking at a handful of circles, not all of them', () => {
    // Count reads of each circle's samples: the old scan read every circle
    // for every loop (n x n); timing alone is too noisy on a loaded box.
    const { loops } = importDXF(drawing(Array.from({ length: 2000 }, (_, i) => circle('A', (i % 50) * 10, Math.floor(i / 50) * 10, 3))))
    let reads = 0
    const segments = loops.map(loop => {
      const points = [...loop.points, loop.points[0]]
      return { layerName: loop.layerId, analyticCircle: { center: { x: 0, y: 0 }, diameter: 6 },
        get points() { reads++; return points } }
    })
    const linked = linkAnalyticCircles(loops, segments)
    expect(linked.every(loop => diameter(loop) === 6)).toBe(true)
    expect(reads).toBeLessThan(10 * loops.length)
  })

  it('concentric circles and same-centre circles on another layer each keep their own', () => {
    const { loops } = importDXF(drawing([circle('A', 5, 5, 3), circle('A', 5, 5, 2), circle('B', 5, 5, 3)]))
    expect(loops.map(loop => [loop.layerId, diameter(loop)]).sort()).toEqual([['A', 4], ['A', 6], ['B', 6]])
  })

  it('a closed polyline is not given a circle diameter', () => {
    const square: Pairs = [[0, 'LWPOLYLINE'], [8, 'A'], [90, 4], [70, 1],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10]]
    const { loops } = importDXF(drawing([square, circle('A', 5, 5, 1)]))
    expect(loops.map(diameter).sort()).toEqual([2, undefined])
  })
})
