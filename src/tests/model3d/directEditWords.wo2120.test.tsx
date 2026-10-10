// @vitest-environment jsdom
// WO-2120: the direct-edit tools say what happened in plain words, and never
// nothing (Operator ruling 2026-09-27: "showing or highlighting where things fail is
// always useful for a user"). Found by the headed re-check of 2026-09-28
// (.planning/direct-edit-imports-2026-09-28/COMPARE.md, items 4-7):
//
//   (1) Fillet clicked on a Platte C hole chamfer (S7) said nothing at all;
//   (2) the STEP Shell card read "Face IMP1:step:face#0 on Part 1";
//   (3) Defeature said "Applying deletion of 1 coherent face group(s) from ...",
//       and that line was still Setup's latest line after Finish;
//   (4) an applied STL edit printed no "applied" line - only the reopen line.
//
// Driven through the REAL SolidsWorkbenchPage: its rail buttons, its viewport
// pick, its dialogs, its Finish button; what is read is the console strip
// (BottomConsole's latest line, what the operator sees) and the command card.
// The scene runtime is faked (jsdom has no WebGL). The STEP cases run the real
// geometry kernel; the STL cases run the real recogniser and edit journal.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'

const stlBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { stlBytes.set(id, buf) },
  loadCachedSTL: async (id: string) => stlBytes.get(id) ?? null,
  removeCachedSTL: async (id: string) => { stlBytes.delete(id) },
}))
const { stepBytes } = vi.hoisted(() => ({ stepBytes: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepBytes.set(id, bytes) },
  loadCachedStep: async (id) => stepBytes.get(id) ?? null,
  removeCachedStep: async (id) => { stepBytes.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
type ImportedGeometry = import('../../types').ImportedGeometry
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>
type SolidsWorkbenchHooks = import('../../components/model3d').SolidsWorkbenchHooks

beforeEach(() => {
  stlBytes.clear()
  stepBytes.clear()
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().clearConsoleEvents() })
})

afterEach(() => {
  cleanup()
})

const state = () => useCamStore.getState()
const canvas = () => screen.getByTestId('solids-workbench-canvas')
/** What the operator reads: the console strip's latest line. */
const strip = (): string => screen.getByTestId('console-strip').textContent ?? ''
const latest = () => state().consoleEvents.at(-1)

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

type V3 = { x: number; y: number; z: number }
/** Aim the fake runtime's ray at `point`, arriving against `normal`. */
function aimAt(runtime: FakeSceneRuntime, point: V3, normal: V3, back = 0.2): void {
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * back, y: point.y + normal.y * back, z: point.z + normal.z * back },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

// ---------------------------------------------------------------- STL parts

const PLATTE = '../mesh/fixtures/obj_1_Platte C.stl'
const PLATE = '../evidence/WO-1846/acceptance-plate.stl'

function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

/** Setup's "Edit as model" on an STL row, then the REAL Model screen. */
async function stlInModelScreen(id: string, name: string, path: string): Promise<FakeSceneRuntime> {
  stlBytes.set(id, fixtureBytes(path))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow(id, name)] } }))
  })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem(id) })
  expect(result?.ok).toBe(true)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 20_000 })
  await waitFor(() => expect(strip()).toMatch(/is open as a mesh/), { timeout: 20_000 })
  return runtime
}

/** STL scene roots the page has added so far (one per draw of the part). */
const stlDraws = (runtime: FakeSceneRuntime): number =>
  runtime.addedObjects.filter((o) => (o as THREE.Object3D).userData.stlModelBodyGeoId !== undefined).length

