// Smoke test for the LienCAM machine bridge: connects the way the browser
// will, and checks the protocol in docs/machine/BRIDGE-PROTOCOL.md - hello,
// call/reply, and the status/console/phase pushes. No GRBL: ADR-0041 retired
// the emulation, so any GRBL text on the wire is a failure here.
//
//   node pendant/uccnc-bridge/smoke.mjs [port] [--fake-inverter]
//   node pendant/uccnc-bridge/smoke.mjs [port] --session-ownership-only
//
// Start the bridge first (see README.md in this folder). Use --board -19.
// Pass --fake-inverter when the bridge was started with --inject-fake-inverter:
// the spindle-link phase then proves a push OPENS the link; without it, it
// proves a push onto a port that does not exist is refused and opens nothing.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const fakeInverter = process.argv.includes('--fake-inverter')
const sessionOwnershipOnly = process.argv.includes('--session-ownership-only')
const boardDistributionOnly = process.argv.includes('--board-distribution-only')
const explicitPort = process.argv.slice(2).find((a) => !a.startsWith('--'))
const port = explicitPort ?? '8325'
const url = `ws://127.0.0.1:${port}/`
const OPERATOR_DEFINITION = JSON.parse(readFileSync(
  new URL('../../docs/machine/profiles/LienCNCV2.definition.json', import.meta.url),
  'utf8',
)).definition

