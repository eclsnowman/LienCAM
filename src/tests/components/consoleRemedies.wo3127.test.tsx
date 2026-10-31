// @vitest-environment jsdom
//
// The owner rejected the ordinary Disconnect result while it was duplicated
// as a workspace fault card. Exercise the real simulator/session route and
// the mounted production Control workspace, not a hand-written job state.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import type { Project, ToolpathMove } from '../../types'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const session = await import('../../lib/machine/machineSession')

let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  originalProject = useCamStore.getState().project
  useUiPrefs.setState({ machineConsoleCollapsed: false })
  useCamStore.setState((state) => ({ project: {
    ...state.project,
    machine: makeMachine({ travel: { x: 600, y: 400, z: 100 }, homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    } }),
    setups: [{ id: 'setup1', name: 'Setup 1', notes: '',
      wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
      stock: makeStock({ material: 'aluminum' }),
      operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    }], activeSetupId: 'setup1',
  } }))
  const pending = session.connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  session.__resetEstopInterlockForTest()
  expect(session.getMachineController().home()).toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  const moves: ToolpathMove[] = Array.from({ length: 4096 }, (_, index) => ({
    type: index % 4000 === 0 ? 'rapid' : 'feed', x: 10, y: 5, z: 2, feed: 600,
  }))
  expect(session.loadGeometryProgram('console-remedies', moves, { opId: 'op1', setupId: 'setup1' }))
    .toEqual({ ok: true, reason: null })
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  const pending = session.disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  useCamStore.setState({ project: originalProject })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mountControl() {
  return render(<ControlPage />)
}

describe('WO-3127 ordinary Disconnect stays in the Control console', () => {
  it('renders the requested disconnect as an info console line, not a workspace fault overlay', async () => {
    mountControl()
    const controller = session.getMachineController()
    const disconnect = vi.spyOn(controller, 'disconnect')
    const stop = vi.spyOn(controller, 'stopJob')
    const start = vi.spyOn(controller, 'startJob')

    await act(async () => { await session.disconnectMachine() })

    const console = screen.getByTestId('control-console')
    expect(console.textContent).toContain('Program parts ended because the machine connection changed')
    expect(useMachineControl.getState().consoleLines.find((line) => (
      line.text.startsWith('Program parts ended because')
    ))).toMatchObject({ severity: 'info' })
    expect(screen.queryByTestId('control-job-error')).toBeNull()
    const state = useMachineControl.getState()
    expect(state.job.error).toMatchObject({ code: null, line: null, moveId: null })
    expect(state.programReadiness.ready).toBe(false)
    expect(state.connectionPhase).toBe('disconnected')
    expect(state.connectionKind).toBeNull()
    expect(session.programPartsTransportState()).toBeNull()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps a genuine transport fault as the actionable workspace overlay', async () => {
    mountControl()
    const controller = session.getMachineController()
    vi.spyOn(controller, 'disconnect').mockImplementation(async () => {
      session.buildContractEvents().onConnectionPhase?.('disconnected', 'USB transport failed')
    })

    await act(async () => { await session.disconnectMachine() })

    expect(useMachineControl.getState().consoleLines.find((line) => (
      line.text.startsWith('Program parts ended because')
    ))).toMatchObject({ severity: 'error' })
    expect(screen.getByTestId('control-job-error').textContent).toContain('USB transport failed')
  })

  it('does not let an older ordinary row hide a later unrequested disconnect fault', async () => {
    mountControl()

    await act(async () => { await session.disconnectMachine() })
    expect(screen.queryByTestId('control-job-error')).toBeNull()

    const reconnect = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await reconnect
    session.__resetEstopInterlockForTest()
    expect(session.getMachineController().home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    const moves: ToolpathMove[] = Array.from({ length: 4096 }, (_, index) => ({
      type: index % 4000 === 0 ? 'rapid' : 'feed', x: 10, y: 5, z: 2, feed: 600,
    }))
    expect(session.loadGeometryProgram('console-remedies-again', moves, { opId: 'op1', setupId: 'setup1' }))
      .toEqual({ ok: true, reason: null })

    await act(async () => {
      session.buildContractEvents().onConnectionPhase?.('disconnected', null)
    })

    expect(useMachineControl.getState().consoleLines.filter((line) => (
      line.text.startsWith('Program parts ended because')
    ))).toMatchObject([{ severity: 'info' }, { severity: 'error' }])
    const rows = useMachineControl.getState().consoleLines.filter((line) => (
      line.text.startsWith('Program parts ended because')
    ))
    expect(rows[0].text).toBe(rows[1].text)
    expect(screen.getByTestId('control-job-error').textContent).toContain('machine connection changed')
  })

  it('does not recreate the ordinary Disconnect overlay when console history is cleared', async () => {
    mountControl()

    await act(async () => { await session.disconnectMachine() })
    expect(screen.queryByTestId('control-job-error')).toBeNull()

    const fault = useMachineControl.getState().job.error
    await act(async () => { useMachineControl.getState().clearConsole() })

    expect(useMachineControl.getState().consoleLines).toEqual([])
    expect(useMachineControl.getState().job.error).toBe(fault)
    expect(screen.queryByTestId('control-job-error')).toBeNull()
  })
})
