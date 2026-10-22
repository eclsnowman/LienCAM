// WO-3026 (alpha.3 A3-12): unit tests for the kernel linking service at parity -
// link-policy-mapping (each field value x case), role-vocabulary-closed (every emitted
// role has a feed row), the carded policies all off, the standoff table, link case and
// outcome classification, headless imports, and no app caller.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { OperationType, ToolpathMove } from '../../types'
import { defaultLinking } from '../../kernel/parameterDefaults'
import * as kernel from '../../kernel/linking'

const FAMILIES = Object.keys(kernel.PARITY_LINK_TABLE) as OperationType[]
const root = process.cwd()
const rel = (path: string) => relative(root, path).split(sep).join('/')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}
function imports(path: string, text = readFileSync(path, 'utf8')): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0]
      found.push(arg && ts.isStringLiteral(arg) ? arg.text : '<nonliteral-import>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Two straight raster passes 2 mm apart on a flat surface at z = 0. */
function rasterPasses(): Float64Array[] {
  const pass = (y: number) => new Float64Array([0, y, 0, 5, y, 0, 10, y, 0])
  return [pass(0), pass(2), pass(30)]
}
const flat: kernel.ConnectorSampler = async xy => new Float64Array(xy.length / 2)

describe('WO-3026 link-policy-mapping: each field value x case', () => {
  it('every family maps every retract type x transition type x case to its own parity row (the fields do not act at parity)', () => {
    for (const family of FAMILIES) {
      const row = kernel.PARITY_LINK_TABLE[family]
      for (const linkCase of kernel.LINK_CASES) {
        const reference = kernel.parityLinkOutcomes(family, kernel.DEFAULT_LINK_FIELDS, linkCase)
        expect(reference.length, `${family} ${linkCase}`).toBeGreaterThan(0)
        expect(reference).toBe(row.outcomes[linkCase])
        for (const outcome of reference) expect(kernel.LINK_OUTCOMES).toContain(outcome)
        for (const retractType of kernel.RETRACT_TYPES) for (const transitionType of kernel.TRANSITION_TYPES) {
          expect(kernel.parityLinkOutcomes(family, { retractType, transitionType }, linkCase), `${family} ${retractType}/${transitionType} ${linkCase}`).toBe(reference)
        }
      }
    }
  })

  it('the table covers every operation type, the field values are today\'s, and the default fields are today\'s new-operation defaults', () => {
    expect(FAMILIES.sort()).toEqual([
      'adaptive_3d', 'adaptive_clearing_2d', 'bore', 'chamfer', 'contour_2d', 'drill', 'engrave', 'face', 'parallel_3d',
      'pattern', 'pencil_3d', 'pocket_2d', 'scallop_3d', 'steep_shallow_3d', 'thread_mill', 'vcarve', 'waterline_3d',
    ])
    expect([...kernel.RETRACT_TYPES]).toEqual(['full', 'partial', 'minimum'])
    expect([...kernel.TRANSITION_TYPES]).toEqual(['safe_height', 'direct', 'avoid_stock'])
    expect(kernel.DEFAULT_LINK_FIELDS).toEqual({ retractType: defaultLinking.retractType, transitionType: defaultLinking.transitionType })
  })

  it('between regions is the union of the gap and level rows; the surface finishers are not levelled', () => {
    for (const family of FAMILIES) {
      const { outcomes } = kernel.PARITY_LINK_TABLE[family]
      const union = new Set([...outcomes.short_gap, ...outcomes.long_gap, ...outcomes.level_change])
      expect(new Set(outcomes.between_regions)).toEqual(union)
    }
    expect(FAMILIES.filter(f => !kernel.PARITY_LINK_TABLE[f].levelled).sort()).toEqual(['parallel_3d', 'pencil_3d', 'scallop_3d'])
  })
})

describe('WO-3026 role-vocabulary-closed: every emitted role has a feed row', () => {
  it('the vocabulary is exactly 12 roles with exactly one feed row each', () => {
    expect(kernel.MOVE_ROLES).toHaveLength(12)
    expect(new Set(kernel.MOVE_ROLES).size).toBe(12)
    expect(Object.keys(kernel.ROLE_FEED_TABLE).sort()).toEqual([...kernel.MOVE_ROLES].sort())
    for (const role of kernel.MOVE_ROLES) {
      const row = kernel.ROLE_FEED_TABLE[role]
      expect(row.role).toBe(role)
      expect(row.rate === null).toBe(role === 'rapid')
      expect(row.motion).toBe(role === 'rapid' ? 'rapid' : 'feed')
    }
    expect([...kernel.DEFERRED_ROLES].sort()).toEqual(['fast_traverse', 'finish'])
    for (const role of Object.values(kernel.IR_ROLE_TO_LINK_ROLE)) expect(kernel.MOVE_ROLES).toContain(role)
  })

  it('an unknown role never resolves: the row lookup refuses it and the output feed stays unset', () => {
    expect(() => kernel.feedRowFor('traverse')).toThrow(/unknown move role 'traverse'/)
    expect(() => kernel.feedRowFor('toString')).toThrow(/unknown move role/)
    const rates = { feedRate: 1, plungeRate: 2, rampRate: 3, leadInRate: 4, leadOutRate: 5, fastTraverseRate: 6, finishRate: 7 }
    expect(kernel.resolveRoleFeed({ role: 'traverse' }, rates)).toBeUndefined()
    expect(kernel.resolveRoleFeed({ role: 'fast_traverse' }, rates)).toBe(6)
    expect(kernel.resolveRoleFeed({ role: 'finish' }, rates)).toBe(7)
    expect(kernel.resolveRoleFeed({ role: 'cut' }, rates)).toBeUndefined()
    expect(kernel.resolveRoleFeed({ role: 'cut', feed: 9 }, rates)).toBe(9)
  })

  it('every role the kernel primitives and linkers emit has a row', async () => {
    const moves: ToolpathMove[] = []
    kernel.rapidEntryAt(moves, { x: 0, y: 0 }, 2, 5, 15)
    kernel.plungeTo(moves, [{ x: 0, y: 0 }], 0, -2, 100)
    kernel.floorHop(moves, { x: 0, y: 0 }, { x: 8, y: 0 }, -2, 0.3, true)
    kernel.retractFrom(moves, 5, 15)
    const raster = await kernel.buildLinkedPath(rasterPasses(), { clearanceZ: 15, retractZ: 10, feedZ: 5 }, { stepover: 2, cutterContactRadiusMm: 3 }, flat)
    const waterline = kernel.linkWaterlinePasses(
      [0, -1, -2].map((z, level) => ({ xy: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]), z, closed: true, level, materialInside: true, region: 0 })),
      { clearanceZ: 15, retractZ: 10, feedZ: 5 }, { stepdown: 1, cutterRadiusMm: 3 },
    )
    const emitted = new Set<string>([...moves.map(m => m.role!), ...[...raster, ...waterline].map(m => kernel.IR_ROLE_TO_LINK_ROLE[m.role!])])
    expect(emitted.size).toBeGreaterThan(3)
    for (const role of emitted) expect(kernel.feedRowFor(role).role).toBe(role)
  })
})

