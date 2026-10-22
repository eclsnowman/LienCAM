// @vitest-environment node
// WO-2844 (ADR-0058 D2/D3): boards/compat.json - proven and cannot-run rows only.
// Two layers, both through the production C#:
//  - a harness compiled WITH the real Machine.cs drives CompatRecord directly;
//  - the real bridge (Bridge.cs Main) built against SimUC100 is started on a
//    demo board and connected to, so Open, hello and the console line are the
//    production route. No hardware, no UC100.dll is loaded, no port is opened.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BRIDGE = path.resolve('pendant/uccnc-bridge')
const SIM = path.resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
const PROFILE = path.resolve('docs/machine/profiles/LienCNCV2.pro')
const COMPAT = path.join(BRIDGE, 'boards', 'compat.json')
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canRun = process.platform === 'win32' && existsSync(csc)
const SOURCES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'].map((f) => path.join(BRIDGE, f))
  .concat(['SimUC100.cs', 'SimUC100Api.cs'].map((f) => path.join(SIM, f)))
const shipped = JSON.parse(readFileSync(COMPAT, 'utf8'))

const HARNESS = `
using System; using System.Collections.Generic; using System.IO;
[assembly: System.Reflection.AssemblyFileVersion("2.1.9.0")]
namespace LienCAM {
static class CompatHarness {
  static void P(string k, object v) { Console.WriteLine(k + "=" + (v == null ? "null" : v.ToString())); }
  static void Main(string[] a) {
    var logs = new List<string>();
    var shipped = CompatRecord.Load(a[0], logs.Add);
    P("SHIPPED_ROWS", shipped.Count); P("SHIPPED_LOGS", logs.Count);
    var r = shipped[0];
    P("ROW0", r.Status + " " + r.DeviceType + " " + r.Fw + " " + r.Hw + " " + r.DllVersion + " " + r.DllSha256 + " " + r.UccncVersion);
    var v = new ControllerVersion { FWVersion = 1005, HWVersion = 1, DLLVersion = 2190, SerialNumber = 13437274, DeviceType = 19 };
    string sha = r.DllSha256;
    P("PROVEN", CompatRecord.Proven(shipped, v, 0, 19, sha) != null);
    var fw = v; fw.FWVersion = 1006; P("FW1006", CompatRecord.Proven(shipped, fw, 0, 19, sha) != null);
    var hw = v; hw.HWVersion = 2; P("HW2", CompatRecord.Proven(shipped, hw, 0, 19, sha) != null);
    var api = v; api.DLLVersion = 2191; P("API2191", CompatRecord.Proven(shipped, api, 0, 19, sha) != null);
    P("OTHER_SHA", CompatRecord.Proven(shipped, v, 0, 19, new string('0', 64)) != null);
    P("NO_SHA", CompatRecord.Proven(shipped, v, 0, 19, null) != null);
    P("RC1", CompatRecord.Proven(shipped, v, 1, 19, sha) != null);
    P("TYPE8", CompatRecord.Proven(shipped, v, 0, 8, sha) != null);
    P("SHIPPED_CANNOT", CompatRecord.CannotRun(shipped, 19, "2.1.9.0", sha) != null);

    logs.Clear();
    var rows = CompatRecord.Load(a[1], logs.Add);
    P("FIX_ROWS", rows.Count); foreach (string l in logs) P("FIX_LOG", l);
    var cr = CompatRecord.CannotRun(rows, 19, "2.1.8.0", null);
    P("CR_218", cr == null ? null : cr.MissingCall);
    P("CR_219", CompatRecord.CannotRun(rows, 19, "2.1.9.0", null) == null ? "null" : CompatRecord.CannotRun(rows, 19, "2.1.9.0", null).MissingCall);
    P("CR_UNREAD", CompatRecord.CannotRun(rows, 19, null, null) == null ? "null" : "match");
    P("CR_SHA", CompatRecord.CannotRun(rows, 8, "9.9.9.9", new string('a', 64)) == null ? "null" : CompatRecord.CannotRun(rows, 8, "9.9.9.9", new string('a', 64)).MissingCall);
    P("REFUSAL", CompatRecord.CannotRunRefusal(cr, "AXBB-E", "2.1.8.0", new string('b', 64), "C:\\\\x\\\\UC100.dll"));

    logs.Clear(); P("BROKEN_ROWS", CompatRecord.Load(a[2], logs.Add).Count); P("BROKEN_LOGS", logs.Count);
    logs.Clear(); P("MISSING_ROWS", CompatRecord.Load(a[2] + ".absent", logs.Add).Count); P("MISSING_LOGS", logs.Count);

    P("LINE_A1", CompatRecord.TakeOperatorLine("untested", "A", "AXBB-E firmware 1006"));
    P("LINE_A2", CompatRecord.TakeOperatorLine("untested", "A", "AXBB-E firmware 1006"));
    P("LINE_B1", CompatRecord.TakeOperatorLine("untested", "B", "AXBB-E firmware 1007") != null);
    P("LINE_PROVEN", CompatRecord.TakeOperatorLine("proven", "C", "x"));
    P("FILEVER", CompatRecord.FileVersion("2, 1, 9, 0"));
    P("SELF_FILEVER", CompatRecord.DllFileVersionOf(a[3]));
    P("SELF_SHA", CompatRecord.FullSha256(a[3]));
    P("ABSENT_SHA", CompatRecord.FullSha256(a[3] + ".absent"));
  }
}
}
`

