// @vitest-environment jsdom
//
// WO-024 (Operator ruling card Q-RUNFROM-CONTRACT-2) + WO-029 (the audit's %
// hole): when a Run-from request lands on a NON-SENDABLE line - comment,
// blank, or an ACTUAL '%' program marker - the planner snaps forward to the
// next sendable line, but the operator must be TOLD: "will start from line 10
// instead of 9". Silent snap-forward is not an allowed outcome, on any of the
// three line kinds, from the UI gesture or from API-originated requests
// (clamp pause / guided tool change re-arm).
//
// WO-033 (the WO-029 audit's weak-pin finding): every cell pins the EXACT
// loaded job - the controller's own loadJobFrom return, prelude then the
// literal remaining source lines - not a line count. A wrong slice with the
// right count cannot pass. Three-way agreement per cell: planner startLine,
// exact loaded content, and the visible requested-vs-actual notice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { StreamLine } from '../../lib/gcode/text'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useMachineControl } = await import('../../store/machineControlStore')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { armRunFromLine, continueClampPause, getMachineController, loadMachineProgram } =
  await import('../../lib/machine/machineSession')
const { buildRunFromLinePlan } = await import('../../lib/machine/runFromLine')
const { GrblController } = await import('../../lib/machine/grbl/controller')

// Every arm path (UI gesture, armRunFromLine, clamp-pause re-arm) funnels
// through GrblController.loadJobFrom, whose return value IS the loaded job.
// The spy passes through to the real method and captures that exact slice.
const loadFrom = vi.spyOn(GrblController.prototype, 'loadJobFrom')

// ACTUAL '%' marker lines (the WO-024 fixtures only claimed them): a wrapped
// program with a comment, a blank, and a stray mid-program marker, all
// snapping to the same sendable line 10.
const PROGRAM = [
  '%', // 1  program-start marker
  'G21 G90 G54', // 2
  'M3 S12000', // 3
  'G0 X0 Y0', // 4
  'G0 Z5', // 5
  'G1 Z-2 F300', // 6
  '( clamp check )', // 7  comment        <- snaps to 10
  '', // 8  blank                         <- snaps to 10
  '%', // 9  stray marker                 <- snaps to 10
  'G1 X10 Y0 F800', // 10 the actual start
  'M5', // 11
  'M30', // 12
  '%', // 13 program-end marker
].join('\n')

const ACTUAL_START = 10
// The EXACT program lines the streamer keeps at/after the actual start:
// sources 10-12 verbatim. The % markers (9, 13) appear nowhere.
const REMAINING_LINES: StreamLine[] = [
  { text: 'G1 X10 Y0 F800', sourceLine: 10 },
  { text: 'M5', sourceLine: 11 },
  { text: 'M30', sourceLine: 12 },
]

const CASES = [
  { kind: 'comment', requested: 7, noticeKind: /comment or blank/i },
  { kind: 'blank', requested: 8, noticeKind: /comment or blank/i },
  { kind: '% marker', requested: 9, noticeKind: /% program marker/ },
] as const

function planWarningsText(): string {
  return screen
    .getAllByTestId('control-runfrom-warning')
    .map((el) => el.textContent)
    .join(' ')
}

// WO-087: the panel's plan handler is async - routing line 1 to an arm from
// the top can have to reset the controller first - so the click has to be
// awaited before the card it produces can be read.
async function planViaFromLineInput(line: number): Promise<void> {
  fireEvent.change(screen.getByTestId('control-runfrom-input'), {
    target: { value: String(line) },
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-runfrom-plan'))
  })
}

/** The planner's own answer, used to pin agreement with job + DOM. */
function purePlan(requested: number) {
  const r = buildRunFromLinePlan(PROGRAM, requested)
  if (!r.ok) throw new Error(`planner refused line ${requested}: ${r.reason}`)
  return r.plan
}

/** The exact job the controller loaded, from its own loadJobFrom return. */
function loadedJobLines(): StreamLine[] {
  expect(loadFrom).toHaveBeenCalledTimes(1)
  // WO-423: loadJobFrom returns a LoadOutcome. GRBL has an interpreter, so it
  // never refuses on capability grounds - say so if that ever changes.
  const outcome = loadFrom.mock.results[0].value
  if (!outcome.ok) throw new Error(`GRBL refused the run-from load: ${outcome.reason}`)
  return outcome.result.lines
}

