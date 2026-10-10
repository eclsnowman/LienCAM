// @vitest-environment jsdom
//
// WO-2174 - image relief stage 2 through the Model screen's own buttons, on
// the real kernel with the fake scene runtime: a colour lake chart opened in
// the relief palette shows Auto's adjustment values; the palette's controls
// change the adjusted picture (greyscale channel, levels, contrast, denoise,
// smooth, edge-keeping smooth) and the step-downs snap the relief to flat
// floors listed on the status line. Apply commits ONE relief feature with
// every value saved; Edit brings them back; Undo takes each step back; save ->
// reopen replays the same body.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zlibSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
  computeStepSha256: vi.fn(async () => null),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService, GeomEngine } from '../../geom'
import { useCamStore } from '../../store'
import { useReliefStore } from '../../components/model3d/relief/reliefStore'
import type { PictureAdjust } from '../../relief/adjust'
import type { ReliefSettings } from '../../relief/reliefHeights'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const PLATE = { x: 100, y: 70, z: 15 }

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function clickWorld(runtime: FakeSceneRuntime, origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): void {
  runtime.rayOverride = { origin, direction }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

function commitField(label: string, raw: string): void {
  const input = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** An RGB 8-bit PNG (filter 0 on every line). */
function pngOf(cols: number, rows: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(rows * (cols * 3 + 1))
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) raw.set(rgb(x, y), y * (cols * 3 + 1) + 1 + x * 3)
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const chunk = (type: string, data: Uint8Array): number[] => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat([...data])
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const len = data.length
    return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]
  }
  const ihdr = new Uint8Array([0, 0, cols >> 8, cols & 255, 0, 0, rows >> 8, rows & 255, 8, 2, 0, 0, 0])
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', zlibSync(raw)), ...chunk('IEND', new Uint8Array(0))])
}

/** A small lake depth chart: tan land, the lake blue going dark toward its deepest point. */
function lakePng(): Uint8Array {
  return pngOf(160, 100, (x, y) => {
    const a = Math.atan2(y - 50, x - 80)
    const r = Math.hypot((x - 80) / 1.5, y - 50) / (38 + 6 * Math.sin(3 * a))
    if (r >= 1) return [205, 190, 150]
    const d = 1 - r
    return [Math.round(60 - 50 * d), Math.round(150 - 120 * d), Math.round(230 - 150 * d)]
  })
}

let plateStep: ArrayBuffer
let savedBlobs: Blob[] = []
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeAll(async () => {
  const engine = new GeomEngine()
  await engine.init()
  const box = await engine.makeBox('PLATE', PLATE)
  plateStep = await engine.exportStep([box.body!])
  await engine.disposeKernel()
}, 120_000)

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
  useReliefStore.getState().closeSession()
  savedBlobs = []
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2174' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  cleanup()
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  vi.unstubAllGlobals()
  resetDocumentHolder()
})
afterAll(() => { useReliefStore.getState().closeSession() })

async function openLake(): Promise<void> {
  const runtime = createFakeSceneRuntime()
  useCamStore.getState().newProject()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([plateStep], 'plate.step')] } })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  clickWorld(runtime, { x: 50, y: 35, z: 100 }, { x: 0, y: 0, z: -1 })
  fireEvent.click(screen.getByTestId('workbench-relief'))
  await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
  fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([lakePng() as BlobPart], 'lake.png', { type: 'image/png' })] } })
  await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
}

const settings = (): ReliefSettings => useReliefStore.getState().settings!
const adjust = (): PictureAdjust => settings().adjust!
const settledAdjusted = (): Float32Array | undefined => window.__reliefSettled?.()?.adjusted

async function settledAfter(change: () => void): Promise<Float32Array> {
  const before = settledAdjusted()
  change()
  await waitFor(() => expect(settledAdjusted()).not.toBe(before), { timeout: 20_000 })
  return settledAdjusted()!
}

