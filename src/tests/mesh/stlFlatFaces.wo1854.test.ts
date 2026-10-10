// WO-1854: a flat face of an STL can be picked.
//
// Rule 6: every claim here goes through a PRODUCTION path - the recognition
// module's own public door (`src/mesh/recognition`, never `topology.ts` behind
// it), the store's `loadMeshFlatFaces` action, and the shared
// `geometryForOperation` source boundary every operation picker resolves
// through. Every fixture is written as REAL BINARY STL BYTES and parsed back
// by the product's own `importStl`; nothing hands a hand-built MeshBuffers to
// an engine.
//
// The acceptance plate below is WO-1846's own builder, copied verbatim from
// `meshFeatureRecognition.wo1846.test.ts` - which does not export it, which
// runs a whole suite and installs module mocks at import time, and which is
// not this order's to edit (owned-paths). Copied rather than re-invented, on
// the architect's instruction and following the identical precedent WO-1851's
// `stlFeatureTargets.wo1851.test.ts` set, so the dimensions asserted here are
// literally WO-1846's proven plate.
//
// `offsetStl` is WO-1851's addition to those fixtures, kept for the same
// reason: the plate as WO-1846 writes it already sits with its XY centre on
// the origin and its bottom on Z 0, so a face reported in the FILE's frame and
// one reported in the mesh's recentred local frame would be indistinguishable.
// Offset, the recentring this order has to get right has a value to get wrong.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Project, Setup } from '../../types'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

const stlBytesById = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore, geometryForOperation } = await import('../../store')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { sourceFacetIdsOf } = await import('../../mesh/edit')
// THE DOOR. This order's whole point is that nothing below it is imported by a
// consumer, so this test imports it the way a consumer must.
const { recognizeFlatFaces, describeFlatFace } = await import('../../mesh/recognition')
const { meshRecenterShift } = await import('../../mesh/recognition/toolpathTargets')
type RecognizedFlatFace = Awaited<ReturnType<typeof recognizeFlatFaces>>['faces'][number]

// ---------------------------------------------- WO-1846's fixtures, verbatim

/** A triangle soup being built up, in the unwelded form an STL writer wants. */
class Soup {
  private readonly coords: number[] = []

  tri(a: Vec3, b: Vec3, c: Vec3): void {
    this.coords.push(...a, ...b, ...c)
  }

  /** two triangles for the quad a-b-c-d, normal by the given winding */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }

  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }

  bytes(): ArrayBuffer {
    return exportBinaryStl(this.mesh()).bytes
  }
}

/** `n` points evenly round a circle, counter-clockwise seen from +Z. */
function ring(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), z] as Vec3
  })
}

/** `n` points round the square of half-size `s`, counter-clockwise from (s, 0),
 *  at EXACTLY representable offsets. */
function squareRing(cx: number, cy: number, s: number, z: number, n: number): Vec3[] {
  const per = n / 8
  return Array.from({ length: n }, (_, k) => {
    const segment = Math.floor(k / per)
    const f = (k % per) / per
    const xy: Array<[number, number]> = [
      [s, s * f], [s * (1 - f), s], [-s * f, s], [-s, s * (1 - f)],
      [-s, -s * f], [-s * (1 - f), -s], [s * f, -s], [s, -s * (1 - f)],
    ]
    return [cx + xy[segment][0], cy + xy[segment][1], z] as Vec3
  })
}

/** A planar strip between an inner loop and an outer loop, normal +Z when both
 *  run counter-clockwise; reversed when `up` is false. */
function annulus(soup: Soup, inner: Vec3[], outer: Vec3[], up: boolean): void {
  const n = inner.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) {
      soup.tri(inner[k], outer[k], outer[j])
      soup.tri(inner[k], outer[j], inner[j])
    } else {
      soup.tri(inner[k], outer[j], outer[k])
      soup.tri(inner[k], inner[j], outer[j])
    }
  }
}

/** A wall between a lower loop and an upper loop. */
function wall(soup: Soup, lower: Vec3[], upper: Vec3[], outward: boolean): void {
  const n = lower.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (outward) {
      soup.tri(lower[k], lower[j], upper[j])
      soup.tri(lower[k], upper[j], upper[k])
    } else {
      soup.tri(lower[k], upper[k], upper[j])
      soup.tri(lower[k], upper[j], lower[j])
    }
  }
}

