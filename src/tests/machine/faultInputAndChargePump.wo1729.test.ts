import { describe, expect, it } from 'vitest'
import type { ControllerDefinition } from '../../types'
import {
  controllerDefinitionPins,
  createDefaultControllerDefinition,
  validateControllerDefinition,
} from '../../types'

describe('WO-1729 drive-fault and charge-pump definition contract', () => {
  it('a blank definition invents neither capability, pin, polarity nor frequency', () => {
    const definition = createDefaultControllerDefinition()

    expect('driveFaultInputs' in definition).toBe(false)
    expect('chargePump' in definition).toBe(false)
    expect(definition.driveFaultInputs).toBeUndefined()
    expect(definition.chargePump).toBeUndefined()
  })

  it('round-trips two fault inputs, both polarities, and a configured charge pump verbatim', () => {
    const definition: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [
        { port: 2, pin: 10, negate: false },
        { port: 3, pin: 7, negate: true },
      ],
      chargePump: {
        enabled: true,
        pin: { port: 4, pin: 1, negate: false },
        frequencyHz: 12_500,
      },
    }

    const crossed = JSON.parse(JSON.stringify(definition)) as ControllerDefinition
    expect(crossed).toEqual(definition)
    expect(crossed.driveFaultInputs).toEqual([
      { port: 2, pin: 10, negate: false },
      { port: 3, pin: 7, negate: true },
    ])
    expect(crossed.chargePump).toEqual({
      enabled: true,
      pin: { port: 4, pin: 1, negate: false },
      frequencyHz: 12_500,
    })
  })

  it('keeps explicit off distinct from absent and leaves optional board-owned fields absent', () => {
    const absent = createDefaultControllerDefinition()
    const off: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [],
      chargePump: { enabled: false },
    }

    expect(absent.chargePump).toBeUndefined()
    expect(JSON.parse(JSON.stringify(off)).chargePump).toEqual({ enabled: false })
    expect('pin' in off.chargePump!).toBe(false)
    expect('frequencyHz' in off.chargePump!).toBe(false)
  })

  it('includes the new physical pins in the shared pin census and duplicate warning route', () => {
    const definition: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [
        { port: 5, pin: 2, negate: false },
        { port: 5, pin: 3, negate: true },
      ],
      chargePump: {
        enabled: true,
        pin: { port: 5, pin: 2, negate: null },
      },
    }

    expect(controllerDefinitionPins(definition).filter(({ label }) =>
      label.startsWith('drive fault input') || label === 'charge pump')).toEqual([
      { label: 'drive fault input 1', pin: { port: 5, pin: 2, negate: false } },
      { label: 'drive fault input 2', pin: { port: 5, pin: 3, negate: true } },
      { label: 'charge pump', pin: { port: 5, pin: 2, negate: null } },
    ])
    expect(validateControllerDefinition(definition)).toContain(
      'Port 5 pin 2 is claimed by both drive fault input 1 and charge pump.',
    )
  })
})
