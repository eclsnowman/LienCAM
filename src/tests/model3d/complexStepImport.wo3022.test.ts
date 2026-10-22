// WO-3022: the two STEP readers the app has - the Model page's geom engine (occt-wasm importStep) and
// the CAM side's model worker core (occt-model readStepShape -> tessellate, which Import geometry,
// reload, replace and the CAM 3D route all use) - read the same body: the same face count, one solid,
// the same mesh bounds within the meshing tolerance, and an exact bounding box that contains the mesh.
// Workbench Part (committed) runs everywhere; the operator's PortalHandle.step (268 faces, never committed)
// runs where it is on disk and pins the readings REPORT.md records, including the exact box's loose
// Y (1.58 mm each side, a card for the operator - this pins today's value so a change to it is seen).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { loadOcctModel, _resetOcctModelForTest, type OcctModelModule } from '../../lib/cam/geometry/occt/model/loader'
import { buildModelPayload } from '../../lib/cam/geometry/occt/model/core'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const here = dirname(fileURLToPath(import.meta.url))
/* eslint-disable @typescript-eslint/no-explicit-any */
;(globalThis as any).require ??= createRequire(import.meta.url)
;(globalThis as any).__dirname ??= here
;(globalThis as any).__filename ??= fileURLToPath(import.meta.url)
/* eslint-enable @typescript-eslint/no-explicit-any */

const WORKBENCH = join(here, '../../../Sample Parts/Workbench Part.step')
const PORTAL = process.env.WO3022_STEP ?? 'H:/LienCAM/fixtures/PortalHandle.step'

function bounds(p: ArrayLike<number>) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[i + c]); hi[c] = Math.max(hi[c], p[i + c]) }
  return { lo, hi }
}

let oc: OcctModelModule
let engine: GeomEngine
beforeAll(async () => {
  _resetOcctModelForTest()
  oc = await loadOcctModel({ wasmBinary: readFileSync(join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')) })
  engine = new GeomEngine()
  await engine.init()
}, 120_000)
afterAll(async () => { await engine.disposeKernel() })

async function readBoth(file: string) {
  const bytes = readFileSync(file)
  const { payload, shape } = buildModelPayload(oc, bytes, file, { linearDeflection: 0.05, angularDeflection: 0.25 })
  shape.delete()
  const imp = await engine.importStep(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'IMP1')
  const tess = await engine.tessellate(imp.bodies[0].handle, DISPLAY_TESS_QUALITY)
  return { payload, imp, cam: bounds(payload.mesh.positions), model: bounds(tess.position) }
}

function sameBody(r: Awaited<ReturnType<typeof readBoth>>, faces: number) {
  expect(r.payload.solidCount).toBe(1)
  expect(r.payload.faceCount).toBe(faces)
  expect(r.imp.bodies).toHaveLength(1)
  expect(r.imp.bodies[0].elementMap.generated).toHaveLength(faces)
  expect(r.imp.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  for (let c = 0; c < 3; c++) {
    // the two meshes agree to within their chord tolerance
    expect(Math.abs(r.cam.lo[c] - r.model.lo[c])).toBeLessThan(0.1)
    expect(Math.abs(r.cam.hi[c] - r.model.hi[c])).toBeLessThan(0.1)
    // and the exact box holds the mesh
    expect(r.payload.bbox.min[c]).toBeLessThanOrEqual(r.cam.lo[c] + 1e-3)
    expect(r.payload.bbox.max[c]).toBeGreaterThanOrEqual(r.cam.hi[c] - 1e-3)
  }
}

describe('WO-3022: both STEP readers read the same body', () => {
  it('Workbench Part: 9 faces, one solid, matching bounds', async () => {
    sameBody(await readBoth(WORKBENCH), 9)
  }, 120_000)

  it.skipIf(!existsSync(PORTAL))('PortalHandle.step: 268 faces, one solid, 321 x 80 x 64 mm in millimetres', async () => {
    const r = await readBoth(PORTAL)
    sameBody(r, 268)
    expect(r.cam.lo[0]).toBeCloseTo(99.98, 1)
    expect(r.cam.hi[0]).toBeCloseTo(421.34, 1)
    expect(r.cam.lo[1]).toBeCloseTo(-0.5, 1)
    expect(r.cam.hi[1]).toBeCloseTo(79.5, 1)
    expect(r.cam.lo[2]).toBeCloseTo(-15.09, 1)
    expect(r.cam.hi[2]).toBeCloseTo(49.32, 1)
    // today's exact box: Y 1.58 mm wider than the body on each side (REPORT.md error 5)
    expect(r.payload.bbox.min[1]).toBeCloseTo(-2.08, 1)
    expect(r.payload.bbox.max[1]).toBeCloseTo(81.08, 1)
  }, 600_000)
})
