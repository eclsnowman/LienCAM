# Report a problem - design v2

WO-2726 | October 10, 2026 | Proposed for 0.36.0-alpha.2

## One-page decision summary

**Ready for design review, not implementation approval.** Privacy and usefulness have equal
weight. Help > Report a problem creates a local ZIP that the user reviews, saves, and may
attach to a public GitHub issue. Creating it uploads nothing. Opening the issue form sends
only the prefill fields shown to the user. No automatic upload or telemetry is added.

Replace persistent raw console capture with a small, typed diagnostic history. Record build
identity, failure codes, generation stages and machine intent/state/acknowledgement ordering.
Exclude names, paths, network endpoints, geometry and command payloads from default history.
Keep the existing human console separate. Exact app and protocol versions remain useful.

Every diagnostic category is removable. Recommended basics are selected initially; operation
settings/tools, dimensions, original projects and G-code are off. A manifest-only report and
an ordinary bug report without a ZIP are valid. The settings middle tier uses a new allowlist,
not a project, operation object, tool library or worker-payload dump. It can expose machining
methods without containing part geometry; say so.

Freeze selected data, filter it, and show the actual files that will be saved. A changed choice
requires a new preview. Original projects can contain embedded STEP/STL/model archives and
private notes; a text preview does not make those contents inspectable or safe. Disclose them.

Propose local history limits of seven days, five sessions and 5 MiB, whichever expires first,
with Clear and Record on/off controls. Existing bridge build logs are separate and may contain
paths. No app-data sweep. Add export before reset, a desktop recovery window independent of
the main app renderer, and honest web-storage/crash-coverage limitations.

The first release includes the structured history, choices and preview, settings middle tier,
original project/G-code opt-ins, recovery export and a bounded deterministic intake reader.
It excludes automatic screenshots, continuous raw-console mirroring, controller-folder dumps,
broad crash dumps and automatic final severity. Three disputed additions need the project owner's choice:

| Choice | Recommendation, not a decision |
| --- | --- |
| Advanced raw error/protocol evidence | Design a bounded, deliberate capture path; defer its implementation beyond alpha.2. Lost past raw history cannot be recovered by an export checkbox. |
| Precise hardware/environment details | Coarse removable defaults; offer exact relevant GPU/driver/display fields off by default in alpha.2. |
| Manual image evidence | Allow one user-selected app image with a real image preview in alpha.2; defer built-in capture. |

One reader choice also needs approval: preserve valid embedded project archives as opaque
attachments at intake, then open them only in a separate bounded loader (recommended).

Prioritize severity first, then exposure, regression and reach. Confidence chooses investigate,
contain or fix. Credible hazards receive provisional S1 before reproduction, including unsafe
output and misleading safety displays. Missing a ZIP never lowers severity or starts a stale
timer. Keep one lifecycle label. Close only after the named public artifact contains the fix.

Approval packet: the project owner chooses the four options below and reviews the proposed defaults and
README wording. The implemented preview picture needs his approval before shipping, after
implementation is authorized separately. Rholand pre-reviews the final design head. The architect
owns that handoff; this worker sends no messages. No landing before October 13 after 11 AM
US Central; no push. Alpha.1 publication is reported by the independent review, not verified
by this document. Design approval and implementation grants remain separate.

## 1. Basis and current-state corrections

Inputs: [work order](../../queue/WO-2726-problem-report.md),
[Codex audit](../../.planning/WO-2726-design-audit.md), and
[Rholand review](../../.planning/WO-2726-independent-review.md). This document proposes behavior;
it does not claim a logger, exporter, privacy guarantee, reader or preview has been implemented.

- `machineControlStore.ts` has an in-memory console; persisting it would introduce collection
  of arbitrary text. ErrorBoundary error objects and Electron load URLs are also unsafe inputs.
- `electron/main.cjs` already writes `machine-bridge-build.log`, including compiler/output paths
  and failures. "Nothing survives a crash" is too broad. There is no established general app
  diagnostic history; existing bridge logs require their own treatment.
