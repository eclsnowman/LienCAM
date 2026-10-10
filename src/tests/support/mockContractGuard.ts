// WO-960: THE TYPED-MOCK RULE, ENFORCED WHERE A SPELLING CANNOT REACH IT.
//
// THE DEFECT THIS EXISTS FOR. `vi.mock('<module>', factory)` replaces a
// module's exports with whatever the factory returns. Written bare, the
// factory's object literal becomes its own contract, invented at the mock site,
// and `tsc` then checks the TEST against that literal instead of checking the
// PRODUCT against it. Three real defects in two days went through exactly that
// gap - `commandSpindle` typed from its own initial value so it could not
// express a `reason`; `runMachineAction: vi.fn(() => true)` against a product
// that had returned `{ ok, sent }` for months - and every one of them was green
// in vitest while `npm run build` was red.
//
// WHY THIS IS NOT A LINT. Three rounds of this order tried to enforce the rule
// by READING TEST SOURCE, and each round's audit found one more spelling that
// walked past it:
//
//   round 1  a value screen (`vi.fn(...)`)     -> a bare arrow in the factory
//   round 2  ... plus four more value shapes   -> a function declaration handed
//                                                 over by shorthand
//   round 3  "the factory must return a call   -> a shadowed local `typedMock`,
//            to typedMock(...)"                   then `vi.doMock(idVariable)`
//
// There was always going to be a round 4 - an aliased import, a computed
// property, a re-export. Static inspection of test source cannot be complete,
// and this order's own history is the proof. So the rule moved to the one place
// a spelling cannot change the answer: the OBJECT the factory returns either
// came out of `typedMock` or it did not.
//
//   round 5  "the object came out of         -> `Object.assign(typedMock<T>({}),
//            typedMock"                          { answer: () => 42 })` - the
//                                                helper ran, on an object that
//                                                was empty when it ran
//
// Round 5 is not a spelling, which is why it is answered somewhere else: the
// brand records the SHAPE that was checked, and `typedMockVerdict` re-reads it
// here. See src/tests/support/typedMock.ts.
//
// WHERE IT HOOKS, AND WHY NOT `vi.mock`. The obvious seam is to wrap `vi.mock`
// and `vi.doMock` on the `vi` object. That was tried first and it is WRONG, in a
// way worth writing down because it is silent: vitest resolves a mock's relative
// path against the file that called it, and it finds that file by reading its
// own stack - `getImporter()` takes the frame directly after ` at Object.mock`
// (vitest/dist/chunks/vi.*.js). A wrapper puts its own frame there, so every
// relative specifier resolves against THIS file instead of the test that wrote
// it. In this repo almost every test sits at src/tests/<dir>/<file>.test.ts -
// the same depth as this module - so `../../lib/x` happened to land in the same
// place and 1,452 tests stayed green over a broken mechanism. The controls in
// src/tests/evidence/WO-960/ are what caught it, from a fixture at another
// depth.
//
// So the hook is `queueMock` on vitest's mocker: the single funnel that
// `vi.mock`, `vi.doMock`, and anything reaching them through an alias all end
// at, AFTER vitest has done its stack reading and resolved the importer itself.
// Nothing about the call's spelling survives to that point, which is precisely
// what makes it the right place.
//
//   aliased import   `import { vi as v }`     - same funnel
//   variable id      `vi.doMock(id, ...)`     - same funnel, id already a value
//   shadowed helper  a local fake `typedMock` - never added the brand
//   hoisted `vi.mock`                         - vitest hoists the CALL, and the
//                                               call still ends here
//
// It is a vitest internal, so it is checked rather than assumed: if the seam is
// missing, this module THROWS at setup and every test file fails at once. A
// guard that quietly stops being installed is worse than no guard at all.
//
// THE BASELINE IS DEBT, NOT AN EXEMPTION. 156 test files were already mocking
// this way when the rule was written. They are recorded in
// mockContractBaseline.ts by `<file>::<module>` with the number of DISTINCT
// call sites, the list may only shrink, and WO-1052 drives it to zero. A module
// mocked untyped from MORE sites than the baseline records is new debt and goes
// red like any other.
//
// WHY DISTINCT CALL SITES AND NOT CALLS. A `vi.doMock` inside a `beforeEach`
// runs once per test, so counting CALLS would make the allowance depend on how
// many tests a run happens to execute - and a guard whose verdict moves with
// the filter is the exact failure mode this order was raised about. The call
// site is read from the stack and only its COUNT is recorded, never its line
// number: a line moves whenever anything above it is edited.

import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, afterAll } from 'vitest'
import { typedMockVerdict } from './typedMock'
import { MOCK_CONTRACT_BASELINE } from './mockContractBaseline'

