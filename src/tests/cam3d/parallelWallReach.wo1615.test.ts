// WO-1615 (finding SH-7): Parallel 3D's ball cut into the tray's rounded walls.
// The chordal sample step assumes the cutter-location surface curves no
// tighter than the ball; beside a wall it jumps from the floor to the rim
// within a fraction of a step, and the straight chord between two samples
// drove the ball sideways into the wall (1.1 mm into the part, measured below
// by exact sphere-to-triangle distance, independent of the kernel).
//
// Production compute path: the store's computeOperationToolpath through the
// cam3d dispatcher (heightScenario). Only browser transports are replaced.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, isRapid, runSolidScenario, solidGougeMm, solidMesh } from '../helpers/heightScenario'
import { refinePassChords } from '../../cam3d/strategies/parallel'
import type { ToolpathMove } from '../../types'

installRealToolpathWorker()

const TOLERANCE = 0.1
const BALL = 6
/** Case 68's reading: half a millimetre of radial slack (a wall only touched). */
const LATERAL_SLACK = 0.5
/** The tray's lowest model point is Z -18; on the table it sits at machine Z 0. */
const TRAY_POSITION_Z = 18

function computeTray() {
  return runSolidScenario({
    part: 'tray', z: 0, stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
    operations: [{ kind: 'parallel_3d', toolDiameter: BALL, params: { stepover: 3, tolerance: TOLERANCE } }],
  }).then(readings => readings[0])
}

describe('WO-1615 Parallel 3D ball never cuts into the tray walls', () => {
  it('the tray path stays on the surface: drop-contact reading and exact ball-to-mesh distance', async () => {
    const r = await computeTray()
    expect(r.status, r.errorMessage).toBe('ready')
    const gouge = await solidGougeMm({
      part: 'tray', partPositionZ: TRAY_POSITION_Z, worldMoves: r.worldMoves,
      cutter: { kind: 'ball', diameter: BALL }, shrinkMm: LATERAL_SLACK,
    })
    console.log(`[WO-1615] tray: ${r.worldMoves.length} moves, drop reading ${JSON.stringify(gouge)}`)
    expect(gouge.samplesOverPart, 'samples over the part').toBeGreaterThan(0)
    expect(gouge.maxGougeMm, `below the surface: ${JSON.stringify(gouge.worst)}`).toBeLessThanOrEqual(TOLERANCE)
    // Independent of the kernel: the ball's centre is never nearer the mesh than its radius.
    const pen = maxBallPenetration(await solidMesh('tray'), r.worldMoves, TRAY_POSITION_Z, BALL / 2)
    console.log(`[WO-1615] tray: exact penetration ${JSON.stringify(pen)}`)
    expect(pen.pen, `ball into the part at ${JSON.stringify(pen)}`).toBeLessThanOrEqual(TOLERANCE)
  }, 300_000)

  it('computing another operation first leaves the tray path unchanged', async () => {
    const alone = await computeTray()
    const box = await runSolidScenario({
      part: 'closed_box', z: 0, stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
      operations: [{ kind: 'parallel_3d', toolDiameter: BALL }],
    })
    expect(box[0].status, box[0].errorMessage).toBe('ready')
    const after = await computeTray()
    expect(alone.status, alone.errorMessage).toBe('ready')
    expect(after.worldMoves.length).toBe(alone.worldMoves.length)
    expect(after.worldMoves).toEqual(alone.worldMoves)
  }, 300_000)

  it('a chord across a cutter-location cliff is refined, and a flat pass is left untouched', async () => {
    // Drop surface: floor Z 0 for x < 1.23, rim Z 10 beyond (a ball riding up a wall).
    const cliff = 1.23
    const surface = (x: number) => (x < cliff ? 0 : 10)
    const drop = async (xy: Float64Array) => {
      const out = new Float64Array(xy.length / 2)
      for (let i = 0; i < out.length; i++) out[i] = surface(xy[2 * i])
      return out
    }
    const xy = Float64Array.from([0, 0, 1.5, 0, 3, 0])
    const refined = await refinePassChords(xy, Float64Array.from([0, 10, 10]), drop, TOLERANCE, -100)
    expect(refined.inserted).toBeGreaterThan(0)
    // Every point is a true drop point.
    const redrop = await drop(refined.xy)
    expect(Array.from(refined.z)).toEqual(Array.from(redrop))
    // Walk the refined polyline finely: below the drop surface by more than the
    // tolerance only within a tenth of the tolerance of the cliff (sideways reach).
    let reach = 0
    for (let i = 1; i < refined.z.length; i++) {
      const ax = refined.xy[2 * i - 2], bx = refined.xy[2 * i]
      const az = refined.z[i - 1], bz = refined.z[i]
      for (let k = 0; k <= 50; k++) {
        const t = k / 50
        const x = ax + (bx - ax) * t
        if (surface(x) - (az + (bz - az) * t) > TOLERANCE) reach = Math.max(reach, Math.abs(x - cliff))
      }
    }
    expect(reach).toBeLessThanOrEqual(TOLERANCE / 10)
    const flat = await refinePassChords(
      xy, Float64Array.from([0, 0, 0]), async p => new Float64Array(p.length / 2), TOLERANCE, -100,
    )
    expect(flat.inserted).toBe(0)
    expect(flat.xy).toBe(xy)
  })
})

/** Deepest the ball (a sphere of radius R standing on the tip) reaches into the
 * mesh along every feed move, sampled every 0.25 mm: R minus the exact
 * distance from the ball centre to the nearest triangle. */
function maxBallPenetration(
  mesh: { positions: Float32Array; indices: Uint32Array },
  moves: readonly ToolpathMove[], partPositionZ: number, R: number,
) {
  const P = mesh.positions, I = mesh.indices
  const cell = 4
  const grid = new Map<string, number[]>()
  for (let t = 0; t < I.length; t += 3) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let k = 0; k < 3; k++) {
      const x = P[I[t + k] * 3], y = P[I[t + k] * 3 + 1]
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    for (let gx = Math.floor((x0 - R) / cell); gx <= Math.floor((x1 + R) / cell); gx++) {
      for (let gy = Math.floor((y0 - R) / cell); gy <= Math.floor((y1 + R) / cell); gy++) {
        const key = `${gx},${gy}`
        let list = grid.get(key)
        if (!list) grid.set(key, list = [])
        list.push(t)
      }
    }
  }
  const vertex = (i: number) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
  let worst = { pen: 0, x: 0, y: 0, z: 0 }
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b)) continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.25))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t - partPositionZ
      const list = grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`)
      if (!list) continue
      for (const tri of list) {
        const d = Math.sqrt(closestSq([x, y, z + R], vertex(I[tri]), vertex(I[tri + 1]), vertex(I[tri + 2])))
        if (R - d > worst.pen) worst = { pen: R - d, x, y, z }
      }
    }
  }
  return worst
}

/** Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestSq(p: number[], a: number[], b: number[], c: number[]): number {
  const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const dist = (q: number[]) => { const d = sub(p, q); return dot(d, d) }
  const lerp = (u: number[], v: number[], t: number) =>
    [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t]
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return dist(a)
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return dist(b)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(lerp(a, b, d1 / (d1 - d3)))
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return dist(c)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(lerp(a, c, d2 / (d2 - d6)))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist(lerp(b, c, (d4 - d3) / ((d4 - d3) + (d5 - d6))))
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return dist([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w])
}
