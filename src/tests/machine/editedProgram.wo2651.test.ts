// @vitest-environment jsdom
//
// WO-2651: EDIT THE LOADED PROGRAM ON THE CONTROL SCREEN.
//
// Operator ruling, 2026-10-06 (verbatim): "A way to edit the gcodes is a requirement.
// That's a real gap. And we need to make it work well. Edit at post processor
// stage, or on control screen." His example: "adding a pause after something
// was already post-processed".
//
// Proven through the production entry point - the rendered ProgramPanel: the
// file is opened through "Open file...", edited in the panel's editor, and
// Apply loads it through the same `applyProgram` an opened file takes. What is
// measured is what the controller does with it:
//   - the in-app simulator (text door) runs the edited file, HOLDS at the
//     inserted M0 and one CYCLE START finishes it;
//   - the real UccncController over a fake bridge socket (file door - the
//     interpreter, the operator's AXBB-E route) is handed moves that stop at the M0:
//     the bridge's loadMoves calls before the hold end at the M0's position
//     and one CYCLE START sends the rest;
//   - the console says what changed; the listing follows the edited text;
//   - while the program is held the editor is read-only and says why;
//   - a line the file reader refuses is marked in the editor with the
//     session's own reason, and the program loaded before stays loaded;
//   - opening and closing the editor with no change loads nothing (pin);
//   - a program sent from the Post Process screen is loaded by the same path.
//
// NOT CLAIMED: hardware. The board readback is the machine seat's desk kit on
// the UCCNC route (the work order's own landing step).

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { MachineStatus, QueuedMove } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

let bridge: {
  sent: BridgeCallMessage[]
  received: BridgeMessage[]
  emit: (message: BridgeMessage) => void
  emitStatus: () => void
  timed: boolean
  currentId: number | null
  frames: number
  pump: () => boolean
} | null = null
vi.mock('../../lib/machine/bridgeTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridge extends actual.BridgeTransport {
    static isSupported() { return true }
    sent: BridgeCallMessage[] = []
    received: BridgeMessage[] = []
    fakeEvents: BridgeTransportEvents | null = null
    pos = { x: 0, y: 0, z: -1 }
    offset = { x: 0, y: 0, z: -10 }
    moves: QueuedMove[] = []
    state: MachineStatus['state'] = 'idle'
    /** WO-2651 items 8-11: a TIMED board, pumped one status frame at a time
     *  by the test. Modelled on Machine.cs (8bb93398d): the board's CurrentID
     *  SURVIVES a job (section 12.3); a frame reports it only while a job runs
     *  and only when it names a move of THIS job (LiveOrdinalForWireId,
     *  :10650 - a job of <= 4095 moves uses the move's own id as its wire id,
     *  :10636, and has no provenance guard, :9976/:10681). The board keeps
     *  the old CurrentID for `retainedFrames` frames after a start before it
     *  reaches the first move. */
    timed = false
    currentId: number | null = null
    jobRunning = false
    retainedFrames = 2
    script: Array<() => void> = []
    frames = 0
    constructor() { super(); bridge = this }
    emit(message: BridgeMessage) { this.received.push(message); this.fakeEvents?.onMessage(message) }
    reportedId(): number | null {
      if (!this.timed) return 0
      if (!this.jobRunning || this.currentId === null) return null
      return this.moves.some((m) => m.id === this.currentId) ? this.currentId : null
    }
    emitStatus() {
      this.emit({ t: 'status', v: {
        state: this.state, subState: null, machinePos: { ...this.pos },
        workPos: { x: this.pos.x - this.offset.x, y: this.pos.y - this.offset.y, z: this.pos.z - this.offset.z },
        feedMmMin: 0, spindleRpm: null, overrides: null, executingMoveId: this.reportedId(),
        buffer: { moves: 0, capacitySeconds: null }, inputs: null, homed: null, spindle: null,
      } })
    }
    /** One board frame of the running job; false once the job has ended. */
    pump(): boolean {
      const next = this.script.shift()
      if (!next) return false
      next()
      this.frames++
      return true
    }
    startTimedJob() {
      this.state = 'run'
      this.jobRunning = true
      this.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
      this.script = []
      for (let i = 0; i < this.retainedFrames; i++) this.script.push(() => this.emitStatus())
      for (const move of this.moves) {
        this.script.push(() => {
          this.currentId = move.id
          if (move.kind === 'line' || move.kind === 'arc') {
            for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) this.pos[axis] = move.to[axis]! + this.offset[axis]
          }
          this.emitStatus()
        })
      }
      this.script.push(() => {
        this.jobRunning = false
        this.state = 'idle'
        this.emitStatus()
        this.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
      })
    }
    async start(events: BridgeTransportEvents) {
      this.fakeEvents = events
      const offsets = Object.fromEntries(['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].map(wcs => [wcs, this.offset]))
      this.emit({ t: 'hello', v: { protocol: 1, bridge: 'WO-2651 desk fake', readOnly: false,
        capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true, machineProgram: true,
          perAxisHoming: true, gcodeText: false, spindleCommands: false, ownsSpindle: false },
        workOffsets: { current: offsets, profile: offsets },
      } } as BridgeMessage)
    }
    send(message: BridgeCallMessage) {
      this.sent.push(message)
      const a = message.a as Record<string, number>
      let value: unknown = true
      if (message.m === 'setWorkOffset') {
        for (const axis of ['x', 'y', 'z'] as const) if (a[axis] !== undefined) this.offset[axis] = a[axis]
        value = { ok: true, offset: { ...this.offset } }
        this.emitStatus()
      }
      if (message.m === 'loadMoves') this.moves = (message.a as { moves: QueuedMove[] }).moves
      if (message.m === 'startJob' && this.timed) {
        this.startTimedJob()
      } else if (message.m === 'startJob') {
        this.state = 'run'; this.emitStatus()
        setTimeout(() => {
          for (const move of this.moves) if (move.kind === 'line' || move.kind === 'arc') {
            for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) this.pos[axis] = move.to[axis]! + this.offset[axis]
          }
          this.state = 'idle'; this.emitStatus()
          this.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
        }, 20)
      }
      if (message.m === 'jogToMachineZ') this.pos.z = a.z
      if (message.m === 'jogToWorkXY') { this.pos.x = a.x + this.offset.x; this.pos.y = a.y + this.offset.y }
      if (message.m === 'probe') {
        this.pos.z = -40
        value = { ok: true, at: { ...this.pos } }
      }
      if (['jogToMachineZ', 'jogToWorkXY', 'probe'].includes(message.m)) {
        setTimeout(() => this.emitStatus(), 1)
      }
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: value })
    }
    async close() { this.fakeEvents?.onClose('closed') }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridge })
})

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { positionMacroBody } = await import('../../types')
const { sendProgramToControl } = await import('../../components/gcode/editedProgram')
const { makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } = await import('../post/helpers')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadedProgramText,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo2651-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }

