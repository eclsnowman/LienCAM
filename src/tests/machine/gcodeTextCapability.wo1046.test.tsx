// @vitest-environment jsdom
//
// WO-1046: THE APP IGNORED A CAPABILITY THE BRIDGE DECLARES.
//
// The bridge's hello frame carries `capabilities.gcodeText: false` - the UC100
// path has no G-code interpreter. WO-1021 taught the backend to REFUSE text it
// cannot run, so nothing dangerous went out; but the refusal is silent from the
// operator's side, and `ControlPage` was the ONLY reader of the capability in
// `src/` (one effect, the G20/G21 units sync). The probe routines - every touch
// is `G38.2` text. WO-1042 later gave offset-value cells a typed controller
// intent, so this regression test now distinguishes those live controls from
// the probe actions that remain text-only.
//
// The three things this test pins (1 and 2 re-pinned by WO-1545, which routes
// every app-issued G-code line through the translator and DELETED the
// text-path gate and its connect-time notice):
//
//   1. gcodeText:false -> the probe controls stay LIVE with no text-path hint,
//      and a CALL-shaped control (G54-G59, a `selectWcs` frame) stays LIVE.
//   2. No "no G-code text path" console line at connect, against THE
//      PRODUCTION FRAME SEQUENCE: a real bridge session makes the app's
//      `connected` callback fire TWICE (the controller's own `setPhase` plus
//      the unsolicited `phase: connected` frame the shipped bridge pushes -
//      Bridge.cs). The fixture below sends BOTH.
//   3. gcodeText:true -> BYTE-IDENTICAL DOM for both panels in the slice after
//      removing WO-1042's intentional old-bridge provenance attributes.
//      Held against `src/tests/evidence/WO-2474/baselines/WO-1046-panels-gcodeText-true.html`,
//      captured by running this same render against the PRE-change files
//      (`git checkout 439c17ef -- <the three>`), so it is a real before/after
//      rather than a snapshot of the new behaviour agreeing with itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BridgeCallMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'
import { removeWo2665Wrappers } from './support/wo2665Layout'

/** What the bridge claims in its hello - the one variable under test. */
let gcodeText = false

/** The live transport's callbacks, so the test can push the frames the bridge
 *  pushes on its own after the handshake. Null between sessions. */
let liveBridgeEvents: BridgeTransportEvents | null = null

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    // A bridge that answers the handshake, so the real UccncController and the
    // real panels run unchanged. Same fixture shape as unitsSyncCapability's.
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        // Held module-side so the test can push the bridge's UNSOLICITED
        // `phase: connected` frame after the handshake, exactly as the shipped
        // bridge does. It cannot be sent from inside start(): the controller
        // installs `capabilities` only after `await helloPromise` resolves, so
        // a frame delivered synchronously here would be handled while the
        // capability still reads its default - which is the one ordering that
        // could hide the duplicate this test exists to catch.
        liveBridgeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: {
              geometryQueue: true,
              executingMoveId: true,
              bufferSeconds: true,
              gcodeText,
              perAxisHoming: true,
              ownsSpindle: false,
              // The real bridge derives this from hello.vfd.present; the hello
              // TYPE carries the full capability set, so a fixture must too.
              spindleCommands: false,
            },
            readOnly: false,
          },
        })
      }
      send(_message: BridgeCallMessage): void {}
      async close(): Promise<void> {
        liveBridgeEvents = null
      }
    },
  })
})

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

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  connectMachine,
  controllerTakesGcodeText,
  disconnectMachine,
} = await import('../../lib/machine/machineSession')

const BASELINE = resolve(__dirname, '../evidence/WO-2474/baselines/WO-1046-panels-gcodeText-true.html')
// WO-1182: the marker is an attribute only - no sentence rides on it.
const UNKNOWN_WORK_OFFSET_MARKER = ' data-not-applied=""'

/** Every remaining action whose implementation is G-code TEXT. */
// WO-2063 (v2 brief): the Probing screen's controls are Start probing and
// Stop; the manual touch buttons went with the old screen.
const TEXT_PATH_CONTROLS = [
  'control-probe-run-guided',
  'control-probe-stop',
]

/** WO-1042 routes these through setWorkOffset on the bridge, not through G10. */
const TYPED_OFFSET_CONTROLS = [
  'control-offset-g54-x',
  'control-offset-g54-y',
  'control-offset-g54-z',
]

