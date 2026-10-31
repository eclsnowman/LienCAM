# LienCAM machine bridge (AXBB-E / UC100)

**This is the developer reference for building and diagnosing the bridge from
source.** Customers who received an unpacked bridge folder should use
[`docs/machine/BRIDGE-START.md`](../../docs/machine/BRIDGE-START.md); they do not
need this build procedure or a terminal.

A small Windows program that lets LienCAM drive a CNCdrive motion controller
directly. **UCCNC is not involved and must not be running** - one process owns
the controller.

It speaks **LienCAM's own protocol over a loopback WebSocket** - JSON frames, a
mechanical mapping of `MachineController` (`src/lib/machine/controller.ts`),
specified in `docs/machine/BRIDGE-PROTOCOL.md` - and calls `UC100.dll` on the
machine side. There is no GRBL anywhere: ADR-0041 retired the emulation that
used to live here, because emulating a poorer protocol in the middle threw away
the AXBB's per-move ids, its buffer-in-seconds and the geometry path.

Design, measurements and open questions: `docs/research/uccnc-control-plan.md`.
Bench harnesses that established the unit conventions: `docs/research/uccnc-api-probe/`.

## The motion gate

`readOnly` is one flag, set at construction in `Machine.cs`, with no path from
the wire to clear it. It currently ships **false**: this build can move the
machine. The gate was cleared on 2026-08-21, after X and Z moved on real
hardware under the pin translation - WO-423's condition was confirmation
against hardware, not against decompiled source.

Trust the startup banner and `hello.readOnly`, never prose: both are generated
from the flag. The banner says either `MOTION ENABLED - this build can move the
machine` or `READ ONLY build - every motion command will be refused`.

Two independent gates still stand between a frame and motion - the `MotionCalls`
set in `Bridge.cs`, and `Machine.Refuse()` next to the hardware - but they now
both ask that one flag rather than each carrying its own copy of the rule. Set
it true and this is a dry-run build again.

Outputs are still inhibited (`SetOffline(true)`) at startup, so a fresh process
drives nothing until it is told to. `setOutputInhibit {on: false}` energises the
terminals for real and is gated like any other motion call. Inhibiting is never
refused: nothing may block a stop.

Gated on the flag: `jog`, `jogToWorkXY`, `jogToMachineZ`, `home`, `homeAxes`,
`cycleResume`, `unlock`, `resetToIdle`, `probe`, `startJob`, `resumeJob`,
`stepJob`, and `setOutputInhibit(false)`.

Never gated, because they only ever stop things or are bridge-side bookkeeping:
every read, `feedHold`, `reset`, `emergencyStop`, `jogCancel`, `pauseJob`,
`stopJob`, `setOverride`, `selectWcs`, `zeroWorkAxis`, `setWorkOffset`,
`setWorkRotation`, `loadMoves`.

WO-2186: `setWorkRotation {wcs, degrees}` rotates a work system about its origin
(CCW positive from +Z, 0 clears), as LinuxCNC's `G10 L2 Pn R` does. The bridge
applies it wherever it applies the offset - program moves (including an axis a
block did not name), arc centres, `jogToWorkXY`, `workPos`, `zeroWorkAxis` on X/Y -
and not to G53 lines, jogs or the machine-axis `probe`. `hello.workOffsets.rotation`
and status `workRotation` report it. Design: docs/design/WCS-ROTATION.md.

## Build

No Visual Studio, no NuGet. The compiler ships with Windows. From the repo
root:

```powershell
Set-Location .\pendant\uccnc-bridge
New-Item -ItemType Directory -Force .\bin | Out-Null
$configText = @'
{
  "installRoot": "C:\\UCCNC12115",
  "profile": "LienCNC.pro",
  "board": -19
}
'@
[IO.File]::WriteAllText((Join-Path $PWD 'bin\liencam-bridge.config.json'), $configText)
$config = $configText | ConvertFrom-Json
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /unsafe /platform:x64 `
    /target:winexe /out:.\bin\liencam-bridge.exe Bridge.cs Machine.cs Json.cs Vfd.cs `
    (Join-Path $config.installRoot 'API\Interface\UC100_wrapper.cs')
& ..\..\tools\bridge-shortcut\New-BridgeShortcut.ps1 -BridgeDirectory .\bin
```

