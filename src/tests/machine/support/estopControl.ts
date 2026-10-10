import { expect } from 'vitest'
import { screen } from '@testing-library/react'

/**
 * WO-469, Operator's ruling 2026-08-22: THE E-STOP CONTROL HAS TWO MODES AND THE
 * MODE DECIDES WHICH CONTROL IT IS.
 *
 *   armed   -> it is an E-STOP. A click STOPS, and only stops.
 *   stopped -> it flashes, it is a CLEAR, and a click clears, returning it to
 *              the armed E-STOP.
 *
 * The visible WORD follows the mode deliberately. It is the mitigation for the
 * one risk Operator named and accepted - an operator stabbing the flashing control
 * meaning to STOP will CLEAR instead - and the work order states it as an
 * implementation constraint: the two must be unmistakably different controls,
 * "a different label, not merely a different colour".
 *
 * The consequence for tests: `getByRole('button', { name: 'E-STOP' })` no
 * longer means "the E-STOP control is on screen". It means "the control is in
 * its ARMED mode", which a fixture that has not cleared the WO-328 startup
 * latch never is. Tests whose subject is the control's PRESENCE - it stays
 * visible in every subview, there is exactly one of it, it is absent here -
 * use the two helpers below instead. They ask for the CONTROL and then check
 * that its word matches its mode, so nothing those tests used to pin is
 * dropped: the counts, the present/absent verdicts and the accessible-name
 * requirement all survive, and the mode/label agreement is new on top.
 */
const MODE_LABEL = { estop: 'E-STOP', clear: 'CLEAR' } as const

type EstopMode = keyof typeof MODE_LABEL

/**
 * Exactly one E-STOP control on screen, in whichever mode it is in, carrying
 * the word that mode requires - as its visible text AND as its accessible
 * name, so an aria-label can never drift away from what the operator reads.
 */
export function expectOneEstopControl(): HTMLButtonElement {
  const found = screen.getAllByTestId('control-estop')
  expect(found).toHaveLength(1)
  const el = found[0] as HTMLButtonElement
  const mode = el.getAttribute('data-estop-mode') as EstopMode | null
  expect(mode === 'estop' || mode === 'clear').toBe(true)
  const label = MODE_LABEL[mode as EstopMode]
  expect(el.textContent?.trim()).toBe(label)
  expect(screen.getAllByRole('button', { name: label })).toHaveLength(1)
  return el
}

/**
 * No E-STOP control on screen in EITHER mode. Strictly stronger than the
 * single-name query this replaces, which could only ever see one of the two.
 */
export function expectNoEstopControl(): void {
  expect(screen.queryAllByTestId('control-estop')).toHaveLength(0)
  expect(screen.queryAllByRole('button', { name: MODE_LABEL.estop })).toHaveLength(0)
  expect(screen.queryAllByRole('button', { name: MODE_LABEL.clear })).toHaveLength(0)
}

/** Refusals reported to the console, read from the caller's own store import
 *  (each test file imports the store after its own localStorage shim, so this
 *  helper takes it rather than importing a second, different instance). */
export function consoleRefusalsFrom(store: {
  getState: () => { consoleLines: Array<{ text: string; severity: string }> }
}): string[] {
  return store
    .getState()
    .consoleLines.filter((l) => l.severity === 'error')
    .map((l) => l.text)
}
