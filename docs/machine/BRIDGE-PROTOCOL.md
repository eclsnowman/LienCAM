# Machine bridge protocol

The wire contract between LienCAM in the browser and a machine-local bridge
process that drives a controller LienCAM cannot reach directly (today: the
CNCdrive AXBB-E via `UC100.dll`).

This document is the **shared artifact** between the two halves - the C# bridge
(`pendant/uccnc-bridge/`) and the TypeScript backend
(`src/lib/machine/uccncController.ts`). Both sides are written against this and
against `src/lib/machine/controller.ts`, so they can be built independently and
meet here.

## Transport

- WebSocket, **loopback only** (`ws://127.0.0.1:<port>/`). The browser side
  refuses any other host: the far end can move a machine.
- Text frames, one JSON object per frame, no framing of our own.
- The bridge is the server. One browser session at a time.
- **Any frame from the browser is a heartbeat.** While the spindle is running,
  the client must send *something* at least every 2 s (`VfdLink.ClientHeartbeatMs`)
  or the link stops the spindle with `lastStopReason: "clientGone"`. A UI that
  polls anything satisfies this without trying; a script has to do it on purpose.
  There is no dedicated heartbeat message and there should not be one - the
  point is proof the client is alive, and any frame is that.
  (2026-08-22: this was the contract all along, but `Vfd.Heartbeat()` was wired
  to nothing, so the watchdog fired 2 s after connect and the spindle could not
  run for longer than that under any client. Undocumented and unimplemented at
  the same time is why it stayed invisible.)

## Shape

Do not invent a message vocabulary. **Every message is a mechanical mapping of
`MachineController`**, so both sides derive the same thing without negotiating:

**Calls** - browser to bridge:

```json
{ "t": "call", "seq": 12, "m": "jog", "a": { "axis": "X", "deltaMm": 5, "feedMmMin": 1200 } }
```

- `m` is the interface method name, verbatim.
- `a` is its arguments **by parameter name**, verbatim from the signature.
  Positional arrays are not used - a renamed or reordered parameter must break
  loudly, not silently bind to the wrong value.
- `seq` is a monotonic integer chosen by the browser.

**Replies** - bridge to browser, one per call:

```json
{ "t": "reply", "seq": 12, "ok": true, "v": true }
{ "t": "reply", "seq": 12, "ok": false, "error": "soft limit would be exceeded" }
```

- `v` is the method's return value, JSON-encoded as the interface declares it.
- A method declared `void` still gets a reply, with `v` absent. Callers that do
  not await it still need the failure path.

**Pushes** - bridge to browser, unsolicited:

```json
{ "t": "status", "v": { ...MachineStatus..., "positionKnowledge": "unknown",
                            "homingCycle": { "X": null, "Y": null, "Z": null } } }
{ "t": "console", "v": { "dir": "rx", "text": "...", "severity": "info" } }
{ "t": "phase",  "v": { "phase": "connected", "version": "AXBB fw 1000 / dll 2204" } }
{ "t": "jobEvent", "v": { "event": "completed", "fault": null } }
{ "t": "homed",  "v": { "axes": ["Z", "X", "Y"],
                            "homingCycle": { "X": 1789064520124, "Y": 1789064531377,
                                             "Z": 1789064498220 } } }
{ "t": "alarm",  "v": { "code": null, "message": "...", "positionLost": true } }
{ "t": "vfd",    "v": { "up": false, "running": false, "faulted": false, "runStateWord": 0,
                        "commandWord": 5, "setpointWord": 0, "consecutiveFailures": 0,
                        "lastStopReason": "commanded", "lastError": null,
                        "statusWords": [], "status": {}, "upToSpeed": null } }
```

- `status` carries `MachineStatus` exactly as declared, including its `null`s.
  **Absent data is `null`, never a substituted number** - the UI says "unknown"
  honestly.