// Seeding mode, used to record the baseline from a real run by
// src/tests/evidence/WO-960/record-mock-baseline.mjs. It classifies and counts
// but never throws, and it says so on stderr, so a recording run cannot be
// mistaken for an enforcing one.
const RECORD_DIR = process.env.MOCK_CONTRACT_RECORD ?? ''
const RECORDING = RECORD_DIR !== ''

type Classification = 'branded' | 'unbranded' | null

interface KeyState {
  // siteId -> what that call site's factory turned out to return. `null` while
  // the factory has not run: mock factories are LAZY, so a mock whose module is
  // never imported is registered and never classified.
  readonly sites: Map<string, Classification>
}

const observed = new Map<string, KeyState>()

const toRepoPath = (absolute: string): string => {
  const cwd = process.cwd().replace(/\\/g, '/')
  const path = absolute.replace(/^file:\/\/\//, '').replace(/\\/g, '/')
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

const GUARD_FILE = 'src/tests/support/mockContractGuard.ts'

// The first stack frame that is neither this module nor vitest's own machinery:
// the line that wrote the mock. Only ever compared for equality and counted -
// see the header for why the line number itself is never recorded.
const callSiteOf = (): string => {
  const stack = new Error('mock-contract-guard').stack ?? ''
  for (const line of stack.split('\n').slice(1)) {
    const frame = line.replace(/\\/g, '/')
    if (frame.includes(GUARD_FILE)) continue
    if (frame.includes('/node_modules/')) continue
    return frame.trim()
  }
  // No usable stack. Fall back to a value that is unique per call: it
  // over-counts rather than under-counts, so the guard can only become
  // stricter, never quieter.
  return 'unknown-site-' + String(observed.size) + '-' + String(Math.random())
}

const stateFor = (key: string): KeyState => {
  const existing = observed.get(key)
  if (existing) return existing
  const created: KeyState = { sites: new Map() }
  observed.set(key, created)
  return created
}

const countOf = (state: KeyState, what: Classification): number => {
  let total = 0
  for (const value of state.sites.values()) if (value === what) total += 1
  return total
}

// What the baseline has to cover: sites that ARE untyped, plus sites whose
// factory never ran and so could still turn out to be. Conservative on purpose
// - it is the number that must not grow, and over-stating it can only make the
// guard quieter about debt it already knows about, never blind to new debt.
const stillUntyped = (state: KeyState): number =>
  countOf(state, 'unbranded') + countOf(state, null)

const failure = (key: string, specifier: string): Error =>
  new Error(
    [
      'WO-960 UNTYPED MOCK: ' + key,
      '',
      'This factory returned an object that did not come through typedMock, so',
      'its literal is its own contract and `tsc` is checking the TEST against it',
      'instead of checking the PRODUCT against it. Write it as:',
      '',
      "  vi.mock('" + specifier + "', () => typedMock<typeof import('" + specifier + "')>({",
      '    someExport: vi.fn(...),',
      '  }))',
      '',
      "  import { typedMock } from '<relative path to>/src/tests/support/typedMock'",
      '',
      'The type argument is the real module, so a key that module does not',
      'export, or one whose type is wrong, is a build error rather than a mock',
      'nobody notices went stale. If the compiler then complains about the',
      'values, that complaint IS the defect this rule exists to surface - fix',
      'the mock, do not widen the type.',
      '',
      'src/tests/support/typedMock.ts explains why; src/tests/support/',
      'mockContractBaseline.ts holds the pre-existing sites WO-1052 is',
      'converting, and it may only shrink.',
    ].join('\n'),
  )

// WO-960 audit round 5. The other way to reach this guard with an export the
// compiler never checked: type an EMPTY object, then put the exports on that
// same object afterwards. `Object.assign(typedMock<T>({}), { answer: () => 42 })`
// returns the target by identity, so under the old membership-only brand the
// value that arrived here was branded and the guard waved it through - with no
// cast and no `tsc` error anywhere, because the intersection `Object.assign`
// produces is never assigned to `Partial<T>`.
//
// `typedMockVerdict` now answers on the SHAPE that was checked rather than on
// membership, so this arrives as its own verdict and gets its own sentence: the
// author did use the helper, and telling them to use the helper would read as a
// guard that does not understand its own rule.
const changedAfterTyping = (key: string, specifier: string): Error =>
  new Error(
    [
      'WO-960 MOCK CHANGED AFTER IT WAS TYPED: ' + key,
      '',
      'This factory called typedMock and then changed the object it got back',
      'before returning it - a property added, removed, redefined, or the',
      'prototype replaced. Only what was INSIDE the typedMock call was compared',
      "to the module, so anything put on it afterwards is an export `tsc` never",
      'looked at. `Object.assign(typedMock<T>({}), { ... })` is the common way in:',
      'it returns the same object, and its intersection type is never assigned',
      'to Partial<T>, so neither the excess-property check nor the assignment',
      'check ever sees the added key.',
      '',
      'Put every export inside the call, where the type argument can reach it:',
      '',
      "  vi.mock('" + specifier + "', () => typedMock<typeof import('" + specifier + "')>({",
      '    someExport: vi.fn(...),',
      '    theOneYouAddedAfterwards: vi.fn(...),',
      '  }))',
      '',
      'Mutating the VALUES is still fine - `mocked.someExport.mockReturnValue(x)`',
      'changes the spy, not the set of exports, and the compiler already checked',
      'the spy. It is the shape that may not move.',
      '',
      'src/tests/support/typedMock.ts explains what the brand records and why.',
    ].join('\n'),
  )

const classify = (key: string, siteId: string, specifier: string, value: unknown): unknown => {
  const state = stateFor(key)
  // vitest may run a factory again after `vi.resetModules()`. A site is
  // COUNTED once, but every execution's output is JUDGED: a replayed factory
  // that now returns an unbranded or mutated object must not ride the first
  // verdict (audit 2026-08-27 - "repeated factory executions reuse the first
  // verdict without rechecking").
  const verdict = typedMockVerdict(value)
  if (state.sites.get(siteId) == null) {
    state.sites.set(siteId, verdict === 'typed' ? 'branded' : 'unbranded')
  }
  if (RECORDING) {
    recordNow()
    return value
  }
  if (verdict === 'typed') return value

  // NO BASELINE ALLOWANCE FOR THIS ONE, ever. The baseline records sites that
  // pre-date the rule, and those factories do not call the helper at all, so
  // they cannot produce this verdict. It can only come from code written since
  // - and an allowance that covers a mistake nobody could have made before the
  // rule existed is an exemption for the bypass itself.
  if (verdict === 'changed-after-typing') {
    const error = changedAfterTyping(key, specifier)
    process.stderr.write('\n' + error.message + '\n\n')
    throw error
  }

  const allowed = MOCK_CONTRACT_BASELINE[key] ?? 0
  if (countOf(state, 'unbranded') > allowed) {
    const error = failure(key, specifier)
    // ALSO ON STDERR, because vitest REPLACES a mock factory's error with its
    // own "there was an error when mocking a module" and moves the real one to
    // `cause` (@vitest/mocker chunk-registry.js, ManualMockedModule.resolve).
    // Whether a cause gets printed is the reporter's business, and the entire
    // value of this rule is the sentence that says what to do about it.
    process.stderr.write('\n' + error.message + '\n\n')
    throw error
  }
  return value
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && typeof (value as { then?: unknown }).then === 'function'

// vitest's mocker, as `queueMock(id, importer, factoryOrOptions)`. `id` is the
// specifier exactly as the call passed it; `importer` is the absolute path of
// the file that wrote the mock, already resolved by vitest.
type QueueMock = (id: string, importer: string, factoryOrOptions?: unknown) => unknown
interface Mocker { queueMock: QueueMock }

const GUARDED = Symbol('wo960.mockContractGuard.installed')

const install = (): void => {
  const mocker = (globalThis as { __vitest_mocker__?: Mocker }).__vitest_mocker__
  if (!mocker || typeof mocker.queueMock !== 'function') {
    throw new Error(
      "WO-960: the typed-mock guard could not find vitest's mocker "
        + '(globalThis.__vitest_mocker__.queueMock). It hooks that rather than `vi.mock` '
        + 'because wrapping `vi.mock` breaks relative mock path resolution - see the header '
        + 'of src/tests/support/mockContractGuard.ts. This is almost certainly a vitest '
        + 'upgrade. Fix the hook; do NOT delete this check, or every mock in the repo goes '
        + 'unchecked with nothing going red.',
    )
  }

  // The prototype is shared across the executors a worker creates, so wrapping
  // it twice would double-count every site.
  const prototype = Object.getPrototypeOf(mocker) as Mocker
  const target = Object.prototype.hasOwnProperty.call(prototype, 'queueMock') ? prototype : mocker
  const original = target.queueMock
  if ((original as unknown as Record<symbol, unknown>)[GUARDED] === true) return

  const wrapped: QueueMock = function (this: Mocker, id, importer, factoryOrOptions) {
    // No factory means an automock or `{ spy: true }`: the mock is derived FROM
    // the real module, so it is typed to the contract by construction and there
    // is nothing here to check.
    if (typeof factoryOrOptions !== 'function') {
      return original.call(this, id, importer, factoryOrOptions)
    }

    const key = toRepoPath(importer) + '::' + id
    const siteId = callSiteOf()
    const state = stateFor(key)
    state.sites.set(siteId, state.sites.get(siteId) ?? null)
    if (RECORDING) recordNow()

    const factory = factoryOrOptions as (...args: unknown[]) => unknown
    const guarded = (...args: unknown[]): unknown => {
      const produced = factory(...args)
      // A factory may be `async` or hand back a promise; the object to judge is
      // what it RESOLVES to.
      return isThenable(produced)
        ? Promise.resolve(produced).then((value) => classify(key, siteId, id, value))
        : classify(key, siteId, id, produced)
    }

    return original.call(this, id, importer, guarded)
  }

  Object.defineProperty(wrapped, GUARDED, { value: true, enumerable: false })
  target.queueMock = wrapped
}

install()

if (RECORDING) {
  process.stderr.write(
    'WO-960 MOCK CONTRACT GUARD IS RECORDING, NOT ENFORCING '
      + '(MOCK_CONTRACT_RECORD=' + RECORD_DIR + ')\n',
  )
}

// THE RATCHET, measured rather than declared. A baseline entry for a file that
// RAN and no longer needs it is a stale allowance - the debt was paid and the
// list did not shrink - so it goes red and says the number to write.
//
// An entry whose call site did not execute at all this run is skipped, not
// judged: a `vi.doMock` inside a test the filter left out registers nothing,
// and a guard that goes red because of which tests you chose to run is the
// failure mode this whole order was raised about.
afterAll(() => {
  const state = (expect as unknown as { getState: () => { testPath?: string } }).getState()
  const prefix = toRepoPath(state.testPath ?? '') + '::'
  const stale: string[] = []

  for (const [key, allowed] of Object.entries(MOCK_CONTRACT_BASELINE)) {
    if (!key.startsWith(prefix)) continue
    const seen = observed.get(key)
    if (!seen || seen.sites.size === 0) continue
    const remaining = stillUntyped(seen)
    if (remaining < allowed) {
      // Single quotes and a trailing comma, so the line below can be pasted
      // straight into mockContractBaseline.ts, which is written that way.
      stale.push(
        "  '" + key + "': " + String(remaining) + ',' + '   // was ' + String(allowed),
      )
    }
  }

  if (stale.length > 0 && !RECORDING) {
    throw new Error(
      [
        'WO-960 THE TYPED-MOCK BASELINE IS STALE - it may only shrink, and it did not.',
        '',
        'These mocks are typed now, so the allowance recorded for them is debt',
        'that has already been paid. Edit src/tests/support/mockContractBaseline.ts',
        'to read:',
        '',
        ...stale,
        '',
        'A zero means the entry goes away entirely. Leaving the old number there',
        'would let the NEXT untyped mock of that module inherit an exemption',
        'nobody meant to give it, which is how a guard rots into decoration.',
      ].join('\n'),
    )
  }
})

// Seeding only. One JSON file per test file, merged by
// src/tests/evidence/WO-960/record-mock-baseline.mjs - vitest forks per test
// file, so a shared file would be a write race.
//
// Written EAGERLY, at every registration and every classification, rather than
// from a hook at the end. `afterAll` does not run for a file whose every suite
// is skipped, and a vitest worker does not run `process.on('exit')` handlers at
// all - both were tried. An env-gated diagnostic probe (EXAMPLE_PROBE,
// WO459_PROBE) is exactly a file with no unskipped suites, and its hoisted mocks
// are still registered and its factories still run at collection, so recording
// only from a hook would have left it out of the baseline and the guard would
// have fired the day someone set the env var.
function recordNow(): void {
  const byFile = new Map<string, Record<string, number>>()
  for (const [key, seen] of observed) {
    const file = key.slice(0, key.indexOf('::'))
    // Every file that registered anything gets a record, even an EMPTY one.
    // A registration is written before its factory has run, so it is counted as
    // possibly-untyped; when the factory turns out to be typed the count drops
    // to zero and the file must be REWRITTEN, not left as it was. Skipping the
    // write here is what made typedMock.proof.test.ts - a correctly typed mock -
    // record itself as debt.
    const bucket = byFile.get(file) ?? {}
    byFile.set(file, bucket)
    const remaining = stillUntyped(seen)
    if (remaining > 0) bucket[key] = remaining
  }
  mkdirSync(RECORD_DIR, { recursive: true })
  for (const [file, counts] of byFile) {
    const safe = file.replace(/[^a-zA-Z0-9]+/g, '_')
    writeFileSync(RECORD_DIR + '/' + safe + '.json', JSON.stringify(counts, null, 2), 'utf8')
  }
}
