# 0032 — Project license: GPL-3.0-or-later

Date: 2026-07-02
Status: Superseded by ADR-0056 (2026-10-01: LienCAM's own code is Apache-2.0; the Adaptive2d engine folder stays LGPL-2.1-or-later)

## Context

The project had no license file, which legally means "all rights reserved" —
nobody could use, modify, or redistribute it. The stated vision includes a
public open-source release, so a license decision was required, driven by
these goals:

- Be a usable base for future builders: hobbyists and shops should be able
  to take the software, run it, adapt it, and build on it without asking.
- Strong copyleft protection: derivatives and forks must stay open. A
  permissive license would allow a proprietary fork to close off
  improvements.
- Patent protection: GPLv3's explicit patent-license and anti-tivoization
  clauses protect users in ways GPLv2-family licenses do not.
- Compatibility with what is already in the tree: the adaptive-clearing
  engine (`src/lib/cam/adaptiveClearing2d/engine/`) is a TypeScript port of
  FreeCAD's Adaptive2d, which is LGPL-2.1-or-later (Copyright (c) 2018
  Kresimir Tusek). Ported code is a derivative work of the original, so the
  project license must be able to receive LGPL-2.1-or-later code. That
  legally rules out MIT, Apache-2.0, and MPL-2.0 as the project license:
  none of them can absorb copyleft code. LGPL-2.1-or-later code combines
  cleanly into a GPL-3.0-or-later work (the "or later" upgrade path).

Runtime dependencies were audited and are all compatible: planegcs
(LGPL-2.1, dynamically loaded WASM), OCCT/opencascade.js (LGPL-2.1 with the
Open CASCADE exception, vendored custom WASM), clipper2-wasm (BSL-1.0),
three/react/react-dom/zustand/fflate (MIT), lucide-react (ISC), SVGnest
port (MIT), M PLUS Rounded 1c (OFL-1.1), Hershey fonts (public domain).

## Decision

The project is licensed **GPL-3.0-or-later**, chosen by the operator on 2026-07-02.

Implementation, all in-tree:

- `/LICENSE` — verbatim official GPL-3.0 text from gnu.org.
- `package.json` — `"license": "GPL-3.0-or-later"` (`"private": true` stays;
  it only prevents accidental npm publishing, it does not conflict).
- `/THIRD-PARTY-NOTICES.md` — one section per third-party component:
  license, obligations, and where the text lives (BSL-1.0 text inlined for
  clipper2-wasm, which ships none in its npm package).
- SPDX headers on every file in `src/lib/cam/adaptiveClearing2d/engine/`
  marking them `LGPL-2.1-or-later` with the upstream copyright, and noting
  the project-as-a-whole license.
- `docs/reference/FreeCAD_Mod_Adaptive_Path-master/PROVENANCE.md` — records
  that the vendored reference copy of the upstream add-on ships no license
  file but the same code in FreeCAD is LGPL-2.1-or-later; reference only,
  excluded from binary distributions.
- `README.md` — a License section in plain English.

## Alternatives considered

- **AGPL-3.0-or-later** — the recommended stronger alternative. Closes the
  "SaaS loophole": someone hosting a modified version as a web service must
  publish their changes, which is pointed for a browser-based app. the operator
  chose plain GPL; hosting-without-sharing is accepted as permitted.
- **MIT / Apache-2.0** — maximally permissive, but no copyleft (proprietary
  forks possible) and legally unavailable anyway: the LGPL-2.1-or-later
  Adaptive2d port cannot be relicensed permissively.
- **MPL-2.0** — file-level copyleft middle ground; same incompatibility
  problem (LGPL code cannot be relicensed under MPL), and weaker protection
  than desired.
- **GPL-2.0-or-later / LGPL** — weaker patent protection than GPLv3; LGPL's
  library exception is not wanted for the application as a whole.

## Consequences

- Anyone may use, modify, and redistribute the software, commercially or
  not; distributed derivatives must remain GPL-3.0-or-later.
- LICENSE, THIRD-PARTY-NOTICES.md, and SPDX obligations are now part of the
  tree and must be maintained: new dependencies get a notices entry; new
  files in the engine port get the LGPL SPDX header.
- All contributions are accepted inbound under GPL-3.0-or-later
  (inbound = outbound).
- The engine port files stay LGPL-2.1-or-later-marked forever; do not strip
  or "upgrade" their headers. The combined work is GPL-3.0-or-later.
- Hosting a modified copy as a service without publishing changes is
  permitted (GPL, not AGPL). Revisiting that choice would require
  relicensing by all copyright holders.

## References

- `/LICENSE`, `/THIRD-PARTY-NOTICES.md`, `README.md` License section
- `src/lib/cam/adaptiveClearing2d/engine/` SPDX headers
- `docs/reference/FreeCAD_Mod_Adaptive_Path-master/PROVENANCE.md`
- ADR-0014 (OCCT kernel), ADR-0016 (planegcs sketch mode), ADR-0018 (B-rep
  model kernel) — the license posture of those dependencies informed this
  decision.
