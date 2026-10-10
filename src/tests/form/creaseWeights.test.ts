// Form: semi-sharp creases (crease weights).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, creaseRimAt, cylinderCage } from '../../form/starters'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine } from '../../form/subdivide'
import { setCreased, insertEdgeLoop } from '../../form/edgeLoop'
import { deleteFaces } from '../../form/topoTools'
import { tessellateForm } from '../../form/finish'
import { evalPatch, exactSurface, refinedLevel } from '../../form/exact'
import { makeFormFeaturePayload } from '../../form/formBody'
import { formStep } from '../../form/exactStep'
import { useFormStore } from '../../form/formStore'
import { GeomEngine } from '../../geom/worker/geom-engine'

function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}
const cyl = () => cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } })
/** the knob's bottom rim at weight w (0 = smooth, Infinity = fully creased) */
function knobAt(w: number): Cage {
  const sharp = creaseRimAt(cyl(), 0)
  if (w === Infinity) return sharp
  const plain = cyl()
  return w === 0 ? plain : setCreased(plain, sharp.creases, true, w)
}

describe('crease weights', () => {
  it('the edge rule blends the smooth and crease rules by the weight; a weight of 1 or more is the crease rule', () => {
    const cage = boxCage({ segments: { x: 1, y: 1, z: 1 } })
    const key = edgeKey(cage.faces[0][0], cage.faces[0][1])
    const edgePointOf = (c: Cage) => {
      const r = refine(levelFromCage(c))
      const P = applyRows(r.rows, cagePositionArray(c))
      const i = r.edgePoint.get(key)!
      return [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
    }
    const smooth = edgePointOf(cage)
    const sharp = edgePointOf(setCreased(cage, [key], true))
    const half = edgePointOf(setCreased(cage, [key], true, 0.5))
    const two = edgePointOf(setCreased(cage, [key], true, 2))
    for (let k = 0; k < 3; k++) {
      expect(half[k]).toBeCloseTo((smooth[k] + sharp[k]) / 2, 12)
      expect(two[k]).toBeCloseTo(sharp[k], 12)
    }
  })

  it('a point on two semi-sharp edges of weight 0.5 lands halfway between its smooth and its crease position', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const at = (pred: (p: number[]) => boolean) => cage.positions.findIndex(pred)
    // the middle of the box's top front edge, creased along that edge
    const v = at((p) => p[0] === 0 && p[1] === -20 && p[2] === 40)
    const below = at((p) => p[0] === -20 && p[1] === -20 && p[2] === 40)
    const above = at((p) => p[0] === 20 && p[1] === -20 && p[2] === 40)
    const keys = [edgeKey(v, below), edgeKey(v, above)]
    const pointOf = (c: Cage) => { const P = applyRows(refine(levelFromCage(c)).rows, cagePositionArray(c)); return [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]] }
    const smooth = pointOf(cage), sharp = pointOf(setCreased(cage, keys, true)), half = pointOf(setCreased(cage, keys, true, 0.5))
    expect(Math.hypot(smooth[0] - sharp[0], smooth[1] - sharp[1], smooth[2] - sharp[2])).toBeGreaterThan(0.1)
    for (let k = 0; k < 3; k++) expect(half[k]).toBeCloseTo((smooth[k] + sharp[k]) / 2, 12)
  })

  it('a heavier weight keeps more of the corner: the knob grows from smooth through weights 1 and 2 to sharp', () => {
    const vol = (w: number) => { const t = tessellateForm(knobAt(w), 0.05); return meshVolume(t.positions, t.indices) }
    const v = [0, 1, 2, Infinity].map(vol)
    expect(v[0]).toBeLessThan(v[1])
    expect(v[1]).toBeLessThan(v[2])
    expect(v[2]).toBeLessThan(v[3])
  })

  it('the exact patches of a weighted knob are still exactly the limit surface where flagged exact', () => {
    // weight 2 is used up by the 3 refinement steps before the patches: the rim is smooth there,
    // and every ordinary patch must be the limit surface (checked at its centre, one step further)
    const cage = knobAt(2)
    const s = exactSurface(cage, 3)
    const { level, positions } = refinedLevel(cage, 3)
    expect(level.sharpness).toBeUndefined()
    const r = refine(level)
    const lim = applyRows(limitRows(r.level), applyRows(r.rows, positions))
    let worst = 0, exact = 0
    s.patches.forEach((p, f) => {
      if (!p.exact) return
      exact++
      const q = evalPatch(p.points, 0.5, 0.5)
      const i = r.facePoint[f]
      worst = Math.max(worst, Math.hypot(q[0] - lim[i * 3], q[1] - lim[i * 3 + 1], q[2] - lim[i * 3 + 2]))
    })
    expect(exact).toBeGreaterThan(s.patches.length / 2)
    expect(worst).toBeLessThan(1e-9)
  })

  it('weights ride along: insert loop splits them, delete remaps them, the payload keeps them, Uncrease clears them', () => {
    const base = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const at = (pred: (p: number[]) => boolean) => base.positions.findIndex(pred)
    const a = at((p) => p[0] === 0 && p[1] === -20 && p[2] === 0), b = at((p) => p[0] === 0 && p[1] === -20 && p[2] === 20)
    const key = edgeKey(a, b)
    const weighted = setCreased(base, [key], true, 1.5)
    expect(weighted.weights).toEqual({ [key]: 1.5 })
    expect(weighted.creases).not.toContain(key)
    const looped = insertEdgeLoop(weighted, key)!
    expect(Object.values(looped.cage.weights ?? {})).toEqual([1.5, 1.5])
    const top = weighted.faces.findIndex((f) => f.every((p) => weighted.positions[p][2] === 40))
    expect(Object.keys(deleteFaces(weighted, [top]).weights ?? {})).toHaveLength(1)
    expect(makeFormFeaturePayload('W', weighted).cage.weights).toEqual({ [key]: 1.5 })
    expect(setCreased(weighted, [key], false).weights).toBeUndefined()
    expect(setCreased(weighted, [key], true).creases).toContain(key)
    expect(setCreased(weighted, [key], true).weights).toBeUndefined()
  })

  it('the store creases with the palette weight', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 1, y: 1, z: 1 } }) })
    const st = useFormStore.getState()
    const key = edgeKey(st.cage.faces[0][0], st.cage.faces[0][1])
    st.setCreaseWeight(2)
    st.select({ kind: 'edge', key }, false)
    st.crease(true)
    expect(useFormStore.getState().cage.weights).toEqual({ [key]: 2 })
    expect(useFormStore.getState().notice).toMatch(/weight 2/)
    useFormStore.getState().setCreaseWeight(0)
  })
})

describe('a weighted form as an exact solid (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('reads back as one solid whose volume sits between the smooth and the sharp knob', async () => {
    const vol = async (c: Cage) => {
      const res = await engine.importStep(new TextEncoder().encode(formStep(c, 'K', 3).text).buffer as ArrayBuffer, 'FRM1')
      expect(res.bodies).toHaveLength(1)
      return (await engine.measure(res.bodies[0].handle, 'volume')).value
    }
    const [soft, weighted, sharp] = [await vol(knobAt(0)), await vol(knobAt(1.5)), await vol(knobAt(Infinity))]
    expect(soft).toBeLessThan(weighted)
    expect(weighted).toBeLessThan(sharp)
  }, 180_000)
})
