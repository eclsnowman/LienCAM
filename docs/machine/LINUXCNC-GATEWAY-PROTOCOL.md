# LinuxCNC gateway protocol

The wire contract between LienCAM and `pendant/linuxcnc-gateway/gateway.py`, a
small process on the LinuxCNC PC (WO-1986). It is **`BRIDGE-PROTOCOL.md`,
spoken by a second, independent implementation** - same frames, same method
names, same `null` rules. This page records only what differs, what LinuxCNC
adds, and what was measured. Where it is silent, `BRIDGE-PROTOCOL.md` governs.

Status: verified against real LinuxCNC 2.9.4 in simulation (the WO-1982
container on the Spark, stock `sim/axis/axis_mm.ini`). **Not verified on
LinuxCNC hardware** - ADR-0048's second tier. No LienCAM backend in `src/`
talks to it yet; that is the next order.

## Which LinuxCNC interface - ADR-0054's first question, answered

**LinuxCNC's own Python module (`import linuxcnc`: `stat`, `command`,
`error_channel`, `ini`) - the NML channels Axis and gmoccapy use - inside a
separate gateway process on the LinuxCNC PC, which speaks LienCAM's bridge
protocol over a WebSocket (loopback by default; the network with
`--host 0.0.0.0`, WO-2101).** Not `linuxcncrsh`, and not a direct
browser-to-LinuxCNC link.

Why, with the evidence:

| question | answer | evidence |
|---|---|---|
| Does the Python/NML interface carry everything the order needs? | Yes: status, E-STOP, reset, home, jog (step and continuous), jog stop, MDI, work offsets (G10), program load/run/pause/resume/stop, and LinuxCNC's own refusal sentences. | `src/tests/evidence/WO-1986/tier2-run{1,2,3}.json` - three consecutive full passes |
| Does it report what `linuxcncrsh` cannot? | Yes: the error channel (e.g. `G-code out of range`, `Cannot home while shared home switch is closed j=2`), per-joint homed/homing/position, three program line numbers, overrides incl. a real rapid override. | same files, `mdiRefused`, `linuxcnc.joints`, `lineSamples` |
| Does the gateway add latency to a stop? | Not measurably. E-STOP shows in a status frame 149-228 ms after the call through the gateway; raw `linuxcnc` with no gateway, same simulator: 194-199 ms. The simulator's `[TASK]CYCLE_TIME = 0.100` dominates. | `tier2-run*.json` `estopToStatusMs`; `estop-raw-output.json` (from `estop_raw.py`) |
| Can the browser talk to it? | Yes: headless Chromium 149 opened the socket from a loopback page, received hello/phase/status and a call reply; a page from a foreign origin was refused. | `browser-handshake.json` |

Why a separate process, not LienCAM importing LinuxCNC: `import linuxcnc`
makes the importing code a derivative of LinuxCNC (GPL-2-or-later). An
arm's-length process behind a documented socket keeps that boundary where it is
(`docs/research/2026-09-10-lcnc-suite-and-linuxcnc.md` section 5), and NML is
local to the LinuxCNC host anyway.

## Transport

As `BRIDGE-PROTOCOL.md`, with these specifics:

- `ws://127.0.0.1:8327/` by default (`--port`): LienCAM on the LinuxCNC PC.
- **LienCAM on another PC (WO-2101):** `--host 0.0.0.0` (or one interface's
  address) listens on the network. LienCAM takes the LinuxCNC PC's address on
  Machine > Definition > Controller ("LinuxCNC PC address": `host` or
  `host:port`; blank = this PC), stored on the machine as
  `linuxcncGatewayAddress`; the next Connect uses it. Measured against the
  WO-1982 simulator from the dev box across the LAN
  (`src/tests/evidence/WO-2101/tier2-run.json`): E-STOP to LinuxCNC's own
  E-STOP status 201-212 ms (141 ms during a run) - the loopback runs measured
  149-228 ms; the simulator's 100 ms task cycle dominates both.
- **Link watch, network sessions only.** A session from another computer can
  die without a close (a pulled cable, a sleeping PC), which TCP does not
  report for minutes. The gateway pings a network session every
  `--link-timeout`/4 and, once NOTHING (a pong, a call, any byte of a frame
  still arriving - a large loadJob takes seconds on a slow link) has arrived
  for `--link-timeout` (default 1 s; 0 = off), drops it - and the drop is the
  socket-loss stop below. Browsers and Node answer pings in their network
  stack, with no page code. Measured: a relay frozen mid-program was dropped
  824 ms later and the program was stopped, stationary on reconnect. A
  loopback session is not pinged: its socket closes when the page dies.
