// @vitest-environment jsdom
//
// WO-1455: an open STEP shell (no TopAbs_SOLID subshapes) was adopted as an
// ordinary body and its Mass Properties readout computed volume/mass/CoM as
// if it were closed -- e.g. measure('volume') on a 30x20x10 box missing one
// face returned 4800 (garbage: correct for neither the closed box (6000) nor
// anything else meaningful). Fixed by gating measure('volume') on
// closed-solid content (#isClosedSolid) in geom-engine.ts and refusing the
// computation itself rather than hiding a computed number.
//
// Architect re-queue 2026-09-14 19:19Z: the shell/refusal state reads on the
// console (COHESION-STANDARD rule 13 / "use the console"), never as a tree
// badge or a panel replacement line -- the tests below assert the console
// events and the ABSENCE of both UI surfaces, not their presence.
//
// Tier 2 desk evidence: real occt-wasm kernel (createLocalGeomService, no
// Worker/postMessage indirection -- same engine, in-process) importing real
// STEP fixtures through the SAME import->measure entry points the Model
// workbench uses (SolidsWorkbenchPage's 'import' node executor ->
// client.importStep -> client.measure(handle, 'volume')), and a rendered
// DesignTree for the CAM-row adoption console line.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { createLocalGeomService } from '../../geom'
import { MassPropertiesPanel } from '../../components/model3d/massProperties'
import type { MassProperties } from '../../components/model3d/massProperties/massProperties'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'
import { DesignTree } from '../../components/panels/DesignTree'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import type { ImportedGeometry } from '../../types'

const { stepCacheStore } = vi.hoisted(() => ({ stepCacheStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, buf: ArrayBuffer) => { stepCacheStore.set(id, buf) }),
  loadCachedStep: vi.fn(async (id: string) => stepCacheStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepCacheStore.delete(id) }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'wo1455')

function loadFixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('WO-1455: open STEP shell adopted as solid', () => {
  it('acceptance #1/#4: a real OPEN_SHELL STEP fixture imports through the real engine, and measure(volume) refuses it by name (RED on main, which threw no error and returned 4800)', async () => {
    const svc = createLocalGeomService()
    await svc.init()
    const bytes = loadFixtureBytes('open-shell-30x20x10.step')
    const { bodies, diagnostics } = await svc.importStep(bytes, 'IMP-OPEN')
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false)
    expect(bodies.length).toBe(1)

    await expect(svc.measure(bodies[0].handle, 'volume')).rejects.toThrow(/is not a closed solid/)

    await svc.disposeAll()
  })

  it('acceptance #3: a normal closed-solid STEP import is unaffected -- volume still computes exactly', async () => {
    const svc = createLocalGeomService()
    await svc.init()
    const bytes = loadFixtureBytes('closed-box-30x20x10.step')
    const { bodies, diagnostics } = await svc.importStep(bytes, 'IMP-CLOSED')
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false)
    expect(bodies.length).toBe(1)

    const volume = await svc.measure(bodies[0].handle, 'volume')
    expect(volume.value).toBeCloseTo(6000, 6) // 30 x 20 x 10 mm

    await svc.disposeAll()
  })

  it('acceptance #2: the real workbench shows no numbers for an open-shell body and names the refusal on the console once, never a panel note', async () => {
    useCamStore.setState({ consoleEvents: [] })
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
    const file = new File([loadFixtureBytes('open-shell-30x20x10.step')], 'open-shell-30x20x10.step', { type: 'application/octet-stream' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 20_000 })

    await waitFor(() => {
      const warn = useCamStore.getState().consoleEvents.find(
        (e) => e.severity === 'warning' && e.source === 'model' && /is not a closed solid/.test(e.message),
      )
      expect(warn).toBeDefined()
    }, { timeout: 20_000 })

    // No numbers, and no replacement text either -- the refusal lives on the console only.
    expect(screen.queryByTestId('mass-readout')).toBeNull()
    expect(screen.queryByTestId('mass-value')).toBeNull()
    expect(screen.queryByTestId('mass-refusal')).toBeNull()

    // Posted once, not once per render/effect re-run.
    const refusalWarnings = useCamStore.getState().consoleEvents.filter(
      (e) => e.severity === 'warning' && e.source === 'model' && /is not a closed solid/.test(e.message),
    )
    expect(refusalWarnings.length).toBe(1)
  }, 30_000)

  it('acceptance #2/#3 regression: the panel still shows the ordinary numeric readout for a closed-solid body, no refusal', () => {
    const properties: MassProperties = {
      massGrams: 16.2,
      volumeMm3: 6000,
      densityGPerCm3: 2.7,
      centerOfMass: { x: 15, y: 10, z: 5 },
      centerOfMassApprox: false,
    }
    render(
      <MassPropertiesPanel
        bodyId="IMP-CLOSED"
        materialId="aluminum"
        customDensityGPerCm3={2.7}
        onMaterialChange={() => {}}
        onCustomDensityChange={() => {}}
        properties={properties}
        busy={false}
      />,
    )
    expect(screen.getByTestId('mass-readout')).toBeTruthy()
    expect(screen.queryByTestId('mass-refusal')).toBeNull()
  })

  it('acceptance #1: an open-shell STEP row in the Design Tree reads differently via the console, never a badge', () => {
    const openShellGeo: ImportedGeometry = {
      id: 'shell1', name: 'Open Shell Part', filename: 'open-shell-30x20x10.step', type: 'brep', format: 'step',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 20, z: 10 },
        size: { x: 30, y: 20, z: 10 }, center: { x: 15, y: 10, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, solidCount: 0,
    }
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState({ activeModal: null, workspace: 'cam', brepImportError: null, consoleEvents: [] })
      useUiPrefs.setState({
        treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
        collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
        expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
      })
    })
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [openShellGeo] } }))
    })

    render(<DesignTree />)

    expect(screen.getByTestId('tree-name-geometry').textContent).toContain('Open Shell Part')
    expect(screen.queryByTestId(`open-shell-badge-${openShellGeo.id}`)).toBeNull()

    const warn = useCamStore.getState().consoleEvents.find(
      (e) => e.severity === 'warning' && e.source === 'model' && /open shell/.test(e.message),
    )
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('Open Shell Part')

    // Posted once per body, not once per render.
    const openShellWarnings = useCamStore.getState().consoleEvents.filter(
      (e) => e.severity === 'warning' && e.source === 'model' && /open shell/.test(e.message),
    )
    expect(openShellWarnings.length).toBe(1)
  })

  // AUDIT FAIL (3115c7650): geom-engine.ts's measure('volume') refusal for an
  // open shell is correct in isolation, but transactExistingPushPull's staging
  // loop (SolidsWorkbenchPage.tsx, the step before an EXISTING push/pull
  // re-edit is adopted) measured the volume of every live body in the
  // document with no catch -- so an untouched open-shell IMPORT sharing the
  // document with the body actually being re-edited rolled the whole edit
  // back with a refusal that named the wrong body. Fixed by treating a
  // refused measure as "no volume" for that row, the same fail-soft pattern
  // the body-list's own initial volume read already uses (line ~4001).
  it('re-editing an existing push/pull feature on a CLOSED body is not refused by an unrelated open-shell import sharing the document', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // IMP1: the open-shell import. Never touched again -- it only needs to be
    // present in the document to reproduce the leak.
    const shellFile = new File([loadFixtureBytes('open-shell-30x20x10.step')], 'open-shell-30x20x10.step', { type: 'application/octet-stream' })
    fireEvent.change(screen.getByTestId('workbench-import-step-input') as HTMLInputElement, { target: { files: [shellFile] } })
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })

    // SK1 -> F1 (40x20x12 extrude) -> F2 (push/pull F1's top face +3): the
    // body actually being edited, entirely unrelated to IMP1.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
    const createInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(createInput, { target: { value: '3' } })
    fireEvent.keyDown(createInput, { key: 'Enter' }) // preview
    fireEvent.keyDown(createInput, { key: 'Enter' }) // commit
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // Re-edit F2 through the tree context menu, the exact staging path
    // (transactExistingPushPull) the audit found leaking IMP1's refusal.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const editInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    expect(editInput.value).toBe('3')
    fireEvent.change(editInput, { target: { value: '5' } })
    fireEvent.keyDown(editInput, { key: 'Enter' }) // preview
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    fireEvent.keyDown(editInput, { key: 'Enter' }) // commit
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(5), { timeout: 20_000 })

    // Before the fix: the edit rolled back and this hint named the refusal.
    const hint = screen.queryByTestId('solids-workbench-pushpull-hint')?.textContent ?? ''
    expect(hint).not.toMatch(/refused/i)
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')
    expect(hooks().getBodyHandle('F2')).not.toBeUndefined()
    // IMP1 (the open shell) is unaffected and still present.
    expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined()
  }, 30_000)
})
