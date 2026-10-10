// WO-1988: the Definition page's LinuxCNC facts (ControllerSetupSection's
// `gateway` branch, useMachineDefinitionPanel.tsx) read `linuxcncHello().vfd`
// and `status().joints` - this pins that those two contracts carry what the
// page needs, against the REAL gateway.py on its FAKE `linuxcnc` module
// (pendant/linuxcnc-gateway/testing/, measured on the WO-1982 LinuxCNC 2.9.4
// simulator), the same pattern WO-1987's own coverage uses.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ControllerEvents } from '../../lib/machine/controller'
import { LinuxcncGatewayTransport, linuxcncGatewayUrl } from '../../lib/machine/linuxcnc/gatewayTransport'
import { LinuxCncController } from '../../lib/machine/linuxcnc/linuxcncController'

const GATEWAY_DIR = resolve(__dirname, '../../../pendant/linuxcnc-gateway')
const FAKE_DIR = join(GATEWAY_DIR, 'testing')
const PYTHON = process.env.LIENCAM_PYTHON || (platform() === 'win32' ? 'python' : 'python3')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const running: ChildProcess[] = []
const controllers: LinuxCncController[] = []

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.disconnect()
  for (const p of running.splice(0)) p.kill()
})

function startGateway(env: Record<string, string> = {}): Promise<number> {
  const programDir = mkdtempSync(join(tmpdir(), 'wo1988-'))
  const proc = spawn(PYTHON, [join(GATEWAY_DIR, 'gateway.py'), '--port', '0', '--program-dir', programDir], {
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

async function connectController(env: Record<string, string> = {}) {
  const port = await startGateway(env)
  const events: ControllerEvents = {}
  const lcnc = new LinuxCncController(events)
  controllers.push(lcnc)
  await lcnc.connect({ kind: 'messages', transport: new LinuxcncGatewayTransport(linuxcncGatewayUrl(port)) })
  return lcnc
}

async function until(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('WO-1988 the Definition page reads LinuxCNC facts live, never invented', () => {
  it('REVIEW FIX: hello.vfd is the gateway constant, never a LinuxCNC spindle fact - capabilities.ownsSpindle is the real one', async () => {
    const lcnc = await connectController()
    await until('first status', () => lcnc.status().state !== 'unknown')
    // gateway.py hard-codes this block in every hello (never a real Modbus
    // reading) and never pushes an update - LINUXCNC-GATEWAY-PROTOCOL.md's
    // Pushes section: "No `vfd` push: LinuxCNC owns the spindle." A page must
    // not read `vfd.present === false` as "LinuxCNC has no spindle".
    expect(lcnc.linuxcncHello()?.vfd).toEqual({ present: false, verified: false, name: null })
    // The fact the gateway DOES report honestly: LinuxCNC owns its spindle.
    expect(lcnc.capabilities.ownsSpindle).toBe(true)
  })

  it('hello.vfd reads null when the gateway sends no vfd block at all - never guessed', () => {
    const lcnc = new LinuxCncController({})
    // linuxcncHello() itself reads null while disconnected (by design - "not
    // connected" is a different fact than "connected but silent"), so this
    // reaches the private parser directly, the same one handleMessage calls,
    // through a hello frame missing the field entirely (an older gateway).
    const withInternals = lcnc as unknown as {
      handleMessage: (message: unknown) => void
      hello: { vfd: unknown } | null
    }
    withInternals.handleMessage({
      t: 'hello',
      v: { protocol: 1, bridge: 'x', controller: 'linuxcnc', coordinates: 'XYZ', capabilities: {} },
    })
    expect(withInternals.hello?.vfd).toBeNull()
  })

  it('a slaved-gantry joint vector carries axis letters and live homed state, per joint', async () => {
    const lcnc = await connectController({ FAKE_LCNC_COORDINATES: 'XYYZ' })
    await until('first status', () => lcnc.status().state !== 'unknown')
    // Before homing: every joint reported, none homed - never invented as
    // homed, and never collapsed to one boolean per letter (ADR-0054 item 4).
    let joints = lcnc.status().joints
    expect(joints?.map((j) => j.axis)).toEqual(['X', 'Y', 'Y', 'Z'])
    expect(joints?.every((j) => j.homed === false)).toBe(true)

    expect(await lcnc.resetToIdle()).toMatchObject({ ok: true })
    expect(lcnc.homeAxes(['Z', 'X', 'Y'])).toBe(true)
    await until('homed', () => lcnc.homedThisSession() && lcnc.machineState() === 'idle')
    joints = lcnc.status().joints
    expect(joints?.every((j) => j.homed === true)).toBe(true)
    // Y is two joints behind one letter; the page's homing summary asks the
    // JogAxis-level map, which folds them, for exactly this reason.
    expect(lcnc.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
  })
})
