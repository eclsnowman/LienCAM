// WO-960: a module that exists only to be mocked by mockContractGuard.test.ts.
//
// The rule test has to mock something a dozen ways in one file, so it mocks
// this: two exports, no dependencies, nothing to load. Mocking a real product
// module there would make the test's cost depend on that module's import graph,
// and this order was raised about a guard that went red for being slow.
//
// The rule's claim about REAL modules is proven next door, in
// typedMock.proof.test.ts, which types a hoisted `vi.mock` factory to an actual
// product module - and in src/tests/evidence/WO-960/typed-mock-tsc-control.mjs,
// which shows the compiler rejecting a wrongly typed one.

export const answer = (): string => 'real'

export const twice = (value: number): number => value * 2
