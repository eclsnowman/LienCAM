// WO-3009 privacy guard. Reference programs, values and store paths never
// enter the repository: the store path comes only from the environment, an
// unset variable skips the private run, and a store inside the working tree
// is refused.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

export const STORE_ENV = 'LIENCAM_REFERENCE_CAM_DIR'

/** The working tree's root (git), or `cwd` when git is unavailable. */
export function repositoryRoot(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return cwd
  }
}

/** Resolve symlinks on the longest existing prefix, so a link into the repo is still seen as inside it. */
function physical(path: string): string {
  const missing: string[] = []
  let head = resolve(path)
  while (!existsSync(head) && dirname(head) !== head) { missing.unshift(basename(head)); head = dirname(head) }
  return resolve(realpathSync(head), ...missing)
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(physical(root), physical(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type StoreLocation = { dir: string; skip?: undefined } | { dir?: undefined; skip: string }

export function referenceStoreDir(env: Record<string, string | undefined> = process.env, root = repositoryRoot()): StoreLocation {
  const raw = env[STORE_ENV]?.trim()
  if (!raw) return { skip: `${STORE_ENV} is not set; the private reference-CAM run is skipped` }
  if (isInside(raw, root)) {
    throw new Error(`reference store refused: ${STORE_ENV} points inside the repository working tree; reference programs must stay outside it`)
  }
  return { dir: resolve(raw) }
}
