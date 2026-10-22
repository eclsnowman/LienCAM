// @vitest-environment node

// WO-2847 (ADR-0058 V6): UC100.dll starts a controller firmware update by
// itself inside Open and returns rc 11 while it runs. UCCNC stays alive and
// calls Open again every 50 ms until rc leaves 11 (decompile Form1.cs:1233-1263,
// 5260-5280; src/tests/evidence/WO-2843/README.md). The bridge used to treat
// rc 11 as a refusal and exit, and Electron respawned it into the same update.
//
// The fake board below runs the PRODUCTION lines of Machine.Open - from its
// UC100.Open call to `opened = true;` - against a scripted UC100.Open, so the
// same test runs against the old exit path (and fails at "bridge exited") and
// against the fix. The Electron half loads the real electron/main.cjs.

import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { electronMainRequire } from '../support/electronMainRequire'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeClientMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ConsoleEntry, ControllerEvents } from '../../lib/machine/controller'

const machineSource = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8').replace(/\r\n/g, '\n')
const bridgeSource = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8').replace(/\r\n/g, '\n')

const IN_PROGRESS = '[bridge] CONTROLLER FIRMWARE UPDATE IN PROGRESS'
const FINISHED = '[bridge] CONTROLLER FIRMWARE UPDATE FINISHED'
const ENDED = '[bridge] CONTROLLER FIRMWARE UPDATE ENDED'

const CSC = nodePath.join(
  nodeProcess.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

/** The firmware-update seam, or nothing on a source that predates it. */
function updateWaitSource(): string {
  const begin = machineSource.indexOf('// BEGIN WO-2847 FIRMWARE UPDATE WAIT')
  const end = machineSource.indexOf('// END WO-2847 FIRMWARE UPDATE WAIT')
  return begin < 0 || end < begin ? '' : machineSource.slice(begin, end)
}

/** Machine.Open from its UC100.Open call up to the line that marks it open. */
function openDecisionSource(): string {
  const open = machineSource.indexOf('public bool Open(int board, string profilePath)')
  const begin = machineSource.indexOf('int rc = UC100.Open(board);', open)
  const end = machineSource.indexOf('opened = true;', begin)
  if (open < 0 || begin < 0 || end < 0) throw new Error('Machine.Open decision lines are missing')
  return machineSource.slice(begin, end)
}

const METHOD_END = '\n        }\n'

/** Machine's report region: ReportLine, openReport, LiveConsole, Report, OpenReport. */
function reportRegionSource(): string {
  const begin = machineSource.indexOf('public sealed class ReportLine')
  const open = machineSource.indexOf('public ReportLine[] OpenReport()', begin)
  const end = machineSource.indexOf(METHOD_END, open)
  if (begin < 0 || open < 0 || end < 0) throw new Error('Machine report region is missing')
  return machineSource.slice(begin, end + METHOD_END.length)
}

/** A marked block, or nothing on a source that predates it. */
function marked(source: string, name: string): string {
  const begin = source.indexOf(`// BEGIN ${name}`)
  const end = source.indexOf(`// END ${name}`)
  return begin < 0 || end < begin ? '' : source.slice(begin, end)
}

/** Machine.ReopenLostBoard, the whole production method. */
function reopenSource(): string {
  const begin = machineSource.indexOf('public bool ReopenLostBoard()')
  const end = machineSource.indexOf(METHOD_END, begin)
  if (begin < 0 || end < 0) throw new Error('Machine.ReopenLostBoard is missing')
  return machineSource.slice(begin, end + METHOD_END.length)
}

/** Bridge.cs's hello replay of the open report, then whatever follows it in
 *  the WO-2847 hello block. */
function helloReplaySource(): string {
  const begin = bridgeSource.indexOf('Machine.ReportLine[] importReport = machine.OpenReport();')
  const last = 'SendConsoleFrame(ws, "rx", importReport[i].Text, importReport[i].Severity);'
  const end = bridgeSource.indexOf(last, begin)
  if (begin < 0 || end < 0) throw new Error('the hello open-report replay is missing')
  return `${bridgeSource.slice(begin, end + last.length)}\n${marked(bridgeSource, 'WO-2847 HELLO FIRMWARE UPDATE LINES')}`
}

/** Bridge.cs's WsFrames, the whole production class: the outbox, its writer
 *  and the frame reader (fix round 4: the acknowledgement rides its pongs). */
function wsFramesSource(): string {
  const begin = bridgeSource.indexOf('    class WsFrames\n')
  const end = bridgeSource.indexOf('\n    }\n}\n', begin)
  if (begin < 0 || end < 0) throw new Error('Bridge.cs WsFrames is missing')
  return bridgeSource.slice(begin, end + '\n    }\n'.length)
}

function explainSource(): string {
  const begin = machineSource.indexOf('public static string Explain(int rc)')
  const end = machineSource.indexOf('\n        }\n', begin)
  if (begin < 0 || end < 0) throw new Error('Machine.Explain is missing')
  return machineSource.slice(begin, end + '\n        }\n'.length)
}

interface BoardRun {
  result: 'connected' | 'bridge exited'
  opens: number
  offlines: number
  gapsMs: number[]
  lines: string[]
}

/** What each session-mode run's bridge printed - electron/main.cjs's input. */
const bridgeStdout: Record<string, string[]> = {}

/** Fix round 4: what each run's socket clients actually READ, as
 *  `GOT <session> <text>` - the receiving side, not what the bridge sent. */
const clientGot: Record<string, string[]> = {}

/** Each run's harness lines, for the console tests at the end of the file. */
let rawRuns: Record<string, string[]> | null = null
const raw_ = (name: string): string[] => rawRuns?.[name] ?? []

/** Each run is [mode, Open rc script, hosted?]; the answer is that run's
 *  harness lines (bridgeStdout gets the bridge's own). hosted: run as
 *  electron/main.cjs runs it, with LIENCAM_BRIDGE_HOST_CONSOLE=1.
 *  open: Machine.Open alone. reopen: a live session loses the board, the
 *  reopen meets an update ending in an error, the poll loop passes again, then
 *  Disconnect, Connect (its hello) and the next reopen pass. startup: the
 *  update runs inside the startup Open with no socket, then two hellos. */
function runFakeBoard(scripts: Record<string, [string, number[], boolean?]>): Record<string, string[]> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'liencam-wo2847-'))
  const source = nodePath.join(root, 'Harness.cs')
  const executable = nodePath.join(root, 'Harness.exe')
  const harness = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
namespace LienCAM {
${updateWaitSource()}
${wsFramesSource()}
static class UC100 {
  public static Queue<int> Script = new Queue<int>();
  public static int Opens, Offlines;
  public static List<long> At = new List<long>();
  public static Stopwatch Clock = Stopwatch.StartNew();
  public static Action<int> OnOpen;
  public static int Open(int board) {
    Opens++;
    At.Add(Clock.ElapsedMilliseconds);
    if (OnOpen != null) OnOpen(Opens);
    return Script.Count > 0 ? Script.Dequeue() : 0;
  }
  public static int SetOffline(bool offline) { if (offline) Offlines++; return 0; }
  public static int ListDevices(ref int found) { found = 1; return 0; }
  public static int Close() { return 0; }
}
static class BoardOwner { public static void AssertOwner(string what) { } }
class Machine {
${reportRegionSource()}
${marked(machineSource, 'WO-2847 FIRMWARE UPDATE LINES')}
${explainSource()}
  bool opened;
  public bool Open(int board) {
${openDecisionSource()}
    opened = true;
    return opened;
  }
  public bool Open(int board, string profilePath) { return Open(board); }

