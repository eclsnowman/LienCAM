// @vitest-environment jsdom
// WO-2092: the Model screen's messages fit the tool in use.
//
// (1) The console strip (BottomConsole's latest-event line, what the operator
//     reads) shows the tool in use: after Defeature, pressing Fillet, Shell or
//     Draft replaces Defeature's "Pick faces to delete..." line.
// (2) With an STL open, Resize hole asks for the hole click and says nothing
//     about holes until the pick; the pick on the STL hole still opens the
//     diameter entry.
//
// Driven through the REAL SolidsWorkbenchPage rail buttons and viewport pick;
// the scene runtime is faked (jsdom has no WebGL).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { FeatureVerdict } from '../../geom/geom-service'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const { mintRectangleSketch } = await import('./mintRectangleSketch')
type ImportedGeometry = import('../../types').ImportedGeometry
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>
type SolidsWorkbenchHooks = import('../../components/model3d').SolidsWorkbenchHooks

beforeEach(() => {
  cache.clear()
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().clearConsoleEvents() })
})

afterEach(() => {
  cleanup()
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

/** What the operator reads: the console strip's latest line. */
const strip = (): string => screen.getByTestId('console-strip').textContent ?? ''

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

const FILLET_VERDICT: FeatureVerdict = {
  featureKey: 'blend-radius-2',
  featureClass: 'filletPlanar',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:blend'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:side'],
  params: { radius: 2 },
}

async function bodyWithDefeatureOpen(): Promise<void> {
  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage
    createClient={() => createFakeGeomClient({ recognizeFeaturesResult: [FILLET_VERDICT] })}
    createSceneRuntime={() => runtime}
  />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

  fireEvent.click(screen.getByTestId('workbench-defeature'))
  await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
  await waitFor(() => expect(strip()).toMatch(/Pick faces to delete/))
}

describe('WO-2092 (1): the console strip shows the tool in use', () => {
  for (const [tool, said] of [
    ['fillet', /^Fillet: select edges/],
    ['shell', /^Shell: select faces/],
    ['draft', /^Draft: click a neutral face/],
  ] as const) {
    it(`Defeature -> ${tool}: Defeature's text leaves the strip and ${tool}'s line replaces it`, async () => {
      await bodyWithDefeatureOpen()

      fireEvent.click(screen.getByTestId(`workbench-${tool}`))
      await waitFor(() => expect(strip()).toMatch(said))
      expect(strip()).not.toMatch(/Pick faces to delete|Defeature/)
      // Info, not a warning or an error: nothing red, nothing refused.
      const latest = useCamStore.getState().consoleEvents.at(-1)
      expect(latest?.severity).toBe('info')
    }, 60_000)
  }
})

// ---------------------------------------------------------------------------
// (2) Resize hole with an STL open.

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
const PLATE = '../evidence/WO-1846/acceptance-plate.stl'

function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

async function openPlateInModelScreen(): Promise<FakeSceneRuntime> {
  cache.set('plate', fixtureBytes(PLATE))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow('plate', 'acceptance plate')] } }))
  })
  let result: { ok: boolean } | undefined
  await act(async () => { result = await useCamStore.getState().wrapImportedGeometryAsModelItem('plate') })
  expect(result?.ok).toBe(true)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId('body-row-stl-body:plate')).toBeTruthy(), { timeout: 20_000 })
  return runtime
}

function aimIntoThroughHole(runtime: FakeSceneRuntime): void {
  const origin = [-20, -20, 50]
  const d = [-17 - origin[0], -20 - origin[1], 6 - origin[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  runtime.rayOverride = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: d[0] / len, y: d[1] / len, z: d[2] / len },
  }
}

describe('WO-2092 (2): Resize hole on an open STL asks for the hole click', () => {
  it('says nothing about holes before the pick, then the STL hole pick opens the 6 mm entry', async () => {
    const runtime = await openPlateInModelScreen()

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    const hint = screen.getByTestId('solids-workbench-resizehole-hint')
    expect(hint.textContent).toMatch(/Click a hole in the viewport to resize it/)
    expect(hint.textContent).not.toMatch(/no recognized/i)
    expect(hint.className).not.toMatch(/refusal/)
    await waitFor(() => expect(strip()).toMatch(/^Resize hole: click a hole in the viewport/))

    aimIntoThroughHole(runtime)
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy())
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    // The tool did not change at the pick (kernel arm -> STL entry): no second line.
    expect(useCamStore.getState().consoleEvents.filter((e) => /^Resize hole:/.test(e.message))).toHaveLength(1)
  }, 60_000)
})
