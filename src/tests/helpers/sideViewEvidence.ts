// WO-1598: one shared side-view drawer for the workholding/reach evidence tests
// (WO-1577, WO-1575, WO-1582), replacing three drifting copies of writeSideView.
//
// The outcome this file exists to guarantee, all in one place:
//  1. The view window is DERIVED from what has to be in it - the tool assembly at
//     the drawn pose, the obstacles, and the path - never a hardcoded constant.
//  2. A band that cannot be drawn in full is drawn clipped AND SAID SO: a
//     broken-edge marker plus a caption line naming what continues past it. A
//     band is never silently skipped.
//  3. Cutter, neck, shank and holder all appear - callers pass whatever bands
//     the tool actually has; none of them are dropped for lack of room.
//  4. A projection cannot imply contact that is not there: a path point drawn
//     over an obstacle it does not share a Y range with is ghosted, and the
//     obstacle's real Y range is named in a caption.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolHolder } from '../../types'
import { toolNeckBand } from '../../lib/cam/holderClearance'

/** [minX, minY, minZ, maxX, maxY, maxZ] */
export type Box = readonly [number, number, number, number, number, number]

/** bottom, top, radius, colour, label - all relative to the tool tip except colour/label. */
export type Band = readonly [bottom: number, top: number, radius: number, colour: string, label: string]

export interface ToolPlacement { x: number; tipZ: number }

export type PathKind = 'cut' | 'plunge' | 'traverse'
export interface PathPoint { x: number; y: number; z: number; kind: PathKind }

export interface Obstacle {
  /** x0, x1, z0, z1 - one entry per solid column making up this obstacle's silhouette. */
  columns: readonly (readonly [number, number, number, number])[]
  /** The Y range the obstacle actually occupies. Omitted = it spans the whole
   *  scene (e.g. a stock block already sliced to one Y by the caller), so a
   *  path point crossing it in this view is never treated as a projection
   *  artefact - there is no other Y for it to be at. */
  yRange?: readonly [number, number]
  colour?: string
  label?: string
  /** Whether the label is drawn on the image next to the shape. Default true;
   *  a many-column obstacle (a stock profile) sets this false so one label
   *  does not repeat once per column - a caption line names it instead. */
  showLabel?: boolean
}

export function obstacleFromBox(box: Box, label = 'workholding', colour = '#c0392b'): Obstacle {
  return { columns: [[box[0], box[3], box[2], box[5]]], yRange: [box[1], box[4]], colour, label }
}

export interface ReferenceLine { z: number; label: string }

/** A measured value called out on the picture: a dashed line at a Z from a
 *  starting X to the view's right edge, with the text in a white box. */
export interface Callout { z: number; fromX: number; text: string }

export interface SideViewSpec {
  dir: string
  name: string
  title: string
  subtitle?: string
  obstacles: readonly Obstacle[]
  path: readonly PathPoint[]
  bands: readonly Band[]
  placements: readonly ToolPlacement[]
  referenceLines?: readonly ReferenceLine[]
  callouts?: readonly Callout[]
  captions: readonly string[]
}

/** The tool stack a reach/clearance verdict actually reasons about: cutter,
 *  then the neck when the tool has one (the product's own `toolNeckBand`),
 *  then the shank, then the holder - read off plain tool and holder fields,
 *  the way every one of these fixtures already measures its distances. */
