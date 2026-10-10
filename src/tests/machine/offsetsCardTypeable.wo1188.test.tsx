// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OffsetsPanel } from '../../components/machine/OffsetsPanel'
import { OffsetsWorkspace } from '../../components/machine/OffsetsWorkspace'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'

beforeEach(() => {
  useCamStore.setState({ machineWorkOffsets: {} })
  useUiPrefs.setState({ machineOffsetsCollapsed: true })
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: 'G54',
    // The disconnect reducer clears live controller readback. This is the
    // actual card state Operator opens, rather than a controller-only test seed.
    offsets: {},
    mpos: null,
    job: { ...state.job, phase: 'empty' },
  }))
})

afterEach(() => cleanup())

describe('WO-1188 work offsets card editing', () => {
  it('keeps disconnected readback unknown while workspace edits remain durable', () => {
    const machine = useCamStore.getState().project.machine
    const view = render(
      <>
        <OffsetsPanel />
        <OffsetsWorkspace machineId={machine.id} machineName={machine.name} />
      </>,
    )

    expect(screen.queryByTestId('control-offset-g54-x')).toBeNull()
    expect(screen.getByTestId('control-offsets-table').textContent).toContain('G54')
    expect(screen.getByTestId('control-offsets-table').textContent).not.toContain('WCS?')
    expect(screen.getByTestId('control-offsets-table').textContent).toContain('G54---')
    const workspaceX = screen.getByTestId('offsets-workspace-g54-x') as HTMLInputElement
    fireEvent.change(workspaceX, { target: { value: '12.5' } })
    fireEvent.blur(workspaceX)

    expect(useCamStore.getState().machineWorkOffsets[machine.id]?.G54).toEqual({
      offset: { x: 12.5 },
      state: 'not-sent',
    })
    expect((screen.getByTestId('offsets-workspace-g54-x') as HTMLInputElement).value).toBe('12.50')
    expect((screen.getByTestId('offsets-workspace-push-g54') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('offsets-workspace-set-position-g54') as HTMLButtonElement).disabled).toBe(true)

    // The durable workspace survives a remount while the disconnected status
    // card continues to avoid presenting it as controller readback.
    view.unmount()
    render(<>
      <OffsetsPanel />
      <OffsetsWorkspace machineId={machine.id} machineName={machine.name} />
    </>)
    expect(screen.queryByTestId('control-offset-g54-x')).toBeNull()
    expect((screen.getByTestId('offsets-workspace-g54-x') as HTMLInputElement).value).toBe('12.50')
  })
})
