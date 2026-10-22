// WO-2955: symmetry turned on after the form was already edited without it.
// Turning it on never changes the cage. The points the form started paired
// with stay paired (the cage remembers its own earlier, symmetric shape), and a
// later move mirrors only that move: an asymmetry made before symmetry was on
// is kept, never mirrored away. A pair the form cannot vouch for (missing,
// ambiguous, an old file without that memory) keeps today's move-alone rule.
// Driven through the Form store's own actions, as the viewport drives them.

import { beforeEach, describe, expect, it } from 'vitest'
import { Matrix4 } from 'three'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage, cylinderCage } from '../../form/starters'
import { useFormStore } from '../../form/formStore'

const st = () => useFormStore.getState()
const sel = (points: number[]) => st().setSelection({ points, edges: [], faces: [] })
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const near = (a: Vec3, b: Vec3, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(tol)

/** The gizmo's gesture: select, begin, one delta, release. */
function moveMatrix(points: number[], m: Matrix4): void {
  sel(points)
  st().beginMove({ extrude: false })
  st().moveBy(m.elements)
  st().endDrag()
}
const move = (points: number[], d: Vec3) => moveMatrix(points, new Matrix4().makeTranslation(d[0], d[1], d[2]))

function open(cage: Cage): void {
  st().openSession({ featureId: null, name: 'Form', cage })
  st().setSoftRadius(0)
}

const box = () => boxCage()
const shifted = (): Cage => { const c = boxCage(); c.positions = c.positions.map((p) => add(p, [7, 5, 7])); return c }
const cyl = (n: number) => cylinderCage({ segments: { x: n, y: 1, z: 2 } })
const rot = (p: Vec3, k: number, n: number): Vec3 => { const a = (2 * Math.PI * k) / n; return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]] }
const indexOf = (c: Cage, p: Vec3) => c.positions.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-6)

/** a mirror's linear part: what it does to a displacement */
const reflect = (n: Vec3) => (d: Vec3): Vec3 => { const k = 2 * (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]); return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]] }
const DIAG: Vec3 = [Math.SQRT1_2, -Math.SQRT1_2, 0]

interface MirrorCase { mode: string; cage: () => Cage; enable: () => void; a: Vec3; b: Vec3; linear: (d: Vec3) => Vec3 }
/** placed plane x = y: Mirror from selection on two corners that mirror onto each other */
const placeDiagonal = (off: Vec3) => () => { const c = st().cage; sel([indexOf(c, add([20, -20, 40], off)), indexOf(c, add([-20, 20, 40], off))]); st().mirrorFromSelection() }
const MIRRORS: MirrorCase[] = [
  { mode: 'X', cage: box, enable: () => st().setSymmetry('x'), a: [20, 20, 40], b: [-20, 20, 40], linear: reflect([1, 0, 0]) },
  { mode: 'Y', cage: box, enable: () => st().setSymmetry('y'), a: [20, 20, 40], b: [20, -20, 40], linear: reflect([0, 1, 0]) },
  { mode: 'Z', cage: box, enable: () => st().setSymmetry('z'), a: [20, 20, 40], b: [20, 20, 0], linear: reflect([0, 0, 1]) },
  { mode: 'X at 7', cage: shifted, enable: () => { st().setSymmetry('x'); st().setSymmetryAt(7) }, a: [27, 25, 47], b: [-13, 25, 47], linear: reflect([1, 0, 0]) },
  { mode: 'Y at 5', cage: shifted, enable: () => { st().setSymmetry('y'); st().setSymmetryAt(5) }, a: [27, 25, 47], b: [27, -15, 47], linear: reflect([0, 1, 0]) },
  { mode: 'Z at 27', cage: shifted, enable: () => st().setSymmetry('z'), a: [27, 25, 47], b: [27, 25, 7], linear: reflect([0, 0, 1]) },
  { mode: 'placed x = y', cage: box, enable: placeDiagonal([0, 0, 0]), a: [20, 0, 40], b: [0, 20, 40], linear: reflect(DIAG) },
  { mode: 'placed x - y = 2', cage: shifted, enable: placeDiagonal([7, 5, 7]), a: [27, 5, 47], b: [7, 25, 47], linear: reflect(DIAG) },
]
const D1: Vec3 = [6, 3, 0]
const D2: Vec3 = [3, 2, 2]