/**
 * The WO-033 pin, shared by every cell: the session armed the controller with
 * the planner's exact startLine and prelude, and the loaded job is EXACTLY
 * prelude (sourceLine 0) + the literal remaining source lines - the actual
 * first loaded line is 'G1 X10 Y0 F800' at source 10, and no % line loads.
 */
function expectExactLoadedJob(plan: { startLine: number; prelude: string[] }): void {
  expect(plan.startLine).toBe(ACTUAL_START)
  expect(loadFrom).toHaveBeenCalledWith(PROGRAM, plan.startLine, plan.prelude)
  const lines = loadedJobLines()
  expect(lines).toEqual([
    ...plan.prelude.map((text) => ({ text, sourceLine: 0 })),
    ...REMAINING_LINES,
  ])
  const firstLoaded = lines.find((l) => l.sourceLine > 0)
  expect(firstLoaded).toEqual({ text: 'G1 X10 Y0 F800', sourceLine: ACTUAL_START })
  // And the armed streamer holds exactly that job, ready to start.
  const job = getMachineController().jobProgress()
  expect(job.phase).toBe('ready')
  expect(job.totalLines).toBe(lines.length)
}

describe('WO-029/WO-033: run-from snap says so AND loads exactly the right lines', () => {
  beforeEach(() => {
    loadMachineProgram('snap.nc', PROGRAM)
    loadFrom.mockClear()
  })

  afterEach(() => {
    cleanup()
    useMachineControl.getState().setToolChange(null)
  })

  for (const c of CASES) {
    it(`UI gesture (From-line input) on a ${c.kind} line: exact lines + notice`, async () => {
      render(<ProgramPanel />)
      await planViaFromLineInput(c.requested)

      // Visible notice agreement: the plan card names requested vs actual and
      // shows the actual line's CONTENT next to its number.
      expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
      expect(screen.getByTestId('control-runfrom-target').textContent).toBe(
        `${ACTUAL_START}: G1 X10 Y0 F800`,
      )
      const warnings = planWarningsText()
      expect(warnings).toMatch(new RegExp(`line ${ACTUAL_START} instead of ${c.requested}`))
      expect(warnings).toMatch(c.noticeKind)

      // Planner + loaded-job agreement, exact.
      expectExactLoadedJob(purePlan(c.requested))
    })

    it(`API (armRunFromLine) on a ${c.kind} line: exact lines + notice`, () => {
      const armed = armRunFromLine(c.requested)
      expect(armed.ok).toBe(true)
      if (!armed.ok) return
      expect(armed.plan.requestedLine).toBe(c.requested)
      expect(armed.plan.startLine).toBe(ACTUAL_START)
      const notice = armed.plan.warnings.find((w) => /instead of/.test(w))
      expect(notice).toBeDefined()
      expect(notice).toMatch(new RegExp(`line ${ACTUAL_START} instead of ${c.requested}`))
      expect(notice).toMatch(c.noticeKind)

      expectExactLoadedJob(armed.plan)
    })
  }

  it('UI gesture: planning a sendable line shows no snap notice, same exact load', async () => {
    render(<ProgramPanel />)
    fireEvent.mouseEnter(screen.getByText('G1 X10 Y0 F800').closest('.gcode-line')!)
    await act(async () => {
      fireEvent.click(screen.getByTestId(`control-runfrom-here-${ACTUAL_START}`))
    })

    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
    // The spindle/plunge cautions still render; the snap notice must not.
    expect(planWarningsText()).not.toMatch(/instead of/)
    // No snap, but the loaded slice is pinned exactly all the same.
    expectExactLoadedJob(purePlan(ACTUAL_START))
  })

  for (const c of CASES) {
    it(`API: a clamp-pause re-arm on a ${c.kind} line surfaces the notice on its card`, () => {
      render(<ProgramPanel />)
      act(() => {
        useMachineControl.getState().setToolChange({
          step: 'awaiting-swap',
          mode: 'clampPause',
          tool: null,
          resumeLine: c.requested, // the captured resume anchor landed here
          message: 'Reposition your clamps.',
          warnings: [],
        })
      })

      let rearmed = false
      act(() => {
        rearmed = continueClampPause()
      })
      expect(rearmed).toBe(true)

      const card = screen.getByTestId('control-toolchange-card')
      expect(card.textContent).toContain(`armed at line ${ACTUAL_START}`)
      expect(card.textContent).toMatch(
        new RegExp(`line ${ACTUAL_START} instead of ${c.requested}`),
      )
      expect(card.textContent).toMatch(c.noticeKind)

      expectExactLoadedJob(purePlan(c.requested))
    })
  }
})