The final command creates the double-clickable `Start LienCAM Bridge.exe`
window host beside the bridge. Ship it with the bridge exe, config, and required
DLLs. It finds the bridge beside itself after the folder is unpacked anywhere.

## Desktop app managed build and distribution boundary

The packaged desktop app currently ships these bridge sources, not a prebuilt
bridge executable or controller DLL. `electron-builder.yml` explicitly excludes
`uccnc-bridge/**/*.exe`, `uccnc-bridge/**/*.dll`, and `uccnc-bridge/bin/**/*`.
On Windows, the default no-environment-variable route compiles the four sources
above with the installed UCCNC `UC100_wrapper.cs` and the Windows C# compiler.

The managed output has one stable path:

```text
%APPDATA%\liencam\machine-bridge\liencam-bridge.exe
```

`machine-bridge-build.json` beside it records the schema, aggregate build
fingerprint, source hashes, wrapper path/hash, compiler path/hash and arguments,
install root, and final executable hash. The app reuses the file only when all
of those identities agree. A source, wrapper, compiler, or install-root change
stages a replacement beside the current executable, stops an app-owned running
bridge only after the staged build succeeds, and swaps the executable and
sidecar with rollback copies. A failed replacement does not launch the old
binary under the new identity.

If an unchanged recorded executable is missing or its bytes no longer match,
startup reports that observed fact and the build-log path. It does not claim an
antivirus cause and does not automatically compile the same identity again.
The operator can choose Build again or Reconnect for one deliberate recovery
attempt. `LIENCAM_BRIDGE_EXECUTABLE` remains an explicit override and is never
replaced by the managed builder.

This is attributable local compilation, not a completed release-distribution
answer. The remaining shipping decision is between:

1. Keep local compilation and validate its exact recorded identities on every
   supported standard-user Windows installation.
2. Produce one controlled release artifact from pinned inputs, publish its hash
   and provenance, and change packaging to include that reviewed artifact and
   its required runtime files instead of compiling on first run.
3. Add Authenticode signing to the controlled artifact after an authorized
   organization signing certificate, protected key custody, timestamp service,
   and post-signature verification policy exist.

No signing identity is authorized in this repository, so the app does not
invent or self-sign one. Reproducible bytes and a valid signature improve
traceability and reputation but do not guarantee that endpoint protection will
accept a binary. Closing that shipping question requires a clean standard-user
install on protected Windows with the installed file hash, sidecar, signature
result (if signing is chosen), protection-history outcome, and launch log
recorded together.

## Desk build and demo-board run (no UCCNC install, no hardware)

**Verified on the dev box 2026-09-10.** The build above assumes a UCCNC install
for the wrapper and the DLLs. Neither is needed - but read this first:

**`UC100_wrapper.cs` is GITIGNORED (`.gitignore:69`) - it is CNCdrive's
proprietary header and is NOT in the repo.** A runner worktree does not have
it. On the dev box it sits in the main checkout at
`pendant/uccnc-bridge/UC100_wrapper.cs`; copy it into your
worktree's `pendant\uccnc-bridge\` before the `csc` line below (the
`.gitignore` keeps it out of your commit). On the mini PC it is at
`C:\UCCNC12115\API\Interface\UC100_wrapper.cs`. WO-1004's lane could not
compile for exactly this reason on 2026-09-10 and said so honestly; the
architect compiled its branch with the on-disk copy before landing.

`bin/` carries `UC100.dll` and `FTD2XX.dll` (also ignored, also on disk), and
`docs/machine/profiles/LienCNCV2.pro` is the operator's real profile. The bridge REFUSES
to start unless it can resolve, in this order, the profile, `API\DLL\UC100.dll`
under the install root, and `ftd2xx64.dll` AT the install root - so build a
fake root that satisfies all three:

