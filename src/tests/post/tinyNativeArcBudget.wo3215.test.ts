// WO-3215: a native arc whose WRITTEN start/end radii (X/Y/I/J after the
// dialect's coordinate rounding) disagree past WO-1384's 0.002 mm budget posts
// as lines on every dialect; an arc that meets the budget stays an arc.
// Oracle: parse the posted text and recompute each G2/G3 block's radii from
// the written words, the way a controller (and WO-3197's post-check) does.
import { describe, expect, it } from 'vitest'
import { postProgram, GRBL_CONFIG, GRBLHAL_CONFIG, UCCNC_CONFIG, LINUXCNC_CONFIG } from '../../lib/post'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { grblArcNeedsLines } from '../../lib/post/arcfit/grblPrecision'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'
import type { ToolpathMove } from '../../types'
import type { PostConfig, PostInput } from '../../lib/post/types'

const BUDGET_MM = 0.002 // WO-1384: 3-decimal post rounding budget
// The same budget in inch words: two units in the last written digit, 0.002 in.
const INCH_BUDGET_IN = 0.002
const configs = [UCCNC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG, GRBLHAL_CONFIG]

function input(moves: ToolpathMove[]): PostInput {
  const machine = makeMachine(), tool = makeTool(), op = makeOp({ toolpathMoves: moves })
  return { machine, setup: { wcs: makeWcs(), operations: [{ op, tool, moves,
    feeds: resolveFeedrates(tool, undefined, machine.rapidRate), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }
}

// A ~0.05 mm bore arc (Full Suite / Bore 3 class): exact on its circle in the
// CAM, but 3-decimal X/Y/I/J put its written end 0.0023 mm off the written
// start radius. GRBL (0.005 mm) and LinuxCNC (0.0127 mm) would still accept it.
const center = { x: 10.285020, y: 20.611614 }
const start = { x: 10.237511, y: 20.627199, z: -1 }
const tinyArc = move({ type: 'arc_cw', x: 10.329368, y: 20.588522, z: -1.02, cx: center.x, cy: center.y, feed: 300 })
// A 5 mm arc on clean coordinates: written radii agree exactly.
const cleanArc = move({ type: 'arc_ccw', x: 20, y: 25, z: -1, cx: 20, cy: 20, feed: 300 })
// Ordinary inch-route arcs (fable review FAIL): a 10 mm quarter arc and a
// 6 mm bore helix of two half turns, off-grid. Main posts each as one G2/G3 on
// every dialect; 3-decimal inch words put their written radii past 0.002 mm.
const quarterStart = { x: 22.345, y: 7.891, z: -1 }
const quarterArc = move({ type: 'arc_ccw', x: 12.345, y: 17.891, z: -1, cx: 12.345, cy: 7.891, feed: 300 })
const boreCenter = { x: 41.237, y: 13.659 }
const boreAt = (k: number) => ({ x: boreCenter.x + 6 * Math.cos(1.4 - k * Math.PI), y: boreCenter.y + 6 * Math.sin(1.4 - k * Math.PI) })
const boreStart = { ...boreAt(0), z: -1 }
const boreHalf = (k: number) => move({ type: 'arc_cw', ...boreAt(k), z: -1 - 0.25 * k, cx: boreCenter.x, cy: boreCenter.y, feed: 300 })
const inchCases = [
  { name: 'a 10 mm quarter arc', from: quarterStart, arcs: [quarterArc] },
  { name: 'a 6 mm bore helix', from: boreStart, arcs: [boreHalf(1), boreHalf(2)] },
]
const inch = (config: PostConfig): PostConfig => ({ ...config, format: { ...config.format, units: 'inch' } })

function program(arc: ToolpathMove | ToolpathMove[], from: { x: number; y: number; z: number }) {
  return [move({ type: 'rapid', x: from.x, y: from.y, z: 5, role: 'rapid' }),
    move({ x: from.x, y: from.y, z: from.z, feed: 100 }), ...[arc].flat()]
}

type Block = { g: number; x: number; y: number; z: number; i?: number; j?: number }
/** Absolute XY/G17 reader for the emitted text: modal G and coordinates. */
function readBlocks(gcode: string): Block[] {
  let g = 0, x = 0, y = 0, z = 0
  const out: Block[] = []
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/\(.*?\)|;.*$/g, '').trim().toUpperCase()
    if (!line || /\bG(?:53|28|30)\b/.test(line)) continue
    const words = new Map(Array.from(line.matchAll(/([A-Z])\s*(-?\d*\.?\d+)/g), m => [m[1] + (m[1] === 'G' ? m[2] : ''), Number(m[2])]))
    const motion = [0, 1, 2, 3].find(n => words.has(`G${n}`) || words.has(`G0${n}`))
    if (motion !== undefined) g = motion
    if (!['X', 'Y', 'Z'].some(k => words.has(k))) continue
    x = words.get('X') ?? x; y = words.get('Y') ?? y; z = words.get('Z') ?? z
    out.push({ g, x, y, z, i: words.get('I'), j: words.get('J') })
  }
  return out
}

/** Written radius disagreement of every G2/G3 block, from the text alone. */
function writtenArcMismatches(blocks: Block[]): number[] {
  return blocks.flatMap((b, k) => {
    if (b.g !== 2 && b.g !== 3) return []
    const prev = blocks[k - 1]
    const cx = prev.x + (b.i ?? 0), cy = prev.y + (b.j ?? 0)
    return [Math.abs(Math.hypot(prev.x - cx, prev.y - cy) - Math.hypot(b.x - cx, b.y - cy))]
  })
}

function post(config: PostConfig, moves: ToolpathMove[]) {
  const result = postProgram(input(moves), config)
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return result.gcode
}

describe('WO-3215 tiny native arcs meet the written radius budget', () => {
  it('fixture: the tiny arc is exact in the CAM but misses the budget as written', () => {
    const r0 = Math.hypot(start.x - center.x, start.y - center.y)
    const r1 = Math.hypot(tinyArc.x - center.x, tinyArc.y - center.y)
    expect(Math.abs(r0 - r1)).toBeLessThan(1e-5)
    expect(r0).toBeGreaterThan(0.04)
    expect(r0).toBeLessThan(0.06)
  })

  for (const config of configs) {
    it(`${config.id}: the tiny arc posts as lines inside the budget, ending exactly at the arc end`, () => {
      const blocks = readBlocks(post(config, program(tinyArc, start)))
      for (const mismatch of writtenArcMismatches(blocks)) expect(mismatch).toBeLessThanOrEqual(BUDGET_MM)
      const plunge = blocks.findIndex(b => b.z === start.z)
      expect(plunge).toBeGreaterThan(-1)
      const cut = blocks.slice(plunge + 1).filter(b => b.g === 1)
      expect(cut.length).toBeGreaterThan(0)
      // Lines walk the same circle in the arc's direction to its exact end.
      for (const b of cut.slice(0, -1)) {
        expect(Math.abs(Math.hypot(b.x - center.x, b.y - center.y) - 0.05)).toBeLessThan(0.002)
      }
      const end = cut[cut.length - 1]
      expect([end.x, end.y, end.z]).toEqual([10.329, 20.589, -1.02])
      expect(blocks.slice(plunge + 1).some(b => b.g === 2 || b.g === 3)).toBe(false)
    })

    it(`${config.id}: an arc that meets the budget stays a native arc`, () => {
      const gcode = post(config, program(cleanArc, { x: 25, y: 20, z: -1 }))
      const blocks = readBlocks(gcode)
      const arcs = blocks.filter(b => b.g === 3)
      expect(arcs).toHaveLength(1)
      expect(arcs[0]).toMatchObject({ x: 20, y: 25, i: -5, j: 0 })
      expect(writtenArcMismatches(blocks)).toEqual([0])
    })

    for (const c of inchCases) {
      it(`${config.id} inch: ${c.name} posts exactly as main did, native arcs within the inch budget`, () => {
        // Main linearized a native arc only through GRBL's own controller check (unchanged).
        const grbl = config.id === 'grbl' || config.id === 'grblhal'
        const mainNative = !grbl || !c.arcs.some((arc, k) => {
          const from = k === 0 ? c.from : c.arcs[k - 1]
          return grblArcNeedsLines(from, arc, arc.cx! - from.x, arc.cy! - from.y, 3, 'inch')
        })
        const blocks = readBlocks(post(inch(config), program(c.arcs, c.from)))
        const arcs = blocks.filter(b => b.g === 2 || b.g === 3)
        const last = c.arcs[c.arcs.length - 1]
        const end = blocks[blocks.length - 1]
        expect([end.x, end.y]).toEqual([Number((last.x / 25.4).toFixed(3)), Number((last.y / 25.4).toFixed(3))])
        if (!mainNative) {
          expect(arcs).toHaveLength(0)
          return
        }
        expect(arcs).toHaveLength(c.arcs.length)
        const mismatches = writtenArcMismatches(blocks)
        // Past the metric budget as written, inside the same budget in inch words.
        expect(Math.max(...mismatches) * 25.4).toBeGreaterThan(BUDGET_MM)
        for (const mismatch of mismatches) expect(mismatch).toBeLessThanOrEqual(INCH_BUDGET_IN + 1e-9)
      })
    }
  }

  it('fixture: main posts the bore helix natively on GRBL in inch (its controller check passes it)', () => {
    const [bore] = inchCases.filter(c => c.name.includes('bore'))
    bore.arcs.forEach((arc, k) => {
      const from = k === 0 ? bore.from : bore.arcs[k - 1]
      expect(grblArcNeedsLines(from, arc, arc.cx! - from.x, arc.cy! - from.y, 3, 'inch')).toBe(false)
    })
  })
})
