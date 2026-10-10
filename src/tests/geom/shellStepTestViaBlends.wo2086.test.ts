// WO-2086: can Shell on Step Test With Holes be reached by taking the small
// chamfers off first? Measured answer: no. These are KERNEL CONTROLS (rule 6),
// not application truth - no production path changed. They pin the three facts
// the re-scope rests on (probes + raw output: src/tests/evidence/WO-2086/):
//  1. With every chamfer defeatured, MakeThickSolid still aborts on the S1 top
//     face, because ANY blind depression opened through the removed face aborts
//     it - a kernel-built box with one plain blind hole does too, while the same
//     hole opened through the bottom face builds.
//  2. A shell built without MakeThickSolid on the depressions (plain-block shell
//     minus grown depression tools, cut from the ORIGINAL part so its chamfers
//     are never touched) is valid - but at 1 mm it is 10 separate solids: the
//     walls around the 8 shallower holes and the pocket touch nothing once the
//     top face is gone. One closed solid at 1 mm is geometrically impossible.
//  3. The same construction is ONE valid solid at 2.5 mm, chamfers intact.
// WO-2107 built fact 2/3's construction into GeomEngine.applyShell as the
// route taken when MakeThickSolid fails (shellByConstruction.wo2107.test.ts
// is the application truth). These raw-kernel facts are unchanged by it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'

const FIXTURE = join(process.cwd(), 'src/tests/geom/fixtures/step-test-with-holes.step')

