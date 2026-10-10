// WO-425 - turning a VFD definition into words on the wire, and words on the
// wire back into readings. Pure functions: no port, no timer, no I/O. The
// bridge (pendant/uccnc-bridge/Vfd.cs) does the same arithmetic in C# because
// it owns the serial port; this side is what the tests and the setup panel use,
// and it is the definition of correct.

import { evaluateVfdExpr } from './vfdExpr'
import {
  commandExists,
  validateVfdDefinition,
  type VfdCommand,
  type VfdCommandTable,
  type VfdCompiledScales,
  type VfdDefinition,
  type VfdEncode,
  type VfdFaultRule,
  type VfdStatusFieldName,
} from './vfdDefinition'

const U16_MAX = 65535

// --- commands ----------------------------------------------------------------

export type VfdCommandWordResult =
  | { ok: true; word: number }
  | { ok: false; sentence: string }

/**
 * The word to write to the command register for one command. `previousWord` is
 * what was last written, and only matters for a bitfield table, where a command
 * changes some bits and leaves the rest alone.
 */
export function vfdCommandWord(
  table: VfdCommandTable,
  command: VfdCommand,
  previousWord?: number,
): VfdCommandWordResult {
  if (!commandExists(table, command)) {
    return { ok: false, sentence: `this inverter's command table has no \`${command}\`.` }
  }
  if (table.style === 'value') {
    return { ok: true, word: table.values[command] as number }
  }
  const entry = table.commands[command]!
  const base = Number.isInteger(previousWord) ? (previousWord as number) & U16_MAX : table.idle
  const word = ((base & ~entry.mask) | entry.value) & U16_MAX
  return { ok: true, word }
}

// --- setpoint ----------------------------------------------------------------

function roundTo(value: number, how: VfdEncode['round']): number {
  if (how === 'down') return Math.floor(value)
  if (how === 'up') return Math.ceil(value)
  return Math.round(value)
}

export type VfdSetpointResult =
  | { ok: true; word: number; clamped: boolean; exact: number }
  | { ok: false; sentence: string }

/**
 * Commanded RPM -> the setpoint register word. The expression does the scaling
 * (Operator's is `set.rpm / 2.4`); rounding and clamping are the definition's
 * `encode` block, because the expression language has no function calls.
 *
 * Clamping is reported, never silent: a spindle that runs slower than asked is
 * safe, a spindle that silently ran at a wrapped-around 16-bit value is not.
 */
export function vfdSetpointWord(
  definition: VfdDefinition,
  compiled: VfdCompiledScales,
  rpm: number,
): VfdSetpointResult {
  if (!Number.isFinite(rpm)) {
    return { ok: false, sentence: 'the commanded speed is not a number.' }
  }
  const evaluated = evaluateVfdExpr(compiled.setpoint, { setRpm: rpm, constants: definition.constants })
  if (!evaluated.ok) return { ok: false, sentence: evaluated.fault.sentence }
  const exact = evaluated.value
  const rounded = roundTo(exact, definition.registers.setpoint.encode.round)
  const { min, max } = definition.registers.setpoint.encode
  const word = Math.min(max, Math.max(min, rounded))
  return { ok: true, word, clamped: word !== rounded, exact }
}

// --- status ------------------------------------------------------------------

export type VfdReadings = Partial<Record<VfdStatusFieldName, number>>

export type VfdDecodeResult =
  | { ok: true; readings: VfdReadings }
  | { ok: false; sentence: string; readings: VfdReadings }

/**
 * Decode the status block. Register-sourced fields read their word; derived
 * fields (Operator's power = volts x amps) see every field above them, which is why
 * the validator forbids a derived field referring forwards.
 */
