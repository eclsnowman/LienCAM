// @vitest-environment node

/**
 * WO-2215: under a rotated work offset the app's bookkeeping of machine-frame
 * moves - the path check and the typed-command end row - states those moves in
 * the work frame the controller reports (docs/design/WCS-ROTATION.md:
 * work = Rot(-R)(machine - O)).
 *
 * The 09-29 rotation rehearsal (.planning/rehearsal-2026-09-29-rotation,
 * G55 = X400 Y400 Z60 rotated 30 deg) measured every move correct and two
 * console defects on them:
 *   F1: G30, G28, G53 XY, Park 1-4 and the tool-change macro printed
 *       "Path check: THE MACHINE LEFT THE COMMANDED PATH ... 234.28 mm off".
 *   F2: "MDI G30 ... ending at G55 X 338 Y 324.5" (true X 454.9666 Y 112.0252)
 *       and "MDI G0 X0 Y20 ... (machine X 400 Y 420)" (true X 390 Y 417.3205).
 *
 * The first block pins the arithmetic (reader, path check - including an
 * injected real deviation that must still go red). The last test is the
 * rehearsal's own route: the REAL bridge (Bridge.cs, Machine.cs, Json.cs,
 * Vfd.cs) built against the native kit's simulated board, driven by the
 * PRODUCTION session (`connectMachine('bridge')`, `sendMdiLine`,
 * `runUserMacro`), at 30 deg and at 0 deg.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MachineMacro } from '../../types'
import { readGcodeProgram, type GcodeReaderOptions } from '../../lib/gcode/reader'
import { analysePathFidelity, type PathFidelitySample } from '../../lib/machine/pathFidelity'
import type { QueuedMove } from '../../lib/machine/controller'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

/** The rehearsal's G55 and angle. */
const G55 = { x: 400, y: 400, z: 60 }
const ANGLE = 30

function rot(deg: number, x: number, y: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}
/** What the controller reports in G55 at a machine XY. */
const machineToWork = (deg: number, x: number, y: number) => rot(-deg, x - G55.x, y - G55.y)

const REFERENCE = { 1: { x: 738, y: 724.5, z: 128 } } as const
const HOME = { x: 738, y: 724.5, z: 128.9 }

function read(text: string, rotationDeg?: number, initial = { x: 0, y: 0, z: 40 }) {
  const options: GcodeReaderOptions = {
    dialect: 'uccnc',
    sessionWcs: 'G55',
    initialPosition: initial,
    machineUnits: 'mm',
    workOffsets: { G55: { ...G55, ...(rotationDeg === undefined ? {} : { rotationDeg }) }, G54: { x: 0, y: 0, z: 0 } },
    referencePositions: REFERENCE,
    machineHome: HOME,
  }
  const result = readGcodeProgram(text, options)
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.program.moves
}

