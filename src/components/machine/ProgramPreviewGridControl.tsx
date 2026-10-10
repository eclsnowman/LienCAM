import type { WcsId } from '../../lib/machine/types'
import {
  safeMachinePosition,
  type AxisEnvelope,
  type EnvelopeStatus,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import {
  PERSISTED_USER_DATA_REGISTRY,
  readRegisteredLocalData,
  writeRegisteredLocalData,
} from '../../store/persistedKeys'

export const PROGRAM_PREVIEW_GRID_STORAGE_KEY =
  PERSISTED_USER_DATA_REGISTRY.programPreviewGrid.key

export const PROGRAM_PREVIEW_WCS_IDS: readonly WcsId[] = [
  'G54',
  'G55',
  'G56',
  'G57',
  'G58',
  'G59',
]

/** WO-414 batch 2 (Operator ruling 2026-08-21: "a dropdown with off, machine, and the
 *  G54, G55, G56, etc in that dropdown. No more than that"): the choice is
 *  exactly one of those eight. The old "follow the active WCS" entry is gone;
 *  a stored 'active' reads as the default (ADR-0040: no legacy). */
export type ProgramPreviewGridSelection = 'off' | 'machine' | WcsId

/** Default grid when nothing (or something stale) is stored: the machine
 *  frame - it exists for every machine, homed or declared, and never depends
 *  on which work offset happens to be active. */
export const DEFAULT_PROGRAM_PREVIEW_GRID: ProgramPreviewGridSelection = 'machine'

export interface GridAxisExtent {
  min: number
  max: number
}

export interface ProgramPreviewGridResolution {
  label: string
  available: boolean
  programOriginMachine: { x: number; y: number; z: number } | null
  /** Coordinate-system origin used to phase the grid and place its axis
   *  marker. This is deliberately not the physical homing-switch point. */
  gridOriginMachine: { x: number; y: number; z: number } | null
  travel: { x: number; y: number } | null
  /** WO-308: the machine's actual reachable box per axis, straight from the
   *  envelope - min/max already carry the sign convention (far corner:
   *  min < 0 == max; near corner: 0 == min < max), so a caller never has to
   *  re-derive which side of zero the table sits on. */
  extentMachine: { x: GridAxisExtent; y: GridAxisExtent } | null
}

function finiteVec3(values: number[] | undefined) {
  if (!values || values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) return null
  return { x: values[0], y: values[1], z: values[2] }
}

function axisExtent(axis: AxisEnvelope | null): GridAxisExtent | null {
  return axis ? { min: axis.min, max: axis.max } : null
}

export function isProgramPreviewGridSelection(
  value: unknown,
): value is ProgramPreviewGridSelection {
  return value === 'off'
    || value === 'machine'
    || PROGRAM_PREVIEW_WCS_IDS.includes(value as WcsId)
}

export function readProgramPreviewGridSelection(): ProgramPreviewGridSelection {
  try {
    const stored = readRegisteredLocalData('programPreviewGrid')
    return isProgramPreviewGridSelection(stored) ? stored : DEFAULT_PROGRAM_PREVIEW_GRID
  } catch {
    return DEFAULT_PROGRAM_PREVIEW_GRID
  }
}

export function persistProgramPreviewGridSelection(selection: ProgramPreviewGridSelection) {
  try {
    writeRegisteredLocalData('programPreviewGrid', selection)
  } catch {
    // A blocked storage backend must not make the machine preview unusable.
  }
}

/**
 * WO-308: the Control grid draws the machine's actual reachable box, in the
 * machine's own sign convention. Takes the envelope WO-292/300 already
 * derived from $130-$132/$23/$27, rather than re-reading $130/$131 straight -
 * two derivations of the same fact can disagree; one cannot.
 *
 * `envelopeStatus` gates the "machine" selection through `safeMachinePosition`,
 * the one honesty chokepoint WO-292 built: an unknown or not-yet-homed
 * machine gets no confidently-placed grid, same as it gets no confidently-
 * placed live position. WCS-frame selections (active/G54-G59) are unaffected -
 * they show the same physical table, just from a different origin, and their
 * availability has always depended on the offset being known, not on homing.
 * WO-414 batch 2: a chosen G5x grid uses THAT offset's origin from the work-
 * offsets table (all six are in the store) - the program still sits at the
 * ACTIVE offset (programOriginMachine), so switching grids never moves it.
 */
export function resolveProgramPreviewGrid(
  selection: ProgramPreviewGridSelection,
  activeWcs: WcsId | null,
  offsets: Record<string, number[]>,
  envelope: MachineEnvelope,
  envelopeStatus: EnvelopeStatus,
): ProgramPreviewGridResolution {
  const activeOrigin = activeWcs ? finiteVec3(offsets[activeWcs]) : null
  if (selection === 'off') {
    return {
      label: 'Off',
      available: true,
      programOriginMachine: activeOrigin,
      gridOriginMachine: null,
      travel: null,
      extentMachine: null,
    }
  }

  const extentX = axisExtent(envelope.x)
  const extentY = axisExtent(envelope.y)
  const extentMachine = extentX && extentY ? { x: extentX, y: extentY } : null
  const travel = extentMachine
    ? { x: extentMachine.x.max - extentMachine.x.min, y: extentMachine.y.max - extentMachine.y.min }
    : null

  if (selection === 'machine') {
    const safeEnvelope = safeMachinePosition(envelopeStatus, envelope)
    const machineZeroOrigin = safeEnvelope?.x && safeEnvelope.y
      ? { x: 0, y: 0, z: 0 }
      : null
    // The signed envelope says where the table lies relative to machine zero.
    // Homing only makes that frame trustworthy; the switch location must not
    // move the grid origin away from machine-coordinate zero.
    const available = machineZeroOrigin !== null && travel !== null
    return {
      label: available ? 'Machine' : travel === null ? 'Machine unavailable' : 'Machine - HOME FIRST',
      available,
      programOriginMachine: activeOrigin,
      gridOriginMachine: available ? machineZeroOrigin : null,
      travel: available ? travel : null,
      extentMachine: available ? extentMachine : null,
    }
  }

  const offset = finiteVec3(offsets[selection])
  const available = offset !== null && travel !== null && activeOrigin !== null
  const selectedName = selection

  return {
    label: available ? selectedName : `${selectedName} unavailable`,
    available,
    programOriginMachine: activeOrigin,
    gridOriginMachine: available ? offset : null,
    travel: available ? travel : null,
    extentMachine: available ? extentMachine : null,
  }
}

/** WO-377: names the FRAME the grid numbers are in. WO-414 batch 2: no longer
 *  a caption under the selector (Operator: one line, no more) - it is the
 *  selector's tooltip, one hover deep. */
export function gridFrameCaption(value: ProgramPreviewGridSelection): string {
  if (value === 'off') return 'No grid drawn. The program does not move when you switch grids.'
  if (value === 'machine') {
    return 'Machine grid - numbers are machine coordinates from machine zero. The program does not move when you switch grids.'
  }
  return `Work grid - numbers are ${value} work coordinates. The program does not move when you switch grids.`
}

interface ProgramPreviewGridControlProps {
  value: ProgramPreviewGridSelection
  onChange: (value: ProgramPreviewGridSelection) => void
  resolution: ProgramPreviewGridResolution
}

/** WO-414 batch 2 (Operator ruling 2026-08-21: "simplify grid. I should just be one
 *  line, and a dropdown with off, machine, and the G54, G55, G56, etc in that
 *  dropdown. No more than that. Keep It Simple"): ONE native select, styled
 *  like every other app select (.mform-input), eight options, no chevron, no
 *  expanded card, no caption. All six G5x are always listed (the store holds
 *  all six offsets); an unknown one reads "G56 unavailable" while selected.
 *  The frame the numbers are in (WO-377) is the select's tooltip. */
export function ProgramPreviewGridControl({
  value,
  onChange,
  resolution,
}: ProgramPreviewGridControlProps) {
  const tip = gridFrameCaption(value)
  return (
    <div
      className="control-overlay-card control-overlay-grid-card"
      data-testid="program-preview-grid-control"
      data-grid-selection={value}
    >
      <select
        className="mform-input control-preview-grid-select"
        aria-label="Preview coordinate grid"
        data-testid="program-preview-grid-label"
        data-grid-frame={value === 'off' ? 'none' : value === 'machine' ? 'machine' : 'work'}
        title={tip}
        value={value}
        onChange={(event) => {
          const next = event.target.value
          if (isProgramPreviewGridSelection(next)) onChange(next)
        }}
      >
        <option value="off">Off</option>
        <option value="machine">{value === 'machine' ? resolution.label : 'Machine'}</option>
        {PROGRAM_PREVIEW_WCS_IDS.map((wcs) => (
          <option key={wcs} value={wcs}>{value === wcs ? resolution.label : wcs}</option>
        ))}
      </select>
    </div>
  )
}