- **One session at a time.** A second WebSocket while one is open gets
  `HTTP 409` and a sentence. The slot is freed only after the last session's
  socket-loss stop (below) has finished, so that stop can never act on the
  next session's motion. A connection that arrives while that stop is still
  running waits for it (up to 3 s) and is then admitted; if the stop is still
  running after 3 s it gets `HTTP 503` and a sentence.
- **Origin check.** Accepted: no `Origin` header (a local script), `null` (the
  desktop shell's file page), any `http(s)` page on `127.0.0.1`/`localhost`/
  `::1`, an `http(s)` page served from the connecting computer's own address
  (LienCAM opened by its network address on the PC it runs on; WO-2101), and
  origins named with `--allow-origin`. Anything else gets `HTTP 403`. The
  bind address does not stop a web page in the operator's browser from
  opening the socket; the Origin check does.
- **Losing the socket stops the machine**: LinuxCNC `abort` (ends a program,
  an MDI move and a jog), then a jog stop on every axis/joint. Measured: a
  continuous jog closed mid-move was stationary on reconnect
  (`afterSocketLoss.moved = 0` in all three runs). Before that stop, every
  ordinary call the dead session sent - running, or still queued behind
  another call - is cancelled: none is issued after the stop, and none replies
  to a later session. A stop call's late acknowledgement is not replied to a
  later session either.
- Standard library Python >= 3.9 only. Nothing to install on the LinuxCNC PC.

## Hello

```json
{ "t": "hello", "v": {
  "protocol": 1,
  "bridge": "liencam-linuxcnc-gateway/0.1",
  "controller": "linuxcnc",
  "linuxcncVersion": "2.9.4",
  "ini": "/home/linuxcnc/linuxcnc/configs/sim/axis/axis_mm.ini",
  "coordinates": "XYZ",
  "capabilities": { "geometryQueue": false, "executingMoveId": false,
                    "bufferSeconds": false, "gcodeText": true,
                    "perAxisHoming": true, "ownsSpindle": true,
                    "spindleCommands": true,
                    "overrides": { "feed": true, "rapid": true, "spindle": true } },
  "readOnly": false,
  "positionKnowledge": "no",
  "homingCycle": { "X": null, "Y": null, "Z": null },
  "vfd": { "present": false, "verified": false, "name": null } } }
```

- `coordinates` is `[TRAJ]COORDINATES`, one letter per JOINT. A slaved gantry
  reads `XYYZ`: Y is joints 1 and 2. Every per-axis answer (homed, limits)
  covers ALL the joints behind a letter - Y is homed only when both are.
- `maxProgramMoves` is deliberately absent: LinuxCNC takes a FILE, so there is
  no staged move list to overflow.
- `positionKnowledge` comes from LinuxCNC's own per-joint homed bits (unlike
  UC100, LinuxCNC has one): `yes` when every joint is homed, else `no`,
  `unknown` when the status read fails.
- `homingCycle` values are set only when THIS gateway saw a joint's homed bit
  rise. A machine already homed when the gateway started reports `null` - it
  cannot say when that happened.

## Replies: a third outcome

Every reply to a command that reaches LinuxCNC carries an additive field,
`outcome`, per ADR-0054 item 1:

| `outcome` | meaning | `ok` |
|---|---|---|
| `accepted` | LinuxCNC did it (see how, below) | `true` |
| `refused` | LinuxCNC said no; `error` is LinuxCNC's own sentence from its error channel when it gave one | `false` |
| `unknown` | no answer by the deadline (`--call-timeout`, default 5 s; 2 s for stops; `sendCommandAwait`: see its row). **It may still be doing it.** | `false` |

A caller must not read `ok: false` with `outcome: "unknown"` as "the machine
refused". Replies with a declared return shape (`sendCommandAwait`'s
`{ok, message}`, `setWorkOffset`'s receipt, `resetToIdle`'s `{ok, reason}`)
put the refusal inside `v` as `BRIDGE-PROTOCOL.md` requires, and still carry
`outcome`.

**How acceptance is read** - measured, and the reason this is not one rule:

- Most commands: LinuxCNC's RCS status for that command (`RCS_DONE` = 1,
  `RCS_ERROR` = 3; the success constant is 1, not 0).
- **Program run, pause, resume, step: by EFFECT.** While a program runs,
  LinuxCNC's task status stays `RCS_EXEC`, so these never read `RCS_DONE`.
  Waiting for it reported every one of them as `unknown` after 5 s on the
  simulator. They are accepted when the interpreter state moves (running /
  paused / not paused / line changed), refused on an error-channel message,
  otherwise unknown.
