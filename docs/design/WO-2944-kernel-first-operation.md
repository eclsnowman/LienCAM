# WO-2944 Face pilot: implementation boundary

## Plan recorded before implementation

Select Face, using the actual `buildFaceToolpath` in
`src/lib/cam/face2d/index.ts`. It already takes resolved world-XY loops and
WCS-relative height numbers. The existing worker awaits `ensureClipperReady`
before calling it. Reusing that algorithm preserves containment, largest-loop
selection, rest holes, tool hand, offsets, pass spacing, finish passes and links.
This is an adapter integration; no improved cutting algorithm is claimed.

Implement `src/kernel/planners/face.ts` with a required injected resolver, the
existing builder/readiness functions, the WO-2931 Face geometry service and the
WO-2932 tool model. The resolver receives those shared services and returns the
existing resolved payload (excluding identity/tool, supplied from PlanningInput),
both existing height metadata objects, and an opaque shared frame token. A
required caller assertion checks frame W/mm, identity/revision and snapshot
currency before work and after asynchronous boundaries. Do not define another
FrameRef or any stock representation here. WO-2945 supplies the actual frame
type/check; WO-2953 supplies current-material/rest readiness where needed.

No global registration: the store selector currently runs BEFORE its geometry,
height, stock, reach and workholding preparation. An invented resolver here would
bypass those authorities. A locally composed router can execute this real planner
in kernel or shadow mode. Resolver/geometry/WASM/build failures propagate without
invoking current planning or publishing partial moves. Current defaults and other
families remain unchanged. Global unregistered-family policy is unchanged.

The tool service carries the explicitly selected tool verbatim into the builder;
it does not select a substitute, infer capabilities or change feeds. Geometry
services remain available at resolution and shadow measurement boundaries. The
builder's internal native offsets are deliberately not replaced: that would need
ownership of face2d and a separate fidelity proof. In particular the native miter
fill offset must not be silently swapped for the round Face profile.

## Condition/consumer discovery

Read neighboring incidents in face2d (ADR-0015 outward overrun, SKC-47-R2 no
closed loop, WO-1820 presence-vs-absence of regionHoles, CAM-14 fidelity), the
store's WO-2904 selector, WO-1819 manifest, rest dispatch and publication blocks,
and `toolpathWorker.ts` COMPUTE_FACE. No existing condition changes.

Routes checked: direct builder and worker both reuse the exact builder; new
headless planner injects the same readiness/build functions; store generation
and preview retain their existing geometry/heights/rest/reach authorities;
headless registry and UI/phone consumers retain current planning because the
global registry stays empty. Simulator, post and controller routes are untouched.
`tools/proven.json` pins probing, not this new adapter. No approved routine is
changed; no before/after motion card is required under rule 11.

## Measured acceptance and limits

The named focused test compares direct existing-builder output and the injected
planner on stock rectangle, translated WCS, rotated passes, concave boundary,
inside containment, offset rings, left-hand one-way, stepped finish and resolved
rest holes. These are real builder outputs from unit inputs, NOT application
entry-point or board evidence. Capture input/output and metrics in this order's
evidence directory. Use physical metrics, not blanket byte equality:

- Coverage/residual: sample material at 1 mm cell centers using the shared Face
  geometry predicate, exclude supplied rest holes; measure distance to bottom
  cut segments minus cutter radius. Residual fraction must not increase; max
  residual distance tolerance 0.005 mm (native CAM-14 total fidelity ceiling).
  This is sampled coverage, not an exhaustive swept-volume certificate.
- Gouge: deepest cutting endpoint below requested bottom must remain zero within
  1e-9 mm. This checks flat-bottom axial gouge, not holder/body collision.
- Clearance: minimum horizontal rapid height minus resolved retract; no new
  deficit over 1e-9 mm. First positioning move has no known preceding location.
- Engagement: retain supplied engagement maxima and count missing cut values;
  missing is unknown, never zero. No stock-derived engagement is fabricated.
- Direction: cut travel projection along the requested pass angle, separated
  into positive/negative length. Preserve within 1e-6 mm; independent one-way
  tool-hand controls must have the correct sign.