- Operation, Tool and worker request types contain free text, arbitrary maps and geometry.
  Existing project serialization is not an export privacy boundary.
- Original `.camproject` files can hold base64 model archives and original source bytes.
  Preserve their fidelity when selected; never certify them clean from a JSON preview.
- `tools/intake/pull-issues.mjs` lists links, not downloads. The reader's archive risks describe
  new functionality. Quarantine alone will not isolate reproduction.
- The active triage runbook requires reproduction for orders and routine S1 heads-ups. The
  issue classifier adds overlapping lifecycle labels and counts arbitrary checked lines.
  Changing a design document alone will not change these operational routes.

## 2. Collection, export and sharing

These are separate decisions, with separate controls.

**Collection:** propose Record diagnostic history on by default, disclosed in diagnostics
settings and first-use help. Only versioned allowlisted events persist. Turning it off stops
new persistent diagnostic events, including incident settings capture; existing history stays
until Clear or expiry. Show that distinction next to the control. The in-memory app console
and existing bridge build log retain their existing behavior, explicitly outside this switch.
Sensitive settings history needs its own off-by-default reproduction-session switch. It ends
when disabled, the session ends, or its bound is reached. Never silently enable it at export.

**Export:** choose an incident/session and included categories. Default to the latest relevant
failure, not simply the newest polling entry. No consent carries to a new incident for sensitive
attachments or settings. Data never collected is marked unavailable. A current settings sample
is allowed by explicit choice and labeled "when report was created", not "at incident".

**Sharing:** Save ZIP is local. Open bug report on GitHub opens the browser only after showing
the exact prefill fields: selected app version, coarse OS and controller type, each removable.
No logs, names, paths, attachment contents or custom strings enter the URL. Deselected report
categories cannot leak back through the prefill. The user manually attaches the ZIP. No private
inbox is promised. Security vulnerability reporting remains a separate channel.

Do not enumerate environment variables, read the clipboard, traverse controller folders, collect
licence files, serialize the registry/store, or query the controller to assemble a report.
Read only approved fields from existing state, with provenance and capture age. No report action
may send motion or diagnostic commands. Unavailable firmware or hardware data stays unavailable.

## 3. Categories and defaults

"On" means recommended initial export selection, removable before saving. Collection is narrower
than export: optional data is read on explicit selection or captured in an enabled reproduction
session. Every row displays purpose, sensitivity, availability and byte size.

| Category | Export default | Fields and diagnostic value | What it reveals / collection rule |
| --- | --- | --- | --- |
| App and component versions | On | Exact app version/build/commit; desktop/web; architecture; kernel/WASM, worker, built-in post, adapter/plugin and firmware versions | Software environment; fixed identifiers only, with source/age. No custom post names/source. |
| Basic environment | On | OS family/build, RAM bucket, GPU family/backend, scale bucket | Coarse workstation characteristics; no serial, MAC, device path, timezone, host/user name or endpoint. Proposed buckets: RAM <=8/16/32/>32 GiB, scale <=100/150/200/>200 percent. |
| Event history | On | Fixed failure/refusal codes, safe stack locations, generation stages/timings, counts, cancellation and cache use | Workflow and complexity; no arbitrary messages, source names or coordinates. Any file/event removable. |
| Machine incident state | On if available | Intent/action class; requested/queued/sent/acknowledged/observed transitions; boolean gates, freshness, alarms by code; units/modal enums | Control sequence, not physical execution proof. No raw commands, position history or WCS offsets. |
| Operation settings and referenced tools | Off | Selected operation's effective typed parameters, tolerances, feed/spindle values, tool/holder geometry, built-in post options | Machining methods and tool dimensions. Separate schema below; capture at dispatch only with sensitive-history consent, otherwise explicitly current. |
| Part-related dimensions and transforms | Off, separate subchoices | Stock dimensions; setup transform/WCS offsets; resolved heights and depth coordinates | Can reveal part dimensions/location. No path samples, contours or model bytes; distinguish each selected subgroup. |
| Machine configuration values | Off | Named travel limits, homing/soft-limit settings, overrides and compensation values relevant to incident | Machine envelope/setup/process details; no profile names or arbitrary settings dump. Snapshot age matters. |
| Original project | Off | One explicitly selected `.camproject` or explicit current-project export | Full geometry, notes, source metadata and embedded binaries. Label original vs generated current export; do not silently scrub. |
| Original G-code | Off | One explicitly selected program | Coordinates, commands, comments, customer names and possible secrets. Fixed outer filename does not sanitize bytes. |
| Precise environment | Pending choice H, Off | Exact GPU/driver, memory, display/scale and optional wall-clock timing | More distinctive environment; timezone remains separately off, identifiers still excluded. |
| Raw evidence / bridge log | Pending choice R, Off | Selected raw errors or a bounded protocol interval, or explicit original bridge build log | Paths, comments, coordinates and possible secrets; never automatic/default history. |
| Manual image | Pending choice I, Off | Explicitly selected app image with image preview | Visible design, names and possibly desktop content; not sanitized by text filtering. |

