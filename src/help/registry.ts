// Help registry - the eager index plus lazy per-category body loading.
// Each category with content gets a dynamic-import loader so topic bodies
// ship as separate chunks and the main bundle stays lean (plan section 2).

import type { HelpCategoryId, HelpIndexEntry, HelpTopic } from './types'
import { HELP_INDEX } from './index-data'
import { englishHelpCatalog, type HelpCatalogTree } from './topics/catalog'
import { HELP_CATEGORIES } from './categories'

type CategoryModule = { topics: HelpTopic[] }

/** Categories WITH content register a loader; the census test asserts every
 *  category that appears in the index has one. */
export const CATEGORY_LOADERS: Partial<Record<HelpCategoryId, () => Promise<CategoryModule>>> = {
  'getting-started': () => import('./topics/getting-started'),
  'workspaces-viewport': () => import('./topics/workspaces-viewport'),
  'import-geometry': () => import('./topics/import-geometry'),
  sketching: () => import('./topics/sketching'),
  // WO-2252: Form's topics are a module of their own (topics/form/) listed
  // under Modeling - Form is a mode of the Model screen.
  modeling: () =>
    Promise.all([import('./topics/modeling'), import('./topics/form')]).then(([model, form]) => ({
      topics: [...model.topics, ...form.topics],
    })),
  'setups-stock-wcs': () => import('./topics/setups-stock-wcs'),
  'cam-operations': () => import('./topics/cam-operations'),
  'tools-holders': () => import('./topics/tools-holders'),
  nesting: () => import('./topics/nesting'),
  simulation: () => import('./topics/simulation'),
  'posting-gcode': () => import('./topics/posting-gcode'),
  machine: () => import('./topics/machine'),
  settings: () => import('./topics/settings'),
  troubleshooting: () => import('./topics/troubleshooting'),
}

export function helpIndex(): HelpIndexEntry[] {
  return HELP_INDEX
}

export function helpIndexEntry(id: string): HelpIndexEntry | undefined {
  return HELP_INDEX.find((e) => e.id === id)
}

const categoryCache = new Map<HelpCategoryId, HelpTopic[]>()

export async function loadCategoryTopics(category: HelpCategoryId): Promise<HelpTopic[]> {
  const cached = categoryCache.get(category)
  if (cached) return cached
  const loader = CATEGORY_LOADERS[category]
  if (!loader) return []
  const mod = await loader()
  categoryCache.set(category, mod.topics)
  return mod.topics
}

/** Load one topic's full body (loads and caches its category chunk). */
export async function loadTopic(id: string): Promise<HelpTopic | null> {
  const entry = helpIndexEntry(id)
  if (!entry) return null
  const topics = await loadCategoryTopics(entry.category)
  return topics.find((t) => t.id === id) ?? null
}

/** Translation tooling can export the entire English `help` namespace.
 * Ordinary app use still loads only the requested category's prose. */
export async function loadEnglishHelpCatalog(): Promise<HelpCatalogTree> {
  await Promise.all(HELP_CATEGORIES.map(category => loadCategoryTopics(category.id)))
  return englishHelpCatalog
}