**Run the script. Do not hand-roll the build, and do not choose your own
output directory** - `desk-build.ps1` exists because choosing your own is a bug:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\pendant\uccnc-bridge\desk-build.ps1
```

It prints the exe path, its size and its timestamp, and the `Start-Process`
line to run it. Everything below about the fake root, the wrapper copy and the
DLL placement is what the script already does for you.

**WHY THE PATH IS FIXED - THIS IS NOT A STYLE PREFERENCE.** Windows Firewall
identifies a program by its FULL PATH, so a bridge built into a per-work-order
temp directory is a program Windows has never seen, and the operator gets an "allow
this app through the firewall" dialog **on his own workstation, for our test
build**. By 2026-09-10 the lanes had created 892 `liencam-*` temp directories,
27 distinct bridge binaries, and **66 firewall rules on his machine (14 Allow,
52 Block)** - every one of them a dialog he had to stop and click.

The bridge listens on **loopback only** and refuses anything else at startup
(`Bridge.cs`: `IPAddress.IsLoopback(bindAddr)` or `Exit(2)`), so it never
needed a firewall grant in the first place. The dialogs were noise we made.

**If you need an A/B control, use the bridge's own `--inject-*` flags** - they
run the SAME binary both ways, which is what makes the comparison a measurement
instead of a reading of two different builds. Do not build a second exe.

A good start prints `board -19 (demo, nothing can move)`, the four axis
readbacks, `gantry OK`, and `listening on ws://127.0.0.1:8399/`. Pick a port
nobody else uses (8325 is the real machine's, 8326 the mini PC's demo).

What the demo board CAN prove: everything the bridge decides from state -
refusals, latches, messages, what gets sent to the board and what is read back,
homing-cycle sequencing, the soft-limit latch, `.pro` handling. What it CANNOT
prove: anything that needs a real input to change - a pressed switch, a drive
fault, a lost USB, an inverter on a wire. For those, use the injectors (`WO-1095`,
demo boards only) or fake the input, and say in the result that the hardware
half is OWED.

**`/target:winexe`, NOT `/target:exe`.** A console build opens a black window at
every start — Operator ruling 2026-08-29: *"What is with all the liencam-bridge.exe popups
will those always be nagging me and future users?"* The PE subsystem byte is what
Windows reads to decide (3 = console, 2 = GUI). Check it with a PE reader rather
than by looking: the console window belongs to `conhost.exe`, so the bridge
process reports `MainWindowHandle` 0 either way and that test proves nothing.

Because there is then no console, the bridge **tees everything to
`bin/liencam-bridge.log`** (one previous run kept as `.log.1`, rolled at 4 MB).
That log is this project's primary evidence surface — every readback, every
refusal, every drift line — so the two changes belong together: going windowless
without it would throw the diagnostics away. `Console.SetOut` installs the tee,
so all ~44 existing `Console.WriteLine` sites keep working untouched.

The install root is written once, in `liencam-bridge.config.json` beside the
exe. `profile` may be a full path or a file name under the derived `Profiles`
directory. At startup the bridge derives `API\DLL\UC100.dll` and
`ftd2xx64.dll` from the root, refreshes their runtime copies beside the exe,
and discovers every `Profiles\*.pro` file. `UC100.dll` also needs the VC++ 2008
runtime, or it fails to load with a bare "module not found".

That csc is a C# 5 compiler - no string interpolation, no `out var`, no
expression-bodied members. `Json.cs` is a hand-rolled JSON codec for the same
reason: no build dependency, nothing to install.

## Run

```powershell
.\bin\liencam-bridge.exe --port 8325
```

- `--board -19` is the **demo AXBB**: a full simulated controller, no hardware,
  nothing that can move. The example config persists this safe default.
