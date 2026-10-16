// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService } from '../../geom'
import { cacheStep } from '../../lib/stepCache'
import { useCamStore } from '../../store'
import { WORKBENCH_BODY_OP_TYPES, type WorkbenchBodyOpType } from '../../components/model3d/bodyLineage'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const FIXTURE = resolve(process.cwd(), 'src/tests/evidence/WO-1292/FailtoFillet.camproject')
const OLDER_FIXTURE = resolve(process.cwd(), 'src/tests/evidence/WO-1292/fillets-cause-undefined.camproject')
const MODEL_ITEM_ID = 'bbc394b0-772d-4211-a705-69fd44a02abc'
const STEP_CACHE_KEY = '471ed7f8-9b1c-4e9b-8d02-df2d25bef110'
const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step')

const BODY_INPUT_CLASSIFICATION = {
  extrude: 'creator',
  revolve: 'creator',
  boolean: 'existing',
  fillet: 'existing',
  defeature: 'existing',
  chamfer: 'existing',
  shell: 'existing',
  draft: 'existing',
  sweep: 'creator',
  loft: 'creator',
  hole: 'existing',
  pushPull: 'existing',
  resizeHole: 'existing',
  form: 'creator',
  relief: 'existing',
} as const satisfies Record<WorkbenchBodyOpType, 'creator' | 'existing'>

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function applySampleMachineFillet(runtime: ReturnType<typeof createFakeSceneRuntime>, label: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  runtime.rayOverride = { origin: { x: 0, y: -100, z: 5 }, direction: { x: 0, y: 1, z: 0 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
  runtime.rayOverride = { origin: { x: 40, y: -100, z: 5 }, direction: { x: 0, y: 1, z: 0 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/2 edges/))
  commitField('fillet-radius', '10')
  await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).not.toBe('pending'), { timeout: 30_000 })
  console.log(`WO-1292 ${label} fillet preview:`, screen.getByTestId('fillet-preview-status').textContent)
  expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
  expect(hooks().scheduler.statusOf('F1')).toBe('ok')
}

async function openSavedProject(): Promise<ReturnType<typeof createFakeSceneRuntime>> {
  const runtime = createFakeSceneRuntime()
  const source = readFileSync(STEP_FIXTURE)
  const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
  await cacheStep(STEP_CACHE_KEY, sourceBytes)
  await useCamStore.getState().loadProjectFromFile(readFileSync(FIXTURE, 'utf8'))
  render(
    <SolidsWorkbenchPage
      modelItemId={MODEL_ITEM_ID}
      createClient={createLocalGeomService}
      createSceneRuntime={() => runtime}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })
  return runtime
}

type SharedPreviewOp = 'fillet' | 'chamfer' | 'shell' | 'draft' | 'hole'
const LIVENESS_GATE_OPS = ['fillet', 'chamfer', 'shell', 'draft', 'hole', 'defeature', 'pushPull'] as const satisfies readonly WorkbenchBodyOpType[]

function clickWorld(runtime: ReturnType<typeof createFakeSceneRuntime>, origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): void {
  runtime.rayOverride = { origin, direction }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

async function exerciseSharedPreview(opType: Exclude<SharedPreviewOp, 'fillet'>, runtime: ReturnType<typeof createFakeSceneRuntime>): Promise<void> {
  fireEvent.click(screen.getByTestId(`workbench-${opType}`))
  if (opType === 'chamfer') {
    clickWorld(runtime, { x: 40, y: -100, z: 5 }, { x: 0, y: 1, z: 0 })
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge/))
    commitField('chamfer-distance', '2')
  } else if (opType === 'shell') {
    clickWorld(runtime, { x: -100, y: 5, z: 5 }, { x: 1, y: 0, z: 0 })
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/))
    commitField('shell-thickness', '2')
  } else if (opType === 'draft') {
    clickWorld(runtime, { x: 5, y: 5, z: -100 }, { x: 0, y: 0, z: 1 })
    await waitFor(() => expect(screen.getByTestId('draft-neutral-face-role').textContent).toMatch(/confirm this role/i))
    fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
    clickWorld(runtime, { x: 5, y: -100, z: 5 }, { x: 0, y: 1, z: 0 })
    await waitFor(() => expect(screen.getByTestId('draft-face-role').textContent).toMatch(/1 draft face selected/i))
    commitField('draft-angle', '5')
  } else {
    clickWorld(runtime, { x: 5, y: 5, z: 100 }, { x: 0, y: 0, z: -1 })
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitField('hole-diameter', '5')
    commitField('hole-blind-distance', '5')
  }

  const status = screen.getByTestId(`${opType}-preview-status`)
  await waitFor(() => expect(status.getAttribute('data-status')).not.toBe('pending'), { timeout: 30_000 })
  console.log(`WO-1292 saved-project ${opType} preview:`, status.getAttribute('data-status'), status.textContent)
  const text = status.textContent ?? ''
  expect(text).not.toMatch(/has no live body \(missing or already consumed\)/)
  if (status.getAttribute('data-status') === 'ready') {
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  } else {
    expect(opType).toBe('shell')
    expect(text).toMatch(/shell/i)
    expect(text).toContain('IMP1')
  }
}

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
})
afterEach(() => {
  cleanup()
  resetDocumentHolder()
})

