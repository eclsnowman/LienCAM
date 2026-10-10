// @vitest-environment jsdom
//
// WO-006: the d20f0892e MC-TIER1 safety follow-ups from the independent
// audit (old-repo mailbox 2026-08-05T23:22:30Z), each pinned by the exact
// hazard the audit named:
//
//   1. A valid run-from plan followed by an INVALID re-plan must not leave
//      the stale sliced job sendable behind the canonical CYCLE START.
//   2. Single Block is enforced at the controller boundary, not just UI
//      state: start/resume refuse while on, engaging mid-stream constrains
//      the streamer, and releasing the mode never auto-resumes.
//   3. Run-from accepts integer, sendable line numbers only - fractional
//      input is refused fail-loud, and the per-line gesture is only offered
//      on sendable rows.
//   4. The engaged mode is VISIBLE: the Single Block chip takes the active
//      class, and that class wins the cascade (the audited Step button was
//      replaced by the unified CYCLE START; .control-btn-step is dead).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const {
  __resetEstopInterlockForTest,
  armRunFromLine,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setMachineSingleBlock,
} = await import('../../lib/machine/machineSession')
const { buildRunFromLinePlan } = await import('../../lib/machine/runFromLine')
const { GrblController } = await import('../../lib/machine/grbl/controller')
const { REALTIME } = await import('../../lib/machine/grbl/constants')
import type { GrblControllerEvents } from '../../lib/machine/grbl/controller'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'

// Ten sendable lines with real modal state to reconstruct; line 6 is a sane
// resume target (same program the MC-TIER1 completion tests use).
const PROGRAM = [
  'G21 G90 G54',
  'M3 S12000',
  'G0 X0 Y0',
  'G0 Z-5',
  'G1 Z-10 F300',
  'G1 X10 Y0 F800',
  'G1 X10 Y10',
  'G0 Z-5',
  'M5',
  'M30',
].join('\n')

/** The run-from fixture commands positive XY and negative Z below its
 * max-end GRBL homing switch. Give the simulator that travel. */
function selectRunFromMachineFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo006-run-from-machine',
    name: 'WO-006 run-from fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

const enc = new TextEncoder()
const dec = new TextDecoder()

class FakeTransport implements MachineTransport {
  events: TransportEvents | null = null
  written: Uint8Array[] = []
  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }
  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
  }
  async close(): Promise<void> {
    this.events?.onClose(null)
  }
  feed(text: string): void {
    this.events!.onChunk(enc.encode(text))
  }
  lines(): string[] {
    return this.written.filter((w) => w.length > 1).map((w) => dec.decode(w).replace(/\n$/, ''))
  }
  bytes(): number[] {
    return this.written.filter((w) => w.length === 1).map((w) => w[0])
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onConsole: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onStatus: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connectFake() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0)
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  ft.written = []
  return { ctrl, ft, events }
}

describe('WO-006 finding 1: no stale sliced job after invalid re-planning', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectRunFromMachineFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    act(() => {
      loadMachineProgram('safety.nc', PROGRAM)
    })
  })

  afterEach(async () => {
    act(() => getMachineController().emergencyStop())
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('valid plan -> invalid re-plan -> Start runs the full program, not the stale slice', () => {
    __resetEstopInterlockForTest()
    const ctrl = getMachineController()
    const armed = armRunFromLine(6)
    expect(armed.ok).toBe(true)
    if (!armed.ok) return
    // The armed job is the SLICE: prelude lines + program lines 6..10.
    const sliced = ctrl.jobProgress().totalLines
    expect(sliced).toBe(armed.plan.prelude.length + 5)
    expect(sliced).not.toBe(10)

    const replanned = armRunFromLine(999)
    expect(replanned.ok).toBe(false)

    // The audited hazard: the caution UI clears but the slice stayed armed.
    // Now the full program is restored - Start begins at line 1.
    expect(ctrl.jobProgress().phase).toBe('ready')
    expect(ctrl.jobProgress().totalLines).toBe(10)
    expect(useMachineControl.getState().job.totalLines).toBe(10)
    expect(ctrl.startJob()).toBe(true)
  })

  it('a failed plan with nothing armed does not conjure a sendable job', () => {
    const ctrl = getMachineController()
    // The guided-flow shape: after a controlled stop the streamer is empty.
    act(() => ctrl.emergencyStop())
    expect(ctrl.jobProgress().phase).toBe('empty')
    expect(armRunFromLine(999).ok).toBe(false)
    expect(ctrl.jobProgress().phase).toBe('empty')
    expect(ctrl.startJob()).toBe(false)
  })
})

