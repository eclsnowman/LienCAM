// WO-960: THE RULE TEST. Every spelling five audit rounds found, run against
// the REAL guard.
//
// Cases 1-7 are SPELLINGS - ways of writing a mock that never came through the
// helper. Cases 8-10 are round 5's class, which is not a spelling at all: the
// helper DID run, and the object it checked was changed afterwards.
//
// These are not unit tests of a parser. There is no parser any more. Each case
// registers a mock through the actual `vi` object, in this actual test file,
// with the actual guard installed by the actual setup file, and then imports the
// module - so what is proven is that the rule holds where a test author stands,
// not that some function returns the right verdict when called by hand.
//
// The first case is also the POSITIVE CONTROL for the whole file: if the setup
// wiring in vite.config.mts or src/tests/setup/localStoragePolyfill.ts is ever
// removed, an untyped mock stops throwing and case 1 goes red immediately. A
// rule test that could pass with its own rule uninstalled would be this order's
// sixth finding all over again.
//
// WHY `vi.doMock` AND NOT `vi.mock`. A bare `vi.mock` is hoisted to the top of
// the file, so a case that must FAIL would take the whole file down with it and
// there would be nothing left to assert. `vi.doMock` registers where it is
// written and its factory runs on the next dynamic import, so the failure is
// catchable. Both spellings go through the same wrapper - `install('mock')` and
// `install('doMock')` in mockContractGuard.ts are one function called twice -
// and the hoisted path is proven working in typedMock.proof.test.ts and proven
// FAILING, as a whole-file red, in
// src/tests/evidence/WO-960/runtime-evasion-control.mjs.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { vi as viUnderAnotherName } from 'vitest'
import { typedMock } from './typedMock'
import { MOCK_CONTRACT_BASELINE } from './mockContractBaseline'

const FIXTURE = './mockContractFixture'

afterEach(() => {
  vi.doUnmock(FIXTURE)
  vi.resetModules()
})

// Vitest REPLACES a mock factory's error with its own "[vitest] There was an
// error when mocking a module" and moves the real one to `cause`
// (@vitest/mocker chunk-registry.js, ManualMockedModule.resolve). So the rule's
// own sentence is read off the cause chain rather than the top-level message,
// and the message is checked WHOLE - if a future vitest stops wrapping, the
// fallback to `error.message` still finds it.
const rejectionNaming = async (load: Promise<unknown>, headline: string): Promise<string> => {
  let thrown: unknown
  try {
    await load
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'importing a mock the rule rejects should have thrown').toBeInstanceOf(Error)

  const chain: string[] = []
  for (let error: unknown = thrown; error instanceof Error; error = (error as { cause?: unknown }).cause) {
    chain.push(error.message)
  }
  const ours = chain.find((message) => message.includes(headline))
  expect(ours, 'no "' + headline + '" anywhere in the cause chain: ' + chain.join(' <- ')).toBeTypeOf('string')
  return ours as string
}

const untypedMockRejection = async (load: Promise<unknown>): Promise<string> =>
  rejectionNaming(load, 'WO-960 UNTYPED MOCK')

// The round-5 verdict is a DIFFERENT headline on purpose, and the cases below
// assert which one they got: an author who did call the helper and then moved
// the shape must not be told to call the helper.
const changedAfterTypingRejection = async (load: Promise<unknown>): Promise<string> =>
  rejectionNaming(load, 'WO-960 MOCK CHANGED AFTER IT WAS TYPED')

