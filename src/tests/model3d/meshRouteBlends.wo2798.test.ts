// @vitest-environment jsdom
//
// WO-2798: the STL (mesh) route edits flat faces that run into fillets, and
// fillets / chamfers that run round a wall - blend chains, a boss foot, a
// pocket's floor fillets. Audit fix-plan item 11
// (docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md).
//
// Every cell runs the audit's own part (src/tests/evidence/WO-2757/*.stl)
// through the Model screen's mesh route exactly as directEditAudit.wo2757
// does: the store's "Edit as model" opens the part, a viewport ray picks the
// face, and the tool's own entry and Apply make the edit. The result is read
// back from the row's journal (resolveEditedStlMesh) and judged against the
// audit's hand volumes plus a shape check - never against "it applied".
//
// directEditAudit.wo2757.test.ts is held by other lanes and is not edited; each
// cell's verdict here is written to src/tests/evidence/WO-2798/cells.json
// (WO2798_RECORD=1) and the architect flips that matrix at landing.

import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stlCache } = vi.hoisted(() => ({ stlCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (the same
// shim directEditAudit.wo2757 installs before importing the page).
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
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { useCamStore } = await import('../../store')
const edit = await import('../../mesh/edit')
const { recognizeEdgeBlends } = await import('../../mesh/recognition')

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const EVIDENCE = resolve(process.cwd(), 'src/tests/evidence/WO-2798')
const RECORD = process.env.WO2798_RECORD === '1'
// WO2798_CAPTURE=1 writes the section pictures into src/tests/evidence/WO-2798/.
const CAPTURE = process.env.WO2798_CAPTURE === '1'

type V3 = { x: number; y: number; z: number }
type Verdict = 'WORKS' | 'REFUSES' | 'WRONG' | 'CRASH'
interface Outcome { verdict: Verdict; message: string; detail: Record<string, unknown> }

const PI = Math.PI
const S45 = Math.SQRT1_2
const P = (x: number, y: number, z: number): V3 => ({ x, y, z })
// The audit's hand formulas (directEditAudit.wo2757 / blendChains.wo2766):
// an r-blend's (1 - PI/4) r^2 section sits r(10 - 3PI)/(12 - 3PI) out from
// the corner it fills; Pappus carries it round.
const BLEND_CENTROID = (10 - 3 * PI) / (12 - 3 * PI)
const blendSection = (r: number) => (1 - PI / 4) * r * r
/** boss_fillet_base: concave ring at the foot of a d20 boss. */
const bossFoot = (r: number) => blendSection(r) * 2 * PI * (10 + r * BLEND_CENTROID)
/** fillet_chain / chamfer_chain: the top loop of a 60x40 block with r6 corners. */
const topFillet = (r: number) => blendSection(r) * (152 + 2 * PI * (6 - r * BLEND_CENTROID))
const topChamfer = (d: number) => d * d / 2 * (152 + 2 * PI * (6 - d / 3))
/** pocket_floor_fillet: the floor loop of a 30x20 pocket with r5 corners. */
const floorFillet = (r: number) => blendSection(r) * (60 + 2 * PI * (5 - r * BLEND_CENTROID))

const verdicts: Record<string, Outcome> = {}
let restoreCanvas2d: (() => void) | null = null
let consoleLines: string[] = []
const realAddConsoleEvent = useCamStore.getState().addConsoleEvent

beforeEach(() => {
  memory.clear()
  stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push(event.message) }
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
})
afterAll(() => {
  if (RECORD) writeFileSync(resolve(EVIDENCE, 'cells.json'), `${JSON.stringify(verdicts, null, 2)}\n`)
})

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null
const lastConsole = () => consoleLines.slice(-2).join(' | ')
const PICK_WAIT = 8_000

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}
function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}
async function waitCount(testId: string, pattern: RegExp): Promise<boolean> {
  try {
    await waitFor(() => expect(text(testId)).toMatch(pattern), { timeout: PICK_WAIT })
    return true
  } catch { return false }
}

// ---------------------------------------------------------------- STL route

interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }

const journalOf = (id: string) => useCamStore.getState().project.geometry.find((g) => g.id === id)?.meshEdits
const resultOf = (s: StlSession) => edit.resolveEditedStlMesh(s.bytes, journalOf(s.id)).mesh

function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
  }
  return v / 6
}
const stlVolume = (s: StlSession) => { const m = resultOf(s); return meshVolume(m.positions, m.indices) }

/** Open an STL the product's way - the store's "Edit as model" - and mount the
 *  Model screen on it (mesh route; the kernel client is the test fake). */