/** A control with a CALL-shaped route: `selectWcs`, not text. */
const CALL_SHAPED_CONTROL = 'control-wcs-g55'

/** A disconnect does NOT uninstall the backend - `machineSession` keeps the
 *  last controller so a reconnect is the same object. So the "nothing
 *  installed" branch is only reachable before this file's first connect, and
 *  the test that covers it asserts this flag rather than trusting file order
 *  to stay what it is today. */
let everConnected = false

/** Connect the mocked bridge and render both panels of the slice in the one
 *  state that makes every control in them reachable: connected, idle, an
 *  active WCS with real numbers in it, the offset table expanded. */
async function connectAndRender(): Promise<HTMLElement> {
  everConnected = true
  await connectMachine('bridge')
  // THE PRODUCTION FRAME SEQUENCE, not a convenient subset of it. See
  // pushUnsolicitedConnectedFrame: on Operator's machine the app is told
  // `connected` twice for one connection, and a fixture that stops at the
  // hello would let a per-callback console push look like a per-connect one.
  act(() => { pushUnsolicitedConnectedFrame() })
  act(() => {
    useUiPrefs.setState({ machineOffsetsCollapsed: false })
    useMachineControl.setState({
      machineState: 'idle',
      activeWcs: 'G54',
      offsets: { G54: [-101.5, -202.25, -33.125] },
    })
  })
  const { container } = render(
    <>
      <ProbingPanel />
      <OffsetsPanel />
    </>,
  )
  await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
  return container
}

/**
 * The `phase: connected` frame the SHIPPED BRIDGE sends on its own, right after
 * it installs the live console (`pendant/uccnc-bridge/Bridge.cs`) - i.e. after
 * the handshake this fixture's hello completed. `UccncController.handleMessage`
 * forwards it straight to `onConnectionPhase`, so the app's connected callback
 * runs a SECOND time for the same connection, with capabilities already
 * installed. Neither side is wrong to say it; the app has to survive being told
 * twice.
 *
 * The version matches what the controller already published for this session,
 * because that is what the real frame carries (`machine.FirmwareVersion()`) -
 * an invented one would be testing a different frame.
 */
function pushUnsolicitedConnectedFrame(): void {
  const events = liveBridgeEvents
  if (!events) throw new Error('no live bridge session - connect first')
  events.onMessage({
    t: 'phase',
    v: { phase: 'connected', version: 'liencam-uccnc-bridge/0.4' },
  })
}

function control(container: HTMLElement, testId: string): HTMLButtonElement | HTMLInputElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!(el instanceof HTMLButtonElement) && !(el instanceof HTMLInputElement)) {
    throw new Error(`${testId} is not a control in the rendered panels`)
  }
  return el
}

/** The sentence, wherever it hangs - on the control itself or on the wrapper
 *  that exists because a disabled input does not reliably fire a hover. */
function hoverText(container: HTMLElement, testId: string): string | null {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  return el?.closest('[data-tooltip]')?.getAttribute('data-tooltip') ?? null
}

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  // The console is session memory and survives a disconnect on purpose (the
  // operator reads what happened after the drop), so a test counting lines has
  // to start from a known empty one.
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  await disconnectMachine()
  vi.useRealTimers()
})

describe('WO-1046: with no backend installed at all', () => {
  it('answers yes - asking must never install a controller from a render', () => {
    expect(
      everConnected,
      'this case is only reachable before the first connect in this file - keep this describe block first',
    ).toBe(false)
    // Nothing connected: every control in question is already disabled by the
    // connection phase, so a `false` here would only mislabel WHY. And
    // `getMachineController()` INSTALLS a GRBL backend when there is none,
    // which a render must never do.
    expect(controllerTakesGcodeText()).toBe(true)
  })
})

