// WO-1680: RUNNING A USER MACRO.
//
// The machine definition carries the user's macros (`MachineConfig.macros`);
// each body is JavaScript and runs in `interpreter.ts`, which yields every
// macro API call here. This file is the ONLY door from a body to the machine,
// and each API entry goes through the door the operator already uses:
//
//   line(text)          sendMdiLine - the typed-line door (E-STOP door, fit,
//                       translator, a bound park or macro M-code)
//   lines(a, b, ...)    runMachineAction - the path a configured button
//                       always took: on a geometry controller consecutive
//                       move/dwell lines stage as ONE program (WO-1707)
//   goTo({x,y,z}, opts) G53 G0 lines through that same door, Z first unless
//                       `zFirst: false`; `machine: false` moves in work
//                       coordinates instead
//   output(name, on)    the definition's output of that name, by its own word
//   wait(ms)            a pause
//   hold()              waits for CYCLE START (`continueHeldMacro`)
//   status()            the live DRO / homed / E-STOP snapshot
//   say(text)           one console row
//   confirm(text)       WO-1715: a dialog with OK / Cancel -> true / false
//   choose(text, [..])  WO-1715: a dialog with one button per option -> the
//                       option chosen, or null on Cancel
//   ask(text, default?) WO-1715: a dialog with one field -> what was typed (a
//                       number when it reads as one, else the text), or null
//                       on Cancel. While any of the three is open the macro
//                       waits exactly as at hold(): nothing is sent, the
//                       dialog's backdrop gates the jog keys (`dialogOpen`),
//                       and every stop below ends the run and closes it.
//                       Cancel is an answer, not a refusal - the script
//                       decides what it means
//   clampPause()        WO-1652: the session's clamp pause (park, then the
//                       clamp card) on the program boundary whose M-code
//                       runs this macro - the same code M2001 always ran.
//                       It ends the macro; the card's Continue runs the rest
//   toolChange(tool?)   WO-1652 fix round 2: the programmed tool change
//                       (`T2 M6`) on that same held boundary - the same
//                       tool-change hold and guided park / swap / probe /
//                       resume a posted M6 runs. The tool is the argument or
//                       the file's last T before the M-code. It ends the
//                       macro; the tool-change card's Continue runs the rest.
//                       Fix round 4: in a macro bound to M6 it starts no
//                       second change - it ends the macro, and the program's
//                       own M6 tool change follows (it always does)
//
// WO-1652: a program's M-code runs the macro bound to it at the held boundary
// (`machineSession`'s `runProgramBoundaryMacro`); its lines pass the MDI
// lockout through `sendFromProgramBoundaryMacro` while that boundary is held.
// A code the dialect gives a meaning (M3, M6, M7, ...) always does that
// meaning in a program: a macro on M6 runs first as a prelude and the tool
// change follows however it ends (`runM6Prelude`); a macro on any other such
// code is not run by a program.
//
// Between any two calls the run can end: Stop (`stopUserMacro`), the
// transport Stop/Reset or any other stop of the board (`subscribeMotionStop`),
// the E-STOP, an alarm, a controller reset or a lost connection each end it at
// once and nothing further is sent. After a line or move the run waits for the
// machine to report idle before the next call, so a body reads top to bottom
// as the machine does it - and a goTo leg only counts as done when the machine
// reports it AT that leg's target (WO-1681 safety round: Idle alone is also
// what a stopped move reports).

import { useCamStore } from '../../../store'
import { parkCarrierMachine } from '../../../store/machineActionsStore'
import { useMachineControl } from '../../../store/machineControlStore'
import { useUiPrefs } from '../../../store/uiPrefs'
import type { MachineConfig, MachineMacro } from '../../../types'
import { substituteActionLines } from '../machineActions'
import {
  awaitMachineArrived,
  awaitMachineSettled,
  clampPauseFromMacro,
  toolChangeFromMacro,
  controllerResetInProgress,
  estopNeedsReset,
  runMachineAction,
  sendFromProgramBoundaryMacro,
  sendMdiLine,
  subscribeControllerReset,
  subscribeEstopNeedsReset,
  subscribeMotionStop,
} from '../machineSession'
import {
  MacroBudgetError,
  MacroRuntimeError,
  MacroSyntaxError,
  macroValueText,
  parseMacro,
  runMacroProgram,
  type MacroEffect,
  type MacroProgram,
} from './interpreter'
// WO-1652: a UCCNC-profile record's one-time "Clamp pause" (M2001) macro.
import './clampPauseMacro'
// WO-1715: the question dialog mounts itself on first use - it belongs to no
// one panel, since a program's M-code can run a macro from any screen.
import { mountMacroAskDialog } from '../../../components/machine/MacroAskDialog'

