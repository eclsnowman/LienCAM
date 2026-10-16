import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export type TrackedState = Map<string, string>

// Git identifies changed paths; hash their current bytes too, so an already
// dirty file cannot be overwritten unnoticed. Never restore anything here:
// the failure must preserve both the user's edits and the offending output.
export function trackedState(root: string): TrackedState {
  const records = execFileSync('git', [
    'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames',
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return new Map(records.split('\0').filter(Boolean).map(record => {
    const path = record.slice(3)
    const full = join(root, path)
    const bytes = existsSync(full)
      ? lstatSync(full).isSymbolicLink() ? readlinkSync(full) : readFileSync(full)
      : '<deleted>'
    // MM can remain MM even when a test stages a different version and then
    // restores the working bytes. Include the staged blob/mode, not just XY.
    const staged = record[0] === ' ' ? '' : execFileSync('git', ['ls-files', '--stage', '-z', '--', path],
      { cwd: root, encoding: 'utf8', windowsHide: true })
    return [path, record.slice(0, 2) + staged + createHash('sha256').update(bytes).digest('hex')]
  }))
}

export function assertTrackedStateUnchanged(root: string, before: TrackedState): void {
  const after = trackedState(root)
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path)).sort()
  if (changed.length) {
    throw new Error(`Test run changed tracked files:\n${changed.join('\n')}\nWrite generated output to .test-scratch/ instead.`)
  }
}
