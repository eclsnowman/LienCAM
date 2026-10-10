// @vitest-environment jsdom
//
// WO-1714 - a macro help screen with an examples library, opened from the
// macro editor's own Help button. Per the WO: Help opens from the editor;
// every name in MACRO_API has a section; every example passes
// checkMacroBody; inserting an example puts its body in the editor; jog
// keys do not jog while the help is open.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

type MachineMacro = import('../../types').MachineMacro
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MACRO_API, checkMacroBody, __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')
const { MACRO_EXAMPLES } = await import('../../lib/machine/macros/macroExamples')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { useControlJogKeys, dialogOpen } = await import('../../hooks/useControlJogKeys')

const LIGHTS: MachineMacro = { id: 'a', name: 'Lights', body: "line('M8')\nline('M9')" }

function selectMachine(macros: MachineMacro[] | undefined): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1714-macro-help',
    name: 'Macro help test bench',
    controller: 'grbl',
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    macros,
  })
}

function renderPanel(): void {
  render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
}

function openEditor(): void {
  fireEvent.click(screen.getByTestId('control-macros-edit'))
}

afterEach(() => {
  cleanup()
})

describe('WO-1714: macro help screen', () => {
  beforeEach(() => {
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine([LIGHTS])
  })

  it('opens from the editor and closes again', () => {
    renderPanel()
    openEditor()
    expect(screen.queryByTestId('macro-help-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    expect(screen.getByTestId('macro-help-panel')).toBeTruthy()
    fireEvent.click(screen.getByTestId('macro-help-close'))
    expect(screen.queryByTestId('macro-help-panel')).toBeNull()
  })

  it('every name in MACRO_API has a help section', () => {
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    for (const name of MACRO_API) {
      expect(screen.getByTestId(`macro-help-api-${name}`)).toBeTruthy()
    }
  })

  it('every example passes checkMacroBody', () => {
    expect(MACRO_EXAMPLES.length).toBeGreaterThan(0)
    for (const example of MACRO_EXAMPLES) {
      const result = checkMacroBody(example.body)
      expect(result.ok, `"${example.name}": ${result.ok ? 'ok' : `${result.message} (line ${result.line})`}`).toBe(true)
    }
  })

  it('inserting an example puts its body into the macro being edited', () => {
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lights' }))
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    const example = MACRO_EXAMPLES[0]
    fireEvent.click(screen.getByTestId(`macro-help-example-${example.id}-insert`))
    // Inserting closes Help and returns to the form showing the new body.
    expect(screen.queryByTestId('macro-help-panel')).toBeNull()
    expect((screen.getByTestId('macro-editor-body') as HTMLTextAreaElement).value).toBe(example.body)
  })

  it('inserting an example with no macro open starts a new one', () => {
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    const example = MACRO_EXAMPLES[1]
    fireEvent.click(screen.getByTestId(`macro-help-example-${example.id}-insert`))
    expect((screen.getByTestId('macro-editor-body') as HTMLTextAreaElement).value).toBe(example.body)
  })

  // Audit round 2 ("Help covers the Stop controls and the new wrapper clips
  // long macro lists"): a live measurement at 1680x900 found the modal
  // widened to 1040px while Help was open, covering the transport bar's
  // Stop/Reset and E-STOP controls, and a wrapper around the list only got
  // scroll styling while Help was open, clipping 30-macro lists with Help
  // closed. jsdom does not lay out real pixels, so these assertions pin the
  // structural facts that produced both defects instead: the modal's own
  // inline `width` (its only source of an inline width override) never
  // changes with Help, and the list/body container is never wrapped in an
  // extra element that could carry its own (possibly absent) overflow rule.
  //
  // (Fix rounds 2 and 3 also tried, in turn, to keep this modal off the
  // Control page's Stop/Reset and E-STOP controls entirely - anchoring,
  // measuring, and finally raising the controls above the dialog's own
  // backdrop. Operator overruled that 2026-09-19: covering those controls while
  // the editor is open is accepted - "no-one is editing macro definitions
  // during active cutting." The modal is back to a plain, unstyled inline
  // state - no width, no custom properties - relying only on
  // MacroEditor.css's ordinary centered `.macro-editor-modal` rule.)
  it('Help does not add an inline width to the modal, open or closed', () => {
    renderPanel()
    openEditor()
    const modal = screen.getByTestId('macro-editor-modal')
    expect(modal.style.width).toBe('')
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    expect(screen.getByTestId('macro-help-panel')).toBeTruthy()
    // Still no inline width on the modal itself - its width comes only from
    // the unchanging `.macro-editor-modal` CSS class, in every state.
    expect(modal.style.width).toBe('')
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    expect(modal.style.width).toBe('')
  })

  it('the list/body stays the modal\'s direct child - no wrapper appears when Help opens', () => {
    renderPanel()
    openEditor()
    const modal = screen.getByTestId('macro-editor-modal')
    const bodyClosed = modal.querySelector(':scope > .macro-editor-body')
    expect(bodyClosed).toBeTruthy()
    // The pre-WO scrolling box (`.macro-editor-body`, overflow-y: auto in
    // MacroEditor.css) carries no inline style of its own - its scroll
    // behaviour comes only from that class, so it cannot silently lose
    // scrolling in one state and not the other.
    expect((bodyClosed as HTMLElement).getAttribute('style')).toBeNull()

    fireEvent.click(screen.getByTestId('macro-editor-help'))
    // Same element, same direct-child relationship, still no inline style -
    // Help replaced this box's CONTENT, it did not wrap it in a new element.
    const bodyOpen = modal.querySelector(':scope > .macro-editor-body')
    expect(bodyOpen).toBe(bodyClosed)
    expect((bodyOpen as HTMLElement).getAttribute('style')).toBeNull()
    expect(screen.getByTestId('macro-help-panel').parentElement).toBe(bodyOpen)
  })

  it('the macro list keeps rendering inside .macro-editor-body with Help closed (long-list scroll path intact)', () => {
    const many: MachineMacro[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      name: `Macro ${i + 1}`,
      body: "line('M8')",
    }))
    selectMachine(many)
    renderPanel()
    openEditor()
    const modal = screen.getByTestId('macro-editor-modal')
    const body = modal.querySelector('.macro-editor-body') as HTMLElement
    expect(body).toBeTruthy()
    // Every macro is in the DOM inside the one scrolling container - nothing
    // clips them out at the React-tree level (a real-browser measurement,
    // not reachable from jsdom, confirms the pixel scroll separately).
    const list = screen.getByTestId('macro-editor-list')
    expect(body.contains(list)).toBe(true)
    expect(list.children.length).toBe(30)
    expect(screen.getByTestId('macro-editor-item-m29')).toBeTruthy()
  })
})

function ControlSurface() {
  useControlJogKeys()
  return <MacroPanel onOpenActions={() => {}} rpm={10000} />
}

async function connectedOnControl(): Promise<void> {
  useMachineActions.setState({ byMachine: {} })
  useCamStore.getState().newProject()
  selectMachine([LIGHTS])
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(50)
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  act(() => { useCamStore.getState().setWorkspace('control') })
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
}

describe('WO-1714: the help screen stops keyboard jog, same as every dialog', () => {
  afterEach(async () => {
    cleanup()
    __resetMacroRuntimeForTest()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('arrow keys do not jog while the macro editor or its help screen are open', async () => {
    vi.useFakeTimers()
    await connectedOnControl()
    const jog = vi.spyOn(getMachineController(), 'jog')
    render(<ControlSurface />)

    expect(dialogOpen()).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(jog).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('control-macros-edit'))
    expect(dialogOpen()).toBe(true)
    fireEvent.click(screen.getByTestId('macro-editor-help'))
    expect(screen.getByTestId('macro-help-panel')).toBeTruthy()
    expect(dialogOpen()).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'PageUp' })
    expect(jog).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(dialogOpen()).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(jog).toHaveBeenCalledTimes(2)
  })
})
