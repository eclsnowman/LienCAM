// WO UI-57-R3 (DECISIONS 2026-07-17 "RUNTIME-GROUNDED CENSUS LAW", ruling 1):
// the census's PRIMARY, verdict-bearing mechanism must be RUNTIME-GROUNDED --
// "execute the real functions and enumerate what actually happens".
//
// THE PROBLEM THIS MODULE SOLVES. Tier 1's domain is the delta PRODUCERS, and
// most of them are ES `#private` class methods on GeomEngine (#pairHealedFaces,
// #assignEditedIds, #applyToolBoolean, #applyEdgeDressUp, #offsetFaceBoolean,
// #editHoleDiameter, #assignHealedIds). A `#private` method is unreachable and
// unspyable from outside its class BY LANGUAGE RULE: there is no vi.spyOn seam,
// no prototype entry, no property descriptor. So the two obvious ways to observe
// "did this producer actually run" are both closed:
//
//   * spying    -- impossible for #private (the whole point of the syntax);
//   * a counter -- would require EDITING PRODUCTION SOURCE to instrument the
//     engine. This round's findings are all `tests`; the production write-side
//     fix is GREEN and untouchable, and an instrumented engine is not the engine
//     the app ships. A census that only proves the INSTRUMENTED build ran its
//     producers is a census of the instrumentation.
//
// THE SEAM USED INSTEAD: V8's own precise coverage (node:inspector Profiler),
// which counts invocations of every compiled function in the isolate, keyed by
// script URL + the function's own name -- INCLUDING `#private` methods, whose
// V8 functionName is the literal '#pairHealedFaces'. It observes the REAL,
// UNMODIFIED production code executing. Nothing is mocked, patched, or wrapped;
// the engine under census is byte-for-byte the engine that ships.
//
// This is what makes tier 1 fail CLOSED by construction: a new producer reached
// through the engine's dispatch surfaces is COUNTED whatever syntax declared it
// -- no import to remember, no return-type annotation to spell, no object
// literal to recognize. The AST derivation (aliasLifecycleCensus.ts) stays as
// the ADVISORY discovery layer per ruling 2; this is the gate.
//
// NON-VACUITY IS ASSERTED, NEVER ASSUMED. If the inspector session silently
// yielded nothing, every producer would read "0 calls" and the census would go
// RED -- fail-closed, which is correct but uninformative. So callers assert the
// CANARY (assertObserved below): a function KNOWN to run must report a positive
// count, or this module -- not the engine -- is what broke.
import { Session } from 'node:inspector'

/** One function's observed invocation count, keyed as V8 reports it. */
export interface ObservedFunction {
  /** The script URL V8 attributes the function to (a file:// URL). */
  url: string
  /** The function's own name, exactly as V8 reports it. A `#private` method
   *  reports its literal '#name' -- which is why this seam can see the majority
   *  of tier 1's domain at all. */
  functionName: string
  /** Invocations observed since the enclosing snapshot window opened. */
  count: number
}

/** A counts map keyed `${urlSuffixMatch}::${functionName}`. */
export type CallCounts = ReadonlyMap<string, number>

const key = (file: string, fn: string): string => `${file}::${fn}`

/**
 * A live V8 precise-coverage window.
 *
 * THE COUNTER SEMANTICS (UI-57-R4 -- MEASURED, and not what R3 assumed).
 * `Profiler.takePreciseCoverage` RESETS V8's execution counters as it reads
 * them, so each call returns the counts accumulated SINCE THE PREVIOUS CALL --
 * the take IS the window. Probed directly on this tree's Node:
 *
 *     probeFn(); probeFn();  take -> 2      // two calls since the last take
 *     (nothing);             take -> 0      // NOT 2: the counters were reset
 *     probeFn();             take -> 1
 *
 * R3 read these as CUMULATIVE and diffed two takes (`since(before, after)`) to
 * get a window. Under reset semantics that subtracts the PREVIOUS window's
 * counts from this one's -- so a producer that ran in both windows reports 0 in
 * the second and vanishes from the map, and its route reads as never driven.
 * (Observed: applyBoolean:op=intersect reported an empty producer list one call
 * after applyBoolean:op=fuse reported a full one.) It fails toward RED rather
 * than green, but it is still a broken measurement, and a census that miscounts
 * in the safe direction today miscounts in the other one the day the call order
 * changes.
 *
 * So there is no diff and no cursor: `takeWindow()` returns the window directly.
 */
export class RuntimeCallCensus {
  readonly #session: Session
  readonly #files: readonly string[]
  #open = true

