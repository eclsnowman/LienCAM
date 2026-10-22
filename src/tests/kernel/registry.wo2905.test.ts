import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import * as sharedDefaults from '../../kernel/parameterDefaults'
import * as sharedSchema from '../../kernel/schema'
import { parameterSchema } from '../../kernel/schema'
import * as adaptiveAdapter from '../../cam3d/integration/adaptive3dOperation'
import * as parallelAdapter from '../../cam3d/integration/parallel3dOperation'
import * as waterlineAdapter from '../../cam3d/integration/waterline3dOperation'
import * as steepAdapter from '../../cam3d/integration/steepShallow3dOperation'
import * as scallopAdapter from '../../cam3d/integration/scallop3dOperation'
import * as pencilAdapter from '../../cam3d/integration/pencil3dOperation'
import * as restAdapter from '../../cam3d/integration/rest3dOperation'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { OPERATION_REGISTRY, operationTypes } from '../../kernel/registry'
import { OPERATION_MANIFEST } from '../../lib/cam/operationManifest'
import { createHeadlessPlanner, createOperation } from '../../kernel/headless'
import { validateOperation, type KnowledgeDeclaration } from '../../kernel/validation'
import { parameterDefaults, defaultHeights, defaultPasses, defaultLinking } from '../../kernel/parameterDefaults'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import type { KernelPlan, PlanningInput } from '../../kernel/planning'
import type { OperationType } from '../../types'

const before = JSON.parse(readFileSync('src/tests/evidence/WO-2905/defaults-before.json', 'utf8'))
const withUndefined = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => entry === undefined ? { $undefined: true } : entry))

describe('WO-2905 registry and defaults parity', () => {
  it('keeps the legacy manifest on the same registry instance', () => {
    expect(OPERATION_MANIFEST).toBe(OPERATION_REGISTRY)
    // WO-3001 added 'pattern' after the WO-2905 defaults record was taken.
    expect(operationTypes).toHaveLength(17)
    expect([...operationTypes].sort()).toEqual([...Object.keys(before.defaults), 'pattern'].sort())
    expect(defaultHeights.heightIntent).toEqual(defaultHeightIntent())
    expect(withUndefined({ defaultHeights, defaultPasses, defaultLinking })).toEqual(before.shared)
  })
  it.each(Object.keys(before.defaults) as OperationType[])('%s preserves every old default and absent/undefined field', type => {
    expect(withUndefined(parameterDefaults[type])).toEqual(before.defaults[type])
    expect(withUndefined(OPERATION_REGISTRY[type].schema().defaults)).toEqual(before.defaults[type])
    const row = OPERATION_REGISTRY[type]
    expect(row.id).toBe(type)
    expect(row.featureTypes.length).toBeGreaterThan(0)
    expect(row.toolTypes.length).toBeGreaterThan(0)
    expect(row.knowledge.required.length).toBeGreaterThan(0)
  })
  it('declares family-specific Auto-Plan tool/role/rest metadata', () => {
    expect(OPERATION_REGISTRY.pencil_3d.toolTypes).toEqual(['ball_end_mill'])
    expect(OPERATION_REGISTRY.chamfer.toolTypes).toContain('countersink')
    expect(OPERATION_REGISTRY.engrave.toolTypes).toContain('v_bit')
    expect(OPERATION_REGISTRY.drill.role).toBe('drilling')
    expect(OPERATION_REGISTRY.contour_2d.restLeft).toContain('reserved tabs')
    expect(OPERATION_REGISTRY.face.featureTypes).toContain('stock-top')
  })
  it('creates isolated nested defaults while preserving explicit overrides', () => {
    const identity = { id: 'op', name: 'Carve', toolId: 'T1' }
    const first = createOperation('vcarve', identity)
    const second = createOperation('vcarve', identity)
    ;(first.params.flatClearing as { stepoverMm: number }).stepoverMm = 9
    first.heights.heightIntent!.bottom.offset = -99
    expect(second.params.flatClearing).toEqual({ mode: 'vbit', stepoverMm: 0.5 })
    expect(second.heights.heightIntent!.bottom.offset).toBe(-5)
    const custom = createOperation('vcarve', identity, { params: { startDepthMm: 3, flatDepthMm: 2 } })
    expect(custom.params).toMatchObject({ startDepthMm: 3, flatDepthMm: 2, tolerance: 0.01 })
  })
  it('declares the different dimensions of the planar and 3D helix and stepover', () => {
    expect(OPERATION_REGISTRY.adaptive_3d.schema().fields.stepover).toMatchObject({ unit: 'fraction', max: 1 })
    expect(OPERATION_REGISTRY.adaptive_3d.schema().fields.helixDiameter.unit).toBe('mm')
    expect(OPERATION_REGISTRY.adaptive_clearing_2d.schema().fields.helixDiameter.unit).toBe('percent')
    expect(OPERATION_REGISTRY.steep_shallow_3d.schema().fields.thresholdDeg).toMatchObject({ min: 0, max: 90, outsideRange: 'clamp' })
  })
})

