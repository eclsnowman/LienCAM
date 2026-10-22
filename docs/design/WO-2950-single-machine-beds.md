# WO-2950: Several beds on one machine in one project

Status: bounded discovery complete; proposed first implementation allocation below.
No product implementation or hardware result is claimed by this document.
Inspected source: `24e7c0f3985d6a55a5dc8d260eab7da4ac64e7bc`.

The operator's words: "Yes but at first lets plan smaller, with the bed system (multiple setups/beds for one machine in one project), later we could make it multi machine multi bed once we develop the system for multi workbeds on a single machine."
Source: trusted owner chat export 2026-10-18, revision 1.0 P11, recorded in
`queue/WO-2950-single-machine-beds-discovery.md`. This design is the worker's
recommendation under that decision, not a further owner decision.
My reading: organize independent loads as existing setups, retaining one machine.
Measured against: the source inventory and counterexamples below; captured
source identities and replayable searches are in `src/tests/evidence/WO-2950/`.

## Decision: initial bed identity is Setup.id

Current Setup CAN encode the initial beds. Use one Setup for each independently
authored bed/load: its id is the durable identity, its name is the operator's
label, its operations belong to it, and its WCS defines its origin. Keep the
existing term Setup in the product for this first slice; a name such as
"Bed 2 - cabinet back" already communicates the load. No second Bed registry,
activeBedId, per-bed machine copy, operation.bedId or duplicate stock snapshot.
The project has exactly one `Project.machine`.

A bed here is a setup/load in the CAM document, not a newly modelled machine
table, pallet changer, physical-machine offset or automatic loading action.
Independent successive loads can each use G54 in separate files. Several
fixtures mounted together can still use the existing combined-offset workflow.
Choosing another setup in the editor does not select a controller offset or
load a machine program. No automatic transition between loads is introduced.

One setup continues to have one stock/WCS context. Several orientations or a
second side remain separate setups, including `flipOf`; they need not become
separate physical blocks. A future grouping of several setups into one named
physical bed would need its own explicit relation and scope. P11 does not
require that extra authority for the first system. Multi-machine routing stays
later; do not add placeholder machine ids to every setup now.

## Current authorities and route census

These are source observations, not newly executed application behavior tests.
The evidence manifest pins the complete inspected files; consumer searches
capture the route discovery rather than treating the order's two analogs as a
complete acceptance list.