describe('WO-3026 parity policy and standoff table', () => {
  it('every carded policy (MD-60..MD-66) is off: the policy holds only parity values and each alternative names its card', () => {
    expect(kernel.PARITY_LINKING_POLICY).toEqual({
      policy_mapping: 'per_family', standoffs: 'per_family', roles: 'ir_8_mapped', keepdown_proof: 'per_operation',
      ride_feed: 'fast_2d_cutting_3d', rest_aware: 'finishes_3d_only', finish_linker_3d: 'per_family',
    })
    expect(Object.isFrozen(kernel.PARITY_LINKING_POLICY)).toBe(true)
    expect(Object.keys(kernel.CARDED_LINKING_ALTERNATIVES).sort()).toEqual(Object.keys(kernel.PARITY_LINKING_POLICY).sort())
    expect(Object.values(kernel.CARDED_LINKING_ALTERNATIVES).map(a => a.card).sort())
      .toEqual(['MD-60', 'MD-61', 'MD-62', 'MD-63', 'MD-64', 'MD-65', 'MD-66'])
    const service = kernel.createLinkingService()
    expect(service.policy).toBe(kernel.PARITY_LINKING_POLICY)
    expect(Object.isFrozen(service)).toBe(true)
  })

  it('the five standoffs are one table at today\'s values, and the 3D finishing linkers read theirs from it', async () => {
    expect(Object.fromEntries(Object.values(kernel.STANDOFFS).map(row => [row.id, row.valueMm]))).toEqual({
      finish_3d_traverse: 1, adaptive_3d_traverse: 0.5, drill_peck_reapproach: 0.5, adaptive_2d_micro_lift: 2, rough_3d_low_travel_headroom: 1,
    })
    for (const [id, row] of Object.entries(kernel.STANDOFFS)) expect(row.id).toBe(id)
    expect(kernel.TRAVERSE_STANDOFF_MM).toBe(kernel.standoffMm('finish_3d_traverse'))
    // A material top above Clearance floors the traverse plane at top + the table's standoff.
    const moves = await kernel.buildLinkedPath(rasterPasses(), { clearanceZ: 15, retractZ: 10, feedZ: 5, materialTopZ: 20 }, { stepover: 2, cutterContactRadiusMm: 3 }, flat)
    expect(moves[0]).toMatchObject({ t: 'rapid', z: 20 + kernel.standoffMm('finish_3d_traverse') })
    expect(moves[moves.length - 1]).toMatchObject({ t: 'rapid', z: 20 + kernel.standoffMm('finish_3d_traverse') })
  })
})

