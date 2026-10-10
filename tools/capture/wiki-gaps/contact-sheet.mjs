// WO-2709: one contact sheet of every candidate (labelled with its file name).
//   node tools/capture/wiki-gaps/contact-sheet.mjs [--dir <candidates>] [--out <sheet.png>]
// (WO-2710 added --dir/--out; the defaults stay the WO-2709 candidates.)
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { OUT } from './common.mjs'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? path.resolve(argv[i + 1]) : null }
const DIR = opt('--dir') || OUT
const SHEET = opt('--out') || path.join(OUT, '..', 'contact-sheet.png')
const files = fs.readdirSync(DIR).filter((f) => /\.(png|webp)$/.test(f)).sort()
const TILE_H = 640, LABEL = 34, GAP = 16, MAX_W = 3600
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const tiles = []
for (const f of files) {
  const meta = await sharp(path.join(DIR, f)).metadata()
  const h = TILE_H, w = Math.round(meta.width * h / meta.height)
  const img = await sharp(path.join(DIR, f)).resize({ width: w, height: h }).png().toBuffer()
  tiles.push({ f, w, h, img })
}
let x = GAP, y = GAP, rowH = 0
const placed = []
for (const t of tiles) {
  if (x + t.w + GAP > MAX_W && x > GAP) { x = GAP; y += rowH + GAP; rowH = 0 }
  placed.push({ ...t, x, y })
  x += Math.max(t.w, 360) + GAP
  rowH = Math.max(rowH, t.h + LABEL)
}
const W = Math.max(...placed.map((p) => p.x + Math.max(p.w, 360))) + GAP
const H = y + rowH + GAP
const composite = []
for (const p of placed) {
  composite.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(p.w, 360)}" height="${LABEL}"><text x="2" y="24" font-family="Arial" font-size="22" fill="#e8eef7">${esc(p.f)}</text></svg>`), left: p.x, top: p.y })
  composite.push({ input: p.img, left: p.x, top: p.y + LABEL })
}
fs.rmSync(SHEET, { force: true })
await sharp({ create: { width: W, height: H, channels: 3, background: '#20242c' } }).composite(composite).png().toFile(SHEET)
console.log('contact sheet', SHEET, W + 'x' + H, files.length, 'pictures')