let pass = 0
let fail = 0
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`) }
}

if (boardDistributionOnly) {
  if (!explicitPort) {
    console.error('board distribution smoke needs an explicit free test port')
    process.exit(2)
  }
  await boardDistributionPhase()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

// Run the ownership proof against a fresh bridge process. The canonical smoke
// deliberately opens and closes several real sessions; starting this phase at
// its tail would measure the preceding owner's required panic cleanup rather
// than the desktop's clean-start readiness-probe sequence.
if (sessionOwnershipOnly) {
  await bridgeSessionOwnershipPhase()
  console.log(`\n${pass} passed, ${fail} failed`)
  await wait(300)
  process.exit(fail === 0 ? 0 : 1)
}

/** Every frame the bridge sent, in order, with arrival times. */
const frames = []
const replies = new Map()
const raw = []
let originalMachineDefinition = null

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'

ws.onmessage = (ev) => {
  const text = typeof ev.data === 'string'
    ? ev.data
    : new TextDecoder().decode(new Uint8Array(ev.data))
  raw.push(text)
  let msg
  try { msg = JSON.parse(text) } catch { frames.push({ t: '<unparseable>', text }); return }
  msg.__at = Date.now()
  frames.push(msg)
  if (msg.t === 'reply') replies.set(msg.seq, msg)
}

ws.onerror = (e) => { console.log('socket error:', e.message ?? e); process.exit(1) }

let seq = 0
async function call(m, a, timeoutMs = 2000) {
  const s = ++seq
  ws.send(JSON.stringify({ t: 'call', seq: s, m, ...(a ? { a } : {}) }))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (replies.has(s)) return replies.get(s)
    await wait(10)
  }
  return null
}

async function waitForIdleStatusAfter(frameIndex, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fresh = frames.slice(frameIndex).filter((frame) => frame.t === 'status')
    if (fresh.some((frame) => frame.v?.state === 'idle' && frame.v?.buffer?.moves === 0)) return true
    await wait(25)
  }
  return false
}

async function waitForStatusAfter(frameIndex, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.slice(frameIndex).find((frame) => frame.t === 'status' && predicate(frame.v))
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function waitForJobEventAfter(frameIndex, event, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.slice(frameIndex).find(
      (frame) => frame.t === 'jobEvent' && frame.v?.event === event,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

const unassignedPin = () => ({ port: 0, pin: 0, negate: null })
const uccncSetting = (key, kind, value) => ({ controller: 'uccnc', key, value: { kind, value } })
const axisDriveSetting = (axis, key, appPart, kind, value) => ({
  ...uccncSetting(`axessettingscontrol${axis}.${key}`, kind, value),
  appKey: `liencam.axes.${axis}.${appPart}`,
})

/** A deliberately different three-axis machine. Empty stated/settings arrays
 * are the existing app-owned declaration that its unassigned home pins are a
 * machine fact, not placeholder values. */
function switchlessDefinition() {
  const names = ['X', 'Y', 'Z']
  const axis = (name) => ({
    axis: name,
    enabled: true,
    stepsPerUnit: 400,
    maxVelocity: 6000,
    acceleration: 300,
    softLimitMin: -100,
    softLimitMax: 100,
    slaveAxis: null,
    stepPin: unassignedPin(),
    dirPin: unassignedPin(),
    homePin: unassignedPin(),
    limitMinusPin: unassignedPin(),
    limitPlusPin: unassignedPin(),
    enablePin: unassignedPin(),
    enableDelayMs: 0,
    backlash: { enabled: false, distance: 0 },
  })
  const homing = (direction) => ({
    direction,
    fastSpeed: 1500,
    slowSpeed: 375,
    backOff: 0,
    homingValue: 0,
    autoZero: true,
  })
  return {
    axes: names.map(axis),
    homing: {
      order: ['Z', 'X', 'Y'],
      perAxis: { X: homing('negative'), Y: homing('negative'), Z: homing('positive') },
    },
    io: { estop: unassignedPin(), probe: unassignedPin(), probe2: unassignedPin() },
    settings: [
      uccncSetting('Generalsettings.Constantvelocitymode', 'boolean', true),
      uccncSetting('Generalsettings.Cornerserror', 'number', 0.05),
      uccncSetting('Generalsettings.Softlimitsenable', 'boolean', false),
    ],
    // The settings array is no longer empty now that this hand-built machine
    // states trajectory values. State the zero home wires explicitly too, so
    // the definition still says these axes genuinely have no home switches.
    stated: names.flatMap((name) => [
      { controller: 'uccnc', key: `axessettingscontrol${name}.Homeportnumber` },
      { controller: 'uccnc', key: `axessettingscontrol${name}.Homepinnumber` },
    ]),
  }
}

/** A deliberately different independent rotary machine. Basing it on the
 * switchless definition keeps desk motion finite: the demo controller never
 * completes a physical homing cycle, so this fixture states no switches.
 * By default it also states no rotary soft-limit range: that is the ordinary
 * locally-authored definition before an operator supplies those machine facts.
 */
function rotaryDefinition(softLimits = null) {
  const definition = switchlessDefinition()
  const importedA = OPERATOR_DEFINITION?.axes?.find((axis) => axis.axis === 'A')
  const a = structuredClone(importedA ?? definition.axes[0])
  a.axis = 'A'
  a.enabled = true
  delete a.softLimitMin
  delete a.softLimitMax
  if (softLimits) {
    a.softLimitMin = softLimits.min
    a.softLimitMax = softLimits.max
  }
  a.slaveAxis = null
  a.homePin = unassignedPin()
  a.limitMinusPin = unassignedPin()
  a.limitPlusPin = unassignedPin()
  definition.axes.push(a)
  definition.homing.order.push('A')
  definition.homing.perAxis.A = {
    direction: 'negative',
    fastSpeed: 1500,
    slowSpeed: 375,
    backOff: 0,
    homingValue: 0,
    autoZero: true,
  }
  definition.stated.push(
    { controller: 'uccnc', key: 'axessettingscontrolA.Homeportnumber' },
    { controller: 'uccnc', key: 'axessettingscontrolA.Homepinnumber' },
  )
  definition.settings.push(
    axisDriveSetting('A', 'Currhilowportnumber', 'currentHiLow.port', 'number', 1),
    axisDriveSetting('A', 'Currhilowpinnumber', 'currentHiLow.pin', 'number', 10),
    axisDriveSetting('A', 'Currhilowpinnegate', 'currentHiLow.negate', 'boolean', true),
    axisDriveSetting('A', 'Rotaryaxis', 'rotary', 'boolean', true),
    axisDriveSetting('A', 'Rotaryrollover', 'rotaryRollover', 'boolean', true),
  )
  return definition
}

function withoutAxisDriveSettings(definition, axis) {
  const prefix = `liencam.axes.${axis}.`
  return {
    ...structuredClone(definition),
    settings: (definition.settings ?? []).filter((row) => !row.appKey?.startsWith(prefix)),
  }
}

function withUccncSettings(definition, replacements) {
  const keys = new Set(replacements.map((row) => row.key))
  return {
    ...definition,
    settings: [
      ...(definition.settings ?? []).filter((row) => !keys.has(row.key)),
      ...replacements,
    ],
  }
}

// WO-1729: the committed definition capture predates these neutral fields.
// State them in the desk fixture instead of letting the bridge fall back to
// archived FaultSignals/Chargepump aliases (which are not runtime authority).
function withDriveSignals(definition, driveFaultInputs, chargePump) {
  return {
    ...structuredClone(definition),
    driveFaultInputs,
    chargePump,
  }
}

// ---- WO-1724: the bridge drives a board spindle ---------------------------
//
// A deliberately different machine: the operator's axes, plus a PWM speed output and
// M3/M4 spindle relays stated in the definition's own outputs list - pins his
// machine does not use. Every assertion reads the board's own answer: the
// spindle setting GetSpindleSetting returns, Stat.SpindleOn/SpindleDir, the
// speed GetSpindleSpeed returns and each relay's GetOutput level.
const WO1724_PWM_OUT = { port: 3, pin: 17, negate: false }
const WO1724_M3 = { port: 3, pin: 2, negate: false }
const WO1724_M4 = { port: 3, pin: 5, negate: false }
const WO1724_PWM_DRIVE = {
  kind: 'board-speed', signal: 'pwm', output: WO1724_PWM_OUT, frequencyHz: 1000,
  minimumRpm: 6000, maximumRpm: 24000, minimumPercent: 10, maximumPercent: 100,
}

function withSpindleRelays(definition, relays) {
  return {
    ...structuredClone(definition),
    outputs: relays.map(([word, pin]) => ({
      name: `${word} spindle relay`, onCode: word, offCode: 'M5', pin, besideWord: true,
    })),
  }
}

async function boardSpindlePhase(baseDefinition) {
  const applied = await call('applyMachineDefinition',
    { definition: withSpindleRelays(baseDefinition, [['M3', WO1724_M3], ['M4', WO1724_M4]]) }, 15_000)
  check('WO-1724: a definition stating M3/M4 spindle relays applies',
    applied?.ok === true && applied.v?.ok === true, JSON.stringify(applied?.v?.error ?? applied))
  const live = await call('setOutputInhibit', { on: false })
  check('  outputs enabled for the spindle phase', live?.ok === true, JSON.stringify(live))
  const pwmPin = await call('getOutput', WO1724_PWM_OUT)

  const pwmOn = await call('spindleOn', { direction: 'cw', rpm: 12000, drive: WO1724_PWM_DRIVE })
  const set = pwmOn?.v?.setting
  check('WO-1724 PWM: spindle on at 12000 puts the definition PWM setting on the board',
    pwmOn?.ok === true && set?.mode === 1 && set.spPin === pwmPin?.v?.ucPin && set.spPinNeg === false
      && set.pwmFreq === 1000 && set.minRpm === 6000 && set.maxRpm === 24000
      && set.minPercent === 10 && set.maxPercent === 100,
    JSON.stringify(pwmOn))
  check('  the board reads back on, clockwise, at 12000, with the M3 relay on and M4 off',
    pwmOn?.v?.on === true && pwmOn.v.ccw === false && pwmOn.v.speed === 12000
      && pwmOn.v.m3Relay?.on === true && pwmOn.v.m4Relay?.on === false,
    JSON.stringify(pwmOn?.v))
  const pwmOff = await call('spindleOff')
  check('WO-1724 PWM: stop clears it - the board reads back off and both relays off',
    pwmOff?.ok === true && pwmOff.v?.on === false
      && pwmOff.v.m3Relay?.on === false && pwmOff.v.m4Relay?.on === false,
    JSON.stringify(pwmOff))

  const reverse = await call('spindleOn', { direction: 'ccw', rpm: 9000, drive: WO1724_PWM_DRIVE })
  check('WO-1724 PWM: counter-clockwise switches M4, not M3',
    reverse?.ok === true && reverse.v?.on === true && reverse.v.ccw === true && reverse.v.speed === 9000
      && reverse.v.m3Relay?.on === false && reverse.v.m4Relay?.on === true,
    JSON.stringify(reverse?.v ?? reverse))
  await call('spindleOff')

  const relayOn = await call('spindleOn', { direction: 'cw', rpm: 12000, drive: { kind: 'relay' } })
  check('WO-1724 relay: a relay drive switches its M3 output and puts no speed output on the board',
    relayOn?.ok === true && relayOn.v?.setting?.mode === 0 && relayOn.v.setting.spPin === 0
      && relayOn.v.m3Relay?.on === true && relayOn.v.m4Relay?.on === false,
    JSON.stringify(relayOn?.v ?? relayOn))
  const relayOff = await call('spindleOff')
  check('WO-1724 relay: stop switches the relay off',
    relayOff?.ok === true && relayOff.v?.m3Relay?.on === false && relayOff.v.m4Relay?.on === false,
    JSON.stringify(relayOff))

  const unstated = await call('spindleOn', {
    direction: 'cw', rpm: 12000, drive: { ...WO1724_PWM_DRIVE, frequencyHz: null, maximumRpm: null },
  })
  check('WO-1724: a mapping the definition left unstated is named, not defaulted',
    unstated?.ok === false && /frequencyHz, maximumRpm/.test(unstated.error ?? ''), JSON.stringify(unstated))

  const inhibit = await call('setOutputInhibit', { on: true })
  const offInhibited = await call('spindleOff')
  check('WO-1724: stop is accepted with the outputs inhibited (never gated)',
    inhibit?.ok === true && offInhibited?.ok === true, JSON.stringify(offInhibited))

  const restored = await call('applyMachineDefinition', { definition: baseDefinition }, 15_000)
  check('WO-1724 restores the canonical desk fixture (no spindle relays)',
    restored?.ok === true && restored.v?.ok === true, JSON.stringify(restored?.v?.error ?? restored))
  const noDrive = await call('spindleOn', { direction: 'cw', setpointWord: 1000 })
  check('WO-1724: with no drive on the call, spindleOn is the unchanged VFD path',
    noDrive?.ok === false && /no spindle link/i.test(noDrive.error ?? ''), JSON.stringify(noDrive))
}

/** A definition created in LienCAM rather than imported from a .pro. An
 * ordinary travel edit adds a liencam.* row to `stated`; that row must not
 * turn the definition's other named fields into profile placeholders. */
function locallyAuthoredDefinitionWithStatedRow() {
  const definition = switchlessDefinition()
  const axis = definition.axes[0]
  axis.stepsPerUnit = 80
  axis.maxVelocity = 1000
  axis.acceleration = 200
  const homing = definition.homing.perAxis[axis.axis]
  homing.direction = 'positive'
  homing.fastSpeed = 250
  homing.slowSpeed = 62.5
  definition.stated = [{
    controller: 'uccnc',
    key: `liencam.axes.${axis.axis}.softLimitMin`,
  }]
  return definition
}

/** The second WO-1747 machine: shaped like an imported profile whose axis
 * sections omit the six values the old bridge replaced with LienCNC-shaped
 * defaults. The named fields retain deliberately different editor values;
 * removing their provenance is what says the profile did not state them. */
function trimmedProfileDefinition(definition) {
  const trimmed = structuredClone(definition)
  const omitted = new Set()
  for (const axis of trimmed.axes ?? []) {
    const section = `axessettingscontrol${axis.axis}`
    for (const key of [
      'Stepsperunit', 'Velocity', 'Acceleration',
      'Homedirectionpositive', 'Homingspeedup', 'Homingspeeddown',
    ]) omitted.add(`${section}.${key}`.toLowerCase())
    axis.stepsPerUnit += 17
    axis.maxVelocity += 23
    axis.acceleration += 31
    const homing = trimmed.homing?.perAxis?.[axis.axis]
    if (homing) {
      homing.direction = homing.direction === 'positive' ? 'negative' : 'positive'
      homing.fastSpeed += 37
      homing.slowSpeed += 41
    }
  }
  const keep = (row) => row?.controller?.toLowerCase() !== 'uccnc'
    || !omitted.has(row?.key?.toLowerCase())
  trimmed.stated = (trimmed.stated ?? []).filter(keep)
  trimmed.settings = (trimmed.settings ?? []).filter(keep)
  return trimmed
}

ws.onopen = async () => {
  console.log(`connected to ${url}\n`)
  await wait(300)

  // ---- hello -----------------------------------------------------------
  const hello = frames[0]
  check('the FIRST frame is hello', hello && hello.t === 'hello', hello && hello.t)
  let vfdHello = null
  if (hello && hello.v) {
    const v = hello.v
    originalMachineDefinition = v.definition ?? null
    console.log(`        ${JSON.stringify(v)}`)
    check('  protocol is 1', v.protocol === 1, String(v.protocol))
    check('  names the bridge build', typeof v.bridge === 'string' && v.bridge.length > 0, v.bridge)
    // readOnly was CLEARED on 2026-08-21 (8d4489a9) once the machine moved
    // under this pin translation, which is the gate's own documented exit
    // condition. The flag still exists and a read-only build is still a
    // supported mode, so assert the SHAPE here and branch the gate checks
    // below on it - asserting `true` outright is how this harness came to
    // carry 8 dead assertions against a build that had moved on.
    check('  readOnly is a boolean the build declares', typeof v.readOnly === 'boolean', String(v.readOnly))
    console.log(`        build mode: ${v.readOnly ? 'READ ONLY' : 'MOTION ENABLED'}`)
    const c = v.capabilities ?? {}
    check('  capabilities.geometryQueue', c.geometryQueue === true)
    check('  capabilities.executingMoveId', c.executingMoveId === true)
    check('  capabilities.bufferSeconds', c.bufferSeconds === true)
    check('  capabilities.outputInhibit', c.outputInhibit === true)
    check('  capabilities.gcodeText is FALSE (no G-code interpreter; loadMoves only)',
      c.gcodeText === false)
    check('  capabilities.perAxisHoming', c.perAxisHoming === true)
    check('  capabilities.ownsSpindle is FALSE (Modbus VFD, separate link)',
      c.ownsSpindle === false, String(c.ownsSpindle))

    // ---- WO-427 / WO-1719: hello.vfd -----------------------------------
    // The bridge reads no inverter definition of its own any more, so a
    // freshly started bridge holds NO spindle link until LienCAM pushes one.
    vfdHello = v.vfd
    check('  hello carries a vfd block', !!vfdHello, JSON.stringify(vfdHello))
    if (vfdHello) {
      check('  vfd.present is a boolean', typeof vfdHello.present === 'boolean', JSON.stringify(vfdHello))
      check('  vfd.verified is a boolean', typeof vfdHello.verified === 'boolean', JSON.stringify(vfdHello))
      check('  no push yet: vfd.present is false', vfdHello.present === false, String(vfdHello.present))
      check('  no push yet: vfd.name and vfd.definition are null',
        vfdHello.name === null && vfdHello.definition === null, JSON.stringify(vfdHello))
    }
  }

  const phase = frames.find((f) => f.t === 'phase')
  check('a phase push announces the connection',
    !!phase && phase.v?.phase === 'connected', JSON.stringify(phase?.v))
  if (phase) console.log(`        version: ${phase.v.version}`)

  // ---- call / reply round trip ------------------------------------------
  const fw = await call('firmwareVersion')
  check('call/reply round trip: firmwareVersion',
    !!fw && fw.t === 'reply' && fw.ok === true && fw.seq === seq, JSON.stringify(fw))
  check('  the reply carries the return value in v', !!fw && typeof fw.v !== 'undefined')

  const voidReply = await call('queryStatus')
  check('a void method still gets a reply, with no v',
    !!voidReply && voidReply.ok === true && !('v' in voidReply), JSON.stringify(voidReply))

  const unknown = await call('thisMethodDoesNotExist')
  check('an unknown method fails with a plain sentence',
    !!unknown && unknown.ok === false && typeof unknown.error === 'string'
      && unknown.error.length > 10, JSON.stringify(unknown))
  if (unknown) console.log(`        ${unknown.error}`)

  // ---- status pushes -----------------------------------------------------
  const before = frames.filter((f) => f.t === 'status').length
  await wait(900)
  const pushes = frames.filter((f) => f.t === 'status')
  check('status pushes arrive unsolicited', pushes.length > before, `${pushes.length} in total`)
  const gaps = []
  for (let i = 1; i < pushes.length; i++) gaps.push(pushes[i].__at - pushes[i - 1].__at)
  const worst = gaps.length ? Math.max(...gaps) : Infinity
  // Idle cadence is "at least every 500 ms"; allow slack for the poll interval
  // and for node's timer resolution.
  check('  idle cadence is at least every 500 ms', worst <= 700, `worst gap ${worst} ms`)

  const st = pushes[pushes.length - 1]?.v
  check('a status push carries MachineStatus', !!st)
  if (st) {
    console.log(`        ${JSON.stringify(st)}`)
    const keys = ['state', 'subState', 'machinePos', 'workPos', 'feedMmMin', 'spindleRpm',
      'overrides', 'executingMoveId', 'buffer', 'inputs', 'homed']
    check('  carries every MachineStatus field',
      keys.every((k) => k in st), keys.filter((k) => !(k in st)).join(','))
    check('  state is a MachineState word',
      ['unknown', 'idle', 'run', 'hold', 'jog', 'alarm', 'door', 'check', 'home', 'sleep']
        .includes(st.state), st.state)
    check('  machinePos is x/y/z',
      st.machinePos && ['x', 'y', 'z'].every((k) => typeof st.machinePos[k] === 'number'))
    check('  workPos is x/y/z',
      st.workPos && ['x', 'y', 'z'].every((k) => typeof st.workPos[k] === 'number'))
    check("  the operator's slaved A does not change the three-axis position frames",
      st.machinePos && st.workPos
        && !['a', 'b', 'c'].some((axis) => axis in st.machinePos || axis in st.workPos),
      JSON.stringify({ machinePos: st.machinePos, workPos: st.workPos }))
    check('  feedMmMin is a number (mm/min, not units/sec)', typeof st.feedMmMin === 'number')
    check('  overrides carries feed/spindle as numbers',
      st.overrides && ['feed', 'spindle'].every((k) => typeof st.overrides[k] === 'number'))
    check('  overrides.rapid is NULL - this controller has no rapid override',
      st.overrides && st.overrides.rapid === null, JSON.stringify(st.overrides))
    check('  buffer.moves is a count', st.buffer && typeof st.buffer.moves === 'number')
    check('  buffer.capacitySeconds is known (TrajParam.USBPufferSize)',
      st.buffer && typeof st.buffer.capacitySeconds === 'number', JSON.stringify(st.buffer))
    check('  inputs decoded, not protocol letters',
      st.inputs && ['estop', 'hardLimit', 'softLimit', 'probe']
        .every((k) => typeof st.inputs[k] === 'boolean'))
    check('  homed is tracked per axis',
      st.homed && ['X', 'Y', 'Z'].every((k) => typeof st.homed[k] === 'boolean'))
    check("  the operator's slaved A does not grow an independent homed field",
      st.homed && !['A', 'B', 'C'].some((axis) => axis in st.homed), JSON.stringify(st.homed))

    // Absent data is null, NEVER a substituted number.
    check('  NULL: spindleRpm (the spindle is not on this controller)',
      st.spindleRpm === null, JSON.stringify(st.spindleRpm))
    check('  NULL: subState (this controller has no Hold:0/Hold:1 sub-code)',
      st.subState === null, JSON.stringify(st.subState))
    check('  NULL: executingMoveId until the connect sentinel has been passed',
      st.executingMoveId === null, JSON.stringify(st.executingMoveId))
  }

  // ---- the safety gates --------------------------------------------------
  // A read-only build refuses every motion call outright. A motion-enabled
  // build refuses on the gates that actually protect the machine, and those
  // are the ones worth testing - all three were defects found on hardware
  // 2026-08-21/22 and each cost a session to find.
  const readOnlyBuild = frames[0]?.v?.readOnly === true

  if (readOnlyBuild) {
    for (const [m, a] of [
      ['jog', { axis: 'X', deltaMm: 5, feedMmMin: 1200 }],
      ['homeAxes', { axes: ['Z'] }],
      ['startJob', undefined],
      ['cycleResume', undefined],
    ]) {
      const r = await call(m, a)
      check(`motion call REFUSED while readOnly: ${m}`,
        !!r && r.ok === false && typeof r.error === 'string' && /read only/i.test(r.error),
        JSON.stringify(r))
    }
  } else {
    // GATE 1 - homing with the outputs inhibited starts a cycle that can
    // never finish and leaves the BOARD in a homing state, so the next
    // output-enable starts an axis with no command. Refused up front.
    const inhibited = await call('setOutputInhibit', { on: true })
    check('output inhibit is enabled for the homing gate check',
      !!inhibited && inhibited.ok === true, JSON.stringify(inhibited))
    const homeInhibited = await call('homeAxes', { axes: ['Z'] })
    check('homing is REFUSED while the outputs are inhibited',
      !!homeInhibited && homeInhibited.ok === false && /inhibited/i.test(homeInhibited.error ?? ''),
      JSON.stringify(homeInhibited))
    const outputsLive = await call('setOutputInhibit', { on: false })
    check('outputs are restored after the homing gate check',
      !!outputsLive && outputsLive.ok === true, JSON.stringify(outputsLive))

    // GATE 2 - the counter resets to 0 on Open and means nothing until the
    // machine is homed. An ABSOLUTE move against it ran the machine from a
    // position it never held.
    // The refusal shape here is NOT a failed reply: Bridge.Report pushes the
    // sentence on the console channel and the call returns false. Both halves
    // matter - a false with no sentence would be a silent refusal, which is
    // the thing this project keeps finding and fixing.
    const beforeAbs = frames.length
    const absZ = await call('jogToMachineZ', { z: -5, feedMmMin: 300 })
    check('an absolute move is REFUSED before homing',
      !!absZ && absZ.ok === true && absZ.v === false, JSON.stringify(absZ))
    const said = frames.slice(beforeAbs).some(
      (f) => f.t === 'console' && /homed/i.test(f.v?.text ?? '') && f.v?.severity === 'error')
    check('  ...and says why on the console rather than refusing silently', said,
      JSON.stringify(frames.slice(beforeAbs).filter((f) => f.t === 'console')))

    // A RELATIVE jog carries no such claim, so it is allowed - the demo
    // board cannot move anything either way.
    const beforeRel = frames.length
    const rel = await call('jog', { axis: 'X', deltaMm: 1, feedMmMin: 600 })
    check('a relative jog is accepted on a motion-enabled build',
      !!rel && rel.ok === true, JSON.stringify(rel))
    check('  and the demo controller returns idle before the program checks',
      await waitForIdleStatusAfter(beforeRel))
  }

  // Loading geometry is bookkeeping in the bridge and must still work, so the
  // browser can stage a program a later build will be allowed to run.
  const load = await call('loadMoves', {
    frame: 'work',
    moves: [
      { id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 600 },
      { id: 2, kind: 'dwell', seconds: 0.25 },
      { id: 3, kind: 'marker' },
    ],
  })
  check('loadMoves stages a program without touching the controller',
    !!load && load.ok === true && load.v?.ok === true, JSON.stringify(load))
  const started = await call('startJob')
  check('  but startJob is still refused',
    !!started && started.ok === false, JSON.stringify(started))
  // GATE 3, and it is the reason: a staged program is refused because the
  // machine has never been homed, not merely because something said no.
  if (!readOnlyBuild) {
    check('  ...and the refusal names the reason: not homed',
      /homed/i.test(started?.error ?? ''), started?.error)

    // WO-1722: the same bridge, with a definition that explicitly has no home
    // switches, has no impossible home-cycle prerequisite. Stop clears the
    // first staged control program so the definition can be applied.
    const cleared = await call('stopJob')
    check('WO-1722 setup clears the switched control program',
      !!cleared && cleared.ok === true, JSON.stringify(cleared))
    const beforeSwitchlessApply = frames.length
    const appliedSwitchless = await call(
      'applyMachineDefinition',
      { definition: rotaryDefinition() },
      15_000,
    )
    check('WO-1722 applies and reads back the switchless definition',
      !!appliedSwitchless && appliedSwitchless.ok === true && appliedSwitchless.v?.ok === true,
      JSON.stringify(appliedSwitchless))
    const switchlessApplyFrames = frames.slice(beforeSwitchlessApply)
    check('WO-1727 hand-built trajectory is applied and read back from its definition',
      switchlessApplyFrames.some((f) => f.t === 'console'
        && /trajectory applied and read back/.test(f.v?.text ?? '')
        && /constantVelocity=True/.test(f.v?.text ?? '')
        && /cornerError=0.05/.test(f.v?.text ?? '')),
      JSON.stringify(switchlessApplyFrames.filter((f) => f.t === 'console')))
    check('WO-1727 hand-built soft-limit enable is applied OFF and read back',
      switchlessApplyFrames.some((f) => f.t === 'console'
        && /soft-limit enable applied and read back: enabled=False/.test(f.v?.text ?? '')),
      JSON.stringify(switchlessApplyFrames.filter((f) => f.t === 'console')))
    check('WO-1728 hand-built A drive settings are applied from the pushed definition',
      switchlessApplyFrames.some((f) => f.t === 'console'
        && /axis A applied and read back:/.test(f.v?.text ?? '')
        && /currentHiLowPin=21/.test(f.v?.text ?? '')
        && /currentHiLowPinNeg=True/.test(f.v?.text ?? '')
        && /rotaryAxis=True/.test(f.v?.text ?? '')
        && /rotaryRollover=True/.test(f.v?.text ?? '')),
      JSON.stringify(switchlessApplyFrames.filter((f) => f.t === 'console')))

    const beforeInheritedDrive = frames.length
    const inheritedDrive = await call(
      'applyMachineDefinition',
      { definition: withoutAxisDriveSettings(rotaryDefinition(), 'A') },
      15_000,
    )
    check('WO-1728 an absent A drive setting inherits instead of clearing',
      !!inheritedDrive && inheritedDrive.ok === true && inheritedDrive.v?.ok === true,
      JSON.stringify(inheritedDrive))
    const inheritedDriveFrames = frames.slice(beforeInheritedDrive)
    check('  inherited readback keeps the previously defined true/pin values',
      inheritedDriveFrames.some((f) => f.t === 'console'
        && /axis A applied and read back:/.test(f.v?.text ?? '')
        && /currentHiLowPin=21/.test(f.v?.text ?? '')
        && /currentHiLowPinNeg=True/.test(f.v?.text ?? '')
        && /rotaryAxis=True/.test(f.v?.text ?? '')
        && /rotaryRollover=True/.test(f.v?.text ?? '')),
      JSON.stringify(inheritedDriveFrames.filter((f) => f.t === 'console')))
    const switchlessHomed = await call('homedThisSession')
    check('  switchless definition does not invent a machine datum',
      !!switchlessHomed && switchlessHomed.ok === true && switchlessHomed.v === false,
      JSON.stringify(switchlessHomed))

    const rotaryOffset = await call('setWorkOffset', { wcs: 'G54', a: 15 })
    check('WO-1726 sets G54 A through the bridge and echoes the canonical row',
      !!rotaryOffset && rotaryOffset.ok === true && rotaryOffset.v?.ok === true
        && rotaryOffset.v?.offset?.a === 15,
      JSON.stringify(rotaryOffset))

    const switchlessLoad = await call('loadMoves', {
      frame: 'work',
      moves: [{ id: 1726, kind: 'line', to: { x: 10, a: 90 }, feedMmMin: 6000 }],
    })
    check('WO-1726 stages G1 X10 A90 without a homing cycle on the switchless definition',
      !!switchlessLoad && switchlessLoad.ok === true && switchlessLoad.v?.ok === true,
      JSON.stringify(switchlessLoad))
    const beforeSwitchlessStart = frames.length
    const switchlessStart = await call('startJob')
    check('  switchless StartJob is accepted without a homing cycle',
      !!switchlessStart && switchlessStart.ok === true && switchlessStart.v === true,
      JSON.stringify(switchlessStart))

    check('  rotary program completes on the demo controller',
      !!(await waitForJobEventAfter(beforeSwitchlessStart, 'completed', 10_000)))
    const rotaryStatus = await waitForStatusAfter(
      beforeSwitchlessStart,
      (status) => status?.state === 'idle' && status?.machinePos?.a === 105,
      2_000,
    )
    check('  status readback observes the work-frame rotary endpoint',
      rotaryStatus?.machinePos?.a === 105 && rotaryStatus?.workPos?.a === 90,
      JSON.stringify(rotaryStatus))

    const beforeRotaryJog = frames.length
    const rotaryJog = await call('jog', { axis: 'A', deltaMm: 5, feedMmMin: 6000 })
    check('  A jog is accepted through the same axis-index path as XYZ',
      !!rotaryJog && rotaryJog.ok === true && rotaryJog.v === true,
      JSON.stringify(rotaryJog))
    const joggedStatus = await waitForStatusAfter(
      beforeRotaryJog,
      (status) => status?.state === 'idle' && status?.machinePos?.a === 110,
      3_000,
    )
    check('  A jog settles on the demo controller', !!joggedStatus)
    check('  A jog readback advances A without shifting its WCS index',
      joggedStatus?.machinePos?.a === 110 && joggedStatus?.workPos?.a === 95,
      JSON.stringify(joggedStatus))

    const rotaryZero = await call('zeroWorkAxis', { axis: 'A' })
    check('  A zero receipt carries the actual A offset',
      !!rotaryZero && rotaryZero.ok === true && rotaryZero.v?.ok === true
        && rotaryZero.v?.offset?.a === 110,
      JSON.stringify(rotaryZero))
    const beforeSwitchlessGoto = frames.length
    const switchlessGoto = await call('jogToWorkXY', {
      x: joggedStatus?.workPos?.x ?? 0,
      y: joggedStatus?.workPos?.y ?? 0,
      feedMmMin: 300,
    })
    check('  switchless go-to-coordinate is accepted without a homing cycle',
      !!switchlessGoto && switchlessGoto.ok === true && switchlessGoto.v === true,
      JSON.stringify(switchlessGoto))
    check('  switchless go-to-coordinate settles before restoring the control definition',
      await waitForIdleStatusAfter(beforeSwitchlessGoto))

    const boundedRotary = await call(
      'applyMachineDefinition',
      { definition: rotaryDefinition({ min: -180, max: 180 }) },
      15_000,
    )
    check('  a stated rotary soft-limit range is applied and read back',
      !!boundedRotary && boundedRotary.ok === true && boundedRotary.v?.ok === true,
      JSON.stringify(boundedRotary))
    const outsideRotary = await call('loadMoves', {
      frame: 'machine',
      moves: [{ id: 1727, kind: 'line', to: { a: 181 }, feedMmMin: 6000 }],
    })
    check('  a stated rotary soft-limit range still refuses an outside endpoint',
      !!outsideRotary && (outsideRotary.ok === false || outsideRotary.v?.ok === false)
        && /outside its soft limits -180\.\.180/.test(
          outsideRotary.error ?? outsideRotary.v?.error ?? outsideRotary.v?.reason ?? '',
        ),
      JSON.stringify(outsideRotary))

    // The shared desk cache may contain deliberate All Settings edits from an
    // earlier smoke. Build the the operator-import case with the values his committed
    // LienCNCV2.pro supplies, using the same typed definition fields.
    const importedMachineDefinition = OPERATOR_DEFINITION
      ? withUccncSettings(OPERATOR_DEFINITION, [
          uccncSetting('Generalsettings.Constantvelocitymode', 'boolean', true),
          uccncSetting('Generalsettings.Stopatangle', 'number', 89),
          uccncSetting('Generalsettings.Linearerror', 'number', 0.03),
          uccncSetting('Generalsettings.Cornerserror', 'number', 0.03),
          uccncSetting('Generalsettings.Softlimitsenable', 'boolean', true),
        ])
      : null
    const beforeRestore = frames.length
    const restored = importedMachineDefinition
      ? await call('applyMachineDefinition', { definition: importedMachineDefinition }, 15_000)
      : null
    check('  the imported switched definition is restored after the switchless smoke',
      !!restored && restored.ok === true && restored.v?.ok === true,
      JSON.stringify(restored))
    const restoredFrames = frames.slice(beforeRestore)
    check('WO-1727 imported trajectory is applied and read back unchanged',
      restoredFrames.some((f) => f.t === 'console'
        && (f.v?.text ?? '').includes('trajectory applied and read back: constantVelocity=True'
          + ' stopAngle=89 linearError=0.03 cornerError=0.03')),
      JSON.stringify(restoredFrames.filter((f) => f.t === 'console')))
    check('WO-1727 imported soft-limit enable is applied and read back unchanged',
      restoredFrames.some((f) => f.t === 'console'
        && (f.v?.text ?? '').includes('soft-limit enable applied and read back: enabled=True')),
      JSON.stringify(restoredFrames.filter((f) => f.t === 'console')))
    check("WO-1728 the operator's imported false/zero drive settings clear the authored A values",
      restoredFrames.some((f) => f.t === 'console'
        && /axis A applied and read back:/.test(f.v?.text ?? '')
        && /currentHiLowPin=0/.test(f.v?.text ?? '')
        && /currentHiLowPinNeg=False/.test(f.v?.text ?? '')
        && /rotaryAxis=False/.test(f.v?.text ?? '')
        && /rotaryRollover=False/.test(f.v?.text ?? '')),
      JSON.stringify(restoredFrames.filter((f) => f.t === 'console')))
    check("  the operator's Y-following-A gantry is unchanged by the drive-setting apply",
      restoredFrames.some((f) => f.t === 'console'
        && /axis Y applied and read back:/.test(f.v?.text ?? '')
        && /slave=A/.test(f.v?.text ?? '')),
      JSON.stringify(restoredFrames.filter((f) => f.t === 'console')))


    const operatorAxis = importedMachineDefinition?.axes?.[0]
    const operatorHoming = importedMachineDefinition?.homing?.perAxis?.[operatorAxis?.axis]
    const sourceRows = importedMachineDefinition?.stated ?? []
    check("WO-1747 the operator's imported definition states the six axis motion and homing values",
      !!operatorAxis && !!operatorHoming && [
        'Stepsperunit', 'Velocity', 'Acceleration',
        'Homedirectionpositive', 'Homingspeedup', 'Homingspeeddown',
      ].every((key) => sourceRows.some((row) => row.controller === 'uccnc'
        && row.key.toLowerCase() === `axessettingscontrol${operatorAxis.axis}.${key}`.toLowerCase())),
      JSON.stringify({ axis: operatorAxis, homing: operatorHoming }))

    const trimmed = importedMachineDefinition
      ? trimmedProfileDefinition(importedMachineDefinition)
      : null
    const trimmedApply = trimmed
      ? await call('applyMachineDefinition', { definition: trimmed }, 15_000)
      : null
    check('WO-1747 trimmed imported definition applies without inventing omitted values',
      !!trimmedApply && trimmedApply.ok === true && trimmedApply.v?.ok === true,
      JSON.stringify(trimmedApply))
    const keptLine = trimmedApply?.v?.lines?.find((line) =>
      line.text?.includes(`axis ${operatorAxis?.axis} not stated by this machine:`))?.text ?? ''
    check('  bridge reports every omitted value as not stated and not applied',
      ['stepsPerUnit', 'maxVelocity', 'acceleration', 'homing.direction',
        'homing.fastSpeed', 'homing.slowSpeed'].every((field) => keptLine.includes(field))
        && keptLine.includes('no definition value was applied for them'), keptLine)
    check("  board and bridge keep the operator's stated values instead of the trimmed editor defaults",
      !!operatorAxis && !!operatorHoming
        && keptLine.includes(`Kept stepsPerUnit=${operatorAxis.stepsPerUnit}`)
        && keptLine.includes(`maxVelocity=${operatorAxis.maxVelocity}`)
        && keptLine.includes(`acceleration=${operatorAxis.acceleration}`)
        && keptLine.includes(`homing.direction=${operatorHoming.direction}`)
        && keptLine.includes(`homing.fastSpeed=${operatorHoming.fastSpeed}`)
        && keptLine.includes(`homing.slowSpeed=${operatorHoming.slowSpeed}`), keptLine)

    const authored = locallyAuthoredDefinitionWithStatedRow()
    const authoredAxis = authored.axes[0]
    const authoredHoming = authored.homing.perAxis[authoredAxis.axis]
    check('WO-1747 local definition carries a non-empty liencam.* stated row',
      authored.stated.length > 0
        && authored.stated.every((row) => row.key.startsWith('liencam.')),
      JSON.stringify(authored.stated))
    const authoredApply = await call(
      'applyMachineDefinition',
      { definition: authored },
      15_000,
    )
    check('  locally authored definition applies with its named fields authoritative',
      !!authoredApply && authoredApply.ok === true && authoredApply.v?.ok === true,
      JSON.stringify(authoredApply))
    const authoredLines = authoredApply?.v?.lines ?? []
    const authoredReadback = authoredLines.find((line) =>
      line.text?.includes(`axis ${authoredAxis.axis} applied and read back:`))?.text ?? ''
    check('  board reads back the three authored axis motion values',
      authoredReadback.includes(`stepsPerUnit=${authoredAxis.stepsPerUnit}`)
        && authoredReadback.includes(`maxVel=${(authoredAxis.maxVelocity / 60).toFixed(6).slice(0, -1)}`)
        && authoredReadback.includes(`acceleration=${authoredAxis.acceleration}`),
      authoredReadback)
    check('  bridge does not report the six authored fields as unstated',
      !authoredLines.some((line) =>
        line.text?.includes(`axis ${authoredAxis.axis} not stated by this machine:`)),
      JSON.stringify(authoredLines))

    // Re-applying the trimmed import makes all six retained bridge values
    // observable in one response without claiming a physical-board test.
    const authoredCarryProbe = await call(
      'applyMachineDefinition',
      { definition: trimmed },
      15_000,
    )
    const authoredKeptLine = authoredCarryProbe?.v?.lines?.find((line) =>
      line.text?.includes(`axis ${authoredAxis.axis} not stated by this machine:`))?.text ?? ''
    check('  a trimmed import observes all six locally authored values retained',
      !!authoredHoming
        && authoredKeptLine.includes(`Kept stepsPerUnit=${authoredAxis.stepsPerUnit}`)
        && authoredKeptLine.includes(`maxVelocity=${authoredAxis.maxVelocity}`)
        && authoredKeptLine.includes(`acceleration=${authoredAxis.acceleration}`)
        && authoredKeptLine.includes(`homing.direction=${authoredHoming.direction}`)
        && authoredKeptLine.includes(`homing.fastSpeed=${authoredHoming.fastSpeed}`)
        && authoredKeptLine.includes(`homing.slowSpeed=${authoredHoming.slowSpeed}`),
      authoredKeptLine)

    const finalRestore = importedMachineDefinition
      ? await call('applyMachineDefinition', { definition: importedMachineDefinition }, 15_000)
      : null
    check("  the operator's complete imported definition is restored after the trimmed-profile smoke",
      !!finalRestore && finalRestore.ok === true && finalRestore.v?.ok === true,
      JSON.stringify(finalRestore))

    // Run this after every motion assertion: the demo input word is zero, so
    // the operator's real active-low fault is truthfully asserted and may latch Stop.
    // Nothing after this block depends on an unlatched motion state.
    const operatorDriveSignals = importedMachineDefinition
      ? withDriveSignals(
          importedMachineDefinition,
          [{ port: 3, pin: 13, negate: true }],
          { enabled: false },
        )
      : null
    const beforeOperatorDriveSignals = frames.length
    const operatorDriveApply = operatorDriveSignals
      ? await call('applyMachineDefinition', { definition: operatorDriveSignals }, 15_000)
      : null
    const operatorDriveLines = operatorDriveApply?.v?.lines ?? []
    check("WO-1729 applies the operator's imported active-low drive-fault input through the board table",
      !!operatorDriveApply && operatorDriveApply.ok === true && operatorDriveApply.v?.ok === true
        && operatorDriveLines.some((line) => /drive fault input 1 applied: UCpin 10 .*active low/.test(line.text ?? '')),
      JSON.stringify(operatorDriveApply))
    check("WO-1729 explicitly turns the operator's charge pump off and reads the board setting back",
      operatorDriveLines.some((line) => /charge pump applied and read back: enabled=False primary UC pin=0 negate=False/.test(line.text ?? '')),
      JSON.stringify(operatorDriveLines))
    const operatorDriveStatus = await waitForStatusAfter(
      beforeOperatorDriveSignals,
      (status) => status?.driveFault?.configured === true
        && status.driveFault.inputs?.length === 1
        && status.driveFault.inputs[0]?.ucPin === 10
        && status.driveFault.inputs[0]?.activeLow === true,
      3_000,
    )
    check("  status samples the operator's neutral input as UC pin 10 active-low",
      !!operatorDriveStatus, JSON.stringify(operatorDriveStatus?.driveFault))

    const differentDriveSignals = withDriveSignals(
      switchlessDefinition(),
      [
        { port: 2, pin: 1, negate: false },
        { port: 3, pin: 10, negate: true },
      ],
      { enabled: true, pin: { port: 3, pin: 14, negate: false } },
    )
    const beforeDifferentDriveSignals = frames.length
    const differentDriveApply = await call(
      'applyMachineDefinition',
      { definition: differentDriveSignals },
      15_000,
    )
    const differentDriveLines = differentDriveApply?.v?.lines ?? []
    check('WO-1729 applies a different two-input definition with each polarity',
      differentDriveApply?.ok === true && differentDriveApply.v?.ok === true
        && differentDriveLines.some((line) => /drive fault input 1 applied: UCpin 1 .*active high/.test(line.text ?? ''))
        && differentDriveLines.some((line) => /drive fault input 2 applied: UCpin 7 .*active low/.test(line.text ?? '')),
      JSON.stringify(differentDriveApply))
    check('WO-1729 enables the different charge pump on translated UC pin 35 and reads it back',
      differentDriveLines.some((line) => /charge pump applied and read back: enabled=True primary UC pin=35 negate=False/.test(line.text ?? '')),
      JSON.stringify(differentDriveLines))
    const differentDriveStatus = await waitForStatusAfter(
      beforeDifferentDriveSignals,
      (status) => status?.driveFault?.inputs?.length === 2
        && status.driveFault.inputs[0]?.ucPin === 1
        && status.driveFault.inputs[0]?.activeLow === false
        && status.driveFault.inputs[1]?.ucPin === 7
        && status.driveFault.inputs[1]?.activeLow === true,
      3_000,
    )
    check('  status samples both differently polarised neutral inputs',
      !!differentDriveStatus, JSON.stringify(differentDriveStatus?.driveFault))

    // Leave the shared canonical desk cache safe for the next lane: no live
    // fault inputs on the zero-valued demo word, and the primary pump off.
    const safeDriveSignalRestore = await call(
      'applyMachineDefinition',
      {
        definition: withDriveSignals(
          importedMachineDefinition,
          [],
          { enabled: false },
        ),
      },
      15_000,
    )
    check('WO-1729 restores a fault-free, pump-off canonical desk fixture',
      safeDriveSignalRestore?.ok === true && safeDriveSignalRestore.v?.ok === true,
      JSON.stringify(safeDriveSignalRestore))

    await boardSpindlePhase(withDriveSignals(importedMachineDefinition, [], { enabled: false }))

  }

  // Move id 0 is the connect-time AddDummyMove sentinel and must be rejected.
  const badId = await call('loadMoves', { frame: 'work', moves: [{ id: 0, kind: 'marker' }] })
  check('loadMoves rejects move id 0 (the connect sentinel)',
    !!badId && (badId.ok === false || badId.v?.ok === false), JSON.stringify(badId))

  // Output inhibit: refused outright on a read-only build, and on a motion
  // build it is the operator's to lift - homing needs it live. Lift it and
  // put it straight back, so the harness leaves the board as it found it.
  const unInhibit = await call('setOutputInhibit', { on: false })
  if (readOnlyBuild) {
    check('enabling outputs is REFUSED while readOnly',
      !!unInhibit && unInhibit.ok === false, JSON.stringify(unInhibit))
  } else {
    check('enabling outputs is allowed on a motion-enabled build',
      !!unInhibit && unInhibit.ok === true, JSON.stringify(unInhibit))
    const reInhibit = await call('setOutputInhibit', { on: true })
    check('  and the harness re-inhibits them before it leaves',
      !!reInhibit && reInhibit.ok === true, JSON.stringify(reInhibit))
  }

  // ---- the G-code seam is gone -------------------------------------------
  const gcode = await call('sendCommand', { text: 'G0 X10' })
  check('the G-code text path says so plainly instead of pretending',
    !!gcode && gcode.ok === false && /geometry/i.test(gcode.error ?? ''), JSON.stringify(gcode))

  check('no GRBL text anywhere on the wire',
    !raw.some((f) => /^Grbl\s|<Idle\||\bok\r?\n|^error:\d/m.test(f)),
    raw.find((f) => /^Grbl\s|<Idle\||^error:\d/m.test(f)))

  // ---- WO-427: the spindle (VFD) link ------------------------------------
  //
  // spindleOff must be accepted in EVERY state - the no-gate-may-block-a-stop
  // rule, whether or not a link was ever configured for this process.
  const spindleOff = await call('spindleOff')
  check('spindleOff is accepted whether or not a spindle link exists',
    !!spindleOff && spindleOff.ok === true, JSON.stringify(spindleOff))

  const spindleOn = await call('spindleOn', { direction: 'cw', setpointWord: 1000 })
  check('spindleOn is REFUSED: no spindle link is configured',
    !!spindleOn && spindleOn.ok === false
      && /no spindle link/i.test(spindleOn.error ?? ''), JSON.stringify(spindleOn))
  if (spindleOn) console.log(`        spindleOn -> ${spindleOn.error}`)

  check('WO-1724: hello declares boardSpindleCommands, and ownsSpindle stays false',
    frames[0]?.v?.capabilities?.boardSpindleCommands === true
      && frames[0]?.v?.capabilities?.ownsSpindle === false,
    JSON.stringify(frames[0]?.v?.capabilities))
  if (readOnlyBuild) {
    const boardOn = await call('spindleOn', { direction: 'cw', rpm: 12000, drive: { kind: 'relay' } })
    check('WO-1724: a board spindle start is refused on a read-only build',
      !!boardOn && boardOn.ok === false, JSON.stringify(boardOn))
  }

  const resetFault = await call('spindleResetFault')
  check('spindleResetFault is refused with no spindle link configured',
    !!resetFault && resetFault.ok === false, JSON.stringify(resetFault))

  const spindleOffAgain = await call('spindleOff')
  check('spindleOff is STILL accepted after a refused spindleOn (stop is never gated)',
    !!spindleOffAgain && spindleOffAgain.ok === true, JSON.stringify(spindleOffAgain))

  // The vfd push: silent while no link is held - "if the link is not
  // running, the push never fires" (Bridge.cs PushVfd sends nothing then).
  await wait(400)
  const vfdPushes = frames.filter((f) => f.t === 'vfd')
  check('NO vfd push while no spindle link has been pushed',
    vfdPushes.length === 0, `${vfdPushes.length} pushes`)

  // status.spindleRpm stays null: no spindle link is held at this point.
  check('status.spindleRpm is still null (no real inverter has answered)',
    st?.spindleRpm === null, JSON.stringify(st?.spindleRpm))

  // ---- contract v3 pushes (WO-423) ---------------------------------------
  //
  // This is a READ-ONLY demo build: nothing homed, nothing ran, and the demo
  // board reports no fault inputs. So the load-bearing check is that the
  // bridge INVENTED NOTHING - a missing event is honest, a fabricated one is
  // a lie the UI would repeat to the operator.
  const PROTOCOL_FRAMES = ['hello', 'phase', 'status', 'console', 'reply', 'jobEvent', 'homed', 'alarm', 'vfd']
  const strange = frames.filter((f) => !PROTOCOL_FRAMES.includes(f.t))
  check('every frame is one the protocol declares',
    strange.length === 0, strange.map((f) => f.t).join(','))

  const jobEvents = frames.filter((f) => f.t === 'jobEvent')
  if (readOnlyBuild) {
    check('no jobEvent was invented: every start was refused on a read-only build',
      jobEvents.length === 0, JSON.stringify(jobEvents.map((f) => f.v)))
  } else {
    check('only the accepted WO-1722 switchless run produced job events',
      JSON.stringify(jobEvents.map((f) => f.v?.event)) === JSON.stringify(['started', 'completed']),
      JSON.stringify(jobEvents.map((f) => f.v)))
  }

  const homedPushes = frames.filter((f) => f.t === 'homed')
  check('no homed push was invented: homing was refused in this build',
    homedPushes.length === 0, JSON.stringify(homedPushes.map((f) => f.v)))

  // An alarm MAY legitimately arrive if the board reports a fault input. It
  // must then be well formed and agree with the status frame that produced it.
  const alarms = frames.filter((f) => f.t === 'alarm')
  const lastInputs = st?.inputs ?? {}
  const faultLive = !!(lastInputs.estop || lastInputs.hardLimit || lastInputs.softLimit)
  check('an alarm push is raised only when an input says so',
    alarms.length === 0 || faultLive, `${alarms.length} alarms, inputs ${JSON.stringify(lastInputs)}`)
  for (const a of alarms) {
    check('  the alarm is well formed (code may be null; the message is a sentence)',
      a.v && a.v.code === null && typeof a.v.message === 'string' && a.v.message.length > 10
        && typeof a.v.positionLost === 'boolean', JSON.stringify(a.v))
  }

  ws.onerror = null   // closing on purpose; the phase below opens its own sessions
  ws.close()
  await wait(300)
  await vfdPushPhase()
  await vfdBitfieldPhase()
  await vfdFaultRegisterPhase()
  await vfdWideSetpointPhase()

  console.log(`\n${pass} passed, ${fail} failed`)
  // Let the phase's sockets finish closing: exiting mid-close trips a libuv
  // assertion on Windows and replaces the exit code.
  await wait(300)
  process.exit(fail === 0 ? 0 : 1)
}

// ---- WO-1719: the spindle link comes only from the pushed definition --------
//
// Each step on a FRESH connection where hello matters, because hello is the
// bridge's statement of what it holds and it is sent once, at connect.

async function openSession() {
  const s = { frames: [], replies: new Map(), seq: 0 }
  const sock = new WebSocket(url)
  sock.binaryType = 'arraybuffer'
  sock.onmessage = (ev) => {
    const text = typeof ev.data === 'string'
      ? ev.data
      : new TextDecoder().decode(new Uint8Array(ev.data))
    let msg
    try { msg = JSON.parse(text) } catch { return }
    s.frames.push(msg)
    if (msg.t === 'reply') s.replies.set(msg.seq, msg)
  }
  s.closed = new Promise((resolve) => sock.addEventListener('close', resolve, { once: true }))
  await new Promise((resolve, reject) => { sock.onopen = resolve; sock.onerror = reject })
  s.call = async (m, a, timeoutMs = 5000) => {
    const n = ++s.seq
    sock.send(JSON.stringify({ t: 'call', seq: n, m, ...(a !== undefined ? { a } : {}) }))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (s.replies.has(n)) return s.replies.get(n)
      await wait(10)
    }
    return null
  }
  s.close = () => sock.close()
  const deadline = Date.now() + 2000
  while (!s.frames.some((f) => f.t === 'hello') && Date.now() < deadline) await wait(10)
  s.hello = s.frames.find((f) => f.t === 'hello')?.v
  return s
}

function rawClient(text = null) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port: Number(port) })
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeListener('error', reject)
      // A rejected or malformed control connection commonly resets after the
      // TCP connect event. That is an expected result for this helper, not an
      // unhandled Node process error; waitForRawClose observes the close.
      sock.on('error', () => {})
      if (text !== null) sock.write(text)
      resolve(sock)
    })
  })
}

async function waitForRawClose(sock, timeoutMs = 1500) {
  if (sock.destroyed) return true
  return Promise.race([
    new Promise((resolve) => sock.once('close', () => resolve(true))),
    wait(timeoutMs).then(() => false),
  ])
}

async function closeSession(session) {
  session.close()
  await Promise.race([session.closed, wait(1500)])
}

async function tryOpenSession() {
  try { return await openSession() } catch { return null }
}

// WO-1732: distribution proof for the canonical desk build. Every process is
// a CNCdrive demo board (board <= 0), so this mode cannot address hardware.
// It starts and stops its own bridge processes and drives the production
// LoadBesideBridge -> CheckBoardType path rather than parsing the table itself.
async function boardDistributionPhase() {
  console.log('\nWO-1732 shipped board data')
  const build = join(tmpdir(), 'liencam-bridge-desk')
  const exe = join(build, 'liencam-bridge.exe')
  const boards = join(build, 'boards')
  const log = join(build, 'liencam-bridge.log')

  check('canonical desk executable exists', existsSync(exe), exe)
  // WO-2844: the compatibility record ships beside the one sourced pin table.
  check('only the sourced UC100 table and the compatibility record are distributed',
    existsSync(boards)
      && JSON.stringify(readdirSync(boards).filter((name) => name.endsWith('.json')).sort())
        === JSON.stringify(['compat.json', 'uc100.json']),
    existsSync(boards) ? JSON.stringify(readdirSync(boards).sort()) : boards)
  if (!existsSync(exe) || !existsSync(boards)) return

  const portFree = await portIsFree(Number(port))
  check(`explicit port ${port} is free before the smoke`, portFree)
  if (!portFree) return

  const uc100 = await runDemoBoard(exe, log, 0, /listening on ws:\/\/127\.0\.0\.1:/)
  check('UC100 table loads from the distributed boards directory',
    /board table uc100\.json: UC100 \(DeviceInfo type 1\), 17 pins/.test(uc100.text), uc100.text)
  check('demo UC100 selects the shipped table through the real board gate',
    /board 0 is the demo UC100 .* UC100 pin table applies/.test(uc100.text), uc100.text)
  const uc100Session = uc100.ready ? await tryOpenSession() : null
  check('demo UC100 reaches hello with board id 0', uc100Session?.hello?.uccnc?.board === 0,
    JSON.stringify(uc100Session?.hello?.uccnc))
  if (uc100Session) await closeSession(uc100Session)
  await stopBridge(uc100.child)

  const axbb = await runDemoBoard(exe, log, -19, /listening on ws:\/\/127\.0\.0\.1:/)
  check('AXBB-E still selects its unchanged built-in table',
    /board -19 is the demo AXBB-E .* AXBB-E pin table applies/.test(axbb.text), axbb.text)
  const axbbSession = axbb.ready ? await tryOpenSession() : null
  check('demo AXBB-E reaches hello with board id -19', axbbSession?.hello?.uccnc?.board === -19,
    JSON.stringify(axbbSession?.hello?.uccnc))
  if (axbbSession) await closeSession(axbbSession)
  await stopBridge(axbb.child)

  const unknown = await runDemoBoard(exe, log, -999, /could not open the controller - exiting/)
  check('unknown demo type 999 retains the truthful pin-table refusal',
    /REFUSING TO OPEN: this controller reports DeviceInfo board type 999/.test(unknown.text)
      && /Pin tables held: AXBB-E \(type 19\), UC100 \(type 1\)/.test(unknown.text),
    unknown.text)
  check('unknown demo type never opens a listener',
    !/listening on ws:/.test(unknown.text), unknown.text)
  await stopBridge(unknown.child)
  check('all demo bridge processes are stopped and the port is free',
    await portIsFree(Number(port)))
}

async function portIsFree(number) {
  return await new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(number, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function runDemoBoard(exe, log, board, readyPattern) {
  const offset = existsSync(log) ? statSync(log).size : 0
  const child = spawn(exe, ['--board', String(board), '--port', String(port)], {
    cwd: dirname(exe),
    stdio: 'ignore',
    windowsHide: true,
  })
  let text = ''
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(log) && statSync(log).size >= offset) {
      text = readFileSync(log).subarray(offset).toString('utf8')
      if (readyPattern.test(text)) break
    }
    if (child.exitCode !== null) break
    await wait(50)
  }
  const ready = readyPattern.test(text)
  console.log(`\n-- demo board ${board} --`)
  for (const line of text.split(/\r?\n/).filter((line) =>
    /board table|demo .* pin table applies|REFUSING TO OPEN|listening on ws:/.test(line))) {
    console.log(line)
  }
  check(`demo board ${board} reaches its expected startup outcome`, ready, text)
  return { child, ready, text }
}

async function stopBridge(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(3_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  await wait(250)
}

// WO-1782: exercise the production listener and handshake boundary. These are
// deliberately status-only sessions on demo board -19; no motion or spindle
// command is sent. The old accept-time guard deterministically fails the held
// incomplete-handshake check because that raw TCP client owns the only slot.
async function bridgeSessionOwnershipPhase() {
  console.log('\nWO-1782 bridge session ownership')

  const bare = await rawClient()
  bare.destroy()
  await waitForRawClose(bare)
  const afterBare = await tryOpenSession()
  check('bare TCP readiness probe cannot steal the browser session',
    afterBare?.hello?.protocol === 1, JSON.stringify(afterBare?.hello))
  if (afterBare) await closeSession(afterBare)

  const incomplete = await rawClient('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
  const besideIncomplete = await tryOpenSession()
  check('held incomplete HTTP handshake does not reserve the browser slot',
    besideIncomplete?.hello?.protocol === 1, JSON.stringify(besideIncomplete?.hello))
  if (besideIncomplete) await closeSession(besideIncomplete)
  incomplete.destroy()
  await waitForRawClose(incomplete)

  const owner = await tryOpenSession()
  check('a real owner connects before rejected-client cleanup checks',
    owner?.hello?.protocol === 1, JSON.stringify(owner?.hello))
  if (owner) {
    const before = owner.frames.filter((frame) => frame.t === 'status').at(-1)?.v?.state
    const aborted = await rawClient()
    aborted.destroy()
    check('aborted TCP probe closes without becoming a session',
      await waitForRawClose(aborted))

    const malformed = await rawClient('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    check('malformed handshake is closed without becoming a session',
      await waitForRawClose(malformed))

    const rejectedOne = await tryOpenSession()
    const rejectedTwo = await tryOpenSession()
    check('rejected non-owners cannot release the real owner slot',
      rejectedOne === null && rejectedTwo === null,
      JSON.stringify({ rejectedOne: !!rejectedOne, rejectedTwo: !!rejectedTwo }))
    if (rejectedOne) await closeSession(rejectedOne)
    if (rejectedTwo) await closeSession(rejectedTwo)

    const stillAnswers = await owner.call('queryStatus')
    await wait(300)
    const after = owner.frames.filter((frame) => frame.t === 'status').at(-1)?.v?.state
    check('non-owner cleanup neither disconnects nor panic-stops the owner',
      stillAnswers?.ok === true && before === after,
      JSON.stringify({ reply: stillAnswers, before, after }))
    await closeSession(owner)
  }

  const contenders = await Promise.allSettled([openSession(), openSession()])
  const winners = contenders.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  check('two simultaneous valid handshakes produce exactly one controlling session',
    winners.length === 1, `${winners.length} sessions opened`)
  for (const winner of winners) await closeSession(winner)

  const reconnect = await tryOpenSession()
  check('the real owner close releases the slot for reconnect',
    reconnect?.hello?.protocol === 1, JSON.stringify(reconnect?.hello))
  if (reconnect) await closeSession(reconnect)

  let repeated = 0
  for (let cycle = 0; cycle < 3; cycle++) {
    const probe = await rawClient()
    probe.destroy()
    await waitForRawClose(probe)
    const session = await tryOpenSession()
    if (session?.hello?.protocol === 1) repeated++
    if (session) await closeSession(session)
  }
  check('repeated desktop-style TCP probe then WebSocket cycles all connect',
    repeated === 3, `${repeated} of 3 connected`)
}

function alternateRunStateDefinition(source) {
  const other = structuredClone(source)
  other.id = 'generic-run-state-drive'
  other.name = 'Generic run-state drive'
  other.registers.runState = {
    address: 0x0200,
    count: 1,
    values: [
      { value: 0, meaning: 'stopped' },
      { value: 1, meaning: 'running' },
      { value: 7, meaning: 'faulted' },
    ],
  }
  other.fault = { kind: 'equals', value: 7 }
  other.commands.values = { runCw: 0x12, runCcw: 0x22, stop: 0x40 }
  return other
}

async function waitForSessionVfdWord(session, afterIndex, word, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.frames.slice(afterIndex).find(
      (frame) => frame.t === 'vfd' && frame.v?.runStateWord === word,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function waitForSessionVfdRunning(session, afterIndex, running, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.frames.slice(afterIndex).find(
      (frame) => frame.t === 'vfd' && frame.v?.running === running,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function setFakeRunState(session, label, word) {
  const before = session.frames.length
  const reply = await session.call('setFakeInverterRunState', { word })
  check(`${label}: demo inverter accepts raw run-state word ${word}`,
    reply?.ok === true && reply.v?.runStateWord === word, JSON.stringify(reply))
  const pushed = await waitForSessionVfdWord(session, before, word)
  check(`${label}: canonical vfd push reports raw word ${word}`,
    !!pushed, JSON.stringify(session.frames.slice(before).filter((frame) => frame.t === 'vfd')))
  return pushed
}

async function stopFakeInverter(session, label, stoppedWord) {
  // Make the explicit call, not the ordinary stopped-state poll loop, necessary
  // for the STOP write below. A running push is emitted only after the single
  // VFD poll thread has written this definition's RUN word, so it also drains
  // any pass that could still have captured the earlier stopped command.
  const beforeFrames = session.frames.length
  const running = await session.call('spindleOn', { direction: 'cw', setpointWord: 1000 })
  const runningPush = await waitForSessionVfdRunning(session, beforeFrames, true)
  check(`${label}: STOP proof first establishes commanded-running state`,
    running?.ok === true && !!runningPush, JSON.stringify({ running, runningPush }))

  const beforeState = await session.call('getFakeInverterState')
  await wait(75) // three 25 ms fake-link poll intervals, with calls maintaining the heartbeat
  const armedState = await session.call('getFakeInverterState')
  check(`${label}: background polling cannot satisfy the explicit STOP proof`,
    beforeState?.ok === true && armedState?.ok === true
      && armedState.v?.stopWrites === beforeState.v?.stopWrites,
    JSON.stringify({ before: beforeState, armed: armedState }))

  const stopped = await session.call('spindleOff')
  const afterState = await session.call('getFakeInverterState')
  check(`${label}: spindleOff is accepted and writes this definition's STOP word`,
    stopped?.ok === true && afterState?.ok === true
      && afterState.v?.stopWrites > armedState?.v?.stopWrites,
    JSON.stringify({ stopped, armed: armedState, after: afterState }))
  const beforeResetFrames = session.frames.length
  const reset = await session.call('setFakeInverterRunState', { word: stoppedWord })
  const pushed = await waitForSessionVfdWord(session, beforeResetFrames, stoppedWord)
  check(`${label}: fake inverter readback returns to stopped word ${stoppedWord}`,
    reset?.ok === true && reset.v?.runStateWord === stoppedWord && !!pushed,
    JSON.stringify({ reset, frames: session.frames.slice(beforeResetFrames).filter((frame) => frame.t === 'vfd') }))
}

