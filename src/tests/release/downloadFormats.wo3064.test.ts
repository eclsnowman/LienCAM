import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs tool
import { downloadsTable } from '../../../tools/release/downloads-table.mjs'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml')
const { Arch, getArtifactArchName } = require('builder-util')
const root = resolve(import.meta.dirname, '../../..')
const script = join(root, 'tools/release/make-releases-json.mjs')
const tag = 'v0.37.1-alpha.3.1'
const version = tag.slice(1)
const config = load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
const directories: string[] = []

// Names come from electron-builder's own spelling of each CPU, not from this test.
const name = (pattern: string, os: string, arch: number, ext: string) => pattern
  .replace('${productName}', config.productName).replace('${version}', version)
  .replace('${os}', os).replace('${arch}', getArtifactArchName(arch, ext)).replace('${ext}', ext)
const both = [Arch.x64, Arch.arm64]
const matrixNames = [
  ...both.flatMap(a => [name(config.nsis.artifactName, 'win', a, 'exe'), name(config.portable.artifactName, 'win', a, 'exe')]),
  ...both.flatMap(a => ['dmg', 'zip'].map(ext => name(config.artifactName, 'mac', a, ext))),
  ...both.flatMap(a => ['AppImage', 'tar.gz', 'deb', 'rpm'].map(ext => name(config.artifactName, 'linux', a, ext))),
]

function fixture(names: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'liencam-wo3064-'))
  directories.push(directory)
  for (const file of names) writeFileSync(join(directory, file), `bytes of ${file}`)
  writeFileSync(join(directory, 'gateway.py'), 'gateway')
  return directory
}
const run = (directory: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, directory, '--tag', tag, ...args], { encoding: 'utf8', windowsHide: true })
const assets = (directory: string) => JSON.parse(readFileSync(join(directory, 'releases.json'), 'utf8')).assets

afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('WO-3064 more download formats and architectures', () => {
  it('electron-builder builds deb and rpm beside the unchanged AppImage and tar.gz, with Intel and arm64 Mac targets', () => {
    expect(config.linux.target).toEqual(['AppImage', 'tar.gz', 'deb', 'rpm'])
    expect(config.linux.maintainer).toMatch(/<.+@.+>/) // electron-builder refuses a deb without a maintainer email
    expect(config.win.target).toEqual(['nsis', 'portable'])
    expect(config.mac.target).toEqual(['dmg', 'zip'])
  })

  it('classifies all 16 matrix files, each once, with the CPU spelling electron-builder gives it', () => {
    const directory = fixture(matrixNames)
    const result = run(directory, '--require-matrix')
    expect(result.status, result.stderr).toBe(0)
    const rows = assets(directory).filter((a: any) => a.kind !== 'gateway')
    expect(rows).toHaveLength(matrixNames.length)
    expect(new Set(rows.map((a: any) => `${a.platform}/${a.kind}/${a.arch}`)).size).toBe(matrixNames.length)
    expect(rows.find((a: any) => a.name.endsWith('.deb') && a.arch === 'x64').name).toContain('-linux-amd64.deb')
    expect(rows.find((a: any) => a.name.endsWith('.rpm') && a.arch === 'arm64').name).toContain('-linux-aarch64.rpm')
    expect(run(directory, '--require-matrix', '--verify').status).toBe(0)
    expect(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')).toHaveLength(matrixNames.length + 1)
  })

  it('--require-matrix names the first missing route; --require-all keeps its alpha.3 meaning', () => {
    const directory = fixture(matrixNames.filter(f => !f.endsWith('.rpm') || f.includes('x86_64')))
    const strict = run(directory, '--require-matrix')
    expect(strict.status).toBe(1)
    expect(strict.stderr).toContain('Missing release asset: linux/rpm/arm64')
    expect(run(directory, '--require-all').status).toBe(0)
  })

  it('leaves the alpha.3 files classified exactly as before', () => {
    const old = matrixNames.filter(f => /win-x64|mac-arm64\.dmg|linux-(x86_64\.AppImage|x64\.tar\.gz)/.test(f))
    expect(old).toHaveLength(5)
    const directory = fixture(old)
    expect(run(directory, '--require-all').status).toBe(0)
    expect(assets(directory).map((a: any) => [a.name.replace(`LienCAM-${version}-`, ''), a.platform, a.kind, a.arch]).sort()).toEqual([
      ['gateway.py', 'linux', 'gateway', null],
      ['linux-x64.tar.gz', 'linux', 'archive', 'x64'],
      ['linux-x86_64.AppImage', 'linux', 'appimage', 'x64'],
      ['mac-arm64.dmg', 'macos', 'dmg', 'arm64'],
      ['win-x64-portable.exe', 'windows', 'portable', 'x64'],
      ['win-x64-setup.exe', 'windows', 'installer', 'x64'],
    ].sort())
  })

  it.each(['linux-amd64.rpm', 'linux-x86_64.deb', 'linux-aarch64.deb', 'mac-aarch64.dmg', 'win-amd64-setup.exe', 'linux-aarch64.tar.gz'])('rejects a wrongly spelled file: %s', suffix => {
    const directory = fixture([])
    const file = `LienCAM-${version}-${suffix}`
    writeFileSync(join(directory, file), 'x')
    const result = run(directory)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Unsupported installer: ${file}`)
  })

  it('the Downloads table has one row per file plus SHA256SUMS.txt, and every route nobody has run says untested', () => {
    const directory = fixture(matrixNames)
    expect(run(directory).status).toBe(0)
    const table = downloadsTable(JSON.parse(readFileSync(join(directory, 'releases.json'), 'utf8'))) as string
    const lines = table.trim().split('\n').slice(2)
    expect(lines).toHaveLength(matrixNames.length + 1 + 5) // files + gateway.py + 2 bridge archives + 3 metadata files
    for (const file of matrixNames) {
      const row = lines.filter(l => l.startsWith(`| \`${file}\``))
      expect(row, file).toHaveLength(1)
      const tested = /-win-x64-/.test(file)
      expect(/Unsigned and untested\./.test(row[0]), file).toBe(!tested)
    }
    expect(lines.find(l => l.includes('linux-arm64.AppImage'))).toContain('native .NET bridge')
    expect(lines.find(l => l.includes('win-arm64-setup'))).toContain('x64 and runs under Windows x64 emulation')
    expect(lines.find(l => l.includes('mac-x64.dmg'))).toContain('Intel Mac')
    // Everything release-assets/* uploads has a row; bridge archives say untested; the sums row names what it covers.
    for (const attached of ['liencam-bridge-linux-x64.tar.gz', 'liencam-bridge-linux-arm64.tar.gz']) {
      expect(lines.find(l => l.startsWith(`| \`${attached}\``)), attached).toContain('Unsigned and untested.')
    }
    for (const attached of ['SHA256SUMS.txt', 'native-bridge-SHA256SUMS.txt', 'releases.json']) expect(lines.some(l => l.startsWith(`| \`${attached}\``)), attached).toBe(true)
    expect(lines.find(l => l.startsWith('| `SHA256SUMS.txt`'))).not.toContain('every file')
  })
})