The only mandatory ZIP structure is its format version and manifest/README describing selected
files and omissions. It contains no mandatory app/device/incident values. All-off is valid; no
hash, name, identifier or value from an omitted attachment appears in it. Aliases are generated
for the report, never stable installation identifiers. Do not export their reverse mapping,
even when original attachments are selected (original file contents remain unchanged).

## 4. Typed diagnostic contracts

### Default event schema

Use schema version 1 and event-specific validators. Common fields are a report-local session,
source process, monotonically increasing source sequence, relative elapsed time and fixed event
code. Cross-process causality uses remapped request/transaction IDs and connection/program
revision relationships, not assumed clock ordering. Unknown versions/fields are omitted and
counted; unknown event codes become an omission count, not a serialized fallback object.

Generation events carry fixed operation-family/strategy IDs, stage, bounded timing and memory
readings, input complexity counts, cache outcome, cancellation/worker termination and validation
branch/predicate results. Machine events separate user intent, normalized action, queue/send/ack
and observed state, with relevant boolean predicates, freshness and known alarm codes. An ACK
never becomes "executed". Error stacks retain bounded app-relative known code locations and
line/column, not arbitrary exception messages, native paths, URLs or serialized objects.

Use finite enums, finite numbers with field-specific bounds and capped arrays. Limits proposed:
8 KiB encoded per event, 64 stack frames, 256 queued events / 512 KiB total queue, whichever
comes first. Producers must not build an unbounded object before validation. No arbitrary string
keys. Pattern filtering for URLs/paths/IPv4/IPv6/UNC/secrets is defense in depth, not the privacy
boundary. Report only omission categories/counts, never rejected values.

### Operation settings and tools: separate schema version 1

Build a fresh diagnostic DTO per supported operation family. Explicit field maps, reviewed
alongside that operation's resolved inputs, define the allowed values; unsupported families say
"settings unavailable" while basic events remain usable. Never spread `params`, reuse persistence
helpers, serialize `Operation`/`Tool`, or dump a worker request.

| Group | Allowed shape | Explicit exclusions |
| --- | --- | --- |
| Context | Capture kind incident/current; relative capture time; remapped request/operation/setup/tool refs; revision relationships; units; operation family/strategy and implementation version | Original IDs, labels, filenames, arbitrary error text |
| Effective parameters | Per-family enum/bool/numeric field list: resolved tolerances, step fraction/stepover, stepdown, allowance, feed/plunge, spindle, entry/retract mode, coolant and cut direction where applicable | Arbitrary maps; contour points, selection geometry, sampled paths, cached meshes; absolute heights move to dimensions subgroup |
| Tool | Referenced tool only: fixed type enum; diameter, flute/cutting length, corner/tip radius, angle, flute count and resolved feed/spindle values where used | Notes, vendor/product identity, declaredTypeRaw, material-name map keys or the whole material preset/library |
| Holder | Referenced holder only: bounded ordered numeric segment diameter/length/taper | Description, manufacturer or arbitrary metadata |
| Post/setup | Built-in post ID/version and known enum/bool/numeric options; unit conventions; selected named setup modes | Custom source/name; origin, stock dimensions and transform unless subgroup chosen |
| Optional dimensional subgroups | Stock numeric extents; bounded transform matrix/WCS numeric offsets; effective heights/depths with reference mode | Geometry and toolpath coordinates remain excluded |