- **Home: by effect.** A home request while motion is in teleop mode (left
  there by a jog) read `RCS_DONE` **and did nothing** on the simulator. The
  gateway switches to joint mode first and accepts only when a joint starts
  homing or a homed bit moves. LinuxCNC refuses joints individually on its
  error channel while others home; if it does, the reply is `refused` with
  every sentence it gave, even though some joints are homing.
- A refusal's sentence can lag its `RCS_ERROR`; the gateway waits up to
  200 ms for it so the reply carries LinuxCNC's words.

## Calls

Method names and arguments are the UCCNC bridge's wire names (its
`Bridge.cs` dispatch table), which are what `uccncController.ts` sends:
`MachineController.jogStartContinuous` goes out as `jogStart`. The gateway
has no name of its own. A bridge method with no LinuxCNC meaning (VFD,
outputs, `probe`, `loadMoves`, the job-progress reads and similar) gets
`ok: false`, "The LinuxCNC gateway has no "<m>" call.". One table-driven test
(`lcncGateway.wo1986.test.ts`) classifies every bridge method and checks
both halves on the wire.

| call | LinuxCNC route | reply `v` | notes |
|---|---|---|---|
| `queryStatus` | pushes a status frame now | - | |
| `resetToIdle` | abort, `STATE_ESTOP_RESET`, `STATE_ON` | `{ok, reason}` | what an operator presses on Axis; a running program ends `stopped` |
| `unlock` | same as `resetToIdle` | boolean | |
| `home` | manual mode, joint mode, `home(-1)` | boolean | LinuxCNC's own `HOME_SEQUENCE`; accepted when homing starts; the `homed` push reports completion |
| `homeAxes {axes}` | `home(j)` for every joint behind each letter, one at a time | boolean after all finish | never reorders; LinuxCNC's refusal is the refusal. `accepted` only once every joint has STOPPED homing with its homed bit set; a joint still homing after `--home-timeout` (default 120 s) is `unknown` (it may still be homing); homing that stops without the homed bit is `refused` with LinuxCNC's sentences. Either error names the axes already homed |
| `jog {axis, deltaMm, feedMmMin}` | `JOG_INCREMENT`, teleop when all joints are homed, joint mode otherwise | boolean | unhomed, a multi-joint letter is refused: jogging one joint of a gantry racks it |
| `jogStart {axis, direction, feedMmMin}` | `JOG_CONTINUOUS` | boolean | runs only while held: arms the jog deadman (below) unless LinuxCNC refused it |
| `jogToWorkXY`, `jogToMachineZ` | MDI `G21 G90 G1 ...` / `G53 G1 Z...` | boolean | |
| `sendCommand {text}` | MDI | boolean | |
| `sendCommandAwait {text}` | MDI, then waits for interpreter idle and in position | `{ok, message}`; a G38 line adds `probe: {word, tripped, at: {x, y, z}}` | message is LinuxCNC's sentence. WO-2099: it waits while LinuxCNC is MOVING, up to `--motion-cap` (default 330 s); `unknown` after `--call-timeout` with no motion (a 150 mm rapid outlasted 5 s on the simulator). A fresh status frame goes out just BEFORE the answer, so a client acting on "done" reads the machine idle (a Bore's next touch read the frame from during the move). **Probing** (below) |
| `selectWcs {wcs}` | MDI `G54`..`G59.3` | boolean | nine systems |
| `setWorkOffset {wcs, x?, y?, z?, r?}` | MDI `G10 L2 P<n>` with only the given axes (and `R`) | `{ok, reason, offset}`; with `r`, `{ok, reason, offset, rotation}` | flat axis arguments, as `BRIDGE-PROTOCOL.md`; an absent axis is left alone, never written as 0. `offset` is the WHOLE row `{x, y, z}` in mm, a READBACK either way: `stat.g5x_offset` when `wcs` is active; otherwise MDI `(LOGOPEN,<file>)`, `(LOG,<tag> #<x> #<y> #<z>)`, `(LOGCLOSE)` (G54 X is `#5221`, each next system +20), the file read and removed - values in machine units, converted to mm (audit 20, measured on the WO-1982 simulator). `offset: null` if the row cannot be read - never the axes just written. `(DEBUG, ...)` on the error channel was measured and rejected: Axis reads the same queue and 23/100 never arrived. WO-2185: `r` is the system's XY rotation in degrees, LinuxCNC's own `G10 L2 P<n> R`: about the system's origin, CCW positive seen from +Z; X Y Z not given stay as they were, and a G10 without R keeps R (docs/design/WCS-ROTATION.md, measured); `0` clears it. `rotation` is a READBACK: `stat.rotation_xy` when `wcs` is active, otherwise the LOG readback of `#5230 + 20 x (P - 1)`; `null` if unread. An `r` that is not a finite number is refused with nothing sent. It rides `setWorkOffset` because the gateway speaks only the bridge's method names (lcncGateway.wo1986) |
| `zeroWorkAxis {axis}` | MDI `G10 L20 P<active> <axis>0` | `{ok, reason, wcs, axis, offset}` (BRIDGE-PROTOCOL receipt; refused: `{ok:false, reason, offset:null}`) | `offset` is a READBACK - LinuxCNC has the offset register the AXBB-E lacks |
| `setOverride {change}` | `feedrate` / `rapidrate` / `spindleoverride` | - | not exercised on the simulator |
| `spindleOn {direction, rpm}` | `spindle(FORWARD/REVERSE, rpm)` | boolean | not exercised on the simulator |
| `loadJob {programText}` | writes `--program-dir/liencam-<stamp>.ngc`, auto mode, `program_open` | `{ok, path, lines, appendedEnd, startLine, notes}` or `{ok:false, reason}` | a text with no `M2`/`M30`/`%..%` gets `M2` appended and a console line says so - LinuxCNC refuses a file with no end, and the software can end it |
| `loadJobFrom {programText, startLine, prelude}` | as `loadJob`, but the file is the prelude lines verbatim, then the program from `startLine` (a leading `%` stays first) | as above | audit 15: LinuxCNC's own run-from-line does not start the spindle or make the approach (measured: spindle off, 0 RPM), so the prelude runs, as the text controllers stream it. Status lines are the program's own numbers; a prelude line reports 0. A console line says what runs |
| `startJob` | `auto(AUTO_RUN, 0)` (or `AUTO_STEP` in single block) | boolean | accepted by effect: the interpreter leaves idle. Refused while a program runs or is paused (state gates, below) |
| `resumeJob`, `cycleResume` | `auto(AUTO_RESUME)`, only while a program is paused; while LinuxCNC waits at an M6, the tool change's Continue (**Tool change**, below) | boolean | accepted by effect: the paused program stops being paused. With nothing paused it is `refused` ("Nothing is paused, so there is nothing to resume.") and **nothing is sent**: on the simulator an `AUTO_RESUME` after a finished program left the interpreter reading as busy - the next `loadJob` was refused and `startJob` re-ran the finished program (`tier2-resume-not-paused-measured.json`, `longLoad`) |
| `stepJob` | `auto(AUTO_STEP)` | boolean | accepted by effect; from idle or paused only (state gates, below); not exercised on the simulator |
| `setSingleBlockMode {on}` | gateway flag read by `startJob` | - | |

