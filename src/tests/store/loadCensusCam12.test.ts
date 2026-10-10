// CAM-12 - GREEN means a toolpath EXISTS and is current, never a persisted
// claim taken on faith (coordination/evidence/CAM-12/FINDINGS.md, binding
// directive). This exercises the load-boundary census through the REAL paths,
// which DIVERGE:
//
//   REFRESH leg (localStorage): persistPartialize -> JSON string round trip ->
//     persistMigrate -> persistMerge (the exact exported trio the persist
//     middleware runs). persistPartialize STRIPS toolpathMoves but keeps status
//     + cut metrics -> the stale-green lie in Operator's screenshot.
//   FILE leg (.camproject): the saveProjectToFile snapshot shape (the live
//     project spread verbatim, INCLUDING toolpathMoves) -> loadProjectFromFile.
//     A normally-saved file carries real moves and stays truthfully green.
//
// Can-fail (mutation): the refresh + file-after-refresh + computing assertions
// FAIL against the pre-CAM-12 store (op stays 'ready'/'computing' with metrics);
// the file-truthful assertion FAILS if the census is replaced by a blanket
// flip-and-clear (it would destroy the file's valid moves - a named bounce).

import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  useCamStore,
  machineActionsOf,
  setupListOrder,
  persistPartialize,
  persistMerge,
  persistMigrate,
  reconcileLoadedOpLifecycle,
  outdatedReasonText,
} from '../../store'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../../store/migrations/projectMigrations'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'
import type { FeedrateOverride, Operation, Project, Setup, Stock, Vec3, WCS } from '../../types'
import { collectToolpathSections } from '../../lib/cam/nesting/nestRuntime'
import { buildFrames, resolvePlaybackPosition, syncStockSimSurface } from '../../components/simulation/SimulationPanel'
import { buildPostInput, operatorStopsFromActions } from '../../lib/post/buildPostInput'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { g10Line } from '../../lib/post/coords'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import { deriveOriginBindingForTest } from '../../store/migrateHierarchy'
import { matchesFilter } from '../../components/panels/treeFilter'
import { validatePersistedSmartHeightState } from '../../lib/cam/smartHeights/authority'
import { reconcileProjectGenerationFreshness } from '../../lib/cam/generationFingerprint'
import { resolveSetupSupportPlane } from '../../lib/cam/types'
import { planSecondSideSetup } from '../../lib/cam/flipSetup'
import { holdingMethodLabel, isHoldingMethodId } from '../../lib/workholding/holdingMethods'
import { isValidReachShortfall } from '../../components/cam/ReachShortfallNotice'
import { CENSUS as COMMITTED_CENSUS } from './setupClosureCensus'

// WO-2438 added Setup.holdingMethod after the committed table was last cut. The table file
// (setupClosureCensus.ts) is not in WO-2458's grant, so its row is declared here and merged;
// every check below sees one combined census.
const CENSUS = [
  ...COMMITTED_CENSUS,
  {
    path: 'Setup.holdingMethod',
    category: 'tolerated' as const,
    rule: "WO-2438 information-only holding method (no cut, keep-out or post output). Read by SetupPanel (`setup.holdingMethod ?? ''` as a select value; writes go through isHoldingMethodId) and holdingMethodLabel's table .find (an === compare); neither throws on any runtime type, so a wrong-typed value reads as 'no method'.",
  },
  // WO-2620: WO-2437 added Setup.machineActions (operator stops) after the table was cut.
  {
    path: 'Setup.machineActions',
    category: 'tolerated' as const,
    rule: "WO-2437 machine actions (operator stops). Every reader Array.isArray-guards the field: machineActionsOf (store/index.ts, the DesignTree/PropertiesPanel/store-action route), operatorStopsFromActions (lib/post/buildPostInput.ts, post time) and setupHasOperatorStops (lib/machine/machineSession.ts, Control load) - a non-array value reads as no actions. Object-shaped malformed elements read as non-stops or orphan rows (=== / .has compares only). A null/undefined ELEMENT is not guarded (setupListOrder reads `action.afterOpId`) - recorded in WO-2620's result, not blessed here.",
  },
] as typeof COMMITTED_CENSUS
const CENSUS_PATHS = new Set(CENSUS.map((e) => e.path))

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const RECT_STOCK: Stock = {
  type: 'rectangular', width: 100, height: 100, depth: 20,
  offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
}

/** A migrate-compatible project (spread from the already-migrated default so
 *  migrateProjectData short-circuits) carrying the given ops in one setup. */
function projectWithOps(ops: Operation[]): Project {
  const base = useCamStore.getState().project
  const setup: Setup = {
    id: 's-cam12', name: 'Setup 1', wcs: makeWcs(),
    stock: RECT_STOCK, operations: ops, notes: '',
  }
  return {
    ...base,
    id: 'proj-cam12', name: 'CAM-12 Fixture',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    setups: [setup], activeSetupId: setup.id, activeOperationId: null,
  }
}

/** A migrate-compatible project (same short-circuit as projectWithOps) whose
 *  `setups` array is exactly the given raw, possibly-malformed entries. Used
 *  by the CAM-12-R2 setup-level fuzz + refresh-boundary suite below. */
function projectWithSetups(rawSetups: unknown[], activeSetupId: string | null = null): Project {
  const base = useCamStore.getState().project
  return {
    ...base,
    id: 'proj-cam12-r2', name: 'CAM-12-R2 Fixture',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    setups: rawSetups as Setup[], activeSetupId, activeOperationId: null,
  }
}

/** Drive the REAL rehydrate boundary starting from an ALREADY-PERSISTED blob:
 *  persistMigrate -> persistMerge, with no persistPartialize step. This is the
 *  auditor's own reproduction method for a malformed SETUP record ("Reproduced
 *  through the real persistMigrate -> persistMerge boundary...") and matches
 *  the real-world entry point: a malformed record arrives as a corrupted or
 *  hand-edited localStorage blob, never by re-serializing already-malformed
 *  LIVE state (persistPartialize's `setup.operations.map(...)` assumes its
 *  input is well-formed live state - a separate, write-side concern this WO
 *  does not touch; a malformed record cannot reach persistPartialize because
 *  this WO's fix keeps one from ever entering live state in the first place). */
function rehydrateRoundTrip(project: Project) {
  const current = useCamStore.getState()
  const migratedState = persistMigrate({ project }, CURRENT_PROJECT_SCHEMA_VERSION)
  const merged = persistMerge(migratedState, current)
  return { merged }
}

/** Drive the REAL browser-refresh path end to end. */
function refreshRoundTrip(project: Project) {
  const current = useCamStore.getState()
  const s = { ...current, project } as typeof current
  const partialized = persistPartialize(s)
  const roundTripped = JSON.parse(JSON.stringify(partialized))
  const migratedState = persistMigrate(roundTripped, CURRENT_PROJECT_SCHEMA_VERSION)
  const merged = persistMerge(migratedState, current)
  return { partialized, merged }
}

