// @vitest-environment jsdom
//
// WO-2763: an STL with a few bad triangles opens in the Model screen instead
// of being refused (WO-2757 audit cells SPP-1 / SDF-7, fix-plan item 9).
//
// The part is OpenCascade's own mesh of the owner's dome-on-plate (40x40x10 plate +
// r12 sphere cap): 3467 triangles, one of them zero-area at the sphere pole.
// Every case goes through the product's route - the store's "Edit as model"
// (wrapImportedGeometryAsModelItem), then the real Model screen
// (SolidsWorkbenchPage) on the mesh route, its own tool buttons and Apply.
// Each case asserts the fixed result; volume formulas apply once a tool
// changes the part, which is other orders' work (see SPP-1 / SDF-7 below).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'
import { binaryStlFixture, cubeWithMissingTop, unitCube } from './fixtures'

const { stlCache } = vi.hoisted(() => ({ stlCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// the WO-2757 audit installs before importing the page).
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
const { createFakeGeomClient } = await import('../model3d/fakeGeomClient')
const { useCamStore } = await import('../../store')
const { importStl, exportBinaryStl } = await import('../../mesh/stl')

const DOME = resolve(process.cwd(), 'src/tests/evidence/WO-2763/dome_on_plate.stl')
type V3 = { x: number; y: number; z: number }
const P = (x: number, y: number, z: number): V3 => ({ x, y, z })

function domeBytes(): ArrayBuffer {
  const b = readFileSync(DOME)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** The same dome with its one zero-area triangle taken out by hand: a clean
 *  curved STL, the control for "a clean STL is unchanged". */
function cleanDomeBytes(): ArrayBuffer {
  const { mesh } = importStl(domeBytes())
  const p = mesh.positions
  const keep: number[] = []
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3]
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]
    const w = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]
    const area = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2
    if (area > 1e-9) keep.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2])
  }
  expect(mesh.indices.length / 3 - keep.length / 3).toBe(1)
  return exportBinaryStl({ positions: mesh.positions, indices: new Uint32Array(keep) }).bytes
}

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
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

const canvas = () => screen.getByTestId('solids-workbench-canvas')
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}
function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

function addStlRow(id: string, bytes: ArrayBuffer): void {
  stlCache.set(id, bytes)
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name: `${id}.stl`, filename: `${id}.stl`, type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 40, z: 22 }, size: { x: 40, y: 40, z: 22 }, center: { x: 20, y: 20, z: 11 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
}

async function editAsModel(id: string, opts?: { headless?: boolean }): Promise<{ ok: boolean; itemId?: string; reason?: string }> {
  let wrapped: { ok: boolean; itemId?: string; reason?: string } | undefined
  await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id, opts) })
  return wrapped!
}

/** "Edit as model" on the row, then mount the Model screen the way the
 *  WO-1936 suite and the WO-2757 audit run the mesh route. */
async function openOnMeshRoute(id: string, bytes: ArrayBuffer): Promise<FakeSceneRuntime> {
  addStlRow(id, bytes)
  const wrapped = await editAsModel(id)
  expect(wrapped, `Edit as model refused: ${useCamStore.getState().brepImportError ?? ''}`).toEqual({ ok: true })
  expect(useCamStore.getState().modelStlGeoId).toBe(id)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: () => createFakeGeomClient(), createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 30_000 })
  return runtime
}

const dropLine = (lines: string[]) => lines.filter((l) => /zero-area triangle/.test(l))