- `--board <n>` with a real board id opens actual hardware.
- `--profile` names an import seed, not a startup authority. On the first start
  of a legacy installation whose bridge cache has neither typed definition
  settings nor a captured profile baseline, the bridge reads it once and
  captures that baseline. Later starts configure from LienCAM's cached machine
  definition and do not open the `.pro`; changing the UCCNC file has no effect
  until the operator explicitly re-imports it in LienCAM.
- `--install-root`, `--profile`, and `--board` override the persisted values for
  that process. This preserves the first-machine-session procedure without
  rewriting the config.
- `--board auto` asks the DLL what is actually connected and uses that id. It
  refuses to start if nothing answers, and refuses rather than guessing if more
  than one controller is connected. It runs after the configured DLLs are copied
  beside the exe, and the id it finds replaces the configured one in the banner,
  in `Machine.Open` and in `hello.uccnc.board`.
- `--home-backoff <mm>` overrides the profile's `Homebackoff`. The default, 0,
  lets the profile win - which is what UCCNC itself does.
- The spindle flags are RETIRED (WO-1719). `--vfd`, `--vfd-port` and
  `--vfd-max-rpm` still consume their value and log that it was ignored, so an
  older launcher starts the bridge; nothing is read from the named file.
  `--vfd-port` is folded into the pushed definition (`link.port`), and
  `setVfdPort` still moves a held link. `--vfd-max-rpm` is removed with its
  setpoint ceiling; the RPM-to-word scale is the definition's, edited in
  LienCAM. `--vfd-commission` was removed earlier. See "The spindle link comes
  from the machine definition" below.
- `--bind` exists only so the refusal is testable. Anything but a loopback
  address exits with code 2. A machine control link must never be dialled
  across a network.

### Test hooks - THEY REFUSE TO START ON A REAL BOARD

Three flags exist only so WO-1095's acceptance can be reproduced rather than
described. They are listed here so nobody finds them by grep and wonders.

- `--inject-status-fault <n>` - throw from `PushStatus`'s READ half on poll
  pass `n`, which is where a wedged or reconfigured board would throw.
- `--inject-status-fault-passes <k>` - keep throwing for `k` consecutive
  passes (default 1). The burst is what makes "the failure is reported once"
  measurable; with a single fault that claim is true whatever the code does.
- `--inject-estop-from <n>` - force `inputs.estop` true from pass `n` onward.
  **An injected bit, never a pin** - the demo board has no input pins to press.
- `--inject-fake-inverter` (WO-1719) - every pushed spindle link opens onto an
  in-process inverter that answers standby, so `smoke.mjs --fake-inverter` can
  prove push -> open -> push none -> closed with no RS485 port. No serial port
  is touched.

**Each one exits with code 2 and a named reason if `board > 0`**, in the same
shape as the non-loopback bind refusal - not a warning. A flag that fakes an
e-stop must never be armable against a real machine, and neither must one that
makes the alarm-delivery thread throw. When armed they print `TEST HOOK ARMED`
at startup; on a machine that can move, that banner cannot appear.

The harness that drives them is
`src/tests/evidence/WO-1095/status-push-fault.mjs`. Run it out of a scratch
directory, never out of `bin/` - the definition cache lives beside the exe.

The first `hello` frame contains `uccnc.configPath`, the resolved install root,
profile, both source DLL paths, board id, and the discovered profile list. The
bridge also emits the resolved paths to LienCAM's machine console so the current
app shows what it is actually using.

`hello.definitionSource` is `cache-baseline` when startup configured the board
without reading the profile. The startup log says `the .pro was not consulted`
and follows each controller-backed cache write with its board readback. A cache
with no complete definition configures nothing and leaves motion refused; a
baseline alone is an upgrade source, not a substitute machine definition.

There is deliberately no browser command that rewrites this config. Changing
the origin of native controller code only takes effect at process startup and
has a different trust boundary from choosing an offset or issuing a stop. Edit
the machine-local file and restart the bridge; a future UI may offer a guarded
workflow around that same restart boundary.