export const MACRO_API = [
  'line', 'lines', 'goTo', 'output', 'wait', 'hold', 'status', 'say', 'clampPause', 'toolChange',
  'confirm', 'choose', 'ask',
] as const

export interface MacroRunState {
  macroId: string
  name: string
  /** 'held' = stopped at hold(), waiting for CYCLE START. */
  phase: 'running' | 'held'
}

/** WO-1715: the question a macro is waiting on - confirm(), choose() or ask(). */
export type MacroQuestion =
  | { kind: 'confirm'; text: string }
  | { kind: 'choose'; text: string; options: string[] }
  | { kind: 'ask'; text: string; defaultValue: string }

export interface MacroAskState {
  /** Changes with every question, so an answer can never reach a later one. */
  id: number
  macroName: string
  question: MacroQuestion
}

let current: (MacroRunState & { run: MacroRun }) | null = null
const listeners = new Set<() => void>()

let asking: (MacroAskState & { run: MacroRun }) | null = null
let nextAskId = 1
const askListeners = new Set<() => void>()

function publishAsk(next: (MacroAskState & { run: MacroRun }) | null): void {
  asking = next
  for (const listener of askListeners) listener()
}

/** The question open now, or null. Stable between changes (useSyncExternalStore). */
export function activeMacroAsk(): MacroAskState | null {
  return asking
}

export function subscribeMacroAsk(listener: () => void): () => void {
  askListeners.add(listener)
  return () => askListeners.delete(listener)
}

/** The operator's answer to question `id`: true/false for confirm, the option
 *  for choose, the typed text for ask, null for Cancel on choose/ask. False
 *  when that question is no longer open. */
export function answerMacroAsk(id: number, answer: unknown): boolean {
  if (!asking || asking.id !== id) return false
  return asking.run.answerQuestion(answer)
}

/** What ask() hands the script: a number when the text reads as one. */
export function askAnswerValue(text: string): number | string {
  const trimmed = text.trim()
  if (trimmed === '') return text
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : text
}

function publish(next: (MacroRunState & { run: MacroRun }) | null): void {
  current = next
  for (const listener of listeners) listener()
}

/** The macro running now, or null. Stable between changes (useSyncExternalStore). */
export function activeMacroRun(): MacroRunState | null {
  return current
}

export function subscribeMacroRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** This machine's macros, in the user's order. (WO-1707: the older custom
 *  buttons were moved onto this list once, by `machineActionsStore`'s
 *  one-time move - nothing folds them in here.) */
export function machineMacros(machine: Pick<MachineConfig, 'macros'> | null | undefined): MachineMacro[] {
  return machine?.macros ?? []
}

function activeMachine(): MachineConfig {
  return parkCarrierMachine(useCamStore.getState())
}

/** WO-2657: THE MACROS THAT RUN. A macro kept off the Macros panel is off
 *  (operator 2026-10-07: "If they're suppressed from view, they also need to be
 *  suppressed from running"): no M-code, program call, M6 prelude or park
 *  reaches it. It stays in the macro editor; showing it turns it back on. */
export function shownMacros(machine: Pick<MachineConfig, 'macros'> | null | undefined): MachineMacro[] {
  return machineMacros(machine).filter((macro) => !macro.hidden)
}

/** The machine with its hidden macros taken off (WO-2657) - for a lookup that
 *  reads parks or the tool-change flag from the whole record. */
export function withoutHiddenMacros<T extends Pick<MachineConfig, 'macros'>>(machine: T | null | undefined): T | null | undefined {
  if (!machine?.macros?.some((macro) => macro.hidden)) return machine
  return { ...machine, macros: shownMacros(machine) }
}

/** The macro a lone typed M-code is bound to on the active machine, or null.
 *  A hidden macro binds nothing (WO-2657): its code reads as unbound. */
export function boundMacro(code: number): MachineMacro | null {
  return shownMacros(activeMachine()).find((macro) => macro.mCode === code) ?? null
}

/** WO-2657: the hidden macro carrying `code` when no shown macro does - so the
 *  one line saying it was not run can name it. Null otherwise. */
