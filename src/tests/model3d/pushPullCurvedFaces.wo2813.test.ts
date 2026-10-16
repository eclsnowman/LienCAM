// @vitest-environment jsdom
// WO-2813: real STEP import, viewport pick, typed Push/Pull, Apply,
// kernel measurements, tree Edit and Undo. Hand cylinder/frustum oracles.

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

const { stepCache, stlCache } = vi.hoisted(() => ({
  stepCache: new Map<string, ArrayBuffer>(),
  stlCache: new Map<string, ArrayBuffer>(),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// pushPullAfterHoleResize.wo1416.test.ts installs before importing the page).
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

const OUT = resolve(process.cwd(), 'src/tests/evidence/WO-2813')
const PART = resolve(process.cwd(), 'src/tests/evidence/WO-2757/stepped_holes.step')
type V3 = { x: number; y: number; z: number }
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear(); stepCache.clear(); stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => { cleanup(); restoreCanvas2d?.(); restoreCanvas2d = null })
interface Outcome { verdict: string; message: string; detail: Record<string, unknown> }
function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

interface StepSession { runtime: FakeSceneRuntime; volume: number }
async function openStep(path: string, bodyIds: string[] = ['IMP1']): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  // Anchored value entries render only while their anchor projects on screen.
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
  try {
    for (const id of bodyIds) {
      await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    }
  } catch (e) {
    throw new Error(`import of ${name} did not produce ${bodyIds.join(',')}: features [${hooks().dag.featureOrder().join(',')}] ${screen.queryByTestId('workbench-status-bodies')?.textContent}; IMP1 ${hooks().scheduler.statusOf('IMP1')} ${JSON.stringify(hooks().scheduler.diagnosticsOf('IMP1'))}`, { cause: e })
  }
  return { runtime, volume: await volumeOf(bodyIds[0]) }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body: kernel surface class, triangle-area-weighted
 *  centroid/normal and bounds, plus the largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
    const area = Math.hypot(cr.x, cr.y, cr.z) / 2
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
    const t = f.best
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
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
  const hits = faces.filter(test)
  if (hits.length === 0) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid, f.normal]))}`)
  return hits[0]
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

function newFeatureId(before: string[]): string | undefined {
  return hooks().dag.featureOrder().find((id) => !before.includes(id))
}

/** After an Apply: did a feature land, replay ok, and change the volume by
 *  what the edit means? `expectedDelta` null = no analytic check. */
async function judgeApplied(before: string[], startVolume: number, expectedDelta: number | null, tol = 0.002): Promise<Outcome> {
  let id: string | undefined
  try {
    await waitFor(() => {
      id = newFeatureId(before)
      expect(id).toBeDefined()
      expect(['ok', 'failed']).toContain(hooks().scheduler.statusOf(id!))
    }, { timeout: 60_000 })
  } catch {
    return { verdict: 'CRASH', message: 'no feature landed after Apply', detail: {} }
  }
  const status = hooks().scheduler.statusOf(id!)
  if (status !== 'ok') {
    const diag = hooks().scheduler.diagnosticsOf(id!)
    return { verdict: 'REFUSES', message: `feature ${id} ${status}: ${JSON.stringify(diag)}`, detail: { id } }
  }
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  const after = await volumeOf(id!)
  const delta = after - startVolume
  const detail = { id, opType: hooks().dag.getNode(id!)?.payload.opType, volumeDelta: Number(delta.toFixed(3)), expectedDelta }
  if (expectedDelta !== null && Math.abs(delta - expectedDelta) > Math.max(tol * Math.abs(expectedDelta), 0.05)) {
    return { verdict: 'WRONG', message: `volume changed by ${delta.toFixed(3)}, expected ${expectedDelta.toFixed(3)}`, detail }
  }
  return { verdict: 'WORKS', message: 'applied', detail }
}

// --- Push/Pull (kernel route): typed two-stage entry, Enter previews, Enter applies.
async function pushPullStep(s: StepSession, face: FaceInfo, delta: number, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAtFace(s.runtime, face)
  click()
  const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
  const refused = () => hint()?.className.includes('refusal') === true
  try {
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') !== null || refused()).toBe(true), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `pick did not mount: ${hint()?.textContent ?? '(no hint)'}`, detail: {} }
  }
  if (refused()) return { verdict: 'REFUSES', message: hint()?.textContent ?? '', detail: { stage: 'pick' } }
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    const g = hooks().getPushPullTransactionState().gesture
    expect(!g.inFlight && (g.previewHandle !== null || refused())).toBe(true)
  }, { timeout: 60_000 })
  if (refused()) {
    const message = hint()?.textContent ?? ''
    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
    return { verdict: 'REFUSES', message, detail: { stage: 'preview' } }
  }
  fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') === null || refused()).toBe(true), { timeout: 60_000 })
  if (refused()) return { verdict: 'REFUSES', message: hint()?.textContent ?? '', detail: { stage: 'apply' } }
  return judgeApplied(before, s.volume, expectedDelta)
}


const PI = Math.PI
function expected(delta: number, cone: boolean): number {
  if (!cone) return -PI * ((5.5 + delta) ** 2 - 5.5 ** 2) * 6.5
  // d13/d6.6, 90 deg cone. Parallel normal offset changes the top
  // radius by delta / cos(45 deg), and the junction follows the pilot.
  const top = 6.5 + delta * Math.SQRT2
  const removed = (r: number) => PI * (r - 3.3) / 3 * (r*r + r*3.3 + 3.3*3.3) - PI * 3.3**2 * (r - 3.3)
  return -(removed(top) - removed(6.5))
}
function section(position: Float32Array, index: Uint32Array): number[][] {
  const lines: number[][] = []
  for (let i = 0; i < index.length; i += 3) {
    const p = [0,1,2].map(j => Array.from(position.slice(index[i+j]*3, index[i+j]*3+3)))
    const cuts: number[][] = []
    for (let j = 0; j < 3; j++) {
      const a=p[j], b=p[(j+1)%3]
      if ((a[1]<20) === (b[1]<20) || Math.abs(a[1]-b[1])<1e-9) continue
      const t=(20-a[1])/(b[1]-a[1]); cuts.push([a[0]+t*(b[0]-a[0]), a[2]+t*(b[2]-a[2])])
    }
    if (cuts.length===2) lines.push([...cuts[0],...cuts[1]])
  }
  return lines
}
async function capture(id: string, label: string): Promise<void> {
  const cut = async (fid: string) => { const m=await hooks().client.tessellate(hooks().getBodyHandle(fid)!, {deflection:0.02}); return section(m.position,m.index) }
  const before=await cut('IMP1'), after=await cut(id)
  const draw=(lines:number[][], color:string)=>lines.map(([x,z,u,v])=>`<line x1="${30+x*12}" y1="${270-z*12}" x2="${30+u*12}" y2="${270-v*12}" stroke="${color}" stroke-width="1.5"/>`).join('')
  writeFileSync(resolve(OUT, `${label}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="340"><rect width="900" height="340" fill="white"/><text x="30" y="30" font-family="Arial" font-size="18">${label}: section y=20 mm; blue before, red after</text>${draw(before,'#1565c0')}${draw(after,'#c62828')}</svg>`)
}
describe('WO-2813 production STEP curved Push/Pull', () => {
  for (const cone of [false,true]) for (const delta of [0.5,-0.5]) {
    const label = `${cone?'PP-7-cone':'PP-6-cylinder'}-${delta>0?'grow':'shrink'}`
    it(label, async () => {
      const s=await openStep(PART)
      const face=findFace(await facesOf('IMP1'),label,f=>f.type===(cone?'cone':'cylinder') && Math.abs(f.centroid.x-(cone?35:15))<0.1 && Math.abs(f.centroid.y-20)<0.1 && (cone||f.min.z>8))
      const o=await pushPullStep(s,face,delta,expected(delta,cone))
      expect(o.verdict, o.message).toBe('WORKS')
      const id=String(o.detail.id)
      const direction = hooks().dag.getNode(id)!.payload.normal as V3
      expect(direction.x*face.aim.normal.x+direction.y*face.aim.normal.y+direction.z*face.aim.normal.z).toBeLessThan(-0.9)
      const faces=await facesOf(id)
      const changed=findFace(faces,label,f=>f.type===(cone?'cone':'cylinder') && Math.abs(f.centroid.x-(cone?35:15))<0.1 && Math.abs(f.centroid.y-20)<0.1 && (cone||f.min.z>8))
      const mesh = await hooks().client.tessellate(hooks().getBodyHandle(id)!, {deflection:0.02})
      const rim: number[] = []
      for (let t=0; t<mesh.triFace.length; t++) {
        if (mesh.faceIds[mesh.triFace[t]] !== changed.id) continue
        for (let j=0;j<3;j++) {
          const k=mesh.index[t*3+j]*3
          if (Math.abs(mesh.position[k+2]-15)<1e-5) rim.push(Math.hypot(mesh.position[k]-(cone?35:15),mesh.position[k+1]-20))
        }
      }
      expect(rim.length).toBeGreaterThan(0)
      const rimR = Math.max(...rim)
      expect(rimR).toBeCloseTo(cone?6.5+delta*Math.SQRT2:5.5+delta,4)
      expect(changed.id).toBe(face.id)
      expect(changed.max.z).toBeCloseTo(15,3)
      if (!cone) expect(changed.min.z).toBeCloseTo(8.5,3)
      else expect((rimR-3.3)/(changed.max.z-changed.min.z)).toBeCloseTo(1,3)
      await capture(id,label)
      fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), {clientX:40,clientY:60})
      fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
      await waitFor(()=>expect(screen.queryByTestId('pushpull-delta-entry') ?? screen.queryByTestId('pushpull-distance')).toBeTruthy(),{timeout:20000})
      fireEvent.keyDown(window,{key:'Escape'})
      // End the edit gesture before Undo so it undoes the committed feature.
      if (screen.queryByTestId('workbench-cancel-pushpull')) fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(()=>expect(hooks().dag.featureOrder()).not.toContain(id),{timeout:20000})
      expect(await volumeOf('IMP1')).toBeCloseTo(s.volume,5)
      console.log('WO-2813 CELL',label,JSON.stringify(o))
    },180000)
  }
})

describe('WO-2813 impossible offsets keep the source body', () => {
  for (const [cone, delta, reason] of [[false,-6,/not positive/],[false,20,/break through/],[true,-6,/close the cone/],[true,20,/break through/]] as const) {
    it(`${cone?'cone':'cylinder'} ${delta} refuses without mutation`, async () => {
      const s=await openStep(PART)
      const face=findFace(await facesOf('IMP1'),'target',f=>f.type===(cone?'cone':'cylinder') && Math.abs(f.centroid.x-(cone?35:15))<0.1 && Math.abs(f.centroid.y-20)<0.1 && (cone||f.min.z>8))
      const before=hooks().dag.featureOrder()
      const o=await pushPullStep(s,face,delta,null)
      expect(o.verdict,o.message).toBe('REFUSES')
      expect(o.detail.stage).toBe('preview')
      expect(o.message).toMatch(reason)
      expect(hooks().dag.featureOrder()).toEqual(before)
      expect(await volumeOf('IMP1')).toBeCloseTo(s.volume,5)
    },180000)
  }
})
