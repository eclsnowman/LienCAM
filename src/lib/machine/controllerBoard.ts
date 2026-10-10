import type { MachineConfig } from '../../types'

/**
 * CNCdrive DeviceInfo type names, matching the vendor wrapper vocabulary and
 * the bridge's BoardPinTables.DeviceTypeName table. This is the one app-side
 * name table: components consume controllerBoardName and never reproduce it.
 */
const UCCNC_DEVICE_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'UC100',
  2: 'UC300 (outputs high)',
  3: 'UC300 (outputs low)',
  4: 'UC300-5LPT',
  5: 'UC300-M44',
  6: 'UC300-ISOBOB',
  7: 'UC300-STEPPER',
  8: 'UC400ETH',
  9: 'UC300ETH (outputs high)',
  10: 'UC300ETH (outputs low)',
  11: 'UC300ETH-5LPT',
  12: 'UC300ETH-M44',
  13: 'UC300ETH-ISOBOB',
  14: 'UC300ETH-STEPPER',
  15: 'UC300-5441',
  16: 'UC300ETH-5441',
  17: 'UC300ETH-M45',
  18: 'UC300ETH-UB1',
  19: 'AXBB-E',
  20: 'UCMIB',
}

/**
 * The declared board name for a UCCNC machine, or null when the definition
 * does not state a known identity. A stale UCCNC board field on another
 * controller is deliberately ignored.
 */
export function controllerBoardName(
  machine: Pick<MachineConfig, 'controller' | 'controllerBoard'> | null | undefined,
): string | null {
  if (machine?.controller !== 'uccnc') return null
  return uccncBoardName(machine.controllerBoard?.deviceType)
}

/**
 * The board name for a raw CNCdrive DeviceInfo type, or null when the type
 * is absent or not a known board. This is the one type-to-name read; the
 * label and the editor both go through it so they can never drift apart.
 */
export function uccncBoardName(
  deviceType: number | null | undefined,
): string | null {
  if (!Number.isInteger(deviceType) || !deviceType || deviceType < 1) return null
  return UCCNC_DEVICE_TYPE_NAMES[deviceType] ?? null
}

/**
 * The device choices a UCCNC editor lists, in DeviceInfo type order, derived
 * from the one name table above. A component must not keep its own copy.
 */
export function uccncBoardOptions(): { deviceType: number; name: string }[] {
  return Object.entries(UCCNC_DEVICE_TYPE_NAMES)
    .map(([deviceType, name]) => ({ deviceType: Number(deviceType), name }))
    .sort((a, b) => a.deviceType - b.deviceType)
}

/**
 * The honest words for a stored type the table does not know. The Controller
 * area and the All Settings row both show it, so an unknown identity reads
 * the same on every surface and is never dressed up as a known board.
 */
export function uccncBoardUnknownName(deviceType: number): string {
  return `Unknown device type ${deviceType}`
}

/** The DeviceInfo type behind a display name, or null when no board is named
 *  that. The one reverse read of the table; editors do not keep their own. */
export function uccncBoardDeviceTypeByName(name: string): number | null {
  for (const [deviceType, known] of Object.entries(UCCNC_DEVICE_TYPE_NAMES)) {
    if (known === name) return Number(deviceType)
  }
  return null
}

/**
 * THE ONE WRITER of this fact, shared by the Controller area and the All
 * Settings row so the two doors cannot drift. `null` clears: the machine
 * library door MERGES records, so naming the key as undefined is what takes
 * the optional fact off the record - the same shape the skew and Safe Z
 * clears use. Writing the type the record already states returns it
 * untouched, so an unknown stored id survives an edit that does not name a
 * board.
 */
export function withUccncBoardDeviceType(
  machine: MachineConfig,
  deviceType: number | null,
): MachineConfig {
  if (deviceType === null) {
    return machine.controllerBoard === undefined
      ? machine
      : { ...machine, controllerBoard: undefined }
  }
  return machine.controllerBoard?.deviceType === deviceType
    ? machine
    : { ...machine, controllerBoard: { deviceType } }
}
