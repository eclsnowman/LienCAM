import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
const moduleUrl = (path: string) => new URL(`../../../${path}`, import.meta.url).href
const { landingFixture } = await import(moduleUrl('src/tests/evidence/WO-2893/landing-fixture.mjs'))
// Keep all six Windows assertions visible as platform skips on Linux.
const hosts = ['powershell.exe', 'pwsh.exe']

describe.skipIf(process.platform !== 'win32')('WO-2893 landing refuses before mutation', () => {
  it.each(hosts)('refuses a missing git-store junction before any git command on %s', host => {
    const result = landingFixture(host, 'missing-junction')
    expect(result.status, JSON.stringify(result)).toBe(1)
    expect(result.commands).not.toContain('git ')
    expect(result.commands).not.toContain('npm')
  })
  it.each(hosts)('refuses scan hits before landing commit, tests, build or main merge on %s', host => {
    const result = landingFixture(host, 'scan-red')
    expect(result.status, JSON.stringify(result)).toBe(1)
    expect(result.commands).toContain('--scan-changed main HEAD')
    expect(result.commands).not.toContain('git commit')
    expect(result.commands).not.toContain('npx')
    expect(result.commands).not.toContain('npm')
    expect(result.commands).not.toContain('git merge --no-edit wo/')
  })
  it.each(hosts)('retains native stderr and successful landing with a clean scan on %s', host => {
    const result = landingFixture(host, 'clean')
    expect(result.status, JSON.stringify(result)).toBe(0)
    expect(result.log).toContain('benign-native-diagnostic')
    expect(result.log).toContain('release changed-file scan green')
    expect(result.commands).toContain('git push origin main')
    expect(result.commands.indexOf('--scan-changed')).toBeLessThan(result.commands.indexOf('git commit'))
    const source = readFileSync(resolve('.planning/architect-scripts/hand-land.ps1'), 'utf8')
    expect(source).toContain("$ErrorActionPreference = 'Continue'")
    expect(source).toContain('main-busy.mjs')
    expect(source).toContain('LIENCAM_HAND_LAND_TOKEN')
  })
})

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const manifest = {
  version: 1,
  selection: [
    { action: 'include', path: 'src/' }, { action: 'exclude', path: 'src/private/' },
    { action: 'include', path: 'src/private/public/' },
    { action: 'include', path: 'Example Projects/' },
    { action: 'include', path: 'release/workflows/', destination: '.github/workflows/' },
    { action: 'include', path: 'tools/release/manifest.json' },
  ],
  scan: { allowedBinaryExtensions: [], allowedEmailDomains: [], ruleExceptions: [] },
}
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wo2893-repo-'))
  git(root, 'init', '-qb', 'main')
  git(root, 'config', 'user.name', 'WO-2893 fixture')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  const put = (file: string, text: string | Buffer) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  put('tools/release/manifest.json', JSON.stringify(manifest))
  put('src/app.ts', 'old app\n')
  put('src/deleted.ts', 'old deleted\n')
  put('src/private/session.ts', 'private baseline\n')
  put('src/private/public/fixture.ts', 'old public fixture\n')
  put('Example Projects/ready.lcam', 'old example\n')
  put('release/workflows/ci.yml', 'old workflow\n')
  put('queue/private.md', 'old queue\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline')
  git(root, 'branch', 'release/fixture')
  const base = git(root, 'rev-parse', 'HEAD')
  put('src/app.ts', 'new app\n'); put('src/private/session.ts', 'private changed\n')
  put('src/private/public/fixture.ts', 'new public fixture\n')
  put('Example Projects/ready.lcam', 'new example\n'); put('release/workflows/ci.yml', 'new workflow\n')
  put('queue/private.md', 'new queue\n'); rmSync(join(root, 'src/deleted.ts'))
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'source updates')
  const source = git(root, 'rev-parse', 'HEAD')
  return { root, base, source, put, close: () => rmSync(root, { recursive: true, force: true }) }
}
const loadPort = () => import(moduleUrl('tools/release/port-to-release.mjs'))
const noJunction = () => {}
const unlocked = (execute: () => unknown) => execute()

