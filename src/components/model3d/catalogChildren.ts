import { Children, type ReactNode } from 'react'

// Same catalog-child convention as WO-2324: preserve original text/value
// boundaries without wrappers, while the complete sentence remains reorderable.
const childMarker = String.fromCharCode(0)
const childMarkerPattern = new RegExp('(' + childMarker + 'value\\d+' + childMarker + ')', 'g')

export function catalogChildren(sentence: string, values: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return Children.toArray(sentence.split(childMarkerPattern).map((part) =>
    part.startsWith('\u0000') ? values[part.slice(1, -1)] : part,
  ))
}
