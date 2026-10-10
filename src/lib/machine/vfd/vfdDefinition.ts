// WO-425 - the VFD definition format.
//
// A spindle inverter is not a controller output on this machine: it is a
// Modbus device on its own serial link. Inverters differ on eight axes at least
// (docs/research/uccnc-control-plan.md section 11.1), so LienCAM carries a
// DECLARATIVE definition per inverter rather than a driver per inverter.
//
// Everything here is pure data and pure checks. Nothing in this file opens a
// port, spins a spindle or knows what a serial frame looks like; the bridge
// (pendant/uccnc-bridge/Vfd.cs) does the talking and is handed a definition.
//
// Two rules bind the whole format:
//
//   1. `verified: false` is not cosmetic. It gates SPINDLE-ON. It never gates a
//      stop - see vfdSafety.ts. A definition written from a datasheet is an
//      untested claim about hardware that spins at 24,000 RPM.
//   2. The link ships DISABLED. It has to be switched on deliberately, exactly
//      like the bridge's read-only motion gate.

import { checkVfdExpr, type VfdExprScopeShape } from './vfdExpr'
import type { ExprAst } from '../probeRoutineExpr'

export const VFD_DEFINITION_SCHEMA_VERSION = 1
export const VFD_DEFINITION_FORMAT = 'liencam-vfd-definition'

// --- link --------------------------------------------------------------------

export type VfdParity = 'none' | 'even' | 'odd'

export interface VfdLinkTiming {
  /** Milliseconds between poll passes. Operator's measured value is 25. */
  pollIntervalMs: number
  /** Retries of ONE transaction before the link is declared lost. Operator's is 1. */
  retryCount: number
  /** Milliseconds to wait for a reply. Operator's measured value is 297. */
  timeoutMs: number
}

export interface VfdSerialLink extends VfdLinkTiming {
  transport: 'rtu'
  /** 'COM3' on Windows. One process owns it; UCCNC must not be running. */
  port: string
  baud: number
  dataBits: 7 | 8
  parity: VfdParity
  stopBits: 1 | 2
  /** Two-wire RS485 is half duplex and needs turnaround time; it is the common case. */
  rs485: 'two-wire' | 'four-wire' | 'none'
  slaveAddress: number
}

export interface VfdTcpLink extends VfdLinkTiming {
  transport: 'tcp'
  host: string
  tcpPort: number
  slaveAddress: number
}

export type VfdLink = VfdSerialLink | VfdTcpLink

// --- protocol ----------------------------------------------------------------

export const VFD_READ_FUNCTIONS = [0x01, 0x03, 0x04] as const
export const VFD_WRITE_FUNCTIONS = [0x05, 0x06, 0x10] as const
export type VfdReadFunction = (typeof VFD_READ_FUNCTIONS)[number]
export type VfdWriteFunction = (typeof VFD_WRITE_FUNCTIONS)[number]

export interface VfdProtocol {
  /** 0x03 read holding registers (Operator), 0x04 input registers, 0x01 coils. */
  readFunction: VfdReadFunction
  /** 0x06 write single register (Operator), 0x10 write multiple, 0x05 write coil. */
  writeFunction: VfdWriteFunction
  /**
   * Which half of a 32-bit value goes on the wire first. WO-1736: this is the
   * order `registers.setpoint` is written in when it is two registers wide,
   * and it is a fact of the drive rather than of Modbus - 18,000 RPM
   * high-first is `0x0000 0x4650`, low-first is `0x4650 0x0000`, and an
   * inverter handed the wrong one runs at a different speed.
   */
  wordOrder: 'high-first' | 'low-first'
}

// --- registers, keyed by ROLE ------------------------------------------------

export const VFD_REGISTER_ROLES = ['command', 'setpoint', 'runState', 'status'] as const
export type VfdRegisterRole = (typeof VFD_REGISTER_ROLES)[number]

/**
 * WO-1735 - ROLES A DEFINITION MAY STATE, not ones every definition has.
 *
 * `faultCode` is the drive's OWN fault register: a word that carries the
 * fault, separately from the operating-state word. Operator's Huanyang GT has no
 * such register in this document (its real fault code at 0x5000 is not read),
 * so his definition does not state one and the fault rule keeps reading the
 * run-state word exactly as before.
 *
 * It is NOT called `fault`: that name belonged to 0x1001 until WO-1074 renamed
 * it `runState`, and `fault` at the top level is the RULE. Two different things
 * sharing one name is what made the old label survive for a month.
 */
export const VFD_OPTIONAL_REGISTER_ROLES = ['faultCode'] as const
export type VfdOptionalRegisterRole = (typeof VFD_OPTIONAL_REGISTER_ROLES)[number]

export type VfdRounding = 'nearest' | 'down' | 'up'

/**
 * How a computed setpoint becomes a register word. The expression language has
 * no function calls by design, so rounding and clamping are FIELDS, never
 * `round(...)` inside the expression.
 */
export interface VfdEncode {
  round: VfdRounding
  min: number
  max: number
}

export interface VfdRegister {
  address: number
  /** Words. 1 for everything of Operator's except the 5-word status block. */
  count: number
}

