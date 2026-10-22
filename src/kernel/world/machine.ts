// WO-3008 08a (A3-08 algorithm step 6): the machine record, read from a machine
// profile (docs/machine/profiles/*.machine.json, the MachineConfig shape). Nothing
// plans against it in alpha.3 (MD-02 defers planning consumers); the machine-safety and
// settings collectors and the time model are its future readers.
import type { AxisName, MachineConfig } from '../../types'

export interface AxisRecord {
  /** mm/min. */
  readonly maxCutting?: number
  /** mm/min. */
  readonly maxRapid?: number
  /** mm/s^2, where the controller definition states it. */
  readonly acceleration?: number
  /** Soft limits in machine mm, where the controller definition states them. */
  readonly softLimitMin?: number
  readonly softLimitMax?: number
}

export interface MachineRecord {
  readonly id: string
  readonly name: string
  /** Travel box, mm. */
  readonly travel: { readonly x: number; readonly y: number; readonly z: number }
  readonly axes: Readonly<Partial<Record<'x' | 'y' | 'z', AxisRecord>>>
  /** Global rapid, mm/min (per-axis maxRapid overrides it). */
  readonly rapidRate: number
  /** Absent means the profile states no bound; nothing may invent one. */
  readonly spindle: { readonly minRpm?: number; readonly maxRpm?: number }
}

type MachineProfile = Pick<MachineConfig, 'id' | 'name' | 'travel' | 'rapidRate' | 'minSpindleRpm' | 'maxSpindleRpm' | 'axisLimits' | 'controllerDefinition'>

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export function machineRecord(profile: MachineProfile): MachineRecord {
  const axes: Partial<Record<'x' | 'y' | 'z', AxisRecord>> = {}
  for (const axis of ['x', 'y', 'z'] as const) {
    const limits = profile.axisLimits?.[axis]
    const definition = profile.controllerDefinition?.axes?.find(entry => entry.axis === (axis.toUpperCase() as AxisName) && entry.enabled)
    const record = defined<AxisRecord>({
      maxCutting: limits?.maxCutting,
      maxRapid: limits?.maxRapid,
      acceleration: definition?.acceleration,
      softLimitMin: definition?.softLimitMin,
      softLimitMax: definition?.softLimitMax,
    })
    if (Object.keys(record).length > 0) axes[axis] = record
  }
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    travel: Object.freeze({ x: profile.travel.x, y: profile.travel.y, z: profile.travel.z }),
    axes: Object.freeze(axes),
    rapidRate: profile.rapidRate,
    spindle: Object.freeze(defined({ minRpm: profile.minSpindleRpm, maxRpm: profile.maxSpindleRpm })),
  })
}
