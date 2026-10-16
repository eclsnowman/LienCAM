# LienCAM: proposed road from alpha to 1.0

Draft for the project owner, 2026-10-10. Source snapshot: `48a951775`. WO-2727.
Nothing here authorizes implementation, changes a hold, or promises a release date.

As of 2026-10-13: written before the 10-13 restart. Since then alpha.2 is set for Fri 10-16
(the project owner card 10-13), and the current queue and dates live in docs/launch/ALPHA.md - where the
two disagree, ALPHA.md is current.

## The ten-minute version

| Release | What it is for | Proposed contents |
|---|---|---|
| 0.36.0-alpha.2 | Make it easier to come back to a project and tell us what went wrong | About/GitHub, Open with pictured recents and examples, Report a problem after its privacy audit; a few bounded fixes (WO-2724, WO-2725, WO-2726). |
| 0.36.0-alpha.3, .4 | Remove daily annoyances while collecting real-machine evidence | Probing console first, clearer program listing, small content fixes; larger control changes get their own proof (WO-2665, WO-2672, WO-2597; ALPHA AFTER). |
| 0.37 alpha | Make ordinary machine work clearer and repeatable | Run macro operations, truthful output buttons, Load after MDI, rapid-override investigation; finish launch media alongside it (WO-2478, WO-2677, WO-2659, WO-2669, WO-2631). |
| 0.38 alpha | Make editing geometry dependable | Defined sketch patterns, Form axis rotation, design-led Simplify; stabilize existing 3D/Form/Relief (WO-2616, WO-2508, WO-2505; R-060..062). |
| 0.39 alpha | Make the whole interface usable in German | Finish extraction, guard new text, CNC glossary, German pilot and layout pass (WO-2322, WO-2324, WO-2325, WO-2328, WO-2329, WO-2330). Can run beside 0.37/0.38 where files do not overlap. |
| Beta | Demonstrate a reliable supported workflow | Conditions below, not a calendar date or a requirement to finish every feature idea (WO-2727; R-060..071). |
| 1.0 | Make a durable promise to users | Stable supported workflows, a defined project-format contract and continuing ability to open released files (WO-2727; ADR-0040 caveat below). |

Propose alpha.2 in the week of October 19, only if its three named items are ready;
then a point release every one to two weeks. A serious reproduced defect can justify
an earlier patch. Feature milestones have sequence, not dates: move a theme rather
than squeeze unfinished work into a patch. The version numbers are proposals, replacing
the older M7 label `0.36.1`; the project owner has not approved that reconciliation.

S = bounded edit/content; M = several connected surfaces; L = broad work, design or
geometry uncertainty. These are effort sizes, not safety ratings or elapsed-time promises.
Order sizing wins over older roadmap estimates. Where an order has S-M or M-L, this
draft uses the higher size. Machine time, review and waiting on the project owner are additional.

## Point releases: cheap fixes and the exceptions

| Slot | Item and size | Why it fits, and what must happen first |
|---|---|---|
| alpha.2 | About and GitHub link - S, WO-2724 | Existing modal/menu; no new subsystem. Included in the WO-2725 UI lane. |
| alpha.2 | Open, pictured recents/examples, saved thumbnail - M, WO-2725 | Bounded opening workflow using existing project/example paths, but desktop recents and save-time pictures make it more than polish. the project owner approves pictures. |
| alpha.2 | Report a problem - L, WO-2726 | Explicitly requested for this release; NOT a cheap fix. Persistent desktop/web logs, opt-in attachments, exact preview, scrubber and reader need the critical privacy/usefulness audit folded in and shown to the project owner before implementation. No automatic upload. |
| alpha.2 candidate | Export .nc with a chosen name - S estimate, ALPHA.md:148 | Existing export path; narrow picker/default-name change. Needs a scoped order and save-dialog proof first. |
| alpha.2 candidate | M0 CYCLE START tooltip - S estimate, owed O13 / WO-2566 | Bounded wording if it can use the existing pause state. Check kept-stop routes; machine-seat look. The source records FAIL, not a finished fix. |
| alpha.3 priority | Console below Probing - M, WO-2665 | Reuse Main's history/collapse; layout and machine-seat screen check, no new console engine. the project owner explicitly put this first after alpha. Bring forward if alpha.2 has room. |
| alpha.3 | Program listing colours and Settings switch - M, WO-2672 | Existing listing; prove comments versus executable lines without changing execution/highlighting. Desktop machine-seat look. |
| alpha.3 | Hidden example macros - S, WO-2597 | Profile content on existing suppression support; hidden examples must remain non-executable until enabled (WO-2657). No claim that an example runs without board readback. |
| alpha.3/.4 | Finish useful wiki pictures - M, WO-2716 | Script repairs are bounded, but waterline and Z-mesh findings must be explained before their images are accepted. Not all six gaps are ready to integrate. |
| Alongside patches | Temp/cache cleanup - S, WO-2682; protect proven behavior - M, WO-2588; pixel-based Help drift - M, WO-2492 | Existing harness paths, not release features. WO-2492 follows landed WO-2491. These support delivery; do not bundle them into a product patch's critical path. |

