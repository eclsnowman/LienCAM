// @vitest-environment jsdom
//
// WO-1801: the Jog Step mode chip gets a stable data-testid so automation can
// select it apart from the program single-block Step button - both print the
// word "Step", which is the ambiguity the machine session closed on. This is
// a test-hook order: the proofs below pin the hook resolving to EXACTLY the
// jog mode control, the Continuous sibling keeping its existing id, clicking
// a mode chip moving ONLY the existing uiPrefs value, and NO jog command
// ever leaving the panel on a mode selection. The default mode stays Step
// (machineJogContinuous: false) - the session's "Continuous is current
// default" observation is explicitly NOT authorization to change it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { ControlStepRow } = await import('../../components/machine/ControlTransportBar')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { getMachineController, __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')

/** Every verb on the controller that could move the machine in jog. */
function spyMotionVerbs(): Record<string, MockInstance> {
  const ctrl = getMachineController() as unknown as Record<string, (...args: never[]) => unknown>
  const spies: Record<string, MockInstance> = {}
  for (const name of ['jog', 'jogCancel', 'jogStartContinuous', 'jogHold', 'jogStop']) {
    if (typeof ctrl[name] === 'function') spies[name] = vi.spyOn(ctrl, name)
  }
  return spies
}

function expectNoMotion(spies: Record<string, MockInstance>): void {
  for (const [name, spy] of Object.entries(spies)) {
    expect(spy, `selecting a jog mode must never emit ${name}()`).not.toHaveBeenCalled()
  }
}

describe('WO-1801 jog step-mode selector test hook', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    // Same treatment as the wedge-routing suite: the E-STOP latch starts
    // armed and would grey out every jog button, making a "no jog emitted"
    // proof vacuous. Reset it so the buttons are genuinely live.
    __resetEstopInterlockForTest()
    useUiPrefs.setState({
      machineJogContinuous: false,
      machineJogStepMm: 1,
      machineJogFeedMmMin: 1000,
      machineDisplayUnits: 'mm',
      collapsedPropsGroups: {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('resolves the exact id to ONLY the jog Step chip, paired with Continuous', () => {
    render(<JogPanel />)
    const stepChip = screen.getByTestId('control-jog-step-mode')
    expect(stepChip.tagName).toBe('BUTTON')
    expect(stepChip.textContent).toBe('Step')
    expect(screen.getAllByTestId('control-jog-step-mode')).toHaveLength(1)
    // The existing Continuous selector is untouched and shares the config row.
    const contChip = screen.getByTestId('control-jog-continuous')
    expect(contChip.textContent).toBe('Cont')
    expect(stepChip.parentElement).toBe(contChip.parentElement)
  })

  it('separates the jog Step chip from the program single-block Step button', () => {
    render(
      <>
        <JogPanel />
        <ControlStepRow />
      </>,
    )
    const stepChip = screen.getByTestId('control-jog-step-mode')
    const programStep = screen.getByTestId('control-step-forward')
    // Both controls print the word "Step" - the ambiguity this hook resolves.
    expect(stepChip.textContent).toBe('Step')
    expect(programStep.textContent?.trim()).toBe('Step')
    expect(stepChip).not.toBe(programStep)
    // Each stays in its own row: the jog config row and the transport step row.
    expect(stepChip.closest('.control-jog-config-row')).not.toBeNull()
    expect(programStep.closest('.control-uix-steprow')).not.toBeNull()
    expect(screen.getAllByText('Step').length).toBeGreaterThanOrEqual(2)
  })

  it('clicking a mode chip changes ONLY the existing pref and emits no jog command', () => {
    const spies = spyMotionVerbs()
    render(<JogPanel />)

    // Step -> Continuous and back: each click moves exactly one pref.
    fireEvent.click(screen.getByTestId('control-jog-continuous'))
    expect(useUiPrefs.getState().machineJogContinuous).toBe(true)
    expectNoMotion(spies)

    fireEvent.click(screen.getByTestId('control-jog-step-mode'))
    expect(useUiPrefs.getState().machineJogContinuous).toBe(false)
    expectNoMotion(spies)

    // Stepsizes and feed survive the mode selection untouched.
    expect(useUiPrefs.getState().machineJogStepMm).toBe(1)
    expect(useUiPrefs.getState().machineJogFeedMmMin).toBe(1000)
  })

  it('keeps the step-mode press handler live after selecting Step by the new id', () => {
    const spies = spyMotionVerbs()
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-jog-step-mode'))
    expectNoMotion(spies)

    // A real press still jogs once per click with the configured step/feed:
    // the hook did not disturb the pointer handlers or the step path.
    fireEvent.pointerDown(screen.getByTestId('control-jog-y-plus'))
    expect(spies.jog).toHaveBeenCalledTimes(1)
    expect(spies.jog).toHaveBeenLastCalledWith('Y', 1, 1000)
    fireEvent.pointerUp(screen.getByTestId('control-jog-y-plus'))
  })

  it('preserves the default mode: source still defaults to Step, not Continuous', () => {
    const uiPrefsSrc = readFileSync('src/store/uiPrefs.ts', 'utf8')
    expect(uiPrefsSrc).toMatch(/machineJogContinuous:\s*false/)
  })
})
