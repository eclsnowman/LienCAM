// @vitest-environment jsdom
//
// WO-2865: sweep 3 (H8-H14) - Model refusals and console lines say what
// happened and what to do next, and no developer text reaches the operator.
// Each case drives the production surface (component, hook or the page's own
// message builder) and pins the new words; every one fails on main.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useCamStore } from '../../store'
import { BottomConsole } from '../../components/panels/BottomConsole'
import { RevolveDialog } from '../../components/model3d/dialogs'
import { SolidsWorkbenchPage, resizedHoleLabel, shellRefusalReason } from '../../components/model3d/SolidsWorkbenchPage'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { KernelInfo } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

// From body: the conversion hands back a cage with a face that names one point
// twice - the exact cage that refused as "face 2106 repeats a point".
vi.mock('../../form/fromMesh', async (original) => (await import('../support/typedMock')).typedMock<typeof import('../../form/fromMesh')>({
  ...await original<typeof import('../../form/fromMesh')>(),
  formFromBody: () => ({
    cage: {
      positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      faces: [[0, 1, 2, 2], [0, 2, 3]],
      creases: [],
    },
    flatFaces: 0,
    gridFaces: 0,
    curvedTriangles: 2,
  }),
}))

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-2865 H14: the console badge click raises no React error', () => {
  it('expanding the console with an unread error marks it read without a render-phase store write', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => { useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'model', message: 'Something failed' }) })
    // Another component reading the read-through mark, as the app shell does.
    const ReadMark = () => createElement('span', { 'data-testid': 'read-mark' }, String(useCamStore((s) => s.consoleReadThroughId)))
    render(createElement('div', null, createElement(BottomConsole), createElement(ReadMark)))
    expect(screen.getByTestId('console-unread-badge').textContent).toBe('1')

    // Three clicks in one batch: only the first toggle can be computed eagerly
    // in the handler; the queued ones run while React renders, which is where
    // the old updater wrote the store (open -> close -> open again).
    act(() => {
      const strip = screen.getByTestId('console-strip')
      fireEvent.click(strip)
      fireEvent.click(strip)
      fireEvent.click(strip)
    })

    expect(screen.queryByTestId('console-unread-badge')).toBeNull()
    expect(screen.getByTestId('console-strip').getAttribute('aria-expanded')).toBe('true')
    const reactErrors = errors.mock.calls.filter(([first]) => typeof first === 'string' && /while rendering a different component|Cannot update a component/.test(first))
    expect(reactErrors).toEqual([])
  })
})

describe('WO-2865 H8: Revolve says why Apply is off and starts at a full turn', () => {
  function sketchOnPlane(normal: { x: number; y: number; z: number }) {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'SK1',
      kind: 'sketch',
      payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', plane: { origin: { x: 0, y: 0, z: 0 }, normal, xDir: { x: 1, y: 0, z: 0 } }, loops: [] }] },
    })
    return { dag, history: new CommandHistory(dag) }
  }
  const props = (dag: FeatureDag, history: CommandHistory) => ({
    dag, history, mode: 'create' as const, sketchOptions: [{ id: 'SK1', label: 'Sketch SK1' }], onApplied: () => {}, onClose: () => {},
  })

  it('a new revolve defaults to 360 degrees', () => {
    const { dag, history } = sketchOnPlane({ x: 0, y: -1, z: 0 })
    render(createElement(RevolveDialog, props(dag, history)))
    expect((screen.getByTestId('revolve-angle').querySelector('input') as HTMLInputElement).value).toBe('360')
    expect(screen.queryByTestId('revolve-apply-blocked-reason')).toBeNull()
  })

  it('a grey Apply shows one line saying what is wrong and what to do, beside the button', () => {
    const { dag, history } = sketchOnPlane({ x: 0, y: 0, z: 1 })
    render(createElement(RevolveDialog, props(dag, history)))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    const reason = screen.getByTestId('revolve-apply-blocked-reason').textContent ?? ''
    expect(reason).toMatch(/^Apply is off: this profile lies flat across the revolve axis \(world Z\), so turning it makes no solid\./)
    expect(reason).toMatch(/Draw the profile on a sketch plane the axis runs along \(XZ or YZ for world Z\), or pick an axis that lies in this sketch's plane \(Construct > Axis\)\./)
  })
})

