// WO INT-4A: deterministic next-free-id helper shared by every create-mode
// dialog (ExtrudeDialog, RevolveDialog, BooleanDialog) and by
// mintRectangleSketch.ts's test-only rectangle-profile scaffolding
// -- caller-assigned ids only (FeatureDag.insertNode never mints its own, see
// dag.ts), so something has to pick the next free slot. Scans upward from 1
// rather than tracking a counter ref: stays correct across undo (a removed
// node's id becomes reusable again) without any extra state to keep in sync.

import type { FeatureDag } from '../../../doc'

export function nextId(dag: FeatureDag, prefix: string): string {
  let n = 1
  while (dag.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}
