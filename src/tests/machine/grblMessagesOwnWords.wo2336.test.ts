import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import { GRBL_ALARM_MESSAGES, GRBL_ERROR_MESSAGES } from '../../lib/machine/grbl/constants'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'

// WO-2336: the numbered GRBL messages are LienCAM's own words. The sentences
// below are the OLD wording (the "before" column of
// src/tests/evidence/WO-2336/messages.md); no message may equal one of them.
const OLD_ERRORS: Record<number, string> = {
  1: "G-code words consist of a letter and a value. Letter was not found.",
  2: "Numeric value format is not valid or missing an expected value.",
  3: "'$' system command was not recognized or supported.",
  4: "Negative value received for an expected positive value.",
  5: "Homing cycle is not enabled via settings.",
  6: "Minimum step pulse time must be greater than 3 usec.",
  7: "EEPROM read failed. Reset and restored to default values.",
  8: "'$' command cannot be used unless Grbl is IDLE.",
  9: "G-code locked out during alarm or jog state.",
  10: "Soft limits cannot be enabled without homing also enabled.",
  11: "Max characters per line exceeded. Line was not processed and executed.",
  12: "'$' setting value exceeds the maximum step rate supported.",
  13: "Safety door detected as opened and door state initiated.",
  14: "Build info or startup line exceeded EEPROM line length limit.",
  15: "Jog target exceeds machine travel. Command ignored.",
  16: "Jog command with no '=' or contains prohibited g-code.",
  17: "Laser mode requires PWM output.",
  20: "Unsupported or invalid g-code command found in block.",
  21: "More than one g-code command from same modal group found in block.",
  22: "Feed rate has not yet been set or is undefined.",
  23: "G-code command in block requires an integer value.",
  24: "Two g-code commands that both require the use of the XYZ axis words were detected in the block.",
  25: "A g-code word was repeated in the block.",
  26: "A g-code command implicitly or explicitly requires XYZ axis words in the block, but none were detected.",
  27: "N line number value is not within the valid range of 1 - 9,999,999.",
  28: "A g-code command was sent, but is missing some required P or L value words in the line.",
  29: "Grbl supports six work coordinate systems G54-G59. G59.1, G59.2, and G59.3 are not supported.",
  30: "The G53 g-code command requires either a G0 seek or G1 feed motion mode to be active.",
  31: "There are unused axis words in the block and G80 motion mode cancel is active.",
  32: "A G2 or G3 arc was commanded but there are no XYZ axis words in the selected plane to trace the arc.",
  33: "The motion command has an invalid target.",
  34: "A G2 or G3 arc, traced with the radius definition, had a mathematical error when computing the arc geometry.",
  35: "A G2 or G3 arc, traced with the offset definition, is missing the IJK offset word in the selected plane.",
  36: "There are unused, leftover g-code words that are not used by any command in the block.",
  37: "The G43.1 dynamic tool length offset command cannot apply an offset to an axis other than its configured axis.",
  38: "Tool number greater than max supported value.",
}
const OLD_ALARMS: Record<number, string> = {
  1: "Hard limit triggered. Machine position is likely lost. Re-homing is highly recommended.",
  2: "Soft limit alarm: G-code motion target exceeds machine travel. Machine position safely retained. Alarm may be unlocked.",
  3: "Reset while in motion. Machine position is likely lost. Re-homing is highly recommended.",
  4: "Probe fail. The probe is not in the expected initial state before starting the probe cycle.",
  5: "Probe fail. Probe did not contact the workpiece within the programmed travel.",
  6: "Homing fail. Reset during active homing cycle.",
  7: "Homing fail. Safety door was opened during active homing cycle.",
  8: "Homing fail. Cycle failed to clear limit switch when pulling off.",
  9: "Homing fail. Could not find limit switch within search distance.",
  10: "Homing fail. Second dual-axis limit switch failed to trigger.",
}

const enc = new TextEncoder()

class FakeTransport implements MachineTransport {
  events: TransportEvents | null = null
  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }
  async write(): Promise<void> {}
  async close(): Promise<void> {
    this.events?.onClose(null)
  }
  feed(text: string): void {
    this.events!.onChunk(enc.encode(text))
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onStatus: vi.fn(),
    onConsole: vi.fn(),
    onAlarm: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onWelcome: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connect() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0)
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  return { ft, events }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GRBL messages in LienCAM words (WO-2336)', () => {
  it('keeps exactly the same set of codes', () => {
    expect(Object.keys(GRBL_ERROR_MESSAGES).map(Number)).toEqual(Object.keys(OLD_ERRORS).map(Number))
    expect(Object.keys(GRBL_ALARM_MESSAGES).map(Number)).toEqual(Object.keys(OLD_ALARMS).map(Number))
  })

  for (const code of Object.keys(OLD_ERRORS).map(Number)) {
    it(`error:${code} reaches the console in new words`, async () => {
      const { ft, events } = await connect()
      ft.feed(`error:${code}\n`)
      const texts = events.onConsole.mock.calls.map((c) => c[0].text as string)
      const hit = texts.find((t) => t.startsWith(`error:${code} - `))
      expect(hit).toBeDefined()
      const message = hit!.slice(`error:${code} - `.length)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toBe(OLD_ERRORS[code])
      expect(message).toBe(GRBL_ERROR_MESSAGES[code])
    })
  }

  for (const code of Object.keys(OLD_ALARMS).map(Number)) {
    it(`ALARM:${code} reaches the alarm event in new words`, async () => {
      const { ft, events } = await connect()
      ft.feed(`ALARM:${code}\n`)
      const call = events.onAlarm.mock.calls.find((c) => c[0] === code)
      expect(call).toBeDefined()
      const message = call![1] as string
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toBe(OLD_ALARMS[code])
      expect(message).toBe(GRBL_ALARM_MESSAGES[code])
    })
  }
})