describe('WO-2763: the dome STL with one zero-area triangle opens as a mesh model', () => {
  it('opens on the mesh route, offers the mesh tools and says it dropped 1 bad triangle', async () => {
    await openOnMeshRoute('dome', domeBytes())
    expect(useCamStore.getState().brepImportError).toBeNull()
    expect(dropLine(consoleLines)).toEqual(['"dome.stl": dropped 1 zero-area triangle(s) and opened it in the Model screen as a mesh.'])
    // The mesh tools are offered on the body (WO-2757 SFO-1 states for one STL mesh body).
    for (const tool of ['workbench-push-pull', 'workbench-defeature', 'workbench-fillet', 'workbench-chamfer', 'workbench-resize-hole', 'workbench-form', 'workbench-boolean']) {
      expect((screen.getByTestId(tool) as HTMLButtonElement).disabled, tool).toBe(false)
    }
  }, 120_000)

  // Past the open, the dome answers each tool exactly as the same dome without
  // its bad triangle does: the triangle no longer changes anything. What the
  // tools then do on a dome is other orders' work (the Push/Pull curved-rim
  // limit; mesh Defeature has no removable group for a sphere cap), so these
  // cells assert the parity, not a volume.
  it('SPP-1: Push/Pull +3 mm on the plate top next to the dome takes the pick and answers as the clean dome does', async () => {
    const pushPull = async (bytes: ArrayBuffer) => {
      const runtime = await openOnMeshRoute('dome', bytes)
      fireEvent.click(screen.getByTestId('workbench-push-pull'))
      aimAt(runtime, P(5, 5, 30), P(5, 5, 10)); click()
      await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
      const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: '3' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(statusOf('pushpull-delta-entry-status')).toMatch(/ready|refused/), { timeout: 30_000 })
      return { status: statusOf('pushpull-delta-entry-status'), text: text('pushpull-delta-entry-status') }
    }
    const bad = await pushPull(domeBytes())
    cleanup()
    act(() => { useCamStore.getState().newProject() })
    const clean = await pushPull(cleanDomeBytes())
    console.log(`SPP-1 bad-triangle dome: ${JSON.stringify(bad)}`)
    expect(bad).toEqual(clean)
  }, 120_000)

  it('SDF-7: Defeature opens on the dome and answers as the clean dome does', async () => {
    const defeature = async (bytes: ArrayBuffer) => {
      const runtime = await openOnMeshRoute('dome', bytes)
      fireEvent.click(screen.getByTestId('workbench-defeature'))
      await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 20_000 })
      aimAt(runtime, P(24, 20, 40), P(24, 20, 12)); click()
      return {
        rows: screen.queryAllByTestId(/^defeature-row-/).map((r) => r.getAttribute('data-testid')),
        card: text('defeature-command-card'),
        state: screen.queryByTestId('defeature-preview-status')?.getAttribute('data-state') ?? null,
      }
    }
    const bad = await defeature(domeBytes())
    cleanup()
    act(() => { useCamStore.getState().newProject() })
    const clean = await defeature(cleanDomeBytes())
    console.log(`SDF-7 bad-triangle dome: ${JSON.stringify(bad)}`)
    expect(bad).toEqual(clean)
  }, 120_000)
})

describe('WO-2763: what does not change', () => {
  it('a clean curved STL (the dome without its bad triangle) opens on the mesh route with no drop line', async () => {
    await openOnMeshRoute('dome', cleanDomeBytes())
    expect(dropLine(consoleLines)).toEqual([])
  }, 120_000)

  it('a clean flat-faced STL still becomes a kernel solid (a Model item), no drop line', async () => {
    addStlRow('cube', binaryStlFixture(unitCube(10)))
    const wrapped = await editAsModel('cube')
    expect(wrapped.ok).toBe(true)
    expect(wrapped.itemId).toEqual(expect.any(String))
    expect(useCamStore.getState().modelStlGeoId).toBeNull()
    expect(dropLine(consoleLines)).toEqual([])
  })

  it('the headless import-time split has no screen to open, so it still refuses the bad mesh by name', async () => {
    addStlRow('dome', domeBytes())
    const wrapped = await editAsModel('dome', { headless: true })
    expect(wrapped).toEqual({ ok: false, reason: 'mesh-degenerate-input' })
    expect(useCamStore.getState().modelStlGeoId).toBeNull()
  })
})

describe('WO-2763: a slightly open STL opens as a mesh instead of being refused', () => {
  it('a cube missing its top opens on the mesh route and the console names the open edges', async () => {
    addStlRow('open', binaryStlFixture(cubeWithMissingTop()))
    const wrapped = await editAsModel('open')
    expect(wrapped).toEqual({ ok: true })
    expect(useCamStore.getState().modelStlGeoId).toBe('open')
    expect(useCamStore.getState().brepImportError).toBeNull()
    expect(consoleLines.filter((l) => /open edge/.test(l))).toEqual(['"open.stl" is open (4 open edge(s)): it opens in the Model screen as a mesh, not as a solid.'])
  })
})

describe('WO-2763: the mesh route leaves the zero-area triangle out and keeps file facet ids', () => {
  it('the dome resolves without its pole triangle; every other facet keeps its file index', async () => {
    const { resolveEditedStlMesh } = await import('../../mesh/edit')
    const source = importStl(domeBytes()).mesh
    const r = resolveEditedStlMesh(domeBytes(), undefined)
    expect(source.indices.length / 3).toBe(3467)
    expect(r.mesh.indices.length / 3).toBe(3466)
    expect(r.sourceFacetIds.length).toBe(3466)
    expect(Array.from(r.sourceFacetIds).includes(2499)).toBe(false)
    expect(r.sourceFacetIds[2498]).toBe(2498)
    expect(r.sourceFacetIds[2499]).toBe(2500)
  })

  it('a clean STL resolves to exactly what the importer read', async () => {
    const { resolveEditedStlMesh } = await import('../../mesh/edit')
    const bytes = cleanDomeBytes()
    const source = importStl(bytes).mesh
    const r = resolveEditedStlMesh(bytes, undefined)
    expect(r.mesh).toBe(r.source.mesh)
    expect(Array.from(r.mesh.indices)).toEqual(Array.from(source.indices))
    expect(Array.from(r.sourceFacetIds)).toEqual(Array.from({ length: source.indices.length / 3 }, (_, i) => i))
  })
})