describe('WO-3026 link case and outcome', () => {
  const planes = { clearanceZ: 15, retractZ: 10, feedZ: 5 }
  const cut = (x: number, z = 0): ToolpathMove => ({ type: 'feed', x, y: 0, z, role: 'cut' })
  const rapid = (x: number, z: number): ToolpathMove => ({ type: 'rapid', x, y: 0, z, role: 'rapid' })

  it('splits a program into its links, leaving out the first approach and the final retract', () => {
    const moves = [rapid(0, 15), rapid(0, 5), cut(0, -1), cut(4, -1), rapid(4, 15), rapid(20, 15), rapid(20, 5), cut(20, -2), cut(24, -2),
      { type: 'feed' as const, x: 26, y: 0, z: -2, role: 'fast_traverse' as const }, cut(28, -2), rapid(28, 15)]
    const spans = kernel.linkSpans(moves)
    expect(spans.map(s => [s.start, s.moves.length, s.from.x, s.to.x, s.nextRunMinZ])).toEqual([[4, 3, 4, 20, -2], [9, 1, 24, 26, -2]])
  })

  it('classifies the case by level, then by the gap against the tool diameter; between regions when the planner says so', () => {
    const span = (fromZ: number, toX: number, nextZ: number) => ({ from: { x: 0, y: 0, z: fromZ }, to: { x: toX, y: 0, z: 5 }, nextRunMinZ: nextZ })
    expect(kernel.classifyLinkCase(span(-1, 6, -1), { toolDiameterMm: 6, levelled: true })).toBe('short_gap')
    expect(kernel.classifyLinkCase(span(-1, 6.1, -1), { toolDiameterMm: 6, levelled: true })).toBe('long_gap')
    expect(kernel.classifyLinkCase(span(-1, 1, -2), { toolDiameterMm: 6, levelled: true })).toBe('level_change')
    expect(kernel.classifyLinkCase(span(-1, 1, -2), { toolDiameterMm: 6, levelled: false })).toBe('short_gap')
    expect(kernel.classifyLinkCase(span(-1, 1, -1.0005), { toolDiameterMm: 6, levelled: true })).toBe('short_gap')
    expect(kernel.classifyLinkCase(span(-1, 1, -1), { toolDiameterMm: 6, levelled: true, betweenRegions: true })).toBe('between_regions')
  })

  it('reads the outcome as stay down (no rapid) or the highest plane the rapids reach', () => {
    const ride: ToolpathMove = { type: 'feed', x: 1, y: 0, z: -1, role: 'stepover' }
    expect(kernel.classifyLinkOutcome({ moves: [ride] }, planes)).toBe('stay_down')
    expect(kernel.classifyLinkOutcome({ moves: [rapid(1, -0.7), rapid(2, -1)] }, planes)).toBe('low_rapid')
    expect(kernel.classifyLinkOutcome({ moves: [rapid(1, 5)] }, planes)).toBe('feed_plane')
    expect(kernel.classifyLinkOutcome({ moves: [rapid(1, 10), rapid(2, 10)] }, planes)).toBe('retract_plane')
    expect(kernel.classifyLinkOutcome({ moves: [rapid(1, 10), rapid(1, 15)] }, planes)).toBe('clearance_plane')
  })
})

