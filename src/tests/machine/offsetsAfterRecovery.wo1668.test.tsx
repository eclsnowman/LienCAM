// @vitest-environment jsdom
//
// WO-1668: after a board recovery the offsets card and the fit check read the
// live state.
//
// THE FINDING (hardware session 2026-09-17, docs/machine/NEXT-HARDWARE-SESSION.md
// "After the recovery - screen findings and the G54 restore"; frames
// src/tests/evidence/WO-1548/machine-2026-09-17/session.ws-frames.calls-replies.ndjson):
// the AXBB-E power-cycled on a drive fault, the bridge reopened the board on
// its own (attempt 11), re-applied the definition, and the app re-sent every
// work offset. Then:
//   (o) the Main WORK OFFSETS card showed G54/G55/G56 as "-" with NO cells
//       while the Offsets sub-tab held them ("Push changed (3)"). The wire
//       shows why: the restore's setWorkOffset receipts came back 67 s (G54),
//       53 s (G55) and 37 s (G56) after their calls - every one past the
//       controller's 8 s CALL_TIMEOUT_MS while the bridge dug out of the
//       reopen backlog - and the restore walked on without them. G57/G58/G59
//       (22 s, 9 s, 5 s) made it. The board had applied ALL six writes; the
//       app had dropped three receipts on the floor.
//   (p) pushing G54 Z 66.57 re-ran the envelope fit against the FINISHED
//       one-move `G28 Z18` MDI program still staged from before the crash and
//       printed "OUTSIDE - Program (after G54) lies entirely off the table on
//       Z (Z: program -43.43..-43.43, table 0..129.1, machine coordinates)".
//
// Reproduced here through the REAL UccncController on the real session
// singleton over a fake bridge that replays the recorded frame sequence:
// every setWorkOffset call IS answered (the board applied them all), but the
// reopen window's replies arrive LATE - the per-call latencies are the
// recorded ones by call ordinal (67 s, 53 s, 37 s, 22 s, 9 s, 5 s, then 5 s
// once the backlog has drained).
//
// NOT CLAIMED: hardware. The same replay on machine PC is owed (Tier 1).

import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus, QueuedMove } from '../../lib/machine/controller'
import type { MachineVec3, WcsId } from '../../lib/machine/types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

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

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const EFFECTIVE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const ZERO: MachineVec3 = { x: 0, y: 0, z: 0 }
/** The durable record at the moment of the crash: G54 Z is the 110 the
 *  operator typed at 19:26, G55 Z 110 from the session, G56..G59 agreed zeros. */
const STORED: Record<WcsId, MachineVec3> = {
  G54: { x: 188.7325, y: 397.655, z: 110 },
  G55: { x: 288.7325, y: 397.655, z: 110 },
  G56: { ...ZERO },
  G57: { ...ZERO },
  G58: { ...ZERO },
  G59: { ...ZERO },
}
/** What the reopened board woke with (the profile's start-up rows, per the
 *  connect log: "datum G54: X 81.2275, Y 61.3225, Z 12.16"). */
const BOARD_WAKE: Record<WcsId, MachineVec3> = {
  G54: { x: 81.2275, y: 61.3225, z: 12.16 },
  G55: { ...ZERO },
  G56: { ...ZERO },
  G57: { ...ZERO },
  G58: { ...ZERO },
  G59: { ...ZERO },
}

/** Recorded reply latencies for the six restore calls, by call ordinal. */
const RECORDED_RESTORE_REPLY_LATENCIES_MS = [67_000, 53_000, 37_000, 22_000, 9_000, 5_000]

let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let board: Record<string, MachineVec3> = {}
/** True once the reopen line has been emitted: replies arrive late. */
let recoveryWindow = false
let recoveryCallOrdinal = 0

function cloneOffsets(offsets: Record<WcsId, MachineVec3>): Record<string, MachineVec3> {
  return Object.fromEntries(Object.entries(offsets).map(([k, v]) => [k, { ...v }]))
}

