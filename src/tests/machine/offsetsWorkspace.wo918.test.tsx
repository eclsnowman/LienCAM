// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OffsetsPanel } from '../../components/machine/OffsetsPanel'
import {
  OffsetsWorkspace,
  pushStoredWorkOffset,
  storedWorkOffsetDiffers,
} from '../../components/machine/OffsetsWorkspace'
import { ControlPage } from '../../components/machine/ControlPage'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  machineWorkOffsetWriteInFlight,
  setWorkOffsetValue,
  WORK_OFFSET_WRITE_BUSY,
} from '../../lib/machine/machineSession'
import type { MachineController } from '../../lib/machine/controller'

type OffsetReceipt = {
  ok: boolean
  reason: string | null
  offset: { x: number; y: number; z: number } | null
}

let settleOutstanding: ((receipt: OffsetReceipt) => void) | null = null
let sessionConnected = false

function workspaceElement() {
  const machine = useCamStore.getState().project.machine
  return <OffsetsWorkspace machineId={machine.id} machineName={machine.name} />
}

beforeEach(() => {
  useCamStore.setState({ machineWorkOffsets: {} })
  useUiPrefs.setState({ machineOffsetsCollapsed: true })
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: 'G54',
    offsets: {},
    mpos: null,
    job: { ...state.job, phase: 'empty' },
    consoleLines: [],
  }))
})

afterEach(async () => {
  cleanup()
  if (settleOutstanding) {
    const settle = settleOutstanding
    settleOutstanding = null
    settle({ ok: false, reason: 'test cleanup', offset: null })
    await vi.waitFor(() => {
      const machineId = useCamStore.getState().project.machine.id
      expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false)
    })
  }
  if (sessionConnected) {
    await disconnectMachine()
    sessionConnected = false
  }
})