describe('WO-3026 kernel linking is headless, deterministic and called by no app path', () => {
  const pure = new Set(['src/types', 'src/lib/cam/stockCuttingRoles'])
  it('imports only its own kernel files and the pure role/type modules (no engine, store, UI or package import)', () => {
    const offending = files(resolve('src/kernel/linking')).flatMap(path => imports(path)
      .filter(specifier => {
        const target = rel(resolve(dirname(path), specifier)).replace(/\.(ts|tsx)$/, '')
        return !(specifier.startsWith('.') && (target.startsWith('src/kernel/linking/') || pure.has(target)))
      })
      .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(offending).toEqual([])
    for (const path of files(resolve('src/kernel/linking'))) {
      expect(readFileSync(path, 'utf8'), rel(path)).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|window\.|document\./)
    }
  })

  it('the same inputs give byte-identical links', async () => {
    const run = () => kernel.buildLinkedPath(rasterPasses(), { clearanceZ: 15, retractZ: 10, feedZ: 5, materialTopZ: 1 }, { stepover: 2, cutterContactRadiusMm: 3 }, flat)
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()))
  })

  it('no file under src outside the service and src/tests imports src/kernel/linking (negative control included)', () => {
    // WO-3033's kernel feed service reads the role feed table, and only that file
    // (src/kernel/linking/roles.ts). It is a kernel sibling at parity, not an app caller:
    // feedsUnits.wo3033 pins its imports to that one file, and the check below keeps the
    // app out of both services, so no app path reaches the linking service through it.
    const kernelSibling = (path: string, specifier: string): boolean =>
      rel(path).startsWith('src/kernel/feeds/') &&
      rel(resolve(dirname(path), specifier)).replace(/\.(ts|tsx)$/, '') === 'src/kernel/linking/roles'
    const callers = files(resolve('src'))
      .filter(path => !rel(path).startsWith('src/kernel/linking/') && !rel(path).startsWith('src/tests/'))
      .flatMap(path => imports(path)
        .filter(specifier => specifier.startsWith('.') && rel(resolve(dirname(path), specifier)).startsWith('src/kernel/linking'))
        .filter(specifier => !kernelSibling(path, specifier))
        .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(callers).toEqual([])
    const siblingCallers = files(resolve('src'))
      .filter(path => !rel(path).startsWith('src/kernel/feeds/') && !rel(path).startsWith('src/kernel/linking/') && !rel(path).startsWith('src/tests/'))
      .flatMap(path => imports(path)
        .filter(specifier => specifier.startsWith('.') && rel(resolve(dirname(path), specifier)).startsWith('src/kernel/feeds'))
        .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(siblingCallers, 'an app file reaches the linking service through the kernel feed service').toEqual([])
    expect(kernelSibling(resolve('src/kernel/feeds/select.ts'), '../linking/roles')).toBe(true)
    expect(kernelSibling(resolve('src/kernel/feeds/select.ts'), '../linking/service')).toBe(false)
    expect(kernelSibling(resolve('src/store/negative-control.ts'), '../kernel/linking/roles')).toBe(false)
    expect(imports(resolve('src/store/negative-control.ts'), "import { createLinkingService } from '../kernel/linking'")
      .filter(specifier => rel(resolve(resolve('src/store'), specifier)).startsWith('src/kernel/linking'))).toEqual(['../kernel/linking'])
  })
})