Any other method gets `ok: false` and a sentence naming it.

### Probing: G38 lines through `sendCommandAwait` (WO-2099)

LinuxCNC takes G-code, so LienCAM probes it as it probes every text
controller: the session sends `G38.2`/`G38.3` lines and reads the contact from
the PRB offset entry. The bridge's own `probe` call name stays unanswered
(above); `LinuxCncController.probe()` - what the Routines run panel calls - is
built on the same G38 line. What the gateway adds, measured on the WO-1982
simulator (`src/tests/evidence/WO-2099/g38-raw.txt`, `miss-raw.txt`,
`g53-g38-raw.txt`):

- A G38 MDI line answers `RCS_DONE` only when its move ENDS (4.06 s for a
  20 mm search at 300 mm/min), hence the motion-aware wait above.
- After an accepted G38 line the reply carries `probe`: `tripped` is
  `stat.probe_tripped` (cleared as each probe move starts, so it is this line's
  answer) and `at` is `stat.probed_position` in mm - **machine** coordinates
  (G54 Z 5 set, a touch at machine Z -20 read -20.006, not -25). On a miss `at`
  is where the move ended.
- A `G38.2`/`G38.4` miss is `{ok: false, message}`. LinuxCNC answers the MDI
  `RCS_DONE` and puts "G38.2 move finished without making contact." on its
  error channel - but Axis reads that queue too and took the sentence 4 times
  in 5, so the miss is read from `probe_tripped`, with LinuxCNC's sentence
  when the gateway got it, else the gateway's own. `G38.3`/`G38.5` end quietly
  at their target (`ok: true`, `tripped: false`).
- A probe move starting in contact is LinuxCNC's refusal ("Probe is already
  tripped when starting G38.2 or G38.3 move", `RCS_ERROR`); it leaves the
  machine as it was.
- LinuxCNC does not take `G53` on a G38 line (`RCS_ERROR`, no motion), so
  `probe()` moves relative from the machine position LinuxCNC last reported.
  LinuxCNC decelerates PAST the trip point (0.06 mm at 300 mm/min), so
  `probe()` then goes back to the latched contact on the probed axis, as
  LinuxCNC's own probe macros do, and restores G90 and the units word LienCAM
  last sent.
