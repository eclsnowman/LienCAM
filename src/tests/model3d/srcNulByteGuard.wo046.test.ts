// WO-046 closure 3: a literal NUL byte landed inside a source string (the
// holeSavedFaceKey join separator in SolidsWorkbenchPage.tsx) and silently
// flipped the whole file to "binary" for rg -- every subsequent text search
// skipped it. This guard makes that class of defect a red test instead of a
// silent search blind spot: NO source file under src/ may contain byte 0x00.
// Scope is deliberately src/-only and code/text extensions only (binary
// assets like .png/.stl/.wasm evidence fixtures legitimately contain NULs).

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '..', '..')

/** Extensions where a NUL byte can only be a defect. Everything else under
 *  src/ (captured meshes, screenshots, wasm, logs) is data, not source. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.mjs', '.js',
  '.css', '.html', '.json', '.md', '.yml', '.sh',
])

/** Pre-existing offenders found by this guard's first sweep, pinned at their
 *  EXACT current NUL count so a fix forces deleting the entry and a NEW NUL
 *  in the same file still fails. WO-046 owns only model3d paths, so the fix
 *  itself needs its own WO (logged in WO-046's worker result). */
const KNOWN_OFFENDERS = new Map<string, number>([
  // Literal NUL join separators in lintAuthoringSpace's memo key (~line 1015).
  ['tests/ui/support/overlayAuthoringLint.ts', 2],
])

function sourceFilesUnder(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(path))
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0) continue
    if (SOURCE_EXTENSIONS.has(entry.name.slice(dot))) out.push(path)
  }
  return out
}

describe('src/ NUL-byte guard (WO-046)', () => {
  it('no source file under src/ contains a NUL byte', () => {
    const files = sourceFilesUnder(SRC_ROOT)
    // The sweep must actually be sweeping: an empty list would pass vacuously
    // if the walk root ever went stale.
    expect(files.length).toBeGreaterThan(1000)
    const offenders: string[] = []
    const staleAllowlist: string[] = []
    const seenKnown = new Set<string>()
    for (const file of files) {
      const bytes = readFileSync(file)
      let nulCount = 0
      for (const byte of bytes) if (byte === 0) nulCount += 1
      const key = relative(SRC_ROOT, file).split(sep).join('/')
      const allowed = KNOWN_OFFENDERS.get(key)
      if (allowed !== undefined) {
        seenKnown.add(key)
        // An exact pin: fixing the file (or adding another NUL) both fail,
        // so the allowlist can only shrink.
        if (nulCount !== allowed) staleAllowlist.push(`${key}: expected ${allowed} NULs, found ${nulCount}`)
        continue
      }
      if (nulCount > 0) offenders.push(key)
    }
    expect(offenders).toEqual([])
    expect(staleAllowlist).toEqual([])
    expect([...KNOWN_OFFENDERS.keys()].filter((k) => !seenKnown.has(k))).toEqual([])
  })
})
