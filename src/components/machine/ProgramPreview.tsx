// ProgramPreview - LIVE 3D view of the loaded program (MACHINE-CONTROL Tier 1).
//
// This REPLACED the Canvas-2D XY plan view. The plan view could not show plunge
// depth, ramps, or Z clearance, and on a machine that moves in Z "where is the
// tool" is a 3D question. This mounts a real CNCViewport in the Control tab and
// drives it from the machine's live WPos.
//
// Why its OWN CNCViewport and not the app's: the app's viewport is mounted under
// the CAM workspace and is display:none while the machine workspace is up
// (App.tsx: `<Viewport suspended={workspace !== 'cam'} />`). Its scene is also
// the CAM scene - stock, model bodies, CAM toolpaths. Pushing a g-code program
// into it would be invisible here AND would pollute that scene.
//
// Why the marker moves OUTSIDE React: WPos arrives at the status-report rate;
// a re-render per sample would rebuild this subtree continuously. The rAF loop
// reads the store imperatively (getState, not a hook) and writes straight to the
// THREE objects, so motion is smooth and React never re-renders for it.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import {
  executingProgramMoveId,
  executingProgramMoveShown,
  useMachineControl,
  type StagedProgramView,
} from '../../store/machineControlStore'
import { controlMachine, useCamStore } from '../../store'
import { CNCViewport, type IntendedStockBox } from '../../lib/viewport/CNCViewport'
import {
  compareProgramContext,
  compareProgramContextPerSetup,
  computeMotionDigest,
  deriveOperationProgress,
  isMultiSetupProgramContext,
  programContextSetups,
  programIntentIdentity,
  setupAtSourceLine,
  transferCheckJobFromProgram,
  type ProgramContextComparison,
  type ProgramContextSetupSnapshot,
  type ProgramContextV1,
} from '../../lib/machine/programContext'
import { resolveDeclaredController } from '../../lib/machine/machineChoice'
import { fmtMachineLength, unitLabel } from '../../lib/ui/unitFormat'
import { useDisplayUnits } from './useDisplayUnits'
import {
  buildProgramPath,
  segmentPointsForLine,
  type ProgramPath,
} from '../../lib/machine/programPath'
import {
  deriveEnvelopeStatus,
  ENVELOPE_FIT_TOLERANCE_MM,
  fitProgramToEnvelope,
  reconcileTravels,
  type EnvelopeStatus,
  type MachineAxisRanges,
  type MachineEnvelope,
  type TravelMismatch,
  type WorkRotationForFit,
  workXYPointsForFit,
} from '../../lib/machine/machineEnvelope'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import {
  resolvedMotionCoversAddressedAxes,
  resolveMachineMotion,
} from '../../lib/machine/resolvedMachineMotion'
import {
  armEpoch,
  pausedProgramReadout,
  programLoadEpoch,
  stagedGeometryProgramPath,
  stagedProgramContext,
  standaloneMdiJob,
  subscribeArmEpoch,
  subscribeProgramLoadEpoch,
  subscribeWorkRotations,
  wcsWordInLine,
  workRotations,
} from '../../lib/machine/machineSession'
import {
  applyPreviewRotation,
  resolvePreviewRotation,
  rotatedPreviewFrameInput,
  sceneMachineBounds,
} from './previewGeometry'
import {
  persistProgramPreviewGridSelection,
  ProgramPreviewGridControl,
  readProgramPreviewGridSelection,
  resolveProgramPreviewGrid,
  type ProgramPreviewGridSelection,
} from './ProgramPreviewGridControl'
import type { WcsId } from '../../lib/machine/controller'
import { HelpLink } from '../ui/HelpLink'
import { publishProgramFit } from './ProgramFitStatusLine'
import { useUiPrefs } from '../../store/uiPrefs'

/** WO-414 batch 2: the intended-stock box's show/hide rides in the SAME
 *  persisted record every Control-tab fold uses (uiPrefs.collapsedPropsGroups,
 *  liencam-ui-prefs; WO-116/WO-382/WO-414 lineage). Default SHOWN means
 *  absence = shown, so the record stores the HIDDEN flag - named in the key. */
export const INTENDED_STOCK_HIDDEN_KEY = 'control-preview-stock-hidden'

/** WO-1358: stored inside the existing persisted UI-preferences record, beside
 * the other Control-preview choices. Absence is the long-standing fixed-table
 * default; true opts this preview into following the live cutter. */
export const TOOL_FOLLOW_PREF_KEY = 'control-preview-tool-follow'
export const TOOL_FOLLOW_RESPONSE_MS = 60

/** WO-2049: browser-local display choice, off by default. While a program is
 * streaming or held, true replaces the stacked full-program drawing with the
 * current cursor segment plus everything still ahead of it. WO-2580: the
 * cursor is the move the controller is executing (`executingProgramMoveId`). */
export const REMAINING_PATH_PREF_KEY = 'control-preview-remaining-path'

export interface ToolFollowPoint {
  x: number
  y: number
  z: number
}

/** Frame-rate-independent exponential easing for status-rate WPos samples.
 * The first known point is exact, so enabling follow never flies in from the
 * old program center. Later samples ease without overshoot or a frame-rate-
 * dependent lag. Long background-tab gaps are capped to avoid a resume snap. */
export function advanceToolFollowPoint(
  current: ToolFollowPoint | null,
  target: ToolFollowPoint,
  elapsedMs: number,
): ToolFollowPoint {
  if (!current) return { ...target }
  const boundedMs = Math.max(0, Math.min(elapsedMs, 64))
  const alpha = 1 - Math.exp(-boundedMs / TOOL_FOLLOW_RESPONSE_MS)
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    z: current.z + (target.z - current.z) * alpha,
  }
}

export function useIntendedStockVisible(): boolean {
  return useUiPrefs((s) => !s.collapsedPropsGroups[INTENDED_STOCK_HIDDEN_KEY])
}

export function toggleIntendedStockVisible(): void {
  useUiPrefs.getState().togglePropsGroup(INTENDED_STOCK_HIDDEN_KEY)
}

export function useToolFollowEnabled(): boolean {
  return useUiPrefs((s) => Boolean(s.collapsedPropsGroups[TOOL_FOLLOW_PREF_KEY]))
}

export function toggleToolFollowEnabled(): void {
  useUiPrefs.getState().togglePropsGroup(TOOL_FOLLOW_PREF_KEY)
}

export function useRemainingPathOnly(): boolean {
  return useUiPrefs((s) => Boolean(s.collapsedPropsGroups[REMAINING_PATH_PREF_KEY]))
}

export function toggleRemainingPathOnly(): void {
  useUiPrefs.getState().togglePropsGroup(REMAINING_PATH_PREF_KEY)
}

/** Keep the point immediately before the cursor so the currently executing
 * segment still has a start. A cursor on a non-motion block advances to the
 * next motion; a cursor beyond the final motion yields an empty path. */
