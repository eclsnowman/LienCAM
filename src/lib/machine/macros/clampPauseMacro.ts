// WO-1743: UCCNC imports bring the profile's own macros and add none.
//
// This module remains as a compatibility surface for callers introduced by
// WO-1652, but its former store subscription and built-in M2001 insertion are
// intentionally gone. A machine that wants LienCAM's clampPause() action can
// bind it in its own editable macro, just like any other machine action.

import { machineParks, type MachineConfig } from '../../../types'
import {
  machineParkList,
  machineSafeZValue,
  parkMacroPositions,
  toolChangePark,
  type MachineActionConfig,
  type ParkPosition,
} from '../machineActions'

/** WO-2437: THE PARK A WORKHOLDING STOP GOES TO - one answer, read by the
 *  operator stop the post writes (emit.ts) and by the clamp pause Control runs
 *  at a program's M2001 (machineSession.ts), so the file and Control park in the
 *  same place. Operator ruling 2026-10-02 4:26 PM: "User setable." The machine's own
 *  `operatorStopPark` setting first; unset, the machine's Park 1 (its first
 *  position macro, else its G30 P1); with neither, the park the guided tool
 *  change uses, else the machine's first park. Null when the machine has no
 *  park. */
export function workholdingStopPark(
  machine: (Parameters<typeof machineParkList>[0] & Pick<MachineConfig, 'operatorStopPark'>) | null | undefined,
  config: MachineActionConfig | undefined,
): ParkPosition | null {
  const set = machine?.operatorStopPark
  if (set && [set.x, set.y, set.z].every(Number.isFinite)) {
    return { id: OPERATOR_STOP_PARK_ID, label: 'Operator stop park', x: set.x, y: set.y, z: set.z, zFirst: true }
  }
  // WO-2657: a position macro hidden from the Macros panel is off - not a park.
  if (machine?.macros?.some((macro) => macro.hidden)) {
    machine = { ...machine, macros: machine.macros.filter((macro) => !macro.hidden) }
  }
  const park1 = parkMacroPositions(machine)[0] ?? machineParks(machine).find((park) => park.id === 'g30-p1')
  if (park1) return park1
  const parks = machineParkList(machine, config)
  return toolChangePark(machine, config, parks) ?? parks[0] ?? null
}

/** The id of the park `workholdingStopPark` answers from the user's setting. */
export const OPERATOR_STOP_PARK_ID = 'operator-stop-park'

/** THE ONE WRITER for the operator-stop park, used by both machine-definition
 *  lenses. One axis typed on an unset park starts from the park the stop uses
 *  today (Park 1 ...), so the other two axes do not jump to 0; null clears the
 *  setting back to that default. */
export function withOperatorStopParkAxis(
  machine: MachineConfig,
  axis: 'x' | 'y' | 'z',
  value: number | null,
): MachineConfig {
  if (value === null) return { ...machine, operatorStopPark: null }
  const from = machine.operatorStopPark ?? (() => {
    const park = workholdingStopPark({ ...machine, operatorStopPark: null }, undefined)
    const z = typeof park?.z === 'number' && Number.isFinite(park.z) ? park.z : machineSafeZValue(machine) ?? 0
    return { x: park?.x ?? 0, y: park?.y ?? 0, z }
  })()
  return { ...machine, operatorStopPark: { ...from, [axis]: value } }
}

/** No record needs an application-supplied clamp macro. */
export function needsClampPauseMacro(_record: MachineConfig): boolean {
  return false
}

/** Compatibility no-op: imports and records retain exactly their own macros. */
export function withClampPauseMacro(record: MachineConfig): MachineConfig {
  return record
}

/** Compatibility no-op retained for modules that used to request the move. */
export function addClampPauseMacros(): void {
  // Deliberately empty.
}
