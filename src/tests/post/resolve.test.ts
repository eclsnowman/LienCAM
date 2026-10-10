import { describe, it, expect } from 'vitest'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeOverride } from './helpers'

describe('resolveSpindle', () => {
  it('uses tool default rpm when no override', () => {
    const r = resolveSpindle(makeOp(), makeTool(), makeMachine())
    expect(r.rpm).toBe(12000)
    expect(r.dir).toBe('cw')
  })

  it('override.enabled wins over tool default', () => {
    const op = makeOp({ feedrateOverride: makeOverride({ rpm: 18000 }) })
    const r = resolveSpindle(op, makeTool(), makeMachine())
    expect(r.rpm).toBe(18000)
  })

  it('clamps above machine max', () => {
    const op = makeOp({ feedrateOverride: makeOverride({ rpm: 30000 }) })
    const r = resolveSpindle(op, makeTool(), makeMachine({ maxSpindleRpm: 24000 }))
    expect(r.rpm).toBe(24000)
  })

  it('clamps below machine min', () => {
    const tool = makeTool({ feedsAndSpeeds: { default: { rpm: 1000, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1 } } })
    const r = resolveSpindle(makeOp(), tool, makeMachine({ minSpindleRpm: 6000 }))
    expect(r.rpm).toBe(6000)
  })

  it('direction comes from cutter hand, never the legacy machine default', () => {
    const machine = makeMachine({ spindleDirection: 'ccw' })
    expect(resolveSpindle(makeOp(), makeTool({ cutHand: 'right' }), machine).dir).toBe('cw')
    expect(resolveSpindle(makeOp(), makeTool({ cutHand: 'left' }), machine).dir).toBe('ccw')
  })

  it('falls back to first key when default missing', () => {
    const tool = makeTool({ feedsAndSpeeds: { aluminum: { rpm: 15000, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1 } } })
    const r = resolveSpindle(makeOp(), tool, makeMachine())
    expect(r.rpm).toBe(15000)
  })
})

describe('resolveCoolant', () => {
  it('passes through tool default coolant', () => {
    expect(resolveCoolant(makeTool(), makeMachine())).toBe('flood')
  })

  it('defaults to none when tool has no coolant set', () => {
    const tool = makeTool({ feedsAndSpeeds: { default: { rpm: 1, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1 } } })
    expect(resolveCoolant(tool, makeMachine())).toBe('none')
  })

  it('machine.coolant=false forces none', () => {
    expect(resolveCoolant(makeTool(), makeMachine({ coolant: false }))).toBe('none')
  })

  // WO-965 - THE PER-CHANNEL HALF OF THE SAME QUESTION.
  //
  // `MachineConfig.coolant` is one bit for a machine with two relays. A machine
  // with mist and no flood used to be posted M8 anyway, while the Control page
  // had already stopped drawing the button - one fact, two answers. The post
  // now reads the channel.
  describe('WO-965: what the machine actually HAS', () => {
    const asking = (coolant: 'mist' | 'flood' | 'air') => makeTool({
      feedsAndSpeeds: {
        default: { rpm: 1, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1, coolant },
      },
    })

    it('refuses a channel the machine states it has NOT got', () => {
      const mistOnly = makeMachine({
        coolant: true, coolantCapability: { mist: true, flood: false },
      })
      expect(resolveCoolant(asking('flood'), mistOnly)).toBe('none')
      expect(resolveCoolant(asking('mist'), mistOnly)).toBe('mist')
    })

    it('ABSENT IS NOT FALSE - a machine nobody has described posts what it is asked', () => {
      const unasked = makeMachine({ coolant: true })
      expect(unasked.coolantCapability).toBeUndefined()
      expect(resolveCoolant(asking('flood'), unasked)).toBe('flood')
      expect(resolveCoolant(asking('mist'), unasked)).toBe('mist')
      // A half-answered machine answers for the half it was asked about only.
      const mistSaidNo = makeMachine({ coolant: true, coolantCapability: { mist: false } })
      expect(resolveCoolant(asking('mist'), mistSaidNo)).toBe('none')
      expect(resolveCoolant(asking('flood'), mistSaidNo)).toBe('flood')
    })

    it('reads the DERIVED machine-wide bit, so a contradicting record cannot post wet', () => {
      // Both channels No while the old tick still says yes - the record shape
      // the WO-965 audit failed on. The channels are the evidence; they win.
      const drifted = makeMachine({
        coolant: true, coolantCapability: { mist: false, flood: false },
      })
      expect(resolveCoolant(asking('flood'), drifted)).toBe('none')
      // And the other way: a channel answered Yes on a record whose bit was
      // left false posts that channel rather than a stale refusal.
      const staleFalse = makeMachine({ coolant: false, coolantCapability: { mist: true } })
      expect(resolveCoolant(asking('mist'), staleFalse)).toBe('mist')
    })

    it('never invents a refusal for AIR, which these flags say nothing about', () => {
      const noCoolantChannels = makeMachine({
        coolant: true, coolantCapability: { mist: false, flood: false },
      })
      // Both channels No derives the machine-wide bit to false, and THAT is
      // what refuses the air blast - not a flag that was never about air.
      expect(resolveCoolant(asking('air'), noCoolantChannels)).toBe('none')
      expect(resolveCoolant(asking('air'), makeMachine({
        coolant: true, coolantCapability: { mist: true, flood: false },
      }))).toBe('air')
    })
  })

  it('falls back to first key when default missing', () => {
    const tool = makeTool({ feedsAndSpeeds: { aluminum: { rpm: 1, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1, coolant: 'mist' } } })
    expect(resolveCoolant(tool, makeMachine())).toBe('mist')
  })
})
