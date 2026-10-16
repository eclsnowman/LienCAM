import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useState } from 'react'
import type { StreamerPhase } from '../../lib/machine/controller'
import type { ProgramRunEstimate } from '../../lib/machine/programRunEstimate'
import { useMachineControl } from '../../store/machineControlStore'

export interface RunClockSnapshot {
  elapsedMs: number
  remainingMs: number | null
}

/**
 * Read the active run interval from the session timestamps. During a hold the
 * far end's pause stamp is the effective "now"; after resume the store shifts
 * startedAt by that pause span, so every completed hold remains excluded too.
 */
export function runClockSnapshot(
  nowMs: number,
  startedAt: number,
  pausedAt: number | null,
  estimatedMs: number | null,
): RunClockSnapshot {
  const effectiveNow = pausedAt ?? nowMs
  const elapsedMs = Math.max(0, effectiveNow - startedAt)
  const remainingMs = estimatedMs !== null && Number.isFinite(estimatedMs)
    ? Math.max(0, estimatedMs - elapsedMs)
    : null
  return { elapsedMs, remainingMs }
}

/** Compact machine-clock duration: "45s", "2m 34s", or "1h 03m 04s". */
export function formatRunClockMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  }
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function RunClock({
  phase,
  startedAt,
  pausedAt,
  estimatedMs,
  movesLeft,
}: {
  phase: StreamerPhase
  startedAt: number | null
  pausedAt: number | null
  estimatedMs: number | null
  /** WO-2684: the program's own moves and its cursor - the move executing, or
   *  the next one when held between moves. Est. remaining is the unfinished
   *  part of that move plus every move after it. */
  movesLeft?: { estimate: Pick<ProgramRunEstimate, 'remainingAt'>; cursor: number }
}) {
  useText('control-screens-not-probing')
  const active = phase === 'streaming' || phase === 'paused'
  // Where the machine stands along the move it is in (machine seat 10-08:
  // a 6 s cut read 6 s from its start to its end, and at a Feed Hold halfway).
  const at = useMachineControl((s) => (movesLeft && active ? s.wpos : null))
  // When the cursor reached this move, on the run's own clock (holds excluded):
  // how far along it is when the controller reports no usable position.
  const [moveSince, setMoveSince] = useState<{ key: string; elapsedMs: number } | null>(null)
  const [clock, setClock] = useState({
    nowMs: 0,
    excludedUnstampedHoldMs: 0,
    unstampedHoldStartedAt: null as number | null,
  })

  useEffect(() => {
    if (!active || startedAt === null) {
      setMoveSince(null)
      setClock({
        nowMs: 0,
        excludedUnstampedHoldMs: 0,
        unstampedHoldStartedAt: null,
      })
      return
    }

    const sampledAt = pausedAt ?? Date.now()
    setClock((current) => {
      if (phase === 'paused') {
        // Program M0 holds arrive through progress updates rather than a
        // paused event, so the store has no pausedAt to shift startedAt on
        // resume. Remember that hold locally; stamped holds remain owned by
        // the store and must not be counted twice.
        const unstampedHoldStartedAt = pausedAt === null
          ? current.unstampedHoldStartedAt ?? sampledAt
          : null
        return {
          ...current,
          nowMs: unstampedHoldStartedAt ?? sampledAt,
          unstampedHoldStartedAt,
        }
      }

      const completedHoldMs = current.unstampedHoldStartedAt === null
        ? 0
        : Math.max(0, sampledAt - current.unstampedHoldStartedAt)
      return {
        nowMs: sampledAt,
        excludedUnstampedHoldMs: current.excludedUnstampedHoldMs + completedHoldMs,
        unstampedHoldStartedAt: null,
      }
    })

    if (phase === 'paused') return
    const timer = setInterval(() => {
      setClock((current) => ({ ...current, nowMs: Date.now() }))
    }, 500)
    return () => clearInterval(timer)
  }, [active, phase, pausedAt, startedAt])

  if (!active || startedAt === null) return null
  const snapshot = runClockSnapshot(
    clock.nowMs,
    startedAt + clock.excludedUnstampedHoldMs,
    pausedAt,
    estimatedMs,
  )
  // WO-2684 (the operator, 10-08): "time remaining is not based on number of moves,
  // but on time to execute moves remaining". A current post's whole-program
  // estimate keeps counting down while the program runs (WO-1994); held with
  // moves left, or once that count has run out under motion still to come,
  // the moves left decide - never "0s" at an M0 with a move to run.
  // Keyed by the cursor alone: resuming a Feed Hold moves startedAt forward,
  // and a dwell held halfway must carry on from halfway, not start over. A
  // run's end clears it (above).
  const moveKey = movesLeft ? String(movesLeft.cursor) : null
  if (moveKey !== null && moveSince?.key !== moveKey) {
    setMoveSince({ key: moveKey, elapsedMs: snapshot.elapsedMs })
  }
  const msInMove = moveSince !== null && moveSince.key === moveKey
    ? snapshot.elapsedMs - moveSince.elapsedMs : 0
  const remainingMs = movesLeft?.estimate.remainingAt(movesLeft.cursor, at, msInMove)
  if (
    remainingMs !== undefined && Number.isFinite(remainingMs)
    && (snapshot.remainingMs === null || snapshot.remainingMs === 0 || phase === 'paused')
  ) {
    snapshot.remainingMs = Math.max(0, remainingMs)
  }

  return (
    <span
      className="control-run-clock"
      data-testid="control-run-clock"
      data-elapsed-ms={snapshot.elapsedMs}
      data-remaining-ms={snapshot.remainingMs ?? undefined}
      data-paused={phase === 'paused' ? 'true' : 'false'}
      role="timer"
      aria-label={
        snapshot.remainingMs === null
          ? controlText('RunClock.text002', { value1: String(formatRunClockMs(snapshot.elapsedMs)) })
          : controlText('RunClock.text003', { value1: String(formatRunClockMs(snapshot.elapsedMs)), value2: String(formatRunClockMs(snapshot.remainingMs)) })
      }
    >{catalogChildren(controlText('RunClock.text001', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: formatRunClockMs(snapshot.elapsedMs), value2: ' | ', value3: snapshot.remainingMs === null ? controlText('RunClock.unavailable') : formatRunClockMs(snapshot.remainingMs) })}</span>
  )
}
