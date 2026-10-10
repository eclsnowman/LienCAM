// @vitest-environment jsdom
//
// WO-2171 - image relief stage 1b through the Model screen's own buttons, on
// the real kernel (createLocalGeomService) with the fake scene runtime:
// Relief on the rail, a click on a flat face of an imported plate, a picture
// opened through the palette's file input - the standard's defaults with no
// other click - then Apply (ONE relief feature, the body built into the face),
// Edit (every value back, Apply edits the same node), Undo (one step each),
// and save -> reopen (the picture travels inside the project and the relief
// replays). A curved face is not offered: the status line says so.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { isReliefFeaturePayload } from '../../relief/reliefFeature'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const TEXT_SIGN = resolve(process.cwd(), 'docs/design/relief-references/fixtures/fixture-03-text-sign.png')
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

let plateStep: ArrayBuffer
let savedBlobs: Blob[] = []
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeAll(async () => {
  // the plate the operator imports: a 100 x 70 x 15 box as a STEP file
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
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2171' }) as typeof URL.createObjectURL
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

async function importPlate(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  useCamStore.getState().newProject()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([plateStep], 'plate.step')] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })
  return runtime
}

async function volumeOf(id: string): Promise<number> {
  return (await hooks().client.measure(hooks().getBodyHandle(id)!, 'volume')).value
}

