// DOES THIS PROGRAM FIT ON THE BOARD? (WO-1044)
//
// THE DEFECT THIS FILE EXISTS FOR, measured on Operator's machine 2026-08-26 with
// Operator present (`src/tests/evidence/CHORD-AB-2026-08-26/`, commit f7285554):
// the AXBB-E through the bridge executes `moveCount mod 4096` of a staged
// program. 4274 moves accepted -> 178 executed. 6284 -> the remainder. The
// board ACCEPTS every move, reports buffer-full ZERO times, and executes the
// wrong number. There is no signal from the board. The only defence is ours,
// and it has to happen BEFORE the program is loaded.
//
// So this module answers two questions and nothing else:
//
//   1. HOW MANY MOVES IS THIS, AND DOES IT FIT? Answered up front - before
//      Cycle Start, before the wire. A successful streaming load reports the
//      program itself; this capacity detail is operator-facing only when it
//      explains why a program genuinely cannot run.
//   2. IF IT DOES NOT FIT, HOW WOULD IT BREAK UP? How many programs run in
//      sequence, and where the boundaries fall - each one ON A RAPID, never
//      mid-cut. If no such boundary exists, this says so and names why; it
//      never invents one.
//
// WHAT IT NEVER DOES: truncate, materialise, or send. A plan is not an act.
// WO-1054's caller materialises and runs a legal plan as controller-sized
// parts; both backends still enforce this cap independently on every load.
//
// PURE. No controller, no store, no clock, no I/O - the same input gives the
// same answer to the app door, to a backend and to a test.

import type { ProgramStep, QueuedMove } from '../machine/controller'

/**
 * A step that occupies a slot in the controller's staged move list.
 *
 * The whole `QueuedMove` union, not just `line`: `uccncController.loadProgram`
 * puts every one of them in the `loadMoves` frame the bridge stages, so a
 * dwell or a marker consumes a slot exactly like a cut does. Counting only the
 * cutting moves would be the same undercount the board already punishes.
 *
 * A `MachineAction` is NOT counted - no backend can execute one yet, and both
 * refuse a program containing one before the cap is ever consulted.
 */
export function isStagedMove(step: ProgramStep): step is QueuedMove {
  return step.kind === 'line' || step.kind === 'arc' || step.kind === 'dwell' || step.kind === 'marker'
}

/** One part of a split program: a half-open range over the motion steps. */
export interface ProgramPart {
  /** Index of this part's first motion step, inclusive. */
  start: number
  /** Index one past this part's last motion step. */
  end: number
  /** Moves in this part. Never zero, never above the cap. */
  count: number
}

/**
 * How a program stands against the controller's cap.
 *
 * `parts` is a PLAN, and only ever describes moves that already exist - it
 * never re-orders, merges or adds one. `null` means the program cannot be
 * broken up under the rapid rule, and `splitRefusal` says which part of it
 * could not be placed.
 */
export interface ProgramCapacity {
  /** Motion steps in the program - what actually goes to the board. */
  count: number
  /** The controller's ceiling, from `resolveMaxProgramMoves`. */
  cap: number
  /** `count <= cap`: this program can be loaded as one program. */
  fits: boolean
  /** The parts it would take, or `null` when no legal boundary exists. One
   *  part (the whole program) when it fits. */
  parts: ProgramPart[] | null
  /** Why it cannot be split, in a sentence. Null whenever `parts` is set. */
  splitRefusal: string | null
}

/**
 * MEASURE A PROGRAM AGAINST A CONTROLLER'S CAP, AND PLAN THE SPLIT IF IT NEEDS
 * ONE.
 *
 * THE BOUNDARY RULE, and it is the whole safety argument: a part ENDS ON A
 * RAPID. Between two parts the operator's machine sits idle while the next
 * program is loaded, and the one place a tool must never be left sitting is in
 * a cut. A rapid is the product's own declaration that this move is
 * positioning and not cutting (`QueuedMove.rapid`, ADR-0043 section 3), so
 * ending a part there leaves the tool where the toolpath itself had already
 * lifted it. The next part then begins exactly where the uninterrupted program
 * would have gone next.
 *
 * The boundary is the LAST rapid inside each part's reach, so a part carries
 * as much as it legally can and the number of parts is the smallest the rule
 * allows. A reach containing NO rapid is refused by name - never stretched
 * past the cap, and never cut mid-feed "because it is close enough".
 */
export function assessProgramCapacity(steps: readonly ProgramStep[], cap: number): ProgramCapacity {
  const moves = steps.filter(isStagedMove)
  const count = moves.length

  if (!(Number.isInteger(cap) && cap > 0)) {
    // A caller that got the cap from `resolveMaxProgramMoves` cannot reach
    // this; a caller that typed one can. Refusing to plan is the only honest
    // answer - a nonsense ceiling must not become a nonsense split.
    return {
      count,
      cap,
      fits: false,
      parts: null,
      splitRefusal: `The controller's move cap is ${String(cap)}, which is not a usable number of moves.`,
    }
  }

  if (count <= cap) {
    return {
      count,
      cap,
      fits: true,
      parts: count === 0 ? [] : [{ start: 0, end: count, count }],
      splitRefusal: null,
    }
  }

  const parts: ProgramPart[] = []
  let start = 0
  while (count - start > cap) {
    // The last rapid this part can reach. `start` itself is legal: a one-move
    // positioning part leaves the machine at the end of a rapid, which is the
    // exact safe handoff state this boundary rule requires.
    let boundary = -1
    for (let i = Math.min(start + cap, count) - 1; i >= start; i--) {
      const move = moves[i]
      if (move.kind === 'line' && move.rapid === true) {
        boundary = i
        break
      }
    }
    if (boundary < 0) {
      let cuttingEnd = start
      while (cuttingEnd < count) {
        const move = moves[cuttingEnd]
        if (move.kind === 'line' && move.rapid === true) break
        cuttingEnd += 1
      }
      const cuttingCount = cuttingEnd - start
      return {
        count,
        cap,
        fits: false,
        parts: null,
        splitRefusal: `one continuous cutting stretch of ${cuttingCount.toLocaleString('en-US')} moves `
          + `has no rapid to split at; the board holds ${cap.toLocaleString('en-US')}.`,
      }
    }
    parts.push({ start, end: boundary + 1, count: boundary + 1 - start })
    start = boundary + 1
  }
  parts.push({ start, end: count, count: count - start })

  return { count, cap, fits: false, parts, splitRefusal: null }
}

/**
 * THE REFUSAL, in the words WO-1044 asked for: "this program has 6284 moves;
 * the board can only hold 4095 at once".
 *
 * It then says what it would TAKE - the part count from the plan - because an
 * operator who is told only "no" has to go and count segments by hand. And it
 * says plainly that nothing was split and nothing was sent, so the sentence
 * cannot be read as "it handled it".
 */
export function describeOverCapRefusal(capacity: ProgramCapacity): string {
  const head =
    `This program has ${capacity.count} moves; the board can only hold ${capacity.cap} at once.`
  if (capacity.parts === null) {
    return (
      `${head} It cannot be broken up either: ${capacity.splitRefusal ?? 'no boundary could be placed.'} `
      + 'Nothing was sent - shorten the toolpath or raise the chord tolerance.'
    )
  }
  return (
    `${head} It would take ${capacity.parts.length} programs run in sequence, and this build does `
    + 'not run them for you. Nothing was sent - shorten the toolpath or raise the chord tolerance.'
  )
}