function configureMachine(_backend: string): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2651 simulator',
    controller: 'uccnc',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [{
      id: PARK.id,
      name: PARK.label,
      body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
      usedForToolChange: true,
    }],
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}


const FILE = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nG0 X20\nG0 X35\nM30'
/** The edit: M0 after line 4 (`G0 X20`). */
const EDITED = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nG0 X20\nM0\nG0 X35\nM30'

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
const textarea = () => screen.getByTestId('control-gcode-editor-text') as HTMLTextAreaElement

async function openFile(name: string, text: string): Promise<void> {
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  const file = new File([text], name, { type: 'text/plain' })
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
  await advance(300)
}

/** Right-click a listing line and pick from its line menu (the operator's amendment:
 *  no Edit button - the line menu is the way in). */
function lineMenu(line: number, item: string): void {
  fireEvent.contextMenu(screen.getByTestId(`control-gcode-line-${line}`), { clientX: 40, clientY: 40 })
  fireEvent.click(screen.getByTestId(`control-line-menu-${item}`))
}

/** Right-click line `after` -> Insert line -> type `text` -> Enter. */
function insertLine(after: number, text: string): void {
  lineMenu(after, 'insert')
  const input = screen.getByTestId('control-insert-line-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

async function cycleStart(): Promise<void> {
  const where = new Error().stack?.split('\n')[2] ?? ''
  await act(async () => { expect(await executeOperatorCycleStart(), `${where}\n${consoleText()}\n${useMachineControl.getState().programReadiness.reason}`).toBe(true) })
}

function loadMovesFrames(): QueuedMove[][] {
  return (bridge?.sent ?? []).filter((f) => f.m === 'loadMoves').map((f) => (f.a as { moves: QueuedMove[] }).moves)
}

for (const backend of ['simulator', 'bridge'] as const) describe(`WO-2651 Control editor - ${backend}`, () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    bridge = null
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine(backend)
    useMachineControl.setState({ activeTool: null })
    const connected = connectMachine(backend, 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    if (backend === 'bridge') {
      bridge!.emitStatus()
      bridge!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } })
    } else {
      getMachineController().home()
      await vi.advanceTimersByTimeAsync(2000)
    }
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    tools.setProbeConfig(MACHINE_ID, { maxTravel: 50 })
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  it('opens a file, right-click line 4 -> Insert line M0, applies: the run holds there and one CYCLE START finishes it', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', FILE)
    expect(loadedProgramText()).toBe(FILE)
    // No Edit button and no Apply place until something is staged (item 6).
    expect(screen.queryByTestId('control-edit-program')).toBeNull()
    expect(screen.queryByTestId('control-editor-staged')).toBeNull()

    // The right-clicked row is marked while its menu is open (Operator ruling 10-06 11:40 PM:
    // "names/marks the clicked line unmistakably").
    fireEvent.contextMenu(screen.getByTestId('control-gcode-line-4'), { clientX: 40, clientY: 40 })
    expect(screen.getByTestId('control-line-menu').getAttribute('aria-label')).toBe('Line 4')
    expect(screen.getByTestId('control-gcode-line-4').className).toContain('gcode-line-menu-target')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('control-line-menu')).toBeNull()
    expect(screen.getByTestId('control-gcode-line-4').className).not.toContain('gcode-line-menu-target')
    // Escape and a press outside hand keyboard focus back to the listing (Rholand's receipt 10-07: it fell to <body>).
    await vi.advanceTimersByTimeAsync(1)
    expect(document.activeElement).toBe(screen.getByTestId('control-gcode-list'))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.contextMenu(screen.getByTestId('control-gcode-line-4'), { clientX: 40, clientY: 40 })
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    fireEvent.pointerDown(document.querySelector('.sketch-context-overlay')!)
    expect(screen.queryByTestId('control-line-menu')).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(document.activeElement).toBe(screen.getByTestId('control-gcode-list'))
    insertLine(4, 'M0')
    // STAGED: nothing loaded yet, the one Apply / Discard place says what changed.
    expect(loadedProgramText()).toBe(FILE)
    expect(screen.queryByTestId('control-program-editor')).toBeNull()
    expect(screen.getByTestId('control-editor-summary').textContent).toBe('1 line added after line 4')
    if (backend === 'simulator') {
      // The text listing shows the staged row, marked.
      expect(screen.getByTestId('control-gcode-line-5').textContent).toContain('M0')
      expect(screen.getByTestId('control-gcode-line-5').dataset.staged).toBe('true')
    }
    const framesBefore = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)

    // Re-read through the load path: the session holds the edited text, the
    // listing shows it, the console says what changed, the editor closed.
    expect(loadedProgramText()).toBe(EDITED)
    expect(consoleText()).toContain('Program edited: 1 line added after line 4')
    expect(screen.queryByTestId('control-program-editor')).toBeNull()
    expect(useMachineControl.getState().job.name).toBe('part.nc')
    // The listing follows the edited text: the text door lists the M0 row;
    // the file door lists the stop as the start of a second file section.
    expect(screen.getByTestId('control-gcode-list').textContent)
      .toContain(backend === 'simulator' ? 'M0' : 'File section 2')

    await cycleStart()
    await advance(3000)
    const held = useMachineControl.getState()
    expect(held.machineState === 'hold' || held.job.phase === 'paused', consoleText()).toBe(true)
    expect(held.mpos?.x).toBeCloseTo(20, 1)
    if (backend === 'bridge') {
      // The bridge calls carry the stop: what was loaded before the hold ends
      // at the M0's X20 and never reaches X35.
      const sentBeforeHold = loadMovesFrames().slice(framesBefore).flat()
      const xs = sentBeforeHold.flatMap((m) => (m.kind === 'line' || m.kind === 'arc') && m.to.x !== undefined ? [m.to.x] : [])
      expect(xs.length).toBeGreaterThan(0)
      expect(Math.max(...xs)).toBeCloseTo(20, 1)
    }

    // While held the line menu offers no Insert line, and the editor opens
    // read-only and says why (rule 11: a real cannot).
    const heldRow = backend === 'simulator' ? 2 : screen.getByTestId('control-gcode-list')
      .querySelector('[data-testid^="control-gcode-line-"]')!.getAttribute('data-testid')!.replace('control-gcode-line-', '')
    fireEvent.contextMenu(screen.getByTestId(`control-gcode-line-${heldRow}`), { clientX: 40, clientY: 40 })
    expect(screen.queryByTestId('control-line-menu-insert')).toBeNull()
    expect(screen.queryByTestId('control-line-menu-runfrom')).toBeNull()
    fireEvent.click(screen.getByTestId('control-line-menu-goto'))
    expect(textarea().readOnly).toBe(true)
    expect(screen.getByTestId('control-gcode-editor-readonly-reason').textContent).toContain('Stop')
    expect(screen.queryByTestId('control-editor-apply')).toBeNull()
    fireEvent.click(screen.getByTestId('control-editor-close'))

    // ONE Cycle Start continues to the end.
    const holdsBefore = useMachineControl.getState().holdsSeen
    await cycleStart()
    await advance(5000)
    const end = useMachineControl.getState()
    expect(end.job.phase, consoleText()).toBe('complete')
    expect(end.mpos?.x).toBeCloseTo(35, 1)
    expect(end.holdsSeen).toBe(holdsBefore)
    if (backend === 'bridge') {
      const after = loadMovesFrames().slice(framesBefore).flat()
      expect(after.some((m) => m.kind === 'line' && m.to.x !== undefined && Math.abs(m.to.x - 35) < 0.01)).toBe(true)
    }
  })

  it('the unedited file runs straight through, and opening the editor without a change loads nothing (pin)', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', FILE)
    const consoleBefore = consoleText()
    const wireBefore = bridge?.sent.length ?? 0
    lineMenu(3, 'goto')
    expect(textarea().value).toBe(FILE)
    expect(screen.queryByTestId('control-editor-apply')).toBeNull()
    fireEvent.click(screen.getByTestId('control-editor-close'))
    expect(screen.queryByTestId('control-program-editor')).toBeNull()
    expect(loadedProgramText()).toBe(FILE)
    expect(consoleText()).toBe(consoleBefore)
    expect(bridge?.sent.length ?? 0).toBe(wireBefore)

    await cycleStart()
    await advance(5000)
    const end = useMachineControl.getState()
    expect(end.job.phase, consoleText()).toBe('complete')
    expect(end.mpos?.x).toBeCloseTo(35, 1)
  })

  it('a staged edit of file A is dropped (and said so) when file B loads; Insert + Apply then edit and load B, never A (desk kit RED 1, 10-07)', async () => {
    render(createElement(ProgramPanel))
    await openFile('a.nc', FILE)
    insertLine(4, 'M0')
    expect(screen.getByTestId('control-editor-summary').textContent).toBe('1 line added after line 4')
    const other = FILE.replace(/X(\d+)/g, (_m, n: string) => `X${Number(n) + 1}`)
    await openFile('b.nc', other)
    expect(loadedProgramText()).toBe(other)
    expect(consoleText()).toContain('Staged edits to "a.nc" were discarded: "b.nc" was loaded in its place.')
    expect(screen.queryByTestId('control-editor-staged')).toBeNull()
    insertLine(4, 'M0')
    expect(screen.getByTestId('control-editor-summary').textContent).toBe('1 line added after line 4')
    await act(async () => { fireEvent.click(screen.getByTestId('control-editor-apply')) })
    await advance(300)
    const lines = other.split('\n')
    lines.splice(4, 0, 'M0')
    expect(loadedProgramText()).toBe(lines.join('\n'))
    expect(useMachineControl.getState().job.name).toBe('b.nc')
  })

  it('opening the same file again (identical text) starts clean: the staged edit is dropped and said so (desk kit note, 10-07)', async () => {
    render(createElement(ProgramPanel))
    await openFile('a.nc', FILE)
    insertLine(4, 'M0')
    await openFile('a.nc', FILE)
    expect(consoleText()).toContain('Staged edits to "a.nc" were discarded: "a.nc" was loaded in its place.')
    expect(screen.queryByTestId('control-editor-staged')).toBeNull()
    expect(loadedProgramText()).toBe(FILE)
  })

  it('a run started with an edit still staged says the staged edit is not in it (desk kit note, 10-07)', async () => {
    render(createElement(ProgramPanel))
    await openFile('a.nc', FILE)
    insertLine(4, 'M0')
    await cycleStart()
    await advance(5000)
    expect(consoleText()).toContain('This run uses the loaded program; your staged edits (1 line added after line 4) are not in it - Apply them first to run them.')
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
  })

  it('Run from here on an opened file plans from that file line on both routes (desk kit RED 2, 10-07: disabled on the UCCNC door)', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', FILE)
    fireEvent.contextMenu(screen.getByTestId('control-gcode-line-4'), { clientX: 40, clientY: 40 })
    const item = screen.getByTestId('control-line-menu-runfrom') as HTMLButtonElement
    expect(item.disabled).toBe(false)
    await act(async () => { fireEvent.click(item) })
    await advance(300)
    // WO-2810: the row menu also asks about the unknown fitted tool before arming.
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')) })
    await advance(300)
    expect(screen.getByTestId('control-runfrom-target').textContent).toBe('4: G0 X20')
    expect((screen.getByTestId('control-runfrom-input') as HTMLInputElement).value).toBe('4')
  })

  it('a listing line opens the editor at that line', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', FILE)
    const row = screen.getByTestId('control-gcode-line-5')
    fireEvent.doubleClick(row)
    expect(screen.getByTestId('control-gcode-editor-position').textContent).toContain('Ln 5, Col 1')
  })

  it('a program sent from the Post Process screen loads through the same path', async () => {
    render(createElement(ProgramPanel))
    await act(async () => { sendProgramToControl({ name: 'posted.nc', text: EDITED }) })
    await advance(300)
    expect(loadedProgramText()).toBe(EDITED)
    expect(useMachineControl.getState().job.name).toBe('posted.nc')
    await cycleStart()
    await advance(3000)
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(20, 1)
  })

  if (backend === 'simulator') it('Run from here on the edited program (rows shifted, a target changed) plans and runs from the edited line', async () => {
    // At F600 a 50 ms frame can miss the turnaround by 0.5 mm (WO-2024).
    // Slow this fixture so the unchanged 0.05 mm assertion resolves the edited target.
    const file = 'G21 G90 G54\nT1\n(roughing)\nG0 X10 Y0 Z-1\nG1 X11 F60\nG1 X12\nG1 X13\nG1 X14\nM30'
    render(createElement(ProgramPanel))
    await openFile('part.nc', file)
    lineMenu(4, 'goto')
    // Rows after the edit: 3 G0 X10, 4 G1 X15 (new), 5 X11, 6 X12, 7 X23 (was X13), 8 X14.
    const edited = file.replace('(roughing)\n', '').replace('G0 X10 Y0 Z-1\n', 'G0 X10 Y0 Z-1\nG1 X15 F60\n').replace('G1 X13', 'G1 X23')
    fireEvent.change(textarea(), { target: { value: edited } })
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toBe(edited)
    lineMenu(7, 'runfrom')
    await advance(300)
    // WO-2810: confirm Start now, then measure the same edited-line execution.
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')) })
    await advance(300)
    expect(screen.getByTestId('control-runfrom-target').textContent).toMatch(/^7: .*X23/)
    expect(useMachineControl.getState().armedFromLine).toBe(7)
    await cycleStart()
    const xs: number[] = []
    for (let i = 0; i < 600 && useMachineControl.getState().job.phase !== 'complete'; i++) {
      await advance(50)
      xs.push(useMachineControl.getState().mpos?.x ?? NaN)
    }
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    // It ran X23 (the edited target), then X14 - never the old X13 end.
    expect(Math.max(...xs)).toBeCloseTo(23, 1)
    expect(xs.at(-1)).toBeCloseTo(14, 1)
  })

  if (backend === 'simulator') it('at a tool-change hold a staged edit cannot be applied and Insert line is not offered (item 12)', async () => {
    const file = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2 M6\nG0 X20 Y0 Z-1\nM30'
    useMachineToolTable.getState().recordProbedZ(MACHINE_ID, 2, -40, 1)
    render(createElement(ProgramPanel))
    await openFile('part.nc', file)
    useMachineControl.setState({ activeTool: 1 })
    insertLine(5, 'G0 X30')
    const loaded = loadedProgramText()
    await cycleStart()
    let atChange = false
    for (let i = 0; i < 100 && !atChange; i++) {
      await advance(200)
      atChange = useMachineControl.getState().toolChange !== null
    }
    expect(atChange, consoleText()).toBe(true)
    const apply = screen.getByTestId('control-editor-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    await advance(300)
    expect(loadedProgramText()).toBe(loaded)
    const row = screen.getByTestId('control-gcode-list').querySelector('[data-testid^="control-gcode-line-"]')!
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })
    expect(screen.queryByTestId('control-line-menu-insert')).toBeNull()
    fireEvent.click(screen.getByTestId('control-line-menu-goto'))
    expect(textarea().readOnly).toBe(true)
  })

  if (backend === 'bridge') it("marks a line the file reader refuses with the session's reason; the loaded program stays", async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', FILE)
    lineMenu(4, 'goto')
    fireEvent.change(textarea(), { target: { value: FILE.replace('G0 X20', 'G0 X20\nG38.2 Z-5 F100') } })
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toBe(FILE)
    expect(screen.getByTestId('control-program-editor')).toBeTruthy()
    const mark = screen.getByTestId('control-gcode-editor-mark-5')
    expect(mark.textContent).toMatch(/^Line 5: /)
    expect(consoleText()).toContain('The edited program was not loaded')
  })
})

