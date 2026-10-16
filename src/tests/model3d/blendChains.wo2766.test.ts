// @vitest-environment jsdom
//
// WO-2766: fillet and chamfer chains on imported STEP parts can be changed and
// removed. The audit cells FI-1..4, CH-1, DF-4..7 and DF-9
// (docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md) through the
// REAL Model screen (SolidsWorkbenchPage) on the REAL in-process kernel: the
// part comes in through the screen's own Import input, the blend face is
// picked by a viewport ray, and the edit goes through the tool's own button,
// dialog, preview and Apply. The kernel is read only to MEASURE a result
// (volume, and what the result's blend faces are) or to find where a face is.
//
// WORKS is judged by the audit's own hand formulas plus a face check: after a
// change the chain is still one chain of the same faces at the new size; after
// a removal no blend of that size is left.

import { readFileSync } from 'node:fs'
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

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const part = (name: string) => resolve(PARTS, name)
// parts this order adds (src/tests/evidence/WO-2766/generate_parts.mjs)
const ownPart = (name: string) => resolve(process.cwd(), 'src/tests/evidence/WO-2766', name)

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

/** Fillet/Chamfer: arm the tool, click the blend FACE, read the size the
 *  dialog opened on, type the new size, preview, Apply. */
async function changeBlend(tool: 'fillet' | 'chamfer', s: StepSession, face: FaceInfo, value: string): Promise<{ id: string; delta: number; opened: string }> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId(`workbench-${tool}`))
  aimAtFace(s.runtime, face)
  click()
  await waitFor(() => expect(text(`${tool}-edge-count`), `console: ${consoleLines.join(' | ')}`).toMatch(/[1-9]\d* edge/), { timeout: 20_000 })
  const field = tool === 'fillet' ? 'fillet-radius' : 'chamfer-distance'
  const opened = (screen.getByTestId(field).querySelector('input') as HTMLInputElement).value
  commitField(field, value)
  await waitFor(() => expect(statusOf(`${tool}-preview-status`)).toBe('ready'), { timeout: 60_000 })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  return { ...(await applied(before, s.volume)), opened }
}

/** Defeature: open the card, click the face, preview, Apply. */
async function removeFeature(s: StepSession, face: FaceInfo): Promise<{ id: string; delta: number; summary: string }> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-defeature'))
  await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 30_000 })
  aimAtFace(s.runtime, face)
  click()
  const state = () => screen.queryByTestId('defeature-preview-status')?.getAttribute('data-state') ?? null
  await waitFor(() => expect(['ready', 'failed']).toContain(state()), { timeout: 30_000 })
  expect(state(), text('defeature-preview-status')).toBe('ready')
  const summary = text('defeature-summary')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  return { ...(await applied(before, s.volume)), summary }
}

async function verdictsOf(featureId: string): Promise<FeatureVerdict[]> {
  return hooks().client.recognizeFeatures(hooks().getBodyHandle(featureId) as BodyHandle)
}
/** The result's blend chains of one kind and size. */
async function chainsOf(featureId: string, kind: 'fillet' | 'chamfer', size: number): Promise<FeatureVerdict[]> {
  const word = kind === 'fillet' ? 'radius' : 'distance'
  return (await verdictsOf(featureId)).filter((v) => v.featureKey.startsWith(`chain:${kind}:`) && Math.abs(Number(v.params[word]) - size) < 1e-3)
}

const expectVolume = (delta: number, expected: number) =>
  expect(Math.abs(delta - expected), `volume changed by ${delta.toFixed(4)}, expected ${expected.toFixed(4)}`).toBeLessThan(Math.max(Math.abs(expected) * 0.002, 0.05))

// Hand formulas (the audit's own). A constant-section blend swept round a
// path has volume = section area x the path its centroid follows (Pappus).
const PI = Math.PI
/** the (1 - PI/4) r^2 fillet section's centroid sits r(10 - 3PI)/(12 - 3PI)
 *  from the corner it fills, along each leg. */