describe('WO-2215 the reader states a machine point in the rotated work frame', () => {
  it('G30: the XY leg ends at Rot(-R)(P1 - O) - the G55 X/Y the DRO shows', () => {
    const moves = read('G21 G90\nG30', ANGLE)
    const last = moves[moves.length - 1]
    const want = machineToWork(ANGLE, 738, 724.5)
    expect(last.x).toBeCloseTo(454.9666, 4)
    expect(last.y).toBeCloseTo(112.0252, 4)
    expect(Math.hypot(last.x - want.x, last.y - want.y)).toBeLessThan(1e-9)
    // The move itself is untouched: still a machine target.
    expect(last.machineAbsolute).toEqual({ x: 738, y: 724.5 })
  })

  it('G28 and G53 X Y land on the same turned work point; the machine target is unchanged', () => {
    const g28 = read('G21 G90\nG28', ANGLE)
    const home = g28[g28.length - 1]
    const wantHome = machineToWork(ANGLE, HOME.x, HOME.y)
    expect(Math.hypot(home.x - wantHome.x, home.y - wantHome.y)).toBeLessThan(1e-9)
    expect(home.z).toBeCloseTo(HOME.z - G55.z, 9)
    // WO-2596: G28 goes home one axis per rapid in the homing order (Z, X, Y);
    // each leg names only its own axis as a machine target, together all of HOME.
    expect(g28.slice(-3).map((m) => m.machineAbsolute)).toEqual([{ z: HOME.z }, { x: HOME.x }, { y: HOME.y }])

    const g53 = read('G21 G90\nG53 G0 X100 Y600', ANGLE)[0]
    const want = machineToWork(ANGLE, 100, 600)
    expect(Math.hypot(g53.x - want.x, g53.y - want.y)).toBeLessThan(1e-9)
    expect(g53.machineAbsolute).toEqual({ x: 100, y: 600 })
  })

  it('G53 X alone: machine Y holds, so work X AND Y both move, and both are placed', () => {
    // From G55 X0 Y20 (machine 390, 417.3205 at 30 deg) to machine X 500.
    const moves = read('G21 G90\nG53 G0 X500', ANGLE, { x: 0, y: 20, z: 40 })
    const heldY = G55.y + rot(ANGLE, 0, 20).y
    const want = machineToWork(ANGLE, 500, heldY)
    expect(Math.hypot(moves[0].x - want.x, moves[0].y - want.y)).toBeLessThan(1e-9)
    expect(moves[0].executionAxes).toEqual(expect.arrayContaining(['x', 'y']))
  })

  it('unrotated (absent or 0): exactly the old arithmetic - machine less offset per named axis', () => {
    for (const rotationDeg of [undefined, 0]) {
      const g30 = read('G21 G90\nG30', rotationDeg)
      expect(g30[g30.length - 1]).toMatchObject({ x: 738 - 400, y: 724.5 - 400, z: 128 - 60 })
      const g53 = read('G21 G90\nG53 G0 X500', rotationDeg, { x: 0, y: 20, z: 40 })[0]
      expect(g53).toMatchObject({ x: 500 - 400, y: 20, z: 40 })
      expect(g53.executionAxes).toEqual(['x'])
    }
  })

  it('a frame change out of a rotated G55 carries the same physical point', () => {
    // G55 X10 Y0 at 30 deg is machine (408.6603, 405); G54 is the machine frame.
    const moves = read('G21 G90\nG0 X10 Y0\nG54\nG0 Z41', ANGLE)
    const last = moves[moves.length - 1]
    const m = rot(ANGLE, 10, 0)
    expect(last.x).toBeCloseTo(G55.x + m.x, 9)
    expect(last.y).toBeCloseTo(G55.y + m.y, 9)
  })
})