- A miss leaves LinuxCNC idle and ON - no E-STOP, no alarm (Tier 2 `miss`).

Proof: `src/tests/evidence/WO-2099/tier2-run.json` - Probe Z0, Z surface,
Edge, outside/inside corner, Bore, Boss, Rect pocket, Angle, a factory routine
and the tool setter Measure through the production session against a part
modelled in HAL (`sim_part.py`), every contact within 0.004 mm.

### Tool change: LinuxCNC's own M6 (WO-2100)

LinuxCNC runs its own tool change: an M6 to a tool other than the one in the
spindle raises iocontrol's `tool-change` with the tool in `tool-prep-number`,
and the program waits until `tool-changed` rises. On the stock sim (and any
Axis config) `hal_manualtoolchange` answers it: its dialog's Continue, or its
`change_button` input - LinuxCNC's own pin for a Continue button wired
outside the dialog. Measured on the WO-1982 simulator
(`src/tests/evidence/WO-2100/m6-raw.txt`):

- The wait is interp `READING` with the motion queue empty and in position;
  `exec_state` does not tell it apart (7 before and during). `read_line` is
  the M6's line; `motion_line` still names the last motion line before it.
- `change_button` pressed: `tool-change` fell 167 ms later, `tool_in_spindle`
  became the new tool, and the program's next `G43 H<n>` applied that tool's
  table length.
- An M6 to the tool already in the spindle asks nothing and runs on.
- An abort during the wait drops `tool-change` with the old tool kept.

What the gateway does:

- **Status.** While a program or MDI line waits like that, it reads
  `halcmd -s show pin iocontrol.0.tool` (about 1.5 ms, at most every 100 ms,
  and only in that shape). `tool-change` high and `tool-changed` low is a
  wait: the frame's `state` is `hold` and `linuxcnc.toolChange` is
  `{tool, line, inSpindle, answeredBy, press}` (`line` in the app's program
  numbering, null for an MDI M6; `answeredBy` the HAL pin driving
  `tool-changed`; `press` the pin the gateway sets for Continue, or null).
  Otherwise `linuxcnc.toolChange` is null. The first read of a wait puts one
  console line up: "LinuxCNC is waiting at the tool change on line 13: fit T2
  (T1 is in the spindle), then press Cycle Start."
- **`resumeJob` / `cycleResume` during a wait** (not also paused) answer it:
  `halcmd setp <press> 1` until `tool-change` falls, then `setp <press> 0` -
  always, since a button left high would answer the next M6 the moment its
  dialog opened. `press` is the answering component's unlinked
  `change_button` input (hal_manualtoolchange), or `iocontrol.0.tool-changed`
  itself when it is on no signal. Accepted when `tool-change` fell and
  `tool_in_spindle` is the tool asked for; refused when it fell with another
  tool; `unknown` when it had not fallen after 5 s. With no pin to press (an
  ATC component drives `tool-changed`) it is refused with a sentence naming
  what answers it, and nothing is set. An MDI M6's answer raises no `resumed`.
  This `setp` is the gateway's only HAL write.
- The tool number and the length offset in effect afterwards are LinuxCNC's:
  the gateway never writes a tool or an offset.

`LinuxCncController` hands LinuxCNC its M6 back: the session stages every M6
after the first move as an `M0` hold for a text controller, so an `M0` on a
line with a T word, or right after a bare T line, goes to LinuxCNC as `M6`
(`linuxcncProgramText`; every other line unchanged). While LinuxCNC waits,
the job's progress line is the M6's line, where the session's tool-change hold
and the Control tab's "Tool change - insert T2" banner are. An M6 before the
first move is held by LinuxCNC too (it runs every M6); the session stages no
banner there, so the hold and the console line say it, and Cycle Start
answers it the same way.

Proof: `src/tests/evidence/WO-2100/tier2-run.json` - a two-tool program as
LienCAM's LinuxCNC post writes it, through Connect, Load and CYCLE START, on
the simulator: held at T1 (line 3) and T2 (line 13, the banner), each answered
by Cycle Start; LinuxCNC's own `tool_in_spindle` 2 and tool offset 0.1 (its
table's T2) at the end. Not verified with a physical tool changer or on
LinuxCNC hardware.

### State gates: refused before anything is sent

A reply is `accepted` only on evidence that was false before the call and
that only this call could make true. In a few states the evidence is already
true, so no answer from LinuxCNC could prove anything. In those states the
gateway refuses the call with `outcome: "refused"` and sends nothing. The
UCCNC bridge refuses the matching calls in these states. The full per-call
table is in the WO-1986 order, "Call table".