function helloFrame(offsets: Record<WcsId, MachineVec3>): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: 1,
      bridge: 'wo-1668-fake-bridge',
      capabilities: EFFECTIVE_CAPABILITIES,
      readOnly: false,
      workOffsets: { current: cloneOffsets(offsets), profile: cloneOffsets(offsets) },
    },
  } as BridgeMessage
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        events.onMessage(helloFrame(STORED))
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        if (message.m === 'selectWcs') {
          bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
          return
        }
        if (message.m !== 'setWorkOffset') return
        const answer = () => {
          const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
          const row = board[a.wcs]
          board[a.wcs] = { x: a.x ?? row.x, y: a.y ?? row.y, z: a.z ?? row.z }
          bridgeEvents?.onMessage({
            t: 'reply',
            seq: message.seq,
            ok: true,
            v: { ok: true, reason: null, offset: { ...board[a.wcs] } },
          })
        }
        if (!recoveryWindow) {
          answer()
          return
        }
        const latency = RECORDED_RESTORE_REPLY_LATENCIES_MS[
          Math.min(recoveryCallOrdinal, RECORDED_RESTORE_REPLY_LATENCIES_MS.length - 1)
        ]
        recoveryCallOrdinal += 1
        setTimeout(answer, latency)
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { resetProgramFitConsole } = await import('../../components/machine/ProgramFitStatusLine')
const { fmtMachineLength } = await import('../../lib/ui/unitFormat')
const session = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1668-liencnc-v2'

/** Operator's table as the OUTSIDE row reported it: 0..738 / 0..724.5 / 0..129.1. */
function sampleMachineTable() {
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1668 LienCNC V2',
    travel: { x: 738, y: 724.5, z: 129.1 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
}

function idleStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 738, y: 724.5, z: 128.9 },
    workPos: { x: 549.268, y: 326.845, z: 18.9 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

async function connectBridge(): Promise<void> {
  const pending = session.connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  session.__resetEstopInterlockForTest()
  bridgeEvents?.onMessage({ t: 'status', v: idleStatus() } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  sent = []
}

/** The recorded recovery: the reopened board reports its wake values, then
 *  proves the reopen through the unchanged console line (WO-1331's shape),
 *  and every restore reply arrives late by the recorded latencies. */
function emitRecordedReopen(): void {
  recoveryWindow = true
  recoveryCallOrdinal = 0
  bridgeEvents?.onMessage(helloFrame(BOARD_WAKE))
  bridgeEvents?.onMessage({
    t: 'console',
    v: {
      dir: 'rx',
      text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 11) - this link is live, '
        + 'the profile above was read back off the board',
      severity: 'info',
    },
  } as BridgeMessage)
}

function fitRows(): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((text) => text.includes('Program (after'))
}

function offsetInput(wcs: string, axis: string): HTMLInputElement | null {
  return screen.queryByTestId(`control-offset-${wcs}-${axis}`) as HTMLInputElement | null
}

beforeEach(() => {
  // requestAnimationFrame stays the local mock above (fake timers would
  // collide with its defineProperty); everything else is fake time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  cleanup()
  localStorage.clear()
  resetProgramFitConsole()
  sent = []
  recoveryWindow = false
  recoveryCallOrdinal = 0
  board = cloneOffsets(STORED)
  useCamStore.getState().newProject()
  useCamStore.setState((state) => ({ project: { ...state.project, machine: sampleMachineTable() } }))
  useCamStore.setState({ machineWorkOffsets: {} })
  for (const wcs of Object.keys(STORED) as WcsId[]) {
    useCamStore.getState().setMachineWorkOffset(MACHINE_ID, wcs, { ...STORED[wcs] }, 'restored')
  }
  useUiPrefs.setState({ machineOffsetsCollapsed: false })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    connectionKind: null,
    offsets: {},
    consoleLines: [],
    programFit: null,
    activeWcs: 'G54',
  })
})

