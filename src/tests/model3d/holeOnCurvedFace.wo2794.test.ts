// @vitest-environment jsdom
//
// WO-2794: a Hole placed on a curved face drills along the surface normal at
// the picked point (audit cell HO-2, docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-
// AUDIT-2026-10.md fix-plan item 3). Before the fix `makeHole` drilled every
// point along ONE normal per face (the face's UV-middle normal), so a d5 hole
// picked near the dome's foot went in 34 deg off the dome normal, out into the
// plate.
//
// Every case runs the REAL Model screen (SolidsWorkbenchPage) on the REAL
// in-process occt kernel: the part comes in through the screen's Import input,
// the face is picked by a viewport ray, and the hole goes through the Hole
// tool's own dialog, preview and Apply. The kernel is read only to MEASURE.
//
// Oracles (independent of the code under test):
//  - dome: the hole's flat bottom is perpendicular to the sphere normal at the
//    picked seed, (seed - centre) / |seed - centre|, within 0.01 deg; the
//    removed volume is a d5 x 3 cylinder along that axis cut out of
//    block + sphere by quadrature.
//  - flat face (control): a d5 x 3 hole straight down, pi * 2.5^2 * 3, and the
//    same face count as before the fix.
//  - cylinder side (control): the hole drills radially, toward the boss axis.
//
// WO2794_CAPTURE=1 writes HO-2's section picture into src/tests/evidence/WO-2794/.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// directEditAudit.wo2757.test.ts installs before importing the page).
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const EVIDENCE = resolve(process.cwd(), 'src/tests/evidence/WO-2794')
const DOME_STEP = resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step')
const CAPTURE = process.env.WO2794_CAPTURE === '1'
const PI = Math.PI

type V3 = { x: number; y: number; z: number }

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  useCamStore.getState().addConsoleEvent = () => {}
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

interface StepSession { runtime: FakeSceneRuntime; volume: number }

/** Mount the Model screen on the real kernel and import `path` through the
 *  screen's own Import input. */
async function openStep(path: string): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf('IMP1') }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body: kernel surface class, triangle-area-weighted
 *  centroid/normal, plus the largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const tri = (t: number) => {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    return { a, b, c, cr: { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x } }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const { a, b, c, cr } = tri(t)
    const area = Math.hypot(cr.x, cr.y, cr.z) / 2
    f.a += area
    for (const k of ['x', 'y', 'z'] as const) {
      f.c[k] += area * (a[k] + b[k] + c[k]) / 3
      f.n[k] += cr[k] / 2
    }
    if (area > f.bestA) { f.bestA = area; f.best = t }
  }
  const out: FaceInfo[] = []
  for (let i = 0; i < mesh.faceIds.length; i++) {
    const f = acc[i]
    if (f.best < 0) continue
    const { a, b, c, cr } = tri(f.best)
    const cl = Math.hypot(cr.x, cr.y, cr.z)
    const nl = Math.hypot(f.n.x, f.n.y, f.n.z) || 1
    out.push({
      id: mesh.faceIds[i],
      type: await hooks().client.classifyFace(h, mesh.faceIds[i]),
      centroid: { x: f.c.x / f.a, y: f.c.y / f.a, z: f.c.z / f.a },
      normal: { x: f.n.x / nl, y: f.n.y / nl, z: f.n.z / nl },
      aim: { point: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }, normal: { x: cr.x / cl, y: cr.y / cl, z: cr.z / cl } },
    })
  }
  return out
}

