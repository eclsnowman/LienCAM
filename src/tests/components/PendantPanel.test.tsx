// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendantPanel } from '../../components/machine/PendantPanel'
import { pendantBridge } from '../../lib/machine/pendantRuntime'
import { useMachineControl } from '../../store/machineControlStore'

describe('PendantPanel', () => {
  beforeEach(() => {
    pendantBridge.disable()
    act(() => useMachineControl.setState({ connectionPhase: 'disconnected', connectionKind: 'serial' }))
  })

  afterEach(() => {
    pendantBridge.disable()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    cleanup()
  })

  it('requires both a machine connection and the operator stay-by-machine acknowledgement', () => {
    render(<PendantPanel />)
    expect(screen.queryByTestId('pendant-enable')).toBeNull()
    fireEvent.click(screen.getByTestId('pendant-status-button'))
    const enable = screen.getByTestId('pendant-enable') as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    expect(screen.getByText(/physical E-stop within reach/i)).not.toBeNull()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(enable.disabled).toBe(true)

    act(() => useMachineControl.setState({ connectionPhase: 'connected' }))
    expect(enable.disabled).toBe(false)
  })

  it('labels the software action as disabling remote control, never as an E-stop', () => {
    render(<PendantPanel />)
    fireEvent.click(screen.getByTestId('pendant-status-button'))
    expect(screen.getByText('Enable remote control')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /e-stop/i })).toBeNull()
  })

  it('opens a right-docking overlay without adding a panel to the rail', () => {
    render(<PendantPanel />)
    const trigger = screen.getByTestId('pendant-status-button')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 80,
      top: 80,
      right: 140,
      bottom: 104,
      left: 20,
      width: 120,
      height: 24,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)

    const flyout = screen.getByRole('dialog', { name: 'Mobile pendant pairing' })
    expect(trigger.closest('.panel')).toBeNull()
    expect(flyout.classList.contains('pendant-popover')).toBe(true)
    expect(flyout.style.left).toBe('146px')
    expect(flyout.style.top).toBe('80px')
  })

  it('starts the local broker automatically when a connected simulator enables remote control', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      brokerUrl: 'ws://127.0.0.1:8324/bridge',
      port: 8324,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const enableBridge = vi.spyOn(pendantBridge, 'enable').mockImplementation(() => undefined)
    act(() => useMachineControl.setState({ connectionPhase: 'connected', connectionKind: 'simulator' }))

    render(<PendantPanel />)
    fireEvent.click(screen.getByTestId('pendant-status-button'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByTestId('pendant-enable'))

    await waitFor(() => expect(enableBridge).toHaveBeenCalledWith(
      'ws://127.0.0.1:8324/bridge',
      expect.stringMatching(/^[a-f0-9]{36}$/),
    ))
    expect(fetchMock).toHaveBeenCalledWith('/__liencam/pendant-broker/start', expect.objectContaining({
      method: 'POST',
      headers: { 'X-LienCAM-Host': 'pendant' },
    }))
  })
})