const C = (10 - 3 * PI) / (12 - 3 * PI)
const filletSection = (r: number) => (1 - PI / 4) * r * r
/** boss_fillet_base: concave ring at the foot of a d20 boss. */
const bossFoot = (r: number) => filletSection(r) * 2 * PI * (10 + r * C)
/** fillet_chain / chamfer_chain: the top loop of a 60x40 block with r6 vertical
 *  corners - 2(48 + 28) = 152 straight, plus four quarter-turns round the r6
 *  corner axes with the section centroid inside the r6 wall. */
const topFillet = (r: number) => filletSection(r) * (152 + 2 * PI * (6 - r * C))
const topChamfer = (d: number) => d * d / 2 * (152 + 2 * PI * (6 - d / 3))
/** chamfer_unequal_chain: the same loop chamfered h across the top face and v
 *  down the walls - a right triangle h x v whose centroid sits h/3 inside the
 *  wall. */
const topChamferHV = (h: number, v: number) => h * v / 2 * (152 + 2 * PI * (6 - h / 3))
/** pocket_floor_fillet: the floor loop of a 30x20 pocket with r5 corners -
 *  2(20 + 10) = 60 straight, plus a full turn round the r5 corner axes with
 *  the section centroid inside the r5 wall (into the pocket). */
const floorFillet = (r: number) => filletSection(r) * (60 + 2 * PI * (5 - r * C))

const isTopMember = (f: FaceInfo) => f.type === 'cylinder' && f.min.z > 17 && f.normal.y < -0.5
const isTopCorner = (f: FaceInfo) => f.type === 'torus' && f.min.z > 17
const isFloorFillet = (f: FaceInfo) => f.type === 'cylinder' && f.max.z < 14.5 && f.min.z > 11.5 && Math.abs(f.normal.z) > 0.3
const isChamferMember = (f: FaceInfo) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.5
// chamfer_unequal_chain strips stand 60 deg (2 across, 3.5 down)
const isSteepChamferMember = (f: FaceInfo) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.3

