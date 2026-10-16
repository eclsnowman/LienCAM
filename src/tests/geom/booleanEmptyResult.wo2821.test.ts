// @vitest-environment jsdom
// WO-2821: edit through the production Model screen with the real OCCT
// client. Only the viewport runtime and STEP cache are desk substitutes.
// Kernel measurements below are read-only oracles, never edit entry points.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { OcctKernel } from 'occt-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))
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

let restoreCanvas: (() => void) | undefined
let consoleLines: string[] = []
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  vi.spyOn(useCamStore.getState(), 'addConsoleEvent').mockImplementation(event => { consoleLines.push(event.message) })
})
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  vi.restoreAllMocks()
})
function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (!h) throw new Error('Model screen hooks missing')
  return h
}
async function openModel(): Promise<void> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  render(createElement(SolidsWorkbenchPage, {
    createClient: createLocalGeomService, createSceneRuntime: () => runtime,
  }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
}
async function importStep(name: string, id: string): Promise<void> {
  const b = readFileSync(resolve(process.cwd(), 'src/tests/evidence/WO-2757', name))
  const bytes = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  fireEvent.change(screen.getByTestId('workbench-import-step-input'), {
    target: { files: [new File([bytes], name, { type: 'application/octet-stream' })] },
  })
  await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
}
async function volume(id: string): Promise<number> {
  const h = hooks().getBodyHandle(id)
  if (h === undefined) throw new Error(`No body for ${id}`)
  return (await hooks().client.measure(h, 'volume')).value
}
async function subtract(): Promise<string> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-boolean'))
  fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'IMP1' } })
  fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'IMP2' } })
  fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'cut' } })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const id = hooks().dag.featureOrder().find(id => !before.includes(id))
  if (!id) throw new Error('Boolean did not enter the Model history')
  await waitFor(() => expect(['ok', 'failed']).toContain(hooks().scheduler.statusOf(id)), { timeout: 30_000 })
  return id
}
function expectVisible(id: string): void {
  expect((screen.getByTestId(`body-visible-${id}`) as HTMLInputElement).checked).toBe(true)
}

describe('WO-2821 Model Boolean empty result', () => {
  it('keeps a nonempty imported IGES edge after subtracting a disjoint box', async () => {
    // Service-level regression for the audit finding, through the same real
    // local production engine as the Model tests below. The kernel only
    // generates IGES fixture bytes; it does not perform the tested cut.
    const fixtureKernel = await OcctKernel.init()
    const client = createLocalGeomService()
    try {
      await client.init()
      const edge = fixtureKernel.makeLineEdge({ x: 20, y: 0, z: 0 }, { x: 30, y: 0, z: 0 })
      const bytes = new TextEncoder().encode(fixtureKernel.exportIges(edge)).buffer
      const imported = await client.importIges(bytes, 'WIRE')
      expect(imported.content).toMatchObject({ solids: 0, faces: 0, edges: 1 })
      expect(imported.bodies).toHaveLength(1)
      const target = imported.bodies[0].handle
      const tool = await client.makeBox('TOOL', { x: 5, y: 5, z: 5 })
      expect(tool.ok).toBe(true)
      expect(tool.body).toBeDefined()
      const result = await client.applyBoolean({ featureId: 'CUT', op: 'cut', target, tools: [tool.body!] })
      expect(result.ok, 'a surviving edge is nonempty geometry and must not be refused').toBe(true)
      expect(result.body).toBeDefined()
      expect(result.elementMap?.featureId).toBe('CUT')
      expect((await client.measure(result.body!, 'length')).value).toBeCloseTo(10, 8)
      expect((await client.measure(target, 'length')).value).toBeCloseTo(10, 8)
      expect((await client.measure(tool.body!, 'volume')).value).toBeCloseTo(125, 8)
    } finally {
      await client.terminate()
      fixtureKernel[Symbol.dispose]()
    }
  }, 60_000)

  it('says identical-rib subtraction removes the whole target and keeps both input bodies', async () => {
    await openModel()
    await importStep('rib_part.step', 'IMP1')
    await importStep('rib_part.step', 'IMP2')
    const target = hooks().getBodyHandle('IMP1')
    const tool = hooks().getBodyHandle('IMP2')
    // Independent fixture oracle: base plus two 50 x 3 x 15 ribs.
    const expected = 60 * 40 * 5 + 2 * 50 * 3 * 15
    expect(await volume('IMP1')).toBeCloseTo(expected, 3)
    expectVisible('IMP1')
    expectVisible('IMP2')
    const id = await subtract()
    expect(hooks().scheduler.statusOf(id), 'empty subtraction must refuse before minting a body').toBe('failed')
    expect(hooks().getBodyHandle(id)).toBeUndefined()
    expect(hooks().scheduler.diagnosticsOf(id)).toMatchObject([{
      code: 'KERNEL_OP_FAILED', severity: 'error',
      params: { op: 'cut', reason: 'Subtraction removes the whole target; nothing would be left.' },
    }])
    await waitFor(() => expect(consoleLines.join('\n')).toContain('Subtraction removes the whole target; nothing would be left.'))
    expect(hooks().getBodyHandle('IMP1')).toBe(target)
    expect(hooks().getBodyHandle('IMP2')).toBe(tool)
    expect(await volume('IMP1')).toBeCloseTo(expected, 3)
    expect(await volume('IMP2')).toBeCloseTo(expected, 3)
    expectVisible('IMP1')
    expectVisible('IMP2')
    // The rejected feature is undoable; it never supplants the inputs.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(id)).toBeUndefined())
    expectVisible('IMP1')
    expectVisible('IMP2')
  }, 60_000)

  it('keeps the nonempty rib minus stepped-plate cut at its hand-oracle volume', async () => {
    await openModel()
    await importStep('rib_part.step', 'IMP1')
    await importStep('stepped_holes.step', 'IMP2')
    const id = await subtract()
    expect(hooks().scheduler.statusOf(id)).toBe('ok')
    // Plate removes the base and each rib up to z=15. Three bores leave
    // base plugs (5 mm high); the counterbore/sink are above the base and
    // miss the ribs at y=8..11 and 29..32.
    const expected = 2 * 50 * 3 * 5 + 5 * Math.PI * (2 * 3.3 ** 2 + 2.5 ** 2)
    expect(expected).toBeCloseTo(1940.294, 3)
    expect(await volume(id)).toBeCloseTo(expected, 3)
    expect(screen.queryByTestId('body-row-IMP1')).toBeNull()
    expect(screen.queryByTestId('body-row-IMP2')).toBeNull()
    expect(hooks().getBodyPresentationVisible('IMP1')).toBe(false)
    expect(hooks().getBodyPresentationVisible('IMP2')).toBe(false)
  }, 60_000)
})
