// WO-2237: the return to a pause point and the rest of the interrupted move -
// the pure planner (runFromLine.ts). Operator picked Option 1 on 2026-09-29: a
// move out of a pause is a kept stop, and CYCLE START goes back to the point
// (safe Z, X/Y, down at the capped approach feed) and finishes the move from
// there.
import { describe, expect, it } from 'vitest'
import {
  applyResumeMotion,
  buildResumeAtPointPlan,
  locatePausedLine,
} from '../../lib/machine/runFromLine'

const LINES = [
  'G21 G90 G54', //       1
  'G0 Z5', //             2
  'G0 X0 Y0', //          3
  'M3 S10000', //         4
  'G1 Z-1 F300', //       5
  'G1 X100 Y0 F1200', //  6
  'G1 X100 Y50', //       7
  'G0 Z5', //             8
  'M5', //                9
  'M30', //               10
]
const PROGRAM = LINES.join('\n')

describe('WO-2237 resume at the pause point - a straight move', () => {
  it('goes up to safe Z, over, down at the capped feed, then finishes the line from the point', () => {
    const planned = buildResumeAtPointPlan(PROGRAM, 6, { x: 40, y: 0.004, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const { plan } = planned
    expect(plan.startLine).toBe(6)
    expect(plan.resumeAt).toEqual({
      line: 6,
      text: 'G1 X100 Y0 Z-1 F1200',
      point: { x: 40, y: 0, z: -1 },
      pointMm: { x: 40, y: 0, z: -1 },
    })
    // The order of the return: lift, cross, come down, then cut.
    const lift = plan.prelude.indexOf('G53 G0 Z-5')
    const cross = plan.prelude.indexOf('G0 X40 Y0')
    const toClearance = plan.prelude.indexOf('G0 Z5')
    const plunge = plan.prelude.indexOf('G1 Z-1 F300')
    expect(lift).toBeGreaterThan(-1)
    expect(cross).toBeGreaterThan(lift)
    expect(toClearance).toBeGreaterThan(cross)
    expect(plunge).toBeGreaterThan(toClearance)
    // The spindle is back on before any motion reaches the work.
    expect(plan.prelude.indexOf('M3 S10000')).toBeGreaterThan(-1)
    expect(plan.prelude.indexOf('M3 S10000')).toBeLessThan(cross)
    // The program's own state, whatever the operator typed during the stop.
    expect(plan.prelude).toEqual(expect.arrayContaining(['G21', 'G90', 'G54']))
    expect(plan.warnings[0]).toMatch(/goes back to X40 Y0 Z-1, where the pause stopped line 6/)
    expect(planned.offPathMm).toBeCloseTo(0.004, 6)
    // The slice sends the rest of line 6 in place of line 6, every line number kept.
    const sent = applyResumeMotion(PROGRAM, plan).split('\n')
    expect(sent).toHaveLength(LINES.length)
    expect(sent[5]).toBe('G1 X100 Y0 Z-1 F1200')
    expect(sent[6]).toBe(LINES[6])
  })

  it('pausing on the last move finishes that move and the program ends', () => {
    const planned = buildResumeAtPointPlan(PROGRAM, 7, { x: 100, y: 20, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X100 Y50 Z-1')
  })

  it('the plunge comes down at the capped feed even when the point is above work Z 0', () => {
    const text = ['G21 G90 G54', 'G0 Z30', 'G0 X0 Y0', 'G1 Z12 F800', 'G1 X50 F1000', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 5, { x: 20, y: 0, z: 12 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.prelude).toContain('G0 Z30')
    expect(planned.plan.prelude).toContain('G1 Z12 F300')
  })

  it('with no machine safe Z the tool first rises to the program clearance, never crossing below the point', () => {
    const planned = buildResumeAtPointPlan(PROGRAM, 6, { x: 40, y: 0, z: -1 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const p = planned.plan.prelude
    expect(p.some((l) => l.startsWith('G53'))).toBe(false)
    expect(p.indexOf('G0 Z5')).toBeLessThan(p.indexOf('G0 X40 Y0'))
    expect(p.indexOf('G1 Z-1 F300')).toBeGreaterThan(p.indexOf('G0 X40 Y0'))
  })

  it('an incremental line finishes with the distance left from the point', () => {
    const text = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G91', 'G1 X100 F1000', 'G90', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 6, { x: 30, y: 0, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.text).toBe('G1 X70 Y0 Z0 F1000')
    // The approach runs in G90; the program's G91 goes back on last.
    expect(planned.plan.prelude.at(-1)).toBe('G91')
  })

  it('an inch program is returned to, and finished, in inches', () => {
    const text = ['G20 G90 G54', 'G0 Z0.2', 'G0 X0 Y0', 'G1 Z-0.05 F10', 'G1 X4 F40', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 5, { x: 25.4, y: 0, z: -1.27 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.point).toEqual({ x: 1, y: 0, z: -0.05 })
    // The operator's sentence states the same point in work millimetres (WO-1667).
    expect(planned.plan.resumeAt.pointMm).toEqual({ x: 25.4, y: 0, z: -1.27 })
    expect(planned.plan.resumeAt.text).toBe('G1 X4 Y0 Z-0.05 F40')
    expect(planned.plan.prelude).toContain('G20')
  })

  it('pausing inside the first line of the program still returns to the point', () => {
    const text = ['G1 X50 Y0 Z0 F500', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(`G0 X0 Y0 Z0\n${text}`, 2, { x: 10, y: 0, z: 0 }, {})
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X50 Y0 Z0 F500')
  })
})

describe('WO-2237 resume at the pause point - arcs', () => {
  const ARC = [
    'G21 G90 G54 G17', //       1
    'G0 Z5', //                 2
    'G0 X10 Y0', //             3
    'G1 Z-1 F300', //           4
    'G3 X0 Y10 I-10 J0 F900', // 5  quarter circle CCW about the origin
    'G1 X0 Y20', //             6
    'M30', //                   7
  ]
  const text = ARC.join('\n')
  const at45 = { x: 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2, z: -1 }

  it('an arc finishes from the point with its centre measured from there', () => {
    const planned = buildResumeAtPointPlan(text, 5, at45, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.text).toBe('G3 X0 Y10 Z-1 I-7.0711 J-7.0711 F900')
    expect(planned.plan.resumeAt.point).toEqual({ x: 7.0711, y: 7.0711, z: -1 })
    expect(planned.plan.resumeMotion).toBeNull()
  })

  it('a reported point just off the arc is put back on it', () => {
    const planned = buildResumeAtPointPlan(text, 5, { x: 7.08, y: 7.08, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const { x, y } = planned.plan.resumeAt.point
    expect(Math.hypot(x, y)).toBeCloseTo(10, 3)
  })

  it('an R-form arc is finished as a centre-form arc from the point', () => {
    const r = [...ARC]
    r[4] = 'G3 X0 Y10 R10 F900'
    const planned = buildResumeAtPointPlan(r.join('\n'), 5, at45, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G3 X0 Y10 Z-1 I-7.0711 J-7.0711 F900')
  })

  it('a clockwise arc and a helix: the linear axis is where the fraction of the turn puts it', () => {
    const helix = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y10', 'G1 Z0 F300', 'G2 X10 Y0 Z-2 I0 J-10 F600', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(helix, 5, { ...at45, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.point.z).toBeCloseTo(-1, 4)
    expect(planned.plan.resumeAt.text).toBe('G2 X10 Y0 Z-2 I-7.0711 J-7.0711 F600')
  })

  it('an arc mode a line inherits is named on the rest of the line', () => {
    const modal = [...ARC]
    modal[4] = 'X0 Y10 I-10 J0 F900'
    modal.splice(4, 0, 'G3 X10 Y0 I0 J0') // a zero move that sets G3 modal
    const planned = buildResumeAtPointPlan(modal.join('\n'), 6, at45, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G3 X0 Y10 Z-1 I-7.0711 J-7.0711 F900')
  })

  // An arc written from its own end point is a full circle on GRBL, LinuxCNC and UCCNC.
  it('a pause at the end of an arc finishes with a straight G1 to the end, never a full circle', () => {
    const planned = buildResumeAtPointPlan(text, 5, { x: 0, y: 10, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.text).toBe('G1 X0 Y10 Z-1 F900')
    expect(planned.plan.resumeAt.point).toEqual({ x: 0, y: 10, z: -1 })
  })

  it('a pause a hair short of the end of an arc is not written as an arc whose start rounds to its end', () => {
    const a = Math.PI / 2 - 1e-7
    const planned = buildResumeAtPointPlan(text, 5, { x: 10 * Math.cos(a), y: 10 * Math.sin(a), z: -1 }, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X0 Y10 Z-1 F900')
  })

  it('a pause past the end of an arc, inside the next line, resumes inside that next line', () => {
    const found = locatePausedLine(text, [5, 6], { x: 0, y: 10.1, z: -1 }, 0.25)
    expect(found?.line).toBe(6)
    expect(found?.pointMm.y).toBeCloseTo(10.1, 6)
    const planned = buildResumeAtPointPlan(text, found!.line, found!.pointMm, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X0 Y20 Z-1')
  })

  it('a pause at the junction after an arc, with the arc named first, finishes the arc with no circle', () => {
    const found = locatePausedLine(text, [5, 6], { x: 0, y: 10, z: -1 }, 0.25)
    expect(found?.line).toBe(5)
    const planned = buildResumeAtPointPlan(text, found!.line, found!.pointMm, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X0 Y10 Z-1 F900')
  })

  it('a helical full circle paused at its end is not cut again', () => {
    const circle = ['G21 G90 G54 G17', 'G0 Z5', 'G0 X10 Y0', 'G1 Z0 F300', 'G2 X10 Y0 Z-1 I-10 J0 F600', 'G0 Z5', 'M30']
    const planned = buildResumeAtPointPlan(circle.join('\n'), 5, { x: 10, y: 0, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X10 Y0 Z-1 F600')
  })

  it('a helical full circle paused at its start is still cut whole', () => {
    const circle = ['G21 G90 G54 G17', 'G0 Z5', 'G0 X10 Y0', 'G1 Z0 F300', 'G2 X10 Y0 Z-1 I-10 J0 F600', 'G0 Z5', 'M30']
    const planned = buildResumeAtPointPlan(circle.join('\n'), 5, { x: 10, y: 0, z: 0 }, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G2 X10 Y0 Z-1 I-10 J0 F600')
  })
})

describe('WO-2237 resume at the pause point - what the program had in force', () => {
  it('a program that selects no work offset returns in the one the point was reported in', () => {
    const text = ['G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X50 F900', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 5, { x: 10, y: 0, z: -1 }, { safeZMachine: -5, frameAtPause: 55 })
    expect(planned.ok && planned.plan.prelude).toContain('G55')
  })

  // Review 2 (attempt 1): the clearance of a program that names no offset was
  // looked up under the reported one, so the return rapided onto the point.
  const NO_WCS = ['G21 G90', 'G0 Z5', 'G0 X0 Y0', 'M3 S10000', 'G1 Z-1 F300', 'G1 X100 Y0 F1200', 'M30'].join('\n')

  it('a program that names no offset comes down from its own clearance at the capped feed', () => {
    const planned = buildResumeAtPointPlan(NO_WCS, 6, { x: 40, y: 0, z: -1 }, { safeZMachine: -5, frameAtPause: 54 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const p = planned.plan.prelude
    const lift = p.indexOf('G53 G0 Z-5')
    const cross = p.indexOf('G0 X40 Y0')
    const toClearance = p.indexOf('G0 Z5')
    const plunge = p.indexOf('G1 Z-1 F300')
    expect(p).toContain('G54')
    expect(lift).toBeGreaterThan(-1)
    expect(cross).toBeGreaterThan(lift)
    expect(toClearance).toBeGreaterThan(cross)
    expect(plunge).toBeGreaterThan(toClearance)
    expect(p).not.toContain('G0 Z-1')
  })

  it('a program that names no offset, with no machine safe Z, rises to its clearance before any X/Y', () => {
    const planned = buildResumeAtPointPlan(NO_WCS, 6, { x: 40, y: 0, z: -1 }, { frameAtPause: 54 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const p = planned.plan.prelude
    expect(p.indexOf('G0 Z5')).toBeGreaterThan(-1)
    expect(p.indexOf('G0 Z5')).toBeLessThan(p.indexOf('G0 X40 Y0'))
    expect(p.indexOf('G1 Z-1 F300')).toBeGreaterThan(p.indexOf('G0 X40 Y0'))
    expect(p).not.toContain('G0 Z-1')
  })


  it('a tool changed during the stop cuts the rest with its own length', () => {
    const text = ['G21 G90 G54', 'T1 M6', 'G43 H1', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X50 F900', 'M30'].join('\n')
    const same = buildResumeAtPointPlan(text, 7, { x: 10, y: 0, z: -1 }, { safeZMachine: -5, toolNow: 1 })
    expect(same.ok && same.plan.prelude).toContain('G43 H1')
    const changed = buildResumeAtPointPlan(text, 7, { x: 10, y: 0, z: -1 }, { safeZMachine: -5, toolNow: 2 })
    expect(changed.ok && changed.plan.prelude).toContain('G43 H2')
    expect(changed.ok && changed.plan.prelude).not.toContain('G43 H1')
  })

  it('a spindle and coolant the program had off are switched off again', () => {
    const text = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X50 F900', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 5, { x: 10, y: 0, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok && planned.plan.prelude).toEqual(expect.arrayContaining(['M5', 'M9']))
  })

  it('coolant the program had on is on again before the return reaches the work', () => {
    const text = ['G21 G90 G54', 'M3 S9000', 'M8', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X50 F900', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(text, 7, { x: 10, y: 0, z: -1 }, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const p = planned.plan.prelude
    expect(p.indexOf('M8')).toBeGreaterThan(-1)
    expect(p.indexOf('M8')).toBeLessThan(p.indexOf('G1 Z-1 F300'))
    expect(p).not.toContain('M9')
  })

  it('a line that is not one plain move is not resumed inside - the caller starts it from its beginning', () => {
    // WO-2241: a canned cycle now goes back to its hole's cycle start
    // (keptStopCannedCycle.wo2241.test.ts); a machine-coordinate move is still
    // started from its beginning.
    const machineMove = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0', 'G53 G0 X10 Y10', 'G0 X0 Y0', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(machineMove, 4, { x: 5, y: 5, z: 5 }, {})
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toMatch(/is not a plain move/)
  })
})

describe('WO-2237 which line the pause stopped inside', () => {
  it('picks the first candidate whose move passes through the point', () => {
    const found = locatePausedLine(PROGRAM, [7, 6], { x: 40, y: 0, z: -1 }, 0.25)
    expect(found?.line).toBe(6)
    expect(found?.pointMm).toEqual({ x: 40, y: 0, z: -1 })
  })

  it('at the junction of two moves the earlier candidate given first wins', () => {
    const found = locatePausedLine(PROGRAM, [6, 7], { x: 100, y: 0, z: -1 }, 0.25)
    expect(found?.line).toBe(6)
  })

  it('a point on none of the candidates finds nothing', () => {
    expect(locatePausedLine(PROGRAM, [6, 7], { x: 40, y: 30, z: -1 }, 0.25)).toBeNull()
  })
})
