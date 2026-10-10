// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../types'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'

const root = resolve(import.meta.dirname, '../../..')
const folder = resolve(root, 'examples/08-gear-pair')
const evidence = resolve(root, 'src/tests/evidence/WO-2447')
const json = (name: string) => JSON.parse(readFileSync(resolve(evidence, name), 'utf8'))
const project = JSON.parse(readFileSync(resolve(folder, 'gear-pair.camproject'), 'utf8')) as Project

describe('WO-2447 gear pair on one taped and glued sheet', () => {
  it('binds both setups and all six geometries to the same unmoved 200 x 120 x 6 sheet', () => {
    const stocks = project.sceneStock!.fixedStocks
    expect(stocks).toHaveLength(1)
    const stock = stocks[0]
    expect(stock).toMatchObject({ width: 200, height: 120, depth: 6, position: { x: 0, y: 0, z: 0 } })
    expect(project.setups).toHaveLength(2)
    for (const field of ['origin', 'xAxis', 'yAxis', 'zAxis', 'originBinding'] as const) {
      expect(project.setups[0].wcs[field]).toEqual(project.setups[1].wcs[field])
    }
    for (const setup of project.setups) expect(setup.wcs.stockId).toBe(stock.id)
    for (const geometry of project.geometry) expect(geometry.stockId).toBe(stock.id)
  })

  it('records full-sheet tape and glue, retained gears, and pry-off instructions in both setups', () => {
    for (const setup of project.setups) {
      expect(setup.holdingMethod).toBe('tape_glue')
      expect(setup.notes).toMatch(/masking tape.*spoilboard.*full 200 x 120 x 6 mm sheet/i)
      expect(setup.notes).toMatch(/superglue.*cure/i)
      expect(setup.notes).toContain('without moving it')
      expect(setup.notes).toContain('Both gears stay glued in place')
      expect(setup.notes).toContain('Pry off both gears and deburr')
    }
  })

  it('keeps the original gear, bore and keyway sketches and the 80 mm native mesh distance', () => {
    const sketches = JSON.parse(readFileSync(resolve(folder, 'sketches.camproject'), 'utf8')) as Project
    expect(project.geometry).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(project.geometry[i].loops).toEqual(sketches.geometry[i].loops)
      expect(project.geometry[i].sketches).toEqual(sketches.geometry[i].sketches)
      expect(project.geometry[i].position.x).toBe(i < 3 ? 0 : 16)
    }
    const pitches = [0, 3].map(i => project.geometry[i].sketches![0].entities.find(
      e => e.kind === 'circle' && e.construction,
    ))
    expect(pitches.every(e => e?.kind === 'circle')).toBe(true)
    if (pitches[0]?.kind !== 'circle' || pitches[1]?.kind !== 'circle') throw new Error('Missing pitch circles')
    expect(pitches[0].radius).toBe(32)
    expect(pitches[1].radius).toBe(48)
    expect(Math.hypot(pitches[1].center.x - pitches[0].center.x, pitches[1].center.y - pitches[0].center.y)).toBeCloseTo(80, 2)
  })

  it('cuts both outlines into the tape without tabs and keeps the entire cutter on the sheet', () => {
    const stock = project.sceneStock!.fixedStocks[0]
    for (const setup of project.setups) {
      expect(setup.operations.map(o => o.type)).toEqual(['bore', 'pocket_2d', 'contour_2d'])
      const outline = setup.operations[2]
      expect(outline.params).toMatchObject({ tabs: false })
      // WO-2549 deliberately cuts 0.5 mm below the sheet to release both outlines.
      expect(Math.min(...outline.toolpathMoves!.map(m => m.z))).toBeCloseTo(stock.position.z - 0.5, 6)
      for (const op of setup.operations) {
        expect(operationGenerationIsCurrent(project, setup, op)).toBe(true)
        const radius = project.toolLibrary!.find(t => t.id === op.toolId)!.diameter / 2
        const moves = sampleArcMovesForLinearConsumers(op.toolpathMoves!)
        expect(moves.length).toBeGreaterThan(0)
        expect(Math.min(...moves.map(m => m.x)) - radius).toBeGreaterThanOrEqual(stock.position.x - 1e-6)
        expect(Math.max(...moves.map(m => m.x)) + radius).toBeLessThanOrEqual(stock.position.x + stock.width + 1e-6)
        expect(Math.min(...moves.map(m => m.y)) - radius).toBeGreaterThanOrEqual(stock.position.y - 1e-6)
        expect(Math.max(...moves.map(m => m.y)) + radius).toBeLessThanOrEqual(stock.position.y + stock.height + 1e-6)
      }
    }
  })

  it('reopens through production Open with all six operations current before recompute', { timeout: 300_000 }, async () => {
    const { useCamStore } = await import('../../store')
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(project))
    const state = useCamStore.getState()
    const loaded = { ...state.project, toolLibrary: state.toolLibrary }
    const browserReopened = json('reopened-current.json') as Project
    for (const p of [loaded, browserReopened]) {
      expect(p.id).toBe(project.id)
      for (const setup of p.setups) {
        expect(setup.holdingMethod).toBe('tape_glue')
        for (const op of setup.operations) expect(operationGenerationIsCurrent(p, setup, op)).toBe(true)
      }
    }
    expect(json('round-trip.json').reopened).toEqual(json('round-trip.json').saved)
    expect(json('steps.json').every((s: { status: string }) => s.status === 'passed')).toBe(true)
  })

  it('reads clear tooth outlines and retained gear interiors from each real Cut Stock end state', () => {
    const simulations = json('simulation.json')
    expect(simulations).toHaveLength(2)
    for (const sim of simulations) {
      expect(sim.removedVolumeMm3).toBeGreaterThan(0)
      expect(sim.gaps.length).toBeGreaterThan(100)
      expect(sim.gaps.every((p: { topZ: number }) => p.topZ <= sim.bottom + 0.001)).toBe(true)
      expect(sim.retained.topZ).toBeGreaterThan(sim.bottom + 5.9)
    }
    for (const name of ['toolpaths.png', 'simulation-end.png', 'simulation-end-setup-1.png', 'simulation-end-setup-2.png']) {
      const png = readFileSync(resolve(evidence, name))
      expect(png.readUInt32BE(16)).toBe(1920)
      expect(png.readUInt32BE(20)).toBe(1080)
      expect(png.length).toBeGreaterThan(50_000)
    }
  })

  it('downloads the method and removal instruction in production job-sheet text and PDF', () => {
    const text = readFileSync(resolve(folder, 'gear-pair.setup.txt'), 'utf8')
    expect((text.match(/Method: Tape and glue/g) ?? []).length).toBe(2)
    expect(text).toContain('Pry off both gears and deburr')
    expect(text).toContain('Both gears stay glued in place')
    const pdf = readFileSync(resolve(folder, 'gear-pair.setup.pdf'), 'utf8')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    const logical = Array.from(pdf.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), m =>
      Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')).join('\n')
    expect(logical).toContain('Tape and glue')
    expect(logical).toContain('Pry off both gears and deburr')
  })
})