async function openStl(name: string): Promise<StlSession> {
  const id = name.replace(/\W/g, '-')
  const bytes = bytesOf(resolve(PARTS, name))
  stlCache.set(id, bytes)
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name, filename: name, type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 70, y: 60, z: 24 }, size: { x: 70, y: 60, z: 24 }, center: { x: 35, y: 30, z: 12 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
  let wrapped: { ok: boolean; reason?: string } | undefined
  await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id) })
  expect(wrapped?.ok, `Edit as model refused ${name}: ${wrapped?.reason}`).toBe(true)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: () => createFakeGeomClient(), createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 30_000 })
  const s = { runtime, id, bytes, volume: 0 }
  s.volume = stlVolume(s)
  return s
}

async function judgeStl(s: StlSession, expectedDelta: number, tol = 0.03): Promise<Outcome> {
  try {
    await waitFor(() => expect(journalOf(s.id)?.length ?? 0).toBeGreaterThan(0), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `nothing recorded after Apply: ${lastConsole()}`, detail: { stage: 'apply' } }
  }
  const j = journalOf(s.id)!
  const delta = stlVolume(s) - s.volume
  const detail = { kind: j[j.length - 1].kind, volumeDelta: Number(delta.toFixed(3)), expectedDelta: Number(expectedDelta.toFixed(3)) }
  if (Math.abs(delta - expectedDelta) > Math.max(tol * Math.abs(expectedDelta), 0.5)) {
    return { verdict: 'WRONG', message: `volume changed by ${delta.toFixed(3)}, expected ${expectedDelta.toFixed(3)}`, detail }
  }
  return { verdict: 'WORKS', message: 'applied', detail }
}

async function stlPushPull(s: StlSession, from: V3, to: V3, delta: number, expectedDelta: number): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAt(s.runtime, from, to); click()
  try {
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: PICK_WAIT })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('solids-workbench-pushpull-hint')} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  try {
    await waitFor(() => expect(statusOf('pushpull-delta-entry-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('pushpull-delta-entry-status')} ${lastConsole()}`, detail: { stage: 'preview' } }
  }
  if (statusOf('pushpull-delta-entry-status') === 'refused') return { verdict: 'REFUSES', message: text('pushpull-delta-entry-status'), detail: { stage: 'preview' } }
  fireEvent.keyDown(input, { key: 'Enter' })
  return judgeStl(s, expectedDelta)
}

async function stlFillet(s: StlSession, from: V3, to: V3, value: string, expectedDelta: number): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  aimAt(s.runtime, from, to); click()
  if (!await waitCount('fillet-edge-count', /[1-9]\d* edge/)) {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('fillet-edge-count')} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const input = screen.getByTestId('fillet-radius').querySelector('input') as HTMLInputElement
  const measured = input.value
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  try {
    await waitFor(() => expect(statusOf('fillet-preview-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('fillet-preview-status')} ${lastConsole()}`, detail: { stage: 'preview', measured } }
  }
  if (statusOf('fillet-preview-status') !== 'ready') return { verdict: 'REFUSES', message: text('fillet-preview-status'), detail: { stage: 'preview', measured } }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeStl(s, expectedDelta)
  return { ...o, detail: { ...o.detail, measured } }
}

async function stlDefeature(s: StlSession, from: V3, to: V3, expectedDelta: number): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-defeature'))
  await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 20_000 })
  const rows = screen.queryAllByTestId(/^defeature-row-/).map((r) => r.getAttribute('data-testid')!.replace('defeature-row-', ''))
  aimAt(s.runtime, from, to); click()
  const state = () => screen.queryByTestId('defeature-preview-status')?.getAttribute('data-state') ?? null
  try {
    await waitFor(() => expect(['ready', 'failed']).toContain(state()), { timeout: PICK_WAIT })
  } catch {
    return { verdict: 'REFUSES', message: `nothing picked/previewed: ${text('defeature-preview-status')} ${lastConsole()}`, detail: { stage: 'pick', rows } }
  }
  if (state() !== 'ready') return { verdict: 'REFUSES', message: text('defeature-preview-status'), detail: { stage: 'preview', rows } }
  const picked = rows.filter((r) => (screen.queryByTestId(`defeature-check-${r}`) as HTMLInputElement | null)?.checked === true)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeStl(s, expectedDelta)
  return { ...o, detail: { ...o.detail, rows, picked } }
}

/** Every result vertex `where` selects must pass `on` - a section with no lip,
 *  moat, notch or plateau reads as every vertex of that band lying where the
 *  hand geometry says it must. Returns the worst miss, mm. */
function worstVertex(s: StlSession, where: (x: number, y: number, z: number) => boolean, off: (x: number, y: number, z: number) => number): { count: number; worst: number } {
  const m = resultOf(s)
  let count = 0
  let worst = 0
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]]
    if (!where(x, y, z)) continue
    count++
    worst = Math.max(worst, off(x, y, z))
  }
  return { count, worst }
}