describe('CAM-12 refresh leg (localStorage rehydrate)', () => {
  it('a ready op with moves rehydrates as needs-regen (not green) with metrics cleared', () => {
    const readyOp = makeOp({
      id: 'op-ready', name: '3D Rough 2', status: 'ready',
      toolpathMoves: [move(), move({ x: 1 })],
      computeTimeMs: 16700, estimatedCutTimeMs: 276000,
    })
    const { partialized, merged } = refreshRoundTrip(projectWithOps([readyOp]))

    // Root cause reproduced: persistPartialize really strips the moves (its
    // return type omits the field, hence the cast to read it back).
    const strippedOp = partialized.project.setups[0].operations[0] as { toolpathMoves?: unknown }
    expect(strippedOp.toolpathMoves).toBeUndefined()

    // ...and green does NOT survive without moves.
    const op = merged.project.setups[0].operations[0]
    expect(op.status).toBe('outdated')
    expect(op.toolpathMoves == null || op.toolpathMoves.length === 0).toBe(true)
    expect(op.computeTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()

    // Visible downgrade: a single load notice was recorded.
    expect(merged.consoleEvents.some((e) => e.source === 'load')).toBe(true)
  })

  it('a persisted computing op heals to a non-computing needs-regen state', () => {
    const computingOp = makeOp({
      id: 'op-comp', status: 'computing', progress: 0.5, progressPhase: 'Z level 2/4',
      toolpathMoves: [],
    })
    const { merged } = refreshRoundTrip(projectWithOps([computingOp]))
    const op = merged.project.setups[0].operations[0]
    expect(op.status).not.toBe('computing')
    expect(op.status).toBe('outdated')
    expect(op.progress).toBeUndefined()
    expect(op.progressPhase).toBeUndefined()
  })
})

describe('CAM-12 file leg (.camproject open)', () => {
  beforeEach(() => {
    // A viewport handle may leak between tests; there is none in jsdom, so
    // loadProjectFromFile skips the scene rebuild. Reset console noise.
    useCamStore.setState({ consoleEvents: [] })
  })

  it('a saved file with real moves stays green and KEEPS its moves (anti-bounce)', () => {
    // cutHand: 'right' pre-normalized so migrateProjectToolCutHands' always-run
    // step (projectMigrations.ts) is a byte-identical no-op -- otherwise it
    // backfills `cutHand` onto the round-tripped tool and the recomputed
    // fingerprint would mismatch the one stamped below for a reason that has
    // nothing to do with this test's own toolpath-freshness concern.
    const tool = makeTool({ cutHand: 'right' })
    const readyOp = makeOp({
      id: 'op-ready', status: 'ready',
      toolpathMoves: [move(), move({ x: 5 })],
      computeTimeMs: 1000, estimatedCutTimeMs: 5000,
    })
    const project = { ...projectWithOps([readyOp]), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, toolLibrary: [tool] }
    // CAM-15 (52ac9e3e7): a 'ready' op must carry a fingerprint-current
    // generation stamp or the file-open reconcile downgrades it as unverified
    // - stamp it against this EXACT project/setup/tool so the anti-bounce
    // fixture actually represents "computed and never touched since", not a
    // pre-CAM-15 legacy record (a different, already-covered scenario).
    stampGenerationCurrent(project, project.setups[0], readyOp, tool)
    const fileJson = JSON.stringify(project)
    useCamStore.getState().loadProjectFromFile(fileJson)
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.status).toBe('ready')            // green survives
    expect(op.toolpathMoves?.length).toBe(2)   // moves NOT destroyed
    expect(op.computeTimeMs).toBe(1000)        // metrics intact
  })

  it('a file saved AFTER a refresh (ready + no moves) is downgraded, not shown green', () => {
    const staleGreen = makeOp({
      id: 'op-stale', status: 'ready', toolpathMoves: [],
      computeTimeMs: 16700, estimatedCutTimeMs: 276000,
    })
    const fileJson = JSON.stringify({
      ...projectWithOps([staleGreen]), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    })
    useCamStore.getState().loadProjectFromFile(fileJson)
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.status).toBe('outdated')
    expect(op.computeTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()
  })
})

describe('CAM-12 census: non-ready statuses keep their semantics', () => {
  it('degraded keeps its last-known moves; pending/outdated/error untouched', () => {
    const degraded = makeOp({ id: 'd', status: 'degraded', toolpathMoves: [move(), move()] })
    const pending = makeOp({ id: 'p', status: 'pending', toolpathMoves: [] })
    const outdated = makeOp({ id: 'o', status: 'outdated', toolpathMoves: [move()] })
    const errored = makeOp({ id: 'e', status: 'error', errorMessage: 'boom', toolpathMoves: [] })
    const { project: out, downgrades } = reconcileLoadedOpLifecycle(
      projectWithOps([degraded, pending, outdated, errored]),
    )
    const [d, p, o, e] = out.setups[0].operations
    expect(d.status).toBe('degraded')
    expect(d.toolpathMoves?.length).toBe(2) // KEEPS last-known toolpath
    expect(p.status).toBe('pending')
    expect(o.status).toBe('outdated')
    expect(o.toolpathMoves?.length).toBe(1)
    expect(e.status).toBe('error')
    expect(e.errorMessage).toBe('boom')
    expect(downgrades).toHaveLength(0)
  })

  it('a ready op with a NaN coordinate is treated as no-toolpath (charter bar 3)', () => {
    // A NaN sails through numeric comparisons silently; the census validates
    // finite x/y/z, not just a non-empty length. (In memory NaN is preserved;
    // a hand-edited file yields null coords, which are likewise non-finite.)
    const nanOp = makeOp({ id: 'nan', status: 'ready', toolpathMoves: [move({ x: NaN })] })
    const { project: out, downgrades } = reconcileLoadedOpLifecycle(projectWithOps([nanOp]))
    const op = out.setups[0].operations[0]
    expect(op.status).toBe('outdated')
    expect(downgrades).toHaveLength(1)
    expect(downgrades[0].reason).toBe('no-toolpath')
    // R1 major: the downgrade must CLEAR the invalid moves in the SAME object,
    // not merely flip status - a retained non-empty NaN array still reaches
    // collectToolpathSections (status-blind) behind the honest-looking status.
    expect(op.toolpathMoves == null || op.toolpathMoves.length === 0).toBe(true)
  })
})

// ============================================================
// R1 rework - the audit's major: a downgrade that flips status but retains
// the invalid non-empty moves array is not a real fix, because
// collectToolpathSections (which drives BOTH SimulationPanel and
// buildPostInput) selects by enabled + non-empty moves, NOT by status. This
// exercises the census's fix THROUGH those real consumers, plus the audit's
// required fuzz set (moves:null, moves:[{x:NaN}], status:undefined, a null
// operation record) end to end with no throw.
// ============================================================

/** A minimal, self-contained Project (no store default dependency) for the
 *  fuzz cases, so each case controls exactly what reaches the census. */
function fuzzProject(rawOps: unknown[]): Project {
  const setup = {
    id: 's-fuzz', name: 'Setup 1', wcs: makeWcs(),
    stock: RECT_STOCK, operations: rawOps, notes: '',
  } as unknown as Setup
  return {
    id: 'proj-fuzz', name: 'Fuzz', version: '1', createdAt: '', updatedAt: '',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  } as unknown as Project
}

describe('CAM-12-R1: a downgraded malformed op contributes ZERO frames through the real SimulationPanel selection path', () => {
  it('a ready op downgraded for NaN-coordinate moves produces zero sim sections and zero frames', () => {
    const nanOp = makeOp({
      id: 'nan-2move', name: 'NaN Rough', status: 'ready',
      toolpathMoves: [move({ x: NaN }), move({ x: 5, y: NaN })],
    })
    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(fuzzProject([nanOp]))
    expect(downgrades).toHaveLength(1)
    const op = reconciled.setups[0].operations[0]
    expect(op.status).toBe('outdated')
    expect(op.toolpathMoves == null || op.toolpathMoves.length === 0).toBe(true)

    // Mirror SimulationPanel's real selection (SimulationPanel.tsx): every
    // enabled op, NO status filter, fed straight into collectToolpathSections.
    const allOps = reconciled.setups[0].operations.filter((o) => o.enabled)
    const sections = collectToolpathSections(allOps, reconciled.geometry, reconciled.nests)
    expect(sections).toHaveLength(0) // no section => buildFrames never sees the NaN moves

    const frames = sections.flatMap((sec) => buildFrames(sec.moves, 5000).frames)
    expect(frames).toHaveLength(0)
  })

  // The census + SimulationPanel selection chain (reconcile -> collect
  // sections -> build frames) is the load/render boundary this WO owns, and
  // it must NEVER throw for any of these four records (a throw here lands on
  // the rehydrate/first-render path -> ErrorBoundary -> deletes the project).
  it.each([
    { label: 'moves:null', op: makeOp({ id: 'a', status: 'ready', toolpathMoves: null as unknown as undefined }) },
    { label: 'moves:[{x:NaN}]', op: makeOp({ id: 'b', status: 'ready', toolpathMoves: [move({ x: NaN })] }) },
    { label: 'status:undefined', op: makeOp({ id: 'c', status: undefined as unknown as Operation['status'] }) },
    { label: 'null op record', op: null },
  ])('fuzz case ($label) reconciles and simulates with no throw end to end', ({ op }) => {
    const project = fuzzProject([op])
    expect(() => {
      const { project: reconciled } = reconcileLoadedOpLifecycle(project)
      const setup = reconciled.setups[0]
      const allOps = setup.operations.filter((o) => o.enabled)
      const sections = collectToolpathSections(allOps, reconciled.geometry, reconciled.nests)
      for (const sec of sections) buildFrames(sec.moves, 5000)
    }).not.toThrow()
  })

  // Post-time coverage for the same three records the census actually HEALS
  // to a valid, known status ('outdated' with moves cleared, or dropped
  // entirely) - buildPostInput/postProgram must refuse them loud, never post
  // a cut-free/malformed program. 'status:undefined' is deliberately excluded
  // here: the census leaves an out-of-contract status value untouched (same
  // as any other status outside its named posture), and validate.ts's
  // compiler-enforced exhaustiveness switch THEN intentionally throws for it
  // (src/lib/post/validate.ts, "a new OperationStatus that reaches the post
  // gate un-handled is a build error, never a silent fall-through that would
  // post an unvalidated op" - pre-existing CAM-1 design, not this WO's
  // remit). That throw is USER-INITIATED post time, not the automatic
  // rehydrate path, and is already caught at the UI boundary
  // (PostProcessModal.tsx's postProject try/catch -> POST_THREW diagnostic),
  // so it carries none of the ErrorBoundary data-loss risk this WO closes.
  it.each([
    { label: 'moves:null', op: makeOp({ id: 'a', status: 'ready', toolpathMoves: null as unknown as undefined }) },
    { label: 'moves:[{x:NaN}]', op: makeOp({ id: 'b', status: 'ready', toolpathMoves: [move({ x: NaN })] }) },
    { label: 'null op record', op: null },
  ])('fuzz case ($label) reconciles and posts with no throw, refusing loud', ({ op }) => {
    const project = fuzzProject([op])
    expect(() => {
      const { project: reconciled } = reconcileLoadedOpLifecycle(project)
      const setup = reconciled.setups[0]
      const input = buildPostInput(reconciled, setup)
      const result = postProgram(input, UCCNC_CONFIG)
      // A dropped/healed record produces no cutting moves - refuse, don't
      // silently emit a cut-free program (the ok:true failure mode CAM-12
      // closed at the post boundary).
      if (setup.operations.length > 0) {
        expect(result.ok).toBe(false)
        expect(result.gcode).toBe('')
      }
    }).not.toThrow()
  })
})

