// planegcs WASM loading — ONE place that knows HOW the solver module reaches
// the runtime, shared by both sketch stacks (src/lib/sketch/solver and
// src/sketch3d) so the worker, the mapping layers, and headless tests all
// share a single loading strategy (and a single WASM instantiation per
// thread). Unified in SKC-6A from two near-identical loaders; see
// coordination/reports/SKC-6A.report.json for the merge rationale.
//
// Mirrors the clipper2-wasm pattern in src/lib/cam/face2d/clipperOffset.ts:
// Vite emits the .wasm as an asset and `?url` resolves to its served URL.
// Emscripten's default resolution (bare filename relative to the script) is
// unreliable inside a bundled Web Worker, so in the browser we point
// `locateFile` at the resolved URL. Under Node (vitest) the default path —
// relative to node_modules/@salusoft89/planegcs/dist/planegcs_dist/ — works,
// and the `?url` import is left unused.

import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs'
import type { GcsSystem } from '@salusoft89/planegcs'
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'

const runtime = globalThis as typeof globalThis & {
  process?: { versions?: { node?: string } }
}

// True under Node (vitest) — there the Emscripten default wasm resolution works.
const isNode = typeof runtime.process?.versions?.node === 'string'

type PlanegcsModule = {
  GcsSystem: new () => GcsSystem
}

// WO-202 recovery of WO-091: a liveness backstop, not a performance budget.
// Browser loads fetch planegcs.wasm through a Vite-served asset URL. A fetch
// that never settles must become a rejection so the memo below can be evicted
// and the workbench's bounded automatic retry can start a genuine new load.
// Node tests load from disk, where this browser failure class does not apply;
// focused tests opt into the deadline explicitly.
const DEFAULT_PLANEGCS_LOAD_DEADLINE_MS = 30_000

let planegcsLoadDeadlineMs: number | null = isNode ? null : DEFAULT_PLANEGCS_LOAD_DEADLINE_MS
let modulePromise: Promise<PlanegcsModule> | null = null
let planegcsLoadAttemptCount = 0

function startPlanegcsLoad(): Promise<PlanegcsModule> {
  planegcsLoadAttemptCount++
  const load = init_planegcs_module(
    isNode ? undefined : { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) },
  ) as Promise<PlanegcsModule>
  const deadlineMs = planegcsLoadDeadlineMs
  if (deadlineMs === null) return load
  return new Promise<PlanegcsModule>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`planegcs wasm module load timed out after ${deadlineMs}ms`))
    }, deadlineMs)
    // Handle both branches so a load settling after its deadline never becomes
    // an unhandled rejection or silently replaces the newer retry's module.
    load.then(
      (mod) => { clearTimeout(timer); resolve(mod) },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
    )
  })
}

function ensurePlanegcsModule(): Promise<PlanegcsModule> {
  if (modulePromise === null) {
    const attempt = startPlanegcsLoad()
    modulePromise = attempt
    // Identity matters: an abandoned attempt may reject after a later one has
    // succeeded, and must not evict that newer live module.
    attempt.catch(() => {
      if (modulePromise === attempt) modulePromise = null
    })
  }
  return modulePromise
}

/** Test-only proof seam: a post-failure retry must increment this counter. */
export function planegcsLoadAttemptCountForTest(): number {
  return planegcsLoadAttemptCount
}

export function resetPlanegcsModuleForTest(): void {
  modulePromise = null
  planegcsLoadAttemptCount = 0
}

/** Test-only: arm the browser deadline path under Node. */
export function setPlanegcsLoadDeadlineMsForTest(ms: number | null): void {
  planegcsLoadDeadlineMs = ms
}

export function resetPlanegcsLoadDeadlineForTest(): void {
  planegcsLoadDeadlineMs = isNode ? null : DEFAULT_PLANEGCS_LOAD_DEADLINE_MS
}

/**
 * Create a fresh GcsWrapper (its own GcsSystem constraint network) on the
 * shared WASM module. Each solve context (2D worker session, test) should
 * own its wrapper; wrappers are independent, the module instantiates once.
 */
export async function createGcsWrapper(): Promise<GcsWrapper> {
  const mod = await ensurePlanegcsModule()
  return new GcsWrapper(new mod.GcsSystem())
}

// Test-only instrumentation (SKC-2 criterion 2, "system reuse"): counts native GcsSystem
// construction so a drag-session test can assert the wasm system is built at most once per
// drag, not rebuilt per move(). Not read by production code. Scoped to the sketch3d entry
// point only (createGcsWrapper, the 2D path, does not increment it) — preserved unchanged
// from the pre-unification sketch3d loader.
let gcsSystemConstructCount = 0

export function sketch3dGcsSystemConstructCountForTest(): number {
  return gcsSystemConstructCount
}

export function resetSketch3dGcsSystemConstructCountForTest(): void {
  gcsSystemConstructCount = 0
}

export async function createSketch3dGcsWrapper(): Promise<GcsWrapper> {
  const mod = await ensurePlanegcsModule()
  gcsSystemConstructCount++
  return new GcsWrapper(new mod.GcsSystem())
}

// NOTE (2026-07-07, Architect): a quantitative wasm-leak metric is NOT implementable
// against this planegcs build. Measured facts: HEAP8.byteLength is pinned at 16 MB and
// does not move even under a deliberate 300x heavy-instance leak (it reports capacity,
// not bytes-in-use), and the module exports no _malloc/_free to probe free headroom.
// Disposal correctness is therefore guarded by the dispose-contract test (delete()
// called exactly once, in solveService.test.ts) plus the OOM-calibrated heavy soak
// test in disposalSoak.test.ts - do not reintroduce a heap-byte assertion without
// first proving the metric can move.
//
// BK-19 (2026-07-08, SKC-3): the "Aborted(OOM)" stderr line observed during teardown of
// 100/150-entity drag sessions (see dragPerfLadder.test.ts) traces to
// `u:()=>{la("OOM")}` in the vendored wasm glue - emscripten's standard grow-heap-failure
// abort, consistent with the pinned-16MB finding above (heap growth is compiled out, so
// any allocation needing more than the current high-water-mark hits this trap). The throw
// never reaches JS (caught internally before our dispose() call returns). It did NOT
// reproduce in an isolated single-file harness across two tier orderings (bk19Investigation.test.ts),
// which weighs against a per-service/per-file cumulative leak; full root cause needs
// wasm-build-level visibility (out of scope - see that file's header for the complete
// evidence trail and the ruling-3 close rationale).
