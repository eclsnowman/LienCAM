import { parseGcode, type GcodeProgram } from './parse'
import { codeOutsideComments } from './reader'
import { buildPreviewModel, type PreviewModel } from '../machine/previewGeometry'
import type { ProgramStep } from '../machine/controller'

export type InsightRange = { min: number; max: number } | null
export interface ProgramInsightFacts {
  feedMmMin: InsightRange
  spindleRpm: InsightRange
  tools: number[]
  toolsUnknown: boolean
  bounds: PreviewModel['workBounds']
}

function range(values: number[], unknown: boolean): InsightRange {
  if (unknown || values.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value) }
  return { min, max }
}

/** Display only. Geometry, units and canned cycles belong to the preview's
 * authority. The extra modal walk attributes spindle/tool state to its cutting
 * source lines; it never decides whether a program may load or execute. */
export function textProgramInsight(text: string, prepared?: { model: PreviewModel; program: GcodeProgram }): ProgramInsightFacts {
  const model = prepared?.model ?? buildPreviewModel(text)
  const clean = text.split('\n').map((raw) => codeOutsideComments(raw))
  const malformed = clean.some((line) => !line.ok)
  const source = clean.map((line) => line.ok ? line.code : '').join('\n')
  // Preview tolerates unfinished comments and separates tokens around comments;
  // this reader rejects malformed comments and joins the surrounding code. Only
  // share an AST when every nonblank physical input line is exactly the same
  // after trimming. Otherwise preserve the original insight parser semantics.
  const physical = clean.flatMap((line, index) => line.ok && line.code.trim()
    ? [{ number: index + 1, code: line.code.trim() }] : [])
  const reusable = prepared?.program.lines.length === physical.length
    && physical.every((line, index) => line.number === prepared.program.lines[index].number
      && line.code === prepared.program.lines[index].raw.trim())
  const parsed = reusable ? prepared!.program : parseGcode(source)
  // Feed/spindle speed modes do not alter XYZ geometry. For those modes only,
  // ask the SAME preview builder for cutting attribution without the speed-mode
  // words. Keep the original preview bounds; the modal walk below marks the
  // affected speed unknown. All other unsupported words/syntax remain intact,
  // so macros/unknown cycles cannot become invented numeric geometry.
  const hasSpeedMode = parsed.lines.some((line) => line.words.some((w) =>
    w.letter === 'G' && [93, 95, 96, 97].includes(w.value)))
  const geometry = model.refusal !== null && hasSpeedMode
    ? buildPreviewModel(source.replace(/G\s*(?:93|95|96|97)(?![\d.])/gi, ' ')) : model
  const cutting = new Map<number, number[]>()
  // Equal preview coordinates only establish stationarity in the SAME frame.
  // G53 preserves the preview's work position, so remember each addressed
  // axis independently until an absolute work target establishes it again.
  const positions = new Map<string, { frame: string | null; value: number }>()
  for (const move of geometry.moves) {
    const frame = move.coordinateFrame === 'machine' ? 'G53' : move.workCoordinateSystem
    let moves = move.kind === 'arc'
    for (const axis of move.addressedAxes) {
      const previous = positions.get(axis)
      if (move.targetMode === 'incremental') {
        const delta = move.to[axis] - move.from[axis]
        if (delta !== 0) moves = true
        if (previous) positions.set(axis, { frame: previous.frame, value: previous.value + delta })
      } else {
        if (!previous || previous.frame !== frame || previous.value !== move.to[axis]) moves = true
        positions.set(axis, { frame, value: move.to[axis] })
      }
    }
    if (move.kind === 'rapid' || !moves) continue
    const feeds = cutting.get(move.line) ?? []
    feeds.push(move.feedMmMin ?? NaN)
    cutting.set(move.line, feeds)
  }
  let feedUnknown = malformed || (geometry.refusal !== null)
  let spindleUnknown = feedUnknown
  let toolsUnknown = feedUnknown
  let spindleOn: boolean | null = null
  let rpm: number | null = null
  let rpmMode = true
  let feedMode = true
  let feedEstablished = true
  let selected: number | null = null
  let active: number | null = null
  const feeds: number[] = []
  const rpms: number[] = []
  const tools = new Set<number>()
  for (const line of parsed.lines) {
    const gs = line.words.filter((w) => w.letter === 'G').map((w) => w.value)
    const ms = line.words.filter((w) => w.letter === 'M').map((w) => w.value)
    const value = (letter: string) => line.words.find((w) => w.letter === letter)?.value
    // WO-3171: a macro can alter modal state or add motion invisibly. Whole
    // ranges are then unknown; numeric literals outside it are not a full list.
    if (/[@^\[\]#=]/.test(line.raw) || ms.some((m) => m >= 100 || m === 98 || m === 99) || gs.includes(65) || gs.includes(66)) {
      feedUnknown = spindleUnknown = toolsUnknown = true
    }
    if (gs.includes(93) || gs.includes(95)) { feedMode = false; feedEstablished = false }
    if (gs.includes(94)) feedMode = true
    if (gs.includes(96)) rpmMode = false
    if (gs.includes(97)) rpmMode = true
    if (feedMode && value('F') !== undefined) feedEstablished = true
    const s = value('S')
    if (s !== undefined) rpm = Number.isFinite(s) && s >= 0 ? s : null
    const t = value('T')
    if (t !== undefined) selected = Number.isInteger(t) && t >= 0 ? t : null
    if (ms.includes(6)) active = selected
    if (ms.includes(3) || ms.includes(4)) spindleOn = true
    if (ms.includes(5)) spindleOn = false
    const used = cutting.get(line.number)
    if (used) {
      for (const feed of used) {
        if (!feedMode || !feedEstablished || !Number.isFinite(feed) || feed <= 0) feedUnknown = true
        else feeds.push(feed)
      }
      if (spindleOn === null || (spindleOn && (!rpmMode || rpm === null))) spindleUnknown = true
      else rpms.push(spindleOn ? rpm! : 0)
      if (active === null) toolsUnknown = true
      else if (active > 0) tools.add(active)
    }
    if (ms.includes(2) || ms.includes(30)) break
  }
  return {
    feedMmMin: range(feeds, feedUnknown), spindleRpm: range(rpms, spindleUnknown),
    tools: [...tools], toolsUnknown, bounds: model.workBounds,
  }
}

/** Native geometry already has physical mm/min and RPM in typed steps. Bounds
 * are passed from the same session path used by ProgramPreview (incl. G53). */
export function stagedProgramInsight(steps: readonly ProgramStep[], bounds: ProgramInsightFacts['bounds']): ProgramInsightFacts {
  const feeds: number[] = []
  const rpms: number[] = []
  const tools = new Set<number>()
  let feedUnknown = false
  let spindleUnknown = false
  let toolsUnknown = false
  let rpm: number | null = null
  let tool: number | null = null
  const position: Record<string, number | undefined> = {}
  for (const step of steps) {
    if (step.kind === 'spindle') rpm = step.direction === 'off' ? 0 : step.rpm
    if (step.kind === 'toolChange') tool = step.toolNumber
    if (step.kind !== 'line' && step.kind !== 'arc') continue
    const coordinates = Object.entries(step.to).filter(([, value]) => value !== undefined)
    const moves = step.kind === 'arc' || coordinates.some(([axis, value]) => position[axis] !== value)
    for (const [axis, value] of coordinates) position[axis] = value
    if (!moves || (step.kind === 'line' && step.rapid)) continue
    if (!Number.isFinite(step.feedMmMin) || step.feedMmMin <= 0) feedUnknown = true
    else feeds.push(step.feedMmMin)
    if (rpm === null || !Number.isFinite(rpm)) spindleUnknown = true
    else rpms.push(rpm)
    if (tool === null) toolsUnknown = true
    else if (tool > 0) tools.add(tool)
  }
  return { feedMmMin: range(feeds, feedUnknown), spindleRpm: range(rpms, spindleUnknown), tools: [...tools], toolsUnknown, bounds }
}
