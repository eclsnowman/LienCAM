// WO-3232 (WO-3173 Draft A0): the public occt-wasm JoinType enum must mean what
// its names say when it reaches offsetWire2D. Independent truth is geometry, not
// a second kernel output: a 40 x 20 rectangle offset outward by t = 2 encloses
// 44 x 24 = 1056 mm2 with sharp (intersection) corners, and
// 800 + 2 x (40 + 20) x 2 + pi x 2^2 = 1052.566 mm2 with round (arc) corners.
// Kernel-binding control only; no document, UI or CAM route is exercised.
import { JoinType, OcctKernel, type ShapeHandle } from 'occt-wasm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SHARP = 44 * 24
const ROUND = 40 * 20 + 2 * (40 + 20) * 2 + Math.PI * 2 * 2

let k: OcctKernel
const held: ShapeHandle[] = []
const own = <T extends ShapeHandle>(h: T): T => { held.push(h); return h }

beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
afterAll(() => {
  for (const h of held) { try { k.release(h) } catch { /* already gone */ } }
  k?.[Symbol.dispose]()
})

/** Area enclosed by the 40 x 20 rectangle's outer wire offset by `t`. */
function offsetArea(t: number, join?: JoinType): number {
  const wire = own(k.getSubShapes(own(k.makeRectangle(40, 20)), 'wire')[0])
  const offset = own(join === undefined ? k.offsetWire2D(wire, t) : k.offsetWire2D(wire, t, join))
  const outline = k.isWire(offset) ? offset : own(k.getSubShapes(offset, 'wire')[0])
  const face = own(k.makeFace(outline))
  expect(k.isValid(face)).toBe(true)
  return k.getSurfaceArea(face)
}

const rel = (actual: number, expected: number) => Math.abs(actual - expected) / expected

describe('WO-3232 offsetWire2D join enum contract (40 x 20 outward t = 2)', () => {
  it('JoinType.Intersection gives sharp corners: area 44 x 24 = 1056', () => {
    const area = offsetArea(2, JoinType.Intersection)
    expect(rel(area, SHARP), `area ${area}`).toBeLessThanOrEqual(1e-6)
  })

  it('JoinType.Arc gives round corners: area 800 + 120 x 2 + 4 pi', () => {
    const area = offsetArea(2, JoinType.Arc)
    expect(rel(area, ROUND), `area ${area}`).toBeLessThanOrEqual(1e-6)
  })

  it('the default join (the geom-engine #grownOutline call site) stays round', () => {
    const area = offsetArea(2)
    expect(rel(area, ROUND), `area ${area}`).toBeLessThanOrEqual(1e-6)
  })
})
