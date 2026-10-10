import { describe, expect, it } from 'vitest'
import { buildRunFromLinePlan, buildStepBackPlan } from '../../lib/machine/runFromLine'
import type { MachineOutputDefinition } from '../../types'

// WO-1650: RUN-FROM-LINE RESTORES EVERY OUTPUT THAT WAS ON AT THAT LINE - not
// only the last M7/M8. A hand-made list with a pump on M10 (its own off word
// M12) and air on M11.

const PUMP_AND_AIR: MachineOutputDefinition[] = [
  { name: 'coolant pump', onCode: 'M10', offCode: 'M12', pin: { port: 1, pin: 17, negate: false } },
  { name: 'air', onCode: 'M11', offCode: null, pin: { port: 2, pin: 3, negate: false } },
]

const PROGRAM = [
  'G21', // 1
  'G90', // 2
  'G54', // 3
  'M3 S8000', // 4
  'M7', // 5
  'M10', // 6
  'G0 X10 Y20', // 7
  'M8', // 8
  'G1 Z-2 F250', // 9
  'M11', // 10
  'G1 X40 F800', // 11
  'M12', // 12
  'G1 Y60', // 13
  'M9', // 14
  'G0 Z5', // 15
  'M30', // 16
].join('\n')

function prelude(line: number, outputs: MachineOutputDefinition[] | null = PUMP_AND_AIR): string[] {
  const r = buildRunFromLinePlan(PROGRAM, line, { outputs })
  if (!r.ok) throw new Error(r.reason)
  return r.plan.prelude
}

const outputWords = (lines: string[]) => lines.filter((l) => /^M(?:7|8|9|1\d)$/.test(l))

describe('WO-1650: run-from-line restores every output on at the line', () => {
  it('after M10 the pump is restored', () => {
    expect(outputWords(prelude(7))).toEqual(['M7', 'M10'])
  })

  it('mist AND flood AND pump AND air, in the order the file switched them on', () => {
    expect(outputWords(prelude(11))).toEqual(['M7', 'M10', 'M8', 'M11'])
  })

  it("the pump's own off word takes it out of the restore", () => {
    expect(outputWords(prelude(13))).toEqual(['M7', 'M8', 'M11'])
  })

  it('M9 stops every one of them', () => {
    expect(outputWords(prelude(15))).toEqual([])
  })

  it('a machine that lists no such output restores only the coolant words', () => {
    expect(outputWords(prelude(11, null))).toEqual(['M7', 'M8'])
  })

  it('Step Back restores the same outputs', () => {
    const r = buildStepBackPlan(PROGRAM, 12, { outputs: PUMP_AND_AIR })
    if (!r.ok) throw new Error(r.reason)
    expect(outputWords(r.plan.prelude)).toEqual(['M7', 'M10', 'M8', 'M11'])
  })
})
