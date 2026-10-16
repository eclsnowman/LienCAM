# Exterior staged roughing: design review

Source-grounded bounded implementation proposal, prepared under the renewed
documentation-only admission: `src/tests/evidence/WO-2654/scoped-proposal.md`.
It recommends stock/access analysis before motion changes and separates later
full-envelope, staged-pilot and retained-stock proof. This is not coding approval;
the original measurements and the unavailable proposed-strategy times below remain
unchanged. Owner reading and a separately scoped implementation order remain owed.

Status: source review complete; three production measurements captured and one
recompute refused. The shallow cleanup comparison remains incomplete. No strategy
implementation or machining recommendation is made by this document. The owner
must read the review before an implementation order is considered.

## Finding

The current rougher already enters from exterior air when the production setup
proves a full-stock region, and it already offers intermediate upward terrace
cleanup. The missing capability under review is a different scheduling policy:
clear accessible exterior material in deeper axial stages, then decide when to
clear cavities from the actual remaining stock. Reversing all Z levels would
break the current stock and dependency assumptions and is not a candidate.

The present evidence cannot establish that exterior-first is faster. It remains
a hypothesis. Neither proposed cavity policy exists as an executable production
strategy, so neither has a measured cycle time.

## What the current application does

- `src/cam3d/rough/levels.ts`, `planLevels`: descending full levels, spacing each
  interval at or below maximum stepdown and retaining required surface depths.
- `src/cam3d/rough/scheduleComponents.ts`, `scheduleAdaptiveDepthBranches`:
  overlapping upper regions precede their lower continuation. The scheduler
  follows an eligible branch through depth; it does not always finish every
  region at one height before descending. Unclassified lower regions wait for
  the whole preceding populated level.
- `src/store/index.ts`, adaptive operation dispatch: full-stock clearing resolves
  the real stock and footprint before setting `sideEntry`. A bounded part region
  or fallback does not inherit that exterior-air proof.
- `src/cam3d/strategies/adaptiveRough.ts`: discovers regions on a private top-down
  stock replay, then emits against the live stock field. Its side-entry seed
  includes the current stock section and the protected part section; material
  belonging to the part is not treated as air outside the stock.
- `src/cam3d/rough/terraceSchedule.ts` and the terrace scheduler: optional midpoint
  cleanup belongs to the interval exposed by a full cut. Eligible terrace work
  precedes overlapping deeper bulk work. During emission the remaining region
  is checked against live stock, with productive removal diagnostics.
- `src/cam3d/strategies/rest/index.ts`: rest machining also calls the adaptive
  rougher with reference/retained stock. It is not a separate exterior-first
  pocket strategy.

This is more capable than a simple top-to-bottom level loop. A new scheduler
must preserve those existing entry, retained-stock and terrace behaviors.

## Options to evaluate

| Option | Order and material state | What exists | Evidence still needed |
| --- | --- | --- | --- |
| Current depth branches | Eligible branches descend with upper-parent dependencies; optional intermediate cleanup | Production implementation | Knob comparison captured; shallow cleanup recompute refused |
| Exterior stages, cavities when reachable | At each bounded exterior stage, reconsider cavities against material already removed | Design candidate only | Stock/access graph, full tool-envelope clearance, engagement checks, generated comparison |
| Exterior stages, cavities afterwards | Finish accessible exterior stages, then a remaining-stock cavity stepdown pass | Design candidate only | Same clearance proof plus compatible retained-stock handoff and no skipped residual material |

The latter two share a staged exterior planner. Their difference is cavity
scheduling, not a different stock model. Neither should be represented by a
post-processing reorder of the current moves: each entry and link depends on
which material has actually been removed.

## Required geometric and cutting evidence

**Evolving stock and access.** At each proposed entry depth, identify material
reachable from exterior air with the actual cutter envelope. Distinguish an
open channel from a cavity enclosed at that depth. Update that classification
after removal, including a cavity that becomes accessible from a side. Preserve
part and finish allowances. The current Z-dexel field stores one bottom/top interval per XY column for
upward-open removal. That representation alone cannot establish a route that
leaves an upper shelf above a removed band. The current top-down replay is useful infrastructure,
but its precomputed regions do not by themselves prove a new deep schedule.

**Full axial clearance.** A clear cutter-tip disk at one Z plane is insufficient.
The proposed route must account for the cutting portion, shaft and holder over
the entire occupied height, and the setup's fixture/workholding geometry. Check
the entry descent, radial engagement, links and upward cleanup. A final stock
picture alone cannot establish clearance. Determine whether the current stock
representation can answer each clearance query; retain unknowns instead of
assuming missing geometry is clear.

**Cutting length and load.** Effective axial engagement must fit the stated
cutting length and reach. Current planar engagement control does not establish
force or deflection for a much deeper axial cut. Tool diameter, flute length,
shaft/holder shape, stickout, material and feed limits need explicit treatment
in any later implementation study. This review does not supply cutting values
or certify either example for physical machining.

