// @vitest-environment jsdom
//
// WO-2767: Push/Pull on a face bounded by fillets, cones or drafts moves the
// face and carries the blends with it. The audit cells PP-2, PP-4, PP-8, PP-11
// and PP-12 (docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md),
// which refused cleanly since WO-2760, through the REAL Model screen
// (SolidsWorkbenchPage) on the REAL in-process kernel: the part comes in
// through the screen's own Import input, the face is picked by a viewport ray,
// and the move goes through the Push/Pull button, typed entry, preview (Enter)
// and Apply (Enter). The kernel is read only to MEASURE a result (volume, its
// faces, its blend chains) or to find where a face is.
//
// WORKS is judged by the audit's own hand formulas plus a face check: no
// groove, moat, plateau or lip, and the blends come back at their original
// radii. PP-1 (the dome), PP-3 and PP-9 are re-run to show the moves that
// already worked are unchanged.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle, FeatureVerdict, StableId } from '../../geom/geom-service'
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

const part = (name: string) => resolve(process.cwd(), 'src/tests/evidence/WO-2757', name)
const fixture = (name: string) => resolve(process.cwd(), 'test_fixtures/brep', name)

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

const newFeatureId = (before: string[]) => hooks().dag.featureOrder().find((id) => !before.includes(id))

/** Push/Pull through the Model screen: the button, a pick on the face, the
 *  typed distance, Enter to preview, Enter to apply. A refusal anywhere comes
 *  back as its hint text so the assertion shows the operator's line. */
async function pushPull(s: StepSession, face: FaceInfo, delta: number): Promise<{ id: string; delta: number }> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAtFace(s.runtime, face)
  click()
  const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
  const refused = () => hint()?.className.includes('refusal') === true
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') !== null || refused()).toBe(true), { timeout: 30_000 })
  expect(refused(), `pick refused: ${hint()?.textContent}`).toBe(false)
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    const g = hooks().getPushPullTransactionState().gesture
    expect(!g.inFlight && (g.previewHandle !== null || refused())).toBe(true)
  }, { timeout: 60_000 })
  expect(refused(), `preview refused: ${hint()?.textContent}`).toBe(false)
  fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') === null || refused()).toBe(true), { timeout: 60_000 })
  expect(refused(), `apply refused: ${hint()?.textContent}`).toBe(false)
  let id: string | undefined
  await waitFor(() => {
    id = newFeatureId(before)
    expect(id).toBeDefined()
    expect(hooks().scheduler.statusOf(id!), JSON.stringify(id === undefined ? null : hooks().scheduler.diagnosticsOf(id))).toBe('ok')
  }, { timeout: 60_000 })
  expect(hooks().dag.getNode(id!)?.payload.opType).toBe('pushPull')
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  return { id: id!, delta: (await volumeOf(id!)) - s.volume }
}

/** The result's blend chains of one kind and size. */
async function chainsOf(featureId: string, kind: 'fillet' | 'chamfer', size: number): Promise<FeatureVerdict[]> {
  const word = kind === 'fillet' ? 'radius' : 'distance'
  const all = await hooks().client.recognizeFeatures(hooks().getBodyHandle(featureId) as BodyHandle)
  return all.filter((v) => v.featureKey.startsWith(`chain:${kind}:`) && Math.abs(Number(v.params[word]) - size) < 1e-3)
}

const expectVolume = (delta: number, expected: number) =>
  expect(Math.abs(delta - expected), `volume changed by ${delta.toFixed(4)}, expected ${expected.toFixed(4)}`).toBeLessThan(Math.max(Math.abs(expected) * 0.002, 0.05))

