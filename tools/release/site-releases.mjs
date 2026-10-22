#!/usr/bin/env node
// Run before the existing site build:
//   node tools/release/site-releases.mjs [releases.json | --latest | --tag v...]
//   npm run build:site
// --output writes a copy of the page for isolated fixture builds. No network
// is used by default. GitHub's /latest omits alpha releases, so --latest reads
// the published release list (including prereleases) and its metadata asset.
import { isMain } from '../lib/is-main.mjs';
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const fixturePath = resolve(root, 'test_fixtures/site/releases.fixture.json')
const pagePath = resolve(root, 'site/download.html')
const repository = 'https://github.com/eclsnowman/LienCAM'
const slots = [
  ['windows', 'installer', 'Installer'], ['windows', 'portable', 'Portable'],
  ['linux', 'appimage', 'AppImage'], ['linux', 'archive', 'tar.gz'], ['linux', 'gateway', 'LinuxCNC gateway'],
  ['macos', 'dmg', 'Disk image (.dmg)'],
]
const platforms = { windows: 'Windows', linux: 'Linux', macos: 'macOS' }
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

export function validateRelease(data) {
  if (!data || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.tag) || data.version !== data.tag.slice(1)
    || typeof data.prerelease !== 'boolean' || !Array.isArray(data.assets)) throw new Error('Invalid releases.json header')
  const keys = new Set()
  for (const asset of data.assets) {
    const key = `${asset.platform}/${asset.kind}/${asset.arch}`
    if (keys.has(key)) throw new Error(`Duplicate release asset: ${key}`)
    keys.add(key)
    const expectedUrl = `${repository}/releases/download/${encodeURIComponent(data.tag)}/${encodeURIComponent(asset.name)}`
    if (typeof asset.name !== 'string' || !asset.name || /[\\/\x00-\x1f]/.test(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || asset.url !== expectedUrl || typeof asset.unsigned !== 'boolean' || typeof asset.tested !== 'boolean'
      || !['x64', 'arm64', null].includes(asset.arch)
      || !['windows', 'linux', 'macos'].includes(asset.platform)) throw new Error(`Invalid release asset: ${asset.name}`)
  }
  return data
}

export async function readReleaseData({ file, latest = false, tag, fetchImpl = fetch } = {}) {
  if ([Boolean(file), latest, tag !== undefined].filter(Boolean).length > 1) throw new Error('Choose a file, --latest or --tag')
  if (tag !== undefined && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Invalid release tag')
  if (!latest && tag === undefined) return validateRelease(JSON.parse(await readFile(file ?? fixturePath, 'utf8')))
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  // Keep the token on API requests only; release asset downloads are public.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const endpoint = tag === undefined ? '?per_page=100' : `/tags/${encodeURIComponent(tag)}`
  const list = await fetchImpl(`https://api.github.com/repos/eclsnowman/LienCAM/releases${endpoint}`, { headers, signal: AbortSignal.timeout(30_000) })
  if (!list.ok) throw new Error(`GitHub release list: HTTP ${list.status}`)
  const payload = await list.json()
  const releases = tag === undefined ? payload : [payload]
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list')
  const release = releases.filter(item => item && !item.draft && item.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]
  // At tag creation the assets still belong to a draft. Never substitute an
  // older release or preview data for the tag the workflow actually checked out.
  if (tag !== undefined && (!release || release.tag_name !== tag)) throw new Error(`Release ${tag} is not published or does not match the requested tag`)
  const metadata = release?.assets?.find(asset => asset.name === 'releases.json')
  if (!metadata) throw new Error('Newest published release has no releases.json')
  const url = new URL(metadata.browser_download_url)
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/eclsnowman/LienCAM/releases/download/')) throw new Error('Unexpected releases.json download URL')
  const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`releases.json download: HTTP ${response.status}`)
  const data = validateRelease(await response.json())
  if (data.tag !== release.tag_name) throw new Error('releases.json tag differs from GitHub release')
  return data
}

export function renderRelease(data, { preview = false } = {}) {
  validateRelease(data)
  const groups = Object.entries(platforms).map(([platform, label]) => {
    const cells = slots.filter(slot => slot[0] === platform).map(([, kind, title]) => {
      const assets = data.assets.filter(asset => asset.platform === platform && asset.kind === kind)
      const files = assets.map(asset => `<div class="release-file" data-size="${asset.size}">
            <a class="button" href="${escape(asset.url)}">${escape(asset.name)}</a>
            <p class="file-size">${escape(asset.arch ?? 'Python')} - ${asset.size.toLocaleString('en-US')} bytes</p>
            <p class="checksum">SHA-256 <code>${escape(asset.sha256)}</code></p>
          </div>`).join('\n')
      // WO-2730: keep app installation help with the generated download rows.
      const guide = assets.length && platform === 'linux' && ['appimage', 'archive'].includes(kind)
        ? `\n          <p><a href="${repository}/wiki/Install-on-Linux">Linux installation guide</a></p>` : ''
      return `<div class="download-cell${assets.length ? '' : ' missing'}" data-platform="${platform}" data-kind="${kind}" data-available="${assets.length > 0}">
          <h3>${title}</h3>
          ${assets.length ? files : '<p class="not-built">not built yet</p>'}${guide}
        </div>`
    }).join('\n')
    return `<div class="platform-group" aria-labelledby="platform-${platform}"><h2 id="platform-${platform}">${label}</h2>${cells}</div>`
  }).join('\n')
  return `<p class="release-version">${data.prerelease ? 'Alpha / prerelease' : 'Stable release'}: <strong>${escape(data.version)}</strong></p>
      ${preview ? '<p class="preview-note">Preview data: these sample entries show the download layout. Installers have not been published yet.</p>' : ''}
      <div class="download-grid">${groups}</div>`
}

export async function writeDownloadPage({ file, latest = false, tag, output = pagePath, fetchImpl } = {}) {
  const data = await readReleaseData({ file, latest, tag, fetchImpl })
  const template = await readFile(pagePath, 'utf8')
  const marker = /<!-- releases:start -->[\s\S]*?<!-- releases:end -->/
  if (!marker.test(template)) throw new Error('Download page has no release data markers')
  const preview = !latest && tag === undefined && (!file || resolve(file) === fixturePath || resolve(file) === resolve(root, 'test_fixtures/site/releases.windows-only.fixture.json'))
  const eol = template.includes('\r\n') ? '\r\n' : '\n'
  const region = `<!-- releases:start -->\n      ${renderRelease(data, { preview })}\n      <!-- releases:end -->`.replaceAll('\n', eol)
  const html = template.replace(marker, () => region)
  await writeFile(output, html)
  return data
}

if (isMain(import.meta.url)) {
  try {
    let file, output, tag, latest = false
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--latest') latest = true
      else if (args[index] === '--tag' && args[index + 1]) tag = args[++index]
      else if (args[index] === '--output' && args[index + 1]) output = args[++index]
      else if (!args[index].startsWith('-') && !file) file = args[index]
      else throw new Error('Usage: site-releases.mjs [releases.json | --latest | --tag v...] [--output download.html]')
    }
    const data = await writeDownloadPage({ file, latest, tag, output })
    console.log(`Wrote Download page: ${data.tag}, ${data.assets.length} assets`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
