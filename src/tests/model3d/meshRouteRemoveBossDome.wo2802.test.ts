// @vitest-environment jsdom
//
// WO-2802: production Model-screen picks and journal readback on the audit's STL parts.
// Explicit WO2802_RECORD / WO2802_CAPTURE opt into tracked evidence updates.

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
const { analyzeAndMeasure } = await import('../../mesh/analysis')
const { weldMesh } = await import('../../mesh/recognition/topology')

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const EVIDENCE = resolve(process.cwd(), 'src/tests/evidence/WO-2802')
const RECORD = process.env.WO2802_RECORD === '1'
// WO2802_CAPTURE=1 writes the section pictures into src/tests/evidence/WO-2802/.
const CAPTURE = process.env.WO2802_CAPTURE === '1'

type V3 = { x: number; y: number; z: number }
type Verdict = 'WORKS' | 'REFUSES' | 'WRONG' | 'CRASH'
interface Outcome { verdict: Verdict; message: string; detail: Record<string, unknown> }

const PI = Math.PI
const P = (x: number, y: number, z: number): V3 => ({ x, y, z })
// The audit's hand formulas (directEditAudit.wo2757 / blendChains.wo2766):
// an r-blend's (1 - PI/4) r^2 section sits r(10 - 3PI)/(12 - 3PI) out from
// the corner it fills; Pappus carries it round.
const BLEND_CENTROID = (10 - 3 * PI) / (12 - 3 * PI)
const blendSection = (r: number) => (1 - PI / 4) * r * r
/** boss_fillet_base: concave ring at the foot of a d20 boss. */
const bossFoot = (r: number) => blendSection(r) * 2 * PI * (10 + r * BLEND_CENTROID)
// Rounded 60 x 40 block: 152 mm of straight wall plus four r6 corners.
// Pappus: a d^2/2 chamfer section has its centroid d/3 inside the edge.
const topChamfer = (d: number) => d * d / 2 * (152 + 2 * PI * (6 - d / 3))
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