| Concern | Current authority and observation | Initial-bed consequence |
| --- | --- | --- |
| Machine and setup identity | `src/types/index.ts`: Project owns machine, setups, activeSetupId and activeOperationId; Setup owns id/name/WCS/stock/operations/folders/notes/optional flipOf. | Reuse the existing cardinality and nested operation membership. No machine-per-bed fields. |
| Authored writes | `src/kernel/camCommands.ts`: setup.add clones its input, rejects duplicate setup ids and activates the new setup; operation.add targets setupId and rejects duplicate operation ids across setups. `src/store/index.ts` routes add/update through executeCamCommands. | Create using the existing modal/transaction. No parallel writer or copied operation authority. |
| Selection | `src/components/panels/DesignTree.tsx`: handleActivateSetup clears selected stock/geometry and viewport part before using setActiveSetup. Store setActiveSetup also clears activeOperationId; operation-row activation first selects its parent setup. | Existing tree is the bed selector. Do not add a second selector that omits selection cleanup. Switching must not move geometry, machine or stock. |
| Setup authoring | `src/components/modals/SetupModal.tsx`: pickDefaultSetupStock selects the sole geometry-bearing stock, asks for a choice when multiple candidates exist, and saves stock-corner/part-feature/manual bindings. New or explicitly offset-edited WCS records carry fixtureOffsetOwner='setup'. The picker disables occupied slots and computes allOffsetsUsed; `src/kernel/authoring.ts` uses that fact as a save gate. | Reuse origin picking and real capability validation. Authoring must permit independent loads to reuse a slot; deleting only the export conflict check would leave an incomplete flow. A new bed with several possible blocks must bind the intended block, not whichever setup was last active. |
| Setup panel | `src/components/panels/SetupPanel.tsx` exports SetupHoldingEditor, editing holdingMethod and notes only. `src/components/panels/PropertiesPanel.tsx` selects SetupProperties from activeSetupId. | The read-only analog is not a bed registry or full setup editor. No reason to put persistence or stock authority here. |
| Physical stock | `src/types/index.ts`: Project.stocks contains PhysicalStock id/mode/bounds/position and optional legacy fixtureOffset. Setup.stock is stock configuration/material, not another physical block id. Project.sceneStock is legacy scene configuration. | Bind through the existing stock readers; do not infer physical identity from Setup.stock, dimensions, material, name or G54. |
| Membership | `src/store/stockAssignment.ts`: effectiveStockIdForCompute accounts for nests/model-origin membership; setupStockConsistency checks enabled operations. `src/store/dispatchGeo.ts`: resolveOwningStock and aggregate selections have explicit ownership rules and no project-wide fallback for a named missing stock. | Preserve these readers. A setup row does not scope every '__all__' operation automatically. Tests must exercise aggregates, nests and explicitly assigned model geometry as well as simple DXF rows. |
| Origin and offset | `src/lib/post/workOffsets.ts`: wcsBoundStockId treats originBinding as authoritative, including explicit part_feature.stockId. Manual binding ignores stale legacy stockId. resolveSetupWorkOffset reconciles operation stock with WCS stock and honors setup-owned offsets, otherwise legacy stock-first resolution. | A work slot is not bed identity. Untouched legacy records keep their resolution. Do not reinterpret a modern part-feature binding using an outdated stock-corner-only comment. |
| Legacy stock-slot editing | `src/store/index.ts`: setStockFixtureOffset still rejects conflicting physical owners. SetupModal writes setup-owned WCS records rather than calling that action. | Leave the stock-level assignment action and its consumers unchanged; independent-load authoring does not need to reassign legacy physical-stock slots. |
| Save/reopen | `src/store/index.ts`: buildProjectFileSnapshot packages every setup via stripOperationForPersistence('file'); persistPartialize uses 'localstorage'. loadProjectFromFile migrates/hydrates and conditionally rederives setup stock on open. `src/store/persistenceRegistry.ts` classifies setups as localstorage-heavy and activeSetupId as core. | Reuse both persistence legs. File and browser recovery intentionally differ in derived toolpath retention; compare authored identity/ownership, not identical derived caches. |
| Migration | `src/store/migrateHierarchy.ts`, `src/store/migrations/projectMigrations.ts` and `src/store/migrations/schemaMigration.ts` own existing normalization. | No bed schema version or record rewrite for the proposed alias. Existing reopen normalization still applies. |
| Separate/combined posting | `src/lib/post/postProject.ts`: both modes resolve offsets and stock consistency before building inputs; mode branches later. Separate files carry setupId but their default name is baseName-G<offset>.ext. | Shared cross-setup offset conflict validation currently also affects separate loads. Repeated slots can also yield identical default filenames for otherwise accepted same-stock setups. These need the bounded export change below. |
| Actual export UI | `src/components/modals/PostProcessModal.tsx`: checked setup/op ids determine scope; outputMode initially combined; runFreshPost stages fresh selected work; exportNames/handEdits are keyed by setup identity and operation selection. Separate exports download individual files; setup sheets consume those file identities/names. | Operator explicitly chooses Separate for successive loads. Keep current combined default and fresh staging. Verify downloaded files and setup sheets, not just preview strings. Custom filenames remain the operator's. |
| Live geometry program | `src/lib/program/multiSetupProgram.ts` plans stages, duplicate-WCS refusal and global safe retract. `src/lib/machine/machineSession.ts` owns actual staging/offset switches/holds and tool changes. `src/lib/machine/programContext.ts` binds setup snapshots and operation ownership; `src/lib/post/programContextEnvelope.ts` carries context on file output. | None of these becomes a load sequencer. Keep current live combined rules. Single-file contexts must contain only their own setup/operations. |
| Second side, workholding and placement | `src/lib/cam/flipSetup.ts` derives a second-side setup; `src/lib/workholding/resolveWorkholding.ts` resolves setupScope. Project geometry/modelItemPlacements remain shared project authorities. | Shared stock/geometry is intentional only when explicitly referenced. Two independent beds need distinct physical stocks and distinct placements/geometry where their poses differ; do not silently move one shared model to make another bed look right. |