export function toolBands(tool: Tool, holder: ToolHolder): Band[] {
  const exposedTop = isPositiveFinite(tool.lengthBelowHolder) ? tool.lengthBelowHolder : tool.overallLength
  const bands: Band[] = [[0, tool.fluteLength, tool.diameter / 2, '#2e7d32', 'cutter']]
  const neck = toolNeckBand(tool)
  let shankBottom = tool.fluteLength
  if (neck && exposedTop > neck.bottomMm) {
    bands.push([neck.bottomMm, Math.min(neck.topMm, exposedTop), neck.diameterMm / 2, '#b58900', 'neck'])
    shankBottom = neck.topMm
  }
  if (exposedTop > shankBottom) bands.push([shankBottom, exposedTop, tool.shankDiameter / 2, '#7f8c8d', 'shank'])
  const holderHeight = holder.segments.reduce((sum, s) => sum + s.height, 0)
  const holderRadius = Math.max(...holder.segments.map((s) => Math.max(s.lowerDiameter, s.upperDiameter))) / 2
  bands.push([exposedTop, exposedTop + holderHeight, holderRadius, '#34495e', 'holder'])
  return bands
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

/** A hand-drawn "this continues past the frame" mark: a small zigzag across
 *  the clipped edge, so a truncated band reads as truncated, not as whole. */
function brokenEdge(x0: number, x1: number, y: number): string {
  const step = 6
  let d = `M ${x0.toFixed(1)} ${y.toFixed(1)}`
  let x = x0
  let up = true
  for (x = x0 + step; x < x1; x += step) {
    d += ` L ${x.toFixed(1)} ${(y + (up ? -4 : 4)).toFixed(1)}`
    up = !up
  }
  d += ` L ${x1.toFixed(1)} ${y.toFixed(1)}`
  return `<path d="${d}" stroke="#000" stroke-width="1.4" fill="none"/>`
}

export function writeSideView(spec: SideViewSpec): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  mkdirSync(spec.dir, { recursive: true })

  // ── 1. Derive the view window from what must be in it ──────────────────────
  // Both ends: a scene entirely in WCS Z (cuts and workholding well below the
  // stock top, Z 0) is as real a case as the all-positive machine-Z scenes
  // this drawer started with - the window must fit whichever of top/bottom a
  // scene actually uses, never assume Z 0 is the floor.
  const xs: number[] = [0]
  const mustFitZTops: number[] = [0]
  const mustFitZBottoms: number[] = [0]
  for (const o of spec.obstacles) {
    for (const [x0, x1, z0, z1] of o.columns) { xs.push(x0, x1); mustFitZTops.push(z1); mustFitZBottoms.push(z0) }
  }
  for (const p of spec.path) { xs.push(p.x); mustFitZTops.push(p.z); mustFitZBottoms.push(p.z) }
  for (const r of spec.referenceLines ?? []) { mustFitZTops.push(r.z); mustFitZBottoms.push(r.z) }
  // A band whose height exceeds 200 mm is a deliberately open-ended stand-in
  // (a holder/spindle that keeps going up, not a real measured extent) - it
  // must still APPEAR, but only its base needs to fit; the rest legitimately
  // clips, honestly, with the marker below.
  for (const placement of spec.placements) {
    for (const [bottom, top, radius] of spec.bands) {
      xs.push(placement.x - radius, placement.x + radius)
      mustFitZTops.push(placement.tipZ + (top - bottom < 200 ? top : bottom))
      mustFitZBottoms.push(placement.tipZ + bottom)
    }
  }
  const viewXAbs = Math.max(10, ...xs.map(Math.abs)) + 4
  const viewZTop = Math.max(10, ...mustFitZTops) + 6
  const viewZBottom = Math.min(0, ...mustFitZBottoms) - 6

  // ── 2. Frame ─────────────────────────────────────────────────────────────
  const scale = Math.max(4, Math.min(13, 720 / (2 * viewXAbs)))
  const subtitleLines = spec.subtitle ? wrap(spec.subtitle, 92) : []
  const left = 70
  const top = 74 + subtitleLines.length * 17
  const px = (x: number) => (left + (x + viewXAbs) * scale).toFixed(1)
  const pz = (z: number) => (top + (viewZTop - z) * scale).toFixed(1)
  const frameW = 2 * viewXAbs * scale
  const frameH = (viewZTop - viewZBottom) * scale

  const parts: string[] = [
    `<text x="40" y="34" font-size="18" font-weight="bold">${esc(spec.title)}</text>`,
    ...subtitleLines.map((line, i) => `<text x="40" y="${58 + i * 17}" font-size="13" fill="#444">${esc(line)}</text>`),
    `<rect x="${px(-viewXAbs)}" y="${pz(viewZTop)}" width="${frameW.toFixed(1)}" height="${frameH.toFixed(1)}" fill="#fafafa" stroke="#999"/>`,
  ]

  // Z ruler - ticks span the whole window, not just Z >= 0.
  const step = (viewZTop - viewZBottom) > 60 ? 10 : 5
  const zStart = Math.ceil(viewZBottom / step) * step
  for (let z = zStart; z <= viewZTop; z += step) {
    parts.push(`<line x1="${Number(px(-viewXAbs)) - 5}" y1="${pz(z)}" x2="${px(-viewXAbs)}" y2="${pz(z)}" stroke="#999"/>`)
    parts.push(`<text x="${Number(px(-viewXAbs)) - 9}" y="${Number(pz(z)) + 4}" font-size="11" fill="#555" text-anchor="end">Z ${z}</text>`)
  }

  // Reference lines - what the program used to ask for, dashed.
  for (const ref of spec.referenceLines ?? []) {
    parts.push(`<line x1="${px(-viewXAbs)}" y1="${pz(ref.z)}" x2="${px(viewXAbs)}" y2="${pz(ref.z)}" ` +
      'stroke="#888" stroke-width="1.2" stroke-dasharray="6 4"/>')
    parts.push(`<text x="${Number(px(viewXAbs)) - 6}" y="${Number(pz(ref.z)) - 6}" font-size="11" fill="#666" text-anchor="end">${esc(ref.label)}</text>`)
  }

  const captions: string[] = [...spec.captions]
  const clipped = new Set<string>()

  /** Draws one band as a rect, clipped to the frame, with a broken-edge marker
   *  and a caption line whenever the real extent runs past the frame. Used for
   *  both obstacle columns and tool bands so clipping behaves identically
   *  everywhere a band could, in principle, run off the drawn window. */
  function drawBand(xCenter: number, radius: number, z0: number, z1: number, colour: string,
    label: string, labelSide: 'left' | 'right', showLabel = true): void {
    const drawZ1 = Math.min(z1, viewZTop)
    const x0px = Number(px(xCenter - radius))
    const x1px = Number(px(xCenter + radius))
    if (drawZ1 <= z0) {
      // Entirely above the frame: still never silently skipped - a thin
      // marker at the very top plus the caption naming it.
      parts.push(`<rect x="${x0px.toFixed(1)}" y="${pz(viewZTop)}" width="${(x1px - x0px).toFixed(1)}" height="3" fill="${colour}" fill-opacity="0.7"/>`)
      parts.push(brokenEdge(x0px, x1px, Number(pz(viewZTop))))
      const note = `${label} starts above Z ${viewZTop.toFixed(0)} and is not shown here.`
      if (!clipped.has(note)) { clipped.add(note); captions.push(note) }
      return
    }
    parts.push(`<rect x="${x0px.toFixed(1)}" y="${pz(drawZ1)}" width="${(x1px - x0px).toFixed(1)}" ` +
      `height="${((drawZ1 - z0) * scale).toFixed(1)}" fill="${colour}" fill-opacity="0.45" stroke="#000"/>`)
    if (showLabel) {
      const labelX = labelSide === 'left' ? xCenter - radius - 0.4 : xCenter + radius + 0.4
      parts.push(`<text x="${px(labelX)}" y="${Number(pz(z0)) - 4}" font-size="11" fill="${colour}" ` +
        `text-anchor="${labelSide === 'left' ? 'end' : 'start'}">${esc(label)}</text>`)
    }
    if (drawZ1 < z1) {
      parts.push(brokenEdge(x0px, x1px, Number(pz(drawZ1))))
      const note = `${label} continues above Z ${viewZTop.toFixed(0)}.`
      if (!clipped.has(note)) { clipped.add(note); captions.push(note) }
    }
  }

  // ── 3. Obstacles ─────────────────────────────────────────────────────────
  for (const obstacle of spec.obstacles) {
    for (const [x0, x1, z0, z1] of obstacle.columns) {
      const cx = (x0 + x1) / 2
      drawBand(cx, (x1 - x0) / 2, z0, z1, obstacle.colour ?? '#c0392b', obstacle.label ?? 'workholding',
        'left', obstacle.showLabel ?? true)
    }
  }

  // ── 4. The path, ghosting any point that is not at the obstacle's own Y ────
  const ghostNotes = new Map<string, { yMin: number; yMax: number; yRange: readonly [number, number] }>()
  function ghostFor(p: PathPoint): { label: string; yRange: readonly [number, number] } | undefined {
    for (const o of spec.obstacles) {
      if (!o.yRange) continue
      const overlaps = o.columns.some(([x0, x1, z0, z1]) => p.x >= x0 - 1e-6 && p.x <= x1 + 1e-6 && p.z >= z0 - 1e-6 && p.z <= z1 + 1e-6)
      if (!overlaps) continue
      const inRange = p.y >= o.yRange[0] - 1e-6 && p.y <= o.yRange[1] + 1e-6
      if (!inRange) return { label: o.label ?? 'the obstacle', yRange: o.yRange }
    }
    return undefined
  }
  for (const p of spec.path) {
    if (Math.abs(p.x) > viewXAbs) continue
    const traverse = p.kind === 'traverse'
    const plunge = p.kind === 'plunge'
    const colour = traverse ? '#e67e22' : plunge ? '#8e44ad' : '#1f6feb'
    const radius = traverse ? 1.3 : 2
    const ghost = ghostFor(p)
    if (ghost) {
      const entry = ghostNotes.get(ghost.label)
      if (entry) { entry.yMin = Math.min(entry.yMin, p.y); entry.yMax = Math.max(entry.yMax, p.y) }
      else ghostNotes.set(ghost.label, { yMin: p.y, yMax: p.y, yRange: ghost.yRange })
      parts.push(`<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="${radius}" fill="none" ` +
        `stroke="${colour}" stroke-width="1.2" stroke-dasharray="2 1.5" fill-opacity="0"/>`)
    } else {
      parts.push(`<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="${radius}" fill="${colour}"/>`)
    }
  }
  for (const [label, { yMin, yMax, yRange }] of ghostNotes) {
    const at = yMin === yMax ? `Y ${yMin.toFixed(1)}` : `Y ${yMin.toFixed(1)}..${yMax.toFixed(1)}`
    captions.push(`The dashed crossing over ${label} is a projection artefact, not contact: that pass runs at ${at}, ` +
      `while ${label} spans Y ${yRange[0]}..${yRange[1]}.`)
  }

  // ── 5. The tool, at every placement, cutter/neck/shank/holder all drawn ───
  spec.placements.forEach((placement, index) => {
    const side: 'left' | 'right' = index % 2 === 0 ? 'left' : 'right'
    for (const [bottom, top, radius, colour, label] of spec.bands) {
      drawBand(placement.x, radius, placement.tipZ + bottom, placement.tipZ + top, colour, label, side)
    }
    parts.push(`<text x="${px(placement.x)}" y="${Number(pz(placement.tipZ)) + 16}" font-size="11" text-anchor="middle">X ${placement.x.toFixed(2)}</text>`)
  })

  // ── 5b. Callouts - a measured value pinned to the picture, not just the words ──
  for (const callout of spec.callouts ?? []) {
    const x1 = Number(px(viewXAbs - 0.5))
    const x0 = Number(px(callout.fromX))
    parts.push(`<line x1="${x0}" y1="${pz(callout.z)}" x2="${x1}" y2="${pz(callout.z)}" ` +
      'stroke="#111" stroke-width="1" stroke-dasharray="4 3"/>')
    const calloutW = callout.text.length * 6.7
    parts.push(`<rect x="${(x1 - calloutW - 6).toFixed(1)}" y="${(Number(pz(callout.z)) - 24).toFixed(1)}" ` +
      `width="${(calloutW + 12).toFixed(1)}" height="22" fill="white" fill-opacity="0.88"/>`)
    parts.push(`<text x="${x1}" y="${Number(pz(callout.z)) - 8}" font-size="12" font-weight="bold" text-anchor="end">` +
      `${esc(callout.text)}</text>`)
  }

  // ── 6. Legend ────────────────────────────────────────────────────────────
  const legendY = Number(pz(viewZBottom)) + 30
  const legend: [string, string][] = [
    ['#1f6feb', 'cutting'],
    ['#e67e22', 'non-cutting (rapid, link, re-entry)'],
    ['#8e44ad', 'feed plunge down to the cut (through air until it reaches stock)'],
  ]
  legend.forEach(([colour, label], i) => {
    parts.push(`<circle cx="${Number(px(-viewXAbs)) + 6}" cy="${legendY + i * 17 - 4}" r="4" fill="${colour}"/>`)
    parts.push(`<text x="${Number(px(-viewXAbs)) + 16}" y="${legendY + i * 17}" font-size="12">${esc(label)}</text>`)
  })
  if (ghostNotes.size > 0) {
    const i = legend.length
    parts.push(`<circle cx="${Number(px(-viewXAbs)) + 6}" cy="${legendY + i * 17 - 4}" r="4" fill="none" stroke="#555" stroke-dasharray="2 1.5"/>`)
    parts.push(`<text x="${Number(px(-viewXAbs)) + 16}" y="${legendY + i * 17}" font-size="12">off-plane crossing (different Y - not contact, see caption)</text>`)
  }

  // ── 7. Captions, wrapped ─────────────────────────────────────────────────
  const wrapped: string[] = []
  for (const line of captions) wrapped.push(...wrap(line, 100), '')
  const captionTop = legendY + legend.length * 17 + (ghostNotes.size > 0 ? 17 : 0) + 22
  wrapped.forEach((line, i) => parts.push(`<text x="40" y="${captionTop + i * 17}" font-size="12">${esc(line)}</text>`))

  const height = captionTop + wrapped.length * 17 + 10
  const width = frameW + left + 40
  writeFileSync(join(spec.dir, `${spec.name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" font-family="sans-serif">` +
    `<rect width="100%" height="100%" fill="white"/>${parts.join('')}</svg>`)
}
