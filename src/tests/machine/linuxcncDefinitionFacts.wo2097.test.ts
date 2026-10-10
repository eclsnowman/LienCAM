// WO-2097: the gateway reads the facts in LinuxCNC's own config - each axis'
// [AXIS_<L>] MIN_LIMIT / MAX_LIMIT / MAX_VELOCITY, [SPINDLE_<n>]'s RPM range
// and the running HAL's links for the standard probe / E-STOP / coolant /
// spindle pins - and sends them in its hello (`config`), which
// LinuxCncController parses for the Definition page.
//
//  - Unit: the REAL gateway.py on its FAKE `linuxcnc` module and FAKE halcmd
//    (pendant/linuxcnc-gateway/testing/), over a real WebSocket.
//  - Tier 2: the REAL gateway.py inside the WO-1982 LinuxCNC 2.9.4 simulator
//    on the Spark (stock sim/axis/axis_mm.ini, real halcmd), reached over a
//    real WebSocket through `ssh spark docker exec` relaying the gateway's
//    loopback port - the production LinuxCncController on the far end.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { hostname, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LinuxcncGatewayTransport, linuxcncGatewayUrl } from '../../lib/machine/linuxcnc/gatewayTransport'
import { LinuxCncController, type LinuxcncConfig } from '../../lib/machine/linuxcnc/linuxcncController'
import { LCNC_SIM_CONTAINER, LCNC_SIM_TURN_WAIT_MS, takeSimulatorTurn, type SimulatorTurn } from '../support/lcncSimLock'

const GATEWAY_DIR = resolve(__dirname, '../../../pendant/linuxcnc-gateway')
const FAKE_DIR = join(GATEWAY_DIR, 'testing')
const EVIDENCE_DIR = resolve(__dirname, '../evidence/WO-2097')
const PYTHON = process.env.LIENCAM_PYTHON || (platform() === 'win32' ? 'python' : 'python3')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const running: ChildProcess[] = []
const controllers: LinuxCncController[] = []
const servers: Server[] = []
const cleanups: (() => void)[] = []

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.disconnect()
  for (const p of running.splice(0)) p.kill()
  for (const s of servers.splice(0)) s.close()
  for (const f of cleanups.splice(0)) f()
})

const INI = `[TRAJ]
COORDINATES = X Y Z
LINEAR_UNITS = mm
ANGULAR_UNITS = degree

[AXIS_X]
MAX_VELOCITY = 30.48
MIN_LIMIT = -254
MAX_LIMIT = 254

[AXIS_Y]
MAX_VELOCITY = 25
MIN_LIMIT = 0
MAX_LIMIT = 610

[AXIS_Z]
MAX_VELOCITY = 15
MIN_LIMIT = -110
MAX_LIMIT = 0

[SPINDLE_0]
MAX_FORWARD_VELOCITY = 24000
MIN_FORWARD_VELOCITY = 6000
`

function startGateway(env: Record<string, string>, halcmd = join(FAKE_DIR, 'halcmd.py')): Promise<number> {
  const programDir = mkdtempSync(join(tmpdir(), 'wo2097-'))
  const proc = spawn(PYTHON, [join(GATEWAY_DIR, 'gateway.py'), '--port', '0', '--program-dir', programDir, '--halcmd', halcmd], {
    env: { ...process.env, PYTHONPATH: FAKE_DIR, PYTHONDONTWRITEBYTECODE: '1', ...env },
    windowsHide: true,
  })
  running.push(proc)
  let err = ''
  proc.stderr!.on('data', (d) => (err += String(d)))
  return new Promise((ok, bad) => {
    let out = ''
    const timer = setTimeout(() => bad(new Error(`gateway did not start: ${err}`)), 10_000)
    proc.stdout!.on('data', (d) => {
      out += String(d)
      if (!out.includes('\n')) return
      clearTimeout(timer)
      ok(JSON.parse(out.split(/\r?\n/)[0]).listening)
    })
    proc.on('exit', (code) => bad(new Error(`gateway exited ${code}: ${err}`)))
  })
}

async function connectAt(port: number): Promise<LinuxCncController> {
  const lcnc = new LinuxCncController({})
  controllers.push(lcnc)
  await lcnc.connect({ kind: 'messages', transport: new LinuxcncGatewayTransport(linuxcncGatewayUrl(port)) })
  return lcnc
}

function iniFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'wo2097-ini-')), 'machine.ini')
  writeFileSync(path, INI)
  return path
}