export function hiddenBoundMacro(code: number): MachineMacro | null {
  if (boundMacro(code) !== null) return null
  return machineMacros(activeMachine()).find((macro) => macro.hidden && macro.mCode === code) ?? null
}

/** WO-2657: the hidden macro a park was read from, or null. A park handed to
 *  the session by any caller (pendant Rear, program panel M6 or clamp pause) is
 *  that macro's movement, so a hidden one does not move the machine. */
export function hiddenParkMacro(park: { id: string }): MachineMacro | null {
  return machineMacros(activeMachine()).find((macro) => macro.hidden && macro.id === park.id) ?? null
}

/** WO-2657: the one line a hidden macro's code gets instead of a run. */
export function hiddenMacroNotRunText(macro: MachineMacro): string {
  const named = macro.mCode === undefined ? `Macro "${macro.name}"` : `M${macro.mCode} is the macro "${macro.name}", which`
  return `${named} is hidden from the Macros panel, so it was not run - show it on the panel to turn it back on.`
}

function say(text: string, severity: 'info' | 'error' = 'info'): void {
  useMachineControl.getState().pushConsole('tx', text, severity)
}

/** WO-1707: `{rpm}` in a `line(...)` call resolves the same dialed spindle
 *  speed a custom button's line always did (`SpindlePanel`'s
 *  `useUiPrefs().machineSpindleRpm`) - the one substitution point, so a
 *  folded custom button behaves exactly as it did before the fold. */
function substituteRpmPlaceholder(text: string): string {
  if (!text.includes('{rpm}')) return text
  return substituteActionLines([text], { rpm: useUiPrefs.getState().machineSpindleRpm })[0]
}

class MacroStopped extends Error {}

class MacroRun {
  private stopped: string | null = null
  private wake: (() => void) | null = null
  private resume: (() => void) | null = null
  private answer: ((value: unknown) => void) | null = null

  readonly macro: MachineMacro
  constructor(macro: MachineMacro) {
    this.macro = macro
  }

  get isStopped(): boolean {
    return this.stopped !== null
  }

  /** End the run: nothing more is sent. `why` is the row, or null for silence. */
  stop(why: string | null): void {
    if (this.stopped !== null) return
    this.stopped = why ?? ''
    if (why) say(why)
    this.wake?.()
    this.resume?.()
  }

  continueHold(): boolean {
    if (!this.resume) return false
    const resume = this.resume
    this.resume = null
    resume()
    return true
  }

  answerQuestion(value: unknown): boolean {
    if (!this.answer) return false
    const answer = this.answer
    this.answer = null
    answer(value)
    return true
  }

  /** WO-1715: show `question` and wait for the answer, exactly as hold()
   *  waits for CYCLE START - any stop ends the run and closes the dialog. */
  private async askOperator(question: MacroQuestion): Promise<unknown> {
    this.check()
    say(`Macro "${this.macro.name}" is waiting for an answer: ${question.text}`)
    publishAsk({ id: nextAskId++, macroName: this.macro.name, question, run: this })
    mountMacroAskDialog()
    try {
      return await this.guard(new Promise<unknown>((resolve) => {
        this.answer = resolve
      }))
    } finally {
      this.answer = null
      if (asking?.run === this) publishAsk(null)
    }
  }

  private check(): void {
    if (this.stopped !== null) throw new MacroStopped()
  }

  /** Await `promise` unless the run is stopped first. */
  private async guard<T>(promise: Promise<T>): Promise<T> {
    this.check()
    let unblock: () => void = () => {}
    const stopped = new Promise<never>((_, reject) => {
      unblock = () => reject(new MacroStopped())
    })
    this.wake = unblock
    try {
      return await Promise.race([promise, stopped])
    } finally {
      this.wake = null
    }
  }

  private async sendLine(text: string, target: GoToLeg['target'] | null = null): Promise<boolean> {
    this.check()
    if (!sendFromProgramBoundaryMacro(() => sendMdiLine(text))) {
      // The door has already said why in the console; the macro ends there.
      this.stop(`Macro "${this.macro.name}" stopped: "${text}" was not sent.`)
      return false
    }
    const settled = await this.guard(awaitMachineSettled())
    this.check()
    if (!settled) {
      this.stop(`Macro "${this.macro.name}" stopped: the machine did not come back to idle after "${text}".`)
      return false
    }
    // WO-2255 (B-3, Operator's machine 2026-09-30): the real board can report idle with no job at the START position
    // before its move shows as running, so the first settle is not arrival. A leg with a target waits for the
    // machine to reach it; it ends only when the machine has sat idle away from the target for ARRIVAL_GRACE_MS.
    if (target && !reachedTarget(target) && !(await this.guard(awaitMachineArrived(() => reachedTarget(target), ARRIVAL_GRACE_MS)))) {
      this.check()
      this.stop(`Macro "${this.macro.name}" stopped: the machine did not reach the position "${text}" names.`)
      return false
    }
    this.check()
    return true
  }

