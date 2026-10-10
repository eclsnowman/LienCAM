// WO-2327: the readable English modules are the source catalog. Only words
// are projected; ids, anchors, context keys, file names and numbers are data.
// No app/runtime import here: the offline wiki exporter loads these modules.
import type { HelpIndexEntry, HelpSection, HelpTopic } from '../types'

export interface HelpCatalogTree { [key: string]: string | HelpCatalogTree }
export const englishHelpCatalog: HelpCatalogTree = {}
type Lookup = (key: string, english: string) => string
let lookup: Lookup = (_key, english) => english

/** Installed by the app's Help entry point; offline consumers stay English. */
export function setHelpTextLookup(next: Lookup): void { lookup = next }

function catalogWord(key: string, english: string): () => string {
  const parts = key.split('.')
  let tree = englishHelpCatalog
  for (const part of parts.slice(0, -1)) {
    tree[part] ??= {}
    tree = tree[part] as HelpCatalogTree
  }
  tree[parts.at(-1)!] = english
  return () => lookup(key, english) || english
}

/** A live projection lets a cached topic follow the current language, while
 * keeping the English source immutable and code-split by category. */
function words<T extends object>(source: T, prefix: string, fields: Array<keyof T>): T {
  const result = { ...source }
  for (const field of fields) {
    const english = source[field]
    if (typeof english !== 'string') continue
    Object.defineProperty(result, field, {
      enumerable: true,
      get: catalogWord(`${prefix}.${String(field)}`, english),
    })
  }
  return result
}

export function helpCategoryLabel(id: string, english: string): () => string {
  return catalogWord(`categories.${id}`, english)
}

export function localizeHelpIndex(entries: HelpIndexEntry[]): HelpIndexEntry[] {
  return entries.map(entry => words(entry, `topics.${entry.id}`, ['title', 'summary', 'keywords']))
}

function sectionWords(section: HelpSection, prefix: string): HelpSection {
  switch (section.kind) {
    case 'image': return section
    case 'paragraph': case 'tip': case 'warning': case 'heading':
      return words(section, prefix, ['text'])
    case 'steps': {
      const steps = section.steps.map((text, i) => catalogWord(`${prefix}.steps.${i}`, text))
      return { ...section, get steps() { return steps.map(read => read()) } }
    }
    case 'table': {
      const columns = section.columns.map((text, i) => catalogWord(`${prefix}.columns.${i}`, text))
      const rows = section.rows.map((row, i) => {
        const cells = row.cells.map((text, j) => catalogWord(`${prefix}.rows.${i}.cells.${j}`, text))
        return { ...row, get cells() { return cells.map(read => read()) } }
      })
      return { ...section, rows, get columns() { return columns.map(read => read()) } }
    }
  }
}

export function localizeHelpTopics(topics: HelpTopic[]): HelpTopic[] {
  return topics.map(topic => {
    const prefix = `topics.${topic.id}`
    return Object.assign(words(topic, prefix, ['title', 'summary', 'keywords']), {
      sections: topic.sections.map((section, i) => sectionWords(section, `${prefix}.sections.${i}`)),
      images: topic.images.map(image => words(image, `${prefix}.images.${image.slot}`, ['alt'])),
    })
  })
}
