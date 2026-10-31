// WO-425 - the VFD link, generalised.
//
// What these tests CANNOT do: talk to an inverter. There is no demo mode for a
// VFD (uccnc-control-plan.md section 10.4) and nothing here pretends otherwise.
// What they do prove is everything that is decidable off the hardware: the
// definition format round-trips, the scale expression is the bounded evaluator
// and not `eval`, the command table maps both styles, the fault rule fires, and
// - the one that matters at 24,000 RPM - an unverified definition refuses
// spindle-on while a stop is never refused by anything.

import { describe, expect, it } from 'vitest'
import {
  HUANYANG_GT,
  VFD_DEFINITIONS,
  VFD_DEFINITION_FORMAT,
  VFD_DEFINITION_SCHEMA_VERSION,
  VFD_LINK_DEFAULT_ENABLED,
  VFD_LINK_DEFAULT_SETTINGS,
  VFD_LINK_QUIET_STOP_MS,
  VFD_LINK_STATE_DOWN,
  canonicalVfdDefinitionJson,
  checkVfdExpr,
  commandExists,
  compileVfdDefinition,
  describeVfdFault,
  evaluateVfdExpr,
  parseVfdDefinition,
  validateVfdDefinition,
  vfdCommandGate,
  vfdCommandWord,
  vfdDecodeStatus,
  vfdIsFaulted,
  vfdIsUpToSpeed,
  vfdSetpointWord,
  vfdSpindleOnAllowed,
  vfdStopIsAllowed,
  vfdStopRequired,
  type VfdCommandTable,
  type VfdDefinition,
  type VfdLinkState,
} from '../../lib/machine/vfd'

function clone(definition: VfdDefinition): VfdDefinition {
  return JSON.parse(JSON.stringify(definition)) as VfdDefinition
}

const UP: VfdLinkState = {
  enabled: true,
  connected: true,
  timeSinceLastSuccessMs: 0,
  bridgeConnected: true,
  clientConnected: true,
  faulted: false,
}

// --- 1. Operator's definition, and only Operator's -----------------------------------

describe("WO-425 the one definition that ships is Operator's, unverified", () => {
  it('validates', () => {
    const result = validateVfdDefinition(HUANYANG_GT)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.compiled).not.toBeNull()
  })

  it('is the only one, and it is not verified', () => {
    expect(VFD_DEFINITIONS).toHaveLength(1)
    expect(VFD_DEFINITIONS[0]).toBe(HUANYANG_GT)
    expect(HUANYANG_GT.verified).toBe(false)
  })

  it("carries Operator's measured link timings unchanged", () => {
    // WO-3072 (e4ccf21a81): the shipped link seeds its port per host -
    // Operator's measured COM3 on Windows, the USB serial device on Linux. The
    // measured timings below are the same either way.
    expect(HUANYANG_GT.link).toMatchObject({
      transport: 'rtu',
      port: process.platform === 'linux' ? '/dev/ttyUSB0' : 'COM3',
      baud: 19200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      slaveAddress: 1,
      pollIntervalMs: 25,
      retryCount: 1,
      timeoutMs: 297,
    })
  })

  it("carries Operator's register map keyed by role", () => {
    expect(HUANYANG_GT.registers.command.address).toBe(0x1000)
    expect(HUANYANG_GT.registers.setpoint.address).toBe(0x2000)
    expect(HUANYANG_GT.registers.runState.address).toBe(0x1001)
    expect(HUANYANG_GT.registers.status.address).toBe(0x3003)
    expect(HUANYANG_GT.registers.status.count).toBe(5)
  })

  it("records the inverter's own comms-loss alarm as a parameter we must not replace", () => {
    const pc05 = HUANYANG_GT.requiredParameters.find((p) => p.parameter === 'PC.05')
    expect(pc05?.value).toBe('0')
    expect(pc05?.why).toContain('never replaces')
  })

  it('ships the link switched off', () => {
    expect(VFD_LINK_DEFAULT_ENABLED).toBe(false)
    expect(VFD_LINK_DEFAULT_SETTINGS.enabled).toBe(false)
    expect(VFD_LINK_STATE_DOWN.enabled).toBe(false)
  })
})

// --- 2. the format round-trips ------------------------------------------------

