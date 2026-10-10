// WO-2200: the display's per-vertex AO bake stopped the Model screen for two
// minutes after Apply on a mesh relief (the portrait: 627,534 vertices, 117 s a
// bake). Bodies at or under AO_EXACT_VERTEX_BUDGET bake exactly as before (pinned
// here against main's own output); above it the bake samples ~AO_SAMPLED_VERTICES
// vertices and interpolates, and the result still reads as AO.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { OcctKernel } from 'occt-wasm'
import { createLocalGeomService } from '../../geom'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import {
  AO_EXACT_VERTEX_BUDGET,
  AO_SAMPLED_VERTICES,
  applyBodyAO,
  computeVertexAO,
} from '../../lib/viewport/lighting/vertexAO'
import { AO_RAYS } from '../../lib/viewport/lighting/rigDescriptors'

/** A plate's top as a height field, nx x ny samples over lx x ly mm, with a square
 *  pocket (depth mm) in the middle and, if `texture`, relief-like fine detail. */
function heightField(nx: number, ny: number, lx: number, ly: number, depth: number, texture: boolean): THREE.BufferGeometry {
  const pos = new Float32Array(nx * ny * 3)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i / (nx - 1)) * lx, y = (j / (ny - 1)) * ly
      const inPocket = Math.abs(x - lx / 2) < lx * 0.15 && Math.abs(y - ly / 2) < ly * 0.15
      let z = inPocket ? -depth : 0
      if (texture) z += 0.6 * Math.sin(x * 1.7) * Math.cos(y * 2.3) + 0.25 * Math.sin(x * 9.1 + y * 7.3)
      const k = (j * nx + i) * 3
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z
    }
  }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6)
  let t = 0
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1
      index[t++] = a; index[t++] = b; index[t++] = d
      index[t++] = a; index[t++] = d; index[t++] = c
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  return g
}

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const aoHash = (ao: Float32Array) => fnv1a(new Uint8Array(ao.buffer, ao.byteOffset, ao.byteLength))

function pocketMask(g: THREE.BufferGeometry, lx: number, ly: number, inset: number): boolean[] {
  const p = g.getAttribute('position')
  const out: boolean[] = []
  for (let v = 0; v < p.count; v++) {
    out.push(Math.abs(p.getX(v) - lx / 2) < lx * (0.15 - inset) && Math.abs(p.getY(v) - ly / 2) < ly * (0.15 - inset))
  }
  return out
}

const mean = (a: Float32Array, keep: (v: number) => boolean) => {
  let s = 0, n = 0
  for (let v = 0; v < a.length; v++) if (keep(v)) { s += a[v]; n++ }
  return s / n
}

const meanAbs = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let v = 0; v < a.length; v++) s += Math.abs(a[v] - b[v])
  return s / a.length
}

/** Vertices within 6 mm of the plate's outer edge: open face, far from the pocket. */
const farFace = (g: THREE.BufferGeometry, lx: number, ly: number) => {
  const p = g.getAttribute('position')
  return (v: number) => Math.min(p.getX(v), p.getY(v), lx - p.getX(v), ly - p.getY(v)) < 6
}

beforeEach(() => vi.stubGlobal('window', {}))
afterEach(() => vi.restoreAllMocks())