ADR-0026, `docs/decisions/0026-one-stock-per-setup-multi-fixture-posting.md`,
retains one-stock-per-setup and global-retract rules. Its historical stock-slot
amendment does not describe the newer explicit setup-owned marker; the actual
resolver above is the source truth. ADR-0040,
`docs/decisions/0040-no-legacy-project-support-before-1-0.md`, discourages
speculative compatibility migrations. This proposal adds none and preserves
the compatibility handling that already executes.

## Frames and shared stock prerequisite

Use WO-2945's selected contract in
`docs/design/WO-2945-coordinate-frames.md` and implemented
`src/lib/geometry/coordinateFrames.ts`: FrameRef has kind, projectEpoch,
entityId and revision; metric right-handed points/vectors have explicit
conversion direction. Project world is NOT controller machine coordinates.
No bed translation is applied to stock bounds or toolpaths a second time.

WO-2953 owns initial material, ordered enabled predecessors, revision,
readiness and conservative representation. Its recorded continuation in
`queue/WO-2953-shared-enabled-operation-stock.md` specifies the public
getOperationStockDomain(setupId, stockId) accessor with authority, shared
world FrameRef and finalOperationId using STOCK_END_OPERATION_ID. Reuse that
accessor after delivery; do not construct another authority, supply private
epochs/currency callbacks or create a bed stock cache. Independent beds never
consume each other's removed material merely because dimensions or slots match.
Same physical stock in a flip does not by itself prove reusable remaining stock;
that needs explicit mapping and representation support from the stock authority.

Availability is distinct from contract selection: the frame implementation is
present in this checkout. The stock order records a review/delivery checkpoint
on 2026-10-20; its authority/adapter implementation and evidence directory are
absent here. No stock integration or accepted final stock review is claimed.
Before implementing, the architect must reconcile the delivered 2953 contract
and current leases, especially store/index.ts. This is a technical checkpoint
under the existing approval, not a request to the operator to approve P11 again.

## Operator flow

1. Open one project with its existing machine. Create a setup using New Setup;
   name it "Bed 1 - cabinet sides", bind stock A, and choose its origin with the
   existing setup editor. Add operations to that setup.
2. Create "Bed 2 - cabinet back" on the same project machine, bind stock B and
   set its own origin. Add its operations through the existing setup-scoped
   authoring route. Reusing stock A intentionally means the same physical block;
   it does not allocate a fresh load of material.
3. Select either tree row. Properties, operation list and setup-scoped
   workholding follow that setup. The overall workspace may still show other
   project geometry; selection is not a promise to hide every other bed.
4. Save the .camproject and reopen it. Both setup ids/names, stock references,
   WCS bindings and nested operations survive. Browser recovery uses its existing
   derived-data stripping policy. No selection change starts machining.
5. In Post Process choose the desired setups/operations and Separate. Preview
   and export one independent program per nonempty selected setup, with distinct
   default filenames and matching setup sheets. G54 may be reused across these
   independent outputs. The existing single-setup run procedure applies to each
   file; no file automatically loads or runs the next bed.
6. For fixtures present together, deliberately choose Combined and the existing
   valid offsets. Current conflict checks, retracts, tool-change holds and stops
   remain. Never convert a refused combined job into separate execution silently.

Steps describing repeated G54 independent loads are proposed behavior, not
something this discovery has verified in the current application.

## Persistence and transition plan

No data migration: existing setups become the initial beds by interpretation.
Keep every setup/operation/stock id, order, binding, machine record and flip
relation. Retain legacy stock-first versus explicit setup-owned offset behavior;
never assign new offsets during open, selection, rename or save. Preserve names
with duplicates or non-ASCII text because identity is the id.

Reopen tests must pass through prepareProjectToFile/buildProjectFileSnapshot
and loadProjectFromFile, plus persistPartialize and real rehydrate. A JSON clone
is only a control. Check same-id project replacement against the stock owner's
epoch/async invalidation tests after that dependency is delivered. Unknown stock
readiness is not an empty fresh block. File-open stock healing must not recenter
an unchanged bound origin (the neighboring WO-2271 incident comment explains why).

Do not add migration code to anticipate multi-machine or a future bed-group
model. A later allocation can add an explicit grouping relation if real use
needs multiple setups per named physical bed; it must retain existing setup ids
and avoid moving stock/WCS/operations into a second authoritative container.

## Exact proposed first implementation allocation