describe('WO-2865 H9: Form > From body refuses in shop words with what to try', () => {
  afterEach(() => { act(() => useFormStore.getState().closeSession()) })

  it('a body whose conversion repeats a point names no face index and offers a next step', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const dag = new FeatureDag()
    const deps = {
      runtime: null,
      canvasRef: { current: null },
      dag,
      history: new CommandHistory(dag),
      onApplied: vi.fn(),
      showBody: vi.fn(),
      selectedBodyMesh: async () => ({ featureId: 'BLK', mesh: { position: [], index: [], triFace: [] } }),
    }
    const { result } = renderHook(() => useFormSession(deps))
    act(() => result.current.open())
    const fromBody = result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === 'form-starter-body')
    expect(fromBody).toBeDefined()
    await act(async () => { fromBody!.onClick(); await Promise.resolve() })

    const notice = useFormStore.getState().notice ?? ''
    expect(notice).not.toMatch(/face \d+|repeats a point|Not applied/)
    expect(notice).toMatch(/^From body could not turn this body into a form/)
    expect(notice).toMatch(/Try From body on the body before its fillets and small details .*, or start from a Box or Cylinder and shape that\./)
    expect(deps.showBody).not.toHaveBeenCalledWith('BLK', false)
  })
})

describe('WO-2865 H10: the Resize Hole console line names the hole that changed', () => {
  it('names the Hole feature that cut the picked hole, not the body\'s latest feature', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], payload: { opType: 'hole', ownerId: 'F1', points: [{ x: 0, y: 0, z: 0 }], name: 'Hole F2' } })
    dag.insertNode({ id: 'F5', kind: 'feature', consumes: ['F2'], payload: { opType: 'hole', ownerId: 'F2', points: [{ x: 9, y: 0, z: 0 }], name: 'Hole F5' } })
    expect(resizedHoleLabel(dag, ['F2:HOL:i0:wall', 'F2:HOL:i0:floor'])).toBe('Hole F2')
    // a face a later cut split still carries the hole that made it
    expect(resizedHoleLabel(dag, ['F5:CUT:(F2:HOL:i0:wall):0'])).toBe('Hole F2')
  })

  it('a multi-point Hole names which of its holes changed; a hole no Hole feature made names nothing', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F3', kind: 'feature', payload: { opType: 'hole', points: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], name: 'Hole F3' } })
    expect(resizedHoleLabel(dag, ['F3:HOL:i1:wall'])).toBe('Hole F3, hole 2 of 3')
    expect(resizedHoleLabel(dag, ['IMP1:step:4'])).toBeUndefined()
  })
})

describe('WO-2865 H13: the Shell refusal says what to try', () => {
  const shellFailed = (reason: string) => [{ code: 'SHELL_FAILED', severity: 'error', params: { faces: 'F1:XTR:cap1', thickness: 2, reason } }]

  it('the kernel stopping on the inward offsets becomes a thinner-wall / other-face next step with no ids', () => {
    const text = shellRefusalReason(shellFailed('shell kernel stopped while constructing inward offsets for 5 retained face(s) after opening F1:XTR:cap1 at thickness 2; it produced no result shape and the source body was left unchanged.'))
    expect(text).toBe('a 2 mm wall cannot be offset inward from every face of this body. Try a thinner wall - thinner than the smallest rounded corner or narrowest rib - or open a different face.')
  })

  it('no hollow and untraceable faces each get their own plain next step', () => {
    expect(shellRefusalReason(shellFailed('shell thickness 2 produced no meaningful hollow near face F1:XTR:cap1 -- try a smaller thickness')))
      .toBe('a 2 mm wall leaves no hollow inside this body. Try a thinner wall.')
    expect(shellRefusalReason(shellFailed('shell of face F1:XTR:cap1 produced 1 face(s) the kernel could not trace to a generating face (a plane face near (0.00, 0.00, 0.00)) -- refusing to persist a stable id the design tree could not re-derive')))
      .toMatch(/^the 2 mm hollow came out with faces LienCAM cannot keep track of in the tree\. Try a slightly different wall thickness, or open a different face\.$/)
  })
})

