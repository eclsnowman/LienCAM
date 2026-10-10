/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified by LienCAM, 2026: adapt PureCutCNC paper/fit maths to the shared
 * Y-up mm sketch SVG, add overlapping tiles and native row print options.
 */
import { exportSketchSvg } from './exportSvg'
import type { Sketch } from './types'

export const PRINT_PAPERS = {
  Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
  A4: [210, 297], A3: [297, 420],
} as const
export interface SketchPrintOptions {
  paper: keyof typeof PRINT_PAPERS
  orientation: 'portrait' | 'landscape'
  scale: 'actual' | 'fit'
}
export const DEFAULT_PRINT_OPTIONS: SketchPrintOptions = { paper: 'Letter', orientation: 'portrait', scale: 'actual' }
export const PRINT_MARGIN_MM = 10
export const PRINT_TITLE_MM = 12
export const PRINT_OVERLAP_MM = 10
const fmt = (n: number) => String(Number(n.toFixed(6)))
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function drawingPrintLayout(width: number, height: number, options: SketchPrintOptions) {
  const paper = PRINT_PAPERS[options.paper]
  const [paperWidth, paperHeight] = options.orientation === 'landscape' ? [paper[1], paper[0]] : paper
  const printableWidth = paperWidth - 2 * PRINT_MARGIN_MM
  const printableHeight = paperHeight - 2 * PRINT_MARGIN_MM - PRINT_TITLE_MM
  const scale = options.scale === 'fit' ? Math.min(printableWidth / width, printableHeight / height) : 1
  const count = (span: number, area: number) => Math.max(1, Math.ceil((span * scale - PRINT_OVERLAP_MM) / (area - PRINT_OVERLAP_MM) - 1e-9))
  const columns = options.scale === 'fit' ? 1 : count(width, printableWidth)
  const rows = options.scale === 'fit' ? 1 : count(height, printableHeight)
  const tiled = columns * rows > 1
  const tiles = Array.from({ length: columns * rows }, (_, page) => {
    const column = page % columns, row = Math.floor(page / columns)
    return { row, column, x: column * (printableWidth - PRINT_OVERLAP_MM) / scale,
      y: row * (printableHeight - PRINT_OVERLAP_MM) / scale,
      // Tiled strips still need room for visible registration crosses.
      width: (tiled ? printableWidth : Math.min(width * scale, printableWidth)) / scale,
      height: (tiled ? printableHeight : Math.min(height * scale, printableHeight)) / scale }
  })
  return { paperWidth, paperHeight, printableWidth, printableHeight, scale, columns, rows, tiles, overlap: PRINT_OVERLAP_MM }
}

/** Every tile contains the export writer's geometry unchanged, clipped by its
 * viewport. Its physical dimensions / viewBox dimensions give mm per mm.
 * Reading the writer's own root avoids a second bounds or geometry renderer. */
export function buildSketchPrintDocument(sketch: Sketch, name = 'Sketch', options = DEFAULT_PRINT_OPTIONS, date = new Date().toLocaleDateString('en-US')) {
  const svg = exportSketchSvg(sketch, name)
  const [minX, minY, width, height] = svg.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number)
  const geometry = svg.slice(svg.indexOf('>\n', svg.indexOf('<svg')) + 2, svg.lastIndexOf('</svg>'))
  const layout = drawingPrintLayout(width, height, options)
  const { paperWidth, paperHeight, printableWidth, printableHeight, scale } = layout
  const scaleLabel = options.scale === 'actual' ? '1:1' : `${fmt(scale * 100)}% (${fmt(scale)}:1)`
  const pages = layout.tiles.map((tile, index) => {
    const w = tile.width * scale, h = tile.height * scale
    // Crosses halfway into each overlap correspond to the same drawing
    // coordinates on neighbouring pages (e.g. x=185 on col 1, x=5 on col 2).
    const marks = layout.tiles.length > 1 ? `<svg class="overlap-marks" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}" aria-label="10 mm overlap alignment marks"><g fill="none" stroke="black" stroke-width="0.15">${[5, w - 5].flatMap((x) => [5, h - 5].map((y) => `<path d="M${fmt(x - 2)} ${fmt(y)}h4 M${fmt(x)} ${fmt(y - 2)}v4"/>`)).join('')}</g></svg>` : ''
    return `<section class="print-page" data-row="${tile.row + 1}" data-column="${tile.column + 1}"><div class="drawing-area"><svg class="drawing" xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="${fmt(minX + tile.x)} ${fmt(minY + tile.y)} ${fmt(tile.width)} ${fmt(tile.height)}" overflow="${layout.tiles.length > 1 ? 'hidden' : 'visible'}">${geometry}</svg>${marks}</div><footer><strong>${escape(name)}</strong><br>${escape(date)} | Scale ${scaleLabel} | Page ${index + 1} of ${layout.tiles.length} | Row ${tile.row + 1}, column ${tile.column + 1}${layout.tiles.length > 1 ? ' | Overlap 10 mm' : ''}</footer></section>`
  })
  // Internal mm padding keeps the paper margin independent of Chromium
  // rounding @page margins. Single-sheet SVGs retain the exporter's visible
  // overflow: a rounded SVG clip can otherwise erase the fitted right edge.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(name)}</title><style>
@page { size: ${paperWidth}mm ${paperHeight}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: white; color: black; }
.print-page { box-sizing: border-box; width: ${paperWidth}mm; height: ${paperHeight}mm; padding: ${PRINT_MARGIN_MM}mm; break-after: page; }
.print-page:last-child { break-after: auto; }
.drawing-area { position: relative; width: ${printableWidth}mm; height: ${printableHeight}mm; }
.drawing { display: block; }
.overlap-marks { position: absolute; left: 0; top: 0; }
footer { box-sizing: border-box; height: ${PRINT_TITLE_MM}mm; border: 0.2mm solid black; padding: 1mm 2mm; font: 3mm/1.4 Arial, sans-serif; overflow: hidden; }
</style></head><body>${pages.join('\n')}</body></html>`
  return { html, layout }
}

/** A same-origin frame uses the browser/Electron print dialog without popup
 * blocking. Keep the print document alive until the dialog finishes. */
export function printSketchDocument(html: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.title = 'Sketch print document'
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
  frame.onload = async () => {
    frame.onload = null
    const win = frame.contentWindow!
    await frame.contentDocument?.fonts?.ready
    win.addEventListener('afterprint', () => frame.remove(), { once: true })
    win.focus()
    win.print()
  }
  frame.srcdoc = html
  document.body.appendChild(frame)
  return frame
}