This is a plan for the architect to record as the next narrow lease. It does
NOT expand this discovery order's currently writable paths. First check the
delivered WO-2945/2953 contracts and overlapping live ownership. No whole-order
wait for every coordinate/stock consumer migration is necessary.

Source to grant:

- `src/components/modals/SetupModal.tsx`: allow selecting an occupied G54-G59
  slot for a setup-owned WCS and creating more than six sequential loads. Retain
  the current preference for a free slot when available; retain resolved-height,
  fixture-stack, stock-choice, bore and second-side checks. Occupied slots may
  keep their existing descriptive owner labels, but are selectable. Remove the
  all-slots-used refusal and its authored fact; no new field, toggle, machine
  action or translation is needed. Do not silently rewrite legacy offsets.
- `src/kernel/authoring.ts`: remove only the allOffsetsUsed field/gate from
  SetupAuthoringFacts/setupAuthoringDecision. Every other authoring fact and
  command validation remains. The existing allOffsetsUsed=true rejection test
  reflects simultaneous-fixture exclusivity, not the ordered sequential-load
  capability; submit that exact oracle change to the independent judge with P11
  and the retained combined/live safeguards. No assertion is changed here.
- `src/lib/post/postProject.ts`: scope cross-setup offset conflicts to a combined
  output. Separate outputs each retain resolveSetupWorkOffset, stock binding,
  stock consistency, freshness, supported-post and per-file validation. Do not
  remove a per-setup error just because other files can post. Keep existing
  all-or-nothing result handling for an invalid selected setup. Allocate unique
  case-insensitive default filenames across all emitted separate files, including
  nothing-to-cut files; retain existing names when unique. Use setup identity
  for association and a sanitized setup label with deterministic collision
  suffixes for human-readable names. Cover equal names, punctuation, case-only
  differences and suffix-like names. No G-code, operation order, context or
  combined-emission change.

Named new tests to grant:

- `src/tests/post/singleMachineBeds.wo2950.test.ts`: repeated G54 on distinct
  stocks posts separately, refuses combined, matches posting each setup alone,
  and produces unique default names. Same-stock/same-slot, empty/nothing-to-cut,
  disabled/selected operations, origin binding and context ownership controls.
- `src/tests/store/singleMachineBedsReopen.wo2950.test.ts`: two independent
  beds through actual create/update/save/open/rehydrate routes, selection cleanup,
  stock/origin/operation isolation, suppression/reorder/delete/undo and intentional
  shared-stock/flip controls. Use existing public store APIs; no new store writer.
- `src/tests/components/singleMachineBedsFlow.wo2950.test.tsx`: existing SetupModal
  and DesignTree selection plus PostProcessModal Separate choice/download and
  setup-sheet file association, including selected-subset and hand-edit identity.
  Use existing production components and meaningful fixtures, not a mock bed UI.
- Existing tests to grant narrowly:
  `src/tests/kernel/authoring.wo2914.test.ts` and
  `src/tests/kernel/camCommands.wo2914.test.ts` for the changed fact and retained
  capability gates; `src/tests/components/SetupModal.smoke.test.tsx` for existing
  same-stock/legacy-offset behavior. Do not weaken stock, height or flip oracles.
- `src/tests/evidence/WO-2950/`: focused outputs, application captures, source
  identities and any failing-old/passing-new proof required for the actual fix.
- `docs/design/WO-2950-single-machine-beds.md` and this order's result metadata.

Proposed named verification slice: those three new files, the three explicitly
owned existing test files above, and read-only existing
`src/tests/post/postProject.test.ts` (seven named files). Run a standard build for the product
change. Reuse unchanged frame/stock evidence rather than running their entire
suites. Include the stock owner's named cross-domain lifecycle regression only
if a focused failure identifies a stock-domain risk; log that concrete reason
and reconcile the allocation first. Capture the existing user flow through the
application entry point in headless Chromium for Tier 2 evidence. Preserve
independent adversarial source audit/review before landing.

No DesignTree, store, WCS resolver, schema, translations, live
session, controller, bridge or hardware edit is expected in that first slice.
If a test reveals another product defect requiring one, preserve the branch
and request its exact path allocation; do not widen the lease silently. The
first product outcome is a usable, independently exported load set through the
existing setup flow, not another unused bed data type.