- `positionKnowledge` is exactly `yes | no | unknown`, on both `hello.v` and
  `status.v`. This is a **bridge-computed observation**, not a UC100 field: the
  UC100 API exposes `Stat.Home` only while homing is active and exposes no
  persistent homed bit. It begins `unknown`, becomes `no` when this bridge
  observes an e-stop, hard limit, or invalidating definition change, and
  becomes `yes` only after X, Y and Z each complete a homing cycle whose
  auto-zero makes the coordinate meaningful. A status read that cannot ask the
  controller reports `unknown` for that frame; inability to ask is never
  promoted to `yes`.
- `homingCycle` is present on `hello.v`, `status.v`, and every `homed.v`. It is
  a per-axis object because this bridge starts and observes UC100 homing one
  axis at a time. Each value is the bridge-recorded completion time in Unix
  milliseconds, or `null` when this bridge process has observed no completed
  cycle for that axis. A completion is assigned only after Home clears, the
  board settles, and the position stamp reads back. Values survive browser
  disconnect/reconnect while the bridge stays alive. They return to `null`
  when the bridge restarts or the controller is reopened, because UC100 has no
  homing identity to reconstruct; `null` is unknown, never "not homed since".
- `status.v.overrides` carries the controller's current percentages as
  `{ "feed": number|null, "rapid": number|null, "spindle": number|null }`.
  The UC100 bridge reads FRO and SRO on every status poll; `rapid` is `null`
  because UC100's JRO is a jog-rate control, not a rapid-move override. The
  bridge may additionally report JRO as `overrides.jog`, but a client must
  never relabel it as rapid. `hello.v.capabilities.overrides` declares those
  same three channels with booleans (`feed: true`, `rapid: false`,
  `spindle: true` for UC100), so unsupported renders as `n/a`; an older hello
  or status frame with no override declaration/value remains unknown (`--`).
- Cadence: on change, and an unchanged frame is repeated at least every 100 ms - or every 500 ms
  only while CONFIDENTLY idle: the board said idle, every read the frame depends on answered
  (position, feed hold, inputs, overrides, buffer, any configured probe pin or drive-fault input),
  and no limit/E-STOP input or soft-limit latch is set (WO-1990).
  Status reads cost ~0.001 ms on this controller
  (`docs/research/uccnc-api-probe/`), so there is no reason to be stingy.

### The contract v3 pushes (WO-423)

`jobEvent`, `homed` and `alarm` are the `ControllerEvents` members this bridge
can honestly raise. There is deliberately **no** `jobProgress`, `offset`,
`setting` or `accessories` push: progress rides in the status frame as the
executing move id, this controller keeps no GRBL-style offset or settings dump,
and the spindle is a Modbus VFD on a separate link (`capabilities.ownsSpindle`
is false). A missing event is honest; an invented one is a lie the UI repeats.

- `jobEvent.event` is one of `started | paused | resumed | stopped | completed |
  failed`. `started`, `paused` and `resumed` are pushed when the corresponding
  call succeeds. **The terminal three are RAISED by the code that knows the
  outcome and merely delivered by the status thread** - never inferred by it.

  WO-1054 (2026-08-27): they used to be deduced from the EDGE of the job-running
  flag, and measurement showed that edge is never observed. At 5, 40, 1,000 and
  4,000 moves the bridge emitted `started` and then **nothing at all**, while
  its own log said "program finished: N of N moves pushed". The window in which
  the flag is true is exactly the window in which the streaming loop holds the
  board owner that the status poll needs, so the one observer that had to see it
  was the one thread that could not.

- **`completed` MEANS EXECUTED, NOT SENT.** It is raised only after the board
  reports idle AND the position has not changed across two consecutive polls.
  The moves being handed over is a different fact and a much earlier one: the
  streaming loop finishes pushing while the machine is still cutting.

  This matters at a part boundary. A client that treats "all moves sent" as
  "the part is finished" will start the next part into a machine that is still
  moving. Measured: a second `loadMoves` + `startJob` were both accepted
  while `state` was still `"run"` and the position was still changing.

  The idle check deliberately does **not** read `Stat.Puffer`. That counter is
  12-bit and wraps at 4,096, so on exactly the long programs this matters for it
  reports a fiction - a full queue can read zero. The position cannot wrap.

