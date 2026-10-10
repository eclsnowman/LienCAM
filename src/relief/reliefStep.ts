// Image relief - the exact relief face as explicit B-spline control poles,
// written as STEP for the kernel to read (the route Form proved:
// src/form/exactStep.ts -> importStep).
//
// Why not occt-wasm's bsplineSurface(points, rows, cols)? MEASURED (WO-2170):
// it FITS a surface through the points (degree up to 8, its own pole count),
// and the fit is not safe on a relief: a 64 x 64 cosine bump came back
// spanning z -6248 .. +5310 mm (area 87 million mm^2), and 32 x 32 rang
// 0.26 mm BELOW the face at the bump's foot. Explicit poles cannot do that.
//
// The surface here is a clamped uniform bicubic B-spline with n x n poles:
// - each pole sits at its Greville point, so X and Y are exactly linear in the
//   surface parameters (the relief is not stretched) and the surface is the
//   height grid, gently smoothed over about one pole pitch;
// - a B-spline stays inside its poles' convex hull, so heights >= 0 give a
//   surface that never dips below the face, and where the heights are zero
//   the surface lies EXACTLY on the face (the plan's section 3, step 4);
// - its volume is known in closed form (poleSurfaceVolume), which separates
//   the kernel's error from the sampling error.

import { heightAt, type HeightGrid } from './heightGrid'

/** Knot values of a clamped uniform cubic with n poles, as distinct values + multiplicities (STEP form). */
export function clampedCubicKnots(n: number): { knots: number[]; mults: number[] } {
  if (n < 4) throw new Error(`a cubic B-spline needs at least 4 poles per side, got ${n}`)
  const spans = n - 3
  const knots = Array.from({ length: spans + 1 }, (_, i) => i)
  const mults = knots.map((_, i) => (i === 0 || i === spans ? 4 : 1))
  return { knots, mults }
}

/** Greville abscissa of pole i (0..n-1) as a fraction 0..1 of the side. */
export function grevilleFraction(i: number, n: number): number {
  const spans = n - 3
  // full knot vector: 0,0,0,0,1,2,...,spans-1,spans,spans,spans,spans
  const t = (k: number) => Math.min(Math.max(k - 3, 0), spans)
  return (t(i + 1) + t(i + 2) + t(i + 3)) / 3 / spans
}

/** Integral of basis function i over the parameter range, in knot spans. */
function basisIntegral(i: number, n: number): number {
  const spans = n - 3
  const t = (k: number) => Math.min(Math.max(k - 3, 0), spans)
  return (t(i + 4) - t(i)) / 4
}

export interface ReliefPoles {
  n: number
  widthMm: number
  depthMm: number
  /** pole heights above the face, mm; index = iy * n + ix */
  heights: Float64Array
}

/** Pole heights sampled from the grid at the Greville points; the border ring is exactly 0. */
export function reliefPoles(g: HeightGrid, n: number): ReliefPoles {
  const heights = new Float64Array(n * n)
  for (let iy = 1; iy < n - 1; iy++) {
    const y = grevilleFraction(iy, n) * g.depthMm
    for (let ix = 1; ix < n - 1; ix++) heights[iy * n + ix] = heightAt(g, grevilleFraction(ix, n) * g.widthMm, y)
  }
  return { n, widthMm: g.widthMm, depthMm: g.depthMm, heights }
}

/** Exact volume between the pole surface and the face, mm^3. */
export function poleSurfaceVolume(p: ReliefPoles): number {
  const a = Array.from({ length: p.n }, (_, i) => basisIntegral(i, p.n))
  let sum = 0
  for (let iy = 0; iy < p.n; iy++) for (let ix = 0; ix < p.n; ix++) sum += a[ix] * a[iy] * p.heights[iy * p.n + ix]
  const spans = p.n - 3
  return sum * (p.widthMm / spans) * (p.depthMm / spans)
}