Condition-consumer audit for that proposed allocation: allOffsetsUsed has two
production owners/consumers (SetupModal and kernel/authoring), with the typed
facts consumed by kernel/camCommands and the modal's canSave/submit checks.
Its only executable test consumers are the two named kernel tests above; other
search hits are historical evidence. Both option-disabled and all-slots-full
routes need the authoring change. defaultFixtureForStock remains a preference,
not an identity authority. Shared workOffsets helpers, setStockFixtureOffset,
combined post conflict checks, live duplicate-WCS checks, second-side lock and
stock-binding validation remain valid for their existing routes and need no
condition change. The discovery searches include each route; this is broader
than the two initial read-only analogs.

## Validation matrix and adversarial review

The following are required future observations, not passing test claims.

| Counterexample | Expected behavior / measurement |
| --- | --- |
| Same dimensions/name/G54, different stocks A and B | Distinct setup/stock identity. Separate succeeds after the scoped change; combined retains DUPLICATE_WORK_OFFSET. Each file equals its single-setup emission, apart from intentionally different metadata. |
| Six occupied slots and a seventh independent load | Setup authoring still permits the capable separate-load workflow, with an explicitly chosen valid slot and retained height/stock/flip checks. No new six-bed cap or automatic renumbering. |
| Bed A at (0,0,0), bed B translated and yawed | WCS-local points and stock top belong to their own bed; verify point/vector round trips with the shared frame service and compare each file with its same-pose single-setup baseline. No second application of PhysicalStock.position. |
| Edit A's stock height/origin or disable/delete/reorder an A operation | B's authored fields/operations unchanged. A's relevant generation/material suffix invalidates. Compare semantic fields and geometric bounds, not status strings alone. |
| Switch A -> B with an A operation or stock selected | B becomes active; active operation and conflicting Properties/gizmo selection clear. No stock movement, program staging or controller call. |
| Two independently placed instances of one model | Independent placements/references explicitly authored; moving one does not silently move the other. Reusing one shared placement intentionally changes its dependents and is not promised isolation. |
| '__all__', named geometry, nest seed, locked model stock and unassigned geometry | Ownership resolves through current readers. No cross-bed aggregate capture or silent fallback; unsupported/mismatched inputs retain their real diagnostic. |
| A flip or several setups intentionally share stock | Preserve flipOf and shared-stock meaning, current offset resolution and representation limits; never initialize a second independent material block implicitly. |
| Save/open and browser recovery; invalid active id; delete active bed; undo/redo | All authored memberships/bindings survive; active selection follows existing normalization (may be null). No guessed replacement bed or stale async publication. Check same-id reload via the delivered stock authority. |
| Export B only, then A+B; partial operations; hand edits | Correct selected setupId/op set in spans/context/downloads/sheets. Unselected A never enters B. Cached edits remain keyed to identity and selection. |
| Equal default filenames, case variants, punctuation and empty/no-cut setups | Every emitted default file name unique within the batch on Windows. Unique historical names retained. Empty skipped setups add no file; no-cut output follows existing semantics. Operator-specified names remain explicit. |
| Existing valid combined output and live multi-setup geometry path | Before/after G-code and plan/hold semantics unchanged. No new automatic action, removed stop or changed retract. Independent load support does not authorize a live load sequencer. |

Self-adversarial review rejected four tempting shortcuts: stock.id is not bed.id
(flip sharing), G54 is not identity (successive loads), Setup.stock is not the
physical stock registry, and an isolated post helper fixture is not evidence of
the complete application save/export flow. Found-source behavior is recorded
without running broad tests or claiming an independent judge verdict. The normal
lane audit remains independent.

Motion classification: discovery changes no motion; the planned separate-export
scope restores the explicitly ordered independent-load capability and preserves
each setup's emitted motion. No before/after motion card is required for this
text-only phase. No board readback, machine operation, public message, push or
landing is claimed or requested.

## Discovery verification

Declared test-slice is empty. Actual behavior-test count: 0 run, 0 passed,
0 failed; no build needed for design/evidence text. Source references, symbol
anchors and captured consumer searches are checked by the evidence verification
command. The npm check dry run is recorded; its unconditional repository-wide
TypeScript build would exceed this order's binding empty slice, so the actual
completion check is not executed and no executable receipt is fabricated.