describe('WO-2766 Change radius / distance on imported blend chains (Model screen, real kernel)', () => {
  it('FI-1 boss-foot fillet r3 -> r4 from the torus face: the ring grows by the hand volume and stays one r4 blend', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const blend = findFace(await facesOf('IMP1'), 'boss-foot torus', (f) => f.type === 'torus')
    const r = await changeBlend('fillet', s, blend, '4')
    expect(r.opened).toBe('3')
    expectVolume(r.delta, bossFoot(4) - bossFoot(3))
    expect(await chainsOf(r.id, 'fillet', 4)).toHaveLength(1)
    expect(await chainsOf(r.id, 'fillet', 3)).toHaveLength(0)
  }, 180_000)

  it('FI-2 one straight member of the r2 top chain -> r3: the whole loop changes, 8 faces at r3', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chain straight member', isTopMember)
    const r = await changeBlend('fillet', s, member, '3')
    expect(r.opened).toBe('2')
    expectVolume(r.delta, -(topFillet(3) - topFillet(2)))
    const chains = await chainsOf(r.id, 'fillet', 3)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
  }, 180_000)

  it('FI-3 the corner (torus) member of the chain -> r3: same result as picking a straight member', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const corner = findFace(await facesOf('IMP1'), 'chain corner', isTopCorner)
    const r = await changeBlend('fillet', s, corner, '3')
    expect(r.opened).toBe('2')
    expectVolume(r.delta, -(topFillet(3) - topFillet(2)))
    expect((await chainsOf(r.id, 'fillet', 3))[0]?.faceIds).toHaveLength(8)
  }, 180_000)

  it('FI-4 pocket floor fillet r2 -> r3: the whole floor loop changes, the pocket keeps its walls', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const blend = findFace(await facesOf('IMP1'), 'floor fillet', isFloorFillet)
    const r = await changeBlend('fillet', s, blend, '3')
    expect(r.opened).toBe('2')
    expectVolume(r.delta, floorFillet(3) - floorFillet(2))
    expect((await chainsOf(r.id, 'fillet', 3))[0]?.faceIds).toHaveLength(8)
    expect(await chainsOf(r.id, 'fillet', 2)).toHaveLength(0)
  }, 180_000)

  it('CH-1 one member of the 2 mm top chamfer chain -> 3 mm: the whole loop changes, 8 faces at 3 mm', async () => {
    const s = await openStep(part('chamfer_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chamfer member', isChamferMember)
    const r = await changeBlend('chamfer', s, member, '3')
    expect(r.opened).toBe('2')
    expectVolume(r.delta, -(topChamfer(3) - topChamfer(2)))
    expect((await chainsOf(r.id, 'chamfer', 3))[0]?.faceIds).toHaveLength(8)
  }, 180_000)

  /** Fillet r7 on the r2 top chain (wider than its r6 corners): the preview
   *  says why and nothing is applied. */
  async function expectR7Refused(s: StepSession): Promise<void> {
    const member = findFace(await facesOf('IMP1'), 'chain straight member', isTopMember)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    aimAtFace(s.runtime, member)
    click()
    await waitFor(() => expect(text('fillet-edge-count')).toMatch(/[1-9]\d* edge/), { timeout: 20_000 })
    commitField('fillet-radius', '7')
    await waitFor(() => expect(['refused', 'ready']).toContain(statusOf('fillet-preview-status')), { timeout: 60_000 })
    expect(statusOf('fillet-preview-status'), 'an r7 round that folds the r6 corners must not preview as a result').toBe('refused')
    expect(text('fillet-preview-status')).toMatch(/at radius 7 the 8-face fillet does not come back as one fillet of that radius - it would run past the faces round it \(current radius 2\); nothing was changed/)
    expect(hooks().dag.featureOrder()).toEqual(before)
    expect(await volumeOf('IMP1')).toBeCloseTo(s.volume, 6)
  }

  it('refusal: r7 on the r2 top chain (wider than its r6 corners) says why in the preview and applies nothing', async () => {
    await expectR7Refused(await openStep(part('fillet_chain.step')))
  }, 180_000)

  it('unequal legs: the 2 x 3.5 mm top chamfer chain -> an equal 3 mm chamfer, 8 faces at 3 mm, no unequal chamfer left', async () => {
    const s = await openStep(ownPart('chamfer_unequal_chain.step'))
    // the part as built: a removable chamfer chain with legs 2 and 3.5
    const unequal = (await verdictsOf('IMP1')).filter((v) => v.featureKey.startsWith('chain:chamfer:') && v.removable)
    expect(unequal).toHaveLength(1)
    expect([Number(unequal[0].params.distanceA), Number(unequal[0].params.distanceB)].sort()).toEqual([2, 3.5])
    const member = findFace(await facesOf('IMP1'), 'chamfer member', isSteepChamferMember)
    const r = await changeBlend('chamfer', s, member, '3')
    // the dialog opens on the smaller leg
    expect(r.opened).toBe('2')
    expectVolume(r.delta, topChamferHV(2, 3.5) - topChamfer(3))
    expect((await chainsOf(r.id, 'chamfer', 3))[0]?.faceIds).toHaveLength(8)
    expect((await verdictsOf(r.id)).filter((v) => v.featureKey.startsWith('chain:chamfer:') && v.params.distanceA !== undefined)).toHaveLength(0)
  }, 180_000)

  it('two chains on one body: the r2 block-top chain -> r3 changes only that chain; the r7 base chain is untouched', async () => {
    const s = await openStep(ownPart('two_fillet_chains.step'))
    expect(await chainsOf('IMP1', 'fillet', 2)).toHaveLength(1)
    expect(await chainsOf('IMP1', 'fillet', 7)).toHaveLength(1)
    const member = findFace(await facesOf('IMP1'), 'block-top chain member', isTopMember)
    const r = await changeBlend('fillet', s, member, '3')
    expect(r.opened).toBe('2')
    expectVolume(r.delta, -(topFillet(3) - topFillet(2)))
    expect((await chainsOf(r.id, 'fillet', 3))[0]?.faceIds).toHaveLength(8)
    expect(await chainsOf(r.id, 'fillet', 2)).toHaveLength(0)
    const base = await chainsOf(r.id, 'fillet', 7)
    expect(base).toHaveLength(1)
    expect(base[0].faceIds).toHaveLength(8)
  }, 180_000)

  it('two chains on one body: r7 on the block-top chain refuses even though the base chain is already an 8-face r7 fillet', async () => {
    await expectR7Refused(await openStep(ownPart('two_fillet_chains.step')))
  }, 180_000)
})