const FIXTURE = {
  format: 'liencam-compat', schemaVersion: 1, rows: [
    { status: 'cannot-run', dllFileVersion: '2, 1, 8, 0', missingCall: 'GetVersio', evidence: 'fixture' },
    { status: 'cannot-run', dllSha256: 'A'.repeat(64), missingCall: 'ProbeStart' },
    { status: 'cannot-run', fw: 1005, missingCall: 'X' },
    { status: 'untested', deviceType: 19 },
    { status: 'proven', deviceType: 19, fw: 1005, dllVersion: 2190 },
    { status: 'cannot-run', missingCall: 'Y' },
    { status: 'proven', deviceType: 19, fw: 1005, dllVersion: 2190, dllSha256: 'xyz' },
  ],
}

let root = ''
let values: Record<string, string[]> = {}
let selfSha = ''
type Run = { exited: number | null, listening: boolean, sessions: { compat: Record<string, unknown> | null, console: string[] }[], log: string }
let untested: Run
let refused: Run

function compile(out: string, main: string, extra: string[] = []) {
  const r = spawnSync(csc, ['/nologo', '/unsafe', '/platform:x64', '/target:exe', `/main:${main}`, `/out:${out}`, ...SOURCES, ...extra], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`csc: ${r.stdout}\n${r.stderr}`)
}