const closed: KnowledgeDeclaration = { required: ['planar-contours'], optional: ['stock-state'], closedRegions: true }
describe('WO-2905 one validation contract', () => {
  it('proceeds with required knowledge and absent optional extras silently', () => {
    expect(validateOperation(closed, { operationName: 'Pocket', available: ['planar-contours'] }))
      .toEqual({ status: 'PROCEED', usableFeatures: [], omittedFeatures: [], messages: [] })
  })
  it('mentions absent optional stock only if the caller asked for the stock extra', () => {
    expect(validateOperation(closed, { operationName: 'Pocket', available: ['planar-contours'], requestedOptional: ['stock-state'] }))
      .toMatchObject({ status: 'PROCEED', messages: ['Pocket: continuing without stock-state extras.'] })
  })
  it('degrades to the usable region, naming the omitted open chain', () => {
    expect(validateOperation(closed, { operationName: 'Pocket', available: ['planar-contours'], features: [
      { name: 'Boss', closed: true }, { name: 'Front edge', closed: false },
    ] })).toEqual({ status: 'DEGRADE', usableFeatures: ['Boss'], omittedFeatures: ['Front edge'],
      messages: ['Pocket: planning usable regions; omitting open chains Front edge.'] })
  })
  it('does not discard an open contour from a route that can cut it', () => {
    expect(validateOperation({ ...closed, closedRegions: false }, { operationName: 'Trace', available: ['planar-contours'], features: [{ name: 'Front edge', closed: false }] }))
      .toMatchObject({ status: 'PROCEED', usableFeatures: ['Front edge'], messages: [] })
  })
  it('rejects a surface-height Z mode on 2D input without substituting parameter depth', () => {
    expect(validateOperation(closed, { operationName: 'Trace surface', zMode: 'surface-height', available: ['planar-contours'] }))
      .toMatchObject({ status: 'REJECT', messages: ['Trace surface: cannot plan without surface-height.'] })
  })
  it('rejects only when no usable closed region remains', () => {
    expect(validateOperation(closed, { operationName: 'Pocket', available: ['planar-contours'], features: [{ name: 'Front edge', closed: false }] }))
      .toMatchObject({ status: 'REJECT', usableFeatures: [], omittedFeatures: ['Front edge'] })
  })
})

describe('WO-2905 headless adapter contract (not engine toolpath evidence)', () => {
  it.each(operationTypes)('creates, validates and dispatches %s on current with no DOM', async type => {
    expect(typeof document).toBe('undefined')
    expect(typeof window).toBe('undefined')
    const result = { moves: [], computeTimeMs: 0 } as unknown as KernelPlan
    const current = vi.fn(async (_input: PlanningInput) => result)
    const api = createHeadlessPlanner(current)
    const operation = api.create(type, { id: type, name: type, toolId: 'T1' })
    const input = { operation } as PlanningInput
    expect(api.validate(type, { operationName: type, available: OPERATION_REGISTRY[type].knowledge.required }).status).toBe('PROCEED')
    expect(await api.plan(input)).toBe(result)
    expect(current).toHaveBeenCalledExactlyOnceWith(input)
  })
  it('does not send a mismatched family to an adapter', () => {
    expect(() => OPERATION_REGISTRY.face.plan({ operation: { type: 'drill' } } as PlanningInput, vi.fn()))
      .toThrow('Planner face received drill')
  })
})

// Independent compatibility oracle: evaluate only the pinned old pure reader
// declarations in memory. Never check out a second tree or run machine code.
const adapterCases = [
  ['adaptive3d', 'adaptive_3d', 'DEFAULT_ADAPTIVE3D_PARAMS', 'readAdaptive3dParams', adaptiveAdapter],
  ['parallel3d', 'parallel_3d', 'DEFAULT_PARALLEL3D_PARAMS', 'readParallel3dParams', parallelAdapter],
  ['waterline3d', 'waterline_3d', 'DEFAULT_WATERLINE_PARAMS', 'readWaterlineParams', waterlineAdapter],
  ['steepShallow3d', 'steep_shallow_3d', 'DEFAULT_STEEP_SHALLOW3D_PARAMS', 'readSteepShallow3dParams', steepAdapter],
  ['scallop3d', 'scallop_3d', 'DEFAULT_SCALLOP3D_PARAMS', 'readScallop3dParams', scallopAdapter],
  ['pencil3d', 'pencil_3d', 'DEFAULT_PENCIL3D_PARAMS', 'readPencil3dParams', pencilAdapter],
  ['rest3d', 'rest_3d', 'DEFAULT_REST3D_PARAMS', 'readRest3dParams', restAdapter],
] as const
const adapterSource = '3754196a86' // preserved branch before the granted adapter migration
const oldAdapter = (stem: string): Record<string, unknown> => {
  const path = `src/cam3d/integration/${stem}Operation.ts`
  const text = execFileSync('git', ['show', `${adapterSource}:${path}`], { encoding: 'utf8' })
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const statements = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) && /^read.*Params$|^readRestMachiningSettings$|^defaultWaterlineStepdownFor$/.test(node.name?.text ?? '') ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && /^DEFAULT_/.test(d.name.text)))
  const code = statements.map(node => node.getText(source)).join('\n').replace(/\bexport\s+/g, '')
  const names = statements.flatMap(node => ts.isFunctionDeclaration(node) ? [node.name!.text]
    : ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(source)) : [])
  return new Function(ts.transpile(code, { target: ts.ScriptTarget.ES2023 }) + `\nreturn { ${names.join(', ')} }`)()
}

