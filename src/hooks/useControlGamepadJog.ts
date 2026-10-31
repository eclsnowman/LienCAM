// useControlGamepadJog - the gamepad's step jog, scoped to the Control
// workspace (WO-3259, WO-3181 phase A).
//
// Mounted once in ControlPage beside useControlJogKeys, as
// `useEffect(() => startControlGamepadJog(kind), [kind])`: the architecture
// boundary keeps React out of src/hooks for new code, so this file exports the
// installer and its teardown, and the page owns the effect. ControlPage stays
// mounted under display:none when another workspace shows, so the installer
// subscribes to the workspace itself and stops the moment Control is left.
//
// It follows the session Enable on its own (useGamepadJogSession) and reads
// the pad through gamepadJogInput's snapshot provider every
// GAMEPAD_POLL_MS while the session Enable is on (and not at all otherwise),
// hands each read to GamepadJogMachine, and carries out what comes back:
//   jog     the SAME wrapped controller.jog the Jog panel's step mode calls,
//           asked first with the Jog panel's own question,
//           authorize('jog', currentJogAuthorityFacts(...)); sent inside this
//           step's WO-3258 gesture token so the session knows it is ours.
//   cancel  controller.jogCancel inside the same token - only for a step this
//           adapter still owns. Another input's intent or any stop ends that
//           ownership first (subscribeManualMotionInput), so a late release
//           never cancels someone else's move.
//   say     one sentence on the console, the machine's message surface.
//
// Leaving Control, a dialog, typing focus, blur, a hidden page, pagehide and a
// pad disconnect stop the owned step now (not at the next read) and drop the
// arm; coming back needs every button let go first, so nothing replays.

import { textFor } from '../i18n'
import { controlMachine, useCamStore } from '../store'
import { parkCarrierMachine } from '../store/machineActionsStore'
import { useMachineControl } from '../store/machineControlStore'
import { useUiPrefs } from '../store/uiPrefs'
import { getMachineController } from '../lib/machine/machineSession'
import { enabledControlAxes } from '../lib/machine/controller'
import { authorize } from '../lib/machine/operatorAuthority'
import {
  currentJogAuthorityFacts,
  currentPauseTakesCommands,
  type SelectedConnectionKind,
} from '../lib/machine/jogAuthorityFacts'
import {
  createManualJogGesture,
  subscribeManualMotionInput,
  withManualJogGesture,
  type ManualJogGesture,
} from '../lib/machine/manualJogInputContext'
import {
  GAMEPAD_POLL_MS,
  GamepadJogMachine,
  findGamepad,
  gamepadSnapshots,
  readGamepadJogPrefs,
  useGamepadJogSession,
  type GamepadJogAction,
  type GamepadJogHoldReason,
} from '../lib/machine/gamepadJogInput'
import { dialogOpen } from './useControlJogKeys'

const gamepadText = textFor('gamepad-jog.wo3259')

/** One line of the desk trace: what was read, asked, sent and cancelled, on
 *  the same monotonic clock (performance.now). Bounded; evidence only. */
export interface GamepadJogTraceEvent {
  t: number
  event: 'read' | 'jog' | 'cancel' | 'say' | 'leave' | 'intent' | 'stop' | 'connection' | 'phase'
  detail: string
}

const TRACE_LIMIT = 500
const trace: GamepadJogTraceEvent[] = []

function note(event: GamepadJogTraceEvent['event'], detail: string): void {
  trace.push({ t: performance.now(), event, detail })
  if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT)
}

export function gamepadJogTrace(): readonly GamepadJogTraceEvent[] {
  return trace.slice()
}

export function clearGamepadJogTrace(): void {
  trace.length = 0
}

