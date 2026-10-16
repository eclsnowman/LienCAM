// @vitest-environment jsdom
// Real Model screen import, viewport picks, preview and Apply; kernel reads measure the result.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { OcctKernel } from 'occt-wasm'
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
const part = (name: string) => resolve(PARTS, name)
const EVIDENCE = resolve(process.cwd(), 'src/tests/evidence/WO-2804/shell')

mkdirSync(EVIDENCE,{recursive:true})

type V3 = { x: number; y: number; z: number }

let consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push(event.message) }
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

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body: kernel surface class, area-weighted centroid and
 *  normal, bounds, and the largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const tri = (t: number) => {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
    return { a, b, c, cr, area: Math.hypot(cr.x, cr.y, cr.z) / 2 }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const { a, b, c, cr, area } = tri(t)
    f.a += area
    for (const k of ['x', 'y', 'z'] as const) {
      f.c[k] += area * (a[k] + b[k] + c[k]) / 3
      f.n[k] += cr[k] / 2
      f.min[k] = Math.min(f.min[k], a[k], b[k], c[k])
      f.max[k] = Math.max(f.max[k], a[k], b[k], c[k])
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
      min: f.min, max: f.max,
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

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

const newFeatureId = (before: string[]) => hooks().dag.featureOrder().find((id) => !before.includes(id))

/** After an Apply: the one new feature replays ok; returns its id and the
 *  volume change against the imported part. */
async function applied(before: string[], startVolume: number): Promise<{ id: string; delta: number }> {
  let id: string | undefined
  await waitFor(() => {
    id = newFeatureId(before)
    expect(id).toBeDefined()
    expect(hooks().scheduler.statusOf(id!)).toBe('ok')
  }, { timeout: 60_000 })
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  return { id: id!, delta: (await volumeOf(id!)) - startVolume }
}


async function finish(tool: string, s: StepSession, before: string[]) {
  const st = `${tool}-preview-status`
  await waitFor(() => expect(statusOf(st) !== null && !['pending','idle'].includes(statusOf(st)!)).toBe(true), { timeout: 60_000 })
  expect(statusOf(st), text(st)).toBe('ready')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  return applied(before, s.volume)
}
async function shell(s: StepSession, face: FaceInfo, t: number) {
  const apply = vi.spyOn(hooks().client, 'applyShell')
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-shell'))
  aimAtFace(s.runtime, face); click()
  await waitFor(() => expect(text('shell-face-count')).toMatch(/1 face/))
  commitField('shell-thickness', String(t))
  const result = await finish('shell', s, before)
  const diagnostics = (await apply.mock.results.at(-1)!.value).diagnostics
  apply.mockRestore()
  return { ...result, diagnostics }
}
async function draft(s: StepSession, neutral: FaceInfo, wall: FaceInfo) {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-draft'))
  aimAtFace(s.runtime, neutral); click()
  await waitFor(() => expect(text('draft-neutral-face-role')).toMatch(/confirm this role/i))
  fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
  aimAtFace(s.runtime, wall); click()
  await waitFor(() => expect(text('draft-face-role')).toMatch(/1 draft face selected/i))
  commitField('draft-angle', '3')
  return finish('draft', s, before)
}
const cells: Record<string, unknown> = {}
function record(cell: string, detail: unknown) {
  cells[cell] = { verdict: 'WORKS', detail }
  writeFileSync(resolve(EVIDENCE, 'cells.json'), JSON.stringify(cells, null, 2)+'\n')
}
/** Read back the STEP the Model screen actually exports. Recognition is not
 * a radius oracle: a drafted rolling-ball spline may cease to be removable.
 * Every curved face must still carry its 2 or 5 mm circular section radius
 * at every accepted point from nine varied U/V locations. The fixture generator specifies 8 floor bands + 4 corners. */
async function readback(id: string, retainedCentroids?: V3[], thickness?: number) {
  const bytes = await hooks().client.exportStep([hooks().getBodyHandle(id)!])
  const k = await OcctKernel.init()
  const shape = k.importStep(bytes)
  const fs = k.getSubShapes(shape,'face')
  const solids = k.getSubShapes(shape,'solid')
  try {
    expect(k.isValid(shape)).toBe(true)
    expect(solids).toHaveLength(thickness === undefined ? 1 : 2)
    const pieces = solids.map(solid => {
      expect(k.isValid(solid)).toBe(true)
      const volume = k.getVolume(solid)
      expect(volume).toBeGreaterThan(0)
      const bounds = k.getBoundingBox(solid, false)
      const measurements: number[] = []
      if (thickness !== undefined) {
        const pocket = bounds.zmin > 5
        const points = pocket
          ? [[15,20,17,-1,0,0],[30,10,17,0,-1,0],[30,20,12,0,0,-1]]
          : [[0,20,5,1,0,0],[30,0,5,0,1,0],[30,20,0,0,0,1]]
        // Three independent planar wall stations on EACH exported solid.
        // Bracket its inner boundary to 0.0001 mm without relying on mesh bounds.
        for (const [x,y,z,dx,dy,dz] of points) {
          const inside = (d: number) => k.containsPoint(solid, {x:x+dx*d,y:y+dy*d,z:z+dz*d})
          expect(inside(thickness*.5)).toBe(true)
          expect(inside(thickness-1e-4)).toBe(true)
          expect(inside(thickness+1e-4)).toBe(false)
          let lo=thickness*.5, hi=thickness*1.5
          for (let i=0;i<24;i++) { const mid=(lo+hi)/2; if (inside(mid)) lo=mid; else hi=mid }
          measurements.push((lo+hi)/2)
        }
        const expected = pocket ? pocketSkinVolume(thickness) : 60*40*20-(60-2*thickness)*(40-2*thickness)*(20-thickness)
        expect(Math.abs(volume-expected)).toBeLessThan(.02)
      }
      return { valid: true, volume, bounds, measurements }
    })
    const radii: number[] = []
    const bands: Array<{radius:number;samples:Array<[number,number]>}> = []
    for (const f of fs) {
      if (k.surfaceType(f) === 'plane') continue
      if (retainedCentroids) {
        const c=k.getSurfaceCenterOfMass(f)
        if (!retainedCentroids.some(p=>Math.hypot(c.x-p.x,c.y-p.y,c.z-p.z)<.05)) continue
      }
      const uv = k.uvBounds(f)
      const samples: Array<[number,number]> = []
      const circumradius = (points: Array<{x:number;y:number;z:number}>) => {
        const [a,b,c]=points
        const ab=[b.x-a.x,b.y-a.y,b.z-a.z], ac=[c.x-a.x,c.y-a.y,c.z-a.z]
        const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
        const area2=Math.hypot(...cross)
        return area2>1e-12 ? Math.hypot(...ab)*Math.hypot(...ac)*Math.hypot(c.x-b.x,c.y-b.y,c.z-b.z)/(2*area2) : Infinity
      }
      for (const [fu,fv] of [[.25,.25],[.5,.5],[.75,.75],[.25,.75],[.75,.25],[.125,.5],[.875,.5],[.5,.125],[.5,.875]]) {
        const u = uv.uMin+fu*(uv.uMax-uv.uMin), v = uv.vMin+fv*(uv.vMax-uv.vMin)
        if (k.classifyPointOnFace(f,u,v) !== 'in') continue
        const du=(uv.uMax-uv.uMin)*.001, dv=(uv.vMax-uv.vMin)*.001
        if ([-1,1].some(d => k.classifyPointOnFace(f,u+d*du,v) !== 'in' || k.classifyPointOnFace(f,u,v+d*dv) !== 'in')) continue
        samples.push([
          circumradius([-1,0,1].map(d=>k.pointOnSurface(f,u+d*du,v))),
          circumradius([-1,0,1].map(d=>k.pointOnSurface(f,u,v+d*dv))),
        ])
      }
      expect(samples.length).toBeGreaterThanOrEqual(3)
      const radius = [2,5].find(r => [0,1].some(axis=>samples.every(c=>Math.abs(c[axis]-r)<.005)))
      expect(radius, `${k.surfaceType(f)} ${JSON.stringify(samples.slice(0,3))}`).toBeDefined()
      radii.push(radius!)
      bands.push({ radius:radius!, samples })
    }
    return { valid: true, solids: solids.length, pieces, radii: radii.sort((a,b)=>a-b), bands }
  } finally {
    for (const f of fs) k.release(f)
    for (const solid of solids) k.release(solid)
    k.release(shape)
    k[Symbol.dispose]()
  }
}
async function radii(id: string) { return (await readback(id)).radii }
type Seg = [number, number, number, number]

/** Cut a triangle mesh with the plane `axis` = `at`; segments in the other
 *  horizontal axis (u) and z. */
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

function writeSectionSvg(cell: string, title: string, before: Seg[], after: Seg[], axis: 'x' | 'y', at: number): void {
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
<text x="20" y="46" font-family="sans-serif" font-size="13">Section at ${axis} = ${at} mm (horizontal: ${axis === 'y' ? 'x' : 'y'}, vertical: z). Grey = imported part, red = result after the edit.</text>
${lines(before, '#9a9a9a', 4)}
${lines(after, '#d0302f', 1.6)}
</svg>
`
  writeFileSync(resolve(EVIDENCE, `${cell}-section.svg`), svg)
}

async function captureStep(cell: string, title: string, resultId: unknown, axis: 'x' | 'y', at: number): Promise<void> {
  if (typeof resultId !== 'string') return
  const cut = async (id: string) => {
    const m = await hooks().client.tessellate(hooks().getBodyHandle(id) as BodyHandle, { deflection: 0.02 })
    return sectionOf(m.position, m.index, axis, at)
  }
  writeSectionSvg(cell, title, await cut('IMP1'), await cut(resultId), axis, at)
}


// Independent section integration from generate_parts.py: rounded rectangle
// 30x20, r5 corners, r2 floor fillet centred at z14. Its outward parallel
// surface has radius 2+t and corner radius 5+d; no kernel volumes are inputs.
function pocketSkinVolume(t: number): number {
  const area = (d: number) => (30+2*d)*(20+2*d)-(4-Math.PI)*(5+d)**2
  const envelope = (wall: number) => {
    const radius=2+wall, steps=20000, dz=radius/steps
    let volume=(20-14)*area(wall)
    for (let i=0;i<steps;i++) {
      const below=radius-(i+.5)*dz
      volume+=area(-2+Math.sqrt(radius**2-below**2))*dz
    }
    return volume
  }
  return envelope(t)-envelope(0)
}

function domeShellRemoved(t: number): number {
  const rj = Math.sqrt(12 ** 2 - (10 - 12) ** 2)
  const h = 0.005
  let v = 0
  for (let z = 10 - t + h / 2; z < 12 + 12; z += h) {
    for (let r = h / 2; r < 12 + 0.5; r += h) {
      if (z > 10 && r * r + (z - 12) ** 2 > 12 ** 2) continue
      const dRim = Math.hypot(r - rj, z - 10)
      const dTop = r >= rj ? Math.abs(z - 10) : dRim
      const len = Math.hypot(r, z - 12)
      const dCap = 12 + 12 * (z - 12) / len >= 10 ? Math.abs(12 - len) : dRim
      if (Math.min(dTop, dCap) >= t) v += 2 * Math.PI * r * h * h
    }
  }
  return (40 - 2 * t) ** 2 * (10 - t) + v
}

describe('WO-2799 Shell and Draft on filleted STEP parts', () => {
  for (const [cell,t] of [['SH-1',2],['SH-3',1]] as const) {
    it(`${cell}: pocket floor fillets survive a ${t} mm shell, with three measured walls`, async () => {
      const s = await openStep(part('pocket_floor_fillet.step'))
      const originalRadii = await radii('IMP1')
      expect(originalRadii).toEqual([...Array<number>(8).fill(2), ...Array<number>(4).fill(5)])
      const importedFaces = await facesOf('IMP1')
      const top = findFace(importedFaces, 'top', f => f.type === 'plane' && f.normal.z > .99 && Math.abs(f.centroid.z-20)<.01)
      const r = await shell(s, top, t)
      expect(r.delta).toBeLessThan(-100)
      const fs = await facesOf(r.id)
      // Three independent planar walls: x=0, y=0, bottom z=0.
      const measurements = [
        findFace(fs, 'inner x wall', f => f.type === 'plane' && f.normal.x > .99 && Math.abs(f.centroid.x-t)<.01).centroid.x,
        findFace(fs, 'inner y wall', f => f.type === 'plane' && f.normal.y > .99 && Math.abs(f.centroid.y-t)<.01).centroid.y,
        findFace(fs, 'inner bottom', f => f.type === 'plane' && f.normal.z > .99 && Math.abs(f.centroid.z-t)<.01).centroid.z,
      ]
      for (const v of measurements) expect(v).toBeCloseTo(t, 3)
      const retainedBlends = importedFaces.filter(f=>f.type!=='plane')
      const retainedFaces = importedFaces.filter(f=>f.id!==top.id)
      for (const before of retainedFaces) {
        const after = fs.find(f=>f.id===before.id)
        expect(after, `retained face ${before.id}`).toBeDefined()
        expect(after!.type).toBe(before.type)
        for (const axis of ['x','y','z'] as const) expect(after!.centroid[axis]).toBeCloseTo(before.centroid[axis],3)
      }
      const resolutions = await hooks().client.resolve(hooks().getBodyHandle(r.id)!,retainedFaces.map(f=>f.id))
      expect(resolutions.every(r=>r.status==='exact')).toBe(true)
      const geometricReadback = await readback(r.id,retainedBlends.map(f=>f.centroid),t)
      expect(geometricReadback.radii).toEqual(originalRadii)
      expect(geometricReadback.pieces.flatMap(p=>p.measurements)).toHaveLength(6)
      for (const v of geometricReadback.pieces.flatMap(p=>p.measurements)) expect(v).toBeCloseTo(t,3)
      const diagnostics = r.diagnostics
      expect(diagnostics).toContainEqual({ code:'OK',severity:'info',params:{pieces:2,reason:'Shell left 2 separate pieces: with this face open the pocket no longer joins the outer walls'} })
      expect(consoleLines.filter(line => line === 'Shell left 2 separate pieces: with this face open the pocket no longer joins the outer walls')).toHaveLength(1)
      record(cell, { representation:'one compound body containing both valid solids', thickness: measurements, originalRadii, volumeDelta: r.delta, geometricReadback, diagnostics, consoleLines })
      if (cell === 'SH-1') {
        await captureStep(cell, '2 mm shell - floor fillets retained', r.id, 'y', 20)
        fireEvent.contextMenu(screen.getByTestId(`feature-row-${r.id}`))
        fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
        await waitFor(() => expect(screen.getByTestId('shell-thickness')).toBeTruthy())
        commitField('shell-thickness', '1.5')
        await waitFor(() => expect(statusOf('shell-preview-status'), text('shell-preview-status')).toBe('ready'))
        fireEvent.click(screen.getByTestId('dialog-shell-apply'))
        await waitFor(() => expect(screen.queryByTestId('shell-thickness')).toBeNull())
        expect(consoleLines.filter(line => line === 'Shell left 2 separate pieces: with this face open the pocket no longer joins the outer walls')).toHaveLength(2)
      }
    }, 180_000)
  }
  it('DR-2: pocket wall drafts 3 degrees from its floor with unchanged fillet radii', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const originalRadii = await radii('IMP1')
    const fs = await facesOf('IMP1')
    const floor = findFace(fs, 'floor', f => f.type === 'plane' && f.normal.z > .99 && Math.abs(f.centroid.z-12)<.01)
    const wall = findFace(fs, 'wall', f => f.type === 'plane' && f.normal.y > .99 && Math.abs(f.centroid.y-10)<.01)
    const r = await draft(s, floor, wall)
    const after = findFace(await facesOf(r.id), 'drafted wall', f => f.type === 'plane' && f.normal.y>.99 && f.centroid.y<12 && f.centroid.y>8)
    const angle = Math.atan2(after.normal.z, after.normal.y)*180/Math.PI
    expect(angle).toBeCloseTo(3, 2)
    // The selected wall retains its id and still meets the neutral floor's
    // plane at the original sharp support line y=10, z=12.
    expect(after.id).toBe(wall.id)
    const neutralIntercept = after.centroid.y+(after.centroid.z-12)*after.normal.z/after.normal.y
    expect(neutralIntercept).toBeCloseTo(10, 4)
    const resolutions = await hooks().client.resolve(hooks().getBodyHandle(r.id)!, fs.map(f=>f.id))
    expect(resolutions.every(r=>r.status==='exact')).toBe(true)
    const geometricReadback = await readback(r.id)
    expect(geometricReadback.radii).toEqual(originalRadii)
    record('DR-2', { angleDeg: angle, originalRadii, volumeDelta: r.delta, neutralIntercept, geometricReadback })
    await captureStep('DR-2', '3 degree wall - all original fillet radii retained', r.id, 'x', 30)
  }, 180_000)
  it('existing dome shell retains its analytic 2 mm result', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step'))
    const bottom = findFace(await facesOf('IMP1'), 'bottom', f => f.type==='plane' && f.normal.z < -.99)
    const r = await shell(s,bottom,2)
    // Same oracle as SH-2 of the audit: spherical dome on a 40x40x10 plate.
    const expected = -domeShellRemoved(2)
    expect(Math.abs(r.delta-expected)).toBeLessThan(Math.abs(expected)*.002)
  }, 180_000)
})