function findFace(faces: FaceInfo[], label: string, test: (f: FaceInfo) => boolean): FaceInfo {
  const hit = faces.find(test)
  if (hit === undefined) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid, f.normal]))}`)
  return hit
}

/** Aim the viewport ray straight down a face's own outward normal. */
function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

interface HolePayload { seed: V3; normal: V3; points: V3[]; depth: { distance?: number } }

/** Hole tool: arm, pick, type d and depth, wait for the preview, Apply. */
async function holeStep(aim: () => void, diameter: string, depth: string): Promise<{ id: string; payload: HolePayload }> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-hole'))
  aim()
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy(), { timeout: 20_000 })
  commitField('hole-diameter', diameter)
  commitField('hole-blind-distance', depth)
  await waitFor(() => {
    const st = statusOf('hole-preview-status')
    expect(st !== null && st !== 'pending' && st !== 'idle').toBe(true)
  }, { timeout: 60_000 })
  expect(statusOf('hole-preview-status'), text('hole-preview-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(['ok', 'failed']).toContain(hooks().scheduler.statusOf(id!))
  }, { timeout: 60_000 })
  expect(hooks().scheduler.statusOf(id!), JSON.stringify(hooks().scheduler.diagnosticsOf(id!))).toBe('ok')
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  return { id: id!, payload: hooks().dag.getNode(id!)!.payload as unknown as HolePayload }
}

const unit = (v: V3): V3 => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l } }
const angleDeg = (a: V3, b: V3) => {
  const [ua, ub] = [unit(a), unit(b)]
  return Math.acos(Math.min(1, Math.abs(ua.x * ub.x + ua.y * ub.y + ua.z * ub.z))) * 180 / PI
}

/** The hole's flat floor: of the planes within 3.5 mm of the seed, the one
 *  that faces back up the hole at the seed from deepest in. Its normal IS the
 *  drilled axis. (Near the dome's foot the hole's mouth also leaves a flat
 *  face in the tangent plane at the seed, where the d5 disk reaches into the
 *  plate; that face is level with the seed, not below it.) */
async function holeBottom(resultId: string, seed: V3): Promise<FaceInfo> {
  const rise = (f: FaceInfo) => (seed.x - f.centroid.x) * f.normal.x + (seed.y - f.centroid.y) * f.normal.y + (seed.z - f.centroid.z) * f.normal.z
  const near = (await facesOf(resultId)).filter((f) => f.type === 'plane' &&
    Math.hypot(f.centroid.x - seed.x, f.centroid.y - seed.y, f.centroid.z - seed.z) < 3.5)
  const floor = near.sort((a, b) => rise(b) - rise(a))[0]
  if (floor === undefined || !(rise(floor) > 1)) throw new Error(`no hole floor near ${JSON.stringify(seed)}: ${JSON.stringify(near.map((f) => [f.centroid, f.normal]))}`)
  return floor
}

/** Material a d(2r) cylinder `depth` long, drilled along -n from `seed`,
 *  takes out of the part `inside` - midpoint quadrature over the cylinder. */
function cylinderRemoved(seed: V3, n: V3, r: number, depth: number, inside: (x: number, y: number, z: number) => boolean): number {
  const w = unit(n)
  const a = Math.abs(w.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u = unit({ x: a.y * w.z - a.z * w.y, y: a.z * w.x - a.x * w.z, z: a.x * w.y - a.y * w.x })
  const v = { x: w.y * u.z - w.z * u.y, y: w.z * u.x - w.x * u.z, z: w.x * u.y - w.y * u.x }
  const h = 0.02
  let vol = 0
  for (let i = -r + h / 2; i < r; i += h) {
    for (let j = -r + h / 2; j < r; j += h) {
      if (i * i + j * j > r * r) continue
      for (let k = h / 2; k < depth; k += h) {
        if (inside(seed.x + i * u.x + j * v.x - k * w.x, seed.y + i * u.y + j * v.y - k * w.y, seed.z + i * u.z + j * v.z - k * w.z)) vol += h * h * h
      }
    }
  }
  return vol
}

/** One closed solid: write the result out as STEP and read it back - it
 *  holds exactly one body. */
async function solidCount(resultId: string): Promise<number> {
  const bytes = await hooks().client.exportStep([hooks().getBodyHandle(resultId) as BodyHandle])
  const back = await hooks().client.importStep(bytes, 'WO2794CHK')
  return back.bodies.length
}

// fix_freeform.step: block 40x40x10 + sphere r12 centred (20,20,12).
const DOME_C = { x: 20, y: 20, z: 12 }
const DOME_R = 12
const insideDomePart = (x: number, y: number, z: number) =>
  (x >= 0 && x <= 40 && y >= 0 && y <= 40 && z >= 0 && z <= 10) ||
  (x - DOME_C.x) ** 2 + (y - DOME_C.y) ** 2 + (z - DOME_C.z) ** 2 <= DOME_R ** 2

// boss_fillet_base.step: plate 60x60x10, d20 x 12 boss at (30,30), r3 foot fillet.
const insideBoss = (x: number, y: number, z: number) => (x - 30) ** 2 + (y - 30) ** 2 <= 100 && z >= 10 && z <= 22

describe('WO-2794 a Hole on a curved face drills along the surface normal at the picked point', () => {
  it('HO-2 d5 x 3 hole on the dome: axis = the sphere normal at the seed, volume = the cylinder along it, one closed solid', async () => {
    const s = await openStep(DOME_STEP)
    const dome = findFace(await facesOf('IMP1'), 'dome', (f) => f.type === 'sphere')
    const { id, payload } = await holeStep(() => aimAtFace(s.runtime, dome), '5', '3')
    const picked = payload.points[0] ?? payload.seed
    // The pick lands on the drawn (tessellated) dome, within chord error of the
    // sphere; the hole starts at that point carried onto the sphere, where the
    // normal is radial.
    expect(Math.abs(Math.hypot(picked.x - DOME_C.x, picked.y - DOME_C.y, picked.z - DOME_C.z) - DOME_R)).toBeLessThan(0.1)
    const sphereNormal = unit({ x: picked.x - DOME_C.x, y: picked.y - DOME_C.y, z: picked.z - DOME_C.z })
    const seed = { x: DOME_C.x + DOME_R * sphereNormal.x, y: DOME_C.y + DOME_R * sphereNormal.y, z: DOME_C.z + DOME_R * sphereNormal.z }
    if (CAPTURE) await captureSection('HO-2', `d5 x 3 hole picked on the dome (${process.env.WO2794_CAPTURE_TAG ?? 'after'} WO-2794)`, id, 'y', seed.y)
    const bottom = await holeBottom(id, seed)
    const off = angleDeg(bottom.normal, sphereNormal)
    console.log(`WO-2794 HO-2 seed ${JSON.stringify(seed)} drilled axis ${JSON.stringify(bottom.normal)} off the sphere normal by ${off} deg`)
    expect(off, `drilled axis is ${off.toFixed(3)} deg off the dome normal at the seed`).toBeLessThan(0.01)
    // The bottom sits 3 mm in along that normal (blind depth from the seed).
    const depthAlong = (seed.x - bottom.centroid.x) * sphereNormal.x + (seed.y - bottom.centroid.y) * sphereNormal.y + (seed.z - bottom.centroid.z) * sphereNormal.z
    expect(depthAlong).toBeCloseTo(3, 2)
    const removed = s.volume - await volumeOf(id)
    const expected = cylinderRemoved(seed, sphereNormal, 2.5, 3, insideDomePart)
    console.log(`WO-2794 HO-2 removed ${removed.toFixed(3)} expected ${expected.toFixed(3)}`)
    expect(Math.abs(removed - expected)).toBeLessThan(Math.max(0.01 * expected, 0.05))
    expect(await solidCount(id)).toBe(1)
  }, 180_000)

  it('control: a d5 x 3 hole on a flat face is unchanged (straight down, pi * 2.5^2 * 3, same faces)', async () => {
    const s = await openStep(resolve(PARTS, 'rib_part.step'))
    const base = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && Math.abs(f.centroid.z - 5) < 1e-3)
    const { id, payload } = await holeStep(() => aimAtFace(s.runtime, base), '5', '3')
    const seed = payload.points[0] ?? payload.seed
    const bottom = await holeBottom(id, seed)
    expect(angleDeg(bottom.normal, { x: 0, y: 0, z: 1 })).toBeLessThan(1e-6)
    expect(bottom.centroid.z).toBeCloseTo(2, 6)
    expect(s.volume - await volumeOf(id)).toBeCloseTo(PI * 2.5 ** 2 * 3, 3)
    // Face count measured on main before the fix: the body gains a wall and a floor.
    expect((await facesOf(id)).length - (await facesOf('IMP1')).length).toBe(2)
    expect(await solidCount(id)).toBe(1)
  }, 180_000)

  it('control: a d5 x 3 hole on a cylinder side drills radially, toward the boss axis', async () => {
    const s = await openStep(resolve(PARTS, 'boss_fillet_base.step'))
    // Hit the boss side square-on at (40, 30, 17).
    const { id, payload } = await holeStep(() => aimAt(s.runtime, { x: 55, y: 30, z: 17 }, { x: 30, y: 30, z: 17 }), '5', '3')
    const seed = payload.points[0] ?? payload.seed
    expect(Math.hypot(seed.x - 30, seed.y - 30)).toBeCloseTo(10, 3)
    const radial = unit({ x: seed.x - 30, y: seed.y - 30, z: 0 })
    const bottom = await holeBottom(id, seed)
    const off = angleDeg(bottom.normal, radial)
    console.log(`WO-2794 boss seed ${JSON.stringify(seed)} drilled axis ${JSON.stringify(bottom.normal)} off radial by ${off} deg`)
    expect(off).toBeLessThan(0.01)
    const removed = s.volume - await volumeOf(id)
    const expected = cylinderRemoved(seed, radial, 2.5, 3, insideBoss)
    expect(Math.abs(removed - expected)).toBeLessThan(Math.max(0.01 * expected, 0.05))
    expect(await solidCount(id)).toBe(1)
  }, 180_000)
})

// ---------------------------------------------------------------- capture
type Seg = [number, number, number, number]

function sectionOf(pos: ArrayLike<number>, idx: ArrayLike<number>, axis: 'x' | 'y', at: number): Seg[] {
  const a = axis === 'y' ? 1 : 0
  const u = axis === 'y' ? 0 : 1
  const out: Seg[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
    const pts: Array<[number, number]> = []
    for (let k = 0; k < 3; k++) {
      const p = v[k]
      const q = v[(k + 1) % 3]
      const dp = p[a] - at
      const dq = q[a] - at
      if ((dp < 0 && dq >= 0) || (dp >= 0 && dq < 0)) {
        const f = dp / (dp - dq)
        pts.push([p[u] + f * (q[u] - p[u]), p[2] + f * (q[2] - p[2])])
      }
    }
    if (pts.length === 2) out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]])
  }
  return out
}

async function captureSection(cell: string, title: string, resultId: string, axis: 'x' | 'y', at: number): Promise<void> {
  const cut = async (id: string) => {
    const m = await hooks().client.tessellate(hooks().getBodyHandle(id) as BodyHandle, { deflection: 0.02 })
    return sectionOf(m.position, m.index, axis, at)
  }
  const before = await cut('IMP1')
  const after = await cut(resultId)
  const all = [...before, ...after]
  const us = all.flatMap((s) => [s[0], s[2]])
  const zs = all.flatMap((s) => [s[1], s[3]])
  const [u0, u1, z0, z1] = [Math.min(...us) - 2, Math.max(...us) + 2, Math.min(...zs) - 2, Math.max(...zs) + 2]
  const scale = 760 / Math.max(u1 - u0, (z1 - z0) * 1.6)
  const W = Math.ceil((u1 - u0) * scale) + 40
  const H = Math.ceil((z1 - z0) * scale) + 90
  const X = (v: number) => (20 + (v - u0) * scale).toFixed(2)
  const Z = (v: number) => (70 + (z1 - v) * scale).toFixed(2)
  const lines = (segs: Seg[], color: string, width: number) => segs.map((s) =>
    `<line x1="${X(s[0])}" y1="${Z(s[1])}" x2="${X(s[2])}" y2="${Z(s[3])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="20" y="24" font-family="sans-serif" font-size="16" font-weight="bold">${cell}: ${title}</text>
<text x="20" y="46" font-family="sans-serif" font-size="13">Section at ${axis} = ${at.toFixed(3)} mm (horizontal: ${axis === 'y' ? 'x' : 'y'}, vertical: z). Grey = imported part, red = result after the edit.</text>
${lines(before, '#9a9a9a', 4)}
${lines(after, '#d0302f', 1.6)}
</svg>
`
  writeFileSync(resolve(EVIDENCE, `${cell}-section-${process.env.WO2794_CAPTURE_TAG ?? 'after'}.svg`), svg)
}
