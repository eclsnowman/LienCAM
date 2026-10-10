import type { AxisName, ControllerType, MachineConfig } from '../../types'
import {
  boundsOfPoints,
  fitProgramToEnvelope,
  turnWorkPoint,
  type Bounds3,
} from './machineEnvelope'
import { GENERIC_MACHINE_ID, isGrblFamily, resolveDeclaredController } from './machineChoice'
import {
  resolveMachineMotion,
  type ResolvedMachineMotion,
} from './resolvedMachineMotion'
import {
  samplePreviewArc,
  type ArcPlane,
  type PreviewArcCommand,
} from './previewGeometry'
import type { WcsId } from './types'

export type TransferAxisKey = 'x' | 'y' | 'z'

/** One tessellated move of the program, as the shared path builder produced it
 * (`previewGeometry.buildProgramPath`/`buildPreviewModel`): arcs already
 * sampled, canned cycles already expanded, the modal feed carried per move. */
export interface TransferCheckMove {
  line: number
  kind: 'rapid' | 'feed' | 'arc'
  coordinateFrame: 'work' | 'machine'
  workCoordinateSystem: WcsId | null
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
  addressedAxes: ReadonlyArray<TransferAxisKey>
  targetMode?: 'absolute' | 'incremental' | 'line-start'
  plane?: ArcPlane
  sourceArc?: PreviewArcCommand
  feedMmMin: number | null
}

/** Geometry and motion facts prepared by the program-load path. This pure
 * check NEVER interprets G-code: it judges the same move list the Control
 * preview draws, plus the header facts the program context already resolved. */
export interface TransferCheckJob {
  moves: ReadonlyArray<TransferCheckMove>
  /** Program-commanded axes, including zero-delta words and axes used by
   * expanded cycles/arcs, with their first relevant source line. */
  addressedAxes: Partial<Record<TransferAxisKey, { firstLine: number }>>
  /** One-shot G53 destinations already expressed in machine mm. They remain
   * separate from work bounds until the live offset is available. */
  machineCoordinateRanges?: Partial<Record<TransferAxisKey, { min: number; max: number }>>
  spindleRpmMax: number
  postedFor?: {
    id: string
    name: string
    controller: ControllerType
  }
  toolClearances?: ReadonlyArray<{
    toolName: string
    availableMm: number
    requiredMm: number
  }>
}

/** THE FINDING CONTRACT, stated once so no third class can grow between the
 * two that exist:
 *
 * - `refusals` - the job must not run. Never acknowledgeable.
 * - `warnings` - the job may run only after an explicit acknowledge. EVERY
 *   entry is counted in the summary's "checks flagged" total and EVERY entry
 *   gates Cycle Start; there is no filter anywhere downstream.
 * - `notes` - not a finding about the job at all: a statement of what this
 *   check could NOT decide, because an input was missing. Shown to the
 *   operator, never counted, never gating. An acknowledgement cannot turn an
 *   unknown work zero into a known one, and the architect's attempt-2 ruling
 *   is that over-travel is judged only against an ESTABLISHED offset - so an
 *   unestablished axis produces a note, not a warning that must be waved off.
 *
 * A finding that must not gate belongs in `notes`, never in `warnings`. */
export interface TransferCheckResult {
  refusals: string[]
  warnings: string[]
  notes: string[]
}

export interface TransferWorkOffset {
  x?: number
  y?: number
  z?: number
  /** WO-2219: this offset's XY rotation in degrees, as the CONTROLLER reports
   *  it (docs/design/WCS-ROTATION.md: machine = O + Rot(R)(work), CCW positive
   *  from +Z, about the work origin). Absent or 0 = not rotated. */
  rotationDeg?: number
}

/** Verified offsets indexed by the persistent work-coordinate identity used by
 * each program move. The wrapper keeps this distinct from the legacy single
 * offset accepted by pure callers. */