describe('WO-960 an untyped mock cannot be written, whatever it is spelled like', () => {
  it('1. POSITIVE CONTROL: a bare object literal throws when the factory runs', async () => {
    vi.doMock(FIXTURE, () => ({ answer: () => 'mocked' }))
    const message = await untypedMockRejection(import(FIXTURE))

    // The message is the whole point of the guard, so it is asserted rather
    // than assumed: it names the site, and it says what to write instead.
    expect(message).toContain('src/tests/support/mockContractGuard.test.ts::./mockContractFixture')
    expect(message).toContain("typedMock<typeof import('./mockContractFixture')>")
  })

  it('2. a shadowed local helper called typedMock does not brand anything', async () => {
    // Audit round 3's evasion. The static rule required the factory to RETURN a
    // call to `typedMock`, and a local one satisfied that syntactically while
    // typing nothing. A brand is not a name, so this is now indistinguishable
    // from case 1 - which is exactly the point.
    const typedMock = <T,>(shape: T): T => shape
    vi.doMock(FIXTURE, () => typedMock({ answer: () => 'mocked' }))
    await untypedMockRejection(import(FIXTURE))
  })

  it('3. a module id held in a variable is read, not parsed', async () => {
    // Audit round 3's second evasion: `vi.doMock(moduleIdVariable, ...)`. A
    // source screen has no string to key on. The wrapper has the value.
    const id = FIXTURE
    vi.doMock(id, () => ({ answer: () => 'mocked' }))
    await untypedMockRejection(import(FIXTURE))
  })

  it('4. an aliased vi import is the same object and the same wrapper', async () => {
    viUnderAnotherName.doMock(FIXTURE, () => ({ answer: () => 'mocked' }))
    await untypedMockRejection(import(FIXTURE))
  })

  it('5. a factory built elsewhere and handed over as a value is still judged', async () => {
    // The value shapes rounds 1 and 2 enumerated - a bare arrow, a function
    // declaration by shorthand, a factory forwarded from another module - all
    // collapse into this one case, because nothing about HOW the factory was
    // written is looked at. Only what it returns.
    function buildIt() {
      return { answer: () => 'mocked' }
    }
    const factory = buildIt
    vi.doMock(FIXTURE, factory)
    await untypedMockRejection(import(FIXTURE))
  })

  it('6. an async factory is judged on what it RESOLVES to', async () => {
    vi.doMock(FIXTURE, async () => ({ answer: () => 'mocked' }))
    await untypedMockRejection(import(FIXTURE))
  })

  it('7. spreading a typed mock loses the brand, because it loses the check', async () => {
    // Not an evasion the audit found - a trap a well-meaning author would walk
    // into. `{ ...typedMock<T>({...}), extra }` is a NEW object whose excess
    // property was never checked against the module, so it must not inherit the
    // brand. It does not, because the brand is the fact that the helper ran on
    // THIS object, not a mark copied along with the properties.
    vi.doMock(FIXTURE, () => ({
      ...typedMock<typeof import('./mockContractFixture')>({ answer: () => 'mocked' }),
    }))
    await untypedMockRejection(import(FIXTURE))
  })

  it('8. Object.assign onto a typed mock adds an export nothing checked', async () => {
    // AUDIT ROUND 5, and the exact construction it wrote. Case 7's control
    // covers a COPY of a branded object; this is the opposite move and there was
    // no control for it - the SAME object, augmented in place. `Object.assign`
    // returns its target by identity, so under a membership-only brand the value
    // arriving at the guard was branded and went straight through.
    //
    // Nothing here is cast and nothing here is a `tsc` error: `Object.assign`
    // produces an intersection, the intersection is never assigned to
    // `Partial<typeof import(...)>`, and so neither the excess-property check nor
    // the assignment check ever looks at `answer` - whose real contract is
    // `() => string`. The compiler is genuinely satisfied. Only the runtime
    // verdict can catch it, which is why it is caught here.
    vi.doMock(FIXTURE, () => Object.assign(
      typedMock<typeof import('./mockContractFixture')>({}),
      { answer: () => 42 },
    ))
    const message = await changedAfterTypingRejection(import(FIXTURE))
    expect(message).toContain('src/tests/support/mockContractGuard.test.ts::./mockContractFixture')
    expect(message).toContain('Put every export inside the call')
  })

  it('9. redefining a property after typing is judged too, not just adding one', async () => {
    // `Object.defineProperty` takes an `unknown` value, so it is the other way
    // to put an unchecked export on a checked object - and it can overwrite a
    // key that WAS checked, which a key-set comparison alone would miss. The
    // brand records the descriptor, so the substitution is what goes red.
    vi.doMock(FIXTURE, () => {
      const mock = typedMock<typeof import('./mockContractFixture')>({ answer: () => 'mocked' })
      Object.defineProperty(mock, 'answer', { value: () => 42, enumerable: true, configurable: true })
      return mock
    })
    await changedAfterTypingRejection(import(FIXTURE))
  })

  it('10. a typed mock stripped back down after the check is not still typed', async () => {
    // Deleting is the mirror of adding, and it matters for the same reason: the
    // object handed to vitest is no longer the one the compiler was shown. A
    // subset test would have called this typed.
    vi.doMock(FIXTURE, () => {
      const mock = typedMock<typeof import('./mockContractFixture')>({ answer: () => 'mocked' })
      Reflect.deleteProperty(mock, 'answer')
      return mock
    })
    await changedAfterTypingRejection(import(FIXTURE))
  })
})