// ============================================================
// R2 rework - the re-audit's remaining major: the census recorded a
// malformed-record downgrade for a bad SETUP but returned the setup
// UNCHANGED into project.setups. On rehydrate, persistMerge therefore
// installed a null/malformed setup into live state, and SimulationPanel's
// automatic setup lookup (`setups.find(st => st.id === activeSetupId)`, whose
// predicate dereferences `st.id` on EVERY element including a null one) and
// operation-selection logic (`setup.operations.filter(...)`) then threw on
// first render - the exact ErrorBoundary/data-loss hazard CAM-12 exists to
// close, just one level up from the operation-record case R1 already fixed.
//
// Derived completeness (Setup, src/types/index.ts): id, name, wcs, stock,
// operations, notes. `operations` is the only field the census/SimulationPanel
// structurally REQUIRE to iterate (id is read but never throws on a mismatch -
// see the array-element `.find` case below, which throws for a different
// reason: the predicate runs on every element, not just the eventual match).
// The census below is fuzzed with every record shape and every operations-
// field shape a hand-edited or corrupted file/localStorage blob could carry.
// ============================================================

describe('CAM-12-R2: a malformed setup record is quarantined at the reconcile boundary, never installed into the live project', () => {
  const validSetupOf = (op: Operation): Setup => ({
    id: 's-valid', name: 'Valid Setup', wcs: makeWcs(), stock: RECT_STOCK, operations: [op], notes: '',
  })

  it.each([
    { label: 'null setup', setup: null },
    { label: 'undefined setup (a hole in the array)', setup: undefined },
    { label: 'string primitive as setup', setup: 'not-a-setup' },
    { label: 'number primitive as setup', setup: 42 },
    { label: 'array literal as setup', setup: [] },
    {
      label: 'object missing operations entirely',
      setup: { id: 's-missing-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, notes: '' },
    },
    {
      label: 'operations:null',
      setup: { id: 's-null-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: null, notes: '' },
    },
    {
      label: 'operations:undefined',
      setup: { id: 's-undef-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: undefined, notes: '' },
    },
    {
      label: 'operations:{} (plain object, not an array)',
      setup: { id: 's-obj-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: {}, notes: '' },
    },
    {
      label: 'operations:"nope" (string)',
      setup: { id: 's-str-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: 'nope', notes: '' },
    },
    {
      label: 'operations:42 (number)',
      setup: { id: 's-num-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: 42, notes: '' },
    },
    {
      label: 'operations:true (boolean)',
      setup: { id: 's-bool-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: true, notes: '' },
    },
  ])('$label is dropped with a malformed-record downgrade, and the live project never contains it', ({ setup }) => {
    const validOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move(), move({ x: 5 })] })
    const project = projectWithSetups([setup, validSetupOf(validOp)], 's-valid')

    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(project)

    expect(downgrades.some((d) => d.reason === 'malformed-record')).toBe(true)
    // Quarantined: exactly the one valid sibling remains, never the malformed
    // record returned unchanged (the R2 audit's exact defect).
    expect(reconciled.setups).toHaveLength(1)
    expect(reconciled.setups[0].id).toBe('s-valid')
    expect(reconciled.setups[0].operations[0].toolpathMoves?.length).toBe(2)
  })

  it('reads the malformed setup id into the downgrade notice when it is actually readable (ADR-0003 identity)', () => {
    const project = projectWithSetups(
      [{ id: 's-readable-id', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: {}, notes: '' }],
      's-readable-id',
    )
    const { downgrades } = reconcileLoadedOpLifecycle(project)
    expect(downgrades).toHaveLength(1)
    expect(downgrades[0].opId).toBe('s-readable-id')
  })
})

describe('CAM-12-R2: refresh-boundary through the REAL path (persistMigrate -> persistMerge -> SimulationPanel selection), no throw, no data loss', () => {
  // The auditor's exact reproductions, plus derived cases from the same
  // Setup-field census above. Each drives persistMigrate -> persistMerge
  // (the exact boundary the auditor's own reproduction used, starting from an
  // ALREADY-PERSISTED blob - rehydrateRoundTrip, not the write-side
  // persistPartialize), then exercises SimulationPanel's OWN setup lookup +
  // operation-selection logic (SimulationPanel.tsx:334/472/508) against the
  // result, exactly as written in the component.
  it.each([
    {
      label: 'null setup ([null, validSetup]) - auditor repro 1',
      setup: null,
    },
    {
      label: 'operations:null - auditor repro 2',
      setup: { id: 's-null-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: null, notes: '' },
    },
    {
      label: 'operations:{} - auditor repro 3',
      setup: { id: 's-obj-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: {}, notes: '' },
    },
    {
      label: 'undefined setup (a hole in the array) - derived',
      setup: undefined,
    },
    {
      label: 'operations:"nope" (string) - derived',
      setup: { id: 's-str-ops', name: 'x', wcs: makeWcs(), stock: RECT_STOCK, operations: 'nope', notes: '' },
    },
  ])('$label: no throw, malformed record absent from live state, visible notice, valid sibling fully usable', ({ setup }) => {
    const validOp = makeOp({
      id: 'op-sibling', status: 'ready',
      toolpathMoves: [move({ feed: 2000 }), move({ x: 5, feed: 2000 })],
    })
    const validSetup: Setup = {
      id: 's-valid', name: 'Valid Setup', wcs: makeWcs(), stock: RECT_STOCK, operations: [validOp], notes: '',
    }
    const project = projectWithSetups([setup, validSetup], 's-valid')

    let merged!: ReturnType<typeof persistMerge>
    expect(() => {
      merged = rehydrateRoundTrip(project).merged
    }).not.toThrow()

    // Not present in live state (quarantined, not returned unchanged).
    expect(merged.project.setups).toHaveLength(1)
    expect(merged.project.setups.some((s) => s == null || typeof s !== 'object')).toBe(false)

    // Visible malformed-record notice was raised.
    expect(merged.consoleEvents.some((e) => e.source === 'load')).toBe(true)

    // SimulationPanel's EXACT setup lookup (SimulationPanel.tsx:334/472): a
    // `.find` predicate that dereferences `st.id` on every array element is
    // exactly what threw on a null entry pre-fix - it must not throw now that
    // the entry is gone, and it must resolve the valid sibling.
    expect(() => {
      const setupFound = merged.project.setups.find((st) => st.id === merged.project.activeSetupId)
      expect(setupFound).toBeDefined()
      if (!setupFound) return
      // SimulationPanel.tsx:508 - the exact operation-selection expression.
      const allOps = setupFound.operations.filter((o) => o.enabled)
      expect(allOps).toHaveLength(1)
      const sections = collectToolpathSections(allOps, merged.project.geometry, merged.project.nests)
      expect(sections).toHaveLength(1)
      const frames = sections.flatMap((sec) => buildFrames(sec.moves, 5000).frames)
      expect(frames.length).toBeGreaterThan(0) // the valid sibling is fully usable
    }).not.toThrow()
  })
})

// ============================================================
// CAM-12-R3 - re-cut after the two-bounce STOP (coordination/DECISIONS.md,
// "2026-07-15 - CAM-12 two-bounce STOP: the dereference closure was never
// derived"). R1 guarded operation records; R2 guarded setup records; the R2
// audit found a THIRD same-class miss one field over - setup.wcs. The STOP
// ruling's root cause: a hand-walked consumer list cannot mechanically prove
// completeness. This section derives the closure MECHANICALLY (a real
// ts.Program AST scan, tools/deriveSetupClosure.mjs) and diffs it against the
// committed census (setupClosureCensus.ts) on every run - a dereferenced
// field missing a census entry is a RED failure NAMING the field, not a
// code-review hope.
// ============================================================

describe('CAM-12-R3: mechanical dereference-closure (STOP-ruling enforcement)', () => {
  it('the type-directed extraction over every Setup/WCS/Stock/Operation access in src/ exactly matches the committed census - no uncensused path, no stale entry, no unresolvable computed-key blind spot', () => {
    const started = performance.now()
    const output = execFileSync(
      process.execPath,
      [resolve(REPO_ROOT, 'src/tests/support/deriveSetupClosure.mjs')],
      { encoding: 'utf8', cwd: REPO_ROOT, windowsHide: true, timeout: 135_000 },
    )
    const extracted = performance.now()
    const { fieldPaths, violations } = JSON.parse(output) as {
      fieldPaths: string[]
      violations: Array<{ file: string; line: number; text: string }>
    }

    // Honesty rule (WO requirement 1): a computed bracket access on a tracked
    // type must either resolve to a finite literal union that the scanner can
    // enumerate or fail RED naming the remaining blind spot.
    expect(violations, `unresolvable computed-key blind spot(s) on a tracked type: ${JSON.stringify(violations)}`).toEqual([])

    const derived = new Set(fieldPaths)
    const missingFromCensus = fieldPaths.filter((p) => !CENSUS_PATHS.has(p))
    expect(
      missingFromCensus,
      `dereferenced in src/ but MISSING a census entry (no quarantine rule, no fuzz case): ${missingFromCensus.join(', ')}`,
    ).toEqual([])

    const staleInCensus = [...CENSUS_PATHS].filter((p) => !derived.has(p))
    expect(
      staleInCensus,
      `censused but no consumer in src/ dereferences it anymore (stale entry): ${staleInCensus.join(', ')}`,
    ).toEqual([])
    if (process.env.WO1247_PROFILE) console.log('WO1247 census ms', {
      extraction: extracted - started, comparison: performance.now() - extracted,
    })
  // WO-1247: solo 44,326 ms (2026-09-06); 135 s is approximately 3x
  // headroom for this full-source TypeScript scan. Measured phases: program
  // 8.24 s, checker 2.51 s, traversal 17.77 s. It already runs once; the
  // extractor is outside this WO's ownership. Keep every source and assertion.
  // Bound the subprocess too: a synchronous child cannot yield to Vitest's timer.
  }, 135_000)
})

describe('CAM-12-R3: setup.wcs malformed is quarantined at the reconcile boundary, never installed into the live project', () => {
  const validOpOf = (): Operation => makeOp({
    id: 'op-sibling', status: 'ready', toolpathMoves: [move({ feed: 2000 }), move({ x: 5, feed: 2000 })],
  })
  const validSetupOf = (): Setup => ({
    id: 's-valid', name: 'Valid Setup', wcs: makeWcs(), stock: RECT_STOCK, operations: [validOpOf()], notes: '',
  })

  it.each([
    { label: 'wcs:null', wcs: null },
    { label: 'wcs:undefined (key present, undefined)', wcs: undefined },
    { label: 'wcs:"not-an-object" (string)', wcs: 'not-an-object' },
    { label: 'wcs:42 (number)', wcs: 42 },
    { label: 'wcs:[] (array)', wcs: [] },
    { label: 'wcs:{} (missing origin/axes entirely)', wcs: {} },
    { label: 'wcs.origin:null (axes otherwise valid)', wcs: { ...makeWcs(), origin: null } },
    { label: 'wcs.origin:{} (missing x/y/z)', wcs: { ...makeWcs(), origin: {} } },
    { label: 'wcs.origin.x:NaN (non-finite component)', wcs: { ...makeWcs(), origin: { x: NaN, y: 0, z: 0 } } },
    { label: 'wcs.origin.z:Infinity (non-finite component)', wcs: { ...makeWcs(), origin: { x: 0, y: 0, z: Infinity } } },
    { label: 'wcs.xAxis:null (origin/other axes otherwise valid)', wcs: { ...makeWcs(), xAxis: null } },
    { label: 'wcs.yAxis:"bad" (wrong type)', wcs: { ...makeWcs(), yAxis: 'bad' } },
    { label: 'wcs.zAxis:{} (missing x/y/z)', wcs: { ...makeWcs(), zAxis: {} } },
  ])('$label is dropped with a malformed-record downgrade, sibling setup untouched', ({ wcs }) => {
    const malformed = { id: 's-bad-wcs', name: 'Bad WCS', wcs, stock: RECT_STOCK, operations: [validOpOf()], notes: '' }
    const project = projectWithSetups([malformed, validSetupOf()], 's-valid')

    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(project)

    expect(downgrades.some((d) => d.reason === 'malformed-record')).toBe(true)
    expect(reconciled.setups).toHaveLength(1)
    expect(reconciled.setups[0].id).toBe('s-valid')
    expect(reconciled.setups[0].operations[0].toolpathMoves?.length).toBe(2)
  })

  it('orthonormality is deliberately NOT required - a finite but non-orthonormal basis is KEPT (over-quarantine would reject legitimately-saved files for zero crash coverage)', () => {
    const skewed = {
      ...makeWcs(), xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 1, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    }
    const setup = { id: 's-skewed', name: 'Skewed', wcs: skewed, stock: RECT_STOCK, operations: [validOpOf()], notes: '' }
    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(projectWithSetups([setup], 's-skewed'))
    expect(downgrades.some((d) => d.reason === 'malformed-record')).toBe(false)
    expect(reconciled.setups).toHaveLength(1)
    expect(reconciled.setups[0].wcs.yAxis).toEqual({ x: 1, y: 1, z: 0 })
  })

  it('refresh-boundary through the REAL path (persistMigrate -> persistMerge -> SimulationPanel selection): a wcs:null setup never throws, is absent from live state, sibling stays fully simulable', () => {
    const project = projectWithSetups([
      { id: 's-bad-wcs', name: 'Bad WCS', wcs: null, stock: RECT_STOCK, operations: [validOpOf()], notes: '' },
      validSetupOf(),
    ], 's-valid')

    let merged!: ReturnType<typeof persistMerge>
    expect(() => { merged = rehydrateRoundTrip(project).merged }).not.toThrow()

    expect(merged.project.setups).toHaveLength(1)
    expect(merged.consoleEvents.some((e) => e.source === 'load')).toBe(true)

    expect(() => {
      const setupFound = merged.project.setups.find((st) => st.id === merged.project.activeSetupId)
      expect(setupFound).toBeDefined()
      if (!setupFound) return
      const allOps = setupFound.operations.filter((o) => o.enabled)
      const sections = collectToolpathSections(allOps, merged.project.geometry, merged.project.nests)
      const frames = sections.flatMap((sec) => buildFrames(sec.moves, 5000).frames)
      expect(frames.length).toBeGreaterThan(0)
    }).not.toThrow()
  })
})

describe('CAM-12-R3: setup.stock malformed is quarantined at the reconcile boundary', () => {
  const validOpOf = (): Operation => makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move(), move({ x: 5 })] })
  const validSetupOf = (): Setup => ({
    id: 's-valid', name: 'Valid Setup', wcs: makeWcs(), stock: RECT_STOCK, operations: [validOpOf()], notes: '',
  })

  it.each([
    { label: 'stock:null', stock: null },
    { label: 'stock:undefined', stock: undefined },
    { label: 'stock:"not-an-object" (string)', stock: 'not-an-object' },
    { label: 'stock:42 (number)', stock: 42 },
  ])('$label is dropped with a malformed-record downgrade (PropertiesPanel.tsx:691 setup.stock.type - the ONLY Stock field any consumer reads)', ({ stock }) => {
    const malformed = { id: 's-bad-stock', name: 'Bad Stock', wcs: makeWcs(), stock, operations: [validOpOf()], notes: '' }
    const project = projectWithSetups([malformed, validSetupOf()], 's-valid')

    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(project)

    expect(downgrades.some((d) => d.reason === 'malformed-record')).toBe(true)
    expect(reconciled.setups).toHaveLength(1)
    expect(reconciled.setups[0].id).toBe('s-valid')
  })

  it('a wrong-shaped-but-present stock object (e.g. missing width/height) is NOT quarantined - only stock.type is ever dereferenced, and a wrong shape there cannot throw', () => {
    const oddShape = { type: 'from_model', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' }
    const setup = { id: 's-odd-stock', name: 'x', wcs: makeWcs(), stock: oddShape, operations: [validOpOf()], notes: '' }
    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(projectWithSetups([setup], 's-odd-stock'))
    expect(downgrades).toHaveLength(0)
    expect(reconciled.setups).toHaveLength(1)
  })
})

describe('CAM-12-R3: op.params / op.heights malformed drops ONLY that operation, sibling ops and the setup untouched', () => {
  it.each([
    { label: 'params:null', field: 'params' as const, value: null },
    { label: 'params:undefined (key present, undefined)', field: 'params' as const, value: undefined },
    { label: 'params:"nope" (string)', field: 'params' as const, value: 'nope' },
    { label: 'params:42 (number)', field: 'params' as const, value: 42 },
    { label: 'heights:null', field: 'heights' as const, value: null },
    { label: 'heights:undefined (key present, undefined)', field: 'heights' as const, value: undefined },
    { label: 'heights:"nope" (string)', field: 'heights' as const, value: 'nope' },
    { label: 'heights:42 (number)', field: 'heights' as const, value: 42 },
  ])('$label drops that op with a malformed-record downgrade; the sibling op and the setup survive', ({ field, value }) => {
    const badOp = { ...makeOp({ id: 'op-bad', name: 'Bad Op' }), [field]: value }
    const goodOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move(), move({ x: 5 })] })
    const project = projectWithOps([badOp as unknown as Operation, goodOp])

    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(project)

    expect(downgrades.some((d) => d.reason === 'malformed-record' && d.opId === 'op-bad')).toBe(true)
    expect(reconciled.setups).toHaveLength(1) // the SETUP is never dropped for an op-level field
    expect(reconciled.setups[0].operations).toHaveLength(1)
    expect(reconciled.setups[0].operations[0].id).toBe('op-sibling')
  })

  it('a readable op name survives into the downgrade notice even though params/heights is what is malformed (ADR-0003 identity)', () => {
    const badOp = { ...makeOp({ id: 'op-readable-name', name: 'Readable Name' }), params: null }
    const { downgrades } = reconcileLoadedOpLifecycle(projectWithOps([badOp as unknown as Operation]))
    expect(downgrades).toHaveLength(1)
    expect(downgrades[0].opId).toBe('op-readable-name')
    expect(downgrades[0].opName).toBe('Readable Name')
  })

  it('a wrong-shaped-but-present params/heights object (e.g. missing sub-fields) is NOT quarantined - a missing sub-field reads as undefined, never throws (Vec3/leaf stopping rule)', () => {
    const oddOp = { ...makeOp({ id: 'op-odd' }), params: { unrelated: true }, heights: {} }
    const { project: reconciled, downgrades } = reconcileLoadedOpLifecycle(projectWithOps([oddOp as unknown as Operation]))
    expect(downgrades).toHaveLength(0)
    expect(reconciled.setups[0].operations).toHaveLength(1)
  })

  it('refresh-boundary through the REAL path: an op with params:null never throws the SimulationPanel toolpathKey selector logic, is dropped, sibling stays simulable', () => {
    const badOp = { ...makeOp({ id: 'op-bad', status: 'ready', toolpathMoves: [move()] }), params: null }
    const goodOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move(), move({ x: 5 })] })
    const project = projectWithOps([badOp as unknown as Operation, goodOp])

    let merged!: ReturnType<typeof persistMerge>
    expect(() => { merged = refreshRoundTrip(project).merged }).not.toThrow()

    const setup = merged.project.setups[0]
    expect(setup.operations).toHaveLength(1)
    expect(setup.operations[0].id).toBe('op-sibling')

    // Mirror SimulationPanel.tsx's toolpathKey selector EXACTLY: for every
    // enabled op, `(o.params as {geometryId?}).geometryId` - this is the
    // UNGUARDED expression that throws on params:null; the op is gone by now,
    // so it must never be reached, and the sibling's read must not throw.
    expect(() => {
      for (const op of setup.operations.filter((o) => o.enabled)) {
        const geoId = (op.params as { geometryId?: string }).geometryId
        void geoId
      }
    }).not.toThrow()
  })
})