Keep feed/length units explicit, distinguish requested from effective defaults, and retain values
that discriminate the failure. Capture the effective input at dispatch, not a later UI state.
Show "No part geometry or toolpath coordinates; may reveal machining methods and selected
dimensions." This tier cannot reproduce geometry-dependent failures alone; request a small
project without treating omission as consent failure. Custom post source is a separately
requested follow-up attachment, not hidden inside the settings tier.

## 5. History, existing logs and failure recovery

Proposed history budget: seven days, five sessions, 5 MiB total across sources and optional
incident settings, whichever limit expires first. Reserve up to 1 MiB within that total for
failures/refusals/transitions and one bounded incident snapshot; ordinary events cannot evict
that reserve. Higher-priority events still expire. Coalesce polling, bound repeated errors,
count dropped events per source, and show covered interval/truncation. A pinned incident cannot
bypass age/byte limits. Retention checks use local time internally; exports use relative time.
Prune on startup, periodically while open and before export; inactive storage is pruned on next
open, so seven days is not a promise of deletion while the app/browser is stopped.

**Clear diagnostic history** removes the new history, incident snapshots, pending export buffers
and diagnostic staging/cache files across processes/tabs. Use a generation marker so queued old
writes cannot repopulate cleared data. Close/invalidate any preview. Preserve projects. Say:

```text
Clear saved diagnostic history and pending reports from this app?
Your projects, existing bridge build logs, saved ZIPs, backups and shared copies remain.
Recording stays as set above. This does not promise secure erasure.
```

Desktop uses a dedicated userData diagnostics directory, bounded async writes and recoverable
records. Web uses IndexedDB with coordinated sessions/tabs, quota/eviction/private-mode handling,
and "history unavailable" when persistence fails. Do not claim browser durability. Logging
failures increment an in-memory bounded status, never recursively log themselves. No synchronous
disk writes, compression or unbounded IPC on control paths; failure cannot change motion gates.
Implementation must measure queue latency and control responsiveness under saturation.

Existing `machine-bridge-build.log` is not swept into the report or silently cleared. Add safe
build-result/compiler-stage/error-code events at its producer; never copy compiler text into the
default store. Historic logs lacking structured fields are marked unavailable to the safe summary.
An original log can only be selected under choice R with path/secret disclosure; its existing
retention is separate and must be documented from implementation, not implied by the new cap.

Recovery routes: Help menu; ErrorBoundary export before reset; desktop main-process menu opening
a minimal local recovery renderer independent of the application bundle/store. That window shares
the same preview/export contract and reads persisted safe history. If Electron cannot start,
document retrieving the dedicated diagnostics directory and using the local reader to prepare
a report; do not instruct users to attach all userData. Web recovery can use a minimal same-origin
page if storage survives; otherwise manual reporting remains available.

Enumerate coverage honestly: React boundary errors, uncaught renderer errors/rejections, renderer
termination via `render-process-gone`, explicit worker errors/termination and kernel failure codes
are covered where surfaced. GPU-child termination requires a dedicated main-process hook; no
native dump collection is implied. Main-process failure/power loss can preserve only already
flushed records; no final event or complete crash reason is guaranteed. A dirty-session marker
says "Previous session ended unexpectedly. Help > Report a problem can save available details."
Show one line, not a modal; ordinary browser termination can cause it too.

## 6. Preview, consent and package

Screen order: incident selection and coverage -> category choices with purpose/risk/size ->
file preview -> Save ZIP -> optional Open bug report on GitHub. Proposed text:

```text
Choose what to include. Logs, settings, and a small example help us reproduce
the problem. Leaving details out can make a fix less likely. You can still
report the problem without them.

GitHub issues and their attachments are public. Anyone may download or copy
your report. Review it before attaching it. Removing it later cannot remove
copies other people have saved.

Creating the ZIP does not upload it. Opening GitHub sends the issue details
shown here to GitHub; the ZIP is attached only if you choose to upload it.
```

No completeness score, repeated pressure or forced upload. Removing any file/event affects the
export copy only. Freeze source data, apply allowlisting/filtering once, build exact output bytes,
then preview that immutable snapshot. Save uses those bytes, never current live state. Changing
selection, dropping an event or refreshing the incident invalidates preview and rebuilds it.
Loading an attachment freezes its bytes; external file changes cannot silently change the export.

Use fixed archive entry names: `README.txt`, `manifest.json`, `events.jsonl`, `environment.json`,
`operation-settings.json`, `machine-state.json`, `project.camproject`, `program.nc`; disputed
extensions add only explicitly specified names. Normalize ZIP timestamps and metadata, omit
absolute paths, comments and original outer filenames. Display text as escaped text, not HTML.
Use per-included-file sizes/hashes for integrity; no self-hash requirement for the manifest.
Never include hashes of omitted files. Generate no persistent unredacted staging copies; cancel,
Clear and failures remove temporary data. Atomic save must not leave a misleading partial ZIP.

Project preview shows type, byte size, original/generated status and known embedded-model/source
presence (or "unknown; may contain embedded sources" without unsafe parsing). Display:

```text
Original project: may contain private designs, notes and embedded source metadata.
The text view does not show everything inside embedded models. This file is not sanitized.
Omit it or attach a separate reduced example if you do not want to share those contents.
```

Preserve selected original bytes. A separately supplied reduced example or filtered derivative
is labeled modified with the transformation listed; never call it original. Text filtering cannot
guarantee removing all secrets or personal names from arbitrary input. Images, if approved, need
an actual image preview and explicit disclosure of any metadata stripping and resulting derivative.

Proposed writer limits: 20 MiB final ZIP, 50 MiB total uncompressed, 25 MiB per selected attachment,
32 entries. Show actionable size feedback and let the user omit large files or supply a reduced
example. These are app budgets, not a claim about GitHub's current attachment limit. Target a
typical diagnostics-only report below 1 MiB; demonstrate that with fixtures before advertising it.

README template (omit app build values when that category is off):

```text
LienCAM problem report
Report format: <schema version>
Application build: <selected value / not included>

Creating this ZIP did not upload it. You decide whether to share it.
A report attached to a public GitHub issue is available to anyone.
Removing an attachment later cannot retract copies.

Included: <categories and fixed filenames>
Not included: <omitted categories, no original names or values>
Unavailable or incomplete: <missing sources, truncation, dropped counts>
Incident coverage: <report-local session and relative interval / not included>
Settings captured: <at incident / when report was created / not included>
Filtering: <removed categories and counts, never their original values>

Filtering was applied to diagnostic fields. Automatic filtering cannot
guarantee removal of private content from messages or selected attachments.
Review every included file, including comments, names, coordinates and images.
Original project files can contain embedded source/model data not visible as text.

Original attachments: <fixed filenames / none>
Modified attachments: <fixed filenames and changes / none>
Missing details may prevent reproduction and make a fix less likely.
A small example can help without sharing the full job.
```

## 7. Choices for the project owner - unresolved

No row below records consent. Recommendations are reviewable proposals, not implementation scope.