| state | refused calls | why |
|---|---|---|
| a joint is homing | `home`, `homeAxes`, `jog`, `jogStart`, `jogToWorkXY`, `jogToMachineZ`, `loadJob(From)`, `startJob`, `stepJob` | "a joint is homing" is already what a second home would be accepted by. The bridge's long-operation gate refuses motion during a homing cycle too |
| a program is running | `startJob`, `stepJob` (and `loadJob`, as before) | the interpreter is already busy and its lines already move. On the fake, `AUTO_RUN` during a run rewound it to its start line. The audit at `bee6b29e9` reproduced line 1 going back to line 0. `jog`, MDI and the other mode-switching calls are not gated here: LinuxCNC refuses their mode switch itself, and that refusal is the reply |
| a program is paused | `startJob` | resume it with `resumeJob`. `stepJob` from a pause is allowed: that is what a step is |
| the interpreter is idle but the gateway has not yet raised the last program's terminal event | `loadJob(From)`, `startJob`, `stepJob` | the bridge's "still cutting the previous part" |

Two other rows change what is reported, not what is sent. A `pauseJob` or
`feedHold` while the program is already paused is `accepted` with nothing
sent, and it raises no second `paused` event. `resetToIdle` and `unlock`
abort a running program, so that program ends `stopped`, never `completed`.

### Stop calls: their own path

`emergencyStop`, `stopJob`, `reset`, `pauseJob`, `feedHold`, `jogStop`,
`jogCancel`, `spindleOff`. (`jogHold` is on the same fast path but is not a
stop - see the jog deadman below.)

These are issued **the moment their frame is parsed**, on a second
`linuxcnc.command()` channel that no ordinary command uses, never behind the
lock that serialises ordinary calls, never waiting for an ordinary command's
answer, and never gated. Measured with the fake controller: an E-STOP sent
while an MDI line hung unanswered was accepted and in the status frame at once;
the MDI reply came later, `unknown`.

| call | LinuxCNC | measured on the simulator (3 runs) |
|---|---|---|
| `emergencyStop` | `state(STATE_ESTOP)` | in a status frame 149-228 ms after the call; `RCS_DONE` reply at 365-395 ms. Raw LinuxCNC: 194-199 ms / 396-403 ms. Axis held still after an E-STOP mid-program. |
| `stopJob`, `reset` | `abort()` | reply 83-125 ms; axis held still |
| `pauseJob`, `feedHold` | `auto(AUTO_PAUSE)` during a program (accepted by effect); otherwise a jog stop | held still while paused |
| `jogStop`, `jogCancel` | `JOG_STOP` on every axis (teleop) or joint | reply ~72 ms; axis held still |
| `spindleOff` | `spindle(SPINDLE_OFF)` | not exercised |

Every stop call that ends motion disarms the jog deadman; `spindleOff` does
not (a jog running through it stays bounded). A jog stop that lands while its
`jogStart` still awaits LinuxCNC's answer is not undone: the start
does not re-arm the deadman behind it.

### The jog deadman: `jogHold`

`jogHold` means the operator is STILL holding the jog button
(`controller.ts`, `MachineController.jogHold`): it keeps the continuous jog
running and sends LinuxCNC nothing. It replies at once, `v: true` when it
pushed the deadman back, `v: false` when no continuous jog was armed. It is
never behind the ordinary-call lock: a keepalive queued behind a long call
would arrive late and stop a jog still held.

A continuous jog LinuxCNC took (accepted or unknown) arms a deadman of
`--jog-deadman` seconds (default 0.25, the UCCNC bridge's window; the panel
holds every 75 ms). Each hold pushes it back. When no hold arrives in the
window the gateway issues the jog stop itself, from its own task (not the
status ticker), and says so on the console: "The jog deadman fired - no
jogHold arrived for 250 ms, so the jog was stopped...". A frozen panel with
its socket still open cannot drive an axis into a limit. A hold that races
ahead of its own `jogStart` (the panel sends the first at once)
arms nothing; the start arms the deadman when LinuxCNC takes the jog.

Measured on the simulator (`tier2-attempt3.json`): held at 75 ms, X moved
3.96-3.98 mm in 0.8 s, still `jog`; holds stopped with the socket open ->
`idle` 257-262 ms later (four runs), then stationary, with the console line.

A stop that ends a job marks the job as stopping BEFORE it is issued. LinuxCNC
acknowledges an abort a task cycle or more later, and in that window the
machine is idle and still - which reads exactly like a finished program. One
Tier 2 run before that fix reported a Stop as `completed`
(`tier2-before-stop-fix.json`). A stop is never reported as a finished part.

## Pushes

`hello`, `phase`, `status`, `console`, `jobEvent`, `homed`, `alarm` - as
`BRIDGE-PROTOCOL.md`. No `vfd` push: LinuxCNC owns the spindle.

