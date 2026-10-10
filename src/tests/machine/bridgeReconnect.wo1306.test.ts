import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const machineSource = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8')
const bridgeSource = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8')

function startupWaitSource(): string {
  const begin = machineSource.indexOf('// BEGIN WO-1306 CONTROLLER STARTUP WAIT')
  const end = machineSource.indexOf('// END WO-1306 CONTROLLER STARTUP WAIT')
  if (begin < 0 || end < begin) throw new Error('WO-1306 startup wait seam is missing')
  return machineSource.slice(
    begin + '// BEGIN WO-1306 CONTROLLER STARTUP WAIT'.length,
    end,
  )
}

function autoBoardDiscoverySource(): string {
  const begin = bridgeSource.indexOf('// BEGIN WO-1306 AUTO BOARD DISCOVERY')
  const end = bridgeSource.indexOf('// END WO-1306 AUTO BOARD DISCOVERY')
  if (begin < 0 || end < begin) throw new Error('WO-1306 auto board discovery seam is missing')
  return bridgeSource.slice(
    begin + '// BEGIN WO-1306 AUTO BOARD DISCOVERY'.length,
    end,
  )
}

// The desk harness compiles C# with the Windows .NET Framework compiler. On the
// Spark (Linux) there is no csc.exe, so the harness case is skipped there rather
// than reported as a red the remote gate cannot act on (WO-1306 landing gate,
// 2026-09-10: it was the one NEW failure on an otherwise green remote run).
const CSC = path.join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runDeskHarness(): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo1306-'))
  const source = path.join(root, 'Harness.cs')
  const executable = path.join(root, 'Harness.exe')
  const compiler = CSC
  const harness = `
using System;
using System.Collections.Generic;
namespace LienCAM {
${startupWaitSource()}
public static class Harness {
  static class BoardOwner {
    public static void AssertOwner(string operation) {}
  }
${autoBoardDiscoverySource()}
  static void Require(bool condition, string message) {
    if (!condition) throw new Exception(message);
  }
  public static void Main() {
    int calls = 0;
    int sleeps = 0;
    var lines = new List<string>();
    ControllerEnumeration last;
    bool ready = ControllerStartupWait.UntilEnumerable(
      "board 1",
      delegate {
        calls++;
        return calls <= 3
          ? new ControllerEnumeration(0, 0)
          : new ControllerEnumeration(0, 1);
      },
      delegate(int milliseconds) { Require(milliseconds == 1000, "wrong poll interval"); sleeps++; },
      lines.Add,
      out last);
    Require(ready, "late AXBB-E never became ready");
    Require(calls == 4 && sleeps == 3, "wait did not follow the device condition");
    Require(last.Count == 1, "ready descriptor was not retained");
    Require(ControllerStartupWait.IsSupportedDeviceType(19), "AXBB-E descriptor was refused");
    Require(!lines.Exists(delegate(string line) { return line.Contains("board type 0"); }),
      "empty enumeration was misreported as an unknown board");
    Console.WriteLine("late-device: connected after " + calls + " enumerations");

    calls = 0;
    sleeps = 0;
    int discovered = DiscoverBoard(
      delegate {
        calls++;
        return calls <= 3
          ? new ControllerEnumeration(0, 0)
          : new ControllerEnumeration(0, 1);
      },
      delegate(int id) { return new ControllerDeviceInfo(0, 19, 0x1306); },
      delegate(int milliseconds) { Require(milliseconds == 1000, "wrong discovery poll interval"); sleeps++; },
      lines.Add);
    Require(discovered == 1, "--board auto did not select the late controller");
    Require(calls == 4 && sleeps == 3, "--board auto did not wait for enumeration");
    Require(!lines.Exists(delegate(string line) { return line.Contains("refusing to start"); }),
      "--board auto retained its zero-device startup refusal");
    Console.WriteLine("auto-board: selected late board " + discovered);

    calls = 0;
    ready = ControllerStartupWait.UntilEnumerable(
      "board 1",
      delegate { calls++; return new ControllerEnumeration(0, 1); },
      delegate(int milliseconds) { throw new Exception("present device unexpectedly waited"); },
      delegate(string line) {},
      out last);
    Require(ready && calls == 1, "present unknown device did not reach the type gate immediately");
    Require(!ControllerStartupWait.IsSupportedDeviceType(0), "type-0 device bypassed the refusal gate");
    Console.WriteLine("type-0-device: refused immediately");
  }
}}
`
  try {
    writeFileSync(source, harness)
    execFileSync(compiler, ['/nologo', `/out:${executable}`, source], { stdio: 'pipe' })
    return execFileSync(executable, { encoding: 'utf8' }).trim().split(/\r?\n/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('WO-1306 bridge reconnect startup', () => {
  it.skipIf(!existsSync(CSC))('waits for a late AXBB-E and still refuses an immediately present type-0 device', () => {
    expect(runDeskHarness()).toEqual([
      'late-device: connected after 4 enumerations',
      'auto-board: selected late board 1',
      'type-0-device: refused immediately',
    ])
  })

  it('keeps the production open path behind enumeration and the existing refusal sentence', () => {
    const wait = machineSource.indexOf('ControllerStartupWait.UntilEnumerable(')
    const deviceInfo = machineSource.indexOf('string gate = CheckBoardType(board);', wait)
    expect(wait).toBeGreaterThan(0)
    expect(deviceInfo).toBeGreaterThan(wait)
    expect(machineSource).toContain('return BoardTypeRefusal(type);')
    expect(machineSource).toContain('REFUSING TO OPEN: this controller reports DeviceInfo board type ')
    expect(bridgeSource).toContain("if (discover)")
    expect(bridgeSource).toContain('found = DiscoverBoard(')
  })
})
