// WO UI-24-R2 (root-cause ruling, item b): "the census method itself committed as a test that
// fails when a new non-dag render input appears." This statically parses SolidsWorkbenchPage.tsx's
// OWN source text for every `useState`/`useRef` declaration and asserts each one is a classified key
// in debugSceneCensus.ts's STATE_CENSUS -- a future hook with no entry fails HERE, not silently
// leaving skipped[] incomplete the way audit UI-24.audit.json and UI-24-R1.audit.json both did.
//
// Reads the real source file with node:fs rather than importing the component, so this test needs
// neither jsdom nor a kernel -- it is a pure text-census check, fast and dependency-free.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { STATE_CENSUS } from '../../components/model3d/debugSceneCensus'

const SOURCE_PATH = new URL('../../components/model3d/SolidsWorkbenchPage.tsx', import.meta.url)

function extractHookNames(source: string): { useState: string[]; useRef: string[] } {
  const useState: string[] = []
  const useRef: string[] = []
  // WORKER-CHARTER item 11: CRLF-safe -- iterate lines rather than anchoring on \n, so this survives
  // either line-ending convention untouched.
  for (const line of source.split(/\r?\n/)) {
    const stateMatch = /const\s+\[\s*(\w+)\s*,\s*set\w+\s*\]\s*=\s*useState\b/.exec(line)
    if (stateMatch) useState.push(stateMatch[1])
    const refMatch = /const\s+(\w+)\s*=\s*useRef\b/.exec(line)
    if (refMatch) useRef.push(refMatch[1])
  }
  return { useState, useRef }
}

describe('WO UI-24-R2: SolidsWorkbenchPage state census completeness', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const { useState, useRef } = extractHookNames(source)

  it('sanity: the source parse actually found hooks (a zero count means the regex/path broke, not that the component has none)', () => {
    expect(useState.length).toBeGreaterThan(20)
    expect(useRef.length).toBeGreaterThan(30)
  })

  it('every useState hook declared in SolidsWorkbenchPage.tsx is classified in STATE_CENSUS', () => {
    const unclassified = useState.filter((name) => !(name in STATE_CENSUS))
    expect(unclassified).toEqual([])
  })

  it('every useRef hook declared in SolidsWorkbenchPage.tsx is classified in STATE_CENSUS', () => {
    const unclassified = useRef.filter((name) => !(name in STATE_CENSUS))
    expect(unclassified).toEqual([])
  })

  it('every STATE_CENSUS entry has a non-empty ruling and note (no silent/placeholder entries)', () => {
    for (const [name, entry] of Object.entries(STATE_CENSUS)) {
      expect(entry.note.length, `census entry '${name}' has an empty note`).toBeGreaterThan(0)
      expect(['captured', 'skip-when-live', 'transient', 'internal']).toContain(entry.ruling)
    }
  })
})