/** Distance from (x, y) to the outline of the rectangle [x0,x1]x[y0,y1] with
 *  corners rounded to r (0 on the outline). */
function toRoundedRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const inCorner = (x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r)
  if (inCorner) return Math.abs(Math.hypot(x - cx, y - cy) - r)
  return Math.min(Math.abs(x - x0), Math.abs(x - x1), Math.abs(y - y0), Math.abs(y - y1))
}

/** A cell's outcome, with its shape check folded in: WORKS only when the hand
 *  volume AND the shape check hold. */
function withCheck(o: Outcome, check: string, worst: number, count: number, tol = 0.02, emptyPasses = false): Outcome {
  const detail = { ...o.detail, check, checkedVertices: count, worstMm: Number(worst.toFixed(4)) }
  if (o.verdict !== 'WORKS') return { ...o, detail }
  if ((count === 0 && !emptyPasses) || worst > tol) return { verdict: 'WRONG', message: `${check}: worst vertex ${worst.toFixed(4)} mm off (${count} checked)`, detail }
  return { ...o, detail }
}

function record(cell: string, o: Outcome): Outcome {
  console.log(`WO-2798 CELL ${cell} ${JSON.stringify(o)}`)
  verdicts[cell] = o
  return o
}

/** The blends the edited part still proves (what the listing reads back). */
function blendsAfter(s: StlSession) {
  return recognizeEdgeBlends(resultOf(s)).blends
}

// ---------------------------------------------------------------- captures
// The part cut by a vertical plane, the imported shape in grey and the edited
// result in red (the same picture directEditAudit.wo2757 draws), from the same
// resolved mesh the Model screen draws.

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