/**
 * WO-1736 - HOW WIDE A SPEED SETPOINT MAY BE.
 *
 * Operator's Huanyang GT takes its speed in one holding register. Plenty of drives
 * take it as a 32-bit value in a REGISTER PAIR. Those are the two shapes that
 * exist: `count` is 1 or 2, and `protocol.wordOrder` orders the pair. Nothing
 * wider is a speed reference any inverter document describes, and the bridge
 * would have to invent the arithmetic for it.
 */
export const VFD_SETPOINT_WORD_COUNTS = [1, 2] as const
export type VfdSetpointWordCount = (typeof VFD_SETPOINT_WORD_COUNTS)[number]

/** The largest value a setpoint `count` registers wide can carry. */
export function vfdSetpointCeiling(count: number): number {
  return count === 2 ? 0xFFFFFFFF : 0xFFFF
}

/**
 * The setpoint value as the WORDS this definition puts on the wire, in wire
 * order. `pendant/uccnc-bridge/Vfd.cs` (VfdPlan.SetpointWords) does the same
 * arithmetic in C# because it owns the serial port; this side is what the tests
 * and the setup panel use, and it is the definition of correct.
 *
 * It cannot fail: the width and the order were settled when the definition was
 * validated, and a value above the width is already clamped by
 * `registers.setpoint.encode`. It is pure arithmetic on two stated facts, which
 * is the whole reason there is no branch per inverter here.
 */
export function vfdSetpointRegisterWords(
  definition: Pick<VfdDefinition, 'protocol' | 'registers'>,
  value: number,
): number[] {
  const whole = Math.max(0, Math.trunc(value))
  if (definition.registers.setpoint.count <= 1) return [whole & U16_MAX]
  const high = Math.floor(whole / 0x10000) & U16_MAX
  const low = whole & U16_MAX
  return definition.protocol.wordOrder === 'low-first' ? [low, high] : [high, low]
}

export interface VfdSetpointRegister extends VfdRegister {
  /**
   * Commanded RPM -> register word. Operator's Huanyang GT is `set.rpm / 2.4`, a
   * constant he measured from his own RPM table, not a datasheet formula.
   *
   * WO-1736: on a two-register setpoint this is still ONE number - the whole
   * 32-bit value. Splitting it into words is the wire's business
   * (`vfdSetpointRegisterWords`), never the expression's.
   */
  scale: string | number
  encode: VfdEncode
}

/**
 * The inverter's own names for values read from its operating-state register.
 * Direction here is diagnostic only: commanded direction remains the source
 * for physical spindle direction (Operator's GT reports the opposite direction).
 */
export const VFD_RUN_STATE_MEANINGS = [
  'running', 'runningForward', 'runningReverse', 'stopped', 'faulted', 'poweredOff',
] as const
export type VfdRunStateMeaning = (typeof VFD_RUN_STATE_MEANINGS)[number]
export interface VfdRunStateValue {
  value: number
  meaning: VfdRunStateMeaning
}

export interface VfdRunStateRegister extends VfdRegister {
  /**
   * WO-1721 staged definition/editor phase. New app-owned definitions carry
   * this table. WO-2009: optional in the STORED shape only (records saved
   * before WO-1721 lack it); `validateVfdDefinition` refuses a definition
   * without rows, because the bridge refuses its link.
   */
  values?: VfdRunStateValue[]
}

/**
 * WO-1735 - A DRIVE THAT REPORTS FAULTS IN ITS OWN REGISTER SAYS SO HERE.
 *
 * One mechanism, fed by the definition: when this register is stated the
 * bridge reads it each pass and applies a fault rule to THAT word; when it is
 * absent nothing is read and the run-state word decides, which is what every
 * definition did before this order. There is no branch per device anywhere -
 * the definition states the register or it does not.
 */
export interface VfdFaultCodeRegister extends VfdRegister {
  /**
   * Which words off this register mean a fault - the same three-way rule the
   * definition already speaks (`equals` a code, any `nonZero` code, or a fault
   * bit inside a status word). Absent means the definition's own `fault` rule
   * is applied to this register's word instead of the run-state word, which is
   * the common case: a drive with a fault-code register usually wants
   * `nonZero`, and it states that once.
   */
  rule?: VfdFaultRule
}

export interface VfdRegisterMap {
  command: VfdRegister
  setpoint: VfdSetpointRegister
  /** WO-1074: 0x1001, the inverter's OPERATING-STATE word - 1 forward,
   *  2 reverse, 3 standby, 4 fault, 5 POFF. It was called `fault` until
   *  2026-08-27 because that name was transcribed faithfully from the UCCNC
   *  modbus-master plugin, which calls it "VFD Error". Both were wrong: it is
   *  a state register whose 4 happens to mean fault, and the real fault CODE
   *  is 0x5000, which this map does not read (WO-1057).
   *
   *  The name mattered rather than merely being untidy - WO-1053 has to read
   *  this register to decide whether the spindle is turning before it will
   *  keep a link, and a register labelled "fault" is one nobody thinks to read
   *  for that. That is how the misnaming survived. */
  runState: VfdRunStateRegister
  status: VfdRegister
  /** WO-1735. Absent on Operator's GT and on every definition written before it:
   *  the fault then comes from the run-state word, unchanged. */
  faultCode?: VfdFaultCodeRegister
}

// --- command table -----------------------------------------------------------