// ============================================================
// CAM-12-R3 requirement 3 (reproduce-first): the auditor's constructed crash
// (wcs:null active setup, enabled ready op, real finite moves -> throws at
// SimulationPanel.tsx:581/:653) PLUS the two no-moves-needed crash shapes the
// preflight verified: Viewport.tsx:656's exact destructure (fires on a plain
// refresh with NO moves) and DesignTree.tsx:2520's exact stockInvalid
// expression (fires for a NON-active setup row too). Each sub-test first
// proves the RAW malformed shape genuinely throws at the cited real
// expression (the hazard is not hypothetical), then drives the REAL
// persistMigrate -> persistMerge reconcile boundary and proves the malformed
// setup never survives to reach it.
// ============================================================

describe('CAM-12-R3: reproduce-first - the auditor\'s constructed crash and the two no-moves-needed crash shapes, through the REAL boundary', () => {
  it('SimulationPanel.tsx:581/:653 - wcs:null active setup with an enabled ready op carrying REAL finite moves', () => {
    // RED baseline: the exact expressions the auditor cited genuinely throw on
    // this raw shape (proves the hazard is real, not hypothetical).
    const rawWcsNullSetup = { id: 's-crash', name: 'Crash', wcs: null as unknown as WCS, stock: RECT_STOCK, notes: '' } as Setup
    expect(() => resolvePlaybackPosition(
      { fromX: 0, fromY: 0, fromZ: 0, toX: 1, toY: 1, toZ: 1, startMs: 0, durationMs: 100 },
      0,
      rawWcsNullSetup.wcs,
    )).toThrow() // SimulationPanel.tsx:581/:264 toWork(machine, wcs) -> coords.ts:24 wcs.origin.x on null
    expect(() => {
      const stockId = rawWcsNullSetup.wcs.stockId // SimulationPanel.tsx:653
      void stockId
    }).toThrow()

    // GREEN through the REAL boundary: the auditor's exact construction -
    // this setup IS the active one, carries an enabled 'ready' op with real
    // finite moves - never survives to reach either expression.
    const crashOp = makeOp({ id: 'op-crash', status: 'ready', toolpathMoves: [move(), move({ x: 1 })] })
    const validOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move({ feed: 2000 }), move({ x: 5, feed: 2000 })] })
    const validSetup: Setup = { id: 's-valid', name: 'Valid', wcs: makeWcs(), stock: RECT_STOCK, operations: [validOp], notes: '' }
    const project = projectWithSetups(
      [{ id: 's-crash', name: 'Crash', wcs: null, stock: RECT_STOCK, operations: [crashOp], notes: '' }, validSetup],
      's-crash', // the malformed setup IS the active one, per the auditor's construction
    )

    let merged!: ReturnType<typeof persistMerge>
    expect(() => { merged = rehydrateRoundTrip(project).merged }).not.toThrow()
    expect(merged.project.setups.some((s) => s.id === 's-crash')).toBe(false) // quarantined out
    expect(merged.consoleEvents.some((e) => e.source === 'load')).toBe(true)

    // SimulationPanel's own `!setup` early-out (SimulationPanel.tsx:506) - the
    // active id now dangles, so lookup returns undefined and the panel clears
    // rather than throwing. The valid sibling remains independently simulable.
    expect(() => {
      const active = merged.project.setups.find((st) => st.id === merged.project.activeSetupId)
      expect(active).toBeUndefined()
      const sibling = merged.project.setups.find((st) => st.id === 's-valid')
      expect(sibling).toBeDefined()
      if (!sibling) return
      const sections = collectToolpathSections(sibling.operations.filter((o) => o.enabled), merged.project.geometry, merged.project.nests)
      const frames = sections.flatMap((sec) => buildFrames(sec.moves, 5000).frames)
      expect(frames.length).toBeGreaterThan(0)
    }).not.toThrow()
  })

  it('Viewport.tsx:656 - the exact `const { x, y, z } = setup.wcs.origin` destructure throws on wcs:null WITH NO MOVES NEEDED (fires on a plain refresh)', () => {
    const rawWcsNullSetup: Pick<Setup, 'wcs'> = { wcs: null as unknown as WCS }
    // RED baseline: Viewport's exact activeSetupWCSKey destructure.
    expect(() => {
      const { x, y, z } = rawWcsNullSetup.wcs.origin
      return `${x}|${y}|${z}`
    }).toThrow()

    // GREEN through the REAL boundary: NO operations at all (proves the
    // hazard needs no toolpath moves), still quarantined.
    const project = projectWithSetups(
      [{ id: 's-crash', name: 'Crash', wcs: null, stock: RECT_STOCK, operations: [], notes: '' }],
      's-crash',
    )
    let merged!: ReturnType<typeof persistMerge>
    expect(() => { merged = rehydrateRoundTrip(project).merged }).not.toThrow()
    expect(merged.project.setups).toHaveLength(0) // gone entirely - the destructure is unreachable
    expect(() => {
      const setup = merged.project.setups.find((st) => st.id === merged.project.activeSetupId)
      if (!setup) return // Viewport.tsx's own `if (!setup) return null` guard
      const { x, y, z } = setup.wcs.origin
      void x; void y; void z
    }).not.toThrow()
  })

  it('DesignTree.tsx:2520 - the exact stockInvalid expression throws on wcs:null for a NON-ACTIVE setup row (every row is evaluated, active or not)', () => {
    const stocks: { id: string }[] = []
    const fixedStocks: { id: string }[] = []
    const rawWcsNullSetup: Pick<Setup, 'wcs'> = { wcs: null as unknown as WCS }
    // RED baseline: DesignTree's exact stockInvalid expression.
    expect(() => {
      return !!(
        rawWcsNullSetup.wcs.stockId &&
        !stocks.some((ps) => ps.id === rawWcsNullSetup.wcs.stockId) &&
        !fixedStocks.some((fs) => fs.id === rawWcsNullSetup.wcs.stockId)
      )
    }).toThrow()

    // GREEN through the REAL boundary: the malformed setup is NOT the active
    // one (proves the hazard fires for every row, not just the active row) -
    // it is quarantined regardless, so DesignTree's `project.setups.map(...)`
    // never iterates it at all.
    const validOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move()] })
    const validSetup: Setup = { id: 's-valid', name: 'Valid', wcs: makeWcs(), stock: RECT_STOCK, operations: [validOp], notes: '' }
    const project = projectWithSetups(
      [validSetup, { id: 's-crash', name: 'Crash (non-active)', wcs: null, stock: RECT_STOCK, operations: [], notes: '' }],
      's-valid', // the VALID setup is active; the malformed one is a sibling ROW
    )
    let merged!: ReturnType<typeof persistMerge>
    expect(() => { merged = rehydrateRoundTrip(project).merged }).not.toThrow()
    expect(merged.project.setups.some((s) => s.id === 's-crash')).toBe(false)
    expect(() => {
      for (const setup of merged.project.setups) {
        const invalid = !!(
          setup.wcs.stockId &&
          !stocks.some((ps) => ps.id === setup.wcs.stockId) &&
          !fixedStocks.some((fs) => fs.id === setup.wcs.stockId)
        )
        void invalid
      }
    }).not.toThrow()
  })
})