describe('WO-425 the definition format round-trips', () => {
  it('canonical JSON parses back to the same definition', () => {
    const text = canonicalVfdDefinitionJson(HUANYANG_GT)
    const parsed = parseVfdDefinition(text, 'huanyang-gt.json')
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const back = parsed.definition!
    expect(back.link).toEqual(HUANYANG_GT.link)
    expect(back.registers).toEqual(HUANYANG_GT.registers)
    expect(back.commands).toEqual(HUANYANG_GT.commands)
    expect(back.status).toEqual(HUANYANG_GT.status)
    expect(back.fault).toEqual(HUANYANG_GT.fault)
    expect(back.resetSequence).toEqual(HUANYANG_GT.resetSequence)
  })

  it('is stable: a round trip is a fixed point after the first import', () => {
    const once = canonicalVfdDefinitionJson(HUANYANG_GT)
    // The first import rewrites provenance to `imported` on purpose; from there
    // the text no longer moves.
    const imported = canonicalVfdDefinitionJson(parseVfdDefinition(once).definition!)
    const again = canonicalVfdDefinitionJson(parseVfdDefinition(imported).definition!)
    expect(again).toBe(imported)
    expect(JSON.parse(imported).provenance.kind).toBe('imported')
  })

  it('a file may NEVER claim to be verified', () => {
    const lying = { ...clone(HUANYANG_GT), verified: true }
    const parsed = parseVfdDefinition(JSON.stringify(lying))
    expect(parsed.ok).toBe(true)
    expect(parsed.definition!.verified).toBe(false)
    expect(parsed.definition!.provenance.kind).toBe('imported')
  })

  it('refuses a newer schema version rather than guessing', () => {
    const future = { ...clone(HUANYANG_GT), schemaVersion: VFD_DEFINITION_SCHEMA_VERSION + 1 }
    const parsed = parseVfdDefinition(JSON.stringify(future))
    expect(parsed.ok).toBe(false)
    expect(parsed.errors.map((e) => e.code)).toContain('E_VFD_SCHEMA')
  })

  it('refuses text that is not a definition at all', () => {
    expect(parseVfdDefinition('{oops').ok).toBe(false)
    expect(parseVfdDefinition('[]').ok).toBe(false)
    expect(parseVfdDefinition(JSON.stringify({ format: 'something-else' })).ok).toBe(false)
  })
})

// --- 3. the scale expression --------------------------------------------------

describe("WO-425 the scale expression evaluates Operator's RPM / 2.4", () => {
  const compiled = compileVfdDefinition(HUANYANG_GT)

  it('compiles', () => {
    expect(compiled.ok).toBe(true)
  })

  it('turns commanded RPM into the frequency register word', () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    const cases: [number, number][] = [
      [0, 0],
      [2400, 1000],
      [12000, 5000],
      [24000, 10000],
    ]
    for (const [rpm, word] of cases) {
      const result = vfdSetpointWord(compiled.definition, compiled.compiled, rpm)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.word).toBe(word)
        expect(result.clamped).toBe(false)
      }
    }
  })

  it('rounds, because a register holds whole words and the language has no round()', () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    const result = vfdSetpointWord(compiled.definition, compiled.compiled, 1000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.exact).toBeCloseTo(1000 / 2.4, 9)
      expect(result.word).toBe(417)
    }
  })

  it('clamps above the ceiling and SAYS SO rather than wrapping a 16-bit word', () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    const result = vfdSetpointWord(compiled.definition, compiled.compiled, 250000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.word).toBe(10000)
      expect(result.clamped).toBe(true)
    }
  })

  it('refuses a commanded speed that is not a number', () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    expect(vfdSetpointWord(compiled.definition, compiled.compiled, Number.NaN).ok).toBe(false)
  })

  it('uses the bounded evaluator, so there is no way to run code', () => {
    const shape = { direction: 'setpoint' as const, constants: ['maxRpm'], earlierFields: [] }
    for (const hostile of [
      'process.exit(1)',
      'set.rpm ** 2',
      'set.rpm ^ 2',
      'fetch("x")',
      'set.rpm = 9',
      '"abc"',
      'set.rpm , 1',
    ]) {
      const { faults } = checkVfdExpr(hostile, shape)
      expect(faults.length, hostile).toBeGreaterThan(0)
    }
  })

  it('refuses names the definition does not declare', () => {
    const shape = { direction: 'setpoint' as const, constants: ['maxRpm'], earlierFields: [] }
    expect(checkVfdExpr('set.rpm / vfd.poles', shape).faults[0].sentence).toContain('not a constant')
    expect(checkVfdExpr('raw.value * 2', shape).faults[0].sentence).toContain('status field')
    expect(checkVfdExpr('spindle.rpm', shape).faults[0].sentence).toContain('set., raw., field. or vfd.')
  })

  it('catches a scale that always divides by zero, statically', () => {
    const shape = { direction: 'setpoint' as const, constants: [] as string[], earlierFields: [] as string[] }
    const { faults } = checkVfdExpr('set.rpm / (2 - 2)', shape)
    expect(faults.some((f) => f.code === 'E_CALC_NOT_FINITE')).toBe(true)
  })

  it('evaluates a declared constant', () => {
    const shape = { direction: 'setpoint' as const, constants: ['maxRpm'], earlierFields: [] }
    const { ast, faults } = checkVfdExpr('set.rpm / vfd.maxRpm * 100', shape)
    expect(faults).toEqual([])
    const value = evaluateVfdExpr(ast!, { setRpm: 12000, constants: { maxRpm: 24000 } })
    expect(value.ok).toBe(true)
    if (value.ok) expect(value.value).toBeCloseTo(50, 9)
  })
})