function captureStl(cell: string, title: string, s: StlSession, axis: 'x' | 'y', at: number): void {
  if (!CAPTURE) return
  const before = edit.resolveEditedStlMesh(s.bytes, undefined).mesh
  const after = resultOf(s)
  const segsBefore = sectionOf(before.positions, before.indices, axis, at)
  const segsAfter = sectionOf(after.positions, after.indices, axis, at)
  const all = [...segsBefore, ...segsAfter]
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
  writeFileSync(resolve(EVIDENCE, `${cell}-section.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="20" y="24" font-family="sans-serif" font-size="16" font-weight="bold">${cell}: ${title}</text>
<text x="20" y="46" font-family="sans-serif" font-size="13">Section at ${axis} = ${at} mm (horizontal: ${axis === 'y' ? 'x' : 'y'}, vertical: z). Grey = imported part (before), red = result after the edit.</text>
${lines(segsBefore, '#9a9a9a', 4)}
${lines(segsAfter, '#d0302f', 1.6)}
</svg>
`)
}

describe('WO-2798 STL Push/Pull: a flat face that runs tangent into fillets moves, and the fillets ride with it', () => {
  it('SPP-2 boss STL: plate top +3 mm beside the r3 foot fillet - the fillet rides up, the boss wall shortens, no moat', async () => {
    const s = await openStl('boss_fillet_base.stl')
    let o = await stlPushPull(s, P(5, 5, 30), P(5, 5, 10), 3, 3 * (3600 - 100 * PI))
    // Below the new plate top (z 13) only the outer flanks and the bottom have
    // vertices: the old plate level left no moat round the boss.
    const below = worstVertex(s, (_x, _y, z) => z > 0.01 && z < 12.99, (x, y) => toRoundedRect(x, y, 0, 0, 60, 60, 0))
    o = withCheck(o, 'nothing below the plate top but the outer flanks', below.worst, below.count, 0.02, true)
    // The foot fillet sits at z 13..16 on an r3 torus round the d20 boss.
    const torus = worstVertex(s, (x, y, z) => z > 13.001 && z < 15.999 && Math.hypot(x - 30, y - 30) < 13.5,
      (x, y, z) => Math.abs(Math.hypot(Math.hypot(x - 30, y - 30) - 13, z - 16) - 3))
    o = withCheck(o, 'the foot fillet is the r3 torus at z 13..16', torus.worst, torus.count)
    captureStl('SPP-2', 'STL plate top +3 mm beside the r3 foot fillet - the fillet rides up with the top', s, 'x', 30.3)
    record('SPP-2', o)
    expect(o.verdict, o.message).toBe('WORKS')
  }, 120_000)

  it('SPP-4 fillet chain STL: top +2 mm inside the r2 chain - the chain rides up, no plateau', async () => {
    const s = await openStl('fillet_chain.stl')
    let o = await stlPushPull(s, P(30, 20, 40), P(30, 20, 20), 2, 2 * (2400 - (4 - PI) * 36))
    // At or below the old top (z 20) every vertex is on the r6-cornered walls.
    const walls = worstVertex(s, (_x, _y, z) => z > 0.01 && z <= 20.001, (x, y) => toRoundedRect(x, y, 0, 0, 60, 40, 6))
    o = withCheck(o, 'below z 20 only the r6-cornered walls', walls.worst, walls.count)
    record('SPP-4', o)
    expect(o.verdict, o.message).toBe('WORKS')
    const chain = blendsAfter(s).filter((b) => b.kind === 'fillet')
    expect(chain.map((b) => Number((b.radiusMm ?? 0).toFixed(2)))).toEqual([2])
  }, 120_000)

  it('SPP-8 pocket STL: floor -2 mm with its r2 floor fillets - the fillets go down with the floor, no well', async () => {
    const s = await openStl('pocket_floor_fillet.stl')
    let o = await stlPushPull(s, P(30, 20, 40), P(30, 20, 12), -2, -2 * (600 - (4 - PI) * 25))
    // Inside the pocket above the fillets (z 12..20) only the pocket walls.
    const walls = worstVertex(s, (x, y, z) => z > 12.001 && z < 19.999 && x > 14 && x < 46 && y > 9 && y < 31,
      (x, y) => toRoundedRect(x, y, 15, 10, 45, 30, 5))
    o = withCheck(o, 'inside the pocket above z 12 only the r5-cornered walls', walls.worst, walls.count, 0.02, true)
    record('SPP-8', o)
    expect(o.verdict, o.message).toBe('WORKS')
  }, 120_000)

  it('SPP-6 stepped-holes STL: top +1 mm - the countersink rides up whole (as WO-2082 keeps chamfered holes), the pilot lengthens', async () => {
    // ORACLE NOTE (disputed, see the WO's worker result): the WO quotes 2552.6,
    // which is the d13 opening carried STRAIGHT up as a 1 mm cylinder above
    // the cone. The landed rule (WO-2082 / WO-2119, and WO-2767 on STEP) is
    // that a chamfer on the moved face's rim rides with it at its own size: the
    // countersink keeps d13 at the new top and its 90 degree cone, and the
    // pilot gets 1 mm longer. Hand volume: 2800 - PI (5.5^2 + 3.3^2 + 2.5^2).
    const s = await openStl('stepped_holes.stl')
    let o = await stlPushPull(s, P(65, 35, 30), P(65, 35, 15), 1, 2800 - PI * (5.5 ** 2 + 3.3 ** 2 + 2.5 ** 2))
    const cone = worstVertex(s, (x, y, z) => z > 0.01 && Math.hypot(x - 35, y - 20) < 7.5,
      (x, y, z) => Math.abs(Math.hypot(x - 35, y - 20) - (z <= 12.8 ? 3.3 : 3.3 + (z - 12.8))))
    o = withCheck(o, 'every countersink vertex on the 90 deg cone (d13 at z 16) or the d6.6 pilot below z 12.8', cone.worst, cone.count)
    captureStl('SPP-6', 'STL top +1 mm over a counterbore, a countersink and a d5 hole - each opening rides up whole', s, 'y', 20.3)
    record('SPP-6', o)
    expect(o.verdict, o.message).toBe('WORKS')
  }, 120_000)
})

describe('WO-2798 STL Fillet: change a fillet that runs round a wall (a boss foot, a chain, floor fillets)', () => {
  it('SFI-1 boss STL: the r3 foot fillet -> r4', async () => {
    const s = await openStl('boss_fillet_base.stl')
    const pt = P(30, 30 + 10 + 3 - 3 * S45, 10 + 3 - 3 * S45)
    const o = await stlFillet(s, P(pt.x, pt.y + 5, pt.z + 5), pt, '4', bossFoot(4) - bossFoot(3))
    captureStl('SFI-1', 'STL boss foot fillet r3 -> r4 (Fillet tool, mesh route)', s, 'x', 30.3)
    record('SFI-1', o)
    expect(o.verdict, o.message).toBe('WORKS')
    expect(Number(o.detail.measured)).toBeCloseTo(3, 2)
    expect(blendsAfter(s).filter((b) => b.kind === 'fillet').map((b) => Number((b.radiusMm ?? 0).toFixed(2)))).toEqual([4])
  }, 120_000)

  it('SFI-2 fillet chain STL: a straight member r2 -> r3 changes the whole tangent chain', async () => {
    const s = await openStl('fillet_chain.stl')
    const pt = P(30, 2 - 2 * S45, 18 + 2 * S45)
    const o = await stlFillet(s, P(pt.x, pt.y - 5, pt.z + 5), pt, '3', -(topFillet(3) - topFillet(2)))
    record('SFI-2', o)
    expect(o.verdict, o.message).toBe('WORKS')
    expect(blendsAfter(s).filter((b) => b.kind === 'fillet').map((b) => Number((b.radiusMm ?? 0).toFixed(2)))).toEqual([3])
  }, 120_000)

  it('SFI-3 fillet chain STL: the corner member r2 -> r3 changes the whole tangent chain', async () => {
    const s = await openStl('fillet_chain.stl')
    const pt = P(6 - 5.414 * S45, 6 - 5.414 * S45, 18 + 2 * S45)
    const o = await stlFillet(s, P(pt.x - 2.5, pt.y - 2.5, pt.z + 3.5), pt, '3', -(topFillet(3) - topFillet(2)))
    record('SFI-3', o)
    expect(o.verdict, o.message).toBe('WORKS')
  }, 120_000)

  it('SFI-4 pocket STL: the r2 floor fillet -> r3', async () => {
    const s = await openStl('pocket_floor_fillet.stl')
    const pt = P(30, 12 - 2 * S45, 14 - 2 * S45)
    const o = await stlFillet(s, P(pt.x, pt.y + 4, pt.z + 4), pt, '3', floorFillet(3) - floorFillet(2))
    record('SFI-4', o)
    expect(o.verdict, o.message).toBe('WORKS')
  }, 120_000)
})

describe('WO-2798 STL Defeature: remove a fillet or chamfer that runs round a wall', () => {
  it('SDF-3 boss STL: remove the foot fillet - the boss meets the plate at a sharp edge', async () => {
    const s = await openStl('boss_fillet_base.stl')
    const pt = P(30, 30 + 10 + 3 - 3 * S45, 10 + 3 - 3 * S45)
    const o = await stlDefeature(s, P(pt.x, pt.y + 5, pt.z + 5), pt, -bossFoot(3))
    record('SDF-3', o)
    expect(o.verdict, o.message).toBe('WORKS')
    expect(blendsAfter(s).filter((b) => b.kind === 'fillet')).toEqual([])
  }, 120_000)

  it('SDF-5 fillet chain STL: remove the chain - the top meets the walls at a sharp edge', async () => {
    const s = await openStl('fillet_chain.stl')
    const pt = P(30, 2 - 2 * S45, 18 + 2 * S45)
    const o = await stlDefeature(s, P(pt.x, pt.y - 5, pt.z + 5), pt, topFillet(2))
    record('SDF-5', o)
    expect(o.verdict, o.message).toBe('WORKS')
    // No r2 round is left; the r6 corners now run top to bottom and read as
    // the plain vertical fillets they are.
    expect(blendsAfter(s).filter((b) => b.kind === 'fillet' && Math.abs((b.radiusMm ?? 0) - 2) < 0.1)).toEqual([])
  }, 120_000)

  it('SDF-6 chamfer chain STL: remove the chamfer - the top meets the walls at a sharp edge', async () => {
    const s = await openStl('chamfer_chain.stl')
    const o = await stlDefeature(s, P(30, -4, 24), P(30, 1, 19), topChamfer(2))
    record('SDF-6', o)
    expect(o.verdict, o.message).toBe('WORKS')
    expect(blendsAfter(s).filter((b) => b.kind === 'chamfer')).toEqual([])
  }, 120_000)

  it('SDF-8 pocket STL: remove the floor fillets - the floor meets the walls at a sharp edge', async () => {
    const s = await openStl('pocket_floor_fillet.stl')
    const pt = P(30, 12 - 2 * S45, 14 - 2 * S45)
    const o = await stlDefeature(s, P(pt.x, pt.y + 4, pt.z + 4), pt, -floorFillet(2))
    record('SDF-8', o)
    expect(o.verdict, o.message).toBe('WORKS')
    expect(blendsAfter(s).filter((b) => b.kind === 'fillet' && Math.abs((b.radiusMm ?? 0) - 2) < 0.1)).toEqual([])
  }, 120_000)
})
