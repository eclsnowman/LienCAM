/** WO-2505 restricted verifier building block, not a kernel/body certificate.
 *
 * Input is one COMPLETE, untrimmed tensor-product rational Bezier patch on
 * [0,1]^2. Pole boxes are already in model-space mm, enclosing any export and
 * location-transform error; weight intervals enclose the exact positive
 * weights. A trimmed support surface cannot supply boundary witnesses here:
 * holes, seams and post-heal topology still require a kernel cover adapter.
 * No production operation or Model UI consumes this module.
 */
import type { Point3, SurfaceBox, SurfaceCover } from '../worker/simplifyDeviation'

export interface ScalarInterval { min: number; max: number }
export interface RationalBezierPatch {
  /** First index is U; second is V. Both degrees must be at least one. */
  poles: readonly (readonly SurfaceBox[])[]
  weights: readonly (readonly ScalarInterval[])[]
}

type HPoint = [ScalarInterval, ScalarInterval, ScalarInterval, ScalarInterval]
type Net = HPoint[][]
const storage = new DataView(new ArrayBuffer(8))

function outward(value: number, up: boolean): number {
  if (!Number.isFinite(value)) return value
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE
  storage.setFloat64(0, value)
  storage.setBigUint64(0, storage.getBigUint64(0) + ((value > 0) === up ? 1n : -1n))
  return storage.getFloat64(0)
}

function checked(min: number, max: number): ScalarInterval {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error('Bezier enclosure arithmetic is not finite')
  }
  return { min, max }
}

function multiply(a: ScalarInterval, b: ScalarInterval): ScalarInterval {
  const products = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max]
  return checked(outward(Math.min(...products), false), outward(Math.max(...products), true))
}

function midpoint(a: ScalarInterval, b: ScalarInterval): ScalarInterval {
  // Scale before adding: finite large operands need not overflow their average.
  return checked(
    outward(outward(a.min * 0.5, false) + outward(b.min * 0.5, false), false),
    outward(outward(a.max * 0.5, true) + outward(b.max * 0.5, true), true),
  )
}

function dividePositive(a: ScalarInterval, b: ScalarInterval): ScalarInterval {
  if (b.min <= 0) throw new Error('Bezier weight enclosure does not prove a positive denominator')
  const ratios = [a.min / b.min, a.min / b.max, a.max / b.min, a.max / b.max]
  return checked(outward(Math.min(...ratios), false), outward(Math.max(...ratios), true))
}

function splitCurve(points: HPoint[]): [HPoint[], HPoint[]] {
  let level = points
  const left = [level[0]], right = [level[level.length - 1]]
  while (level.length > 1) {
    level = level.slice(1).map((p, i) => p.map((coordinate, axis) =>
      midpoint(level[i][axis], coordinate)) as HPoint)
    left.push(level[0]); right.unshift(level[level.length - 1])
  }
  return [left, right]
}

function splitNet(net: Net): [Net, Net, Net, Net] {
  const nu = net.length, nv = net[0].length
  const uLeft: Net = Array.from({ length: nu }, () => [])
  const uRight: Net = Array.from({ length: nu }, () => [])
  for (let v = 0; v < nv; v++) {
    const [left, right] = splitCurve(net.map(row => row[v]))
    for (let u = 0; u < nu; u++) { uLeft[u].push(left[u]); uRight[u].push(right[u]) }
  }
  const left = uLeft.map(splitCurve), right = uRight.map(splitCurve)
  return [left.map(row => row[0]), left.map(row => row[1]),
    right.map(row => row[0]), right.map(row => row[1])]
}

function project(p: HPoint): SurfaceBox {
  const xyz = p.slice(0, 3).map(coordinate => dividePositive(coordinate, p[3]))
  return { min: xyz.map(i => i.min) as unknown as Point3, max: xyz.map(i => i.max) as unknown as Point3 }
}

function validate(patch: RationalBezierPatch, depth: number): void {
  // Bound the experiment's work explicitly: at most 1024 leaf cells per patch.
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) throw new Error('Bezier subdivision depth must be 0 through 5')
  const nu = patch.poles.length, nv = patch.poles[0]?.length ?? 0
  if (nu < 2 || nv < 2 || nu > 17 || nv > 17 || patch.weights.length !== nu) {
    throw new Error('Expected a rectangular Bezier net of degree 1 through 16')
  }
  for (let u = 0; u < nu; u++) {
    if (patch.poles[u].length !== nv || patch.weights[u]?.length !== nv) throw new Error('Ragged Bezier net')
    for (let v = 0; v < nv; v++) {
      const p = patch.poles[u][v], w = patch.weights[u][v]
      if (p.min.length !== 3 || p.max.length !== 3 || p.min.some((x, axis) =>
        !Number.isFinite(x) || !Number.isFinite(p.max[axis]) || x > p.max[axis])) {
        throw new Error('Invalid Bezier pole enclosure')
      }
      if (!Number.isFinite(w.min) || !Number.isFinite(w.max) || w.min <= 0 || w.min > w.max) {
        throw new Error('Bezier weight enclosure must be finite and strictly positive')
      }
    }
  }
}

/** Complete continuous cover by positive-weight convex hulls after homogeneous
 * de Casteljau subdivision. Each leaf contributes its four endpoint boxes as
 * witnesses: those boxes enclose actual points, rather than control poles that
 * generally lie OFF the surface. Outward intervals cover every arithmetic step.
 * Increasing depth tightens hulls; it never substitutes samples for coverage.
 * Overflow or a lost positive-weight proof throws instead of issuing a bound.
 */
export function coverRationalBezierPatch(patch: RationalBezierPatch, depth = 2): SurfaceCover {
  validate(patch, depth)
  const net: Net = patch.poles.map((row, u) => row.map((p, v) => {
    const w = patch.weights[u][v]
    return [0, 1, 2].map(axis => multiply({ min: p.min[axis], max: p.max[axis] }, w))
      .concat([{ ...w }]) as HPoint
  }))
  const cells: SurfaceBox[] = [], witnesses: SurfaceBox[] = []
  function visit(current: Net, remaining: number): void {
    if (remaining) { for (const child of splitNet(current)) visit(child, remaining - 1); return }
    const projected = current.flatMap(row => row.map(project))
    cells.push({
      min: [0, 1, 2].map(axis => Math.min(...projected.map(p => p.min[axis]))) as unknown as Point3,
      max: [0, 1, 2].map(axis => Math.max(...projected.map(p => p.max[axis]))) as unknown as Point3,
    })
    const lastU = current.length - 1, lastV = current[0].length - 1
    witnesses.push(project(current[0][0]), project(current[0][lastV]),
      project(current[lastU][0]), project(current[lastU][lastV]))
  }
  visit(net, depth)
  return { cells, witnesses }
}