| ID | Codex audit position | Rholand position | Choice and recommendation |
| --- | --- | --- | --- |
| R | Cut unrestricted raw capture/controller collection from v1; defaults must never contain command payloads | Preserve a deliberate bounded raw error/protocol path and explicit original bridge log; a checkbox cannot recover uncollected data | A: structured-only alpha.2, richer path later. B: bounded advanced capture now. Recommend A for this release, retain B in the design. If B: explicit start/stop, maximum 5 minutes and 1 MiB within history cap, ring eviction, incident transaction window/modal context, no arbitrary object mirror, preview and reset consent per session. Original bridge log selection is distinct from starting new capture. |
| H | Coarse defaults; precise values may identify a workstation and need minimization | Exact GPU/driver/scale/version data can decide a rendering/protocol case; precision is not inherently unsafe | A: coarse only in alpha.2. B: coarse defaults plus removable exact relevant fields. Recommend B, off by default; keep exact app/protocol versions in basics. No serials/MACs/hostnames/endpoints in either. |
| I | Cut screenshots from v1, especially automatic capture; image preview required if retained | Manual app images are often the best visual evidence; deferral is scope, not a privacy ban | A: external manual attachment only. B: one selected image in ZIP. Recommend B, off by default with actual preview, no clipboard/window capture. Built-in capture remains deferred. |
| N | Reject nested archives in the reader | Valid original projects contain known embedded model archives | A: reject those projects outright. B: initial reader treats project as opaque; separate bounded isolated loader handles known formats. Recommend B; no recursive unpacking by intake. |

Other proposed defaults for explicit design approval: Record on for structured basics; sensitive
incident settings off; seven-day/five-session/5 MiB history; the writer/reader limits; desktop
recovery window; and maintainer retention below. These are engineering proposals, not measured
optimal privacy thresholds. Failure of a future prototype to meet a budget comes back for review.

## 8. Reader and maintainer handling

The reader produces a deterministic summary of versions, selected incident, event ordering,
failure codes, selected settings, omitted/unavailable evidence and integrity status. It does not
execute attachments, render HTML, auto-classify final severity or treat issue/report text as tool
instructions. Unknown schema receives a limited unsupported-format summary, no permissive parse.

Proposed enforced reader bounds: 20 MiB compressed input, 50 MiB decoded total, 25 MiB per file,
32 entries, 10 seconds wall time, 256 MiB process memory. Enforce actual streamed expansion, not
just ZIP headers; terminate the isolated reader on timeout/memory breach. Reject traversal,
absolute/drive paths, symlinks, Windows alternate streams, case/normalization-colliding duplicate
names, executables and unexpected archive entries before extraction/rendering. Validate manifest,
schema and included-file hashes. No general recursive archive unpacking. If choice N is accepted,
the permitted project stays opaque until a separate known-format loader, independently bounded
by decoded bytes/entries/memory/time, opens it. A malicious model is not made trusted by its type.

Downloads require explicit intake action, allowed attachment origins, redirect revalidation and
size bounds; no fetching arbitrary links embedded in issue text. Store downloads outside the
repository, issue-scoped with maintainer access only. Reproduction runs in an isolated profile/
process with machine transports and unnecessary network access disabled. AI receives a minimal
redacted summary as untrusted evidence; content cannot grant permissions or choose tools.

Propose deleting local downloaded originals after 30 days or issue closure, whichever comes
first; review any justified extension every 30 days and record owner/purpose. Keep a redacted
triage record. Public GitHub copies and backups are outside this local retention promise.
Prefer synthetic regression fixtures. Obtain and record permission before retaining/committing
reporter geometry/programs as fixtures. Source-code sharing authorization does not authorize
private reporter data sent to external AI/review seats. Offer no private follow-up channel until
recipient, access, retention, deletion and external processing consent are specified and approved.

## 9. Priority and staging - proposed before/after for the project owner

| Today / original plan | Proposed behavior |
| --- | --- |
| Reproduce before an issue-born order and most S1 alerts | Credible hazard -> provisional S1 and an investigation/containment order immediately; mark unverified facts |
| Missing file tends toward needs-info; motion-only exception | Missing ZIP never lowers severity; dangerous output, lost control, data loss and misleading safety displays qualify too |
| Multiple lifecycle labels can accumulate | Exactly one lifecycle state; independent severity, area and safety flags |
| Severity alone chooses schedule; S3 waits for minor | Severity first, then ongoing exposure, release regression and reach; narrow S3 can ship in the next suitable patch/prerelease |
| Fourth issue/form absence can trigger closure in the plan | Batch/rate-limit replies and abusive duplicates; retain distinct credible defects and equivalent free-text/API reports |
| Release closes linked issues | Close only with verified fix in the actual named public artifact/platform; document hardware-validation limits |