describe('WO-2905 shared 3D adapter policy preserves old reader behavior', () => {
  it.each(adapterCases)('%s shares seeds/readers and matches pinned defaults, edge cases and warnings', (stem, type, constant, reader, module) => {
    const old = oldAdapter(stem)
    const current = module as unknown as Record<string, unknown>
    expect(current[constant]).toBe((sharedDefaults as unknown as Record<string, unknown>)[constant])
    expect(current[reader]).toBe((sharedSchema as unknown as Record<string, unknown>)[reader])
    expect(current[constant]).toEqual(old[constant])
    const readOld = old[reader] as (params: Record<string, unknown>) => unknown
    const readNew = current[reader] as typeof readOld
    const defaults = old[constant] as Record<string, unknown>
    const fields = Object.keys(defaults).concat(stem === 'rest3d' ? ['surfaceStockToLeave', 'restMachining'] : [])
    const values: unknown[] = [undefined, null, true, false, '', '0', '1', 'climb', 'conventional', 'region', 'level',
      'previous_operations', 'previous_tool', {}, [], NaN, Infinity, -Infinity, -100, -1, -0, 0, Number.MIN_VALUE,
      0.01, 0.5, 1, 3, 5, 10, 25, 30, 90, 100, 101, 1e10]
    const schema = type === 'rest_3d' ? undefined : parameterSchema(type)
    for (const field of Object.values(schema?.fields ?? {})) for (const bound of [field.min, field.max]) {
      if (bound !== undefined) values.push(bound - 1e-9, bound, bound + 1e-9)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let compared = 0
    const compare = (params: Record<string, unknown>) => {
      warn.mockClear()
      const expected = readOld(params)
      const warnings = [...warn.mock.calls]
      warn.mockClear()
      expect(readNew(params), `${stem} input ${String(Object.entries(params))}`).toEqual(expected)
      expect(warn.mock.calls).toEqual(warnings)
      compared++
    }
    try {
      compare({})
      compare(defaults)
      for (const key of fields) for (const value of values) compare({ [key]: value })
      for (const value of values) compare(Object.fromEntries(fields.map(key => [key, value])))
      if (stem === 'rest3d') {
        for (const primary of values) for (const alias of [undefined, -1, 0, 0.7, 5, NaN]) compare({ stockToLeave: primary, surfaceStockToLeave: alias })
        const settings = old.readRestMachiningSettings as typeof readOld
        for (const value of values) {
          const params = { restMachining: value, stockSource: value }
          expect(restAdapter.readRestMachiningSettings(params)).toEqual(settings(params))
        }
        expect(restAdapter.DEFAULT_REST_MACHINING_SETTINGS).toBe(sharedDefaults.DEFAULT_REST_MACHINING_SETTINGS)
        expect(restAdapter.DEFAULT_REST3D_PARAMS.stockSource).toBe('previous_tool')
        expect(restAdapter.readRest3dParams({}).stockSource).toBe('previous_operations')
      }
      if (stem === 'waterline3d') {
        const toolSeed = old.defaultWaterlineStepdownFor as (diameter: number) => number
        for (const diameter of [NaN, Infinity, -1, 0, 0.1, 2, 3.175, 6, 12]) {
          expect(waterlineAdapter.defaultWaterlineStepdownFor(diameter)).toBe(toolSeed(diameter))
        }
      }
      console.info(`WO-2905 reader parity ${stem}: ${compared} input records plus shared-setting/tool-seed checks`)
    } finally { warn.mockRestore() }
  })

  it('exposes and enforces the distinct slope endpoints and fallback/clamp policies', () => {
    expect(parameterSchema('waterline_3d').fields.minSlopeDeg).toMatchObject({ max: 90, exclusiveMax: true })
    expect(parameterSchema('parallel_3d').fields.maxSlopeDeg).toMatchObject({ max: 90, exclusiveMin: true })
    expect(waterlineAdapter.readWaterlineParams({ minSlopeDeg: 90 }).minSlopeDeg).toBe(0)
    expect(parallelAdapter.readParallel3dParams({ maxSlopeDeg: 90 }).maxSlopeDeg).toBe(90)
    expect(adaptiveAdapter.readAdaptive3dParams({ stepover: 1.1 }).stepover).toBe(sharedDefaults.DEFAULT_ADAPTIVE3D_PARAMS.stepover)
    expect(parameterSchema('waterline_3d').fields.stockToLeave.outsideRange).toBe('clamp')
  })
})