  // ReopenLostBoard's state, as a board that was open and has been lost.
  public bool boardLost = true;
  public int openBoard = 1;
  string openProfilePath = "profile.pro";
  int notOpenStreak, reopenAttempts, lastReopenTick;
  bool staleHandleClosed;
  const int ReopenIntervalMs = 0;
  int injectReopenFailures, injectUnconfiguredReopens;
  bool injectRefusalOnThisOpen;
  public int Reopened;
  void AfterProvedReopen(int attempt) { Reopened++; }
${reopenSource()}
}
public static class Harness {
  static Machine machine;
  static WsFrames ws;
  static readonly List<string> Said = new List<string>();
  static bool inHello;
  static void Log(string s) { }
  // Bridge.cs's console frame, reduced to its text; HELLO or LIVE says which
  // moment sent it. The frame really goes out through the production WsFrames.
  static void SendConsoleFrame(WsFrames socket, string dir, string text, string severity) {
    Said.Add((inHello ? "HELLO " : "LIVE ") + text);
    socket.SendText(text);
  }
  static void Send(WsFrames socket, string t, object value) {
    Said.Add((inHello ? "HELLO " : "LIVE ") + ((Json.Obj)value)["text"]);
    var frame = new Json.Obj(); frame.Set("t", t); frame.Set("v", value);
    socket.SendText(Json.Write(frame));
  }
${marked(bridgeSource, 'WO-2847 FIRMWARE UPDATE ACK')}
${bridgeSource.includes('static bool HandleFirmwareUpdateAck') ? '' : 'static bool HandleFirmwareUpdateAck(WsFrames socket, object parsed) { return false; }'}
  // The two Bridge.cs moments: a session starting (the operator's Connect) and its hello.
  static void SessionStarts() {
${marked(bridgeSource, 'WO-2847 OPERATOR CONNECT')}
  }
  static void Hello() {
    inHello = true;
    try {
${helloReplaySource()}
    } finally { inHello = false; }
  }

  // ---- A real loopback WebSocket per session (fix round 4) ----------------
  // The bridge end is the production WsFrames; the client end reads frames in
  // order and answers each ping with its pong, as a browser does (RFC 6455
  // 5.5.2) - or, for a client that never reads, does nothing at all.
  static int sessionNo;
  static TcpClient serverTcp, clientTcp;
  static Thread serverReader, clientReader;
  static readonly List<string> Got = new List<string>();
  static readonly AutoResetEvent settled = new AutoResetEvent(false);
  static volatile string settleToken;
  static int settleNo;
  static readonly FieldInfo OnPongField = typeof(WsFrames).GetField("OnPong");
  static readonly MethodInfo EnqueueFrame = typeof(WsFrames).GetMethod("Enqueue", BindingFlags.Instance | BindingFlags.NonPublic);

  static bool ReadExactly(NetworkStream net, byte[] buf, int count) {
    int got = 0;
    while (got < count) { int n = net.Read(buf, got, count - got); if (n <= 0) return false; got += n; }
    return true;
  }

  static void ClientText(NetworkStream net, string text) {
    byte[] data = Encoding.UTF8.GetBytes(text);
    if (data.Length >= 126) throw new Exception("oversized harness receipt");
    var mask = new byte[] { 0x11, 0x22, 0x33, 0x44 };
    var frame = new byte[6 + data.Length]; frame[0] = 0x81; frame[1] = (byte)(0x80 | data.Length);
    Array.Copy(mask, 0, frame, 2, 4);
    for (int i = 0; i < data.Length; i++) frame[6 + i] = (byte)(data[i] ^ mask[i & 3]);
    net.Write(frame, 0, frame.Length); net.Flush();
  }

  static void ClientLoop(object state) {
    object[] args = (object[])state;
    NetworkStream net = (NetworkStream)args[0];
    int session = (int)args[1];
    try {
      var hdr = new byte[2];
      while (ReadExactly(net, hdr, 2)) {
        int opcode = hdr[0] & 0x0F;
        long len = hdr[1] & 0x7F;
        if (len == 126) { var e = new byte[2]; if (!ReadExactly(net, e, 2)) return; len = (e[0] << 8) | e[1]; }
        else if (len == 127) { var e = new byte[8]; if (!ReadExactly(net, e, 8)) return; len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | e[i]; }
        var data = new byte[len];
        if (len > 0 && !ReadExactly(net, data, (int)len)) return;
        if (opcode == 0x1) {
          string text = Encoding.UTF8.GetString(data);
          if (text.StartsWith("harness settle ")) { ClientText(net, text); continue; }
          object parsed;
          if (Json.TryParse(text, out parsed) && Json.Str(parsed, "t") == "console") {
            object entry = Json.Get(parsed, "v");
            lock (Got) Got.Add("GOT " + session + " " + Json.Str(entry, "text"));
            string id = Json.Str(entry, "firmwareUpdateId");
            if (id != null) {
              var ack = new Json.Obj(); ack.Set("t", "firmwareUpdateAck"); ack.Set("id", id);
              ClientText(net, Json.Write(ack));
            }
          } else lock (Got) Got.Add("GOT " + session + " " + text);
        }
        if (opcode == 0x9) {
          var mask = new byte[] { 0x11, 0x22, 0x33, 0x44 };
          var pong = new byte[6 + data.Length];
          pong[0] = 0x8A; pong[1] = (byte)(0x80 | data.Length);
          Array.Copy(mask, 0, pong, 2, 4);
          for (int i = 0; i < data.Length; i++) pong[6 + i] = (byte)(data[i] ^ mask[i & 3]);
          net.Write(pong, 0, pong.Length);
          net.Flush();
        }
      }
    } catch (Exception) { }   // the session is over
  }

  static void ServerLoop(object state) {
    WsFrames frames = (WsFrames)state;
    try {
      byte[] payload;
      while (frames.TryReadFrame(out payload)) {
        if (payload == null) continue;
        string text = Encoding.UTF8.GetString(payload);
        if (text == settleToken) { settled.Set(); continue; }
        object parsed;
        if (Json.TryParse(text, out parsed)) HandleFirmwareUpdateAck(frames, parsed);
      }
    } catch (Exception) { }
  }

