// @vitest-environment jsdom
//
// REGRESSION guard for the bug: "clicking into a numeric field puts the cursor
// where I click instead of selecting the whole value to type over."
//
// ROOT CAUSE (fixed): the shared NumericInput (src/components/ui/NumericInput.tsx)
// used to render <input type="number"> and call e.target.select() on focus. Per
// the HTML spec the text-selection APIs (select / selectionStart / selectionEnd /
// setSelectionRange) DO NOT APPLY to number inputs, so select() was a silent
// no-op and the caret just landed where you clicked.
//
// THE FIX: NumericInput now renders <input type="text" inputMode="decimal"> (the
// same idiom as the working SketchDrawValueInput) and selects the whole value on
// focus (plus a one-shot re-select on the first mouseUp to survive the click
// caret reset). resolveNumericDraft still validates/clamps, so native number
// validation is not needed.
//
// GATE NOTE: jsdom models selection ranges on TEXT inputs, so the range assertion
// below is meaningful now (it was impossible on a number input). The real-browser
// caret behavior is still the ultimate visual gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { NumericInput } from '../../components/ui/NumericInput'
import {
  useSelectAllOnClick, attachSelectAllOnClick,
} from '../../components/ui/selectAllOnClick'
import { useTypeToSet } from '../../components/ui/useTypeToSet'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { loadMachineProgram } = await import('../../lib/machine/machineSession')
const { parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { machineSafeZ, withMachineSafeZ, createDefaultControllerDefinition } = await import('../../types')

afterEach(cleanup)

describe('NumericInput select-on-focus (regression)', () => {
  it('renders a text input with inputMode="decimal" (not type="number")', () => {
    const { container } = render(<NumericInput value={2.5} onChange={() => {}} />)
    const input = container.querySelector('input') as HTMLInputElement
    expect(input).not.toBeNull()
    // The fix: a TEXT input so text-selection APIs actually apply.
    expect(input.type).toBe('text')
    expect(input.inputMode).toBe('decimal')
  })

  it('focusing NumericInput selects the whole value', () => {
    const { container } = render(<NumericInput value={2.5} onChange={() => {}} />)
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.focus(input)

    // Select-on-focus works now: the WHOLE value is highlighted so the next
    // keystroke overwrites it. On the old number input selectionStart/End were
    // null and this was impossible.
    expect(input.value.length).toBeGreaterThan(0)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('re-selects on the first mouseUp after a click focus', () => {
    const { container } = render(<NumericInput value={12.5} onChange={() => {}} />)
    const input = container.querySelector('input') as HTMLInputElement

    // Simulate a click landing a caret mid-value, then the focus+mouseUp cycle.
    fireEvent.focus(input)
    // Collapse the selection to a caret as a real click would on mouseDown.
    input.setSelectionRange(2, 2)
    fireEvent.mouseUp(input)

    // The one-shot mouseUp guard should have re-selected the whole value.
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })
})

// ---- Shared helper: useSelectAllOnClick (the extracted contract) ----------
//
// The critical path that KILLED the bespoke fixes: a field that is
// PROGRAMMATICALLY focused (auto-opened editor). The user's first click into
// it fires NO focus event, so the one-shot flag must be armable WITHOUT a
// focus event — arm() from the same effect that calls focus(). This harness
// deliberately attaches NO onFocus handler so only arm() can arm the flag.
function AutoFocusedHarness() {
  const sel = useSelectAllOnClick()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    sel.arm(ref.current) // the DimValueInput mount-effect pattern
  }, [sel])
  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      defaultValue="123.45"
      onMouseUp={sel.onMouseUp}
    />
  )
}