describe('WO-918 offsets setup workspace', () => {
  it('renders six rows and edits the same durable value the quick card reads while offline', () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(
      machineId,
      'G54',
      { x: 10, y: 20, z: -5 },
      'sent',
    )
    useMachineControl.setState({ offsets: { G54: [10, 20, -5] } })

    render(
      <>
        {workspaceElement()}
        <OffsetsPanel />
      </>,
    )

    for (const wcs of ['g54', 'g55', 'g56', 'g57', 'g58', 'g59']) {
      expect(screen.getByTestId(`offsets-workspace-row-${wcs}`)).toBeTruthy()
    }
    expect((screen.getByTestId('offsets-workspace-g54-x') as HTMLInputElement).value).toBe('10.00')
    expect((screen.getByTestId('offsets-workspace-g54-y') as HTMLInputElement).value).toBe('20.00')
    expect((screen.getByTestId('offsets-workspace-g54-z') as HTMLInputElement).value).toBe('-5.00')

    fireEvent.change(screen.getByTestId('offsets-workspace-g54-x'), { target: { value: '11' } })

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 11, y: 20, z: -5 },
      state: 'not-sent',
    })
    // WO-1182: no state column, no PC number - the marker attribute is the
    // only trace of sync state, on the field itself.
    expect(screen.queryByTestId('offsets-workspace-state-g54')).toBeNull()
    expect(screen.queryByTestId('control-offset-stored-g54-x')).toBeNull()
    expect(screen.getByTestId('offsets-workspace-g54-x').parentElement
      ?.hasAttribute('data-not-sent')).toBe(true)
    expect(screen.getByTestId('offsets-workspace').textContent).not.toContain('stored on this computer')
  })

  it('writes a fixture label per keystroke and keeps it through later offset receipts', () => {
    const machineId = useCamStore.getState().project.machine.id
    render(workspaceElement())

    fireEvent.change(screen.getByTestId('offsets-workspace-label-g55'), {
      target: { value: 'Left vise' },
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55).toEqual({
      label: 'Left vise',
      offset: {},
      state: 'unknown',
    })

    act(() => useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 7 }, 'sent'))
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55).toEqual({
      label: 'Left vise',
      offset: { x: 7 },
      state: 'sent',
    })
  })

  it('uses the existing action reasons while disconnected, streaming, and write-busy', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 1 }, 'not-sent')
    const { rerender } = render(workspaceElement())
    const push = () => screen.getByTestId('offsets-workspace-push-g54') as HTMLButtonElement

    expect(push().disabled).toBe(true)
    expect(push().getAttribute('data-tooltip')).toBe('Connect to a machine to push stored work offsets')

    act(() => useMachineControl.setState((state) => ({
      connectionPhase: 'connected',
      machineState: 'run',
      job: { ...state.job, phase: 'streaming' },
    })))
    expect(push().disabled).toBe(true)
    expect(push().getAttribute('data-tooltip')).toBe('Stop the program before changing work offsets')

    let settle!: (receipt: OffsetReceipt) => void
    const controller = {
      setWorkOffset: () => new Promise<OffsetReceipt>((resolve) => {
        settle = resolve
        settleOutstanding = resolve
      }),
      refreshState: vi.fn(),
    } as unknown as MachineController
    act(() => useMachineControl.setState((state) => ({
      connectionPhase: 'connected',
      machineState: 'idle',
      job: { ...state.job, phase: 'empty' },
    })))
    expect(setWorkOffsetValue('G54', 'X', 2, controller)).toBe(true)
    rerender(workspaceElement())

    expect(push().disabled).toBe(true)
    expect(push().getAttribute('data-tooltip')).toBe(WORK_OFFSET_WRITE_BUSY)

    await vi.waitFor(() => expect(typeof settle).toBe('function'))
    settleOutstanding = null
    await act(async () => {
      settle({ ok: true, reason: null, offset: { x: 2, y: 0, z: 0 } })
    })
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
  })

  it('pushes one whole row through the existing coalesced typed intent and marks its receipt sent', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffsetLabel(machineId, 'G56', 'Tombstone')
    useCamStore.getState().setMachineWorkOffset(
      machineId,
      'G56',
      { x: 10, y: -20, z: 3.5 },
      'not-sent',
    )
    const setWorkOffset = vi.fn(async (_wcs, offset) => ({
      ok: true,
      reason: null,
      offset: {
        x: offset.x ?? 0,
        y: offset.y ?? 0,
        z: offset.z ?? 0,
      },
    }))
    const controller = { setWorkOffset, refreshState: vi.fn() } as unknown as MachineController
    const stored = useCamStore.getState().machineWorkOffsets[machineId]?.G56

    expect(pushStoredWorkOffset(
      'G56',
      stored,
      (wcs, axis, value) => setWorkOffsetValue(wcs, axis, value, controller),
    )).toBe(true)

    await vi.waitFor(() => expect(setWorkOffset).toHaveBeenCalledTimes(1))
    expect(setWorkOffset).toHaveBeenCalledWith('G56', { x: 10, y: -20, z: 3.5 })
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G56).toEqual({
        label: 'Tombstone',
        offset: { x: 10, y: -20, z: 3.5 },
        state: 'sent',
      })
    })
  })

  it('selects only rows whose stored axes differ from the controller report', () => {
    expect(storedWorkOffsetDiffers(
      { offset: { x: 1, y: 2, z: 3 }, state: 'not-sent' },
      [1, 2, 3],
    )).toBe(false)
    expect(storedWorkOffsetDiffers(
      { offset: { x: 1, y: 2, z: 4 }, state: 'not-sent' },
      [1, 2, 3],
    )).toBe(true)
    expect(storedWorkOffsetDiffers(
      { label: 'Label only', offset: {}, state: 'unknown' },
      [0, 0, 0],
    )).toBe(false)
  })

  it('pushes only changed rows in sequence and sets a row from the current position', async () => {
    await connectMachine('simulator')
    sessionConnected = true
    __resetEstopInterlockForTest()
    const machineId = useCamStore.getState().project.machine.id
    const controller = getMachineController()
    const sendCommandAwait = vi.spyOn(controller, 'sendCommandAwait')
    const current = useMachineControl.getState()
    expect(current.connectionPhase).toBe('connected')
    expect(current.machineState).toBe('idle')
    expect(current.mpos).not.toBeNull()
    const liveG55 = current.offsets.G55 ?? [0, 0, 0]
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 10, y: 20, z: -5 }, 'not-sent')
    useCamStore.getState().setMachineWorkOffset(machineId, 'G55', {
      x: liveG55[0], y: liveG55[1], z: liveG55[2],
    }, 'not-sent')
    useCamStore.getState().setMachineWorkOffset(machineId, 'G57', { x: 30 }, 'not-sent')
    render(workspaceElement())

    fireEvent.click(screen.getByTestId('offsets-workspace-push-all'))
    await vi.waitFor(() => expect(sendCommandAwait).toHaveBeenCalledTimes(2))
    expect(sendCommandAwait.mock.calls.map(([line]) => line)).toEqual([
      'G10 L2 P1 X10 Y20 Z-5',
      'G10 L2 P4 X30',
    ])
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('sent')
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G57?.state).toBe('sent')
    })

    const at = useMachineControl.getState().mpos!
    fireEvent.click(screen.getByTestId('offsets-workspace-set-position-g56'))
    await vi.waitFor(() => expect(sendCommandAwait).toHaveBeenCalledTimes(3))
    expect(sendCommandAwait).toHaveBeenLastCalledWith(
      `G10 L2 P3 X${at.x} Y${at.y} Z${at.z}`,
    )
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G56).toEqual({
        offset: { x: at.x, y: at.y, z: at.z },
        state: 'sent',
      })
    })
  })

  it('leaves the durable row unchanged when set from position is refused', async () => {
    await connectMachine('simulator')
    sessionConnected = true
    __resetEstopInterlockForTest()
    const machineId = useCamStore.getState().project.machine.id
    const controller = getMachineController()
    const sendCommandAwait = vi.spyOn(controller, 'sendCommandAwait').mockResolvedValueOnce({
      ok: false,
      message: 'refused by fixture',
    })
    useCamStore.getState().setMachineWorkOffsetLabel(machineId, 'G56', 'Tombstone')
    useCamStore.getState().setMachineWorkOffset(
      machineId,
      'G56',
      { x: 10, y: -20, z: 3.5 },
      'not-sent',
    )
    render(workspaceElement())

    fireEvent.click(screen.getByTestId('offsets-workspace-set-position-g56'))

    await vi.waitFor(() => expect(sendCommandAwait).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G56).toEqual({
      label: 'Tombstone',
      offset: { x: 10, y: -20, z: 3.5 },
      state: 'not-sent',
    })
  })

  it('mounts the full workspace in the Offsets tab while Main keeps the quick card', () => {
    render(<ControlPage />)
    expect(screen.queryByTestId('offsets-workspace')).toBeNull()
    expect(screen.getByTestId('control-offsets-table')).toBeTruthy()

    fireEvent.click(screen.getByTestId('control-view-offsets'))

    expect(screen.getByTestId('offsets-workspace')).toBeTruthy()
    expect(screen.getByTestId('control-offsets-table').closest('.control-offsets-quick-card'))
      .toBeTruthy()
    expect((screen.getByTestId('control-page').querySelector('.control-columns') as HTMLElement)
      .hidden).toBe(true)
  })
})
