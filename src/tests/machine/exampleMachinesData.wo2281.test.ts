import { describe, expect, it } from 'vitest'
import { EXAMPLE_MACHINES, createExampleMachine } from '../../lib/machine/exampleMachines'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { BUILT_IN_DIALECTS } from '../../lib/post'

// Independently copied from .planning/research-common-hobby-cnc-2026-09-30.md.
// null = not published / unverified, NOT zero. Approximate values and the
// specific options chosen from multi-variant rows are retained explicitly.
const RESEARCH_ROWS = [
  { key: 'shapeoko-standard', name: 'Shapeoko 5 Pro / 4 Standard', travel: [406, 406, 95], rpm: [10000, 31000], controller: 'grbl', family: 'Carbide Motion / GRBL-derived (detail unverified)' },
  { key: 'genmitsu-3018', name: 'Genmitsu 3018-PROVer V2', travel: [300, 180, 45], rpm: [1000, 10000], controller: 'grbl', family: 'GRBL 1.1' },
  { key: 'onefinity-woodworker', name: 'Onefinity Woodworker', travel: [813, 813, 165], rpm: [null, null], controller: 'generic', family: 'Buildbotics / MASSO' },
  { key: 'longmill-30x30', name: 'Sienci LongMill MK2 30x30', travel: [820, 868, 125], rpm: [15000, 25000], controller: 'grblhal', family: 'SuperLongBoard grblHAL', cutting: [4000, 4000, 3000] },
  { key: 'lead-1010', name: 'OpenBuilds LEAD 1010', travel: [750, 750, 100], rpm: [null, null], controller: 'grbl', family: 'BlackBox GRBL 1.1' },
  { key: 'masuter-pro', name: 'FoxAlien Masuter Pro', travel: [400, 380, 60], rpm: [3000, 12000], controller: 'grbl', family: 'GRBL 1.1' },
  { key: 'proverxl-4030', name: 'Genmitsu PROVerXL 4030', travel: [400, 300, 110], rpm: [null, null], controller: 'grbl', family: 'GRBL 1.1' },
  { key: '6040-class', name: '6040-class Chinese gantry', travel: [600, 400, 75], rpm: [6000, 24000], controller: 'uccnc', family: 'Mach3 / UCCNC' },
  { key: 'x-carve-1000', name: 'X-Carve 1000', travel: [750, 750, 65], rpm: [16000, 27000], controller: 'grbl', family: 'X-Controller GRBL' },
  { key: 'pcnc-440', name: 'Tormach PCNC 440', travel: null, rpm: [null, 10000], controller: 'linuxcnc', family: 'PathPilot LinuxCNC' },
] as const

describe('WO-2281 published example data and labelled defaults', () => {
  it('offers exactly the ten independently copied research rows in research order', () => {
    expect(EXAMPLE_MACHINES.map(({ key, name }) => ({ key, name })))
      .toEqual(RESEARCH_ROWS.map(({ key, name }) => ({ key, name })))
  })

  it.each(RESEARCH_ROWS)('$name has only its published row values and product defaults', (row) => {
    const example = EXAMPLE_MACHINES.find(({ key }) => key === row.key)!
    const machine = createExampleMachine(example)
    const sample = createSampleMachine()
    const travel = row.travel
      ? { x: row.travel[0], y: row.travel[1], z: row.travel[2] }
      : sample.travel
    const expected = {
      ...sample,
      id: machine.id,
      name: `Example - ${row.name}`,
      notes: machine.notes,
      controller: row.controller,
      travel,
      minSpindleRpm: row.rpm[0] ?? undefined,
      maxSpindleRpm: row.rpm[1] ?? undefined,
      // WO-2597: approved editable examples are product defaults, not
      // published machine specifications. Pin their metadata independently;
      // exampleMacros.wo2597.test.ts checks the bodies through production MDI.
      macros: [
        {
          id: 'example-part-swap', name: 'Example - Part swap', mCode: 300, hidden: true,
          body: expect.stringMatching(/^\/\/ Retract first, park at the BACK of travel, then M0 pauses for a part swap\.\n/),
        },
        {
          id: 'example-spindle-warm-up', name: 'Example - Spindle warm-up', mCode: 301, hidden: true,
          body: expect.stringMatching(/^\/\/ Warm up clockwise at three RPM stages for 30 seconds each, then stop\.\n/),
        },
        {
          id: 'example-part-trace', name: 'Example - Part trace', mCode: 302, hidden: true,
          body: expect.stringMatching(/^\/\/ Trace a rectangular stock\/part outline in work coordinates, at safe machine Z\.\n/),
        },
      ],
      ...(row.key === 'pcnc-440' ? { type: 'vertical_mill' } : {}),
      ...('cutting' in row ? {
        axisLimits: {
          x: { ...sample.axisLimits!.x, maxCutting: row.cutting[0] },
          y: { ...sample.axisLimits!.y, maxCutting: row.cutting[1] },
          z: { ...sample.axisLimits!.z, maxCutting: row.cutting[2] },
        },
      } : {}),
    }
    // Whole-record comparison also catches extra invented wiring, motion
    // parameters, capabilities or a silently added controller definition.
    expect(machine).toEqual(expected)
    expect(BUILT_IN_DIALECTS.find(({ id }) => id === machine.controller)?.id).toBe(row.controller)
    expect(machine.id).not.toBe(sample.id)
    expect(machine.notes).toContain('Example built from published specifications')
    expect(machine.notes).toContain('Check against your own machine')
    for (const field of ['rapid rates', 'acceleration (unset)', 'probing', 'spindle direction', 'tool changer', 'coolant', 'home convention (unset)', 'other setup values']) {
      expect(machine.notes).toContain(field)
    }
    if (row.key !== 'longmill-30x30') expect(machine.notes).toContain('cutting feeds')
    if (row.rpm[0] === null) expect(machine.notes).toContain('minimum')
    if (row.rpm[1] === null) expect(machine.notes).toContain('maximum spindle RPM (unset)')
    if (row.travel === null) expect(machine.notes).toContain('X/Y/Z travel (406 x 406 x 95 mm sample size; research dimensions unverified)')
    if (['genmitsu-3018', 'longmill-30x30', 'masuter-pro', '6040-class', 'x-carve-1000'].includes(row.key)) {
      expect(machine.notes).toContain('setup values, homing switches')
    }
  })

  it('creates independent identities and nested records without changing the sample or catalog', () => {
    const before = structuredClone(EXAMPLE_MACHINES)
    const sample = createSampleMachine()
    for (const example of EXAMPLE_MACHINES) {
      const first = createExampleMachine(example)
      const second = createExampleMachine(example)
      expect(first.id).not.toBe(second.id)
      first.travel.x = -1
      first.axisLimits!.x!.maxRapid = -1
      first.probing!.fastFeed = -1
      expect(second.travel.x).toBeGreaterThan(0)
      expect(second.axisLimits!.x!.maxRapid).toBe(5000)
      expect(second.probing).toEqual(sample.probing)
    }
    expect(EXAMPLE_MACHINES).toEqual(before)
    expect(createSampleMachine()).toEqual(sample)
  })
})