describe('useSelectAllOnClick: armed-by-PROGRAMMATIC-focus path', () => {
  it('arm() in the mount effect selects the whole value without a focus event', () => {
    const { container } = render(<AutoFocusedHarness />)
    const input = container.querySelector('input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('first CLICK into the auto-focused field re-selects all and prevents the caret drop', () => {
    const { container } = render(<AutoFocusedHarness />)
    const input = container.querySelector('input') as HTMLInputElement

    // A user click on an already-focused field: mousedown collapses the
    // selection to a caret (no focus event fires — the field is focused).
    fireEvent.mouseDown(input)
    input.setSelectionRange(2, 2)
    const notPrevented = fireEvent.mouseUp(input)

    // The armed one-shot consumed: preventDefault() was called on that
    // mouseUp (fireEvent returns false when default was prevented) and the
    // whole value is selected again (Chrome-URL-bar feel).
    expect(notPrevented).toBe(false)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('SECOND click places the caret (flag consumed: no select, no preventDefault)', () => {
    const { container } = render(<AutoFocusedHarness />)
    const input = container.querySelector('input') as HTMLInputElement

    // First click consumes the one-shot.
    fireEvent.mouseUp(input)
    // Second click: caret lands where clicked and STAYS there.
    input.setSelectionRange(3, 3)
    const notPrevented = fireEvent.mouseUp(input)

    expect(notPrevented).toBe(true)
    expect(input.selectionStart).toBe(3)
    expect(input.selectionEnd).toBe(3)
  })

  it('the second click of a double-click leaves the browser caret in place', () => {
    const { container } = render(<AutoFocusedHarness />)
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.mouseUp(input, { detail: 1 }) // first click consumes the arm
    input.setSelectionRange(4, 4)
    fireEvent.mouseUp(input, { detail: 2 })
    fireEvent.doubleClick(input, { detail: 2 })

    expect(input.selectionStart).toBe(4)
    expect(input.selectionEnd).toBe(4)
  })
})

function TypeToSetHarness({ enabled }: { enabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('12.5')
  useTypeToSet(inputRef, { enabled })
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
    />
  )
}

describe('useTypeToSet', () => {
  it('seeds and focuses the primary input when enabled', async () => {
    const { container } = render(<TypeToSetHarness enabled />)
    const input = container.querySelector('input') as HTMLInputElement

    await act(async () => {
      fireEvent.keyDown(window, { key: '7' })
      await Promise.resolve()
    })

    expect(input.value).toBe('7')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(1)
  })

  it('does nothing when disabled', () => {
    const { container } = render(<TypeToSetHarness enabled={false} />)
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.keyDown(window, { key: '7' })

    expect(input.value).toBe('12.5')
    expect(document.activeElement).not.toBe(input)
  })

  it('claims sketch digits before later window shortcut listeners', () => {
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    try {
      const { container } = render(<TypeToSetHarness enabled />)
      const input = container.querySelector('input') as HTMLInputElement

      fireEvent.keyDown(window, { key: '1' })

      expect(input.value).toBe('1')
      expect(shortcut).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', shortcut)
    }
  })
})

// ---- Shared helper: attachSelectAllOnClick (plain-DOM flavor) --------------
// Consumed by CNCViewport's raw slice-plane Z input (#sp-z-input), which is
// built via innerHTML — no React. Same contract via addEventListener.
describe('attachSelectAllOnClick (plain DOM, CNCViewport raw input)', () => {
  function makeInput(): HTMLInputElement {
    const el = document.createElement('input')
    el.type = 'text'
    el.value = '42.5'
    document.body.appendChild(el)
    return el
  }
  afterEach(() => { document.body.innerHTML = '' })

  it('focus selects all; the paired mouseUp re-selects and preventDefaults', () => {
    const el = makeInput()
    attachSelectAllOnClick(el)

    el.dispatchEvent(new FocusEvent('focus'))
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(el.value.length)

    // Click caret collapse, then the mouseUp of the same click gesture.
    el.setSelectionRange(1, 1)
    const up = new MouseEvent('mouseup', { bubbles: true, cancelable: true })
    el.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(true)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(el.value.length)
  })

  it('one-shot: a second mouseUp keeps the caret; arm() re-arms; detach() disables', () => {
    const el = makeInput()
    const { arm, detach } = attachSelectAllOnClick(el)

    el.dispatchEvent(new FocusEvent('focus'))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    // Flag consumed: the second click's caret survives.
    el.setSelectionRange(2, 2)
    const up2 = new MouseEvent('mouseup', { bubbles: true, cancelable: true })
    el.dispatchEvent(up2)
    expect(up2.defaultPrevented).toBe(false)
    expect(el.selectionStart).toBe(2)
    expect(el.selectionEnd).toBe(2)

    // arm() (programmatic-focus case) re-enables the one-shot.
    arm()
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(el.value.length)
    el.setSelectionRange(1, 1)
    const up3 = new MouseEvent('mouseup', { bubbles: true, cancelable: true })
    el.dispatchEvent(up3)
    expect(up3.defaultPrevented).toBe(true)
    expect(el.selectionEnd).toBe(el.value.length)

    // detach() removes both listeners.
    detach()
    el.setSelectionRange(1, 1)
    el.dispatchEvent(new FocusEvent('focus'))
    expect(el.selectionStart).toBe(1) // no select-on-focus anymore
  })
})

function expectTypeOverPointerContract(input: HTMLInputElement) {
  expect(input.type).toBe('text')
  expect(['decimal', 'numeric']).toContain(input.inputMode)
  expect(input.value.length).toBeGreaterThan(0)

  fireEvent.focus(input)
  input.setSelectionRange(1, 1)
  const firstMouseUp = fireEvent.mouseUp(input, { detail: 1 })
  expect(firstMouseUp).toBe(false)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(input.value.length)

  input.setSelectionRange(1, 1)
  fireEvent.mouseUp(input, { detail: 2 })
  fireEvent.doubleClick(input, { detail: 2 })
  expect(input.selectionStart).toBe(1)
  expect(input.selectionEnd).toBe(1)
}

function enterEdit(input: HTMLInputElement, value: string) {
  input.focus()
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

function escapeEdit(input: HTMLInputElement, value: string) {
  input.focus()
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Escape' })
}

describe('machine numeric-entry consumers', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      activeWcs: 'G54',
      offsets: { G54: [1, 2, 3] },
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
    useUiPrefs.setState({
      machineDisplayUnits: 'mm',
      collapsedPropsGroups: {},
      machineJogFeedMmMin: 1000,
      machineOffsetsCollapsed: false,
      machineSpindleRpm: 10000,
    })
  })

  it('JogPanel selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    const { container } = render(<JogPanel />)
    const getInput = () => container.querySelector('.control-jog-feed') as HTMLInputElement
    expectTypeOverPointerContract(getInput())

    enterEdit(getInput(), '1000.0')
    expect(getInput().value).toBe('1000')
    expect(useUiPrefs.getState().machineJogFeedMmMin).toBe(1000)
    enterEdit(getInput(), '1500')
    expect(useUiPrefs.getState().machineJogFeedMmMin).toBe(1500)
    escapeEdit(getInput(), '1700')
    expect(useUiPrefs.getState().machineJogFeedMmMin).toBe(1500)
    expect(getInput().value).toBe('1500')
  })

  it('SpindlePanel selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const getInput = () => container.querySelector('.control-rpm-input') as HTMLInputElement
    expectTypeOverPointerContract(getInput())

    enterEdit(getInput(), '10000.0')
    expect(getInput().value).toBe('10000')
    expect(useUiPrefs.getState().machineSpindleRpm).toBe(10000)
    enterEdit(getInput(), '12000')
    expect(useUiPrefs.getState().machineSpindleRpm).toBe(12000)
    escapeEdit(getInput(), '14000')
    expect(useUiPrefs.getState().machineSpindleRpm).toBe(12000)
    expect(getInput().value).toBe('12000')
  })

  it('ProgramPanel selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    act(() => loadMachineProgram('numeric.nc', ['G21', 'G0 X0', 'G1 X1'].join('\n')))
    render(<ProgramPanel />)
    const getInput = () => screen.getByTestId('control-runfrom-input') as HTMLInputElement

    enterEdit(getInput(), '2')
    expect((screen.getByTestId('control-runfrom-plan') as HTMLButtonElement).disabled).toBe(false)
    expectTypeOverPointerContract(getInput())
    escapeEdit(getInput(), '3')
    expect(getInput().value).toBe('2')
  })

  it('OffsetsPanel selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    render(<OffsetsPanel />)
    const getInput = () => screen.getByTestId('control-offset-g54-x') as HTMLInputElement
    expectTypeOverPointerContract(getInput())

    enterEdit(getInput(), '1')
    expect(getInput().value).toBe('1.00')
    // A changed offset is receipt-driven and the panel disables while the
    // bridge answers. This select-on-focus test only needs the editable draft;
    // do not pretend an unacknowledged machine write became the shown value.
    getInput().focus()
    fireEvent.change(getInput(), { target: { value: '7' } })
    expect(getInput().value).toBe('7')
    escapeEdit(getInput(), '9')
    expect(getInput().value).toBe('1.00')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(getInput().value).toBe('0.039')
    expectTypeOverPointerContract(getInput())
    escapeEdit(getInput(), '9')
    expect(getInput().value).toBe('0.039')
    expect(useMachineControl.getState().offsets.G54).toEqual([1, 2, 3])
  })

  it('ToolsProbePanel selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    render(<ToolsProbePanel />)
    const getInput = () => screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement
    expectTypeOverPointerContract(getInput())

    enterEdit(getInput(), '12.7')
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    expect(useMachineToolTable.getState().probeConfigFor(machineId).padThickness).toBeCloseTo(12.7, 3)
    escapeEdit(getInput(), '15')
    expect(useMachineToolTable.getState().probeConfigFor(machineId).padThickness).toBeCloseTo(12.7, 3)
    expect(getInput().value).toBe('12.70')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(getInput().value).toBe('0.500')
    expectTypeOverPointerContract(getInput())
    enterEdit(getInput(), '1')
    expect(getInput().value).toBe('1.000')
    expect(useMachineToolTable.getState().probeConfigFor(machineId).padThickness).toBeCloseTo(25.4, 6)
    escapeEdit(getInput(), '2')
    expect(getInput().value).toBe('1.000')
  })

  it('MachineArea (Machine tab) Safe Z selects on first click, preserves the double-click caret, and commits or cancels keys', () => {
    // WO-1670: safe Z lives on the machine record, not beside the wiring.
    // WO-1710: its one editor is the Machine tab, not Machine actions.
    const base = useCamStore.getState().project.machine
    const machine = {
      ...base,
      id: 'wo1710-numeric-select',
      controller: 'grbl' as const,
      controllerDefinition: createDefaultControllerDefinition(),
    }
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
      })
    })
    const safeZ = () => machineSafeZ(parkCarrierMachine(useCamStore.getState()))?.z
    saveParkMachineRecord(withMachineSafeZ(parkCarrierMachine(useCamStore.getState()), 5))
    render(<MachineDefinitionPanel />)
    act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-machine')) })
    const getInput = () => screen.getByLabelText('Safe Z') as HTMLInputElement
    expectTypeOverPointerContract(getInput())

    enterEdit(getInput(), '8')
    // The definition panel edits a draft; Save is what writes it to the
    // record (same two-store write as saveParkMachineRecord - see commit()
    // in useMachineDefinitionPanel.tsx).
    act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) })
    expect(safeZ()).toBe(8)
    escapeEdit(getInput(), '10')
    expect(safeZ()).toBe(8)
    expect(getInput().value).toBe('8')
  })
})