/** A facet of Platte C's hole chamfer: the slanted ring round a hole's mouth. */
function platteChamferFacet(): { point: V3; normal: V3; label: string } {
  const model = buildStlModelBodyModel({ geoId: 'platte', name: 'obj_1_Platte C', bytes: fixtureBytes(PLATTE), meshEdits: undefined })
  const p = model.positions
  for (let f = 0; f < model.facetCount; f++) {
    const feature = model.features[model.featureOfFacet[f]]
    if (feature === undefined) continue
    const t = feature.target
    const chamfer = (t.family === 'round' && t.feature.kind === 'chamfered-hole') || (t.family === 'blend' && t.blend.kind === 'chamfer')
    if (!chamfer) continue
    const a = new THREE.Vector3(p[f * 9], p[f * 9 + 1], p[f * 9 + 2])
    const b = new THREE.Vector3(p[f * 9 + 3], p[f * 9 + 4], p[f * 9 + 5])
    const c = new THREE.Vector3(p[f * 9 + 6], p[f * 9 + 7], p[f * 9 + 8])
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize()
    if (Math.abs(n.z) < 0.3 || Math.abs(n.z) > 0.95) continue // the slant, not the bore or the top
    const m = a.add(b).add(c).divideScalar(3)
    return { point: { x: m.x, y: m.y, z: m.z }, normal: { x: n.x, y: n.y, z: n.z }, label: feature.label }
  }
  throw new Error('Platte C has no hole-chamfer facet')
}

describe('WO-2120 (1): Fillet clicked on a Platte C hole chamfer says why', () => {
  it('the strip says the part has no rounded edge to change, what edits what was clicked, and what was clicked', async () => {
    const runtime = await stlInModelScreen('platte', 'obj_1_Platte C', PLATTE)
    const target = platteChamferFacet()

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(strip()).toMatch(/^Fillet: select edges/))
    aimAt(runtime, target.point, target.normal)
    fireEvent.click(canvas())

    await waitFor(() => expect(strip()).toMatch(/^Not changed: /))
    // The answer leads (the strip is one line): no rounded edge to change,
    // then the tool that edits what was clicked, then what was clicked.
    const said = strip()
    expect(said.startsWith('Not changed: "obj_1_Platte C" has no rounded edge for Fillet to change. ')).toBe(true)
    expect(said).toMatch(/ Defeature (changes|removes) that \w+: /)
    expect(said.endsWith(`: the ${target.label}.`)).toBe(true)
    // Said, not shouted: nothing red, nothing refused.
    expect(latest()?.severity).toBe('info')
    // Nothing was picked or changed.
    expect(screen.getByTestId('fillet-edge-count').textContent).toBe('0 edges selected')
    expect(state().project.geometry.find((g) => g.id === 'platte')?.meshEdits).toBeUndefined()
  }, 60_000)
})

describe('WO-2120 (4): an applied STL edit says what it did', () => {
  it('Resize hole on the STL prints an applied line, and the redraw after it does not bury it', async () => {
    const runtime = await stlInModelScreen('plate', 'acceptance plate', PLATE)
    const drawsBefore = stlDraws(runtime)

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    runtime.rayOverride = { origin: { x: -20, y: -20, z: 50 }, direction: new THREE.Vector3(3, 0, -44).normalize() }
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy())
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(state().project.geometry[0].meshEdits).toHaveLength(1), { timeout: 20_000 })
    // The part is drawn again from its edited journal ...
    await waitFor(() => expect(stlDraws(runtime)).toBeGreaterThan(drawsBefore), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getStlBody?.()?.previewFacetCount).toBe(0), { timeout: 20_000 })

    // ... and the strip still says what the edit did, like the STEP route.
    expect(strip()).toBe('Resize hole to 8 mm applied on "acceptance plate": 6 mm -> 8 mm.')
    expect(latest()?.severity).toBe('success')
    expect(state().consoleEvents.filter((e) => /is open as a mesh/.test(e.message))).toHaveLength(1)
  }, 60_000)

  it('Defeature on the STL says what it removed; after Finish that line is no longer the latest', async () => {
    const runtime = await stlInModelScreen('plate', 'acceptance plate', PLATE)

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    runtime.rayOverride = { origin: { x: -20, y: -20, z: 50 }, direction: new THREE.Vector3(3, 0, -44).normalize() }
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(state().project.geometry[0].meshEdits).toHaveLength(1), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getStlBody?.()?.featureCount).toBe(9), { timeout: 20_000 })

    expect(strip()).toBe('Removed the through hole (diameter 6 mm) from "acceptance plate".')
    expect(strip()).not.toMatch(/coherent|face group|Applying/)

    await act(async () => { fireEvent.click(screen.getByTestId('model-item-finish-btn')) })
    await waitFor(() => expect(state().workspace).toBe('cam'))
    expect(strip()).not.toMatch(/Removed/)
    expect(strip()).toMatch(/^Finished ".+" - back to Setup\.$/)
  }, 60_000)
})