// --- 4. the command table -----------------------------------------------------

describe('WO-425 the command table maps CW, CCW, stop and reset', () => {
  it("gives Operator's whole-word values", () => {
    const table = HUANYANG_GT.commands
    expect(vfdCommandWord(table, 'runCw')).toEqual({ ok: true, word: 1 })
    expect(vfdCommandWord(table, 'runCcw')).toEqual({ ok: true, word: 2 })
    expect(vfdCommandWord(table, 'stop')).toEqual({ ok: true, word: 5 })
    expect(vfdCommandWord(table, 'resetFault')).toEqual({ ok: true, word: 7 })
    expect(vfdCommandWord(table, 'releaseReset')).toEqual({ ok: true, word: 0 })
  })

  it("carries Operator's two-step reset sequence, pause and all", () => {
    expect(HUANYANG_GT.resetSequence).toEqual([
      { command: 'resetFault', delayMsAfter: 2000 },
      { command: 'releaseReset', delayMsAfter: 0 },
    ])
    for (const step of HUANYANG_GT.resetSequence) {
      expect(commandExists(HUANYANG_GT.commands, step.command)).toBe(true)
    }
  })

  it('also carries a bitfield inverter, which is the other common scheme', () => {
    const bitfield: VfdCommandTable = {
      style: 'bitfield',
      idle: 0b0000,
      commands: {
        runCw: { mask: 0b0011, value: 0b0001 },
        runCcw: { mask: 0b0011, value: 0b0011 },
        stop: { mask: 0b0011, value: 0b0000 },
        resetFault: { mask: 0b0100, value: 0b0100 },
        releaseReset: { mask: 0b0100, value: 0b0000 },
      },
    }
    // Bits outside the mask survive, which is what a bitfield inverter needs.
    expect(vfdCommandWord(bitfield, 'runCw', 0b1000)).toEqual({ ok: true, word: 0b1001 })
    expect(vfdCommandWord(bitfield, 'runCcw', 0b1001)).toEqual({ ok: true, word: 0b1011 })
    expect(vfdCommandWord(bitfield, 'stop', 0b1011)).toEqual({ ok: true, word: 0b1000 })
    expect(vfdCommandWord(bitfield, 'runCw')).toEqual({ ok: true, word: 0b0001 })
  })

  it('says plainly when an inverter has no such command', () => {
    const table: VfdCommandTable = { style: 'value', values: { stop: 5, runCw: 1 } }
    const result = vfdCommandWord(table, 'runCcw')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.sentence).toContain('runCcw')
  })

  it('REFUSES a definition that cannot stop the spindle', () => {
    const noStop = clone(HUANYANG_GT)
    delete (noStop.commands as { values: Record<string, number> }).values.stop
    const result = validateVfdDefinition(noStop)
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain('E_VFD_NO_STOP')
  })

  it('refuses a bitfield command whose value escapes its mask', () => {
    const sloppy = clone(HUANYANG_GT)
    sloppy.commands = {
      style: 'bitfield',
      idle: 0,
      commands: { stop: { mask: 0b0001, value: 0b0010 } },
    }
    const result = validateVfdDefinition(sloppy)
    expect(result.errors.some((e) => e.path === 'commands.commands.stop')).toBe(true)
  })
})