afterEach(async () => {
  cleanup()
  session.clearPathFidelity()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1668 defect 1: the reopen restore reads the board back', () => {
  it('keeps sending until the late receipts land - the card shows what the sub-tab holds', async () => {
    await connectBridge()
    render(createElement(OffsetsPanel))
    // Sanity: the connect reconcile agreed every row, so the card starts full.
    expect(offsetInput('g54', 'x')?.value).toBe(fmtMachineLength(188.7325, 'mm'))
    expect(offsetInput('g56', 'z')?.value).toBe(fmtMachineLength(0, 'mm'))

    emitRecordedReopen()
    // The restore clears the live table up front (WO-1331) and re-sends every
    // frame; the receipts arrive 67/53/37/22/9/5 s late by call ordinal.
    await act(async () => {
      for (let second = 0; second < 120; second += 1) await vi.advanceTimersByTimeAsync(1000)
    })

    // One source, both views: the card shows exactly what the sub-tab holds.
    const live = useMachineControl.getState().offsets
    for (const wcs of Object.keys(STORED) as WcsId[]) {
      expect(live[wcs]).toEqual([STORED[wcs].x, STORED[wcs].y, STORED[wcs].z])
      expect(offsetInput(wcs.toLowerCase(), 'x')?.value).toBe(fmtMachineLength(STORED[wcs].x, 'mm'))
      expect(offsetInput(wcs.toLowerCase(), 'z')?.value).toBe(fmtMachineLength(STORED[wcs].z, 'mm'))
      expect(useCamStore.getState().machineWorkOffsets[MACHINE_ID]?.[wcs]?.state).toBe('restored')
    }
    // Every unrestored frame was retried to a landing: no unrestored line.
    expect(
      useMachineControl.getState().consoleLines.map((line) => line.text)
        .filter((text) => text.startsWith('Work zero was not restored')),
    ).toEqual([])
    // The recorded restore said so, once per frame.
    const restoredRows = useMachineControl.getState().consoleLines
      .map((line) => line.text)
      .filter((text) => text.startsWith('Work zero restored from this computer'))
    expect(restoredRows).toHaveLength(6)
  })
})

describe('WO-1668 defect 2: the fit check reads the live program state', () => {
  /** The finished one-move `G28 Z18` MDI program: one rapid to work
   *  X335 Y40 Z-110 (machine Z 0 against the then-active G54 Z 110). */
  const STALE_MDI: QueuedMove[] = [
    { id: 1, kind: 'line', to: { x: 335, y: 40, z: -110 }, feedMmMin: 3000, rapid: true },
  ]

  function stageStaleMdi(jobPhase: 'complete' | 'ready'): void {
    session.armPathFidelityFromMoves(STALE_MDI, 'work')
    useMachineControl.setState({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      activeWcs: 'G54',
      homed: true,
      offsets: { G54: [STORED.G54.x, STORED.G54.y, 120] },
      job: {
        phase: jobPhase,
        name: 'G28 Z18',
        totalLines: 1,
        sentLines: 1,
        ackedLines: 1,
        ackedSourceLine: 1,
        sentSourceLine: 1,
        startedAt: 0,
        pausedAt: null,
        error: null,
        toolChanges: [],
      },
    })
  }

  async function pushG54Z(value: number): Promise<void> {
    await act(async () => {
      expect(session.setWorkOffsetValue('G54', 'Z', value)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    })
  }

  it('a finished MDI program is not re-fit-checked by a later offset push', async () => {
    await connectBridge()
    stageStaleMdi('complete')
    render(createElement(ProgramPreview))

    // The exact gesture from the finding: G54 Z pushed down to 66.57.
    await pushG54Z(66.57)

    // The offset took (the card's live value is the receipt's), and NOTHING
    // re-judged the finished move against it.
    expect(useMachineControl.getState().offsets.G54).toEqual([STORED.G54.x, STORED.G54.y, 66.57])
    expect(fitRows()).toEqual([])
    expect(useMachineControl.getState().programFit).toBeNull()
  })

  it('an armed program is fit-checked on the same push', async () => {
    await connectBridge()
    stageStaleMdi('ready')
    render(createElement(ProgramPreview))
    // G54 Z 120 places the move at machine Z 10: inside, and silent.
    expect(fitRows()).toEqual([])

    await pushG54Z(66.57)

    // The SAME program, armed, is judged against the SAME push - the check
    // runs on the program that can still be started.
    expect(useMachineControl.getState().programFit?.state).toBe('outside')
    const rows = fitRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('OUTSIDE - Program (after G54) lies entirely off the table on Z')
    expect(rows[0]).toContain('program -43.43..-43.43')
  })
})