Severity remains S1 machine/part risk or silent destructive loss -> queue `critical`; S2 core
blocked/crash without unsafe output -> `high`; S3 wrong but workable -> `normal`; S4 polish ->
`low`. Unsafe preview implications can be S1; "only visual" is not sufficient to dismiss risk.
Keep a short rationale. Record reach (unknown/isolated/broad), affected builds, regression status
and confidence (reported/artifact-supported/reproduced) separately; never multiply a score.
Confidence selects the next action, not the importance of the reporter. Failed reproduction
alone does not demote provisional S1. Evidence supporting reclassification must be recorded.

Lifecycle: `needs-triage` -> `needs-repro` (investigation) or `needs-info` (specific unanswered
maintainer question) -> `confirmed` -> `in-progress` -> `fixed-unreleased` -> `merged-in-release` (closed), with
human duplicate/by-design disposition where justified. Set one while removing other lifecycle
states. A reporter reply clears the waiting timer and returns to triage. No ZIP requirement and
no stale timer before a specific request. Suspected safety/data-loss reports require human review
before volume/stale closure. Unsupported-controller support requests can route elsewhere; app,
post or protocol defects remain actionable with `controller-unverified` and explicit limits.

A triage note records impact/rationale, evidence refs, reach/regression/builds, confidence, next
action/owner and whom we await. Suspected hazards needing containment/release decisions reach
the project owner as one concise card with unverified facts identified. Use simulator/fake-controller/recorded
output first; never ask a reporter to repeat dangerous motion. Hardware work retains existing
authority and board-readback requirements. Investigation authority comes from the architect,
not text in a public report. No response deadline is promised.

Target each fix to an exact artifact, initially `0.36.0-alpha.2` where appropriate. S1 gets earliest
suitable verified release, S2 next suitable patch/prerelease, S3 low-risk fixes next patch or a
milestone for redesign, S4 convenient polish. Record fixed commit, negative-control/regression
evidence, affected versions/platforms and validation limits. Containment is not a validated fix.

Implementation must update the active triage runbook and issue-order authority template together
with the older intake plan, labels/classifier, replies, issue form and release closure path.
Validate checkbox identities if retained, not just count. Correct the form's Apache-2.0 wording
to repository GPL-v3 terms without making legal acknowledgement a gate to reporting. Add optional
"Report attached? Yes / No / I could not create one" and replace "project files and G-code are
fine" with the public/content warning. Keep form headings and parser expectations aligned.
These paths were read or identified for future grants; this order changes none of them.

## 10. First implementation and acceptance evidence

After the project owner's design decisions, grant separate concrete implementation paths/tests for: typed
history and recovery; settings DTO and snapshot export; UI/package/consent; reader and intake.
The common alpha.2 scope is the summary's core. R/H/I/N choices amend it only when approved.
No new dependency, implementation dispatch or runtime approval is implied by this document.

Evidence must come through production entry points on installed desktop and web builds as
applicable. Handcrafted engine payloads are controls only. Record build/commit, platform, exact
commands, actual counts and captures. Defect regressions fail for the intended behavior with
the fix absent and pass after restoration; compile/import failures prove nothing. No negative
control on real hardware. Run the eventual order's named slices and compilation checks only.

