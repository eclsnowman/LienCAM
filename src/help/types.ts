// Help system core types (WO HELP-1, docs/planning/HELP-WIKI-PLAN.md).
//
// Topics are TYPED TS MODULES, not markdown: compile-checked ids, categories,
// and context keys, walkable by the help census test. The EAGER index
// (src/help/index-data.ts) carries only the small searchable fields; bodies
// live in per-category chunks loaded on demand (browser-headroom rule).

export type HelpCategoryId =
  | 'getting-started'
  | 'workspaces-viewport'
  | 'import-geometry'
  | 'sketching'
  | 'modeling'
  | 'setups-stock-wcs'
  | 'cam-operations'
  | 'tools-holders'
  | 'nesting'
  | 'simulation'
  | 'posting-gcode'
  | 'machine'
  | 'settings'
  | 'troubleshooting'

/**
 * Context keys are colon-separated strings, general -> specific, that tie a
 * topic to a place or activity in the app (see plan section 4). The census
 * test validates every declared key against these roots.
 */
export type ContextKey = string

export const CONTEXT_KEY_ROOTS = [
  'workspace',
  'mode',
  'modal',
  'panel',
  'selection',
  'tool',
  'interaction',
  'error',
  'controller',
] as const

export function isValidContextKey(key: string): boolean {
  const parts = key.split(':')
  if (parts.length < 2 && key !== 'error:recent') {
    // every key needs at least root:value; error:recent is already 2 parts
    return false
  }
  if (parts.length > 4) return false
  if (!(CONTEXT_KEY_ROOTS as readonly string[]).includes(parts[0])) return false
  return parts.every((p) => /^[a-z0-9][a-z0-9_-]*$/.test(p))
}

/** One renderable block of a topic body. */
export type HelpSection =
  | { kind: 'paragraph'; text: string }
  | { kind: 'steps'; steps: string[] }
  | { kind: 'tip'; text: string }
  | { kind: 'warning'; text: string }
  | { kind: 'image'; slot: string }
  /** WO-413: a sub-heading inside a long topic. `anchor` is the deep-link
   *  target openHelpTopic(topicId, anchor) scrolls to (kebab-case, unique
   *  within the topic). */
  | { kind: 'heading'; text: string; anchor: string }
  /** WO-413: a small plain table (for example the "what the errors mean"
   *  rows). A row may carry its own `anchor` so a hotlink can land on it. */
  | { kind: 'table'; columns: string[]; rows: Array<{ cells: string[]; anchor?: string }> }

/**
 * An illustration slot. Files live in public/help/<topic-id>/ and are fetched
 * on demand - never bundled. 'needed'/'deferred' slots render nothing yet;
 * the census reports them so image debt stays visible.
 */
export interface HelpImage {
  slot: string
  file: string
  alt: string
  /** What the screenshot must show - instructions for the capture pass. */
  captureNotes: string
  status: 'needed' | 'deferred' | 'done'
}

export interface HelpTopic {
  /** kebab-case, unique, stable forever (deep links depend on it). */
  id: string
  title: string
  category: HelpCategoryId
  /** One sentence, shown in the list, search results, and content header. */
  summary: string
  sections: HelpSection[]
  images: HelpImage[]
  /** Search terms beyond title/summary. */
  keywords: string
  contextKeys: ContextKey[]
  relatedTopicIds: string[]
  /** App version the described feature shipped in. */
  sinceVersion: string
}

/** The always-bundled searchable projection of a topic. */
export interface HelpIndexEntry {
  id: string
  title: string
  category: HelpCategoryId
  summary: string
  keywords: string
  contextKeys: ContextKey[]
}

export function toIndexEntry(topic: HelpTopic): HelpIndexEntry {
  return {
    id: topic.id,
    title: topic.title,
    category: topic.category,
    summary: topic.summary,
    keywords: topic.keywords,
    contextKeys: topic.contextKeys,
  }
}
