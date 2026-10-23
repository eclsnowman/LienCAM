#!/usr/bin/env node
import { isMain } from '../lib/is-main.mjs'
import { readFile } from 'node:fs/promises'

// WO-3064: the release notes' Downloads table, one row per file, written from
// releases.json so a file can never ship without a row. Only the Windows x64
// installers have been run by Eric; every other route says "untested" plainly.
const tested = asset => asset.platform === 'windows' && asset.arch === 'x64'

const cpu = { x64: 'x64 (Intel/AMD)', arm64: 'arm64' }
const notes = {
  'windows/installer': 'Windows 10/11 installer.',
  'windows/portable': 'Windows portable build; settings stay on the PC and are shared with an installed copy.',
  'macos/dmg': 'macOS disk image.',
  'macos/archive': 'macOS zip.',
  'linux/appimage': 'Linux AppImage.',
  'linux/archive': 'Linux tar.gz archive.',
  'linux/deb': 'Linux .deb package (Debian, Ubuntu).',
  'linux/rpm': 'Linux .rpm package (Fedora, openSUSE).',
}

function describe(asset) {
  if (asset.kind === 'gateway') return 'The separate LinuxCNC gateway.'
  const base = notes[`${asset.platform}/${asset.kind}`]
  const extra = []
  if (asset.platform === 'macos') extra.push(asset.arch === 'arm64' ? 'Apple Silicon' : 'Intel Mac')
  else extra.push(cpu[asset.arch])
  if (asset.platform === 'windows' && asset.arch === 'arm64') extra.push('the app runs natively; the machine-control bridge is x64 and runs under Windows x64 emulation')
  if (asset.platform === 'linux' && asset.arch === 'arm64') extra.push('machine control uses the native .NET bridge, because the Wine bridge needs x86-64')
  if (asset.platform === 'linux' && asset.arch === 'x64') extra.push('machine control uses the Wine bridge or the native .NET bridge')
  return `${base} ${extra.join('; ')}. ${tested(asset) ? '' : 'Unsigned and untested.'}`.trim()
}

export function downloadsTable(releases) {
  const rows = releases.assets.map(asset => `| \`${asset.name}\` | ${describe(asset)} |`)
  // Files the release also attaches that releases.json does not list (the native
  // bridge archives, built-not-run on both CPUs) get their rows here.
  for (const arch of ['x64', 'arm64']) {
    rows.push(`| \`liencam-bridge-linux-${arch}.tar.gz\` | Native AXBB-E machine-control bridge for Linux ${cpu[arch]}, standalone. Unsigned and untested. |`)
  }
  rows.push('| `SHA256SUMS.txt` | Checksums for the installers, packages and `gateway.py` above. |')
  rows.push('| `native-bridge-SHA256SUMS.txt` | Checksums for the two `liencam-bridge-*` archives. |')
  rows.push('| `releases.json` | The list of downloads above, with sizes and checksums, for the website. |')
  return ['| File | What it is |', '|---|---|', ...rows].join('\n') + '\n'
}

if (isMain(import.meta.url)) {
  try {
    const [path] = process.argv.slice(2)
    if (!path) throw new Error('Usage: downloads-table.mjs <releases.json>')
    process.stdout.write(downloadsTable(JSON.parse(await readFile(path, 'utf8'))))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