- Travel/time: cut, link and rapid lengths within 1e-6 mm; use the existing arc
  sampler for spatial measures and native runtime estimator for cycle time.
  Time tolerance 0.01 ms. Air time is rapid/link time only, not inferred air cuts.
- Latency: capture warmed elapsed generation time separately, enforce a generous
  5 second per-case ceiling; no relative speed claim from short/noisy runs.
- Memory: record serialized move bytes as retained-output size, not heap/RSS;
  no growth beyond max(1 KiB, 5%) versus current. Peak WASM memory remains owed.

## Production grant and rollout

This is working planner code, but full feature delivery still requires actual
production router wiring and application proof. Proposed next grant:
`src/store/index.ts` (after WO-2945 releases it), `src/kernel/planning.ts`, this
planner, and `src/tests/store/faceKernelPilot.wo2944.test.ts`.

Exact seams: extract the existing common Face resolution from the callback at
`engineRouter.plan` through `computeRoute.buildRequest`, retaining every current
early return and resolved-height/reach/workholding field. Produce one prepared
Face request plus height metadata/frame revision before choosing the engine;
pass it to the injected resolver, never repeat the legacy compute callback to
obtain inputs. Reuse the existing worker's complete postprocessing (holder/reach
checks included), not only its raw Face builder, for production publication.
Keep non-Face preparation/dispatch in its existing callback. Register Face only
when this complete resolver exists, then bind the same engineId to
`setGenerationEngineResolver`. Assert currency again at store publication.

First rollout is explicit shadow mode retaining current moves. Application-entry
tests must cover stock/geometry/model/rest boundaries, SmartHeight and manual
heights, translated/yawed setups, disabled predecessors, stale async results,
reach/workholding, errors, and fingerprint invalidation. Rest/current-material
cases wait for the WO-2953 contract, not the non-stock pilot. Then explicit kernel
mode can publish via the current completion/runtime/fingerprint path. No default
switch in this phase. Rollback selects current and invalidates engine-dependent
fingerprints; remove Face registration if the resolver is withdrawn. No V3,
controller frame conversion, UI/MCP rollout, machine operation or landing here.

## Approved application phase plan (2026-10-18)

Preserve the reviewed adapter. Move Face engine selection to the existing fully
resolved manifest request, after geometry, SmartHeight/manual intent, selected
tool, stock, holder, reach and workholding preparation. Keep the native worker
transport and one publication/fingerprint/runtime/batch path. The worker composes
a complete Face planner with shared geometry/tool services and native readiness,
then applies its existing complete postprocessing on both routes. Shadow runs
both through that boundary and returns current as authoritative, with kernel
moves attached only as comparison evidence. Explicit kernel errors never invoke
current as a recovery. Current is still the default and other families retain
current dispatch. A pure shared selector keeps fingerprint identity consistent
with the worker registration; no partial global resolver is registered.

The worker envelope carries the accepted FrameRef world identity, a dispatch
revision derived from the existing generation fingerprint, the prepared height
metadata and immutable planning input. The store verifies live request currency
before dispatch and before handling ANY terminal pilot response, including
errors; an old job/project completion must not overwrite a newer operation.
No controller frame conversion is performed. The snapshot assertion in the
worker supplements, and cannot replace, the store's live currency assertion.

Until WO-2953 is accepted, explicit pilot routes requiring prior material or
rest subtraction refuse precisely before dispatch; legacy current retains its
behavior. Disabled predecessors do not themselves imply removed stock. Initial
stock and manual/explicit-depth Face paths use existing height/stock authorities.
Tests will call computeOperationToolpath and the real worker, inspect current,
shadow and kernel outputs, and capture numeric evidence rather than claim any
rendered interface change. Reuse the reviewed adapter/coordinate tests; run only
the two allocated test files and a product build. npm check's related-store
expansion exceeds this order, so inspect its plan and use focused checks instead.

## Delivered application phase and exact stock handoff

The store now prepares the native manifest request once before attaching an
explicit Face pilot envelope. The envelope uses WO-2945 FrameRef world/mm with
project identity and the existing generation fingerprint as its revision. The
worker locally registers the complete injected Face planner; its build dependency
uses the SAME native builder and complete holder/reach/workholding response
closure as current. No partial resolver or global Face singleton is installed.
The global router remains available to other registered families unchanged.

