# The spindle link (Modbus VFD)

## Nothing here has touched a real inverter

Read that first. `Vfd.cs` has never exchanged a single frame with a Huanyang GT
or with anything else. The definition that ships (`src/lib/machine/vfd/huanyangGt.ts`)
was transcribed from two files that **are** working on the operator's machine - the
`[ModbusMaster]` section of `LienCNC.pro` and the UCCNC macro `M20002.txt` - but
transcribing a working configuration is not the same as having talked to the
hardware with this code. The definition therefore says `verified: false`, and
that flag is not decoration: **it refuses spindle-on.**

There is no demo mode for a VFD. Motion could be proved with nothing plugged in
(`--board -19`); this cannot. Framing and CRC-16 can be proved on the bench -
and are; the conversation cannot be proved anywhere but at the machine.

## Why the spindle is not a controller output on this machine

`UC100.dll` has no Modbus functions at all. UCCNC's Modbus is a PC-side plugin
driving a serial port, and it was never part of the motion API. So the spindle
is a **second, independent link** that LienCAM owns outright: its own serial
port, its own thread, its own watchdog. Background, register map and risks:
`docs/research/uccnc-control-plan.md` sections 10 and 11.

## What is here, and what is deliberately not

| | |
| --- | --- |
| `Vfd.cs` | the Modbus RTU master: CRC-16, function `0x03` (read holding registers) and `0x06` (write single register), a poll loop on its own thread, and the watchdog |
| `src/lib/machine/vfd/` | the declarative definition format, the scale expressions, the command table, the fault rule and the safety gates |

**`Vfd.cs` does no arithmetic that varies between inverters.** Scale
expressions, command tables, status decoding and fault rules all live in the
definition on the LienCAM side, which compiles them down to the plain integers
of `VfdPlan` and decodes the raw words the bridge reports back. There is exactly
one expression evaluator in the product (`src/lib/machine/probeRoutineExpr.ts`,
an AST walk with no `eval`), and it is not in C#. A second one would be a second
thing to get wrong about a spindle that turns at 24,000 RPM.

**Wired in, WO-427, still disabled by default.** `Bridge.cs` opens the link only
when it is started with `--vfd <definition.json>`; absent the flag no serial
port for the spindle is ever opened. `Vfd.cs` was already on the `csc` line
before this landed:

```powershell
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /unsafe /platform:x64 `
    /target:exe /out:.\bin\liencam-bridge.exe Bridge.cs Machine.cs Json.cs Vfd.cs UC100_wrapper.cs