export function remainingProgramPath(
  path: ProgramPath,
  cursor: number,
  stepOrder: readonly number[] | null = null,
): ProgramPath {
  if (cursor <= 0 || path.moves.length < 2 || path.moveLines.length !== path.moves.length) return path
  const firstRemaining = firstRemainingMoveIndex(path, cursor, stepOrder)
  if (firstRemaining >= path.moves.length) return { moves: [], moveLines: [] }
  const firstPoint = Math.max(0, firstRemaining - 1)
  return {
    moves: path.moves.slice(firstPoint),
    moveLines: path.moveLines.slice(firstPoint),
  }
}

/** WO-2048: length of already-run path kept lit behind the current move. On a
 * dense Adaptive a single move is a fraction of a millimetre, so lighting only
 * that move reads as a flicker; a short trail reads as the tool travelling. */
export const CURRENT_TRAIL_MM = 15
/** WO-2048 paced the lit trail at this display rate. WO-2580 removed the
 * pacing: a trail held back up to 100 ms named the move before the one the
 * listing highlights. Kept as a number only for WO-2048's tests. */
export const CURRENT_TRAIL_UPDATE_MS = 100
/** WO-2048: arcs are sampled at no fewer than 8 chords, so 15 mm of tiny
 * Adaptive arcs can be hundreds of points; a trail that long measurably cost
 * running frame rate. The trail stops at whichever limit it reaches first. */
export const CURRENT_TRAIL_MAX_POINTS = 48

/** The current line's points plus up to `trailMm` (and at most
 * `CURRENT_TRAIL_MAX_POINTS` points) of path run before it, as one polyline. Null when the line produced no geometry, so a caller clears
 * the highlight instead of pointing it at the wrong move. WO-2580: the
 * program's first move has no drawn point before it; given `fromTool`, it is
 * drawn from where the tool is - the start of the move it is running. */
export function currentMoveTrailPoints(
  path: ProgramPath,
  line: number,
  trailMm = CURRENT_TRAIL_MM,
  fromTool: ToolFollowPoint | null = null,
): Array<{ x: number; y: number; z: number }> | null {
  if (fromTool && line > 0 && path.moveLines[0] === line) {
    const points = [{ x: fromTool.x, y: fromTool.y, z: fromTool.z }]
    for (let i = 0; i < path.moves.length && path.moveLines[i] === line; i++) {
      const { x, y, z } = path.moves[i]
      points.push({ x, y, z })
    }
    return points
  }
  const current = segmentPointsForLine(path, line)
  if (!current) return null
  // segmentPointsForLine starts one point before the line's first move.
  let from = path.moveLines.indexOf(line) - 1
  let travelled = 0
  const before: Array<{ x: number; y: number; z: number }> = []
  while (from > 0 && travelled < trailMm && before.length < CURRENT_TRAIL_MAX_POINTS) {
    const a = path.moves[from - 1]
    const b = path.moves[from]
    travelled += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    before.push({ x: a.x, y: a.y, z: a.z })
    from--
  }
  return before.reverse().concat(current)
}

/** WO-2048: index of the first move not yet done at `cursor` - the current
 * line's first move. Moves before it are drawn dimmed. A cursor before the
 * program has nothing done; one past the final motion has everything done.
 * WO-2580: a staged step id is found by identity first - ids are not
 * guaranteed to rise through a program - and only a cursor with no geometry of
 * its own (a text door's M5) falls back to the next motion after it. A staged
 * step with no geometry (a G4 dwell, whose id is numbered above every motion)
 * is placed by `stepOrder`, the staged steps' ids in the order they run: the
 * next motion after it in that order is the first not done. */
export function firstRemainingMoveIndex(
  path: ProgramPath,
  cursor: number,
  stepOrder: readonly number[] | null = null,
): number {
  if (cursor <= 0 || path.moveLines.length !== path.moves.length) return 0
  const exact = path.moveLines.indexOf(cursor)
  if (exact >= 0) return exact
  const at = stepOrder ? stepOrder.indexOf(cursor) : -1
  if (stepOrder && at >= 0) {
    for (let next = at + 1; next < stepOrder.length; next++) {
      const index = path.moveLines.indexOf(stepOrder[next])
      if (index >= 0) return index
    }
    return path.moves.length
  }
  const firstRemaining = path.moveLines.findIndex((line) => line >= cursor)
  return firstRemaining < 0 ? path.moves.length : firstRemaining
}

/** WO-2580: the path of the program the LISTING shows, in the listing's own
 * step ids. The armed controller queue is not always that program - the way
 * back to a kept stop, an MDI line in a pause and a later program part are
 * armed queues of their own, with ids of their own - and drawing one of those
 * put the current move several moves away from the highlighted row. The armed
 * path is used as it is when it IS the listing's program (it alone knows the
 * start position a first move with omitted axes fills from); otherwise the
 * path is read off the listing's steps, the same way. */
export function stagedListingProgramPath(view: StagedProgramView, armed: ProgramPath | null): ProgramPath {
  const steps = view.program.steps.filter((step) => step.kind === 'line' || step.kind === 'arc')
  const byId = new Map(steps.map((step) => [step.id, step] as const))
  const sameAxis = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) <= 1e-9
  const armedIsListing = armed !== null
    && armed.moves.length > 0
    && armed.moveLines.length === armed.moves.length
    && armed.moveLines[0] === steps[0]?.id
    && armed.moveLines.at(-1) === steps.at(-1)?.id
    && armed.moveLines.every((id, i) => {
      const step = byId.get(id)
      if (!step || (step.kind !== 'line' && step.kind !== 'arc')) return false
      const point = armed.moves[i]
      return sameAxis(step.to.x, point.x) && sameAxis(step.to.y, point.y) && sameAxis(step.to.z, point.z)
    })
  if (armedIsListing) return { moves: armed.moves, moveLines: armed.moveLines }
  const moves: ProgramPath['moves'] = []
  const moveLines: number[] = []
  let modal: { x?: number; y?: number; z?: number } = {}
  for (const step of steps) {
    if (step.kind === 'line') {
      const x = step.to.x ?? modal.x
      const y = step.to.y ?? modal.y
      const z = step.to.z ?? modal.z
      modal = { x, y, z }
      if (x === undefined || y === undefined || z === undefined) continue
      moves.push({
        type: step.rapid ? 'rapid' : 'feed',
        role: step.rapid ? 'rapid' : 'cut',
        x,
        y,
        z,
        ...(step.rapid ? {} : { feed: step.feedMmMin }),
      })
      moveLines.push(step.id)
    } else if (step.kind === 'arc') {
      modal = { x: step.to.x, y: step.to.y, z: step.to.z }
      moves.push({
        type: step.clockwise ? 'arc_cw' : 'arc_ccw',
        role: 'cut',
        x: step.to.x,
        y: step.to.y,
        z: step.to.z,
        cx: step.centre.x,
        cy: step.centre.y,
        feed: step.feedMmMin,
      })
      moveLines.push(step.id)
    }
  }
  return { moves, moveLines }
}

type CameraView = 'top' | 'front' | 'right' | 'iso'

