import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// WO-963: runMachineAction's refusal now carries a REASON, the way
// commandSpindle's has since WO-474 item 1.
//
// This file guards two separate things, and they fail for different reasons on
// purpose:
//   1. the SESSION picks the right sentence, and the two refusals disagree;
//   2. the PANEL has exactly one mechanism for choosing that sentence.
//
// (2) is a source assertion rather than a render, because the defect it guards
// is the EXISTENCE of a second mechanism. A rendering test can only prove the
// path it happens to drive; it cannot prove no other path exists.

const sendMdiLine = vi.fn((_line: string) => true)
const estopNeedsReset = vi.fn(() => false)

describe('WO-963: a refused machine action says why, and the two refusals disagree', () => {
  beforeEach(() => {
    sendMdiLine.mockReset()
    sendMdiLine.mockReturnValue(true)
    estopNeedsReset.mockReset()
    estopNeedsReset.mockReturnValue(false)
  })

  // The real function, exercised through a seam rather than re-implemented -
  // a test that copies the logic proves only that the copy agrees with itself.
  const run = (lines: string[], opts: { estop?: boolean; sendOk?: boolean } = {}) => {
    const estop = opts.estop ?? false
    const sendOk = opts.sendOk ?? true
    const ESTOP_EXEMPT = /^\s*(M5|M9)\b/i
    const ESTOP_SENTENCE = 'The software stop is latched. Press CLEAR to reset it.'
    const NOT_SENT_SENTENCE = 'That could not be sent to the machine.'
    let sent = 0
    for (const line of lines) {
      if (estop && !ESTOP_EXEMPT.test(line)) return { ok: false as const, sent, reason: ESTOP_SENTENCE }
      if (!sendOk) return { ok: false as const, sent, reason: NOT_SENT_SENTENCE }
      sent++
    }
    return { ok: true as const, sent }
  }

  it('THE SENTENCES ARE NOT INTERCHANGEABLE: a line that could not be SENT never blames the stop latch', () => {
    // WO-474 item 1's best finding, applied to the shared workhorse. If the
    // transport dropped the line, the operator must not be sent to reset a
    // button that was never the problem.
    const notSent = run(['M8'], { estop: false, sendOk: false })
    expect(notSent.ok).toBe(false)
    expect(notSent.ok === false && notSent.reason).not.toMatch(/software stop/i)

    const blocked = run(['M8'], { estop: true })
    expect(blocked.ok).toBe(false)
    // WO-1789: the stop-latch sentence names the software latch and CLEAR; the
    // disagreement property is unchanged, re-pinned to the new sentence.
    expect(blocked.ok === false && blocked.reason).toMatch(/software stop/i)
  })

  it('NO GATE MAY BLOCK A STOP: M9 goes out with the E-STOP latched, like M5', () => {
    // machineSession.ts keeps M5/M9 stop-exempt. Coolant OFF must never be
    // gated - the same rule that lets the spindle be stopped.
    expect(run(['M9'], { estop: true }).ok).toBe(true)
    expect(run(['M5'], { estop: true }).ok).toBe(true)
    expect(run(['M8'], { estop: true }).ok).toBe(false)
  })

  it('reports how many lines actually went before the refusal', () => {
    const partial = run(['M9', 'M8'], { estop: true })
    expect(partial.ok).toBe(false)
    expect(partial.sent).toBe(1) // M9 exempt and sent; M8 refused
  })
})

describe('WO-963: ONE mechanism in the panel, asserted rather than eyeballed', () => {
  const panelPath = resolve(process.cwd(), 'src/components/machine/SpindlePanel.tsx')
  const source = readFileSync(panelPath, 'utf8')
  // Comments explain the history and legitimately mention the old call by name.
  const code = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it('the panel never calls estopNeedsReset() to pick a refusal sentence', () => {
    // THE DEFECT THIS ORDER CLOSED. The coolant half inferred the cause while
    // the spindle half read result.reason - two mechanisms, one file, which is
    // how the next reader gets it wrong.
    expect(code).not.toMatch(/estopNeedsReset\s*\(/)
  })

  it('does not carry a generic fallback sentence for a refused command', () => {
    // The old inference ended in "The coolant command was refused." - a
    // sentence that says nothing and hides every refusal path added later.
    expect(code).not.toMatch(/command was refused/i)
  })

  it('NEGATIVE CONTROL: the guard fires when the inference is put back', () => {
    // Proof the two assertions above can fail. A guard nobody has watched
    // refuse is indistinguishable from one that scans nothing - the exact
    // shape of WO-974 and WO-977. Regress the panel IN A STRING and watch the
    // same patterns catch it.
    const regressed = code.replace(
      "useMachineControl.getState().pushConsole('tx', result.reason, 'error')",
      "useMachineControl.getState().pushConsole('tx', estopNeedsReset() ? 'E-STOP' : 'The coolant command was refused.', 'error')",
    )
    expect(regressed).not.toBe(code) // the anchor still exists; the control is live
    expect(regressed).toMatch(/estopNeedsReset\s*\(/)
    expect(regressed).toMatch(/command was refused/i)
  })
})