// ============================================================
// DOC-7: a malformed pre-v1 setup must not make persistMigrate throw. Zustand
// swallows a migrate rejection and keeps the newly-created blank project, so
// the migrator preserves the legacy project and lets persistMerge's existing
// load-boundary quarantine remove only the malformed setup.
// ============================================================

describe('DOC-7: pre-v1 migration cannot silently blank the project', () => {
  it('preserves a pre-v1 project with malformed setup.wcs and quarantines only that setup', () => {
    const preV1Project = {
      id: 'p-legacy', name: 'Legacy', version: '1', createdAt: '', updatedAt: '',
      schemaVersion: 0,
      machine: makeMachine(),
      toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
      geometry: [],
      setups: [{ id: 's1', name: 'Setup 1', wcs: null, stock: RECT_STOCK, operations: [], notes: '' }],
      activeSetupId: 's1', activeOperationId: null,
      sceneStock: {}, notes: '',
    }

    const migrated = persistMigrate(
      { project: preV1Project },
      CURRENT_PROJECT_SCHEMA_VERSION,
    )
    const rehydrated = persistMerge(migrated, useCamStore.getState())

    expect(rehydrated.project.id).toBe('p-legacy')
    expect(rehydrated.project.name).toBe('Legacy')
    expect(rehydrated.project.setups).toEqual([])
    expect(rehydrated.consoleEvents.at(-1)?.message).toContain('malformed record')
    expect(rehydrated.consoleEvents.at(-1)?.message).toContain('removed')
  })

  it('a CURRENT-SCHEMA (v6) blob short-circuits the migration chain entirely and never reaches migrateHierarchy.ts - unaffected regardless of wcs shape', () => {
    const currentSchemaProject = {
      id: 'p-current', name: 'Current', version: '1', createdAt: '', updatedAt: '',
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      machine: makeMachine(),
      toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
      geometry: [],
      setups: [{ id: 's1', name: 'Setup 1', wcs: null, stock: RECT_STOCK, operations: [], notes: '' }],
      activeSetupId: 's1', activeOperationId: null,
      sceneStock: {}, notes: '',
    }
    // No throw INSIDE persistMigrate itself for a v6 blob (runMigrationChain's
    // from===current no-op) - the malformed wcs instead reaches the OWNED
    // reconcile boundary (persistMerge), which is exactly where R3's new
    // quarantine handles it (proven by the wcs-quarantine describe block above).
    expect(() => persistMigrate({ project: currentSchemaProject }, CURRENT_PROJECT_SCHEMA_VERSION)).not.toThrow()
  })
})

