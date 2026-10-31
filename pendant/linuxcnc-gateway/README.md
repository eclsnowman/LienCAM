# LienCAM LinuxCNC gateway

A small process that runs **on the LinuxCNC PC**. It talks to LinuxCNC through
LinuxCNC's own Python module (the NML channels Axis uses) and to LienCAM over a
WebSocket, speaking the same bridge protocol as the UC100 bridge - loopback by
default, the network with `--host 0.0.0.0` so LienCAM can run on another PC
(WO-2101; type this PC's address on Machine > Definition > Controller).

The contract, what was measured and what is still open:
[`docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md`](../../docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md).

Verified against real LinuxCNC 2.9.4 **in simulation only** (WO-1986, the
WO-1982 simulator). Not yet verified on LinuxCNC hardware. LienCAM's LinuxCNC
controller drives it (Control tab, connection "LinuxCNC gateway").

Licence: this folder is a separate program licensed **GPL-3.0-or-later**
(see [`LICENSE`](LICENSE)), not Apache-2.0 like the rest of LienCAM, because
`gateway.py` imports LinuxCNC's GPL Python module (ADR-0056).

## Run

```sh
python3 gateway.py                  # ws://127.0.0.1:8327/, programs in ~/liencam-programs
python3 gateway.py --host 0.0.0.0   # LienCAM on another PC reaches this one
python3 gateway.py --help
```

Python 3.9+ standard library only - the python3 that ships with LinuxCNC.
LinuxCNC must already be running.

Step-by-step setup, in plain words, is in LienCAM's Help: open Help and read
"Connecting to LinuxCNC".

## Files

| file | what |
|---|---|
| `gateway.py` | the gateway |
| `sim_drive.py` | Tier 2 drive: starts the gateway and exercises it against a running LinuxCNC, printing measurements |
| `sim_reset.py` | SIMULATOR-ONLY fixture: backs the stock sim off its shared home switch so it can home. Never run it against a machine. |
| `sim_probe.py` | SIMULATOR-ONLY fixture (WO-2099): a HAL window comparator that trips `motion.probe-input` past one position on one axis. Never on a machine. |
| `sim_part.py` | SIMULATOR-ONLY fixture (WO-2099): a userspace HAL component that trips `motion.probe-input` where a modelled part (block, bores, pockets, bosses, tool setter) is. Never on a machine. |
| `testing/halcmd.py` | a FAKE `halcmd` for the unit tests (`--halcmd testing/halcmd.py`); lines copied from the simulator's own `halcmd -s show pin/sig`; WO-2100: iocontrol's tool pins and `setp`, shared with the fake `linuxcnc` through `FAKE_HAL_DIR` |
| `testing/linuxcnc.py` | a FAKE `linuxcnc` module for the unit tests, modelled on measured simulator behaviour. Never on a machine's `PYTHONPATH`. |

Tests: `npx vitest run src/tests/tools/lcncGateway.wo1986.test.ts` (the Tier 2
case runs when the WO-1982 simulator is reachable and says so when it is not).

## Machine facts in the hello (WO-2097)

Each session's hello carries `config`: every axis' `[AXIS_<L>]` `MIN_LIMIT`,
`MAX_LIMIT` and `MAX_VELOCITY`, each spindle's `[SPINDLE_<n>]` RPM range, as the
INI writes them (strings, the INI's own units; `null` when the INI does not set
a key), and the running HAL's links for the standard probe, E-STOP chain,
coolant and spindle pins, read with `halcmd -s show pin` / `show sig` (read-only;
`--halcmd` names another halcmd). When halcmd cannot read the HAL, `config.io`
says why and the INI facts are still sent. LienCAM shows them on Machine >
Definition > Controller.

## Tool change (WO-2100)

LinuxCNC's own M6 holds the program until iocontrol's `tool-changed` rises.
While it waits, the gateway reports a `hold` with `linuxcnc.toolChange` (the
tool, the M6's line) and says on the console which tool to fit; Cycle Start
(`resumeJob`) answers it by setting the pin LinuxCNC's config already uses for
that - hal_manualtoolchange's `change_button` on an Axis config - with
`halcmd setp`, and releasing it once the change is taken. That `setp` is the
only HAL write the gateway makes. Details and measurements:
[`LINUXCNC-GATEWAY-PROTOCOL.md`](../../docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md),
"Tool change". Tests: `src/tests/machine/linuxcncToolChange.wo2100.test.ts`
(fakes) and `src/tests/evidence/WO-2100/tier2.wo2100.test.ts` (simulator).

## Work-system rotation (WO-2185)

`setWorkOffset {wcs, r}` rotates a work system with LinuxCNC's own
`G10 L2 P<n> R<degrees>` (X Y Z untouched; `0` clears it) and answers with
LinuxCNC's readback. Status `linuxcnc.wcsRotation` reports every system's
rotation - the active one from `stat.rotation_xy`, the others from LinuxCNC's
parameter file or the last readback, whichever is newer. Tests:
`src/tests/machine/linuxcncWcsRotation.wo2185.test.ts` (fakes) and
`src/tests/evidence/WO-2185/tier2.wo2185.test.ts` (simulator).
