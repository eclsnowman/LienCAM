import type { ToolpathMove } from '../../types'

/** Hard bound applies even to zero-duration moves and densely sampled arcs. */
export const TOOLPATH_WINDOW_SIDE_LIMIT = 32
export const TOOLPATH_WINDOW_MS = 2000
/** Session controls accept a useful finite range without weakening the work bound. */
export const TOOLPATH_WINDOW_MAX_MS = 60_000

export interface ToolpathWindowOptions {
  /** Dimmed motion behind the cutter. Zero deliberately selects none. */
  recentMs?: number
  /** Bright motion ahead of the cutter. Zero deliberately selects none. */
  upcomingMs?: number
}

export interface WindowFrame {
  fromX: number; fromY: number; fromZ: number
  toX: number; toY: number; toZ: number
  startMs: number
  durationMs: number
  role: string
  sourceMove?: ToolpathMove
  sourceMoveIndex?: number
  sourceOperationId?: string
}

export interface ToolpathWindowSegment {
  frame: WindowFrame
  frameIndex: number
  phase: 'recent' | 'upcoming'
  fromX: number; fromY: number; fromZ: number
  toX: number; toY: number; toZ: number
}

/**
 * Read only the bounded neighborhood of the panel's already-resolved cursor.
 * Clip by time, including the active frame at the marker's exact fraction.
 * Identity/role stay on the original frame, including sampled-arc ownership.
 * Zero-length frames retain identity without searching beyond the work bound.
 */
export function selectToolpathWindow(
  frames: readonly WindowFrame[], frameIndex: number, cursorMs: number, options: ToolpathWindowOptions = {},
): ToolpathWindowSegment[] {
  if (!frames.length || !Number.isFinite(cursorMs)) return []
  const index = Math.max(0, Math.min(frames.length - 1, Math.floor(frameIndex)))
  if (!Number.isFinite(index)) return []
  // Invalid programmatic input preserves the established two-second default;
  // UI input is constrained to the same finite 0..60s range.
  const duration = (value: number | undefined) => value === undefined || !Number.isFinite(value)
    ? TOOLPATH_WINDOW_MS
    : Math.max(0, Math.min(TOOLPATH_WINDOW_MAX_MS, value))
  const recentMs = duration(options.recentMs)
  const upcomingMs = duration(options.upcomingMs)
  const segments: ToolpathWindowSegment[] = []
  const append = (frame: WindowFrame, i: number, phase: ToolpathWindowSegment['phase'], low: number, high: number) => {
    const end = frame.startMs + frame.durationMs
    if (end < low || frame.startMs > high) return
    const fraction = (ms: number) => frame.durationMs > 0
      ? Math.max(0, Math.min(1, (ms - frame.startMs) / frame.durationMs))
      : (ms >= frame.startMs ? 1 : 0)
    const from = fraction(low), to = fraction(high)
    if (to <= from && frame.durationMs > 0) return
    const at = (a: number, b: number, t: number) => a + (b - a) * t
    segments.push({
      frame, frameIndex: i, phase,
      fromX: at(frame.fromX, frame.toX, from),
      fromY: at(frame.fromY, frame.toY, from),
      fromZ: at(frame.fromZ, frame.toZ, from),
      toX: at(frame.fromX, frame.toX, to),
      toY: at(frame.fromY, frame.toY, to),
      toZ: at(frame.fromZ, frame.toZ, to),
    })
  }
  if (recentMs > 0) {
    const low = cursorMs - recentMs
    for (let i = index, n = 0; i >= 0 && n < TOOLPATH_WINDOW_SIDE_LIMIT; i--, n++) {
      const frame = frames[i]
      if (frame.startMs + frame.durationMs < low) break
      append(frame, i, 'recent', low, cursorMs)
    }
  }
  if (upcomingMs > 0) {
    const high = cursorMs + upcomingMs
    for (let i = index, n = 0; i < frames.length && n < TOOLPATH_WINDOW_SIDE_LIMIT; i++, n++) {
      const frame = frames[i]
      if (frame.startMs > high) break
      append(frame, i, 'upcoming', cursorMs, high)
    }
  }
  return segments
}
