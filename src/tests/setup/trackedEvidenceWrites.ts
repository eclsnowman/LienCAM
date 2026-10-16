import { execFileSync } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evidenceOutDir, refreshEvidence } from '../support/evidenceScratch'

// Patch the real Node builtins before test collection, including named ESM
// imports and require('fs'). A per-test vi.mock would miss those consumers.
// Child processes/browser downloads are outside this process's boundary.
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const fsp = require('node:fs/promises') as typeof import('node:fs/promises')
const installed = Symbol.for('liencam.wo2780.trackedEvidenceWrites')
const state = fs as typeof fs & { [installed]?: boolean }
const root = process.cwd()

if (!state[installed] && fs.existsSync(resolve(root, '.git'))) {
  const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  const physicalRoot = fs.realpathSync(root)
  // Git's index, rather than existence or status, distinguishes committed
  // baselines from permitted new captures (also protects already dirty files).
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', 'src/tests/evidence'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean).flatMap(path => [key(resolve(root, path)), key(resolve(physicalRoot, path))]))
  const trackedDirectories = new Set<string>()
  for (const file of tracked) {
    for (let parent = dirname(file); parent !== dirname(parent); parent = dirname(parent)) {
      trackedDirectories.add(parent)
      if (parent === key(resolve(root, 'src/tests/evidence')) || parent === key(resolve(physicalRoot, 'src/tests/evidence'))) break
    }
  }
  const native = { mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, copyFileSync: fs.copyFileSync }

  function trackedPath(path: unknown, directory = false): string | null {
    if (typeof path === 'number' || path === null || path === undefined) return null
    const text = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : path
    if (typeof text !== 'string') return null
    const absolute = resolve(text)
    const match = key(absolute)
    return tracked.has(match) || (directory && trackedDirectories.has(match)) ? absolute : null
  }

  function route(path: unknown, seed = false, directory = false): unknown {
    if (refreshEvidence()) return path
    const absolute = trackedPath(path, directory)
    if (!absolute) return path
    const output = evidenceOutDir(absolute)
    native.mkdirSync(dirname(output), { recursive: true })
    if (seed && !native.existsSync(output) && native.existsSync(absolute)) native.copyFileSync(absolute, output)
    return output
  }

  function writing(flags: unknown): boolean {
    return typeof flags === 'number'
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
      : typeof flags === 'string' && /[wa+]/.test(flags)
  }

  function seedForOpen(flags: unknown): boolean {
    // Numeric truncate-without-create requires an existing file. Exclusive
    // creates must still fail on an existing baseline, just as native fs does.
    return typeof flags === 'number'
      ? !(flags & fs.constants.O_TRUNC) || !(flags & fs.constants.O_CREAT) || Boolean(flags & fs.constants.O_EXCL)
      : typeof flags === 'string' && (!flags.startsWith('w') || flags.includes('x'))
  }

  function wrap(target: object, name: string, paths: (args: unknown[]) => void) {
    const object = target as Record<string, unknown>
    const original = object[name]
    if (typeof original !== 'function') return
    object[name] = function (...args: unknown[]) {
      paths(args)
      return Reflect.apply(original, target, args)
    }
  }

  for (const target of [fs, fsp]) {
    for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
      wrap(target, name, args => {
        const flag = (args[2] as { flag?: string | number } | undefined)?.flag
        args[0] = route(args[0], name.startsWith('append') || (flag !== undefined && seedForOpen(flag)))
      })
    }
    for (const name of ['copyFile', 'copyFileSync']) {
      wrap(target, name, args => { args[1] = route(args[1], typeof args[2] === 'number' && Boolean(args[2] & fs.constants.COPYFILE_EXCL)) })
    }
    for (const name of ['cp', 'cpSync']) {
      wrap(target, name, args => { args[1] = route(args[1], false, true) })
    }
    for (const name of ['rename', 'renameSync']) {
      wrap(target, name, args => {
        // A tracked rename source must survive too. Seed a scratch copy, then
        // move that copy, so atomic-replacement writers never consume a baseline.
        args[0] = route(args[0], true)
        args[1] = route(args[1])
      })
    }
    for (const name of ['open', 'openSync']) {
      wrap(target, name, args => { if (writing(args[1])) args[0] = route(args[0], seedForOpen(args[1])) })
    }
    // Capture cleanup must remove scratch, never the committed file it
    // originally targeted. Cover directory cleanup containing tracked leaves.
    for (const name of ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'truncate', 'truncateSync']) {
      wrap(target, name, args => { args[0] = route(args[0], name.startsWith('truncate'), name.startsWith('rm')) })
    }
  }
  wrap(fs, 'createWriteStream', args => {
    const flags = (args[1] as { flags?: string | number } | undefined)?.flags ?? 'w'
    if (writing(flags)) args[0] = route(args[0], seedForOpen(flags))
  })
  state[installed] = true
  syncBuiltinESMExports()
}
