import { describe, expect, it } from 'vitest'
import { buildRunFromLinePlan, buildStepBackPlan } from '../../lib/machine/runFromLine'
import { GrblController } from '../../lib/machine/grbl/controller'

const PROGRAM = [
  'G21', // 1
  'G90', // 2
  'G55', // 3
  'M3 S8000', // 4
  'M8', // 5
  'G0 X10 Y20', // 6
  'G0 Z5', // 7
  'G1 Z-2 F250', // 8
  'G1 X40 F800', // 9
  '( pause here )', // 10
  'G1 Y60', // 11
  'M5', // 12
  'M30', // 13
].join('\n')

describe('buildRunFromLinePlan', () => {
  it('reconstructs modal state, position, spindle, and coolant at the target', () => {
    const r = buildRunFromLinePlan(PROGRAM, 11)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.startLine).toBe(11)
    expect(r.plan.resumePosition).toEqual({ x: 40, y: 20, z: -2 })
    expect(r.plan.prelude).toEqual([
      'G21',
      'G90',
      'G55',
      'G0 Z5', // WO-1989: up to the program's clearance before any XY
      'M3 S8000',
      'M8',
      'G0 X40 Y20',
      'G1 Z-2 F300', // plunge feed = min(300 cap, program feed 800)
      'F800',
    ])
  })

  it('snaps over comment/blank lines to the next sendable line AND says so', () => {
    const r = buildRunFromLinePlan(PROGRAM, 10)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.startLine).toBe(11)
    expect(r.plan.requestedLine).toBe(10)
    // Operator's ruling (Q-RUNFROM-CONTRACT-2): the snap is allowed, silence is
    // not - the notice names the requested line and the actual line.
    const notice = r.plan.warnings.find((w) => /instead of/.test(w))
    expect(notice).toBeDefined()
    expect(notice).toMatch(/line 11 instead of 10/)
    expect(notice).toMatch(/line 10 is a comment or blank/i)
  })

  it('emits no snap notice when the requested line is already sendable', () => {
    const r = buildRunFromLinePlan(PROGRAM, 11)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.requestedLine).toBe(11)
    expect(r.plan.startLine).toBe(11)
    expect(r.plan.warnings.some((w) => /instead of/.test(w))).toBe(false)
  })

  it('warns about the plunge and the spindle start', () => {
    const r = buildRunFromLinePlan(PROGRAM, 11)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.warnings.join(' ')).toMatch(/spindle will START/i)
    expect(r.plan.warnings.join(' ')).toMatch(/plunge/i)
  })

  it('refuses line 1, out-of-range, and no-sendable-code targets', () => {
    expect(buildRunFromLinePlan(PROGRAM, 1).ok).toBe(false)
    expect(buildRunFromLinePlan(PROGRAM, 99).ok).toBe(false)
    expect(buildRunFromLinePlan('G21\n( only comments after )\n', 2).ok).toBe(false)
  })

  // WO-029 (WO-024 audit hole): the planner must use the streamer's own
  // sendable predicate, so ACTUAL '%' marker lines snap forward too instead
  // of being reported as the start line and then silently skipped.
  describe('% program-marker lines (WO-029)', () => {
    const MARKED = [
      '%', // 1  program-start marker
      'G21', // 2
      'G90', // 3
      'M3 S8000', // 4
      'G0 X10 Y20', // 5
      'G0 Z5', // 6
      'G1 Z-2 F250', // 7
      '', // 8  blank
      '( pause )', // 9  comment
      '%', // 10 stray marker the streamer drops
      'G1 X40 F800', // 11
      'M5', // 12
      'M30', // 13
      '%', // 14 program-end marker
    ].join('\n')

    it('a request ON a % line snaps to the next sendable line and says so', () => {
      const r = buildRunFromLinePlan(MARKED, 10)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.plan.requestedLine).toBe(10)
      expect(r.plan.startLine).toBe(11)
      const notice = r.plan.warnings.find((w) => /instead of/.test(w))
      expect(notice).toBeDefined()
      expect(notice).toMatch(/line 11 instead of 10/)
      expect(notice).toMatch(/line 10 is a % program marker/)
    })

    it('blank and comment requests snap PAST a following % marker in one hop', () => {
      for (const requested of [8, 9]) {
        const r = buildRunFromLinePlan(MARKED, requested)
        if (!r.ok) throw new Error(`expected ok for line ${requested}`)
        expect(r.plan.startLine).toBe(11)
        expect(r.plan.warnings.join(' ')).toMatch(new RegExp(`line 11 instead of ${requested}`))
      }
    })

    it('planner startLine and the loaded job agree: no % line ever streams', () => {
      const r = buildRunFromLinePlan(MARKED, 10)
      if (!r.ok) throw new Error('expected ok')
      const controller = new GrblController({})
      const load = controller.loadJobFrom(MARKED, r.plan.startLine, r.plan.prelude)
      if (!load.ok) throw new Error(`GRBL refused a text load: ${load.reason}`)
      const programLines = load.result.lines.filter((l) => l.sourceLine > 0)
      // First streamed source line IS the planner's startLine, and the % lines
      // (10 and 14) are nowhere in the job.
      expect(programLines[0].sourceLine).toBe(r.plan.startLine)
      expect(programLines.map((l) => l.sourceLine)).toEqual([11, 12, 13])
    })

    it('a trailing % with nothing sendable after it is refused, not planned', () => {
      const r = buildRunFromLinePlan(MARKED, 14)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/No sendable g-code/i)
    })

    it('the leading % and the first real line are the program start - refused', () => {
      // Line 1 (%) would snap to line 2, the first line the machine receives;
      // both are Start-with-extra-steps, not a mid-program resume.
      for (const requested of [1, 2]) {
        const r = buildRunFromLinePlan(MARKED, requested)
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.reason).toMatch(/use Start instead/)
      }
    })
  })

  // Operator's ruling 2026-09-26: the chosen line starts. An arc mode the line
  // relies on is written onto it; G91 goes back on at the end of the prelude.
  it('re-arms the arc mode only when the target line relies on it', () => {
    const prog = 'G21\nG90\nG0 X10 Y0\nG2 X0 Y10 I-10 J0 F500\nX10 Y0 I0 J-10\nG1 X0 F600'
    // Line 5 relies on modal G2 -> it starts, sent as G2.
    const modal = buildRunFromLinePlan(prog, 5)
    if (!modal.ok) throw new Error(modal.reason)
    expect(modal.plan.startLine).toBe(5)
    expect(modal.plan.resumeMotion).toEqual({ line: 5, word: 'G2' })
    // Line 6 sets its own G1 -> nothing re-armed.
    const explicit = buildRunFromLinePlan(prog, 6)
    if (!explicit.ok) throw new Error(explicit.reason)
    expect(explicit.plan.resumeMotion).toBeNull()
  })

  it('starts in incremental mode and puts G91 back on after the approach', () => {
    const r = buildRunFromLinePlan('G21\nG91\nG1 X1 F100\nG1 X1\nG90\nG1 X0', 4)
    if (!r.ok) throw new Error(r.reason)
    expect(r.plan.startLine).toBe(4)
    expect(r.plan.prelude[r.plan.prelude.length - 1]).toBe('G91')
    expect(r.plan.warnings.join(' ')).toMatch(/incremental mode \(G91\)/)
  })

  it('uses G0 for an above-zero Z approach and re-arms modal G1 via the feed line', () => {
    const r = buildRunFromLinePlan('G21\nG90\nG0 X0 Y0\nG1 Z5 F500\nG1 X20\nG1 Y20', 6)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.prelude).toContain('G0 Z5')
    expect(r.plan.prelude).toContain('G1 F500')
  })
})

