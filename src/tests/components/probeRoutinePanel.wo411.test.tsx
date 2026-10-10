// WO-411 slice 3 - the Run panel in the Routines tab: tick -> Run -> proposal
// -> Confirm. Proves Confirm is the ONLY writer (no G10 before the press), the
// tick is per preview, and a stale preview cannot run.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import { useMachineControl } from '../../store/machineControlStore'
import type { CommandAck } from '../../lib/machine/grbl/controller'
import type { JogAxis, MachineController } from '../../lib/machine/controller'

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
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')
const session = await import('../../lib/machine/machineSession')

const ACK: CommandAck = { ok: true, code: 0, message: 'ok' }
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
let machinePos = { ...START }
let wire: string[] = []

function mount(units: 'mm' | 'inch' = 'mm') {
  return render(
    <ProbeRoutineEditor
      start={START}
      envelopeStatus="homed"
      envelope={envelope}
      probe={probe}
      tipRadiusMm={1.5}
      axisLimits={null}
      activeWcs="G54"
      // WO-2065: the Bore works from its top; the Routines tab fills it from work Z0 (WO-2074)
      workZeroMachineZ={25}
      units={units}
      defaultOpen
    />,
  )
}

function connectedIdleController() {
  const ctrl = session.getMachineController()
  const baseStatus = ctrl.status()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
  vi.spyOn(
    ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
    'homedAxesThisSession',
  ).mockReturnValue({ X: true, Y: true, Z: true })
  vi.spyOn(ctrl, 'sendCommand').mockImplementation((line) => {
    wire.push(`TEXT ${line}`)
    return true
  })
  vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line) => {
    wire.push(`TEXT-AWAIT ${line}`)
    return Promise.resolve(ACK)
  })
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  // The runner settles to Idle after every queued move (WO-416 race fix).
  vi.spyOn(ctrl, 'queryStatus').mockReturnValue(undefined)
  vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
  vi.spyOn(ctrl, 'status').mockImplementation(() => ({
    ...baseStatus,
    state: 'idle',
    machinePos: { ...machinePos },
    workPos: { ...machinePos },
  }))
  vi.spyOn(ctrl, 'jogToWorkXY').mockImplementation((x, y, feed) => {
    wire.push(`jogToWorkXY(${x},${y},${feed})`)
    machinePos = { ...machinePos, x, y }
    return true
  })
  vi.spyOn(ctrl, 'jogToMachineZ').mockImplementation((z, feed) => {
    wire.push(`jogToMachineZ(${z},${feed})`)
    machinePos = { ...machinePos, z }
    return true
  })
  vi.spyOn(ctrl, 'jog').mockImplementation((axis, delta, feed) => {
    wire.push(`jog(${axis},${delta},${feed})`)
    const key = axis.toLowerCase() as 'x' | 'y' | 'z'
    machinePos = { ...machinePos, [key]: machinePos[key] + delta }
    return true
  })
  return ctrl
}

/** Walls 2 mm into every search (bore diameter 40 about START). */
function fakeWalls() {
  const contacts: Array<[number, number, number]> = [[84.5, 100, 40], [115.5, 100, 40], [100, 84.5, 40], [100, 115.5, 40]]
  let pass = 0
  vi.spyOn(session.getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
    wire.push(`probe(${axis},${target},${feed})`)
    const values = contacts[Math.floor(pass++ / 2)] ?? [0, 0, 0]
    machinePos = { x: values[0], y: values[1], z: values[2] }
    return { ok: true, at: { ...machinePos } }
  })
  return wire
}

const pick = (id: string) => fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: id } })
const check = () => fireEvent.click(screen.getByTestId('probe-routine-check'))
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } })

beforeEach(() => {
  mem.clear()
  session.__resetEstopInterlockForTest()
  useMachineControl.setState({
    probe: null,
    activeWcs: 'G54',
    offsets: { G54: [0, 0, 0] },
  })
  machinePos = { ...START }
  wire = []
  connectedIdleController()
  act(() => { useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] }) })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-411 slice 3 - Run in the Routines tab', () => {
  it('shows three decimals in inch proposals while keeping the offset values in mm', async () => {
    fakeWalls()
    const write = vi.spyOn(session, 'setWorkOffsetValue').mockReturnValue(true)
    mount('inch')
    pick('factory.bore-centre')
    // The custom-routine parameter editor takes canonical mm in either display mode.
    type('probe-routine-input-value-diameter', '40')
    check()
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
    await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy(), { timeout: 5_000 })
    const proposals = screen.getAllByTestId('probe-routine-run-proposal')
    expect(proposals[0].textContent).toContain('G54: X = 3.937 in, Y = 3.937 in')
    expect(proposals[1].textContent).toContain('Diameter (X): 1.339 in')
    expect(write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('probe-routine-confirm-offset'))
    expect(write).toHaveBeenCalledWith('G54', 'X', 100)
    expect(write).toHaveBeenCalledWith('G54', 'Y', 100)
  })
  it('Run is absent until Check; after Check the path-clear tick gates Run', () => {
    mount()
    pick('factory.bore-centre')
    expect(screen.queryByTestId('probe-routine-run-panel')).toBeNull()
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(true)
    check()
    expect(screen.getByTestId('probe-routine-run-panel')).toBeTruthy()
    const run = screen.getByTestId('probe-routine-run') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    expect(run.disabled).toBe(false)
  })

  it('tick -> Run puts the bore on the wire, shows the proposal, and writes NOTHING until Confirm; Confirm writes through setWorkOffsetValue', async () => {
    const lines = fakeWalls()
    const write = vi.spyOn(session, 'setWorkOffsetValue').mockReturnValue(true)
    mount()
    pick('factory.bore-centre')
    type('probe-routine-input-value-diameter', '40')
    check()
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
    await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy(), { timeout: 5_000 })

    // WO-2065: first the descent to probing depth (top 25 - depth 5), a G38.3 probe move on this
    // text controller; then the four walls; then the rise to top + clearance and the modal restore
    expect(lines[0]).toBe('TEXT-AWAIT G21 G91 G38.3 Z-20 F300')
    // WO-2554: the first wall approach is a guarded seek, independent of nominal size.
    expect(lines[1]).toBe('probe(X,70,300)')
    expect(lines.filter((l) => l.startsWith('probe(')).map((l) => l.split(',').at(-1))).toEqual(['300)', '40)', '300)', '40)', '300)', '40)', '300)', '40)'])
    expect(lines.filter((l) => l.startsWith('probe('))).toHaveLength(8)
    expect(lines.filter((l) => l.startsWith('TEXT'))).toEqual(['TEXT-AWAIT G21 G91 G38.3 Z-20 F300', 'TEXT G90'])
    expect(lines.at(-2)).toBe('jogToMachineZ(30,1200)')
    expect(lines.some((l) => /G10|G92/.test(l))).toBe(false)
    expect(write).not.toHaveBeenCalled()

    const msg = screen.getByTestId('probe-routine-run-message').textContent ?? ''
    expect(msg).toContain('recorded 4 touches')
    expect(msg).toContain('Nothing has been written')
    const proposal = screen.getAllByTestId('probe-routine-run-proposal')[0]
    expect(proposal.getAttribute('data-kind')).toBe('workOffset')
    expect(proposal.textContent).toContain('G54: X = 100.00 mm, Y = 100.00 mm')
    expect(screen.getAllByTestId('probe-routine-run-proposal')[1].textContent).toContain('Diameter (X): 34.00 mm')

    fireEvent.click(screen.getByTestId('probe-routine-confirm-offset'))
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledWith('G54', 'X', 100)
    expect(write).toHaveBeenCalledWith('G54', 'Y', 100)
    expect(screen.getByTestId('probe-routine-run-written').textContent).toContain('G54 updated')
    // one tick bought one run
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a change after Check makes the preview stale: the tick is disabled and Run refuses until Check again', () => {
    mount()
    pick('factory.bore-centre')
    check()
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(false)
    type('probe-routine-input-value-diameter', '30')
    expect(screen.getByTestId('probe-routine-preview-stale')).toBeTruthy()
    expect((screen.getByTestId('probe-routine-path-clear-tick') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).title).toContain('out of date')
  })

  it('a missed contact stops at the named step: no proposal, no Confirm, the error names the step', async () => {
    vi.spyOn(session.getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
      wire.push(`probe(${axis},${target},${feed})`)
      return { ok: false, at: null, reason: 'ALARM:4' }
    })
    const write = vi.spyOn(session, 'setWorkOffsetValue').mockReturnValue(true)
    mount()
    pick('factory.bore-centre')
    check()
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
    await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy())
    expect(screen.getByTestId('probe-routine-run-result').getAttribute('data-ok')).toBe('false')
    expect(screen.getByTestId('probe-routine-run-message').textContent).toContain('left stopped')
    expect(screen.queryByTestId('probe-routine-confirm-offset')).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('while a routine runs ONE E-STOP sits next to Running... and presses the transport bar handler (pressEstop); it is gone when the run ends (WO-411 Operator cleanup)', async () => {
    // The first typed move is accepted but does not reach its target until we
    // release it, so the panel stays busy while the runner waits for readback.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(session.getMachineController().jogToWorkXY).mockImplementation((x, y, feed) => {
      wire.push(`jogToWorkXY(${x},${y},${feed})`)
      void gate.then(() => { machinePos = { ...machinePos, x, y } })
      return true
    })
    vi.spyOn(session.getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
      wire.push(`probe(${axis},${target},${feed})`)
      return { ok: false, at: null, reason: 'ALARM:4' }
    })
    const estop = vi.spyOn(session, 'pressEstop').mockResolvedValue({ ok: true })
    mount()
    pick('factory.bore-centre')
    // no E-STOP anywhere on the station before a run (the tab has no transport row)
    expect(screen.queryAllByRole('button', { name: 'E-STOP' })).toHaveLength(0)
    check()
    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
    await waitFor(() => expect(screen.getByTestId('probe-routine-run-panel').getAttribute('data-busy')).toBe('true'))
    expect(screen.getByTestId('probe-routine-run').textContent).toBe('Running...')
    expect(screen.getAllByRole('button', { name: 'E-STOP' })).toHaveLength(1)
    fireEvent.click(screen.getByTestId('probe-routine-run-estop'))
    expect(estop).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy())
    expect(screen.queryByTestId('probe-routine-run-estop')).toBeNull()
    expect(screen.getByTestId('probe-routine-run-panel').getAttribute('data-busy')).toBeNull()
  })
})