function pin(config: LinuxcncConfig, name: string) {
  return config.io.pins.find((p) => p.pin === name)
}

describe('WO-2097 the gateway sends LinuxCNC\'s INI/HAL facts in its hello', () => {
  it('each axis\' INI limits and max velocity, the [SPINDLE_0] RPM range and the HAL I/O links', async () => {
    const lcnc = await connectAt(await startGateway({ FAKE_LCNC_INI: iniFile() }))
    const config = lcnc.linuxcncHello()?.config
    expect(config).toBeTruthy()
    expect(config!.linearUnits).toBe('mm')
    expect(config!.axes).toEqual([
      { axis: 'X', units: 'mm', minLimit: '-254', maxLimit: '254', maxVelocity: '30.48' },
      { axis: 'Y', units: 'mm', minLimit: '0', maxLimit: '610', maxVelocity: '25' },
      { axis: 'Z', units: 'mm', minLimit: '-110', maxLimit: '0', maxVelocity: '15' },
    ])
    expect(config!.spindles).toEqual([{
      spindle: 0,
      maxForwardVelocity: '24000',
      minForwardVelocity: '6000',
      maxReverseVelocity: null,
      minReverseVelocity: null,
    }])
    expect(config!.io.read).toBe(true)
    expect(pin(config!, 'motion.probe-input')).toMatchObject({
      group: 'probe', inHal: true, dir: 'IN', signal: 'probe-in', linked: [{ arrow: '<==', pin: 'parport.0.pin-15-in' }],
    })
    expect(pin(config!, 'iocontrol.0.emc-enable-in')).toMatchObject({
      group: 'estop', signal: 'estop-loop', linked: [{ arrow: '<==', pin: 'iocontrol.0.user-enable-out' }],
    })
    expect(pin(config!, 'iocontrol.0.coolant-flood')).toMatchObject({ group: 'coolant', dir: 'OUT', signal: 'flood' })
    expect(pin(config!, 'spindle.0.on')).toMatchObject({ group: 'spindle', inHal: true, signal: null, linked: [] })
    expect(pin(config!, 'spindle.0.speed-out')?.linked).toEqual([
      { arrow: '==>', pin: 'limit_speed.in' },
      { arrow: '==>', pin: 'near_speed.in1' },
    ])
  })

  it('an INI that sets none of them reads as unset - never a guessed value', async () => {
    const lcnc = await connectAt(await startGateway({}))
    const config = lcnc.linuxcncHello()!.config!
    expect(config.axes.map((a) => [a.axis, a.minLimit, a.maxLimit, a.maxVelocity])).toEqual([
      ['X', null, null, null], ['Y', null, null, null], ['Z', null, null, null],
    ])
    expect(config.spindles).toEqual([{
      spindle: 0, maxForwardVelocity: null, minForwardVelocity: null, maxReverseVelocity: null, minReverseVelocity: null,
    }])
  })

  it('when halcmd cannot read the HAL, the hello still arrives and says why', async () => {
    const lcnc = await connectAt(await startGateway({ FAKE_LCNC_INI: iniFile(), FAKE_HALCMD_FAIL: 'HAL: ERROR: rtapi init failed' }))
    const config = lcnc.linuxcncHello()!.config!
    expect(config.axes[0]).toMatchObject({ axis: 'X', minLimit: '-254' })
    expect(config.io).toEqual({
      read: false,
      error: 'halcmd could not read the running HAL: HAL: ERROR: rtapi init failed',
      pins: [],
    })
  })

  it('a hello with no config block (an older gateway) parses as null, not as an empty machine', () => {
    const lcnc = new LinuxCncController({})
    const internals = lcnc as unknown as { handleMessage: (m: unknown) => void; hello: { config: unknown } | null }
    internals.handleMessage({ t: 'hello', v: { protocol: 1, bridge: 'x', controller: 'linuxcnc', coordinates: 'XYZ', capabilities: {} } })
    expect(internals.hello?.config).toBeNull()
  })
})

// ---------------------------------------------------------------- Tier 2
const CONTAINER = LCNC_SIM_CONTAINER
const localSpark = platform() === 'linux' && hostname().startsWith('spark-')
const sshHost = process.env.LIENCAM_LCNC_HOST || 'spark'
const SIM_PORT = 8397
/** Record the measurements into src/tests/evidence/WO-2097/ (never on a gate run). */
const WRITE_EVIDENCE = process.env.WO2097_WRITE_EVIDENCE === '1'