## Check it

```powershell
node pendant\uccnc-bridge\smoke.mjs 8325
```

Connects the way the browser does and checks the protocol: `hello` first with
its version and capabilities, `call`/`reply` round trips including the void and
failure paths, unsolicited `status` pushes inside the stated cadence, the
`MachineStatus` nulls where this controller genuinely has no data, that every
motion call is refused while `readOnly`, and that no GRBL text appears on the
wire. Captured run: `docs/research/uccnc-api-probe/bridge-smoke-wo419.txt`.

## Board pin tables and the spindle link are data (WO-1646)

- **Pins.** A definition names (port, pin); the board wants its own UC pin
  number, and every UC board has a different table. `BoardPinTables` in
  `Machine.cs` holds the AXBB-E's (DeviceInfo type 19, verified on hardware).
  Any other board's table goes in a `boards\<name>.json` file beside the
  bridge exe:
  `{ "format": "liencam-board-pins", "schemaVersion": 1, "name": "UC400ETH",
  "deviceType": 8, "pins": [ { "port": 1, "pin": 2, "ucPin": 1, "direction": "output" } ] }`.
  `deviceType` is the wrapper's `DeviceType` number. A demo board uses the table
  of the board it emulates (`--board -19` -> type 19). A board with no table is
  refused by name.

  Shipped board data:

  - `boards\uc100.json` is DeviceInfo type 1. CNCdrive's *UC100 USB CNC motion
    controller* manual, PDF pages 7-8, documents the one LPT-compatible port's
    12 output and 5 input roles plus its 100 kHz, 6-axis and electrical limits:
    <https://www.cncdrive.com/MC/UC100%20datasheet/UC100%20users%20guide.pdf>.
    CNCdrive's official API wrapper version 2.096 documents `UC100 = 1` and the
    API's direct physical pin-number ranges in `UC100_wrapper.cs`:
    <https://www.cncdrive.com/MC/UC_API/UC100API.zip>. Together those sources
    make every `ucPin` value explicit; the table does not infer a translation.
  - UC300ETH-5LPT (type 11) remains pending. Its manual, PDF pages 19-21,
    documents port numbering, physical directions, 49 inputs and 36 outputs,
    but not the API's global `ucPin` numbering across five ports:
    <https://www.cncdrive.com/MC/UC300ETH%20datasheet/UC300ETH_manual.pdf>.
  - UC300ETH breakout variants (types 9, 10 and 12-18) remain pending. The
    UC300ETH-5LPT manual does not document their breakout-dependent terminal
    wiring; no 5LPT table is borrowed for them.
  - UC400ETH (type 8) remains pending. Its manual, PDF pages 19-20, documents
    two LPT-compatible ports with 24 outputs and 10 inputs, but not the API's
    global `ucPin` numbering across the two ports:
    <https://www.cncdrive.com/MC/UC400ETH%20datasheet/UC400ETH_manual.pdf>.

  A pending board still follows the existing refusal path. Do not construct a
  table by concatenating per-port pin numbers: the bridge passes `ucPin` to the
  controller API, so an undocumented offset could silently drive the wrong
  terminal.
- **Spindle link.** Port, baud, framing, slave, poll, retry, timeout, function
  codes and registers all come from the VFD definition. A link value the
  definition leaves out is named in the refusal, never filled in with the operator's.
  Writes use function 0x06 or 0x10, reads 0x03 or 0x04, as the definition says.

## The spindle link comes from the machine definition (WO-1719)

The bridge holds no inverter definition of its own and reads none from disk.
A freshly started bridge has no spindle link: no serial port is open,
`hello.vfd.present` is false and no `vfd` push fires.

- `applyVfdDefinition { definition: <liencam-vfd-definition> }` opens the link
  from exactly that document. If a link is already held it is closed first and
  reopened from the new document (refused while the inverter reports running;
  the old link is put back if the new one cannot read the inverter). The same
  document pushed again - LienCAM pushes it on every connect - keeps the link
  as it is.