// ---------------------------------------------------------------- STEP part

async function stepInModelScreen(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const bytes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
  fireEvent.change(input, { target: { files: [new File([bytes], 'fix_plate_holes.step', { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })
  return runtime
}

/** The highest upward-facing triangle of the imported body: its top face. */
async function topFacePoint(): Promise<V3> {
  const mesh = await hooks().client.tessellate(hooks().getBodyHandle('IMP1')!, { deflection: 0.1 })
  let best: V3 | null = null
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const ids = [mesh.index[t * 3], mesh.index[t * 3 + 1], mesh.index[t * 3 + 2]]
    if (ids.some((i) => mesh.normal[i * 3 + 2] < 0.999)) continue
    const point = {
      x: ids.reduce((s, i) => s + mesh.position[i * 3], 0) / 3,
      y: ids.reduce((s, i) => s + mesh.position[i * 3 + 1], 0) / 3,
      z: ids.reduce((s, i) => s + mesh.position[i * 3 + 2], 0) / 3,
    }
    if (best === null || point.z > best.z + 1e-6) best = point
  }
  if (best === null) throw new Error('no upward face on the imported plate')
  return best
}

describe('WO-2120 (2): the STEP Shell card names the face in words', () => {
  it('hovering and picking the imported plate\'s top face reads "Top face on fix_plate_holes", never its internal id', async () => {
    const runtime = await stepInModelScreen()
    const top = await topFacePoint()

    fireEvent.click(screen.getByTestId('workbench-shell'))
    await waitFor(() => expect(screen.getByTestId('shell-workspace-palette')).toBeTruthy())
    aimAt(runtime, top, { x: 0, y: 0, z: 1 }, 50)
    fireEvent.pointerMove(canvas())
    const card = () => within(screen.getByTestId('shell-workspace-palette'))
    await waitFor(() => expect(card().getByTestId('solids-workbench-hover-readout').textContent).toBe('Top face on fix_plate_holes'))

    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toBe('1 face to open'))
    const text = screen.getByTestId('shell-workspace-palette').textContent ?? ''
    expect(text).toContain('Top face on fix_plate_holes')
    expect(text).not.toMatch(/IMP\d|step:face|face#/)
  }, 90_000)
})

describe('WO-2120 (3): Defeature says what it removed in plain words', () => {
  it('removing a through hole of the imported plate says "Removed the through hole (diameter 10 mm) from fix_plate_holes."', async () => {
    await stepInModelScreen()
    const verdicts = await hooks().client.recognizeFeatures(hooks().getBodyHandle('IMP1')!)
    const hole = verdicts.find((v) => v.removable && v.featureClass === 'throughHole' && v.params.diameter === 10)
    expect(hole).toBeDefined()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId(`defeature-check-${hole!.featureKey}`)).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId(`defeature-check-${hole!.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(strip()).toMatch(/^Removed /), { timeout: 30_000 })

    expect(strip()).toBe('Removed the through hole (diameter 10 mm) from fix_plate_holes.')
    expect(strip()).not.toMatch(/coherent|face group|Applying/)
  }, 90_000)
})
