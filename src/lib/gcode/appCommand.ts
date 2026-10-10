// ============================================================
// WO-1545 - EVERY G-CODE LINE THE APP ITSELF ISSUES GOES THROUGH HERE
// ============================================================
// WO-1335 built the translator for FILES (reader.ts / interpret.ts). The app's
// own features - probe cycles, offset writes, the units sync, park, TLO - kept
// writing raw lines with `sendCommand`, and a controller that takes geometry
// instead of text (UCCNC) refused every one. The app then told the operator
// "this controller has no G-code text path" as if that were the machine's
// limit. It was our shortcut.
//
// ONE LAYER, EVERY SENDER. A controller that takes text (GRBL, the simulator)
// gets the line exactly as before. A controller that does not gets it
// translated:
//   - G20/G21/G90/G91 are modal state, held here per controller - nothing sent
//     (G17/G40/G80/G94 are the fixed states and are accepted as no change);
//   - a command whose native call is a later WO-1545 slice (probe, work offset,
//     TLO, geometry moves) names itself and the slice, and nothing is sent -
//     never reported as a controller limit or a probe miss;
//   - a command with no controller equivalent names itself and what does it.
// ============================================================

import type { MachineController } from '../machine/controller'
import { tokenizeLine } from './parse'
import {
  gcodeWordEntry,
  gcodeWordRefusal,
  gcodeWordRefusalIfAbsent,
  gcodeWordTable,
  type GcodeTableDialect,
  type GcodeWordCategory,
} from './wordTable'

export type AppCommandUnits = 'mm' | 'inch'
export type AppCommandDistance = 'absolute' | 'incremental'

/** The modal state a controller without an interpreter cannot hold itself. */
export interface AppCommandModal {
  units: AppCommandUnits
  distanceMode: AppCommandDistance
}

/** What the line becomes on a controller that takes geometry. */
export type AppCommandPlan =
  | { kind: 'modal'; units: AppCommandUnits | null; distanceMode: AppCommandDistance | null }
  | { kind: 'notWired'; slice: 2 | 3 | 4; what: string }
  | { kind: 'noEquivalent'; what: string }

export interface AppCommandOutcome {
  ok: boolean
  /** Why it did not run, naming the command; the controller's own message on
   *  the text route. */
  message: string | null
  /** True only when the line reached the controller. */
  sent: boolean
  /** Null on the text route; otherwise what the line was translated into. */
  translated: AppCommandPlan['kind'] | null
  /** The modal state after the line, when the line changed it locally. */
  modal: AppCommandModal | null
}

const DEFAULT_MODAL: AppCommandModal = { units: 'mm', distanceMode: 'absolute' }
const modalByController = new WeakMap<MachineController, AppCommandModal>()

/** The locally held modal state for a controller without an interpreter. */
export function appCommandModal(ctrl: MachineController): AppCommandModal {
  return { ...(modalByController.get(ctrl) ?? DEFAULT_MODAL) }
}

/** A new connection starts from the power-on modal state. */
export function resetAppCommandModal(ctrl: MachineController): void {
  modalByController.delete(ctrl)
}

const MODAL_G = new Map<number, Partial<AppCommandModal>>([
  [20, { units: 'inch' }],
  [21, { units: 'mm' }],
  [90, { distanceMode: 'absolute' }],
  [91, { distanceMode: 'incremental' }],
  // WO-1636: the states a geometry controller is always in - XY plane, no
  // cutter compensation, no canned cycle, units-per-minute feed. Stating them
  // changes nothing, so they are held (as no change) rather than refused.
  [17, {}],
  [40, {}],
  [80, {}],
  [94, {}],
  // WO-1644: path control. The geometry route blends by the board's own
  // settings whichever is stated, as a loaded program's G61/G64 does.
  [61, {}],
  [64, {}],
])

/** The G words a line may carry on its own as held modal state. */
export const APP_COMMAND_HELD_G: ReadonlySet<number> = new Set(MODAL_G.keys())

/** The table categories whose words move the machine or dwell. */
const MOVE_CATEGORIES: ReadonlySet<GcodeWordCategory> = new Set([
  'motion', 'dwell', 'home', 'reference point', 'machine frame', 'canned cycle',
])

/** Read one app-issued line into what it becomes without a text path. Pure.
 *  Every G word is classified by its category in the dialect's word table
 *  (WO-1644); the bridge that takes geometry is UCCNC's. */
