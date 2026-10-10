// Surface-mesh probing and compensation.
//
// The measured rectangle is deliberately derived from CUTTING moves, never
// rapids. Inside it, compensation is bilinearly interpolated. Outside it, the
// nearest edge value eases to zero over a spatial fade band so crossing the
// boundary cannot create a Z shelf. The program compiler then subdivides
// motion where needed so GRBL receives the same smooth surface as the preview.

import { stripGcodeComments, type StreamLine } from '../gcode/text'
import { computeCutBounds, type FitBounds } from './materialFit'
import { buildPreviewModel, type PreviewPolyline } from './previewGeometry'

export interface SurfaceMeshBounds extends FitBounds {}

export interface SurfaceMeshSetup {
  bounds: SurfaceMeshBounds
  cutBounds: SurfaceMeshBounds
  marginMm: number
  pointsX: number
  pointsY: number
  fadeMm: number
}

export interface SurfaceMeshPoint {
  row: number
  column: number
  x: number
  y: number
}

export interface SurfaceMeshSample extends SurfaceMeshPoint {
  machineZ: number
}

// WO-1822 / ADR-0050 G5 - THE MAP HAS NO STATED PRECISION, AND THIS IS WHERE
// IT BINDS. Every sample below is the established two-pass Z touch, whose
// trigger repeatability nothing has yet measured. A surface touch is largely
// insensitive to tip diameter, but the map's worst-case error is bounded by
// that repeatability, and for a 0.1 mm PCB isolation cut the bound IS the
// product. WO-1817 (probe calibration) is what states the number. When it
// does, it lands here as a recorded field on SurfaceMeshMap and shows in the
// readout - this order does not invent one.
export interface SurfaceMeshMap {
  bounds: SurfaceMeshBounds
  cutBounds: SurfaceMeshBounds
  pointsX: number
  pointsY: number
  fadeMm: number
  referenceMachineZ: number
  samples: SurfaceMeshSample[]
  sourceFingerprint: string
  sourceName: string | null
  workOffset: string
  /** The X/Y/Z VALUES that offset held when the grid was measured (WO-1822,
   * ADR-0050 G2). The offset's NAME is not its identity: re-zeroing X, Y or Z
   * on the same G54 after mapping slides the program across the measured
   * surface while every name-based check still passes, and a silent wrong Z is
   * the failure Operator named. Optional because a controller that has not
   * reported its offsets leaves nothing to compare - and because a mesh built
   * before this field existed must still be readable, not migrated. */
  workOffsetValues?: number[] | null
  probedAt: number
  active: boolean
}

export interface SurfaceCompensationResult {
  offsetMm: number
  fadeWeight: number
  insideMeasuredArea: boolean
}

export type SurfaceMeshPlanResult =
  | { ok: true; setup: SurfaceMeshSetup; points: SurfaceMeshPoint[] }
  | { ok: false; reason: string }

export type SurfaceMeshCompileResult =
  | { ok: true; lines: StreamLine[]; generatedMotionLines: number }
  | { ok: false; reason: string }

export const DEFAULT_MESH_MARGIN_MM = 2
export const DEFAULT_MESH_POINTS = 5
export const DEFAULT_MESH_FADE_MM = 10
export const DEFAULT_MESH_SEGMENT_MM = 5
export const DEFAULT_MESH_SPLIT_DELTA_Z_MM = 0.025

const EPS = 1e-9

function finiteBounds(bounds: SurfaceMeshBounds): boolean {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
}

function validPointCount(value: number): boolean {
  return Number.isInteger(value) && value >= 3 && value <= 25
}