Cap optional patch contents to what fits the one-to-two-week rhythm. WO-2726 controls
alpha.2 readiness; moving it out would require the project owner to change his explicit assignment.
Useful launch pictures and clips may ship earlier than 0.37 when approved.

## Feature milestones: dependencies and proof

| Theme / proposed slot | Work and size | Dependencies and hardware evidence |
|---|---|---|
| 0.37: machine workflow | Run macro operation - M, WO-2478 | WO-2437 rails landed. Named macro must have an M-code; prove posted position and execution through simulator/native kit, then real-board readback for any hardware claim. |
| 0.37: machine workflow | Macro Drives output field - M, WO-2677 | Follow WO-2668's vacuum work; verify state from button, MDI and program routes, including external output changes. Kit plus board output readback. |
| 0.37: machine workflow | Load waits for moving MDI - M, WO-2659 | Session-state consumer inventory and cancellation/stop cases; simulator/kit first, then board showing the old move ends before loading. |
| 0.37: investigation first | UC100 rapid override - L, WO-2669 | Establish actual API behavior, then the project owner picks the route. Measured board speed/readback required; do not promise a live override before the investigation. |
| 0.37 companion: teaching | Hero/V01 - M, WO-2631; V02-V09 - L each, WO-2572, WO-2573, WO-2574, WO-2575, WO-2576, WO-2577, WO-2578, WO-2579 | Freeze a capture build, prove smooth V01/hero first, then the eight clips; each stops for the project owner's review. Whole jobs through the production app; V07 simulator footage does not certify hardware. |
| 0.37 companion: teaching | Site scenes - M, WO-2543; Help drift - M, WO-2492 | Re-shoot S02-S16/SP on the release build, review whole frames against actual use. No new hardware claim; use verified captures/footage. |
| 0.38: editable geometry | Sketch patterns, mirror and offset copies - L estimate, WO-2616 | Inventory all copy makers; retain definitions without overconstraint; edit/source propagation, save/reopen and undo. Not a circular-pattern-only patch. No board dependency. |
| 0.38: editable geometry | Form axis/cage-edge rotation - M, WO-2508 | WO-2507 landed. Design axis picking and symmetry first; visible pivot and typed angle. No board dependency. |
| 0.38: editable geometry | Model Simplify - L, WO-2505 | Compare algorithms, the project owner picks before code; maximum two-way surface deviation within the chosen limit, face counts, production import/Form/fillet case and undo. No board dependency. |
| 0.38: machining quality | 3D/Form/Relief stabilization - L/L/M, R-060/061/062; bottom-up exterior clearing review - M, WO-2654 | WO-2654 is design ONLY: measured cycle-time comparison and UI sketch, not permission to build. CAM changes need posted-output/stock evidence and appropriate real-part trials before stable claims. |
| 0.39: German | Remaining extraction - L each, WO-2322/2324/2325; guard - M, WO-2328; glossary/pilot - L, WO-2329; layout - L, WO-2330 | Remaining extraction -> guard -> pilot -> layout at 1920x1080 and 1440x900. Preserve existing language commits. English output unchanged; G-code/controller text and decimal point stay unchanged. Exercise operator messages on kit; board checks only if behavior changes. |
| Next feature decision, no date | Desktop MCP CAM planning - L, R-091; modeling later - L, R-092 | Keep the already-done read commands (R-090). CAM planning with undo comes first; no machine motion. Needs scoped orders under the existing design before dispatch. |
| Later, no version assigned | Beds - L, R-114; several blanks in one setup - sizing owed, ALPHA.md:173; custom layouts - L, R-097 | Different asks, not synonyms. Define saved-project structure/workholding semantics before Beds or multiple blanks; decide persistent layout behavior separately. Hardware proof follows any eventual posting/control effects. |

