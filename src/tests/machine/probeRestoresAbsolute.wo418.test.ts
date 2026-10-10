// GrblController.probe() issues G91 because probe travel is relative, and GRBL
// does not restore the distance mode afterwards - it is sticky modal state.
// Leaving it set means the NEXT absolute move is read as relative, which on a
// machine is a move to entirely the wrong place.
//
// Found in architect review: the primitive was added by WO-418 without the
// explicit G90 that machineSession's own probe cycles have always ended with.
// Nothing calls it yet, so it had not bitten - these tests are what stop it.

import { describe, expect, it } from 'vitest'
import { GrblController } from '../../lib/machine/grbl/controller'

/** Captures every line written, without a real controller underneath. */
function harness() {
  const written: string[] = []
  const ctrl = new GrblController({}) as unknown as {
    sendCommand: (t: string) => boolean
    sendCommandAwait: (t: string) => Promise<{ ok: boolean; message: string | null }> | null
    probe: GrblController['probe']
  }
  ctrl.sendCommand = (text: string) => {
    written.push(text)
    return true
  }
  return { ctrl, written }
}

describe('probe() leaves the controller in absolute mode', () => {
  it('restores G90 after a probe whose command is refused outright', async () => {
    const { ctrl, written } = harness()
    // No transport: sendCommandAwait returns null, the earliest failure path.
    ctrl.sendCommandAwait = () => null

    const result = await ctrl.probe('Z', -10, 60)

    expect(result.ok).toBe(false)
    expect(written).toContain('G90')
  })

  it('restores G90 after the controller rejects the probe line', async () => {
    const { ctrl, written } = harness()
    ctrl.sendCommandAwait = () => Promise.resolve({ ok: false, message: 'error:9' })

    const result = await ctrl.probe('Z', -10, 60)

    expect(result.ok).toBe(false)
    expect(written).toContain('G90')
  })

  // PROBE_RESULT_MAX_WAIT_MS is 15s: on a miss, probe() waits the full window
  // for a [PRB:] that never comes. That is the real behaviour, so the test
  // waits it out rather than pretending the path is fast.
  it('restores G90 even when the probe reports no contact', async () => {
    const { ctrl, written } = harness()
    // Accepted, but no [PRB:] ever arrives - the miss case.
    ctrl.sendCommandAwait = () => Promise.resolve({ ok: true, message: null })

    const result = await ctrl.probe('Z', -10, 60)

    expect(result.ok).toBe(false)
    expect(written).toContain('G90')
  }, 20000)
})