export const VFD_COMMANDS = ['runCw', 'runCcw', 'stop', 'resetFault', 'releaseReset'] as const
export type VfdCommand = (typeof VFD_COMMANDS)[number]

/** `stop` is mandatory in every table. Nothing may ship that cannot stop. */
export const VFD_REQUIRED_COMMANDS: readonly VfdCommand[] = ['stop']

/** Operator's inverter: one whole word per command (1 CW, 2 CCW, 5 stop, 7 reset, 0 release). */
export interface VfdValueCommandTable {
  style: 'value'
  values: Partial<Record<VfdCommand, number>>
}

/**
 * Older Huanyang HY packs run / direction / stop into bits of one word, so a
 * command is "clear these bits, set those" applied over the word last written.
 */
export interface VfdBitfieldCommand {
  mask: number
  value: number
}

export interface VfdBitfieldCommandTable {
  style: 'bitfield'
  /** The word a bitfield command starts from when nothing has been written yet. */
  idle: number
  commands: Partial<Record<VfdCommand, VfdBitfieldCommand>>
}

export type VfdCommandTable = VfdValueCommandTable | VfdBitfieldCommandTable

/**
 * Clearing a fault is a SEQUENCE on Operator's inverter, not a value: write 7, wait
 * two seconds, write 0. One step is one command plus the pause after it.
 */
export interface VfdSequenceStep {
  command: VfdCommand
  delayMsAfter: number
}

// --- status block ------------------------------------------------------------

export const VFD_STATUS_FIELDS = ['volts', 'amps', 'actualRpm', 'torque', 'power', 'frequencyHz'] as const
export type VfdStatusFieldName = (typeof VFD_STATUS_FIELDS)[number]

export interface VfdRegisterStatusField {
  name: VfdStatusFieldName
  source: 'register'
  /** Word offset inside the status block. Words nobody uses are simply absent. */
  offset: number
  /** Raw word -> the field's unit. `raw.value` for a straight read. */
  scale: string | number
}

export interface VfdDerivedStatusField {
  name: VfdStatusFieldName
  source: 'derived'
  /** May only reference fields ABOVE it: Operator's power is `field.volts * field.amps`. */
  scale: string | number
}

export type VfdStatusField = VfdRegisterStatusField | VfdDerivedStatusField

// --- fault rule --------------------------------------------------------------

export type VfdFaultRule =
  | { kind: 'equals'; value: number }
  | { kind: 'nonZero' }
  | { kind: 'mask'; mask: number }

// --- the definition ----------------------------------------------------------

export interface VfdProvenance {
  kind: 'factory' | 'user' | 'imported'
  /** Where it came from in words: a profile file, a datasheet, a person. */
  source?: string
}

/**
 * A parameter that must be set INSIDE the inverter for the definition to work.
 * The link cannot set these and cannot check them; they are recorded so the
 * operator can. Operator's `PC.05 = 0` is the inverter's own comms-loss alarm - a
 * hardware safety net that our watchdog stands beside, never replaces.
 */
export interface VfdRequiredParameter {
  parameter: string
  value: string
  why: string
}

export interface VfdDefinition {
  format: typeof VFD_DEFINITION_FORMAT
  schemaVersion: typeof VFD_DEFINITION_SCHEMA_VERSION
  id: string
  name: string
  /**
   * FALSE until a human has run the verification flow (section 11.4) against
   * this exact inverter. Gates spindle-on; never gates a stop.
   */
  verified: boolean
  provenance: VfdProvenance
  link: VfdLink
  protocol: VfdProtocol
  registers: VfdRegisterMap
  commands: VfdCommandTable
  /** What to write, and how long to wait, to clear a fault. May be empty. */
  resetSequence: VfdSequenceStep[]
  status: VfdStatusField[]
  fault: VfdFaultRule
  /** Named numbers the scale expressions may use as `vfd.<name>`. */
  constants: Record<string, number>
  /** Actual RPM within this of the setpoint counts as up to speed. Operator's is 3. */
  upToSpeedToleranceRpm: number
  requiredParameters: VfdRequiredParameter[]
  notes?: string
}

// --- validation --------------------------------------------------------------

export type VfdErrorCode =
  | 'E_VFD_SCHEMA'
  | 'E_VFD_FIELD'
  | 'E_VFD_RANGE'
  | 'E_VFD_EXPR'
  | 'E_VFD_NO_STOP'
  | 'E_VFD_DUPLICATE'

export interface VfdDefinitionError {
  code: VfdErrorCode
  /** JSON path inside the definition, e.g. `registers.setpoint.scale`. */
  path: string
  /** A whole sentence, in plain words, ending with a full stop. */
  sentence: string
}

export interface VfdValidationResult {
  ok: boolean
  errors: VfdDefinitionError[]
  /** Compiled scale expressions, present only when there are no expression errors. */
  compiled: VfdCompiledScales | null
}

