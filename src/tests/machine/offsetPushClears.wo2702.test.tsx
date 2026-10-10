// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OffsetsWorkspace, storedWorkOffsetDiffers } from '../../components/machine/OffsetsWorkspace'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController, machineWorkOffsetWriteInFlight } from '../../lib/machine/machineSession'

beforeEach(() => {
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState((s) => ({ offsets: {}, consoleLines: [], job: { ...s.job, phase: 'empty' } }))
})
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await disconnectMachine() })

describe('WO-2702 offset precision', () => {
  it('Set from position acknowledges the sent numbers and clears Push changed on the real simulator session', async () => {
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    const controller = getMachineController()
    const startX = useMachineControl.getState().mpos!.x
    expect(controller.jog('X', 1.234567, 6000)).toBe(true)
    await vi.waitFor(() => expect(controller.status().state).toBe('idle'))
    controller.queryStatus()
    await vi.waitFor(() => expect(useMachineControl.getState().mpos?.x).toBeCloseTo(startX + 1.234567, 6))
    const at = useMachineControl.getState().mpos!
    const rounded = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number(at[axis as 'x' | 'y' | 'z'].toFixed(4))]))
    const sent = vi.spyOn(controller, 'sendCommandAwait')
    const machine = useCamStore.getState().project.machine
    render(<OffsetsWorkspace machineId={machine.id} machineName={machine.name} />)
    fireEvent.click(screen.getByTestId('offsets-workspace-set-position-g54'))
    await act(async () => { await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machine.id)).toBe(false)) })
    expect(sent).toHaveBeenCalledWith(`G10 L2 P1 X${rounded.x} Y${rounded.y} Z${rounded.z}`)
    // The store keeps the operator's full-precision numbers (WO-2474: precision stays at the presentation
    // edge); only the comparison with the controller's 4-decimal readback is made at controller precision.
    const stored = useCamStore.getState().machineWorkOffsets[machine.id]?.G54
    expect(stored?.state).toBe('sent')
    for (const axis of ['x', 'y', 'z'] as const) expect(Number(stored!.offset[axis]!.toFixed(4))).toBe(rounded[axis])
    expect(useMachineControl.getState().offsets.G54?.[0]).toBe(rounded.x)
    expect(screen.getByTestId('offsets-workspace-push-all').textContent?.trim()).toBe('Push changed (0)')
  })

  it('compares a typed controller readback at four decimals without hiding a one-step change or missing axis', () => {
    const stored = { offset: { x: 1.234567 }, state: 'sent' as const }
    expect(storedWorkOffsetDiffers(stored, [1.2346, 0, 0])).toBe(false)
    expect(storedWorkOffsetDiffers(stored, [1.2345, 0, 0])).toBe(true)
    expect(storedWorkOffsetDiffers(stored, [])).toBe(true)
    expect(storedWorkOffsetDiffers(stored, undefined)).toBe(true)
    expect(stored.offset.x).toBe(1.234567)
  })
})
