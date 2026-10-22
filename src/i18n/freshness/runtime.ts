// WO-2943: the browser half of catalog freshness. No hashing and no Node code
// here: tools/i18n-freshness.mjs --write-runtime decides offline which
// translations are stale against their English source and writes stale.json;
// this module only drops those keys from a language's words, so i18next falls
// back to English for them (UI and Help alike) instead of showing a translation
// written for English that has since changed.
//
// Bootstrap observations and untracked translations are not stale: they stay
// visible. `--check-runtime` fails when stale.json no longer matches the
// catalogs, so a changed English label cannot ship with an old list.
import type { CatalogTree } from '../catalogs'
import runtime from './stale.json'

type Fallback = Readonly<Record<string, readonly string[]>>

/** The full lookup keys (`area.group.key`) of one language that show English. */
export function staleKeys(language: string, fallback: Fallback = runtime.fallback): readonly string[] {
  return Object.hasOwn(fallback, language) ? fallback[language] : []
}

/** One language's area catalogs without its stale keys. The input is never
 *  changed; with nothing stale the same object comes back. */
export function withoutStale(
  language: string,
  catalog: Record<string, CatalogTree>,
  fallback: Fallback = runtime.fallback,
): Record<string, CatalogTree> {
  const keys = staleKeys(language, fallback)
  if (keys.length === 0) return catalog
  const result: Record<string, CatalogTree> = { ...catalog }
  for (const key of keys) {
    const [area, ...path] = key.split('.')
    if (!Object.hasOwn(result, area) || path.length === 0) continue
    result[area] = without(result[area], path)
  }
  return result
}

/** A copy of the tree with one leaf removed; untouched branches are shared. */
function without(tree: CatalogTree, path: readonly string[]): CatalogTree {
  const [head, ...rest] = path
  if (!Object.hasOwn(tree, head)) return tree
  const child = tree[head]
  const next: Record<string, string | CatalogTree> = { ...tree }
  if (rest.length === 0) {
    if (typeof child !== 'string') return tree
    delete next[head]
  } else {
    if (typeof child === 'string') return tree
    next[head] = without(child, rest)
  }
  return next
}