describe('WO-2171 relief mode in the Model screen', () => {
  it('Relief on the rail: pick a flat face, open a picture, Apply, Edit, Undo', async () => {
    const runtime = await importPlate()
    // the operator clicks the plate's top face, then Relief on the rail
    clickWorld(runtime, { x: 50, y: 35, z: 100 }, { x: 0, y: 0, z: -1 })
    fireEvent.click(screen.getByTestId('workbench-relief'))
    expect(screen.getByTestId('relief-palette-shell')).toBeTruthy()
    // the rail swapped to the relief tools
    expect(screen.getByTestId('relief-open-image')).toBeTruthy()
    await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
    const face = useReliefStore.getState().target!.face
    expect(face.widthMm).toBeCloseTo(100, 3)
    expect(face.heightMm).toBeCloseTo(70, 3)
    expect(face.normal.z).toBeCloseTo(1, 6)

    // open the picture: the standard's defaults with no other click
    const png = readFileSync(TEXT_SIGN)
    fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([png], 'fixture-03-text-sign.png', { type: 'image/png' })] } })
    await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
    const s = useReliefStore.getState().settings!
    // S1: 1600 x 800 inside 100 x 70 with a 5 % margin -> 90 x 45; S2: 4 % of 45 = 1.8 -> 1.75 mm; Raise, base 0
    expect(s).toMatchObject({ widthMm: 90, heightMm: 45, depthMm: 1.75, direction: 'raise', baseMm: 0, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0, auto: true })
    // S6: Auto flipped the black-on-white art so the letters rise
    expect(s.invert).toBe(true)
    expect(useReliefStore.getState().autoParams?.kind).toBe('artwork')
    // S12: the status line (information only) after the preview settles
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/^90\.0 x 45\.0 mm, highest 1\.75 mm, steepest wall \d+ deg, grid 901 x 451 @ 0\.10 mm/), { timeout: 20_000 })
    console.log('WO-2171 relief status line:', screen.getByTestId('relief-status-line').textContent)

    // change by number: depth 1.5 mm, and a smaller sign (proportions kept) so the kernel work stays short
    commitField('Relief depth', '1.5')
    commitField('Relief width', '40')
    expect(useReliefStore.getState().settings).toMatchObject({ depthMm: 1.5, widthMm: 40, heightMm: 20 })

    // Apply: ONE relief feature consuming the plate, built into its face
    const before = await volumeOf('IMP1')
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect(hooks().dag.getNode('REL1')).not.toBeUndefined(), { timeout: 60_000 })
    await waitFor(() => expect(hooks().getBodyHandle('REL1')).not.toBeUndefined(), { timeout: 60_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 60_000 })
    expect(screen.queryByTestId('relief-palette-shell')).toBeNull()
    const node = hooks().dag.getNode('REL1')!
    expect(node.consumes).toEqual(['IMP1'])
    expect(isReliefFeaturePayload(node.payload)).toBe(true)
    // WO-2200: 40 mm at 10 / mm is a 401-sample grid, more than an exact face's 256: a mesh relief, and its row says so
    expect(node.payload.name).toBe('Relief 1 (mesh relief)')
    const added = (await volumeOf('REL1')) - before
    console.log('WO-2171 relief added volume (mm^3):', added.toFixed(1))
    expect(added).toBeGreaterThan(20)
    expect(hooks().getBodyPresentationVisible('IMP1')).toBe(false)

    // Edit: every value back; Apply edits the same node
    const entry = hooks().editEntryFor('REL1')
    expect(entry !== undefined && 'onEdit' in entry).toBe(true)
    if (entry !== undefined && 'onEdit' in entry) entry.onEdit()
    await waitFor(() => expect(useReliefStore.getState().picture).not.toBeNull(), { timeout: 20_000 })
    expect(screen.getByTestId('relief-palette-shell').textContent).toMatch(/Edit relief - Relief 1/)
    expect(useReliefStore.getState().settings).toMatchObject({ depthMm: 1.5, widthMm: 40, heightMm: 20, invert: true })
    commitField('Relief depth', '1')
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect((hooks().dag.getNode('REL1')!.payload.settings as { depthMm: number }).depthMm).toBe(1), { timeout: 60_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 60_000 })
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'relief')).toEqual(['REL1'])

    // Undo: one step takes the edit back, the next takes the relief away
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect((hooks().dag.getNode('REL1')!.payload.settings as { depthMm: number }).depthMm).toBe(1.5), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('REL1')).toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(hooks().getBodyPresentationVisible('IMP1')).toBe(true), { timeout: 30_000 })
  }, 240_000)

  it('save -> reopen: the picture travels inside the project and the relief replays to the same body', async () => {
    const runtime = await importPlate()
    clickWorld(runtime, { x: 50, y: 35, z: 100 }, { x: 0, y: 0, z: -1 })
    fireEvent.click(screen.getByTestId('workbench-relief'))
    await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([readFileSync(TEXT_SIGN)], 'sign.png', { type: 'image/png' })] } })
    await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
    // a small sign keeps the saved project light (the CAM row carries the body's display mesh)
    commitField('Relief width', '30')
    expect(useReliefStore.getState().settings).toMatchObject({ widthMm: 30, heightMm: 15 })
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 60_000 })
    const hash = hooks().getBodyGeometryHash('REL1')
    const volume = await volumeOf('REL1')
    console.log('WO-2171 applied before save:', JSON.stringify({ hash, volume }))

    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    expect(savedBlobs.length).toBe(1)
    const saved = await savedBlobs[0].text()
    console.log(`WO-2171 saved project: ${(saved.length / 1e6).toFixed(1)} MB`)
    cleanup()
    resetDocumentHolder()

    const reopened = createFakeSceneRuntime()
    await useCamStore.getState().loadProjectFromFile(saved)
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => reopened} />)
    await waitFor(() => expect(hooks().dag.getNode('REL1')).not.toBeUndefined(), { timeout: 30_000 })
    // the picture itself came back inside the project
    const image = hooks().dag.getNode('REL1')!.payload.image as { dataUrl: string; fileName: string }
    expect(image.fileName).toBe('sign.png')
    expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 60_000 })
    expect(Math.abs((await volumeOf('REL1')) - volume)).toBeLessThan(1e-6 * volume)
    await waitFor(() => expect(hooks().getBodyGeometryHash('REL1')).toBe(hash), { timeout: 30_000 })
  }, 240_000)

  it('picture first, then Pick face and a click on the top face: the picture lies on it (Operator 2026-09-30)', async () => {
    const runtime = await importPlate()
    // nothing selected: Relief on the rail, the picture opened before any face
    fireEvent.click(screen.getByTestId('workbench-relief'))
    fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([readFileSync(TEXT_SIGN)], 'sign.png', { type: 'image/png' })] } })
    await waitFor(() => expect(useReliefStore.getState().picture).not.toBeNull(), { timeout: 20_000 })
    expect(useReliefStore.getState().target).toBeNull()
    // Pick face, then the top face
    fireEvent.click(screen.getByTestId('relief-pick-face'))
    clickWorld(runtime, { x: 50, y: 35, z: 100 }, { x: 0, y: 0, z: -1 })
    await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
    // the same defaults as face-first: fitted inside 100 x 70 with a 5 % margin, Auto's adjustments shown
    await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
    const st = useReliefStore.getState()
    expect(st.settings).toMatchObject({ widthMm: 90, heightMm: 45, depthMm: 1.75, direction: 'raise', auto: true, invert: true })
    expect(st.settings!.adjust).toEqual(st.autoAdjust)
    // the height row and Fit to face are live, and the preview settles on the face
    expect((screen.getByTestId('relief-raise') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('relief-fit') as HTMLButtonElement).disabled).toBe(false)
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/^90\.0 x 45\.0 mm, highest 1\.75 mm/), { timeout: 20_000 })
  }, 120_000)

  it('Cancel leaves no trace; a side face takes the picture upright', async () => {
    const runtime = await importPlate()
    fireEvent.click(screen.getByTestId('workbench-relief'))
    expect(screen.getByTestId('relief-notice').textContent).toMatch(/click a flat face/i)
    // the side face at x = 0: its frame stands the picture upright (+Z up)
    clickWorld(runtime, { x: -100, y: 35, z: 7.5 }, { x: 1, y: 0, z: 0 })
    await waitFor(() => expect(useReliefStore.getState().target?.face.normal.x).toBeCloseTo(-1, 6), { timeout: 20_000 })
    expect(useReliefStore.getState().target!.face.yDir.z).toBeCloseTo(1, 6)
    fireEvent.click(screen.getByTestId('relief-cancel'))
    expect(screen.queryByTestId('relief-palette-shell')).toBeNull()
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'relief')).toBe(false)
    expect(hooks().getBodyPresentationVisible('IMP1')).toBe(true)
  }, 120_000)

  it('a curved face is not offered: the status line says curved faces come later', async () => {
    const runtime = createFakeSceneRuntime()
    useCamStore.getState().newProject()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    const holes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
    fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([holes], 'plate-holes.step')] } })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('workbench-relief'))
    // down through the d6 hole at (20, 20) onto its round wall
    clickWorld(runtime, { x: 20, y: 20, z: 50 }, { x: 2.9, y: 0, z: -45 })
    await waitFor(() => expect(screen.getByTestId('relief-notice').textContent).toMatch(/round\. Curved faces come in a later stage/), { timeout: 20_000 })
    expect(useReliefStore.getState().target).toBeNull()
  }, 120_000)
})