- `console`: every message on LinuxCNC's error channel, `severity` `error`
  (NML/operator errors) or `info` (text/display), whichever code path read it.
- `jobEvent`: `started`, `paused`, `resumed` when those calls are accepted.
  `completed` only after the interpreter is idle, the motion queue empty, in
  position, and the position unchanged across two consecutive polls. `failed`
  when LinuxCNC put an error on its channel during the run (the fault's
  `message` is that sentence and `line` is `current_line`) that no gateway
  call claimed. The channel is shared: a gateway command LinuxCNC refused
  (a jog refused because a program is running, a refused homing) claims
  exactly ONE sentence - the first error read in its own window, which is the
  refusal its reply carries, and which still reaches the console. Every other
  error read while the program runs, including one read in the same poll,
  is the program's and fails it. `stopped` for a
  stop call, an E-STOP or a hard limit during a run.
- `homed`: on the rising edge of every joint behind a letter. Measured: `Z`
  first, then `X` and `Y` together - `axis_mm`'s `HOME_SEQUENCE`.
- `alarm`: rising edge of E-STOP, a hard limit, a soft limit. `code` is null.
  `positionLost` is true only when LinuxCNC itself no longer reports every
  joint homed (it keeps homed bits across an E-STOP; measured).

## Status

`MachineStatus`, exactly, from `linuxcnc.stat`:

| field | source | notes |
|---|---|---|
| `state` | `alarm` in E-STOP, on a hard limit, or machine OFF; `hold` when paused or waiting at an M6 (WO-2100); `home` while any joint homes; `run` when the interpreter is busy; `jog` in manual when moving; else `idle` | **moving is `not inpos` OR velocity > 0**: `inpos` stayed TRUE through a teleop continuous jog on the simulator |
| `machinePos` | `actual_position`, mm | `linear_units` applied; A/B/C in degrees |
| `workPos` | `actual_position - g5x - tool`, rotated by `-rotation_xy`, `- g92` | Axis's DRO arithmetic |
| `feedMmMin` | `current_vel x 60`, mm | |
| `spindleRpm` | **`null`** | `stat` carries the COMMANDED speed only (it is in `linuxcnc.spindleCommanded`); a command wearing a measurement's name is a lie |
| `overrides` | `feedrate`, `rapidrate`, `spindle[0].override`, as percent | a real rapid override |
| `executingMoveId` | `null` | text controller; see `linuxcnc.motionLine` |
| `buffer` | `{moves: stat.queue, capacitySeconds: null}` | |
| `inputs.estop/hardLimit/softLimit` | `task_state`; each joint's own `stat.joint[j]` `min_hard_limit`/`max_hard_limit` (hard) and `min_soft_limit`/`max_soft_limit` (soft) flags | never `stat.limit`: its index is documented as an axis, and a joint-indexed read reported a gantry's (XYYZ) Z limit as Y (audit 16; `stat.joint[j]` measured on 2.9.4) |
| `inputs.limits`, `limitMinus`, `limitPlus` | per axis, from every joint behind it | |
| `inputs.probe` | `probe_val` | the probe PIN |
| `inputs.door` | `null` | no such input in `stat` |
| `inputs.hold` | `stat.paused` | |
| `inputs.home` | absent | `stat` has no home-switch input; absent means "not reported" |
| `homed` | per letter, every joint behind it | |
| `spindle` | `null` | no VFD link |

Plus two bridge fields (`positionKnowledge`, `homingCycle`) and one
LinuxCNC block, `linuxcnc`: `taskState`, `taskMode`, `interpState`,
`execState`, `motionLine`, `currentLine`, `readLine`, `file`, `wcsIndex`,
`wcsRotation`, `spindleCommanded {speed, direction, enabled}`, and `joints[]` (`joint`,
`axis`, `homed`, `homing`, `position`, `ferror`, `fault`) - the optional joint
read ADR-0054 item 4 adopts.

`linuxcnc.wcsRotation` (WO-2185) is every work system's XY rotation, degrees,
keyed `G54` .. `G59.3`: the ACTIVE system's is `stat.rotation_xy`, this tick;
each other one is the newer of LinuxCNC's parameter file (the INI's
`[RS274NGC] PARAMETER_FILE`, `#5230 + 20 x (P - 1)`) and the value LinuxCNC
last read back to this gateway on `setWorkOffset` with `r`; `null` when neither is
known. So a rotation LinuxCNC restored from its parameter file at startup is
reported on the first status after Connect. A `G10 L2 P<n> R` run outside
`setWorkOffset` on a system that is NOT active shows once LinuxCNC next
writes its parameter file (below).