async function vfdPushPhase() {
  console.log(`\n-- WO-1719: the spindle link from the pushed definition (${fakeInverter ? 'fake inverter' : 'no inverter'}) --`)
  // A desk fixture only: the bridge itself reads no definition from disk.
  const doc = JSON.parse(readFileSync(new URL('./vfd/huanyang-gt.definition.json', import.meta.url), 'utf8'))
  const otherDoc = alternateRunStateDefinition(doc)
  if (!fakeInverter) doc.link.port = 'COM250'   // a port no desk box has

  let s = await openSession()
  const slowDoc = structuredClone(doc)
  slowDoc.id = 'slow-polling-drive'
  slowDoc.name = 'Slow polling drive'
  slowDoc.link.pollIntervalMs = 2000
  const slow = await s.call('applyVfdDefinition', { definition: slowDoc })
  check('WO-1737 refuses a 2000 ms poll against the 1000 ms spindle stop budget',
    !!slow && slow.ok === true && slow.v?.ok === false
      && slow.v?.reason === 'the spindle link polls every 2000 ms; the spindle safety stop needs a reading within 1000 ms.',
    JSON.stringify(slow))
  await wait(2200)
  check('  the refused definition creates no spindle link or stop loop',
    s.frames.filter((f) => f.t === 'vfd').length === 0,
    `${s.frames.filter((f) => f.t === 'vfd').length} vfd pushes`)
  s.close()
  await wait(300)

  s = await openSession()
  check('  hello still says no spindle link after the refusal',
    s.hello?.vfd?.present === false && s.hello?.vfd?.definition === null,
    JSON.stringify(s.hello?.vfd))
  const pushed = await s.call('applyVfdDefinition', { definition: doc })

  if (!fakeInverter) {
    check('push onto a port that does not exist is REFUSED, not pretended',
      !!pushed && pushed.ok === true && pushed.v?.ok === false
        && /could not (be )?open/i.test(pushed.v?.reason ?? ''), JSON.stringify(pushed))
    s.close()
    await wait(300)
    s = await openSession()
    check('  and the bridge still holds no link (hello.vfd.present false)',
      s.hello?.vfd?.present === false, JSON.stringify(s.hello?.vfd))
    s.close()
    return
  }

  check('push -> the bridge opens the link and echoes the document it now holds',
    !!pushed && pushed.ok === true && pushed.v?.ok === true && pushed.v?.definition?.name === doc.name,
    JSON.stringify(pushed))
  check('  and says so on the console',
    s.frames.some((f) => f.t === 'console'
      && /spindle link is open at COM3 \(Modbus RTU slave 1\)/.test(f.v?.text ?? '')),
    JSON.stringify(s.frames.filter((f) => f.t === 'console').map((f) => f.v?.text)))
  await wait(500)
  const vfdFrames = s.frames.filter((f) => f.t === 'vfd')
  check('  vfd pushes start on the SAME connection, no reconnect needed',
    vfdFrames.length > 0, `${vfdFrames.length} pushes`)
  const lastVfd = vfdFrames[vfdFrames.length - 1]?.v
  if (lastVfd) {
    console.log(`        ${JSON.stringify(lastVfd)}`)
    check('  vfd push has up/running/faulted/runStateWord/status as the right types',
      typeof lastVfd.up === 'boolean' && typeof lastVfd.running === 'boolean'
        && typeof lastVfd.faulted === 'boolean' && typeof lastVfd.runStateWord === 'number'
        && typeof lastVfd.status === 'object', JSON.stringify(lastVfd))
    check('  the link is up and the (fake) inverter reads standby (3)',
      lastVfd.up === true && lastVfd.runStateWord === 3, JSON.stringify(lastVfd))
    check('  no invented up-to-speed: that needs the setpoint scale, which only LienCAM evaluates',
      lastVfd.upToSpeed === null, JSON.stringify(lastVfd.upToSpeed))
  }

  check('  shipped Huanyang document carries the measured 1/2/3/4/5 meanings',
    JSON.stringify(doc.registers.runState.values) === JSON.stringify([
      { value: 1, meaning: 'runningForward' },
      { value: 2, meaning: 'runningReverse' },
      { value: 3, meaning: 'stopped' },
      { value: 4, meaning: 'faulted' },
      { value: 5, meaning: 'poweredOff' },
    ]), JSON.stringify(doc.registers.runState.values))

  await stopFakeInverter(s, 'Huanyang stopped=3', 3)
  const huanyangRunning = await setFakeRunState(s, 'Huanyang runningForward=1', 1)
  check('  raw running report does not invent a commanded direction',
    huanyangRunning?.running === false, JSON.stringify(huanyangRunning))
  const refusedOtherWhileRunning = await s.call('applyVfdDefinition', { definition: otherDoc })
  check('  replacement is refused while the Huanyang table says running forward',
    refusedOtherWhileRunning?.ok === true && refusedOtherWhileRunning.v?.ok === false
      && /running forward/.test(refusedOtherWhileRunning.v?.reason ?? ''),
    JSON.stringify(refusedOtherWhileRunning))
  await stopFakeInverter(s, 'Huanyang runningForward=1', 3)

  const appliedOther = await s.call('applyVfdDefinition', { definition: otherDoc })
  check('stopped Huanyang link is replaced by the independently authored stopped=0 drive',
    appliedOther?.ok === true && appliedOther.v?.ok === true
      && appliedOther.v?.definition?.name === otherDoc.name
      && JSON.stringify(appliedOther.v?.definition?.registers?.runState?.values)
        === JSON.stringify(otherDoc.registers.runState.values),
    JSON.stringify(appliedOther))
  const otherStopped = await waitForSessionVfdWord(s, 0, 0)
  check('  replacement link reports stopped through its own word 0',
    !!otherStopped, JSON.stringify(s.frames.filter((frame) => frame.t === 'vfd').slice(-5)))
  await stopFakeInverter(s, 'alternate stopped=0', 0)

  const otherRunning = await setFakeRunState(s, 'alternate running=1', 1)
  check('  alternate raw running report also leaves direction command-derived',
    otherRunning?.running === false, JSON.stringify(otherRunning))
  const refusedOperatorWhileRunning = await s.call('applyVfdDefinition', { definition: doc })
  check('  Huanyang replacement is refused while the alternate table says running',
    refusedOperatorWhileRunning?.ok === true && refusedOperatorWhileRunning.v?.ok === false
      && /reports running\./.test(refusedOperatorWhileRunning.v?.reason ?? ''),
    JSON.stringify(refusedOperatorWhileRunning))
  await stopFakeInverter(s, 'alternate running=1', 0)

  const otherFaulted = await setFakeRunState(s, 'alternate faulted=7', 7)
  check('  alternate fault rule reports faulted from its own word 7',
    otherFaulted?.faulted === true, JSON.stringify(otherFaulted))
  const refusedOperatorWhileFaulted = await s.call('applyVfdDefinition', { definition: doc })
  check('  replacement is refused while the alternate table says faulted',
    refusedOperatorWhileFaulted?.ok === true && refusedOperatorWhileFaulted.v?.ok === false
      && /FAULTED/.test(refusedOperatorWhileFaulted.v?.reason ?? ''),
    JSON.stringify(refusedOperatorWhileFaulted))
  await stopFakeInverter(s, 'alternate faulted=7', 0)

  const otherUnknown = await setFakeRunState(s, 'alternate unknown=99', 99)
  check('  an unnamed word is not reported as faulted or commanded running',
    otherUnknown?.faulted === false && otherUnknown?.running === false,
    JSON.stringify(otherUnknown))
  const refusedOperatorWhileUnknown = await s.call('applyVfdDefinition', { definition: doc })
  check('  replacement is refused when the alternate table does not name word 99',
    refusedOperatorWhileUnknown?.ok === true && refusedOperatorWhileUnknown.v?.ok === false
      && /unrecognised code \(99\)/.test(refusedOperatorWhileUnknown.v?.reason ?? ''),
    JSON.stringify(refusedOperatorWhileUnknown))
  await stopFakeInverter(s, 'alternate unknown=99', 0)

  const restoredOperator = await s.call('applyVfdDefinition', { definition: doc })
  check('stopped alternate link is replaced by the shipped Huanyang definition again',
    restoredOperator?.ok === true && restoredOperator.v?.ok === true
      && restoredOperator.v?.definition?.name === doc.name,
    JSON.stringify(restoredOperator))

  const again = await s.call('applyVfdDefinition', { definition: doc })
  check('the SAME document pushed again (every connect does) keeps the link',
    !!again && again.v?.ok === true && again.v?.definition?.name === doc.name, JSON.stringify(again))
  s.close()
  await wait(300)

  s = await openSession()
  check('hello on a new connection reports the pushed link it holds',
    s.hello?.vfd?.present === true && s.hello?.vfd?.name === doc.name
      && s.hello?.vfd?.definition?.link?.port === doc.link.port, JSON.stringify(s.hello?.vfd))
  check('  verified is FALSE: a pushed definition claims nothing about itself',
    s.hello?.vfd?.verified === false, String(s.hello?.vfd?.verified))

  const none = await s.call('applyVfdDefinition', { definition: null })
  check('push none -> the bridge closes the link',
    !!none && none.ok === true && none.v?.ok === true && none.v?.definition === null, JSON.stringify(none))
  check('  and says so on the console',
    s.frames.some((f) => f.t === 'console' && /declares no VFD/.test(f.v?.text ?? '')),
    JSON.stringify(s.frames.filter((f) => f.t === 'console').map((f) => f.v?.text)))
  await wait(300)
  const settled = s.frames.filter((f) => f.t === 'vfd').length
  await wait(700)
  check('  vfd pushes stop once the link is closed',
    s.frames.filter((f) => f.t === 'vfd').length === settled, `${s.frames.filter((f) => f.t === 'vfd').length - settled} more`)
  const on = await s.call('spindleOn', { direction: 'cw', setpointWord: 1000 })
  check('  spindleOn is refused: no spindle link is configured',
    !!on && on.ok === false && /no spindle link/i.test(on.error ?? ''), JSON.stringify(on))
  const off = await s.call('spindleOff')
  check('  spindleOff is still accepted', !!off && off.ok === true, JSON.stringify(off))
  s.close()
  await wait(300)

  s = await openSession()
  check('hello on a new connection: no link held after none',
    s.hello?.vfd?.present === false && s.hello?.vfd?.definition === null, JSON.stringify(s.hello?.vfd))
  s.close()
}

