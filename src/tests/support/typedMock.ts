// WO-960: THE ONE TYPED HELPER EVERY MOCK FACTORY MUST RETURN THROUGH.
//
//   A MOCK IS A CLAIM ABOUT A CONTRACT, AND NOTHING CHECKS IT UNLESS IT IS
//   TYPED TO THE CONTRACT.
//
// `vi.mock('<module>', factory)` REPLACES that module's exports with whatever
// the factory hands back. Written bare, the factory's object literal is its own
// contract, invented at the mock site, and `tsc` then enforces THAT against the
// test instead of enforcing the PRODUCT against it. Three real defects in two
// days went through exactly that gap, every one of them green in vitest.
//
//   vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
//     commandSpindle: vi.fn((..._a: unknown[]): SpindleCommandResult => ({ ok: true, route: 'calls' })),
//   }))
//
// The type parameter is the REAL MODULE. From there the compiler does the work,
// and it does not care what shape the value was written in:
//
//   - a property that is not an export of that module is an excess-property
//     error, so a typo'd or renamed export is `tsc` red rather than a mock
//     nobody notices is dead;
//   - a property whose type does not match the real export's is an assignment
//     error, whatever spelling produced it - arrow, declaration, shorthand,
//     spy, or a value forwarded from three files away.
//
// PARTIAL ON PURPOSE. A factory may legitimately replace a few exports of a
// large module, so missing keys are allowed. What is not allowed is a key the
// module does not export, or one whose type is wrong.
//
// `NoInfer` IS THE LOAD-BEARING PART. Without it, `typedMock({ ... })` would
// infer `TModule` FROM THE LITERAL ITSELF - the shape would become its own
// contract again and the helper would check nothing while looking like it did.
// With `NoInfer` there is no inference site left, so an omitted type argument
// falls back to the DEFAULT below rather than to the literal.

// The type argument is not optional, and that is enforced by the default rather
// than left to a rule test alone. `unknown` would not do it: `Partial<unknown>`
// is `{}`, which accepts every object there is. So the fallback is a named type
// with one impossible key - omit the type argument and every property becomes
// an excess-property error that says what is missing.
export interface TypedMockNeedsTheModuleType {
  readonly __typedMock_needs_a_type_argument__: never
}

// WO-960 ROUND 4 - THE BRAND, AND WHY IT IS A WeakMap RATHER THAN A SYMBOL.
//
// Three rounds of this order tried to enforce the rule by READING TEST SOURCE:
// first by judging the values inside a factory, then by requiring the factory to
// return a call to this helper. Each audit found one more spelling - a bare
// arrow, a function declaration by shorthand, a shadowed local `typedMock`, then
// `vi.doMock(moduleIdVariable, ...)`. Static inspection of test source cannot be
// complete, so the rule moved to where a spelling cannot reach it: the OBJECT
// the factory actually returns either came through this function or it did not.
//
// A WeakMap rather than a non-enumerable Symbol property because a Symbol brand
// is copyable. `Symbol.for(...)` is in a global registry anyone can look up, and
// even a module-private symbol is reachable from a branded object through
// `Object.getOwnPropertySymbols` and can then be planted on any object with
// `Object.defineProperty`. An entry in a map that is never exported cannot be
// obtained except by calling `typedMock`, which is the whole point: the brand is
// not a mark that can be forged, it is the fact that this function ran.
//
// The map holds its keys weakly, so a mock factory's return value is collected
// exactly as it would be without the brand.
//
// WO-960 ROUND 5 - AND WHY THE BRAND IS A SHAPE AND NOT MERE MEMBERSHIP.
//
// Audit round 5. Membership alone proves only that this object was handed to
// this function AT SOME EARLIER INSTANT. It does not prove that the object the
// factory finally returns still has the shape the compiler checked, because the
// value comes back by IDENTITY and JavaScript objects are mutable:
//
//   vi.mock('./mod', () => Object.assign(
//     typedMock<typeof import('./mod')>({}),   // checked: nothing
//     { answer: () => 42 },                    // real contract: () => string
//   ))
//
// `Object.assign` returns its TARGET, so the branded object came back out with
// an export on it that `tsc` never compared to the module - no cast and no
// error, because the intersection `Object.assign` produces is never assigned to
// `Partial<TModule>` and so neither half of the rule ever looked at `answer`.
//
// So the brand records WHAT WAS CHECKED rather than merely THAT something was:
// the object's own keys and, per key, the value or the accessor functions its
// descriptor held, plus its prototype. The verdict re-reads that at the moment
// the guard asks, and an object that drifted is no longer typed - anything
// added, removed, redefined or re-parented after the check is by definition an
// export the compiler never saw.
//
// THIS DOES NOT REACH INSIDE THE VALUES, and must not. `answer.mockReturnValue(
// 'x')` mutates the SPY, not the mock object: same key, same value identity,
// still typed. What is rejected is the set of exports changing after the check,
// which is the only thing the compiler was ever looking at.
interface CheckedSlot {
  readonly hasValue: boolean
  readonly value: unknown
  readonly get: unknown
  readonly set: unknown
}

