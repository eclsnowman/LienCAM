// @vitest-environment jsdom
//
// WO-413 - help hotlinks and the return-to-context rule (Operator ruling 2026-08-20:
// "closing help should return you to where you were with currently editing
// values still in place. This should be generalized.").
//
//   - the Routines station's Help link opens the Help Center AT "Probe routines"
//     (the station is the Control > Routines sub-tab since the WO-411 fix;
//     the editor is mounted directly here - the tab is proven in
//     controlTabMount.test.tsx and ProbeRoutineEditor.wo411.test.tsx)
//   - an error sentence's ? opens the topic at that code's row
//   - X / Escape / backdrop each close Help and the probe editor is exactly as
//     it was: the typed value, the selected routine, the open station
//   - Help opened from INSIDE the Post Process modal sits over it (the modal is
//     not unmounted), and closing Help leaves the modal open with its choice
//     (the context toggle flipped OFF) intact
//   - a hotlink pressed while Help is already open re-targets it

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import type { Operation, Project, Setup, Stock } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ProbeRoutineEditor } = await import('../../components/machine/ProbeRoutineEditor')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { HelpLink } = await import('../../components/ui/HelpLink')
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')
const { useCamStore } = await import('../../store')
const { useHelpOpen, openHelpTopic, errorCodeAnchor } = await import('../../help/helpOpen')

// --- the probe editor fixture (WO-411's) ------------------------------------
const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const probe = resolveProbeConfig(null, {
  positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
  surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
})
const START = { x: 100, y: 100, z: 40 }

function mountEditorWithHelp() {
  return render(
    <>
      <ProbeRoutineEditor
        start={START}
        envelopeStatus="homed"
        envelope={envelope}
        probe={probe}
        tipRadiusMm={1.5}
        axisLimits={null}
        activeWcs="G54"
        units="mm"
        defaultOpen
      />
      <HelpCenterModal />
    </>,
  )
}

const helpCenter = () => screen.queryByTestId('help-center')
const topicTitle = () => screen.getByTestId('help-topic-content').querySelector('h2')?.textContent ?? ''

/** Duplicate the factory bore (a USER copy is editable) and type into step 2's expression. */
function editStepTwo(value: string) {
  fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
  fireEvent.click(screen.getByTestId('probe-routine-duplicate'))
  const expr = screen.getByTestId('probe-routine-step-2-expr') as HTMLInputElement
  fireEvent.change(expr, { target: { value } })
  expect((screen.getByTestId('probe-routine-step-2-expr') as HTMLInputElement).value).toBe(value)
}

function expectEditorUntouched(value: string) {
  expect((screen.getByTestId('probe-routine-step-2-expr') as HTMLInputElement).value).toBe(value)
  expect(screen.getByTestId('probe-routine-section').getAttribute('data-open')).toBe('true')
  // the same (user) routine is still selected and still carries its unsaved edit
  expect(screen.getByTestId('probe-routine-badge').textContent).toBe('USER (edited, unsaved)')
  expect((screen.getByTestId('probe-routine-save') as HTMLButtonElement).disabled).toBe(false)
}

beforeEach(() => {
  mem.clear()
  act(() => {
    useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] })
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
    useHelpOpen.setState({ requested: null, overlay: false })
  })
})
afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-413: the probe editor hotlinks and return-to-context', () => {
  it('the Routines header link opens the Help Center at "Probe routines"', async () => {
    mountEditorWithHelp()
    expect(helpCenter()).toBeNull()
    fireEvent.click(screen.getByTestId('probe-routine-help'))
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    expect(topicTitle()).toBe('Probe routines')
    expect(useCamStore.getState().activeModal).toBe('help')
    // the body chunk loads async; the anchored headings are there once it has
    await waitFor(() => expect(screen.getByTestId('help-anchor-what-is')).toBeTruthy())
    expect(screen.getByTestId('help-anchor-errors')).toBeTruthy()
  })

  it('an error sentence\'s ? lands on that code\'s row in "What the errors mean"', async () => {
    mountEditorWithHelp()
    editStepTwo('abs(input.diameter / 2) - probe.tipRadiusMm')
    const inline = await screen.findAllByTestId('probe-routine-step-error')
    const code = inline[0].getAttribute('data-code')
    expect(code).toBe('E_EXPR_UNBOUNDED')
    fireEvent.click(screen.getByTestId('probe-routine-step-2-error-help-0'))
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    expect(topicTitle()).toBe('Probe routines')
    const row = await screen.findByTestId(`help-anchor-${errorCodeAnchor('E_EXPR_UNBOUNDED')}`)
    expect(row.textContent).toMatch(/E_EXPR_UNBOUNDED/)
    await waitFor(() => expect(row.classList.contains('help-anchor-target')).toBe(true))
    // the top-of-editor problem list carries the same link
    expect(screen.getByTestId('probe-routine-error-help-0')).toBeTruthy()
  })

  it.each([
    ['the X button', () => fireEvent.click(screen.getByTestId('help-center-close'))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['the backdrop', () => fireEvent.mouseDown(screen.getByTestId('help-center-backdrop'))],
  ])('closing Help with %s returns to the editor with the typed value intact', async (_how, close) => {
    mountEditorWithHelp()
    const typed = 'input.diameter / 2 - probe.tipRadiusMm + 0.25'
    editStepTwo(typed)
    fireEvent.click(screen.getByTestId('probe-routine-help'))
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    act(() => { close() })
    expect(helpCenter()).toBeNull()
    expect(useCamStore.getState().activeModal).toBeNull()
    expectEditorUntouched(typed)
  })
})