/** A flat disk filling a loop: +Z when `up`. */
function disk(soup: Soup, loop: Vec3[], centre: Vec3, up: boolean): void {
  const n = loop.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) soup.tri(centre, loop[k], loop[j])
    else soup.tri(centre, loop[j], loop[k])
  }
}

const N = 64
const HALF = 20
const THICK = 12
const CELLS: Array<[number, number]> = [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]

/** The acceptance plate: 80 x 80 x 12 mm, four cells, one feature each. */
function acceptancePlate(segments = N): ArrayBuffer {
  const soup = new Soup()
  const topRingRadius = [3, 5, 6, 6]
  for (let cell = 0; cell < 4; cell++) {
    const [cx, cy] = CELLS[cell]
    const outerTop = squareRing(cx, cy, HALF, THICK, segments)
    const outerBottom = squareRing(cx, cy, HALF, 0, segments)
    annulus(soup, ring(cx, cy, topRingRadius[cell], THICK, segments), outerTop, true)
    if (cell === 3) disk(soup, outerBottom, [cx, cy, 0], false)
    else annulus(soup, ring(cx, cy, 3, 0, segments), outerBottom, false)

    if (cell === 0) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, THICK, segments), false)
    } else if (cell === 1) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 8, segments), false)
      annulus(soup, ring(cx, cy, 3, 8, segments), ring(cx, cy, 5, 8, segments), true)
      wall(soup, ring(cx, cy, 5, 8, segments), ring(cx, cy, 5, THICK, segments), false)
    } else if (cell === 2) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 9, segments), false)
      wall(soup, ring(cx, cy, 3, 9, segments), ring(cx, cy, 6, THICK, segments), false)
    } else {
      wall(soup, ring(cx, cy, 6, THICK, segments), ring(cx, cy, 6, THICK + 5, segments), true)
      disk(soup, ring(cx, cy, 6, THICK + 5, segments), [cx, cy, THICK + 5], true)
    }
  }
  const outline = squareRing(0, 0, 2 * HALF, 0, segments * 2)
  const outlineTop = squareRing(0, 0, 2 * HALF, THICK, segments * 2)
  wall(soup, outline, outlineTop, true)
  return soup.bytes()
}

/** A closed sphere: curved everywhere, flat nowhere. */
function spherePart(): ArrayBuffer {
  const soup = new Soup()
  const rings = 24
  const segments = 48
  const at = (i: number, k: number): Vec3 => {
    const phi = (Math.PI * i) / rings
    const theta = (2 * Math.PI * k) / segments
    return [10 * Math.sin(phi) * Math.cos(theta), 10 * Math.sin(phi) * Math.sin(theta), 10 * Math.cos(phi)]
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < segments; k++) {
      const j = (k + 1) % segments
      if (i === 0) soup.tri(at(0, 0), at(1, k), at(1, j))
      else if (i === rings - 1) soup.tri(at(rings, 0), at(i, j), at(i, k))
      else soup.quad(at(i, k), at(i, j), at(i + 1, j), at(i + 1, k))
    }
  }
  return soup.bytes()
}

/** A fixture's own bytes, translated away from the origin: what a real slicer
 *  file looks like, and what gives the recentring a value to get wrong. */
function offsetStl(bytes: ArrayBuffer, by: Vec3): ArrayBuffer {
  const mesh = importStl(bytes).mesh
  const positions = Float32Array.from(mesh.positions)
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    positions[offset] += by[0]
    positions[offset + 1] += by[1]
    positions[offset + 2] += by[2]
  }
  return exportBinaryStl({ positions, indices: mesh.indices }).bytes
}

/** Where CAD left this part. Nothing about it is special except that no
 *  component is zero and none is a round multiple of the other numbers here. */
const FILE_ORIGIN: Vec3 = [137.5, -62.25, 9.75]

// ------------------------------------------------------ this order's fixture

const STEP_Y = 20
/** A stepped block, 60 x 20 in plan. Four treads of 15 mm each, at Z 12, 6, 12
 *  and 3 - so two of them are at the SAME height and are NOT adjacent, which
 *  is the case the acceptance names. Built as an exact closed shell: every
 *  wall and every face is split at the same X and Z levels as its neighbours,
 *  so there is no T-junction anywhere and the weld is by exact coordinate. */
