import { pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const SOURCE = 'release/github-workflows/'
const TARGET = '.github/workflows/'
const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'liencam-wo2403-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(root: string, path: string, contents: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function fixture(options: { destination?: string; unsafeContent?: boolean } = {}) {
  const root = temporaryDirectory()
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/release/manifest.json'), 'utf8'))
  // Use the real mapping, rather than inventing one the product does not ship.
  manifest.selection = manifest.selection.filter((entry: { path: string }) =>
    entry.path === '.github/' || entry.path === SOURCE)
  const mapping = manifest.selection.find((entry: { path: string }) => entry.path === SOURCE)
  if (options.destination !== undefined) mapping.destination = options.destination
  write(root, 'tools/release/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of ['export-public.mjs', 'scan.mjs']) {
    copyFileSync(join(ROOT, 'tools/release', name), join(root, 'tools/release', name))
  }
  // WO-2488: the exporter now imports the production public-test selector.
  writeFileSync(join(root, 'tools/release/public-tests.mjs'),
    `export * from ${JSON.stringify(pathToFileURL(join(ROOT, 'tools/release/public-tests.mjs')).href)}\n`)
  const workflow = readFileSync(join(ROOT, SOURCE, 'issue-intake.yml'))
  write(root, `${SOURCE}issue-intake.yml`, workflow)
  write(root, `${SOURCE}nested/another.yml`, 'name: Another public workflow\r\non: workflow_dispatch\r\n')
  write(root, '.github/ISSUE_TEMPLATE/fixture.yml', 'name: Fixture issue\n')
  write(root, '.github/workflows/existing.yml', 'name: Existing workflow\n')
  if (options.unsafeContent) write(root, `${SOURCE}unsafe.yml`, 'host: 192.168.1.12\n')
  git(root, 'init', '--quiet')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'WO-2403 export fixture')
  return { root, workflow }
}

function exportFixture(root: string) {
  const output = temporaryDirectory()
  const result = spawnSync(process.execPath, [join(root, 'tools/release/export-public.mjs'), 'HEAD', output], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  })
  return { output, result }
}

function snapshot(root: string, path = ''): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path ? `${path}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(files, snapshot(root, relativePath))
    else files[relativePath] = readFileSync(join(root, relativePath)).toString('base64')
  }
  return files
}

afterEach(() => {
  // These are isolated git-init fixtures, with no worktrees or dependency links.
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WO-2403 public workflow export mapping', () => {
  it('exports committed workflows byte for byte at the public path and repeats identically', () => {
    const { root, workflow } = fixture()
    write(root, `${SOURCE}issue-intake.yml`, 'dirty working-tree content\n')
    const first = exportFixture(root)
    expect(first.result.status, `${first.result.stdout}\n${first.result.stderr}`).toBe(0)
    expect(existsSync(join(first.output, TARGET, 'issue-intake.yml')), 'missing .github/workflows/issue-intake.yml').toBe(true)
    expect(readFileSync(join(first.output, TARGET, 'issue-intake.yml'))).toEqual(workflow)
    expect(readFileSync(join(first.output, TARGET, 'nested/another.yml')))
      .toEqual(readFileSync(join(root, SOURCE, 'nested/another.yml')))
    expect(existsSync(join(first.output, SOURCE))).toBe(false)
    expect(existsSync(join(first.output, 'release'))).toBe(false)
    expect(existsSync(join(first.output, '.github/ISSUE_TEMPLATE/fixture.yml'))).toBe(true)
    expect(readFileSync(join(first.output, TARGET, 'existing.yml'), 'utf8')).toBe('name: Existing workflow\n')
    expect(first.result.stdout).toContain('scan: clean - 4 files')
    const second = exportFixture(root)
    expect(second.result.status, `${second.result.stdout}\n${second.result.stderr}`).toBe(0)
    expect(snapshot(second.output)).toEqual(snapshot(first.output))
    expect(second.result.stdout).toBe(first.result.stdout)
  })

  it('scans mapped content at its public destination', () => {
    const { root } = fixture({ unsafeContent: true })
    const { result } = exportFixture(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('.github/workflows/unsafe.yml:1 [personal:rfc1918-ip]')
    expect(result.stdout).toContain('scan: 1 hit in 5 files')
  })

  it.each(['../outside/', '/absolute/', 'C:/outside/', '.git/hooks/', '.github/../outside/', '.github\\workflows/'])(
    'rejects unsafe mapping destination %s before extraction', destination => {
      const { root } = fixture({ destination })
      const { output, result } = exportFixture(root)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('unsafe export destination')
      expect(readdirSync(output)).toEqual([])
    })
})
