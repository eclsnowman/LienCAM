// WO-2983 (WO-2950 plan): several beds on one machine. operator ruling 2026-10-20: "Yes -
// share G54, separate files only (recommended)". Two setups on different
// stocks may both use G54; they post as separate files only, each file equal
// to posting that setup alone, with unique default names; one combined program
// still refuses the shared offset.
import { describe, expect, it } from 'vitest'
import { postProject, type PostProjectOptions } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { importProgramContextFromGcode } from '../../lib/post'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { BoundingBox, ImportedGeometry, Operation, PhysicalStock, Project, Setup, Vec3 } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock = (id: string, x = 0): PhysicalStock => ({
  id, name: `Stock ${id}`, mode: 'explicit',
  bounds: bbox({ x, y: 0, z: 0 }, { x: x + 20, y: 20, z: 10 }), position: { x: 0, y: 0, z: 0 },
})

const geometry = (id: string, stockId: string): ImportedGeometry => ({
  id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
  boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId, loops: [],
} as ImportedGeometry)

const operation = (id: string, geometryId: string, x = 5, overrides: Partial<Operation> = {}): Operation => makeOp({
  id, name: id, toolId: 't1', params: { geometryId },
  toolpathMoves: [
    move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
    move({ type: 'feed', x, y: 0, z: -1, feed: 100, role: 'cut' }),
    move({ type: 'rapid', x, y: 0, z: 5, role: 'rapid' }),
  ],
  ...overrides,
})

