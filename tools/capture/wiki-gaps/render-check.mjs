// WO-2709: rendered-page check of wiki pages that show the new pictures.
// A small GitHub-like render (headings, paragraphs, lists, blockquotes,
// markdown images, inline <img>, bold/code/links) - enough to prove every
// picture resolves and sits where the text says. Not a full GFM renderer.
//   node tools/capture/wiki-gaps/render-check.mjs Probing Phone-Pendant
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { waitForCpu } from './p2-lib.mjs'

const WIKI = path.resolve('docs/wiki')
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const DEST = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.resolve('src/tests/evidence/WO-2709/rendered')
if (outIndex >= 0) argv.splice(outIndex, 2)
fs.mkdirSync(DEST, { recursive: true })
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const inline = (t) => esc(t)
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}">`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
function render(md) {
  const out = []
  let list = null
  const close = () => { if (list) { out.push(`</${list}>`); list = null } }
  // Consecutive inline <img> lines form one paragraph, as GitHub renders them.
  const blocks = md.replace(/\r\n/g, '\n').split('\n')
  for (const line of blocks) {
    if (!line.trim()) { close(); continue }
    let m
    if ((m = line.match(/^(#{1,6}) (.*)$/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue }
    if (/^<img /.test(line)) { if (list !== 'p') { close(); out.push('<p>'); list = 'p' } out.push(line); continue }
    if ((m = line.match(/^\d+\. (.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol' } out.push(`<li>${inline(m[1])}</li>`); continue }
    if ((m = line.match(/^- (.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul' } out.push(`<li>${inline(m[1])}</li>`); continue }
    if ((m = line.match(/^> (.*)$/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue }
    close(); out.push(`<p>${inline(line)}</p>`)
  }
  close()
  return out.join('\n')
}
const css = 'body{background:#0d1117;color:#e6edf3;font:16px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:0}main{max-width:980px;margin:0 auto;padding:32px}img{max-width:100%}h1,h2{border-bottom:1px solid #30363d;padding-bottom:.3em}code{background:#343942;padding:.1em .3em;border-radius:4px}blockquote{border-left:4px solid #3d444d;margin:0;padding:0 1em;color:#9198a1}a{color:#4493f8}'

await waitForCpu()
const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  for (const name of argv) {
    const html = `<!doctype html><meta charset="utf-8"><base href="${pathToFileURL(WIKI + path.sep).href}"><style>${css}</style><main>${render(fs.readFileSync(path.join(WIKI, name + '.md'), 'utf8'))}</main>`
    const file = path.join(DEST, name + '.html')
    fs.writeFileSync(file, html)
    await page.goto(pathToFileURL(file).href)
    await page.waitForLoadState('load')
    const imgs = await page.evaluate(() => [...document.images].map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, shownW: Math.round(i.getBoundingClientRect().width) })))
    const bad = imgs.filter((i) => !i.ok)
    await page.screenshot({ path: path.join(DEST, name + '.png'), fullPage: true })
    console.log(name, imgs.length, 'images', bad.length ? 'BROKEN ' + JSON.stringify(bad) : 'all load', JSON.stringify(imgs))
    if (bad.length) process.exitCode = 1
  }
} finally { await browser.close() }
