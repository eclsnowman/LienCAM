// ============================================================
// Program assembly skeleton (C-P0) — structure only, NO g-code
// ============================================================
// Describes the preamble / per-op / postamble shape of a program so the
// emitter (C-P1) can walk a typed structure rather than re-deriving order.
// Carries op metadata only; no formatted moves.

import type { PostInput, PostOperation } from './types'

export type Section =
  | { kind: 'preamble' }
  | { kind: 'operation'; index: number; op: PostOperation }
  | { kind: 'postamble' }

/** Flatten a PostInput into an ordered preamble -> ops -> postamble section
 *  list. Operation order matches the input (already filtered to enabled). */
export function assembleSections(input: PostInput): Section[] {
  const sections: Section[] = [{ kind: 'preamble' }]
  input.setup.operations.forEach((op, index) => {
    sections.push({ kind: 'operation', index, op })
  })
  sections.push({ kind: 'postamble' })
  return sections
}
