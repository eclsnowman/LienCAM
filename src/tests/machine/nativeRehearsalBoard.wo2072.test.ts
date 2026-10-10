// @vitest-environment node

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)
const KIT_SOURCE = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
const BUILD_SCRIPT = join(KIT_SOURCE, 'build.ps1')
const CHECK_SCRIPT = join(KIT_SOURCE, 'probe-check.mjs')
const BOARD_SOURCE = join(KIT_SOURCE, 'sim-board.example.json')
const KIT_OUTPUT = join(tmpdir(), 'liencam-native-rehearsal')
const EXE = join(KIT_OUTPUT, 'liencam-bridge-sim.exe')
const LOG = join(KIT_OUTPUT, 'liencam-bridge.log')
const CACHE = join(KIT_OUTPUT, 'liencam-bridge.definition.json')
const BOARD_RUNTIME = join(KIT_OUTPUT, 'sim-board.json')

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    wait(3_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

interface RunResult {
  status: number | null
  output: string
  log: string
}

async function runCheck(board: Record<string, unknown>): Promise<RunResult> {
  writeFileSync(BOARD_RUNTIME, `${JSON.stringify(board, null, 2)}\n`, 'utf8')
  rmSync(CACHE, { force: true })
  const offset = existsSync(LOG) ? statSync(LOG).size : 0
  const port = await freePort()
  if (port === 8325) throw new Error('the allocated port is the real machine bridge port')
  const child = spawn(EXE, ['--board', '-19', '--port', String(port)], {
    cwd: dirname(EXE),
    stdio: 'ignore',
    windowsHide: true,
  })
  const freshLog = () => existsSync(LOG)
    ? readFileSync(LOG).subarray(offset).toString('utf8')
    : ''
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !freshLog().includes(`listening on ws://127.0.0.1:${port}/`)) {
      if (child.exitCode !== null) break
      await wait(50)
    }
    if (!freshLog().includes(`listening on ws://127.0.0.1:${port}/`)) {
      throw new Error(`simulated bridge did not listen:\n${freshLog()}`)
    }
    const checked = spawnSync(process.execPath, [CHECK_SCRIPT, String(port)], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    })
    return {
      status: checked.status,
      output: `${checked.stdout ?? ''}${checked.stderr ?? ''}`,
      log: freshLog(),
    }
  } finally {
    await stop(child)
  }
}

describe('WO-2072 native rehearsal board matches measured machine PC probing', () => {
  it.skipIf(!existsSync(CSC))('builds the real bridge and reads every required behavior back from the simulated board', async () => {
    const build = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUILD_SCRIPT,
    ], { cwd: resolve('.'), encoding: 'utf8', timeout: 120_000 })
    expect(build).toContain(`exe      ${EXE}`)
    expect(existsSync(EXE)).toBe(true)

    const board = JSON.parse(readFileSync(BOARD_SOURCE, 'utf8')) as Record<string, unknown> & {
      boxes: Array<Record<string, unknown>>
    }

    // Negative control: the old model treated every box as conducting. Re-arm
    // that exact premise in the runtime copy only; the bare-X case must stop at
    // the separate anodized box and fail, proving the positive check is discriminating.
    const oldModel = structuredClone(board)
    const stock = oldModel.boxes.find((box) => box.name === 'anodized-stock')
    if (!stock) throw new Error('the anodized-stock box is missing')
    stock.conducting = true
    const negative = await runCheck(oldModel)
    expect(negative.status).toBe(1)
    expect(negative.output).toContain('FAIL  X+ bare anodized face -> NO contact')
    expect(negative.log).toMatch(/probe CONTACT 'anodized-stock' on X at X 198\.413/)
    expect(negative.log).not.toContain("PUSHED 'anodized-stock'")

    // Restore the committed board into the runtime path before the proof run.
    copyFileSync(BOARD_SOURCE, BOARD_RUNTIME)
    const positive = await runCheck(board)
    expect(positive.status, positive.output).toBe(0)
    expect(positive.output).toContain('37 passed, 0 failed')
    expect(positive.log).toMatch(/tipRadius 1\.588/)
    expect(positive.log).toMatch(/box 'anodized-stock'.*NON-CONDUCTING/)
    expect(positive.log).toMatch(/probe CONTACT 'top-pad' on Z .* Z 46\.940 at 300\.000 mm\/min/)
    expect(positive.log).toMatch(/probe CONTACT 'x-plus-pad' on X at X 195\.253 .* at 300\.000 mm\/min/)
    expect(positive.log).toMatch(/PUSHED 'anodized-stock' 65\.000 mm on X at 300\.000 mm\/min/)
    expect(positive.log).toMatch(/probe on X reached its target 263\.413 with NO contact/)
    expect(positive.log).toMatch(/probe CONTACT 'setter' on Z .* Z 48\.203 at 300\.000 mm\/min/)
    expect(positive.log).toMatch(/probe CONTACT 'setter' on Z .* Z 48\.263 at 50\.000 mm\/min/)

    const committedBoxes = JSON.parse(readFileSync(BOARD_SOURCE, 'utf8')).boxes
    const committedStock = committedBoxes.find((box: { name?: string }) => box.name === 'stock')
    const anodizedTestBox = committedBoxes.find((box: { name?: string }) => box.name === 'anodized-stock')
    expect(committedStock?.conducting).toBe(true)
    expect(anodizedTestBox?.conducting).toBe(false)
  }, 360_000)
})