// WO-1545 re-pin: the text-path gate and its connect-time notice are DELETED.
// Every probe command goes through the G-code translator, so a controller that
// takes no text keeps the Probing controls - no grey button, no sentence.
describe('WO-1046 re-pinned by WO-1545: a controller that takes no G-code text keeps its probe controls', () => {
  it('leaves the probe controls live with no text-path hint, and the call-shaped one live', async () => {
    gcodeText = false
    const container = await connectAndRender()

    expect(control(container, 'control-probe-stop').disabled).toBe(false)
    // WO-2008 re-pin: a disabled Start probing says WHY - here its own plan
    // reason, the unread travel limits - so the pin is "no text-path hint",
    // not "no tooltip at all".
    for (const testId of TEXT_PATH_CONTROLS) {
      expect(hoverText(container, testId) ?? '', testId).not.toMatch(/text path|G-code text/i)
    }
    expect(hoverText(container, 'control-probe-run-guided')).toMatch(/travel limits are not known yet/)
    expect(container.innerHTML).not.toContain('no text path')

    for (const testId of TYPED_OFFSET_CONTROLS) {
      expect(control(container, testId).disabled, testId).toBe(false)
      expect(hoverText(container, testId), testId).toBeNull()
    }

    // Both routes that exist stay live: selectWcs and setWorkOffset are typed
    // calls, so there is nothing for the text capability to take away.
    expect(control(container, CALL_SHAPED_CONTROL).disabled).toBe(false)
  })

  it('says no "no G-code text path" line at connect, however many connected frames arrive', async () => {
    gcodeText = false
    await connectAndRender()
    act(() => { pushUnsolicitedConnectedFrame() })

    expect(
      useMachineControl.getState().consoleLines.some((line) => line.text.includes('no G-code text path')),
    ).toBe(false)
  })

  it('asks the CAPABILITY, not the controller type', async () => {
    gcodeText = false
    await connectAndRender()
    expect(controllerTakesGcodeText()).toBe(false)

    // A stub answering the other way flips every verdict, so nothing here can
    // be keying off the backend class (the WO-1024 rule).
    const stub = { capabilities: { gcodeText: true } } as unknown as Parameters<
      typeof controllerTakesGcodeText
    >[0]
    expect(controllerTakesGcodeText(stub)).toBe(true)
  })

})

describe('WO-1046: a controller that DOES take text is untouched', () => {
  it('renders both panels byte-identically apart from WO-1042 provenance markers', async () => {
    gcodeText = true
    const container = await connectAndRender()

    // Operator ruling WO-2600: "We should have a stop or pause that only effects probing,
    // not the entire program." Only the new Pause and Start grid span differ;
    // retain the byte comparison for everything else, including text controls.
    expect(container.querySelector('[data-testid="control-probe-pause"]')?.textContent).toBe('Pause')
    const unchanged = container.cloneNode(true) as HTMLElement
    unchanged.querySelector('[data-testid="control-probe-pause"]')?.remove()
    const start = unchanged.querySelector<HTMLElement>('[data-testid="control-probe-run-guided"]')
    // Only the grid span is excused; any other inline style still fails the byte comparison.
    if (start) { start.style.removeProperty('grid-column'); if (!start.getAttribute('style')?.trim()) start.removeAttribute('style') }
    // WO-2764: WO-2665's center column and identity picture-scale wrappers are excused, nothing else.
    removeWo2665Wrappers(unchanged)
    const rendered = unchanged.innerHTML
    // WO-2063: 25 + one - the Probing screen now shows Main's own Position
    // panel, whose active work offset chip carries the WO-1042 marker too.
    expect(rendered.split(UNKNOWN_WORK_OFFSET_MARKER)).toHaveLength(26)
    // Regenerate the baseline deliberately (WRITE_EVIDENCE=1), never by default.
    if (process.env.WRITE_EVIDENCE === '1') {
      writeFileSync(BASELINE, rendered.replaceAll(UNKNOWN_WORK_OFFSET_MARKER, ''))
    }
    expect(rendered.replaceAll(UNKNOWN_WORK_OFFSET_MARKER, '')).toBe(readFileSync(BASELINE, 'utf-8'))
  })

  it('leaves every text-path control live and adds no hint to it', async () => {
    gcodeText = true
    const container = await connectAndRender()

    expect(controllerTakesGcodeText()).toBe(true)
    expect(control(container, 'control-probe-stop').disabled).toBe(false)
    expect(hoverText(container, 'control-probe-stop') ?? '').not.toMatch(/text path|G-code text/i)
    expect(control(container, 'control-offset-g54-x').disabled).toBe(false)
    expect(hoverText(container, 'control-offset-g54-x')).toBeNull()
    expect(container.innerHTML).not.toContain('no text path')
    expect(
      useMachineControl.getState().consoleLines.some((line) => line.text.includes('no G-code text path')),
    ).toBe(false)
  })
})