const STEP_COLUMNS: Array<{ x0: number, x1: number, top: number }> = [
  { x0: 0, x1: 15, top: 12 },
  { x0: 15, x1: 30, top: 6 },
  { x0: 30, x1: 45, top: 12 },
  { x0: 45, x1: 60, top: 3 },
]
const STEP_LEVELS = [0, 3, 6, 12]

function steppedBlock(): ArrayBuffer {
  const soup = new Soup()
  /** the Z levels a wall or a side face spanning [za, zb] must be split at */
  const bands = (za: number, zb: number): Array<[number, number]> => {
    const cuts = STEP_LEVELS.filter((z) => z >= za && z <= zb)
    return cuts.slice(0, -1).map((z, k) => [z, cuts[k + 1]] as [number, number])
  }

  for (const column of STEP_COLUMNS) {
    const { x0, x1, top } = column
    // bottom (facing -Z) and this column's tread (facing +Z)
    soup.quad([x0, 0, 0], [x0, STEP_Y, 0], [x1, STEP_Y, 0], [x1, 0, 0])
    soup.quad([x0, 0, top], [x1, 0, top], [x1, STEP_Y, top], [x0, STEP_Y, top])
    // the two side faces, split so they meet the walls exactly
    for (const [za, zb] of bands(0, top)) {
      soup.quad([x0, 0, za], [x1, 0, za], [x1, 0, zb], [x0, 0, zb])
      soup.quad([x0, STEP_Y, za], [x0, STEP_Y, zb], [x1, STEP_Y, zb], [x1, STEP_Y, za])
    }
  }
  // every X boundary: the wall between what stands to its left and its right
  const heightAt = (index: number): number => STEP_COLUMNS[index]?.top ?? 0
  for (let boundary = 0; boundary <= STEP_COLUMNS.length; boundary++) {
    const x = boundary === 0 ? STEP_COLUMNS[0].x0 : STEP_COLUMNS[boundary - 1].x1
    const left = boundary === 0 ? 0 : heightAt(boundary - 1)
    const right = heightAt(boundary)
    if (left === right) continue
    const facesPlusX = left > right
    for (const [za, zb] of bands(Math.min(left, right), Math.max(left, right))) {
      if (facesPlusX) soup.quad([x, 0, za], [x, STEP_Y, za], [x, STEP_Y, zb], [x, 0, zb])
      else soup.quad([x, 0, za], [x, 0, zb], [x, STEP_Y, zb], [x, STEP_Y, za])
    }
  }
  return soup.bytes()
}

// -------------------------------------------------------------- store set-up

const PLATE_ID = 'geo-plate-1854'
const SPHERE_ID = 'geo-sphere-1854'
const SETUP_ID = 'setup-1854'

function stlRow(id: string, name: string, size: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl', loaded: true,
    boundingBox: {
      min: { x: -size[0] / 2, y: -size[1] / 2, z: 0 },
      max: { x: size[0] / 2, y: size[1] / 2, z: size[2] },
      size: { x: size[0], y: size[1], z: size[2] },
      center: { x: 0, y: 0, z: size[2] / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  } as unknown as ImportedGeometry
}

function project(geometry: ImportedGeometry[]): Project {
  return {
    id: 'p-1854', name: 'STL flat faces', version: '1.0.0',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 200 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry, stocks: [],
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations: [], stock: null, notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
    } as unknown as Setup],
    activeSetupId: SETUP_ID, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 0,
      fixedWidth: 200, fixedHeight: 200, fixedDepth: 20, fixedStocks: [],
    },
    notes: '',
  } as unknown as Project
}

function row(id: string): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === id)
  if (!found) throw new Error(`fixture row "${id}" vanished`)
  return found
}

beforeEach(() => {
  stlBytesById.clear()
  stlBytesById.set(PLATE_ID, offsetStl(acceptancePlate(), FILE_ORIGIN))
  stlBytesById.set(SPHERE_ID, spherePart())
  useCamStore.setState({
    project: project([
      stlRow(PLATE_ID, 'Plate', [80, 80, 17]),
      stlRow(SPHERE_ID, 'Sphere', [20, 20, 20]),
    ]),
  })
})

// ---------------------------------------------------------------- the module

/** Through the DOOR, on real STL bytes, exactly as the panel and store do. */
function facesOf(bytes: ArrayBuffer, options = {}) {
  const parsed = importStl(bytes)
  return recognizeFlatFaces(parsed.mesh, sourceFacetIdsOf(parsed.mesh), options)
}

