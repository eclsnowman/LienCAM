// @vitest-environment node
// Reopen through the built application's Open button, never a second store or
// an engine-only payload. The builder captures Post and live Cut Stock evidence.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '../../types'

const root = path.resolve(__dirname, '../../..')
const part = path.join(root, 'examples/01-fixture-plate')
const evidence = path.join(root, 'src/tests/evidence/WO-2515')
const projectFile = process.env.WO2440_PROJECT ?? path.join(part, 'fixture-plate.camproject')
// A test run never rewrites tracked evidence (a dirty tree stops the gate); the
// committed test-reopen/ folder is the worker's recorded run.
const reopenOut = process.env.WO2440_REOPEN_OUT ?? mkdtempSync(path.join(tmpdir(), 'wo2440-reopen-'))
let reopened: Project

beforeAll(() => {
  const script = `
    import { withExampleDriver } from './tools/examples/lib/drive.mjs';
    await withExampleDriver({ outDir: ${JSON.stringify(reopenOut)} }, async driver => {
      const file = ${JSON.stringify(projectFile)};
      const id = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8')).id;
      await driver.step('Open fixture plate through production Open', async page => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Open project', exact: true }).click();
        await (await chooser).setFiles(file);
      }, state => state.project.id === id, { timeoutMs: 120000 });
      // Autosave intentionally omits move arrays. Save exposes the real loaded
      // runtime results without recomputing them or importing another store.
      const target = driver.output('reopened.camproject');
      const download = driver.page.waitForEvent('download');
      await driver.page.getByRole('button', { name: 'Save project', exact: true }).click();
      await (await download).saveAs(target);
      console.log('__REOPEN__' + JSON.stringify(JSON.parse((await import('node:fs')).readFileSync(target, 'utf8'))));
    });`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 150_000, maxBuffer: 20 * 1024 * 1024,
  })
  reopened = JSON.parse(output.split('\n').find(line => line.startsWith('__REOPEN__'))!.slice('__REOPEN__'.length))
}, 160_000)

describe('WO-2440 fixture plate workholding', () => {
  it('reopens with all five operations current, without recomputing', () => {
    const ops = reopened.setups[0].operations
    expect(ops).toHaveLength(5)
    for (const op of ops) {
      expect(op.status, op.name).toBe('ready')
      expect(op.toolpathMoves?.length ?? 0, op.name).toBeGreaterThan(0)
      expect(op.generationFingerprint, op.name).toBeTruthy()
    }
  })

  it('retains tape and glue and the complete holding and release instructions', () => {
    const setup = reopened.setups[0]
    expect(setup.holdingMethod).toBe('tape_glue')
    for (const text of ['masking tape', 'spoilboard', 'whole plate blank', 'superglue', 'press one minute', 'putty knife']) {
      expect(setup.notes).toContain(text)
    }
  })

  it('drills and thread mills before the outline, then chamfers, with tabs off', () => {
    const ops = reopened.setups[0].operations
    expect(ops.map(op => op.type)).toEqual(['face', 'drill', 'thread_mill', 'contour_2d', 'chamfer'])
    expect((ops[3].params as { tabs?: boolean }).tabs).not.toBe(true)
  })

  it('cuts the outline 0.2 mm and drills full diameter 0.5 mm below the stock bottom', () => {
    const stock = reopened.sceneStock!.fixedStocks[0]
    const bottom = stock.position.z
    expect(bottom).toBe(-8)
    for (const [type, breakthrough] of [['contour_2d', 0.2], ['drill', 0.5]] as const) {
      const op = reopened.setups[0].operations.find(op => op.type === type)!
      const tool = reopened.toolLibrary!.find(tool => tool.id === op.toolId)!
      // WO-2514 stores full-diameter breakthrough; moves are at the drill tip.
      const point = type === 'drill' ? (tool.diameter / 2) / Math.tan(59 * Math.PI / 180) : 0
      expect(op.toolpathMoves, type).toBeDefined()
      expect(Math.min(...op.toolpathMoves!.map(move => move.z)), type).toBeCloseTo(bottom - breakthrough - point, 6)
    }
    const thread = reopened.setups[0].operations.find(op => op.type === 'thread_mill')!
    expect(Math.min(...thread.toolpathMoves!.map(move => move.z))).toBe(bottom)
    expect(thread.reachShortfall).toBeUndefined()
  })

  it('posts the same operation order and breakthrough in each production dialect', () => {
    for (const file of ['fixture-plate.nc', 'uccnc.nc', 'grbl.nc', 'grblhal.nc', 'generic.nc']) {
      const nc = readFileSync(path.join(part, file), 'utf8')
      const starts = reopened.setups[0].operations.map(op => nc.indexOf(op.name))
      expect(starts.every(index => index >= 0), file).toBe(true)
      expect(starts, file).toEqual([...starts].sort((a, b) => a - b))
      const drill = reopened.toolLibrary!.find(tool => tool.id === reopened.setups[0].operations[1].toolId)!
      const drillTip = -8.5 - (drill.diameter / 2) / Math.tan(59 * Math.PI / 180)
      for (const [index, depth] of [[1, drillTip], [2, -8], [3, -8.2]] as const) {
        const section = nc.slice(starts[index], starts[index + 1])
        const zs = Array.from(section.matchAll(/\bZ(-?\d+(?:\.\d+)?)/g), m => Number(m[1]))
        expect(Math.min(...zs), `${file} ${reopened.setups[0].operations[index].name}`).toBeCloseTo(depth, 3)
      }
    }
  })

  it('downloads a job sheet with the holding method and complete instructions', () => {
    const sheet = readFileSync(path.join(part, 'fixture-plate.setup.txt'), 'utf8')
    expect(sheet).toContain('Method: Tape and glue')
    expect(sheet).toContain(reopened.setups[0].notes!)
    expect(readFileSync(path.join(part, 'fixture-plate.setup.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('finishes real Cut Stock with no solid exterior lip in the bottom 0.5 mm', () => {
    const simulation = JSON.parse(readFileSync(path.join(evidence, 'simulation.json'), 'utf8'))
    expect(Math.abs(Number(simulation.progress) - Number(simulation.end))).toBeLessThanOrEqual(1)
    expect(simulation.removedVolumeMm3).toBeGreaterThan(0)
    expect(simulation.bottomExteriorSamples).toBeGreaterThan(0)
    expect(simulation.bottomExteriorSolid).toBe(0)
  })
})