```

`huanyang-gt.definition.json` in this folder is a JSON transcription of
`src/lib/machine/vfd/huanyangGt.ts` - the SAME definition, not a second one -
kept here so the bridge has something to load for its own testing without
needing the TypeScript build:

```powershell
.\bin\liencam-bridge.exe --board -19 --vfd vfd\huanyang-gt.definition.json
```

The wire protocol (`hello.vfd`, the `vfd` push, `spindleOn` / `spindleOff` /
`spindleResetFault`) is documented in `docs/machine/BRIDGE-PROTOCOL.md`. It is
still just wiring: `spindleOn` is refused by `verified: false`, which is every
definition that exists, so nothing here can spin a spindle yet either.

**Serial only.** The definition format carries a TCP transport (the operator's macro
documents a USR-DR302 serial-to-Ethernet adapter as the alternative), and the
master here does not implement it. A TCP plan is refused with a plain sentence
rather than half-worked.

## Safety, in the code and not only here

1. **Nothing blocks a stop.** `VfdLink.Stop()` takes no gate, checks no flag,
   and is the only method that still runs when the link is already failing. The
   TypeScript half says the same thing in `vfdStopIsAllowed()`, a function that
   takes no arguments because there is no state that could make the answer no.
2. **The spindle stops when the inverter goes silent** past `LinkQuietStopMs`
   (1,000 ms), when the client heartbeat goes quiet, on `Close()`, or when the
   process exits. `Close()` stops the spindle *first*, then joins the thread,
   then writes one more stop before the port shuts - the last thing that happens
   on a live port is a stop.

   *Silent*, not *failing*. This line said "transactions failing past the
   definition's retry count" until WO-1278, and that is a different rule: a poll
   pass with three good replies and one blip counted as a failure, so two
   adjacent blips stopped a running spindle. Single blips are ordinary - the
   WO-1313 capture of a healthy 175 s cut at 5,000 RPM carries four of them and
   one checksum failure. The threshold did not move to fix that; the quantity
   did, and a genuinely dead link now stops the spindle in ~1.2 s where the old
   end-of-pass-only check took ~2.4 s.
3. **`verified: false` gates spindle-ON only.** Never a stop, never the fault
   reset. The no-gate-may-block-a-stop rule of this series applies here too.
4. **The link ships disabled.** `VFD_LINK_DEFAULT_ENABLED` is `false` and
   `VfdPlan.SpindleOnAllowed` is `false`, exactly like the bridge's read-only
   motion gate. It has to be switched on deliberately.
5. **The inverter's own alarm stays.** the operator's `PC.05 = 0` makes the inverter
   raise its own communication-loss alarm. That is the layer *below* this one.
   Our watchdog stands beside it and never replaces it, and the verification
   flow proves the inverter's layer trips before ours is relied on.

## COM3 is exclusive

One process owns the port. UCCNC must not be running - which is already true,
because one process owns the motion controller too - and neither may the
dev-time UCCNC oracle in section 5 of the plan.

## The verification flow (plan section 11.4)

This is what changes `verified` to `true`, and it is the real safety design.
Nobody may skip a step because an earlier one looked fine.

1. **The motor is uncoupled, or the tool is out of the collet.** Confirmed by a
   person, out loud, before anything is written.
2. **Prove the stop before run is ever offered.** Write the stop value; confirm
   the inverter reports stopped.
3. **Prove the fault path.** Trip a fault, see it reported, clear it with the
   reset sequence (write `7`, wait 2 s, write `0`), see it clear.
4. **Prove the scaling rather than assuming it.** Run at two or three speeds and
   confirm actual RPM readback tracks the setpoint. the operator's `RPM / 2.4` is his own
   measured calibration, not a datasheet formula, so it is exactly the kind of
   number that must be re-proved on any other machine.
5. **Prove the comms-loss behaviour** - **by simulation, not by pulling
   anything.** Operator ruling 2026-09-10: the VFD and its link are fine, UCCNC's modbus
   master never complains about them, any timeout is our own stringency, and the
   modbus link is not to be disturbed. No cable pull and no power cycle. This
   step used to read "pull the link", which is the same instruction he had
   already declined for the dongle; it is now `WatchdogControls.cs`, which makes
   the inverter go silent, answer with broken checksums, or lose one transaction
   per pass, and asserts what the spindle does in each case. The inverter's own
   `PC.05 = 0` alarm is proved by the inverter, at its own layer, and is not
   ours to trigger.

Only after all five does a definition earn `verified: true`, and only for the
inverter it was proved against.

## What the bench has proved so far

- CRC-16 (poly `0xA001`, seed `0xFFFF`, low byte first) against the canonical
  Modbus vector: `01 03 00 00 00 01` -> `84 0A`. Also `01 06 20 00 0F A0` ->
  `87 82` (write 24,000 RPM as 10,000 counts to `0x2000`) and
  `01 03 30 03 00 05` -> `7A C9` (the five-word status block).
- `Vfd.cs` compiles clean at `/langversion:5 /warn:4` with the in-box csc.
- The whole TypeScript half: `src/tests/machine/vfdDefinition.wo425.test.ts`.
- **The watchdog's timing, both directions** (WO-1278). `WatchdogControls.cs`
  runs the real `VfdLink` - real poll loop, real framing, real CRC, real
  watchdog - against a simulated Huanyang GT on the other end of `IVfdPort`,
  using this folder's real definition, at the operator's real numbers with nothing
  scaled down. Three adjacent 297 ms blips do not stop a healthy spindle
  (longest real silence 600 ms, inside the 1,000 ms budget); an inverter that
  genuinely goes silent has its spindle stopped, the stop reaching the wire at
  1,230 ms; a link answering only broken checksums is stopped at 1,010 ms; and
  a stop landing mid-pass is not written back over by the pass it landed in.
  `src/tests/evidence/WO-1278/watchdog-before-after.mjs` reverts the fix in a
  temporary copy and refuses to pass unless those controls go red without it.

None of that is a conversation with an inverter. `IVfdPort` does not change
that and is not meant to: it is where a simulated failure is injected, and the
only implementation the bridge ever builds is the real serial port.
