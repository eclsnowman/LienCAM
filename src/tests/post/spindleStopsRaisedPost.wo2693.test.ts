// WO-2693 round 2: the post raises the tool before its own spindle-off.
//
// The owner, 10-09: "Yes spindle should be at a raised height before turning off."
// and "Just fix the post or whatever introduced that behavior to raise before
// turning off." A saved project keeps its stored toolpath (the generation
// fingerprint still matches), so a 3D rough generated before the generator fix
// still ends at cutting depth. The post's own generated sequences - the tool
// change (M5 M9 G0 Z<safe>) and the program end (M5 [M9] G0 Z<safe> M30) -
// stopped the spindle there. They now lift to that same safe Z first when the
// last move left the tool below it; when the tool is already up, the output is
// byte-for-byte what it was.
//
// Scope (the owner's direction): normal generated-program completion only - not
// E-STOP, abort or a manual spindle-off; no new motion there.

import { describe, expect, it } from 'vitest'
import { postProgram, postCombined, GRBL_CONFIG, UCCNC_CONFIG } from '../../lib/post'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import type { ToolpathMove } from '../../types'
import { makeTool, makeMachine, makeOp, makeWcs } from './helpers'

const machine = makeMachine()

/** Ends at cutting depth, like a 3D rough stored before the generator fix. */
const endsLow: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 15, role: 'rapid' },
  { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
  { type: 'feed', x: 0, y: 0, z: -3, role: 'plunge', feed: 300 },
  { type: 'feed', x: 10, y: 0, z: -3, role: 'cut', feed: 1200 },
]
/** Ends on its own clearance plane, like every 2D op. */
const endsRaised: ToolpathMove[] = [
  { type: 'rapid', x: 20, y: 0, z: 15, role: 'rapid' },
  { type: 'rapid', x: 20, y: 0, z: 5, role: 'rapid' },
  { type: 'feed', x: 20, y: 0, z: -1, role: 'plunge', feed: 300 },
  { type: 'feed', x: 25, y: 0, z: -1, role: 'cut', feed: 1200 },
  { type: 'rapid', x: 25, y: 0, z: 15, role: 'rapid' },
]

function postOp(id: string, toolNumber: number, moves: ToolpathMove[]): PostOperation {
  const tool = makeTool({ id: `t${toolNumber}`, name: `Flat ${toolNumber}`, type: 'flat_end_mill', diameter: 6, toolNumber })
  const op = makeOp({ id, name: id, type: 'adaptive_3d', toolId: tool.id, status: 'ready', toolpathMoves: moves })
  return {
    op, tool, moves,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
  }
}

function input(ops: PostOperation[]): PostInput {
  return { machine, setup: { wcs: makeWcs(), operations: ops } }
}

/** Z (modal, work frame) in force at every spindle-off / tool-change / end word. */
function zAtStops(gcode: string): Array<{ code: string; z: number; before: string }> {
  let z = Number.NaN
  const out: Array<{ code: string; z: number; before: string }> = []
  const lines = gcode.split('\n').map(l => l.replace(/\(.*?\)/g, '').trim())
  lines.forEach((line, i) => {
    const zWord = /\bZ(-?\d*\.?\d+)/.exec(line)
    if (zWord && !/\bG53\b/.test(line)) z = Number(zWord[1])
    for (const code of ['M5', 'M6', 'M30']) {
      if (new RegExp(`\\b${code}\\b`).test(line)) out.push({ code, z, before: lines[i - 1] })
    }
  })
  return out
}

describe('WO-2693: the post lifts before its own spindle-off when the tool is low', () => {
  for (const config of [GRBL_CONFIG, UCCNC_CONFIG] as PostConfig[]) {
    it(`${config.id}: tool change after an op that ended at depth`, () => {
      const res = postProgram(input([postOp('Rough', 1, endsLow), postOp('Finish', 2, endsRaised)]), config)
      expect(res.ok).toBe(true)
      const stops = zAtStops(res.gcode)
      expect(stops.length).toBeGreaterThanOrEqual(2)
      for (const s of stops) expect(s.z, `${s.code} after "${s.before}"`).toBeGreaterThanOrEqual(15)
      // The lift is the sequence's own retract, written once more ahead of M5.
      const lines = res.gcode.split('\n')
      expect(lines[lines.indexOf('M5') - 1]).toBe('G0 Z15')
    })

    it(`${config.id}: program end after an op that ended at depth`, () => {
      const res = postProgram(input([postOp('Finish', 2, endsRaised), postOp('Rough', 1, endsLow)]), config)
      expect(res.ok).toBe(true)
      for (const s of zAtStops(res.gcode)) expect(s.z, `${s.code} after "${s.before}"`).toBeGreaterThanOrEqual(15)
    })

    it(`${config.id}: combined program end after a setup that ended at depth`, () => {
      const res = postCombined([input([postOp('Finish', 2, endsRaised)]), input([postOp('Rough', 1, endsLow)])], config, { pauseBetweenSetups: true })
      expect(res.ok).toBe(true)
      for (const s of zAtStops(res.gcode)) expect(s.z, `${s.code} after "${s.before}"`).toBeGreaterThanOrEqual(15)
    })

    it(`${config.id}: inch output lifts in the program's own units, to the same line its retract writes`, () => {
      const inch = { ...config, format: { ...config.format, units: 'inch' as const } }
      const res = postProgram(input([postOp('Rough', 1, endsLow), postOp('Finish', 2, endsLow)]), inch)
      expect(res.ok).toBe(true)
      const lines = res.gcode.split('\n')
      const m5s = lines.flatMap((l, i) => (l === 'M5' ? [i] : []))
      expect(m5s.length).toBe(2)
      // Tool change: lift, M5, M9, the sequence's own retract - the same words.
      expect(lines[m5s[0] - 1]).toBe(lines[m5s[0] + 2])
      // Program end: lift, M5, the program end's own retract - the same words.
      expect(lines[m5s[1] - 1]).toBe(lines.slice(m5s[1] + 1).find(l => l.startsWith('G0 Z')))
      expect(lines[m5s[1] - 1]).toMatch(/^G0 Z0\.59/)
    })

    it(`${config.id}: a tool already raised gets no extra line`, () => {
      const res = postProgram(input([postOp('A', 1, endsRaised), postOp('B', 2, endsRaised)]), config)
      const lines = res.gcode.split('\n').filter(l => !/^\(.*\)$/.test(l))
      // Each op's own last move is the Z15 lift; nothing is added between it and M5.
      lines.forEach((line, i) => {
        if (line === 'M5') expect(lines.slice(i - 2, i), `lines before M5 at ${i + 1}`).toEqual(['X25 F1200', 'G0 Z15'])
      })
    })
  }
})