function typingFocused(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/** Control is not the workspace in use: another workspace, a dialog, typing,
 *  a hidden page. (A blurred window is tracked by the hook's own blur/focus
 *  listeners: document.hasFocus is not dependable in every host.) */
export function gamepadJogAway(): boolean {
  return useCamStore.getState().workspace !== 'control'
    || dialogOpen()
    || typingFocused()
    || (typeof document !== 'undefined' && document.hidden)
}

/** Install the gamepad step jog for Control; returns its teardown. Reads the
 *  pad only while the session Enable is on. */
export function startControlGamepadJog(selectedConnectionKind?: SelectedConnectionKind): () => void {
  let stopReading: (() => void) | null = null
  const follow = (enabled: boolean) => {
    if (enabled && stopReading === null) stopReading = startReading(selectedConnectionKind)
    if (!enabled && stopReading !== null) {
      stopReading()
      stopReading = null
    }
    if (!enabled) useGamepadJogSession.setState({ phase: 'session-disabled', hold: 'disabled' })
  }
  follow(useGamepadJogSession.getState().enabled)
  const unsubscribe = useGamepadJogSession.subscribe((state, previous) => {
    if (state.enabled !== previous.enabled) follow(state.enabled)
  })
  return () => {
    unsubscribe()
    follow(false)
  }
}

function startReading(selectedConnectionKind?: SelectedConnectionKind): () => void {
  const machine = new GamepadJogMachine()
  const tokens = new Map<number, ManualJogGesture>()
  const ours = new Set<ManualJogGesture>()
  let lastRead = ''
  let blurred = false

  const publish = () => {
    const session = useGamepadJogSession.getState()
    if (session.phase !== machine.phase || session.hold !== machine.hold) {
      note('phase', `${machine.phase}${machine.hold === null ? '' : ` (${machine.hold})`}`)
      useGamepadJogSession.setState({ phase: machine.phase, hold: machine.hold })
    }
  }

  const run = (actions: GamepadJogAction[]) => {
    for (const action of actions) {
      if (action.type === 'jog') {
        const token = createManualJogGesture(`gamepad step ${action.gesture}`)
        tokens.set(action.gesture, token)
        ours.add(token)
        const sent = withManualJogGesture(token, () =>
          getMachineController().jog(action.axis, action.deltaMm, action.feedMmMin))
        note('jog', `${action.axis} ${action.deltaMm} F${action.feedMmMin} -> ${sent ? 'sent' : 'refused'}`)
      } else if (action.type === 'cancel') {
        const token = tokens.get(action.gesture)
        if (token === undefined) continue
        withManualJogGesture(token, () => getMachineController().jogCancel())
        note('cancel', `step ${action.gesture}`)
      } else {
        const text = action.text === 'simultaneous'
          ? gamepadText('saySimultaneous')
          : action.text === 'axis-not-enabled'
            ? gamepadText('sayAxisNotEnabled', { axis: action.axis ?? '' })
            : gamepadText('sayRefused', { refusal: action.refusal ?? '' })
        useMachineControl.getState().pushConsole('tx', text, 'error')
        note('say', action.text)
      }
    }
    publish()
  }

  const leave = (hold: GamepadJogHoldReason, why: string) => {
    note('leave', why)
    run(machine.leave(hold))
  }

  const tick = () => {
    const prefs = readGamepadJogPrefs(useUiPrefs.getState().gamepadJog)
    const pad = prefs.status === 'ok' ? findGamepad(gamepadSnapshots(), prefs.prefs.deviceFingerprint) : null
    const mc = useMachineControl.getState()
    const cam = useCamStore.getState()
    const gate = authorize('jog', currentJogAuthorityFacts({
      pauseTakesCommands: currentPauseTakesCommands(),
      machine: controlMachine(cam),
      parkMachine: parkCarrierMachine(cam),
      selectedConnectionKind,
    }))
    const uiPrefs = useUiPrefs.getState()
    if (pad !== null) {
      const read = `${pad.index}:${pad.buttons.map((b) => (b.pressed ? 1 : 0)).join('')}:${pad.axes.map((a) => a.toFixed(2)).join(',')}`
      if (read !== lastRead) note('read', read)
      lastRead = read
    }
    run(machine.step({
      now: performance.now(),
      enabled: true,
      prefs,
      pad,
      away: blurred || gamepadJogAway(),
      jogAllowed: gate.allowed,
      jogRefusal: gate.refusal,
      enabledAxes: enabledControlAxes(controlMachine(cam).controllerDefinition ?? null),
      machineState: mc.machineState,
      machineJogStepMm: uiPrefs.machineJogStepMm,
      machineJogFeedMmMin: uiPrefs.machineJogFeedMmMin,
    }))
  }

  const unsubscribeMotion = subscribeManualMotionInput((event) => {
    if (event.type === 'intent') {
      if (event.gesture !== null && ours.has(event.gesture)) return
      note('intent', `${event.kind} ${event.what}`)
      machine.noteExternalIntent()
    } else if (event.type === 'stop') {
      if (event.gesture !== null && ours.has(event.gesture)) return
      note('stop', event.kind)
      run(machine.noteStop(event.kind))
    } else {
      note('connection', String(event.generation))
      run(machine.noteConnection())
    }
  })
  const unsubscribeWorkspace = useCamStore.subscribe((state, previous) => {
    if (state.workspace !== previous.workspace && state.workspace !== 'control') leave('away', 'workspace')
    else if (state.activeModal && !previous.activeModal) leave('away', 'dialog')
  })
  const onBlur = () => { blurred = true; leave('away', 'blur') }
  const onFocus = () => { blurred = false }
  const onHidden = () => { if (document.hidden) leave('away', 'hidden') }
  const onPageHide = () => leave('away', 'pagehide')
  const onFocusIn = () => { if (typingFocused()) leave('away', 'typing') }
  const onPadGone = () => tick()
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('gamepaddisconnected', onPadGone)
  document.addEventListener('visibilitychange', onHidden)
  document.addEventListener('focusin', onFocusIn)

  tick()
  const timer = setInterval(tick, GAMEPAD_POLL_MS)
  return () => {
    clearInterval(timer)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('gamepaddisconnected', onPadGone)
    document.removeEventListener('visibilitychange', onHidden)
    document.removeEventListener('focusin', onFocusIn)
    unsubscribeWorkspace()
    unsubscribeMotion()
    leave('disabled', 'disabled')
    useGamepadJogSession.setState({ phase: 'session-disabled', hold: 'disabled' })
  }
}
