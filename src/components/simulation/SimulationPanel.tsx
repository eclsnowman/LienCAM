import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useEffect, useRef, useCallback, useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, ChevronUp, MonitorPlay } from 'lucide-react'
import { useCamStore } from '../../store'
import { feedLabel, fmtDim, fmtFeed, unitLabel } from '../../lib/ui/unitFormat'
import { toWork } from '../../lib/post/coords'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import { publishSimulationStock } from '../../lib/exportCenter'
import { VoxelSimulator, type VoxelSimTool } from '../../lib/simulation/VoxelSimulator'
import type { StockBounds, VoxelField } from '../../lib/simulation/voxel/VoxelField'
import {
  buildToolpathLayerPreviewPlan,
  type LayerPreviewSection,
  type ToolpathLayerPreviewPlan,
} from '../../lib/simulation/toolpathLayerPreview'
import { seedPoseKeyForGeo } from '../../lib/cam/nesting/instanceToolpath'
import { collectToolpathSections } from '../../lib/cam/nesting/nestRuntime'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import { buildToolProfile, tipOffsetAtRadius, undercutBodyTopAtRadius, undercutSolidFor } from '../../lib/tool/toolProfile'
import { isStockCuttingRole, effectiveMoveRole } from '../../lib/cam/stockCuttingRoles'
import { requireFinitePositiveFeed } from '../../lib/cam/runtime'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { selectEnabledOperations } from '../../lib/cam/operationSuppression'
import { ToolpathFeedEstimatePanel } from '../toolpath/ToolpathFeedEstimatePanel'
import { clearanceAllowanceMmOf } from '../../lib/cam/holderClearanceGate'
import {
  checkWorkholdingContact,
  primeWorkholdingContactShapes,
  workholdingContactConsoleLines,
  workholdingContactShapes,
  type ClearanceMesh,
} from '../../lib/simulation/workholdingContact'
import type { Tool, ToolpathMove, ToolType, Units, Vec3, WCS } from '../../types'

// Total voxel-cell budget. A dense R32F field is 4 bytes/cell. planVoxelGrid
// coarsens (logged, ADR-0003) to fit this. SAFETY STOPGAP: capped at 8M (~32MB)
// because profiling (docs/qa/001 .../PERF-NUMBERS.md, RTX A4000) showed a 32M /
// ~128MB field at 0.1mm CRASHED the GPU process under the current
// full-re-upload-per-sync path. 8M carves safely (the 0.25mm config). RAISE this
// once Item 5 (partial texSubImage3D upload) and/or the sparse brick-pool backing
// (ADR-0028) land and fine resolution is profiled safe.
const VOXEL_MAX_VOXELS = 8_000_000

// Keyframe scrub cache (ADR pending): carving a dense deck-depth rough (156k-248k
// moves) from a SINGLE baseline froze the scrubber for 15-92s on a backward seek
// (re-carve 0..target). The carve is deterministic (~0.43ms/move) and the field
// snapshot/restore is cheap (voxel ~25MB/2-4ms, heightmap ~1MB), so we keep a ring
// of evenly-spaced field snapshots ("keyframes") and seek from the nearest one <=
// target instead of from frame 0. Budget caps the ring's RAM: a 156k-frame voxel
// path at 25MB/snap fits floor(384MB/25MB)=15 keyframes -> interval ~10.4k frames
// -> a settle re-carves at most ~10.4k moves (~4.5s) instead of up to 156k (~67s);
// a smaller (heightmap ~1MB) snapshot hits the 48 cap -> interval ~3.25k (~1.4s).
// During a DRAG we stop at the keyframe (instant ~2-4ms restore, marker still
// exact); on release we settle to the exact frame.
const KEYFRAME_BUDGET_BYTES = 384 * 1024 * 1024
const KEYFRAME_MAX = 48

export interface SimFrame {
  fromX: number; fromY: number; fromZ: number
  toX: number;   toY: number;   toZ: number
  startMs: number
  durationMs: number
  role: string
  speedMmPerMin: number
  toolRadius: number              // resolved at frame-build time (heightmap carving)
  profile: (d: number) => number  // radial Z-offset profile for shaped tools (heightmap)
  bodyTop?: (d: number) => number // undercut tools only: top of the body over the tip (heightmap, WO-1964)
  tool?: VoxelSimTool             // resolved tool shape for voxel carving (ADR-0028)
}

type ToolGeoCfg = {
  type: string; diameter: number; shankDiameter: number
  fluteLength: number; shoulderLength: number; overallLength: number
  cornerRadius: number; angleFromAxisDeg: number
  tipDiameter?: number; neckDiameter?: number
  // Thread-mill teeth (WO-1965): without them the voxel sim carves a plain bore.
  threadPitch?: number; threadTeethCount?: number
  threadFormAngleDeg?: number; neckTransitionAngleDeg?: number
  lengthBelowHolder?: number
  holderSegments?: { height: number; lowerDiameter: number; upperDiameter: number }[]
}

export const RAPID_SPEED = 5000  // mm/min fallback when the machine rapid rate is invalid

const FLAT_PROFILE: (d: number) => number = () => 0

// Bottom-surface radial profile for the 2.5D heightmap path, derived from the ONE
// source-of-truth tool geometry (buildToolProfile) via tipOffsetAtRadius. This
// replaces the old per-type switch duplicated from carve.ts, so all 18 tool types
// (not just flat/ball/bull/v_bit) get a real cutting shape; tipOffsetAtRadius
// reproduces the legacy analytic formulas exactly for the previously-supported
// types. Undercut tools (lollipop/dovetail/slitting saw/thread mill) also get a
// bodyTop (toolBodyTop below) so the head passes under material above it.
function toolProfile(cfg: ToolGeoCfg | null): (d: number) => number {
  if (!cfg) return FLAT_PROFILE
  const profile = buildToolProfile(cfgToTool(cfg))
  return (d) => tipOffsetAtRadius(profile, d)
}

// WO-1964: the top of an undercut tool's body over its tip at radius d, for the
// 2.5D heightmap (HeightmapSimulator.carveWithProfile's bodyTop), built from the
// same bounded solid the voxel carve uses since WO-1383 (undercutSolidFor at the
// cutting radius). A column whose surface is above it keeps its surface: the head
// passes under the overhang and only the neck width is removed above it.
// undefined for a tool that never narrows going up (flat, ball, bull, drill,
// chamfer...), which keeps those tools on the unchanged carve.
function toolBodyTop(cfg: ToolGeoCfg | null): ((d: number) => number) | undefined {
  if (!cfg) return undefined
  const solid = undercutSolidFor(buildToolProfile(cfgToTool(cfg)), cfg.diameter / 2)
  return solid === null ? undefined : (d) => undercutBodyTopAtRadius(solid, d)
}

// Build a Tool-shaped object from the panel's ToolGeoCfg so buildToolProfile (which
// keys on Tool.type / diameter / fluteLength / etc.) can derive the profile.
function cfgToTool(cfg: ToolGeoCfg): Tool {
  return {
    id: '',
    name: '',
    type: cfg.type as ToolType,
    diameter: cfg.diameter,
    fluteLength: cfg.fluteLength,
    shankDiameter: cfg.shankDiameter,
    overallLength: cfg.overallLength,
    shoulderLength: cfg.shoulderLength,
    numberOfFlutes: 0,
    cornerRadius: cfg.cornerRadius,
    angleFromAxisDeg: cfg.angleFromAxisDeg,
    tipDiameter: cfg.tipDiameter,
    neckDiameter: cfg.neckDiameter,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
  }
}

// Map the panel's ToolGeoCfg to the voxel carve tool shape (ADR-0028). The full
// geometry is forwarded so toolShapeFromTool builds the source-of-truth profile;
// angleFromAxisDeg is the canonical per-side half-angle (docs/tool_angle_conventions.md).
function toolShapeCfg(cfg: ToolGeoCfg | null): VoxelSimTool {
  if (!cfg) return { type: 'flat_end_mill', diameter: 6 }
  return {
    type: cfg.type,
    diameter: cfg.diameter,
    cornerRadius: cfg.cornerRadius,
    angleFromAxisDeg: cfg.angleFromAxisDeg,
    fluteLength: cfg.fluteLength,
    shankDiameter: cfg.shankDiameter,
    overallLength: cfg.overallLength,
    shoulderLength: cfg.shoulderLength,
    tipDiameter: cfg.tipDiameter,
    neckDiameter: cfg.neckDiameter,
    threadPitch: cfg.threadPitch,
    threadTeethCount: cfg.threadTeethCount,
    threadFormAngleDeg: cfg.threadFormAngleDeg,
    neckTransitionAngleDeg: cfg.neckTransitionAngleDeg,
  }
}