// --- 5. the fault rule --------------------------------------------------------

describe('WO-425 the fault rule fires on 4', () => {
  it("fires on Operator's value and on nothing else", () => {
    expect(vfdIsFaulted(HUANYANG_GT.fault, 4)).toBe(true)
    for (const clear of [0, 1, 3, 5, 40]) {
      expect(vfdIsFaulted(HUANYANG_GT.fault, clear)).toBe(false)
    }
    expect(describeVfdFault(HUANYANG_GT.fault, 4)).toContain('fault')
    expect(describeVfdFault(HUANYANG_GT.fault, 0)).toContain('no fault')
  })

  it('carries the other two rules other inverters use', () => {
    expect(vfdIsFaulted({ kind: 'nonZero' }, 0)).toBe(false)
    expect(vfdIsFaulted({ kind: 'nonZero' }, 1)).toBe(true)
    expect(vfdIsFaulted({ kind: 'mask', mask: 0b1000 }, 0b0111)).toBe(false)
    expect(vfdIsFaulted({ kind: 'mask', mask: 0b1000 }, 0b1001)).toBe(true)
  })
})

// --- 6. the status block ------------------------------------------------------

describe('WO-425 the status block decodes by role, not by position in the reply', () => {
  const compiled = compileVfdDefinition(HUANYANG_GT)

  it("decodes Operator's five words, including the power the macro computes", () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    // volts, amps, actual RPM, unused, torque
    const result = vfdDecodeStatus(compiled.definition, compiled.compiled, [240, 3, 23998, 0, 55])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.readings).toEqual({ volts: 240, amps: 3, actualRpm: 23998, torque: 55, power: 720 })
    }
  })

  it('says so when the inverter sends a short reply instead of guessing', () => {
    if (!compiled.ok) throw new Error('definition did not compile')
    const result = vfdDecodeStatus(compiled.definition, compiled.compiled, [240, 3])
    expect(result.ok).toBe(false)
  })

  it('lets an inverter that reports Hz convert to RPM in the definition', () => {
    const hzInverter = clone(HUANYANG_GT)
    hzInverter.status = [{ name: 'actualRpm', source: 'register', offset: 2, scale: 'raw.value * 2.4' }]
    const built = compileVfdDefinition(hzInverter)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const result = vfdDecodeStatus(built.definition, built.compiled, [0, 0, 10000, 0, 0])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.readings.actualRpm).toBe(24000)
  })

  it('refuses a derived field that reaches forwards', () => {
    const backwards = clone(HUANYANG_GT)
    backwards.status = [
      { name: 'power', source: 'derived', scale: 'field.volts * field.amps' },
      { name: 'volts', source: 'register', offset: 0, scale: 'raw.value' },
      { name: 'amps', source: 'register', offset: 1, scale: 'raw.value' },
    ]
    const result = validateVfdDefinition(backwards)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === 'E_VFD_EXPR')).toBe(true)
    expect(result.compiled).toBeNull()
  })

  it('refuses an offset outside the block the definition reads', () => {
    const overrun = clone(HUANYANG_GT)
    overrun.status = [{ name: 'volts', source: 'register', offset: 9, scale: 'raw.value' }]
    const result = validateVfdDefinition(overrun)
    expect(result.errors.some((e) => e.path === 'status[0].offset')).toBe(true)
  })

  it("uses Operator's +/-3 RPM tolerance for up-to-speed", () => {
    expect(HUANYANG_GT.upToSpeedToleranceRpm).toBe(3)
    expect(vfdIsUpToSpeed(HUANYANG_GT, 24000, 23998)).toBe(true)
    expect(vfdIsUpToSpeed(HUANYANG_GT, 24000, 24003)).toBe(true)
    expect(vfdIsUpToSpeed(HUANYANG_GT, 24000, 23990)).toBe(false)
    expect(vfdIsUpToSpeed(HUANYANG_GT, 24000, undefined)).toBe(false)
  })
})

