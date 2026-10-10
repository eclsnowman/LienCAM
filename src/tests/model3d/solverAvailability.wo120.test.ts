// WO-120: the three states, and the words each one is allowed to use.
//
// SolidsWorkbenchPage.solverExhaustedSeams.wo120.test.tsx proves the end-to-end
// behaviour on the real page. This file pins the small pure thing underneath it,
// so a future edit that changes a message cannot quietly reintroduce the defect
// without a named, cheap failure pointing straight at the string.

import { describe, it, expect } from 'vitest'
import {
  resolveSolverAvailability,
  unsolvedDocumentNotice,
  unverifiableApplyNotice,
} from '../../components/model3d/workbench/solverAvailability'

/** No sentence for a TERMINAL solver may promise a later success. These are the
 *  exact words the seams used to say forever after exhaustion. */
const FALSE_HOPE = [/loading/i, /try again/i, /in a moment/i] as const

describe('WO-120 resolveSolverAvailability: a null wrapper stops meaning two things', () => {
  it('a live wrapper is READY whatever the host declared - a stale declaration can never suppress a real solve', () => {
    expect(resolveSolverAvailability({ wrapper: {}, solverStatus: 'unavailable' })).toBe('ready')
    expect(resolveSolverAvailability({ wrapper: {}, solverStatus: 'loading' })).toBe('ready')
  })

  it('reports exactly what the host declared when there is no wrapper', () => {
    expect(resolveSolverAvailability({ wrapper: null, solverStatus: 'not-started' })).toBe('not-started')
    expect(resolveSolverAvailability({ wrapper: null, solverStatus: 'loading' })).toBe('loading')
    expect(resolveSolverAvailability({ wrapper: null, solverStatus: 'unavailable' })).toBe('unavailable')
  })

  it('defaults an undeclared host to LOADING - byte-for-byte the assumption every seam made before this WO', () => {
    // The only host that can actually REACH exhaustion is SolidsWorkbenchPage,
    // and it declares the field. The rest are test harnesses standing in for
    // "the solver has not booted here", which is what this default says.
    expect(resolveSolverAvailability({ wrapper: null })).toBe('loading')
  })

  it('unbound deps are NOT STARTED - there is no host, so nothing is in flight', () => {
    expect(resolveSolverAvailability(null)).toBe('not-started')
  })
})

describe('WO-120 the document seam names the state it is in', () => {
  it('the terminal message never promises a later success, and says what does help', () => {
    const said = unsolvedDocumentNotice('unavailable')
    expect(said).toMatch(/solver is unavailable/i)
    for (const forbidden of FALSE_HOPE) expect(said).not.toMatch(forbidden)
    expect(said).toMatch(/reload the page/i)
    // The geometry survives, and the user is told so in the same breath.
    expect(said).toMatch(/exactly as drawn/i)
  })

  it('loading and not-started stay distinct, and both are honest about waiting', () => {
    expect(unsolvedDocumentNotice('loading')).toMatch(/still loading/i)
    expect(unsolvedDocumentNotice('not-started')).toMatch(/has not started/i)
    expect(unsolvedDocumentNotice('loading')).not.toBe(unsolvedDocumentNotice('not-started'))
  })
})

describe('WO-120 the verdict seam names the state it is in', () => {
  it('the terminal message names the refused action and drops "try again in a moment"', () => {
    const said = unverifiableApplyNotice('unavailable', 'Fix')
    expect(said).toMatch(/^Fix was not applied/)
    expect(said).toMatch(/solver is unavailable/i)
    for (const forbidden of FALSE_HOPE) expect(said).not.toMatch(forbidden)
  })

  it('keeps the loading message it always had, now said only when it is true', () => {
    expect(unverifiableApplyNotice('loading', 'Fix'))
      .toBe('Fix: the sketch solver is still loading. Try again in a moment.')
    expect(unverifiableApplyNotice('not-started', 'Fix')).toMatch(/has not started/i)
  })
})
