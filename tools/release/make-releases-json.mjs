#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'eclsnowman/LienCAM'
const metadata = ['releases.json', 'SHA256SUMS.txt']
const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function classify(name, version) {
  if (name === 'gateway.py') return { platform: 'linux', kind: 'gateway', arch: null }
  const match = /^LienCAM-(.+)-(win|linux|mac)-(x64|x86_64|arm64)(-setup|-portable)?\.(exe|AppImage|tar\.gz|dmg|zip)$/.exec(name)
  if (!match) return null
  if (match[1] !== version) throw new Error(`Wrong tag version: ${name}`)
  const [, , os, arch, suffix = '', ext] = match
  const kind = os === 'win' && ext === 'exe' ? { '-setup': 'installer', '-portable': 'portable' }[suffix]
    : suffix ? null : os === 'linux' ? { AppImage: 'appimage', 'tar.gz': 'archive' }[ext]
      : os === 'mac' ? { dmg: 'dmg', zip: 'archive' }[ext] : null
  if (!kind || (arch === 'x86_64' && (os !== 'linux' || kind !== 'appimage'))) throw new Error(`Unsupported installer: ${name}`)
  // Electron-builder spells x64 as x86_64 for AppImage filenames only.
  return { platform: os === 'win' ? 'windows' : os === 'mac' ? 'macos' : 'linux', kind, arch: arch === 'x86_64' ? 'x64' : arch }
}

// Download-page contract: tag/version/prerelease plus assets with bytes and URLs.
// Linux and macOS are untested and unsigned; packaging is not a journey test.
export async function makeReleasesJson({ directory, tag, verify = false, requireAll = false }) {
  if (!tagPattern.test(tag)) throw new Error(`Invalid release tag: ${tag}`)
  directory = resolve(directory)
  const version = tag.slice(1)
  const assets = []
  for (const name of (await readdir(directory)).sort()) {
    if (metadata.includes(name)) continue
    const details = classify(name, version)
    if (!details) {
      // Electron-builder logs, blockmaps and unpacked folders are not downloads.
      if (/^LienCAM-.*\.(exe|AppImage|tar\.gz|dmg|zip)$/.test(name)) throw new Error(`Unsupported installer: ${name}`)
      continue
    }
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Not a nonempty regular file: ${name}`)
    assets.push({
      ...details, name, size: stat.size, sha256: await checksum(path),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      unsigned: true,
      // Windows journey evidence lives in WO-2390, not in this assembler.
      tested: false,
    })
  }
  if (!assets.length) throw new Error('No release assets found')
  if (requireAll) {
    for (const [platform, kind] of [['windows', 'installer'], ['windows', 'portable'], ['linux', 'appimage'], ['linux', 'archive'], ['macos', 'dmg'], ['linux', 'gateway']]) {
      if (!assets.some(asset => asset.platform === platform && asset.kind === kind)) throw new Error(`Missing release asset: ${platform}/${kind}`)
    }
  }
  const result = { tag, version, prerelease: true, assets }
  const sums = assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join('')
  if (verify) {
    const saved = JSON.parse(await readFile(join(directory, metadata[0]), 'utf8'))
    for (const asset of assets) {
      const previous = saved.assets?.find(entry => entry.name === asset.name)
      if (JSON.stringify(previous) !== JSON.stringify(asset)) throw new Error(`Release verification failed: ${asset.name}`)
    }
    if (JSON.stringify(saved) !== JSON.stringify(result)) throw new Error('Release verification failed: releases.json asset set or tag differs')
    if (await readFile(join(directory, metadata[1]), 'utf8') !== sums) throw new Error('Release verification failed: SHA256SUMS.txt differs')
  } else {
    await writeFile(join(directory, metadata[0]), `${JSON.stringify(result, null, 2)}\n`)
    await writeFile(join(directory, metadata[1]), sums)
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, ...args] = process.argv.slice(2)
    const tagIndex = args.indexOf('--tag')
    const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
    const remaining = args.filter((_, index) => index !== tagIndex && index !== tagIndex + 1)
    if (!directory || !tag || remaining.some(arg => !['--verify', '--require-all'].includes(arg))) {
      throw new Error('Usage: make-releases-json.mjs <directory> --tag <vX.Y.Z[-alpha.N]> [--verify] [--require-all]')
    }
    const result = await makeReleasesJson({ directory, tag, verify: remaining.includes('--verify'), requireAll: remaining.includes('--require-all') })
    console.log(`${remaining.includes('--verify') ? 'Verified' : 'Wrote'} ${result.assets.length} assets for ${tag}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