- **A stop during execution reports `stopped`, never `completed`.** Stopping
  is precisely what makes the machine go idle and hold still, so without an
  explicit cancel the operator would press Stop and be told the part finished.
- `fault` is null except on `failed`, where it is a `JobFault`. This controller
  queues **geometry**, so `moveId` names the refused move and `line` is null;
  it has no firmware error numbers, so `code` is null too.
- `homed.axes` is never null - UC100 homes named axes one at a time, so the
  bridge always knows which finished.
- `alarm` is raised on the RISING edge of `inputs.estop` / `hardLimit` /
  `softLimit`. `code` is null (no alarm numbers on this controller).
  `positionLost` is true for an E-stop or a hard limit - both lose steps, so the
  position cannot be trusted until re-homing - and false for a soft limit, which
  is the controller refusing a move it had already planned.

### The `vfd` push (WO-427)

**Two fields in this frame are routinely misread, and they are the two that
decide whether it is safe to do something to a spinning tool. Read this before
using either.**

- **`running` is OURS, not the inverter's.** The bridge computes it as
  "the desired direction is not Stopped", and that desire is only ever set by a
  Run or Stop call - never from a register read (`Vfd.cs` `Sample`, and
  `_desired` is assigned nowhere else). `running: false` therefore means
  *we have not asked it to turn*. It is NOT evidence the spindle has stopped,
  and it stays false through a link that is dead, an inverter someone started
  from the keypad, and a coasting spindle.

- **`runStateWord` is the INVERTER's**, and it is only meaningful while
  `up` is true. It is the raw 0x1001 operating-state word: 1 forward,
  2 reverse, 3 standby, 4 fault, 5 POFF (WO-1057). **Running is 1 or 2.**
  A failed poll leaves the previous word standing, so reading it while
  `up` is false is reading a stale sample.

The distinction is the whole of the no-seed refusal rule: absence of a
"running" answer is not a "stopped" answer. Anything deciding whether the
spindle is turning reads `runStateWord` with `up` true, and refuses when it
cannot get one - never `running`.

Named `faultWord` until WO-1074 (2026-08-27), after the register's own wrong
name, which is exactly how it went unread for this purpose for so long.


The spindle is a Modbus VFD on its own serial link, not a controller output
(`capabilities.ownsSpindle` is false - section 10 of
`docs/research/uccnc-control-plan.md`). **If that link was never started
(the bridge was run without `--vfd <definition.json>`), this push never
fires at all** - a missing push is honest, a frame of nulls is not.

```json
{ "t": "vfd", "v": {
    "up": false,                 // the last poll pass got a good reply
    "running": false,            // WHAT WE COMMANDED, not what the inverter says - see below
    "faulted": false,            // the definition's fault rule applied to runStateWord
    "runStateWord": 0,           // the RAW 0x1001 operating-state word - see below
    "commandWord": 5,            // the RAW command word last written
    "setpointWord": 0,           // the RAW setpoint word last written
    "consecutiveFailures": 0,
    "lastStopReason": "commanded",   // none | commanded | serialTimeout | clientGone | closing | refused
    "lastError": null,
    "statusWords": [],           // the RAW status register block, in order
    "status": {},                // status words NAMED by the definition's register map
    "upToSpeed": null
} }
```

`statusWords` is the raw register block, unconverted. `status` gives some of
those same words NAMES (`volts`, `amps`, `actualRpm`, `torque`, ...) - but
still as raw words, not physical units, and only for a field whose definition
scale is the identity (`raw.value` or the plain number `1`). **The bridge does
no unit conversion and never will**: `Vfd.cs`'s header rule is that there is
exactly one expression evaluator in the product (`src/lib/machine/vfd/`), and
it is not in C#. A field with a real scale (a division, a derived quantity such
as the operator's `power = volts * amps`) is simply absent from `status` here; decoding
it is LienCAM's job. `upToSpeed` is `null` for the same reason: computing it
means comparing the actual RPM to the COMMANDED one, and turning `setpointWord`
back into RPM needs that same scale expression, so the bridge does not attempt
it. `faulted` is the one exception - `equals` / `nonZero` / `mask` is a fixed
three-way comparison, not an expression, and mirrors `vfdSafety.ts`'s
`vfdIsFaulted` exactly.