describe('WO-2893 manifest release plumbing', () => {
  it('ports every selected file, deletes removed files and preserves excluded/private release bytes', async () => {
    const f = fixtureRepo()
    try {
      const port = await loadPort()
      const index = readFileSync(join(f.root, '.git/index'))
      const result = await port.portToRelease({ root: f.root, branch: 'release/fixture' }, { checkJunction: noJunction, protect: unlocked })
      expect(result.writes).toBe(true)
      expect(git(f.root, 'show', 'release/fixture:Example Projects/ready.lcam')).toBe('new example')
      expect(git(f.root, 'show', 'release/fixture:release/workflows/ci.yml')).toBe('new workflow')
      expect(git(f.root, 'show', 'release/fixture:src/private/public/fixture.ts')).toBe('new public fixture')
      expect(git(f.root, 'show', 'release/fixture:src/private/session.ts')).toBe('private baseline')
      expect(git(f.root, 'show', 'release/fixture:queue/private.md')).toBe('old queue')
      expect(git(f.root, 'ls-tree', '-r', 'release/fixture', '--', 'src/deleted.ts')).toBe('')
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.source)
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(index)
      expect(git(f.root, 'status', '--porcelain')).toBe('')
      const again = await port.portToRelease({ root: f.root, branch: 'release/fixture' }, { checkJunction: noJunction, protect: unlocked })
      expect(again).toMatchObject({ writes: false, changed: [] })
    } finally { f.close() }
  })
  it('dry-runs using the committed manifest and never updates either ref or the checkout', async () => {
    const f = fixtureRepo()
    try {
      f.put('tools/release/manifest.json', '{ broken uncommitted manifest')
      const port = await loadPort()
      const result = await port.portToRelease({ root: f.root, branch: 'release/fixture', dryRun: true }, { checkJunction: noJunction })
      expect(result).toMatchObject({ writes: false, dryRun: true })
      expect(result.changed).toContain('Example Projects/ready.lcam')
      expect(git(f.root, 'rev-parse', 'release/fixture')).toBe(f.base)
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.source)
      expect(readFileSync(join(f.root, 'tools/release/manifest.json'), 'utf8')).toBe('{ broken uncommitted manifest')
    } finally { f.close() }
  })
  it('refuses selected drift and any candidate modification outside the manifest', async () => {
    const f = fixtureRepo()
    try {
      const port = await loadPort()
      expect(() => port.assertPortMatches(f.root, f.base, f.source, f.base, manifest)).toThrow('release drift')
      expect(() => port.assertPortMatches(f.root, f.source, f.source, f.base, manifest)).toThrow('outside selection:')
      expect(() => port.assertPortMatches(f.root, f.source, f.source, f.base, manifest)).toThrow('queue/private.md')
    } finally { f.close() }
  })
  it('refuses non-release targets, invalid sources and missing infrastructure without ref changes', async () => {
    const f = fixtureRepo()
    try {
      const port = await loadPort()
      await expect(port.portToRelease({ root: f.root, branch: 'main' }, { checkJunction: noJunction })).rejects.toThrow('release/*')
      await expect(port.portToRelease({ root: f.root, branch: 'release/fixture', source: 'absent' }, { checkJunction: noJunction, protect: unlocked })).rejects.toThrow()
      await expect(port.portToRelease({ root: f.root, branch: 'release/fixture' }, { checkJunction: () => { throw new Error('missing junction') } })).rejects.toThrow('missing junction')
      expect(git(f.root, 'rev-parse', 'release/fixture')).toBe(f.base)
    } finally { f.close() }
  })
  it('refuses a concurrent source update before changing the release ref', async () => {
    const f = fixtureRepo()
    try {
      const port = await loadPort()
      let checks = 0
      await expect(port.portToRelease({ root: f.root, branch: 'release/fixture' }, {
        protect: unlocked, checkJunction: () => { if (++checks === 3) git(f.root, 'update-ref', 'refs/heads/main', f.base, f.source) },
      })).rejects.toThrow('source changed')
      expect(git(f.root, 'rev-parse', 'release/fixture')).toBe(f.base)
    } finally { f.close() }
  })
  it('refuses a checked-out release and preserves a concurrent release ref update', async () => {
    const f = fixtureRepo()
    try {
      const port = await loadPort()
      git(f.root, 'checkout', '-q', 'release/fixture')
      await expect(port.portToRelease({ root: f.root, branch: 'release/fixture', dryRun: true }, { checkJunction: noJunction })).rejects.toThrow('checked out')
      git(f.root, 'checkout', '-q', 'main')
      let checks = 0
      await expect(port.portToRelease({ root: f.root, branch: 'release/fixture' }, {
        protect: unlocked, checkJunction: () => { if (++checks === 3) git(f.root, 'update-ref', 'refs/heads/release/fixture', f.source, f.base) },
      })).rejects.toThrow()
      expect(git(f.root, 'rev-parse', 'release/fixture')).toBe(f.source)
    } finally { f.close() }
  })
})

