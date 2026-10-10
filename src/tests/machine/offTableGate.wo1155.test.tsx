// @vitest-environment jsdom

import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProgramEnvelopeFit } from '../../lib/machine/machineEnvelope'
import {
  currentOperatorTransport,
  PROGRAM_FIT_REMEDY,
} from '../../lib/machine/operatorTransport'
import {
  programFitSentence,
  publishProgramFit,
  resetProgramFitConsole,
} from '../../components/machine/ProgramFitStatusLine'
import { useMachineControl, type MachineJobState } from '../../store/machineControlStore'

const READY_JOB: MachineJobState = {
  phase: 'ready',
  name: 'off-table.nc',
  totalLines: 3,
  sentLines: 0,
  ackedLines: 0,
  ackedSourceLine: 0,
  sentSourceLine: 0,
  startedAt: null,
  pausedAt: null,
  error: null,
  toolChanges: [],
}

const AXIS = {
  axis: 'x' as const,
  programMin: 10,
  programMax: 20,
  machineMin: -100,
  machineMax: 0,
}

const FITS: Record<ProgramEnvelopeFit['state'], ProgramEnvelopeFit> = {
  inside: { state: 'inside', axes: [{ ...AXIS, state: 'inside' }], offending: [] },
  partial: {
    state: 'partial',
    axes: [{ ...AXIS, programMin: -10, state: 'partial' }],
    offending: [{ ...AXIS, programMin: -10, state: 'partial' }],
  },
  outside: {
    state: 'outside',
    axes: [{ ...AXIS, state: 'outside' }],
    offending: [{ ...AXIS, state: 'outside' }],
  },
}

function readySession(): void {
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    homed: true,
    activeWcs: 'G54',
    job: READY_JOB,
    programText: 'G21 G90\nG1 X10\nM30',
    programReadiness: { ready: true, reason: 'Program checks passed.' },
    programFit: null,
    singleBlock: false,
    fitTrace: null,
    toolChange: null,
    consoleLines: [],
  })
}

function publish(state: ProgramEnvelopeFit['state']): void {
  publishProgramFit({ fit: FITS[state], wcs: 'G54' })
}

beforeEach(() => {
  publishProgramFit(null)
  resetProgramFitConsole()
  readySession()
})

afterEach(() => {
  publishProgramFit(null)
  resetProgramFitConsole()
})

describe('WO-1155 off-table CYCLE START gate', () => {
  it('gates outside, but deliberately leaves inside and partial programs enabled', () => {
    const evidence: Record<string, unknown> = {}

    for (const state of ['inside', 'partial', 'outside'] as const) {
      publish(state)
      const verdict = currentOperatorTransport()
      const expectedEnabled = state !== 'outside'
      expect(verdict.cycleStartEnabled).toBe(expectedEnabled)
      expect(verdict.action).toBe(expectedEnabled ? 'start' : 'none')
      if (state === 'outside') {
        expect(verdict.nextAction).toContain('entirely off the table on X')
        expect(verdict.nextAction).toContain(PROGRAM_FIT_REMEDY)
        expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain(
          'X: program 10.00..20.00, table -100.00..0.00',
        )
      } else {
        expect(verdict.nextAction).toBe('Program checks passed. CYCLE START begins the program.')
      }
      if (state === 'inside') expect(useMachineControl.getState().consoleLines).toEqual([])
      evidence[state] = {
        fitState: state,
        storeValue: useMachineControl.getState().programFit,
        cycleStartEnabled: verdict.cycleStartEnabled,
        nextAction: verdict.nextAction,
      }
    }

    // WO-1093: evidence is written only under WRITE_EVIDENCE=1, so a slice run cannot regenerate an artifact another lane is reading.
    if (process.env.WRITE_EVIDENCE === '1') {
      mkdirSync('src/tests/evidence/WO-1155', { recursive: true })
      writeFileSync(
      'src/tests/evidence/WO-1155/gate-states.json',
      `${JSON.stringify(evidence, null, 2)}\n`,
      )
    }
  })

  it('restores the outside gate after disconnect when the preview republishes the identical verdict', () => {
    const published = { fit: FITS.outside, wcs: 'G54' }
    publishProgramFit(published)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)

    useMachineControl.getState().setConnection('disconnected', 'Cable removed.')
    expect(useMachineControl.getState().programFit).toBeNull()

    readySession()
    // Preserve the store's null to model reconnect before ProgramPreview's
    // effect runs. The module cache still holds `published` from above.
    publishProgramFit(published)
    const verdict = currentOperatorTransport()
    expect(useMachineControl.getState().programFit).toEqual({
      state: 'outside',
      sentence: programFitSentence(FITS.outside, 'G54'),
    })
    expect(verdict).toMatchObject({ action: 'none', cycleStartEnabled: false })

    const path = 'src/tests/evidence/WO-1155/gate-states.json'
    // WO-1093: evidence is written only under WRITE_EVIDENCE=1, so a slice run cannot regenerate an artifact another lane is reading.
    if (process.env.WRITE_EVIDENCE === '1') {
      mkdirSync('src/tests/evidence/WO-1155', { recursive: true })
    }
    const base = {
      inside: evidenceFor('inside'),
      partial: evidenceFor('partial'),
      outside: evidenceFor('outside'),
      reconnect: {
        fitState: 'outside',
        storeValueAfterDisconnect: null,
        storeValueAfterRepublish: useMachineControl.getState().programFit,
        cycleStartEnabled: verdict.cycleStartEnabled,
        nextAction: verdict.nextAction,
      },
    }
    // WO-1093: evidence is written only under WRITE_EVIDENCE=1, so a slice run cannot regenerate an artifact another lane is reading.
    if (process.env.WRITE_EVIDENCE === '1') {
      writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`)
    }
  })

  it('does not replace the store object when an unchanged fit is republished', () => {
    publish('outside')
    const first = useMachineControl.getState().programFit
    publishProgramFit({ fit: { ...FITS.outside }, wcs: 'G54' })
    expect(useMachineControl.getState().programFit).toBe(first)
  })

  it('clears a prior fit for different program text but preserves it for a same-text re-arm', () => {
    publish('outside')
    const fit = useMachineControl.getState().programFit
    const text = useMachineControl.getState().programText

    useMachineControl.getState().setProgram('same.nc', text)
    expect(useMachineControl.getState().programFit).toBe(fit)

    useMachineControl.getState().setProgram('different.nc', 'G21 G90\nG1 X-50\nM30')
    expect(useMachineControl.getState().programFit).toBeNull()
  })
})

function evidenceFor(state: ProgramEnvelopeFit['state']) {
  const sentence = programFitSentence(FITS[state], 'G54')
  const programFit = { state, sentence }
  useMachineControl.setState({ programFit })
  const verdict = currentOperatorTransport()
  return {
    fitState: state,
    storeValue: programFit,
    cycleStartEnabled: verdict.cycleStartEnabled,
    nextAction: verdict.nextAction,
  }
}