Shadow returns current moves plus a non-authoritative faceShadow comparison
stream; explicit kernel returns the kernel planner's postprocessed moves. Both
reach the store's existing ready/error/runtime/notices/shortfall/batch publication
path. Face request tokens supplement the existing live fingerprint and project
compute generation, covering late errors as well as late successes and newer
identical requests. The complete input snapshot is diagnostic overhead; measured
serialized output size is not total request/worker heap usage.

Rollout remains opt-in. Node composition reads LIENCAM_ENGINE; the Vite/browser
composition reads VITE_LIENCAM_ENGINE (current, both, kernel). No setting means
current. Set current and regenerate to roll back; the engine identity makes
old both/kernel fingerprints stale. There is no UI/MCP switch or default change.
An unsupported explicit pilot capability returns its error with no fallback.

WO-2953 handoff: replace the bounded pre-dispatch refusal for rest or any enabled
prior operation only after its accepted canonical enabled-operation material
contract supplies the resolution. Carry that authority through Face SmartHeight
current-material start, rest region subtraction, remainingStock reach inputs and
the predecessor-dependent fingerprint, rather than add a separate replay. Preserve
absent versus present-empty rest holes. Legacy current retains all its existing
stock behavior. Disabled predecessors and first-operation initial stock already
work through the delivered pilot. No whole-order wait blocks those routes.

Numeric application-entry evidence is application-comparison.json. Geometry,
manual intent, selected hand/feed, translated/yawed setup, enabled/disabled prior
operations, holder trim, real workholding, explicit errors, rollback, stale
completion/project replacement and late older error are exercised in the named
store test. The intentionally divergent shadow transport control is a control,
not an input/output claim about the normal application. No rendered interface or
machine result is claimed, so no screenshot or controller readback is asserted.


## Fix round 1 plan and condition-consumer discovery (2026-10-18)

Authority: architect assignment at 6:41 PM CT in the WO, preserving the existing
application implementation and prior grants. F1 is a terminal lifecycle defect,
not a machining-method change. The operator's P3 application approval, WO-2588 pins in
tools/proven.json and machine handoff section 7 were checked before setting the
oracle: a dead, still-owned edited request must become outdated; an obsolete
request must preserve the replacement's state. No probing/controller code or
approved motion is affected, so no motion card is owed.

Before editing conditions, searched every faceRequestToken, faceOwnsRequest and
faceInputsCurrent consumer in store/index.ts and read their neighboring incident
comments plus computeWatchdog.ts and the existing WO-2904 watchdog controls.
Routes and decisions:

- Current, both and kernel Face use this same worker lifecycle. All three need
  browser-error and watchdog stale-input handling; no engine/default change.
- onmessage already separates ownership from fingerprint currency for progress,
  success, TOOLPATH_ERROR and unknown messages. Reuse its exact outdated update
  through one local helper; retain settlement and late-message suppression.
- Worker.onerror currently settles stale requests without an outdated update.
  Apply that helper before settlement; current-input errors retain their detail.
- Watchdog rejection currently suppresses stale state updates. Apply the same
  helper in its rejection handler; onTimeout already terminates and resolves the
  worker exactly once. Timer ordering rejects before onTimeout resolves done.
- Pre-dispatch input check, request token assignment, project identity and compute
  generation checks remain unchanged. They establish ownership/currency rather
  than consume a terminal worker event.
- Other operation families have no Face token. Preserve their existing worker
  error, timeout and router behavior; other 3D watchdog instances are separate.
- Common operation status/fingerprint and stageOperationsForEmission consumers
  already understand outdated and clear unavailable output. No new status or
  change to post/simulation/phone/controller consumers is needed.

Add controlled real-store/real-worker tests for both terminal events on all
three engines: edited input becomes outdated, current input becomes error,
newer pending and ready requests remain intact, and project replacement remains
intact. Preserve the earlier late TOOLPATH_ERROR and all 37 pilot checks. Run the
new edited-input assertions on old source first, capture every red, then fix and
commit passing source before committing source-bound old/new proof. Run exactly
the two declared test files, focused ESLint and a product build. Inspect npm check
with --dry-run; its related-store expansion is outside the binding slice. Reuse
unchanged numeric/coordinate evidence; make no new physical or visual claim.