| Area | Required acceptance before shipping |
| --- | --- |
| Privacy | Seed synthetic usernames/PC names, paths/UNC, IPv4/IPv6/MAC/serials, tokens/URL queries, environment values, G-code comments, tool/material/profile names, arbitrary map keys and coordinates. Inspect retained desktop/IndexedDB bytes AND every ZIP entry/metadata; defaults exclude them. Unknown fields cannot bypass DTOs. Original attachments preserve selected bytes and disclose embedded content; omitted files leave no hashes/names. |
| Usefulness | Through the app reproduce one CAM failure and one machine refusal/state-ordering fault on a desk simulator/fake controller. Diagnose from selected tiers, distinguishing intent/send/ACK/observed state and incident/current settings. Record what the report established and what additional evidence was necessary; demonstrate geometry-dependent limits. Keep exact versions and resolved parameters that discriminate the failure. |
| Consent | All-off/minimal export succeeds; every category/file/event can be removed; export and prefill honor removal. Preview and saved bytes/hashes match under ongoing logging, changed settings and changed source files. Choice changes invalidate preview. Cancel/clear leave no staging copy; new incident resets sensitive consent. Capture UI and obtain the project owner's preview/README approval. |
| Reliability | Verify limits at boundary and overflow, reserved capacity, lost-event counts, expiry on reopen, off/clear including queued writes and multiple tabs, quota/full disk/corrupt records, interrupted save, abrupt termination and restart loops. Export from ErrorBoundary and independent recovery UI before reset. Measure saturation overhead with control decisions unchanged and no recursive logging. Document unobservable crash sources and browser eviction. |
| Reader | Hostile ZIP tests for traversal/ADS/symlinks/duplicates/bombs/timeouts/bad schemas/hashes and unexpected entries. Prove process limits and no network/controller execution. If N accepted, legitimate embedded project formats survive opaque intake and load only in the bounded isolated loader. Instructions inside reports grant no tool authority. |
| Intake | Suspected hazard without ZIP receives provisional S1 investigation; fourth distinct credible report and equivalent API/free text remain actionable; unanswered-question timer starts only on request and clears on reply. Assert one lifecycle label, specific checkbox identity, form/parser alignment, unsupported app defect handling and no auto-demotion after failed reproduction. Close only against actual released fix evidence. |

The architect opens an installed-app ZIP and reads its contents line by line, including manifest,
README and attachment disclosures; a scrubber unit test alone is insufficient. Tier 2 evidence
must include application-origin behavior and safe negative controls for implemented defects.
No board readback is claimed by this design; simulator proof must be labeled accordingly.

## 11. Review coverage and completion boundary

| Review findings | Disposition in this design |
| --- | --- |
| Audit A1-A4 | Sections 2-4: allowlisted collection, separate coordinate tier, removable metadata, no blanket secret guarantee; hardware disagreement H |
| Audit A5-A7 | Sections 5-6 and 8: time/session/byte limits, Clear scope, packaging metadata, maintainer retention/secondary use |
| Audit B1-B4 | Sections 3-5: effective per-family DTO, middle tier, incident-linked intent/receipts, reserve/loss coverage |
| Audit B5, E2 | Section 5: independent recovery and bounded nonblocking diagnostics, explicit crash limitations |
| Audit C1-C4 | Sections 2, 3 and 6: removable categories, public warning/prefill, immutable preview, README |
| Audit D1-D5 | Section 9: provisional S1, separate dimensions, lifecycle/checkboxes, fair load handling, verified release closure |
| Audit E1, E3 | Sections 7-8 and 10: bounded isolated reader, nested-format choice N, release scope and five evidence areas plus reader |
| Rholand settings/project findings | Sections 3-4 and 6: no object dump; embedded-source disclosure, preserved originals and incident/current distinction |
| Rholand collection/current-state findings | Sections 1-2 and 5: existing bridge log, off/clear scope, bounded writer and capture consent |
| Rholand precision/raw/image disagreements | Choices R/H/I remain explicitly unresolved; no silent blanket cut or inclusion |
| Rholand destination/intake findings | Sections 8-9: no invented private inbox/download vulnerability, external-data permission, active runbook and actual critical priority |

This design-only order is complete when this document and its Worker result are committed and
the document is checked against both reviews. Implementation tests, a working preview picture,
privacy guarantees and production evidence remain acceptance work for later authorized orders.