  /** WO-1707: a block of lines through `runMachineAction` - the one path a
   *  configured button's lines take (its E-STOP stop-word rule, and on a
   *  geometry controller consecutive move/dwell lines staged as ONE program),
   *  not a second sender. Its refusal reason is the console row, as it always
   *  was; the run ends there. */
  private async sendBlock(texts: string[]): Promise<boolean> {
    this.check()
    const result = sendFromProgramBoundaryMacro(() => runMachineAction(texts))
    if (!result.ok) {
      say(result.reason, 'error')
      this.stop(`Macro "${this.macro.name}" stopped: "${texts.join(' / ')}" was not sent.`)
      return false
    }
    const settled = await this.guard(awaitMachineSettled())
    this.check()
    if (!settled) {
      this.stop(`Macro "${this.macro.name}" stopped: the machine did not come back to idle after "${texts.join(' / ')}".`)
      return false
    }
    return true
  }

  async api(effect: MacroEffect & { kind: 'api' }): Promise<unknown> {
    this.check()
    const [a, b] = effect.args
    switch (effect.name) {
      case 'line':
        await this.sendLine(substituteRpmPlaceholder(macroValueText(a ?? '')))
        return undefined
      case 'lines': {
        const texts = effect.args
          .flatMap((arg) => (Array.isArray(arg) ? arg : [arg]))
          .map((arg) => substituteRpmPlaceholder(macroValueText(arg ?? '')))
        if (texts.length > 0) await this.sendBlock(texts)
        return undefined
      }
      case 'goTo':
        for (const leg of goToLegs(a, b, effect.line)) {
          if (!(await this.sendLine(leg.text, leg.target))) break
        }
        return undefined
      case 'output':
        await this.sendLine(outputLine(a, b, effect.line))
        return undefined
      case 'wait': {
        const ms = Number(a)
        if (!Number.isFinite(ms) || ms <= 0) return undefined
        await this.guard(new Promise<void>((resolve) => setTimeout(resolve, ms)))
        return undefined
      }
      case 'hold': {
        say(`Macro "${this.macro.name}" is holding - CYCLE START continues it.`)
        publishPhase(this, 'held')
        try {
          await this.guard(new Promise<void>((resolve) => {
            this.resume = resolve
          }))
        } finally {
          this.resume = null
          publishPhase(this, 'running')
        }
        return undefined
      }
      case 'status':
        return statusSnapshot()
      case 'say':
        say(macroValueText(a))
        return undefined
      case 'clampPause': {
        const refusal = clampPauseFromMacro()
        if (refusal !== null) throw new MacroRuntimeError(`clampPause: ${refusal}`, effect.line)
        // The clamp card owns the program from here; the macro ends quietly.
        this.stop(null)
        return undefined
      }
      case 'toolChange': {
        const refusal = toolChangeFromMacro(a)
        if (refusal !== null) throw new MacroRuntimeError(`toolChange: ${refusal}`, effect.line)
        // The tool-change card owns the program from here; the macro ends quietly.
        this.stop(null)
        return undefined
      }
      case 'confirm':
        return (await this.askOperator({ kind: 'confirm', text: macroValueText(a ?? '') })) === true
      case 'choose': {
        const options = Array.isArray(b) ? b.map((option) => macroValueText(option ?? '')) : []
        if (options.length === 0) {
          throw new MacroRuntimeError('choose: the second argument must be a list of options, like ["A", "B"]', effect.line)
        }
        const chosen = await this.askOperator({ kind: 'choose', text: macroValueText(a ?? ''), options })
        return typeof chosen === 'string' && options.includes(chosen) ? chosen : null
      }
      case 'ask': {
        const defaultValue = b === undefined || b === null ? '' : macroValueText(b)
        const typed = await this.askOperator({ kind: 'ask', text: macroValueText(a ?? ''), defaultValue })
        return typeof typed === 'string' ? askAnswerValue(typed) : null
      }
    }
    throw new MacroRuntimeError(`"${effect.name}" is not a macro call`, effect.line)
  }
}