// ============================================================
// CAM-12-R4 - the R3 audit's remaining major: 27 of 28 'tolerated' census
// rows had NO dedicated no-throw fuzz case - their verdict rested on per-row
// prose, not the executable proof the WO mandates. This adds exactly the
// adopted fix: one no-throw fuzz case per tolerated row, table-driven off
// CENSUS.filter(e => e.category === 'tolerated') so a newly-tolerated row
// cannot be added without its own fuzz case (the loop IS the coverage - the
// same STOP-ruling mechanism as the R3 mechanical-closure diff above, applied
// to the tolerated leaves instead of the derived path set).
//
// Each TOLERATED_CONSUMERS[path] entry drives BOTH: (1) the reconcile
// boundary (reconcileLoadedOpLifecycle, the one piece of automatic load-path
// processing every field passes through), and (2) the field's own real
// load-path consumer named in its census rule, called with the exact same
// fuzz value - matchesFilter/syncStockSimSurface/deriveOriginBindingForTest/
// g10Line/resolveFeedrates are real exported functions and are invoked
// directly; consumers that live only inside a React component with no export
// (DesignTree's stockInvalid expression) are reproduced inline, the same
// technique the R3 "reproduce-first" block above already used. Rows whose own
// rule states there is NO load-path consumer (event-gated modal fields,
// compute-time-only Regen fields) are satisfied by the reconcile boundary
// alone, because that boundary IS the entire load-path surface for those
// fields - nothing else touches them until a user event or a Regen compute.
// ============================================================

/** A minimal otherwise-valid setup (one enabled 'ready' op) with the given
 *  top-level Setup field(s) overridden - used to fuzz Setup.* tolerated rows
 *  through the real reconcile boundary. */
function setupProjectWith(setupOverrides: Record<string, unknown>): Project {
  const op = makeOp({ id: 'op-tolerated', status: 'ready', toolpathMoves: [move()] })
  const setup = {
    id: 's-tol', name: 'Tolerated', wcs: makeWcs(), stock: RECT_STOCK, operations: [op], notes: '',
    ...setupOverrides,
  }
  return projectWithSetups([setup], 's-tol')
}

/** Same, but overriding fields nested under Setup.wcs. */
function wcsProjectWith(wcsOverrides: Record<string, unknown>): Project {
  return setupProjectWith({ wcs: { ...makeWcs(), ...wcsOverrides } })
}

/** Same, but overriding fields nested under Setup.stock. */
function stockProjectWith(stockOverrides: Record<string, unknown>): Project {
  return setupProjectWith({ stock: { ...RECT_STOCK, ...stockOverrides } })
}

/** A project with the fuzzed op PLUS an untouched valid sibling op, so a
 *  quarantine (if one ever fired) would be visible as a sibling-survives
 *  assertion failure rather than silently vanishing the whole fixture. */
function opProjectWith(opOverrides: Record<string, unknown>): Project {
  const badOp = { ...makeOp({ id: 'op-tolerated', status: 'ready', toolpathMoves: [move()] }), ...opOverrides }
  const goodOp = makeOp({ id: 'op-sibling', status: 'ready', toolpathMoves: [move(), move({ x: 5 })] })
  return projectWithOps([badOp as unknown as Operation, goodOp])
}

type ToleratedFuzzer = (value: unknown) => void

/** One entry per tolerated census row (enforced structurally below - the
 *  coverage test fails, naming the path, if a row is missing here). */