type VpHandle = {
  setToolMarkerPosition?: (x: number, y: number, z: number) => void
  showToolMarker?:        (v: boolean) => void
  updateToolGeometry?:    (cfg: ToolGeoCfg) => void
  initStockSim?:          (cellSize: number, stockId?: string) => {
    x0: number; y0: number; nx: number; ny: number
    cellSize: number; stockTop: number; stockBot: number
  } | null
  updateStockSimHeights?: (heights: Float32Array) => void
  disposeStockSim?:       () => void
  // Feature B: opacity of the live sim stock (heightmap mesh and/or voxel volume)
  // so the target model reads through. One method handles whichever engine is up.
  setStockSimOpacity?:    (opacity: number) => void
  setStockSimVisible?:    (visible: boolean) => void
  // Voxel stock-sim render path (ADR-0028), parallel to the heightmap methods.
  initVoxelSim?:          (field: VoxelField) => void
  syncVoxelSim?:          (field: VoxelField) => void
  disposeVoxelSim?:       () => void
  // GPU capability probe for the voxel engine (ADR-0028): WebGL2 + float-3D-
  // texture linear filtering. Drives the 'auto' setting's fallback to heightmap.
  supportsVoxelSim?:      () => boolean
  setSimulationToolpathPreview?: (moves: ToolpathMove[] | null) => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

// B9 (docs/planning/POST-MERGE-WORKPLAN.md): the stock-removal surface is a
// SIMULATION-mode visual. The frames-rebuild effect below also fires while the
// user sits in Setup/Toolpath (toolpathKey changes whenever an op finishes
// computing - the drill op / drill wizard sightings), and the old plain
// `if (stockSimEnabled)` guard created and showed the surface (and hid the
// wireframe stock, initStockSim's side effect) from those tabs. The surface
// may exist ONLY in simulation mode; in any other mode it is disposed.
// Exported so tests can drive it with real store state + real CNCViewport
// methods (typedZTransform pattern).
export function syncStockSimSurface(
  vp: VpHandle | null,
  opts: { mode: string; enabled: boolean; resolution: number; stockId?: string },
): {
  x0: number; y0: number; nx: number; ny: number
  cellSize: number; stockTop: number; stockBot: number
} | null {
  if (opts.enabled && opts.mode === 'simulation') {
    return vp?.initStockSim?.(opts.resolution, opts.stockId) ?? null
  }
  vp?.disposeStockSim?.()
  return null
}

function resolveRapidSpeed(rapidRate: number): number {
  return Number.isFinite(rapidRate) && rapidRate > 0 ? rapidRate : RAPID_SPEED
}

export function buildFrames(
  moves: { x: number; y: number; z: number; type: string; feed?: number; role?: string; cx?: number; cy?: number }[],
  rapidRate: number,
  baseMs = 0,
  toolRadius = 3,
  profile: (d: number) => number = FLAT_PROFILE,
  tool?: VoxelSimTool,
  // Operation-resolved rates for the two roles that carry geometry + move type but
  // NO baked feed by design (ADR-0001): 'fast_traverse' (keep-down reposition through
  // cleared stock -- emit.ts emitLink jumpType 1 / emitLoopback) and 'finish' (the
  // dedicated wall-finishing contour -- emit.ts emitFinish). The 2D adaptive engine
  // emits these feedless and the consumer resolves the rate BY ROLE, exactly as
  // estimateRuntimeMs (src/lib/cam/runtime.ts) already does. Default to rapidRate for
  // degraded callers with no resolved feeds (the same fallback estimateRuntimeMs uses).
  fastTraverseRate: number = rapidRate,
  finishRate: number = rapidRate,
  bodyTop?: (d: number) => number,
): { frames: SimFrame[]; totalMs: number } {
  const linearMoves = sampleArcMovesForLinearConsumers(moves as ToolpathMove[])
  if (linearMoves.length === 0) return { frames: [], totalMs: 0 }
  const frames: SimFrame[] = []
  let t = baseMs
  let prevX = linearMoves[0].x, prevY = linearMoves[0].y, prevZ = linearMoves[0].z
  const rapidSpeed = resolveRapidSpeed(rapidRate)
  // A missing/degraded role rate falls back to the rapid speed so a frame's speed is
  // ALWAYS finite positive (durationMs can never become NaN/Infinity from a bad rate).
  const fastTraverseSpeed = Number.isFinite(fastTraverseRate) && fastTraverseRate > 0 ? fastTraverseRate : rapidSpeed
  const finishSpeed       = Number.isFinite(finishRate)       && finishRate       > 0 ? finishRate       : rapidSpeed

  for (let i = 1; i < linearMoves.length; i++) {
    const m = linearMoves[i]
    const dx = m.x - prevX, dy = m.y - prevY, dz = m.z - prevZ
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
    const role = effectiveMoveRole(m)
    let speed: number
    if (m.type === 'rapid') {
      speed = rapidSpeed
    } else if (role === 'fast_traverse') {
      // Feedless BY DESIGN (ADR-0001): resolve by role instead of refusing. A keep-down
      // reposition rides the cleared stock at the operation's fast-traverse rate.
      speed = fastTraverseSpeed
    } else if (role === 'finish') {
      // Feedless BY DESIGN (ADR-0001): the wall-finish contour rides the finish rate.
      speed = finishSpeed
    } else {
      // Every OTHER non-rapid move must carry a finite positive baked feed. A genuinely
      // feedless cut is bad data and STILL refuses by name (SIM-4/ADR-0003) -- unchanged.
      speed = requireFinitePositiveFeed(m.feed, tx('SimulationPanel.Simulation_frame_build_refused_move', { p1: i, p2: role }))
    }
    const durationMs = dist > 0.001 ? (dist / speed) * 60000 : 0

    frames.push({
      fromX: prevX, fromY: prevY, fromZ: prevZ,
      toX: m.x, toY: m.y, toZ: m.z,
      startMs: t, durationMs,
      role,
      speedMmPerMin: speed,
      toolRadius,
      profile,
      bodyTop,
      tool,
    })
    t += durationMs
    prevX = m.x; prevY = m.y; prevZ = m.z
  }
  return { frames, totalMs: t - baseMs }
}

export function formatMoveReadout(
  frame: Pick<SimFrame, 'role' | 'speedMmPerMin'> | null,
  units: Units,
): string {
  if (!frame) return '—'
  const role = frame.role.replace(/_/g, ' ').toUpperCase()
  return `${role} @ ${fmtFeed(frame.speedMmPerMin, units)} ${feedLabel(units)}`
}

export interface PlaybackPosition {
  machine: Vec3
  work: Vec3
}

function finitePoint(point: Vec3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
}

// Resolve the ONE interpolated point consumed by both the viewport marker and
// the WCS readout. Toolpath moves are machine/world coordinates; toWork applies
// the canonical machine -> setup(WCS) transform used by the postprocessor:
// work = R^T * (machine - wcs.origin). Invalid frame/WCS data refuses by name
// (null -> dashes) instead of letting NaN survive display rounding.
export function resolvePlaybackPosition(
  frame: Pick<SimFrame, 'fromX' | 'fromY' | 'fromZ' | 'toX' | 'toY' | 'toZ' | 'startMs' | 'durationMs'> | null,
  playheadMs: number,
  wcs: WCS,
): PlaybackPosition | null {
  if (!frame || !Number.isFinite(playheadMs)) return null
  const values = [
    frame.fromX, frame.fromY, frame.fromZ,
    frame.toX, frame.toY, frame.toZ,
    frame.startMs, frame.durationMs,
  ]
  if (values.some(value => !Number.isFinite(value)) || frame.durationMs < 0) return null

  const fraction = frame.durationMs > 0
    ? Math.max(0, Math.min(1, (playheadMs - frame.startMs) / frame.durationMs))
    : 1
  const machine = {
    x: frame.fromX + fraction * (frame.toX - frame.fromX),
    y: frame.fromY + fraction * (frame.toY - frame.fromY),
    z: frame.fromZ + fraction * (frame.toZ - frame.fromZ),
  }
  if (!finitePoint(machine)) return null
  const work = toWork(machine, wcs)
  return finitePoint(work) ? { machine, work } : null
}

export function formatPositionReadout(position: Vec3 | null, units: Units): string {
  if (!position || !finitePoint(position)) return tx('SimulationPanel.WCS_X_Y_Z')
  return tx('SimulationPanel.WCS_X_Y_Z_2', { p1: fmtDim(position.x, units), p2: fmtDim(position.y, units), p3: fmtDim(position.z, units), p4: unitLabel(units) })
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`
}

export const SPEED_OPTIONS   = [0.1, 0.5, 1, 5, 10, 50, 100] as const
// Single source of truth for the startup playback speed. The highlighted speed
// button (speedIdx) AND the live clock multiplier (speedRef) both derive from
// this index so they can never disagree. INITIAL_SPEED_IDX must point at the 1x
// entry; the init-consistency test asserts SPEED_OPTIONS[INITIAL_SPEED_IDX] === 1
// so a future reorder of SPEED_OPTIONS can't silently desync the UI from the clock.
export const INITIAL_SPEED_IDX = 2

// Pure playback clock step used by the rAF loop: advance the sim clock by the
// real elapsed time scaled by the speed multiplier. Exported so a unit test can
// assert determinism (speed 1 over realDt yields exactly +realDt, and the
// per-realDt advance at 1x is identical before/after a detour through any speed).
export function simAdvance(currentMs: number, realDt: number, speed: number): number {
  return currentMs + realDt * speed
}
// value is the voxel size in mm (canonical); the displayed label is built from
// displayUnits at render so it reads e.g. "0.0394 in (fast)" in inch mode.
const RES_OPTIONS     = [
  { value: 1.0,  tag: 'fast'      },
  { value: 0.5,  tag: 'normal'    },
  { value: 0.25, tag: 'fine'      },
  { value: 0.1,  get tag() { return tx('SimulationPanel.very_fine') } },
]

// Which move roles actually remove material lives in ONE shared authority
// (src/lib/cam/stockCuttingRoles.ts): isStockCuttingRole + effectiveMoveRole.
// Both the live-playback carve and the pre-carve baseline consult it so they
// classify identically: skip only rapids, fast-traverse, and loop-backs that
// travel through already-cleared air; carve everything engaged — cut, helix,
// ramp, plunge, stepover, wall_follow, leads, AND the finish pass (a finish
// removes a thin wall skim and must show in the sim).

// P1: chunked async carve tuning. Spans up to this many frames carve INLINE
// (instant, no progress chrome). A larger jump (the settle after a fast drag, a
// click to a far point, skip-to-end) carves in CARVE_CHUNK_BUDGET_MS slices
// yielded across macrotasks, so the main thread never blocks long enough to
// trip Chrome's "page unresponsive" dialog. Playback always carves inline (the
// rAF loop advances small deltas) so it stays continuous, never async-stuttered.
const CARVE_SYNC_MAX = 64
const CARVE_CHUNK_BUDGET_MS = 16

export function SimulationPanel() {
  useText('cam-operations-new-operation')
  const viewer             = useCamStore(s => s.viewer)
  const stockSimEnabled    = useCamStore(s => s.viewer.stockSimEnabled)
  const stockSimResolution = useCamStore(s => s.viewer.stockSimResolution)
  const setStockSimEnabled    = useCamStore(s => s.setStockSimEnabled)
  const setStockSimResolution = useCamStore(s => s.setStockSimResolution)
  const simHideToolpath       = useCamStore(s => s.viewer.simHideToolpath)
  const stockSimDisplayMode   = useCamStore(s => s.viewer.stockSimDisplayMode)
  const stockSimOpacity       = useCamStore(s => s.viewer.stockSimOpacity)
  const setSimHideToolpath     = useCamStore(s => s.setSimHideToolpath)
  const setStockSimDisplayMode = useCamStore(s => s.setStockSimDisplayMode)
  const setStockSimOpacity     = useCamStore(s => s.setStockSimOpacity)
  const displayUnits          = useCamStore(s => s.appSettings.displayUnits)
  const simEngineSetting      = useCamStore(s => s.appSettings.simulationEngine)
  // BUG-517: subscribed (not read via getState() in the rebuild effect below) so
  // editing a tool's/holder's dimensions while paused re-fires the rebuild even
  // though toolpathKey (op id/status/move-count/seed-pose) is unchanged.
  const toolLibrary           = useCamStore(s => s.toolLibrary)
  const holders               = useCamStore(s => s.holders)

  // UI-BRAND-B2-9: names the idle empty-state callout ("Generate '<op>' to
  // simulate") when there is a selected operation but nothing to play back
  // yet. Read-only, presentational -- does not affect frame building below.
  const activeOpName = useCamStore(s => {
    const setup = s.project.setups.find(st => st.id === s.project.activeSetupId)
    return setup?.operations.find(o => o.id === s.project.activeOperationId)?.name ?? null
  })

  const toolpathKey = useCamStore(s => {
    const setup = s.project.setups.find(st => st.id === s.project.activeSetupId)
    if (!setup) return ''
    // Mirror Viewport: fold the bound seed pose in so moving the bound stock
    // (which moves the seed geo, not move counts) re-fires the frame rebuild.
    // Non-seed ops contribute "" -> the key stays byte-identical to before.
    const opKey = (o: typeof setup.operations[number]) => {
      const geoId = (o.params as { geometryId?: string }).geometryId
      const geo = geoId ? s.project.geometry.find(g => g.id === geoId) : undefined
      // P7: a nest seed op simulates the WHOLE nest expansion. Re-fire when the
      // nest copy count, cut order, or world origin change (mirrors Viewport).
      let nestFrag = ''
      if (geo?.ownerNestId) {
        const n = s.project.nests?.find(nn => nn.id === geo.ownerNestId)
        if (n) {
          const o0 = n.origin ?? { x: 0, y: 0 }
          nestFrag = `:nest${n.placements.length}:${n.machiningOrder ?? 'by-operation'}:${o0.x},${o0.y}`
        }
      }
      return `${o.id}:${o.status}:${o.toolpathMoves?.length ?? 0}:${seedPoseKeyForGeo(geo)}${nestFrag}`
    }
    return selectEnabledOperations(setup.operations, s.project.activeOperationId)
      .map(opKey)
      .join('|')
  })

  // Simulation playback state
  const framesRef           = useRef<SimFrame[]>([])
  const currentFrameRef     = useRef<SimFrame | null>(null)
  const currentWcsRef       = useRef<WCS | null>(null)
  const currentPositionRef  = useRef<PlaybackPosition | null>(null)
  const totalMsRef          = useRef(0)
  const currentMsRef        = useRef(0)
  const isPlayingRef        = useRef(false)
  const speedRef            = useRef<number>(SPEED_OPTIONS[INITIAL_SPEED_IDX])
  const lastRealTimeRef     = useRef<number | null>(null)
  const rafIdRef            = useRef(0)
  const layerPreviewPlanRef = useRef<ToolpathLayerPreviewPlan | null>(null)
  const lastPreviewLayerRef = useRef(-2)

  const toolTimelineRef     = useRef<Array<{ startMs: number; cfg: ToolGeoCfg | null }>>([])
  const lastAppliedCfgRef   = useRef<ToolGeoCfg | null>(null)

  // Stock sim state
  const simRef              = useRef<HeightmapSimulator | null>(null)
  const voxelSimRef         = useRef<VoxelSimulator | null>(null) // ADR-0028 voxel engine
  const baseHeightsRef      = useRef<Float32Array | null>(null)   // heightmap baseline snapshot
  const voxelBaselineRef    = useRef<Float32Array | null>(null)   // voxel field baseline snapshot
  const lastCarvedIdxRef    = useRef(-1)                          // last fully-carved frame index
  // WO-1538: the field may additionally hold the ELAPSED PREFIX of the active
  // frame (lastCarved + 1) - never its future endpoint. partialIdxRef names that
  // frame (-1 = none); activeBaseRef is the field as it stood before the prefix
  // was carved, restored before any other carve so a later seek (backward within
  // the frame, or on to its end) starts from completed frames only.
  const partialIdxRef       = useRef(-1)
  const activeBaseRef       = useRef<Float32Array | null>(null)

  // Keyframe scrub cache. keyframesRef holds field snapshots ascending by frame
  // index (idx = last frame the snapshot includes); entry idx -1 is the baseline
  // (reused, NOT a second copy). The ring lets
  // a seek restore the nearest keyframe <= target and carve only the remainder,
  // bounding both backward seeks and big forward jumps to ~`interval` moves.
  const keyframesRef        = useRef<Array<{ idx: number; snap: Float32Array }>>([])
  const nextKeyframeIdxRef  = useRef(0)         // next frame idx at which to capture a keyframe
  const keyframeIntervalRef = useRef(Infinity)  // frames between keyframes (sized from RAM budget)
  const maxKeyframesRef     = useRef(2)          // ring capacity (sized from RAM budget)
  const isScrubbingRef      = useRef(false)      // true while the user drags the scrubber (approximate)
  const carveTokenRef       = useRef(0)          // bumped per seek; an in-flight async carve abandons when superseded
  const initTokenRef        = useRef(0)          // bumped per init-effect run; an in-flight async pre-carve abandons when superseded

  // DOM refs
  const scrubberRef  = useRef<HTMLInputElement>(null)
  const timeNowRef   = useRef<HTMLSpanElement>(null)
  const moveReadoutRef = useRef<HTMLSpanElement>(null)
  const positionReadoutRef = useRef<HTMLSpanElement>(null)
  const carveProgressRef     = useRef<HTMLDivElement>(null)   // progress row wrapper (shown only during an async carve)
  const carveProgressFillRef = useRef<HTMLDivElement>(null)   // the fill bar
  const carveProgressTextRef = useRef<HTMLSpanElement>(null)  // "Simulating NN%"

  const [isPlaying,    setIsPlaying]    = useState(false)
  const [speedIdx,     setSpeedIdx]     = useState(INITIAL_SPEED_IDX)
  const [totalMsState, setTotalMsState] = useState(0)
  // P9: the 7 always-visible speed buttons collapsed to one chip; the presets
  // open as a flyout. Presentation only - speedIdx/speedRef semantics unchanged.
  const [speedFlyoutOpen, setSpeedFlyoutOpen] = useState(false)
  // View-scoped failure state for the toolpath-preview frame build. A refused move
  // (or any error while building simulation frames) must fail loud IN THIS PANEL with
  // the named reason -- it must NOT propagate to the app-level ErrorBoundary and take
  // the whole app down to the "Reset Project Data" screen (that screen even threatens
  // data loss for what is only a VIEW problem). The tree, ops, and geometry stay alive.
  const [frameBuildError, setFrameBuildError] = useState<string | null>(null)
  const speedGroupRef = useRef<HTMLDivElement>(null)

  const syncToolpathLayerPreview = useCallback((frameIndex: number) => {
    const plan = layerPreviewPlanRef.current
    const layerIndex = plan && frameIndex >= 0 && frameIndex < plan.frameToLayer.length
      ? plan.frameToLayer[frameIndex]
      : -1
    if (lastPreviewLayerRef.current === layerIndex) return
    lastPreviewLayerRef.current = layerIndex
    getVp()?.setSimulationToolpathPreview?.(
      layerIndex >= 0 ? plan?.layers[layerIndex] ?? null : null,
    )
  }, [])

  // Root of the panel, for the P15 height publication below.
  const panelRef = useRef<HTMLDivElement>(null)

  // WO-1538: say whether the stock on screen is the exact result for the marker's
  // time ('exact'), a drag preview lagging it ('preview'), or a large carve still
  // catching up ('settling'). Published on the panel root as data-stock-sync +
  // data-stock-ms (the time the shown stock represents); a lagging drag preview
  // also labels itself in the progress row so the mismatch is never unlabeled.
  // null = no stock simulation running.
  const publishStockSync = useCallback((state: 'exact' | 'preview' | 'settling' | null, stockMs: number) => {
    const el = panelRef.current
    if (!el) return
    if (state === null) {
      el.removeAttribute('data-stock-sync')
      el.removeAttribute('data-stock-ms')
      return
    }
    el.setAttribute('data-stock-sync', state)
    el.setAttribute('data-stock-ms', String(Math.round(stockMs)))
    if (state === 'preview') {
      const markerMs = currentMsRef.current
      const pct = markerMs > 0 ? Math.max(0, Math.min(100, Math.round((stockMs / markerMs) * 100))) : 100
      if (carveProgressRef.current) carveProgressRef.current.style.display = 'flex'
      if (carveProgressFillRef.current) carveProgressFillRef.current.style.width = pct + '%'
      if (carveProgressTextRef.current) carveProgressTextRef.current.textContent = tx('SimulationPanel.Stock_preview', { p1: formatTime(stockMs) })
    }
  }, [])

  useEffect(() => {
    if (moveReadoutRef.current) {
      moveReadoutRef.current.textContent = formatMoveReadout(currentFrameRef.current, displayUnits)
    }
    if (positionReadoutRef.current) {
      positionReadoutRef.current.textContent = formatPositionReadout(currentPositionRef.current?.work ?? null, displayUnits)
    }
  }, [displayUnits])

  // P15: while the playback bar is visible it covers the bottom-anchored
  // viewport overlays (ViewCube, display-settings icon, axis legend, toolpath
  // legend chip). Publish the panel's LIVE height as --sim-panel-h on the
  // viewport root; those overlays position with
  // bottom: calc(<rest>px + var(--sim-panel-h, 0px)) so they shift up exactly
  // by the bar's height (which varies: stock-sim rows, carve progress). A
  // ResizeObserver tracks row add/remove; unmount / leaving simulate mode
  // resets the var to 0px so everything settles back down.
  useEffect(() => {
    const el = panelRef.current
    const root = el?.parentElement
    if (!el || !root) return
    const publish = () => root.style.setProperty('--sim-panel-h', `${el.offsetHeight}px`)
    publish()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(publish)
      ro.observe(el)
    }
    return () => {
      ro?.disconnect()
      root.style.setProperty('--sim-panel-h', '0px')
    }
  }, [viewer.mode])

  // Close the speed flyout on any outside pointer-down (same pattern as the
  // DisplayModeControl flyout).
  useEffect(() => {
    if (!speedFlyoutOpen) return
    const handler = (e: MouseEvent) => {
      if (speedGroupRef.current && !speedGroupRef.current.contains(e.target as Node)) {
        setSpeedFlyoutOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [speedFlyoutOpen])

  const applyToolCfg = useCallback((cfg: ToolGeoCfg | null) => {
    if (!cfg || lastAppliedCfgRef.current === cfg) return
    lastAppliedCfgRef.current = cfg
    getVp()?.updateToolGeometry?.(cfg)
  }, [])

  // ── Rebuild frames + init stock sim ────────────────────────────────────────
  useEffect(() => {
    // Bumped on every run so a large rest-machining pre-carve still chunking
    // from a PRIOR run (below) abandons instead of racing this one's result
    // into voxelSimRef/simRef with stale data.
    const myInitToken = ++initTokenRef.current
    // WO-2448: the Export window saves the same live stock as the button below;
    // it follows the engine refs (null here, the engine once its baseline is real).
    publishSimulationStock(null)
    const state   = useCamStore.getState()
    const { project } = state
    // WO-2646: read the vises' and clamps' exact shapes ahead of Simulate (the
    // contact check below uses each one once read, its box until then).
    void primeWorkholdingContactShapes(project)
    const rapidSpeed = resolveRapidSpeed(project.machine.rapidRate)
    // toolLibrary/holders come from the subscribed selectors above (BUG-517) so
    // this effect re-fires when a tool's own dimensions change, not from getState().
    const setup = project.setups.find(st => st.id === project.activeSetupId)

    // Resolve a tool's holder (if any) into plain segment cfg for the 3D marker.
    const holderSegmentsFor = (t: typeof toolLibrary[number] | null) => {
      if (!t?.holderId) return undefined
      const h = holders.find(hd => hd.id === t.holderId)
      return h ? h.segments.map(s => ({ ...s })) : undefined
    }

    const clear = () => {
      framesRef.current = []
      currentFrameRef.current = null
      currentWcsRef.current = null
      currentPositionRef.current = null
      totalMsRef.current = 0
      currentMsRef.current = 0
      toolTimelineRef.current = []
      lastAppliedCfgRef.current = null
      simRef.current = null
      voxelSimRef.current = null
      publishSimulationStock(null)
      baseHeightsRef.current = null
      voxelBaselineRef.current = null
      lastCarvedIdxRef.current = -1
      partialIdxRef.current = -1
      activeBaseRef.current = null
      keyframesRef.current = []
      nextKeyframeIdxRef.current = 0
      keyframeIntervalRef.current = Infinity
      maxKeyframesRef.current = 2
      isScrubbingRef.current = false
      publishStockSync(null, 0)
      layerPreviewPlanRef.current = null
      lastPreviewLayerRef.current = -2
      getVp()?.setSimulationToolpathPreview?.(null)
      // BUG-523: retire what this effect's OTHER exit paths already retire
      // (viewer.mode leaving simulation, stock-sim toggle off) so an empty or
      // invalidated context never leaves a prior carve/marker on screen.
      getVp()?.disposeStockSim?.()
      getVp()?.disposeVoxelSim?.()
      getVp()?.showToolMarker?.(false)
      setTotalMsState(0)
      if (scrubberRef.current) { scrubberRef.current.value = '0'; scrubberRef.current.max = '0'; scrubberRef.current.setAttribute('aria-valuetext', formatTime(0)) }
      if (moveReadoutRef.current) moveReadoutRef.current.textContent = formatMoveReadout(null, displayUnits)
      if (positionReadoutRef.current) positionReadoutRef.current.textContent = formatPositionReadout(null, displayUnits)
    }

    // Everything below builds the simulation frames + stock-sim baseline. Any throw
    // here (e.g. a genuinely feedless CUT move that legitimately refuses per SIM-4) is
    // caught and surfaced IN THE PANEL, never allowed to reach the app-level boundary.
    try {
    setFrameBuildError(null)

    if (!setup) { clear(); return }

    const enabledOps = setup.operations.filter((operation) => operation.enabled)
    const activeId = project.activeOperationId
    const opsToSim = selectEnabledOperations(setup.operations, activeId)

    // P7 (ADR 0024 Amendment 1): collect render sections, expanding each nest to
    // its full multi-copy stream ONCE (all copies + inter-copy travel, ordered by
    // machiningOrder). A normal op -> one section (seed-slot offset or
    // pass-through). by-part nests interleave tools across sections, so each
    // section resolves its OWN tool (sec.toolId). With no nests this is one
    // section per op, byte-identical to the prior per-op simulation.
    const simSections = collectToolpathSections(opsToSim, project.geometry, project.nests)

    // WO-1578: vises, jaws and clamps marked workholding (WO-1572) in world
    // space. WO-2177: a placed vise or clamp comes from the one resolver the
    // screen draws from, for this setup - a jaw at a new opening is checked
    // there. WO-2646: each vise or clamp component is its exact imported shape
    // once primed above - its bounding box fills a vise's open gaps and named
    // a drill through a soft jaw as touching the vise. A marked row, or a
    // component not read yet, is its box: over-report, never miss.
    const workholdingMeshes: ClearanceMesh[] = workholdingContactShapes(project, setup.id)

    const allFrames: SimFrame[] = []
    const layerPreviewSections: LayerPreviewSection[] = []
    const timeline: typeof toolTimelineRef.current = []
    let cumulativeMs = 0

    for (const sec of simSections) {
      const opMoves = sec.moves
      if (opMoves.length === 0) continue
      // Include the synthetic inter-section travel in the upcoming section so
      // a layered preview switches before the descent/reposition begins.
      const sectionStartFrame = allFrames.length

      if (allFrames.length > 0) {
        const last  = allFrames[allFrames.length - 1]
        const first = opMoves[0]
        const dx = first.x - last.toX, dy = first.y - last.toY, dz = first.z - last.toZ
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
        if (dist > 0.001) {
          const travelMs = (dist / rapidSpeed) * 60000
          allFrames.push({
            fromX: last.toX, fromY: last.toY, fromZ: last.toZ,
            toX: first.x, toY: first.y, toZ: first.z,
            startMs: cumulativeMs, durationMs: travelMs, role: 'rapid', speedMmPerMin: rapidSpeed,
            toolRadius: 3, profile: FLAT_PROFILE,
          })
          cumulativeMs += travelMs
        }
      }

      const tool = toolLibrary.find(t => t.id === sec.toolId) ?? null
      const cfg: ToolGeoCfg | null = tool ? {
        type:           tool.type,
        diameter:       tool.diameter,
        shankDiameter:  tool.shankDiameter,
        fluteLength:    tool.fluteLength,
        shoulderLength: tool.shoulderLength ?? tool.fluteLength,
        overallLength:  tool.overallLength,
        cornerRadius:   tool.cornerRadius ?? 0,
        angleFromAxisDeg: tool.angleFromAxisDeg ?? 59,
        tipDiameter:    tool.tipDiameter,
        neckDiameter:   tool.neckDiameter,
        threadPitch:    tool.threadPitch,
        threadTeethCount: tool.threadTeethCount,
        threadFormAngleDeg: tool.threadFormAngleDeg,
        neckTransitionAngleDeg: tool.neckTransitionAngleDeg,
        lengthBelowHolder: tool.lengthBelowHolder,
        holderSegments: holderSegmentsFor(tool),
      } : null

      timeline.push({ startMs: cumulativeMs, cfg })
      const toolRadius = (tool?.diameter ?? 6) / 2
      const profile = toolProfile(cfg)
      const bodyTop = toolBodyTop(cfg)
      const voxelTool = toolShapeCfg(cfg)
      // Resolve THIS section's operation-scoped fast-traverse / finish rates (the same
      // machine-bounded resolution the store feeds estimateRuntimeMs), so the feedless-
      // by-role adaptive moves (fast_traverse keep-down, finish contour) are timed at
      // their real operation speed. Missing op/tool -> rapidSpeed fallback (buildFrames
      // clamps anyway). This never refuses: a feedless-by-design move is valid data.
      const secOp = setup.operations.find((operation) => operation.id === sec.opId)

      // WO-1578: name any contact with workholding on the console, the same
      // contact rule the WO-1565/1575 trim uses (cutter, neck, shank and
      // holder within the operation's Shank clearance). Playback is never
      // stopped or changed by this - the console is the only surface.
      //
      // Audit fix: this effect rebuilds frames in EVERY view mode (deps include
      // stockSimEnabled/resolution/tool edits, not just mode), and SimulationPanel
      // is always mounted, so it must only post while actually simulating - never
      // while the operator is on the Toolpath tab. It also re-fires on every
      // re-entry into simulation (mode leave/return, an unrelated dep change),
      // so a message already standing in the console for this operation (WO-1540's
      // writeGeneratorNotices dedup pattern) is not written again.
      if (tool && workholdingMeshes.length > 0 && viewer.mode === 'simulation') {
        const holder = tool.holderId ? holders.find((h) => h.id === tool.holderId) : undefined
        const contactReport = checkWorkholdingContact({
          moves: opMoves,
          tool,
          holder,
          workholding: workholdingMeshes,
          allowanceMm: clearanceAllowanceMmOf(secOp?.params),
        })
        if (contactReport.hits.length > 0) {
          const opLabel = secOp?.name ?? tx('SimulationPanel.Operation')
          const entityRef = secOp ? { kind: 'op' as const, id: secOp.id } : undefined
          const standing = new Set(
            useCamStore.getState().consoleEvents
              .filter((event) => event.source === 'simulation' && (
                entityRef
                  ? event.entityRef?.kind === 'op' && event.entityRef.id === entityRef.id
                  : !event.entityRef
              ))
              .map((event) => event.message),
          )
          for (const message of workholdingContactConsoleLines(opLabel, opMoves, contactReport)) {
            if (standing.has(message)) continue
            useCamStore.getState().addConsoleEvent({ severity: 'warning', source: 'simulation', message, entityRef })
          }
        }
      }

      const secFeeds = tool ? resolveFeedrates(tool, secOp?.feedrateOverride, rapidSpeed) : null
      const fastTraverseRate = secFeeds?.fastTraverseRate ?? rapidSpeed
      const finishRate = secFeeds?.finishRate ?? rapidSpeed
      const { frames: opFrames, totalMs: opMs } = buildFrames(
        opMoves, rapidSpeed, cumulativeMs, toolRadius, profile, voxelTool, fastTraverseRate, finishRate, bodyTop,
      )
      // Append iteratively, NOT `push(...opFrames)`: a dense op (e.g. a full-stock
      // adaptive clear is 100k+ frames) spreads every frame as a call argument and
      // overflows the stack ("Maximum call stack size exceeded"), crashing the
      // panel into the error boundary. Same fix as the AC engine emit.
      for (let i = 0; i < opFrames.length; i++) allFrames.push(opFrames[i])
      if (secOp && opFrames.length > 0) {
        layerPreviewSections.push({
          startFrame: sectionStartFrame,
          endFrame: allFrames.length,
          operationType: secOp.type,
        })
      }
      cumulativeMs += opMs
    }

    if (allFrames.length === 0) { clear(); return }

    framesRef.current     = allFrames
    layerPreviewPlanRef.current = buildToolpathLayerPreviewPlan(allFrames, layerPreviewSections)
    lastPreviewLayerRef.current = -2
    currentFrameRef.current = allFrames[0]
    currentWcsRef.current = setup.wcs
    const initialPosition = resolvePlaybackPosition(allFrames[0], 0, setup.wcs)
    currentPositionRef.current = initialPosition
    if (initialPosition) {
      getVp()?.setToolMarkerPosition?.(
        initialPosition.machine.x,
        initialPosition.machine.y,
        initialPosition.machine.z,
      )
    }
    totalMsRef.current    = cumulativeMs
    toolTimelineRef.current = timeline
    lastAppliedCfgRef.current = null
    // clear() hides the marker when a context empties; a rebuild that has frames
    // again must show it, or it stays invisible until Simulate is re-entered.
    // Before applyToolCfg, whose geometry rebuild keeps the current visibility.
    if (viewer.mode === 'simulation') getVp()?.showToolMarker?.(true)
    // BUG-517: push the freshly-resolved tool assembly to the marker right away
    // (reuses applyToolCfg, the same helper seekTo already calls) so an edited
    // tool's dimensions show without requiring an unrelated seek to settle it.
    applyToolCfg(timeline[0]?.cfg ?? null)
    currentMsRef.current  = 0
    lastCarvedIdxRef.current = -1
    partialIdxRef.current = -1
    activeBaseRef.current = null
    // The ring is re-seeded with the baseline once the stock sim inits below.
    keyframesRef.current = []
    nextKeyframeIdxRef.current = 0
    keyframeIntervalRef.current = Infinity
    maxKeyframesRef.current = 2
    isScrubbingRef.current = false
    publishStockSync(null, 0)
    if (viewer.mode === 'simulation') syncToolpathLayerPreview(0)
    else getVp()?.setSimulationToolpathPreview?.(null)
    setTotalMsState(cumulativeMs)
    if (scrubberRef.current) {
      scrubberRef.current.value = '0'
      scrubberRef.current.max   = String(cumulativeMs)
      scrubberRef.current.setAttribute('aria-valuetext', formatTime(0))
    }
    if (moveReadoutRef.current) {
      moveReadoutRef.current.textContent = formatMoveReadout(currentFrameRef.current, displayUnits)
    }
    if (positionReadoutRef.current) {
      positionReadoutRef.current.textContent = formatPositionReadout(currentPositionRef.current?.work ?? null, displayUnits)
    }

    // ── Init stock simulation (simulation mode ONLY - B9) ──────────────────
    // Both engines (ADR-0028; selected by appSettings.simulationEngine) reuse syncStockSimSurface to
    // get the same world stock AABB + grid the heightmap surface derives. The
    // voxel path builds a 3D field instead of a displaced surface; the heightmap
    // path is left byte-identical to before.
    {
      const vp = getVp()

      // Seed the keyframe ring from the just-captured baseline (idx -1 = baseline:
      // no frame carved yet, so a restore re-carves frame 0; reused — NOT a second copy). maxKeyframes is bounded by the RAM budget and
      // the hard cap; interval spreads them across the whole frame list so a seek
      // never re-carves more than ~interval moves. Called by BOTH engine branches.
      const seedKeyframeRing = (baseline: Float32Array) => {
        const maxKeyframes = Math.max(
          2,
          Math.min(KEYFRAME_MAX, Math.floor(KEYFRAME_BUDGET_BYTES / Math.max(1, baseline.byteLength))),
        )
        const interval = Math.max(1, Math.ceil(framesRef.current.length / maxKeyframes))
        keyframeIntervalRef.current = interval
        maxKeyframesRef.current     = maxKeyframes
        keyframesRef.current        = [{ idx: -1, snap: baseline }]
        nextKeyframeIdxRef.current  = interval
        publishStockSync('exact', 0)
      }

      // Resolve the EFFECTIVE stock-sim engine (ADR-0028). The user setting is
      // 'auto' | 'voxel' | 'heightmap'; 'auto' (and an explicit 'voxel' on a GPU
      // that can't run it) fall back to the 2.5D heightmap. ADR-0003: name the
      // fallback in the console rather than silently degrading.
      const voxelSupported = vp?.supportsVoxelSim?.() ?? false
      const useVoxel = simEngineSetting !== 'heightmap' && voxelSupported
      if (!useVoxel && simEngineSetting !== 'heightmap') {
        // WO-1531: name the fallback where the operator can see it (console,
        // not a panel badge - COHESION-STANDARD rule 13).
        useCamStore.getState().addConsoleEvent({
          severity: 'warning',
          source: 'simulation',
          message: tx('SimulationPanel.Census_Voxel_simulation_unavailable_GPU_lacks_WebGL2_float_3D_texture'),
        })
      }

      const bounds = syncStockSimSurface(vp, {
        mode: viewer.mode,
        enabled: stockSimEnabled,
        resolution: stockSimResolution,
        stockId: setup.wcs.stockId,
      })

      // Collect the ops BEFORE the selected op (rest-machining baseline). Same
      // section collection as the frame build (P7): a nest carves all its copies
      // + inter-copy travel; each section resolves its own tool.
      const prevSectionsFor = () => {
        if (!activeId) return []
        const activeSetupIdx = enabledOps.findIndex((operation) => operation.id === activeId)
        const prevOps = activeSetupIdx > 0 ? enabledOps.slice(0, activeSetupIdx) : []
        return collectToolpathSections(prevOps, project.geometry, project.nests)
      }
      const prevCfgForSection = (sec: { toolId?: string }): ToolGeoCfg | null => {
        const prevTool = toolLibrary.find(t => t.id === sec.toolId) ?? null
        return prevTool ? {
          type: prevTool.type, diameter: prevTool.diameter,
          shankDiameter: prevTool.shankDiameter, fluteLength: prevTool.fluteLength,
          shoulderLength: prevTool.shoulderLength ?? prevTool.fluteLength,
          overallLength: prevTool.overallLength,
          cornerRadius: prevTool.cornerRadius ?? 0, angleFromAxisDeg: prevTool.angleFromAxisDeg ?? 59,
          // WO-1964: the neck/tip shape the body, so the pre-carve uses the same
          // tool the op's own playback does (a lollipop's neck width, above all).
          tipDiameter: prevTool.tipDiameter, neckDiameter: prevTool.neckDiameter,
          threadPitch: prevTool.threadPitch, threadTeethCount: prevTool.threadTeethCount,
          threadFormAngleDeg: prevTool.threadFormAngleDeg, neckTransitionAngleDeg: prevTool.neckTransitionAngleDeg,
        } : null
      }

      // WO-1533 / BUG-433: the rest-machining pre-carve (a nested/multi-op job
      // can be thousands of moves) used to always run to completion inline,
      // freezing the page for seconds to tens of seconds. Route it through the
      // same sync-below-threshold / chunk-above-threshold split seekCarve
      // already uses for a large scrub (CARVE_SYNC_MAX/CARVE_CHUNK_BUDGET_MS
      // above), so the ops run in the SAME order either way and only WHEN
      // control returns to the browser changes. `ops` is built as closures so
      // this one loop serves both engines below.
      const runPrecarve = (ops: Array<() => void>, finish: () => void) => {
        if (ops.length <= CARVE_SYNC_MAX) {
          for (const op of ops) op()
          finish()
          return
        }
        let i = 0
        const chunk = () => {
          if (myInitToken !== initTokenRef.current) return  // superseded — abandon
          const deadline = performance.now() + CARVE_CHUNK_BUDGET_MS
          while (i < ops.length && performance.now() < deadline) {
            const op = ops[i]
            op()
            i++
          }
          if (i < ops.length) setTimeout(chunk, 0)
          else finish()
        }
        chunk()
      }

      if (bounds && useVoxel) {
        // Build the world AABB from the same bounds the surface uses.
        const stockBounds: StockBounds = {
          x0: bounds.x0,
          y0: bounds.y0,
          z0: bounds.stockBot,
          x1: bounds.x0 + bounds.nx * bounds.cellSize,
          y1: bounds.y0 + bounds.ny * bounds.cellSize,
          z1: bounds.stockTop,
        }
        // WO-1965: the job's tools go to the simulator so a thread mill's pitch
        // gets a grid fine enough to show its thread.
        const jobTools = new Set<VoxelSimTool>()
        for (const fr of allFrames) if (fr.tool) jobTools.add(fr.tool)
        for (const sec of prevSectionsFor()) jobTools.add(toolShapeCfg(prevCfgForSection(sec)))
        const voxelSim = new VoxelSimulator(stockBounds, stockSimResolution, VOXEL_MAX_VOXELS, [...jobTools])
        if (voxelSim.coarsened) {
          // ADR-0003 / WO-1531: no silent fallback - name the effective voxel
          // size on the console, in display units, where the operator can see it.
          useCamStore.getState().addConsoleEvent({
            severity: 'warning',
            source: 'simulation',
            message: tx('SimulationPanel.Census_Simulation_resolution_coarsened_from_to_to_fit_the_stock', { p1: fmtDim(stockSimResolution, displayUnits), p2: unitLabel(displayUnits), p3: fmtDim(voxelSim.field.dims.voxelSize, displayUnits), p4: unitLabel(displayUnits) }),
          })
        }
        // WO-1533 audit fix: do NOT publish voxelSimRef yet. Until `finish` below
        // has built the baseline snapshot + keyframe ring + mesh, a Play/Rewind/
        // scrub landing in this window must find BOTH engine refs null so seekTo's
        // carve branches no-op instead of carving into (and corrupting) a sim that
        // has no baseline or keyframe yet.
        simRef.current = null

        // Pre-carve previous ops into the voxel field (rest-machining baseline).
        const voxelPrecarveOps: Array<() => void> = []
        for (const sec of prevSectionsFor()) {
          const prevCfg = prevCfgForSection(sec)
          const prevTool = toolShapeCfg(prevCfg)
          const mvs = sampleArcMovesForLinearConsumers(sec.moves)
          for (let i = 1; i < mvs.length; i++) {
            const m = mvs[i], p = mvs[i - 1]
            if (isStockCuttingRole(effectiveMoveRole(m))) {
              voxelPrecarveOps.push(() => voxelSim.sweepMove({ x: p.x, y: p.y, z: p.z }, { x: m.x, y: m.y, z: m.z }, prevTool))
            }
          }
        }

        runPrecarve(voxelPrecarveOps, () => {
          voxelBaselineRef.current = voxelSim.snapshot()
          seedKeyframeRing(voxelBaselineRef.current)
          vp?.initVoxelSim?.(voxelSim.field)
          vp?.syncVoxelSim?.(voxelSim.field)
          // Feature B: a freshly built volume starts opaque — re-apply current opacity.
          const s = useCamStore.getState().viewer
          vp?.setStockSimVisible?.(s.stockSimDisplayMode !== 'target')
          vp?.setStockSimOpacity?.(
            s.stockSimDisplayMode === 'stock' ? 1 : s.stockSimOpacity,
          )
          // Publish LAST: only once the baseline/ring/mesh above are real does
          // seekTo's carve branch treat this engine as active.
          voxelSimRef.current = voxelSim
          publishSimulationStock(voxelSim)
        })
      } else if (bounds) {
        const sim = new HeightmapSimulator(
          bounds.x0, bounds.y0,
          bounds.nx * bounds.cellSize,
          bounds.ny * bounds.cellSize,
          bounds.stockTop, bounds.stockBot,
          bounds.cellSize,
        )
        // WO-1533 audit fix: same reasoning as the voxel branch above -- simRef
        // stays null until `finish` has built the baseline + keyframe ring.
        voxelSimRef.current = null

        // Pre-carve all ops that appear BEFORE the selected op in setup order.
        const heightmapPrecarveOps: Array<() => void> = []
        for (const sec of prevSectionsFor()) {
          const prevCfg = prevCfgForSection(sec)
          const r = (prevCfg?.diameter ?? 6) / 2
          const prevProfile = toolProfile(prevCfg)
          const prevBodyTop = toolBodyTop(prevCfg)
          const mvs = sampleArcMovesForLinearConsumers(sec.moves)
          for (let i = 1; i < mvs.length; i++) {
            const m = mvs[i], p = mvs[i - 1]
            if (isStockCuttingRole(effectiveMoveRole(m))) {
              heightmapPrecarveOps.push(() => sim.sweepMoveWithProfile(p.x, p.y, p.z, m.x, m.y, m.z, r, prevProfile, prevBodyTop))
            }
          }
        }

        runPrecarve(heightmapPrecarveOps, () => {
          baseHeightsRef.current = sim.snapshot()
          seedKeyframeRing(baseHeightsRef.current)
          vp?.updateStockSimHeights?.(sim.heights)
          // Feature B: a freshly built mesh starts opaque — re-apply current opacity.
          const s = useCamStore.getState().viewer
          vp?.setStockSimVisible?.(s.stockSimDisplayMode !== 'target')
          vp?.setStockSimOpacity?.(
            s.stockSimDisplayMode === 'stock' ? 1 : s.stockSimOpacity,
          )
          // Publish LAST: only once the baseline/ring above are real does seekTo's
          // carve branch treat this engine as active.
          simRef.current = sim
          publishSimulationStock(sim)
        })
      } else {
        simRef.current = null
        voxelSimRef.current = null
      }
    }
    } catch (err) {
      // View-scoped failure: keep the app alive, name the reason in the panel.
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[simulation] Toolpath preview failed to build; keeping the app alive:', err)
      clear()
      setFrameBuildError(msg)
    }
  }, [toolpathKey, viewer.mode, stockSimEnabled, stockSimResolution, simEngineSetting, syncToolpathLayerPreview, toolLibrary, holders, applyToolCfg, publishStockSync])

  // UI-44: one display-mode seam owns both stock visibility and effective
  // opacity. Compare honors the slider, Stock is opaque, and Target hides only
  // the simulated stock body. Viewport.tsx applies the paired target-model
  // visibility from the same viewer mode.
  useEffect(() => {
    const vp = getVp()
    vp?.setStockSimVisible?.(stockSimDisplayMode !== 'target')
    vp?.setStockSimOpacity?.(
      stockSimDisplayMode === 'stock' ? 1 : stockSimOpacity,
    )
  }, [stockSimDisplayMode, stockSimOpacity])

  // ── Tool marker visibility ──────────────────────────────────────────────────
  useEffect(() => {
    const visible = viewer.mode === 'simulation'
    getVp()?.showToolMarker?.(visible)
    if (visible && currentPositionRef.current) {
      const { machine } = currentPositionRef.current
      getVp()?.setToolMarkerPosition?.(machine.x, machine.y, machine.z)
    }
    if (!visible) {
      isPlayingRef.current = false
      setIsPlaying(false)
      cancelAnimationFrame(rafIdRef.current)
      getVp()?.disposeStockSim?.()
      getVp()?.disposeVoxelSim?.()
      simRef.current = null
      voxelSimRef.current = null
      publishSimulationStock(null)
    }
  }, [viewer.mode])

  // P1: async-carve progress chrome (driven via DOM refs to avoid re-render
  // churn, like timeNow/role). Shown only while a large carve runs in chunks.
  const showCarveProgress = useCallback(() => {
    if (carveProgressRef.current) carveProgressRef.current.style.display = 'flex'
  }, [])
  const setCarveProgress = useCallback((done: number, total: number) => {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100
    if (carveProgressFillRef.current) carveProgressFillRef.current.style.width = pct + '%'
    if (carveProgressTextRef.current) carveProgressTextRef.current.textContent = tx('SimulationPanel.Simulating', { p1: pct })
  }, [])
  const hideCarveProgress = useCallback(() => {
    if (carveProgressRef.current) carveProgressRef.current.style.display = 'none'
  }, [])

  // Keyframe-aware carve cursor advance, shared by both stock-sim engines. The
  // target is frame `targetIdx` at `fraction` of its duration: frames before it
  // are COMPLETED and carve to their endpoints, the active frame carves only its
  // elapsed prefix (WO-1538 - the marker and the stock read the same notion of
  // "how far into this move"). It (1) drops any prefix left by the previous seek
  // (restores the pre-prefix field), (2) finds the nearest keyframe <= the last
  // completed frame, (3) either keeps the live field (already carved within
  // [keyframe, target]) or restores that keyframe, (4) DURING A DRAG stops there
  // (instant approximation, published as 'preview'), else (5) carves forward to
  // the exact target, capturing keyframes en route, then the active prefix. A
  // large forward span chunks across macrotasks (non-blocking) with a progress
  // bar; small spans + playback stay inline. Because the carve is deterministic,
  // restore(keyframe)+carve == carve-from-0 byte-for-byte regardless of chunking.
  const seekCarve = useCallback((
    targetIdx: number,
    fraction: number,
    baselineSnap: Float32Array | null,
    snapshot: () => Float32Array,
    liveData: () => Float32Array,
    restore: (s: Float32Array) => void,
    reset: () => void,
    carveFrame: (fi: number) => void,
    carvePrefix: (fi: number, fraction: number) => void,
    frameCuts: (fi: number) => boolean,
    syncGpu: () => void,
  ) => {
    const frames = framesRef.current
    // Frames before the target are complete; the target itself only once its
    // whole duration has elapsed.
    const fullTarget = fraction >= 1 ? targetIdx : targetIdx - 1
    const prefixNeeded = fraction > 0 && fraction < 1 && frameCuts(targetIdx)
    const endMsOf = (fi: number) => fi >= 0 ? frames[fi].startMs + frames[fi].durationMs : (frames[0]?.startMs ?? 0)

    // The previous seek's prefix is never kept: it belongs to one playhead time.
    if (partialIdxRef.current >= 0 && activeBaseRef.current) {
      restore(activeBaseRef.current)
      lastCarvedIdxRef.current = partialIdxRef.current - 1
    }
    partialIdxRef.current = -1

    const kfs = keyframesRef.current
    // Nearest keyframe at or before the target (idx -1 = baseline always qualifies).
    let startKf: { idx: number; snap: Float32Array } | null = null
    for (let k = kfs.length - 1; k >= 0; k--) {
      if (kfs[k].idx <= fullTarget) { startKf = kfs[k]; break }
    }

    const lastCarved = lastCarvedIdxRef.current
    if (startKf && lastCarved >= startKf.idx && lastCarved <= fullTarget) {
      // The live field already sits between the keyframe and the target — carve
      // forward incrementally, no restore (handles normal playback + small seeks).
    } else if (startKf) {
      // Backward seek or big forward jump — jump straight to the nearest keyframe.
      restore(startKf.snap)
      lastCarvedIdxRef.current = startKf.idx
    } else {
      // Ring not seeded (defensive; the init effect seeds it) — restore the
      // baseline (preserves rest-machining) or hard-reset if even that is absent.
      if (baselineSnap) restore(baselineSnap)
      else reset()
      lastCarvedIdxRef.current = -1
    }

    // Supersede any in-flight async carve: a newer seek now owns the field, so
    // the old chunk loop must abandon at its next checkpoint (it captured the
    // previous token). Bumped for EVERY seek, incl. drag/inline, so a fast inline
    // path cancels a pending settle too.
    const myToken = ++carveTokenRef.current

    // DRAG = approximate: leave the field at the keyframe (only a ~2-4ms restore),
    // push it to the GPU, and stop; the tool marker still moved to the EXACT
    // target above. The panel says the stock lags when it does. Release settles
    // it to the exact frame + elapsed prefix.
    if (isScrubbingRef.current) {
      syncGpu()
      const carvedTo = lastCarvedIdxRef.current
      if (carvedTo !== fullTarget || prefixNeeded) {
        publishStockSync('preview', endMsOf(carvedTo))
      } else {
        hideCarveProgress()
        publishStockSync('exact', currentMsRef.current)
      }
      return
    }

    const interval = keyframeIntervalRef.current
    const maxKf    = maxKeyframesRef.current
    const carveOne = (fi: number) => {
      carveFrame(fi)
      lastCarvedIdxRef.current = fi
      // Lazily grow the ring as we carve forward (ascending idx, capped).
      if (fi >= nextKeyframeIdxRef.current && keyframesRef.current.length < maxKf) {
        keyframesRef.current.push({ idx: fi, snap: snapshot() })
        nextKeyframeIdxRef.current += interval
      }
    }
    // Carve the active frame's elapsed prefix on top of the completed frames,
    // keeping the completed-frames field so the next seek can drop the prefix.
    const carveActivePrefix = () => {
      if (!prefixNeeded) return
      const live = liveData()
      let base = activeBaseRef.current
      if (!base || base.length !== live.length) base = activeBaseRef.current = new Float32Array(live.length)
      base.set(live)
      carvePrefix(targetIdx, fraction)
      partialIdxRef.current = targetIdx
    }

    const start = lastCarvedIdxRef.current + 1
    const span  = fullTarget - start + 1

    // Small span (normal playback advance, tiny seek) carves inline — instant,
    // no progress chrome. Playback always stays inline so the rAF loop carves
    // continuously instead of stuttering through macrotasks.
    if (span <= CARVE_SYNC_MAX || isPlayingRef.current) {
      for (let fi = start; fi <= fullTarget; fi++) carveOne(fi)
      carveActivePrefix()
      syncGpu()
      hideCarveProgress()
      publishStockSync('exact', currentMsRef.current)
      return
    }

    // Large jump — chunk the carve across macrotasks so the main thread never
    // blocks for more than ~one frame budget. The stock recedes live per chunk,
    // a progress bar shows it is working, and a newer seek cancels via the token.
    let fi = start
    showCarveProgress()
    setCarveProgress(0, span)
    publishStockSync('settling', endMsOf(start - 1))
    const settledMs = currentMsRef.current
    const carveChunk = () => {
      if (myToken !== carveTokenRef.current) return  // superseded — abandon
      const deadline = performance.now() + CARVE_CHUNK_BUDGET_MS
      while (fi <= fullTarget && performance.now() < deadline) { carveOne(fi); fi++ }
      if (fi > fullTarget) carveActivePrefix()
      syncGpu()
      setCarveProgress(fi - start, span)
      if (fi <= fullTarget) {
        publishStockSync('settling', endMsOf(fi - 1))
        setTimeout(carveChunk, 0)
      } else {
        hideCarveProgress()
        publishStockSync('exact', settledMs)
      }
    }
    carveChunk()
  }, [showCarveProgress, setCarveProgress, hideCarveProgress, publishStockSync])

  // ── Seek ───────────────────────────────────────────────────────────────────
  const seekTo = useCallback((ms: number) => {
    const frames = framesRef.current
    if (frames.length === 0) return
    currentMsRef.current = Math.max(0, Math.min(ms, totalMsRef.current))

    let lo = 0, hi = frames.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (frames[mid].startMs <= currentMsRef.current) lo = mid
      else hi = mid - 1
    }
    const f = frames[lo]
    syncToolpathLayerPreview(lo)
    currentFrameRef.current = f
    const position = currentWcsRef.current
      ? resolvePlaybackPosition(f, currentMsRef.current, currentWcsRef.current)
      : null
    currentPositionRef.current = position
    if (position) {
      getVp()?.setToolMarkerPosition?.(
        position.machine.x,
        position.machine.y,
        position.machine.z,
      )
    }

    const timeline = toolTimelineRef.current
    if (timeline.length > 0) {
      let tIdx = 0
      for (let i = 1; i < timeline.length; i++) {
        if (timeline[i].startMs <= currentMsRef.current) tIdx = i
      }
      applyToolCfg(timeline[tIdx].cfg)
    }

    // ── Stock sim carving ──────────────────────────────────────────────────
    // One engine is active at a time (ADR-0028; the init effect sets exactly one
    // of voxelSimRef/simRef per the effective engine); the other ref is null. Both
    // share the keyframe-aware seekCarve cursor (replaces the old restore-baseline-
    // and-recarve-from-0 backward path that froze the scrubber on dense decks).
    const voxelSim = voxelSimRef.current
    const sim = simRef.current
    // WO-1538: the SAME elapsed fraction the marker uses (resolvePlaybackPosition)
    // bounds how far into the active frame the stock is carved.
    const fraction = f.durationMs > 0
      ? Math.max(0, Math.min(1, (currentMsRef.current - f.startMs) / f.durationMs))
      : 1
    const along = (fr: SimFrame, t: number) => ({
      x: fr.fromX + t * (fr.toX - fr.fromX),
      y: fr.fromY + t * (fr.toY - fr.fromY),
      z: fr.fromZ + t * (fr.toZ - fr.fromZ),
    })
    if (voxelSim) {
      const voxelCuts = (fi: number) => isStockCuttingRole(frames[fi].role) && !!frames[fi].tool
      const sweepTo = (fi: number, t: number) => {
        const fr = frames[fi]
        if (voxelCuts(fi)) voxelSim.sweepMove({ x: fr.fromX, y: fr.fromY, z: fr.fromZ }, along(fr, t), fr.tool!)
      }
      seekCarve(
        lo,
        fraction,
        voxelBaselineRef.current,
        () => voxelSim.snapshot(),
        () => voxelSim.field.data,
        (s) => voxelSim.restore(s),
        () => voxelSim.reset(),
        (fi) => sweepTo(fi, 1),
        sweepTo,
        voxelCuts,
        // syncGpu: seekCarve calls this per chunk (and once at the end / on a
        // drag restore) so the receding stock updates live without a trailing
        // sync here that would miss the async chunks.
        () => getVp()?.syncVoxelSim?.(voxelSim.field),
      )
    } else if (sim) {
      const heightCuts = (fi: number) => isStockCuttingRole(frames[fi].role)
      const sweepTo = (fi: number, t: number) => {
        const fr = frames[fi]
        if (!heightCuts(fi)) return
        const to = along(fr, t)
        sim.sweepMoveWithProfile(fr.fromX, fr.fromY, fr.fromZ, to.x, to.y, to.z, fr.toolRadius, fr.profile, fr.bodyTop)
      }
      seekCarve(
        lo,
        fraction,
        baseHeightsRef.current,
        () => sim.snapshot(),
        () => sim.heights,
        (s) => sim.restore(s),
        () => sim.reset(),
        (fi) => sweepTo(fi, 1),
        sweepTo,
        heightCuts,
        () => getVp()?.updateStockSimHeights?.(sim.heights),
      )
    }

    if (scrubberRef.current) {
      scrubberRef.current.value = String(currentMsRef.current)
      scrubberRef.current.setAttribute('aria-valuetext', formatTime(currentMsRef.current))
    }
    if (timeNowRef.current)  timeNowRef.current.textContent  = formatTime(currentMsRef.current)
    if (moveReadoutRef.current) {
      moveReadoutRef.current.textContent = formatMoveReadout(f, displayUnits)
    }
    if (positionReadoutRef.current) {
      positionReadoutRef.current.textContent = formatPositionReadout(currentPositionRef.current?.work ?? null, displayUnits)
    }
  }, [applyToolCfg, displayUnits, seekCarve, syncToolpathLayerPreview])

  // WO-1500: the scrubber arms only after the frame rebuild flips totalMsState
  // from 0, so at the moment the rebuild effect writes the ref the <input> is
  // still unmounted (ref null) -- the same first-mount race the max prop comment
  // above documents. Re-sync the announced value once the slider is actually in
  // the DOM; seekTo owns it thereafter on every scrub/playback tick.
  useEffect(() => {
    if (scrubberRef.current) {
      scrubberRef.current.setAttribute('aria-valuetext', formatTime(currentMsRef.current))
    }
  }, [totalMsState])

  const animate = useCallback((realTime: number) => {
    if (!isPlayingRef.current) return
    if (lastRealTimeRef.current !== null) {
      const realDt = realTime - lastRealTimeRef.current
      seekTo(simAdvance(currentMsRef.current, realDt, speedRef.current))
      if (currentMsRef.current >= totalMsRef.current) {
        isPlayingRef.current = false
        setIsPlaying(false)
        lastRealTimeRef.current = null
        return
      }
    }
    lastRealTimeRef.current = realTime
    rafIdRef.current = requestAnimationFrame(animate)
  }, [seekTo])

  const handlePlay = useCallback(() => {
    if (framesRef.current.length === 0) return
    if (currentMsRef.current >= totalMsRef.current) seekTo(0)
    isPlayingRef.current = true
    setIsPlaying(true)
    lastRealTimeRef.current = null
    rafIdRef.current = requestAnimationFrame(animate)
  }, [animate, seekTo])

  const handlePause = useCallback(() => {
    isPlayingRef.current = false
    setIsPlaying(false)
    cancelAnimationFrame(rafIdRef.current)
    lastRealTimeRef.current = null
  }, [])

  const handleRewind    = useCallback(() => { handlePause(); seekTo(0) },                   [handlePause, seekTo])
  const handleSkipEnd   = useCallback(() => { handlePause(); seekTo(totalMsRef.current) },  [handlePause, seekTo])
  const handleScrubberChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handlePause(); seekTo(parseFloat(e.target.value))
  }, [handlePause, seekTo])

  // Scrubber drag lifecycle. While the pointer is down, isScrubbingRef makes every
  // onChange seek APPROXIMATE (restore nearest keyframe only, instant). On
  // release we clear the flag and seek once more to SETTLE the field to the exact
  // frame. Keyboard / programmatic seeks never set the flag, so they stay exact.
  const handleScrubberPointerDown = useCallback(() => {
    isScrubbingRef.current = true
    handlePause()
  }, [handlePause])
  const handleScrubberPointerUp = useCallback(() => {
    if (!isScrubbingRef.current) return
    isScrubbingRef.current = false
    seekTo(currentMsRef.current)
  }, [seekTo])

  const handleSpeedChange = useCallback((idx: number) => {
    setSpeedIdx(idx)
    speedRef.current = SPEED_OPTIONS[idx]
  }, [])

  const handleToggleStockSim = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked
    setStockSimEnabled(enabled)
    if (!enabled) {
      getVp()?.disposeStockSim?.()
      getVp()?.disposeVoxelSim?.()
      simRef.current = null
      voxelSimRef.current = null
      publishSimulationStock(null)
    }
  }, [setStockSimEnabled])

  useEffect(() => () => {
    cancelAnimationFrame(rafIdRef.current)
    getVp()?.setSimulationToolpathPreview?.(null)
    publishSimulationStock(null)
  }, [])

  if (viewer.mode === 'toolpath') {
    return (
      <div className="sim-panel" ref={panelRef} data-testid="toolpath-feed-estimate-panel">
        <ToolpathFeedEstimatePanel showEmpty />
      </div>
    )
  }
  if (viewer.mode !== 'simulation') return null

  // UI-BRAND-B2-9: nothing generated yet (fresh project, no operation
  // selected, or the selected operation hasn't been computed) -- totalMsState
  // is set to exactly 0 by the frame-rebuild effect's clear() path and to the
  // real cumulative playback time otherwise, so it is already the single
  // source of truth for "is there anything to play back."
  const isIdle = totalMsState <= 0

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- covers
    // this panel's own children too (speed flyout etc.), already COHESIVE in
    // the UI-70 census.
    <div className="sim-panel" ref={panelRef} data-ui78-sanctioned="">
      <ToolpathFeedEstimatePanel />
      {frameBuildError ? (
        // View-scoped failure notice: the frame build refused a move (or errored). The
        // app stays alive; only this preview is unavailable, with the named reason.
        <div className="op-no-tool-notice sim-empty-state" role="alert" data-testid="sim-frame-error">
          <MonitorPlay size={28} />
          <span className="op-no-tool-title">{tx('SimulationPanel.Toolpath_preview_unavailable')}</span>
          <span className="op-no-tool-body">{frameBuildError}</span>
        </div>
      ) : isIdle ? (
        // Empty-state callout (B2-8's shared "nothing to show yet" primitive)
        // instead of a fully-armed scrubber sitting at a permanent 00:00/00:00.
        <div className="op-no-tool-notice sim-empty-state">
          <MonitorPlay size={28} />
          <span className="op-no-tool-title">
            {activeOpName ? tx('SimulationPanel.Generate_to_simulate', { p1: activeOpName }) : tx('SimulationPanel.Generate_an_operation_to_simulate')}
          </span>
          <span className="op-no-tool-body">
            {activeOpName
              ? tx('SimulationPanel.Compute_this_operation_s_toolpath_in_Setup_or_Toolpath')
              : tx('SimulationPanel.Select_or_create_an_operation_compute_its_toolpath_then')}
          </span>
        </div>
      ) : (
        <div className="sim-scrubber-row">
          <span ref={timeNowRef} className="sim-time">{tx('SimulationPanel.00_00')}</span>
          <input
            ref={scrubberRef}
            type="range"
            className="sim-scrubber"
            aria-label={tx('SimulationPanel.Simulation_position')}
            min={0}
            // UI-BRAND-B2-9: max is now ALSO a real React prop (was set only
            // imperatively via scrubberRef.current.max inside the frame-
            // rebuild effect). That effect's own ref-write still runs, but
            // this scrubber is now conditionally mounted (idle -> armed), so
            // the very first time it mounts after being idle, the ref is
            // still null when the effect's imperative set fires -- without
            // this declarative prop the freshly-mounted <input> would fall
            // back to the native default max="100" and silently clamp real
            // seeks past 100ms. Declarative + imperative both write the same
            // value (cumulativeMs === totalMsState), so this is redundant,
            // not conflicting, on every render after the first.
            max={totalMsState}
            defaultValue={0}
            step={1}
            onChange={handleScrubberChange}
            onPointerDown={handleScrubberPointerDown}
            onPointerUp={handleScrubberPointerUp}
            onPointerCancel={handleScrubberPointerUp}
          />
          <span className="sim-time">{formatTime(totalMsState)}</span>
        </div>
      )}

      {/* P1: live progress for a chunked async carve (a far seek / settle).
          Hidden by default; shown only while a large carve is running so the
          user knows the simulation is updating, not locked. Driven via DOM refs
          (no React re-render churn). */}
      <div
        ref={carveProgressRef}
        className="sim-carve-progress"
        style={{ display: 'none', alignItems: 'center', gap: '6px', marginTop: '2px' }}
      >
        <div style={{ flex: 1, height: '4px', background: 'rgba(127,127,127,0.3)', borderRadius: '2px', overflow: 'hidden' }}>
          <div ref={carveProgressFillRef} style={{ width: '0%', height: '100%', background: 'var(--accent, #4ea1ff)' }} />
        </div>
        <span ref={carveProgressTextRef} style={{ fontSize: '11px', opacity: 0.8, minWidth: '82px', textAlign: 'right' }}>{tx('SimulationPanel.Simulating_0')}</span>
      </div>

      <div className="sim-controls">
        <button className="sim-btn" onClick={handleRewind} disabled={isIdle} data-tooltip={tx('SimulationPanel.Rewind_to_start')}
        aria-label={tx('SimulationPanel.Rewind_to_start')}>
          <SkipBack size={14} />
        </button>
        {isPlaying
          ? <button className="sim-btn sim-btn-primary" onClick={handlePause} disabled={isIdle} aria-label={tx('SimulationPanel.Pause')}><Pause size={14} /></button>
          : <button className="sim-btn sim-btn-primary" onClick={handlePlay} disabled={isIdle} aria-label={tx('SimulationPanel.Play')}><Play  size={14} /></button>
        }
        <button className="sim-btn" onClick={handleSkipEnd} disabled={isIdle} data-tooltip={tx('SimulationPanel.Skip_to_end')}
        aria-label={tx('SimulationPanel.Skip_to_end')}>
          <SkipForward size={14} />
        </button>

        {/* P9: one compact chip shows the current speed; the presets open as a
            flyout above it. Store/keyboard speed semantics are untouched -
            handleSpeedChange is the same setter the buttons called. */}
        <div className="sim-speed-group" ref={speedGroupRef}>
          <span className="sim-speed-label">{tx('SimulationPanel.Speed')}</span>
          <button
            className="sim-speed-chip"
            data-testid="sim-speed-chip"
            onClick={() => setSpeedFlyoutOpen(o => !o)}
            data-tooltip={tx('SimulationPanel.Playback_speed')}
          >{tx('SimulationPanel.x', { p1: SPEED_OPTIONS[speedIdx] })}<ChevronUp size={11} className="sim-speed-chip-caret" />
          </button>
          {speedFlyoutOpen && (
            <div className="sim-speed-flyout" data-testid="sim-speed-flyout">
              {SPEED_OPTIONS.map((s, i) => (
                <button
                  key={s}
                  className={`sim-speed-btn${speedIdx === i ? ' sim-speed-active' : ''}`}
                  onClick={() => { handleSpeedChange(i); setSpeedFlyoutOpen(false) }}
                >{tx('SimulationPanel.x', { p1: s })}</button>
              ))}
            </div>
          )}
        </div>

        <span className="sim-role-badge">
          <span
            ref={positionReadoutRef}
            className="sim-position-readout"
            data-testid="sim-position-readout"
          >
            {formatPositionReadout(null, displayUnits)}
          </span>
          <span ref={moveReadoutRef} className="sim-move-readout badge badge-neutral">
            {formatMoveReadout(null, displayUnits)}
          </span>
        </span>
      </div>

      <div className="sim-stock-row">
        <label className="sim-stock-check">
          <input
            type="checkbox"
            checked={stockSimEnabled}
            onChange={handleToggleStockSim}
          />{tx('SimulationPanel.Simulate_Stock_Removal')}</label>
        {stockSimEnabled && (
          <select
            className="sim-res-select"
            value={stockSimResolution}
            onChange={e => setStockSimResolution(parseFloat(e.target.value))}
          >
            {RES_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {fmtDim(o.value, displayUnits)} {unitLabel(displayUnits)}{tx('SimulationPanel.symbol')}{o.tag}{tx('SimulationPanel.symbol_2')}</option>
            ))}
          </select>
        )}
      </div>

      {stockSimEnabled && (
        <div className="sim-stock-row">
          <div
            role="radiogroup"
            aria-label={tx('SimulationPanel.Simulation_display')}
            data-testid="sim-display-modes"
            style={{ display: 'flex', gap: 4 }}
          >
            {([
              ['stock', tx('SimulationPanel.Cut_Stock')],
              ['compare', tx('SimulationPanel.Compare')],
              ['target', tx('SimulationPanel.Target')],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`sim-speed-btn${stockSimDisplayMode === mode ? ' sim-speed-active' : ''}`}
                data-testid={`sim-display-${mode}`}
                aria-pressed={stockSimDisplayMode === mode}
                onClick={() => setStockSimDisplayMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Feature A: hide the toolpath lines so the busy path stops obscuring
              the receding stock (sim view only). Default unchecked = VISIBLE. */}
          <label className="sim-stock-check">
            <input
              type="checkbox"
              data-testid="sim-hide-toolpath"
              checked={simHideToolpath}
              onChange={e => setSimHideToolpath(e.target.checked)}
            />{tx('SimulationPanel.Hide_Toolpath')}</label>
          {/* Feature B: make the simulated stock translucent so the target model
              shows through and the user can judge how close the cut got. */}
          {stockSimDisplayMode === 'compare' && (
            <label className="sim-opacity-label">{tx('SimulationPanel.Stock_opacity')}<input
                type="range"
                className="sim-opacity-slider"
                data-testid="sim-stock-opacity"
                min={0.15}
                max={1}
                step={0.05}
                value={stockSimOpacity}
                onChange={e => setStockSimOpacity(parseFloat(e.target.value))}
              />
              <span className="sim-opacity-value">{Math.round(stockSimOpacity * 100)}{tx('SimulationPanel.symbol_3')}</span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