function publishPhase(run: MacroRun, phase: MacroRunState['phase']): void {
  if (current?.run !== run || current.phase === phase) return
  publish({ ...current, phase })
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mm(value: number): string {
  return String(Number(value.toFixed(3)))
}

/** One line of a goTo and where it leaves the machine: the axes it names, in
 *  machine coordinates (G53) or work coordinates. */
interface GoToLeg {
  text: string
  target: { frame: 'machine' | 'work'; axes: Partial<Record<'x' | 'y' | 'z', number>> }
}

/** How far (mm) a reported position may sit from a leg's target and still be
 *  that target - step resolution and report rounding, far below any stop. */
const REACHED_TOLERANCE_MM = 0.02
/** WO-2255: how long the machine must sit idle AWAY from a leg's target before the leg counts as not reached (the
 *  guided park waits 1.2 s the same way before it trusts idle). */
const ARRIVAL_GRACE_MS = 1500

/** True when the machine's last report puts it at every axis the leg names. */
function reachedTarget(target: GoToLeg['target']): boolean {
  const s = useMachineControl.getState()
  const at = target.frame === 'machine' ? s.mpos : s.wpos
  if (!at) return false
  return (Object.entries(target.axes) as Array<['x' | 'y' | 'z', number]>)
    .every(([axis, value]) => Math.abs(at[axis] - value) <= REACHED_TOLERANCE_MM)
}

/** The lines one goTo sends: Z on its own line first (or last with
 *  `zFirst: false`), then the X/Y it names. Millimetres, absolute (G21 G90),
 *  as a park says it; `machine: false` drops G53 and moves in work
 *  coordinates. */
export function goToLines(target: unknown, options: unknown, line = 0): string[] {
  return goToLegs(target, options, line).map((leg) => leg.text)
}

function goToLegs(target: unknown, options: unknown, line = 0): GoToLeg[] {
  const t = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>
  const o = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
  const x = finite(t.x)
  const y = finite(t.y)
  const z = finite(t.z)
  for (const axis of ['x', 'y', 'z'] as const) {
    if (t[axis] !== undefined && finite(t[axis]) === null) {
      throw new MacroRuntimeError(`goTo: ${axis} must be a number, not ${macroValueText(t[axis])}`, line)
    }
  }
  const frame = o.machine === false ? 'work' : 'machine'
  const prefix = frame === 'work' ? 'G21 G90 G0' : 'G21 G90 G53 G0'
  const zLeg: GoToLeg | null = z === null ? null : { text: `${prefix} Z${mm(z)}`, target: { frame, axes: { z } } }
  const xy = [x === null ? null : `X${mm(x)}`, y === null ? null : `Y${mm(y)}`].filter(Boolean).join(' ')
  const xyAxes = { ...(x === null ? {} : { x }), ...(y === null ? {} : { y }) }
  const xyLeg: GoToLeg | null = xy === '' ? null : { text: `${prefix} ${xy}`, target: { frame, axes: xyAxes } }
  const legs = o.zFirst === false ? [xyLeg, zLeg] : [zLeg, xyLeg]
  return legs.filter((l): l is GoToLeg => l !== null)
}

/** The word that switches the definition's output `name` on or off. */
function outputLine(name: unknown, on: unknown, line: number): string {
  const wanted = macroValueText(name ?? '').trim().toLowerCase()
  const outputs = activeMachine().controllerDefinition?.outputs ?? []
  const output = outputs.find((candidate) => candidate.name.trim().toLowerCase() === wanted)
  if (!output) {
    const names = outputs.map((candidate) => `"${candidate.name}"`).join(', ')
    throw new MacroRuntimeError(
      names === ''
        ? `output: this machine states no outputs, so there is no "${macroValueText(name)}"`
        : `output: this machine has no output "${macroValueText(name)}" - it has ${names}`,
      line,
    )
  }
  return on ? output.onCode : (output.offCode ?? 'M9')
}

function statusSnapshot(): unknown {
  const s = useMachineControl.getState()
  return {
    machine: s.mpos ? { ...s.mpos } : null,
    work: s.wpos ? { ...s.wpos } : null,
    homed: s.homed,
    estop: estopNeedsReset(),
    state: s.machineState,
  }
}

/** Parse a macro body. A body that does not parse runs nothing; the row
 *  names the line and column. */
export function checkMacroBody(body: string): { ok: true; program: MacroProgram } | { ok: false; line: number; column: number; message: string } {
  try {
    return { ok: true, program: parseMacro(body) }
  } catch (err) {
    if (err instanceof MacroSyntaxError) return { ok: false, line: err.line, column: err.column, message: err.message }
    throw err
  }
}

/** Yield the thread to the UI between time slices of a long computation. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run a user macro. Returns at once; the run proceeds in the background and
 * is visible through `activeMacroRun`. False (with one console row) when it
 * did not start: another macro is running, or the body does not parse.
 */
export function runUserMacro(macro: MachineMacro): boolean {
  // WO-2657: a hidden macro is off, whichever route reached it.
  if (macro.hidden) {
    say(hiddenMacroNotRunText(macro))
    return false
  }
  if (current) {
    say(`Macro "${macro.name}" did not start: macro "${current.name}" is still running - Stop it first.`, 'error')
    return false
  }
  const parsed = checkMacroBody(macro.body)
  if (!parsed.ok) {
    say(`Macro "${macro.name}" did not run: line ${parsed.line}, column ${parsed.column}: ${parsed.message}.`, 'error')
    return false
  }
  const run = new MacroRun(macro)
  publish({ macroId: macro.id, name: macro.name, phase: 'running', run })
  void drive(run, parsed.program)
  return true
}

async function drive(run: MacroRun, program: MacroProgram): Promise<void> {
  const unsubscribe = [
    subscribeEstopNeedsReset(() => {
      if (estopNeedsReset()) run.stop(`Macro "${run.macro.name}" stopped by the E-STOP.`)
    }),
    subscribeControllerReset(() => {
      if (controllerResetInProgress()) run.stop(`Macro "${run.macro.name}" stopped: the controller was reset.`)
    }),
    // Any Stop/Reset or E-STOP told to the board - the transport bar, a
    // feed hold then Stop, the session's own stops - ends the run before the
    // board's Idle can read as the line having finished.
    subscribeMotionStop((kind) => run.stop(kind === 'estop'
      ? `Macro "${run.macro.name}" stopped by the E-STOP.`
      : `Macro "${run.macro.name}" stopped: the machine was stopped.`)),
  ]
  const walk = runMacroProgram(program, MACRO_API)
  try {
    // A latched E-STOP does not stop a body from starting: the E-STOP door
    // inside `line` names the latch for the first line that needs it.
    let input: unknown
    while (!run.isStopped) {
      const step = walk.next(input)
      input = undefined
      if (step.done) break
      if (step.value.kind === 'slice') {
        await yieldToUi()
        continue
      }
      input = await run.api(step.value)
    }
  } catch (err) {
    if (err instanceof MacroStopped) {
      // Already said.
    } else if (err instanceof MacroBudgetError || err instanceof MacroRuntimeError) {
      run.stop(`Macro "${run.macro.name}" stopped at line ${err.line}: ${err.message}.`)
    } else {
      run.stop(`Macro "${run.macro.name}" stopped: ${err instanceof Error ? err.message : String(err)}.`)
    }
  } finally {
    walk.return(undefined)
    for (const off of unsubscribe) off()
    if (current?.run === run) publish(null)
  }
}

/** Stop the running macro at once: nothing further is sent. */
export function stopUserMacro(): boolean {
  if (!current) return false
  current.run.stop(`Macro "${current.name}" stopped.`)
  return true
}

/** A connection boundary ends the old run before a later controller can
 *  receive anything from it. Called by the session's shared phase handler, so
 *  requested disconnects, unexpected drops and a SWAP to another controller
 *  behave the same on every backend. `lost` only chooses the console row: a
 *  swap is not a lost connection and must not say it was. */
export function stopUserMacroForSessionBoundary(lost: boolean): boolean {
  if (!current) return false
  current.run.stop(lost
    ? `Macro "${current.name}" stopped: the machine connection was lost.`
    : `Macro "${current.name}" stopped: the machine connection changed.`)
  return true
}

/** CYCLE START for a macro waiting at hold(). False when none is holding. */
export function continueHeldMacro(): boolean {
  if (!current || current.phase !== 'held') return false
  return current.run.continueHold()
}

/** Tests: forget any run left by a previous test. */
export function __resetMacroRuntimeForTest(): void {
  current?.run.stop(null)
  publish(null)
  publishAsk(null)
}