Roadmap priority-1 validation also remains active alongside these themes: checked common
machine definitions (M, R-041), UCCNC/GRBL/grblHAL evidence (M each, R-063..065),
probing/setter (M, R-067), and pendant (M, R-071). More-controller tool change (M, R-059),
LinuxCNC (M, R-066) and rotation/surface maps (M, R-068) need their own hardware owners.
Readback and a named version/session are required; a compile or simulator cannot promote a family.

## Findings to scope before assigning a patch

These are retained from [ALPHA's AFTER section](../launch/ALPHA.md#after-the-alpha),
not silently converted into authorized new orders. Sizes are provisional until reproduced.

| Source paragraph / check | Proposed handling |
|---|---|
| Simulator default work zero; UCCNC TEXT outside corner; point-probe simulator (ALPHA.md:133,135,137) | M each, 0.37 investigation candidates. Separate simulator defaults, text-route approach, and tip-radius modeling. Carry RC1 notes O1-O5 with the text-route investigation. Point-probe finding still needs the project owner's disposition. Do not generalize these to the native board. |
| Second-run listing; correcting a refused Load (ALPHA.md:146,150) | M each, 0.37: reproduce move-ID reset and revalidation after tool/limit correction; kit then affected board route. |
| Tool-change card disagreement; stopped probe status; Held chip; Tools-tab measure resume (ALPHA.md:152,158,174) | M each, 0.37 state/UI work: trace stop, refused start, between-part hold and resume consumers. Wording alone is not proof of correct state. |
| G49 / M2001 wording (ALPHA.md:174); owed O22 | M for G49, S for wording estimate. Keep tool-length semantics separate from card copy. O22's kit-only scope remains; do not provoke a fault on hardware. |
| Long-stream override wait (ALPHA.md:141); owed O47 | M investigation, LOW priority as the project owner ruled. The 69-78 s result is SimUC100-only; distinguish simulator from hardware first and time both override and Feed Hold. No claim about E-STOP latency was measured. |
| Wiki P3 picture gaps (ALPHA.md:139) | M batch estimate, after WO-2716's useful P2 work. Twenty low-priority gaps; keep dispositions, not pictures for their own sake. |
| Auto-update/settings (ALPHA.md:174) | M estimate, separate from landed update notification. Agree keep-or-convert behavior for user settings and released projects before automatic installation. |

## Beta: proposed conditions, all required

1. No open confirmed S1 or S2 in the advertised supported workflows; unresolved
   machine-moving allegations get reproduction/triage, not dismissal (intake plan section 2).
2. Report a problem has shipped with the audit resolved, readable preview and tested
   privacy controls; users can supply evidence by choice (WO-2726).
3. Every owed/failed check applicable to the beta's supported scope is closed with named
   evidence. Start with O3/O5/O13/O15/O16/O22/O31/O35 and O37-O47. Reconcile partial PASS
   scopes too, especially O1/O19/O28; do not turn an unrun subcase into a pass. Desk-only
   cases remain desk-only (OWED-CHECKS table and "Could not confirm").
4. Each controller family advertised as supported has at least two independent successful
   user machine reports with logs and the project owner's promotion decision. This preserves the existing
   launch-plan section 2.9 rule; the WO's example of one non-owner machine would be weaker.
   Untested families can remain explicitly experimental outside the supported beta scope.
5. Every supported screen/workflow has useful Help and truthful pictures; installation,
   reopen, machine setup, post, run, hold, stop and recovery work on the named release build
   (WO-2727 proposal; WO-2716; R-060..071). Core feature tests and release gates are green.

Beta is a reliability decision. German, MCP, rotary, Beds and every remaining roadmap idea
are not automatic beta gates. the project owner chooses the supported scope; no machine session is
scheduled or motion authorized by this document.

## 1.0: the promise changes

Propose a stable `.camproject` contract at 1.0: files saved by 1.0 and later keep opening
in later supported releases, with tested conversion for future schema changes. Preserve
settings across updates; publish compatibility limits and recovery steps. Freeze the
contract, not the ability to add features. Require beta conditions to remain true, no
open S1/S2 in supported scope, verified save/open/update round trips, and the project owner's release
decision (WO-2727; ADR-0040; ALPHA AFTER auto-update/settings paragraph).

**A decision is already due:** ADR-0040's title says "before 1.0", but its Decision says
"until ... a public release" and its Consequences say revisit it when a public release
exists. Alpha.1 is published in this source snapshot. We cannot promise free format
breakage until 1.0. the project owner should confirm protection of released alpha/beta files now,
then formalize the 1.0 guarantee. WO-2616's old "no migration needed" clause also needs
that ruling before a saved-format change. This draft changes neither ADR nor order.

## Parking lot: reconcile with the project owner, keep the evidence

| Question for the project owner | Evidence and proposed disposition |
|---|---|
| Mark update checking done, retain auto-install separately? | R-093 says not started; archived WO-2720 is landed and explicitly says it never installs. |
| Mark language plumbing/Help readiness done and size only the remainder? | R-100/R-102 lag landed WO-2319, WO-2320/2321/2323/2326/2327. Remaining six orders above stay held; WO-2329/2330 are L in the orders, not M/S as in the roadmap. |
| Reconcile intake status rather than rebuild it? | R-111 says forms in progress; LAUNCH_PLAN 2.10 says WO-2340/2486 landed. I12's future summary/monthly card was superseded by the live GitHub tab and uptake-driven Ideas review. Confirm I11/I13 release credits and issue closure still work before the next patch (intake section 7). |
| Keep launch media as unfinished launch work? | ALPHA rows 8-9 and WO-2631 put it IN the release; older LAUNCH_PLAN M3 says held from alpha. Eight clip orders plus WO-2543 remain held. This draft proposes delivery slots, not retroactive cancellation. |
| Reproduce or retire old scrub/diagnostic work with evidence? | WO-2354 (M) and WO-2604 (S) remain held despite later release scrubs/sweeps in ALPHA. Their age proves nothing; inspect current hits/four named reds before closure. |
| Retain WO-2716 with corrected status? | Its sizing says integrate accepted 3-3 pictures, but its later disposition withdraws acceptance; G05b may be a product finding. Neither is a cheap approved screenshot. |
| Schedule the big cleanup separately? | WO-2715 is L and authorized after public go. Inventory first; preserve useful branches/work; runner-managed cleanup only. It is not a product-release milestone. |
| Remove only the resolved duplicate from future work? | ALPHA AFTER explicitly marks copied-router home-at-max resolved by WO-2712. R-011/R-035/R-090/R-110 already say done; do not count them as new scope. |

All other rows stay in `roadmap.json`, without new dates: rotary R-001..008; CAM/output
R-010..021 and R-080..082; modeling R-030..038; libraries/onboarding R-040/R-042;
control conveniences R-050..058; mesh/nesting R-069/070; platform R-094..096;
more languages R-106; community R-112/113. Existing `idea`/approval-required rows
remain decisions, not commitments. Only present IDs in these ranges are meant.

## How reports change the plan

Use the [intake plan](../../.planning/public-release/github-intake-plan-2026-10-01.md),
sections 2 and 4: daily triage, treat attachments as untrusted evidence, reproduce
through the app/posted output, then file a scoped order. S1 means machine/part risk
and gets urgent work plus the earliest gated safety patch; S2 means a broken core
step without a workaround and goes in the next patch (sooner for install blockers);
S3 is workable and normally waits for a minor release; S4 polish is batched. the project owner
can override severity; design changes go to him. Landed fixes stay fixed-unreleased
until release notes credit reporters and the released fix is linked before closing
the issue. Ideas have no severity: the live GitHub tab carries them for the project owner's
choices (LAUNCH_PLAN 2.10 supersedes the older monthly-card plan). M7's first-two-week
triage and reporter-credit intent survives; its old version/date labels do not
create a new promise.

Source key: WO IDs refer to `queue/` or `queue/archive/`; R IDs refer to
[roadmap.json](roadmap.json). [Roadmap README](README.md) remains the publication
contract: this draft is not the generated public roadmap. Machine evidence lives in
[OWED-CHECKS](../machine/OWED-CHECKS.md); release policy in
[LAUNCH_PLAN](../launch/LAUNCH_PLAN.md); compatibility in
[ADR-0040](../decisions/0040-no-legacy-project-support-before-1-0.md).