/** The four non-zero cubic basis values at parameter t (0..spans) and the first pole they weight (NURBS Book A2.2). */
function cubicBasis(t: number, spans: number): { first: number; N: number[] } {
  const T = (k: number) => Math.min(Math.max(k - 3, 0), spans)
  const s = Math.min(Math.max(Math.floor(t), 0), spans - 1)
  const i = s + 3
  const N = [1, 0, 0, 0]
  const left = [0, 0, 0, 0]
  const right = [0, 0, 0, 0]
  for (let j = 1; j <= 3; j++) {
    left[j] = t - T(i + 1 - j)
    right[j] = T(i + j) - t
    let saved = 0
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r])
      N[r] = saved + right[r + 1] * temp
      saved = left[j - r] * temp
    }
    N[j] = saved
  }
  return { first: s, N }
}

/** Height of the pole surface above the face at (x, y) mm inside the relief rectangle (X, Y are linear in U, V). */
export function poleSurfaceHeight(p: ReliefPoles, x: number, y: number): number {
  const spans = p.n - 3
  const bu = cubicBasis((Math.min(Math.max(x, 0), p.widthMm) / p.widthMm) * spans, spans)
  const bv = cubicBasis((Math.min(Math.max(y, 0), p.depthMm) / p.depthMm) * spans, spans)
  let h = 0
  for (let b = 0; b < 4; b++) {
    const row = (bv.first + b) * p.n + bu.first
    for (let a = 0; a < 4; a++) h += bv.N[b] * bu.N[a] * p.heights[row + a]
  }
  return h
}

/** A STEP real: always with a decimal point. 12 significant digits is 1e-9 mm on a 1 m part. */
function real(x: number): string {
  if (Object.is(x, -0) || x === 0) return '0.'
  let t = Number.isInteger(x) && Math.abs(x) < 1e15 ? `${x}.` : x.toPrecision(12)
  t = t.replace('e', 'E')
  if (!t.includes('.')) t = t.replace('E', '.E')
  return t
}

/**
 * STEP text of the relief as ONE face (an open shell in a surface model),
 * placed with its low corner at `origin` on the plane z = baseZ, normal +Z.
 * Surface U runs along X, V along Y. The four boundary edges are the pole
 * surface's own boundary curves, straight lines in the plane.
 */
export function reliefFaceStep(p: ReliefPoles, origin: { x: number; y: number }, baseZ: number, name = 'relief'): string {
  return reliefFaceStepInFrame(p, {
    origin: { x: origin.x, y: origin.y, z: baseZ },
    xDir: { x: 1, y: 0, z: 0 },
    yDir: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  }, name)
}

/** Where a relief face sits: the rectangle's low corner and its axes (unit, xDir x yDir = normal, the face's outward normal). */
export interface PoleFrame {
  origin: { x: number; y: number; z: number }
  xDir: { x: number; y: number; z: number }
  yDir: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
}

/**
 * The same face on any flat face (WO-2171): pole (ix, iy) at
 * origin + gx xDir + gy yDir + h normal. A B-spline is affine-invariant, so
 * the surface is the +Z one carried onto the face exactly.
 */