Cadence is `BRIDGE-PROTOCOL.md`'s: on change and at least every 100 ms, or
every 500 ms only while confidently idle (status read succeeded, idle, no job,
no E-STOP or limit). A failed status read never slows the cadence.

## Measured LinuxCNC facts (simulator, 2.9.4)

1. **Program line numbers** (the research doc's open question). One 9-line
   file with a 1 s `G4` on line 6, sampled at ~50 Hz (`lineSamples`):
   `read_line` jumps to 9 at once (the interpreter reads ahead through the
   file); `current_line` runs ahead of motion (5 while lines 3-5 moved, then
   8); `motion_line` walked 3, 4, 5, 7, 8 - it names the line whose MOTION is
   executing, **held 5 through the dwell** (a dwell has no motion) and never
   showed 6. So `motion_line` is a usable "executing now" for motion lines,
   in file-line terms, with no `N` words needed; it is not a step counter.
2. Run/pause/resume never read `RCS_DONE` while a program runs.
3. A home in teleop mode reads `RCS_DONE` and does nothing.
4. `inpos` is true during a teleop continuous jog.
5. The stock `axis_mm` config shares one simulated home switch between X and Z
   (`HOME_IS_SHARED`, `simulated_home.hal`); a joint left on the switch side
   makes LinuxCNC refuse to home the others - the same shape as the
   2026-08-23 made-switch incident. The gateway reports LinuxCNC's sentence.
   `sim_reset.py` puts the SIMULATOR back where it boots before each Tier 2
   run; it is a test fixture and must never run against a machine.
6. E-STOP: status within one-two task cycles, `RCS_DONE` ~400 ms (task cycle
   100 ms in the stock sim; a real config usually runs 10 ms). Homed bits
   survive an E-STOP.
7. **The parameter file is NOT written by a G10** (WO-2185,
   `src/tests/evidence/WO-2185/var-raw.txt`, `var-raw-2.txt`): eight MDI G10
   L2 R lines left the file untouched for 3 s each; LinuxCNC wrote the whole
   file on its next mode command (even to the mode it was in), abort or
   interpreter reset. A `reset_interpreter` right after `G10 L2 P2 R4` wrote
   the file with the OLD `#5250` (3) - so LinuxCNC's value and its file can
   differ until a mode change. LinuxCNC restores `#5230..` from the file at
   startup (research, `rs274` on a copy of the file).

**Measured (WO-2099):** LinuxCNC's error channel is one NML queue, and a GUI
(Axis) running beside the gateway DOES read messages first: the G38.2 miss
sentence reached the gateway once in five misses. Nothing the gateway decides
may rest on an error-channel sentence arriving; probing reads
`probe_tripped` instead.

**Open, seen once (2026-09-26):** after about ten Tier 2 runs in a day the
simulator's NML went dead - `stat.poll()` read all zeros (`task_state 0`,
`echo_serial_number 0`), a command never answered, HAL still ran - and
`sim_reset.py` timed out. `tools/lcnc-sim/spark-stop.sh` + `spark-start.sh`
brought it back and the next runs passed. The cause is not known; the gateway
talks to LinuxCNC only through its Python module, as Axis does.

## Running it

On the LinuxCNC PC, with LinuxCNC running:

```sh
python3 pendant/linuxcnc-gateway/gateway.py            # ws://127.0.0.1:8327/
python3 pendant/linuxcnc-gateway/gateway.py --host 0.0.0.0   # LienCAM on another PC
python3 pendant/linuxcnc-gateway/gateway.py --port 8330 --program-dir ~/liencam-programs
```

It prints one JSON line when it is listening (`{"listening": 8327, ...}`).

Tier 2, from the dev box (needs the WO-1982 simulator running on the Spark):

```powershell
$env:LIENCAM_LCNC_TIER2 = '1'   # opt-in (WO-2610): without it the gateway's Tier 2 skips; set but unreachable FAILS
npx vitest run src/tests/tools/lcncGateway.wo1986.test.ts
npx vitest run src/tests/evidence/WO-2099/tier2.wo2099.test.ts   # probing
npx vitest run src/tests/evidence/WO-2100/tier2.wo2100.test.ts   # tool change (M6)
npx vitest run src/tests/evidence/WO-2101/tier2.wo2101.test.ts   # across the LAN
```

The probing Tier 2 drives the simulator's probe input with `sim_part.py`
(SIMULATOR ONLY: a userspace HAL component modelling a part) and leaves the
simulator as it boots - G54 zero, the probe input on no signal.

## Licence

`gateway.py` imports LinuxCNC (GPL-2-or-later) and is GPL-3.0-or-later, like
LienCAM. Ideas from lcnc-suite's gateway (GPL-3.0, bildobodo/lcnc-suite); no
code was copied from it.
