import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom ships without declarations; keep its used API typed inside this test's lane.
const { JSDOM }: { JSDOM: new (html: string) => { window: { document: Document; close(): void } } } = createRequire(import.meta.url)('jsdom')

const root = resolve(import.meta.dirname, '../../..')
// Read a negative control without checking out main or changing any source.
const revision = process.env.LIENCAM_PICTURES_REVISION
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
const read = (path: string) => revision ? git('show', `${revision}:${path}`) : readFileSync(join(root, path), 'utf8')
const manifest = JSON.parse(read('tools/release/manifest.json'))
const paths = (revision ? git('ls-tree', '-r', '--name-only', '-z', revision)
  : git('ls-files', '--cached', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
const shipped = new Set<string>()
for (const path of paths) {
  let included = false
  let destination = path
  for (const entry of manifest.selection) {
    const prefix = entry.path.replace(/\/$/, '')
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
    included = entry.action === 'include'
    if (included && entry.destination !== undefined) destination = entry.destination.replace(/\/$/, '') + path.slice(prefix.length)
  }
  if (included) shipped.add(destination)
}

function pictures(markdown: string): string[] {
  const visible = markdown.replace(/<!--[^]*?-->|^```[^]*?^```[^\n]*|`[^`\n]*`/gm, '')
  const dom = new JSDOM(visible)
  const urls = [...dom.window.document.querySelectorAll('img')].flatMap(img => {
    const sources = img.getAttribute('srcset')?.split(',').map(item => item.trim().split(/\s+/)[0]) ?? []
    return [img.getAttribute('src'), ...sources].filter((url): url is string => !!url)
  })
  dom.window.close()
  for (const match of visible.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) urls.push(match[1] ?? match[2])
  const references = new Map([...visible.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)]
    .map(match => [match[1].toLowerCase(), match[2] ?? match[3]]))
  for (const match of visible.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g)) {
    const url = references.get((match[2] || match[1]).toLowerCase())
    if (url) urls.push(url)
  }
  return urls
}

function issue(file: string, url: string): string | null {
  const decoded = decodeURIComponent(url.split(/[?#]/)[0])
  if (/(?:^|\/)(?:src\/tests|\.planning)(?:\/|$)/i.test(decoded)) return `${file}: ${url} -> private path`
  // README badges are hosted externally; local pictures must be in the export.
  if (/^(?:https?:)?\/\//i.test(decoded)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)) return `${file}: ${url} -> not a shipped file`
  const target = posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), decoded))
  // A wiki is a separate repository. A sibling media folder in the main repo
  // cannot satisfy an image request made from a published wiki page.
  if (file.startsWith('docs/wiki/') && (!target.startsWith('docs/wiki/') || decoded.startsWith('/'))) return `${file}: ${url} -> outside published wiki`
  return shipped.has(target) ? null : `${file}: ${url} -> missing exported file ${target}`
}

describe('WO-2536 public pictures', () => {
  it('resolves every README and wiki picture in its published export location', () => {
    const pages = paths.filter(path => path === 'README.md' || /^docs\/wiki\/[^/]+\.md$/.test(path))
    const links = pages.flatMap(file => pictures(read(file)).map(url => ({ file, url })))
    expect(pages.length).toBeGreaterThan(40)
    expect(links.length).toBeGreaterThan(100)
    const broken = links.map(({ file, url }) => issue(file, url)).filter(Boolean)
    console.log(`${revision ?? 'working branch'}: ${pages.length} pages, ${links.length} pictures, ${broken.length} broken`)
    expect(broken, broken.join('\n')).toEqual([])
  })

  it('checks HTML, Markdown and reference pictures while ignoring examples', () => {
    expect(pictures('<img src="a.png" srcset="b.png 2x">\n![caption](<c.png> "title")\n![ref][screen]\n[screen]: d.png\n`![example](no.png)`\n<!-- <img src="no.png"> -->'))
      .toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
  })

  it('refuses private, missing and wiki-parent routes even when the repo ships the parent file', () => {
    expect(issue('docs/wiki/Walkthrough.md', '../media/S12.png')).toContain('outside published wiki')
    // Construct the private fixture path so the exporter's static input reader
    // does not mistake this assertion for a dependency on private evidence.
    expect(issue('README.md', ['src', 'tests', 'evidence', 'capture.png'].join('/'))).toContain('private path')
    expect(issue('README.md', '.planning/capture.png')).toContain('private path')
    expect(issue('README.md', 'docs/media/does-not-exist.png')).toContain('missing exported file')
  })
})
