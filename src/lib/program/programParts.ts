import type { MachineProgram, ProgramIndex } from '../machine/controller'
import {
  assessProgramCapacity,
  describeOverCapRefusal,
  isStagedMove,
  type ProgramCapacity,
} from './programCapacity'

export type ProgramPartsResult =
  | { ok: true; capacity: ProgramCapacity; parts: MachineProgram[] }
  | { ok: false; capacity: ProgramCapacity; reason: string }

/**
 * Materialise the capacity plan as independently valid controller programs.
 * IDs are deliberately preserved: progress, fidelity and operation attribution
 * continue to describe the one original program while only the staged list is
 * split at rapid boundaries.
 */
export function buildProgramParts(program: MachineProgram, cap: number): ProgramPartsResult {
  const moves = program.steps.filter(isStagedMove)
  if (moves.length !== program.steps.length) {
    const capacity = assessProgramCapacity(program.steps, cap)
    return {
      ok: false,
      capacity,
      reason: 'This program contains action steps; action steps are not wired for program parts yet.',
    }
  }

  const capacity = assessProgramCapacity(moves, cap)
  if (capacity.parts === null) {
    // WO-1081: no rapid means there is no stationary handoff to materialise,
    // not that the program is impossible. Keep the continuous cut whole and
    // let the backend stream it through its own bounded in-flight window.
    // Invalid cap values still refuse; they cannot describe a useful plan.
    if (Number.isInteger(cap) && cap > 0 && moves.length > cap) {
      return {
        ok: true,
        capacity,
        parts: [{ frame: program.frame, units: program.units, steps: moves, index: program.index }],
      }
    }
    return { ok: false, capacity, reason: describeOverCapRefusal(capacity) }
  }

  const parts = capacity.parts.map(({ start, end }): MachineProgram => {
    const steps = moves.slice(start, end)
    const index: ProgramIndex = {}
    for (const step of steps) {
      const entry = program.index[step.id]
      if (entry !== undefined) index[step.id] = entry
    }
    return { frame: program.frame, units: program.units, steps, index }
  })
  return { ok: true, capacity, parts }
}