// --- 7. unverified gates spindle-on, and NOTHING gates a stop -----------------

describe('WO-425 unverified refuses spindle-on but never a stop', () => {
  it("refuses spindle-on for Operator's definition, because nobody has run it yet", () => {
    const decision = vfdSpindleOnAllowed(UP, HUANYANG_GT)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.refusal).toBe('unverified')
      expect(decision.sentence).toContain('Huanyang GT')
    }
    expect(vfdCommandGate('runCcw', UP, HUANYANG_GT).allowed).toBe(false)
  })

  it('allows spindle-on once, and only once, the definition is verified', () => {
    const verified = { ...clone(HUANYANG_GT), verified: true }
    expect(vfdCommandGate('runCw', UP, verified).allowed).toBe(true)
    expect(vfdCommandGate('runCcw', UP, verified).allowed).toBe(true)
  })

  it('allows a stop in EVERY state, including with no definition at all', () => {
    const states: VfdLinkState[] = [
      UP,
      VFD_LINK_STATE_DOWN,
      { ...UP, enabled: false },
      { ...UP, connected: false },
      { ...UP, faulted: true },
      { ...UP, bridgeConnected: false },
      { ...UP, clientConnected: false },
      { ...UP, timeSinceLastSuccessMs: 99 },
    ]
    const broken = clone(HUANYANG_GT)
    broken.registers.setpoint.scale = 'nonsense !!'
    for (const state of states) {
      for (const definition of [HUANYANG_GT, null, broken, { ...clone(HUANYANG_GT), verified: true }]) {
        expect(vfdCommandGate('stop', state, definition).allowed).toBe(true)
      }
    }
    expect(vfdStopIsAllowed()).toBe(true)
  })

  it('refuses spindle-on while the link is switched off, verified or not', () => {
    const verified = { ...clone(HUANYANG_GT), verified: true }
    const off = { ...UP, enabled: false }
    const decision = vfdCommandGate('runCw', off, verified)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.refusal).toBe('link-disabled')
    // WO-1795: the sentence states facts, not a nonexistent settings switch,
    // and reports the command as not sent.
    if (!decision.allowed) {
      expect(decision.sentence).toBe(
        'The spindle link is not configured for this session, so the command was not sent.',
      )
    }
  })

  it('refuses spindle-on with a broken definition, and says how many problems', () => {
    const broken = clone(HUANYANG_GT)
    broken.verified = true
    broken.registers.setpoint.scale = 'set.rpm / (3 - 3)'
    const decision = vfdCommandGate('runCw', UP, broken)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.refusal).toBe('definition-invalid')
  })

  it('refuses spindle-on while the inverter reports a fault, but allows the reset', () => {
    const verified = { ...clone(HUANYANG_GT), verified: true }
    const faulted = { ...UP, faulted: true }
    expect(vfdCommandGate('runCw', faulted, verified).allowed).toBe(false)
    expect(vfdCommandGate('resetFault', faulted, verified).allowed).toBe(true)
    expect(vfdCommandGate('releaseReset', faulted, verified).allowed).toBe(true)
  })

  it('does not let an unverified definition block clearing a fault', () => {
    expect(vfdCommandGate('resetFault', { ...UP, faulted: true }, HUANYANG_GT).allowed).toBe(true)
  })
})

// --- 8. the spindle stops when anything goes wrong ---------------------------