**Residual material.** Compare final remaining stock at a common resolution and
with identical finish allowances. A faster route that leaves more material is
not an equivalent roughing result. A deferred cavity pass must consume the
actual compatible retained stock; it cannot begin from an assumed cleared box.

## Four bounded production measurements

The four bounded attempts used the shipped projects unchanged except for the
existing Reduce stair steps checkbox in the two marked variants. Each attempt
reopened the original project through File Open and explicitly recomputed the
active rough operation. Measurements were captured October 12, 2026, against
source revision `f22ba6494de77fc8254244e94e24ce7b8652cfed`.

| Run | Shipped part and rough operation | Intermediate stepdown | Simulated timeline | Disposition |
| --- | --- | --- | --- | --- |
| 06-A | Knob and handwheel, 3D Rough 1 | Off, as saved | 1039.874 s (UI 17:19) | Complete; 3600 moves |
| 06-B | Same project and operation | On | 1108.611 s (UI 18:28) | Complete; 8496 moves |
| 07-A | Relief medallion, 3D Rough 2 | Off, as saved | 59.040 s (UI 00:59) | Complete; 704 moves |
| 07-B | Same project and operation | On | Unavailable | Production recompute refused; no Simulate result |

The knob generated nine full levels in both variants. Cleanup added 68.738 s
to the simulated timeline and reported three emitted terraces from nine
candidates, six skipped, no conservative fallbacks, and 654.305 mm3 of terrace
removal at a 0.5 mm cell size. This is additional removal work, not a comparison
of equal final stock or evidence for a candidate strategy's speed.

The shallow baseline generated one full level and machined four regions. With
cleanup enabled, production refused retained-model clearance on move 479:
commanded tip (35.7635, 2.0099, 7.0000) required Z >= 8.0000 for the conservative
cutter envelope. The failed attempt was preserved without retry or source
repair; no duration, move count or screenshot is claimed for its Simulate stage.
This blocks the second successful cleanup comparison.

Generation wall times were 111.629 s, 116.094 s, 95.009 s and 107.409 s respectively;
the last is time to refusal. These are separate from simulated timeline time.
The three successful screenshots show the active rough operation and timeline
on the recorded hardware renderer. Stock removal was off: these pictures do not
prove final remaining stock, holder clearance or whole-project validity.

The knob's saved settings request whole-stock clearing and maximum stepdown
2 mm. Its saved diagnostics list nine full levels. The relief's saved settings
use a bounded part region, maximum stepdown 3 mm and a bottom override 2 mm
below the top; its saved diagnostics list one full level. These are input-file
facts, not fresh generated results. Do not deepen the relief and label it the
shipped baseline. The example index identifies the other numbered machining
projects as 2.5D work; the additional handles and tray are import-only geometry.

Both selected roughing tools are 6 mm flat end mills with a stated 18 mm flute
length, and both projects have an empty holders list. That does not establish
holder or shaft clearance for deeper stages. The shallow relief is intentionally
a control, not a second proof of deep exterior clearing.

For each run, record source/project identity, resolved stock and heights, active
operation, tool and rates, generated schedule, move roles/counts, terrace
counters when present, and the production Simulate timeline. Open through the
application's file loader, verify model references and explicitly recompute the
rough operation before reading results. Do not time cached saved paths or call
the roughing engine with a fabricated payload.

The Simulate scrubber's maximum is the application's generated playback duration
in milliseconds. Its frame builder resolves move roles and rates and sums
path-distance/feed travel time. Report this as simulated timeline time, not
physical cycle time. Record the operation's separate runtime estimate under its
own name; it can use different machine-motion facts. Record computation wall
time separately from both. No current measurement can give a comparative time
for either unimplemented scheduling candidate.

Only 06-A/B supports a successful existing-cleanup comparison; 07-A/B is incomplete.
Do not attribute the observed difference to exterior-first scheduling or infer a
speedup for it. Raw receipts, generated paths, errors and successful screenshots
are retained in the order's internal evidence directory.

## Compact UI proposal for owner discussion

This is a text sketch, not implemented UI:

```text
Strategy       [ Current depth branches             v ]
               [ Exterior stages                    ]

Cavities       [ When reachable / After exterior    v ]
               (shown only for Exterior stages)

Max stepdown   [ existing value ]
Stepover       [ existing value ]
Reduce stair steps [ existing checkbox ]
```

Keep current depth branches as the existing behavior. Reuse the existing depth,
engagement and cleanup settings. The strategy selector should describe the
scheduling change, while the conditional cavity policy describes only when
cavities are attempted. Exact wording and placement await owner review and a
later implementation decision; the review creates no new operator refusal.

## Decision still owed

Review the three measurements and shallow cleanup refusal with the owner. A
separately authorized investigation is needed before another attempt at that
comparison. Decide whether the possible benefit warrants a
separate implementation order with stock/access and full-envelope evidence.
Measured comparison of the two proposed cavity schedules must remain pending
until those schedules can generate real production toolpaths. This design-only
order cannot honestly satisfy that comparison by inventing timings.
