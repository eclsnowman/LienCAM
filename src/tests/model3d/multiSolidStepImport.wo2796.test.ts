// @vitest-environment jsdom
//
// WO-2796 (audit cell BO-1): the Model screen's Import brings in EVERY solid of
// a multi-solid STEP -- one body per solid, the same per-solid import node the
// CAM side's "Edit as model" fan-out mints (src/doc/promoteImportedStepModel.ts)
// -- instead of refusing "import each separately".
//
// The REAL Model screen (SolidsWorkbenchPage) on the REAL in-process occt kernel
// (createLocalGeomService); the file comes in through the screen's own Import
// input. Only the IndexedDB STEP byte cache is faked (no node equivalent).
//
// Fix round 1 (audit: Cancel during the solid-count probe): the Cancel cases
// mount the page on its PRODUCTION client factory (createGeomService), so the
// real abandonable wrapper and the status strip's real Cancel button run; only
// the worker transport is replaced by the same in-process kernel.
//
// ORACLE: test_fixtures/brep/fix_two_solids.step holds two disjoint boxes
// (README / importExecutorBodyIndex.intImportEdit.test.ts): A 30x20x10 = 6000,
// B 15x15x15 = 3375. Pushing B's 15x15 top face up 5 mm adds 15*15*5 = 1125.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { GeomClient } from '../../geom'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => {
    const b = stepCache.get(id)
    return b === undefined ? null : b.slice(0)
  },
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

// Keep the production factory identity, so the page wraps its client in the
// real abandonable wrapper and offers the real Cancel (WO-2705's pattern).
const transport = vi.hoisted(() => ({ create: null as null | (() => GeomClient) }))
vi.mock('../../geom', async (original) => {
  const real = await original<typeof import('../../geom')>()
  return typedMock<typeof import('../../geom')>({
    ...real,
    createGeomService: () => (transport.create ?? real.createLocalGeomService)(),
  })
})

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

const TWO_SOLIDS = resolve(process.cwd(), 'test_fixtures/brep/fix_two_solids.step')
const ONE_SOLID = resolve(process.cwd(), 'test_fixtures/brep/fix_feature_block.step')
const VOL_A = 6000
const VOL_B = 3375

let consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  transport.create = null
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

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function mountAndImport(path: string, opts: { productionClient?: boolean } = {}): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  // Anchored value entries render only while their anchor projects on screen.
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  const client = opts.productionClient === true ? {} : { createClient: createLocalGeomService }
  render(createElement(SolidsWorkbenchPage, { ...client, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
  return runtime
}

async function waitBuilt(id: string): Promise<void> {
  try {
    await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
  } catch (e) {
    const order = hooks().dag.featureOrder()
    const states = order.map((f) => `${f}:${hooks().scheduler.statusOf(f)} ${JSON.stringify(hooks().scheduler.diagnosticsOf(f))}`)
    throw new Error(`${id} not built: [${states.join('; ')}] console [${consoleLines.join(' | ')}]`, { cause: e })
  }
}

async function volumeOf(id: string): Promise<number> {
  const h = hooks().getBodyHandle(id)
  if (h === undefined) throw new Error(`no body for ${id}`)
  return (await hooks().client.measure(h, 'volume')).value
}

describe('WO-2796 BO-1: Model screen Import of a multi-solid STEP', () => {
  it('brings in one editable body per solid, with each solid\'s own volume, and says how many came in', async () => {
    const runtime = await mountAndImport(TWO_SOLIDS)
    await waitBuilt('IMP1')
    await waitBuilt('IMP2')

    const imports = hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.kind === 'import')
    expect(imports).toEqual(['IMP1', 'IMP2'])
    expect(await volumeOf('IMP1')).toBeCloseTo(VOL_A, 0)
    expect(await volumeOf('IMP2')).toBeCloseTo(VOL_B, 0)
    // Each node owns its own solid and its own cache copy (independent lifetimes,
    // same as the Edit-as-model fan-out).
    const p1 = hooks().dag.getNode('IMP1')!.payload
    const p2 = hooks().dag.getNode('IMP2')!.payload
    expect([p1.bodyIndex, p2.bodyIndex]).toEqual([0, 1])
    expect(p1.cacheKey).not.toBe(p2.cacheKey)
    expect(p2.name).toBe(`${String(p1.name)} (2)`)
    expect(consoleLines.some((l) => /2 bodies/.test(l) && l.includes('fix_two_solids.step'))).toBe(true)
    expect(consoleLines.some((l) => /import each separately/.test(l))).toBe(false)

    // Both bodies are selectable and editable: a viewport pick lands on the
    // SECOND solid's top face and Push/Pull +5 mm grows only that body.
    const top = hooks().getBodyTopPoint('IMP2')
    expect(top).toBeDefined()
    runtime.rayOverride = { origin: { x: top!.x, y: top!.y, z: top!.z + 0.5 }, direction: { x: 0, y: 0, z: -1 } }
    const before = new Set(hooks().dag.featureOrder())
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 30_000 })
    const entry = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(entry, { target: { value: '5' } })
    fireEvent.keyDown(entry, { key: 'Enter' })
    await waitFor(() => {
      const g = hooks().getPushPullTransactionState().gesture
      expect(!g.inFlight && g.previewHandle !== null).toBe(true)
    }, { timeout: 60_000 })
    fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
    let added = ''
    await waitFor(() => {
      added = hooks().dag.featureOrder().find((id) => !before.has(id)) ?? ''
      expect(added).not.toBe('')
    }, { timeout: 60_000 })
    await waitBuilt(added)
    expect(hooks().dag.getNode(added)!.consumes).toContain('IMP2')
    expect(await volumeOf(added)).toBeCloseTo(VOL_B + 15 * 15 * 5, 0)
    expect(await volumeOf('IMP1')).toBeCloseTo(VOL_A, 0)

    // Undo takes the Push/Pull back, a second undo takes the WHOLE import back.
    act(() => { hooks().history.undo() })
    act(() => { hooks().history.undo() })
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.kind === 'import')).toEqual([])
  }, 180_000)

  it('a single-solid STEP imports exactly as today: one node, no bodyIndex', async () => {
    await mountAndImport(ONE_SOLID)
    await waitBuilt('IMP1')
    const imports = hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.kind === 'import')
    expect(imports).toEqual(['IMP1'])
    const payload = hooks().dag.getNode('IMP1')!.payload
    expect(Object.keys(payload).sort()).toEqual(['cacheKey', 'fileName', 'name'])
    expect(await volumeOf('IMP1')).toBeGreaterThan(0)
    expect(consoleLines.some((l) => /fix_feature_block applied/.test(l) || / applied$/.test(l))).toBe(true)
  }, 120_000)
})

