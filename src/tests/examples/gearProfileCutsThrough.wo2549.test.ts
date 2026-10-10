// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../types'
// Production browser driver also used to build the shipped examples.
// @ts-expect-error - the shared capture driver is plain JavaScript (.mjs)
import { withExampleDriver } from '../../../tools/examples/lib/drive.mjs'

const folder = path.resolve('examples/08-gear-pair')
const evidence = path.resolve('src/tests/evidence/WO-2549')
const file = process.env.LIENCAM_WO2549_PROJECT ?? path.join(folder, 'gear-pair.camproject')
const project = JSON.parse(readFileSync(file, 'utf8')) as Project

function checkOutlines(p: Project) {
  expect(p.setups).toHaveLength(2)
  const stock = p.sceneStock!.fixedStocks[0]
  expect(stock).toMatchObject({ width: 200, height: 120, depth: 6 })
  for (const setup of p.setups) {
    expect(setup.holdingMethod).toBe('tape_glue')
    const outline = setup.operations.find(op => op.type === 'contour_2d')!
    expect(outline.params).toMatchObject({ tabs: false })
    expect(outline.passes.stepdown).toBe(0.5)
    const bottom = stock.position.z
    const cuts = outline.toolpathMoves!.filter(m => m.role === 'cut' && Math.abs(m.z - (bottom - 0.5)) < 1e-6)
    expect(cuts.length).toBeGreaterThan(100)
    expect(Math.min(...outline.toolpathMoves!.map(m => m.z))).toBeCloseTo(bottom - 0.5, 6)
    // A lone plunge is insufficient: the final pass traverses every tooth.
    const geometry = p.geometry.find(g => g.id === (outline.params as { geometryId: string }).geometryId)!
    for (const point of geometry.loops![0].points) {
      const x = point.x + geometry.position.x
      const y = point.y + geometry.position.y
      expect(cuts.some(m => Math.hypot(m.x - x, m.y - y) < 3.01)).toBe(true)
    }
  }
}

describe('WO-2549: release both gears through their complete outlines', () => {
  it('opens the shipped project and Generate all produces full breakthrough on both outlines', { timeout: 300_000 }, async () => {
    const outDir = `src/tests/evidence/WO-2549/${process.env.LIENCAM_WO2549_PROJECT ? 'main-open' : 'focused-open'}`
    await withExampleDriver({ outDir }, async (d: any) => {
      await d.step('Open shipped gear pair', async (page: any) => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Open project', exact: true }).click()
        await (await chooser).setFiles(file)
      }, (s: any) => s.project.id === project.id)
      await d.page.getByTestId('mode-tab-toolpath').click()
      for (let i = 0; i < 2; i++) {
        const setup = d.page.locator('.tree-setup').nth(i)
        if (await setup.locator('.tree-op').count() < 3) await setup.locator('.tree-setup-header').click()
      }
      await d.step('Generate all', async (page: any) => {
        await page.locator('.tree-section-regen-btn').click()
        await page.waitForTimeout(2000)
        // The durable snapshot can still be the preceding all-ready generation.
        // First wait for the live tree's actual worker activity to finish.
        await page.waitForFunction(() => document.querySelectorAll('.tree-op-status .status-ready').length === 6,
          null, { timeout: 240_000 })
      }, (s: any) => {
        const ops = s.project.setups.flatMap((setup: any) => setup.operations)
        if (ops.some((op: any) => op.status === 'error')) throw new Error(JSON.stringify(ops.map((op: any) => [op.name, op.errorMessage])))
        return ops.length === 6 && ops.every((op: any) => op.status === 'ready')
      }, { timeoutMs: 240_000 })
      // OPFS autosave omits runtime moves; Save packages the real generated
      // paths. Read that download rather than treating an autosave as motion.
      const generatedFile = d.output('generated.camproject')
      const download = d.page.waitForEvent('download', { timeout: 120_000 })
      await d.page.getByRole('button', { name: 'Save project', exact: true }).click()
      await (await download).saveAs(generatedFile)
      checkOutlines(JSON.parse(readFileSync(generatedFile, 'utf8')))
    })
  })

  it('ships the same generated depths and documents glue retention without tooth-flank tabs', () => {
    checkOutlines(project)
    for (const setup of project.setups) {
      expect(setup.notes).toContain('0.5 mm below the stock bottom')
      expect(setup.notes).toContain('sacrificial spoilboard')
      expect(setup.notes).toContain('Both gears stay glued in place')
    }
    for (const dialect of ['generic', 'grbl', 'grblhal', 'linuxcnc', 'uccnc']) {
      const nc = readFileSync(path.resolve(`examples/gcode/08-gear-pair-${dialect}.nc`), 'utf8')
      for (const section of nc.split(/\bG55\b/)) expect(section).toContain('Z-6.5')
    }
    expect(readFileSync(path.join(folder, 'gear-pair.setup.txt'), 'utf8')).toContain('0.5 mm below the stock bottom')
    const pdf = readFileSync(path.join(folder, 'gear-pair.setup.pdf'), 'utf8')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    const logical = Array.from(pdf.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), m =>
      Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')).join('\n')
    expect(logical).toContain('0.5 mm below the stock bottom')
  })

  it('reads a fully open perimeter and retained interiors in both production simulation end states', () => {
    const simulations = JSON.parse(readFileSync(path.join(evidence, 'simulation.json'), 'utf8'))
    expect(simulations).toHaveLength(2)
    for (const sim of simulations) {
      expect(sim.gaps.length).toBeGreaterThan(100)
      expect(sim.gaps.every((sample: { topZ: number }) => sample.topZ <= sim.bottom + 0.001)).toBe(true)
      expect(sim.retained.topZ).toBeGreaterThan(sim.bottom + 5.9)
      expect(sim.removedVolumeMm3).toBeGreaterThan(0)
    }
    for (const name of ['simulation-end-setup-1.png', 'simulation-end-setup-2.png', 'reopened.png']) {
      const png = readFileSync(path.join(evidence, name))
      expect(png.readUInt32BE(16)).toBe(1920)
      expect(png.readUInt32BE(20)).toBe(1080)
      expect(png.length).toBeGreaterThan(50_000)
    }
  })
})