describe('WO-2215 the path check scores a rotated frame by its origin, and still catches a real departure', () => {
  // A G53 X Y move from machine (400, 400) to (738, 724.5) at 30 deg, as the
  // session arms it: a work-frame line to the reader's (now turned) work point.
  const endWork = machineToWork(ANGLE, 738, 724.5)
  const moves: QueuedMove[] = [{ id: 1, kind: 'line', to: { x: endWork.x, y: endWork.y, z: 68 }, feedMmMin: 5000, rapid: true }]
  const samplesFor = (offPathMm: number, rotated = true): PathFidelitySample[] => {
    const out: PathFidelitySample[] = []
    const n = 80
    for (let i = 0; i <= n; i++) {
      const t = i / n
      // Off the path in the middle 40 frames, sideways in machine Y.
      const off = i > 20 && i < 60 ? offPathMm : 0
      const machine = { x: 400 + t * 338, y: 400 + t * 324.5 + off, z: 128 }
      const work = machineToWork(ANGLE, machine.x, machine.y)
      out.push({
        atMs: 1_000 + i * 33,
        machinePos: machine,
        workPos: { x: work.x, y: work.y, z: 68 },
        executingMoveId: 1,
        ...(rotated ? { workRotationDeg: ANGLE } : {}),
      })
    }
    return out
  }
  const analyse = (samples: PathFidelitySample[]) => analysePathFidelity({
    moves,
    startPos: { x: 0, y: 0, z: 68 },
    samples,
    reportsExecutingMoveId: true,
    toleranceMm: 0.03,
    commandedFrame: 'work',
    workFrame: 'G55',
  })

  it('a correct machine-frame move at 30 deg is clean, worst 0.000 mm', () => {
    const report = analyse(samplesFor(0))
    expect(report.verdict, report.headline).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-6)
    // The evidence row names the G55 origin, not machine - work.
    expect(report.evidence?.[40].activeOffset?.x).toBeCloseTo(G55.x, 9)
    expect(report.evidence?.[40].activeOffset?.y).toBeCloseTo(G55.y, 9)
  })

  it('NEGATIVE CONTROL: the same move flown 5 mm off the path still goes red', () => {
    const report = analyse(samplesFor(5))
    expect(report.verdict, report.headline).toBe('divergence')
    // 5 mm along machine Y is 5 x 338 / |(338, 324.5)| = 3.607 mm off the line.
    expect(report.worst!.deviationMm).toBeCloseTo(5 * 338 / Math.hypot(338, 324.5), 3)
  })

  it('frames turned differently across a frame change: cannot assess, never a false red', () => {
    const samples = samplesFor(0).map((s, i) => (i < 40 ? { ...s, workRotationDeg: undefined } : s))
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 68 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G55',
      frameChanges: [{ atMs: 1_000 + 40 * 33, firstMoveId: 1, fromFrame: 'G54', toFrame: 'G55' }],
    })
    expect(report.verdict).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// The rehearsal's route: native kit, production session.
// ---------------------------------------------------------------------------

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = resolve('pendant/uccnc-bridge')
const KIT = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
// This order's own paths, never the shared rehearsal output or the desk path.
const OUT = join(tmpdir(), 'liencam-wo2215-kit')
const EXE = join(OUT, 'liencam-bridge-sim.exe')
const BRIDGE_FILES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'] as const
const canBuild = process.platform === 'win32' && existsSync(CSC)
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const SIM_BOARD = canBuild
  ? JSON.parse(readFileSync(join(KIT, 'sim-board.example.json'), 'utf8')) as Record<string, unknown>
  : {}

function buildKit(): void {
  const root = join(OUT, 'uccnc')
  mkdirSync(join(root, 'API', 'DLL'), { recursive: true })
  mkdirSync(join(root, 'Profiles'), { recursive: true })
  execFileSync(CSC, [
    '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${EXE}`,
    ...BRIDGE_FILES.map((f) => join(BRIDGE, f)),
    join(KIT, 'SimUC100.cs'), join(KIT, 'SimUC100Api.cs'),
  ], { encoding: 'utf8', timeout: 180_000 })
  rmSync(join(OUT, 'boards'), { recursive: true, force: true })
  cpSync(join(BRIDGE, 'boards'), join(OUT, 'boards'), { recursive: true })
  writeFileSync(join(root, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(join(root, 'ftd2xx64.dll'), '')
  copyFileSync(resolve('docs/machine/profiles/LienCNCV2.pro'), join(root, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(join(OUT, 'liencam-bridge.config.json'),
    JSON.stringify({ installRoot: root, profile: 'LienCNCV2.pro', board: -19 }), 'utf8')
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no loopback port')); return }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([new Promise((done) => child.once('exit', done)), wait(3_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

interface Vec { x: number; y: number; z: number }
interface RouteRun {
  deg: number
  route: string
  at: Vec
  work: Vec
  mdi: string[]
  pathCheck: string[]
  /** The session's own report for the route's last run - a clean one-move run
   *  prints nothing (WO-1660), so silence alone proves nothing. */
  report: { verdict: string; worstMm: number | null; headline: string } | null
  console: string[]
}

describe('WO-2215 native kit: no false path alarm, true end numbers, at 30 deg; 0 deg as before', () => {
  it.skipIf(!canBuild)('G30 / G28 / G53 XY / Park 1-4 / Tool change / G0 X0 Y20 through the production session', async () => {
    buildKit()
    const port = await freePort()
    if (port === 8325 || port === 8326) throw new Error('the allocated port belongs to a real bridge')
    const logPath = join(OUT, 'liencam-bridge.log')
    rmSync(logPath, { force: true })
    rmSync(join(OUT, 'liencam-bridge.definition.json'), { force: true })
    const boardFile = join(OUT, 'sim-board.json')
    writeFileSync(boardFile, `${JSON.stringify(SIM_BOARD, null, 2)}\n`, 'utf8')
    const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const child = spawn(EXE, ['--board', '-19', '--port', String(port)], { cwd: OUT, stdio: 'ignore', windowsHide: true })
    try {
      const end = Date.now() + 30_000
      while (Date.now() < end && !log().includes(`listening on ws://127.0.0.1:${port}/`)) {
        if (child.exitCode !== null) break
        await wait(50)
      }
      if (!log().includes(`listening on ws://127.0.0.1:${port}/`)) throw new Error(`bridge did not listen:\n${log()}`)

      const { useCamStore } = await import('../../store')
      const { useMachineControl } = await import('../../store/machineControlStore')
      const { useUiPrefs } = await import('../../store/uiPrefs')
      const { runUserMacro, activeMacroRun } = await import('../../lib/machine/macros/macroRuntime')
      const session = await import('../../lib/machine/machineSession')
      const profile = JSON.parse(readFileSync(resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))
      // No spindle link: the kit bridge would open this dev box's COM port.
      const { spindleLinkDefinition: _link, spindleDrive: _drive, ...machine } = profile
      useCamStore.setState((s) => ({
        machineLibrary: [machine, ...s.machineLibrary.filter((m) => m.id !== machine.id)],
        control: { ...s.control, activeMachineId: machine.id },
      }))
      useUiPrefs.setState((s) => ({ machineLinks: { ...s.machineLinks, [machine.id]: { ...(s.machineLinks[machine.id] ?? {}), bridgePort: port } } }))
      await session.connectMachine('bridge')
      const ctrl = session.getMachineController()
      expect(ctrl.connectionPhase()).toBe('connected')
      session.__resetEstopInterlockForTest()

      const lines = () => useMachineControl.getState().consoleLines
      const consoleText = () => lines().map((l) => `${l.dir} ${l.text}`).join('\n')
      const pos = (): Vec => ctrl.status().machinePos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
      const work = (): Vec => ctrl.status().workPos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
      const settle = async (pred: () => boolean = () => true, timeoutMs = 30_000, quietMs = 600): Promise<boolean> => {
        const until = Date.now() + timeoutMs
        let since = Date.now()
        let last = ''
        while (Date.now() < until) {
          const here = JSON.stringify(ctrl.status().machinePos)
          if (ctrl.machineState() !== 'idle' || here !== last) since = Date.now()
          last = here
          if (Date.now() - since >= quietMs && pred()) return true
          await wait(25)
        }
        return false
      }
      const near = (p: Partial<Vec>, tol = 0.001) => () => {
        const at = pos()
        return (p.x === undefined || Math.abs(at.x - p.x) < tol)
          && (p.y === undefined || Math.abs(at.y - p.y) < tol)
          && (p.z === undefined || Math.abs(at.z - p.z) < tol)
      }
      const setScale = async (timeScale: number) => {
        writeFileSync(boardFile, `${JSON.stringify({ ...SIM_BOARD, timeScale }, null, 2)}\n`, 'utf8')
        await wait(1_200)
      }
      const mdi = async (text: string, target: Partial<Vec>) => {
        expect(session.sendMdiLine(text), consoleText()).toBe(true)
        await wait(300)
        expect(await settle(near(target), 30_000), `${text}\n${consoleText()}`).toBe(true)
      }

      const provenance = machine.controllerDefinition.stated
        ?.map((row: { liencamProfileDriftProvenance?: unknown }) => row?.liencamProfileDriftProvenance)
        .find((row: unknown) => row && typeof row === 'object') ?? {}
      const applied = await session.applyActiveMachineDefinition(provenance)
      expect(applied.ok, JSON.stringify(applied)).toBe(true)
      await setScale(1)
      const yHomed = () => lines().filter((l) => l.text.includes('Y homed - position set')).length
      expect(ctrl.homeAxes?.(['Z', 'X', 'Y'])).toBe(true)
      await wait(500)
      expect(await settle(() => yHomed() > 0 && ctrl.status().homed?.Y === true, 120_000, 1_000), consoleText()).toBe(true)
      // Real speed throughout, as on the desk: a 10x board moves faster than the
      // machine can, and the check rightly calls those frames a measurement fault.

      // G55 = X400 Y400 Z60, active - the rehearsal's frame.
      session.selectWorkOffset('G55')
      expect(session.sendMdiLine(`G10 L2 P2 X${G55.x} Y${G55.y} Z${G55.z}`)).toBe(true)
      expect(await settle(() => Math.abs(pos().x - work().x - G55.x) < 1e-6 && Math.abs(pos().z - work().z - G55.z) < 1e-6, 10_000), consoleText()).toBe(true)

      const macro = (name: string) => {
        const found = (machine.macros as MachineMacro[]).find((m) => m.name === name)
        if (!found) throw new Error(`no macro ${name}`)
        return found
      }
      const ROUTES: Array<{ route: string; target: Vec; run: () => Promise<void> }> = [
        { route: 'mdiG30', target: { x: 738, y: 724.5, z: 128 }, run: async () => { expect(session.sendMdiLine('G30')).toBe(true) } },
        { route: 'mdiG28', target: { x: 738, y: 724.5, z: 128.9 }, run: async () => { expect(session.sendMdiLine('G28')).toBe(true) } },
        { route: 'mdiG53', target: { x: 100, y: 600, z: 100 }, run: async () => { expect(session.sendMdiLine('G53 G0 X100 Y600')).toBe(true) } },
        ...([['park1', 'Park 1', 738, 724.5], ['park2', 'Park 2', 738, 50], ['park3', 'Park 3', 50, 50], ['park4', 'Park 4', 50, 724.5]] as const)
          .map(([route, name, x, y]) => ({ route, target: { x, y, z: 128 }, run: async () => { expect(runUserMacro(macro(name))).toBe(true) } })),
        { route: 'toolChange', target: { x: 730, y: 50, z: 120 }, run: async () => { expect(runUserMacro(macro('Tool change'))).toBe(true) } },
        { route: 'mdiWorkY20', target: { x: Number.NaN, y: Number.NaN, z: 100 }, run: async () => { expect(session.sendMdiLine('G0 X0 Y20')).toBe(true) } },
      ]

      const results: RouteRun[] = []
      for (const deg of [ANGLE, 0]) {
        const set = await session.setWorkRotation('G55', deg)
        expect(set.ok, JSON.stringify(set)).toBe(true)
        await wait(400)
        expect(session.workRotations().G55 ?? 0).toBe(deg)
        for (const r of ROUTES.filter((x) => !process.env.WO2215_ONLY || x.route === process.env.WO2215_ONLY)) {
          // Every route starts where the rehearsal's did: machine X400 Y400 Z100.
          await mdi('G53 G0 Z100', { z: 100 })
          await mdi('G53 G0 X400 Y400', { x: 400, y: 400 })
          const from = lines().length
          const reportBefore = session.pathFidelityReport()
          await r.run()
          await wait(300)
          const target = r.route === 'mdiWorkY20'
            ? { ...G55, ...(() => { const m = rot(deg, 0, 20); return { x: G55.x + m.x, y: G55.y + m.y } })(), z: 100 }
            : r.target
          expect(await settle(() => activeMacroRun() === null && near(target)(), 30_000), `${r.route} at ${deg}\n${consoleText()}`).toBe(true)
          // The run is scored when the bridge says it is complete; a macro's
          // last leg is the last report. Wait for a new one that holds 1.5 s.
          const until = Date.now() + 15_000
          let seen = session.pathFidelityReport()
          let since = Date.now()
          while (Date.now() < until && (seen === reportBefore || Date.now() - since < 1_500)) {
            await wait(50)
            const now = session.pathFidelityReport()
            if (now !== seen) { seen = now; since = Date.now() }
          }
          const report = session.pathFidelityReport()
          const said = lines().slice(from)
          results.push({
            deg,
            route: r.route,
            at: pos(),
            work: work(),
            mdi: said.filter((l) => l.text.startsWith('MDI ')).map((l) => l.text),
            pathCheck: said.filter((l) => l.text.startsWith('Path check:')).map((l) => l.text),
            console: said.map((l) => `${l.dir}/${l.severity}: ${l.text}`),
            report: report === reportBefore || report === null
              ? null
              : { verdict: report.verdict, worstMm: report.worst?.deviationMm ?? null, headline: report.headline },
          })
        }
      }
      const label = process.env.WO2215_LABEL ?? 'run'
      writeFileSync(join(OUT, `console-${label}.txt`), lines().map((l) => `${l.dir}/${l.severity}: ${l.text}`).join('\n'))
      writeFileSync(join(OUT, `results-${label}.json`), JSON.stringify(results, null, 2))
      if (process.env.WO2215_EVIDENCE) {
        writeFileSync(resolve('src/tests/evidence/WO-2215', `results-${label}.json`), `${JSON.stringify(results, null, 2)}\n`)
      }

      const at = (deg: number, route: string): RouteRun => {
        const found = results.find((r) => r.deg === deg && r.route === route)
        if (!found) throw new Error(`route ${route} at ${deg} deg was not measured`)
        return found
      }
      // ---- F1: every listed move at BOTH angles: clean, worst 0.000 mm ------
      for (const deg of [ANGLE, 0]) {
        for (const { route } of ROUTES) {
          const run = at(deg, route)
          for (const text of run.pathCheck) {
            expect(text, `${route} at ${deg}`).not.toContain('LEFT THE COMMANDED PATH')
          }
          // A 20 mm work move is a few frames: no red is all it has to show.
          if (route === 'mdiWorkY20') continue
          expect(run.report, `${route} at ${deg}: no path report\n${run.console.join('\n')}`).not.toBeNull()
          expect(run.report!.verdict, `${route} at ${deg}: ${run.report!.headline}`).toBe('clean')
          // "worst 0.000 mm", as the console prints it.
          expect(run.report!.worstMm!, `${route} at ${deg}`).toBeLessThan(0.0005)
          // A route that says anything says the clean sentence. WO-2474: the
          // Control console states mm lengths to 2 decimals.
          for (const text of run.pathCheck) {
            expect(text, `${route} at ${deg}`).toContain('stayed on the commanded path - worst 0.00 mm')
          }
        }
      }
      // ---- F2: the MDI end row names the true work and machine position ------
      // WO-2474: each length to 2 decimals with its unit.
      expect(at(ANGLE, 'mdiG30').mdi.join('\n'))
        .toContain('ending at G55 X 454.97 mm Y 112.03 mm Z 68.00 mm (machine X 738.00 mm Y 724.50 mm Z 128.00 mm)')
      expect(at(ANGLE, 'mdiWorkY20').mdi.join('\n')).toContain('ending at G55 X 0.00 mm Y 20.00 mm (machine X 390.00 mm Y 417.32 mm)')
      const g53 = machineToWork(ANGLE, 100, 600)
      expect(at(ANGLE, 'mdiG53').mdi.join('\n')).toContain(
        `ending at G55 X ${g53.x.toFixed(2)} mm Y ${g53.y.toFixed(2)} mm (machine X 100.00 mm Y 600.00 mm)`)
      // ... and at 0 deg exactly what main has always printed.
      expect(at(0, 'mdiG30').mdi.join('\n')).toContain('ending at G55 X 338.00 mm Y 324.50 mm Z 68.00 mm (machine X 738.00 mm Y 724.50 mm Z 128.00 mm)')
      expect(at(0, 'mdiWorkY20').mdi.join('\n')).toContain('ending at G55 Y 20.00 mm (machine Y 420.00 mm)')
      expect(at(0, 'mdiG53').mdi.join('\n')).toContain('ending at G55 X -300.00 mm Y 200.00 mm (machine X 100.00 mm Y 600.00 mm)')
      // The machine went where it always did (the motion is not this order's).
      for (const { route, target } of ROUTES) {
        if (route === 'mdiWorkY20') continue
        for (const deg of [ANGLE, 0]) {
          const p = at(deg, route).at
          expect(Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z), `${route} at ${deg}`).toBeLessThan(0.001)
        }
      }
    } finally {
      await stop(child)
    }
  }, 900_000)
})