`MachineStatus.spindleRpm` (in the regular `status` push) is the other
half-step the bridge takes on its own: it is the raw `actualRpm` word,
un-converted, while the link is up and not faulted - which is only honest
because that specific word happens to be named under the same identity-scale
rule above. It stays `null` whenever the link is absent, faulted, or the
`actualRpm` field is not identity-scaled.

**Hello** - first frame the bridge sends, before anything else:

```json
{ "t": "hello", "v": { "protocol": 1, "bridge": "liencam-uccnc-bridge/0.2",
                       "capabilities": { ...ControllerCapabilities... },
                       "readOnly": false,
                       "positionKnowledge": "unknown",
                       "homingCycle": { "X": null, "Y": null, "Z": null },
                       "vfd": { "present": false, "verified": false, "name": null } } }
```

The browser refuses to proceed on a `protocol` it does not know. `capabilities`
is authoritative - the browser must not assume what the controller can do.
`readOnly: true` means the bridge will refuse every motion call; the UI must say
so rather than letting the operator discover it by pressing something.

### `previewProfile` (WO-1040/WO-1106): read a .pro, change nothing

```json
{ "t": "call", "seq": 12, "m": "previewProfile", "a": { "path": "C:\\UCCNC12115\\Profiles\\LienCNCV2.pro" } }
```

Reply value: `{ ok, reason, path, fileHash, settings: [{ section, key, value }] }`.

The operator picks a profile in the browser and must be shown every value it
would change BEFORE anything is written. The `.pro` files live on the machine
PC, so only the bridge can read them.

**READ-ONLY, AND STRUCTURALLY SO.** `Machine.PreviewProfile` is `static` and
parses into a local: there is no path from this call to the live `ini` the
board was configured from. A preview cannot alter what the machine is running
while the operator is still reading the report about it. There is deliberately
**no write verb beside it** - the app diffs this against its own store, names
every change, and applies through `applyMachineDefinition` as it always has.

**`fileHash` is the point of the reply, not decoration.** It is the SHA-256 of
the file. A preview is a statement about a file at a moment, and the file lives
on a PC the operator also uses. Confirm re-calls `previewProfile` and REFUSES if
the hash moved, so a report can never be applied to a file that changed
underneath it. That is the WO-1053 stale-frame lesson written into a contract.

**It reads only what this bridge advertised.** `hello.uccnc.profiles` is the
list; any other path is refused with `ok:false` and a reason. Without that this
verb is an arbitrary file reader on a socket.

`settings` is in FILE ORDER and keeps duplicate keys as they appear - it is a
report about a file, and one that silently dedupes or reorders is a report about
something else. A refusal comes back as `ok:false`, never as a failed call: a
refusal is an answer.

### Phase B (WO-1040/WO-1094): the cache is the only startup authority

There is no new verb. `applyMachineDefinition` sends the complete
`ControllerDefinition`, including `settings`, and the bridge caches that exact
document. At Open the bridge configures the board from the cache alone:

| fact | source at Open (bridge) | who writes it | when |
| --- | --- | --- | --- |
| axes, homing and IO | cached `definition` | app, `applyMachineDefinition` with provenance | Apply to Machine and connect-time apply |
| trajectory (`Generalsettings.Constantvelocitymode`, `Stopatangle`, `Linearerror`, `Cornerserror`, `USBbuffersize`), `Generalsettings.Softlimitsenable`, per-axis `axessettingscontrol<AXIS>.Compaccel` (UCCNC suffixes these sections with the axis LETTER - `axessettingscontrolX`, `...Y`, `...Z`, `...A`, `...B`, `...C` - not a digit; the earlier `N` shorthand here read as numeric and cost a wrong test on 2026-08-29), `FaultSignals.*`, `Workoffset_G5x.*` | cached `definition.settings`, keyed by `(Section, Key)` | the same `applyMachineDefinition` call | the same |
| cached definition with no `settings` (written by an app older than WO-1039) | `profileBaseline`, captured by reading the `.pro` once on the first Open under the new bridge | bridge, once | upgrade path only; the next current-app apply supersedes it |
| the `.pro` | never read at normal Open; read only when the operator imports or re-imports it | app | user gesture |
| `hello.definitionSource` | `"cache-baseline"` when cached settings configured the board without opening a file; `"profile"` only for the one upgrade read; `"none"` when the cache is empty | bridge | every hello |
| `hello.workOffsets.profile` | cached `Workoffset_G5x` settings | bridge | every hello |
| drift | `hello.definitionDrift`, cached definition versus the definition held by the app | bridge computes; app reports | every hello |

Re-import is the existing profile-picker gesture. Its preview names every value
that would change, Confirm writes the app's store, and Apply to Machine sends
that same definition to the cache with `imported` provenance. A later setting
change made directly in UCCNC does not change how LienCAM drives the machine
until the operator explicitly re-imports that `.pro`.

`workOffsets` (WO-1042), in millimetres:

```json
"workOffsets": {
  "current": { "G54": {"x":81.2275,"y":61.3225,"z":12.16}, ... "G59": {...} },
  "profile": { "G54": {"x":81.2275,"y":61.3225,"z":12.16}, ... "G59": {...} }
}
```

`current` is what the bridge holds now. In Phase B, `profile` retains its wire
name for compatibility but contains the cached definition's
`Workoffset_G5x` startup values. It is `null`, not zeros, when the bridge has
no cached definition. "The cache has no startup value" and "the cache says 0"
are different facts; collapsing them is how a client concludes something was
deliberately zeroed.

**ABSENT means an older bridge that cannot say.** Not "all zero".

**COMPARE `current` AGAINST `profile`, NEVER AGAINST ZERO.** Open seeds
`current` FROM the cached startup values, so a fresh bridge reports those numbers -
on the operator's machine G54 is 81.2275 / 61.3225 / 12.16 at a first connect, not
0,0,0. "All zero" only means nobody ever set that WCS anywhere; a fresh bridge
and a deliberately-zeroed offset are indistinguishable by value.

The pair is the discriminator:

    current == profile   nobody touched that WCS this bridge session, so a
                         stored value is safe to push without asking.
    current != profile   somebody set a zero at the machine since this bridge
                         started - the only case worth interrupting for.

`current` does not survive a bridge restart by itself. After a restart it is
seeded from the cached definition again. The bridge does not open or write the
operator's `.pro` during that restart (WO-1036, ADR-0044).

There is no work-offset register on the controller (WO-1041): these are the
bridge's own numbers, ADDED to outgoing coordinates and SUBTRACTED to report
`workPos`. At restart they are reconstructed from our cached definition, not
from the operator's `.pro`.

`vfd` (WO-427) says whether a spindle link exists for this process at all,
independent of whether it is presently connected to hardware (the `vfd` push
carries that). `present` is true once `--vfd <definition.json>` was given and
the definition passed validation; `verified` is the definition's own
`verified` flag, copied straight through - false for every definition that
ships today, which is exactly what refuses spindle-on. `name` is `null` unless
`present` is true.

### Spindle calls (WO-427)

Not `MotionCalls` - the VFD is separate hardware from the UC100 motion
controller, on its own gate, so these are never refused by `readOnly`.

```json
{ "t": "call", "seq": 9, "m": "spindleOn", "a": { "direction": "cw", "setpointWord": 4166 } }
{ "t": "call", "seq": 10, "m": "spindleOff" }
{ "t": "call", "seq": 11, "m": "spindleResetFault" }
```

