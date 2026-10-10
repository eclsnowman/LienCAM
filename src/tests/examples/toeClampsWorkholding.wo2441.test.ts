// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../types'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'

const root = resolve(import.meta.dirname, '../../..')
const part = resolve(root, 'examples/02-toe-clamps')
const evidence = resolve(root, 'src/tests/evidence/WO-2441')
const json = (name: string) => JSON.parse(readFileSync(resolve(evidence, name), 'utf8'))
const project = JSON.parse(readFileSync(resolve(part, 'toe-clamps.camproject'), 'utf8')) as Project

describe('WO-2441 taped and tabbed toe clamps', () => {
  it('records whole-blank tape and glue and the eight-tab removal instructions', () => {
    expect(project.setups).toHaveLength(1)
    const setup = project.setups[0]
    expect(setup.holdingMethod).toBe('tape_glue')
    expect(setup.notes).toMatch(/masking tape.*spoilboard.*whole blank/i)
    expect(setup.notes).toMatch(/superglue.*cure/i)
    expect(setup.notes).toContain('8 tabs')
    expect(setup.notes).toContain('flush-cut the 8 tabs and file smooth')
  })

  it('keeps the recesses and holes and cuts both profiles to bottom minus 0.2 with four triangular tabs each', () => {
    const setup = project.setups[0]
    expect(setup.operations.map(op => op.type)).toEqual(['pocket_2d', 'drill', 'contour_2d'])
    expect(setup.operations[0].resolvedHeights?.wcs.bottom).toBe(-2)
    expect(Math.min(...(setup.operations[1].toolpathMoves ?? []).map(m => m.z))).toBe(-8)
    const profile = setup.operations[2]
    expect(profile.params).toMatchObject({ tabs: true, tabCount: 4, tabWidth: 5, tabHeight: 1, tabShape: 'triangular' })
    expect((profile.params as { loopIds: string[] }).loopIds).toHaveLength(2)
    const bottom = project.sceneStock!.fixedStocks[0].position.z
    for (const side of [-1, 1]) {
      const cuts = (profile.toolpathMoves ?? []).filter(m => m.role === 'cut' && Math.sign(m.y) === side)
      expect(Math.min(...cuts.map(m => m.z))).toBeCloseTo(bottom - 0.2, 6)
    }
    for (const op of setup.operations) {
      expect(op.status).toBe('ready')
      expect(op.toolpathMoves?.length ?? 0).toBeGreaterThan(0)
      expect(operationGenerationIsCurrent(project, setup, op)).toBe(true)
    }
  })

  it('reopens through production Open with all operations current before recompute', { timeout: 120_000 }, async () => {
    const { useCamStore } = await import('../../store')
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(project))
    const state = useCamStore.getState()
    const loaded = { ...state.project, toolLibrary: state.toolLibrary }
    expect(loaded.id).toBe(project.id)
    expect(loaded.setups[0].holdingMethod).toBe('tape_glue')
    expect(loaded.setups[0].notes).toBe(project.setups[0].notes)
    for (const op of loaded.setups[0].operations) {
      expect(op.status).toBe('ready')
      expect(operationGenerationIsCurrent(loaded, loaded.setups[0], op)).toBe(true)
    }
    const reopened = json('reopened-current.json') as Project
    expect(reopened.id).toBe(project.id)
    expect(reopened.setups[0].holdingMethod).toBe('tape_glue')
    expect(reopened.setups[0].notes).toBe(project.setups[0].notes)
    for (const op of reopened.setups[0].operations) {
      expect(op.status).toBe('ready')
      expect(operationGenerationIsCurrent(reopened, reopened.setups[0], op)).toBe(true)
    }
    const roundTrip = json('round-trip.json')
    expect(roundTrip.reopened).toEqual(roundTrip.saved)
    const steps = json('steps.json')
    expect(steps.every((step: { status: string }) => step.status === 'passed')).toBe(true)
    expect(steps.some((step: { label: string }) => step.label === 'Reopen saved project in a fresh context')).toBe(true)
  })

  it('reads eight retained tab bridges and clear profile gaps from the real Cut Stock field', () => {
    const readback = json('tab-stock-readback.json')
    expect(readback.contours).toHaveLength(2)
    for (const contour of readback.contours) {
      expect(contour.tabs).toBe(4)
      expect(contour.lowestZ).toBeCloseTo(-8.2, 6)
      const samples = readback.samples.filter((s: { contour: number }) => s.contour === contour.contour)
      expect(samples.filter((s: { tab: boolean }) => s.tab)).toHaveLength(4)
      expect(samples.some((s: { tab: boolean }) => !s.tab)).toBe(true)
      for (const sample of samples) expect(sample.value >= 0).toBe(sample.tab)
    }
    expect(json('simulation.json').removedVolumeMm3).toBeGreaterThan(0)
    for (const name of ['toolpaths.png', 'simulation-end.png']) {
      const png = readFileSync(resolve(evidence, name))
      expect(png.readUInt32BE(16)).toBe(1920)
      expect(png.readUInt32BE(20)).toBe(1080)
      expect(png.length).toBeGreaterThan(50000)
    }
  })

  it('downloads job-sheet text and PDF with method, tabs and removal from the production button', () => {
    const text = readFileSync(resolve(evidence, 'toe-clamps.setup.txt'), 'utf8')
    expect(text).toContain('Method: Tape and glue')
    expect(text).toContain('4 tabs per contour')
    expect(text).toContain('triangular')
    expect(text).toContain('8 tabs')
    expect(text).toContain('flush-cut the 8 tabs and file smooth')
    const pdf = readFileSync(resolve(evidence, 'toe-clamps.setup.pdf'), 'utf8')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    const logicalText = Array.from(pdf.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), m =>
      Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')).join('\n')
    expect(logicalText).toContain('Tape and glue')
    expect(logicalText).toContain('8 tabs')
    expect(logicalText).toContain('flush-cut the 8 tabs and file smooth')
    expect(json('scan.json').hits).toEqual([])
  })
})