export function planAppCommand(line: string, dialect: GcodeTableDialect = 'uccnc'): AppCommandPlan {
  const table = gcodeWordTable(dialect)
  const categoryOf = (g: number): GcodeWordCategory | null => gcodeWordEntry(table, 'G', g)?.category ?? null
  const text = line.trim()
  if (text.startsWith('$')) {
    return {
      kind: 'noEquivalent',
      what: 'a GRBL setting write has no call on this controller; its settings come from the machine definition',
    }
  }
  const words = tokenizeLine(text, 1).words.filter((w) => w.letter !== 'N')
  const gs = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10)
  if (gs.some((g) => Math.floor(g) === 38)) {
    return { kind: 'notWired', slice: 2, what: 'the probe touch (the native probe call)' }
  }
  if (gs.some((g) => categoryOf(g) === 'offset write' || categoryOf(g) === 'work offset')) {
    return { kind: 'notWired', slice: 3, what: 'the work-offset command (the controller offset calls)' }
  }
  if (gs.some((g) => categoryOf(g) === 'tool length offset')) {
    return { kind: 'notWired', slice: 4, what: 'the tool-length offset (applied to moves)' }
  }
  const axisWords = words.some((w) => 'XYZABCIJKR'.includes(w.letter))
  if (axisWords || gs.some((g) => !MODAL_G.has(g) && MOVE_CATEGORIES.has(categoryOf(g) as GcodeWordCategory))) {
    return { kind: 'notWired', slice: 4, what: 'the move (geometry moves)' }
  }
  const unknown = words.find((w) => (w.letter === 'G' || w.letter === 'M') && gcodeWordRefusalIfAbsent(table, w.letter, w.value) !== null)
  if (unknown) {
    return { kind: 'noEquivalent', what: gcodeWordRefusal(table, unknown.letter, unknown.value).replace(/\.$/, '') }
  }
  const unhandled = words.find((w) => !(w.letter === 'G' && MODAL_G.has(w.value)))
  if (unhandled) {
    return {
      kind: 'noEquivalent',
      what: `${unhandled.letter}${unhandled.value} has no call on this controller; a loaded program runs it through the file translator`,
    }
  }
  let units: AppCommandUnits | null = null
  let distanceMode: AppCommandDistance | null = null
  for (const g of gs) {
    const change = MODAL_G.get(g)
    if (change?.units) units = change.units
    if (change?.distanceMode) distanceMode = change.distanceMode
  }
  return { kind: 'modal', units, distanceMode }
}

function translate(ctrl: MachineController, line: string): AppCommandOutcome {
  if (ctrl.connectionPhase() !== 'connected') {
    return {
      ok: false,
      message: `${line}: not connected to a machine, so nothing was sent.`,
      sent: false,
      translated: null,
      modal: null,
    }
  }
  const plan = planAppCommand(line)
  if (plan.kind === 'modal') {
    const next = appCommandModal(ctrl)
    if (plan.units) next.units = plan.units
    if (plan.distanceMode) next.distanceMode = plan.distanceMode
    modalByController.set(ctrl, next)
    return { ok: true, message: null, sent: false, translated: 'modal', modal: { ...next } }
  }
  const message = plan.kind === 'notWired'
    ? `${line}: ${plan.what} is not wired to this controller yet (WO-1545 slice ${plan.slice}) - nothing was sent.`
    : `${line}: ${plan.what} - nothing was sent.`
  return { ok: false, message, sent: false, translated: plan.kind, modal: null }
}

/** Why `line` would not reach this controller, without sending it or touching
 *  the modal state - null when it would run (text route, or a modal line held
 *  locally). A caller asks this before side effects that only make sense if the
 *  command runs, e.g. disarming the loaded program for a probe cycle. */
export function appCommandUnsent(ctrl: MachineController, line: string): string | null {
  if (ctrl.capabilities.gcodeText) return null
  if (ctrl.connectionPhase() !== 'connected') return `${line}: not connected to a machine, so nothing was sent.`
  const plan = planAppCommand(line)
  if (plan.kind === 'modal') return null
  return plan.kind === 'notWired'
    ? `${line}: ${plan.what} is not wired to this controller yet (WO-1545 slice ${plan.slice}) - nothing was sent.`
    : `${line}: ${plan.what} - nothing was sent.`
}

/** One app-issued line, fire and forget. */
export function sendAppCommand(ctrl: MachineController, line: string): AppCommandOutcome {
  if (!ctrl.capabilities.gcodeText) return translate(ctrl, line)
  const sent = ctrl.sendCommand(line)
  return {
    ok: sent,
    message: sent ? null : `The controller refused ${line}.`,
    sent,
    translated: null,
    modal: null,
  }
}

/** One app-issued line, resolved when the controller acknowledges it - or at
 *  once when the line was translated. Null when the controller would not take
 *  it at all (not connected). */
export function sendAppCommandAwait(
  ctrl: MachineController,
  line: string,
): Promise<AppCommandOutcome> | null {
  if (!ctrl.capabilities.gcodeText) {
    if (ctrl.connectionPhase() !== 'connected') return null
    return Promise.resolve(translate(ctrl, line))
  }
  const pending = ctrl.sendCommandAwait(line)
  if (!pending) return null
  return pending.then((ack) => ({
    ok: ack.ok,
    message: ack.message,
    sent: true,
    translated: null,
    modal: null,
  }))
}