- `spindleOn` - `direction` is `cw` or `ccw`. `setpointWord` is the RAW
  register word, already scaled from a commanded RPM by LienCAM (the
  definition's setpoint expression, e.g. `set.rpm / 2.4`) - the bridge does not
  evaluate that expression, so it never accepts an RPM here. Refused with no
  link configured (`hello.vfd.present` false), and refused - by
  `VfdLink.Run` itself - while `hello.vfd.verified` is false, which is every
  definition that exists today.
- `spindleOff` - no arguments. **Never refused**, including with no spindle
  link configured at all, in which case there is simply nothing to stop. This
  is the no-gate-may-block-a-stop rule applied to the wire: a browser must
  never have to special-case "is there even a spindle" before it is safe to
  ask for one to stop.
- `spindleResetFault` - no arguments, starts the definition's write-wait-write
  reset sequence. Refused only when no link is configured; unlike `spindleOn`
  it is NOT behind the `verified` gate, because clearing a fault does not spin
  anything.

### Work offset calls (WO-1041, WO-1083)

Neither call moves anything. Both write bookkeeping the bridge holds for THIS
SESSION only - ADR-0044 keeps the operator's `.pro` read-only, so a work zero
does not survive a bridge restart until the app pushes it back in.

    setWorkOffset  { wcs, x?, y?, z? }   set an offset TO A NUMBER
    zeroWorkAxis   { axis }              set it to WHERE THE TOOL IS

**Both reply with the same receipt shape,** and a refusal is an ANSWER rather
than a failed call - `ok:false` inside a successful reply, never a transport
error:

    ok      { ok: true,  reason: null, wcs: "G54", axis: "x",
              offset: { x, y, z } }
    refused { ok: false, reason: "<why>", offset: null }

`wcs` and `axis` are on the `zeroWorkAxis` receipt only; `setWorkOffset` was
already told which system it was writing.

**`offset` IS AN ECHO OF WHAT THE BRIDGE NOW HOLDS, NOT A READBACK.** The
AXBB-E has no work-offset register, so there is nothing on the board to read
back and nothing here proves the value took effect. The proof of effect is
`workPos` in the next status frame, which is `machinePos` minus the active
offset.

It is the WHOLE ROW - all three axes of the active system - not just the axis
that changed, because a caller reconciling a work coordinate system wants the
system and not one number.

**A bare `true` in reply to `zeroWorkAxis` is an older bridge that cannot
say.** Before WO-1083 the reply carried no value, so a client's only source
for the resulting offset was a status frame - and that frame is sampled on a
different loop, so it can arrive after the receipt while still describing the
world before the zero. Clients must accept both shapes.

## Bridge supervisor lifecycle contract

The browser build does not own native processes, so a machine-local Node
supervisor owns `liencam-bridge.exe`. `New-BridgeShortcut.ps1` calls
`pendant/uccnc-bridge/supervisor/Install-Supervisor.ps1`, which copies the
supervisor beside the bridge, installs it as the current user's `LienCAM Bridge
Supervisor` login task and starts that task immediately. The desktop preload remains the first choice when it is present;
the browser uses the supervisor only when there is no preload lifecycle host.

The supervisor binds HTTP to `127.0.0.1` only, on bridge port + 1 (8326 for the
default bridge port 8325). Browser requests are accepted only from loopback
HTTP(S) origins; requests without an Origin header remain available to local
service diagnostics. There are four routes and no second machine-control protocol:

| route | meaning | reply |
| --- | --- | --- |
| `GET /status` | Report the owned process, socket health, last exit and last 50 stdout/stderr lines. | `BridgeProcessStatus` |
| `POST /start` | Start the bridge with the request's launch arguments if stopped and wait for its TCP socket. | `BridgeRestartResult` |
| `POST /restart` | Stop the owned process, start it with the request's launch arguments and wait for its TCP socket. | `BridgeRestartResult` |
| `POST /stop` | Stop the owned process after the app has disconnected from the controller. | `{ "ok": true }` or `{ "ok": false, "reason": "stop-timeout" }` |

`BridgeProcessStatus.health` is `stopped`, `starting`, `healthy` or `failing`.
`healthy` means the child is alive and the configured bridge port accepts a
TCP connection. `failureReason` is a plain sentence; `lastExit` is the process
exit tuple; `lastLogs` is capped at 50 lines. A bridge that exits before its
socket listens returns `reason: "exited"`. A live child whose socket never
listens returns `reason: "no-socket"`. A missing bridge executable returns
`reason: "not-configured"` without spawning anything.

`POST /start` and `POST /restart` accept `{ "args": ["..."] }`. The browser
build derives that array from the active machine's computer-local
`machineLinks` record. The desktop preload carries the same record to
`machineBridgeSpec()`, which derives the same flags before spawning. The order
is `--install-root`, `--profile`, `--board`, `--vfd`, omitting unchosen values
except board: an absent board is always emitted as `--board auto`. This is the
safe default introduced after a stale demo-board config impersonated a live
machine. `LIENCAM_BRIDGE_ARGS_JSON`, when present in the desktop host's
environment, remains an explicit whole-array override and wins over the app
record. The scheduled supervisor's `--bridge-args-json` remains the fallback
for direct local calls whose POST body is empty. The desktop host retains the
last renderer-supplied record in memory for its bounded automatic crash
respawns; the durable authority remains the renderer's per-machine record and
is mirrored through the preload when it changes. On an ordinary desktop cold
start, the main process reads that computer-local mirror before its first
spawn. After both renderer stores hydrate, the renderer re-supplies the active
machine's authoritative record and the host reconciles any stale mirror once.

Lifecycle HTTP never carries jog, spindle, setup or controller calls. Those
remain on the WebSocket contract above. Closing that WebSocket performs the
bridge's existing feed-hold/stop safety boundary before the supervisor ends
an idle process.

## Errors

`ok: false` with a plain-sentence `error` that an operator can act on. Never a
raw return code alone - if the API returned one, say what it means and include
the code in parentheses. The controller's own codes are enumerated in
`API/Interface/UC100.h`.

## Safety rules the bridge enforces regardless of what it is asked

These are not options and are not negotiable from the browser side:

1. **Losing the socket stops the machine.** On close or read error, feed hold
   then stop, immediately.
2. **Loopback bind only.** A non-loopback bind address is a refusal at startup.
3. **`AddDummyMove` on connect** to stamp a known baseline: the executing-move
   id survives a close/open cycle on this controller, so without it the bridge
   would report progress left over from a previous session
   (`uccnc-control-plan.md` section 12.3).
4. **Outputs start inhibited on every open**, and the bridge says so in
   `hello`. A client that wants to drive terminals must ask, with
   `setOutputInhibit {on: false}`.

   That call was refused unconditionally while the (port, pin) mapping was
   unverified. **The mapping was verified against hardware on 2026-08-21** — X
   and Z each moved under the bridge's own translation — so the refusal now
   defers to the one read-only gate (`Machine.readOnly`) instead of carrying
   its own hardcoded copy of the rule. Inhibiting is never refused, per rule 1.

   **Output numbering (WO-1666, measured 2026-09-18 on the DLL itself, both
   versions - `src/tests/evidence/WO-1666/`):** `SetOutputBit(Num)` and
   `ClearOutputBit(Num)` take the UC pin number, 1-based (Num 2 sets bit 1,
   Num 0 is refused with rc 9); the `GetOutput`/`SetOutput` word holds
   bit = UC pin - 1, like the `GetInput` word. `setOutput` therefore calls
   `SetOutputBit(ucPin)` and reads `level` back from bit `ucPin - 1`. The
   first bridge passed `ucPin - 1` to both and switched the wrong pin.
5. **The spindle link is opt-in, and starting it can never move it.** Absent
   `--vfd <definition.json>`, no serial port for the spindle is ever opened -
   `hello.vfd.present` is false and the `vfd` push never fires. A definition
   that fails validation is a startup refusal (the process exits), same as
   rule 2. Once loaded, `spindleOn` is refused - by the link itself, not by a
   flag the browser could bypass - while `hello.vfd.verified` is false, which
   is every definition that exists today (WO-427). `spindleOff` is never
   gated by anything, including the absence of a link at all.