// WO2767_CAPTURE=1 writes a section picture per fixed cell into
// src/tests/evidence/WO-2767/: the part cut by a vertical plane, the imported
// shape in grey and the moved result in red (same drawing as the WO-2757
// audit's WRONG pictures), from the tessellation the Model screen draws.
// Never written by an ordinary run.
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
async function capture(cell: string, title: string, resultId: string, axis: 'x' | 'y', at: number): Promise<void> {
  if (process.env.WO2767_CAPTURE !== '1') return
  const cut = async (id: string) => {
    const m = await hooks().client.tessellate(hooks().getBodyHandle(id) as BodyHandle, { deflection: 0.02 })
    return sectionOf(m.position, m.index, axis, at)
  }
  const before = await cut('IMP1')
  const after = await cut(resultId)
  const all = [...before, ...after]
  const us = all.flatMap((g) => [g[0], g[2]])
  const zs = all.flatMap((g) => [g[1], g[3]])
  const [u0, u1, z0, z1] = [Math.min(...us) - 2, Math.max(...us) + 2, Math.min(...zs) - 2, Math.max(...zs) + 2]
  const sc = 760 / Math.max(u1 - u0, (z1 - z0) * 1.6)
  const W = Math.ceil((u1 - u0) * sc) + 40
  const H = Math.ceil((z1 - z0) * sc) + 90
  const X = (v: number) => (20 + (v - u0) * sc).toFixed(2)
  const Z = (v: number) => (70 + (z1 - v) * sc).toFixed(2)
  const lines = (segs: Seg[], color: string, width: number) => segs.map((g) =>
    `<line x1="${X(g[0])}" y1="${Z(g[1])}" x2="${X(g[2])}" y2="${Z(g[3])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`).join('\n')
  const dir = resolve(process.cwd(), 'src/tests/evidence/WO-2767')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${cell}-section.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="20" y="24" font-family="sans-serif" font-size="16" font-weight="bold">${cell}: ${title}</text>
<text x="20" y="46" font-family="sans-serif" font-size="13">Section at ${axis} = ${at} mm (horizontal: ${axis === 'y' ? 'x' : 'y'}, vertical: z). Grey = imported part, red = result after the edit.</text>
${lines(before, '#9a9a9a', 4)}
${lines(after, '#d0302f', 1.6)}
</svg>
`)
}

const PI = Math.PI
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol
const upPlanes = (faces: FaceInfo[]) => faces.filter((f) => f.type === 'plane' && f.normal.z > 0.99)

describe('WO-2767 Push/Pull carries fillets, cones and drafts with the face (Model screen, real kernel)', () => {
  it('PP-2 plate top +3 mm beside the r3 filleted boss: the fillet rides up with the plate top, no moat', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'plate top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const r = await pushPull(s, top, 3)
    // the plate grows 3 mm; the boss's own d20 core already fills its share
    expectVolume(r.delta, 3 * (3600 - 100 * PI))
    const faces = await facesOf(r.id)
    // the r3 foot fillet is back, one chain, sitting on the new plate top
    expect(await chainsOf(r.id, 'fillet', 3)).toHaveLength(1)
    const torus = faces.filter((f) => f.type === 'torus')
    expect(torus).toHaveLength(1)
    expect(torus[0].min.z).toBeCloseTo(13, 2)
    expect(torus[0].max.z).toBeCloseTo(16, 2)
    // no moat: nothing curved reaches below the new plate top, and the plate
    // top is one face at z 13
    expect(faces.filter((f) => f.type !== 'plane' && f.min.z < 13 - 1e-3)).toHaveLength(0)
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([13, 22])
    await capture('PP-2', 'plate top +3 mm beside the filleted boss - the r3 foot fillet rides up with it', r.id, 'y', 30)
  }, 180_000)

  it('PP-4 top +2 mm inside the r2 fillet chain: the whole chain rides up, no plateau', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20))
    const r = await pushPull(s, top, 2)
    // the part gets 2 mm taller over its whole r6-cornered 60 x 40 section
    expectVolume(r.delta, 2 * (2400 - (4 - PI) * 36))
    const chains = await chainsOf(r.id, 'fillet', 2)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
    const faces = await facesOf(r.id)
    // one top, at the new height; the chain runs from z 20 to z 22
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3)))).toEqual([22])
    await capture('PP-4', 'top +2 mm inside the r2 fillet chain - the chain rides up with the top', r.id, 'y', 20)
    const tori = faces.filter((f) => f.type === 'torus')
    expect(tori).toHaveLength(4)
    for (const t of tori) {
      expect(t.min.z).toBeCloseTo(20, 2)
      expect(t.max.z).toBeCloseTo(22, 2)
    }
  }, 180_000)

  it('PP-8 pocket floor -2 mm inside the r2 floor fillets: the fillets go down with the floor, no narrow well', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const floor = findFace(await facesOf('IMP1'), 'pocket floor', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 12))
    const r = await pushPull(s, floor, -2)
    // the whole r5-cornered 30 x 20 pocket deepens 2 mm
    expectVolume(r.delta, -2 * (600 - (4 - PI) * 25))
    const chains = await chainsOf(r.id, 'fillet', 2)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
    const faces = await facesOf(r.id)
    // the floor at z 10, the deck at z 20, nothing left at the old floor
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([10, 20])
    // every floor fillet sits between the new floor and 2 mm above it (the
    // pocket's r5 corner rounds stand straight up: normal z 0)
    await capture('PP-8', 'pocket floor -2 mm - the r2 floor fillets go down with the floor', r.id, 'y', 20)
    const blends = faces.filter((f) => f.type === 'torus' || (f.type === 'cylinder' && Math.abs(f.normal.z) > 0.3))
    expect(blends).toHaveLength(8)
    for (const b of blends) {
      expect(b.min.z).toBeCloseTo(10, 2)
      expect(b.max.z).toBeCloseTo(12, 2)
    }
  }, 180_000)

  it('PP-11 15 deg drafted pocket wall +1 mm: the wall moves, deck and floor re-trim, no lip and no notch', async () => {
    const s = await openStep(fixture('fix_feature_block.step'))
    const isWall = (f: FaceInfo) => f.type === 'plane' && Math.abs(f.normal.z) > 0.2 && Math.abs(f.normal.z) < 0.5 && f.max.x < 35
    const wall = findFace(await facesOf('IMP1'), 'drafted wall', isWall)
    const r = await pushPull(s, wall, 1)
    // the slab between the old and new wall planes, floor z 8 to deck z 20,
    // y 8..32: 12 mm high and 1/cos 15 deg across = wall area x 1
    const slant = 12 / Math.cos(15 * PI / 180)
    expectVolume(r.delta, slant * 24 * 1)
    const faces = await facesOf(r.id)
    // no lip: nothing stands above the deck between the wall and the cap
    expect(faces.filter((f) => f.max.z > 20.05 && f.max.z < 21 && f.min.x > 26 && f.max.x < 33)).toHaveLength(0)
    // the moved wall still runs from the floor to the deck, 1/cos 15 deg
    // nearer the open side (x 28 - 1.035 at the floor), and it is the only
    // drafted face (no notch face at the floor)
    const walls = faces.filter(isWall)
    expect(walls).toHaveLength(1)
    expect(walls[0].min.z).toBeCloseTo(8, 2)
    expect(walls[0].max.z).toBeCloseTo(20, 2)
    expect(walls[0].min.x).toBeCloseTo(28 - 1 / Math.cos(15 * PI / 180), 2)
    await capture('PP-11', 'drafted wall +1 mm - the wall moves, deck and floor re-trim, no lip, no notch', r.id, 'y', 20)
  }, 180_000)

  it('PP-12 base top +2 mm round the tapered (cone) boss: the base meets the cone, no wedge groove', async () => {
    const s = await openStep(fixture('fix_boss_taper.step'))
    const top = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const r = await pushPull(s, top, 2)
    // the block grows to z 12 and buries the cone's lowest 2 mm (r 15 -> 14)
    expectVolume(r.delta, 3600 * 2 - PI * 2 / 3 * (15 ** 2 + 15 * 14 + 14 ** 2))
    const faces = await facesOf(r.id)
    // the cone now starts at the new base top (r 14 at z 12); no other
    // curved face, so no groove wall round its foot
    const curved = faces.filter((f) => f.type !== 'plane')
    expect(curved.map((f) => f.type)).toEqual(['cone'])
    expect(curved[0].min.z).toBeCloseTo(12, 2)
    expect(curved[0].max.x - curved[0].min.x).toBeCloseTo(28, 1)
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([12, 22])
    await capture('PP-12', 'base top +2 mm round the tapered boss - the base meets the cone, no groove', r.id, 'y', 30)
  }, 180_000)
})

describe('WO-2767 the same route, other blends, and what still refuses', () => {
  it('chamfer chain: top +2 mm inside the 2 mm top chamfer loop - the chamfer rides up with the top', async () => {
    const s = await openStep(part('chamfer_chain.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20))
    const r = await pushPull(s, top, 2)
    expectVolume(r.delta, 2 * (2400 - (4 - PI) * 36))
    const chains = await chainsOf(r.id, 'chamfer', 2)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
    expect(upPlanes(await facesOf(r.id)).map((f) => Number(f.centroid.z.toFixed(3)))).toEqual([22])
  }, 180_000)

  it('base top -2 mm round the tapered boss: the cone would have to grow down, which no construction here builds - one plain line, nothing changed', async () => {
    const s = await openStep(fixture('fix_boss_taper.step'))
    const top = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    aimAtFace(s.runtime, top)
    click()
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
    await waitFor(() => expect(hint()?.className.includes('refusal')).toBe(true), { timeout: 60_000 })
    expect(hint()?.textContent).toMatch(/Push\/Pull can't move this face yet: it meets a cone \(taper or countersink\), and moving the face alone would leave a groove or step beside it\. Nothing was changed\./)
    expect(hooks().dag.featureOrder()).toEqual(before)
    expect(await volumeOf('IMP1')).toBeCloseTo(s.volume, 6)
  }, 180_000)
})

describe('WO-2767 the moves that already worked are unchanged', () => {
  it('PP-1 dome-on-plate: plate top +3 mm next to the dome', async () => {
    const s = await openStep(fixture('fix_freeform.step'))
    const top = findFace(await facesOf('IMP1'), 'plate top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const r = await pushPull(s, top, 3)
    expectVolume(r.delta, 40 * 40 * 3 - PI * 429)
  }, 180_000)

  it('PP-3 boss top +2 mm (its neighbour is the boss cylinder)', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'boss top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 22))
    const r = await pushPull(s, top, 2)
    expectVolume(r.delta, 2 * 100 * PI)
    // the foot fillet is untouched
    expect(await chainsOf(r.id, 'fillet', 3)).toHaveLength(1)
  }, 180_000)

  it('PP-9 rib side +1 mm (thicken a rib)', async () => {
    const s = await openStep(part('rib_part.step'))
    const side = findFace(await facesOf('IMP1'), 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    const r = await pushPull(s, side, 1)
    expectVolume(r.delta, 50 * 15)
  }, 180_000)
})