describe('WO-006 finding 2: Single Block enforced at the controller boundary', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('refuses continuous start while on - stepJob is the only way lines go out', async () => {
    const { ctrl, ft } = await connectFake()
    ctrl.loadJob('G21\nG90')
    ctrl.setSingleBlockMode(true)
    expect(ctrl.startJob()).toBe(false)
    expect(ft.lines()).toEqual([])
    expect(ctrl.stepJob()).toBe(true)
    expect(ft.lines()).toEqual(['G21'])
  })

  it('refuses resume while on; OFF plus explicit resume continues from the next unsent line', async () => {
    const { ctrl, ft } = await connectFake()
    ctrl.loadJob('G21\nG90\nG1 X1 F100\nG1 X2')
    ctrl.setSingleBlockMode(true)
    expect(ctrl.stepJob()).toBe(true)
    ft.feed('ok\n')
    ft.written = []

    expect(ctrl.resumeJob()).toBe(false)
    expect(ft.lines()).toEqual([])
    expect(ft.bytes()).toEqual([]) // no cycle-start byte either

    // Releasing the mode is not a motion gesture (never auto-resume)...
    ctrl.setSingleBlockMode(false)
    expect(ft.lines()).toEqual([])
    // ...but an explicit resume now continues exactly at the next unsent line.
    expect(ctrl.resumeJob()).toBe(true)
    expect(ft.bytes()).toEqual([REALTIME.cycleStartResume])
    expect(ft.lines()).toEqual(['G90', 'G1 X1 F100', 'G1 X2'])
  })

  it('engaging mid-stream constrains the streamer: in-flight lines ack, nothing new is sent', async () => {
    const { ctrl, ft, events } = await connectFake()
    // Long enough that the 128-byte window leaves most lines unsent.
    const prog = Array.from({ length: 30 }, (_, i) => `G1 X${i} F100`).join('\n')
    ctrl.loadJob(prog)
    expect(ctrl.startJob()).toBe(true)
    const sentAtEngage = ctrl.jobProgress().sentLines
    expect(sentAtEngage).toBeGreaterThan(0)
    expect(sentAtEngage).toBeLessThan(30)

    ctrl.setSingleBlockMode(true)
    expect(events.onJobEvent).toHaveBeenCalledWith('paused', null)
    for (let i = 0; i < sentAtEngage; i++) ft.feed('ok\n')

    // Every ack of an in-flight line would have auto-filled while streaming.
    expect(ctrl.jobProgress().sentLines).toBe(sentAtEngage)
    expect(ctrl.jobProgress().phase).toBe('paused')
    // Stepping stays available as the one gesture that moves the machine.
    expect(ctrl.stepJob()).toBe(true)
    expect(ctrl.jobProgress().sentLines).toBe(sentAtEngage + 1)
  })
})