/** The area of an `n`-gon of radius `r` - the TESSELLATED footprint of a hole,
 *  which is what the plate actually has where a true circle would be. */
const polygonArea = (r: number, n = N): number => (n * r * r * Math.sin((2 * Math.PI) / n)) / 2
/** How much area a tessellated circle loses against the true one it stands for. */
const chordAreaLoss = (r: number, n = N): number => Math.PI * r * r - polygonArea(r, n)

/**
 * An STL stores float32 coordinates. Every fixture here is written as real STL
 * bytes and parsed back (rule 6), so a ring point that is 3.0000000 in the
 * builder comes back as 2.9999999 and the measured areas below sit a few parts
 * in 10^7 off the exact double-precision formulas. That is the FILE's precision
 * and it is what the product really sees; the assertions state it rather than
 * rounding it away.
 */
const FLOAT32_AREA_REL = 1e-6
function expectAreaClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * FLOAT32_AREA_REL)
}

const PLATE_BYTES = offsetStl(acceptancePlate(), FILE_ORIGIN)

describe('WO-1854: the flat faces of the WO-1846 acceptance plate', () => {
  const result = facesOf(PLATE_BYTES)
  const up = result.faces.filter((f) => f.plane.normal[2] > 0.999999)
  const down = result.faces.filter((f) => f.plane.normal[2] < -0.999999)

  it('finds the plate top, the plate bottom, the four flanks, the boss top and the counterbore shoulder - and nothing off a bore wall or a cone', () => {
    // 8 faces, no more: a 64-sided bore wall breaks into 64 genuinely planar
    // quads of 3.5 mm2 each and NONE of them is a face.
    expect(result.faces).toHaveLength(8)
    expect(up).toHaveLength(3)     // plate top, boss top, counterbore shoulder
    expect(down).toHaveLength(1)   // plate bottom
    expect(result.faces.filter((f) => Math.abs(f.plane.normal[2]) < 1e-9)).toHaveLength(4) // flanks
    // every one of them is genuinely flat, measured not asserted
    for (const face of result.faces) expect(face.maxDeviationMm).toBeLessThan(1e-6)
  })

  it('the top face carries the right plane, and its outline is the plate footprint minus the four holes', () => {
    const top = up.reduce((a, b) => (b.areaMm2 > a.areaMm2 ? b : a))
    expect(top.plane.normal[0]).toBeCloseTo(0, 9)
    expect(top.plane.normal[1]).toBeCloseTo(0, 9)
    expect(top.plane.normal[2]).toBeCloseTo(1, 9)
    expect(top.plane.point[2]).toBeCloseTo(THICK, 4)

    // the outline: the 80 x 80 perimeter, plus one hole per cell (r 3, 5, 6, 6)
    expect(top.outline.outer).toHaveLength(2 * N)
    expect(top.outline.inner).toHaveLength(4)
    for (const hole of top.outline.inner) expect(hole).toHaveLength(N)

    // Two independent measurements of the same number: the summed facet areas
    // and the signed area of the outline. They agree to float noise.
    expectAreaClose(top.outlineAreaMm2, top.areaMm2)
    // ...and both are the plate footprint minus the hole footprints, within
    // the area a tessellated hole loses against the true circle it stands for.
    const trueFootprint = 80 * 80 - Math.PI * (3 * 3 + 5 * 5 + 6 * 6 + 6 * 6)
    const tessellationBudget = chordAreaLoss(3) + chordAreaLoss(5) + 2 * chordAreaLoss(6)
    expect(top.areaMm2).toBeGreaterThan(trueFootprint)
    expect(top.areaMm2 - trueFootprint)
      .toBeLessThanOrEqual(tessellationBudget + top.areaMm2 * FLOAT32_AREA_REL)
    // exactly, against the tessellated footprint the plate really has
    expectAreaClose(top.areaMm2, 80 * 80 - polygonArea(3) - polygonArea(5) - 2 * polygonArea(6))
  })

  it('the bottom face faces down, sits on Z 0 and has the three through bores in it', () => {
    const bottom = down[0]
    expect(bottom.plane.normal[2]).toBeCloseTo(-1, 9)
    expect(bottom.plane.point[2]).toBeCloseTo(0, 4)
    expect(bottom.outline.inner).toHaveLength(3)
    expectAreaClose(bottom.areaMm2, 80 * 80 - 3 * polygonArea(3))
    expectAreaClose(bottom.outlineAreaMm2, bottom.areaMm2)
  })

  it('the boss top and the counterbore shoulder come back at their own heights', () => {
    const bossTop = up.find((f) => Math.abs(f.plane.point[2] - (THICK + 5)) < 1e-6)
    expect(bossTop).toBeDefined()
    expectAreaClose(bossTop!.areaMm2, polygonArea(6))
    expect(bossTop!.outline.inner).toHaveLength(0)

    const shoulder = up.find((f) => Math.abs(f.plane.point[2] - 8) < 1e-6)
    expect(shoulder).toBeDefined()
    expectAreaClose(shoulder!.areaMm2, polygonArea(5) - polygonArea(3))
    expect(shoulder!.outline.inner).toHaveLength(1)
  })

  it('reads in plain words', () => {
    const top = up.reduce((a, b) => (b.areaMm2 > a.areaMm2 ? b : a))
    expect(describeFlatFace(top)).toBe(`${top.areaMm2.toFixed(1)} mm2 flat face, facing up, at Z 12.00 mm`)
    expect(describeFlatFace(down[0])).toBe(
      `${down[0].areaMm2.toFixed(1)} mm2 flat face, facing down, at Z 0.00 mm`,
    )
    const flank = result.faces.find((f) => Math.abs(f.plane.normal[0] - 1) < 1e-9)
    expect(describeFlatFace(flank!)).toBe(
      `${flank!.areaMm2.toFixed(1)} mm2 flat face, upright, facing +X, at X 40.00 mm`,
    )
  })
})

