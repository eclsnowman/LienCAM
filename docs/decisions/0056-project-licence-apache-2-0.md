# 0056 - Project licence: Apache-2.0, with the Adaptive2d engine a marked LGPL module

Date: 2026-10-01
Status: Accepted 2026-10-01 (the operator's decision; supersedes ADR-0032)
Supersedes: ADR-0032 (project license GPL-3.0-or-later)
Related: `docs/launch/LAUNCH_PLAN.md` section 2.6 (Option B), WO-2335
Authority: Operator ruling 2026-10-01 7:49 PM CT, two cards:
- Q-LAUNCH-PLAN-READY-WHICH-LICENCE: "Apache-2.0, engine stays a marked LGPL module (recommended)"
- Q-LAUNCH-COPYRIGHT-LINE: "Copyright (c) 2026 Eric Lien and LienCAM contributors (recommended)"

## Context

ADR-0032 (2026-07-02) made the whole project GPL-3.0-or-later. Its main reason
was that forks must stay open: anyone who distributes a modified LienCAM has
to publish their changes under the same licence.

For the public release the operator wants a very permissive licence. The launch-plan
audit (LAUNCH_PLAN 2.6) found that the whole tree cannot simply be relabelled:

- `src/lib/cam/adaptiveClearing2d/engine/` is a port of FreeCAD's Adaptive2d
  (LGPL-2.1-or-later, Copyright (c) 2018 Kresimir Tusek). A port is a
  derivative; LienCAM cannot relicense it.
- `pendant/linuxcnc-gateway/gateway.py` imports LinuxCNC's GPL Python module.
  It is already a separate program behind a socket.

LienCAM's own code has one copyright holder today and no outside contributors,
so it can be relicensed now. After the first outside contribution that would
need every contributor's consent, which is why this is decided before the
first public commit.

## Decision

LienCAM's own code is licensed **Apache-2.0**. Two folders are exceptions:

1. `src/lib/cam/adaptiveClearing2d/engine/` stays **LGPL-2.1-or-later**, as a
   clearly marked module. The folder has its own `LICENSE` (the LGPL-2.1 text)
   and `README.md`. Every ported file keeps its SPDX header and the upstream
   copyright. Changes to those files stay under the LGPL. Files in the folder
   that LienCAM wrote itself (no SPDX header) are Apache-2.0 like the rest of
   LienCAM; the folder README names them.
2. `pendant/linuxcnc-gateway/` stays **GPL-3.0-or-later** as a separate
   program, because `gateway.py` imports LinuxCNC's GPL Python module. The
   folder has its own `LICENSE` and says so in its README.

Copyright line, in the root `NOTICE`:
"Copyright (c) 2026 Eric Lien and LienCAM contributors".

Implementation (WO-2335):

- `/LICENSE` - the full Apache-2.0 text from apache.org.
- `/NOTICE` - the copyright line and a pointer to the two folder exceptions.
- `package.json` - `"license": "Apache-2.0"` (`"private": true` stays).
- `README.md` - a Licence section in plain words naming both exceptions.
- No per-file licence headers across `src/`: Apache-2.0 does not require them,
  and touching every file would collide with every lane (architect,
  2026-10-01 8:45 PM CT).

## What is deliberately given up

ADR-0032's reason for the GPL - **forks must stay open** - is given up on
purpose. Under Apache-2.0 anyone may take LienCAM's own code into a closed,
proprietary product without publishing their changes. Only the engine folder
keeps a copyleft: changes to those LGPL files must stay open.

## Alternatives considered

From LAUNCH_PLAN 2.6:

- **A. Stay GPL-3.0-or-later** - no change; not the permissive licence the operator wants.
- **C. Clean-room rewrite of the adaptive engine** - fully permissive, but a
  rewrite of about 11,000 lines that feed four other features; not before the
  alpha.
- **D. Ask the FreeCAD authors for permission** - may run alongside this
  decision; if granted, the engine folder exception could go.
- **MIT instead of Apache-2.0** - shorter and well known, but no patent
  licence. Apache-2.0 carries an explicit patent licence from every
  contributor and matches the PureCutCNC code we already adapted.

## Consequences

- Inbound contributions are accepted under Apache-2.0 (inbound = outbound),
  except changes to the engine folder (LGPL-2.1-or-later) and the LinuxCNC
  gateway (GPL-3.0-or-later).
- New files in the engine folder: a port of Adaptive2d code gets the LGPL SPDX
  header and the upstream copyright; a LienCAM-original file gets no header
  and is added by name to the folder README.
- The engine ported files keep their LGPL marking forever; do not strip or
  "upgrade" their headers.
- Left to their own orders (LAUNCH_PLAN 2.6): the engine built as its own
  chunk, OpenCAMLib WASM as its own file, GRBL message strings in our own
  words (WO-2336), DCO/CONTRIBUTING text.
- Legal questions L1-L8 of LAUNCH_PLAN 2.6 are flagged there, not decided here.

## References

- `/LICENSE`, `/NOTICE`, `README.md` Licence section
- `src/lib/cam/adaptiveClearing2d/engine/LICENSE` and `README.md`
- `pendant/linuxcnc-gateway/LICENSE` and `README.md`
- `src/tests/evidence/WO-2335/history.md` - the git-history check on the
  engine folder's header-less files
- ADR-0032 (superseded)