  private constructor(session: Session, files: readonly string[]) {
    this.#session = session
    this.#files = files
  }

  /**
   * Open a coverage window over `files` (repo-relative path fragments matched
   * against V8's script URLs, e.g. 'src/geom/worker/geom-engine.ts').
   *
   * ORDERING (load-bearing): counters attach when this is called, so ONLY calls
   * made AFTER it are observed. Kernel init and any fixture setup performed
   * before opening are deliberately outside the window -- the census measures
   * what the RECIPES drive, not what the harness happened to touch while warming
   * up.
   */
  static async open(files: readonly string[]): Promise<RuntimeCallCensus> {
    const session = new Session()
    session.connect()
    const census = new RuntimeCallCensus(session, files)
    await census.#post('Profiler.enable')
    await census.#post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    return census
  }

  #post(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      // The typed overloads of Session.post do not cover every domain method;
      // the cast is scoped to this one call site rather than leaking outward.
      ;(this.#session.post as (m: string, p: unknown, cb: (e: Error | null, r: unknown) => void) => void)(
        method, params ?? {}, (err, result) => (err ? reject(err) : resolve((result ?? {}) as Record<string, unknown>)),
      )
    })
  }

  /** Which censused file (if any) this V8 script URL belongs to. */
  #fileFor(url: string): string | null {
    // V8 reports OS-native separators inside a file:// URL on Windows; compare
    // on a normalized form so a censused path matches on every platform (the
    // harness runs on win32 and CI alike).
    const normalized = url.replace(/\\/g, '/')
    for (const f of this.#files) if (normalized.endsWith(f)) return f
    return null
  }

  /**
   * The invocation counts accumulated SINCE THE PREVIOUS takeWindow() (or since
   * open()), for every named function in the censused files -- summed across
   * V8's per-closure entries (a method can be reported more than once; the
   * domain question is "did it run", so the counts add).
   *
   * READING THIS RESETS THE COUNTERS (see the class comment): consecutive calls
   * partition execution into non-overlapping windows, which is exactly the
   * per-call attribution the census needs. Never diff two of these.
   */
  async takeWindow(): Promise<CallCounts> {
    if (!this.#open) throw new Error('RuntimeCallCensus: takeWindow() after close()')
    const { result } = (await this.#post('Profiler.takePreciseCoverage')) as {
      result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }>
    }
    const counts = new Map<string, number>()
    for (const script of result) {
      const file = this.#fileFor(String(script.url))
      if (file === null) continue
      for (const fn of script.functions) {
        if (!fn.functionName) continue
        const k = key(file, fn.functionName)
        counts.set(k, (counts.get(k) ?? 0) + (fn.ranges[0]?.count ?? 0))
      }
    }
    return counts
  }

  async close(): Promise<void> {
    if (!this.#open) return
    this.#open = false
    await this.#post('Profiler.stopPreciseCoverage')
    this.#session.disconnect()
  }
}

/** Several windows' counts, summed -- the "did this ever run" question. */
export function mergeWindows(windows: readonly CallCounts[]): CallCounts {
  const total = new Map<string, number>()
  for (const counts of windows) for (const [k, v] of counts) total.set(k, (total.get(k) ?? 0) + v)
  return total
}

/** Invocations of `fn` in `file` within a counts window. 0 = never ran. */
export function callsTo(counts: CallCounts, file: string, fn: string): number {
  return counts.get(key(file, fn)) ?? 0
}

/** Every function name observed running in `file` within a counts window. */
export function namesIn(counts: CallCounts, file: string): string[] {
  const prefix = `${file}::`
  return [...counts.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort()
}

/**
 * THE NON-VACUITY CANARY. A census whose observation seam is dead reports every
 * producer as "never ran" -- fail-closed, but it names the wrong culprit. Assert
 * a function KNOWN to have run reports a positive count, so a broken inspector
 * session fails as ITSELF rather than as 25 phantom producer regressions.
 */
export function assertObserved(counts: CallCounts, file: string, fn: string): void {
  const n = callsTo(counts, file, fn)
  if (n > 0) return
  throw new Error(
    `RUNTIME CENSUS CANARY FAILED: ${file} :: ${fn} was driven but V8 precise coverage observed 0 calls.\n` +
    `The observation seam itself is broken (inspector session, script-URL matching, or a transform that ` +
    `renamed the function) -- NOT the producer. Observed names in ${file}: ${namesIn(counts, file).join(', ') || '<none>'}`,
  )
}