/** The first kernel client's FIRST importStep (the Import's solid-count probe)
 *  either never settles (`hold`) or rejects once (`fail`); every later call and
 *  every later client is the plain in-process kernel. */
function firstProbe(mode: 'hold' | 'fail'): { probed: () => boolean } {
  let clients = 0
  let probed = false
  transport.create = () => {
    const client = createLocalGeomService()
    if (clients++ > 0) return client
    const importStep = client.importStep
    client.importStep = (bytes, importId) => {
      if (probed) return importStep(bytes, importId)
      probed = true
      return mode === 'hold' ? new Promise(() => undefined) : Promise.reject(new Error('the kernel could not read the file'))
    }
    return client
  }
  return { probed: () => probed }
}

const importIds = (): string[] => hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.kind === 'import')

async function cancelDuringProbe(path: string): Promise<void> {
  const probe = firstProbe('hold')
  await mountAndImport(path, { productionClient: true })
  await waitFor(() => expect(probe.probed()).toBe(true), { timeout: 30_000 })
  const historyBefore = hooks().history.size()
  // The status strip offers Cancel once the probe has waited 2 s.
  await waitFor(() => expect(screen.getByTestId('workbench-kernel-cancel')).toBeTruthy(), { timeout: 10_000 })
  fireEvent.click(screen.getByTestId('workbench-kernel-cancel'))
  await waitFor(() => expect(consoleLines.some((l) => /^Cancelled /.test(l))).toBe(true), { timeout: 30_000 })
  // Let any continuation of the abandoned import run to completion.
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  expect(importIds()).toEqual([])
  expect(stepCache.size).toBe(0)
  expect(hooks().history.size()).toBe(historyBefore)
  expect(consoleLines.filter((l) => !/^Cancelled /.test(l))).toEqual([])
}

describe('WO-2796 fix round 1: Cancel during the solid-count probe', () => {
  it('Cancel while counting a multi-solid STEP brings nothing in: no node, no cached bytes, history unchanged', async () => {
    await cancelDuringProbe(TWO_SOLIDS)
  }, 120_000)

  it('Cancel while counting a single-solid STEP brings nothing in either', async () => {
    await cancelDuringProbe(ONE_SOLID)
  }, 120_000)

  it('a probe that genuinely cannot count still imports the file as one body', async () => {
    const probe = firstProbe('fail')
    await mountAndImport(ONE_SOLID, { productionClient: true })
    await waitBuilt('IMP1')
    expect(probe.probed()).toBe(true)
    expect(importIds()).toEqual(['IMP1'])
    expect(Object.keys(hooks().dag.getNode('IMP1')!.payload).sort()).toEqual(['cacheKey', 'fileName', 'name'])
    expect(stepCache.size).toBe(1)
    expect(await volumeOf('IMP1')).toBeGreaterThan(0)
  }, 120_000)
})
