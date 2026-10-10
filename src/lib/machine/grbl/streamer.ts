// Character-counting stream flow control for GRBL (the smooth-motion protocol).
//
// Pure state machine: no I/O, no timers. The owner injects a send callback and
// forwards every ok/error ack. Invariant: bytes in flight (sum of sent,
// un-acked line lengths incl. newline) never exceed the limit, so GRBL's
// 128-byte RX buffer can never overflow and its planner stays fed.
// Real-time bytes bypass this tally entirely - they are not lines and must be
// written directly to the transport, never through the streamer.
// Reference: gnea/grbl doc/script/stream.py; docs/machine/GRBL-PROTOCOL.md.

import type { GrblStatusReport, MachineVec3 } from '../types'
import { tokenizeLine } from '../../gcode/parse'
import { STREAM_BYTE_LIMIT } from './constants'
import type { StreamLine } from '../../gcode/text'

// StreamerProgress and StreamerPhase are the CONTRACT's types now
// (src/lib/machine/controller.ts) so every backend reports the same shape.
// Re-exported here because this file's own callers already import them from it.
export type { StreamerPhase, StreamerProgress } from '../controller'
// A bare re-export does not bring the names into local scope for this file's
// own annotations, so they are imported as well.
import type { StreamerPhase, StreamerProgress } from '../controller'

export interface StreamError {
  code: number
  /** Index into the loaded line list (0-based). */
  lineIndex: number
  sourceLine: number
  text: string
}

export class CharacterCountStreamer {
  private lines: StreamLine[] = []
  private nextIndex = 0
  private ackIndex = 0
  private inFlightBytes: number[] = []
  private phase: StreamerPhase = 'empty'
  private lastError: StreamError | null = null

  private readonly send: (text: string) => void
  private readonly limit: number

  constructor(send: (text: string) => void, limit: number = STREAM_BYTE_LIMIT) {
    this.send = send
    this.limit = limit
  }

  /** Load prepared lines. Resets all progress. */
  load(lines: StreamLine[]): void {
    this.lines = lines
    this.nextIndex = 0
    this.ackIndex = 0
    this.inFlightBytes = []
    this.lastError = null
    this.phase = lines.length > 0 ? 'ready' : 'empty'
  }

  start(): void {
    if (this.phase !== 'ready' && this.phase !== 'paused') return
    this.phase = 'streaming'
    this.fill()
  }

  /** Stop filling. Lines already in the controller's buffer keep executing. */
  pause(): void {
    if (this.phase === 'streaming') this.phase = 'paused'
  }

  resume(): void {
    if (this.phase === 'paused') {
      this.phase = 'streaming'
      this.fill()
    }
  }

  /** Abandon the job (after e.g. feed-hold + soft reset). */
  reset(): void {
    this.load([])
  }

  /**
   * Single-block: send exactly ONE line and stay paused (no auto-fill on its
   * ack). Refused while a previous stepped line is still un-acked. The owner
   * gates further on machine state (wait for Idle = motion complete) - the ok
   * ack only means "parsed", not "done moving".
   */
  step(): boolean {
    if (this.phase !== 'ready' && this.phase !== 'paused') return false
    if (this.inFlightBytes.length > 0) return false
    if (this.nextIndex >= this.lines.length) return false
    this.phase = 'paused'
    const line = this.lines[this.nextIndex]
    this.inFlightBytes.push(line.text.length + 1)
    this.nextIndex++
    this.send(line.text)
    return true
  }