export interface VfdCompiledScales {
  setpoint: ExprAst
  status: { name: VfdStatusFieldName; source: 'register' | 'derived'; offset: number; ast: ExprAst }[]
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/
const U16_MAX = 65535

function err(code: VfdErrorCode, path: string, sentence: string): VfdDefinitionError {
  return { code, path, sentence }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkTiming(link: VfdLinkTiming, errors: VfdDefinitionError[]): void {
  if (!Number.isFinite(link.pollIntervalMs) || link.pollIntervalMs < 1 || link.pollIntervalMs > 5000) {
    errors.push(err('E_VFD_RANGE', 'link.pollIntervalMs', 'the poll interval has to be between 1 and 5000 milliseconds.'))
  }
  if (!Number.isInteger(link.retryCount) || link.retryCount < 0 || link.retryCount > 10) {
    errors.push(err('E_VFD_RANGE', 'link.retryCount', 'the retry count has to be a whole number from 0 to 10.'))
  }
  if (!Number.isFinite(link.timeoutMs) || link.timeoutMs < 1 || link.timeoutMs > 10000) {
    errors.push(err('E_VFD_RANGE', 'link.timeoutMs', 'the reply timeout has to be between 1 and 10000 milliseconds.'))
  }
}

function checkLink(link: VfdLink, errors: VfdDefinitionError[]): void {
  if (!isPlainObject(link)) {
    errors.push(err('E_VFD_FIELD', 'link', 'the definition has no link block.'))
    return
  }
  if (!Number.isInteger(link.slaveAddress) || link.slaveAddress < 1 || link.slaveAddress > 247) {
    errors.push(err('E_VFD_RANGE', 'link.slaveAddress', 'the slave address has to be a whole number from 1 to 247.'))
  }
  checkTiming(link, errors)
  if (link.transport === 'rtu') {
    if (typeof link.port !== 'string' || link.port.trim() === '') {
      errors.push(err('E_VFD_FIELD', 'link.port', 'a serial link needs a port name, such as COM3.'))
    }
    if (!Number.isInteger(link.baud) || link.baud < 1200 || link.baud > 921600) {
      errors.push(err('E_VFD_RANGE', 'link.baud', 'the baud rate has to be between 1200 and 921600.'))
    }
    if (link.dataBits !== 7 && link.dataBits !== 8) {
      errors.push(err('E_VFD_FIELD', 'link.dataBits', 'a Modbus RTU link uses 7 or 8 data bits.'))
    }
    if (link.parity !== 'none' && link.parity !== 'even' && link.parity !== 'odd') {
      errors.push(err('E_VFD_FIELD', 'link.parity', 'parity is none, even or odd.'))
    }
    if (link.stopBits !== 1 && link.stopBits !== 2) {
      errors.push(err('E_VFD_FIELD', 'link.stopBits', 'a Modbus RTU link uses 1 or 2 stop bits.'))
    }
  } else if (link.transport === 'tcp') {
    if (typeof link.host !== 'string' || link.host.trim() === '') {
      errors.push(err('E_VFD_FIELD', 'link.host', 'a network link needs a host address.'))
    }
    if (!Number.isInteger(link.tcpPort) || link.tcpPort < 1 || link.tcpPort > 65535) {
      errors.push(err('E_VFD_RANGE', 'link.tcpPort', 'the network port has to be a whole number from 1 to 65535.'))
    }
  } else {
    errors.push(err('E_VFD_FIELD', 'link.transport', 'the link is either `rtu` (a serial port) or `tcp` (a network adapter).'))
  }
}

function checkRegister(register: VfdRegister, path: string, errors: VfdDefinitionError[]): void {
  if (!isPlainObject(register)) {
    errors.push(err('E_VFD_FIELD', path, `there is no ${path.split('.').pop()} register.`))
    return
  }
  if (!Number.isInteger(register.address) || register.address < 0 || register.address > U16_MAX) {
    errors.push(err('E_VFD_RANGE', `${path}.address`, 'a register address has to be a whole number from 0 to 65535.'))
  }
  if (!Number.isInteger(register.count) || register.count < 1 || register.count > 125) {
    errors.push(err('E_VFD_RANGE', `${path}.count`, 'a register count has to be a whole number from 1 to 125.'))
  }
}

/**
 * WO-1735: ONE fault-rule check, wherever a rule is stated. The definition's
 * own `fault` is required; a fault-code register's is optional and falls back
 * to it, so `optional` is the only difference between the two callers.
 */
function checkFaultRule(
  rule: unknown,
  path: string,
  errors: VfdDefinitionError[],
  optional = false,
): void {
  if (rule === undefined && optional) return
  if (!isPlainObject(rule)) {
    errors.push(err('E_VFD_FIELD', path, `there is no fault rule at ${path}.`))
    return
  }
  const stated = rule as { kind?: unknown; value?: number; mask?: number }
  if (stated.kind === 'equals') {
    const value = stated.value as number
    if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
      errors.push(err('E_VFD_RANGE', `${path}.value`, 'the fault value has to be a whole number from 0 to 65535.'))
    }
    return
  }
  if (stated.kind === 'mask') {
    const mask = stated.mask as number
    if (!Number.isInteger(mask) || mask <= 0 || mask > U16_MAX) {
      errors.push(err('E_VFD_RANGE', `${path}.mask`, 'the fault mask has to be a whole number from 1 to 65535.'))
    }
    return
  }
  if (stated.kind !== 'nonZero') {
    errors.push(err('E_VFD_FIELD', `${path}.kind`, 'a fault rule is `equals` a value, `nonZero`, or a bit `mask`.'))
  }
}

/** WO-2009: the sentence for a run-state register with no meaning table. It
 *  names the rows, because the rows are the only fix. */
export const VFD_RUN_STATE_TABLE_MISSING_SENTENCE =
  'the run-state register has no table saying what its values mean, and the bridge cannot keep a spindle link '
  + 'without one - it cannot tell a stopped spindle from a running one. Add a row for each value this inverter '
  + `reports, at least the one that means stopped; the meanings are ${VFD_RUN_STATE_MEANINGS.join(', ')}.`

function checkRunStateValues(values: VfdRunStateValue[] | undefined, errors: VfdDefinitionError[]): void {
  // WO-2009: absent or empty is REFUSED. The bridge (Vfd.cs ClassifyRunState)
  // answers every code of a definition without a table "unrecognised" and
  // closes the link, so a check that let it through only moved the refusal
  // to the inverter, where it named the wrong thing. A definition that names
  // a shipped template is completed before this check
  // (`completeVfdRunStateValues`), so only one nothing can fill arrives here.
  if (values === undefined || (Array.isArray(values) && values.length === 0)) {
    errors.push(err('E_VFD_FIELD', 'registers.runState.values', VFD_RUN_STATE_TABLE_MISSING_SENTENCE))
    return
  }
  if (!Array.isArray(values)) {
    errors.push(err('E_VFD_FIELD', 'registers.runState.values', 'the run-state values have to be a list of value and meaning rows.'))
    return
  }

  const seen = new Map<number, number>()
  values.forEach((entry, index) => {
    const path = `registers.runState.values[${index}]`
    if (!isPlainObject(entry)) {
      errors.push(err('E_VFD_FIELD', path, 'a run-state row has to state a value and its meaning.'))
      return
    }
    const value = entry.value
    if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
      errors.push(err('E_VFD_RANGE', `${path}.value`, 'a run-state value has to be a whole number from 0 to 65535.'))
    } else {
      const earlier = seen.get(value)
      if (earlier !== undefined) {
        errors.push(err(
          'E_VFD_DUPLICATE',
          `${path}.value`,
          `the run-state value ${value} is already named by row ${earlier + 1}; one value cannot mean two states.`,
        ))
      } else {
        seen.set(value, index)
      }
    }
    if (!(VFD_RUN_STATE_MEANINGS as readonly unknown[]).includes(entry.meaning)) {
      errors.push(err(
        'E_VFD_FIELD',
        `${path}.meaning`,
        `a run-state meaning is one of ${VFD_RUN_STATE_MEANINGS.join(', ')}.`,
      ))
    }
  })
}