const VIEW_BUTTONS: ReadonlyArray<{ view: CameraView; label: string; short: string }> = [
  { view: 'top', label: 'Top view', short: 'TOP' },
  { view: 'front', label: 'Front view', short: 'FRT' },
  { view: 'right', label: 'Right view', short: 'RGT' },
  { view: 'iso', label: 'Isometric view', short: 'ISO' },
]

function machineFitBounds(envelope: MachineEnvelope) {
  if (!envelope.x || !envelope.y) return null
  return {
    min: { x: envelope.x.min, y: envelope.y.min, z: envelope.z?.min ?? 0 },
    max: { x: envelope.x.max, y: envelope.y.max, z: envelope.z?.max ?? 0 },
  }
}

/** WO-380: what the intended-stock readout says about the loaded program.
 *  'comparison-failed' is WO-398's own state (the library threw): shown as its
 *  own label and tinted stale - never dressed up as 'project-changed'. */
export type IntendedStockState = ProgramContextComparison | 'comparison-failed'

/**
 * WO-380: the intended stock block in PROGRAM (work) coordinates - the frame
 * the parsed toolpath is drawn in - derived ONLY from the frozen snapshot, so
 * a live project edit can never move it (it is what the program was posted
 * against; only reloading from the setup replaces it).
 *
 *   'world' space (a physical stock): the world AABB follows the store's own
 *   rule (stockAssignment.stockWorldBounds) - an 'explicit' stock is its
 *   position (min corner) + bounds SIZE, a 'derived' stock's bounds are already
 *   world-space - then work = world - wcs.origin (the post's toWork with the
 *   identity basis V1 requires).
 *   'setup-wcs' space (an authored stock with no physical twin): the authored
 *   bounds are already relative to the setup WCS; used as they are.
 *
 * Returns null for a degenerate (zero-volume) block.
 */
export function intendedStockWorkBox(
  context: Pick<ProgramContextV1, 'stock' | 'wcs'> | null,
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  if (!context) return null
  const { stock, wcs } = context
  let min: { x: number; y: number; z: number }
  let max: { x: number; y: number; z: number }
  if (stock.coordinateSpace === 'world') {
    if (stock.mode === 'explicit') {
      const size = {
        x: stock.bounds.max.x - stock.bounds.min.x,
        y: stock.bounds.max.y - stock.bounds.min.y,
        z: stock.bounds.max.z - stock.bounds.min.z,
      }
      min = { x: stock.position.x, y: stock.position.y, z: stock.position.z }
      max = { x: min.x + size.x, y: min.y + size.y, z: min.z + size.z }
    } else {
      min = { ...stock.bounds.min }
      max = { ...stock.bounds.max }
    }
    min = { x: min.x - wcs.origin.x, y: min.y - wcs.origin.y, z: min.z - wcs.origin.z }
    max = { x: max.x - wcs.origin.x, y: max.y - wcs.origin.y, z: max.z - wcs.origin.z }
  } else {
    min = { x: stock.bounds.min.x + stock.position.x, y: stock.bounds.min.y + stock.position.y, z: stock.bounds.min.z + stock.position.z }
    max = { x: stock.bounds.max.x + stock.position.x, y: stock.bounds.max.y + stock.position.y, z: stock.bounds.max.z + stock.position.z }
  }
  if (!(max.x > min.x) || !(max.y > min.y) || !(max.z > min.z)) return null
  return { min, max }
}

