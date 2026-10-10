// @vitest-environment node

/**
 * WO-2203: on the AXBB-E route a rotated work offset turns the program and
 * never a MACHINE-frame move (Operator ruling 2026-09-29: "make sure it doesn't break any
 * of the go-to positions which are relative to the machine coordinate system
 * like a G30 positions, home, etc.").
 *
 * The spec is LinuxCNC as measured (docs/design/WCS-ROTATION.md):
 *     machine_xy = O_xy + Rot(R)(work_xy)
 * turns program moves, arc centres, the work readout and moves to a work
 * point; G53, the G28/G30 stored points, jogs and homing never turn.
 *
 * The REAL bridge (Bridge.cs, Machine.cs, Json.cs, Vfd.cs) is built against the
 * native rehearsal kit's simulated board, and the PRODUCTION session drives it:
 * `connectMachine('bridge')` builds the app's own UccncController over its own
 * BridgeTransport to the kit's port, and every route below is the exported
 * session function (or macro, or MDI line) the screens call. The kit records
 * every motion call the bridge hands the board (LIENCAM_SIM_RECORD), and the
 * status frames say where the machine came to rest. Each route runs with G55
 * rotated 0 deg and 30 deg and its machine numbers are asserted.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MachineMacro } from '../../types'

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

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = resolve('pendant/uccnc-bridge')
const KIT = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
// This order's own paths, never the shared rehearsal output or the desk path.
const OUT = join(tmpdir(), 'liencam-wo2203-kit')
const EXE = join(OUT, 'liencam-bridge-sim.exe')
const BRIDGE_FILES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'] as const

/** G55: far from G54 (which stays the kit's zero) and clear of the stock. */
const G55 = { x: 450, y: 450, z: 60 }
const ANGLE = 30

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** The committed machine PC rehearsal board: stock, pads, and the setter at
 *  X 738 Y 724.5 (fast top 48.203, fine top 48.263). */
const SIM_BOARD = JSON.parse(readFileSync(join(KIT, 'sim-board.example.json'), 'utf8')) as Record<string, unknown>

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
interface RouteRun { deg: number; route: string; at: Vec; work: Vec; record: string; console: string[] }

// ---- the record the simulated board kept --------------------------------

interface Rec { kind: string; fields: Record<string, string> }
function parseRecord(text: string): Rec[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(' ')
    const fields: Record<string, string> = {}
    for (let i = 1; i + 1 < parts.length; i += 2) fields[parts[i]] = parts[i + 1]
    return { kind: parts[0], fields }
  })
}
const num = (v: string | undefined) => (v === undefined || v === '-' ? Number.NaN : Number(v))

function rot(deg: number, x: number, y: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}
/** LinuxCNC's machine point for a G55 work point. */
const workToMachine = (deg: number, x: number, y: number) => {
  const r = rot(deg, x, y)
  return { x: G55.x + r.x, y: G55.y + r.y }
}

const canBuild = process.platform === 'win32' && existsSync(CSC)

/** What the first test measured, for the G28 test after it. */
let RESULTS: RouteRun[] = []