export function vfdDecodeStatus(
  definition: VfdDefinition,
  compiled: VfdCompiledScales,
  words: readonly number[],
): VfdDecodeResult {
  const readings: VfdReadings = {}
  const fields: Record<string, number> = {}
  for (const field of compiled.status) {
    let value: number
    if (field.source === 'register') {
      const raw = words[field.offset]
      if (raw === undefined || !Number.isFinite(raw)) {
        return {
          ok: false,
          readings,
          sentence: `the inverter sent ${words.length} words but the definition reads word ${field.offset}.`,
        }
      }
      const evaluated = evaluateVfdExpr(field.ast, {
        rawValue: raw,
        fields,
        constants: definition.constants,
      })
      if (!evaluated.ok) return { ok: false, readings, sentence: evaluated.fault.sentence }
      value = evaluated.value
    } else {
      const evaluated = evaluateVfdExpr(field.ast, { fields, constants: definition.constants })
      if (!evaluated.ok) return { ok: false, readings, sentence: evaluated.fault.sentence }
      value = evaluated.value
    }
    fields[field.name] = value
    readings[field.name] = value
  }
  return { ok: true, readings }
}

// --- fault -------------------------------------------------------------------

/** Whether the fault register says this inverter is faulted. */
export function vfdIsFaulted(rule: VfdFaultRule, word: number): boolean {
  if (!Number.isFinite(word)) return false
  const value = word & U16_MAX
  switch (rule.kind) {
    case 'equals':
      return value === rule.value
    case 'nonZero':
      return value !== 0
    case 'mask':
      return (value & rule.mask) !== 0
  }
}

/** Plain words for the status line and the console. */
export function describeVfdFault(rule: VfdFaultRule, word: number): string {
  if (!vfdIsFaulted(rule, word)) return 'The inverter reports no fault.'
  return `The inverter reports a fault (fault register ${word & U16_MAX}).`
}

// --- up to speed -------------------------------------------------------------

/**
 * Operator's macro calls the spindle up to speed when actual RPM is within +/-3 of
 * the setpoint. The tolerance is per-inverter, so it lives in the definition.
 */
export function vfdIsUpToSpeed(definition: VfdDefinition, commandedRpm: number, actualRpm: number | undefined): boolean {
  if (actualRpm === undefined || !Number.isFinite(actualRpm) || !Number.isFinite(commandedRpm)) return false
  return Math.abs(actualRpm - commandedRpm) <= definition.upToSpeedToleranceRpm
}

// --- the bridge's `vfd` push, decoded in one step -----------------------------

/**
 * The subset of the bridge's `vfd` push (docs/machine/BRIDGE-PROTOCOL.md) this
 * needs to decode honestly: whether the last poll actually got a reply,
 * whether the inverter is faulted, and the raw status words. The push carries
 * more (command/setpoint words, stop reason, ...); this only touches what
 * affects whether the status words mean anything right now.
 */
export interface VfdPushSample {
  up: boolean
  faulted: boolean
  statusWords: readonly number[]
}

/**
 * Turn one `vfd` push into real-unit readings - WO-441. `up: false` or
 * `faulted: true` means there is nothing honest to report, same as no
 * definition at all: an empty reading set, never a stale or invented number.
 * This is the one place "should this sample be trusted" (link down, inverter
 * faulted) meets "what do these words mean" (the definition's scale
 * expressions), so a caller such as UccncController does not reimplement
 * either half.
 */
export function vfdDecodePush(
  definition: VfdDefinition,
  compiled: VfdCompiledScales,
  sample: VfdPushSample,
): VfdReadings {
  if (!sample.up || sample.faulted) return {}
  const decoded = vfdDecodeStatus(definition, compiled, sample.statusWords)
  return decoded.ok ? decoded.readings : {}
}

// --- convenience -------------------------------------------------------------

export type VfdCompileResult =
  | { ok: true; definition: VfdDefinition; compiled: VfdCompiledScales }
  | { ok: false; sentences: string[] }

/** Validate and compile in one step, for callers that only want the happy path. */
export function compileVfdDefinition(definition: VfdDefinition): VfdCompileResult {
  const result = validateVfdDefinition(definition)
  if (!result.ok || !result.compiled) {
    return { ok: false, sentences: result.errors.map((e) => (e.path ? `${e.path}: ${e.sentence}` : e.sentence)) }
  }
  return { ok: true, definition, compiled: result.compiled }
}