/** A setup the Setup dialog writes today: setup-owned offset, stock-corner bound. */
function bed(id: string, name: string, fixtureOffset: number, stockId: string, operations: Operation[]): Setup {
  return {
    id, name,
    wcs: {
      ...makeWcs({
        id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset, stockId,
        cornerRow: 2, cornerCol: 0, cornerFace: 'top',
        originBinding: { kind: 'stock_corner', stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
      }),
      fixtureOffsetOwner: 'setup',
    } as Setup['wcs'],
    stock: makeStock(),
    operations, notes: '',
  }
}

function project(setups: Setup[], geometryRows: ImportedGeometry[], stocks: PhysicalStock[]): Project {
  const p: Project = {
    id: 'beds', name: 'Beds', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(), toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: geometryRows, stocks, setups,
    activeSetupId: setups[0]?.id ?? null, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const s of setups) for (const op of s.operations) stampGenerationCurrent(p, s, op, p.toolLibrary[0])
  return p
}

/** Bed 1 (stock A) and Bed 2 (stock B), both on G54: two successive loads. */
function twoBeds() {
  const a = bed('bed-1', 'Bed 1 - cabinet sides', 54, 'stock-a', [operation('op-a1', 'geo-a', 5), operation('op-a2', 'geo-a', 7)])
  const b = bed('bed-2', 'Bed 2 - cabinet back', 54, 'stock-b', [operation('op-b1', 'geo-b', 9)])
  const p = project([a, b], [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-b')], [stock('stock-a'), stock('stock-b', 40)])
  return { p, a, b }
}

const OPTS: PostProjectOptions = { mode: 'separate', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

describe('WO-2983 single-machine beds: shared G54, separate files only', () => {
  it('posts two different-stock G54 beds as separate files and refuses them combined', () => {
    const { p, a, b } = twoBeds()
    const separate = postProject(p, [a, b], UCCNC_CONFIG, OPTS)
    expect(separate.ok).toBe(true)
    expect(separate.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(separate.files?.map((f) => f.setupId)).toEqual(['bed-1', 'bed-2'])
    for (const file of separate.files ?? []) expect(file.result.gcode.split('\n')).toContain('G54')

    const combined = postProject(p, [a, b], UCCNC_CONFIG, { ...OPTS, mode: 'combined' })
    expect(combined.ok).toBe(false)
    expect(combined.combined).toBeUndefined()
    expect(combined.files).toBeUndefined()
    const refusal = combined.diagnostics.find((d) => d.code === 'DUPLICATE_WORK_OFFSET')
    expect(refusal?.level).toBe('error')
    expect(refusal?.message).toContain('G54')
    expect(refusal?.message).toContain('separate files')
  })

  it('makes each separate file byte-equal to posting that bed alone', () => {
    const { p, a, b } = twoBeds()
    const both = postProject(p, [a, b], UCCNC_CONFIG, OPTS)
    for (const s of [a, b]) {
      const alone = postProject(p, [s], UCCNC_CONFIG, OPTS)
      expect(alone.ok).toBe(true)
      const file = both.files!.find((f) => f.setupId === s.id)!
      expect(file.result.gcode).toBe(alone.files![0].result.gcode)
      expect(file.result.operationSpans).toEqual(alone.files![0].result.operationSpans)
    }
  })

  it('keeps each file context to its own bed and operations', () => {
    const { p, a, b } = twoBeds()
    const both = postProject(p, [a, b], UCCNC_CONFIG, { ...OPTS, programContext: true })
    expect(both.ok).toBe(true)
    for (const [setup, ops] of [[a, ['op-a1', 'op-a2']], [b, ['op-b1']]] as const) {
      const file = both.files!.find((f) => f.setupId === setup.id)!
      expect(file.result.programContextEnvelope).toMatchObject({ included: true, setupCount: 1 })
      const imported = importProgramContextFromGcode(file.result.gcode)
      expect(imported.warning).toBeNull()
      expect(imported.context).not.toBeNull()
      const text = JSON.stringify(imported.context)
      expect(text).toContain(setup.id)
      for (const other of [a, b].filter((x) => x !== setup)) expect(text).not.toContain(other.id)
      for (const opId of ['op-a1', 'op-a2', 'op-b1']) {
        if ((ops as readonly string[]).includes(opId)) expect(text).toContain(opId)
        else expect(text).not.toContain(opId)
      }
    }
  })

  it('gives every emitted file a unique default name and keeps unique historical names', () => {
    const { p, a, b } = twoBeds()
    const c = bed('bed-3', 'Bed 3', 55, 'stock-c', [operation('op-c1', 'geo-c')])
    p.setups.push(c)
    p.stocks!.push(stock('stock-c', 80))
    p.geometry.push(geometry('geo-c', 'stock-c'))
    stampGenerationCurrent(p, c, c.operations[0], p.toolLibrary[0])
    const result = postProject(p, [a, b, c], UCCNC_CONFIG, OPTS)
    expect(result.files?.map((f) => f.filename)).toEqual([
      'part-G54-Bed-1-cabinet-sides.nc',
      'part-G54-Bed-2-cabinet-back.nc',
      'part-G55.nc',
    ])
    // One bed alone keeps the historical name.
    expect(postProject(p, [b], UCCNC_CONFIG, OPTS).files?.map((f) => f.filename)).toEqual(['part-G54.nc'])
  })

  it('names equal, case-only, punctuated, empty and suffix-like setup names apart, deterministically', () => {
    const names = ['Bed', 'Bed-2', 'bed', 'BED', 'Bed: 1/2?', '   ', '...', 'Bed']
    const stocks = names.map((_, i) => stock(`stock-${i}`, i * 30))
    const setups = names.map((name, i) => bed(`s${i}`, name, 54, `stock-${i}`, [operation(`op-${i}`, `geo-${i}`)]))
    const p = project(setups, names.map((_, i) => geometry(`geo-${i}`, `stock-${i}`)), stocks)
    const run = () => postProject(p, setups, UCCNC_CONFIG, OPTS).files!.map((f) => f.filename)
    const filenames = run()
    expect(filenames).toEqual([
      'part-G54-Bed.nc',
      'part-G54-Bed-2.nc',
      'part-G54-bed-3.nc',
      'part-G54-BED-4.nc',
      'part-G54-Bed-1-2.nc',
      'part-G54-setup.nc',
      'part-G54-setup-2.nc',
      'part-G54-Bed-5.nc',
    ])
    expect(new Set(filenames.map((n) => n.toLowerCase())).size).toBe(filenames.length)
    for (const n of filenames) expect(n).not.toMatch(/[<>:"/\\|?*]/)
    expect(run()).toEqual(filenames)
  })

  it('same stock on the same slot still posts, combined and separate, with distinct names', () => {
    const a = bed('a', 'Top', 54, 'stock-a', [operation('op-a', 'geo-a')])
    const b = bed('b', 'Top', 54, 'stock-a', [operation('op-b', 'geo-a', 8)])
    const p = project([a, b], [geometry('geo-a', 'stock-a')], [stock('stock-a')])
    expect(postProject(p, [a, b], UCCNC_CONFIG, { ...OPTS, mode: 'combined' }).ok).toBe(true)
    const separate = postProject(p, [a, b], UCCNC_CONFIG, OPTS)
    expect(separate.ok).toBe(true)
    expect(separate.files?.map((f) => f.filename)).toEqual(['part-G54-Top.nc', 'part-G54-Top-2.nc'])
  })

  it('an unselected bed adds no file; a partial selection posts only the chosen operations', () => {
    const { p, a, b } = twoBeds()
    const onlyB = postProject(p, [a, b], UCCNC_CONFIG, { ...OPTS, selectedOpIds: { 'bed-1': [] } })
    expect(onlyB.ok).toBe(true)
    expect(onlyB.files?.map((f) => [f.setupId, f.filename])).toEqual([['bed-2', 'part-G54.nc']])
    expect(onlyB.diagnostics.some((d) => d.code === 'SETUP_NO_OPS_SELECTED')).toBe(true)

    const partial = postProject(p, [a, b], UCCNC_CONFIG, { ...OPTS, selectedOpIds: { 'bed-1': ['op-a2'] } })
    const fileA = partial.files!.find((f) => f.setupId === 'bed-1')!
    expect(fileA.result.operationSpans?.map((s) => s.opId)).toEqual(['op-a2'])
    expect(partial.files!.find((f) => f.setupId === 'bed-2')!.result.operationSpans?.map((s) => s.opId)).toEqual(['op-b1'])
  })

  it('a disabled operation stays out of its own bed and never moves to the other', () => {
    const { p, a, b } = twoBeds()
    a.operations[0].enabled = false
    const result = postProject(p, [a, b], UCCNC_CONFIG, OPTS)
    expect(result.ok).toBe(true)
    expect(result.files!.find((f) => f.setupId === 'bed-1')!.result.operationSpans?.map((s) => s.opId)).toEqual(['op-a2'])
    expect(result.files!.find((f) => f.setupId === 'bed-2')!.result.operationSpans?.map((s) => s.opId)).toEqual(['op-b1'])
  })

  it('keeps every per-bed refusal in separate mode', () => {
    const { p, a, b } = twoBeds()
    // Bed 2 rebound to a stock its operations do not cut: its own error still
    // stops the whole export, even though Bed 1 alone could post.
    b.wcs.stockId = 'ghost'
    b.wcs.originBinding = { kind: 'stock_corner', stockId: 'ghost', cornerRow: 2, cornerCol: 0, cornerFace: 'top' }
    const result = postProject(p, [a, b], UCCNC_CONFIG, OPTS)
    expect(result.ok).toBe(false)
    expect(result.files).toBeUndefined()
    expect(result.diagnostics.some((d) => d.code === 'SETUP_STOCK_BINDING_MISMATCH' && d.level === 'error')).toBe(true)
  })
})
