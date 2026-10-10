import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../types'
import { migrateProjectData } from '../../store/migrations/projectMigrations'
import { resolveInstancePlacements, placedBoundingBox } from '../../lib/workholding/resolveWorkholding'

const root = path.resolve(__dirname, '../../..')
const folder = path.join(root, 'examples/06-knob-handwheel')
const evidence = path.join(root, 'src/tests/evidence/WO-2445')
const currentEvidence = path.join(root, 'src/tests/evidence/WO-2644/knob-holding')
const raw = process.env.WO2445_BASELINE_REF
  ? execFileSync('git', ['show', `${process.env.WO2445_BASELINE_REF}:examples/06-knob-handwheel/knob-handwheel.camproject`], { cwd: root, maxBuffer: 20_000_000 }).toString()
  : process.env.WO2445_NEGATIVE_CONTROL === '1'
  ? execFileSync('git', ['show', 'main:examples/06-knob-handwheel/knob-handwheel.camproject'], { cwd: root, maxBuffer: 20_000_000 }).toString()
  : readFileSync(path.join(folder, 'knob-handwheel.camproject'), 'utf8')
const project = migrateProjectData(JSON.parse(raw)) as Project
const setup = project.setups[0]

describe('WO-2445 production-built knob base vise', () => {
  it('reads back the raised-stock holding without changing the stock or WCS', () => {
    const input = JSON.parse(readFileSync(path.join(evidence, 'raised-stock-readback.json'), 'utf8'))
    expect(input.stocks).toEqual(project.stocks)
    expect(input.wcs).toEqual(setup.wcs)
    expect(input.holdingMethod).toBe('vise')
    expect(input.notes).toContain('36 x 36 x 12 mm undersized support block')
    expect(input.notes).toContain('bottom 3 mm')
    expect(input.workholding.instances).toHaveLength(1)
    expect(input.workholding.instances[0].setupScope).toEqual({ kind: 'setups', setupIds: [setup.id] })
    expect(input.workholding.instances[0].worldPose.position.z).toBe(-27)
    const asset = JSON.parse(readFileSync(path.join(folder, 'knob-base-vise.workholding.json'), 'utf8'))
    expect(asset.placedAt.worldPose).toEqual(input.workholding.instances[0].worldPose)
    for (const name of ['fixed', 'moving']) {
      expect(Buffer.from(asset.shapes[name].stl, 'base64').toString())
        .toBe(readFileSync(path.join(folder, `knob-${name}-jaw.stl`), 'utf8').replaceAll('\r\n', '\n'))
    }
    expect(Buffer.from(asset.shapes.support.stl, 'base64').toString())
      .toBe(readFileSync(path.join(folder, 'knob-support-block.stl'), 'utf8').replaceAll('\r\n', '\n'))
  })

  it('reopens with all three current operations and the saved vise method', () => {
    expect(setup.holdingMethod).toBe('vise')
    expect(setup.operations).toHaveLength(3)
    expect(setup.operations.map(op => op.status)).toEqual(['ready', 'ready', 'ready'])
    const reopened = JSON.parse(readFileSync(path.join(evidence, 'reopened-state.json'), 'utf8'))
    expect(reopened.projectId).toBe(project.id)
    expect(reopened.operations).toEqual(setup.operations.map(op => ({ id: op.id, type: op.type, status: 'ready' })))
    expect(reopened.workholding).toEqual(project.workholding)
  })

  it('places an X-opening vise with a support block and only a 3 mm bottom grip', () => {
    expect(project.workholding?.definitions).toHaveLength(1)
    const definition = project.workholding!.definitions[0]
    const instance = project.workholding!.instances[0]
    expect(definition.kind).toBe('vise')
    expect(instance.setupScope).toEqual({ kind: 'setups', setupIds: [setup.id] })
    expect(definition.components.find(c => c.joint)?.joint?.axis).toEqual({ x: 1, y: 0, z: 0 })
    expect(instance.jointValuesMm.moving).toBeCloseTo(project.stocks![0].bounds.max.x - project.stocks![0].bounds.min.x, 5)
    const placed = resolveInstancePlacements(project, setup.id)
    expect(placed.notices).toEqual([])
    expect(placed.placements).toHaveLength(3)
    expect(resolveInstancePlacements(project, 'other-setup').placements).toHaveLength(0)
    const jawBounds = placed.placements.map(p => {
      const row = project.geometry.find(g => g.id === p.geometryId)!
      expect(row.workholding).toBe(true)
      const mesh = placedBoundingBox(p, row)!
      const values = Array.from(mesh.positions)
      return { minX: Math.min(...values.filter((_, i) => i % 3 === 0)), maxX: Math.max(...values.filter((_, i) => i % 3 === 0)),
        maxZ: Math.max(...values.filter((_, i) => i % 3 === 2)) }
    })
    // Both jaws rise 3 mm above the stock bottom. The shorter support block
    // seats the stock at Z -10; it does not set the fixed assembly's maximum.
    expect(jawBounds[0].maxZ).toBe(-7)
    expect(jawBounds[1].maxZ).toBe(-7)
    const fixed = project.geometry.find(g => g.name === 'knob-fixed-jaw')!
    const moving = project.geometry.find(g => g.name === 'knob-moving-jaw')!
    // The fixed body's AABB also contains its lower baseplate. Its authored
    // STL jaw face is checked directly, rather than mistaking that plate for a jaw.
    const fixedStl = readFileSync(path.join(folder, 'knob-fixed-jaw.stl'), 'utf8')
    expect(fixedStl).toContain(`vertex ${project.stocks![0].bounds.min.x} -30 -7`)
    const supportStl = readFileSync(path.join(folder, 'knob-support-block.stl'), 'utf8')
    expect(supportStl).toContain('vertex -18 -18 -22')
    expect(supportStl).toContain(`vertex 18 18 ${project.stocks![0].bounds.min.z}`)
    expect(jawBounds[1].minX).toBeCloseTo(project.stocks![0].bounds.max.x, 5)
    expect(moving.boundingBox!.max.z - moving.boundingBox!.min.z).toBe(12)
    expect(fixed.workholding).toBe(true)
  })

  it('models the support as a separate setup-scoped contact body seated against the stock', () => {
    const placed = resolveInstancePlacements(project, setup.id)
    const support = placed.placements.find(p => p.componentId === 'support')
    expect(support, 'Support must be an independent resolved workholding body').toBeDefined()
    const row = project.geometry.find(g => g.id === support!.geometryId)!
    expect(row.name).toBe('knob-support-block')
    expect(row.workholding).toBe(true)
    expect(row.hidden).not.toBe(true)
    expect(row.faceCount).toBe(12)
    expect(project.binaries?.[row.id]).toBeTruthy()
    const mesh = placedBoundingBox(support!, row)!
    const coords = [0, 1, 2].map(axis => Array.from(mesh.positions).filter((_, i) => i % 3 === axis))
    expect(coords.map(values => [Math.min(...values), Math.max(...values)]))
      .toEqual([[-18, 18], [-18, 18], [-22, -10]])
    expect(Math.max(...coords[2])).toBe(project.stocks![0].bounds.min.z)
    for (const op of setup.operations) for (const move of op.toolpathMoves!) {
      expect(move.z).toBeGreaterThan(Math.max(...coords[2]))
    }
    expect(resolveInstancePlacements(project, 'other-setup').placements).toHaveLength(0)
  })

  it('keeps every cut, lead and link above the jaw keep-out and retains the WO-2548 paths', () => {
    // The same kit generator replayed the current source in an evidence-only
    // copy; its Save/Open must preserve every move, not the pre-rebuild paths.
    const report = JSON.parse(readFileSync(path.join(currentEvidence, 'verification.json'), 'utf8'))
    const origin = JSON.parse(readFileSync(path.join(root, 'src/tests/evidence/WO-2644/knob-generator-origin.json'), 'utf8'))
    expect(origin.input).toBe('examples/06-knob-handwheel/knob-handwheel.camproject')
    expect(origin.inputSha256).toBe(createHash('sha256').update(raw.replaceAll('\r\n', '\n')).digest('hex'))
    const observed = setup.operations.map(op => {
      expect(op.toolpathMoves!.length).toBeGreaterThan(0)
      for (const move of op.toolpathMoves!) {
        expect(move.z).toBeGreaterThan(3)
        expect(move.z).toBeGreaterThanOrEqual(op.resolvedHeights!.machine.bottom - 1e-6)
      }
      return { type: op.type, moves: op.toolpathMoves!.length,
        sha256: createHash('sha256').update(JSON.stringify(op.toolpathMoves)).digest('hex') }
    })
    expect(observed).toEqual(report.beforePaths)
    expect(observed).toEqual(report.afterPaths)
  })

  it('downloads a production job sheet stating vise, grip and second-setup base removal', () => {
    const sheet = readFileSync(path.join(folder, 'knob-handwheel.setup.txt'), 'utf8')
    expect(sheet).toContain('Method: Vise')
    expect(sheet).toContain('Knob base vise')
    expect(sheet).toContain('bottom 3 mm of the remaining square stock base')
    expect(sheet).toContain('36 x 36 x 12 mm undersized support block')
    expect(sheet).toContain('base is about 15 mm high')
    expect(sheet).toContain('Remove the base in a second setup or with a saw')
    expect(sheet).toContain(setup.notes!)
    expect(readFileSync(path.join(folder, 'knob-handwheel.setup.pdf')).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('captures completed Cut Stock with no named contact from the application', () => {
    const report = JSON.parse(readFileSync(path.join(currentEvidence, 'verification.json'), 'utf8'))
    expect(report.simulation).toEqual({ completed: true, engine: 'heightmap', contacts: 0 })
    expect(report.captureDisplay).toEqual({ mode: 'compare', stockOpacity: 1, targetHidden: true,
      cutStockVerdict: 'simulation-cut-stock-end.png' })
    expect(statSync(path.join(currentEvidence, report.captureDisplay.cutStockVerdict)).size).toBeGreaterThan(20_000)
    expect(readFileSync(path.join(currentEvidence, 'simulation-console.txt'), 'utf8')).not.toMatch(/contacts workholding/i)
    for (const name of ['toolpaths.png', 'simulation-end.png']) {
      expect(statSync(path.join(currentEvidence, name)).size).toBeGreaterThan(20_000)
      expect(statSync(path.join(evidence, name)).size).toBeGreaterThan(20_000)
      // Exact byte equality without formatting hundreds of thousands of PNG
      // bytes into Vitest's mismatch diff (WO-2595 hang diagnosis).
      // WO-2548 rebuilt the kit and shipped its own production toolpaths capture; WO-2644
      // restored those bytes as the receipt (knob-kit/reopened-receipt.json names the commit).
      // simulation-end.png is the same rebuild's src/tests/evidence/WO-2548/finish/simulation-with-vise.png.
      const receipt = name === 'toolpaths.png'
        ? path.join(root, 'src/tests/evidence/WO-2644/knob-kit/reopened.png')
        : path.join(root, 'src/tests/evidence/WO-2548/finish/simulation-with-vise.png')
      expect(readFileSync(receipt).equals(readFileSync(path.join(folder, name))),
        `${name}: shipped capture differs from its production receipt`).toBe(true)
    }
  })
})