function checkCommands(table: VfdCommandTable, errors: VfdDefinitionError[]): void {
  if (!isPlainObject(table)) {
    errors.push(err('E_VFD_FIELD', 'commands', 'the definition has no command table.'))
    return
  }
  if (table.style === 'value') {
    const values = table.values
    if (!isPlainObject(values)) {
      errors.push(err('E_VFD_FIELD', 'commands.values', 'a value command table needs a value for each command.'))
      return
    }
    for (const [name, value] of Object.entries(values)) {
      if (!(VFD_COMMANDS as readonly string[]).includes(name)) {
        errors.push(err('E_VFD_FIELD', `commands.values.${name}`, `\`${name}\` is not a spindle command; the commands are ${VFD_COMMANDS.join(', ')}.`))
        continue
      }
      if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
        errors.push(err('E_VFD_RANGE', `commands.values.${name}`, 'a command value has to be a whole number from 0 to 65535.'))
      }
    }
    for (const required of VFD_REQUIRED_COMMANDS) {
      if (typeof values[required] !== 'number') {
        errors.push(err('E_VFD_NO_STOP', `commands.values.${required}`, `the table has no \`${required}\` command; a definition that cannot stop the spindle is not allowed.`))
      }
    }
  } else if (table.style === 'bitfield') {
    if (!Number.isInteger(table.idle) || table.idle < 0 || table.idle > U16_MAX) {
      errors.push(err('E_VFD_RANGE', 'commands.idle', 'the idle word has to be a whole number from 0 to 65535.'))
    }
    const commands = table.commands
    if (!isPlainObject(commands)) {
      errors.push(err('E_VFD_FIELD', 'commands.commands', 'a bitfield command table needs a mask and value for each command.'))
      return
    }
    for (const [name, entry] of Object.entries(commands)) {
      if (!(VFD_COMMANDS as readonly string[]).includes(name)) {
        errors.push(err('E_VFD_FIELD', `commands.commands.${name}`, `\`${name}\` is not a spindle command; the commands are ${VFD_COMMANDS.join(', ')}.`))
        continue
      }
      if (!entry || !Number.isInteger(entry.mask) || entry.mask < 0 || entry.mask > U16_MAX) {
        errors.push(err('E_VFD_RANGE', `commands.commands.${name}.mask`, 'a bit mask has to be a whole number from 0 to 65535.'))
        continue
      }
      if (!Number.isInteger(entry.value) || entry.value < 0 || entry.value > U16_MAX) {
        errors.push(err('E_VFD_RANGE', `commands.commands.${name}.value`, 'a bit value has to be a whole number from 0 to 65535.'))
        continue
      }
      if ((entry.value & ~entry.mask & U16_MAX) !== 0) {
        errors.push(err('E_VFD_FIELD', `commands.commands.${name}`, 'the value sets bits the mask does not cover, so the result would depend on what was written before.'))
      }
    }
    for (const required of VFD_REQUIRED_COMMANDS) {
      if (!commands[required]) {
        errors.push(err('E_VFD_NO_STOP', `commands.commands.${required}`, `the table has no \`${required}\` command; a definition that cannot stop the spindle is not allowed.`))
      }
    }
  } else {
    errors.push(err('E_VFD_FIELD', 'commands.style', 'a command table is either `value` (one word per command) or `bitfield` (bits inside one word).'))
  }
}