describe('buildStepBackPlan (WO-051)', () => {
  it('finds the previous sendable line and delegates the exact run-from plan', () => {
    const r = buildStepBackPlan(PROGRAM, 11)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Line 10 is a comment, so reverse search lands on sendable line 9.
    expect(r.plan.requestedLine).toBe(9)
    expect(r.plan.startLine).toBe(9)
    expect(r.plan.resumePosition).toEqual({ x: 10, y: 20, z: -2 })
    expect(r.plan.warnings.join(' ')).toMatch(/re-arm line 9.*cursor at line 11/i)
  })

  it('uses the stream predicate in reverse across blanks, comments, and % markers', () => {
    const marked = ['%', 'G21', '', '( note )', '%', 'G90', 'G0 X0', 'M30'].join('\n')
    const r = buildStepBackPlan(marked, 7)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.startLine).toBe(6)
  })

  it('fails loudly at the first sendable line and without a live cursor', () => {
    const atStart = buildStepBackPlan(PROGRAM, 2)
    expect(atStart.ok).toBe(false)
    if (!atStart.ok) expect(atStart.reason).toMatch(/program start|use Start/i)

    const noCursor = buildStepBackPlan(PROGRAM, 0)
    expect(noCursor.ok).toBe(false)
    if (!noCursor.ok) expect(noCursor.reason).toMatch(/no completed program line/i)
  })

  it('steps back into a G91 region and onto an arc-modal line (Operator\'s ruling 2026-09-26)', () => {
    const incremental = buildStepBackPlan(
      ['G21', 'G90', 'G91', 'G1 X1 F100', 'G1 X1', 'G90'].join('\n'),
      5,
    )
    if (!incremental.ok) throw new Error(incremental.reason)
    expect(incremental.plan.startLine).toBe(4)
    expect(incremental.plan.prelude[incremental.plan.prelude.length - 1]).toBe('G91')

    const arcModal = buildStepBackPlan(
      ['G21', 'G90', 'G0 X10 Y0', 'G2 X0 Y10 I-10 J0 F500', 'X10 Y0 I0 J-10', 'G1 X0'].join('\n'),
      6,
    )
    if (!arcModal.ok) throw new Error(arcModal.reason)
    expect(arcModal.plan.startLine).toBe(5)
    expect(arcModal.plan.resumeMotion).toEqual({ line: 5, word: 'G2' })
  })
})

describe('GrblController.loadJobFrom', () => {
  it('loads the prelude (sourceLine 0) then only lines at/after startLine', () => {
    const controller = new GrblController({})
    const load = controller.loadJobFrom(PROGRAM, 11, ['G21', 'G90', 'G55', 'G0 X40 Y20'])
    if (!load.ok) throw new Error(`GRBL refused a text load: ${load.reason}`)
    expect(load.result.lines.map((l) => l.sourceLine)).toEqual([0, 0, 0, 0, 11, 12, 13])
    expect(load.result.lines[4].text).toBe('G1 Y60')
    expect(controller.jobProgress().phase).toBe('ready')
  })
})