function kit(name: string, compat: string): string {
  const dir = path.join(root, name)
  const install = path.join(root, `${name}-uccnc`)
  mkdirSync(path.join(dir, 'boards'), { recursive: true })
  mkdirSync(path.join(install, 'API', 'DLL'), { recursive: true })
  mkdirSync(path.join(install, 'Profiles'), { recursive: true })
  copyFileSync(path.join(root, 'bridge-sim.exe'), path.join(dir, 'liencam-bridge-sim.exe'))
  cpSync(path.join(BRIDGE, 'boards', 'uc100.json'), path.join(dir, 'boards', 'uc100.json'))
  writeFileSync(path.join(dir, 'boards', 'compat.json'), compat)
  writeFileSync(path.join(install, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(path.join(install, 'ftd2xx64.dll'), '')
  copyFileSync(PROFILE, path.join(install, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(path.join(dir, 'liencam-bridge.config.json'), JSON.stringify({ installRoot: install, profile: 'LienCNCV2.pro', board: -19 }))
  copyFileSync(path.join(SIM, 'sim-board.example.json'), path.join(dir, 'sim-board.json'))
  return dir
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runBridge(dir: string, port: number, sessions: number): Promise<Run> {
  const child = spawn(path.join(dir, 'liencam-bridge-sim.exe'), ['--board', '-19', '--port', String(port)], { cwd: dir, stdio: 'ignore' })
  let exited: number | null = null
  child.on('exit', (code) => { exited = code ?? -1 })
  const logFile = path.join(dir, 'liencam-bridge.log')
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
  for (let i = 0; i < 120 && exited === null && !/listening on ws/.test(log()); i++) await sleep(250)
  const run: Run = { exited: null, listening: /listening on ws/.test(log()), sessions: [], log: '' }
  try {
    if (run.listening) for (let s = 0; s < sessions; s++) {
      const rec: Run['sessions'][number] = { compat: null, console: [] }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data))
        if (m.t === 'hello') rec.compat = m.v.compat
        if (m.t === 'console') rec.console.push(m.v?.text ?? '')
      }
      await sleep(1500)
      ws.close()
      await sleep(800)
      run.sessions.push(rec)
    }
  } finally {
    if (exited === null) child.kill()
    for (let i = 0; i < 20 && exited === null; i++) await sleep(100)
  }
  run.exited = exited
  run.log = log()
  return run
}

beforeAll(async () => {
  if (!canRun) return
  root = mkdtempSync(path.join(tmpdir(), 'liencam-wo2844-'))
  const fixture = path.join(root, 'fixture.json')
  const broken = path.join(root, 'broken.json')
  writeFileSync(fixture, JSON.stringify(FIXTURE))
  writeFileSync(broken, '{ "format": "liencam-compat", ')
  const harnessCs = path.join(root, 'CompatHarness.cs')
  writeFileSync(harnessCs, HARNESS)
  const harness = path.join(root, 'compat-harness.exe')
  // The harness failing to build leaves its rows empty (those tests fail);
  // the real-bridge rows below still run, so a missing implementation fails
  // on behaviour, not only on a compile error.
  try {
    compile(harness, 'LienCAM.CompatHarness', [harnessCs])
    selfSha = createHash('sha256').update(readFileSync(harness)).digest('hex')
    const r = spawnSync(harness, [COMPAT, fixture, broken, harness], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`harness: ${r.stdout}\n${r.stderr}`)
    for (const line of r.stdout.trim().split(/\r?\n/)) {
      const at = line.indexOf('=')
      ;(values[line.slice(0, at)] ??= []).push(line.slice(at + 1))
    }
  } catch (error) {
    console.log(String(error).slice(0, 2000))
  }
  compile(path.join(root, 'bridge-sim.exe'), 'LienCAM.Bridge')
  untested = await runBridge(kit('shipped', readFileSync(COMPAT, 'utf8')), 18444, 2)
  refused = await runBridge(kit('cannot-run', JSON.stringify({
    format: 'liencam-compat', schemaVersion: 1,
    rows: [{ status: 'cannot-run', deviceType: 19, missingCall: 'ProbeStart', evidence: 'test fixture' }],
  })), 18445, 1)
}, 240_000)

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

const v = (key: string) => values[key] ?? []

describe('WO-2844 shipped compatibility record', () => {
  it('holds exactly the F6 proven row and no cannot-run row', () => {
    expect(shipped.format).toBe('liencam-compat')
    expect(shipped.schemaVersion).toBe(1)
    expect(shipped.rows).toHaveLength(1)
    expect(shipped.rows[0]).toMatchObject({
      status: 'proven', deviceType: 19, fw: 1005, hw: 1, dllVersion: 2190, uccncVersion: '1.2115',
      dllSha256: 'fa715370f660411397c09c408b5c9dab30dbd202fa1ba6731643c8d4cde039ca',
    })
    expect(shipped.rows[0].evidence).toContain('fw 1005 / hw 1 / dll 2190')
  })
  it('is left out of the pin-table loader and read before Open, after the board gate', () => {
    const source = readFileSync(path.join(BRIDGE, 'Machine.cs'), 'utf8')
    expect(source).toMatch(/GetFileName\(file\), CompatRecord\.FileName, StringComparison\.OrdinalIgnoreCase\)\) continue;/)
    const open = source.slice(source.indexOf('public bool Open(int board, string profilePath)'))
    expect(open.indexOf('CheckBoardType(board)')).toBeLessThan(open.indexOf('CheckCompatBeforeOpen()'))
    expect(open.indexOf('CheckCompatBeforeOpen()')).toBeLessThan(open.indexOf('UC100.Open(board)'))
    expect(open.indexOf('UC100.GetVersio(')).toBeLessThan(open.indexOf('NoteCompatAfterOpen(ver, versionRc)'))
  })
})

