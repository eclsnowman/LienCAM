// Phase 6 (P10): design-tree filter logic — extracted as pure functions so the
// match rule is unit-testable independent of React. The tree filters across
// geometry / layers / loops / setups / operations: a row is visible when its
// own display name OR type matches the query (case-insensitive substring), OR
// any of its descendants match (so ancestors of a match stay visible).

/** Normalize a query: trim + lowercase. Empty -> '' (means "no filter"). */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

/**
 * Does a single node's own fields match the (already-normalized) query?
 * Pass any number of haystack strings (display name, type label, format, ...);
 * undefined/empty entries are ignored. An empty query matches everything.
 */
export function matchesFilter(query: string, ...fields: Array<string | undefined | null>): boolean {
  if (!query) return true
  for (const f of fields) {
    if (f && f.toLowerCase().includes(query)) return true
  }
  return false
}

/**
 * Given a node that matches on its own fields (selfMatch) and whether any
 * descendant matches (childMatch), decide if the node row should be visible.
 * Visible when the query is empty, the node itself matches, or a child matches
 * (ancestor-of-a-match stays visible).
 */
export function isVisible(query: string, selfMatch: boolean, childMatch: boolean): boolean {
  return !query || selfMatch || childMatch
}

/** "shown/total" badge text for a section header under an active filter. */
export function filteredCountLabel(shown: number, total: number, query: string): string {
  return query ? `${shown}/${total}` : String(total)
}