describe('WO-2200 vertex AO bake budget', () => {
  it('a body at or under the budget bakes exactly as main (byte-identical ao)', () => {
    // 150 x 150 = 22,500 vertices, a 60 x 60 mm pocketed plate: an ordinary part.
    const g = heightField(150, 150, 60, 60, 12, false)
    expect(g.getAttribute('position').count).toBeLessThanOrEqual(AO_EXACT_VERTEX_BUDGET)
    const { ao } = computeVertexAO(g)
    // Recorded from main's vertexAO.ts (before WO-2200) on this same geometry.
    expect(aoHash(ao)).toBe(MAIN_POCKET_AO_HASH)
    // And the exact path is what the budget switch leaves in place.
    expect(aoHash(computeVertexAO(heightField(150, 150, 60, 60, 12, false), Infinity).ao)).toBe(MAIN_POCKET_AO_HASH)
  })

  it('above the budget a smooth pocketed part samples and keeps the exact bake AO', () => {
    // 260 x 260 = 67,600 vertices: over the budget, small enough to bake exactly too.
    const exact = computeVertexAO(heightField(260, 260, 60, 60, 12, false), Infinity).ao
    const g = heightField(260, 260, 60, 60, 12, false)
    expect(g.getAttribute('position').count).toBeGreaterThan(AO_EXACT_VERTEX_BUDGET)
    const raycast = vi.spyOn(MeshBVH.prototype, 'raycastFirst')
    const sampled = computeVertexAO(g).ao
    const samples = raycast.mock.calls.length / AO_RAYS
    raycast.mockRestore()
    expect(samples).toBeLessThanOrEqual(AO_SAMPLED_VERTICES * 1.25)

    const err = meanAbs(exact, sampled)
    const inPocket = pocketMask(g, 60, 60, 0.03)
    const pocketMean = mean(sampled, (v) => inPocket[v])
    const faceMean = mean(sampled, farFace(g, 60, 60))
    console.log(`[WO-2200 AO] smooth 67,600 vertices: ${samples} samples; mean |sampled - exact| ${err.toFixed(4)}; pocket ${pocketMean.toFixed(3)} vs face ${faceMean.toFixed(3)} (exact ${mean(exact, (v) => inPocket[v]).toFixed(3)} vs ${mean(exact, farFace(g, 60, 60)).toFixed(3)})`)
    expect(err).toBeLessThan(0.02)
    expect(pocketMean).toBeLessThanOrEqual(0.8 * faceMean) // the pocket still reads as a recess
    // Deterministic: the same body bakes the same bytes.
    expect(aoHash(computeVertexAO(heightField(260, 260, 60, 60, 12, false)).ao)).toBe(aoHash(sampled))
  })

  it('above the budget a relief-textured part keeps the exact bake AO at the scale it is seen (6 mm)', () => {
    const exact = computeVertexAO(heightField(260, 260, 60, 60, 12, true), Infinity).ao
    const g = heightField(260, 260, 60, 60, 12, true)
    const sampled = computeVertexAO(g).ao
    // Mean over 26 x 26-vertex blocks (~6 mm, half this plate's AO radius): vertex-to-
    // vertex AO noise from the 0.5 mm texture is smoothed by design (a sample every
    // ~1.4 mm here); the texture itself is drawn by the normals, which are untouched.
    const block = (a: Float32Array) => {
      const out: number[] = []
      for (let bj = 0; bj + 26 <= 260; bj += 26) {
        for (let bi = 0; bi + 26 <= 260; bi += 26) {
          let s = 0
          for (let j = bj; j < bj + 26; j++) for (let i = bi; i < bi + 26; i++) s += a[j * 260 + i]
          out.push(s / 676)
        }
      }
      return Float32Array.from(out)
    }
    const err = meanAbs(block(exact), block(sampled))
    const inPocket = pocketMask(g, 60, 60, 0.03)
    console.log(`[WO-2200 AO] textured 67,600 vertices: per-vertex mean |sampled - exact| ${meanAbs(exact, sampled).toFixed(4)}, 6 mm blocks ${err.toFixed(4)}; pocket ${mean(sampled, (v) => inPocket[v]).toFixed(3)} vs face ${mean(sampled, farFace(g, 60, 60)).toFixed(3)} (exact ${mean(exact, (v) => inPocket[v]).toFixed(3)} vs ${mean(exact, farFace(g, 60, 60)).toFixed(3)})`)
    expect(err).toBeLessThan(0.08)
    // No overall darkening or lightening of the part.
    expect(Math.abs(mean(sampled, () => true) - mean(exact, () => true))).toBeLessThan(0.03)
    expect(mean(sampled, (v) => inPocket[v])).toBeLessThanOrEqual(0.8 * mean(sampled, farFace(g, 60, 60)))
  })

  it('above the budget a many-faced part keeps each face its own AO (a fixture plate: holes do not darken its outer walls)', async () => {
    // The capture's fixture plate (evidence/WO-2200/aoparts): 300 x 200 x 20, a pocket and
    // a 15 mm grid of 198 counterbored holes, imported and meshed by the production geometry
    // service at the Model screen's display quality (57,864 vertices, as in the app). Before
    // this case the sampler shared one sample between every face in a cell that faced the
    // same way, so an outer wall took a hole wall's darkness (pixel-visible on the page).
    const kernel = await OcctKernel.init()
    const plate = kernel.makeBox(300, 200, 20)
    const tools = [kernel.translate(kernel.makeBox(70, 50, 11), 115, 75, 10)]
    for (let x = 12.5; x < 290; x += 15) {
      for (let y = 12.5; y < 190; y += 15) {
        if (x > 105 && x < 195 && y > 65 && y < 135) continue
        tools.push(kernel.translate(kernel.makeCylinder(3, 22), x, y, -1))
        tools.push(kernel.translate(kernel.makeCylinder(5, 7), x, y, 14))
      }
    }
    const step = new TextEncoder().encode(kernel.exportStep(kernel.cutAll(plate, tools)))
    const client = createLocalGeomService()
    await client.init()
    const imported = await client.importStep(step.buffer.slice(step.byteOffset, step.byteOffset + step.byteLength) as ArrayBuffer, 'IMP1')
    expect(imported.bodies.length, JSON.stringify(imported.diagnostics)).toBe(1)
    const t = await client.tessellate(imported.bodies[0].handle, DISPLAY_TESS_QUALITY)
    await client.disposeAll()
    const body = () => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(t.position.slice(), 3))
      g.setAttribute('normal', new THREE.BufferAttribute(t.normal.slice(), 3))
      g.setIndex(new THREE.BufferAttribute(t.index.slice(), 1))
      return g
    }
    const g = body()
    const count = g.getAttribute('position').count
    expect(count).toBeGreaterThan(AO_EXACT_VERTEX_BUDGET)
    const exact = computeVertexAO(body(), Infinity).ao
    const raycast = vi.spyOn(MeshBVH.prototype, 'raycastFirst')
    const sampled = computeVertexAO(g).ao
    const samples = raycast.mock.calls.length / AO_RAYS
    raycast.mockRestore()

    const p = g.getAttribute('position'), n = g.getAttribute('normal')
    const outerWall = (v: number) => Math.abs(n.getZ(v)) < 0.1
      && Math.min(p.getX(v), p.getY(v), 300 - p.getX(v), 200 - p.getY(v)) < 1e-3
    const topFace = (v: number) => n.getZ(v) > 0.9 && p.getZ(v) > 20 - 1e-3
    const occluded = (v: number) => exact[v] < 0.9
    const diff = Float32Array.from(sampled, (s, v) => Math.abs(s - exact[v]))
    let walls = 0
    for (let v = 0; v < count; v++) if (outerWall(v)) walls++
    expect(walls).toBeGreaterThan(0)
    if (process.env.AO_PROBE) {
      const kinds: Record<string, (v: number) => boolean> = {
        thruWall: (v) => Math.abs(n.getZ(v)) < 0.1 && p.getZ(v) < 14.001 && nearHole(v, 3),
        cboreWall: (v) => Math.abs(n.getZ(v)) < 0.1 && p.getZ(v) > 13.999 && nearHole(v, 5),
        cboreFloor: (v) => n.getZ(v) > 0.9 && Math.abs(p.getZ(v) - 14) < 1e-3,
        pocket: (v) => p.getX(v) > 114.99 && p.getX(v) < 185.01 && p.getY(v) > 74.99 && p.getY(v) < 125.01 && p.getZ(v) > 9.99,
        bottom: (v) => n.getZ(v) < -0.9,
      }
      function nearHole(v: number, r: number) {
        const cx = Math.round((p.getX(v) - 12.5) / 15) * 15 + 12.5, cy = Math.round((p.getY(v) - 12.5) / 15) * 15 + 12.5
        return Math.abs(Math.hypot(p.getX(v) - cx, p.getY(v) - cy) - r) < 0.05
      }
      for (const [k, f] of Object.entries(kinds)) {
        let c = 0
        for (let v = 0; v < count; v++) if (f(v)) c++
        console.log(`PROBE ${k}: ${c} vertices, exact ${mean(exact, f).toFixed(3)}, sampled ${mean(sampled, f).toFixed(3)}, mean |diff| ${mean(diff, f).toFixed(3)}`)
      }
    }
    console.log(`[WO-2200 AO] fixture plate ${count} vertices (${walls} on the outer walls): ${samples} samples; mean |sampled - exact| ${mean(diff, () => true).toFixed(4)}; `
      + `outer walls ${mean(sampled, outerWall).toFixed(3)} (exact ${mean(exact, outerWall).toFixed(3)}); top face ${mean(sampled, topFace).toFixed(3)} (exact ${mean(exact, topFace).toFixed(3)}); `
      + `occluded ${mean(sampled, occluded).toFixed(3)} (exact ${mean(exact, occluded).toFixed(3)})`)
    expect(samples).toBeLessThan(count / 4) // still a sample set, not the exact bake
    // the defect (the sampler before this case): outer walls 0.850, top face 0.787, exact 1.000
    expect(mean(diff, outerWall)).toBeLessThan(0.03)
    expect(mean(diff, topFace)).toBeLessThan(0.03)
    // Inside the holes the shading is softened, not lost: a counterbore wall is meshed on
    // its two rims only, and at ~4 samples a face one rim's value can stand for both
    // (measured 0.060 mean per vertex; holes 0.331 vs exact 0.285, face 1.000).
    expect(mean(diff, () => true)).toBeLessThan(0.08)
    // the pockets and holes keep their darkening
    expect(mean(sampled, occluded)).toBeLessThan(mean(exact, occluded) + 0.06)
    expect(mean(sampled, occluded)).toBeLessThan(0.5 * mean(sampled, topFace))
  }, 180_000)

  it('a portrait-sized mesh relief (700 x 901 = 630,700 vertices) bakes from the sample set', () => {
    const g = heightField(700, 901, 90, 117, 1, true)
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial())
    // A plain counter, not a spy: main's bake here is 20M rays and a spy keeps each call.
    const raycastFirst = MeshBVH.prototype.raycastFirst
    let rays = 0
    MeshBVH.prototype.raycastFirst = function (this: MeshBVH, ...args: Parameters<MeshBVH['raycastFirst']>) {
      rays++
      return raycastFirst.apply(this, args)
    }
    const t0 = performance.now()
    let result: ReturnType<typeof applyBodyAO>
    try {
      result = applyBodyAO(mesh)
    } finally {
      MeshBVH.prototype.raycastFirst = raycastFirst
    }
    const ms = performance.now() - t0
    const samples = rays / AO_RAYS
    console.log(`[WO-2200 AO] 630,700 vertices: ${samples} samples, bake ${result.bakeMs} ms (applyBodyAO ${ms.toFixed(0)} ms)`)
    expect(result.vertices).toBe(630_700)
    expect(samples).toBeLessThanOrEqual(AO_SAMPLED_VERTICES * 1.25)
    let lo = 1
    for (const f of result.ao!) lo = Math.min(lo, f)
    expect(lo).toBeLessThan(1) // it still carries AO, not the flat fail-open
  })
})

const MAIN_POCKET_AO_HASH = 'f2877358'