function simArgv(command: string): [string, string[]] {
  return localSpark
    ? ['sh', ['-c', command]]
    : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, command]]
}

function sim(command: string, input?: string, timeout = 30_000) {
  const [cmd, args] = simArgv(command)
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout, windowsHide: true })
}

const simReachable =
  process.env.LIENCAM_LCNC_TIER2 !== '0' &&
  sim(`docker inspect --format '{{.State.Running}}' ${CONTAINER}`, undefined, 20_000).stdout?.trim() === 'true'

/** A stdin/stdout <-> 127.0.0.1:<port> pipe, run inside the container. */
const RELAY = `import os, socket, sys, threading
s = socket.create_connection(('127.0.0.1', int(sys.argv[1])))
def up():
    while True:
        d = os.read(0, 65536)
        if not d:
            break
        s.sendall(d)
    s.shutdown(socket.SHUT_WR)
threading.Thread(target=up, daemon=True).start()
while True:
    d = s.recv(65536)
    if not d:
        break
    os.write(1, d)
`

/** A local loopback port whose every connection is piped to the gateway's
 *  loopback port inside the simulator container. */
function relayPort(): Promise<number> {
  const server = createServer((socket) => {
    const [cmd, args] = simArgv(`docker exec -i ${CONTAINER} python3 /tmp/wo2097/relay.py ${SIM_PORT}`)
    const pipe = spawn(cmd, args, { windowsHide: true })
    running.push(pipe)
    // Teardown closes either end first; a write into the other is expected.
    pipe.stdin.on('error', () => {})
    socket.on('error', () => {})
    socket.pipe(pipe.stdin)
    pipe.stdout.pipe(socket)
    socket.on('close', () => pipe.kill())
    pipe.on('exit', () => socket.destroy())
  })
  servers.push(server)
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)))
}

function upload(files: Record<string, string>): void {
  for (const [file, body] of Object.entries(files)) {
    const put = sim(`docker exec -i ${CONTAINER} sh -c 'mkdir -p /tmp/wo2097/p && cat > /tmp/wo2097/${file}'`, body.replace(/\r\n/g, '\n'))
    expect(put.status, put.stderr).toBe(0)
  }
}