beforeEach(() => {
  st().closeSession()
  st().setSymmetry(null)
})

describe('WO-2955: late-enabled mirror symmetry', () => {
  it.each(MIRRORS)('late enable preserves every cage field for $mode', (c) => {
    open(c.cage())
    const A = indexOf(st().cage, c.a)
    move([A], D1)
    const before = copy(st().cage), past = st().history.past.length, edits = st().editVersion
    c.enable()
    expect(st().symmetry).not.toBeNull()
    expect(st().cage).toEqual(before)
    expect(st().history.past).toHaveLength(past)
    expect(st().editVersion).toBe(edits)
  })

  it.each(MIRRORS)('a later move mirrors only its new displacement ($mode)', (c) => {
    open(c.cage())
    const A = indexOf(st().cage, c.a), B = indexOf(st().cage, c.b)
    expect(A).toBeGreaterThanOrEqual(0)
    expect(B).toBeGreaterThanOrEqual(0)
    move([A], D1)
    c.enable()
    const before = copy(st().cage.positions)
    move([A], D2)
    const P = st().cage.positions
    near(P[A], add(add(c.a, D1), D2))
    // the partner takes the mirrored NEW move and keeps the earlier asymmetry
    near(P[B], add(c.b, c.linear(D2)))
    // nothing else moved, to the bit
    P.forEach((p, i) => { if (i !== A && i !== B) expect(p).toEqual(before[i]) })
  })

  it('the reproducer: corner 17 then Mirror X then [3, 2, 2] leaves partner 15 at [-23, 22, 42]', () => {
    open(box())
    expect(st().cage.positions[17]).toEqual([20, 20, 40])
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    move([17], D1)
    st().setSymmetry('x')
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    move([17], D2)
    expect(st().cage.positions[17]).toEqual([29, 25, 42])
    expect(st().cage.positions[15]).toEqual([-23, 22, 42])
  })

  it('a residual within the match tolerance is preserved', () => {
    open(box())
    // 0.0005 mm: inside today's pairing reach (about 0.0014 mm on this box), so every point pairs
    move([17], [0.0005, 0, 0])
    st().setSymmetry('x')
    expect(st().notice).not.toMatch(/move alone/)
    move([17], [1, 0, 0])
    near(st().cage.positions[17], [21.0005, 20, 40], 1e-12)
    near(st().cage.positions[15], [-21, 20, 40], 1e-12)
  })

  it('symmetry on before the edits keeps the conventional absolute mirror, exactly', () => {
    open(box())
    st().setSymmetry('x')
    move([17], D1)
    expect(st().cage.positions[15]).toEqual([-26, 23, 40])
    move([17], D2)
    expect(st().cage.positions[17]).toEqual([29, 25, 42])
    expect(st().cage.positions[15]).toEqual([-29, 25, 42])
    // a seam point moved across the plane is held on it
    move([16], [4, 1, 0])
    expect(st().cage.positions[16]).toEqual([0, 21, 40])
  })

  it('a late-enabled form with no asymmetry edits exactly as a pre-enabled one', () => {
    open(box())
    st().setSymmetry('x')
    move([17], D1); move([25], [0, 2, 5]); move([16], [0, 0, 3])
    const pre = copy(st().cage.positions)
    st().closeSession()
    st().setSymmetry(null)
    open(box())
    move([4], [0, 0, 0])
    st().setSymmetry('x')
    move([17], D1); move([25], [0, 2, 5]); move([16], [0, 0, 3])
    expect(st().cage.positions).toEqual(pre)
  })

  it('a seam point moved off the plane before symmetry keeps that offset, moves alone, and can go back onto the plane', () => {
    open(box())
    move([16], [2, 0, 0])
    st().setSymmetry('x')
    expect(st().notice).toMatch(/1 point has no mirror partner and moves alone/)
    move([17], D2)
    expect(st().cage.positions[16]).toEqual([2, 20, 40])
    move([16], [1, 1, 1])
    near(st().cage.positions[16], [3, 21, 41])
    move([16], [-3, 0, 0])
    near(st().cage.positions[16], [0, 21, 41])
    // back on the plane it is a seam point again: held there
    move([16], [4, 0, 0])
    near(st().cage.positions[16], [0, 21, 41])
  })

  it('a seam point a hair off the plane keeps that hair and slides along the plane', () => {
    open(box())
    move([16], [0.0001, 0, 0])
    st().setSymmetry('x')
    move([16], [1, 1, 1])
    near(st().cage.positions[16], [0.0001, 21, 41], 1e-12)
  })

  it('the operator\'s own pick wins; with both sides picked the + side wins', () => {
    open(box())
    move([17], D1)
    st().setSymmetry('x')
    // the - side picked: its mirrored move goes to the + side, keeping the + side's earlier offset
    move([15], [-2, 0, 0])
    near(st().cage.positions[15], [-22, 20, 40])
    near(st().cage.positions[17], [28, 23, 40])
    move([15, 17], [1, 0, 0])
    near(st().cage.positions[17], [29, 23, 40])
    near(st().cage.positions[15], [-23, 20, 40])
  })

  it('a weighted soft move: each independently paired point gets its mirrored own move', () => {
    open(box())
    move([17], D1)
    st().setSymmetry('x')
    st().setSoftRadius(30)
    const before = copy(st().cage.positions)
    sel([17])
    st().beginMove({ extrude: false })
    st().moveBy(new Matrix4().makeTranslation(0, 0, 4).elements)
    st().endDrag()
    const P = st().cage.positions
    const L = reflect([1, 0, 0])
    let followers = 0
    before.forEach((p0, i) => {
      if (p0[0] <= 0) return
      const d: Vec3 = [P[i][0] - p0[0], P[i][1] - p0[1], P[i][2] - p0[2]]
      if (Math.hypot(...d) === 0) return
      const partner = i === 17 ? 15 : indexOf(boxCage(), [-boxCage().positions[i][0], boxCage().positions[i][1], boxCage().positions[i][2]])
      near(P[partner], add(before[partner], L(d)))
      followers++
    })
    // the corner and some soft neighbours moved, each mirrored from its own weight
    expect(followers).toBeGreaterThan(2)
    near(P[17], add(before[17], [0, 0, 4]))
    near(P[15], add(before[15], [0, 0, 4]))
  })

  it('a whole-cage transform carries reference coordinates (translate)', () => {
    open(box())
    move(box().positions.map((_, i) => i), [7, 5, 7])
    move([17], D1)
    st().setSymmetry('x')
    st().setSymmetryAt(7)
    move([17], D2)
    near(st().cage.positions[15], [-13 - 3, 25 + 2, 47 + 2])
  })

  it('a whole-cage transform carries reference coordinates (rotate 90 deg about Z)', () => {
    open(box())
    moveMatrix(box().positions.map((_, i) => i), new Matrix4().makeRotationZ(Math.PI / 2))
    // corner 17 is now at [-20, 20, 40]; its X mirror is the point now at [20, 20, 40]
    near(st().cage.positions[17], [-20, 20, 40])
    const B = indexOf(st().cage, [20, 20, 40])
    move([17], D1)
    st().setSymmetry('x')
    move([17], D2)
    near(st().cage.positions[B], [20 - 3, 20 + 2, 40 + 2])
  })

  it('a whole-cage move along the mirror plane is rigid: where the form pairs moves with it', () => {
    open(box())
    st().setSymmetry('x')
    move(box().positions.map((_, i) => i), [0, 20, 0])
    // the box now spans Y 0..40; centred on Y = 20 every point pairs as it is, with no offset
    st().setSymmetry('y')
    st().setSymmetryAt(20)
    expect(st().notice).not.toMatch(/alone|offset/)
    move([17], D2)
    near(st().cage.positions[17], [23, 42, 42])
    near(st().cage.positions[11], [23, -2, 42])
  })

  it('missing and ambiguous correspondences are never guessed: those points move alone', () => {
    // the form's memory has corner 14 on top of corner 17, so corner 15 has two candidate partners there
    const cage = box()
    const reference = box().positions
    reference[14] = [20, 20, 40]
    cage.positions[17] = add(cage.positions[17], D1)
    open({ ...cage, symmetryReference: { positions: reference, faces: cage.faces.map((f) => f.slice()) } } as Cage)
    st().setSymmetry('x')
    expect(st().notice).toMatch(/2 points have no mirror partner and move alone/)
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
  })

  it('mode replacement recomputes correspondence for the new plane', () => {
    open(box())
    move([17], D1)
    st().setSymmetry('x')
    st().setSymmetry('y')
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    near(st().cage.positions[11], [23, -22, 42])
  })

  it('Z keeps its current-bounds default plane after a late edit, without moving anything', () => {
    open(box())
    move([17], [0, 0, 10])
    const before = copy(st().cage)
    st().setSymmetry('z')
    expect(st().symmetryAt).toBe(25)
    expect(st().cage).toEqual(before)
  })
})

