# 0057 - Your data always leaves with you: everything exports in an open, standard format

Date: 2026-10-02
Status: Accepted 2026-10-02 (the operator's ruling; binding on every work order)
Related: ADR-0040 (no legacy before 1.0), ADR-0056 (Apache-2.0 licence)
Authority: Operator ruling 2026-10-02 ~8:20 AM CT, chat, word for word:

> I see you say we cannot export our sketches as DXF. I feel exporting our files to avoid any user lock-in is
> critical. Anything we create needs to be portable back out. That is not just a nice to have, it is a requirement in
> my opinion. Models, Sketches, Macros, Machine Definitions, Post Processors, Gcode, User Profiles and
> configurations, Projects, and any usable deliverable from the project needs to be exportable in an industry
> standard format (like step, stl, dxf, dwg, svg, json, etc). No user will ever have their data locked behind
> proprietary formats. We may use formats inside the software that are most compatible with our software stack. But
> portability out of the software is a commitment we need to make to ourselves and out users. It needs to be part of
> the ethos of the project, and called out proudly as a commitment to our users. The software is open by design,
> through and through.

## Context

LienCAM stores its work in formats that suit its own stack (the project file, browser storage, the geometry kernel's
own records). That is fine inside the program. The question this record settles is the way OUT: on 2026-10-02 the
roadmap draft listed "sketch export as DXF" as a small, later item, and the operator ruled that a missing export is never a
nice-to-have.

## Decision

1. **Everything a user makes or configures can be exported from the app's own UI in an open, industry-standard
   format.** At least: models and bodies (STEP, plus STL/3MF for meshes), sketches (DXF and SVG), Form bodies and
   reliefs (STEP or STL), toolpaths and programs (G-code), setup sheets (PDF), tool library, machine definitions,
   post-processor configurations, macros, probing routines, work offsets, user settings and profiles (JSON with a
   published schema, or CSV where people expect a spreadsheet), and the project itself (a documented, open format).
2. **Inside, we use what works best for our stack.** Internal formats may be our own; the way out may not be ours
   only. An export in our own undocumented format does not count; a JSON export counts when its schema is published
   in the repository.
3. **Every new kind of user data ships with its export.** A work order that adds something a user creates or
   configures includes its standard-format export, or names the order that adds it, filed at the same time.
   An audit or a roadmap never files a missing export as "later" or "nice to have": it is a gap, and gaps get orders.
4. **We say it proudly.** The README, the site and the About page carry an "Open by design" commitment: your data is
   yours, and every part of it leaves with you in a format other software can read.

## Public wording

Approved by Operator ruling 2026-10-02 (card Q-OPEN-BY-DESIGN-YOUR-WORDS-FOR-RE: "Use it as written"). The paragraph, word for word:

> Open by design. Everything you make in LienCAM is yours, and it leaves with you. Models export as STEP and STL, sketches as DXF and SVG, programs as plain G-code, and your tools, machines, post-processors, macros, settings and projects as documented JSON. Inside, LienCAM uses whatever formats work best for it - but the way out is always an open, standard format that other software can read. No account, no cloud, no lock-in.

The honesty line below accompanies it only until the export orders WO-2410..2427 have all landed:

> A few exports are still being finished; each one is on the roadmap at top priority.

## Consequences

- The export audit (.planning/portability/EXPORT-AUDIT.md) lists every gap; each becomes a work order.
- Reviewers check new orders against rule 3.
- Imports are welcome but are not what this record requires; this record is about getting data out.

## References

- Memory rule data-always-exports (architect sessions).
- Roadmap draft .planning/roadmap/ROADMAP-DRAFT.md (the "sketch export as DXF" row that prompted this).