interface CheckedShape {
  readonly prototype: unknown
  readonly slots: ReadonlyMap<string | symbol, CheckedSlot>
}

const BRANDED = new WeakMap<object, CheckedShape>()

const isObjectLike = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

// Read WITHOUT invoking anything: a getter is recorded as its function and is
// never called. A mock that computes an export lazily must not be run by the
// guard - that would make the rule change what the mock DOES, and this helper's
// whole claim is that it changes nothing except whether the compiler looked.
const shapeOf = (target: object): CheckedShape => {
  const slots = new Map<string | symbol, CheckedSlot>()
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
    const hasValue = descriptor !== undefined && 'value' in descriptor
    slots.set(key, {
      hasValue,
      value: hasValue ? (descriptor as PropertyDescriptor).value : undefined,
      get: descriptor?.get,
      set: descriptor?.set,
    })
  }
  return { prototype: Reflect.getPrototypeOf(target), slots }
}

const stillTheCheckedShape = (target: object, checked: CheckedShape): boolean => {
  if (Reflect.getPrototypeOf(target) !== checked.prototype) return false
  const keys = Reflect.ownKeys(target)
  // Count first, so a key REMOVED since the check is caught as surely as one
  // added - `keys` being a subset of the recorded slots is not enough.
  if (keys.length !== checked.slots.size) return false
  for (const key of keys) {
    const before = checked.slots.get(key)
    if (before === undefined) return false
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
    if (descriptor === undefined) return false
    const hasValue = 'value' in descriptor
    if (hasValue !== before.hasValue) return false
    if (hasValue && !Object.is(descriptor.value, before.value)) return false
    if (descriptor.get !== before.get) return false
    if (descriptor.set !== before.set) return false
  }
  return true
}

export const typedMock = <TModule = TypedMockNeedsTheModuleType>(
  shape: Partial<NoInfer<TModule>>,
): Partial<TModule> => {
  // Identity at runtime. The value handed to vitest is the same object the
  // caller wrote, so the helper cannot change what a mock DOES - only whether
  // the compiler was made to check it.
  if (isObjectLike(shape)) {
    BRANDED.set(shape, shapeOf(shape))
  }
  return shape
}

// What the guard learns about one object. THREE answers and not two, because
// "typed, then changed behind the compiler's back" is a different mistake from
// "never typed at all" and the person who wrote it needs a different sentence:
// telling them to wrap it in `typedMock` when they already did is how a guard
// teaches people that it does not understand its own rule.
export type TypedMockVerdict = 'typed' | 'changed-after-typing' | 'untyped'

export const typedMockVerdict = (value: unknown): TypedMockVerdict => {
  if (!isObjectLike(value)) return 'untyped'
  const checked = BRANDED.get(value)
  if (checked === undefined) return 'untyped'
  return stillTheCheckedShape(value, checked) ? 'typed' : 'changed-after-typing'
}

// Asked by src/tests/support/mockContractGuard.ts, and by nothing else. It is a
// question about one object, not a search for a pattern in a file.
export const isTypedMock = (value: unknown): boolean => typedMockVerdict(value) === 'typed'
