import { Children, type ReactNode } from 'react'

// Preserve the original React text/value child boundaries, including when
// identical textContent alone cannot establish identical rendering. Markers let translators reorder
// the whole sentence while React still renders the original values as children
// (including null/boolean/array rules), without adding wrappers or HTML parsing.
const childMarker = String.fromCharCode(0)
const childMarkerPattern = new RegExp(`(${childMarker}value\\d+${childMarker})`, 'g')

export function catalogChildren(sentence: string, values: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return Children.toArray(sentence.split(childMarkerPattern).map((part) =>
    part.startsWith('\u0000') ? values[part.slice(1, -1)] : part,
  ))
}