// ---- WO-1734: a VFD with a bit-field control word --------------------------
//
// the operator's Huanyang GT states one whole WORD per command. Plenty of inverters
// state a CONTROL WORD instead, where run, reverse, stop and fault reset are
// BITS of one word and a command is "clear these bits, set those" over the word
// last written. The bridge used to refuse such a document outright - no link,
// and therefore no stop either - and knew exactly one reset shape.
//
// The document below is deliberately unlike his, and nothing in the product was
// edited to make it work. Its STOP claims only the run bits, so the direction
// bit it never claimed is still standing in the word afterwards; a whole-word
// table cannot express that at all, and it is why 0x0021 below is the check
// that matters. Its fault reset sets a bit, waits, and then puts the word back
// to a plain stop, which is the sequence the DOCUMENT states and not one this
// bridge knows by heart.
//
// The words are read off `vfd.commandWord`, which is what the bridge last wrote
// to the command register. Words written DURING a reset sequence are not
// visible here - a pass emits its push when it ends, and the sequence runs
// inside a pass - so the step-by-step reset proof is
// src/tests/machine/vfdBitfieldCommands.wo1734.test.ts, against the same
// compiled Vfd.cs. What this phase proves is the whole path: a document pushed
// from LienCAM over the socket, and the words that came out on the wire.
function bitfieldDefinition(source) {
  const doc = structuredClone(source)
  doc.id = 'control-word-drive'
  doc.name = 'Control word drive'
  doc.commands = {
    style: 'bitfield',
    idle: 0x0000,
    commands: {
      // bits 0-1 run/stop, bits 4-5 direction, bit 7 fault reset.
      runCw: { mask: 0x0033, value: 0x0012 },
      runCcw: { mask: 0x0033, value: 0x0022 },
      stop: { mask: 0x0003, value: 0x0001 },
      resetFault: { mask: 0x0080, value: 0x0080 },
      // Clearing the fault also clears run and direction: the word goes back to
      // a plain stop, which is this drive's rule and not the bridge's.
      releaseReset: { mask: 0x00b3, value: 0x0001 },
    },
  }
  doc.resetSequence = [
    { command: 'resetFault', delayMsAfter: 300 },
    { command: 'releaseReset', delayMsAfter: 0 },
  ]
  return doc
}