async function judgeStl(s: StlSession, expectedDelta: number, tol = 0.003, minimumEntries = 1): Promise<Outcome> {
  try {
    await waitFor(() => expect(journalOf(s.id)?.length ?? 0).toBeGreaterThanOrEqual(minimumEntries), { timeout: 30_000 })
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
  const minimumEntries = (journalOf(s.id)?.length ?? 0) + 1
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
  return judgeStl(s, expectedDelta, 0.003, minimumEntries)
}

async function stlFillet(s: StlSession, from: V3, to: V3, value: string, expectedDelta: number): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  aimAt(s.runtime, from, to); click()
  if (!/[1-9]\d* edge/.test(text('fillet-edge-count'))) {
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
  // WO-2798's existing hand-volume oracle permits tessellation error on
  // a small blend-volume difference. Main measures the same 0.713 % error.
  const o = await judgeStl(s, expectedDelta, 0.01)
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

async function stlChamfer(s: StlSession, from: V3, to: V3, value: string, expectedDelta: number): Promise<Outcome> {
  const minimumEntries = (journalOf(s.id)?.length ?? 0) + 1
  fireEvent.click(screen.getByTestId('workbench-chamfer'))
  aimAt(s.runtime, from, to); click()
  try {
    await waitFor(() => expect(text('chamfer-edge-count')).toMatch(/[1-9]\d* edge/), { timeout: PICK_WAIT })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('chamfer-edge-count')} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const input = screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement
  const measured = input.value
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  try {
    await waitFor(() => expect(statusOf('chamfer-preview-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('chamfer-preview-status')} ${lastConsole()}`, detail: { stage: 'preview', measured } }
  }
  if (statusOf('chamfer-preview-status') !== 'ready') {
    return { verdict: 'REFUSES', message: text('chamfer-preview-status'), detail: { stage: 'preview', measured } }
  }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeStl(s, expectedDelta, 0.003, minimumEntries)
  return { ...o, detail: { ...o.detail, measured } }
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

/** A cell's outcome, with its shape check folded in: WORKS only when the hand
 *  volume AND the shape check hold. */
function withCheck(o: Outcome, check: string, worst: number, count: number, tol = 0.02, emptyPasses = false): Outcome {
  const detail = { ...o.detail, checks: [...(Array.isArray(o.detail.checks) ? o.detail.checks : []), { check, worstMm: worst, count }], check, checkedVertices: count, worstMm: Number(worst.toFixed(4)) }
  if (o.verdict !== 'WORKS') return { ...o, detail }
  if ((count === 0 && !emptyPasses) || worst > tol) return { verdict: 'WRONG', message: `${check}: worst vertex ${worst.toFixed(4)} mm off (${count} checked)`, detail }
  return { ...o, detail }
}

function record(cell: string, o: Outcome): Outcome {
  console.log(`WO-2802 CELL ${cell} ${JSON.stringify(o)}`)
  verdicts[cell] = o
  return o
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


const bossRemoved = -(PI * 100 * 12 + bossFoot(3))
const domeRemoved = -PI * 14 ** 2 * (3 * 12 - 14) / 3
const plateAdded = 4800 - 429 * PI

function closed(s: StlSession) {
  const welded = weldMesh(resultOf(s))
  const measured = analyzeAndMeasure({ positions: new Float32Array(welded.positions), indices: new Uint32Array(welded.facets) }, { checkSelfIntersections: false })
  expect(measured.report.boundaryEdgeCount).toBe(0)
  expect(measured.report.watertight).toBe(true)
  expect(measured.report.windingConflictEdgeCount).toBe(0)
  expect(measured.report.nonManifoldEdgeCount).toBe(0)
  expect(measured.measures.signedVolume).toBeGreaterThan(0)
  return { openEdges: measured.report.boundaryEdgeCount, nonManifoldEdges: measured.report.nonManifoldEdgeCount,
    windingConflicts: measured.report.windingConflictEdgeCount, components: measured.measures.componentCount }
}

describe('WO-2802 Model screen mesh route', () => {
  it('SCH-1 changes the whole chamfer chain 2 to 3 from one member face', async () => {
    const s = await openStl('chamfer_chain.stl')
    let o = await stlChamfer(s, P(30, -4, 24), P(30, 1, 19), '3', -(topChamfer(3) - topChamfer(2)))
    // Each top-band vertex lies on the new 45-degree leg, including the
    // corner cones: distance inward from the rounded r6 wall + (20-z) = 3.
    const band = worstVertex(s, (_x, _y, z) => z >= 17 - 1e-4, (x, y, z) => {
      const dx = Math.max(6 - x, 0, x - 54)
      const dy = Math.max(6 - y, 0, y - 34)
      const inward = 6 - Math.hypot(dx, dy)
      // The interior of the planar top is not part of the chamfer band.
      return Math.abs(z - 20) < 1e-4 && inward >= 3 - 0.01 ? 0 : Math.abs(inward + 20 - z - 3)
    })
    o = withCheck(o, 'whole chamfer chain and corner cones have 3 mm legs without lips', band.worst, band.count)
    if (o.verdict === 'WORKS') o.detail.health = closed(s)
    expect(record('SCH-1', o).verdict, JSON.stringify(o)).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(1)
    closed(s)
    captureStl('SCH-1', 'Chamfer chain 2 mm to 3 mm', s, 'y', 20)
  }, 120_000)

  it('SCH-1 cancels an existing-chain preview then reopens and edits again after replay', async () => {
    const s = await openStl('chamfer_chain.stl')
    fireEvent.click(screen.getByTestId('workbench-chamfer'))
    aimAt(s.runtime, P(30, -4, 24), P(30, 1, 19)); click()
    expect(text('chamfer-edge-count')).toMatch(/[1-9]\d* edge/)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(journalOf(s.id)?.length ?? 0).toBe(0)
    const first = await stlChamfer(s, P(30, -4, 24), P(30, 1, 19), '3', -(topChamfer(3) - topChamfer(2)))
    expect(first.verdict, JSON.stringify(first)).toBe('WORKS')
    // Read the resized band through the same ray and production journal resolver.
    const second = await stlChamfer(s, P(30, -4, 24), P(30, 1.5, 18.5), '2', 0)
    expect(second.verdict, JSON.stringify(second)).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(2)
    closed(s)
  }, 120_000)

  it('SDF-4 removes the boss and its entire foot fillet in one step', async () => {
    const s = await openStl('boss_fillet_base.stl')
    let o = await stlDefeature(s, P(30, 60, 16), P(30, 40, 16), bossRemoved)
    const check = worstVertex(s, (_x, _y, z) => z > 9.99, (_x, _y, z) => Math.abs(z - 10))
    o = withCheck(o, 'plate top is flat with no boss or foot lip', check.worst, check.count)
    captureStl('SDF-4', 'Remove boss and foot fillet', s, 'y', 30)
    if (o.verdict === 'WORKS') o.detail.health = closed(s)
    expect(record('SDF-4', o).verdict).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(1)
    // The witness covers the dependent foot, not only the wall clicked.
    const boss = (await import('../../mesh/recognition/plateBosses')).provePlateBosses(weldMesh(edit.resolveEditedStlMesh(s.bytes, undefined).mesh))[0]
    expect(journalOf(s.id)![0].facets).toEqual(boss.facets)
    closed(s)
  }, 120_000)

  it('SDF-7 removes the spherical cap leaving a flat plate', async () => {
    const s = await openStl('dome_on_plate.stl')
    let o = await stlDefeature(s, P(20, 20, 40), P(20, 20, 24), domeRemoved)
    const check = worstVertex(s, (_x, _y, z) => z > 9.99, (_x, _y, z) => Math.abs(z - 10))
    o = withCheck(o, 'plate top is flat with no dome lip', check.worst, check.count)
    captureStl('SDF-7', 'Remove spherical cap', s, 'y', 20)
    if (o.verdict === 'WORKS') o.detail.health = closed(s)
    expect(record('SDF-7', o).verdict).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(1)
    closed(s)
  }, 120_000)

  it('SPP-1 moves the plate top +3 mm along the spherical rim without changing the dome', async () => {
    const s = await openStl('dome_on_plate.stl')
    let o = await stlPushPull(s, P(5, 5, 30), P(5, 5, 10), 3, plateAdded)
    const below = worstVertex(s, (_x, _y, z) => z > 0.01 && z < 12.99,
      (x, y) => Math.min(Math.abs(x), Math.abs(x - 40), Math.abs(y), Math.abs(y - 40)))
    o = withCheck(o, 'no rim moat below the new top', below.worst, below.count, 0.02, true)
    const sphere = worstVertex(s, (_x, _y, z) => z > 13.001,
      (x, y, z) => Math.abs(Math.hypot(x - 20, y - 20, z - 12) - 12))
    o = withCheck(o, 'dome stays on its original sphere', sphere.worst, sphere.count, 0.05)
    captureStl('SPP-1', 'Plate top +3 mm along dome rim', s, 'y', 20)
    if (o.verdict === 'WORKS') o.detail.health = closed(s)
    expect(record('SPP-1', o).verdict).toBe('WORKS')
    closed(s)
  }, 120_000)

  it('SPP-1 keeps the moved top pickable for a second preview and Apply after replay', async () => {
    const s = await openStl('dome_on_plate.stl')
    const first = await stlPushPull(s, P(5, 5, 30), P(5, 5, 10), 3, plateAdded)
    expect(first.verdict, JSON.stringify(first)).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(1)
    // Hand integral from z=10 to 14: 40*40*4 minus the sphere's
    // cross-section integral PI * integral(144 - (z-12)^2) dz.
    const expected = 6400 - PI * (576 - 16 / 3)
    let second = await stlPushPull(s, P(5, 5, 30), P(5, 5, 13), 1, expected)
    const sphere = worstVertex(s, (_x, _y, z) => z > 14.001,
      (x, y, z) => Math.abs(Math.hypot(x - 20, y - 20, z - 12) - 12))
    second = withCheck(second, 'second move keeps the original dome', sphere.worst, sphere.count, 0.05)
    expect(record('SPP-1-second', second).verdict, JSON.stringify(second)).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(2)
    closed(s)
    captureStl('SPP-1-second', 'Plate top +3 mm then +1 mm along dome rim', s, 'y', 20)
  }, 120_000)
})

describe('WO-2802 combined boss and foot requests', () => {
  it.each(['boss-first', 'foot-first'] as const)('%s removes the boss and foot once through the production planner', async (order) => {
    const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
    const { planStlFeatureEdits } = await import('../../components/model3d/workbench/stlFeatureEdits')
    const bytes = bytesOf(resolve(PARTS, 'boss_fillet_base.stl'))
    const body = buildStlModelBodyModel({ geoId: 'boss', name: 'boss', bytes, meshEdits: undefined })!
    const boss = body.features.find((f) => f.target.family === 'round')!
    const foot = body.features.find((f) => f.target.family === 'blend')!
    expect(boss).toBeDefined()
    expect(foot).toBeDefined()
    const features = order === 'boss-first' ? [boss, foot] : [foot, boss]
    const plan = planStlFeatureEdits(body, features.map((feature) => ({ tool: 'defeature' as const, feature })))
    console.log(`WO-2802 COMBINED ${order} ${JSON.stringify({ ok: plan.ok, ...(!plan.ok ? { reason: plan.reason } : {}) })}`)
    expect(plan.ok, !plan.ok ? plan.reason : '').toBe(true)
    if (!plan.ok) return
    const delta = meshVolume(plan.mesh.positions, plan.mesh.indices) - meshVolume(body.mesh.positions, body.mesh.indices)
    expect(Math.abs(delta - bossRemoved)).toBeLessThan(Math.abs(bossRemoved) * 0.003)
    const journal: import('../../mesh/edit').MeshEditRecord[] = []
    let mesh = body.mesh
    for (const { edit: planned } of plan.edits) {
      const record = edit.createMeshEditRecord(mesh, planned)
      journal.push(record)
      mesh = edit.replayMeshEdits(mesh, [record]).mesh
    }
    const replayed = edit.resolveEditedStlMesh(bytes, journal)
    expect(replayed.stopped).toBeUndefined()
    expect(Array.from(replayed.mesh.positions)).toEqual(Array.from(plan.mesh.positions))
  })
})

describe('WO-2802 same-preview removal boundaries', () => {
  async function fixture() {
    const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
    const { planStlFeatureEdits } = await import('../../components/model3d/workbench/stlFeatureEdits')
    const bytes = bytesOf(resolve(PARTS, 'boss_fillet_base.stl'))
    const body = buildStlModelBodyModel({ geoId: 'boundaries', name: 'boss', bytes, meshEdits: undefined })!
    const boss = body.features.find((f) => f.target.family === 'round')!
    const foot = body.features.find((f) => f.target.family === 'blend')!
    return { body, boss, foot, plan: planStlFeatureEdits }
  }
  it('satisfies duplicate removals once but replans independently after an interrupted preview', async () => {
    const { body, boss, foot, plan } = await fixture()
    const requests = [boss, boss, foot, foot].map((feature) => ({ tool: 'defeature' as const, feature }))
    const first = plan(body, requests)
    expect(first.ok, !first.ok ? first.reason : '').toBe(true)
    if (!first.ok) return
    expect(first.edits).toHaveLength(1)
    // Discarded previews write nothing and carry no satisfied ids into a new call.
    const again = plan(body, requests)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.edits).toHaveLength(1)
    const stale = plan({ ...body, mesh: first.mesh, sourceFacetIds: first.sourceFacetIds }, [{ tool: 'defeature', feature: foot }])
    expect(stale.ok).toBe(false)
  })
  it('refuses empty, stale and mixed stale selections even after a successful removal', async () => {
    const { body, boss, foot, plan } = await fixture()
    for (const ids of [[], [4294967295], [...foot.sourceFacetIds, 4294967294]]) {
      const invalid = { ...foot, sourceFacetIds: ids }
      const p = plan(body, [{ tool: 'defeature', feature: boss }, { tool: 'defeature', feature: invalid }])
      expect(p.ok).toBe(false)
    }
  })
  it('does not satisfy a radius change by an earlier removal', async () => {
    const { body, boss, foot, plan } = await fixture()
    const p = plan(body, [{ tool: 'defeature', feature: boss }, { tool: 'fillet', feature: foot, radiusMm: 4 }])
    expect(p.ok).toBe(false)
  })
})

// Adjacent risk identified by the Model body's round-before-blend pick order:
// a complete boss must not hide its foot from the existing blend tools.
describe('WO-2802 preserves independently editable boss-foot routes', () => {
  const footPick = P(30, 43 - 3 * Math.SQRT1_2, 13 - 3 * Math.SQRT1_2)
  it('Fillet still picks the foot alone and changes r3 to r4', async () => {
    const s = await openStl('boss_fillet_base.stl')
    const o = await stlFillet(s, P(footPick.x, footPick.y + 5, footPick.z + 5), footPick, '4', bossFoot(4) - bossFoot(3))
    expect(o.verdict, JSON.stringify(o)).toBe('WORKS')
    closed(s)
  }, 120_000)
  it('Defeature still removes the foot alone and keeps the boss', async () => {
    const s = await openStl('boss_fillet_base.stl')
    const o = await stlDefeature(s, P(footPick.x, footPick.y + 5, footPick.z + 5), footPick, -bossFoot(3))
    expect(o.verdict, JSON.stringify(o)).toBe('WORKS')
    const m = resultOf(s)
    expect(Math.max(...Array.from(m.positions).filter((_v, i) => i % 3 === 2))).toBeCloseTo(22)
    closed(s)
    // A boss without a fillet still removes through the same production door.
    const plain = await stlDefeature(s, P(30, 60, 16), P(30, 40, 16), bossRemoved)
    expect(plain.verdict, JSON.stringify(plain)).toBe('WORKS')
    expect(journalOf(s.id)).toHaveLength(2)
    closed(s)
  }, 120_000)
})

describe('WO-2802 recognition controls', () => {
  it('SCH-1 already exposes the complete chamfer band including corner cones', async () => {
    const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
    const { prepareWallBlendFromBand } = await import('../../mesh/recognition/wallBlends')
    const body = buildStlModelBodyModel({ geoId: 'chamfer', name: 'chamfer', bytes: bytesOf(resolve(PARTS, 'chamfer_chain.stl')), meshEdits: undefined })!
    const chamfers = body.features.filter((f) => f.target.family === 'blend' && f.target.blend.kind === 'chamfer')
    expect(chamfers).toHaveLength(1)
    const chain = chamfers[0]
    expect(chain.facets).toHaveLength(280)
    const prepared = prepareWallBlendFromBand(weldMesh(body.mesh), chain.facets)
    expect(prepared.kind).toBe('chamfer')
    expect(prepared.sizeMm).toBeCloseTo(2, 5)
    expect(prepared.loopLengthsMm).toHaveLength(1)
    expect(prepared.edgeLengthMm).toBeCloseTo(152 + 12 * PI, 1)
    expect(prepared.maxDeviationMm).toBeLessThan(0.01)
  })

  it('SCH-1 keeps the complete resized chain visible to recognition and rejects invalid or wrong-kind size edits', async () => {
    const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
    const { planStlFeatureEdits, stlToolAccepts } = await import('../../components/model3d/workbench/stlFeatureEdits')
    const bytes = bytesOf(resolve(PARTS, 'chamfer_chain.stl'))
    const body = buildStlModelBodyModel({ geoId: 'chain', name: 'chain', bytes, meshEdits: undefined })
    const chain = body.features.find((f) => f.target.family === 'blend' && f.target.blend.kind === 'chamfer')!
    expect(stlToolAccepts('chamfer', chain)).toBe(true)
    expect(stlToolAccepts('fillet', chain)).toBe(false)
    expect(edit.blendRadiusChangeRefusal(body.mesh, chain.facets, 3)).toMatch(/not a round/)
    const op = edit.getMeshEditOperation(edit.CHANGE_CHAMFER_SIZE_KIND)!
    for (const distanceMm of [0, -1, NaN, Infinity]) {
      expect(edit.chamferSizeChangeRefusal(body.mesh, chain.facets, distanceMm)).toMatch(/finite|greater/)
      expect(() => op.validate({ distanceMm })).toThrow()
    }
    expect(() => op.validate({ distanceMm: 3, radiusMm: 3 })).toThrow()
    expect(edit.chamferSizeChangeRefusal(body.mesh, chain.facets, 2)).toMatch(/already/)
    expect(edit.chamferSizeChangeRefusal(body.mesh, chain.facets, 50)).toMatch(/fold|past|open|plane/)
    const plan = planStlFeatureEdits(body, [{ tool: 'chamfer', feature: chain, distanceMm: 3 }])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const record = edit.createMeshEditRecord(body.mesh, plan.edits[0].edit)
    const reopened = buildStlModelBodyModel({ geoId: 'chain', name: 'chain', bytes, meshEdits: JSON.parse(JSON.stringify([record])) })
    const chains = reopened.features.filter((f) => f.target.family === 'blend' && f.target.blend.kind === 'chamfer')
    expect(chains).toHaveLength(1)
    expect(chains[0].sourceFacetIds).toEqual(chain.sourceFacetIds)
    expect(chains[0].facets).toHaveLength(280)
    expect(chains[0].target.family === 'blend' && chains[0].target.blend.setbackMm?.[0]).toBeCloseTo(3, 5)
    const footBody = buildStlModelBodyModel({ geoId: 'foot', name: 'foot', bytes: bytesOf(resolve(PARTS, 'boss_fillet_base.stl')), meshEdits: undefined })
    const foot = footBody.features.find((f) => f.target.family === 'blend')!
    expect(stlToolAccepts('chamfer', foot)).toBe(false)
    expect(edit.chamferSizeChangeRefusal(footBody.mesh, foot.facets, 4)).toMatch(/round/)
  })

  it('resizes a straight equal-leg chamfer through the registered journal without changing the radius-only contract', async () => {
    const { exportBinaryStl } = await import('../../mesh/stl')
    const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
    // Independent control, not an application drawing claim: write a real
    // closed STL prism with a 2 mm leg on its x=0/z=20 corner, then use the
    // production import -> Model recognition -> journal -> resolver path.
    const profile = [[0, 0], [60, 0], [60, 20], [2, 20], [0, 18]]
    const coords: number[] = []
    const tri = (...points: number[][]) => coords.push(...points.flat())
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i], b = profile[(i + 1) % profile.length]
      for (let y = 0; y < 40; y += 10) {
        tri([a[0], y, a[1]], [a[0], y + 10, a[1]], [b[0], y + 10, b[1]])
        tri([a[0], y, a[1]], [b[0], y + 10, b[1]], [b[0], y, b[1]])
      }
    }
    for (let i = 1; i + 1 < profile.length; i++) {
      tri([0, 0, 0], [profile[i][0], 0, profile[i][1]], [profile[i + 1][0], 0, profile[i + 1][1]])
      tri([0, 40, 0], [profile[i + 1][0], 40, profile[i + 1][1]], [profile[i][0], 40, profile[i][1]])
    }
    const positions = Float32Array.from(coords)
    const bytes = exportBinaryStl({ positions, indices: Uint32Array.from({ length: coords.length / 3 }, (_, i) => i) }).bytes
    const body = buildStlModelBodyModel({ geoId: 'straight', name: 'straight', bytes, meshEdits: undefined })
    const chamfer = body.features.find((f) => f.target.family === 'blend' && f.target.blend.kind === 'chamfer')!
    expect(chamfer).toBeDefined()
    const record = edit.createMeshEditRecord(body.mesh, { kind: edit.CHANGE_CHAMFER_SIZE_KIND, facets: chamfer.facets, parameters: { distanceMm: 3 } })
    const replayed = edit.resolveEditedStlMesh(bytes, [record])
    expect(replayed.stopped).toBeUndefined()
    const delta = meshVolume(replayed.mesh.positions, replayed.mesh.indices) - meshVolume(body.mesh.positions, body.mesh.indices)
    expect(delta).toBeCloseTo(-40 * (3 ** 2 - 2 ** 2) / 2, 3)
    expect(weldMesh(replayed.mesh).edges.every((e) => e.facets.length === 2)).toBe(true)
  })

  it('never turns spherical or filleted bosses into drill or pocket targets', async () => {
    const { meshFeatureTargets } = await import('../../mesh/recognition/toolpathTargets')
    for (const name of ['boss_fillet_base.stl', 'dome_on_plate.stl']) {
      const m = edit.resolveEditedStlMesh(bytesOf(resolve(PARTS, name)), undefined).mesh
      const targets = meshFeatureTargets(m)
      expect(targets.holes).toHaveLength(0)
      expect(targets.pockets).toHaveLength(0)
    }
  })
  it('rejects an inward cap and a cap with an off-sphere vertex', async () => {
    const { provePlateBosses } = await import('../../mesh/recognition/plateBosses')
    const m = edit.resolveEditedStlMesh(bytesOf(resolve(PARTS, 'dome_on_plate.stl')), undefined).mesh
    const boss = provePlateBosses(weldMesh(m)).find((b) => b.sphere)!
    expect(boss).toBeDefined()
    const inward = { positions: m.positions.slice(), indices: m.indices.slice() }
    for (const f of boss.facets) [inward.indices[f * 3 + 1], inward.indices[f * 3 + 2]] = [inward.indices[f * 3 + 2], inward.indices[f * 3 + 1]]
    expect(provePlateBosses(weldMesh(inward)).filter((b) => b.sphere)).toHaveLength(0)
    const damaged = { positions: m.positions.slice(), indices: m.indices.slice() }
    // STL triangle soup: move every copy of a non-rim pole vertex together.
    for (let i = 0; i < damaged.positions.length; i += 3) if (damaged.positions[i + 2] > 23.99) damaged.positions[i + 2] += 1
    expect(provePlateBosses(weldMesh(damaged)).filter((b) => b.sphere)).toHaveLength(0)
  })
})
