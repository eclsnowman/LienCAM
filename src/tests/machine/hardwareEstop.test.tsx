// @vitest-environment jsdom
//
// A PHYSICAL E-STOP IS AN E-STOP.
//
// Operator, at the machine 2026-08-23: "if I hit the physical e-stop it doesn't
// display on the machine. the e-stop on the machine in the software should
// know if I hit the physical stop. that's a requirement for me." His ruling on
// what it should then do: the same as a software E-STOP - the machine IS
// stopped, so clearing it must be a deliberate act.
//
// Until the bridge fix of the same day this could not be written at all. The
// AXBB's GetStatus returns UC100_ESTOP (rc 7, measured) while the button is
// in, and the bridge turned every non-zero rc into state 'unknown' with the
// whole inputs block nulled - so `inputs.estop` never once arrived as true,
// and nothing in src/ read it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCallMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

let emit: ((m: unknown) => void) | null = null
/** What the board is currently reporting, so a queryStatus answers with it. */
let boardEstop = false

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        emit = (m) => events.onMessage(m as never)
        emit({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: {
              geometryQueue: true, executingMoveId: true, bufferSeconds: true,
              gcodeText: false, perAxisHoming: true,
              ownsSpindle: false, spindleCommands: false,
            },
            readOnly: false,
          },
        })
      }
      // The real bridge ANSWERS. A fake that swallows calls makes every path
      // that awaits one (resetToIdle, the reset confirm) fail for a reason
      // that has nothing to do with what is under test.
      send(message: BridgeCallMessage): void {
        if (message.m === 'queryStatus') report(boardEstop)
        // A MOCK MUST CARRY THE REAL SHAPE. resetToIdle's caller reads
        // `.ok` off the reply value, so a bare `true` makes every clear look
        // refused - for a reason that has nothing to do with the e-stop.
        emit?.({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: message.m === 'resetToIdle' ? { ok: true, reason: null } : true,
        })
      }
      async close(): Promise<void> { emit = null }
    },
  })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
  configurable: true,
})

const { connectMachine, disconnectMachine, estopNeedsReset, resetEstop, ESTOP_RESET_REFUSAL } =
  await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
/** mirrors machineSession.ts */
const ESTOP_RESET_DEBOUNCE_MS = 600

const BASE: MachineStatus = {
  state: 'idle', subState: null, machinePos: null, workPos: null,
  feedMmMin: null, spindleRpm: null, overrides: null, executingMoveId: null,
  buffer: null, inputs: null, homed: null, spindle: null,
}

/** One status frame, as the patched bridge sends it. */
function report(estop: boolean) {
  boardEstop = estop
  emit?.({
    t: 'status',
    v: {
      ...BASE,
      state: estop ? 'alarm' : 'idle',
      // The bridge states what it knows and nulls what it does not - `false`
      // on an input it cannot read would be a licence to show a machine safe.
      inputs: estop
        ? { estop: true, hardLimit: null, softLimit: null, probe: null, limits: null, door: null, hold: null }
        : { estop: false, hardLimit: false, softLimit: false, probe: false, limits: null, door: null, hold: false },
    },
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  await connectMachine('bridge')
  // WO-1349 deliberately repins WO-1182: a clean status cannot release the
  // fresh-connect latch. CLEAR it deliberately so these four cases continue
  // to isolate the later physical E-STOP edge they were written to prove.
  report(false)
  expect(await resetEstop()).toEqual({ ok: true })
  expect(estopNeedsReset()).toBe(false)
})

afterEach(async () => {
  await disconnectMachine()
  vi.useRealTimers()
})

describe('a physical e-stop is an e-stop', () => {
  it('arms the latch when the machine reports the button is in', async () => {
    report(true)
    await vi.advanceTimersByTimeAsync(10)

    // The requirement, as one assertion.
    expect(estopNeedsReset()).toBe(true)
  })

  it('stays armed after the button is released - clearing is deliberate', async () => {
    report(true)
    await vi.advanceTimersByTimeAsync(10)
    report(false)
    await vi.advanceTimersByTimeAsync(10)

    // Operator's ruling: same as a software E-STOP. A stop the operator did not
    // initiate must not un-happen by itself the moment the cause goes away.
    expect(estopNeedsReset()).toBe(true)
  })

  it('arms on the RISING EDGE, so a held button cannot block its own clear', async () => {
    // The bug this pins is not hypothetical. armEstopNeedsReset() restarts the
    // anti-double-tap debounce, and the keepalive polls status every 750 ms -
    // so arming on every frame instead of on the edge would keep the debounce
    // permanently fresh and answer every clear attempt with `tooSoon`, for as
    // long as the operator held the button and 600 ms beyond.
    report(true)
    await vi.advanceTimersByTimeAsync(10)

    for (let frame = 0; frame < 8; frame++) {
      report(true)
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(ESTOP_RESET_DEBOUNCE_MS + 50)

    const result = await resetEstop()
    // EstopResetResult is a discriminated union - only the refusing arm has a
    // reason, so read it through the discriminant rather than off the union.
    const reason = result.ok ? null : result.reason
    expect(reason).not.toBe(ESTOP_RESET_REFUSAL.tooSoon)
  })

  it('re-arms on a NEW press after a clear', async () => {
    report(true)
    await vi.advanceTimersByTimeAsync(10)
    report(false)
    await vi.advanceTimersByTimeAsync(ESTOP_RESET_DEBOUNCE_MS + 50)
    expect((await resetEstop()).ok).toBe(true)
    expect(estopNeedsReset()).toBe(false)

    // Edge-triggering must not mean once-only.
    report(true)
    await vi.advanceTimersByTimeAsync(10)

    expect(estopNeedsReset()).toBe(true)
  })
})