// ---------------------------------------------------------------------------
// WO-2651 AMENDMENT 2 (items 8-12): BASELINE -> EDIT -> APPLY -> RERUN on the
// UCCNC route. Simulator / fake-board evidence only (item 10) - no live CNC.

/** Every motion line ends at its own X, so a row's text names the move. */
const RUN_FILE = [
  'G21 G90 G54', //  1
  'T1', //           2
  '(roughing)', //   3
  'G0 X10 Y0 Z-1', // 4
  'G1 X11 F600', //  5
  '(pass 2)', //     6
  'G1 X12', //       7
  'G1 X13', //       8
  'G1 X14', //       9
  'M30', //         10
].join('\n')

interface Frame { reported: number | null; row: string | null; rowText: string | null; x: number | undefined }

/** The row Control highlights now (WO-2580: the controller's executing move). */
function highlighted(): { row: string | null; text: string | null } {
  const hl = screen.getByTestId('control-gcode-list').querySelector('.gcode-line-hl')
  return { row: hl?.getAttribute('data-testid')?.replace('control-gcode-line-', '') ?? null, text: hl?.textContent ?? null }
}

/** Pump the board one frame at a time; after each, read the highlighted row. */
async function pumpRun(): Promise<Frame[]> {
  const frames: Frame[] = []
  for (let guard = 0; guard < 200; guard++) {
    let pumped = false
    await act(async () => { pumped = bridge!.pump() })
    if (!pumped) break
    await advance(5)
    const last = bridge!.received.filter((m) => m.t === 'status').at(-1) as { v: MachineStatus } | undefined
    const reported = last?.v.executingMoveId ?? null
    const move = (bridge as unknown as { moves: QueuedMove[] }).moves.find((m) => m.id === reported)
    const { row, text } = highlighted()
    frames.push({ reported, row, rowText: text, x: move && (move.kind === 'line' || move.kind === 'arc') ? move.to.x : undefined })
  }
  return frames
}