function checkExpression(
  source: string | number,
  path: string,
  shape: VfdExprScopeShape,
  errors: VfdDefinitionError[],
): ExprAst | null {
  if (typeof source !== 'string' && typeof source !== 'number') {
    errors.push(err('E_VFD_FIELD', path, 'a scale is an expression such as `set.rpm / 2.4`, or a plain number.'))
    return null
  }
  const { ast, faults } = checkVfdExpr(source, shape)
  for (const fault of faults) errors.push(err('E_VFD_EXPR', path, fault.sentence))
  return faults.length === 0 ? ast : null
}

/**
 * Check one definition from top to bottom. Pure: no port is opened, nothing is
 * written anywhere. `compiled` is non-null only when every scale expression
 * parsed and resolved, so callers never evaluate a half-checked definition.
 */
export function validateVfdDefinition(definition: VfdDefinition): VfdValidationResult {
  const errors: VfdDefinitionError[] = []

  if (definition.format !== VFD_DEFINITION_FORMAT) {
    errors.push(err('E_VFD_SCHEMA', 'format', `this is not a ${VFD_DEFINITION_FORMAT} definition.`))
  }
  if (definition.schemaVersion !== VFD_DEFINITION_SCHEMA_VERSION) {
    errors.push(err('E_VFD_SCHEMA', 'schemaVersion', `this definition is version ${String(definition.schemaVersion)}; this build reads version ${VFD_DEFINITION_SCHEMA_VERSION}.`))
  }
  if (typeof definition.id !== 'string' || !ID_RE.test(definition.id)) {
    errors.push(err('E_VFD_FIELD', 'id', 'the id has to be 3 to 64 characters of lower-case letters, digits, dots and dashes.'))
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    errors.push(err('E_VFD_FIELD', 'name', 'the definition needs a name.'))
  }
  if (typeof definition.verified !== 'boolean') {
    errors.push(err('E_VFD_FIELD', 'verified', 'the definition has to say plainly whether it has been verified against the inverter.'))
  }

  checkLink(definition.link, errors)

  const protocol = definition.protocol
  if (!isPlainObject(protocol)) {
    errors.push(err('E_VFD_FIELD', 'protocol', 'the definition has no protocol block.'))
  } else {
    if (!(VFD_READ_FUNCTIONS as readonly number[]).includes(protocol.readFunction)) {
      errors.push(err('E_VFD_FIELD', 'protocol.readFunction', `the read function is one of ${VFD_READ_FUNCTIONS.map((f) => `0x${f.toString(16).padStart(2, '0')}`).join(', ')}.`))
    }
    if (!(VFD_WRITE_FUNCTIONS as readonly number[]).includes(protocol.writeFunction)) {
      errors.push(err('E_VFD_FIELD', 'protocol.writeFunction', `the write function is one of ${VFD_WRITE_FUNCTIONS.map((f) => `0x${f.toString(16).padStart(2, '0')}`).join(', ')}.`))
    }
    if (protocol.wordOrder !== 'high-first' && protocol.wordOrder !== 'low-first') {
      errors.push(err('E_VFD_FIELD', 'protocol.wordOrder', 'the word order is `high-first` or `low-first`.'))
    }
  }

  const registers = definition.registers
  if (!isPlainObject(registers)) {
    errors.push(err('E_VFD_FIELD', 'registers', 'the definition has no register map.'))
  } else {
    for (const role of VFD_REGISTER_ROLES) checkRegister(registers[role], `registers.${role}`, errors)
    if (isPlainObject(registers.runState)) {
      checkRunStateValues(registers.runState.values as VfdRunStateValue[] | undefined, errors)
    }
    // WO-1735: stated or absent, never half-stated. A fault register with no
    // usable address is an address this software would have to choose, and
    // choosing a Modbus address is inventing a machine fact.
    for (const role of VFD_OPTIONAL_REGISTER_ROLES) {
      if (registers[role] === undefined) continue
      checkRegister(registers[role], `registers.${role}`, errors)
      checkFaultRule((registers[role] as VfdFaultCodeRegister).rule, `registers.${role}.rule`, errors, true)
    }
  }

  checkCommands(definition.commands, errors)

  const constants = isPlainObject(definition.constants) ? definition.constants : {}
  for (const [name, value] of Object.entries(constants)) {
    if (!Number.isFinite(value)) {
      errors.push(err('E_VFD_RANGE', `constants.${name}`, `the constant \`${name}\` is not a number.`))
    }
  }
  const constantNames = Object.keys(constants)

  let setpointAst: ExprAst | null = null
  if (isPlainObject(registers) && isPlainObject(registers.setpoint)) {
    // WO-1736: one register (Operator's) or two (a 32-bit speed reference). A
    // `count` that is not a whole number at all has already been named by
    // checkRegister; saying it twice helps nobody.
    const setpointCount = registers.setpoint.count
    if (
      Number.isInteger(setpointCount) && setpointCount >= 1
      && !(VFD_SETPOINT_WORD_COUNTS as readonly number[]).includes(setpointCount)
    ) {
      errors.push(err(
        'E_VFD_RANGE',
        'registers.setpoint.count',
        'a speed setpoint is one register (16-bit) or two (32-bit).',
      ))
    }
    setpointAst = checkExpression(registers.setpoint.scale, 'registers.setpoint.scale', {
      direction: 'setpoint',
      constants: constantNames,
      earlierFields: [],
    }, errors)
    const encode = registers.setpoint.encode
    if (!isPlainObject(encode)) {
      errors.push(err('E_VFD_FIELD', 'registers.setpoint.encode', 'the setpoint needs to say how it is rounded and what it is clamped to.'))
    } else {
      if (encode.round !== 'nearest' && encode.round !== 'down' && encode.round !== 'up') {
        errors.push(err('E_VFD_FIELD', 'registers.setpoint.encode.round', 'rounding is `nearest`, `down` or `up`.'))
      }
      // WO-1736: the clamp is bounded by the WIDTH the definition states, not
      // by 16 bits. A two-register setpoint that could only be clamped to
      // 65,535 is a 32-bit drive nobody can drive past a fraction of its range.
      const ceiling = vfdSetpointCeiling(setpointCount)
      if (!Number.isInteger(encode.min) || encode.min < 0 || encode.min > ceiling) {
        errors.push(err('E_VFD_RANGE', 'registers.setpoint.encode.min', `the smallest setpoint word has to be a whole number from 0 to ${ceiling}.`))
      }
      if (!Number.isInteger(encode.max) || encode.max < 0 || encode.max > ceiling) {
        errors.push(err('E_VFD_RANGE', 'registers.setpoint.encode.max', `the largest setpoint word has to be a whole number from 0 to ${ceiling}.`))
      }
      if (Number.isInteger(encode.min) && Number.isInteger(encode.max) && encode.min > encode.max) {
        errors.push(err('E_VFD_RANGE', 'registers.setpoint.encode', 'the smallest setpoint word is larger than the largest.'))
      }
    }
  }

  const statusList = Array.isArray(definition.status) ? definition.status : []
  if (!Array.isArray(definition.status)) {
    errors.push(err('E_VFD_FIELD', 'status', 'the status block is a list of fields, which may be empty.'))
  }
  const compiledStatus: VfdCompiledScales['status'] = []
  const seenFields: string[] = []
  const statusCount = isPlainObject(registers) && isPlainObject(registers.status) ? registers.status.count : 0
  statusList.forEach((field, index) => {
    const path = `status[${index}]`
    if (!isPlainObject(field) || !(VFD_STATUS_FIELDS as readonly string[]).includes(field.name)) {
      errors.push(err('E_VFD_FIELD', `${path}.name`, `a status field is one of ${VFD_STATUS_FIELDS.join(', ')}.`))
      return
    }
    if (seenFields.includes(field.name)) {
      errors.push(err('E_VFD_DUPLICATE', `${path}.name`, `\`${field.name}\` is decoded twice.`))
      return
    }
    let offset = -1
    if (field.source === 'register') {
      offset = field.offset
      if (!Number.isInteger(offset) || offset < 0) {
        errors.push(err('E_VFD_RANGE', `${path}.offset`, 'the offset into the status block has to be a whole number, 0 or more.'))
        return
      }
      if (Number.isInteger(statusCount) && offset >= statusCount) {
        errors.push(err('E_VFD_RANGE', `${path}.offset`, `the status block is ${statusCount} words long, so there is no word ${offset}.`))
        return
      }
    } else if (field.source !== 'derived') {
      errors.push(err('E_VFD_FIELD', `${path}.source`, 'a status field comes from a `register` word or is `derived` from fields above it.'))
      return
    }
    const ast = checkExpression(field.scale, `${path}.scale`, {
      direction: 'status',
      constants: constantNames,
      earlierFields: [...seenFields],
    }, errors)
    seenFields.push(field.name)
    if (ast) compiledStatus.push({ name: field.name, source: field.source, offset, ast })
  })

  if (!isPlainObject(definition.fault)) {
    errors.push(err('E_VFD_FIELD', 'fault', 'the definition has no fault rule.'))
  } else {
    checkFaultRule(definition.fault, 'fault', errors)
  }

  const sequence = Array.isArray(definition.resetSequence) ? definition.resetSequence : []
  if (!Array.isArray(definition.resetSequence)) {
    errors.push(err('E_VFD_FIELD', 'resetSequence', 'the fault-reset sequence is a list of steps, which may be empty.'))
  }
  sequence.forEach((step, index) => {
    const path = `resetSequence[${index}]`
    if (!isPlainObject(step) || !(VFD_COMMANDS as readonly string[]).includes(step.command)) {
      errors.push(err('E_VFD_FIELD', `${path}.command`, `a reset step names one of ${VFD_COMMANDS.join(', ')}.`))
      return
    }
    if (!Number.isFinite(step.delayMsAfter) || step.delayMsAfter < 0 || step.delayMsAfter > 30000) {
      errors.push(err('E_VFD_RANGE', `${path}.delayMsAfter`, 'the pause after a reset step has to be between 0 and 30000 milliseconds.'))
    }
    if (!commandExists(definition.commands, step.command)) {
      errors.push(err('E_VFD_FIELD', `${path}.command`, `the command table has no \`${step.command}\`, so this step could not be sent.`))
    }
  })

  if (!Number.isFinite(definition.upToSpeedToleranceRpm) || definition.upToSpeedToleranceRpm < 0) {
    errors.push(err('E_VFD_RANGE', 'upToSpeedToleranceRpm', 'the up-to-speed tolerance has to be 0 RPM or more.'))
  }

  const compiled = errors.some((e) => e.code === 'E_VFD_EXPR') || !setpointAst
    ? null
    : { setpoint: setpointAst, status: compiledStatus }

  return { ok: errors.length === 0, errors, compiled }
}