async function waitForSessionVfdCommandWord(session, afterIndex, word, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.frames.slice(afterIndex).find(
      (frame) => frame.t === 'vfd' && frame.v?.commandWord === word,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function checkCommandWord(session, label, word) {
  const before = session.frames.length
  const seen = await waitForSessionVfdCommandWord(session, before, word)
  check(`  ${label}: the bridge writes 0x${word.toString(16).padStart(4, '0')}`,
    !!seen,
    JSON.stringify(session.frames.slice(before).filter((f) => f.t === 'vfd')
      .map((f) => f.v?.commandWord).slice(-8)))
  return seen
}

async function vfdBitfieldPhase() {
  console.log('\n-- WO-1734: a control-word drive, from its own definition --')
  if (!fakeInverter) {
    console.log('   (skipped: this phase needs --fake-inverter)')
    return
  }
  const operator = JSON.parse(readFileSync(new URL('./vfd/huanyang-gt.definition.json', import.meta.url), 'utf8'))
  const doc = bitfieldDefinition(operator)

  // The phase above signs off with a close and no wait; this bridge holds one
  // control session, so connecting before that one has finished closing is
  // refused at the socket.
  await wait(300)
  const s = await openSession()
  const pushed = await s.call('applyVfdDefinition', { definition: doc })
  check('a bit-field command table is ACCEPTED, where it used to be refused outright',
    pushed?.ok === true && pushed.v?.ok === true && pushed.v?.definition?.name === doc.name,
    JSON.stringify(pushed))
  if (pushed?.v?.ok !== true) { s.close(); return }

  await checkCommandWord(s, 'stopped', 0x0001)

  const cw = await s.call('spindleOn', { direction: 'cw', setpointWord: 1000 })
  check('  spindleOn cw is accepted', cw?.ok === true, JSON.stringify(cw))
  await checkCommandWord(s, 'run forward', 0x0012)

  const ccw = await s.call('spindleOn', { direction: 'ccw', setpointWord: 1000 })
  check('  spindleOn ccw is accepted', ccw?.ok === true, JSON.stringify(ccw))
  await checkCommandWord(s, 'run reverse', 0x0022)

  const off = await s.call('spindleOff')
  check('  spindleOff is accepted', off?.ok === true, JSON.stringify(off))
  // THE CHECK THAT COULD NOT PASS ON A WHOLE-WORD TABLE: stop claims the run
  // bits only, so the reverse bit this drive was left in is still standing.
  await checkCommandWord(s, 'stop over reverse keeps the bits it did not claim', 0x0021)

  const reset = await s.call('spindleResetFault')
  check('  the fault reset is accepted on a control-word link', reset?.ok === true, JSON.stringify(reset))
  await checkCommandWord(s, "the reset ends where this document says, not where the operator's does", 0x0001)

  const closed = await s.call('applyVfdDefinition', { definition: null })
  check('  the control-word link closes like any other',
    closed?.ok === true && closed.v?.ok === true && closed.v?.definition === null, JSON.stringify(closed))
  s.close()
  await wait(300)
}

// ---- WO-1735: a fault read from the drive's own register -------------------
//
// the operator's Huanyang GT reports its fault in the OPERATING-STATE word (4 means
// fault), and that is all this bridge could ever read. Plenty of drives carry
// a separate fault register instead, and on those the operating-state word
// keeps saying "stopped" while the drive sits on a fault - which is exactly
// the picture this phase produces.
//
// The document below is his, with one register added and nothing in the
// product edited to make it work: a definition either states registers.
// faultCode or it does not. Both definitions run through the same push, the
// same link and the same poll loop in the same process, one after the other.
function ownFaultRegisterDefinition(source) {
  const doc = structuredClone(source)
  doc.id = 'own-fault-register-drive'
  doc.name = 'Own fault register drive'
  doc.registers.runState = {
    address: 0x0200,
    count: 1,
    values: [
      { value: 0, meaning: 'stopped' },
      { value: 1, meaning: 'running' },
    ],
  }
  // The fault lives here, and this drive's table has no `faulted` value at all
  // - there is nothing in its operating-state word that could stand in.
  doc.registers.faultCode = { address: 0x5000, count: 1 }
  doc.fault = { kind: 'nonZero' }
  return doc
}

async function waitForSessionVfdFaulted(session, afterIndex, faulted, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.frames.slice(afterIndex).find(
      (frame) => frame.t === 'vfd' && frame.v?.faulted === faulted,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function vfdFaultRegisterPhase() {
  console.log('')
  console.log("-- WO-1735: a fault read from the drive's own register --")
  if (!fakeInverter) {
    console.log('   (skipped: this phase needs --fake-inverter)')
    return
  }
  const operator = JSON.parse(readFileSync(new URL('./vfd/huanyang-gt.definition.json', import.meta.url), 'utf8'))
  const own = ownFaultRegisterDefinition(operator)

  await wait(300)
  const s = await openSession()

  // ---- 1. the operator's definition: unchanged, and says so on the wire ----------
  const pushedOperator = await s.call('applyVfdDefinition', { definition: operator })
  check('WO-1735: the shipped Huanyang document still opens its link',
    pushedOperator?.ok === true && pushedOperator.v?.ok === true, JSON.stringify(pushedOperator))
  if (pushedOperator?.v?.ok !== true) { s.close(); return }
  check('  and it states no fault register',
    operator.registers.faultCode === undefined, JSON.stringify(operator.registers.faultCode))

  const operatorStopped = await waitForSessionVfdWord(s, 0, 3)
  check('  his link reports standby (3) and no fault',
    operatorStopped?.faulted === false, JSON.stringify(operatorStopped))
  // A word in a register his definition does not name is not a fact about his
  // inverter, so the push does not carry one.
  check('  his push carries NO faultCodeWord key at all',
    operatorStopped !== null && !('faultCodeWord' in operatorStopped), JSON.stringify(operatorStopped))
  const operatorFaultState = await s.call('getFakeInverterState')
  check('  the demo inverter exposes its fault word for this phase',
    typeof operatorFaultState?.v?.faultCodeWord === 'number', JSON.stringify(operatorFaultState))
  const operatorFaultWritten = await s.call('setFakeInverterFaultCode', { word: 12 })
  check('  a 12 put in 0x5000 is accepted by the demo inverter',
    operatorFaultWritten?.ok === true && operatorFaultWritten.v?.faultCodeWord === 12,
    JSON.stringify(operatorFaultWritten))
  await wait(400)
  const operatorAfterFaultWord = s.frames.filter((f) => f.t === 'vfd').slice(-1)[0]?.v
  check('  and it changes NOTHING on his link: still not faulted, still no key',
    operatorAfterFaultWord?.faulted === false && !('faultCodeWord' in (operatorAfterFaultWord ?? {})),
    JSON.stringify(operatorAfterFaultWord))
  const operatorRunStateFault = await setFakeRunState(s, 'Huanyang fault=4', 4)
  check('  his fault still comes from the operating-state word (4)',
    operatorRunStateFault?.faulted === true, JSON.stringify(operatorRunStateFault))
  await stopFakeInverter(s, 'Huanyang fault=4', 3)

  // ---- 2. a drive whose fault lives in its own register ------------------
  const pushedOwn = await s.call('applyVfdDefinition', { definition: own })
  check('a drive that states registers.faultCode is accepted, with no source edit',
    pushedOwn?.ok === true && pushedOwn.v?.ok === true
      && pushedOwn.v?.definition?.registers?.faultCode?.address === 0x5000,
    JSON.stringify(pushedOwn))
  if (pushedOwn?.v?.ok !== true) { s.close(); return }

  const ownClear = await waitForSessionVfdWord(s, 0, 0)
  check('  its link comes up stopped, with its fault register reading 0',
    ownClear?.faulted === false && ownClear?.faultCodeWord === 0, JSON.stringify(ownClear))

  const before = s.frames.length
  const set = await s.call('setFakeInverterFaultCode', { word: 12 })
  check('  the demo inverter takes a fault code of 12', set?.ok === true, JSON.stringify(set))
  const faulted = await waitForSessionVfdFaulted(s, before, true)
  check('A FAULT IN THAT REGISTER IS REPORTED: faulted true from word 12',
    faulted?.faulted === true && faulted?.faultCodeWord === 12, JSON.stringify(faulted))
  // THE MEASUREMENT THAT MATTERS: the operating-state word says stopped in the
  // very same push. The old path could not have reported this fault at all.
  check('  while the operating-state word in the same push still reads stopped (0)',
    faulted?.runStateWord === 0, JSON.stringify(faulted))

  const cleared = s.frames.length
  await s.call('setFakeInverterFaultCode', { word: 0 })
  const recovered = await waitForSessionVfdFaulted(s, cleared, false)
  check('  and clearing that register clears the fault, without a reset gate',
    recovered?.faulted === false && recovered?.faultCodeWord === 0, JSON.stringify(recovered))

  const off = await s.call('spindleOff')
  check('  spindleOff is accepted on this link too, faulted or not', off?.ok === true, JSON.stringify(off))

  const closed = await s.call('applyVfdDefinition', { definition: null })
  check('  the fault-register link closes like any other',
    closed?.ok === true && closed.v?.ok === true && closed.v?.definition === null, JSON.stringify(closed))
  s.close()
  await wait(300)
}


// ---- WO-1736: a VFD with a 32-bit speed setpoint ---------------------------
//
// the operator's Huanyang GT takes its speed in ONE holding register, and until this
// order that was the only setpoint the bridge could write. Plenty of drives
// take the speed reference as a 32-bit value in a REGISTER PAIR, and which
// half goes on the wire first is a fact of the drive rather than of Modbus:
// 18,000 RPM high-first is 0x0000 0x4650, low-first is 0x4650 0x0000, and an
// inverter handed the wrong one runs at a different speed.
//
// The documents below are deliberately unlike his and nothing in the product
// was edited to make them work: they state `registers.setpoint.count` 2 and
// their own `protocol.wordOrder`, and the bridge writes that shape.
//
// WHAT THIS PHASE PROVES AND WHAT IT DOES NOT. It is the whole path - a
// document pushed from LienCAM over the socket, a link opened on it, a speed
// commanded, and the setpoint the bridge reports having WRITTEN coming back in
// its own push. `vfd.setpointWord` is latched only after the write succeeded,
// so 18000 coming back means the pair went out and was answered. The BYTES of
// that pair - two registers, in the stated order, in one 0x10 frame - are read
// off the wire in src/tests/machine/vfdWideSetpoint.wo1736.test.ts, against
// the same compiled Vfd.cs; the demo inverter here does not record them.
function wideSetpointDefinition(source, wordOrder) {
  const doc = structuredClone(source)
  doc.id = `wide-setpoint-${wordOrder}`
  doc.name = `Wide setpoint drive (${wordOrder})`
  doc.protocol = { readFunction: 3, writeFunction: 0x10, wordOrder }
  doc.registers = {
    ...doc.registers,
    // Plain RPM, in a pair. 18,000 needs both registers the moment the drive
    // scales in anything finer than whole RPM, and needs the ORDER either way.
    setpoint: {
      address: 0x2000,
      count: 2,
      scale: 'set.rpm',
      encode: { round: 'nearest', min: 0, max: 4294967295 },
    },
  }
  return doc
}

async function waitForSessionSetpointWord(session, afterIndex, word, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.frames.slice(afterIndex).find(
      (frame) => frame.t === 'vfd' && frame.v?.setpointWord === word,
    )
    if (found) return found.v
    await wait(25)
  }
  return null
}

async function driveWideSetpoint(session, wordOrder, operator) {
  const doc = wideSetpointDefinition(operator, wordOrder)
  const pushed = await session.call('applyVfdDefinition', { definition: doc })
  check(`  a ${wordOrder} 32-bit setpoint document is ACCEPTED`,
    pushed?.ok === true && pushed.v?.ok === true && pushed.v?.definition?.name === doc.name,
    JSON.stringify(pushed))
  if (pushed?.v?.ok !== true) return

  const before = session.frames.length
  // 18,000 RPM, scaled by this document's own `set.rpm` - the number LienCAM
  // computes and sends; the bridge never evaluates the scale itself.
  const on = await session.call('spindleOn', { direction: 'cw', setpointWord: 18000 })
  check(`  spindleOn at 18,000 RPM is accepted on a ${wordOrder} drive`,
    on?.ok === true, JSON.stringify(on))
  const seen = await waitForSessionSetpointWord(session, before, 18000)
  check(`  the bridge writes and reports 18,000 as this drive's register pair (${wordOrder})`,
    !!seen,
    JSON.stringify(session.frames.slice(before).filter((f) => f.t === 'vfd')
      .map((f) => f.v?.setpointWord).slice(-8)))

  const off = await session.call('spindleOff')
  check('  spindleOff is accepted, ungated as always', off?.ok === true, JSON.stringify(off))
  const stopped = await waitForSessionSetpointWord(session, session.frames.length, 0)
  check('  and the setpoint goes back to zero with it',
    !!stopped, JSON.stringify(session.frames.slice(-4).filter((f) => f.t === 'vfd')
      .map((f) => f.v?.setpointWord)))
}

async function vfdWideSetpointPhase() {
  console.log('\n-- WO-1736: a 32-bit speed setpoint, from its own definition --')
  if (!fakeInverter) {
    console.log('   (skipped: this phase needs --fake-inverter)')
    return
  }
  const operator = JSON.parse(readFileSync(new URL('./vfd/huanyang-gt.definition.json', import.meta.url), 'utf8'))

  // This bridge holds one control session, so connecting before the previous
  // phase's has finished closing is refused at the socket.
  await wait(300)
  const s = await openSession()

  await driveWideSetpoint(s, 'high-first', operator)
  await driveWideSetpoint(s, 'low-first', operator)

  // THE SAME SOCKET, THE SAME BINARY, THE OPERATOR'S OWN DOCUMENT: one register, and
  // 18,000 RPM is still 7,500 counts on his drive. A wide setpoint anywhere in
  // this file must not have widened his.
  const his = await s.call('applyVfdDefinition', { definition: operator })
  check("  the operator's one-register document is accepted unchanged",
    his?.ok === true && his.v?.ok === true, JSON.stringify(his))
  const before = s.frames.length
  const on = await s.call('spindleOn', { direction: 'cw', setpointWord: 7500 })
  check('  spindleOn at 18,000 RPM on his drive is accepted', on?.ok === true, JSON.stringify(on))
  check('  and the setpoint he has always written is the one reported',
    !!(await waitForSessionSetpointWord(s, before, 7500)),
    JSON.stringify(s.frames.slice(before).filter((f) => f.t === 'vfd')
      .map((f) => f.v?.setpointWord).slice(-8)))
  await s.call('spindleOff')

  const closed = await s.call('applyVfdDefinition', { definition: null })
  check('  the link closes like any other',
    closed?.ok === true && closed.v?.ok === true && closed.v?.definition === null, JSON.stringify(closed))
  s.close()
  await wait(300)
}
