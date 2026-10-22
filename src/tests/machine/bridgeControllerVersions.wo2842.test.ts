// @vitest-environment node
// Desk proof only: execute the production version-read block with a fake API.
// The machine seat owns SimUC100 Open and the next normal board readback.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const source = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8').replace(/\r\n/g, '\n')
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const mcs = spawnSync('mcs', ['--version'], { encoding: 'utf8' }).status === 0
const canCompile = existsSync(csc) || mcs

function region(begin: string, end: string): string {
  const start = source.indexOf(begin)
  const stop = source.indexOf(end, start)
  if (start < 0 || stop < start) return '' // old source is a runnable negative control
  return source.slice(start, stop)
}

function run(): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo2842-'))
  const exe = path.join(root, 'Harness.exe')
  const cs = path.join(root, 'Harness.cs')
  const fixture = path.join(root, 'controller with spaces.dll')
  const versions = region('// BEGIN WO-2842 CONTROLLER VERSIONS', '// END WO-2842 CONTROLLER VERSIONS')
  const block = region('            UC100.Versio ver =', '            // OUTPUTS COME UP LIVE.')
    || region('            ControllerVersion ver =', '            // OUTPUTS COME UP LIVE.')
  const names = region('        public static string DeviceTypeName(int type)', '\n    }\n\n    public static class ControllerStartupWait')
  if (!block || !names) throw new Error('production version read or board names missing')
  const metadata = versions ? `
    Console.WriteLine("META=" + ControllerVersionLog.Line(new ControllerVersion {
      FWVersion=1005, HWVersion=1, DLLVersion=2190, SerialNumber=13437274, DeviceType=19
    }, 0, 19, args[0]));
    Console.WriteLine("MISSING=" + ControllerVersionLog.Line(new ControllerVersion(), 1, 19, args[0]+".missing"));
    Console.WriteLine("LOADED=" + (ControllerVersionLog.LoadedDllPath() ?? "unavailable"));
  ` : ''
  writeFileSync(cs, `
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
[assembly: System.Reflection.AssemblyFileVersion("2.1.9.0")]
namespace LienCAM {
${versions}
static class BoardPinTables { ${names} }
static class UC100 {
  [StructLayout(LayoutKind.Sequential)] public struct Versio {
    public int FWVersion, HWVersion, DLLVersion, SerialNumber;
  }
  public static int Rc, Calls, BufferBytes, Fifth=19, Fw=1005;
  public static unsafe int GetVersio(ref Versio v) {
    Calls++;
    // Write only inside the caller's measured allocation; never reproduce an
    // out-of-bounds native write on the old four-int control.
    fixed (Versio* p = &v) {
      int* words = (int*)p;
      words[0]=Fw; words[1]=1; words[2]=2190; words[3]=13437274;
      if (BufferBytes >= 20 && Fifth != 0) words[4]=Fifth;
    }
    return Rc;
  }
}
class Harness {
  int boardType=19;
  string firmware;
  void Read() {
    // The sole test instrumentation measures the actual production local.
    ${block.replace(/(\s*)(int versionRc|firmware =)/, '$1UC100.BufferBytes = Marshal.SizeOf(ver);$1$2')}
    Console.WriteLine("SIZE="+Marshal.SizeOf(ver));
    Console.WriteLine("FIFTH="+(ver.GetType().GetField("DeviceType") == null ? "absent" : ver.GetType().GetField("DeviceType").GetValue(ver).ToString()));
    Console.WriteLine("FIRMWARE="+(firmware ?? "null"));
  }
  static void Main(string[] args) {
    Harness h = new Harness();
    h.Read();
    UC100.Fw=1008; h.Read(); // repeated Open refreshes the data
    h.boardType=8; h.Read();
    UC100.Rc=1; h.Read(); // even a partially filled failed read is unavailable
    UC100.Rc=0; UC100.Fifth=0; h.boardType=19; h.Read(); // four-int DLL/sim
    Console.WriteLine("CALLS="+UC100.Calls);
    ${metadata}
  }
}
}
`)
  try {
    const compiled = existsSync(csc)
      ? spawnSync(csc, ['/nologo', '/unsafe', '/platform:x64', `/out:${exe}`, cs], { encoding: 'utf8' })
      : spawnSync('mcs', ['-unsafe', `-out:${exe}`, cs], { encoding: 'utf8' })
    if (compiled.status !== 0) throw new Error(`csc: ${compiled.stdout}\n${compiled.stderr}`)
    // A managed PE supplies real file-version metadata and known hash bytes;
    // it is never loaded as a controller DLL or presented as board evidence.
    const bytes = readFileSync(exe)
    writeFileSync(fixture, bytes)
    const output = existsSync(csc)
      ? execFileSync(exe, [fixture], { encoding: 'utf8' })
      : execFileSync('mono', [exe, fixture], { encoding: 'utf8' })
    return [...output.trim().split(/\r?\n/), `HASH=${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}`, `PATH=${fixture}`]
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const lines = canCompile ? run() : []
const values = (key: string) => lines.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1))
const controllerLines = () => lines.filter(line => line.startsWith('[bridge] controller:'))