export interface TransferWorkOffsetTable {
  byWcs: Partial<Record<WcsId, TransferWorkOffset>>
  /** The controller's current modal frame. Used only when a direct NC file
   * never selects a persistent WCS of its own. */
  activeWcs?: WcsId
}

const AXES: ReadonlyArray<{ key: TransferAxisKey; label: AxisName }> = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
]

const EPS = 1e-9
const UNCHECKED_TRAVEL_NOTE_PREFIX = 'Work zero not set on '
const UNKNOWN_AXIS_ENVELOPE_NOTE_PREFIX = 'Machine travel unset for '

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function fmt(value: number): string {
  const clean = Object.is(value, -0) ? 0 : value
  return Number.isInteger(clean) ? String(clean) : clean.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** The program's extent, from the SAME tessellated moves the preview draws.
 *  WO-2219: under a rotated offset every point is turned about the work origin
 *  first, so machine = these bounds + offset on each axis. */
function jobBounds(job: TransferCheckJob, rotationDeg = 0): Bounds3 | null {
  const points: Array<{ x: number; y: number; z: number }> = []
  for (const move of job.moves) {
    if (move.coordinateFrame !== 'machine') {
      points.push(turnWorkPoint(move.from, rotationDeg), turnWorkPoint(move.to, rotationDeg))
    }
  }
  return boundsOfPoints(points)
}

function rotationDegOf(offset: TransferWorkOffset | null | undefined): number {
  const degrees = offset?.rotationDeg
  return finite(degrees) ? degrees : 0
}

function isOffsetTable(value: TransferWorkOffset | TransferWorkOffsetTable | null | undefined): value is TransferWorkOffsetTable {
  return !!value && 'byWcs' in value
}

/** Peak commanded velocity on one axis: the modal feed decomposed onto the
 * axis along each straight move. An arc's tangent reaches the full feed on any
 * axis it sweeps, so a sampled chord never softens the number. */
function axisFeedPeak(job: TransferCheckJob, key: TransferAxisKey): number {
  let peak = 0
  for (const move of job.moves) {
    if (!finite(move.feedMmMin)) continue
    const delta = Math.abs(move.to[key] - move.from[key])
    if (delta <= EPS) continue
    const distance = Math.hypot(
      move.to.x - move.from.x,
      move.to.y - move.from.y,
      move.to.z - move.from.z,
    )
    const component = move.kind === 'arc' || distance <= EPS
      ? move.feedMmMin
      : (move.feedMmMin * delta) / distance
    if (component > peak) peak = component
  }
  return peak
}

function postedController(job: TransferCheckJob): ReturnType<typeof resolveDeclaredController> | null {
  if (!job.postedFor) return null
  // The resolver reads only the declared controller. Keep the transfer snapshot
  // compact rather than serializing an obsolete copy of the entire machine.
  return resolveDeclaredController(job.postedFor as MachineConfig)
}

export function checkJobAgainstMachine(
  job: TransferCheckJob,
  machine: MachineConfig,
  workOffset: TransferWorkOffset | TransferWorkOffsetTable | null | undefined,
  // Pure/unit callers historically pass a controller definition directly.
  // Runtime callers always supply their already-resolved live session model.
  motion: ResolvedMachineMotion = resolveMachineMotion({ machine, connectionKind: 'bridge' }),
): TransferCheckResult {
  const refusals: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const source = postedController(job)
  if (source) {
    const target = resolveDeclaredController(machine)
    const sameControllerFamily = source.ok && target.ok
      && isGrblFamily(source.controller) && isGrblFamily(target.controller)
    if (source.ok && target.ok && source.controller !== target.controller && !sameControllerFamily) {
      refusals.push(
        `Controller mismatch: the job was posted for ${source.controller}, but ${machine.name} runs ${target.controller}.`,
      )
    } else if (!target.ok) {
      refusals.push(`Controller check refused for ${machine.name}: ${target.reason}`)
    }
  }

  const envelope = motion.envelope
  const offsetTable = isOffsetTable(workOffset) ? workOffset : null
  const usedWorkCoordinates = new Set(job.moves
    .filter((move) => move.coordinateFrame === 'work' && move.workCoordinateSystem)
    .map((move) => move.workCoordinateSystem as WcsId))
  const hasUnknownWorkCoordinate = job.moves.some(
    (move) => move.coordinateFrame === 'work' && !move.workCoordinateSystem,
  )
  const activeWcsFallback = offsetTable && usedWorkCoordinates.size === 0 && hasUnknownWorkCoordinate
    ? offsetTable.activeWcs ?? null
    : null
  const frameSpecific = !!offsetTable
    && !activeWcsFallback
    && (usedWorkCoordinates.size !== 1 || hasUnknownWorkCoordinate)
  const singleWorkCoordinate = usedWorkCoordinates.size === 1 ? [...usedWorkCoordinates][0] : null
  const singleOffset = offsetTable
    ? (singleWorkCoordinate
        ? offsetTable.byWcs[singleWorkCoordinate]
        : activeWcsFallback
          ? offsetTable.byWcs[activeWcsFallback]
          : undefined)
    : workOffset as TransferWorkOffset | null | undefined
  const offset: TransferWorkOffset = {}
  const checkableAxes = new Set<TransferAxisKey>()
  // WO-2674: the shipped sample is a placeholder, not a chosen machine. Its
  // X, Y and Z exist; nothing places its sample travel, so a commanded axis
  // reads as travel unset - as on a defined machine - instead of refusing.
  const placeholder = machine.id === GENERIC_MACHINE_ID
  for (const { key, label } of AXES) {
    const address = job.addressedAxes[key]
    if (!address) continue
    const axis = motion.axes[key]
    if (axis.definitionState === 'missing-definition' && !axis.effective && !placeholder) {
      refusals.push(
        `${label} is commanded on line ${address.firstLine}, but ${machine.name} has no controller definition or resolved ${label} Machine-page travel envelope.`,
      )
      continue
    }
    if (axis.definitionState === 'disabled') {
      refusals.push(`${label} is commanded on line ${address.firstLine}, but ${machine.name} defines ${label} as disabled.`)
      continue
    }
    if (axis.definitionState === 'undefined') {
      refusals.push(`${label} is commanded on line ${address.firstLine}, but ${machine.name} has no ${label} axis definition (unsupported/undefined).`)
      continue
    }
    if (axis.definitionState === 'invalid' || axis.state === 'invalid') {
      refusals.push(
        `${label} is commanded on line ${address.firstLine}, but ${machine.name} has an invalid ${label} soft-limit envelope; set finite limits with maximum greater than minimum.`,
      )
      continue
    }
    if (axis.state === 'conflict') {
      refusals.push(`${label} is commanded on line ${address.firstLine}, but ${axis.reason}.`)
      continue
    }
    if (!axis.effective) {
      notes.push(
        `${UNKNOWN_AXIS_ENVELOPE_NOTE_PREFIX}${label} on ${machine.name}: travel not checked. To check it, enter both limits on the Definition page.`,
      )
      continue
    }
    checkableAxes.add(key)
    if (frameSpecific) continue
    const value = singleOffset?.[key]
    if (finite(value)) offset[key] = value
    else {
      // A note, not a warning: with no offset there is nothing to judge on
      // this axis, and nothing an acknowledgement could accept.
      notes.push(
        `${UNCHECKED_TRAVEL_NOTE_PREFIX}${label} - travel on ${label} is unchecked until you set it.`,
      )
    }
  }
  if (offsetTable && frameSpecific) {
    const ranges = new Map<string, {
      frame: string
      key: TransferAxisKey
      min: number
      max: number
    }>()
    const missing = new Set<string>()
    const lastAddressedFrame = new Map<TransferAxisKey, string>()
    const machinePosition = new Map<TransferAxisKey, number>()
    let sourceLine = -1
    let lineStartPosition = new Map<TransferAxisKey, number>()
    /** WO-2219: a work move in a ROTATED frame moves machine X and Y together,
     *  whichever of the two it names. Resolves both, in machine coordinates,
     *  from the position the tool is really at. null when the frame is not
     *  rotated or the move names neither X nor Y. */
    const turnedXY = (move: TransferCheckMove): Partial<Record<'x' | 'y', { from: number; to: number }>> | null => {
      if (move.coordinateFrame !== 'work' || !move.workCoordinateSystem) return null
      const origin = offsetTable.byWcs[move.workCoordinateSystem]
      const degrees = rotationDegOf(origin)
      if (degrees === 0) return null
      const namesX = move.addressedAxes.includes('x')
      const namesY = move.addressedAxes.includes('y')
      if (!namesX && !namesY) return null
      const machineX = machinePosition.get('x')
      const machineY = machinePosition.get('y')
      const fromWork = finite(machineX) && finite(machineY) && finite(origin?.x) && finite(origin?.y)
        ? turnWorkPoint({ x: machineX - origin.x, y: machineY - origin.y }, -degrees)
        : { x: move.from.x, y: move.from.y }
      const toWork = move.targetMode === 'incremental'
        ? { x: fromWork.x + (move.to.x - move.from.x), y: fromWork.y + (move.to.y - move.from.y) }
        : { x: namesX ? move.to.x : fromWork.x, y: namesY ? move.to.y : fromWork.y }
      const fromTurned = turnWorkPoint(fromWork, degrees)
      const toTurned = turnWorkPoint(toWork, degrees)
      const resolved: Partial<Record<'x' | 'y', { from: number; to: number }>> = {}
      for (const key of ['x', 'y'] as const) {
        const value = origin?.[key]
        if (!finite(value)) continue
        resolved[key] = {
          from: machinePosition.get(key) ?? fromTurned[key] + value,
          to: toTurned[key] + value,
        }
      }
      return resolved
    }
    const processMove = (move: TransferCheckMove): void => {
      if (move.line !== sourceLine) {
        sourceLine = move.line
        lineStartPosition = new Map(machinePosition)
      }
      const turned = turnedXY(move)
      for (const { key, label } of AXES) {
        if (!move.addressedAxes.includes(key) && !(turned && (key === 'x' || key === 'y'))) continue
        const moveFrame = move.coordinateFrame === 'machine'
          ? 'G53'
          : move.workCoordinateSystem ?? 'unknown'
        const previousFrame = lastAddressedFrame.get(key)
        const includeFrom = previousFrame === undefined || previousFrame === moveFrame
        lastAddressedFrame.set(key, moveFrame)
        if (!checkableAxes.has(key)) continue
        let frame: string
        let origin: number
        if (move.coordinateFrame === 'machine') {
          frame = 'G53'
          origin = 0
        } else if (!move.workCoordinateSystem) {
          const note = `Unknown WCS ${label} is unchecked on line ${move.line} - select G54 through G59 before motion.`
          if (!missing.has(note)) {
            missing.add(note)
            notes.push(note)
          }
          continue
        } else {
          frame = move.workCoordinateSystem
          const selected = offsetTable.byWcs[move.workCoordinateSystem]?.[key]
          if (!finite(selected)) {
            const note = `${frame} ${label} is unchecked - no verified work offset is available.`
            if (!missing.has(note)) {
              missing.add(note)
              notes.push(note)
            }
            continue
          }
          origin = selected
        }
        // Resolve the move into machine coordinates once, in program order.
        // A WCS change does not change the physical start point. Incremental
        // targets therefore advance from that machine point, while a G98
        // expanded return goes back to the point captured before its line.
        const turnedAxis = key === 'z' ? undefined : turned?.[key]
        const from = turnedAxis?.from ?? machinePosition.get(key) ?? move.from[key] + origin
        if (!lineStartPosition.has(key)) lineStartPosition.set(key, from)
        const to = move.targetMode === 'line-start'
          ? lineStartPosition.get(key) ?? from
          : turnedAxis
            ? turnedAxis.to
            : move.targetMode === 'incremental'
              ? from + (move.to[key] - move.from[key])
              : move.to[key] + origin
        machinePosition.set(key, to)
        const id = `${frame}:${key}`
        const previous = ranges.get(id)
        const nextMin = includeFrom ? Math.min(from, to) : to
        const nextMax = includeFrom ? Math.max(from, to) : to
        ranges.set(id, previous
          ? { ...previous, min: Math.min(previous.min, nextMin), max: Math.max(previous.max, nextMax) }
          : { frame, key, min: nextMin, max: nextMax })
      }
    }
    for (let moveIndex = 0; moveIndex < job.moves.length; moveIndex++) {
      const move = job.moves[moveIndex]
      let moves: ReadonlyArray<TransferCheckMove> = [move]
      if (move.kind === 'arc' && move.coordinateFrame === 'work'
        && move.workCoordinateSystem && move.plane && move.sourceArc) {
        const frame = move.workCoordinateSystem
        const geometryAxes = move.addressedAxes
        const frameChanged = geometryAxes.some((key) => {
          const previous = lastAddressedFrame.get(key)
          return previous !== undefined && previous !== frame
        })
        if (frameChanged) {
          const from = { ...move.sourceArc.from }
          const to = { ...move.sourceArc.to }
          let resolvable = true
          // WO-2219: in a rotated frame the tool's work X/Y come from BOTH
          // machine axes, turned back about the work origin.
          const frameOffset = offsetTable.byWcs[frame]
          const degrees = rotationDegOf(frameOffset)
          const machineX = machinePosition.get('x')
          const machineY = machinePosition.get('y')
          const turnedFrom = degrees !== 0 && finite(machineX) && finite(machineY)
            && finite(frameOffset?.x) && finite(frameOffset?.y)
            ? turnWorkPoint({ x: machineX - frameOffset.x, y: machineY - frameOffset.y }, -degrees)
            : null
          for (const key of geometryAxes) {
            const origin = offsetTable.byWcs[frame]?.[key]
            if (!finite(origin)) {
              resolvable = false
              break
            }
            const machineFrom = machinePosition.get(key) ?? move.sourceArc.from[key] + origin
            from[key] = degrees === 0 || key === 'z'
              ? machineFrom - origin
              : turnedFrom?.[key] ?? move.sourceArc.from[key]
            if (move.targetMode === 'incremental') {
              to[key] = from[key] + (move.sourceArc.to[key] - move.sourceArc.from[key])
            } else if (!move.sourceArc.targetAxes.includes(key)) {
              to[key] = from[key]
            }
          }
          if (resolvable) {
            const samples = samplePreviewArc(from, to, move.sourceArc, move.plane)
            moves = samples.slice(1).map((point, sampleIndex) => ({
              ...move,
              from: { ...samples[sampleIndex] },
              to: { ...point },
              targetMode: 'absolute',
              sourceArc: undefined,
            }))
            while (moveIndex + 1 < job.moves.length) {
              const next = job.moves[moveIndex + 1]
              if (next.line !== move.line || next.kind !== 'arc' || !next.sourceArc) break
              moveIndex++
            }
          }
        }
      }
      for (const resolvedMove of moves) processMove(resolvedMove)
    }
    // Keep accepting compact/manual jobs that carry the established G53 range
    // field without a corresponding preview move. Production jobs carry both.
    for (const { key } of AXES) {
      if (!checkableAxes.has(key)) continue
      const machineRange = job.machineCoordinateRanges?.[key]
      if (!machineRange || !finite(machineRange.min) || !finite(machineRange.max)) continue
      const id = `G53:${key}`
      const previous = ranges.get(id)
      ranges.set(id, previous
        ? {
            ...previous,
            min: Math.min(previous.min, machineRange.min),
            max: Math.max(previous.max, machineRange.max),
          }
        : { frame: 'G53', key, min: machineRange.min, max: machineRange.max })
    }
    for (const range of ranges.values()) {
      const bounds: Bounds3 = {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      }
      bounds.min[range.key] = range.min
      bounds.max[range.key] = range.max
      const fit = fitProgramToEnvelope(bounds, { [range.key]: 0 }, envelope)
      for (const finding of fit?.offending ?? []) {
        const label = finding.axis.toUpperCase()
        refusals.push(
          `${range.frame} ${label} program range ${fmt(finding.programMin)}..${fmt(finding.programMax)} mm exceeds soft limits ${fmt(finding.machineMin)}..${fmt(finding.machineMax)} mm.`,
        )
      }
    }
  } else {
    // Legacy pure callers supply one offset for a one-frame fixture. Preserve
    // their aggregate wording while runtime callers use the per-WCS path above.
    const combinedMachineBounds: Bounds3 = {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    }
    const combinedAxes: TransferWorkOffset = {}
    const bounds = jobBounds(job, rotationDegOf(singleOffset))
    for (const { key } of AXES) {
      const ranges: Array<{ min: number; max: number }> = []
      const origin = offset[key]
      if (bounds && finite(origin)) {
        ranges.push({ min: bounds.min[key] + origin, max: bounds.max[key] + origin })
      }
      const machineRange = job.machineCoordinateRanges?.[key]
      if (machineRange && finite(machineRange.min) && finite(machineRange.max)) ranges.push(machineRange)
      if (ranges.length === 0) continue
      combinedMachineBounds.min[key] = Math.min(...ranges.map((range) => range.min))
      combinedMachineBounds.max[key] = Math.max(...ranges.map((range) => range.max))
      combinedAxes[key] = 0
    }
    const fit = fitProgramToEnvelope(combinedMachineBounds, combinedAxes, envelope)
    for (const finding of fit?.offending ?? []) {
      const label = finding.axis.toUpperCase()
      refusals.push(
        `${label} program range ${fmt(finding.programMin)}..${fmt(finding.programMax)} mm exceeds soft limits ${fmt(finding.machineMin)}..${fmt(finding.machineMax)} mm.`,
      )
    }
  }

  for (const { key, label } of AXES) {
    const limit = motion.axes[key].maxVelocityMmMin
    const peak = axisFeedPeak(job, key)
    if (limit !== null && finite(peak) && peak > limit + EPS) {
      warnings.push(`${label} feed reaches ${fmt(peak)} mm/min; ${machine.name} allows ${fmt(limit)} mm/min.`)
    }
  }

  const maximumSpindleRpm = machine.maxSpindleRpm
  if (maximumSpindleRpm !== undefined && finite(job.spindleRpmMax) && job.spindleRpmMax > maximumSpindleRpm) {
    warnings.push(
      `Spindle speed reaches ${fmt(job.spindleRpmMax)} RPM; ${machine.name} allows ${fmt(maximumSpindleRpm)} RPM.`,
    )
  }
  for (const clearance of job.toolClearances ?? []) {
    if (clearance.requiredMm > clearance.availableMm) {
      warnings.push(
        `${clearance.toolName} requires ${fmt(clearance.requiredMm)} mm holder clearance; only ${fmt(clearance.availableMm)} mm is available.`,
      )
    }
  }
  return { refusals, warnings, notes }
}

/** An unknown configured envelope is a visible load qualification even when
 * another missing input (such as work zero) prevents a geometric verdict. */
export function transferCheckReadinessNote(result: TransferCheckResult): string | null {
  return result.notes.find((note) => note.startsWith(UNKNOWN_AXIS_ENVELOPE_NOTE_PREFIX)) ?? null
}

export function transferCheckSummary(
  sourceMachineName: string | null | undefined,
  targetMachineName: string,
  result: TransferCheckResult,
): string | null {
  const count = result.refusals.length + result.warnings.length
  if (count === 0) return null
  const source = sourceMachineName?.trim() || 'an unspecified machine'
  return `Job posted for ${source}; Control is running ${targetMachineName} - ${count} ${count === 1 ? 'check' : 'checks'} flagged`
}