// --- Help from inside another modal -----------------------------------------
function makeStock(): Stock {
  return { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
function twoMoveOp(id: string, name: string): Operation {
  return makeOp({
    id, name, toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}
function makeSetup(id: string, name: string, fixtureOffset: number): Setup {
  return {
    id, name,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(),
    operations: [twoMoveOp(`${id}-op`, `${name} face`)],
    notes: 'Shop notes.',
  }
}
function makeProject(setups: Setup[], controller = 'uccnc'): Project {
  const project: Project = {
    id: 'p-ui', name: 'UI Part', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine({ controller } as never),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [], setups, activeSetupId: setups[0].id, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return project
}
const toggleInput = () =>
  screen.getByTestId('post-include-context-row').querySelector('input[type="checkbox"]') as HTMLInputElement

describe('WO-413: Help opened from inside a modal keeps that modal and its edits', () => {
  const originalProject = useCamStore.getState().project
  const originalToolLibrary = useCamStore.getState().toolLibrary
  afterEach(() => {
    useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
  })

  it('Post Process: flip the context toggle OFF, open Help from its link, close Help - the modal is still open and still OFF', async () => {
    const project = makeProject([makeSetup('s1', 'Setup One', 54)])
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary } as never) })
    render(
      <>
        <PostProcessModal />
        <HelpCenterModal />
      </>,
    )
    act(() => { useCamStore.getState().openModal('post-process') })
    expect(toggleInput().checked).toBe(true)
    act(() => { fireEvent.click(toggleInput()) })
    expect(toggleInput().checked).toBe(false)

    fireEvent.click(screen.getByTestId('post-include-context-help'))
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    // OVER the modal, not instead of it: activeModal is still post-process,
    // the modal is still in the DOM, and the Help backdrop is marked as an overlay
    expect(useCamStore.getState().activeModal).toBe('post-process')
    expect(useHelpOpen.getState().overlay).toBe(true)
    expect(screen.getByTestId('post-include-context-row')).toBeTruthy()
    expect(screen.getByTestId('help-center-backdrop').getAttribute('data-help-overlay')).toBe('true')
    expect(topicTitle()).toBe('Include LienCAM context')

    // Escape closes ONLY Help (the Post Process modal has its own Escape-to-close)
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(helpCenter()).toBeNull()
    expect(useCamStore.getState().activeModal).toBe('post-process')
    expect(screen.getByTestId('post-include-context-row')).toBeTruthy()
    expect(toggleInput().checked).toBe(false)

    // and the X path, for the same modal
    fireEvent.click(screen.getByTestId('post-include-context-help'))
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    fireEvent.click(screen.getByTestId('help-center-close'))
    expect(helpCenter()).toBeNull()
    expect(useCamStore.getState().activeModal).toBe('post-process')
    expect(toggleInput().checked).toBe(false)
  })
})

describe('WO-413: the generalized hotlink', () => {
  it('HelpLink opens Help at its topic from a plain panel, and a second link re-targets an open Help', async () => {
    render(
      <>
        <HelpLink topic="probing-tab" />
        <HelpLink topic="program-context" anchor="chip" />
        <HelpCenterModal />
      </>,
    )
    const first = screen.getByTestId('help-link-probing-tab')
    expect(first.getAttribute('aria-label')).toBe('Help: The Probing tab')
    fireEvent.click(first)
    await waitFor(() => expect(helpCenter()).toBeTruthy())
    expect(topicTitle()).toBe('The Probing tab')
    // the topic was not a context suggestion here, so the nav shows the full
    // index with Machine expanded and the topic row active
    expect(screen.getByTestId('help-topic-probing-tab').className).toMatch(/help-topic-button-active/)

    fireEvent.click(screen.getByTestId('help-link-program-context-chip'))
    await waitFor(() => expect(topicTitle()).toBe('Setup information on a loaded program'))
    const row = await screen.findByTestId('help-anchor-chip')
    await waitFor(() => expect(row.classList.contains('help-anchor-target')).toBe(true))
  })

  it('openHelpTopic with no modal open is the ordinary Help modal; with one open it is an overlay', () => {
    act(() => { openHelpTopic('probe-routines') })
    expect(useCamStore.getState().activeModal).toBe('help')
    expect(useHelpOpen.getState().overlay).toBe(false)
    act(() => { useCamStore.getState().closeModal() })

    act(() => { useCamStore.getState().openModal('settings') })
    act(() => { openHelpTopic('probe-routines', 'inputs') })
    expect(useCamStore.getState().activeModal).toBe('settings')
    expect(useHelpOpen.getState().overlay).toBe(true)
    expect(useHelpOpen.getState().requested).toMatchObject({ topicId: 'probe-routines', anchor: 'inputs' })
  })
})
