// Conflict / redundant panel (WP3.4): turns the solver's raw conflicting[]/redundant[] id
// arrays into UI-ready entries with a human label and the entities to highlight, straight from
// Sketch3dSolveResult - never re-derived from a separate solve.
import { describeConstraint } from './constraintGeometry'
import type { Sketch3dConflictEntry, Sketch3dConflictPanel, Sketch3dDocument, Sketch3dSolveResult } from './types'

function buildEntries(
  document: Sketch3dDocument,
  ids: string[],
  severity: 'conflicting' | 'redundant',
): Sketch3dConflictEntry[] {
  return ids.map((constraintId) => {
    const constraint = document.constraints.find((candidate) => candidate.id === constraintId)
    if (!constraint) {
      return { constraintId, kind: 'unknown', label: `Unknown constraint '${constraintId}'`, entityIds: [], severity }
    }
    const described = describeConstraint(document, constraint)
    return { constraintId, kind: constraint.kind, label: described.label, entityIds: described.entityIds, severity }
  })
}

export function computeConflictPanel(document: Sketch3dDocument, result: Sketch3dSolveResult): Sketch3dConflictPanel {
  const conflicting = buildEntries(document, result.conflicting, 'conflicting')
  const redundant = buildEntries(document, result.redundant, 'redundant')
  return { conflicting, redundant, isEmpty: conflicting.length === 0 && redundant.length === 0 }
}