- `applyVfdDefinition { definition: null }` (or `"none"`) closes the link: the
  machine definition declares no VFD. Close stops the spindle before the port
  closes. Refused only while the inverter reports running. The receipt is
  `{ ok: true, definition: null }`.
- No restart is needed either way; `vfd` pushes start and stop on the live
  connection, and `hello.vfd` on the next connection reports what is held.
- Desk proof: start a demo board with `--inject-fake-inverter` (refused on a
  real board) and run `node smoke.mjs <port> --fake-inverter`. Without the
  flag the smoke proves a push onto a missing port is refused and opens nothing.
  The fake proves the bridge's handling of the push only; the conversation with
  the real inverter is proved at the machine.

## Conventions this code depends on

All measured on the bench 2026-08-21; the harnesses are committed.

| | |
| --- | --- |
| `AddLinearMove` Feed, `AxisSetting.MaxVel` | units/**second**. The profile's `Velocity=` is units/**minute** - divide by 60, or you command 60x the intended speed |
| `AddDwell` Time | **milliseconds**, while `QueuedMove.dwell` is seconds |
| step-rate ceiling | ~95,000 steps/sec, so max velocity = 95000 / steps-per-unit |
| `Stat.Feed` | garbage for the first sample after a move is queued - clamp to the configured axis limit |
| `Stat.CurrentID` | **survives Close/Open.** Stamp `AddDummyMove` on connect or you report progress from a previous session. Move id 0 is reserved for that sentinel |
| `TrajParam.USBPufferSize` | the buffer's **capacity** in seconds, not how much is in it - that is what `buffer.capacitySeconds` carries (contract v2; `buffer.moves` is the occupancy) |
| gantry slaving | UCCNC stores the slave as a name, the API wants an index. Missing it drives one side of a gantry and racks it |
| work coordinates | the controller knows only machine position; G54-G59 live above it, held by the bridge |
| override channels | `SetFRO`/`SetSRO`/`SetJRO` take an **absolute percent**, so `to: 'percent'` is real here. There is no rapid override: the interface's `rapid` channel is carried by the **jog rate** override (`SetJRO`) |
| `UC100.dll` threading | undocumented, so one lock serialises every call - the status loop and the dispatcher both reach it |

## Where the interface and the UC100 API do not line up

Recorded here because both sides of `BRIDGE-PROTOCOL.md` need to know.

- **`jog` is incremental; UC100's jog is continuous.** `MachineController.jog`
  is a distance plus a feed. `JogOn`/`JogOff` is an on/off jog and
  `JogOnSpeed`'s speed is a percentage of the jog rate, not mm/min. The faithful
  mapping is `AddLinearMoveRel`, a buffered relative move - so `jogCancel` has to
  stop motion (`StopWithDeccel`), not merely `JogOff`.
- **There is no rapid override.** See the table above.
- **There is no G-code interpreter.** `sendCommand`, `sendCommandAwait`,
  `loadJob` and `loadJobFrom` cannot be honoured at all; the bridge says so
  plainly rather than faking a text path. The geometry path (`loadMoves`) is the
  only program route, which is exactly what `capabilities.geometryQueue` is for.
- **`loadMoves` cannot push to the controller.** On UC100 a queued move begins
  executing as soon as it is accepted, so "load" would mean "run". The bridge
  stages the program and `startJob` streams it.
- **No controller-level soft reset.** `reset()` maps to an immediate `Stop()`
  plus `ClearSoftlimitState()`; there is no equivalent of GRBL's Ctrl-X.
- **`AddCircularMove`'s `Dir` is documented only as "CW/CCW".** Which boolean is
  which is unverified; `clockwise` is passed straight through and must be
  confirmed on hardware with outputs inhibited.

## Segment unification: the board's 100/100 is the intended setting (WO-1320)

the operator's `LienCNCV2.pro` declares `maxLinearUnificationLength = 2` and
`maxLinearAddLength = 1`. His AXBB-E holds **100 / 100**, and so does the demo
board - it is the board's own default. **The bridge sends neither value, on
purpose** (WO-1011 removed the write), and it reports the gap on a NOTE line at
startup so the divergence stays visible.

**100/100 is intended.** Measured 2026-09-10 from 2,199 status frames of real
cutting motion at that setting (`src/tests/evidence/WO-1313/capture-2026-09-10-run4/`):
a 90-degree corner survived intact between two 0.165 mm steps, and the path
check on the same setting read a worst deviation of 0.021 mm against a 0.090 mm
threshold. Aggressive unification would show as rounded corners and smeared
turns; there are none. The profile's 2/1 is an imported seed, exactly as its
500 acceleration was a seed for the 1000 he chose.

Do not re-derive "the profile asks for 2/1 and we send nothing" as a defect.
If the operator wants the value changed he says so; until then the board holds what it
holds and the bridge does not write it.

## Not done yet

- **Nothing may move.** Motion is implemented but gated (see above) until
  WO-423 confirms the (port, pin) mapping against hardware.
- **Buffer flow control is partly unverified, and the two halves differ.**
  Corrected 2026-09-10 - this entry used to say flatly that "demo mode has no
  buffer model", and that is wrong in a way that matters to WO-1081.
  - **Occupancy IS modelled on the demo board.** `src/tests/evidence/PUFFER-4096/`
    measured the counter wrapping there precisely: 4022 moves -> reports 4022,
    4274 moves -> reports 178 (`4274 mod 4096`), and
    `docs/research/uccnc-api-probe/buffer-stream-2026-08-21.txt` shows it
    climbing to 4088 across a 5000-move push. **So a credit-window streamer can
    be developed and largely proven at the desk.**
  - **The FULL SIGNAL is not.** `rc == 10` (`UC100_COMMAND_BUFFER_FULL`) is
    implemented as the backpressure path - wait and retry, never drop a move -
    and the demo board never returns it. **That half still needs real hardware**
    with `SetOffline(true)` (`uccnc-control-plan.md` section 12.2).

  Reading occupancy and being told "full" are different signals; conflating
  them is what made this entry over-claim.
- **The (port, pin) to single-pin-number mapping is unverified.** No output may
  be enabled until it is confirmed against hardware with outputs inhibited.
- **Homing speeds are imported but untried.** `Homingspeedup`/`Homingspeeddown`
  are read as units/minute and divided by 60, by analogy with `Velocity`; that
  analogy has not been measured.
- The spindle is a Modbus VFD on this machine, not a controller output -
  `capabilities.ownsSpindle` is false and `status.spindleRpm` is null. The
  separate serial link is not built yet.
- **A board-driven spindle (WO-1724).** A machine whose definition states a
  board speed output (PWM, or the 0-10V output made from it) or M3/M4 spindle
  relays is driven by the bridge. `spindleOn` carries the definition's
  `drive`; the bridge writes it with `SetSpindleSetting`, then
  `SetSpindleSpeed` and `SpindleOn`. The relay pins come from the applied
  definition's `outputs` (entries whose word is M3/M4) and are switched through
  the ordinary output switch (`SetOutput`), not the board's own relay feature:
  on the demo board relays switched that way never show up in `GetOutput`, so
  nothing could prove them. The reply is the board's readback: the setting it
  holds, `Stat.SpindleOn`/`SpindleDir`, `GetSpindleSpeed` and each relay's
  level. `spindleOff`, E-STOP and socket loss also run `SpindleOff` and release
  the relays - only once this session has configured a board spindle, so a
  VFD machine's stop path is unchanged. Capabilities declare
  `boardSpindleCommands: true`; `ownsSpindle` stays false because the app
  reads it as "this backend reports accessory state", which this bridge does
  not. Not yet proven on real hardware: hardware check M11.