export function ProgramPreview() {
  const programText = useMachineControl((s) => s.programText)
  const storeProgramContext = useMachineControl((s) => s.programContext)
  const stagedProgram = useMachineControl((s) => s.stagedProgram)
  const jobName = useMachineControl((s) => s.job.name)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const ackedSourceLine = useMachineControl((s) => s.job.ackedSourceLine)
  // WO-2580: the move the controller is executing (executingProgramMoveId) -
  // not the line it acknowledged, which runs ahead of it while lines buffer.
  const pausedProgram = useSyncExternalStore(useMachineControl.subscribe, pausedProgramReadout, () => null)
  const cursorMove = useMachineControl((s) => {
    if (!executingProgramMoveShown(s.job.phase, pausedProgram)) return null
    const move = executingProgramMoveId(s, pausedProgram)
    return move !== null && move > 0 ? move : null
  })
  const armedFromLine = useMachineControl((s) => s.armedFromLine)
  const project = useCamStore((s) => s.project)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const units = useDisplayUnits()
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const offsets = useMachineControl((s) => s.offsets)
  const settings = useMachineControl((s) => s.settings)
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const homed = useMachineControl((s) => s.homed)
  const machine = useCamStore(controlMachine)
  const configuredTravel = machine?.travel
  const [gridSelection, setGridSelection] = useState<ProgramPreviewGridSelection>(
    readProgramPreviewGridSelection,
  )
  // WO-414 batch 2: the intended-stock box in the 3D scene can be hidden
  // (persisted); the line in the corner still says what it is.
  const stockVisible = useIntendedStockVisible()
  const toolFollowEnabled = useToolFollowEnabled()
  const remainingPathOnly = useRemainingPathOnly()

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const vpRef = useRef<CNCViewport | null>(null)
  const pathRef = useRef<ProgramPath>({ moves: [], moveLines: [] })
  // Last values pushed into THREE, so the frame loop only touches the scene on
  // a real change.
  const lastPosRef = useRef<string>('')
  const lastMoveRef = useRef<string>('')
  const cursorMoveRef = useRef<number | null>(cursorMove)
  cursorMoveRef.current = cursorMove
  const followEnabledRef = useRef(toolFollowEnabled)
  const followPointRef = useRef<ToolFollowPoint | null>(null)
  const followFrameTimeRef = useRef<number | null>(null)
  const followAppliedRef = useRef(false)
  const staticPathClearedRef = useRef(false)
  followEnabledRef.current = toolFollowEnabled
  // WO-2675 (Operator 10-07 at the machine: "I had zoomed it out and then it
  // zoomed back in very close"; 10-08: "keep your zoom on MDI moves and
  // offset/WCS changes; re-fit only on Load of a new program"). Until the
  // operator zooms, pans, turns or picks a view, every change frames the
  // program as it always has. After that the view is his: only his Load (the
  // same file too) re-fits it, and that Load hands framing back. Nothing that
  // stages the program again on its own is a Load (see programLoadEpoch).
  const operatorViewRef = useRef(false)
  const loadEpoch = useSyncExternalStore(subscribeProgramLoadEpoch, programLoadEpoch, programLoadEpoch)
  const framedLoadRef = useRef(loadEpoch)
  const loadEpochRef = useRef(loadEpoch)
  loadEpochRef.current = loadEpoch

  // Geometry programs have no text by design. The arm epoch is the session's
  // existing notification that a different controller queue became current;
  // on that route render the exact staged moves instead of an empty text parse.
  const epoch = useSyncExternalStore(subscribeArmEpoch, armEpoch, armEpoch)
  // WO-2580: a published listing is the program drawn - see
  // stagedListingProgramPath. Without one the armed queue is all there is. A
  // listing is redrawn only when a different listing is published; an arm of
  // the way back or an MDI line changes neither it nor its ids.
  const armedPathEpoch = stagedProgram ? null : epoch
  const path = useMemo(
    () => programText
      ? buildProgramPath(programText)
      : stagedProgram
        ? stagedListingProgramPath(stagedProgram, stagedGeometryProgramPath())
        : stagedGeometryProgramPath() ?? buildProgramPath(null),
    [programText, stagedProgram, armedPathEpoch],
  )
  // WO-2047: a program staged through the program door (a controller that
  // runs staged programs, Operator's LienCNC) has no text in the store, so its
  // LienCAM context rides with the staged listing instead. The intended-stock
  // readout reads whichever door took the program; a text-door program's
  // context is the store's own, unchanged.
  const staged = useMemo(
    () => (programText === null && stagedProgram ? stagedProgramContext() : null),
    // Every program-door load publishes a new listing object, so the listing's
    // identity is the "a different program is staged" signal.
    [programText, stagedProgram],
  )
  const programContext: ProgramContextV1 | null = storeProgramContext ?? staged?.context ?? null
  /** The text the context was verified on: the loaded text on the text door,
   *  the posted text the staged program was read from on the program door. */
  const contextText = storeProgramContext ? programText : staged?.text ?? null
  /** The context's source line for the controller's cursor. The program door's
   *  cursor is a staged step id, mapped back to its file line. */
  const contextAckedLine = storeProgramContext || !staged ? ackedSourceLine : staged.lineOfStep(ackedSourceLine) ?? 0

  const motion = useMemo(
    () => resolveMachineMotion({
      machine,
      // A connected legacy/restored state predating connectionKind is a GRBL
      // session because its only live motion authority is the numeric dump.
      connectionKind: connectionPhase === 'connected' && connectionKind === null
        ? 'serial'
        : connectionKind,
      settings,
      datumKnown: homed,
    }),
    [connectionKind, connectionPhase, homed, machine, settings],
  )
  const programAxesCovered = useMemo(
    () => !programText || resolvedMotionCoversAddressedAxes(
      motion,
      transferCheckJobFromProgram(programText).addressedAxes,
    ),
    [motion, programText],
  )
  const envelope = motion.envelope
  const envelopeStatus = useMemo(
    () =>
      deriveEnvelopeStatus({
        connected: connectionPhase === 'connected',
        // The UCCNC bridge deliberately has no GRBL-style settings dump. Its
        // pinned, stated controller definition is the live range authority,
        // so a resolved XY envelope is the equivalent availability witness.
        settingsKnown: connectionKind === 'bridge'
          ? Boolean(motion.envelope.x && motion.envelope.y)
          : Object.keys(settings).length > 0,
        homed,
      }),
    [connectionKind, connectionPhase, homed, motion.envelope, settings],
  )
  const travelMismatches = useMemo(
    () => reconcileTravels(motion.reportedEnvelope, configuredTravel),
    [configuredTravel, motion.reportedEnvelope],
  )
  const usingConfiguredEnvelope = connectionPhase !== 'connected' || connectionKind === 'simulator'
  const gridEnvelope = envelope
  const gridEnvelopeStatus: EnvelopeStatus = usingConfiguredEnvelope ? 'homed' : envelopeStatus
  // WO-308: the grid draws the SAME envelope, not a second read of $130/$131 -
  // two derivations of the same fact can disagree; one cannot.
  const gridResolution = useMemo(
    () => resolveProgramPreviewGrid(gridSelection, activeWcs, offsets, gridEnvelope, gridEnvelopeStatus),
    [gridSelection, activeWcs, offsets, gridEnvelope, gridEnvelopeStatus],
  )
  // WO-2217: the controller's reported work rotations decide how the preview is
  // DRAWN - the program turned where the machine runs it, the view framed by
  // the chosen grid. Display only: the program and file are never rotated.
  const rotations = useSyncExternalStore(subscribeWorkRotations, workRotations, workRotations)
  const previewRotation = useMemo(
    () => resolvePreviewRotation({
      gridSelection,
      gridAvailable: gridResolution.available,
      gridOriginMachine: gridResolution.gridOriginMachine,
      activeWcs,
      rotations,
    }),
    [gridSelection, gridResolution, activeWcs, rotations],
  )
  const machineBounds = useMemo(
    () => sceneMachineBounds(machineFitBounds(gridEnvelope), previewRotation),
    [gridEnvelope, previewRotation],
  )
  pathRef.current = path
  // WO-2580: the staged steps' ids in run order - the only way to place a
  // cursor on a step with no geometry of its own (see firstRemainingMoveIndex).
  const stepOrder = useMemo(
    () => (programText || !stagedProgram ? null : stagedProgram.program.steps.map((step) => step.id)),
    [programText, stagedProgram],
  )
  const stepOrderRef = useRef(stepOrder)
  stepOrderRef.current = stepOrder

  // WO-377: where the loaded program lands on the declared table AFTER the
  // active work offset - the signed result the grid draws but never said.
  // Compared against the SAME envelope the grid uses (gridEnvelope), never a
  // second derivation; silent when there is no program, no offset, or a
  // commanded axis has no effective envelope in the resolved motion model.
  //
  // WO-1630 audit follow-up: `programBounds` and `machineAxisRanges` are
  // derived TOGETHER from the same route, and `programBounds` is NEVER
  // `boundsOfPoints(path.moves)` - `path.moves` (used only for the drawn 3D
  // path) keeps a machineAbsolute (G53) line's baked WORK-coordinate value for
  // path fidelity, and folding that stale bake into the work-coordinate bounds
  // is exactly what produced the false "Z: program 171.4..171.4" reading
  // (128 baked against G54 66.57 -> 61.43, re-shifted by the edited offset
  // 110 -> 171.43). The text route already excludes G53 lines from its
  // `workBounds` (`buildPreviewModel`); the staged-geometry route now reports
  // the same exclusion itself (`stagedGeometryProgramPath().workBounds`).
  const previewModel = useMemo(
    () => (programText ? buildPreviewModel(programText) : null),
    [programText],
  )
  const stagedPath = useMemo(
    () => (programText ? null : stagedGeometryProgramPath()),
    [programText, epoch],
  )
  const programBounds = previewModel ? previewModel.workBounds : stagedPath?.workBounds ?? null
  const machineAxisRanges: MachineAxisRanges = previewModel
    ? previewModel.machineCoordinateRanges
    : stagedPath?.machineAxisRanges ?? {}
  // WO-1999: the fit is measured against the offset the PROGRAM selects (its
  // own first G54..G59 word), not whichever offset happens to be active - a
  // G58 program is not judged against G54. A program with no G5x word runs in
  // the active offset. And it is silent until that offset holds a work zero:
  // an all-zero (or unreported) row means "not set yet", and judging the
  // program against machine zero would raise a false PARTLY OUTSIDE at connect.
  const fitWcs = useMemo<WcsId | null>(() => {
    if (programText) {
      for (const line of programText.split(/\r?\n/)) {
        const word = wcsWordInLine(line)
        if (word) return word
      }
    }
    return activeWcs
  }, [programText, activeWcs])
  const fitOrigin = useMemo(() => {
    const row = fitWcs ? offsets[fitWcs] : undefined
    if (!row || row.length < 3 || !row.slice(0, 3).every(Number.isFinite)) return null
    if (row[0] === 0 && row[1] === 0 && row[2] === 0) return null
    return { x: row[0], y: row[1], z: row[2] }
  }, [fitWcs, offsets])
  // WO-2219: in a rotated offset the controller runs the program turned about
  // that offset's origin, by the rotation it REPORTS (`rotations`, above) - so
  // the fit measures it there, from the program's own XY points. No rotation,
  // no argument: the verdict is computed exactly as before.
  const fitRotation = useMemo<WorkRotationForFit | null>(() => {
    const degrees = fitWcs ? rotations[fitWcs] ?? 0 : 0
    if (degrees === 0) return null
    if (previewModel) return { degrees, workPoints: workXYPointsForFit(previewModel.moves) }
    return { degrees, workPoints: stagedPath?.workXYPoints ?? null, workArcs: stagedPath?.workArcs ?? null }
  }, [fitWcs, rotations, previewModel, stagedPath])
  const programFit = useMemo(
    () => (!programAxesCovered || gridEnvelopeStatus === 'unknown' || gridEnvelopeStatus === 'no-datum' || !fitOrigin
      ? null
      : fitProgramToEnvelope(
          programBounds,
          fitOrigin,
          gridEnvelope,
          ENVELOPE_FIT_TOLERANCE_MM,
          machineAxisRanges,
          fitRotation,
        )),
    [programAxesCovered, programBounds, fitOrigin, gridEnvelope, gridEnvelopeStatus, machineAxisRanges, fitRotation],
  )

  // WO-414 batch 2: the Table card is gone; the verdict is published to
  // ProgramFitStatusLine, which (WO-414, Operator on Chat: "use console for
  // messages") writes it to the console only - never re-derived there.
  useEffect(() => {
    publishProgramFit(programFit ? { fit: programFit, wcs: fitWcs } : null)
  }, [programFit, fitWcs])
  useEffect(() => () => publishProgramFit(null), [])

  // WO-380: the loaded program's snapshot against the LIVE project - the same
  // comparison ProgramPanel's chip runs, keyed the same way (WO-396: on what the
  // intent digest READS, not on the project object, so a tree click costs
  // nothing). It only ever changes the LABEL and the tint; the block itself is
  // read from the frozen snapshot and never follows a live edit.
  const loadedMotionDigest = useMemo(
    () => (programContext ? computeMotionDigest(contextText ?? '') : null),
    [programContext, contextText],
  )
  const intentIdentity = programIntentIdentity(project, toolLibrary)
  const intentProject = useMemo(
    () => ({ ...project, toolLibrary }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the digest reads, not on the project object (WO-396)
    [intentIdentity[0], intentIdentity[1], intentIdentity[2], intentIdentity[3], intentIdentity[4], intentIdentity[5], intentIdentity[6], intentIdentity[7], intentIdentity[8]],
  )
  // WO-1404: the post config used for this comparison must be the project's
  // ACTUAL declared post, the same resolution ProgramPanel's header chip uses
  // (resolveDeclaredController) - not a hard-coded dialect. Post configuration
  // is part of the hashed program intent, so comparing against the wrong
  // dialect can never agree with a header comparison run against the right one.
  const controllerResolution = useMemo(
    () => resolveDeclaredController(project.machine),
    [project.machine],
  )
  const postConfigForProject = controllerResolution.ok ? controllerResolution.dialect : null
  // WO-412: the card follows the ACTIVE setup of a multi-setup program - the
  // setup the acknowledged line is in (or about to enter), the lead setup while
  // nothing is armed - and shows THAT setup's verdict, so one stale setup does
  // not hide the others. A one-setup context has exactly one setup: unchanged.
  const activeSetup = useMemo<ProgramContextSetupSnapshot | null>(() => {
    if (!programContext) return null
    if (!isMultiSetupProgramContext(programContext)) return programContextSetups(programContext)[0]
    const progress = deriveOperationProgress(programContext, contextText, { phase: jobPhase, ackedSourceLine: contextAckedLine, armedFromLine })
    return progress?.activeSetup ?? setupAtSourceLine(programContext, contextAckedLine) ?? programContext.setups[0]
  }, [programContext, contextText, jobPhase, contextAckedLine, armedFromLine])
  const intendedStockState = useMemo<IntendedStockState>(() => {
    if (!programContext || !activeSetup) return 'no-context'
    if (!postConfigForProject) return 'comparison-failed'
    try {
      const perSetup = compareProgramContextPerSetup(programContext, intentProject, contextText, postConfigForProject, loadedMotionDigest ?? undefined)
      return perSetup.find((v) => v.setup.id === activeSetup.setup.id)?.verdict
        ?? compareProgramContext(programContext, intentProject, contextText, postConfigForProject, loadedMotionDigest ?? undefined)
    } catch (err) {
      console.error('[program-context] comparison failed:', err)
      return 'comparison-failed'
    }
  }, [programContext, activeSetup, intentProject, contextText, loadedMotionDigest, postConfigForProject])
  const intendedStockBox = useMemo(() => intendedStockWorkBox(activeSetup), [activeSetup])
  const intendedStockStale = intendedStockState !== 'current' && intendedStockState !== 'no-context'
  // Last block pushed into THREE: the scene is touched only on a real change
  // (and never at all while no setup was ever loaded).
  const lastIntendedRef = useRef<string>('')

  // Mount the viewport once. jsdom and any WebGL-less environment fall through
  // silently, exactly as the 2D canvas version did.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let vp: CNCViewport
    try {
      vp = new CNCViewport(el)
    } catch {
      return
    }
    vpRef.current = vp
    // A program preview is the PATH plus the tool, not the CAM scene furniture.
    vp.setStockVisible(false)
    vp.setWorkpieceVisible(false)
    vp.setMachineVisible(false)
    vp.showToolMarker(true)
    return () => {
      vpRef.current = null
      lastPosRef.current = ''
      lastMoveRef.current = ''
      lastIntendedRef.current = ''
      followPointRef.current = null
      followFrameTimeRef.current = null
      followAppliedRef.current = false
      try {
        vp.dispose()
      } catch {
        /* a already-lost GL context is not worth failing the unmount over */
      }
    }
  }, [])

  // WO-2675: the operator's own zoom (wheel, pinch) or drag (pan, orbit) on the
  // canvas makes the view his. A click that does not move is not a view change.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onCanvas = (e: Event) => e.target instanceof HTMLCanvasElement
    const pressed = new Map<number, { x: number; y: number }>()
    const onWheel = (e: WheelEvent) => {
      if (onCanvas(e)) operatorViewRef.current = true
    }
    const onDown = (e: PointerEvent) => {
      if (onCanvas(e)) pressed.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const onMove = (e: PointerEvent) => {
      const start = pressed.get(e.pointerId)
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) operatorViewRef.current = true
    }
    const onUp = (e: PointerEvent) => {
      pressed.delete(e.pointerId)
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: true })
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointermove', onMove, true)
    el.addEventListener('pointerup', onUp, true)
    el.addEventListener('pointercancel', onUp, true)
    return () => {
      el.removeEventListener('wheel', onWheel, true)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointermove', onMove, true)
      el.removeEventListener('pointerup', onUp, true)
      el.removeEventListener('pointercancel', onUp, true)
    }
  }, [])

  // Program changed -> rebuild the 3D path and frame it.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    // A new program has no done moves; clear first so the rebuild does not
    // dim it at the old program's boundary.
    if (typeof vp.setToolpathDoneBoundary === 'function') vp.setToolpathDoneBoundary(null)
    vp.renderToolpath(path.moves, true)
    staticPathClearedRef.current = false
    vp.setActiveToolpathSegment(null)
    lastMoveRef.current = ''
    // WO-2675: his Load takes the view back; the program staged again on its
    // own (after an MDI line, at CYCLE START, Re-arm) does not.
    if (framedLoadRef.current !== loadEpochRef.current) {
      framedLoadRef.current = loadEpochRef.current
      operatorViewRef.current = false
    }
    // Frame the PROGRAM, not the scene: fitAll() includes the grid and machine
    // envelope, which shrinks a typical part to a speck at the origin.
    if (path.moves.length > 1 && !operatorViewRef.current) vp.fitToolpath()
    if (followAppliedRef.current) {
      vp.setOrbitFocus(null)
      followPointRef.current = null
      followFrameTimeRef.current = null
      followAppliedRef.current = false
      lastPosRef.current = ''
    }
  }, [path])

  // WO-2675: a Load that lands after its program was drawn (a setup's, staged
  // before its Load answers) or draws the very path already shown frames it
  // here. A Load the [path] effect above already framed has nothing left to do.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp || framedLoadRef.current === loadEpoch) return
    framedLoadRef.current = loadEpoch
    operatorViewRef.current = false
    if (path.moves.length > 1) vp.fitToolpath()
    if (followAppliedRef.current) {
      vp.setOrbitFocus(null)
      followPointRef.current = null
      followFrameTimeRef.current = null
      followAppliedRef.current = false
      lastPosRef.current = ''
    }
  }, [loadEpoch, path.moves.length])

  // WO-2049: use the viewport's disposable preview layer for the changing
  // remainder. It hides the full static path without destroying it, disposes
  // each replaced geometry, and keeps fit-to-program based on the full job.
  // Older test doubles predate that public viewport method, so the capability
  // check leaves those unrelated seams on their established full-path view.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp || typeof vp.setSimulationToolpathPreview !== 'function') return
    const running = cursorMove !== null && (jobPhase === 'streaming' || jobPhase === 'paused' || pausedProgram !== null)
    if (!remainingPathOnly || !running) {
      vp.setSimulationToolpathPreview(null)
      if (staticPathClearedRef.current) {
        vp.renderToolpath(path.moves, true)
        staticPathClearedRef.current = false
      }
      return
    }

    const remaining = remainingProgramPath(path, cursorMove, stepOrder)
    if (remaining.moves.length >= 2) {
      if (staticPathClearedRef.current) {
        vp.renderToolpath(path.moves, true)
        staticPathClearedRef.current = false
      }
      vp.setSimulationToolpathPreview(remaining.moves)
      return
    }

    // setSimulationToolpathPreview(null) reveals its static path. At the end
    // of the job there is no remainder to overlay, so clear that static path
    // too; toggling off or leaving the running/paused phases restores it above.
    vp.setSimulationToolpathPreview(null)
    vp.renderToolpath([], true)
    staticPathClearedRef.current = true
  }, [cursorMove, jobPhase, path, pausedProgram, remainingPathOnly, stepOrder])

  // Keep every program-owned object in one canonical machine frame. The
  // viewport translates its shared program group from the active WCS offset;
  // the selected grid merely chooses which controller frame is drawn over it.
  // WO-2217: under a reported rotation the program group also turns (about the
  // program's work origin) and a rotated grid's view turns the machine-fixed
  // table under it; unrotated, the call is exactly what it always was.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    const frameInput = rotatedPreviewFrameInput({
      programOriginMachine: gridResolution.programOriginMachine,
      grid: gridResolution.available && gridResolution.gridOriginMachine && gridResolution.travel
        ? {
            travel: gridResolution.travel,
            originMachine: gridResolution.gridOriginMachine,
            extentMachine: gridResolution.extentMachine,
          }
        : null,
    }, previewRotation)
    vp.setMachinePreviewCoordinateFrame(frameInput)
    applyPreviewRotation(
      vp,
      previewRotation,
      gridResolution.extentMachine,
      frameInput.grid?.extentMachine ?? null,
    )
    // WO-2675: a work offset or WCS write (same values too - applyOffset makes
    // a new offsets object) moves the program here; the operator's view stays.
    if (path.moves.length > 1 && !operatorViewRef.current) vp.fitToolpath()
    if (followAppliedRef.current) {
      vp.setOrbitFocus(null)
      followPointRef.current = null
      followFrameTimeRef.current = null
      followAppliedRef.current = false
      lastPosRef.current = ''
    }
  }, [gridResolution, path.moves.length, previewRotation])

  // WO-380: the intended stock block follows the snapshot (placement) and the
  // comparison (tint) - nothing else. Under an armed/running program a live
  // project edit can flip the tint to stale; it cannot move or resize the block.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    // WO-414 batch 2: the show/hide toggle on the corner line gates the box.
    const next: IntendedStockBox | null = intendedStockBox && stockVisible
      ? { min: intendedStockBox.min, max: intendedStockBox.max, stale: intendedStockStale }
      : null
    const key = next ? JSON.stringify(next) : ''
    if (key === lastIntendedRef.current) return
    lastIntendedRef.current = key
    vp.setIntendedStock(next)
  }, [intendedStockBox, intendedStockStale, stockVisible])

  // Live motion, outside React: read the store imperatively and write the THREE
  // objects directly. No setState, no re-render, no coupling to render rate.
  useEffect(() => {
    let raf = 0
    const tick = (frameTime: number) => {
      const vp = vpRef.current
      if (vp) {
        const s = useMachineControl.getState()
        const connected = s.connectionPhase === 'connected'

        if (connected && s.wpos) {
          const key = `${s.wpos.x},${s.wpos.y},${s.wpos.z}`
          if (followEnabledRef.current) {
            const previousFrameTime = followFrameTimeRef.current
            const point = advanceToolFollowPoint(
              followPointRef.current,
              s.wpos,
              previousFrameTime === null ? 0 : frameTime - previousFrameTime,
            )
            followPointRef.current = point
            followFrameTimeRef.current = frameTime
            followAppliedRef.current = true
            lastPosRef.current = key
            // Move the visible cutter and orbit focus together. The marker is
            // therefore pinned at the chosen screen position while the program
            // slides smoothly underneath instead of jumping at status rate.
            vp.setToolMarkerPosition(point.x, point.y, point.z)
            vp.showToolMarker(true)
            vp.setOrbitFocus(point)
          } else {
            if (followAppliedRef.current) {
              // Ending follow is intentionally not a reframe. The viewport
              // drops its delta cursor and leaves this exact camera pose alone.
              vp.setOrbitFocus(null)
              followPointRef.current = null
              followFrameTimeRef.current = null
              followAppliedRef.current = false
              lastPosRef.current = ''
            }
            if (key !== lastPosRef.current) {
              lastPosRef.current = key
              vp.setToolMarkerPosition(s.wpos.x, s.wpos.y, s.wpos.z)
              vp.showToolMarker(true)
            }
          }
        } else if (followAppliedRef.current) {
          // A lost/unknown WPos supplies no new focus authority. Keep the last
          // camera pose, but make the next valid point a fresh recenter.
          vp.setOrbitFocus(null)
          followPointRef.current = null
          followFrameTimeRef.current = null
          followAppliedRef.current = false
          lastPosRef.current = ''
        }

        // WO-2580: the move drawn as current, and the moves dimmed as done
        // before it, are the move the controller is executing - on the frame
        // its report says so, never paced behind it (a WO-2048 100 ms pacing
        // put the trail a move behind the controller). The phase is part of
        // the key so a hold or the end redraws at once.
        const cursor = cursorMoveRef.current
        const path = pathRef.current
        // The first move starts where the tool is: no drawn point precedes it.
        const fromTool = cursor !== null && path.moveLines[0] === cursor && connected && s.wpos ? s.wpos : null
        const moveKey = cursor === null
          ? ''
          : `${s.job.phase}:${cursor}${fromTool ? `@${fromTool.x},${fromTool.y},${fromTool.z}` : ''}`
        if (moveKey !== lastMoveRef.current) {
          lastMoveRef.current = moveKey
          vp.setActiveToolpathSegment(
            cursor === null ? null : currentMoveTrailPoints(path, cursor, CURRENT_TRAIL_MM, fromTool),
          )
          if (typeof vp.setToolpathDoneBoundary === 'function') {
            vp.setToolpathDoneBoundary(cursor === null ? null : firstRemainingMoveIndex(path, cursor, stepOrderRef.current))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    // data-viewport-host: THREE appends this host's canvas at runtime, so the
    // overlay census cannot see an authored <canvas> to infer it from.
    <div
      className="control-preview-wrap"
      ref={wrapRef}
      data-testid="control-preview"
      data-viewport-host=""
    >
      <ProgramPreviewGridControl
        value={gridSelection}
        onChange={(selection) => {
          setGridSelection(selection)
          persistProgramPreviewGridSelection(selection)
        }}
        resolution={gridResolution}
      />
      <div className="control-preview-view-rail" aria-label="Viewport views">
        {VIEW_BUTTONS.map(({ view, label, short }) => (
          <button
            key={view}
            type="button"
            className="control-preview-view-button"
            aria-label={label}
            title={label}
            onClick={() => {
              operatorViewRef.current = true
              vpRef.current?.setCameraView(view)
            }}
          >
            {short}
          </button>
        ))}
        <span className="control-preview-view-divider" aria-hidden="true" />
        <button
          type="button"
          className="control-preview-view-button"
          aria-label="Follow tool"
          aria-pressed={toolFollowEnabled}
          data-testid="program-preview-tool-follow"
          data-follow-mode={toolFollowEnabled ? 'follow' : 'fixed'}
          title={toolFollowEnabled
            ? 'Follow tool view on - the cutter stays centered'
            : 'Fixed table view on - select to follow the cutter'}
          onClick={toggleToolFollowEnabled}
        >
          {toolFollowEnabled ? 'FOL' : 'FIX'}
        </button>
        <button
          type="button"
          className="control-preview-view-button"
          aria-label="Show remaining moves only"
          aria-pressed={remainingPathOnly}
          data-testid="program-preview-remaining-path"
          data-path-view={remainingPathOnly ? 'remaining' : 'all'}
          title={remainingPathOnly
            ? 'Remaining moves only while running - select to show the full path'
            : 'Full path shown - select to hide moves behind the running cursor'}
          onClick={toggleRemainingPathOnly}
        >
          {remainingPathOnly ? 'REM' : 'ALL'}
        </button>
        <span className="control-preview-view-divider" aria-hidden="true" />
        <button
          type="button"
          className="control-preview-view-button control-preview-fit-button"
          aria-label="Fit machine extents"
          title="Fit machine extents"
          disabled={!machineBounds}
          onClick={() => {
            const vp = vpRef.current
            if (machineBounds && vp) {
              operatorViewRef.current = true
              vp.fitBoundsPreservingView(machineBounds)
              if (followEnabledRef.current) {
                vp.setOrbitFocus(null)
                followPointRef.current = null
                followFrameTimeRef.current = null
                followAppliedRef.current = false
                lastPosRef.current = ''
              }
            }
          }}
        >
          MCH
        </button>
        <button
          type="button"
          className="control-preview-view-button control-preview-fit-button"
          aria-label="Fit program extents"
          title="Fit program extents"
          disabled={path.moves.length === 0}
          onClick={() => {
            const vp = vpRef.current
            if (vp) {
              operatorViewRef.current = true
              vp.fitToolpathPreservingView()
              if (followEnabledRef.current) {
                vp.setOrbitFocus(null)
                followPointRef.current = null
                followFrameTimeRef.current = null
                followAppliedRef.current = false
                lastPosRef.current = ''
              }
            }
          }}
        >
          PGM
        </button>
      </div>
      {/* WO-414 batch 2: the Table card is gone (Operator: "remove it"). A travel
          mismatch (Machine Library vs controller) is the one thing it showed
          that lives nowhere else; it keeps one amber line, bottom-left, only
          while present. */}
      <TravelMismatchLine mismatches={travelMismatches} />
      {jobName && !standaloneMdiJob() && (
        <IntendedStockReadout
          state={intendedStockState}
          postedFromAnotherProject={programContext?.project?.id != null && programContext.project.id !== project.id}
          context={activeSetup}
          box={intendedStockBox}
          units={units}
          visible={stockVisible}
          onToggleVisible={toggleIntendedStockVisible}
        />
      )}
      {path.moves.length === 0 && (
        <div className="panel-empty control-preview-empty">
          Path preview appears when a program is loaded.
        </div>
      )}
    </div>
  )
}

/** WO-292 named the travel disagreement (Machine Library vs controller); the
 *  Table card that carried it is gone (WO-414 batch 2), so the line rides
 *  alone, bottom-left, only while a mismatch exists. Silent otherwise: the
 *  status (homed / not homed) is the HOME LED's job, and the fit verdict is a
 *  console line only (WO-414, ProgramFitStatusLine.publishProgramFit). */
function TravelMismatchLine({ mismatches }: { mismatches: TravelMismatch[] }) {
  const units = useDisplayUnits()
  if (mismatches.length === 0) return null
  return (
    <div
      className="control-overlay-card control-overlay-bottom control-travel-mismatch"
      data-testid="program-preview-envelope-mismatch"
      role="status"
    >
      {mismatches
        .map(
          (m) =>
            `${m.axis.toUpperCase()} travel: Machine Library ${fmtMachineLength(m.typedMm, units)} ${unitLabel(units)}, ` +
            `controller ${fmtMachineLength(m.reportedMm, units)} ${unitLabel(units)} (off by ${fmtMachineLength(m.differenceMm, units)} ${unitLabel(units)})`,
        )
        .join('; ')}
    </div>
  )
}

const INTENDED_STOCK_STATE_TEXT: Record<IntendedStockState, { badge: string; note: string | null }> = {
  'no-context': { badge: 'NONE', note: 'No intended stock information - this program was loaded from a file, not from a setup.' },
  current: { badge: 'CURRENT', note: null },
  'project-changed': { badge: 'STALE', note: 'Setup changed since this program was posted. The block shows the stock AS POSTED, not the live setup - reload from the setup to refresh it.' },
  'program-changed': { badge: 'STALE', note: 'Program text changed since it was posted. The block shows the stock AS POSTED - reload from the setup to refresh it.' },
  'comparison-failed': { badge: 'UNVERIFIED', note: 'The app could not compare this program with the project (logged to the console). The block shows the stock AS POSTED; do not trust it as current.' },
}

/** WO-380: the intended-stock readout - which setup/stock the loaded program
 *  was posted against, its overall size, material and G54-G59 slot.
 *  WO-414 batch 2 (Operator ruling 2026-08-21: "it needs to be cleaner, allow toggling
 *  the stock visibility. And it needs to get out of the way ... lower right
 *  corner. We want to avoid covering the visibility of the preview"): ONE line
 *  anchored LOWER-RIGHT in the preview frame - "Intended stock - CURRENT -
 *  Setup 4 (G57)" + the help link + an eye toggle for the box in the scene.
 *  Clicking the line opens the facts (setup / stock / size / WCS / note) as a
 *  small popover ABOVE the line; Escape, the line again, or a click anywhere
 *  else closes it. Transient (not remembered) - it is a look-up, not a state.
 *  WO-412: the line follows the ACTIVE setup of a multi-setup program.
 *  Staleness is carried by the badge text, the data attribute and the tint
 *  together - never by colour alone. Advisory: nothing here can arm, start, or
 *  alter a line. */
function IntendedStockReadout({
  state,
  postedFromAnotherProject,
  context,
  box,
  units,
  visible,
  onToggleVisible,
}: {
  state: IntendedStockState
  postedFromAnotherProject: boolean
  /** The setup the line describes: the active one of a multi-setup program
   *  (WO-412), the single setup otherwise. */
  context: Pick<ProgramContextV1, 'setup' | 'wcs' | 'stock'> | null
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null
  units: ReturnType<typeof useDisplayUnits>
  /** Whether the stock box is drawn in the 3D scene (persisted). */
  visible: boolean
  onToggleVisible: () => void
}) {
  // WO-2278: distinguish another project's post only in this readout's words.
  // Keep the shared verdict, scene tint and program-text drift precedence.
  const text = state === 'project-changed' && postedFromAnotherProject
    ? { badge: 'other project', note: 'This program was posted from another project. The block shows the stock AS POSTED in that project.' }
    : INTENDED_STOCK_STATE_TEXT[state]
  const dim = (mm: number) => fmtMachineLength(mm, units)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const wcsShort = context ? `G${context.wcs.fixtureOffset}` : null
  const eyeTip = visible ? 'Hide the intended stock box in the preview' : 'Show the intended stock box in the preview'
  return (
    <div
      ref={rootRef}
      className="control-overlay-card control-overlay-bottom-right control-intended-stock-card"
      data-testid="program-preview-intended-stock"
      data-context-state={state}
      data-expanded={open ? 'true' : 'false'}
      data-stock-visible={visible ? 'true' : 'false'}
    >
      {open && (
        <div
          className="control-intended-stock-popover"
          data-testid="program-preview-intended-stock-body"
          role="dialog"
          aria-label="Intended stock details"
        >
          {context && (
            <dl className="control-intended-stock-facts" data-testid="program-preview-intended-stock-facts">
              <dt>Setup</dt>
              <dd data-testid="program-preview-intended-stock-setup">{context.setup.name}</dd>
              <dt>Stock</dt>
              <dd data-testid="program-preview-intended-stock-name">
                {context.stock.name}
                {/* WO-380: stock material is not shown - there is no place to set one yet (Operator 2026-08-21) */''}
              </dd>
              <dt>Size</dt>
              <dd data-testid="program-preview-intended-stock-size">
                {box
                  ? `X ${dim(box.max.x - box.min.x)}  Y ${dim(box.max.y - box.min.y)}  Z ${dim(box.max.z - box.min.z)} ${unitLabel(units)}`
                  : 'no volume (not drawn)'}
              </dd>
              <dt>WCS</dt>
              <dd data-testid="program-preview-intended-stock-wcs">
                G{context.wcs.fixtureOffset}
                {context.wcs.label && context.wcs.label !== `G${context.wcs.fixtureOffset}` ? ` (${context.wcs.label})` : ''}
              </dd>
            </dl>
          )}
          {text.note && (
            <span className="control-intended-stock-note" data-testid="program-preview-intended-stock-note">
              {text.note}
            </span>
          )}
        </div>
      )}
      <div className="control-overlay-head">
        <button
          type="button"
          className="control-intended-stock-line"
          data-testid="program-preview-intended-stock-summary"
          aria-expanded={open}
          aria-haspopup="dialog"
          style={state === 'project-changed' && postedFromAnotherProject ? { whiteSpace: 'normal' } : undefined}
          data-tooltip={open ? 'Hide the intended-stock details' : 'Show which setup and stock this program was posted against'}
          onClick={() => setOpen((v) => !v)}
        >
          Intended stock
          {' - '}
          <span
            className="control-intended-stock-badge"
            data-testid="program-preview-intended-stock-badge"
            style={state === 'project-changed' && postedFromAnotherProject ? { whiteSpace: 'nowrap' } : undefined}
          >
            {text.badge}
          </span>
          {context ? ` - ${context.setup.name} (${wcsShort})` : ''}
        </button>
        {/* WO-413: what CURRENT / STALE / NONE / UNVERIFIED and the chip mean */}
        <HelpLink topic="program-context" testId="program-preview-intended-stock-help" />
        <button
          type="button"
          className="panel-action-btn control-intended-stock-eye"
          data-testid="program-preview-intended-stock-visible"
          aria-pressed={visible}
          aria-label={eyeTip}
          data-tooltip={eyeTip}
          onClick={onToggleVisible}
        >
          {visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
    </div>
  )
}