describe('WO-1854: the recentred frame is the one the edge chains use', () => {
  const result = facesOf(PLATE_BYTES)
  const shift = meshRecenterShift(importStl(PLATE_BYTES).mesh)
  const top = result.faces
    .filter((f) => f.plane.normal[2] > 0.999999)
    .reduce((a, b) => (b.areaMm2 > a.areaMm2 ? b : a))

  it('the frame is (-(minX+maxX)/2, -(minY+maxY)/2, -minZ) - the plate reads as 80 x 80 about the origin', () => {
    // the shift is not a no-op: the file has the plate at FILE_ORIGIN
    expect(shift[0]).toBeCloseTo(-FILE_ORIGIN[0], 3)
    expect(shift[1]).toBeCloseTo(-FILE_ORIGIN[1], 3)
    expect(shift[2]).toBeCloseTo(-FILE_ORIGIN[2], 3)

    const xs = top.outline.outer.map((p) => p[0])
    const ys = top.outline.outer.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(-2 * HALF, 3)
    expect(Math.max(...xs)).toBeCloseTo(2 * HALF, 3)
    expect(Math.min(...ys)).toBeCloseTo(-2 * HALF, 3)
    expect(Math.max(...ys)).toBeCloseTo(2 * HALF, 3)
    expect(top.outline.outer.every((p) => Math.abs(p[2] - THICK) < 1e-3)).toBe(true)
  })

  it('NEGATIVE CONTROL: the same outline moved by the recentring shift fails that assertion', () => {
    // un-shift it, i.e. put it back in the STL file's own frame. If the
    // recentring above were a no-op this would be the same points and the
    // assertion would still pass - it must not.
    const unshifted = top.outline.outer.map((p) => [p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]] as Vec3)
    const xs = unshifted.map((p) => p[0])
    expect(Math.min(...xs)).not.toBeCloseTo(-2 * HALF, 3)
    expect(unshifted.every((p) => Math.abs(p[2] - THICK) < 1e-3)).toBe(false)
    // and it lands exactly where the file put it, which is the defect this
    // control exists to catch
    expect(Math.min(...xs)).toBeCloseTo(FILE_ORIGIN[0] - 2 * HALF, 3)
  })
})