export function reliefFaceStepInFrame(p: ReliefPoles, frame: PoleFrame, name = 'relief'): string {
  const n = p.n
  const lines: string[] = []
  const add = (body: string): string => {
    lines.push(body)
    return `#${lines.length}`
  }
  const { origin, xDir, yDir, normal } = frame
  const gx = Array.from({ length: n }, (_, i) => grevilleFraction(i, n) * p.widthMm)
  const gy = Array.from({ length: n }, (_, i) => grevilleFraction(i, n) * p.depthMm)
  const pole: string[] = new Array(n * n)
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const h = p.heights[iy * n + ix]
      const x = origin.x + gx[ix] * xDir.x + gy[iy] * yDir.x + h * normal.x
      const y = origin.y + gx[ix] * xDir.y + gy[iy] * yDir.y + h * normal.y
      const z = origin.z + gx[ix] * xDir.z + gy[iy] * yDir.z + h * normal.z
      pole[iy * n + ix] = add(`CARTESIAN_POINT('',(${real(x)},${real(y)},${real(z)}))`)
    }
  }
  const { knots, mults } = clampedCubicKnots(n)
  const K = `(${mults.join(',')})`
  const T = `(${knots.map(real).join(',')})`
  const rows: string[] = []
  for (let ix = 0; ix < n; ix++) {
    const row: string[] = []
    for (let iy = 0; iy < n; iy++) row.push(pole[iy * n + ix])
    rows.push(`(${row.join(',')})`)
  }
  const surface = add(`B_SPLINE_SURFACE_WITH_KNOTS('',3,3,(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,${K},${K},${T},${T},.UNSPECIFIED.)`)
  const curve = (refs: string[]) => add(`B_SPLINE_CURVE_WITH_KNOTS('',3,(${refs.join(',')}),.UNSPECIFIED.,.F.,.F.,${K},${T},.UNSPECIFIED.)`)
  const corner = (ix: number, iy: number) => add(`VERTEX_POINT('',${pole[iy * n + ix]})`)
  const v00 = corner(0, 0), v10 = corner(n - 1, 0), v11 = corner(n - 1, n - 1), v01 = corner(0, n - 1)
  const idx = Array.from({ length: n }, (_, i) => i)
  const bottom = add(`EDGE_CURVE('',${v00},${v10},${curve(idx.map((i) => pole[i]))},.T.)`)
  const right = add(`EDGE_CURVE('',${v10},${v11},${curve(idx.map((i) => pole[i * n + n - 1]))},.T.)`)
  const top = add(`EDGE_CURVE('',${v01},${v11},${curve(idx.map((i) => pole[(n - 1) * n + i]))},.T.)`)
  const left = add(`EDGE_CURVE('',${v00},${v01},${curve(idx.map((i) => pole[i * n]))},.T.)`)
  const oe = (e: string, same: boolean) => add(`ORIENTED_EDGE('',*,*,${e},${same ? '.T.' : '.F.'})`)
  const loop = add(`EDGE_LOOP('',(${oe(bottom, true)},${oe(right, true)},${oe(top, false)},${oe(left, false)}))`)
  const bound = add(`FACE_OUTER_BOUND('',${loop},.T.)`)
  const face = add(`ADVANCED_FACE('',(${bound}),${surface},.T.)`)
  const shell = add(`OPEN_SHELL('',(${face}))`)
  const model = add(`SHELL_BASED_SURFACE_MODEL('${name}',(${shell}))`)
  const ctx = add("APPLICATION_CONTEXT('automotive design')")
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ctx})`)
  const pctx = add(`PRODUCT_CONTEXT('',${ctx},'mechanical')`)
  const product = add(`PRODUCT('${name}','${name}','',(${pctx}))`)
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',${product})`)
  const dctx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ctx},'design')`)
  const definition = add(`PRODUCT_DEFINITION('design','',${formation},${dctx})`)
  const shape = add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)
  const mm = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))')
  const rad = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))')
  const sr = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())')
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','')`)
  const gctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr}))REPRESENTATION_CONTEXT('',''))`)
  const rep = add(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${name}',(${model}),${gctx})`)
  add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${rep})`)
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('LienCAM relief face'),'2;1');",
    `FILE_NAME('${name}.stp','',(''),(''),'LienCAM','LienCAM','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    lines.map((body, i) => `#${i + 1}=${body};`).join('\n'),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n')
}

/**
 * The pole surface's heights on an (nx+1) x (ny+1) grid of points spread
 * evenly over the rectangle (row 0 at y = 0), each basis computed once per
 * column and once per row - the fast form of poleSurfaceHeight for a preview grid.
 */
export function poleSurfaceGrid(p: ReliefPoles, nx: number, ny: number): Float32Array {
  const spans = p.n - 3
  const cols = Array.from({ length: nx + 1 }, (_, c) => cubicBasis((c / nx) * spans, spans))
  const out = new Float32Array((nx + 1) * (ny + 1))
  for (let r = 0; r <= ny; r++) {
    const bv = cubicBasis((r / ny) * spans, spans)
    for (let c = 0; c <= nx; c++) {
      const bu = cols[c]
      let h = 0
      for (let b = 0; b < 4; b++) {
        const row = (bv.first + b) * p.n + bu.first
        h += bv.N[b] * (bu.N[0] * p.heights[row] + bu.N[1] * p.heights[row + 1] + bu.N[2] * p.heights[row + 2] + bu.N[3] * p.heights[row + 3])
      }
      out[r * (nx + 1) + c] = h
    }
  }
  return out
}
