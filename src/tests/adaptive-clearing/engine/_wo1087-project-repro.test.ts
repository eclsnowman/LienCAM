// WO-1087 DIAGNOSTIC: reproduce Operator's three pictures from the PROJECT FILE, not a fixture.
//
// Reads `Example Projects/Adaptive Clearing Shapes.camproject` and drives every
// `adaptive_clearing_2d` operation through the app's own entry point
// (buildAdaptiveClearingToolpath), then counts the HELIX RAMPS in the emitted move stream --
// the orange rings Operator's viewport draws and his three notes arrow at.
//
// Why not the gt fixtures: they carry the same loop points but a test harness has to guess
// every other setting, and a guess that is one flag out reproduces a different toolpath. The
// project file carries the operation verbatim.
//
// Measurement only, skipped unless WO1087_PROJECT is set:
//   WO1087_PROJECT=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1087-project-repro.test.ts

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import type { Tool } from '../../../types'

const PROJECT = 'Example Projects/Adaptive Clearing Shapes.camproject'

interface Ring { x: number; y: number; n: number }

function ringsOf(moves: { x: number; y: number; role?: string }[]): Ring[] {
  const rings: Ring[] = []
  let cur: { xs: number[]; ys: number[] } | null = null
  for (const m of moves) {
    if (m.role === 'helix') {
      if (!cur) cur = { xs: [], ys: [] }
      cur.xs.push(m.x); cur.ys.push(m.y)
    } else if (cur) {
      rings.push({ x: cur.xs.reduce((a, b) => a + b, 0) / cur.xs.length, y: cur.ys.reduce((a, b) => a + b, 0) / cur.ys.length, n: cur.xs.length })
      cur = null
    }
  }
  if (cur) rings.push({ x: cur.xs.reduce((a, b) => a + b, 0) / cur.xs.length, y: cur.ys.reduce((a, b) => a + b, 0) / cur.ys.length, n: cur.xs.length })
  return rings
}

describe('WO-1087: the GOOD corpus project, run through the app entry point', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it.skipIf(!process.env.WO1087_PROJECT)('counts the helix ramps each operation emits', async () => {
    const proj = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
    const tools: Tool[] = proj.toolLibrary
    const geoms: { id: string; name: string; loops: unknown[] }[] = proj.geometry
    const report: Record<string, unknown> = {}

    for (const setup of proj.setups) {
      const wcsOrigin = setup.wcsOrigin ?? setup.origin ?? { x: 0, y: 0, z: 0 }
      for (const op of setup.operations) {
        if (op.type !== 'adaptive_clearing_2d') continue
        const geom = geoms.find(g => g.id === op.params.geometryId)
        const tool = tools.find(t => t.id === op.toolId)
        if (!geom || !tool) throw new Error(`missing geometry/tool for ${op.name}`)
        const payload = {
          opId: op.id, setupId: setup.id,
          params: op.params, heights: op.heights, passes: op.passes, linking: op.linking,
          tool, loops: geom.loops, wcsOrigin,
        } as unknown as ACWorkerPayload

        const warns: string[] = []
        const warn = console.warn
        console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
        let moves
        try { moves = await buildAdaptiveClearingToolpath(payload) } finally { console.warn = warn }

        const rings = ringsOf(moves as { x: number; y: number; role?: string }[])
        report[op.name] = {
          rings: rings.map(r => ({ x: Number(r.x.toFixed(2)), y: Number(r.y.toFixed(2)), moves: r.n })),
          moves: moves.length,
          finishConnectionWarns: warns.filter(w => w.includes('[finish-connection]')),
          sideEntryWarns: warns.filter(w => w.includes('[side-entry]')),
        }
        console.log(`${op.name}: ${rings.length} helix ring(s) -> ${rings.map(r => `(${r.x.toFixed(2)},${r.y.toFixed(2)})`).join(' ')}`)
      }
    }
    if (process.env.WO1087_PROJECT_OUT) fs.writeFileSync(process.env.WO1087_PROJECT_OUT, JSON.stringify(report, null, 2) + '\n')
    expect(Object.keys(report).length).toBeGreaterThan(0)
  }, 3_000_000)
})