describe('WO-2097 Tier 2 - the facts from the real LinuxCNC simulator (WO-1982)', () => {
  if (!simReachable) console.warn(`WO-2097 Tier 2 skipped: ${CONTAINER} is not running or not reachable`)
  // WO-2312: one file at a time on the one simulator (src/tests/support/lcncSimLock.ts);
  // afterEach's cleanups stop this file's gateway before afterAll ends the turn.
  let simTurn: SimulatorTurn | null = null
  beforeAll(async () => { if (simReachable) simTurn = await takeSimulatorTurn('linuxcncDefinitionFacts.wo2097') }, LCNC_SIM_TURN_WAIT_MS)
  afterAll(async () => { await simTurn?.release() })

  it.skipIf(!simReachable)(
    'the production controller, over a real WebSocket to the real gateway, reads axis_mm.ini and the running HAL',
    async () => {
      upload({ 'gateway.py': readFileSync(join(GATEWAY_DIR, 'gateway.py'), 'utf8'), 'relay.py': RELAY })
      sim(`docker exec ${CONTAINER} pkill -f /tmp/wo2097/gateway.py`)
      const started = sim(
        `docker exec -d ${CONTAINER} sh -c 'python3 /tmp/wo2097/gateway.py --port ${SIM_PORT} --program-dir /tmp/wo2097/p > /tmp/wo2097/gateway.log 2>&1'`,
      )
      expect(started.status, started.stderr).toBe(0)
      cleanups.push(() => { sim(`docker exec ${CONTAINER} pkill -f /tmp/wo2097/gateway.py`) })
      let listening = false
      for (let i = 0; i < 40 && !listening; i++) {
        listening = sim(`docker exec ${CONTAINER} grep -q listening /tmp/wo2097/gateway.log`).status === 0
        if (!listening) await sleep(250)
      }
      expect(listening, sim(`docker exec ${CONTAINER} cat /tmp/wo2097/gateway.log`).stdout).toBe(true)

      const lcnc = await connectAt(await relayPort())
      const hello = lcnc.linuxcncHello()!
      const config = hello.config!
      if (WRITE_EVIDENCE) writeFileSync(join(EVIDENCE_DIR, 'tier2-sim-hello.json'), `${JSON.stringify({
        measured: new Date().toISOString(),
        route: 'LinuxCncController -> WebSocket -> ssh/docker relay -> gateway.py in liencam-linuxcnc-sim (LinuxCNC 2.9.4)',
        linuxcncVersion: hello.linuxcncVersion,
        ini: hello.ini,
        config,
      }, null, 1)}\n`)

      expect(hello.linuxcncVersion).toBe('2.9.4')
      expect(config.ini).toMatch(/sim\/axis\/axis_mm\.ini$/)
      // axis_mm.ini, as LinuxCNC runs it: [AXIS_X]/[AXIS_Y] +/-254 at 30.48,
      // [AXIS_Z] -50.8..101.6 at 30.48, mm.
      expect(config.axes).toEqual([
        { axis: 'X', units: 'mm', minLimit: '-254', maxLimit: '254', maxVelocity: '30.48' },
        { axis: 'Y', units: 'mm', minLimit: '-254', maxLimit: '254', maxVelocity: '30.48' },
        { axis: 'Z', units: 'mm', minLimit: '-50.8', maxLimit: '101.6', maxVelocity: '30.48' },
      ])
      // axis_mm.ini has no [SPINDLE_0] section: unset, not invented.
      expect(config.spindles).toEqual([{
        spindle: 0, maxForwardVelocity: null, minForwardVelocity: null, maxReverseVelocity: null, minReverseVelocity: null,
      }])
      // The running HAL (core_sim.hal, sim_spindle_encoder.hal, cooling.hal),
      // measured with halcmd -s show pin|sig on the same simulator.
      expect(config.io.read, config.io.error ?? '').toBe(true)
      expect(pin(config, 'iocontrol.0.emc-enable-in')).toMatchObject({
        inHal: true, dir: 'IN', signal: 'estop-loop', linked: [{ arrow: '<==', pin: 'iocontrol.0.user-enable-out' }],
      })
      expect(pin(config, 'iocontrol.0.coolant-flood')).toMatchObject({ signal: 'flood', linked: [{ arrow: '==>', pin: 'and2.0.in0' }] })
      expect(pin(config, 'iocontrol.0.coolant-mist')).toMatchObject({ signal: 'mist', linked: [{ arrow: '==>', pin: 'and2.0.in1' }] })
      expect(pin(config, 'spindle.0.speed-out')).toMatchObject({ dir: 'OUT', signal: 'spindle-speed-cmd' })
      expect(pin(config, 'spindle.0.at-speed')).toMatchObject({ dir: 'IN', signal: 'spindle-at-speed' })
      // The stock sim wires no probe: the pin exists, on no signal.
      expect(pin(config, 'motion.probe-input')).toMatchObject({ inHal: true, dir: 'IN', signal: null, linked: [] })
    },
    120_000,
  )

  it.skipIf(!simReachable)(
    'LinuxCNC\'s own ini reader gives the [SPINDLE_0] RPM range from a copy of axis_mm.ini that sets one',
    () => {
      upload({ 'gateway.py': readFileSync(join(GATEWAY_DIR, 'gateway.py'), 'utf8') })
      const script = [
        'import json, sys',
        "sys.path.insert(0, '/tmp/wo2097')",
        'import gateway, linuxcnc',
        's = linuxcnc.stat(); s.poll()',
        "text = open(s.ini_filename).read() + '\\n[SPINDLE_0]\\nMAX_FORWARD_VELOCITY = 24000\\nMIN_FORWARD_VELOCITY = 6000\\n'",
        "path = '/tmp/wo2097/spindle.ini'",
        "open(path, 'w').write(text)",
        'print(json.dumps(gateway.Lcnc(linuxcnc, path).read_config()))',
      ].join('\n')
      const run = sim(`docker exec -i ${CONTAINER} python3 -`, script, 60_000)
      expect(run.status, run.stderr).toBe(0)
      const config = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)!)
      if (WRITE_EVIDENCE) writeFileSync(join(EVIDENCE_DIR, 'tier2-sim-spindle-ini.json'), `${JSON.stringify({
        measured: new Date().toISOString(),
        route: 'gateway.Lcnc.read_config() with LinuxCNC 2.9.4 linuxcnc.ini, in liencam-linuxcnc-sim',
        spindles: config.spindles,
      }, null, 1)}\n`)
      expect(config.spindles).toEqual([{
        spindle: 0, MAX_FORWARD_VELOCITY: '24000', MIN_FORWARD_VELOCITY: '6000', MAX_REVERSE_VELOCITY: null, MIN_REVERSE_VELOCITY: null,
      }])
    },
    90_000,
  )
})
