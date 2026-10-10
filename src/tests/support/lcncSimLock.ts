// WO-2312: the real-LinuxCNC Tier 2 files take turns on the one WO-1982
// simulator (liencam-linuxcnc-sim on the Spark).
//
// There is ONE LinuxCNC in that container. Each Tier 2 file starts its own
// gateway in it, homes it, runs programs, nets motion.probe-input
// (sim_part.py) and kills its own fixtures by pattern - and a gateway whose
// socket closes aborts LinuxCNC. Two files at once (two forks of one run, or a
// gate on the Spark and a run from the dev box over ssh) broke each other:
// measured 2026-10-01, src/tests/evidence/WO-2312/contention-live.txt.
//
// A turn is an exclusive flock held by lcnc_sim_lock.py INSIDE the container,
// so every route to the simulator (Spark-local docker or ssh from another
// computer) contends for the same lock. The lock lives exactly as long as the
// holder's stdin: release() closes it, and a test process that dies closes it
// too - nothing is left locked and there is no stale-lock timeout to guess.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { resolve } from 'node:path'

/** The simulator's container; LIENCAM_LCNC_CONTAINER names another one, as
 *  tools/lcnc-sim/spark-start.sh takes it (a second instance to measure on). */
export const LCNC_SIM_CONTAINER = process.env.LIENCAM_LCNC_CONTAINER || 'liencam-linuxcnc-sim'
/** How long a file waits for the files ahead of it. The whole machine slice's
 *  Tier 2 work, back to back, is a few minutes; this is a queue wait, never a
 *  test's own timeout. Pass it as the beforeAll hook's timeout. */
export const LCNC_SIM_TURN_WAIT_MS = 20 * 60_000
export const LCNC_SIM_LOCK_FILE = '/tmp/liencam-sim.lock'

const REMOTE_DIR = '/tmp/liencam-sim-lock'
const SCRIPT = resolve(__dirname, 'lcnc_sim_lock.py')
const localSpark = platform() === 'linux' && hostname().startsWith('spark-')
const sshArgs = () => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', process.env.LIENCAM_LCNC_HOST || 'spark']

function hostCommand(command: string, input?: string) {
  const [cmd, args] = localSpark ? ['sh', ['-c', command]] as const : ['ssh', [...sshArgs(), command]] as const
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 30_000, windowsHide: true })
}

export interface SimulatorTurn {
  /** ms spent waiting for other holders. */
  waitedMs: number
  /** Who held the simulator when this turn started waiting, or null if it was free. */
  waitedFor: string | null
  release(): Promise<void>
}

export interface TurnOptions { waitMs?: number; lockFile?: string }

/** Wait for the simulator, then hold it until release(). `label` names the
 *  holder to anyone who has to wait (file name; pid and host are added). */
export async function takeSimulatorTurn(label: string, options: TurnOptions = {}): Promise<SimulatorTurn> {
  const waitMs = options.waitMs ?? LCNC_SIM_TURN_WAIT_MS
  const lockFile = options.lockFile ?? LCNC_SIM_LOCK_FILE
  const holder = `${label} pid ${process.pid} on ${hostname()}`.replace(/[^\w .:@/-]/g, '_')
  const upload = hostCommand(
    `docker exec -i ${LCNC_SIM_CONTAINER} sh -c 'mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_DIR}/lock.py.$$ && mv -f ${REMOTE_DIR}/lock.py.$$ ${REMOTE_DIR}/lock.py'`,
    readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'),
  )
  if (upload.status !== 0) throw new Error(`could not put the simulator lock in ${LCNC_SIM_CONTAINER}: ${upload.stderr || upload.error}`)

  const command = `docker exec -i ${LCNC_SIM_CONTAINER} python3 -u ${REMOTE_DIR}/lock.py ${lockFile} '${holder}'`
  const child: ChildProcess = localSpark
    ? spawn('docker', ['exec', '-i', LCNC_SIM_CONTAINER, 'python3', '-u', `${REMOTE_DIR}/lock.py`, lockFile, holder], { windowsHide: true })
    : spawn('ssh', [...sshArgs(), command], { windowsHide: true })
  const t0 = Date.now()
  let waitedFor: string | null = null
  let err = ''
  child.stderr!.on('data', (d) => (err += String(d)))
  const exited = new Promise<void>((done) => child.once('exit', () => done()))

  await new Promise<void>((held, refused) => {
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      refused(new Error(`the LinuxCNC simulator stayed busy for ${Math.round(waitMs / 1000)} s, held by ${waitedFor ?? 'an unnamed holder'}`))
    }, waitMs)
    child.stdout!.on('data', (d) => {
      out += String(d)
      for (const line of out.split(/\r?\n/).slice(0, -1)) {
        if (line.startsWith('WAITING ')) waitedFor = line.slice('WAITING '.length)
        if (line === 'HELD') { clearTimeout(timer); held() }
      }
      out = out.slice(out.lastIndexOf('\n') + 1)
    })
    child.once('exit', (code) => { clearTimeout(timer); refused(new Error(`the simulator lock exited ${code} before it was held: ${err}`)) })
  })

  const waitedMs = Date.now() - t0
  if (waitedFor) console.info(`WO-2312: ${label} waited ${waitedMs} ms for the LinuxCNC simulator (held by ${waitedFor})`)
  let released = false
  return {
    waitedMs,
    waitedFor,
    async release() {
      if (released) return
      released = true
      child.stdin!.end()
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))])
      if (!gone) child.kill()
    },
  }
}