/**
 * WO-2009 - A DEFINITION THAT NAMES A SHIPPED TEMPLATE GETS THAT TEMPLATE'S
 * RUN-STATE ROWS, FROM THE APP, NOT FROM THE OPERATOR.
 *
 * Definitions saved before WO-1721 carry `registers.runState` with no values
 * table. The bridge cannot keep a link without one. When the definition's id is
 * a shipped template's AND its run-state register is that template's register
 * (same address, same width - a table is a fact about one register, not about a
 * drive name), the template's rows are copied in. Anything else is returned
 * untouched and `validateVfdDefinition` refuses it, naming the rows.
 *
 * Pure: the input is never modified. `filledFrom` is the template's name when
 * rows were added, so the caller can say so once.
 */
export function completeVfdRunStateValues<T extends Pick<VfdDefinition, 'id' | 'registers'>>(
  definition: T,
  templates: readonly Pick<VfdDefinition, 'id' | 'name' | 'registers'>[],
): { definition: T; filledFrom: string | null } {
  const registers = isPlainObject(definition) ? definition.registers : undefined
  const runState = isPlainObject(registers) ? registers.runState : undefined
  if (!isPlainObject(runState) || runState.values !== undefined) return { definition, filledFrom: null }
  const template = templates.find((entry) => entry.id === definition.id)
  const rows = template?.registers.runState.values
  if (
    !template
    || !Array.isArray(rows)
    || rows.length === 0
    || template.registers.runState.address !== runState.address
    || template.registers.runState.count !== runState.count
  ) {
    return { definition, filledFrom: null }
  }
  return {
    definition: {
      ...definition,
      registers: {
        ...definition.registers,
        runState: { ...runState, values: rows.map((row) => ({ ...row })) },
      },
    },
    filledFrom: template.name,
  }
}