const TOLERATED_CONSUMERS: Record<string, ToleratedFuzzer> = {
  'Setup.id': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ id: value }))
    // SimulationPanel/DesignTree's `.find(st => st.id === activeSetupId)` -
    // an === comparison never throws regardless of runtime type.
    const setups = [{ id: value } as unknown as Setup]
    setups.find((st) => st.id === 'activeSetupId-does-not-match')
  },
  'Setup.name': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ name: value }))
    // matchesFilter short-circuits on the default empty query before ever
    // calling .toLowerCase() on the field.
    matchesFilter('', value as string)
  },
  'Setup.operationFolders': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ operationFolders: value }))
    // DesignTree.tsx's own Array.isArray guard (CAM-12-R3-R4 fix) - reproduced
    // inline, same technique as the R3 reproduce-first block above.
    const opFolders = Array.isArray(value) ? (value as { parentId?: string | null }[]) : []
    opFolders.filter((folder) => folder.parentId == null)
  },
  'Setup.defaultHeightIntent': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ defaultHeightIntent: value }))
    // setupDefaultHeightIntent's nullish fallback and clone are the only
    // automatic-safe read path; malformed values remain event-gated afterward.
    setupDefaultHeightIntent({ defaultHeightIntent: value } as Pick<Setup, 'defaultHeightIntent'>)
  },
  'WCS.stockId': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ stockId: value }))
    // SimulationPanel.tsx's real exported syncStockSimSurface.
    syncStockSimSurface(null, { mode: 'simulation', enabled: true, resolution: 10, stockId: value as string })
    // DesignTree.tsx:2520's exact stockInvalid expression (no export exists;
    // reproduced inline, same technique as the R3 reproduce-first block above).
    const stocks: { id: string }[] = []
    const fixedStocks: { id: string }[] = []
    const invalid = !!(
      value &&
      !stocks.some((ps) => ps.id === value) &&
      !fixedStocks.some((fs) => fs.id === value)
    )
    void invalid
  },
  'WCS.label': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ label: value }))
    matchesFilter('', value as string)
  },
  'WCS.id': (value) => {
    // SetupModal-only, event-gated - never dereferenced on the load/first-
    // render path, so the reconcile boundary IS the entire load-path surface.
    reconcileLoadedOpLifecycle(wcsProjectWith({ id: value }))
  },
  'WCS.fixtureOffset': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ fixtureOffset: value }))
    // g10Line/dimWord - the real post-time consumer (user-gated, not load-path,
    // but the cited real consumer; invoked directly regardless of trigger timing).
    g10Line({ ...makeWcs(), fixtureOffset: value as number }, UCCNC_CONFIG)
  },
  'WCS.cornerRow': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ cornerRow: value, cornerCol: 0 }))
    deriveOriginBindingForTest({ ...makeWcs(), cornerRow: value as number, cornerCol: 0 })
  },
  'WCS.cornerCol': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ cornerRow: 0, cornerCol: value }))
    deriveOriginBindingForTest({ ...makeWcs(), cornerRow: 0, cornerCol: value as number })
  },
  'WCS.cornerFace': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ cornerRow: 0, cornerCol: 0, cornerFace: value }))
    deriveOriginBindingForTest({ ...makeWcs(), cornerRow: 0, cornerCol: 0, cornerFace: value } as unknown as WCS)
  },
  'WCS.snapGeoId': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ snapGeoId: value }))
    deriveOriginBindingForTest({ ...makeWcs(), snapGeoId: value as string })
  },
  'WCS.snapLocalPt': (value) => {
    reconcileLoadedOpLifecycle(wcsProjectWith({ snapGeoId: 'g1', snapLocalPt: value }))
    // migrateHierarchy.ts's cloneVec(v) - already null-safe (`v ? {...} : ZERO_VEC`).
    deriveOriginBindingForTest({ ...makeWcs(), snapGeoId: 'g1', snapLocalPt: value as Vec3 })
  },
  'Stock.type': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ type: value }))
    // PropertiesPanel.tsx:691 - display-only template-string read.
    const stock = { ...RECT_STOCK, type: value as string }
    void `${stock.type}`
  },
  'Operation.id': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ id: value }))
    const ops = [{ id: value } as unknown as Operation]
    ops.find((o) => o.id === 'does-not-match')
  },
  'Operation.name': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ name: value }))
    matchesFilter('', value as string) // DesignTree filter, default-query short-circuit
    void `${value}` // downgrade/console message template-string coercion
  },
  'Operation.type': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ type: value }))
    void (value !== 'adaptive_3d') // Viewport.tsx safe compare
  },
  'Operation.enabled': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ enabled: value }))
    const ops = [{ enabled: value } as unknown as Operation]
    ops.filter((o) => o.enabled) // truthy filter, any value is safe
  },
  'Operation.toolId': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ toolId: value }))
    const toolLibrary = [makeTool({ id: 't1', toolNumber: 1 })]
    toolLibrary.find((t) => t.id === value) // dangling/absent id tolerated
  },
  'Operation.geometrySelections': (value) => {
    // event-gated only (geometry-delete sweep, Regen, modal editors) - never
    // on the automatic load/first-render path.
    reconcileLoadedOpLifecycle(opProjectWith({ geometrySelections: value }))
  },
  'Operation.modelReferences': (value) => {
    // CAM-1 re-resolution runs on Regen (user-initiated) only.
    reconcileLoadedOpLifecycle(opProjectWith({ modelReferences: value }))
  },
  'Operation.modelReferenceNote': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ modelReferenceNote: value }))
    void `${value ?? ''}` // PropertiesPanel/DesignTree tooltip, template/optional-chain use
  },
  'Operation.outdatedReason': (value) => {
    // WO-2663: DesignTree and PropertiesPanel render it only when truthy, and
    // outdatedReasonText switches on `.kind` with a default - any shape reads.
    reconcileLoadedOpLifecycle(opProjectWith({ status: 'outdated', outdatedReason: value }))
    if (value) void outdatedReasonText(value as never)
  },
  'Operation.passes': (value) => {
    // NewOperationModal (event-gated) + compute-time (Regen) only.
    reconcileLoadedOpLifecycle(opProjectWith({ passes: value }))
  },
  'Operation.linking': (value) => {
    // Same reasoning as Operation.passes.
    reconcileLoadedOpLifecycle(opProjectWith({ linking: value }))
  },
  'Operation.feedrateOverride': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ feedrateOverride: value }))
    // resolveFeedrates - the real compute-time (Regen) consumer; `fo?.enabled`
    // optional chaining tolerates any runtime shape.
    resolveFeedrates(makeTool(), value as FeedrateOverride | undefined)
  },
  'Operation.computeTimeMs': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ computeTimeMs: value }))
    void `${value}` // display/arithmetic only
  },
  'Operation.estimatedCutTimeMs': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ estimatedCutTimeMs: value }))
    void `${value}`
  },
  // SIM-7 twin field, classified at CAM-12 merge reassembly: DesignTree's
  // find predicate and PropertiesPanel's conditional render are truthy
  // checks + title/template use only.
  'Operation.estimatedCutTimeMsError': (value) => {
    const project = opProjectWith({ estimatedCutTimeMsError: value })
    reconcileLoadedOpLifecycle(project)
    const ops = project.setups.flatMap((s) => (Array.isArray(s?.operations) ? s.operations : []))
    void ops.find((op) => op?.status === 'ready' && op?.estimatedCutTimeMsError)?.estimatedCutTimeMsError
    void `${value}`
  },
  'Operation.errorMessage': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ errorMessage: value }))
    void `${value}` // rendered/template-string only
  },
  'Operation.progress': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ progress: value }))
    void `${value}` // display/arithmetic only
  },
  'Operation.progressPhase': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ progressPhase: value }))
    void `${value}` // display only
  },
  'Operation.folderId': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ folderId: value }))
    // DesignTree.tsx's own nullish-coalesced compare + Set.has() lookup -
    // reproduced inline, same technique as the R3 reproduce-first block above.
    void ((value ?? null) === 'does-not-match')
    const folderIds = new Set<string>()
    void (value != null && folderIds.has(value as string))
  },
  'Operation.diagnostics': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ diagnostics: value }))
    // PropertiesPanel.tsx's own optional-chained read.
    void (value as { adaptiveRough?: unknown } | undefined)?.adaptiveRough
  },
  'Operation.generationFingerprint': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ generationFingerprint: value }))
    // operationGenerationIsCurrent/reconcileProjectGenerationFreshness's own
    // typeof-guard + plain equality compare - never dereferenced as an object.
    void (typeof value === 'string')
    void (value === 'some-other-hash')
  },
  'Operation.resolvedHeights': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ resolvedHeights: value }))
    // PropertiesPanel.tsx's own version-gated reads (displayBottom/topZAbs,
    // CAM-12-R3-R4 fix) - reproduced inline.
    const rh = value as { version?: number; wcs?: { bottom?: number }; machine?: { top?: number } } | null | undefined
    void (rh?.version === 1 ? rh.wcs?.bottom : undefined)
    void (rh?.version === 1 ? rh.machine?.top : undefined)
  },
  // ---- Census re-cut 2026-08-20 (16 newly-dereferenced paths) ----
  'Setup.fixtureStack': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ fixtureStack: value }))
    // Viewport.tsx's real consumer: the exported resolver, whose
    // setupFixtureStack Array.isArray-guards + shape-coerces every item.
    void JSON.stringify({ fixtureStack: (value as unknown[]) ?? [] })
    resolveSetupSupportPlane({ wcs: makeWcs(), fixtureStack: value as never }, 0)
  },
  'Setup.supportPlane': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ supportPlane: value }))
    void JSON.stringify({ supportPlane: value ?? null })
    resolveSetupSupportPlane({ wcs: makeWcs(), supportPlane: value as never }, 0)
    resolveSetupSupportPlane({ wcs: makeWcs(), supportPlane: value as never }, undefined)
  },
  'Setup.notes': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ notes: value }))
    // programContext.ts carries it verbatim into the snapshot (post time).
    void ({ notes: value })
  },
  // WO-2438 added Setup.holdingMethod (information only: no cut, keep-out or post output).
  // Its readers are the Setup panel's `setup.holdingMethod ?? ''` select value, which funnels
  // writes through isHoldingMethodId, and holdingMethodLabel's table .find (an === compare).
  // Neither throws on any runtime type, so the row is tolerated; nothing is quarantined.
  'Setup.holdingMethod': (value) => {
    reconcileLoadedOpLifecycle(setupProjectWith({ holdingMethod: value }))
    void isHoldingMethodId(value)
    void holdingMethodLabel(value as never)
  },
  'Setup.machineActions': (value) => {
    // WO-2620: the field as a whole, then each non-nullish fuzz value as the one
    // element of an array (a null element is the unguarded gap the census rule
    // names) - through the three readers: tree order, post, Control load.
    for (const actions of value == null ? [value] : [value, [value]]) {
      reconcileLoadedOpLifecycle(setupProjectWith({ machineActions: actions }))
      const setup = { machineActions: actions } as Pick<Setup, 'machineActions'>
      void setupListOrder([{ id: 'op-tolerated' }], machineActionsOf(setup))
      void operatorStopsFromActions(['op-tolerated'], setup.machineActions)
      // machineSession.ts setupHasOperatorStops (not exported), reproduced inline.
      void (Array.isArray(setup.machineActions)
        && setup.machineActions.some((action) => action.kind === 'operator_stop' && action.enabled !== false))
    }
  },
  'Setup.flipOf': (value) => {
    const { project } = reconcileLoadedOpLifecycle(setupProjectWith({ flipOf: value }))
    // ProbingPanel.tsx's exact read: truthy check, then the ids are handed to
    // the real planner, which resolves the parent by .find and REFUSES (not
    // throws) on anything it cannot resolve.
    const setup = project.setups[0] as unknown as { flipOf?: { setupId?: unknown; axis?: unknown } }
    if (setup.flipOf) {
      planSecondSideSetup(
        { setups: project.setups, stocks: project.stocks ?? [] },
        { parentSetupId: setup.flipOf.setupId as string, axis: setup.flipOf.axis as 'x' },
      )
    }
    // removeSetup's optional-chained compare.
    void ((setup.flipOf as { setupId?: string } | undefined)?.setupId !== 's-tol')
  },
  'Operation.smartHeight': (value) => {
    const { project } = reconcileLoadedOpLifecycle(opProjectWith({ smartHeight: value }))
    // The file-open leg's generation-freshness pass (store loadProjectFromFile
    // -> reconcileProjectGenerationFreshness) and the validator every
    // load-path reader funnels through.
    reconcileProjectGenerationFreshness(project)
    const validated = validatePersistedSmartHeightState(value)
    expect(validated.ok).toBe(false)
    void (value === undefined ? undefined : JSON.stringify({ smartHeight: value }))
  },
  'Operation.resolvedHeightPlan': (value) => {
    const { project } = reconcileLoadedOpLifecycle(opProjectWith({ resolvedHeightPlan: value }))
    reconcileProjectGenerationFreshness(project)
    // PropertiesPanel.tsx's version gate (census re-cut fix) - reproduced
    // inline, then the dereference that previously threw.
    const plan = value as { version?: number; machining: { cutterCenterEnd?: { wcsMm?: number } } } | null | undefined
    const gated = plan?.version === 2 ? plan : undefined
    void gated?.machining.cutterCenterEnd?.wcsMm
  },

  'Stock.width': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ width: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { width: value } as Record<string, unknown>
    void (stock.width ?? null)
    void Math.max(0, (stock.width as number) ?? 0)
  },
  'Stock.height': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ height: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { height: value } as Record<string, unknown>
    void (stock.height ?? null)
    void Math.max(0, (stock.height as number) ?? 0)
  },
  'Stock.depth': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ depth: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { depth: value } as Record<string, unknown>
    void (stock.depth ?? null)
    void Math.max(0, (stock.depth as number) ?? 0)
  },
  'Stock.diameter': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ diameter: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { diameter: value } as Record<string, unknown>
    void (stock.diameter ?? null)
    void Math.max(0, (stock.diameter as number) ?? 0)
  },
  'Stock.length': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ length: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { length: value } as Record<string, unknown>
    void (stock.length ?? null)
    void Math.max(0, (stock.length as number) ?? 0)
  },
  'Stock.offsetX': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ offsetX: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { offsetX: value } as Record<string, unknown>
    void (stock.offsetX ?? null)
    void Math.max(0, (stock.offsetX as number) ?? 0)
  },
  'Stock.offsetY': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ offsetY: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { offsetY: value } as Record<string, unknown>
    void (stock.offsetY ?? null)
    void Math.max(0, (stock.offsetY as number) ?? 0)
  },
  'Stock.offsetZTop': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ offsetZTop: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { offsetZTop: value } as Record<string, unknown>
    void (stock.offsetZTop ?? null)
    void Math.max(0, (stock.offsetZTop as number) ?? 0)
  },
  'Stock.offsetZBottom': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ offsetZBottom: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { offsetZBottom: value } as Record<string, unknown>
    void (stock.offsetZBottom ?? null)
    void Math.max(0, (stock.offsetZBottom as number) ?? 0)
  },
  'Stock.material': (value) => {
    reconcileLoadedOpLifecycle(stockProjectWith({ material: value }))
    // programContext.ts authoredStockSnapshot/authoredStockBounds - reproduced inline.
    const stock = { material: value } as Record<string, unknown>
    void (stock.material ?? null)
    void Math.max(0, (stock.material as number) ?? 0)
  },
  'Operation.contourTabPreview': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ contourTabPreview: value }))
    // Viewport.tsx/PropertiesPanel.tsx's own Array.isArray guard (CAM-12-R3-R4
    // fix) - reproduced inline.
    const preview = value as { loops?: unknown } | null | undefined
    void (!preview || !Array.isArray(preview.loops) || (preview.loops as unknown[]).length === 0)
  },
  'Operation.reachShortfall': (value) => {
    reconcileLoadedOpLifecycle(opProjectWith({ reachShortfall: value }))
    // DesignTree.tsx/PropertiesPanel.tsx's own isValidReachShortfall guard.
    void isValidReachShortfall(value)
  },
}