describe('WO-2086 shell on Step Test With Holes with the small chamfers off', () => {
  let k: OcctKernel
  let source: ShapeHandle
  let faces: ShapeHandle[]

  beforeAll(async () => {
    k = await OcctKernel.init()
    const bytes = readFileSync(FIXTURE)
    source = k.importStep(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    faces = k.getSubShapes(source, 'face')
  }, 60_000)

  afterAll(() => {
    k[Symbol.dispose]()
  })

  const normalZ = (f: ShapeHandle) => {
    const uv = k.uvBounds(f)
    return k.surfaceNormal(f, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2).z
  }
  const planeAtZ = (shape: ShapeHandle, z: number) => k.getSubShapes(shape, 'face').filter((f) => {
    const bb = k.getBoundingBox(f, false)
    return k.surfaceType(f) === 'plane' && Math.abs(bb.zmin - z) < 1e-5 && Math.abs(bb.zmax - z) < 1e-5
  })
  const countType = (shape: ShapeHandle, type: string) =>
    k.getSubShapes(shape, 'face').filter((f) => k.surfaceType(f) === type).length

  /** Every chamfer on the part: countersink/rim cones, the two bspline rim
   *  strips, and the small inclined planes (outer edges, corners, rim flats). */
  function chamferFaces(): ShapeHandle[] {
    return faces.filter((f) => {
      const type = k.surfaceType(f)
      const area = k.getSurfaceArea(f)
      if (type === 'cone') return true
      if (type === 'bspline') return area < 60
      return type === 'plane' && area < 60 && Math.abs(normalZ(f)) < 0.99
    })
  }

  /** The shell built without MakeThickSolid on the depressions. */
  function shellByDepressionTools(t: number): ShapeHandle {
    const top = planeAtZ(source, 0).filter((f) => k.getSurfaceArea(f) > 1000)
    expect(top).toHaveLength(1)
    // Plain block: every face but the six block faces (large planes lying on
    // the part's bounding box) defeatured.
    const box = k.getBoundingBox(source, false)
    const onBox = (f: ShapeHandle) => {
      const bb = k.getBoundingBox(f, false)
      const flat = (lo: number, hi: number, a: number, b: number) =>
        Math.abs(lo - hi) < 1e-5 && (Math.abs(lo - a) < 1e-5 || Math.abs(lo - b) < 1e-5)
      return flat(bb.xmin, bb.xmax, box.xmin, box.xmax) || flat(bb.ymin, bb.ymax, box.ymin, box.ymax) || flat(bb.zmin, bb.zmax, box.zmin, box.zmax)
    }
    const blockFaces = faces.filter((f) => k.surfaceType(f) === 'plane' && k.getSurfaceArea(f) > 1000 && onBox(f))
    expect(blockFaces).toHaveLength(6)
    const block = k.defeature(source, faces.filter((f) => !blockFaces.includes(f)), 1e-6)
    expect(k.getSubShapes(block, 'face')).toHaveLength(6)
    const blockShell = k.shell(block, [planeAtZ(block, 0)[0]], t, 1e-6)
    const cavity0 = k.getSubShapes(k.cut(block, blockShell), 'solid')[0]
    // Depression floors: upward-facing planes below the top face.
    const floors = faces.filter((f) => {
      const bb = k.getBoundingBox(f, false)
      return k.surfaceType(f) === 'plane' && bb.zmax < -1e-3 && Math.abs(bb.zmax - bb.zmin) < 1e-6 && normalZ(f) > 0.999
    })
    expect(floors).toHaveLength(13) // 12 blind holes + the pocket
    const tools = floors.map((floor) => {
      const z = k.getBoundingBox(floor, false).zmin
      const wire = k.outerWire(floor)
      const plain = k.getSurfaceArea(k.makeFace(wire))
      // offsetWire2D's side follows the wire orientation; keep the growing side.
      const grow = (d: number) => {
        try {
          const f = k.makeFace(k.offsetWire2D(wire, d))
          return k.getSurfaceArea(f) > plain ? f : null
        } catch { return null }
      }
      const outline = grow(t) ?? grow(-t)
      expect(outline).not.toBeNull()
      // The outline lies on the floor (z); the tool runs from z - t to t above the top.
      const tool = k.extrude(k.translate(outline!, 0, 0, -t), 0, 0, -z + 2 * t)
      return k.isValid(tool) ? tool : k.fixShape(tool)
    })
    return k.cut(source, k.cutAll(cavity0, tools))
  }

  it('still aborts MakeThickSolid on S1 with all 44 chamfers off; one blind hole is enough to abort it', () => {
    const chamfers = chamferFaces()
    expect(chamfers).toHaveLength(44)
    const stripped = k.defeature(source, chamfers, 1e-6)
    expect(k.isValid(stripped)).toBe(true)
    expect(k.getSubShapes(stripped, 'face')).toHaveLength(55)
    const strippedTop = planeAtZ(stripped, 0)
    expect(strippedTop).toHaveLength(1)
    expect(() => k.shell(stripped, strippedTop, 1, 1e-6)).toThrow()

    // Control on kernel-built geometry: one plain blind hole from the top.
    const block = k.makeBoxFromCorners({ x: -40, y: -40, z: -14 }, { x: 40, y: 40, z: 0 })
    const holed = k.cut(block, k.translate(k.makeCylinder(2.5, 12), 0, 0, -7))
    expect(() => k.shell(holed, planeAtZ(holed, 0), 1, 1e-6)).toThrow()
    const openBottom = k.shell(holed, planeAtZ(holed, -14), 1, 1e-6)
    expect(k.isValid(openBottom)).toBe(true)
    expect(k.isSolid(openBottom)).toBe(true)
  }, 180_000)

  it('builds a valid 1 mm shell without MakeThickSolid, but it is 10 separate solids', () => {
    const shelled = shellByDepressionTools(1)
    expect(k.isValid(shelled)).toBe(true)
    const solids = k.getSubShapes(shelled, 'solid')
    expect(solids).toHaveLength(10)
    expect(k.getVolume(shelled)).toBeLessThan(k.getVolume(source))
    // 1 mm walls where a shell puts them, and a tube left round each hole.
    const inside = (x: number, y: number, z: number) => k.containsPoint(shelled, { x, y, z })
    expect(inside(39.5, 0, -5)).toBe(true) // outer wall
    expect(inside(38.5, 0, -5)).toBe(false) // cavity
    expect(inside(30, 0, -13.5)).toBe(true) // floor
    expect(inside(30, 0, -12.5)).toBe(false) // cavity
    expect(inside(-30.234, 11.363, -3)).toBe(true) // wall round a hole
    expect(inside(-29.234, 11.363, -3)).toBe(false) // cavity outside it
  }, 180_000)

  it('is one valid solid at 2.5 mm with every chamfer cone of the source intact', () => {
    const shelled = shellByDepressionTools(2.5)
    expect(k.isValid(shelled)).toBe(true)
    expect(k.getSubShapes(shelled, 'solid')).toHaveLength(1)
    expect(k.getVolume(shelled)).toBeLessThan(k.getVolume(source))
    expect(countType(shelled, 'cone')).toBe(countType(source, 'cone'))
    expect(countType(source, 'cone')).toBe(20)
  }, 180_000)
})