/** Whether the table can produce a word for this command at all. */
export function commandExists(table: VfdCommandTable, command: VfdCommand): boolean {
  if (!isPlainObject(table)) return false
  if (table.style === 'value') return typeof table.values?.[command] === 'number'
  if (table.style === 'bitfield') return Boolean(table.commands?.[command])
  return false
}

// --- canonical text, for round-tripping and hashing --------------------------

const DEFINITION_KEY_ORDER: (keyof VfdDefinition)[] = [
  'format',
  'schemaVersion',
  'id',
  'name',
  'verified',
  'provenance',
  'link',
  'protocol',
  'registers',
  'commands',
  'resetSequence',
  'status',
  'fault',
  'constants',
  'upToSpeedToleranceRpm',
  'requiredParameters',
  'notes',
]

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

/** Stable JSON: top-level keys in declaration order, everything below sorted. */
export function canonicalVfdDefinitionJson(definition: VfdDefinition): string {
  const out: Record<string, unknown> = {}
  for (const key of DEFINITION_KEY_ORDER) {
    const value = definition[key]
    if (value === undefined) continue
    out[key] = sortDeep(value)
  }
  return JSON.stringify(out, null, 2)
}

export type VfdParseResult =
  | { ok: true; definition: VfdDefinition; errors: [] }
  | { ok: false; definition: null; errors: VfdDefinitionError[] }

/**
 * Read one definition from text. A definition that does not validate is NEVER
 * returned, verified is FORCED to false on the way in whatever the text says,
 * and provenance is forced to `imported`: a file cannot tell LienCAM that
 * somebody ran the verification flow.
 */
export function parseVfdDefinition(text: string, source?: string): VfdParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, definition: null, errors: [err('E_VFD_SCHEMA', '', 'this file is not readable as JSON.')] }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, definition: null, errors: [err('E_VFD_SCHEMA', '', 'a VFD definition file holds one definition object.')] }
  }
  const candidate = {
    ...(raw as unknown as VfdDefinition),
    verified: false,
    provenance: { kind: 'imported', source: source ?? (raw.provenance as VfdProvenance | undefined)?.source } as VfdProvenance,
  }
  const result = validateVfdDefinition(candidate)
  if (!result.ok) return { ok: false, definition: null, errors: result.errors }
  return { ok: true, definition: candidate, errors: [] }
}
