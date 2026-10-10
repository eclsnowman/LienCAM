// @vitest-environment jsdom

// WO-2712 (Operator 10-09 4:42, card item 6): the shipped Sample router states
// 406 x 406 x 95 mm travel and homes to X max / Y max / Z max - the Machine
// Library shows both. With nothing typed, the simulator must use that stated
// travel: Start probing is not refused for "a complete machine envelope", and
// the simulated part sits inside the travel. A machine that states no travel
// and no home end keeps its current behaviour.

import { beforeEach, describe, expect, it } from 'vitest'
import { machineHomeConvention } from '../../types'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { createExampleMachine, EXAMPLE_MACHINES } from '../../lib/machine/exampleMachines'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import { planFeatureProbeCycle } from '../../lib/machine/probeFeatureCycle'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { buildDefaultSimulatedPart } = await import('../../lib/machine/machineSession')

const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

describe('WO-2712 the sample router uses its stated travel on the simulator', () => {
  beforeEach(() => {
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl })
  })

  it('the simulator envelope is the stated 406 x 406 x 95, homed at the max ends', () => {
    const sample = useCamStore.getInitialState().project.machine
    expect(sample).toEqual(createSampleMachine())
    const motion = resolveMachineMotion({ machine: sample, connectionKind: 'simulator' })
    expect(motion.envelope.x).toMatchObject({ min: -406, max: 0, homesToward: 'max' })
    expect(motion.envelope.y).toMatchObject({ min: -406, max: 0, homesToward: 'max' })
    expect(motion.envelope.z).toMatchObject({ min: -95, max: 0, homesToward: 'max' })
  })

  it('Start probing (outside corner) is planned, not refused for an incomplete envelope', () => {
    const sample = createSampleMachine()
    const { envelope } = resolveMachineMotion({ machine: sample, connectionKind: 'simulator' })
    const config = resolveProbeConfig(null, sample.probing!)
    const result = planFeatureProbeCycle({
      kind: 'corner',
      start: { x: -200, y: -200, z: -20 },
      envelope,
      config,
      tipRadiusMm: 1,
      nominalSizeXmm: 100,
      nominalSizeYmm: 80,
      cornerXDirection: '+',
      cornerYDirection: '+',
    })
    if (!result.ok) expect(result.reason).toBe('(planned)')
    expect(result.ok).toBe(true)
  })

  it('the simulated part sits inside the stated travel', () => {
    useMachineControl.setState({ connectionKind: 'simulator' })
    const part = buildDefaultSimulatedPart()
    expect(part.origin.x).toBeGreaterThanOrEqual(-406)
    expect(part.origin.x + part.sizeX).toBeLessThanOrEqual(0)
    expect(part.origin.y).toBeGreaterThanOrEqual(-406)
    expect(part.origin.y + part.sizeY).toBeLessThanOrEqual(0)
    expect(part.topZ).toBeLessThanOrEqual(0)
    expect(part.topZ - part.height).toBeGreaterThanOrEqual(-95)
  })

  it('example machines built from the sample still state no home end (unchanged)', () => {
    for (const example of EXAMPLE_MACHINES) {
      const machine = createExampleMachine(example)
      expect(machine.homeConvention, example.key).toBeUndefined()
      expect(machineHomeConvention(machine), example.key).toBeUndefined()
      const motion = resolveMachineMotion({ machine, connectionKind: 'simulator' })
      expect(motion.envelope, example.key).toEqual({ x: null, y: null, z: null })
    }
  })
})