  /**
   * Forward every ok/error the controller emits while a job is loaded.
   * Returns the error descriptor when this ack was an error, else null.
   * On error the streamer stops filling (halt-and-surface policy); lines
   * already inside GRBL's buffer will still execute - the controller must
   * follow up with a feed hold to actually stop motion.
   */
  handleAck(ok: boolean, code = 0): StreamError | null {
    if (this.ackIndex >= this.nextIndex) return null // ack for something else (e.g. MDI before load)
    this.inFlightBytes.shift()
    const ackedLine = this.lines[this.ackIndex]
    this.ackIndex++

    if (!ok) {
      this.lastError = {
        code,
        lineIndex: this.ackIndex - 1,
        sourceLine: ackedLine.sourceLine,
        text: ackedLine.text,
      }
      this.phase = 'failed'
      return this.lastError
    }

    if (this.ackIndex >= this.lines.length) {
      // A FAILED job stays failed (WO-087). On error:N the lines already
      // inside GRBL keep executing and keep acking, so the tail of a failed
      // run reaches here with ok:true - and flipping to 'complete' would tell
      // the operator the part finished when a line of it was rejected.
      if (this.phase !== 'failed') this.phase = 'complete'
      return null
    }
    if (this.phase === 'streaming') this.fill()
    return null
  }

  /** True when this ack belongs to a streamed line (vs an MDI command). */
  ownsNextAck(): boolean {
    return this.ackIndex < this.nextIndex
  }

  progress(): StreamerProgress {
    return {
      phase: this.phase,
      totalLines: this.lines.length,
      sentLines: this.nextIndex,
      ackedLines: this.ackIndex,
      ackedSourceLine: this.ackIndex > 0 ? this.lines[this.ackIndex - 1].sourceLine : 0,
      sentSourceLine: this.nextIndex > 0 ? this.lines[this.nextIndex - 1].sourceLine : 0,
      bytesInFlight: this.inFlightBytes.reduce((a, b) => a + b, 0),
    }
  }

  /** Attribution reads the original mapping without changing the byte budget. */
  programLines(): readonly StreamLine[] { return this.lines }

  nextAckLine(): StreamLine | null { return this.ownsNextAck() ? this.lines[this.ackIndex] : null }

  error(): StreamError | null {
    return this.lastError
  }

  private fill(): void {
    while (this.phase === 'streaming' && this.nextIndex < this.lines.length) {
      const line = this.lines[this.nextIndex]
      const cost = line.text.length + 1 // + newline
      const inFlight = this.inFlightBytes.reduce((a, b) => a + b, 0)
      if (inFlight + cost > this.limit) return
      this.inFlightBytes.push(cost)
      this.nextIndex++
      this.send(line.text)
    }
  }
}

/** WO-2581: display attribution only. Nothing here controls streaming or motion.
 * Bf is not an execution cursor: GRBL removes blocks from the planner while
 * their step segments are still executing. Subtracting its free count from
 * ACKs would reproduce the same lead on a smaller scale.
 *
 * Without Ln, only a unique interior position on a known straight block is
 * proof. Shared endpoints, repeated paths, arcs, dwell/offset/probe routes and
 * unreported modal/position facts stay unknown rather than naming an ACK.
 */
export class GrblExecutingBlockTracker {
  private blocks: Array<{
    sourceLine: number
    uncertain: boolean
    n: number | null
    from: MachineVec3 | null
    to: MachineVec3 | null
  }> = []
  private firstPossible = 0
  private toleranceMm: number | null = 0.02

