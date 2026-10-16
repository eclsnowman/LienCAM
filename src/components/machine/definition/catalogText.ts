import { Children, type ReactNode } from 'react'
import { i18n } from '../../../i18n'

// Keep the original React child boundaries: flex lays out separate text nodes
// as separate anonymous items. A single interpolated string silently changes
// that spacing, despite identical textContent. Markers let translators reorder
// the whole sentence while React still renders the original values as children
// (including null/boolean/array rules), without adding wrappers or HTML parsing.
const childMarker = String.fromCharCode(0)
const childMarkerPattern = new RegExp(`(${childMarker}value\\d+${childMarker})`, 'g')

export function catalogChildren(sentence: string, values: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return Children.toArray(sentence.split(childMarkerPattern).map((part) =>
    part.startsWith('\u0000') ? values[part.slice(1, -1)] : part,
  ))
}

// Exported display tables keep their existing shape and stable identity. Read
// their translated values again on a language switch, rather than freezing
// whichever language was selected when the module was first imported.
export function liveCatalog<T extends object>(read: () => T): T {
  let language = i18n.language
  let value = read()
  return new Proxy(value, {
    get(_target, property) {
      if (language !== i18n.language) {
        language = i18n.language
        value = read()
      }
      return Reflect.get(value, property)
    },
  })
}