function differs(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

describe('WO-2174 relief adjustments and step-downs in the Model screen', () => {
  it('the palette controls adjust the picture and step the heights; Apply, Edit, Undo keep every value', async () => {
    await openLake()
    // Auto's choices show as the adjustment values; the picture keeps its colour channels
    expect(settings().auto).toBe(true)
    expect(adjust()).toMatchObject({ channel: 'luma', midtones: 1, contrast: 0, brightness: 0, edgeSmoothMm: 0 })
    expect(useReliefStore.getState().picture?.rgb).toBeDefined()
    expect(screen.getByTestId('relief-histogram')).toBeTruthy()
    await waitFor(() => expect(settledAdjusted()).toBeDefined(), { timeout: 20_000 })
    commitField('Relief width', '30')
    await waitFor(() => expect(window.__reliefSettled?.()?.settings.widthMm).toBe(30), { timeout: 20_000 })
    const autoAdjusted = settledAdjusted()!

    // Greyscale: the blue channel; moving a control makes the values the operator's own (Auto switches off)
    const blue = await settledAfter(() => fireEvent.click(screen.getByTestId('relief-channel-blue')))
    expect(adjust().channel).toBe('blue')
    expect(settings().auto).toBe(false)
    expect(differs(blue, autoAdjusted)).toBeGreaterThan(0.05)
    // Levels, contrast, brightness, denoise, smooth, edge-keeping smooth: each by its own control, each changes the picture
    let last = blue
    const steps: Array<[string, () => void, Partial<PictureAdjust>]> = [
      ['levels black', () => commitField('Levels black', '40'), { black: 40 / 255 }],
      ['levels midtones', () => commitField('Levels midtones', '1.6'), { midtones: 1.6 }],
      ['levels white', () => commitField('Levels white', '220'), { white: 220 / 255 }],
      ['contrast', () => commitField('Contrast', '30'), { contrast: 30 }],
      ['brightness', () => fireEvent.change(screen.getByTestId('relief-brightness-slider'), { target: { value: '-10' } }), { brightness: -10 }],
      ['denoise', () => commitField('Denoise', '2'), { denoisePx: 2 }],
      ['smooth', () => commitField('Smooth', '0.4'), { smoothMm: 0.4 }],
      ['edge-keeping smooth', () => fireEvent.click(screen.getByTestId('relief-edge-toggle').querySelector('input')!), { edgeSmoothMm: 0.5, edgeRange: 0.1 }],
    ]
    for (const [name, change, expected] of steps) {
      const next = await settledAfter(change)
      expect(adjust(), name).toMatchObject(expected)
      expect(differs(next, last), name).toBeGreaterThan(1e-4)
      last = next
    }

    // the 2D map: before, after, and both side by side
    for (const view of ['image', 'adjusted', 'compare'] as const) {
      fireEvent.click(screen.getByTestId(`relief-view-${view}`))
      expect(useReliefStore.getState().mapView).toBe(view)
    }

    // Step-downs: 5 levels, then a 45 deg wall; the status line lists the levels
    fireEvent.click(screen.getByTestId('relief-steps-levels'))
    commitField('Step levels', '5')
    commitField('Relief depth', '2')
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/5 levels 0\.40 \/ 0\.80 \/ 1\.20 \/ 1\.60 \/ 2\.00 mm high, vertical walls$/), { timeout: 20_000 })
    // the settled surface (what Apply builds) is those floors and nothing else
    const floors = new Set(Array.from(window.__reliefSettled!()!.heights).map((h) => Math.round(h * 1e6) / 1e6))
    expect([...floors].every((h) => [0, 0.4, 0.8, 1.2, 1.6, 2].includes(h))).toBe(true)
    expect(floors.size).toBeGreaterThanOrEqual(4)
    commitField('Wall angle', '45')
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/walls at 45 deg$/), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('relief-steps-step'))
    commitField('Step depth', '0.75')
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/3 levels 0\.75 \/ 1\.50 \/ 2\.00 mm high, walls at 45 deg$/), { timeout: 20_000 })
    const chosen = { adjust: { ...adjust() }, steps: { ...settings().steps! } }
    expect(chosen.steps).toEqual({ mode: 'step', levels: 5, stepMm: 0.75, wallDeg: 45 })

    // Apply: ONE relief feature, every value saved in it
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 90_000 })
    const saved = hooks().dag.getNode('REL1')!.payload.settings as ReliefSettings
    expect(saved.adjust).toEqual(chosen.adjust)
    expect(saved.steps).toEqual(chosen.steps)

    // Edit: the values come back; change the step and Apply edits the same node
    const entry = hooks().editEntryFor('REL1')
    if (entry !== undefined && 'onEdit' in entry) entry.onEdit()
    await waitFor(() => expect(useReliefStore.getState().picture).not.toBeNull(), { timeout: 20_000 })
    expect(adjust()).toEqual(chosen.adjust)
    expect(settings().steps).toEqual(chosen.steps)
    expect((screen.getByLabelText('Contrast') as HTMLInputElement).value).toBe('30')
    commitField('Step depth', '0.5')
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect((hooks().dag.getNode('REL1')!.payload.settings as ReliefSettings).steps?.stepMm).toBe(0.5), { timeout: 60_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 90_000 })
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'relief')).toEqual(['REL1'])

    // Undo: one step takes the edit back, the next takes the relief away
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect((hooks().dag.getNode('REL1')!.payload.settings as ReliefSettings).steps?.stepMm).toBe(0.75), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('REL1')).toBeUndefined(), { timeout: 30_000 })
  }, 300_000)

  it('Auto puts its own values back with one click', async () => {
    await openLake()
    const auto = { ...adjust() }
    commitField('Contrast', '50')
    expect(settings().auto).toBe(false)
    fireEvent.click(screen.getByTestId('relief-auto-toggle').querySelector('input')!)
    expect(settings().auto).toBe(true)
    expect(adjust()).toEqual(auto)
    // and off: the standard's manual defaults (the picture as it is, 0.10 mm smooth)
    fireEvent.click(screen.getByTestId('relief-auto-toggle').querySelector('input')!)
    expect(adjust()).toMatchObject({ channel: 'luma', black: 0, white: 1, midtones: 1, contrast: 0, brightness: 0, denoisePx: 0, smoothMm: 0.1, edgeSmoothMm: 0 })
  }, 120_000)

  it('save -> reopen: a stepped, adjusted relief replays to the same body', async () => {
    await openLake()
    commitField('Relief width', '30')
    fireEvent.click(screen.getByTestId('relief-channel-red'))
    commitField('Contrast', '20')
    fireEvent.click(screen.getByTestId('relief-steps-levels'))
    commitField('Step levels', '4')
    commitField('Wall angle', '60')
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 90_000 })
    const hash = hooks().getBodyGeometryHash('REL1')
    const volume = (await hooks().client.measure(hooks().getBodyHandle('REL1')!, 'volume')).value

    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    const text = await savedBlobs[0].text()
    cleanup()
    resetDocumentHolder()
    const reopened = createFakeSceneRuntime()
    await useCamStore.getState().loadProjectFromFile(text)
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => reopened} />)
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 90_000 })
    const s = hooks().dag.getNode('REL1')!.payload.settings as ReliefSettings
    expect(s.adjust?.channel).toBe('red')
    expect(s.steps).toMatchObject({ mode: 'levels', levels: 4, wallDeg: 60 })
    expect(Math.abs((await hooks().client.measure(hooks().getBodyHandle('REL1')!, 'volume')).value - volume)).toBeLessThan(1e-6 * volume)
    await waitFor(() => expect(hooks().getBodyGeometryHash('REL1')).toBe(hash), { timeout: 30_000 })
  }, 300_000)
})