  /** The operator's Connect: a new socket, its session start and its hello,
   *  then Serve's LiveConsole. reads: the client reads (and answers pings). */
  static void Connect(bool reads) {
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    clientTcp = new TcpClient();
    clientTcp.Connect(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
    serverTcp = listener.AcceptTcpClient();
    listener.Stop();
    sessionNo++;
    ws = new WsFrames(serverTcp.GetStream());
    SessionStarts();
    Hello();
    if (OnPongField != null) {
      Action<byte[]> production = (Action<byte[]>)OnPongField.GetValue(ws);
      OnPongField.SetValue(ws, (Action<byte[]>)delegate(byte[] pong) {
        if (production != null) production(pong);
        if (Encoding.UTF8.GetString(pong) == settleToken) settled.Set();
      });
    }
    WsFrames sessionWs = ws;
    machine.LiveConsole = delegate(string text, string severity) { SendConsoleFrame(sessionWs, "rx", text, severity); };
    serverReader = new Thread(ServerLoop); serverReader.IsBackground = true; serverReader.Start(ws);
    clientReader = null;
    if (reads) {
      clientReader = new Thread(ClientLoop); clientReader.IsBackground = true;
      clientReader.Start(new object[] { clientTcp.GetStream(), sessionNo });
    }
  }

  /** Everything sent so far has been read and answered: a ping of our own
   *  comes back only after the client has read and answered every frame
   *  queued before it. A source without pongs gets a short wait instead. */
  static void Settle() {
    settleToken = "harness settle " + (++settleNo);
    ws.SendText(settleToken);
    if (!settled.WaitOne(10000)) throw new Exception("the client never answered " + settleToken);
  }

  /** The session ends: Serve's teardown, then the socket closes. */
  static void Disconnect() {
    machine.LiveConsole = null;
${marked(bridgeSource, 'WO-2847 FIRMWARE UPDATE SESSION END')}
    ws.CloseOutbox();
    Thread.Sleep(50);
    try { clientTcp.Close(); } catch (Exception) { }
    try { serverTcp.Close(); } catch (Exception) { }
    if (clientReader != null) clientReader.Join(5000);
    serverReader.Join(5000);
  }

  static void Opens(string at) { Said.Add("OPENS " + at + " " + UC100.Opens); }
  // Bridge.cs's startup exit after a failed update; Environment.Exit ends the run here.
  class HarnessExit : Exception { }
  static void ExitWith(int code) { Said.Add("EXIT " + code); throw new HarnessExit(); }
  static bool StartupExit(bool opened) {
    try {
${marked(bridgeSource, 'WO-2847 STARTUP UPDATE EXIT').replace(/Environment\.Exit\(/g, 'ExitWith(')}
    } catch (HarnessExit) { return true; }
    return false;
  }

  static void Print(TextWriter real) {
    Console.SetOut(real);
    foreach (string line in Said) Console.WriteLine(line);
    lock (Got) foreach (string line in Got) Console.WriteLine(line);
  }

  // The bridge's own stdout in the session modes, handed to the test on
  // stderr: it is what electron/main.cjs reads.
  static readonly StringWriter BridgeOut = new StringWriter();

  public static void Main(string[] args) {
    try { Run(args); }
    finally { Console.Error.Write(BridgeOut.ToString()); }
  }

  static void Run(string[] args) {
    foreach (string rc in args[1].Split(',')) UC100.Script.Enqueue(int.Parse(rc));
    machine = new Machine();
    TextWriter real = Console.Out;
    if (args[0] == "quietReopen") {
      // The board is lost with nobody connected; the reopen meets an update
      // that ends in an error, the poll loop passes again, then a Connect.
      Console.SetOut(BridgeOut);
      machine.ReopenLostBoard();
      Opens("failed");
      for (int pass = 0; pass < 3; pass++) machine.ReopenLostBoard();
      Opens("auto");
      Connect(true);
      Settle();
      bool back = machine.ReopenLostBoard();
      Opens("connect");
      Said.Add("REOPENED " + (back && machine.Reopened == 1 && !machine.boardLost));
      Settle();
      Disconnect();
      Print(real);
      return;
    }
    if (args[0] == "midUpdateConnect") {
      // The board is lost with nobody connected and the reopen meets an
      // update; the operator connects while it runs, then reconnects.
      UC100.OnOpen = delegate(int n) {
        if (n == 2) { Said.Add("SESSION 1"); Connect(true); Settle(); }
        if (n == 3) { Disconnect(); Said.Add("SESSION 2"); Connect(true); Settle(); }
      };
      Console.SetOut(BridgeOut);
      bool back = machine.ReopenLostBoard();
      Said.Add("REOPENED " + (back && machine.Reopened == 1 && !machine.boardLost));
      Settle();
      Disconnect();
      Print(real);
      return;
    }
    if (args[0] == "reopen") {
      // Connected, the board is lost, and the reopen meets an update that ends in an error.
      Console.SetOut(BridgeOut);
      Connect(true);
      Settle();
      machine.ReopenLostBoard();
      Settle();
      Opens("failed");
      for (int pass = 0; pass < 5; pass++) machine.ReopenLostBoard();   // the poll loop's later passes
      Opens("auto");
      Disconnect();                                                     // Disconnect
      Connect(true);                                                    // Connect
      Settle();
      bool back = machine.ReopenLostBoard();
      Opens("connect");
      Said.Add("REOPENED " + (back && machine.Reopened == 1 && !machine.boardLost));
      Settle();
      Disconnect();
      Print(real);
      return;
    }
    if (args[0] == "writerClosed" || args[0] == "neverRead") {
      // Fix round 4 (astra audit 4). writerClosed: a session is live and its
      // socket writer has stopped (WriteLoop sets outboxClosed on a write
      // error) before Serve's teardown ends the session; the lost board's
      // update fails in that gap. neverRead: the session's client never reads
      // what is sent to it before its socket goes. Then two more Connects.
      Console.SetOut(BridgeOut);
      bool reads = args[0] == "writerClosed";
      Connect(reads);
      if (reads) { Settle(); ws.CloseOutbox(); Thread.Sleep(200); Said.Add("WRITER CLOSED"); }
      machine.ReopenLostBoard();
      Opens("failed");
      Disconnect();
      Said.Add("SESSION 2");
      Connect(true);
      Settle();
      Disconnect();
      Said.Add("SESSION 3");
      Connect(true);
      Settle();
      Disconnect();
      Print(real);
      return;
    }
    if (args[0] == "startup") {
      // The update runs inside the startup Open, before any socket exists.
      Console.SetOut(BridgeOut);
      bool ok = machine.Open(1);
      if (!StartupExit(ok)) {
        Connect(true);
        Settle();
        Disconnect();
        Said.Add("SECOND HELLO");
        Connect(true);
        Settle();
        Disconnect();
      }
      Console.SetOut(real);
      Console.WriteLine("RESULT " + (ok ? "connected" : "bridge exited"));
      foreach (string line in Said) Console.WriteLine(line);
      lock (Got) foreach (string line in Got) Console.WriteLine(line);
      return;
    }
    var captured = new StringWriter();
    Console.SetOut(captured);
    bool opened = machine.Open(1);
    Console.SetOut(real);
    Console.WriteLine("RESULT " + (opened ? "connected" : "bridge exited"));
    Console.WriteLine("OPENS " + UC100.Opens);
    Console.WriteLine("OFFLINES " + UC100.Offlines);
    var gaps = new List<string>();
    for (int i = 1; i < UC100.At.Count; i++) gaps.Add((UC100.At[i] - UC100.At[i - 1]).ToString());
    Console.WriteLine("GAPS " + string.Join(",", gaps.ToArray()));
    foreach (string line in captured.ToString().Split(new[] { "\\r\\n", "\\n" }, StringSplitOptions.RemoveEmptyEntries))
      Console.WriteLine("LINE " + line);
  }
}}
`
  try {
    writeFileSync(source, harness)
    try {
      execFileSync(CSC, ['/nologo', `/out:${executable}`, source, nodePath.resolve('pendant/uccnc-bridge/Json.cs')], { stdio: 'pipe' })
    } catch (error) {
      throw new Error(`fake board compile: ${String((error as { stdout?: unknown }).stdout)}\n${String(error)}`)
    }
    const runs: Record<string, string[]> = {}
    for (const [name, [mode, script, hosted]] of Object.entries(scripts)) {
      const env = { ...nodeProcess.env }
      delete env.LIENCAM_BRIDGE_HOST_CONSOLE
      if (hosted) env.LIENCAM_BRIDGE_HOST_CONSOLE = '1'
      const run = spawnSync(executable, [mode, script.join(',')], { encoding: 'utf8', env, timeout: 60_000 })
      if (run.status !== 0) throw new Error(`fake board ${name} failed: ${run.stderr}`)
      const lines = run.stdout.split(/\r?\n/).filter((line) => line !== '')
      runs[name] = lines.filter((line) => !line.startsWith('GOT '))
      clientGot[name] = lines.filter((line) => line.startsWith('GOT '))
      bridgeStdout[name] = run.stderr.split(/\r?\n/).filter((line) => line !== '')
    }
    return runs
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function boardRun(out: string[]): BoardRun {
  const value = (key: string) => out.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? ''
  return {
    result: value('RESULT') as BoardRun['result'],
    opens: Number(value('OPENS')),
    offlines: Number(value('OFFLINES')),
    gapsMs: value('GAPS') === '' ? [] : value('GAPS').split(',').map(Number),
    lines: out.filter((line) => line.startsWith('LINE ')).map((line) => line.slice(5)),
  }
}

const count = (lines: string[], prefix: string) => lines.filter((line) => line.startsWith(prefix)).length

const HOST_CONSOLE = '[bridge] FOR THE CONTROL CONSOLE '

// Round 5 uses the real controller and session console acceptance boundary.
// This transport supplies only the remote messages; it never acknowledges them.
class ReceiptTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeClientMessage[] = []
  duringStart: (() => void) | null = null
  failStart = false
  loseAck = false
  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
    this.duringStart?.()
    if (this.failStart) throw new Error('Connect interrupted after console frame')
    this.emit({ t: 'hello', v: {
      protocol: 1, bridge: 'WO-2847-receipts', readOnly: false,
      capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming: true, ownsSpindle: false, spindleCommands: false },
    } })
  }
  send(message: BridgeClientMessage): void {
    this.sent.push(message)
    if (message.t === 'firmwareUpdateAck' && this.loseAck) throw new Error('socket closed before ack write')
  }
  async close(): Promise<void> { this.events?.onClose('test socket closed') }
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  line(id: string): void {
    this.emit({ t: 'console', v: { dir: 'rx', severity: 'error',
      text: `${ENDED} - receipt test ${id}`, firmwareUpdateId: id } })
  }
  acks(): BridgeClientMessage[] { return this.sent.filter((m) => m.t === 'firmwareUpdateAck') }
}

describe('WO-2847 screen receipts by id, after console acceptance', () => {
  const controllers: import('../../lib/machine/uccncController').UccncController[] = []
  const memoryStorage = new Map<string, string>()
  let sequence = 0
  const id = () => `round5-client-${++sequence}`
  async function screen(events?: ControllerEvents) {
    const { buildContractEvents } = await import('../../lib/machine/machineSession')
    const { UccncController } = await import('../../lib/machine/uccncController')
    const { useMachineControl } = await import('../../store/machineControlStore')
    useMachineControl.setState({ consoleLines: [] })
    const controller = new UccncController(events ?? buildContractEvents())
    controllers.push(controller)
    return { controller, store: useMachineControl, events: events ?? buildContractEvents() }
  }
  afterEach(async () => {
    for (const controller of controllers.splice(0)) await controller.disconnect()
    vi.unstubAllGlobals()
  })

  it('Connect buffers without a receipt, then prints and acknowledges the exact id after success', async () => {
    const { controller, store } = await screen()
    const transport = new ReceiptTransport()
    const eventId = id()
    transport.duringStart = () => {
      transport.line(eventId)
      expect(transport.acks()).toEqual([])
      expect(store.getState().consoleLines).toEqual([])
    }
    await controller.connect({ kind: 'messages', transport })
    expect(store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toHaveLength(1)
    expect(transport.acks()).toEqual([{ t: 'firmwareUpdateAck', id: eventId }])
  })

  it('failed Connect discards its buffer without acknowledging; the next hello can replay and print it', async () => {
    const { controller, store } = await screen()
    const failed = new ReceiptTransport()
    const eventId = id()
    failed.failStart = true
    failed.duringStart = () => failed.line(eventId)
    await expect(controller.connect({ kind: 'messages', transport: failed })).rejects.toThrow('Connect interrupted')
    expect(failed.acks()).toEqual([])
    expect(store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toEqual([])
    const resumed = new ReceiptTransport()
    resumed.duringStart = () => resumed.line(eventId)
    await controller.connect({ kind: 'messages', transport: resumed })
    expect(store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toHaveLength(1)
    expect(resumed.acks()).toEqual([{ t: 'firmwareUpdateAck', id: eventId }])
  })

  it('a lost acknowledgement replays the same id, prints once, and acknowledges again after reconnect', async () => {
    const { controller, store } = await screen()
    const first = new ReceiptTransport()
    first.loseAck = true
    await controller.connect({ kind: 'messages', transport: first })
    const eventId = id()
    first.line(eventId)
    await controller.disconnect()
    const resumed = new ReceiptTransport()
    await controller.connect({ kind: 'messages', transport: resumed })
    resumed.line(eventId)
    resumed.line(eventId)
    expect(store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toHaveLength(1)
    expect(first.acks()).toHaveLength(1)
    expect(resumed.acks()).toEqual(Array(2).fill({ t: 'firmwareUpdateAck', id: eventId }))
  })

  it('a stale session rejects without printing or acknowledging; an accepted current event still prints once', async () => {
    const { buildContractEvents } = await import('../../lib/machine/machineSession')
    const rejected = buildContractEvents({ controller: null } as never)
    const { controller, store } = await screen(rejected)
    const transport = new ReceiptTransport()
    await controller.connect({ kind: 'messages', transport })
    const eventId = id()
    transport.line(eventId)
    expect(store.getState().consoleLines).toEqual([])
    expect(transport.acks()).toEqual([])
    rejected.onConsole = buildContractEvents().onConsole
    transport.line(eventId)
    expect(store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toHaveLength(1)
    expect(transport.acks()).toEqual([{ t: 'firmwareUpdateAck', id: eventId }])
  })

  it('a returning callback without console acceptance and an obsolete transport never acknowledge', async () => {
    let offered: ConsoleEntry | undefined
    const { controller } = await screen({ onConsole: (entry) => { offered = entry } })
    const first = new ReceiptTransport()
    await controller.connect({ kind: 'messages', transport: first })
    first.line(id())
    expect(first.acks()).toEqual([])
    expect(offered?.onAccepted).toBeTypeOf('function')
    const staleReceipt = offered?.onAccepted
    await controller.disconnect()
    const next = new ReceiptTransport()
    await controller.connect({ kind: 'messages', transport: next })
    staleReceipt?.()
    first.line(id())
    expect(first.acks()).toEqual([])
    expect(next.acks()).toEqual([])
  })

  it('renderer reload remembers printed ids and re-acknowledges the replay without printing twice', async () => {
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => memoryStorage.get(key) ?? null,
      setItem: (key: string, value: string) => memoryStorage.set(key, value),
    } })
    const first = await screen()
    const transport = new ReceiptTransport()
    await first.controller.connect({ kind: 'messages', transport })
    const eventId = id()
    transport.line(eventId)
    expect(first.store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toHaveLength(1)
    await first.controller.disconnect()
    vi.resetModules()
    const reloaded = await screen()
    const resumed = new ReceiptTransport()
    await reloaded.controller.connect({ kind: 'messages', transport: resumed })
    resumed.line(eventId)
    expect(reloaded.store.getState().consoleLines.filter((l) => l.text.includes(eventId))).toEqual([])
    expect(resumed.acks()).toEqual([{ t: 'firmwareUpdateAck', id: eventId }])
  })

  it.skipIf(!existsSync(CSC))('compiled bridge retains an overflowed outcome until the current screen acknowledges its exact id', () => {
    const executable = nodePath.join(nodeProcess.env.TEMP ?? tmpdir(), 'liencam-bridge-desk', 'liencam-bridge.exe')
    execFileSync(CSC, ['/nologo', '/unsafe', '/platform:x64', '/target:winexe', `/out:${executable}`,
      ...['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs', 'UC100_wrapper.cs'].map((p) => nodePath.resolve('pendant/uccnc-bridge', p))], { stdio: 'pipe' })
    const output = execFileSync('powershell.exe', ['-NoProfile', '-File',
      'src/tests/evidence/WO-2847/round5-ack-repro.ps1', '-Exe', executable], { encoding: 'utf8' })
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!)
    expect(result.nextHelloOutcomeLines, output).toBe(1)
    expect(result).toMatchObject({ wireHasExactId: true, exactBoundaryHeld: 1, dropped: 1,
      outcomeFramesAvailable: 0, ackPingsAvailable: 0, afterUnknownAck: 1,
      afterStaleSessionAck: 1, afterAcceptedAck: 0, afterDuplicateAck: 0 })
    expect(result.recordId).toMatch(/^fw[0-9a-f]{32}-\d+$/)
    const restarted = execFileSync('powershell.exe', ['-NoProfile', '-File',
      'src/tests/evidence/WO-2847/round5-ack-repro.ps1', '-Exe', executable], { encoding: 'utf8' })
    expect(JSON.parse(restarted.trim().split(/\r?\n/).at(-1)!).recordId).not.toBe(result.recordId)
  }, 60_000)
})

/** The progress line exactly as Machine.cs says it. */
function inProgressLine(): string {
  const source = updateWaitSource()
  const begin = source.indexOf('public const string InProgressLine = InProgressPrefix')
  const end = source.indexOf('";\n', begin) + 1
  return IN_PROGRESS + [...source.slice(begin, end).matchAll(/"([^"]*)"/g)].map((match) => match[1]).join('')
}

describe('WO-2847 the bridge waits out a firmware update the DLL started', () => {
  const raw = existsSync(CSC)
    ? runFakeBoard({
      updateThenConnected: ['open', [11, 11, 11, 11, 11, 0]],
      updateThenError: ['open', [11, 11, 11, 4]],
      noUpdate: ['open', [2]],
      reopenUpdateThenErrorThenConnect: ['reopen', [11, 11, 4, 0]],
      startupUpdateThenConnected: ['startup', [11, 11, 0]],
      // Fix round 2: the same routes run as electron/main.cjs runs the bridge.
      hostedStartupFinished: ['startup', [11, 11, 0], true],
      hostedStartupEnded: ['startup', [11, 11, 4], true],
      plainStartupEnded: ['startup', [11, 11, 4]],
      hostedReopenLive: ['reopen', [11, 11, 4, 0], true],
      hostedQuietReopen: ['quietReopen', [11, 11, 4, 0], true],
      hostedMidUpdate: ['midUpdateConnect', [11, 11, 11, 0], true],
      plainMidUpdate: ['midUpdateConnect', [11, 11, 11, 0]],
      plainQuietReopen: ['quietReopen', [11, 11, 4, 0]],
      // Fix round 4: the socket writer has closed, or the client never reads.
      plainWriterClosed: ['writerClosed', [11, 11, 4]],
      hostedWriterClosed: ['writerClosed', [11, 11, 4], true],
      plainNeverRead: ['neverRead', [11, 11, 4]],
    })
    : null
  rawRuns = raw
  // WO2847_WRITE_STDOUT=1 refreshes the journey's input (shoot-console.mjs).
  if (raw !== null && nodeProcess.env.WO2847_WRITE_STDOUT === '1') {
    writeFileSync('src/tests/evidence/WO-2847/bridge-stdout.json', `${JSON.stringify({
      source: 'fake board, production Machine.cs/Bridge.cs blocks (failedUpdateMessage.wo2847.test.ts runFakeBoard)',
      runs: bridgeStdout,
    }, null, 2)}\n`)
  }
  const runs = raw === null ? null : {
    updateThenConnected: boardRun(raw.updateThenConnected),
    updateThenError: boardRun(raw.updateThenError),
    noUpdate: boardRun(raw.noUpdate),
  }

  it.skipIf(runs === null)('stays up through rc 11, re-opens every ~50 ms, says so once, and ends connected', () => {
    const run = runs!.updateThenConnected
    expect(run.result).toBe('connected')
    expect(run.opens).toBe(6)
    // UCCNC: SetOffline(true) after every Open while it waits.
    expect(run.offlines).toBe(6)
    expect(run.gapsMs).toHaveLength(5)
    for (const gap of run.gapsMs) {
      expect(gap).toBeGreaterThanOrEqual(40)
      expect(gap).toBeLessThan(1_000)
    }
    expect(count(run.lines, IN_PROGRESS)).toBe(1)
    expect(run.lines.find((line) => line.startsWith(IN_PROGRESS)))
      .toContain('do not close LienCAM and do not power off the controller')
    expect(count(run.lines, FINISHED)).toBe(1)
    expect(run.lines).toHaveLength(2)
  })

  it.skipIf(runs === null)('an update ending in an error code reports it once, explained, and stops', () => {
    const run = runs!.updateThenError
    expect(run.result).toBe('bridge exited')
    expect(run.opens).toBe(4)
    expect(count(run.lines, IN_PROGRESS)).toBe(1)
    expect(count(run.lines, ENDED)).toBe(1)
    expect(run.lines.find((line) => line.startsWith(ENDED)))
      .toContain(' - the link to the controller failed (rc 4)')
    // Fix round 3: an AXBB-E is on Ethernet - the line does not say USB.
    expect(run.lines.join(' ')).not.toContain('USB')
    expect(count(run.lines, '[bridge] Open ')).toBe(0)
    expect(run.lines).toHaveLength(2)
  })

  it.skipIf(runs === null)('any other Open rc is untouched: one Open, no SetOffline, the existing line', () => {
    const run = runs!.noUpdate
    expect(run).toMatchObject({ result: 'bridge exited', opens: 1, offlines: 0 })
    expect(run.lines).toEqual(['[bridge] Open no controller was found (rc 2)'])
  })

  // Fix round 1 (astra audit): a failed update on the lost-board route latched
  // every later reopen shut, so the Connect its own line advises never reached
  // Open again. No automatic retry; the operator's Connect is the retry.
  it.skipIf(raw === null)('after an update fails during a reopen nothing retries by itself, and the next Connect reaches Open and connects', () => {
    const out = raw!.reopenUpdateThenErrorThenConnect
    expect(out).toContain('OPENS failed 3')
    expect(out).toContain('OPENS auto 3')
    expect(out).toContain('OPENS connect 4')
    expect(out).toContain('REOPENED True')
  })

  it.skipIf(raw === null)('a live session hears the progress and the outcome once each, and the next hello does not replay them', () => {
    const out = raw!.reopenUpdateThenErrorThenConnect
    expect(count(out, `LIVE ${IN_PROGRESS}`)).toBe(1)
    expect(count(out, `LIVE ${ENDED}`)).toBe(1)
    expect(out.filter((line) => line.startsWith('HELLO '))).toEqual([])
  })

  it.skipIf(raw === null)('an update inside the startup Open is said once, at the first hello, by its outcome - never as a stale "in progress"', () => {
    const out = raw!.startupUpdateThenConnected
    expect(out[0]).toBe('RESULT connected')
    const hellos = out.slice(1)
    const second = hellos.indexOf('SECOND HELLO')
    expect(second).toBeGreaterThan(0)
    expect(hellos.slice(0, second)).toEqual([expect.stringMatching(/^HELLO \[bridge\] CONTROLLER FIRMWARE UPDATE FINISHED - /)])
    expect(hellos.slice(second + 1)).toEqual([])
    expect(count(hellos, `HELLO ${IN_PROGRESS}`)).toBe(0)
  })

  // Fix round 2 (two audit FAILs, one cause): a line about the update must
  // not depend on a session existing. Run as Electron runs it, a line no
  // session heard goes to the host instead of waiting for a hello, and a line
  // a session heard is not handed to the host as well.
  it.skipIf(raw === null)('hosted: a startup update hands its progress and outcome to the host, once each, and no hello repeats them', () => {
    for (const name of ['hostedStartupFinished', 'hostedStartupEnded']) {
      const out = bridgeStdout[name]
      expect(count(out, `${HOST_CONSOLE}warn ${IN_PROGRESS}`)).toBe(1)
      expect(count(out, HOST_CONSOLE)).toBe(2)
      expect(raw![name].filter((line) => line.startsWith('HELLO '))).toEqual([])
    }
    expect(count(bridgeStdout.hostedStartupFinished, `${HOST_CONSOLE}warn ${FINISHED}`)).toBe(1)
    expect(raw!.hostedStartupFinished).not.toContain('EXIT 11')
    const ended = bridgeStdout.hostedStartupEnded
    expect(count(ended, `${HOST_CONSOLE}error ${ENDED}`)).toBe(1)
    expect(raw!.hostedStartupEnded[0]).toBe('RESULT bridge exited')
    expect(raw!.hostedStartupEnded).toContain('EXIT 11')
  })

  // Fix round 3 (astra audit 3): the last line printed is electron/main.cjs's
  // lastExit.error, which a Connect or Restart failure quotes. Hosted, the
  // outcome already went to the host, so that line only points at it; run by
  // hand or by the supervisor, the explained outcome stays the last line.
  it.skipIf(raw === null)('a failed startup update exits 11; hosted, its last line points at the console instead of repeating the outcome', () => {
    const hosted = bridgeStdout.hostedStartupEnded
    expect(hosted[hosted.length - 1]).toBe('[bridge] exiting: the controller firmware update ended without opening the controller - the Control console says why.')
    expect(hosted[hosted.length - 2]).toMatch(/^\[bridge\] CONTROLLER FIRMWARE UPDATE ENDED .*\(rc 4\)/)
    const plain = bridgeStdout.plainStartupEnded
    expect(raw!.plainStartupEnded).toContain('EXIT 11')
    expect(plain[plain.length - 1]).toMatch(/^\[bridge\] CONTROLLER FIRMWARE UPDATE ENDED .*\(rc 4\)/)
    expect(count(plain, '[bridge] exiting')).toBe(0)
  })

  // Fix round 4 (astra audit 4): round 2 sent a hosted line to a live session
  // INSTEAD of the host whenever the send returned, and a send into a closed
  // outbox returns too. Hosted, the host is now the one carrier, session or
  // not, so no send's return decides anything; the socket carries none.
  it.skipIf(raw === null)('hosted: every line goes to the host whether or not a session is live, and the socket carries none', () => {
    const out = raw!.hostedReopenLive
    expect(count(bridgeStdout.hostedReopenLive, `${HOST_CONSOLE}warn ${IN_PROGRESS}`)).toBe(1)
    expect(count(bridgeStdout.hostedReopenLive, `${HOST_CONSOLE}error ${ENDED}`)).toBe(1)
    expect(count(bridgeStdout.hostedReopenLive, HOST_CONSOLE)).toBe(2)
    expect(out.filter((line) => (line.startsWith('LIVE ') || line.startsWith('HELLO ')) && line.includes('CONTROLLER FIRMWARE UPDATE'))).toEqual([])
    expect(clientGot.hostedReopenLive.filter((line) => line.includes('CONTROLLER FIRMWARE UPDATE'))).toEqual([])
    expect(out).toContain('OPENS connect 4')
  })

  it.skipIf(raw === null)('a lost-board update that fails with nobody connected: no automatic retry, Connect reaches Open, and its outcome is said once', () => {
    const hosted = raw!.hostedQuietReopen
    expect(hosted).toEqual(expect.arrayContaining(['OPENS failed 3', 'OPENS auto 3', 'OPENS connect 4', 'REOPENED True']))
    expect(hosted.filter((line) => line.startsWith('HELLO '))).toEqual([])
    expect(count(bridgeStdout.hostedQuietReopen, `${HOST_CONSOLE}error ${ENDED}`)).toBe(1)
    // Without a host the Connect's hello says the outcome, once.
    const plain = raw!.plainQuietReopen
    expect(plain).toEqual(expect.arrayContaining(['OPENS failed 3', 'OPENS auto 3', 'OPENS connect 4', 'REOPENED True']))
    expect(plain.filter((line) => line.startsWith('HELLO '))).toEqual([expect.stringMatching(/^HELLO \[bridge\] CONTROLLER FIRMWARE UPDATE ENDED /)])
    expect(count(bridgeStdout.plainQuietReopen, HOST_CONSOLE)).toBe(0)
  })

  it.skipIf(raw === null)('connecting and reconnecting while a lost-board update runs: the progress line once, the outcome once, live', () => {
    const plain = raw!.plainMidUpdate
    const second = plain.indexOf('SESSION 2')
    expect(plain.slice(0, second)).toEqual(['SESSION 1', `HELLO ${inProgressLine()}`])
    expect(plain.slice(second + 1)).toEqual([expect.stringMatching(/^LIVE \[bridge\] CONTROLLER FIRMWARE UPDATE FINISHED /), 'REOPENED True'])
    // The clients READ it so: session 1 the progress line, session 2 the outcome.
    expect(clientGot.plainMidUpdate).toEqual([`GOT 1 ${inProgressLine()}`, expect.stringMatching(/^GOT 2 \[bridge\] CONTROLLER FIRMWARE UPDATE FINISHED /)])
    // Hosted: the host carries both lines (fix round 4), so no session says either.
    const hosted = raw!.hostedMidUpdate
    expect(hosted.filter((line) => line.startsWith('HELLO ') || line.startsWith('LIVE '))).toEqual([])
    expect(hosted).toContain('REOPENED True')
    expect(count(bridgeStdout.hostedMidUpdate, HOST_CONSOLE)).toBe(2)
    expect(count(bridgeStdout.hostedMidUpdate, `${HOST_CONSOLE}warn ${IN_PROGRESS}`)).toBe(1)
    expect(count(bridgeStdout.hostedMidUpdate, `${HOST_CONSOLE}warn ${FINISHED}`)).toBe(1)
  })

  // Fix round 4 (astra audit 4, Machine.cs:752 on 55f09a0d78): the session's
  // socket writer has stopped - WriteLoop sets outboxClosed on a write error -
  // but Serve has not yet ended the session, and the lost board's update ends
  // in that gap. The live send returned without queuing anything, and the
  // outcome was dropped from every carrier. Now an unacknowledged record stays
  // held: the next Connect's client reads it, once, and nobody after.
  it.skipIf(raw === null)('the socket writer closes before the session ends: the outcome is read once by the next Connect, never lost', () => {
    const plain = raw!.plainWriterClosed
    expect(plain).toContain('WRITER CLOSED')
    expect(plain).toContain('OPENS failed 3')
    const outcome = (lines: string[]) => lines.filter((line) => line.includes(ENDED))
    expect(outcome(clientGot.plainWriterClosed)).toEqual([expect.stringMatching(/^GOT 2 \[bridge\] CONTROLLER FIRMWARE UPDATE ENDED .*\(rc 4\)/)])
    // Its progress line was never read either; it is stale now and never said.
    expect(clientGot.plainWriterClosed.filter((line) => line.includes(IN_PROGRESS))).toEqual([])
    const third = plain.indexOf('SESSION 3')
    expect(plain.slice(third + 1)).toEqual([])
    // Hosted: the host carried it, whatever the socket was doing.
    expect(count(bridgeStdout.hostedWriterClosed, `${HOST_CONSOLE}error ${ENDED}`)).toBe(1)
    expect(outcome(raw!.hostedWriterClosed)).toEqual([])
    expect(outcome(clientGot.hostedWriterClosed)).toEqual([])
  })

  it.skipIf(raw === null)('a client that never reads what it was sent: the outcome waits for the next Connect and is read once', () => {
    const plain = raw!.plainNeverRead
    const outcome = clientGot.plainNeverRead.filter((line) => line.includes(ENDED))
    expect(outcome).toEqual([expect.stringMatching(/^GOT 2 \[bridge\] CONTROLLER FIRMWARE UPDATE ENDED .*\(rc 4\)/)])
    expect(count(plain, `LIVE ${ENDED}`)).toBe(1)
    expect(count(plain, `HELLO ${ENDED}`)).toBe(1)
    const third = plain.indexOf('SESSION 3')
    expect(plain.slice(third + 1)).toEqual([])
  })

  it.skipIf(raw === null)('every unhosted line a client read, it read once: progress and outcome across startup, reopen and reconnect', () => {
    for (const name of ['reopenUpdateThenErrorThenConnect', 'plainQuietReopen', 'startupUpdateThenConnected', 'plainMidUpdate', 'plainWriterClosed', 'plainNeverRead']) {
      const read = clientGot[name].map((line) => line.replace(/^GOT \d+ /, ''))
      const outcomes = read.filter((line) => line.startsWith(FINISHED) || line.startsWith(ENDED))
      expect(outcomes, name).toHaveLength(1)
      expect(count(read, IN_PROGRESS), name).toBeLessThanOrEqual(1)
    }
  })

  // The console journey (shoot-console.mjs) replays these runs from
  // bridge-stdout.json; it must be what the production blocks print today.
  it.skipIf(raw === null)('the console journey fixture is the current production stdout for every run it replays', () => {
    const fixture = JSON.parse(readFileSync('src/tests/evidence/WO-2847/bridge-stdout.json', 'utf8')).runs as Record<string, string[]>
    for (const name of ['hostedStartupFinished', 'hostedStartupEnded', 'hostedQuietReopen']) {
      expect(fixture[name], name).toEqual(bridgeStdout[name])
    }
  })

  it('no startup or reopen wait gives up on the board owner while an update runs; a failed update exits 11', () => {
    const extended = bridgeSource.match(/300000,\s*delegate \{ return ControllerFirmwareUpdateWait\.Active; \},/g) ?? []
    expect(extended).toHaveLength(2)
    expect(bridgeSource).toContain('delegate { opened = machine.Open(uccnc.Board, uccnc.ProfilePath); },')
    expect(bridgeSource).toContain('Environment.Exit(ControllerFirmwareUpdateWait.EndedWithErrorExitCode);')
    expect(machineSource).toContain('public const int EndedWithErrorExitCode = 11;')
    expect(machineSource).toContain('if (ControllerFirmwareUpdateWait.EndedWithError) return false;')
  })
})

// ---- Electron: no respawn into an update, no restart through one ---------

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn((_signal?: string) => {
    queueMicrotask(() => this.exit(0))
    return true
  })

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  exit(code: number | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }

  say(line: string): void {
    this.stdout.emit('data', `${line}\r\n`)
  }
}

interface MainApi {
  machineBridgeStatus: () => {
    running: boolean
    respawn: { attempts: number; gaveUp: boolean }
    firmwareUpdate?: { since: number; line: string } | null
    consoleLines?: Array<{ id: string; severity: string; text: string }>
    lastExit: unknown
  }
  restartMachineBridge: () => Promise<{ ok: boolean; reason?: string; firmwareUpdate?: boolean }>
  startMachineBridge: () => FakeChild | null
}

/** onSpawn: what each new child does; refuseSockets: nothing listens on any
 *  port (restartMachineBridge's own socket probe runs, against no socket). */
function loadMain(hooks: { onSpawn?: (child: FakeChild) => void; refuseSockets?: boolean } = {}): { api: MainApi; children: FakeChild[]; spawnEnvs: Array<Record<string, string | undefined>> } {
  const children: FakeChild[] = []
  const spawnEnvs: Array<Record<string, string | undefined>> = []
  const electron = {
    app: {
      isPackaged: false,
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({ then: () => Promise.resolve() }),
    },
    BrowserWindow: class { static getAllWindows = () => [] },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const processValue = {
    ...nodeProcess,
    argv: [],
    env: {
      ...nodeProcess.env,
      LIENCAM_BRIDGE_EXECUTABLE: 'C:\\fake\\liencam-bridge.exe',
      LIENCAM_BRIDGE_ARGS_JSON: JSON.stringify(['--port', '8399']),
    },
    platform: 'win32',
    resourcesPath: nodePath.resolve('.tmp-wo2847-resources'),
  }
  const moduleValue = { exports: {} as MainApi }
  const realRequire = electronMainRequire
  vm.runInNewContext(readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal, Buffer, Date, Promise, Response, URL,
    __dirname: nodePath.resolve('electron'),
    clearTimeout, console, exports: moduleValue.exports, fetch,
    module: moduleValue, process: processValue, queueMicrotask, setTimeout,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') {
        return {
          spawn: vi.fn((_executable: string, _args: string[], options?: { env?: Record<string, string | undefined> }) => {
            spawnEnvs.push(options?.env ?? {})
            const child = new FakeChild(4800 + children.length)
            children.push(child)
            hooks.onSpawn?.(child)
            return child
          }),
        }
      }
      if (id === 'node:net' && hooks.refuseSockets) {
        return {
          createConnection: () => {
            const socket = Object.assign(new EventEmitter(), { destroy: () => {}, setTimeout: () => {} })
            setImmediate(() => socket.emit('error', new Error('connection refused')))
            return socket
          },
        }
      }
      return realRequire(id)
    },
  })
  return { api: moduleValue.exports, children, spawnEnvs }
}

describe('WO-2847 Electron leaves a firmware update alone', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not restart, kill or respawn the bridge while it reports an update in progress', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = loadMain()
    runtime.api.startMachineBridge()
    const child = runtime.children[0]
    child.say('[bridge] ListDevices rc=0 -> 1 device(s)')
    child.say(`${IN_PROGRESS} - do not close LienCAM and do not power off the controller.`)

    // A Restart press (or the renderer's settings reconcile) mid-update.
    const pending = runtime.api.restartMachineBridge()
    await vi.advanceTimersByTimeAsync(0)
    expect(child.kill).not.toHaveBeenCalled()
    expect(runtime.children).toHaveLength(1)
    expect(await pending).toMatchObject({ ok: false, reason: 'no-socket', firmwareUpdate: true })
    expect(runtime.api.machineBridgeStatus().firmwareUpdate?.line).toContain(IN_PROGRESS)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runtime.children).toHaveLength(1)
    expect(runtime.api.machineBridgeStatus().running).toBe(true)

    child.say(`${FINISHED} - the controller is open and the connection continues.`)
    expect(runtime.api.machineBridgeStatus().firmwareUpdate).toBeNull()
  })

  it('does not respawn a bridge whose update ended in an error, and still respawns a crash', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = loadMain()
    runtime.api.startMachineBridge()
    runtime.children[0].say(`${IN_PROGRESS} - do not close LienCAM and do not power off the controller.`)
    runtime.children[0].say(`${ENDED} without opening the controller - the link to the controller failed (rc 4).`)
    runtime.children[0].exit(11)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.children).toHaveLength(1)
    expect(runtime.api.machineBridgeStatus()).toMatchObject({
      running: false, respawn: { attempts: 0, gaveUp: true }, firmwareUpdate: null,
    })

    const control = loadMain()
    control.api.startMachineBridge()
    control.children[0].exit(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(control.children).toHaveLength(2)
  })
})

// ---- Fix round 2: the Control console hears every update line once -------
//
// The bridge's own stdout from the fake-board runs above goes through the real
// electron/main.cjs; its status goes through the Control page's own delivery
// (ControlPage.tsx sayBridgeConsoleLines - the status poll and Connect both
// use it); the assertion is on the console store the Control console shows.

describe('WO-2847 every firmware-update line reaches the Control console once', () => {
  const haveBoard = existsSync(CSC)
  let say: (status: unknown) => void
  let store: typeof import('../../store/machineControlStore')['useMachineControl']
  let host: typeof import('../../lib/machine/bridgeHost')
  const globalWindow = globalThis as { window?: unknown }

  const consoleTexts = () => store.getState().consoleLines.map((line) => line.text)
  const poll = (api: MainApi) => say(api.machineBridgeStatus())

  async function loadRenderer(): Promise<void> {
    if (say === undefined) {
      const page = await import('../../components/machine/ControlPage')
      // A Control page without it delivers nothing from host status - the
      // defect this describe proves (the negative control runs that page).
      const delivery = (page as { sayBridgeConsoleLines?: (status: unknown) => void }).sayBridgeConsoleLines
      say = delivery ?? (() => {})
      store = (await import('../../store/machineControlStore')).useMachineControl
      host = await import('../../lib/machine/bridgeHost')
    }
    store.setState({ consoleLines: [] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  }

  /** The bridge prints `lines` up to and including the first starting with
   *  `until` (all of them without it); returns how many it printed. */
  function feed(child: FakeChild, lines: string[], until?: string): number {
    const stop = until === undefined ? lines.length : lines.findIndex((line) => line.startsWith(until)) + 1
    for (const line of lines.slice(0, stop)) child.say(line)
    return stop
  }

  /** The desktop preload, answered by the loaded main.cjs. realRestart: its
   *  own restartMachineBridge; otherwise a start reported ready at once. */
  function hostWindow(api: MainApi, children: FakeChild[], realRestart = false): void {
    globalWindow.window = {
      liencamHost: {
        machineBridgeStatus: async () => api.machineBridgeStatus(),
        machineBridgeRestart: realRestart
          ? async () => api.restartMachineBridge()
          : async () => (api.startMachineBridge() === null
            ? { ok: false, reason: 'not-configured' }
            : { ok: true, pid: children[children.length - 1].pid, port: 8399 }),
      },
    }
  }

  /** The Control page's own Connect handler (ControlPage.tsx onConnect),
   *  run against the real bridgeHost, delivery and console store. */
  async function controlPageConnect(): Promise<string[]> {
    const ts = await import('typescript')
    const page = readFileSync('src/components/machine/ControlPage.tsx', 'utf8').replace(/\r\n/g, '\n')
    const begin = page.indexOf('  const onConnect = async () => {')
    const end = page.indexOf('  const onDisconnect = async () => {', begin)
    if (begin < 0 || end < 0) throw new Error('ControlPage onConnect is missing')
    const panel: string[] = []
    const context = vm.createContext({
      ...host,
      sayBridgeConsoleLines: say,
      window: globalWindow.window,
      useMachineControl: store,
      useUiPrefs: { getState: () => ({ machineLinks: { wo2847: {} } }) },
      machine: { id: 'wo2847' },
      kind: 'bridge',
      baud: 115200,
      setConnectError: (text: string | null) => { if (text !== null) panel.push(text) },
      setBusy: () => {},
      connectMachine: async () => { throw new Error('no socket in this test') },
      controlText: (key: string) => key,
    })
    const code = ts.transpileModule(`${page.slice(begin, end)}\nglobalThis.onConnect = onConnect`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    vm.runInContext(code, context)
    await (context.onConnect as () => Promise<void>)()
    return panel
  }

  afterEach(() => {
    delete globalWindow.window
    vi.restoreAllMocks()
  })

  it.skipIf(!haveBoard)('startup update that finishes: in progress once while it runs, finished once, never stale; Restart and Connect leave it alone', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children, spawnEnvs } = loadMain()
    api.startMachineBridge()
    expect(spawnEnvs[0].LIENCAM_BRIDGE_HOST_CONSOLE).toBe('1')
    const out = bridgeStdout.hostedStartupFinished
    const taken = feed(children[0], out, IN_PROGRESS)
    poll(api)
    poll(api)
    expect(consoleTexts()).toEqual([inProgressLine()])

    // Restart mid-update is refused without a kill; Connect says why it waits.
    expect(await api.restartMachineBridge()).toMatchObject({ ok: false, firmwareUpdate: true })
    expect(children[0].kill).not.toHaveBeenCalled()
    hostWindow(api, children)
    const prepared = await host.prepareHostedBridgeForConnect(undefined, say)
    expect(prepared).toMatchObject({ kind: 'not-started', socketMayAnswer: true })
    expect(prepared.kind === 'not-started' && prepared.sentence).toContain('updating its firmware')
    expect(children).toHaveLength(1)

    feed(children[0], out.slice(taken))
    poll(api)
    poll(api)
    const texts = consoleTexts()
    expect(count(texts, IN_PROGRESS)).toBe(1)
    expect(count(texts, FINISHED)).toBe(1)
    expect(texts).toHaveLength(2)
    expect(api.machineBridgeStatus().consoleLines?.some((line) => line.text.startsWith(IN_PROGRESS))).toBe(false)
    // The bridge's hellos said nothing, so the socket adds no second copy.
    expect(raw_('hostedStartupFinished').filter((line) => line.startsWith('HELLO '))).toEqual([])
  })

  it.skipIf(!haveBoard)('startup update that fails: the explained outcome reaches the console once after the bridge exits, no respawn, and a later Connect does not repeat it', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children } = loadMain()
    api.startMachineBridge()
    feed(children[0], bridgeStdout.hostedStartupEnded)
    children[0].exit(11)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(children).toHaveLength(1)
    expect(api.machineBridgeStatus()).toMatchObject({ running: false, respawn: { gaveUp: true } })
    poll(api)
    poll(api)
    let texts = consoleTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/^\[bridge\] CONTROLLER FIRMWARE UPDATE ENDED /)
    expect(texts[0]).toContain(' - the link to the controller failed (rc 4)')
    // The progress line of an update that is over is never said late.
    expect(count(texts, IN_PROGRESS)).toBe(0)

    // The operator's Connect starts the bridge again and clears lastExit.
    hostWindow(api, children)
    expect(await host.prepareHostedBridgeForConnect(undefined, say)).toMatchObject({ kind: 'started', again: true })
    expect(children).toHaveLength(2)
    expect(api.machineBridgeStatus().lastExit).toBeNull()
    poll(api)
    texts = consoleTexts()
    expect(count(texts, ENDED)).toBe(1)
  })

  it.skipIf(!haveBoard)('a Connect pressed before the page has polled says the missed outcome first', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children } = loadMain()
    api.startMachineBridge()
    feed(children[0], bridgeStdout.hostedStartupEnded)
    children[0].exit(11)
    hostWindow(api, children)
    expect(await host.prepareHostedBridgeForConnect(undefined, say)).toMatchObject({ kind: 'started' })
    const texts = consoleTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/^\[bridge\] CONTROLLER FIRMWARE UPDATE ENDED /)
    poll(api)
    expect(count(consoleTexts(), ENDED)).toBe(1)
  })

  it.skipIf(!haveBoard)('lost-board update that fails with nobody connected: the console hears the outcome once, through the host', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children } = loadMain()
    api.startMachineBridge()
    feed(children[0], bridgeStdout.hostedQuietReopen)
    poll(api)
    poll(api)
    const texts = consoleTexts()
    expect(count(texts, ENDED)).toBe(1)
    expect(count(texts, IN_PROGRESS)).toBe(0)
    expect(texts).toHaveLength(1)
    expect(api.machineBridgeStatus().running).toBe(true)
  })

  // Fix round 4 (astra audit 4): the hosted bridge whose session's socket
  // writer had closed - the console hears the outcome once, through the host.
  it.skipIf(!haveBoard)('lost-board update that fails while the session socket writer is closed: the console hears the outcome once', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children } = loadMain()
    api.startMachineBridge()
    feed(children[0], bridgeStdout.hostedWriterClosed)
    poll(api)
    poll(api)
    const texts = consoleTexts()
    expect(count(texts, ENDED)).toBe(1)
    expect(texts.find((text) => text.startsWith(ENDED))).toContain('(rc 4)')
    expect(count(texts, IN_PROGRESS)).toBe(0)
    expect(texts).toHaveLength(1)
  })

  it.skipIf(!haveBoard)('lost-board update with a session live, and a reconnect mid-update: each line once across the host and the socket', { timeout: 60_000 }, async () => {
    await loadRenderer()
    // Live session: the host carries both lines (fix round 4) and the socket
    // neither, so the status poll says each once.
    const live = loadMain()
    live.api.startMachineBridge()
    const liveOut = bridgeStdout.hostedReopenLive
    const liveTaken = feed(live.children[0], liveOut, IN_PROGRESS)
    poll(live.api)
    feed(live.children[0], liveOut.slice(liveTaken))
    poll(live.api)
    poll(live.api)
    const liveSocket = raw_('hostedReopenLive').filter((line) => (line.startsWith('LIVE ') || line.startsWith('HELLO ')) && line.includes('CONTROLLER FIRMWARE UPDATE'))
    expect(liveSocket).toEqual([])
    expect(count(consoleTexts(), IN_PROGRESS)).toBe(1)
    expect(count(consoleTexts(), ENDED)).toBe(1)
    expect(consoleTexts()).toHaveLength(2)
    store.setState({ consoleLines: [] })

    // Reconnect mid-update: the host says the progress, the socket the outcome.
    const mid = loadMain()
    mid.api.startMachineBridge()
    const out = bridgeStdout.hostedMidUpdate
    const taken = feed(mid.children[0], out, IN_PROGRESS)
    poll(mid.api)
    feed(mid.children[0], out.slice(taken))
    poll(mid.api)
    const socket = raw_('hostedMidUpdate')
      .filter((line) => line.startsWith('LIVE ') || line.startsWith('HELLO '))
      .map((line) => line.replace(/^(LIVE|HELLO) /, ''))
    const heard = [...consoleTexts(), ...socket]
    expect(count(heard, IN_PROGRESS)).toBe(1)
    expect(count(heard, FINISHED)).toBe(1)
    expect(heard).toHaveLength(2)
  })

  // Fix round 3 (astra audit 3): Connect starts the stopped bridge, the new
  // child's Open meets an update that fails and it exits 11. Connect's own
  // failure line used to quote lastExit.error - the outcome - and the status
  // poll said the host's copy too: two ENDED lines for one event. The host's
  // line is now the only carrier; Connect says only what it adds.
  it.skipIf(!haveBoard)('Connect starts the bridge and its update fails: the console says the outcome ONCE, then Connect points at it', { timeout: 60_000 }, async () => {
    await loadRenderer()
    const { api, children } = loadMain({
      refuseSockets: true,
      onSpawn: (child) => setImmediate(() => {
        feed(child, bridgeStdout.hostedStartupEnded)
        child.exit(11)
      }),
    })
    hostWindow(api, children, true)
    expect(api.machineBridgeStatus().running).toBe(false)
    const panel = await controlPageConnect()
    expect(children).toHaveLength(1)
    // The status poll after the press, twice.
    poll(api)
    poll(api)
    const texts = consoleTexts()
    const outcome = texts.filter((text) => text.includes(ENDED))
    expect(outcome).toHaveLength(1)
    expect(outcome[0]).toMatch(/^\[bridge\] CONTROLLER FIRMWARE UPDATE ENDED .* - the link to the controller failed \(rc 4\)/)
    const pointer = 'Not connected: Connect did not open the controller - see the firmware update line above.'
    expect(texts.filter((text) => text === pointer)).toHaveLength(1)
    expect(texts.indexOf(outcome[0])).toBeLessThan(texts.indexOf(pointer))
    expect(texts.some((text) => text.includes('exiting: the controller firmware update ended'))).toBe(false)
    expect(panel).toEqual([pointer])
    // No respawn into another Open.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(children).toHaveLength(1)
  })

  it.skipIf(!haveBoard)('a Connect or Restart while a started bridge is still updating says the update, not a silent port', { timeout: 60_000 }, async () => {
    await loadRenderer()
    expect(host.bridgeNotStartedSentence({ ok: false, reason: 'no-socket', pid: 1, port: 8399, firmwareUpdate: true }))
      .toContain('updating its firmware')
    expect(host.bridgeNotStartedSentence({ ok: false, reason: 'no-socket', pid: 1, port: 8399 }))
      .toBe('Not connected: the machine connection started but is not answering on port 8399.')
    // Every other start failure keeps today's wrapped sentence.
    expect(host.bridgeNotStartedSentence({ ok: false, reason: 'exited', lastExit: { code: 1, signal: null, error: '[bridge] boom.' } }))
      .toBe('Not connected: the machine connection stopped at start ([bridge] boom).')
    // main.cjs names the event only for exit 11 after an outcome event.
    const { api, children } = loadMain()
    api.startMachineBridge()
    children[0].say('[bridge] something else')
    children[0].exit(1)
    expect((api.machineBridgeStatus().lastExit as { consoleLineId?: string }).consoleLineId).toBeUndefined()
  })

  it('the Control page delivers host lines from its status poll and before a Connect press says anything', () => {
    const page = readFileSync('src/components/machine/ControlPage.tsx', 'utf8').replace(/\r\n/g, '\n')
    expect(page).toMatch(/const publish = \(status: BridgeProcessStatus \| null\) => \{\n\s+if \(!current\) return\n\s+sayBridgeConsoleLines\(status\)/)
    expect(page).toMatch(/prepareHostedBridgeForConnect\(\n\s+useUiPrefs\.getState\(\)\.machineLinks\[machine\.id\],\n\s+sayBridgeConsoleLines,\n\s+\)/)
  })
})
