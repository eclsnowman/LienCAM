// @vitest-environment jsdom
//
// WO-2820: Form - From body works on the STL open in the Model screen; Relief on
// that mesh says why it is off. WO-2819 cell STL-FORM-boss_fillet_base: with
// boss_fillet_base.stl opened through Edit as model, From body refused "Select a
// body in the Model tree first..." although the STL was the only body (and
// selected) - the page only looked at kernel bodies. Cell STL-RELIEF: Relief was
// disabled with no reason.
//
// Every cell runs the REAL Model screen (SolidsWorkbenchPage) on the REAL
// in-process occt kernel: the STL opens the product's way (the store's Edit as
// model), Form opens from its toolbar button, From body / rotate / Finish are the
// Form panel's own controls, and the body Finish makes is the one the Model
// history replays. The kernel is read only to MEASURE.
//
// Oracles (independent of the product):
//   - the source volume is the STL's own signed-tetrahedron sum, and equals the
//     hand formula for the part (generate_parts.py: plate 60x60x10, d20 x 12
//     boss, r3 foot fillet; Pappus for the fillet ring) to the STL's chord;
//   - rotate all 90 degrees: every cage point is where an independent quarter
//     turn about the points' centre puts it, and the finished volume is the
//     source's within the Form reconstruction budget (0.2%, WO-2819);
//   - no edit: the finished body is within 0.1% of the source volume (the r3
//     ring is 129.5 mm^3; a bevel is +181), its surface within 0.25 mm of the
//     STL both ways, and every point in the foot corner within 0.2 mm of the r3
//     arc (a straight bevel's middle is 0.88 mm off it);
//   - Relief: the disabled button's tooltip is the plain reason, naming the STL.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { closestPointIndex } from '../../form/closestPoint'
import type { Vec3 } from '../../form/cage'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stlCache } = vi.hoisted(() => ({ stlCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (the same shim directEditAudit.wo2757 installs).
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
const { useFormStore } = await import('../../form/formStore')
const { resolveEditedStlMesh } = await import('../../mesh/edit')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

const PI = Math.PI
const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const OUT = resolve(process.cwd(), 'src/tests/evidence/WO-2820')
const FILE = 'boss_fillet_base.stl'
const ID = 'boss-fillet-base-stl'
const STL_BODY = `stl-body:${ID}`
/** area and centroid offset (from the corner, along either leg) of the corner an r fillet fills */
const blendArea = (r: number) => r * r * (1 - PI / 4)
const blendOffset = (r: number) => (r * (10 - 3 * PI)) / (12 - 3 * PI)
const HAND_VOLUME = 60 * 60 * 10 + PI * 10 * 10 * 12 + 2 * PI * (10 + blendOffset(3)) * blendArea(3)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  resetDocumentHolder()
  useFormStore.getState().closeSession()
  memory.clear()
  stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => {
  act(() => { useFormStore.getState().closeSession() })
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const text = (id: string) => screen.queryByTestId(id)?.textContent ?? ''

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
function meshVolume(p: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}
const vertices = (pos: ArrayLike<number>): Vec3[] => {
  const out: Vec3[] = []
  for (let i = 0; i < pos.length; i += 3) out.push([pos[i], pos[i + 1], pos[i + 2]])
  return out
}
const worstFrom = (a: Vec3[], b: { position: ArrayLike<number>; index: ArrayLike<number> }) => {
  const idx = closestPointIndex(b)
  return a.reduce((w, p) => Math.max(w, idx.closest(p).distance), 0)
}

interface StlSession { position: Float32Array; index: Uint32Array; volume: number; min: Vec3; max: Vec3 }

/** Open the STL the product's way - the store's Edit as model - and mount the Model screen on it (real occt). */
async function openStl(): Promise<StlSession> {
  const bytes = bytesOf(resolve(PARTS, FILE))
  stlCache.set(ID, bytes)
  act(() => {
    useCamStore.setState((st) => ({ project: { ...st.project, geometry: [{
      id: ID, name: FILE, filename: FILE, type: 'mesh', format: 'stl', loaded: true,
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 60, z: 22 }, size: { x: 60, y: 60, z: 22 }, center: { x: 30, y: 30, z: 11 } },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    }] } }))
  })
  await act(async () => { expect((await useCamStore.getState().wrapImportedGeometryAsModelItem(ID)).ok).toBe(true) })
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { modelItemId: useCamStore.getState().activeModelItemId ?? undefined, createClient: createLocalGeomService, createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-${STL_BODY}`)).toBeTruthy(), { timeout: 30_000 })
  // the curved boss stays a mesh: no kernel body was made from it
  expect(hooks().dag.featureOrder().filter((id) => hooks().getBodyHandle(id) !== undefined)).toEqual([])
  const { mesh } = resolveEditedStlMesh(bytes, undefined)
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of vertices(mesh.positions)) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]) }
  return { position: mesh.positions, index: mesh.indices, volume: meshVolume(mesh.positions, mesh.indices), min, max }
}

async function fromBody(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-form'))
  await waitFor(() => expect(useFormStore.getState().active).toBe(true))
  fireEvent.click(screen.getByTestId('form-starter-body'))
  await waitFor(() => expect(useFormStore.getState().sourceBodyId !== null || /Select a body/i.test(text('form-notice'))).toBe(true), { timeout: 120_000 })
  expect(useFormStore.getState().sourceBodyId, `From body: ${text('form-notice')}`).toBe(STL_BODY)
  expect(useFormStore.getState().startedFrom).toBe('body')
}

async function finish(): Promise<{ id: string; volume: number; mesh: { position: ArrayLike<number>; index: ArrayLike<number> } }> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('form-finish'))
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(hooks().getBodyHandle(id!)).not.toBeUndefined()
  }, { timeout: 120_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf(id!)).toBe('ok'), { timeout: 120_000 })
  const h = hooks().getBodyHandle(id!) as BodyHandle
  return { id: id!, volume: (await hooks().client.measure(h, 'volume')).value, mesh: await hooks().client.tessellate(h, { deflection: 0.02, angularDeflection: 0.1 }) }
}

const cells: Record<string, { verdict: string; message: string; oracle: string; detail: Record<string, unknown> }> = {}
afterAll(() => {
  if (Object.keys(cells).length !== 3 || process.env.WO2820_WRITE_CELLS !== '1') return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(resolve(OUT, 'cells.json'), `${JSON.stringify({ wo: 'WO-2820', route: 'SolidsWorkbenchPage: Edit as model (boss_fillet_base.stl, mesh body) -> Form -> From body -> Finish, real occt kernel', cells }, null, 2)}\n`)
})

describe('WO-2820 From body takes the STL open in the Model screen (production Model screen)', () => {
  it('STL-FORM-boss_fillet_base: From body -> rotate all 90 degrees -> Finish (the WO-2819 cell)', async () => {
    const s = await openStl()
    // the STL is the part the hand formula describes, to its own chord
    expect(Math.abs(s.volume - HAND_VOLUME) / HAND_VOLUME).toBeLessThan(0.002)
    await fromBody()
    const original = useFormStore.getState().cage.positions.map((p) => [...p])
    fireEvent.click(screen.getByTestId('form-select-all'))
    fireEvent.click(screen.getByTestId('form-transform-rotate'))
    fireEvent.change(screen.getByLabelText('Centre rotation axis'), { target: { value: 'z' } })
    const angle = screen.getByLabelText('Rotation angle')
    fireEvent.change(angle, { target: { value: '90' } })
    fireEvent.blur(angle)
    fireEvent.click(screen.getByTestId('form-rotation-apply'))
    const after = useFormStore.getState().cage.positions
    const c = [0, 1, 2].map((k) => original.reduce((sum, p) => sum + p[k], 0) / original.length)
    const turnError = Math.max(...original.map((p, i) => Math.hypot(after[i][0] - (c[0] - (p[1] - c[1])), after[i][1] - (c[1] + (p[0] - c[0])), after[i][2] - p[2])))
    expect(turnError, 'every cage point against an independent quarter turn, mm').toBeLessThan(1e-7)
    const done = await finish()
    const dv = done.volume - s.volume
    const budget = 0.002 * s.volume
    cells['STL-FORM-boss_fillet_base'] = {
      verdict: Math.abs(dv) <= budget ? 'WORKS' : 'WRONG', message: Math.abs(dv) <= budget ? 'finished within 0.2% source volume' : `volume changed by ${dv.toFixed(3)}`,
      oracle: 'every cage point matches an independent 90 degree turn; finished volume equals the STL signed-tetrahedron volume within 0.2%',
      detail: { id: done.id, sourceVolume: +s.volume.toFixed(3), handVolume: +HAND_VOLUME.toFixed(3), volumeDelta: +dv.toFixed(3), volumeBudget: +budget.toFixed(1), pointQuarterTurnError: turnError, cagePoints: original.length },
    }
    console.log(`WO-2820 CELL STL-FORM-boss_fillet_base ${JSON.stringify(cells['STL-FORM-boss_fillet_base'].detail)}`)
    expect(Math.abs(dv), `finished ${done.volume} against the STL's ${s.volume}`).toBeLessThanOrEqual(budget)
  }, 600_000)

  it('STL-FORM-boss_fillet_base-foot: the STL row picked, From body -> Finish with no edit keeps the r3 foot round', async () => {
    const s = await openStl()
    fireEvent.click(screen.getByTestId(`body-row-${STL_BODY}`))
    await fromBody()
    const cagePoints = useFormStore.getState().cage.positions.length
    const done = await finish()
    // Finish leaves the From-body source hidden, as it does a modelled body
    await waitFor(() => expect((screen.getByTestId(`body-visible-${STL_BODY}`) as HTMLInputElement).checked).toBe(false))
    const dv = done.volume - s.volume
    const finished = vertices(done.mesh.position)
    const formToStl = worstFrom(finished, s)
    const stlToForm = worstFrom(vertices(s.position), done.mesh)
    // the boss axis is the part's centre in x, y; the plate top 10 above its bottom
    const ax = (s.min[0] + s.max[0]) / 2, ay = (s.min[1] + s.max[1]) / 2, top = s.min[2] + 10
    let worst = 0, points = 0
    for (const p of finished) {
      const r = Math.hypot(p[0] - ax, p[1] - ay), z = p[2] - top
      if (r < 10.05 || r > 12.95 || z < 0.05 || z > 2.95) continue
      points++
      worst = Math.max(worst, Math.abs(Math.hypot(r - 13, z - 3) - 3))
    }
    const ok = Math.abs(dv) <= 0.001 * s.volume && formToStl <= 0.25 && stlToForm <= 0.25 && points > 0 && worst <= 0.2
    cells['STL-FORM-boss_fillet_base-foot'] = {
      verdict: ok ? 'WORKS' : 'WRONG', message: ok ? 'finished body is the STL: volume, surface and the r3 foot section within budget' : 'finished body is not the STL',
      oracle: 'finished volume within 0.1% of the STL signed-tetrahedron volume; surface both ways within 0.25 mm; every finished point in the foot corner (r 10..13, 0..3 above the plate) within 0.2 mm of the r3 arc',
      detail: { id: done.id, sourceVolume: +s.volume.toFixed(3), volumeDelta: +dv.toFixed(3), volumeBudget: +(0.001 * s.volume).toFixed(1), formToStlMm: +formToStl.toFixed(4), stlToFormMm: +stlToForm.toFixed(4), sectionWorstMm: +worst.toFixed(4), sectionPoints: points, cagePoints },
    }
    console.log(`WO-2820 CELL STL-FORM-boss_fillet_base-foot ${JSON.stringify(cells['STL-FORM-boss_fillet_base-foot'].detail)}`)
    expect(Math.abs(dv), `finished ${done.volume} against the STL's ${s.volume}`).toBeLessThanOrEqual(0.001 * s.volume)
    expect(formToStl, 'finished body to the STL, mm').toBeLessThanOrEqual(0.25)
    expect(stlToForm, 'STL to the finished body, mm').toBeLessThanOrEqual(0.25)
    expect(points).toBeGreaterThan(0)
    expect(worst, 'the foot section against the r3 arc, mm').toBeLessThanOrEqual(0.2)
  }, 600_000)

  it('STL-RELIEF: Relief on the open STL alone is off and says why', async () => {
    await openStl()
    const button = screen.getByTestId('workbench-relief') as HTMLButtonElement
    const reason = `Relief - not on a mesh yet: "${FILE}" is an STL, and Relief embosses a picture into the flat face of a modelled body`
    cells['STL-RELIEF'] = {
      verdict: 'REFUSES', message: `Relief disabled: ${button.getAttribute('data-tooltip')}`,
      oracle: 'the disabled button carries the plain reason, naming the STL (wording only until a mesh Relief route exists)',
      detail: { disabled: button.disabled, tooltip: button.getAttribute('data-tooltip') },
    }
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('data-tooltip')).toBe(reason)
  }, 120_000)
})
