// A memoised sweep of every .ts/.tsx file under src/ - WO-960.
//
// Several suites here are GUARDS: they read all of src/ and fail if a
// forbidden shape appears anywhere in it. Breadth is the entire guarantee of
// such a guard, so it must never be narrowed to go faster. Its COST, though,
// is a real liability: reading 31 MB across ~2,250 files twice in one file put
// the WO-912 pin-rule guard within a whisker of vitest's 5,000 ms default test
// timeout, and under CPU starvation it went over. Captured 2026-08-25:
//
//     x ... detects the AXBB table when it IS present ... 5457ms
//       -> Test timed out in 5000ms.
//
// The guard's answer was never wrong. It was simply too slow to finish, and a
// guard that goes amber under load is a guard people learn to wave through.
// See src/tests/evidence/WO-960/ for the reproduction and the numbers.
//
// This module keeps the breadth and deletes everything above the floor:
//
//   1. The tree is read ONCE per process, in parallel, and each file's verdict
//      is memoised - so a second sweep in the same file re-reads nothing.
//   2. A caller-supplied cheap `screen` skips the expensive work for the files
//      that cannot possibly match. The screen MUST be a strict superset of
//      `inspect`; see the WO-912 suite for how that is argued and proven.
//   3. An OPTIONAL `prescreen` over the raw bytes runs before the file is
//      decoded at all. Turning 31 MB of UTF-8 into UTF-16 strings costs more
//      than reading it does, and a rule whose screen needs a literal byte
//      sequence can skip that for the files that lack it. Same superset rule,
//      one level earlier - and the same discipline: it must be argued from the
//      screen's own text and checked by running the unscreened `inspect` over
//      what it drops. No rule in the tree needs it today; the WO-912 guard uses
//      `screen` only.
//
// The floor that remains is the ~2,300 file reads themselves. That is the
// breadth, and it is not negotiable.

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export interface SourceSweepRule<T> {
  // OPTIONAL, and cheaper still: a screen over the file's BYTES, run before the
  // 31 MB is decoded from UTF-8 into UTF-16 strings. Decoding costs more than
  // the reads do, so a rule whose screen cannot match without some literal byte
  // sequence being present can say so here and skip the decode entirely.
  //
  // It carries the SAME hazard as `screen` and then some - it runs first, so a
  // file it drops is never even looked at - and it earns the same discipline:
  // it must be a strict superset of `screen`, argued from the screen's own
  // text, and checked by running the unscreened `inspect` over what it drops.
  prescreen?: (buffer: Buffer) => boolean
  // Cheap, allocation-free screen over the file's RAW text. A file this
  // rejects is never inspected, so it MUST accept everything `inspect` could
  // flag. Getting this wrong makes the guard vacuous silently.
  screen: (raw: string) => boolean
  // The real check. Returns this file's findings, or [] for a clean file.
  inspect: (raw: string, relPath: string) => T[]
  // Paths (repo-relative, forward slashes) the rule excuses - typically the
  // suite that states the rule and must be free to name what it forbids.
  skip?: (relPath: string) => boolean
}

export interface SourceSweep<T> {
  run: () => Promise<T[]>
  // Drop one file's memoised verdict. A suite that WRITES into src/ - a
  // negative control proving the guard still fires - calls this so its fixture
  // is read fresh rather than answered from a previous sweep.
  forget: (absPath: string) => void
}

const SRC_ROOT = join(process.cwd(), 'src')

// Bounded so a sweep cannot exhaust file handles on a loaded box; measured
// flat from 32 upwards, so this is headroom rather than a tuned number.
const READ_CONCURRENCY = 128

// `evidence/` holds captured transcripts and rendered proof, not product code,
// and a slice churns it constantly. `node_modules` is never ours.
const SKIPPED_DIRECTORIES = new Set(['evidence', 'node_modules'])

export const collectSourceFiles = (dir: string = SRC_ROOT, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      collectSourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

export const toRepoPath = (absPath: string): string =>
  relative(process.cwd(), absPath).split(sep).join('/')

export const createSourceSweep = <T>(rule: SourceSweepRule<T>): SourceSweep<T> => {
  const verdicts = new Map<string, T[]>()

  const readVerdict = async (absPath: string): Promise<T[]> => {
    const relPath = toRepoPath(absPath)
    if (rule.skip?.(relPath)) return []
    if (!rule.prescreen) {
      const raw = await readFile(absPath, 'utf8')
      return rule.screen(raw) ? rule.inspect(raw, relPath) : []
    }
    // Every byte is still read - the breadth is the guarantee and it is not
    // negotiable. Only the DECODE is conditional.
    const buffer = await readFile(absPath)
    if (!rule.prescreen(buffer)) return []
    const raw = buffer.toString('utf8')
    return rule.screen(raw) ? rule.inspect(raw, relPath) : []
  }

  return {
    forget: (absPath) => { verdicts.delete(absPath) },
    run: async () => {
      // The walk is re-done every sweep (~20 ms) so a file that appeared since
      // the last one - a negative control's fixture - is always discovered.
      const files = collectSourceFiles()
      const pending = files.filter((file) => !verdicts.has(file))

      let next = 0
      const worker = async () => {
        for (;;) {
          const index = next++
          if (index >= pending.length) return
          const file = pending[index]
          verdicts.set(file, await readVerdict(file))
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, worker),
      )

      const findings: T[] = []
      for (const file of files) findings.push(...(verdicts.get(file) ?? []))
      return findings
    },
  }
}