describe('WO-1292 saved imported-body operations', () => {
  it('opens Operator\'s saved project and applies a fillet to its visible imported body', async () => {
    const runtime = await openSavedProject()

    const before = {
      bodyIds: hooks().dag.featureOrder().filter((id) => hooks().getBodyHandle(id) !== undefined),
      imp1Handle: hooks().getBodyHandle('IMP1') !== undefined,
      imp1Status: hooks().scheduler.statusOf('IMP1'),
      imp1Edges: hooks().getBodyEdgeIds('IMP1')?.length ?? 0,
    }
    console.log('WO-1292 saved-project pre-fillet runtime:', JSON.stringify(before))

    await applySampleMachineFillet(runtime, 'saved-project')
  }, 120_000)

  it('also applies the same fillet immediately after a fresh import', async () => {
    useCamStore.getState().newProject()
    const runtime = createFakeSceneRuntime()
    const source = readFileSync(STEP_FIXTURE)
    const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const { container } = render(
      <SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    const input = container.querySelector('[data-testid="workbench-import-step-input"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([sourceBytes], 'fix_freeform.step')] } })
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
    console.log('WO-1292 fresh-import runtime:', JSON.stringify({
      imp1Handle: hooks().getBodyHandle('IMP1') !== undefined,
      imp1Status: hooks().scheduler.statusOf('IMP1'),
      imp1Edges: hooks().getBodyEdgeIds('IMP1')?.length ?? 0,
    }))

    await applySampleMachineFillet(runtime, 'fresh-import')
  }, 120_000)

  it.each(['chamfer', 'shell', 'draft', 'hole'] as const)('$opType uses its operator preview against the reopened imported body', async (opType) => {
    const runtime = await openSavedProject()
    await exerciseSharedPreview(opType, runtime)
  }, 120_000)

  it('boolean applies through its dialog after the operator imports a second body', async () => {
    await openSavedProject()
    const source = readFileSync(STEP_FIXTURE)
    const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([sourceBytes], 'second.step')] } })
    await waitFor(() => expect(hooks().getBodyHandle('IMP2')).not.toBeUndefined(), { timeout: 30_000 })

    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'IMP1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'IMP2' } })
    // WO-2821 refuses an empty subtraction of identical imports. This test
    // proves applying a valid saved-body operation, so explicitly fuse them.
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, 120_000)

  it('defeature recognizes and applies through its operator dialog', async () => {
    await openSavedProject()
    const recognized = await hooks().client.recognizeFeatures(hooks().getBodyHandle('IMP1')!)
    const removable = recognized.find((entry) => entry.removable)
    expect(removable).toBeDefined()

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId(`defeature-check-${removable!.featureKey}`)).toBeTruthy(), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId(`defeature-check-${removable!.featureKey}`))
    const status = screen.getByTestId('defeature-preview-status')
    await waitFor(() => expect(status.getAttribute('data-state')).not.toBe('building'), { timeout: 30_000 })
    console.log('WO-1292 saved-project defeature preview:', status.getAttribute('data-state'), status.textContent)
    expect(status.textContent).not.toMatch(/has no live body \(missing or already consumed\)/)
    expect(status.getAttribute('data-state')).toBe('ready')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, 120_000)

  it('push/pull previews and applies through its viewport value entry', async () => {
    const runtime = await openSavedProject()
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    clickWorld(runtime, { x: -100, y: 5, z: 5 }, { x: 1, y: 0, z: 0 })
    const input = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 30_000 }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry-apply')).toBeTruthy(), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
    const diagnostics = JSON.stringify(hooks().scheduler.diagnosticsOf('F1'))
    console.log('WO-1292 saved-project push/pull:', hooks().scheduler.statusOf('F1'), diagnostics)
    expect(hooks().dag.getNode('F1')?.payload.opType).toBe('pushPull')
    expect(diagnostics).not.toMatch(/has no live body \(missing or already consumed\)/)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, 120_000)

  it('push/pull edits its imported-body feature through the scratch replay transaction', async () => {
    const runtime = await openSavedProject()
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    clickWorld(runtime, { x: -100, y: 5, z: 5 }, { x: 1, y: 0, z: 0 })
    const createInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 30_000 }) as HTMLInputElement
    fireEvent.change(createInput, { target: { value: '1' } })
    fireEvent.keyDown(createInput, { key: 'Enter' })
    fireEvent.click(await screen.findByTestId('pushpull-delta-entry-apply', undefined, { timeout: 30_000 }))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.opType).toBe('pushPull'), { timeout: 30_000 })

    const committedHash = hooks().getBodyGeometryHash('F1')
    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const editInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 30_000 }) as HTMLInputElement
    expect(editInput.value).toBe('1')
    fireEvent.change(editInput, { target: { value: '2' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyGeometryHash('F1')).not.toBe(committedHash), { timeout: 30_000 })

    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 30_000 })
    const result = screen.queryByTestId('solids-workbench-pushpull-hint')?.textContent ?? 'applied without refusal'
    console.log('WO-1292 saved-project push/pull edit:', result)
    expect(result).not.toMatch(/has no live body \(missing or already consumed\)/)
    expect(hooks().dag.getNode('F1')?.payload.delta).toBe(2)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
    expect(hooks().getBodyHandle('F1')).not.toBeUndefined()
  }, 120_000)

  it('resize hole names why the reopened imported body cannot be edited', async () => {
    await openSavedProject()
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    const hint = await screen.findByTestId('solids-workbench-resizehole-hint', undefined, { timeout: 30_000 })
    await waitFor(() => expect(hint.textContent).not.toMatch(/recognizing/i), { timeout: 30_000 })
    console.log('WO-1292 saved-project resize hole:', hint.textContent)
    expect(hint.textContent).toMatch(/no recognized through, blind, or counterbore holes/i)
  }, 120_000)

  it('classifies the older fillet project from its loaded runtime, not its filename', async () => {
    await useCamStore.getState().loadProjectFromFile(readFileSync(OLDER_FIXTURE, 'utf8'))
    render(<SolidsWorkbenchPage modelItemId="legacy" createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    const runtime = hooks().dag.featureOrder().map((id) => ({ id, kind: hooks().dag.getNode(id)?.kind }))
    const bodyIds = hooks().dag.featureOrder().filter((id) => hooks().getBodyHandle(id) !== undefined)
    console.log('WO-1292 older-project runtime:', JSON.stringify({ runtime, bodyIds }))
    expect(runtime.some(({ kind }) => kind === 'import')).toBe(false)
    expect(bodyIds).toEqual([])
  }, 120_000)

  it('classifies every body operation and behaviorally covers every existing-body operation', () => {
    expect(Object.keys(BODY_INPUT_CLASSIFICATION).sort()).toEqual([...WORKBENCH_BODY_OP_TYPES].sort())
    const existingOps = WORKBENCH_BODY_OP_TYPES.filter((opType) => BODY_INPUT_CLASSIFICATION[opType] === 'existing')
    expect(existingOps).toEqual(['boolean', 'fillet', 'defeature', 'chamfer', 'shell', 'draft', 'hole', 'pushPull', 'resizeHole', 'relief'])
    // WO-2171: relief on an imported body (Relief on the rail, a face click, Apply) is driven in src/tests/relief/reliefMode.test.tsx
    expect([...LIVENESS_GATE_OPS].sort()).toEqual(existingOps.filter((opType) => !['boolean', 'resizeHole', 'relief'].includes(opType)).sort())
  })
})