describe.skipIf(!canRun)('WO-2844 CompatRecord through the production C#', () => {
  it('reads the shipped file with no complaint', () => {
    expect(v('SHIPPED_ROWS')).toEqual(['1'])
    expect(v('SHIPPED_LOGS')).toEqual(['0'])
    expect(v('ROW0')[0]).toBe('proven 19 1005 1 2190 fa715370f660411397c09c408b5c9dab30dbd202fa1ba6731643c8d4cde039ca 1.2115')
  })
  it('a proven combination reads proven; any other version or DLL is untested, never refused', () => {
    expect(v('PROVEN')).toEqual(['True'])
    for (const k of ['FW1006', 'HW2', 'API2191', 'OTHER_SHA', 'NO_SHA', 'RC1', 'TYPE8']) expect(v(k), k).toEqual(['False'])
    expect(v('SHIPPED_CANNOT')).toEqual(['False'])
  })
  it('a cannot-run row matches only what it names and refuses naming the missing call', () => {
    expect(v('CR_218')).toEqual(['GetVersio'])
    expect(v('CR_219')).toEqual(['null'])
    expect(v('CR_UNREAD')).toEqual(['null'])
    expect(v('CR_SHA')).toEqual(['ProbeStart'])
    expect(v('REFUSAL')[0]).toBe('REFUSING TO OPEN: the AXBB-E cannot run with UC100.dll 2.1.8.0 (sha256 bbbbbbbb) from '
      + 'C:\\x\\UC100.dll: that DLL has no GetVersio, which this bridge calls. Point LienCAM at a UCCNC install whose '
      + 'UC100.dll has it. (compat.json: fixture)')
  })
  it('skips a malformed row with one reason each and keeps the rest', () => {
    expect(v('FIX_ROWS')).toEqual(['2'])
    expect(v('FIX_LOG')).toEqual([
      '[bridge] compat.json row 3 skipped: a cannot-run row is judged before Open, when fw, hw and dllVersion are not known yet',
      "[bridge] compat.json row 4 skipped: status must be proven or cannot-run, not 'untested'",
      '[bridge] compat.json row 5 skipped: a proven row names deviceType, fw, dllVersion and dllSha256',
      '[bridge] compat.json row 6 skipped: a cannot-run row names deviceType, dllFileVersion or dllSha256',
      '[bridge] compat.json row 7 skipped: dllSha256 is not 64 hex digits',
    ])
  })
  it('an unreadable record is no record: one line, nothing refused; an absent one says nothing', () => {
    expect(v('BROKEN_ROWS')).toEqual(['0'])
    expect(v('BROKEN_LOGS')).toEqual(['1'])
    expect(v('MISSING_ROWS')).toEqual(['0'])
    expect(v('MISSING_LOGS')).toEqual(['0'])
  })
  it('says an untested combination once per combination, and nothing for proven', () => {
    expect(v('LINE_A1')[0]).toBe('[bridge] this controller combination has not been tested with LienCAM yet: AXBB-E firmware 1006. '
      + 'It connected; nothing is refused for being untested.')
    expect(v('LINE_A2')).toEqual(['null'])
    expect(v('LINE_B1')).toEqual(['True'])
    expect(v('LINE_PROVEN')).toEqual(['null'])
  })
  it('reads a DLL file version and full sha256 the way the record writes them', () => {
    expect(v('FILEVER')).toEqual(['2.1.9.0'])
    expect(v('SELF_FILEVER')).toEqual(['2.1.9.0'])
    expect(v('SELF_SHA')).toEqual([selfSha])
    expect(v('ABSENT_SHA')).toEqual(['null'])
  })
})

describe.skipIf(!canRun)('WO-2844 real bridge on a demo board (SimUC100)', () => {
  it('an untested combination connects, hello says so, and the console line comes once', () => {
    expect(untested.listening).toBe(true)
    expect(untested.sessions).toHaveLength(2)
    for (const s of untested.sessions) expect(s.compat).toEqual({
      status: 'untested', board: 'AXBB-E', fw: 7777, hw: 1, api: 1, dllFileVersion: null, dllSha256: null, evidence: null,
    })
    const line = '[bridge] this controller combination has not been tested with LienCAM yet: AXBB-E firmware 7777, hardware 1, '
      + 'API 1, UC100.dll unavailable. It connected; nothing is refused for being untested.'
    expect(untested.sessions[0].console).toContain(line)
    expect(untested.sessions[1].console.filter((l) => l.includes('has not been tested'))).toEqual([])
    expect(untested.log).toContain('[bridge] compatibility: untested - AXBB-E firmware 7777, hardware 1, API 1, UC100.dll unavailable; '
      + 'not in compat.json, so it connects untested (ADR-0058 D2)')
    expect(untested.log).not.toMatch(/board table compat\.json/)
    expect(untested.log).not.toMatch(/REFUSING/)
  })
  it('a cannot-run row refuses before Open, naming the call, and nothing listens', () => {
    expect(refused.listening).toBe(false)
    expect(refused.log).toContain('[bridge] REFUSING TO OPEN: the AXBB-E cannot run with UC100.dll (version unreadable) '
      + '(sha256 unreadable) from (path unknown): that DLL has no ProbeStart, which this bridge calls.')
    expect(refused.log).not.toMatch(/\[sim-board\] Open board/)
    expect(refused.log).not.toMatch(/controller: AXBB-E/)
  })
})