describe('CAM-12-R4: tolerated-leaf census - one no-throw fuzz case per tolerated row', () => {
  const TOLERATED_ROWS = CENSUS.filter((e) => e.category === 'tolerated')
  // null/number/wrong-type covers requirement 2's "null/number/wrong-type";
  // the wrong-type string also stands in for "a dangling id" on the by-id ref
  // rows (WCS.stockId, WCS.snapGeoId, Operation.toolId) - a well-formed string
  // that matches nothing is exactly what a dangling id looks like at runtime.
  const FUZZ_VALUES: unknown[] = [null, 42, 'zz-dangling-or-wrong-type', {}]

  it('every tolerated census row has a registered fuzz consumer (a newly-tolerated row cannot go uncovered)', () => {
    const uncovered = TOLERATED_ROWS.filter((e) => !(e.path in TOLERATED_CONSUMERS))
    expect(uncovered.map((e) => e.path)).toEqual([])
  })

  it.each(TOLERATED_ROWS)(
    '$path (tolerated): null/number/wrong-type/dangling-id fuzz reconciles + drives its real load-path consumer with no throw',
    ({ path }) => {
      const consumer = TOLERATED_CONSUMERS[path]
      expect(consumer, `no fuzz consumer registered for tolerated census row ${path}`).toBeDefined()
      for (const value of FUZZ_VALUES) {
        expect(() => consumer(value), `${path} threw for fuzz value ${JSON.stringify(value)}`).not.toThrow()
      }
    },
  )
})