describe('WO-960 this file is never baselined, or it would prove nothing', () => {
  it('has no allowance of its own in the baseline', () => {
    // Seven cases above are untyped mocks ON PURPOSE. If any of them were ever
    // recorded as debt, the guard would stop throwing for this file and all
    // seven would pass by being allowed rather than by being caught - a test
    // that is green, honest about what it measured, and useless for the thing
    // it exists to catch. That is this order's own founding finding, so it gets
    // an assertion rather than a comment in the recorder.
    const mine = Object.keys(MOCK_CONTRACT_BASELINE).filter((key) =>
      key.startsWith('src/tests/support/mockContractGuard.test.ts::'),
    )
    expect(mine, 'the rule test must never buy itself an exemption').toEqual([])
  })
})

describe('WO-960 what the rule ALLOWS, so it is a rule and not a ban on mocking', () => {
  it('a factory that returns through typedMock passes, and actually mocks', async () => {
    vi.doMock(FIXTURE, () => typedMock<typeof import('./mockContractFixture')>({
      answer: () => 'mocked',
    }))
    const mocked = await import(FIXTURE)
    expect(mocked.answer()).toBe('mocked')
  })

  it('a partial mock is allowed: only the exports it names are replaced', async () => {
    // The helper takes a `Partial`, on purpose - a factory may legitimately
    // replace two exports of a twenty-export module. What it may not do is name
    // an export that does not exist, or give one the wrong type; both of those
    // are `tsc` errors, shown in evidence/WO-960/typed-mock-tsc-control.log.
    vi.doMock(FIXTURE, () => typedMock<typeof import('./mockContractFixture')>({
      twice: (value: number) => value * 3,
    }))
    const mocked = await import(FIXTURE)
    expect(mocked.twice(4)).toBe(12)
  })

  it('a spy configured after typing is still typed - the VALUES may move', async () => {
    // The round-5 check is about the SET OF EXPORTS, and it has to stop there.
    // `mockReturnValue` mutates the spy, and the spy is the same object at the
    // same key that the compiler already checked, so the mock is untouched as
    // far as the contract goes. A rule that rejected this would ban the ordinary
    // way of configuring a mock and would be routed around within a week.
    vi.doMock(FIXTURE, () => {
      const answer = vi.fn(() => 'first')
      const mock = typedMock<typeof import('./mockContractFixture')>({ answer })
      answer.mockReturnValue('second')
      return mock
    })
    const mocked = await import(FIXTURE)
    expect(mocked.answer()).toBe('second')
  })

  it('an automock has no factory to judge and is left alone', async () => {
    // `vi.doMock(path)` derives the mock FROM the real module, so it is typed to
    // the contract by construction. There is no literal to invent and nothing
    // for this rule to check.
    vi.doMock(FIXTURE)
    const mocked = await import(FIXTURE)
    expect(mocked.answer()).toBeUndefined()
  })
})