describe('WO-2203 AXBB-E: a rotated G55 turns the program, never a machine-frame move', () => {
  it.skipIf(!canBuild)('square + every go-to route at 0 and 30 deg through the production session', async () => {
    buildKit()
    const record = join(OUT, 'moves.rec')
    const port = await freePort()
    if (port === 8325 || port === 8326) throw new Error('the allocated port belongs to a real bridge')
    const logPath = join(OUT, 'liencam-bridge.log')
    rmSync(logPath, { force: true })
    rmSync(record, { force: true })
    rmSync(join(OUT, 'liencam-bridge.definition.json'), { force: true })
    const boardFile = join(OUT, 'sim-board.json')
    writeFileSync(boardFile, `${JSON.stringify(SIM_BOARD, null, 2)}\n`, 'utf8')
    const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const child = spawn(EXE, ['--board', '-19', '--port', String(port)], {
      cwd: OUT, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIENCAM_SIM_RECORD: record },
    })
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
      const { machineParkList } = await import('../../lib/machine/machineActions')
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

      const consoleText = () => useMachineControl.getState().consoleLines.map((l) => `${l.dir} ${l.text}`).join('\n')
      const pos = (): Vec => ctrl.status().machinePos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
      const work = (): Vec => ctrl.status().workPos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
      /** Idle and still for `quietMs`, and `pred` holds; false on timeout. */
      const settle = async (pred: () => boolean = () => true, timeoutMs = 30_000, quietMs = 600): Promise<boolean> => {
        const end = Date.now() + timeoutMs
        let since = Date.now()
        let last = ''
        while (Date.now() < end) {
          const here = JSON.stringify(ctrl.status().machinePos)
          if (ctrl.machineState() !== 'idle' || here !== last) since = Date.now()
          last = here
          if (Date.now() - since >= quietMs && pred()) return true
          await wait(25)
        }
        return false
      }
      const near = (p: { x?: number; y?: number; z?: number }, tol = 0.001) => () => {
        const at = pos()
        return (p.x === undefined || Math.abs(at.x - p.x) < tol)
          && (p.y === undefined || Math.abs(at.y - p.y) < tol)
          && (p.z === undefined || Math.abs(at.z - p.z) < tol)
      }
      const setScale = async (timeScale: number) => {
        writeFileSync(boardFile, `${JSON.stringify({ ...SIM_BOARD, timeScale }, null, 2)}\n`, 'utf8')
        await wait(1_200)
      }

      // ---- the definition and the datum, as the screens do them ---------
      const provenance = machine.controllerDefinition.stated
        ?.map((row: { liencamProfileDriftProvenance?: unknown }) => row?.liencamProfileDriftProvenance)
        .find((row: unknown) => row && typeof row === 'object') ?? {}
      const applied = await session.applyActiveMachineDefinition(provenance)
      expect(applied.ok, JSON.stringify(applied)).toBe(true)
      const home = async () => {
        await setScale(1)
        // Done when the bridge says Y (the last axis) homed THIS time - the
        // homed flags are already true on a second homing.
        const yHomed = () => useMachineControl.getState().consoleLines.filter((l) => l.text.includes('Y homed - position set')).length
        const before = yHomed()
        expect(ctrl.homeAxes?.(['Z', 'X', 'Y'])).toBe(true)
        await wait(500)
        expect(await settle(() => yHomed() > before && ctrl.status().homed?.X === true && ctrl.status().homed?.Y === true && ctrl.status().homed?.Z === true, 120_000, 1_000), consoleText()).toBe(true)
        await setScale(10)
        return pos()
      }
      await home()

      // G55 at (450, 450, 60), active, set through a typed line.
      session.selectWorkOffset('G55')
      expect(session.sendMdiLine(`G10 L2 P2 X${G55.x} Y${G55.y} Z${G55.z}`)).toBe(true)
      expect(await settle(() => Math.abs(pos().x - work().x - G55.x) < 1e-6 && Math.abs(pos().z - work().z - G55.z) < 1e-6, 10_000), consoleText()).toBe(true)

      const results: RouteRun[] = []
      const measure = async (deg: number, route: string, run: () => Promise<void>) => {
        rmSync(record, { force: true })
        const lines = useMachineControl.getState().consoleLines.length
        await run()
        const at = pos()
        const recs = existsSync(record) ? readFileSync(record, 'utf8') : ''
        const said = useMachineControl.getState().consoleLines.slice(lines).map((l) => `${l.dir} ${l.text}`)
        results.push({ deg, route, at, work: work(), record: recs, console: said })
        writeFileSync(join(OUT, `rec-${deg}-${route}.rec`), recs)
        return at
      }

      const SAFE_Z = 120
      const PROGRAM = [
        'G21 G90 G55',
        'G0 Z40',
        'G0 X0 Y0',
        'G1 X40 Y0 F3000',
        'G1 X40 Y40',
        'G1 X0 Y40',
        'G1 X0 Y0',
        'G2 X20 Y0 I10 J0',
        'G0 Z50',
        'M30',
      ].join('\n')

      for (const deg of [0, ANGLE]) {
        const set = await session.setWorkRotation('G55', deg)
        expect(set.ok, JSON.stringify(set)).toBe(true)
        await wait(400)
        expect(session.workRotations().G55 ?? 0).toBe(deg)

        // ---- MACHINE: jog to safe Z (Jog panel) ---------------------------
        await measure(deg, 'safeZ', async () => {
          expect(session.jogToSafeZ(SAFE_Z, 3000)).toMatchObject({ ok: true })
          expect(await settle(near({ z: SAFE_Z })), consoleText()).toBe(true)
        })
        // ---- WORK: Goto work XY zero (Control page) ------------------------
        await measure(deg, 'gotoWorkXYZero', async () => {
          expect(session.gotoWorkXYZero(8000)).toBe(true)
          expect(await settle(near({ x: G55.x, y: G55.y })), consoleText()).toBe(true)
        })
        // ---- WORK: the 40 x 40 square + one arc, loaded and Cycle Start ----
        await measure(deg, 'square', async () => {
          const load = session.loadGcodeFile('wo2203-square.nc', PROGRAM, null)
          expect(load.door === 'program' && load.ok, `${JSON.stringify(load)}\n${consoleText()}`).toBe(true)
          await wait(300)
          expect(session.startMachineJob(), consoleText()).toBe(true)
          await wait(500)
          expect(await settle(() => !ctrl.hasActiveJob(), 60_000, 1_000), consoleText()).toBe(true)
        })
        // ---- WORK: the material-fit trace of that program (app work lines) --
        await measure(deg, 'fitTrace', async () => {
          const prepared = session.prepareMaterialFitTrace(SAFE_Z, 3000)
          expect(prepared, consoleText()).toMatchObject({ ok: true })
          const traced = await session.startMaterialFitTrace()
          expect(traced, `${JSON.stringify(useMachineControl.getState().fitTrace)}\n${consoleText()}`).toBe(true)
          session.cancelMaterialFitTrace()
          expect(await settle()).toBe(true)
        })
        // ---- MACHINE: a position macro goTo (Macros: "Park 3") -------------
        await measure(deg, 'macroPark3', async () => {
          const macro = (machine.macros as MachineMacro[]).find((m) => m.name === 'Park 3')
          expect(runUserMacro(macro!)).toBe(true)
          await wait(300)
          expect(await settle(() => activeMacroRun() === null && near({ x: 50, y: 50, z: 128 })(), 30_000), consoleText()).toBe(true)
        })
        // ---- MACHINE: a typed G53 line (MDI) ------------------------------
        await measure(deg, 'mdiG53', async () => {
          expect(session.sendMdiLine('G53 G0 X100 Y600'), consoleText()).toBe(true)
          await wait(300)
          expect(await settle(near({ x: 100, y: 600 }), 20_000), consoleText()).toBe(true)
        })
        // ---- MACHINE: a jog along machine X (Jog panel) ----------------------
        await measure(deg, 'jogX', async () => {
          const from = pos()
          expect(ctrl.jog('X', -10, 3000)).toBe(true)
          expect(await settle(near({ x: from.x - 10, y: from.y }), 20_000), consoleText()).toBe(true)
        })
        // ---- MACHINE: the Macros panel park button (runParkMove) -----------
        await measure(deg, 'parkButton', async () => {
          const parks = machineParkList(machine, undefined)
          const park = parks.find((p) => p.label === 'Park 2')!
          expect(park, JSON.stringify(parks)).toBeTruthy()
          expect(session.runParkMove(park, SAFE_Z), consoleText()).toMatchObject({ ok: true })
          await wait(300)
          expect(await settle(near({ x: 738, y: 50, z: 128 }), 30_000), consoleText()).toBe(true)
        })
        // ---- MACHINE: the guided tool change park (Tool change macro) ------
        await measure(deg, 'toolChangePark', async () => {
          const park = machineParkList(machine, undefined).find((p) => p.label === 'Tool change')!
          expect(park, JSON.stringify(machineParkList(machine, undefined))).toBeTruthy()
          const parked = await session.beginGuidedToolChange({ tool: 2, resumeLine: 1, park, safeZMachine: SAFE_Z })
          expect(parked, `${JSON.stringify(useMachineControl.getState().toolChange)}\n${consoleText()}`).toBe(true)
          expect(await settle(near({ x: 730, y: 50, z: 120 }), 30_000), consoleText()).toBe(true)
          session.cancelGuidedToolChange()
        })
        // ---- MACHINE: Tools > Measure on the fixed setter (X 738 Y 724.5) --
        await measure(deg, 'setterMeasure', async () => {
          const measured = await session.runZProbeCycle('measureTool', machine.probing)
          expect(measured.ok, `${JSON.stringify(measured)}\n${consoleText()}`).toBe(true)
          expect(await settle()).toBe(true)
          results.push({ deg, route: 'setterMeasure:contact', at: { x: 738, y: 724.5, z: measured.probedMachineZ ?? Number.NaN }, work: work(), record: '', console: [] })
        })
        // ---- MACHINE: an X+ probe touch on the pad (Probing: X+) ------------
        // Placed by typed G53 lines, then the native probe call (a machine-
        // axis search) and its back-off to a machine point.
        await measure(deg, 'probeXPlus', async () => {
          expect(session.jogToSafeZ(SAFE_Z, 3000)).toMatchObject({ ok: true })
          expect(await settle(near({ z: SAFE_Z }))).toBe(true)
          expect(session.sendMdiLine('G53 G0 X180 Y265')).toBe(true)
          await wait(300)
          expect(await settle(near({ x: 180, y: 265 }), 20_000), consoleText()).toBe(true)
          expect(session.sendMdiLine('G53 G0 Z30')).toBe(true)
          await wait(300)
          expect(await settle(near({ z: 30 }), 20_000), consoleText()).toBe(true)
          const touched = await session.runDirectionalProbeTouch('X', '+', machine.probing, 30)
          expect(touched.ok, `${JSON.stringify(touched)}\n${consoleText()}`).toBe(true)
          expect(await settle()).toBe(true)
          results.push({ deg, route: 'probeXPlus:contact', at: { x: touched.probedMachinePosition!, y: 265, z: 30 }, work: work(), record: '', console: [] })
          expect(session.jogToSafeZ(SAFE_Z, 3000)).toMatchObject({ ok: true })
          expect(await settle(near({ z: SAFE_Z }))).toBe(true)
        })
        // ---- MACHINE: G30 - the definition reference point 1 (MDI) ---------
        await measure(deg, 'mdiG30', async () => {
          expect(session.sendMdiLine('G30'), consoleText()).toBe(true)
          await wait(300)
          expect(await settle(near({ x: 738, y: 724.5, z: 128 }), 20_000), consoleText()).toBe(true)
        })
        // ---- MACHINE: G28 - machine home (MDI). Measured, asserted below. ---
        await measure(deg, 'mdiG28', async () => {
          expect(session.jogToSafeZ(SAFE_Z, 3000)).toMatchObject({ ok: true })
          expect(await settle(near({ z: SAFE_Z }))).toBe(true)
          session.sendMdiLine('G53 G0 X600 Y600')
          await wait(300)
          expect(await settle(near({ x: 600, y: 600 }), 20_000), consoleText()).toBe(true)
          rmSync(record, { force: true })
          session.sendMdiLine('G28')
          await wait(500)
          await settle(() => !ctrl.hasActiveJob(), 20_000, 1_000)
        })
        // ---- MACHINE: Home all (Jog panel: homeAxes Z X Y) ------------------
        await measure(deg, 'homeAll', async () => {
          await home()
        })
      }
      writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
      RESULTS = results

      const at = (deg: number, route: string): RouteRun => {
        const found = results.find((r) => r.deg === deg && r.route === route)
        if (!found) throw new Error(`route ${route} at ${deg} deg was not measured`)
        return found
      }

      // ---- 1. THE SQUARE turns about the G55 origin: O + Rot(R)(work) -----
      const SQUARE: Record<number, { x: number; y: number; cx?: number; cy?: number }> = {
        2: { x: 0, y: 0 }, 3: { x: 40, y: 0 }, 4: { x: 40, y: 40 }, 5: { x: 0, y: 40 }, 6: { x: 0, y: 0 },
        7: { x: 20, y: 0, cx: 10, cy: 0 },
      }
      for (const deg of [0, ANGLE]) {
        const recs = parseRecord(at(deg, 'square').record)
        for (const [id, w] of Object.entries(SQUARE)) {
          const r = recs.find((x) => (x.kind === 'line' || x.kind === 'arc') && x.fields.id === id)
          expect(r, `square move ${id} at ${deg} deg`).toBeTruthy()
          const m = workToMachine(deg, w.x, w.y)
          expect(Math.abs(num(r!.fields.x) - m.x), `square ${id} X at ${deg}`).toBeLessThan(1e-6)
          expect(Math.abs(num(r!.fields.y) - m.y), `square ${id} Y at ${deg}`).toBeLessThan(1e-6)
          expect(num(r!.fields.z)).toBe(100)
          if (w.cx !== undefined) {
            const c = workToMachine(deg, w.cx, w.cy!)
            expect(Math.abs(num(r!.fields.cx) - c.x), `arc centre X at ${deg}`).toBeLessThan(1e-6)
            expect(Math.abs(num(r!.fields.cy) - c.y), `arc centre Y at ${deg}`).toBeLessThan(1e-6)
          }
        }
      }
      // 0 deg: the corners themselves. 30 deg: (484.641, 470), (464.641, 504.641), (430, 484.641).
      expect(workToMachine(ANGLE, 40, 40).x).toBeCloseTo(464.641016, 6)
      expect(workToMachine(ANGLE, 40, 40).y).toBeCloseTo(504.641016, 6)

      // ---- 2. THE FIT TRACE (app work lines) turns with it -----------------
      for (const deg of [0, ANGLE]) {
        const xy = parseRecord(at(deg, 'fitTrace').record).filter((r) => r.kind === 'line' && r.fields.x !== '-')
        const corners = [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]].map(([x, y]) => workToMachine(deg, x, y))
        expect(xy.length, at(deg, 'fitTrace').record).toBe(corners.length)
        xy.forEach((r, i) => {
          expect(Math.abs(num(r.fields.x) - corners[i].x), `trace corner ${i} X at ${deg}`).toBeLessThan(0.001)
          expect(Math.abs(num(r.fields.y) - corners[i].y), `trace corner ${i} Y at ${deg}`).toBeLessThan(0.001)
        })
      }

      // ---- 3. EVERY MACHINE-FRAME ROUTE: same machine point at 0 and 30 ----
      const MACHINE_ROUTES: Record<string, Partial<Vec>> = {
        safeZ: { z: 120 },
        macroPark3: { x: 50, y: 50, z: 128 },
        mdiG53: { x: 100, y: 600, z: 128 },
        jogX: { x: 90, y: 600, z: 128 },
        parkButton: { x: 738, y: 50, z: 128 },
        toolChangePark: { x: 730, y: 50, z: 120 },
        setterMeasure: { x: 738, y: 724.5, z: 128.1 },
        'setterMeasure:contact': { z: 48.263 },
        probeXPlus: { x: 193.2525, y: 265, z: 120 },
        mdiG30: { x: 738, y: 724.5, z: 128 },
        homeAll: { x: 738, y: 724.5, z: 128.9 },
        // WO-2207: G28's home leg is machine-absolute, as G30's is.
        mdiG28: { x: 738, y: 724.5, z: 128.9 },
      }
      for (const [route, expected] of Object.entries(MACHINE_ROUTES)) {
        for (const deg of [0, ANGLE]) {
          const p = at(deg, route).at
          for (const axis of ['x', 'y', 'z'] as const) {
            if (expected[axis] === undefined) continue
            expect(Math.abs(p[axis] - expected[axis]!), `${route} ${axis} at ${deg} deg`).toBeLessThan(0.001)
          }
        }
        const a = at(0, route).at
        const b = at(ANGLE, route).at
        for (const axis of ['x', 'y', 'z'] as const) {
          if (expected[axis] === undefined) continue
          expect(Math.abs(a[axis] - b[axis]), `${route} ${axis}: 0 deg vs ${ANGLE} deg`).toBeLessThan(0.001)
        }
        // ... and the board was handed the same calls (ids aside), to 0.001 mm.
        const ra = parseRecord(at(0, route).record)
        const rb = parseRecord(at(ANGLE, route).record)
        expect(rb.map((r) => r.kind), `${route} board calls`).toEqual(ra.map((r) => r.kind))
        ra.forEach((r, i) => {
          for (const key of Object.keys(r.fields)) {
            if (key === 'id') continue
            const va = r.fields[key]
            const vb = rb[i].fields[key]
            if (va === '-' || Number.isNaN(Number(va))) expect(vb, `${route} call ${i} ${key}`).toBe(va)
            else expect(Math.abs(Number(va) - Number(vb)), `${route} call ${i} ${key}`).toBeLessThan(0.001)
          }
        })
      }
      expect(at(0, 'probeXPlus:contact').at.x).toBeCloseTo(195.2525, 4)
      expect(Math.abs(at(ANGLE, 'probeXPlus:contact').at.x - at(0, 'probeXPlus:contact').at.x)).toBeLessThan(0.001)

      // ---- 4. WORK: Goto work XY zero is the G55 origin either way; the work
      // readout of a machine point is the turned one, Rot(-R)(machine - O). ---
      for (const deg of [0, ANGLE]) {
        const z = at(deg, 'gotoWorkXYZero').at
        expect(Math.hypot(z.x - G55.x, z.y - G55.y)).toBeLessThan(0.001)
        const probe = at(deg, 'probeXPlus')
        const w = rot(-deg, probe.at.x - G55.x, probe.at.y - G55.y)
        expect(Math.abs(probe.work.x - w.x), `probe work X at ${deg}`).toBeLessThan(0.001)
        expect(Math.abs(probe.work.y - w.y), `probe work Y at ${deg}`).toBeLessThan(0.001)
      }
      writeFileSync(join(OUT, 'wo2203.pass'), new Date().toISOString())
    } finally {
      await stop(child)
    }
  }, 900_000)

  // FOUND BY WO-2203, FIXED BY WO-2207: `G28` through MDI (and in a file) was
  // resolved by the shared reader (src/lib/gcode/reader.ts, the home block)
  // into a WORK rapid to (home - offset) with no machine-frame marker, so the
  // bridge turned it: at 30 deg it asked for machine X 562.17 Y 831.72, the
  // bridge refused the out-of-limits load, and nothing moved. The home leg now
  // carries `machineAbsolute` on the axes it names, the way G30's legs do.
  it.skipIf(!canBuild)('G28 under a 30 deg G55 rotation lands on machine home (738, 724.5, 128.9)', () => {
    const g28 = RESULTS.find((r) => r.deg === ANGLE && r.route === 'mdiG28')
    expect(g28, 'the first test did not measure G28').toBeTruthy()
    expect(Math.hypot(g28!.at.x - 738, g28!.at.y - 724.5, g28!.at.z - 128.9)).toBeLessThan(0.001)
  })
})
