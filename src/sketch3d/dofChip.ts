// DOF chip (WP3.4): a thin, honest derivation from the solver's own result - never a
// re-computation of DOF. planegcs's dof()/status/redundant[] IS the ground truth (criterion 3);
// this module only labels it for a UI chip.
import type { Sketch3dDofChip, Sketch3dSolveResult } from './types'

export function computeDofChip(result: Sketch3dSolveResult, hasConstraints: boolean): Sketch3dDofChip {
  if (result.status === 'conflicting') {
    return { dof: result.dof, status: 'conflicting', label: 'Conflicting constraints' }
  }
  if (result.status === 'failed' || result.status === 'invalid_sketch') {
    return { dof: result.dof, status: 'invalid', label: 'Solve failed' }
  }

  if (!hasConstraints) {
    const label = result.dof === 0 ? 'Empty sketch' : `${result.dof} DOF remaining`
    return { dof: result.dof, status: 'unconstrained', label }
  }

  if (result.dof === 0) {
    const label = result.status === 'redundant'
      ? 'Fully constrained (redundant constraints present)'
      : 'Fully constrained'
    return { dof: 0, status: 'fully_constrained', label }
  }

  if (result.status === 'redundant') {
    return { dof: result.dof, status: 'redundant', label: `${result.dof} DOF remaining (redundant constraints present)` }
  }

  return { dof: result.dof, status: 'partially_constrained', label: `${result.dof} DOF remaining` }
}