describe('WO-2842 controller versions', () => {
  it.skipIf(!canCompile)('allocates five ints and receives the fifth native field', () => {
    expect(values('SIZE')).toEqual(['20', '20', '20', '20', '20'])
    expect(values('FIFTH')).toEqual(['19', '19', '19', '19', '0'])
  })
  it.skipIf(!canCompile)('reads once and logs once on each Open including reopen', () => {
    expect(values('CALLS')).toEqual(['5'])
    expect(controllerLines()).toHaveLength(5)
    expect(controllerLines()[0]).toContain('fw 1005 hw 1 api 2190')
    expect(controllerLines()[1]).toContain('fw 1008 hw 1 api 2190')
  })
  it.skipIf(!canCompile)('uses the selected board name for firmware and the log', () => {
    expect(values('FIRMWARE')[0]).toBe('AXBB-E fw 1005 / hw 1 / dll 2190')
    expect(values('FIRMWARE')[2]).toBe('UC400ETH fw 1008 / hw 1 / dll 2190')
    expect(controllerLines()[2]).toContain('controller: UC400ETH serial 13437274')
  })
  it.skipIf(!canCompile)('logs unavailable versions on a failed read and clears stale firmware', () => {
    expect(values('FIRMWARE')[3]).toBe('null')
    expect(controllerLines()[3]).toContain('serial unavailable fw unavailable hw unavailable api unavailable')
    expect(controllerLines()[3]).toContain('GetVersio rc=1')
  })
  it.skipIf(!canCompile)('keeps the four-int simulator and older DLL route with the selected board name', () => {
    expect(values('FIFTH')[4]).toBe('0')
    expect(controllerLines()[4]).toContain('controller: AXBB-E serial 13437274 fw 1008')
  })
  it.skipIf(!canCompile)('logs real file version, eight sha256 hex digits, and the whole path', () => {
    expect(values('META')[0]).toBe(`controller: AXBB-E serial 13437274 fw 1005 hw 1 api 2190 dll 2.1.9.0 sha256 ${values('HASH')[0]} from ${values('PATH')[0]}`)
  })
  it.skipIf(!canCompile)('does not refuse when DLL metadata is missing', () => {
    expect(values('MISSING')[0]).toBe(`controller: AXBB-E serial unavailable fw unavailable hw unavailable api unavailable dll unavailable sha256 unavailable from ${values('PATH')[0]}.missing GetVersio rc=1`)
    expect(values('LOADED')).toEqual(['unavailable']) // this desk harness loads no UC100.dll
  })
  it('keeps version acquisition after trajectory read and before the existing output enable', () => {
    expect(source.match(/UC100\.GetVersio\(/g)).toHaveLength(1)
    const open = source.slice(source.indexOf('public bool Open(int board, string profilePath)'))
    expect(open.indexOf('UC100.GetTrajParam')).toBeLessThan(open.indexOf('UC100.GetVersio'))
    expect(open.indexOf('UC100.GetVersio')).toBeLessThan(open.indexOf('UC100.SetOffline(false)'))
  })
})