export function fingerprintProgram(programText: string): string {
  // Small deterministic FNV-1a fingerprint. This is an identity guard, not a
  // security hash: a mesh may never remain armed when the loaded text changes.
  let hash = 0x811c9dc5
  for (let i = 0; i < programText.length; i++) {
    hash ^= programText.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function expandSurfaceBounds(bounds: SurfaceMeshBounds, marginMm: number): SurfaceMeshBounds {
  return {
    minX: bounds.minX - marginMm,
    minY: bounds.minY - marginMm,
    maxX: bounds.maxX + marginMm,
    maxY: bounds.maxY + marginMm,
  }
}

export function buildSurfaceMeshPoints(
  bounds: SurfaceMeshBounds,
  pointsX: number,
  pointsY: number,
): SurfaceMeshPoint[] {
  if (!finiteBounds(bounds) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return []
  if (!validPointCount(pointsX) || !validPointCount(pointsY)) return []
  const points: SurfaceMeshPoint[] = []
  for (let row = 0; row < pointsY; row++) {
    const y = bounds.minY + ((bounds.maxY - bounds.minY) * row) / (pointsY - 1)
    const columns = Array.from({ length: pointsX }, (_, column) => column)
    if (row % 2 === 1) columns.reverse()
    for (const column of columns) {
      points.push({
        row,
        column,
        x: bounds.minX + ((bounds.maxX - bounds.minX) * column) / (pointsX - 1),
        y,
      })
    }
  }
  return points
}

export function planSurfaceMesh(
  programText: string | null,
  overrides: Partial<Pick<SurfaceMeshSetup, 'bounds' | 'marginMm' | 'pointsX' | 'pointsY' | 'fadeMm'>> = {},
): SurfaceMeshPlanResult {
  if (!programText) return { ok: false, reason: 'Load a program to derive the active cutting area.' }
  const cut = computeCutBounds(buildPreviewModel(programText))
  if (!cut.ok) return { ok: false, reason: cut.reason }
  const marginMm = overrides.marginMm ?? DEFAULT_MESH_MARGIN_MM
  const pointsX = overrides.pointsX ?? DEFAULT_MESH_POINTS
  const pointsY = overrides.pointsY ?? DEFAULT_MESH_POINTS
  const fadeMm = overrides.fadeMm ?? DEFAULT_MESH_FADE_MM
  if (!Number.isFinite(marginMm) || marginMm < 0) {
    return { ok: false, reason: 'Mesh margin must be zero or greater.' }
  }
  if (!validPointCount(pointsX) || !validPointCount(pointsY)) {
    return { ok: false, reason: 'Mesh point counts must be whole numbers from 3 to 25.' }
  }
  if (!Number.isFinite(fadeMm) || fadeMm <= 0) {
    return { ok: false, reason: 'Mesh fade distance must be greater than zero.' }
  }
  const bounds = overrides.bounds ?? expandSurfaceBounds(cut.bounds, marginMm)
  if (!finiteBounds(bounds) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    return { ok: false, reason: 'Mesh minimums must be below the maximums on both axes.' }
  }
  if (
    bounds.minX > cut.bounds.minX + EPS || bounds.minY > cut.bounds.minY + EPS
    || bounds.maxX < cut.bounds.maxX - EPS || bounds.maxY < cut.bounds.maxY - EPS
  ) {
    return {
      ok: false,
      reason: 'The measured mesh must cover every cutting move. Expand the area or reset it to the cutting bounds.',
    }
  }
  const points = buildSurfaceMeshPoints(bounds, pointsX, pointsY)
  if (points.length === 0) return { ok: false, reason: 'The mesh grid could not be built from these values.' }
  return {
    ok: true,
    setup: { bounds, cutBounds: cut.bounds, marginMm, pointsX, pointsY, fadeMm },
    points,
  }
}

function sampleGrid(mesh: SurfaceMeshMap): SurfaceMeshSample[][] | null {
  if (mesh.samples.length !== mesh.pointsX * mesh.pointsY) return null
  const grid: Array<Array<SurfaceMeshSample | undefined>> = Array.from(
    { length: mesh.pointsY },
    () => Array.from({ length: mesh.pointsX }),
  )
  for (const sample of mesh.samples) {
    if (sample.row < 0 || sample.row >= mesh.pointsY || sample.column < 0 || sample.column >= mesh.pointsX) return null
    grid[sample.row][sample.column] = sample
  }
  return grid.every((row) => row.every(Boolean)) ? grid as SurfaceMeshSample[][] : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

export function surfaceCompensationAt(
  mesh: SurfaceMeshMap,
  x: number,
  y: number,
): SurfaceCompensationResult | null {
  const grid = sampleGrid(mesh)
  if (!grid || !finiteBounds(mesh.bounds) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const width = mesh.bounds.maxX - mesh.bounds.minX
  const height = mesh.bounds.maxY - mesh.bounds.minY
  if (width <= 0 || height <= 0 || !Number.isFinite(mesh.fadeMm) || mesh.fadeMm <= 0) return null

  const cx = clamp(x, mesh.bounds.minX, mesh.bounds.maxX)
  const cy = clamp(y, mesh.bounds.minY, mesh.bounds.maxY)
  const gx = ((cx - mesh.bounds.minX) / width) * (mesh.pointsX - 1)
  const gy = ((cy - mesh.bounds.minY) / height) * (mesh.pointsY - 1)
  const x0 = Math.min(mesh.pointsX - 2, Math.floor(gx))
  const y0 = Math.min(mesh.pointsY - 2, Math.floor(gy))
  const x1 = x0 + 1
  const y1 = y0 + 1
  const tx = clamp(gx - x0, 0, 1)
  const ty = clamp(gy - y0, 0, 1)
  const z00 = grid[y0][x0].machineZ
  const z10 = grid[y0][x1].machineZ
  const z01 = grid[y1][x0].machineZ
  const z11 = grid[y1][x1].machineZ
  const z0 = z00 + (z10 - z00) * tx
  const z1 = z01 + (z11 - z01) * tx
  const measuredOffset = z0 + (z1 - z0) * ty - mesh.referenceMachineZ

  const dx = x < mesh.bounds.minX
    ? mesh.bounds.minX - x
    : x > mesh.bounds.maxX ? x - mesh.bounds.maxX : 0
  const dy = y < mesh.bounds.minY
    ? mesh.bounds.minY - y
    : y > mesh.bounds.maxY ? y - mesh.bounds.maxY : 0
  const outsideDistance = Math.hypot(dx, dy)
  const insideMeasuredArea = outsideDistance <= EPS
  const fadeWeight = insideMeasuredArea
    ? 1
    : smoothstep01(1 - outsideDistance / mesh.fadeMm)
  return { offsetMm: measuredOffset * fadeWeight, fadeWeight, insideMeasuredArea }
}

function words(line: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const regex = /([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    const key = match[1].toUpperCase()
    const values = out.get(key) ?? []
    values.push(Number(match[2]))
    out.set(key, values)
  }
  return out
}

function hasCode(lineWords: Map<string, number[]>, letter: string, code: number): boolean {
  return lineWords.get(letter)?.some((value) => Math.abs(value - code) < EPS) ?? false
}

interface GcodeToken {
  letter: string
  value: number
  /** The word exactly as the operator wrote it, so G01 stays G01. */
  text: string
}

function tokensOf(line: string): GcodeToken[] {
  const out: GcodeToken[] = []
  const regex = /([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    out.push({
      letter: match[1].toUpperCase(),
      value: Number(match[2]),
      text: `${match[1].toUpperCase()}${match[2]}`,
    })
  }
  return out
}

const isCode = (token: GcodeToken, letter: string, code: number): boolean =>
  token.letter === letter && Math.abs(token.value - code) < EPS

/** Words that mean a LENGTH in the program's active units. Every one of these
 * on a MOTION line is resolved to mm by the preview model before it reaches
 * this compiler; on a non-motion command (a G10 offset write, say) nothing
 * resolves it, which is the one thing an inch program can still carry that we
 * have not built a conversion for. */
const LENGTH_WORDS = new Set(['X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'Q'])

/** LinuxCNC/UCCNC block order: spindle, coolant and tool words on a motion
 * line take effect BEFORE the move; the stopping codes take effect after it. */
const STOP_CODES = [0, 1, 2, 30, 60]
const isStopCode = (token: GcodeToken): boolean =>
  token.letter === 'M' && STOP_CODES.some((code) => Math.abs(token.value - code) < EPS)

const MM_PER_INCH = 25.4

function n(value: number): string {
  const rounded = Number(value.toFixed(4))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function splitPolyline(
  line: PreviewPolyline,
  mesh: SurfaceMeshMap,
  maxSegmentMm: number,
  splitDeltaZMm: number,
): Array<{ x: number; y: number; z: number }> | null {
  const out: Array<{ x: number; y: number; z: number }> = []
  let traversed = 0
  const lengths: number[] = []
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]
    const b = line.points[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    lengths.push(length)
    traversed += length
  }
  const total = traversed
  traversed = 0
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]
    const b = line.points[i]
    const length = lengths[i - 1]
    const startFraction = total > EPS ? traversed / total : 0
    const endFraction = total > EPS ? (traversed + length) / total : 1
    const ca = surfaceCompensationAt(mesh, a.x, a.y)
    const cb = surfaceCompensationAt(mesh, b.x, b.y)
    if (!ca || !cb) return null
    const segments = Math.max(
      1,
      Math.ceil(length / maxSegmentMm),
      Math.ceil(Math.abs(cb.offsetMm - ca.offsetMm) / splitDeltaZMm),
    )
    for (let step = 1; step <= segments; step++) {
      const t = step / segments
      const fraction = startFraction + (endFraction - startFraction) * t
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      const compensation = surfaceCompensationAt(mesh, x, y)
      if (!compensation) return null
      const baseZ = line.z0 + (line.z - line.z0) * fraction
      out.push({ x, y, z: baseZ + compensation.offsetMm })
    }
    traversed += length
  }
  // A pure Z move has two identical XY points and total XY length zero.
  if (out.length === 0 && line.points.length > 0) {
    const point = line.points[line.points.length - 1]
    const compensation = surfaceCompensationAt(mesh, point.x, point.y)
    if (!compensation) return null
    out.push({ x: point.x, y: point.y, z: line.z + compensation.offsetMm })
  }
  return out
}

/** WO-2283: G0-G3, the probe moves and the canned cycles - the motion mode. */
function isMotionModeWord(token: GcodeToken): boolean {
  if (token.letter !== 'G') return false
  const v = token.value
  return v === 0 || v === 1 || v === 2 || v === 3 || (v >= 38 && v < 39) || v === 73 || v === 76 || (v >= 80 && v <= 89)
}

/** WO-2283: a block passed on as the program wrote it, in the stream's
 *  millimetres: an inch block's lengths and feed are scaled, its G20 dropped. */
function millimetreBlock(tokens: GcodeToken[], lineIsInch: boolean, stripped: string): string {
  if (!lineIsInch) return stripped
  return tokens
    .filter((token) => !isCode(token, 'G', 20))
    .map((token) => (LENGTH_WORDS.has(token.letter) || token.letter === 'F'
      ? `${token.letter}${n(token.value * MM_PER_INCH)}`
      : token.text))
    .join(' ')
}

/** WO-2283: one compensated point at a move's end. */
function endPointOf(line: PreviewPolyline, mesh: SurfaceMeshMap): Array<{ x: number; y: number; z: number }> | null {
  const point = line.points.at(-1)
  if (!point) return null
  const compensation = surfaceCompensationAt(mesh, point.x, point.y)
  if (!compensation) return null
  return [{ x: point.x, y: point.y, z: line.z + compensation.offsetMm }]
}

/**
 * Compile a measured mesh into sendable absolute-mm motion while retaining
 * original source-line attribution.
 *
 * WO-1822 / ADR-0050 G7 - LIENCAM.md rule 11. The first implementation refused
 * inch programs outright and refused any motion line that shared a block with
 * an M, S or T word. Both were premises, not limits: the preview model already
 * resolves G20 to canonical mm for every coordinate it reads (previewGeometry's
 * `resolveProgramSegments`), and a block's non-motion words can simply be
 * emitted as their own line in the order the controller would have run them.
 * So the compiler does those two things now, and the inch refusal survives only
 * where it is TRUE: a NON-motion command carrying a length word that nothing
 * upstream resolved. G18/G19/G53/G92/G93, rotary axes and G91 remain refused -
 * a Z-in-XY map genuinely cannot reinterpret those.
 *
 * WO-2283 (Operator ruling 2026-09-30): the mesh belongs to the WORK SYSTEM it was
 * probed in, not to the program it was planned from - any program compiles
 * against it. Only the moves that run in the mesh's work system are
 * compensated; a move in another work system is passed on as the program
 * wrote it. `startWcs` is the work system the controller is in when the
 * program starts (the frame of every move before the program's first
 * G54-G59); it defaults to the mesh's own. A program with no move in the
 * mesh's work system comes back ok with no lines and generatedMotionLines 0:
 * nothing to compensate, it runs as written.
 */
export function compileSurfaceCompensatedProgram(
  programText: string,
  mesh: SurfaceMeshMap,
  options: { maxSegmentMm?: number; splitDeltaZMm?: number; startWcs?: string | null } = {},
): SurfaceMeshCompileResult {
  if (!mesh.active) return { ok: false, reason: 'Surface mesh compensation is not active.' }
  if (!sampleGrid(mesh)) return { ok: false, reason: 'The surface mesh is incomplete.' }
  const model = buildPreviewModel(programText)
  const startWcs = options.startWcs === undefined ? mesh.workOffset : options.startWcs
  // The work system each motion line runs in, and the axes it names.
  const frameByLine = new Map<number, string | null>()
  const axesByLine = new Map<number, Set<string>>()
  const movesOnLine = new Map<number, number>()
  for (const move of model.moves) {
    const frame = move.coordinateFrame === 'machine' ? 'G53' : move.workCoordinateSystem ?? startWcs ?? null
    frameByLine.set(move.line, frame)
    const axes = axesByLine.get(move.line) ?? new Set<string>()
    for (const axis of move.addressedAxes) axes.add(axis)
    axesByLine.set(move.line, axes)
    movesOnLine.set(move.line, (movesOnLine.get(move.line) ?? 0) + 1)
  }
  const unplaced = [...frameByLine].find(([, frame]) => frame === null)
  if (unplaced) {
    return {
      ok: false,
      reason: `The active work offset is not known, so line ${unplaced[0]} cannot be placed on the ${mesh.workOffset} mesh.`,
    }
  }
  if (model.refusal === null && ![...frameByLine.values()].includes(mesh.workOffset)) {
    return { ok: true, lines: [], generatedMotionLines: 0 }
  }
  const rawLines = programText.split(/\r?\n/)
  const strippedLines = rawLines.map((raw) => stripGcodeComments(raw))
  const lineTokens = strippedLines.map(tokensOf)
  const lineWords = strippedLines.map(words)
  // Units are modal and take effect for their own block. Resolve them once so
  // every line below knows what its numbers meant.
  let inch = false
  const inchByLine = lineTokens.map((tokens) => {
    for (const token of tokens) {
      if (isCode(token, 'G', 20)) inch = true
      else if (isCode(token, 'G', 21)) inch = false
    }
    return inch
  })
  if (!lineWords.some((value) => hasCode(value, 'G', 90)) || lineWords.some((value) => hasCode(value, 'G', 91))) {
    return { ok: false, reason: 'Mesh compensation currently requires absolute G90 motion.' }
  }
  const unsupportedModal = lineWords.findIndex((value) =>
    hasCode(value, 'G', 18) || hasCode(value, 'G', 19) || hasCode(value, 'G', 53)
    || hasCode(value, 'G', 92) || hasCode(value, 'G', 93),
  )
  if (unsupportedModal >= 0) {
    return {
      ok: false,
      reason: `Line ${unsupportedModal + 1} uses G18, G19, G53, G92, or G93, which surface compensation does not reinterpret safely.`,
    }
  }
  const unsupportedAxis = lineWords.findIndex((value) =>
    ['A', 'B', 'C', 'U', 'V', 'W'].some((axis) => (value.get(axis)?.length ?? 0) > 0),
  )
  if (unsupportedAxis >= 0) {
    return { ok: false, reason: `Line ${unsupportedAxis + 1} contains rotary or auxiliary-axis motion, which surface compensation does not support.` }
  }
  if (model.refusal !== null) return { ok: false, reason: model.refusal }
  const inMeshFrame = (line: number): boolean => frameByLine.get(line) === mesh.workOffset
  // Only the mesh's own work system has to lie on the measured surface; each
  // of its cuts is held to the measured area as the loop below reaches it.
  const cut = computeCutBounds({ ...model, polylines: model.polylines.filter((line) => inMeshFrame(line.line)) })
  if (!cut.ok) return { ok: false, reason: cut.reason }
  const cutPointsByLine = new Map<number, Array<{ x: number; y: number }>>()
  for (const polyline of model.polylines) {
    if (polyline.kind === 'rapid') continue
    cutPointsByLine.set(polyline.line, [...(cutPointsByLine.get(polyline.line) ?? []), ...polyline.points])
  }
  const outsideMeasuredArea = (points: Array<{ x: number; y: number }>): boolean => points.some((p) =>
    p.x < mesh.bounds.minX - EPS || p.y < mesh.bounds.minY - EPS
    || p.x > mesh.bounds.maxX + EPS || p.y > mesh.bounds.maxY + EPS)

  const motionByLine = new Map<number, PreviewPolyline>()
  for (const polyline of model.polylines) motionByLine.set(polyline.line, polyline)
  const maxSegmentMm = options.maxSegmentMm ?? DEFAULT_MESH_SEGMENT_MM
  const splitDeltaZMm = options.splitDeltaZMm ?? DEFAULT_MESH_SPLIT_DELTA_Z_MM
  if (!Number.isFinite(maxSegmentMm) || maxSegmentMm <= 0 || !Number.isFinite(splitDeltaZMm) || splitDeltaZMm <= 0) {
    return { ok: false, reason: 'Mesh subdivision settings must be positive.' }
  }

  const lines: StreamLine[] = [{ text: 'G21 G90', sourceLine: 0 }]
  let generatedMotionLines = 0
  // WO-2283: the motion mode the program has set, and the one the emitted
  // stream last set. A line passed on as written that leans on the program's
  // mode gets it stated again when a compensated G0/G1 changed it.
  let programMotion: string | null = null
  let streamMotion: string | null = null
  /** The work system of the previous motion line. */
  let previousFrame: string | null = null
  /** The axes whose position in the mesh's work system is known. A move into
   *  it from another system starts from a point only the controller knows. */
  const known = new Set(['x', 'y', 'z'])
  for (let i = 0; i < rawLines.length; i++) {
    const sourceLine = i + 1
    const stripped = stripGcodeComments(rawLines[i])
    if (!stripped || stripped === '%') continue
    const tokens = lineTokens[i]
    const lineIsInch = inchByLine[i]
    const motionWord = tokens.filter(isMotionModeWord).at(-1)
    if (motionWord) programMotion = `G${n(motionWord.value)}`
    const motion = motionByLine.get(sourceLine)
    if (!motion) {
      if (motionWord) streamMotion = programMotion
      // The emitted stream is G21 G90 from its header line down, so a G20 must
      // never reach the controller: it would turn every compensated
      // millimetre below it into an inch. Drop the word, keep the rest of the
      // block, and refuse only a length this compiler cannot convert.
      const carriesUnits = tokens.some((token) => isCode(token, 'G', 20))
      const scalesFeed = lineIsInch && tokens.some((token) => token.letter === 'F')
      if (lineIsInch) {
        const unresolved = tokens.find((token) => LENGTH_WORDS.has(token.letter))
        if (unresolved) {
          return {
            ok: false,
            reason: `Line ${sourceLine} sets ${unresolved.text} as a length in inches on a command that is not motion, `
              + 'and mesh compensation does not convert those. Post that command in millimetres.',
          }
        }
      }
      if (!carriesUnits && !scalesFeed) {
        lines.push({ text: stripped, sourceLine })
        continue
      }
      const rewritten = tokens
        .filter((token) => !isCode(token, 'G', 20))
        .map((token) => (token.letter === 'F' && lineIsInch ? `F${n(token.value * MM_PER_INCH)}` : token.text))
        .join(' ')
      if (rewritten) lines.push({ text: rewritten, sourceLine })
      continue
    }
    const frame = frameByLine.get(sourceLine) ?? null
    const entered = previousFrame !== null && previousFrame !== frame
    previousFrame = frame
    if (frame === mesh.workOffset && entered) known.clear()
    // The move that completes X, Y and Z in the mesh's work system starts
    // from a point only the controller knows: it is sent as one move.
    const startUnknown = frame === mesh.workOffset && known.size < 3
    if (startUnknown) {
      for (const axis of axesByLine.get(sourceLine) ?? []) if ('xyz'.includes(axis)) known.add(axis)
    }
    // WO-2283: a move in another work system, or a rapid into the mesh's
    // before the program has said where X, Y and Z are in it, is passed on as
    // the program wrote it (in millimetres) - never compensated.
    if (frame !== mesh.workOffset || (known.size < 3 && motion.kind === 'rapid')) {
      const block = millimetreBlock(tokens, lineIsInch, stripped)
      if (!motionWord && programMotion !== null && programMotion !== streamMotion) {
        if (!['G0', 'G1', 'G2', 'G3'].includes(programMotion)) {
          return {
            ok: false,
            reason: `Line ${sourceLine} repeats ${programMotion} after a compensated move, which mesh compensation does not re-issue.`,
          }
        }
        lines.push({ text: `${programMotion} ${block}`, sourceLine })
      } else {
        lines.push({ text: block, sourceLine })
      }
      streamMotion = programMotion
      continue
    }
    if (known.size < 3 || (startUnknown && movesOnLine.get(sourceLine) !== 1)) {
      return {
        ok: false,
        reason: `Line ${sourceLine} cuts in ${mesh.workOffset} straight after a move in another work offset, before the `
          + `program has given X, Y and Z in ${mesh.workOffset}, so its start on the measured surface is not known.`,
      }
    }
    const cutPoints = cutPointsByLine.get(sourceLine) ?? []
    if (outsideMeasuredArea(startUnknown ? cutPoints.slice(-1) : cutPoints)) {
      return { ok: false, reason: 'The loaded program cuts outside the measured mesh area.' }
    }
    // A block that moves AND sets something becomes two or three lines in the
    // order the controller would have run them, rather than a refusal: the
    // work offset, spindle, coolant and tool words first, the move, then any
    // stopping code.
    const beforeMove = tokens.filter((token) =>
      token.letter === 'S' || token.letter === 'T' || (token.letter === 'M' && !isStopCode(token))
      || (token.letter === 'G' && token.value >= 54 && token.value < 60),
    )
    const afterMove = tokens.filter(isStopCode)
    if (beforeMove.length > 0) {
      lines.push({ text: beforeMove.map((token) => token.text).join(' '), sourceLine })
    }
    const points = startUnknown
      ? endPointOf(motion, mesh)
      : splitPolyline(motion, mesh, maxSegmentMm, splitDeltaZMm)
    if (!points) return { ok: false, reason: `Could not interpolate mesh compensation for line ${sourceLine}.` }
    // F is units-per-minute, so an inch program's F20 is 508 mm/min.
    const rawFeed = lineWords[i].get('F')?.[0]
    const feed = rawFeed === undefined ? undefined : lineIsInch ? rawFeed * MM_PER_INCH : rawFeed
    const motionCode = motion.kind === 'rapid' ? 'G0' : 'G1'
    points.forEach((point, index) => {
      const feedWord = motion.kind !== 'rapid' && index === 0 && feed !== undefined ? ` F${n(feed)}` : ''
      lines.push({
        text: `${motionCode} X${n(point.x)} Y${n(point.y)} Z${n(point.z)}${feedWord}`,
        sourceLine,
      })
      generatedMotionLines++
    })
    streamMotion = motionCode
    if (afterMove.length > 0) {
      lines.push({ text: afterMove.map((token) => token.text).join(' '), sourceLine })
    }
  }
  return { ok: true, lines, generatedMotionLines }
}
