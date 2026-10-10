// WO-2668: WHICH OUTPUT PINS A CONTROL BUTTON IS SHOWING RIGHT NOW.
//
// A mounted button registers the pins it lights from; the session reads those
// pins back now and after every edge that may switch an output without a word
// of ours (connect, Stop/Reset, E-STOP, a job's end). Only watched pins are
// read - nothing on screen asks, nothing goes on the wire. Kept apart from
// machineSession so a panel can watch without importing the session's door,
// and the session supplies the reader when it loads.

import type { MachineOutputDefinition, PinRef } from '../../types'
import type { MachineController, OutputReadback, OutputSwitchRequest } from './controller'
import { outputPinAssigned } from './machineOutputs'

/** The one key an output pin's controller readback is kept under - the
 *  session writes it, a Control button reads it. */
export const outputPinKey = (pin: Pick<PinRef, 'port' | 'pin'>): string => `${pin.port}:${pin.pin}`

/**
 * IS THIS OUTPUT ON, AS THE CONTROLLER LAST READ IT BACK? Null when the output
 * has no pin to read, or its pin has not been read this session - the caller
 * keeps its own fallback for that and only for that.
 */
export function outputReadbackOn(
  output: Pick<MachineOutputDefinition, 'pin'> | null | undefined,
  pins: Readonly<Record<string, boolean>>,
): boolean | null {
  if (!output || !outputPinAssigned(output.pin)) return null
  return pins[outputPinKey(output.pin)] ?? null
}

/** A controller that can READ one output back, read-only, with the
 *  definition's negate (the UCCNC bridge's `getOutput`). Resolves null when
 *  the board could not report the pin; returns null when nothing could be
 *  asked (no link). Text controllers have no such read. */
export interface OutputPinReadback {
  readOutput(request: Omit<OutputSwitchRequest, 'on'>): Promise<OutputReadback | null> | null
}

export function canReadOutputPins(ctrl: MachineController): ctrl is MachineController & OutputPinReadback {
  return typeof (ctrl as Partial<OutputPinReadback>).readOutput === 'function'
}

const watched = new Map<string, { pin: PinRef; watchers: number }>()
let reader: ((pins: readonly PinRef[]) => void) | null = null

/** The session's read-back door; set once when the session loads. */
export function setOutputPinReader(read: (pins: readonly PinRef[]) => void): void {
  reader = read
}

/** Every pin a mounted button is showing, one entry per pin. */
export function watchedOutputPins(): PinRef[] {
  return [...watched.values()].map((entry) => entry.pin)
}

/** A button showing these pins' state: they are read now and after every edge,
 *  until the returned release. Unassigned pins are nothing to read. */
export function watchOutputPins(pins: readonly PinRef[]): () => void {
  const assigned = pins.filter(outputPinAssigned)
  const added: PinRef[] = []
  for (const pin of assigned) {
    const entry = watched.get(outputPinKey(pin))
    if (entry !== undefined) {
      entry.watchers++
      continue
    }
    watched.set(outputPinKey(pin), { pin, watchers: 1 })
    added.push(pin)
  }
  if (added.length > 0) reader?.(added)
  return () => {
    for (const pin of assigned) {
      const entry = watched.get(outputPinKey(pin))
      if (entry !== undefined && --entry.watchers <= 0) watched.delete(outputPinKey(pin))
    }
  }
}
