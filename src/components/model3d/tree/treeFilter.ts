// WO UI-8 (BK-42 mission #1): Design Tree filter-bar matching logic. Pure
// functions (no React, no FeatureDag import) -- same "matcher is a pure
// function" discipline as the 2D DesignTree's own src/components/panels/
// treeFilter.ts (Phase 6/P10), extended with `:operator` tokens
// per the WO's gap-recon mission. Filtering NEVER mutates anything it reads;
// FeatureTree.tsx only ever uses this to decide which already-rendered rows
// to hide (mission #1's binding "filtering never changes document state"
// invariant lives entirely in that separation -- this module cannot touch a
// FeatureDag even if it wanted to, it has no reference to one).

/** Parsed filter query: plain-text tokens (matched against name/type,
 *  case-insensitive substring) plus the three operators the
 *  WO names explicitly. Multiple operators AND together; free text is one
 *  more AND'd condition on top. */
export interface FilterQuery {
  /** Remaining free-text tokens, lowercased and space-joined. Empty string = no text filter. */
  text: string
  /** `:errors` -- degraded/failed features only. */
  errors: boolean
  /** `:suppressed` -- user- (root/cascade) or rollback-suppressed features only. */
  suppressed: boolean
  /** `:type <kind>` (repeatable) -- lowercased kind/opType tokens; empty = no type filter. */
  types: string[]
}

const EMPTY_QUERY: FilterQuery = { text: '', errors: false, suppressed: false, types: [] }

/** True if `query` filters out nothing -- the "clearing the filter restores
 *  the full tree" state (mission #1). */
export function isEmptyFilterQuery(query: FilterQuery): boolean {
  return query.text === '' && !query.errors && !query.suppressed && query.types.length === 0
}

/**
 * Parses raw filter-bar text into a FilterQuery. Recognizes `:errors` and
 * `:suppressed` as standalone tokens, and `:type <kind>` as a two-token
 * operator (the kind is the NEXT whitespace-separated token) -- `:type:kind`
 * (no space) is also accepted as a convenience alias. Unrecognized `:`-led
 * tokens fall through to plain text (matched literally, colon included)
 * rather than being silently dropped, so a typo'd operator is still visible
 * as a (probably non-matching) search term instead of vanishing.
 */
export function parseFilterQuery(raw: string): FilterQuery {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return { ...EMPTY_QUERY }

  let errors = false
  let suppressed = false
  const types: string[] = []
  const textParts: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const lower = tok.toLowerCase()
    if (lower === ':errors') {
      errors = true
      continue
    }
    if (lower === ':suppressed') {
      suppressed = true
      continue
    }
    if (lower === ':type') {
      const next = tokens[i + 1]
      if (next !== undefined) {
        types.push(next.toLowerCase())
        i++
      }
      continue
    }
    if (lower.startsWith(':type:') && lower.length > ':type:'.length) {
      types.push(lower.slice(':type:'.length))
      continue
    }
    textParts.push(lower)
  }

  return { text: textParts.join(' '), errors, suppressed, types }
}

/** The facts about one feature-tree row the filter needs -- deliberately
 *  plain data (no dag/node types) so this stays testable without building a
 *  FeatureDag. FeatureTree.tsx derives these straight from the SAME dag reads
 *  it already performs for rendering (suppressedState/rolledBack/node.kind),
 *  never a second parallel computation. */
export interface FeatureFilterFacts {
  name: string
  /** DagNodeKind, or the feature's own opType (extrude/revolve/boolean/...)
   *  when present -- `:type` matches whichever is more specific, per the
   *  mission's own example list naming opTypes, not DagNodeKinds. */
  typeTag: string
  /** node.degraded, or scheduler status 'failed'/'degraded' -- "pairs with
   *  the shipped degraded badges" per the mission. */
  hasErrors: boolean
  /** root-suppressed, cascade-suppressed, OR rollback-suppressed -- the
   *  mission's own "user- and rollback-suppressed" definition. */
  suppressed: boolean
}

/** True if `facts` satisfies every active clause of `query` (AND across
 *  operators + text; an inactive clause never excludes anything). */
export function matchesFeatureFilter(query: FilterQuery, facts: FeatureFilterFacts): boolean {
  if (query.errors && !facts.hasErrors) return false
  if (query.suppressed && !facts.suppressed) return false
  if (query.types.length > 0 && !query.types.includes(facts.typeTag.toLowerCase())) return false
  if (query.text !== '') {
    const haystack = `${facts.name} ${facts.typeTag}`.toLowerCase()
    if (!haystack.includes(query.text)) return false
  }
  return true
}

/** "12" when unfiltered, "3/12" under an active filter -- mission #1's
 *  "Matched-count shown plainly". */
export function filteredCountLabel(shown: number, total: number, query: FilterQuery): string {
  return isEmptyFilterQuery(query) ? `${total}` : `${shown}/${total}`
}
