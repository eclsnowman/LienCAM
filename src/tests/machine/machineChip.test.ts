// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { deriveMachineChip, type MachineChipFacts } from '../../lib/machine/machineChip'
import type { MachineController } from '../../lib/machine/controller'
import { connectMachine, disconnectMachine, estopNeedsReset, getMachineController, pressEstop } from '../../lib/machine/machineSession'
import { TopToolbar } from '../../components/toolbar/TopToolbar'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'

function facts(overrides: Partial<MachineChipFacts> = {}): MachineChipFacts {
  return {
    connectionPhase: 'connected',
    machineState: 'idle',
    jobPhase: 'ready',
    datumResolver: {
      homedThisSession: vi.fn(() => true),
      homedAxesThisSession: vi.fn(() => ({ X: true, Y: true, Z: true })),
    },
    ...overrides,
  }
}

describe('WO-1153 machine header chip derivation', () => {
  it.each(['disconnected', 'connecting'] as const)(
    'renders offline throughout the %s connection threshold',
    (connectionPhase) => {
      expect(deriveMachineChip(facts({ connectionPhase, machineState: 'alarm', jobPhase: 'streaming' })))
        .toEqual({ state: 'offline', label: 'Offline' })
    },
  )

  it('renders alarm ahead of an active program', () => {
    expect(deriveMachineChip(facts({ machineState: 'alarm', jobPhase: 'streaming' })))
      .toEqual({ state: 'alarm', label: 'Alarm' })
  })

  it('WO-2609/WO-2611: reads Held at M0 and Feed Hold, retaining connection and alarm precedence', () => {
    expect(deriveMachineChip(facts({ jobPhase: 'paused', programM0Held: true })))
      .toEqual({ state: 'held', label: 'Held' })
    expect(deriveMachineChip(facts({ jobPhase: 'paused', machineState: 'hold' })))
      .toEqual({ state: 'held', label: 'Held' })
    expect(deriveMachineChip(facts({ programM0Held: true, connectionPhase: 'disconnected' })))
      .toEqual({ state: 'offline', label: 'Offline' })
    expect(deriveMachineChip(facts({ programM0Held: true, machineState: 'alarm' })))
      .toEqual({ state: 'alarm', label: 'Alarm' })
    const css = readFileSync('src/styles/app.css', 'utf8')
    expect(css).toMatch(/\.machine-status-chip\[data-state='held'\]\s*\{\s*color:\s*var\(--accent-amber\)/)
  })

  it.each([
    { machineState: 'run', jobPhase: 'ready' },
    { machineState: 'jog', jobPhase: 'ready' },
    { machineState: 'home', jobPhase: 'ready' },
    { machineState: 'idle', jobPhase: 'streaming' },
    { machineState: 'idle', jobPhase: 'paused' },
  ] as const)('renders running for live activity %#', ({ machineState, jobPhase }) => {
    expect(deriveMachineChip(facts({ machineState, jobPhase, datumResolver: null })))
      .toEqual({ state: 'running', label: 'Running' })
  })

  it('renders not-homed when any shared resolver axis is missing', () => {
    const datumResolver = {
      homedThisSession: vi.fn(() => true),
      homedAxesThisSession: vi.fn(() => ({ X: true, Y: true, Z: false })),
    }

    expect(deriveMachineChip(facts({ datumResolver })))
      .toEqual({ state: 'not-homed', label: 'Not homed' })
    expect(datumResolver.homedAxesThisSession).toHaveBeenCalledOnce()
  })

  it('fails closed to not-homed when no live datum resolver exists', () => {
    expect(deriveMachineChip(facts({ datumResolver: null })))
      .toEqual({ state: 'not-homed', label: 'Not homed' })
  })

  it('uses the shared resolver fallback for controllers without per-axis truth', () => {
    const datumResolver = { homedThisSession: vi.fn(() => false) }

    expect(deriveMachineChip(facts({ datumResolver })))
      .toEqual({ state: 'not-homed', label: 'Not homed' })
    expect(datumResolver.homedThisSession).toHaveBeenCalledOnce()
  })

  it('renders ready only when the shared resolver reports every gate axis homed', () => {
    expect(deriveMachineChip(facts())).toEqual({ state: 'ready', label: 'Ready' })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  cleanup()
  vi.useFakeTimers()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

/** WO-3190 (CT-2): connecting arms the software stop and the header chip reads
 * that latch as E-STOP. Clear it the operator's way - CLEAR (pressEstop) on the
 * connected simulator - before the test sets its own store facts. */
async function connectAndClear(): Promise<void> {
  vi.useFakeTimers()
  const connecting = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1000)
  await connecting
  const cleared = pressEstop()
  await vi.advanceTimersByTimeAsync(1500)
  expect(await cleared).toMatchObject({ ok: true })
  expect(estopNeedsReset()).toBe(false)
  vi.useRealTimers()
}

describe('WO-1153 shared header wiring', () => {
  it('repaints from homing changes while the shared resolver remains authoritative', async () => {
    await connectAndClear()
    const controller = getMachineController() as MachineController & Required<
      Pick<MachineController, 'homedAxesThisSession'>
    >
    const homedAxes = vi.spyOn(controller, 'homedAxesThisSession')
      .mockReturnValue({ X: true, Y: true, Z: true })
    const job = useMachineControl.getState().job

    useCamStore.setState({ workspace: 'cam' })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: false,
      job: { ...job, phase: 'ready' },
    })
    render(createElement(TopToolbar))

    const chip = screen.getByTestId('machine-status-chip')
    expect(chip.getAttribute('data-state')).toBe('ready')

    homedAxes.mockReturnValue({ X: false, Y: true, Z: true })
    act(() => useMachineControl.setState({ homed: true }))
    expect(chip.getAttribute('data-state')).toBe('not-homed')

    homedAxes.mockReturnValue({ X: true, Y: true, Z: true })
    act(() => useMachineControl.setState({ homed: false }))
    expect(chip.getAttribute('data-state')).toBe('ready')
  })

  it('renders the machine chip at the right end of the shared toolbar', () => {
    useCamStore.setState({ workspace: 'cam' })
    useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'unknown' })

    const { container } = render(createElement(TopToolbar))
    const right = container.querySelector('.toolbar-section-right')
    const chip = screen.getByTestId('machine-status-chip')

    expect(chip.parentElement).toBe(right)
    expect(right?.lastElementChild).toBe(chip)
    expect(chip.getAttribute('data-state')).toBe('offline')
    expect(chip.getAttribute('aria-label')).toBe('Machine status: Offline')
  })

  it('removes CAM undo and redo only in Control while keeping the chip', () => {
    useCamStore.setState({ workspace: 'cam' })
    useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'unknown' })
    render(createElement(TopToolbar))

    expect(screen.getByText('Undo')).toBeTruthy()
    expect(screen.getByText('Redo')).toBeTruthy()

    act(() => useCamStore.setState({ workspace: 'control' }))
    expect(screen.queryByText('Undo')).toBeNull()
    expect(screen.queryByText('Redo')).toBeNull()
    expect(screen.getByTestId('machine-status-chip')).toBeTruthy()

    act(() => useCamStore.setState({ workspace: 'part' }))
    expect(screen.getByText('Undo')).toBeTruthy()
    expect(screen.getByText('Redo')).toBeTruthy()
  })

  it('marks Control as the separately backed machine-end tab', () => {
    useCamStore.setState({ workspace: 'cam' })
    useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'unknown' })
    render(createElement(TopToolbar))

    expect(screen.getByTestId('mode-tab-control').className).toContain('mode-tab-machine-end')
    expect(screen.getByTestId('mode-tab-setup').className).not.toContain('mode-tab-machine-end')
  })

  it('keeps labels through 1600px and switches to marks below that threshold', () => {
    const css = readFileSync('src/styles/app.css', 'utf8')
    expect(css).toMatch(
      /@media \(max-width: 1599px\)[\s\S]*?\.machine-status-label\s*\{\s*display:\s*none;/,
    )
    expect(css).not.toMatch(/@media \(max-width: 1600px\)[\s\S]*?\.machine-status-label/)
  })
})
