// ============================================================
// Per-program tool numbers (WO-2637) - pure
// ============================================================
// Operator ruling 2026-10-06: two different tools in one program may share a library
// tool number. The post does not go out like that; the Post Process screen
// names the conflict and lets the operator give a tool its own number FOR THIS
// PROGRAM. "Your tool library may have a different number."
//
// The chosen numbers ride on the project document as `Project.postToolNumbers`
// (toolId -> number). buildPostInput reads them, so every route that posts the
// project (Post Process export, Control > Load, the setup sheet, the program
// context) gives the tool the same number. The tool library is never changed.

import type { Project, Tool } from '../../types'

/** toolId -> the number that tool posts as in this project's programs. */
export type PostToolNumbers = Readonly<Record<string, number>>

/** A number a tool can post as: a whole number from 1 up. */
export function isPostToolNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** The project's per-program tool numbers; anything malformed is ignored. */
export function postToolNumbersOf(project: Pick<Project, 'postToolNumbers'>): PostToolNumbers {
  const raw: unknown = project.postToolNumbers
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [toolId, n] of Object.entries(raw)) if (isPostToolNumber(n)) out[toolId] = n
  return out
}

/** The map after the operator sets `tool`'s number for this program. Null, or
 *  the tool's own library number, takes the program number away (the tool
 *  posts with its library number again). Undefined when nothing is left, so a
 *  project that never used this saves no field. */
export function withPostToolNumber(
  current: PostToolNumbers,
  tool: Pick<Tool, 'id' | 'toolNumber'>,
  n: number | null,
): PostToolNumbers | undefined {
  const next: Record<string, number> = { ...current }
  if (n === null || n === tool.toolNumber) delete next[tool.id]
  else if (isPostToolNumber(n)) next[tool.id] = n
  return Object.keys(next).length > 0 ? next : undefined
}