describe('WO-425 anything going wrong stops the spindle', () => {
  it('does not stop while everything is up', () => {
    expect(vfdStopRequired(UP)).toEqual({ stop: false })
  })

  it('stops only after the fixed elapsed-time threshold', () => {
    expect(vfdStopRequired({ ...UP, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS }).stop).toBe(false)
    const decision = vfdStopRequired({ ...UP, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS + 1 })
    expect(decision.stop).toBe(true)
    if (decision.stop) expect(decision.reason).toBe('serial-timeout')
  })

  it('stops when the bridge socket goes away', () => {
    const decision = vfdStopRequired({ ...UP, bridgeConnected: false })
    expect(decision.stop).toBe(true)
    if (decision.stop) expect(decision.reason).toBe('bridge-socket-lost')
  })

  it('stops when LienCAM disconnects', () => {
    const decision = vfdStopRequired({ ...UP, clientConnected: false })
    expect(decision.stop).toBe(true)
    if (decision.stop) expect(decision.reason).toBe('client-disconnected')
  })

  it('stops when the link is switched off while it spins', () => {
    const decision = vfdStopRequired({ ...UP, enabled: false })
    expect(decision.stop).toBe(true)
    if (decision.stop) expect(decision.reason).toBe('link-switched-off')
    // WO-1795: the sentence states facts, not a nonexistent operator switch,
    // and does not claim physical stopping completed.
    if (decision.stop) {
      expect(decision.sentence).toBe('The spindle link is unavailable, so a spindle stop is being requested.')
    }
  })

  it('does not need a definition, and preserves the down-link stop decision', () => {
    expect(vfdStopRequired({ ...UP, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS + 1 }).stop).toBe(true)
    const down = vfdStopRequired(VFD_LINK_STATE_DOWN)
    expect(down.stop).toBe(true)
    if (down.stop) expect(down.reason).toBe('client-disconnected')
  })

  it('always gives a sentence a person can read', () => {
    for (const state of [
      { ...UP, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS + 1 },
      { ...UP, bridgeConnected: false },
      { ...UP, clientConnected: false },
      { ...UP, enabled: false },
    ]) {
      const decision = vfdStopRequired(state)
      expect(decision.stop).toBe(true)
      if (decision.stop) expect(decision.sentence.endsWith('.')).toBe(true)
    }
  })
})

// --- 9. the format refuses nonsense ------------------------------------------

describe('WO-425 the validator says what is wrong, in words', () => {
  it('catches a link that cannot exist', () => {
    const bad = clone(HUANYANG_GT)
    bad.link = { ...bad.link, slaveAddress: 0, baud: 3, timeoutMs: 0 } as VfdDefinition['link']
    const paths = validateVfdDefinition(bad).errors.map((e) => e.path)
    expect(paths).toContain('link.slaveAddress')
    expect(paths).toContain('link.baud')
    expect(paths).toContain('link.timeoutMs')
  })

  it('accepts the TCP transport the macro documents as the alternative', () => {
    const tcp = clone(HUANYANG_GT)
    tcp.link = {
      transport: 'tcp',
      host: '192.0.2.13',
      tcpPort: 503,
      slaveAddress: 1,
      pollIntervalMs: 100,
      retryCount: 3,
      timeoutMs: 25,
    }
    expect(validateVfdDefinition(tcp).errors).toEqual([])
  })

  it('catches a register address outside a 16-bit space', () => {
    const bad = clone(HUANYANG_GT)
    bad.registers.command.address = 70000
    expect(validateVfdDefinition(bad).errors.map((e) => e.path)).toContain('registers.command.address')
  })

  it('catches a function code no Modbus device speaks', () => {
    const bad = clone(HUANYANG_GT)
    bad.protocol = { ...bad.protocol, readFunction: 0x42 as never, writeFunction: 0x99 as never }
    const paths = validateVfdDefinition(bad).errors.map((e) => e.path)
    expect(paths).toContain('protocol.readFunction')
    expect(paths).toContain('protocol.writeFunction')
  })

  it('catches a reset step naming a command the table does not have', () => {
    const bad = clone(HUANYANG_GT)
    delete (bad.commands as { values: Record<string, number> }).values.releaseReset
    expect(validateVfdDefinition(bad).errors.map((e) => e.path)).toContain('resetSequence[1].command')
  })

  it('catches the same reading being decoded twice', () => {
    const bad = clone(HUANYANG_GT)
    bad.status = [
      { name: 'volts', source: 'register', offset: 0, scale: 'raw.value' },
      { name: 'volts', source: 'register', offset: 1, scale: 'raw.value' },
    ]
    expect(validateVfdDefinition(bad).errors.map((e) => e.code)).toContain('E_VFD_DUPLICATE')
  })

  it('names the format so an unrelated JSON file cannot be read as one', () => {
    expect(HUANYANG_GT.format).toBe(VFD_DEFINITION_FORMAT)
    const bad = clone(HUANYANG_GT)
    bad.format = 'liencam-probe-routines' as never
    expect(validateVfdDefinition(bad).ok).toBe(false)
  })
})
