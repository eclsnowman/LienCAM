// WO-474 ITEM 1 - the refusal carries its own reason, so the panel stops
// inferring one.
//
// Before this, `commandSpindle` returned only { ok, route }. SpindlePanel then
// called `estopNeedsReset()` ITSELF and picked a sentence from it, falling back
// to a generic "the spindle command was refused" when that came back false.
// That is a second opinion about something this function already knows, and it
// fails silently: a refusal path added in machineSession that the panel has
// never heard of arrives wearing the generic sentence, and nothing anywhere
// indicates a sentence went missing.
//
// These tests drive the REAL commandSpindle with an injected controller - not a
// mock of it - because a mocked commandSpindle can only ever return the reason
// the test author already thought of, which is the exact failure being fixed.
//
// HONEST ABOUT REACH, in the same terms WO-474 used for the Off press:
// `estopNeedsReset()` is TRUE on a fresh module load (machineSession.ts:531),
// which is the state this order was found in and the state every fresh browser
// load is in. So the E-STOP paths are exercised here directly. Clearing the
// latch needs a connected session AND a controller-proven verified idle (see
// estopResetInterlock.wo328), so `controllerRefused` is NOT executed here - it
// is held by the TYPE, since SpindleCommandResult makes `reason` mandatory on
// every ok:false branch and `npm run build` is what proves that. `notSent` IS
// executed, via a disconnected session. Said out loud rather than implied by a
// green file.

import { describe, it, expect } from 'vitest'
import {
  commandSpindle,
  estopNeedsReset,
  ESTOP_BLOCKS_MOTION,
  SPINDLE_REFUSAL,
} from '../../lib/machine/machineSession'
import type { MachineController } from '../../lib/machine/controller'

const caps = (over: Record<string, boolean>) =>
  ({
    geometryQueue: false,
    executingMoveId: false,
    bufferSeconds: false,
    gcodeText: false,
    perAxisHoming: false,
    ownsSpindle: false,
    spindleCommands: false,
    ...over,
  }) as MachineController['capabilities']

/** Takes spindle CALLS - the AXBB's route. */
const callsCtrl = (onResult = true) =>
  ({
    capabilities: caps({ spindleCommands: true }),
    spindleOn: () => onResult,
    spindleOff: () => true,
  }) as unknown as MachineController

/** Takes G-code TEXT - GRBL's route. */
const textCtrl = () =>
  ({ capabilities: caps({ gcodeText: true }) }) as unknown as MachineController

/** Has no spindle control at all. */
const noSpindleCtrl = () =>
  ({ capabilities: caps({}) }) as unknown as MachineController

const lines = () => ['M3 S12000']

describe('WO-474 item 1: a refused spindle command says why, itself', () => {
  // The precondition this whole order was found in. If this ever goes false the
  // tests below stop meaning what they say, so it is asserted, not assumed.
  it('the latch is SET on a fresh module load - the state of every fresh page', () => {
    expect(estopNeedsReset()).toBe(true)
  })

  it('CALLS route refused by the software stop names the software stop', () => {
    const result = commandSpindle('cw', 12000, lines, callsCtrl())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(SPINDLE_REFUSAL.estop)
    expect(result.reason).toMatch(/software stop/i)
  })

  it('TEXT route refused by the software stop names the software stop too - both routes, one sentence', () => {
    const result = commandSpindle('ccw', 12000, lines, textCtrl())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(SPINDLE_REFUSAL.estop)
  })

  // The two routes must not disagree about WHY. A panel that inferred the cause
  // could only ever produce one sentence for both; the point of carrying the
  // reason is that they now agree because they come from the same place.
  it('the software-stop sentence is the SHARED one, not a spindle-private copy', () => {
    expect(SPINDLE_REFUSAL.estop).toBe(ESTOP_BLOCKS_MOTION)
  })

  it('a controller with no spindle control says THAT, and does not blame the software stop', () => {
    const result = commandSpindle('cw', 12000, lines, noSpindleCtrl())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(SPINDLE_REFUSAL.unsupported)
    // The latch IS set here. Naming it anyway would be the old inference's
    // exact mistake - the dominant cause borrowed for a case it does not own.
    expect(estopNeedsReset()).toBe(true)
    expect(result.reason).not.toMatch(/software stop/i)
  })

  // NOTHING GATES A STOP, and a stop that succeeds carries no reason at all.
  it('OFF is not refused even with the latch set, and returns no reason', () => {
    const result = commandSpindle('off', 0, lines, callsCtrl())
    expect(result.ok).toBe(true)
    expect('reason' in result).toBe(false)
  })

  // FOUND BY THIS TEST FAILING, and the test was the thing that was wrong.
  // The text route hands the lines to `runMachineAction`, which sends through
  // the SESSION's controller - not the injected one, which only decides the
  // route. With no session connected the line cannot go, so the honest answer
  // is notSent. That makes `notSent` reachable here after all, and it pins the
  // distinction the old inference could never draw: M5 is latch-exempt, so this
  // refusal is NOT the E-STOP even though the latch is set.
  it('a stop that cannot be SENT says so, and does not blame the software stop', () => {
    expect(estopNeedsReset()).toBe(true)
    const result = commandSpindle('off', 0, () => ['M5'], textCtrl())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(SPINDLE_REFUSAL.notSent)
    expect(result.reason).not.toMatch(/software stop/i)
  })

  // The same branch, with a line that is NOT latch-exempt, must answer with
  // the software-stop sentence.
  // Two refusals, one code path, and they disagree correctly.
  it('a START on the same route DOES blame the software stop - same path, different cause', () => {
    const result = commandSpindle('cw', 12000, () => ['M3 S12000'], textCtrl())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(SPINDLE_REFUSAL.estop)
  })

  // Every refusal sentence must be usable as-is by an operator: no key names,
  // no "see the console" (it IS the console), and it must end like a sentence.
  it('every refusal reads as a sentence an operator can act on', () => {
    for (const [key, text] of Object.entries(SPINDLE_REFUSAL)) {
      expect(text.length, key).toBeGreaterThan(20)
      expect(text, key).toMatch(/[.]$/)
      expect(text, key).not.toMatch(/see the (machine )?console/i)
    }
  })
})