describe('WO-1854: a stepped block - each step is its own face', () => {
  const result = facesOf(steppedBlock())
  const treads = result.faces.filter((f) => f.plane.normal[2] > 0.999999)

  it('finds the four treads, the bottom, the five walls and the two sides', () => {
    expect(result.faces).toHaveLength(12)
    expect(treads).toHaveLength(4)
    expect(result.faces.filter((f) => f.plane.normal[2] < -0.999999)).toHaveLength(1)
  })

  it('each tread is a separate face at its own height, 15 x 20 mm', () => {
    // the block is recentred, so X runs -30..30 and the treads sit at 12, 6,
    // 12, 3 measured from the bottom face.
    const seen = treads
      .map((f) => ({ x: Number(f.plane.point[0].toFixed(4)), z: Number(f.plane.point[2].toFixed(4)) }))
      .sort((a, b) => a.x - b.x)
    expect(seen).toEqual([
      { x: -22.5, z: 12 }, { x: -7.5, z: 6 }, { x: 7.5, z: 12 }, { x: 22.5, z: 3 },
    ])
    for (const tread of treads) {
      expectAreaClose(tread.areaMm2, 15 * STEP_Y)
      expect(tread.outline.outer).toHaveLength(4)
      expect(tread.outline.inner).toHaveLength(0)
    }
  })

  it('two treads at the SAME height that are not adjacent stay two faces', () => {
    const atTwelve = treads.filter((f) => Math.abs(f.plane.point[2] - 12) < 1e-9)
    expect(atTwelve).toHaveLength(2)
    // neither was merged across the step between them: 300 mm2 each, not 600
    for (const tread of atTwelve) expectAreaClose(tread.areaMm2, 300)
    expect(new Set(atTwelve.map((f) => f.id)).size).toBe(2)
    // and they do not share a single facet
    const [a, b] = atTwelve
    expect(a.sourceFacetIds.some((id) => b.sourceFacetIds.includes(id))).toBe(false)
  })

  it('the stepped side profile is one face, the L-shape it really is', () => {
    const side = result.faces.filter((f) => Math.abs(Math.abs(f.plane.normal[1]) - 1) < 1e-9)
    expect(side).toHaveLength(2)
    for (const face of side) {
      // 15*12 + 15*6 + 15*12 + 15*3 = 495 mm2
      expectAreaClose(face.areaMm2, 495)
      expectAreaClose(face.outlineAreaMm2, 495)
    }
  })
})

describe('WO-1854: nothing flat is an answer, not an error', () => {
  it('a sphere has no flat face, so the list is empty and nothing is raised', () => {
    const result = facesOf(spherePart())
    expect(result.faces).toEqual([])
    expect(result.facetCount).toBeGreaterThan(0)
    // the pass looked and said so; nothing here is a refusal shown to anyone
    expect(result.skipped.every((s) => s.reason === 'curved-surface' || s.reason === 'below-minimum-area'))
      .toBe(true)
  })

  it('a face below the minimum area is simply not listed', () => {
    const big = facesOf(PLATE_BYTES)
    const tiny = facesOf(PLATE_BYTES, { minAreaMm2: 100_000 })
    expect(big.faces.length).toBe(8)
    expect(tiny.faces).toEqual([])
  })
})

// ----------------------------------------------------------------- the store