describe('WO-006 finding 3: run-from accepts integer, sendable lines only', () => {
  it('refuses fractional and non-finite line numbers fail-loud instead of crashing', () => {
    const fractional = buildRunFromLinePlan(PROGRAM, 5.5)
    expect(fractional.ok).toBe(false)
    if (!fractional.ok) expect(fractional.reason).toContain('whole line number')
    expect(buildRunFromLinePlan(PROGRAM, Number.NaN).ok).toBe(false)
    expect(buildRunFromLinePlan(PROGRAM, Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it('offers "Run from here" on sendable rows only', () => {
    const withComments = [
      'G21 G90 G54',
      '(setup notes - not sendable)',
      'G0 X0 Y0',
      'G1 Z-2 F300',
    ].join('\n')
    act(() => {
      loadMachineProgram('comments.nc', withComments)
    })
    render(<ProgramPanel />)

    fireEvent.mouseEnter(screen.getByText('G0 X0 Y0').closest('.gcode-line')!)
    expect(screen.getByTestId('control-runfrom-here-3')).toBeTruthy()

    const commentRow = screen.getByText('(setup notes - not sendable)').closest('.gcode-line')!
    fireEvent.mouseEnter(commentRow)
    expect(screen.queryByTestId('control-runfrom-here-2')).toBeNull()

    // Right-click on a non-sendable row must not plan either. Since WO-2651 (Operator ruling 10-06:
    // "I'd still like the right-click context menu") every row opens the line menu,
    // but Run from here is not offered on a row that cannot be a resume target.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { commentRow.dispatchEvent(ev) })
    const runFrom = screen.queryByTestId('control-line-menu-runfrom') as HTMLButtonElement | null
    expect(runFrom === null || runFrom.disabled).toBe(true)
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()
  })

  it("offers no gesture on a '%' program-marker row (WO-021: the streamer drops it)", () => {
    // The WO-006 audit residual: comment rows were covered, but the streamer's
    // prepareProgram ALSO drops a stripped line equal to '%'. A marker row past
    // the line-1 guard must offer none of the three gestures.
    const withMarkers = ['%', 'G21 G90 G54', 'G0 X0 Y0', 'G1 Z-2 F300', '%'].join('\n')
    act(() => {
      loadMachineProgram('markers.nc', withMarkers)
    })
    render(<ProgramPanel />)

    const markerRows = screen.getAllByText('%').map((el) => el.closest('.gcode-line')!)
    const endMarker = markerRows[markerRows.length - 1] // line 5

    // Hover: no "Run from here" button appears.
    fireEvent.mouseEnter(endMarker)
    expect(screen.queryByTestId('control-runfrom-here-5')).toBeNull()
    expect(endMarker.className).not.toContain('gcode-line-pickable')

    // Row-click: the run-from target input stays empty.
    fireEvent.click(endMarker)
    const input = screen.getByTestId('control-runfrom-input') as HTMLInputElement
    expect(input.value).toBe('')

    // Right-click: the WO-2651 line menu offers no Run from here, nothing planned.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { endMarker.dispatchEvent(ev) })
    const runFrom = screen.queryByTestId('control-line-menu-runfrom') as HTMLButtonElement | null
    expect(runFrom === null || runFrom.disabled).toBe(true)
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })

    // Control: a real g-code row in the same program still offers the gesture.
    fireEvent.mouseEnter(screen.getByText('G0 X0 Y0').closest('.gcode-line')!)
    expect(screen.getByTestId('control-runfrom-here-3')).toBeTruthy()
    cleanup()
  })
})

describe('WO-006 finding 4: the engaged Single Block mode is visibly styled', () => {
  const appCss = readFileSync('src/styles/app.css', 'utf8')

  afterEach(() => {
    cleanup()
    act(() => setMachineSingleBlock(false))
  })

  it('the active chip style is declared after every equal-specificity rule it must beat', () => {
    const active = appCss.indexOf('.control-chip-active {')
    expect(active).toBeGreaterThan(-1)
    // The audited defect class: a later rule silently winning the cascade
    // over the active state. The active rule must come LAST of the three.
    expect(active).toBeGreaterThan(appCss.indexOf('.control-chip-btn {'))
    expect(active).toBeGreaterThan(appCss.indexOf('.control-single-block-mode {'))
    // And it changes something an operator can see.
    const body = /\.control-chip-active \{([^}]*)\}/.exec(appCss)![1]
    expect(body).toMatch(/border-color|background/)
  })

  it('engaging the mode marks the chip active and arms the controller boundary together', () => {
    render(<ControlTransportBar />)
    const toggle = screen.getByTestId('control-singleblock-toggle')
    expect(toggle.className).not.toContain('control-chip-active')

    act(() => { fireEvent.click(toggle) })
    expect(toggle.className).toContain('control-chip-active')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    // The chip never claims a mode the controller is not enforcing.
    expect(getMachineController().singleBlockMode()).toBe(true)
  })

  it('no machine component references the dead Step-button class', () => {
    const dir = 'src/components/machine'
    const inspect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) inspect(path)
        else expect(readFileSync(path, 'utf8')).not.toContain('control-btn-step')
      }
    }
    inspect(dir)
  })
})
