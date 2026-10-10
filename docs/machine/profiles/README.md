# Shared machine + shop data

**Why this directory exists (Operator ruling 2026-09-07):** *"the machine definition that
you build here should likely be pushed back to the project for it to have on
Main. that way we don't have divergence in the definitions of the machines,
tools, macros, etc. between you and it."*

The dev box and the machine seat must not drift apart on machines, tools, macros
or holders. Anything here is the shared copy; if you change one of these at the
machine, export it and land it here.

| file | what it is | how to load it |
|---|---|---|
| `LienCNCV2.pro` | the operator's UCCNC profile. **READ-ONLY** - ADR-0044. A one-time seed, never written by us. | Machine Library -> Import |

**Two profile values are known seeds, not the intended state.** The `.pro`
declares acceleration 500 and segment unification 2/1; the board holds 1000
(the operator's choice) and 100/100 (intended - WO-1320, measured 2026-09-10: the board
tracks a 90-degree corner intact at 100/100 and the path check reads 0.021 mm
worst against 0.090 mm). The bridge writes neither. Do not file "the profile
says X and we send nothing" as a defect for either value.
| `tool_library.json` | The 5 test tools, exported 2026-09-07 from `Example Projects/Full Suite.camproject` | Tool Library -> Import |

## tool_library.json

Internal export format: a JSON array of tools, each carrying an embedded
`holder` object when it links to one. The importer re-mints every id and assigns
its own library, so `id` and `libraryId` here are informational.

    6mm Flat End Mill                                  flat_end_mill   6.00
    6mm Ball End Mill                                  ball_end_mill   6.00
    Test Long Tool                                     flat_end_mill   9.52
    4mm drill                                          drill           4.00
    Rennie 1/8" (.1250") Single Flute DLC Carbide      flat_end_mill   3.10

**Note the 9.52 mm "Test Long Tool"** - that is the cutter the adaptive
engagement corpus is built around (the 10 mm ring leaves it a 0.43 mm corridor),
so it is the one to reach for when reproducing an engagement refusal.

Importing this is currently also the WORKAROUND for **WO-1261**: a new tool
cannot be saved from the editor, so on a fresh install Import is the only way to
get tools into the library and therefore the only way to create any operation.
When WO-1261 lands that stops being load-bearing, but the file stays - it is the
shared test set.

## LienCNCV2.definition.json - the definition the machine ACTUALLY runs

Added 2026-09-07 by the machine seat, on the operator's instruction: "the machine
definition that you build here should likely be pushed back to the project for
it to have on Main. that way we don't have divergence in the definitions of the
machines, tools, macros, etc. between you and it."

This is the bridge's own cached definition, copied verbatim from
`pendant/uccnc-bridge/bin/liencam-bridge.definition.json` after it was applied
to board 1 and verified by readback.

**It is not the same as `LienCNCV2.pro`, and that is the point.** The `.pro`
seeded this record once and is read-only to us (ADR-0044). Every edit since
lives here. Concretely, today:

    acceleration  X/Y/Z/A = 1000     LienCNCV2.pro says 500

the operator runs 1000; his profile has said 500 for as long as anyone has looked. Each
of those four keys carries `provenance.axes.<A>.acceleration = liencam-ui`
naming his definition editor, which is what makes WO-1048 KEEP them at the next
bridge start rather than refusing them back to the profile's value. Proved on
2026-09-07 across a real restart:

    Bridge start-up check: 4 cached settings differ from the profile
                           - 4 kept, 0 sent back to the profile's value.
    [bridge] KEPT axes.X.acceleration: cache 1000, profile 500
             - the operator set it (liencam-ui: ...)
    [bridge] axis X applied and read back: ... acceleration=1000 ...

Earlier the same day, before the edit had operator provenance, the same check
read "7 cached settings differ - 1 kept, 6 sent back" and pushed every
acceleration down to 500.

So: read this file, not the `.pro`, when you want to know what the machine is
set to. Anything that reports the `.pro` as what the machine "is running" is
wrong - see WO-1262.

## LienCNCV2.machine.json - the app's machine record (2026-09-27)

**Exported 2026-09-27 10:33 AM CT by the machine seat (the machine PC)** from the LienCAM app at pin
ed347e510 (bridge MD5 7564DDEC), the exact build that passed the 2026-09-26 session. It is the app's
library machine "LienCNC V2" (id liencnc-v2), serialized as Machine Library > Export selected writes it,
read from the app's saved user state (OPFS generation muijnem3). Holds: setter 738/724.5/120, tool change
macro 730/50/120, parks 1-4, probing overrides pad 3.16 / max travel 100, acceleration 1000 x4, soft
limits 738/724.5/129.1, Huanyang GT link COM3/19200, tool table (reference T19 48.2925, T1 48.2875).
Load it with Machine Library > Import. **Rehearsals use this file** (Operator ruling 2026-09-27: simulations run
on the definition the machine actually runs).

Kept separate from `LienCNCV2.definition.json` (the BRIDGE cache, a different format that
`boardSpindleBridge.wo1724.test.ts` and `pendant/uccnc-bridge/smoke.mjs` read). `tool_library.json` was
replaced by the same export (all 12 app tools). `LienCNCV2.pro` was NOT replaced: the machine's copy
differs only in run counters and `UCdevicetype Demo_AXBB` (UCCNC last opened in demo mode, not our write).
Not yet in this directory: Safe Z 120 and the park XYs also held in the app's localStorage
`liencam-machine-actions` (WO-1670's second store).

`LienCNCV2.machine-actions.json` (2026-09-27, machine seat): localStorage `liencam-machine-actions` from
the machine PC verbatim - liencnc-v2 parks 738/724.5, 738/50, 50/50, 50/724.5 and safeZMachine 120 (WO-1670's
second store; not in the machine export). The legacy `liencam-tool-table` store is not exported: since
WO-1676 nothing writes it and probing reads the machine record's `probeOverrides` (pad 3.16 / travel 100).
