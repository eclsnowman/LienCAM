import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const { exportPublic } = await import(new URL('../../../tools/release/export-public.mjs', import.meta.url).href)
const directories: string[] = []
afterEach(() => {
  // Isolated git-init fixtures only: no worktrees or dependency links.
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected fixture path')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('exports only scripts whose direct Node file targets ship, preserving installed dependencies and inline commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo2722-'))
  const output = mkdtempSync(join(tmpdir(), 'liencam-wo2722-export-'))
  directories.push(root, output)
  mkdirSync(join(root, 'tools/release'), { recursive: true })
  writeFileSync(join(root, 'tools/kept.mjs'), 'console.log("ready")\n')
  const scripts = {
    dev: 'vite', kept: 'node tools/kept.mjs', flags: 'node --max-old-space-size=8192 tools/kept.mjs',
    quoted: 'node "tools/kept.mjs"', missing: 'node tools/missing.mjs',
    chain: 'npm run build && node --experimental-strip-types tools/missing.mts',
    later: 'node tools/kept.mjs && node tools/missing.mjs',
    build: 'node --max-old-space-size=8192 node_modules/typescript/bin/tsc -b',
    inline: 'node -e "console.log(1)"', print: 'node --print "1+1"',
  }
  const packageText = JSON.stringify({ scripts }) + '\n'
  writeFileSync(join(root, 'package.json'), packageText)
  writeFileSync(join(root, 'tools/release/manifest.json'), JSON.stringify({ version: 1,
    selection: ['package.json', 'tools/kept.mjs'].map(path => ({ action: 'include', path, reason: 'Public fixture.' })),
    scan: { allowedNames: [], allowedEmailDomains: [], allowedBinaryExtensions: [], ruleExceptions: [] },
  }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  git('init', '--quiet')
  git('add', 'package.json', 'tools')
  git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'WO-2722 fixture')
  const result = exportPublic('HEAD', output, { cwd: root, log: () => {} })
  expect(result.hits).toBe(0)
  const actual = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).scripts
  expect(actual).not.toHaveProperty('missing')
  expect(actual).not.toHaveProperty('chain')
  expect(actual).not.toHaveProperty('later')
  const { missing, chain, later, ...kept } = scripts
  expect(actual).toEqual(kept)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(packageText)
})