describe('WO-2651 amendment 2 - rerun after an edit, UCCNC fake-board bridge', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    bridge = null
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine('bridge')
    useMachineControl.setState({ activeTool: null })
    const connected = connectMachine('bridge', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    bridge!.emitStatus()
    bridge!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } })
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    tools.setProbeConfig(MACHINE_ID, { maxTravel: 50 })
    bridge!.timed = true
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  /** Every motion frame highlights the row of the move the board executes,
   *  and that row's text is that move (its X). A frame naming no move shows
   *  no row - or, at a hold or the end, the move that ran last (WO-2580: the
   *  move the controller reported when the program stopped). WO-2683: held at
   *  an M0, the M0's own row (`m0Row`). */
  function expectHighlightFollowsExecution(frames: Frame[], label: string, heldRow: string | null = null, m0Row: string | null = null): void {
    let lastRow: string | null = heldRow
    for (const [i, f] of frames.entries()) {
      const detail = `${label} frame ${i}: ${JSON.stringify(f)}`
      if (f.reported === null) {
        if (f.row !== null && f.row === m0Row) expect(f.rowText, detail).toBe(`${m0Row}M0`)
        else if (f.row !== null) expect(f.row, detail).toBe(lastRow)
      } else if (f.x !== undefined) {
        expect(f.rowText ?? '', detail).toMatch(new RegExp(`X${f.x}(?![0-9.])`))
        lastRow = f.row
      }
    }
  }

  it('imported .nc: baseline, then an edit that shifts every line (comment deleted, two motion lines inserted, one target changed), Apply, rerun: the board runs the EDITED moves and every frame highlights the executing row - never the retained CurrentID', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', RUN_FILE)
    await cycleStart()
    const baseline = await pumpRun()
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expectHighlightFollowsExecution(baseline, 'baseline')
    const baselineXs = loadMovesFrames().flat().flatMap((m) => m.kind === 'line' ? [m.to.x] : [])
    expect(baselineXs).toEqual([10, 11, 12, 13, 14])
    // The board keeps the last move's id after the job (Machine.cs section 12.3).
    expect(bridge!.currentId).toBe(5)

    // EDIT through the line menu's editor: delete the '(roughing)' comment,
    // insert G1 X15 / G1 X16 after the rapid, change G1 X13 to G1 X23.
    lineMenu(4, 'goto')
    const edited = RUN_FILE
      .replace('(roughing)\n', '')
      .replace('G0 X10 Y0 Z-1\n', 'G0 X10 Y0 Z-1\nG1 X15 F600\nG1 X16\n')
      .replace('G1 X13', 'G1 X23')
    fireEvent.change(textarea(), { target: { value: edited } })
    const sentBefore = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toBe(edited)
    expect(consoleText()).toMatch(/Program edited: /)

    await cycleStart()
    const rerun = await pumpRun()
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    // Apply replaced the execution source: the rerun's frames carry the
    // edited moves, in the edited order - no move of the old program.
    const rerunXs = loadMovesFrames().slice(sentBefore).flat().flatMap((m) => m.kind === 'line' ? [m.to.x] : [])
    expect(rerunXs).toEqual([10, 15, 16, 11, 12, 23, 14])
    // ITEM 11: the board's first frames still name id 5 (the old job's last
    // move, now `G1 X12` on row 7 of the edited text). No row is highlighted
    // until the board reaches the edited program's first move.
    expect(rerun.slice(0, 2).map((f) => f.reported)).toEqual([5, 5])
    expect(rerun.slice(0, 2).map((f) => f.row), JSON.stringify(rerun.slice(0, 3))).toEqual([null, null])
    expectHighlightFollowsExecution(rerun.slice(2), 'rerun')
    // Rows of the EDITED text (comment gone, two lines in): X10 is row 3,
    // X15 4, X16 5, X11 6, X12 8 (row 7 is '(pass 2)'), X23 9, X14 10.
    expect(rerun.slice(2).filter((f) => f.reported !== null).map((f) => f.row)).toEqual(['3', '4', '5', '6', '8', '9', '10'])
  })

  it('an M0 inserted and applied holds the rerun there; at the hold a staged edit cannot be applied and Insert line is not offered (item 12); one CYCLE START runs the LOADED program on', async () => {
    render(createElement(ProgramPanel))
    await openFile('part.nc', RUN_FILE)
    await cycleStart()
    await pumpRun()
    insertLine(5, 'M0')
    const sentBefore = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toBe(RUN_FILE.replace('G1 X11 F600\n', 'G1 X11 F600\nM0\n'))
    // Stage a second edit BEFORE the run: X17 after the X14 line. Not applied.
    insertLine(10, 'G1 X17')
    expect(screen.getByTestId('control-editor-summary').textContent).toBe('1 line added after line 10')
    const loaded = loadedProgramText()

    await cycleStart()
    const first = await pumpRun()
    const held = useMachineControl.getState()
    expect(held.machineState === 'hold' || held.job.phase === 'paused', consoleText()).toBe(true)
    // Section 1 ran the rapid and X11 and stopped AT the inserted M0.
    expect(loadMovesFrames().slice(sentBefore).flat().flatMap((m) => m.kind === 'line' ? [m.to.x] : [])).toEqual([10, 11])
    expect(held.mpos?.x).toBeCloseTo(11, 1)
    expectHighlightFollowsExecution(first, 'to the M0', null, '6')
    // WO-2683: held there, the lit row is the M0's own line.
    expect(first.at(-1), JSON.stringify(first.at(-1))).toMatchObject({ row: '6', rowText: '6M0' })

    // AT THE HOLD: Apply is there but disabled and says why; a click reaches
    // no load; the line menu offers no Insert line; the editor is read-only.
    const apply = screen.getByTestId('control-editor-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(apply.getAttribute('data-tooltip')).toContain('Stop')
    const wire = bridge!.sent.length
    fireEvent.click(apply)
    await advance(300)
    expect(loadedProgramText()).toBe(loaded)
    expect(bridge!.sent.length).toBe(wire)
    const row = screen.getByTestId('control-gcode-list').querySelector('[data-testid^="control-gcode-line-"]')!
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })
    expect(screen.queryByTestId('control-line-menu-insert')).toBeNull()
    fireEvent.click(screen.getByTestId('control-line-menu-goto'))
    expect(textarea().readOnly).toBe(true)
    fireEvent.click(screen.getByTestId('control-editor-close'))

    // ONE CYCLE START runs the loaded program on - X12, X13, X14, never the
    // staged X17.
    const resumeFrom = loadMovesFrames().length
    await cycleStart()
    const rest = await pumpRun()
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    const restXs = loadMovesFrames().slice(resumeFrom).flat().flatMap((m) => m.kind === 'line' ? [m.to.x] : [])
    expect(restXs.slice(-3)).toEqual([12, 13, 14])
    expect(restXs).not.toContain(17)
    expectHighlightFollowsExecution(rest, 'after the M0', first.at(-1)?.row ?? null)

    // Ended: the staged edit applies now.
    expect((screen.getByTestId('control-editor-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toContain('G1 X14\nG1 X17\nM30')
  })

  /** A generated CAM setup: one operation on T1, its toolpath stamped
   *  current (WO-2013's small-setup fixture). */
  function camSetup(): void {
    const tool = makeTool({ id: 'tA', name: '6 mm flat', toolNumber: 1 })
    const operation = makeOp({ id: 'opA', name: 'Op A', toolId: 'tA', status: 'ready', toolpathMoves: [
      { type: 'rapid', x: 20, y: 20, z: 10 },
      { type: 'feed', x: 20, y: 20, z: -2, feed: 300 },
      { type: 'feed', x: 25, y: 22, z: -2, feed: 900 },
      { type: 'feed', x: 30, y: 20, z: -2, feed: 900 },
      { type: 'feed', x: 35, y: 22, z: -2, feed: 900 },
      { type: 'rapid', x: 35, y: 22, z: 10 },
    ] })
    const setup = {
      id: 'setup-cam', name: 'Setup 1', notes: '', operations: [operation],
      wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } }),
      stock: makeStock({ material: 'aluminum' }),
    }
    const project = { ...useCamStore.getState().project, setups: [setup], activeSetupId: setup.id, toolLibrary: [tool], stocks: [], nests: [] }
    stampGenerationCurrent(project, setup, operation, tool)
    useCamStore.setState({ project, toolLibrary: [tool] })
  }

  async function loadSetup(id: string): Promise<void> {
    act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
    await act(async () => {
      fireEvent.click(screen.getByTestId(`control-load-setup-item-${id}`))
      await Promise.resolve()
    })
    await advance(300)
  }

  async function g54For(z: number): Promise<void> {
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', z]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
  }

  /** The editor's text with M0 after the X25 cut and the X30 cut moved to X32. */
  function editPosted(text: string): string {
    const rows = text.split('\n')
    const at25 = rows.findIndex((r) => /(^|\s)X25\b/.test(r))
    expect(at25).toBeGreaterThan(0)
    rows.splice(at25 + 1, 0, 'M0')
    const at30 = rows.findIndex((r) => /(^|\s)X30\b/.test(r))
    expect(at30).toBeGreaterThan(0)
    rows[at30] = rows[at30].replace('X30', 'X32')
    return rows.join('\n')
  }

  const lineXs = (frames: QueuedMove[][]) => frames.flat().flatMap((m) => m.kind === 'line' && m.to.x !== undefined ? [m.to.x] : [])

  it('a generated CAM setup loaded with Load (an internal toolpath queue): baseline, edit (M0 + a changed cut), Apply, rerun runs the EDITED program - holds at the M0, never the old queue; Run from here on it starts at the edited line', async () => {
    camSetup()
    await g54For(-15)
    render(createElement(ProgramPanel))
    await loadSetup('setup-cam')
    expect(useMachineControl.getState().job.name).toBe('Setup 1 (toolpath)')
    // The toolpath door: no text, the session's own queue of moves.
    expect(loadedProgramText()).toBeNull()
    await cycleStart()
    const baseline = await pumpRun()
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expectHighlightFollowsExecution(baseline, 'setup baseline')
    expect(lineXs(loadMovesFrames())).toEqual([20, 20, 25, 30, 35, 35])

    // The line menu's Go to line opens the editor on the setup POSTED for this
    // controller (the toolpath queue has no text) and says so.
    lineMenu(3, 'goto')
    expect(screen.getByTestId('control-editor-note').textContent).toMatch(/posted/i)
    const posted = textarea().value
    const edited = editPosted(posted)
    fireEvent.change(textarea(), { target: { value: edited } })
    const sentBefore = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    expect(loadedProgramText()).toBe(edited)
    // M0 after the X25 cut and the next cut changed: one place, two lines.
    expect(consoleText()).toMatch(/Program edited: line \d+ replaced by 2 lines/)
    // The program's setup information came through the edit (item 9): no
    // "Ignoring the LienCAM setup information" warning.
    expect(consoleText()).not.toMatch(/Ignoring the LienCAM setup information|does not match the program/)

    await cycleStart()
    const toHold = await pumpRun()
    const s = useMachineControl.getState()
    expect(s.machineState === 'hold' || s.job.phase === 'paused', consoleText()).toBe(true)
    expect(s.mpos?.x).toBeCloseTo(25, 1)
    expectHighlightFollowsExecution(toHold, 'edited setup to the M0')
    await cycleStart()
    const rest = await pumpRun()
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expectHighlightFollowsExecution(rest, 'edited setup after the M0', toHold.at(-1)?.row ?? null)
    const rerunXs = lineXs(loadMovesFrames().slice(sentBefore))
    expect(rerunXs).toContain(32)
    expect(rerunXs).not.toContain(30)
    expect(rerunXs.at(-1)).toBe(35)

    // The session's program IS the edited text - what a Stop re-stages and
    // run-from-line replans from - not the old toolpath queue.
    expect(loadedProgramText()).toBe(edited)

    // Run from here on the edited program: its plan names the edited line.
    // (T1 is in the spindle - the program ran with it - so the plan needs no change.)
    useMachineControl.setState({ activeTool: 1 })
    const row32 = [...screen.getByTestId('control-gcode-list').querySelectorAll('[data-testid^="control-gcode-line-"]')]
      .find((el) => /X32/.test(el.textContent ?? ''))!
    const line32 = edited.split('\n').findIndex((r) => /(^|\s)X32\b/.test(r)) + 1
    expect(row32.getAttribute('data-testid')).toBe(`control-gcode-line-${line32}`)
    lineMenu(line32, 'runfrom')
    await advance(300)
    expect(screen.getByTestId('control-runfrom-target').textContent).toMatch(new RegExp(`^${line32}: .*X32`))
    const fromAt = loadMovesFrames().length
    await cycleStart()
    const fromFrames = await pumpRun()
    // The plan's spindle start is a hold on a machine with no spindle link
    // ("start it at the machine"); the operator presses CYCLE START.
    for (let i = 0; i < 3 && useMachineControl.getState().job.phase === 'paused'; i++) {
      await cycleStart()
      fromFrames.push(...await pumpRun())
    }
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    const fromXs = lineXs(loadMovesFrames().slice(fromAt))
    // The prelude goes to the edited line's start (the X25 cut's end), then
    // the edited line's own X32 runs; no earlier line (X20) is cut.
    const first32 = fromXs.indexOf(32)
    expect(first32).toBeGreaterThan(0)
    expect(new Set(fromXs.slice(0, first32))).toEqual(new Set([25]))
    expect(fromXs.slice(first32)).toEqual([32, 35, 35, 35])
    // Before the edited line's own move, the rows shown are the one the last
    // run ended on (where the tool is) and then the edited line itself - the
    // plan's lead-in belongs to it. From its move on, every frame shows the
    // executing row.
    const endedOn = [...rest].reverse().find((f) => f.row !== null)?.row ?? null
    const atTarget = fromFrames.findIndex((f) => f.x === 32)
    for (const f of fromFrames.slice(0, atTarget)) expect([endedOn, String(line32)], JSON.stringify(f)).toContain(f.row)
    expect(fromFrames[atTarget].row).toBe(String(line32))
    expectHighlightFollowsExecution(fromFrames.slice(atTarget), 'run from the edited line')
  })


  it('two setups with the same name: editing the loaded one keeps ITS moves (review 10-07, fifth)', async () => {
    camSetup()
    const state = useCamStore.getState()
    const loaded = state.project.setups[0]
    const decoyOp = { ...loaded.operations[0], id: 'op-decoy', name: 'Wrong operation',
      toolpathMoves: loaded.operations[0].toolpathMoves!.map((m) => (m.x === 30 ? { ...m, x: 90 } : { ...m })) }
    const decoy = { ...loaded, id: 'setup-decoy', operations: [decoyOp] }
    const project = { ...state.project, setups: [decoy, loaded] }
    stampGenerationCurrent(project as never, decoy as never, decoyOp as never, state.toolLibrary[0])
    useCamStore.setState({ project: project as never })
    await g54For(-15)
    render(createElement(ProgramPanel))
    await loadSetup('setup-cam')
    expect(loadedProgramText()).toBeNull()
    await cycleStart()
    await pumpRun()
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(lineXs(loadMovesFrames())).toContain(30)
    expect(lineXs(loadMovesFrames())).not.toContain(90)
    lineMenu(3, 'goto')
    const posted = textarea().value
    expect(posted).not.toContain('Wrong operation')
    fireEvent.change(textarea(), { target: { value: posted + '\n(review comment only)' } })
    const before = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    await cycleStart()
    await pumpRun()
    const rerunXs = lineXs(loadMovesFrames().slice(before))
    expect(rerunXs).toContain(30)
    expect(rerunXs).not.toContain(90)
  })

  it('editing a loaded setup starts from the LOADED program, not a CAM change made after Load (review 10-07, sixth)', async () => {
    camSetup()
    await g54For(-15)
    render(createElement(ProgramPanel))
    await loadSetup('setup-cam')
    expect(loadedProgramText()).toBeNull()
    await cycleStart()
    await pumpRun()
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(lineXs(loadMovesFrames())).toContain(30)
    const stagedBefore = useMachineControl.getState().stagedProgram
    // A FAILED Load of another (empty) setup leaves the loaded program - and its source - in place (review, seventh).
    const original = useCamStore.getState().project
    act(() => {
      useCamStore.setState({ project: { ...original, setups: [...original.setups,
        { ...original.setups[0], id: 'empty-review', name: 'Empty review setup', operations: [] }] } as never })
    })
    await loadSetup('empty-review')
    expect(useMachineControl.getState().stagedProgram).toBe(stagedBefore)
    const state = useCamStore.getState()
    const loaded = state.project.setups[0]
    const operation = { ...loaded.operations[0],
      toolpathMoves: loaded.operations[0].toolpathMoves!.map((m) => (m.x === 30 ? { ...m, x: 90 } : { ...m })) }
    const changed = { ...loaded, operations: [operation] }
    const project = { ...state.project, setups: [changed] }
    stampGenerationCurrent(project as never, changed as never, operation as never, state.toolLibrary[0])
    act(() => { useCamStore.setState({ project: project as never }) })
    expect(useMachineControl.getState().stagedProgram).toBe(stagedBefore)
    lineMenu(3, 'goto')
    const posted = textarea().value
    expect(posted).not.toMatch(/X90\b/)
    fireEvent.change(textarea(), { target: { value: posted + '\n(comment only)' } })
    const before = loadMovesFrames().length
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300)
    await cycleStart()
    await pumpRun()
    const rerunXs = lineXs(loadMovesFrames().slice(before))
    expect(rerunXs).toContain(30)
    expect(rerunXs).not.toContain(90)
  })

  it('an operation Load recomputes stays editable from the revision Load staged (review 10-07, eighth)', async () => {
    camSetup()
    const state = useCamStore.getState()
    const setup = state.project.setups[0]
    useCamStore.setState({ project: { ...state.project, setups: [{ ...setup, operations: [{ ...setup.operations[0], status: 'outdated' }] }] } as never })
    await g54For(-15)
    const originalCompute = useCamStore.getState().computeOperationToolpath
    const compute = vi.fn(async () => {
      const now = useCamStore.getState()
      const s0 = now.project.setups[0]
      const operation = { ...s0.operations[0], status: 'ready', toolpathMoves: s0.operations[0].toolpathMoves!.map((m) => (m.x === 30 ? { ...m, x: 90 } : m)) }
      const changed = { ...s0, operations: [operation] }
      const project = { ...now.project, setups: [changed] }
      stampGenerationCurrent({ ...project, toolLibrary: now.toolLibrary } as never, changed as never, operation as never, now.toolLibrary[0])
      useCamStore.setState({ project: project as never })
    })
    useCamStore.setState({ computeOperationToolpath: compute as never })
    try {
      render(createElement(ProgramPanel))
      await loadSetup('setup-cam')
      expect(compute).toHaveBeenCalled()
      await cycleStart(); await pumpRun()
      expect(useMachineControl.getState().job.phase).toBe('complete')
      const baselineXs = lineXs(loadMovesFrames())
      expect(baselineXs).toContain(90)
      lineMenu(3, 'goto')
      const editor = screen.queryByTestId('control-gcode-editor-text') as HTMLTextAreaElement | null
      expect(editor, consoleText().slice(-400)).not.toBeNull()
      fireEvent.change(editor!, { target: { value: editor!.value + '\n(comment only)' } })
      const before = loadMovesFrames().length
      fireEvent.click(screen.getByTestId('control-editor-apply'))
      await advance(300); await cycleStart(); await pumpRun()
      const rerunXs = lineXs(loadMovesFrames().slice(before))
      expect(rerunXs).toContain(90)
      expect(rerunXs).not.toContain(30)
    } finally { useCamStore.setState({ computeOperationToolpath: originalCompute }) }
  })

  it('a comment-only edit keeps a multi-setup program loaded to continue through setups continuous (review 10-07, ninth)', async () => {
    camSetup()
    const state = useCamStore.getState(), first = state.project.setups[0]
    const operation = { ...first.operations[0], id: 'op-second', name: 'Second op' }
    const second = { ...first, id: 'setup-second', name: 'Setup 2', wcs: { ...first.wcs, id: 'w2', label: 'G55', fixtureOffset: 55 }, operations: [operation] }
    const project = { ...state.project, setups: [first, second] }
    stampGenerationCurrent({ ...project, toolLibrary: state.toolLibrary } as never, second as never, operation as never, state.toolLibrary[0])
    useCamStore.setState({ project: project as never })
    await g54For(-15)
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -15]] as const) {
      expect(setWorkOffsetValue('G55', axis, mm)).toBe(true); await vi.advanceTimersByTimeAsync(50)
    }
    render(createElement(ProgramPanel))
    fireEvent.click(screen.getByTestId('control-load-menu'))
    expect((screen.getByTestId('control-load-all-setups-continue') as HTMLInputElement).checked).toBe(true)
    await act(async () => { fireEvent.click(screen.getByTestId('control-load-all-setups')); await Promise.resolve() })
    await advance(300)
    expect(useMachineControl.getState().stagedProgram?.setups).toHaveLength(2)
    await cycleStart(); await pumpRun()
    expect(useMachineControl.getState().job.phase).toBe('complete')
    lineMenu(3, 'goto')
    const editor = textarea()
    fireEvent.change(editor, { target: { value: editor.value + '\n(comment only)' } })
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300); await cycleStart(); await pumpRun()
    expect(useMachineControl.getState().job.phase, consoleText().slice(-600)).toBe('complete')
    // A SECOND comment-only Apply keeps it too (review 10-07, tenth).
    const firstRow = document.querySelector('[data-testid^="control-gcode-line-"]')!.getAttribute('data-testid')!
    lineMenu(Number(firstRow.replace('control-gcode-line-', '')), 'goto')
    const again = textarea()
    fireEvent.change(again, { target: { value: again.value + '\n(second comment)' } })
    fireEvent.click(screen.getByTestId('control-editor-apply'))
    await advance(300); await cycleStart(); await pumpRun()
    expect(useMachineControl.getState().job.phase, consoleText().slice(-600)).toBe('complete')
  })
})