describe('WO-1854: through the store, a flat face is a pick', () => {
  it('lands one derived layer per plane, with the face outlines on it', async () => {
    const recognition = await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)
    expect(recognition.faces).toHaveLength(8)

    const geo = row(PLATE_ID)
    const layers = (geo.layers2d ?? []).filter((l) => l.name.startsWith('STL flat faces'))
    // 8 faces on 8 distinct planes (top, bottom, 4 flanks, boss top, shoulder)
    expect(layers).toHaveLength(8)
    expect(layers.map((l) => l.name)).toContain('STL flat faces (1) @ Z 12')
    expect(layers.map((l) => l.name)).toContain('STL flat faces (1) @ Z 0, facing down')
    for (const layer of layers) {
      expect(layer.derived).toBe(true)
      expect(layer.frame).toBe('geometry_local')
      expect(layer.projectionPlane).toBeDefined()
    }

    const faceLoops = (geo.loops ?? []).filter((l) => l.id.startsWith('mfa:'))
    // one outer loop per face plus one per hole through a face: the plate top
    // has four, the bottom three, the shoulder one.
    expect(faceLoops.filter((l) => l.type === 'contour')).toHaveLength(8)
    expect(faceLoops.filter((l) => l.type === 'hole')).toHaveLength(8)
    expect(faceLoops.every((l) => l.closed)).toBe(true)
  })

  it('the picked outline is in the layer\'s own plane frame, and the top face reads as the plate footprint', async () => {
    await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)
    const geo = row(PLATE_ID)
    const layer = (geo.layers2d ?? []).find((l) => l.name === 'STL flat faces (1) @ Z 12')
    expect(layer).toBeDefined()
    expect(layer!.projectionPlane!.origin.x).toBeCloseTo(0, 6)
    expect(layer!.projectionPlane!.origin.y).toBeCloseTo(0, 6)
    expect(layer!.projectionPlane!.origin.z).toBeCloseTo(THICK, 6)

    const outer = (geo.loops ?? []).find((l) => l.layerId === layer!.id && l.type === 'contour')
    expect(outer).toBeDefined()
    // a horizontal face keeps the world X and Y axes, so this reads as plain
    // part coordinates - the same frame an edge chain at Z 12 is in
    expect(Math.min(...outer!.points.map((p) => p.x))).toBeCloseTo(-2 * HALF, 3)
    expect(Math.max(...outer!.points.map((p) => p.y))).toBeCloseTo(2 * HALF, 3)
    expect(outer!.area).toBeCloseTo(80 * 80, 3)
    expect(outer!.name).toMatch(/flat face, facing up, at Z 12\.00 mm$/)
  })

  it('the existing edge-chain candidates for the same STL are identical to before', async () => {
    const before = await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    const snapshot = JSON.stringify(before)
    expect(before.length).toBeGreaterThan(0)

    await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)

    const after = await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    expect(JSON.stringify(after)).toBe(snapshot)
    // and they are still on the row, untouched, beside the new face loops
    const geo = row(PLATE_ID)
    expect((geo.loops ?? []).filter((l) => l.id.startsWith('mec:')).length).toBe(before.length)
    expect((geo.loops ?? []).some((l) => l.id.startsWith('mfa:'))).toBe(true)
  })

  it('a picked face is offered to the families that can cut one, and to no others', async () => {
    await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)
    const geo = row(PLATE_ID)
    const faceLoopIds = (loops: ImportedGeometry['loops']) =>
      (loops ?? []).filter((l) => l.id.startsWith('mfa:')).map((l) => l.id)

    // a contour cuts a closed boundary; a pocket is bounded by one
    expect(faceLoopIds(geometryForOperation(geo, 'contour_2d').loops).length).toBe(16)
    expect(faceLoopIds(geometryForOperation(geo, 'pocket_2d').loops).length).toBe(16)
    // a drill has nothing to aim at a face with - and the layer goes with them
    expect(faceLoopIds(geometryForOperation(geo, 'drill').loops)).toEqual([])
    expect((geometryForOperation(geo, 'drill').layers2d ?? [])
      .filter((l) => l.name.startsWith('STL flat faces'))).toEqual([])
    // raw geometry (no operation filter) keeps everything
    expect(faceLoopIds(geometryForOperation(geo, undefined).loops).length).toBe(16)
  })

  it('asking twice for the same unchanged part changes nothing', async () => {
    await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)
    const first = row(PLATE_ID)
    await useCamStore.getState().loadMeshFlatFaces(PLATE_ID)
    const second = row(PLATE_ID)
    expect(second.loopsVersion).toBe(first.loopsVersion)
    expect(second.loops?.map((l) => l.id)).toEqual(first.loops?.map((l) => l.id))
  })

  it('a part with no flat face lands an empty list and says nothing alarming', async () => {
    const recognition = await useCamStore.getState().loadMeshFlatFaces(SPHERE_ID)
    expect(recognition.faces).toEqual([])
    const geo = row(SPHERE_ID)
    expect((geo.loops ?? []).filter((l) => l.id.startsWith('mfa:'))).toEqual([])
    expect((geo.layers2d ?? []).filter((l) => l.name.startsWith('STL flat faces'))).toEqual([])
  })

  it('names the geometry when it cannot be read at all', async () => {
    stlBytesById.delete(PLATE_ID)
    await expect(useCamStore.getState().loadMeshFlatFaces(PLATE_ID))
      .rejects.toThrow(/"Plate".*cached mesh data is missing/)
    await expect(useCamStore.getState().loadMeshFlatFaces('no-such-geometry'))
      .rejects.toThrow(/no longer exists/)
  })
})

// A compile-time pin, not a runtime one: the door's face type is what the
// store and the panel both spell, so a change to it breaks here first.
const _pinned: (face: RecognizedFlatFace) => string = describeFlatFace
void _pinned