describe('WO-2766 Remove imported blend chains with Defeature (Model screen, real kernel)', () => {
  it('DF-4 remove the boss-foot fillet: the boss meets the plate at a sharp edge', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const blend = findFace(await facesOf('IMP1'), 'boss-foot torus', (f) => f.type === 'torus')
    const r = await removeFeature(s, blend)
    expect(r.summary).toMatch(/1 of \d+ selected - 1 fillet/)
    expectVolume(r.delta, -bossFoot(3))
    expect((await facesOf(r.id)).filter((f) => f.type === 'torus')).toHaveLength(0)
  }, 180_000)

  it('DF-5 remove the r2 top fillet chain: the block gets its sharp top edge back', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chain straight member', isTopMember)
    const r = await removeFeature(s, member)
    expectVolume(r.delta, topFillet(2))
    const left = await facesOf(r.id)
    expect(left.filter((f) => f.type === 'torus')).toHaveLength(0)
    // above the old fillet's foot only the four r6 vertical corner rounds are
    // curved, and they now run straight up to the top
    const curvedUpTop = left.filter((f) => f.max.z > 18.01 && f.type !== 'plane')
    expect(curvedUpTop).toHaveLength(4)
    for (const f of curvedUpTop) {
      expect(f.type).toBe('cylinder')
      expect(Math.abs(f.normal.z)).toBeLessThan(1e-3)
      expect(f.max.z).toBeCloseTo(20, 3)
    }
  }, 180_000)

  it('DF-6 remove the 2 mm top chamfer chain: the block gets its sharp top edge back', async () => {
    const s = await openStep(part('chamfer_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chamfer member', isChamferMember)
    const r = await removeFeature(s, member)
    expectVolume(r.delta, topChamfer(2))
    const left = await facesOf(r.id)
    expect(left.filter((f) => f.type === 'cone')).toHaveLength(0)
    expect(left.filter(isChamferMember)).toHaveLength(0)
  }, 180_000)

  it('DF-7 remove the boss: its foot fillet goes with it and the plate top is whole', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const wall = findFace(await facesOf('IMP1'), 'boss wall', (f) => f.type === 'cylinder')
    const r = await removeFeature(s, wall)
    expect(r.summary).toMatch(/1 boss/)
    // the d20 x 12 boss and its r3 foot ring
    expectVolume(r.delta, -(PI * 10 ** 2 * 12 + bossFoot(3)))
    const left = await facesOf(r.id)
    expect(left.every((f) => f.type === 'plane')).toBe(true)
    expect(left).toHaveLength(6)
  }, 180_000)

  it('DF-9 remove the pocket floor fillets: the pocket keeps its walls and floor, the floor corner is sharp', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const blend = findFace(await facesOf('IMP1'), 'floor fillet', isFloorFillet)
    const r = await removeFeature(s, blend)
    expect(r.summary).toMatch(/1 fillet/)
    expectVolume(r.delta, -floorFillet(2))
    const left = await facesOf(r.id)
    expect(left.filter((f) => f.type === 'torus')).toHaveLength(0)
    expect(left.filter(isFloorFillet)).toHaveLength(0)
    // the floor and the four r5 pocket corners are still there
    expect(left.filter((f) => f.type === 'plane' && f.normal.z > 0.99 && Math.abs(f.centroid.z - 12) < 1e-3)).toHaveLength(1)
    expect(left.filter((f) => f.type === 'cylinder' && f.min.z < 12.01)).toHaveLength(4)
  }, 180_000)
})