  load(lines: readonly StreamLine[], initial: {
    position: MachineVec3 | null
    wco: MachineVec3 | null
    units: 'mm' | 'inch'
    absolute: boolean
    motion: string | null
    wcs: string | null
    toleranceMm?: number | null
  }): void {
    this.blocks = []
    this.firstPossible = 0
    this.toleranceMm = initial.toleranceMm === undefined ? 0.02 : initial.toleranceMm
    let position = initial.position && { ...initial.position }
    let scale = initial.units === 'inch' ? 25.4 : 1
    let absolute = initial.absolute
    let motion = initial.motion
    let wcs = initial.wcs
    let modelInvalid = false
    for (const line of lines) {
      const words = tokenizeLine(line.text, line.sourceLine).words
      const gs = words.filter(w => w.letter === 'G').map(w => w.value)
      const n = words.find(w => w.letter === 'N')?.value ?? null
      if (gs.includes(20)) scale = 25.4
      if (gs.includes(21)) scale = 1
      if (gs.includes(90)) absolute = true
      if (gs.includes(91)) absolute = false
      const selectedWcs = gs.find(g => g >= 54 && g <= 59)
      if (selectedWcs !== undefined) {
        if (`G${selectedWcs}` !== wcs) { position = null; modelInvalid = true }
        wcs = `G${selectedWcs}`
      }
      const mode = gs.find(g => [0, 1, 2, 3, 80].includes(g))
      if (mode !== undefined) motion = `G${mode}`
      // These routes change the coordinate model or have an endpoint that
      // cannot be learned from the text. Ln can still identify their block.
      const unknownGeometry = gs.some(g => ![0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 40,
        53, 54, 55, 56, 57, 58, 59, 61, 64, 80, 90, 91, 91.1, 93, 94].includes(g))
      if (unknownGeometry) { position = null; modelInvalid = true }
      const axes = words.filter(w => ['X', 'Y', 'Z'].includes(w.letter))
      const from = position && { ...position }
      if (axes.length > 0 && motion !== 'G80') {
        if (!position && absolute && axes.length === 3 && !modelInvalid) {
          position = { x: 0, y: 0, z: 0 }
        }
        if (position) {
          for (const word of axes) {
            const axis = word.letter.toLowerCase() as 'x' | 'y' | 'z'
            if (gs.includes(53)) {
              if (!initial.wco) { position = null; break }
              position[axis] = word.value * scale - initial.wco[axis]
            } else position[axis] = absolute ? word.value * scale : position[axis] + word.value * scale
          }
        }
      }
      const straight = axes.length > 0 && (motion === 'G0' || motion === 'G1') && !modelInvalid && !gs.includes(4)
      this.blocks.push({ sourceLine: line.sourceLine, uncertain: modelInvalid || (axes.length > 0 && (!straight || !from || !position)), n: Number.isFinite(n) ? n : null,
        from: straight ? from : null, to: straight && position ? { ...position } : null })
    }
  }

  resolve(report: GrblStatusReport,
    position: MachineVec3 | null, sentLines: number): number | null {
    if (!['run', 'hold', 'door'].includes(report.state)) return null
    const possible = this.blocks.slice(this.firstPossible, sentLines)
    if (!position || this.toleranceMm === null) return null
    if (report.line !== null && report.line > 0) {
      // Ln is the file's N word, NOT its physical line number. Duplicate N
      // words cannot identify a source line, even when their ACKs are known.
      const matches = possible.filter(b => b.n === report.line)
      if (matches.length !== 1) return null
      // GRBL's Ln is taken from the planner tail, which may already lead
      // the step segments. Require the same position proof as the fallback.
      const selected = matches[0]
      if (selected.uncertain) return null
      const geometric = this.resolve({ ...report, line: null }, position, sentLines)
      return geometric === selected.sourceLine ? geometric : null
    }
    if (possible.some(b => b.uncertain)) return null
    const matches: Array<{ index: number; interior: boolean }> = []
    for (let i = this.firstPossible; i < Math.min(sentLines, this.blocks.length); i++) {
      const block = this.blocks[i]
      if (!block?.from || !block.to) continue
      const a = block.from, b = block.to
      const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
      const lengthSq = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
      if (lengthSq === 0) continue
      const t = Math.max(0, Math.min(1, ((position.x - a.x) * delta.x + (position.y - a.y) * delta.y
        + (position.z - a.z) * delta.z) / lengthSq))
      // Rounded/quantized endpoints remain possible: dropping one could make
      // a later buffered block look unique and advance past executing motion.
      const tolerance = this.toleranceMm
      const margin = tolerance / Math.sqrt(lengthSq)
      if (Math.hypot(position.x - a.x - t * delta.x, position.y - a.y - t * delta.y,
        position.z - a.z - t * delta.z) <= tolerance) {
        matches.push({ index: i, interior: t > margin && t < 1 - margin })
      }
    }
    if (matches.length !== 1 || !matches[0].interior) return null
    this.firstPossible = matches[0].index
    return this.blocks[matches[0].index].sourceLine || null
  }
}