describe('WO-2955: late-enabled circular symmetry', () => {
  const COUNTS: Array<{ n: number; segments: number }> = [
    { n: 2, segments: 8 }, { n: 3, segments: 3 }, { n: 4, segments: 4 }, { n: 8, segments: 8 }, { n: 24, segments: 24 },
  ]
  const C1: Vec3 = [2, 1, 0]
  const C2: Vec3 = [1, 0, 1]

  it.each(COUNTS)('late enable preserves every cage field for c$n', ({ n, segments }) => {
    open(cyl(segments))
    move([indexOf(st().cage, [20, 0, 15])], C1)
    const before = copy(st().cage)
    st().setCircularCopies(n)
    st().toggleCircular()
    expect(st().symmetry).toBe(`c${n}`)
    expect(st().cage).toEqual(before)
  })

  it.each(COUNTS)('a later move turns only its new displacement round the axis (c$n)', ({ n, segments }) => {
    open(cyl(segments))
    const start = copy(st().cage.positions)
    const P = indexOf(st().cage, [20, 0, 15])
    move([P], C1)
    st().setCircularCopies(n)
    st().toggleCircular()
    expect(st().symmetry).toBe(`c${n}`)
    const before = copy(st().cage.positions)
    move([P], C2)
    const out = st().cage.positions
    near(out[P], add(add(start[P], C1), C2))
    const copies = new Set<number>()
    for (let k = 1; k < n; k++) {
      const Q = indexOf(cyl(segments), rot(start[P], k, n))
      copies.add(Q)
      near(out[Q], add(start[Q], rot(C2, k, n)))
    }
    out.forEach((p, i) => { if (i !== P && !copies.has(i)) expect(p).toEqual(before[i]) })
  })

  it('a partial group propagates only to independently verified copies', () => {
    const cage = cyl(8)
    const P = indexOf(cage, [20, 0, 15]), Q = indexOf(cage, rot([20, 0, 15], 2, 8))
    const reference = cyl(8).positions
    reference[Q] = add(reference[Q], [5, 0, 0])
    cage.positions[P] = add(cage.positions[P], C1)
    open({ ...cage, symmetryReference: { positions: reference, faces: cage.faces.map((f) => f.slice()) } } as Cage)
    // Circular's toggle would pick 2, the most copies this reference fully fits; 8 is asked for directly
    st().setSymmetry('c8')
    // every copy of that ring lacks the one in the gap; the one in the gap pairs with nothing
    expect(st().notice).toMatch(/; 8 points have no copies and move alone/)
    move([P], C2)
    const out = st().cage.positions
    expect(out[Q]).toEqual(cyl(8).positions[Q])
    for (const k of [1, 3, 4, 5, 6, 7]) {
      const R = indexOf(cyl(8), rot([20, 0, 15], k, 8))
      near(out[R], add(cyl(8).positions[R], rot(C2, k, 8)))
    }
  })
})
