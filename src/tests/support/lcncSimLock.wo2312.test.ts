// WO-2312: the simulator lock the real-LinuxCNC Tier 2 files take turns on
// (lcncSimLock.ts / lcnc_sim_lock.py), against the real container on the
// Spark. Every case uses its own lock file, never the one the Tier 2 files
// hold, so this file can run while a gate is using the simulator.

import { spawn, spawnSync } from 'node:child_process'
import { hostname, platform } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LCNC_SIM_CONTAINER, takeSimulatorTurn, type SimulatorTurn } from './lcncSimLock'

const localSpark = platform() === 'linux' && hostname().startsWith('spark-')
const sshHost = process.env.LIENCAM_LCNC_HOST || 'spark'
const reachable = process.env.LIENCAM_LCNC_TIER2 !== '0' && (() => {
  const command = `docker inspect --format '{{.State.Running}}' ${LCNC_SIM_CONTAINER}`
  const r = localSpark
    ? spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 20_000 })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, command], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  return r.stdout?.trim() === 'true'
})()

const lockFile = (name: string) => `/tmp/liencam-sim-lock/wo2312-test-${name}-${process.pid}.lock`
const turns: SimulatorTurn[] = []
afterEach(async () => { for (const t of turns.splice(0)) await t.release() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!reachable)('WO-2312 one holder at a time on the LinuxCNC simulator', () => {
  it('a second turn waits for the first to end, and knows who it waited for', async () => {
    const file = lockFile('order')
    const first = await takeSimulatorTurn('wo2312-first', { lockFile: file })
    turns.push(first)
    expect(first.waitedFor).toBeNull()
    let secondHeld = false
    const second = takeSimulatorTurn('wo2312-second', { lockFile: file }).then((t) => { secondHeld = true; turns.push(t); return t })
    await sleep(2500)
    expect(secondHeld).toBe(false)
    await first.release()
    const held = await second
    expect(held.waitedMs).toBeGreaterThanOrEqual(2000)
    expect(held.waitedFor).toMatch(/^wo2312-first pid \d+ on /)
  }, 60_000)

  it('a holder that dies without releasing leaves nothing locked', async () => {
    const file = lockFile('killed')
    // A raw holder, then its client killed outright - the way a test process
    // killed by a timeout or a gate's teardown ends.
    // takeSimulatorTurn uploads lock.py; take and end one turn first so it is there.
    await (await takeSimulatorTurn('wo2312-upload', { lockFile: lockFile('upload') })).release()
    const command = `docker exec -i ${LCNC_SIM_CONTAINER} python3 -u /tmp/liencam-sim-lock/lock.py ${file} 'wo2312-killed'`
    const raw = localSpark
      ? spawn('docker', ['exec', '-i', LCNC_SIM_CONTAINER, 'python3', '-u', '/tmp/liencam-sim-lock/lock.py', file, 'wo2312-killed'])
      : spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, command], { windowsHide: true })
    await new Promise<void>((ok) => raw.stdout.on('data', (d) => { if (String(d).includes('HELD')) ok() }))
    raw.kill('SIGKILL')
    const t0 = Date.now()
    const after = await takeSimulatorTurn('wo2312-after', { lockFile: file, waitMs: 30_000 })
    turns.push(after)
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 60_000)

  it('a turn that cannot start in time says who holds the simulator', async () => {
    const file = lockFile('busy')
    turns.push(await takeSimulatorTurn('wo2312-holder', { lockFile: file }))
    await expect(takeSimulatorTurn('wo2312-late', { lockFile: file, waitMs: 3000 }))
      .rejects.toThrow(/the LinuxCNC simulator stayed busy for 3 s, held by wo2312-holder pid \d+ on /)
  }, 60_000)
})