describe('WO-2893 committed changed-file release scan', () => {
  it('reports every public hit while omitting deletions, excluded inputs and queue changes', async () => {
    const f = fixtureRepo()
    try {
      f.put('src/app.ts', '// ' + ['Er', 'ic'].join('') + '\n')
      f.put('src/other.ts', '// ' + ['Master', 'cam'].join('') + '\n')
      f.put('src/private/session.ts', '// ' + ['Er', 'ic'].join('') + '\n')
      f.put('queue/private.md', ['Er', 'ic'].join(''))
      git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'scan fixture')
      f.put('src/app.ts', '// clean uncommitted bytes\n')
      const { scanChanged } = await loadPort()
      const report = scanChanged({ root: f.root, base: f.base })
      expect(report.hits.map((hit: { file: string }) => hit.file).sort()).toEqual(['src/app.ts', 'src/other.ts'])
      const cli = spawnSync(process.execPath, [resolve('tools/release/port-to-release.mjs'), '--scan-changed', f.base, 'HEAD'], { cwd: f.root, encoding: 'utf8' })
      expect(cli.status, cli.stderr).toBe(1)
      expect(cli.stdout).toContain('scan: 2 hits')
    } finally { f.close() }
  })
  it('honors manifest exceptions at the mapped public destination', async () => {
    const f = fixtureRepo()
    try {
      f.put('release/workflows/ci.yml', '# ' + ['Er', 'ic'].join('') + '\n')
      f.put('tools/release/manifest.json', JSON.stringify({ ...manifest, scan: { ...manifest.scan,
        ruleExceptions: [
          { rule: 'personal:' + ['er', 'ic'].join(''), path: '.github/workflows/ci.yml', reason: 'fixture' },
          { rule: '*', path: 'tools/release/manifest.json', reason: 'synthetic scanner policy' },
        ] } }))
      git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'exception fixture')
      const { scanChanged } = await loadPort()
      expect(scanChanged({ root: f.root, base: f.base }).hits).toEqual([])
      expect(scanChanged({ root: f.root, base: 'HEAD' }).files).toBe(0)
    } finally { f.close() }
  })
})

describe('WO-2893 actual Windows junction check', () => {
  it.skipIf(process.platform !== 'win32')('accepts only a Junction to the designated live store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wo2893-junction-'))
    const store = join(root, 'store'), other = join(root, 'other'), link = join(root, '.git')
    mkdirSync(store); mkdirSync(other)
    const { assertGitJunction } = await import(moduleUrl('tools/git-junction-check.mjs'))
    try {
      expect(() => assertGitJunction(root, store)).toThrow()
      mkdirSync(link)
      expect(() => assertGitJunction(root, store)).toThrow('must be a Junction')
      rmdirSync(link)
      symlinkSync(other, link, 'junction')
      expect(() => assertGitJunction(root, store)).toThrow('wrong store')
      rmdirSync(link)
      symlinkSync(store, link, 'junction')
      expect(assertGitJunction(root, store).store.toLowerCase()).toBe(realpathSync.native(store).toLowerCase())
      const cli = spawnSync(process.execPath, [resolve('tools/git-junction-check.mjs'), '--root', root, '--store', store], { encoding: 'utf8' })
      expect(cli.status, cli.stderr).toBe(0)
    } finally {
      if (existsSync(link)) rmdirSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