describe('WO-2865 H14: a geometry-engine retry that recovers is not an error', () => {
  const KERNEL: KernelInfo = { backend: 'occt-wasm', occtVersion: 'fake-0.0', capabilities: { defeature: false, xcaf: false, hlr: false } }

  it('attempt 1 failing and attempt 2 loading writes one info line and no console error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const infos = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const first = createFakeGeomClient()
    first.init = async (onProgress) => { onProgress?.(10, 'geom:loading-wasm'); throw new Error('Failed to fetch dynamically imported module') }
    const second = createFakeGeomClient()
    second.init = async () => KERNEL
    const clients: GeomClient[] = [first, second]
    const create = vi.fn((): GeomClient => clients.shift() ?? createFakeGeomClient())

    render(createElement(SolidsWorkbenchPage, {
      createClient: create,
      createSceneRuntime: fakeCreateSceneRuntime,
      geometryBootPolicy: { timeoutMs: 2_000, maxAttempts: 3, backoffMs: [1, 1] },
    }))
    await waitFor(() => { expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready') }, { timeout: 8_000 })

    const bootLine = (calls: unknown[][]) => calls.filter(([first]) => typeof first === 'string' && first.includes('3D geometry engine initialization failed'))
    expect(create).toHaveBeenCalledTimes(2)
    expect(bootLine(errors.mock.calls)).toEqual([])
    expect(bootLine(infos.mock.calls)).toHaveLength(1)
    expect(bootLine(infos.mock.calls)[0][0]).toMatch(/\(attempt 1 of 3\)/)
  })
})

// ------------------------------------------------------------------------
// H10 + H13 through the REAL page and the REAL in-process kernel: the same
// buttons, viewport picks and console strip the operator uses (fake scene
// runtime only - jsdom has no WebGL). Box x:[10,50] y:[0,20] z:[0,20].

function pageHooks() {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}
async function modelPageWithBox(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(pageHooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  return runtime
}
async function drillBlindHole(runtime: FakeSceneRuntime, x: number, y: number, diameter: string, featureId: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime.rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitField('hole-diameter', diameter)
  commitField('hole-blind-distance', '5')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(pageHooks().getBodyHandle(featureId)).not.toBeUndefined(), { timeout: 20_000 })
}

describe('WO-2865 H10 + H13 through the Model page (real kernel)', () => {
  let restoreCanvas2d: (() => void) | null = null
  beforeEach(() => {
    restoreCanvas2d = stubCanvas2d()
    act(() => { useCamStore.getState().clearConsoleEvents() })
  })
  afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

  it('H10: resizing the first of two holes names Hole F2 on the console line, not the later Hole F3', async () => {
    const runtime = await modelPageWithBox()
    await drillBlindHole(runtime, 20, 5, '6', 'F2')
    await drillBlindHole(runtime, 40, 15, '4', 'F3')

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i), { timeout: 20_000 })
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })

    const applied = useCamStore.getState().consoleEvents.filter((e) => e.severity === 'success' && / applied on /.test(e.message))
    expect(applied.map((e) => e.message)).toEqual([expect.stringMatching(/ applied on Hole F2: 6 mm -> 9 mm/)])
  }, 120_000)

  it('H13: an impossible Shell wall is refused in plain words with a next step, on a row that wraps', async () => {
    const runtime = await modelPageWithBox()
    fireEvent.click(screen.getByTestId('workbench-shell'))
    commitField('shell-thickness', '12')
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i))
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('refused'), { timeout: 30_000 })

    const line = screen.getByTestId('shell-preview-status')
    const text = line.textContent ?? ''
    expect(text).toMatch(/^Shell preview refused: a 12 mm wall /)
    expect(text).toMatch(/Try a thinner wall/)
    expect(text).not.toMatch(/F1:|kernel|retained face|thickness 12/)
    expect(line.style.whiteSpace).toBe('normal')
    expect(line.style.flexBasis).toBe('100%')
    expect(screen.getByTestId('shell-workspace-palette').style.flexWrap).toBe('wrap')
  }, 120_000)
})
