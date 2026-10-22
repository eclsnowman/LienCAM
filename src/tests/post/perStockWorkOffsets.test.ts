import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveSetupWorkOffset,
  WorkOffsetResolutionError,
} from '../../lib/post/workOffsets'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { migrateProjectToHierarchy } from '../../store/migrateHierarchy'
import { useCamStore } from '../../store'
import {
  makeMachine,
  makeOp,
  makeTool,
  makeWcs,
  move,
  stampGenerationCurrent,
} from './helpers'
import type {
  BoundingBox,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Project,
  Setup,
  Vec3,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

function stock(id: string, fixtureOffset?: number): PhysicalStock {
  return {
    id,
    name: `Stock ${id}`,
    mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 10 }),
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset,
  }
}

function geometry(id: string, stockId: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: `${id}.dxf`,
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId,
    loops: [],
  } as ImportedGeometry
}

function operation(id: string, geometryId: string): Operation {
  return makeOp({
    id,
    name: id,
    toolId: 't1',
    params: { geometryId },
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 100, role: 'cut' }),
    ],
  })
}

function setup(
  id: string,
  fixtureOffset: number,
  stockId?: string,
  operations: Operation[] = [],
): Setup {
  return {
    id,
    name: `Setup ${id}`,
    wcs: makeWcs({
      id: `wcs-${id}`,
      label: `G${fixtureOffset}`,
      fixtureOffset,
      ...(stockId
        ? {
            stockId,
            cornerRow: 2,
            cornerCol: 0,
            cornerFace: 'top' as const,
            originBinding: {
              kind: 'stock_corner' as const,
              stockId,
              cornerRow: 2,
              cornerCol: 0,
              cornerFace: 'top' as const,
            },
          }
        : {}),
    }),
    stock: {} as Setup['stock'],
    operations,
    notes: '',
  }
}

function project(
  setups: Setup[],
  geometryRows: ImportedGeometry[],
  stocks: PhysicalStock[],
): Project {
  return {
    id: 'p',
    name: 'Per-stock offsets',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: geometryRows,
    stocks,
    setups,
    activeSetupId: setups[0]?.id ?? null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
}

describe('per-stock work-offset resolution', () => {
  it('preserves stock-first resolution for unmarked legacy setups', () => {
    const a = setup('a', 54, 'stock-a', [operation('op-a', 'geo-a')])
    const b = setup('b', 54, 'stock-b', [operation('op-b', 'geo-b')])
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-b')],
      [stock('stock-a', 55), stock('stock-b', 56)],
    )

    expect(resolveSetupWorkOffset(p, a).fixtureOffset).toBe(55)
    expect(resolveSetupWorkOffset(p, b).fixtureOffset).toBe(56)
  })

  it('resolves an explicitly setup-owned offset without rewriting its stock', () => {
    const s = setup('owned', 55, 'stock-a', [operation('op', 'geo-a')])
    ;(s.wcs as typeof s.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    const p = project([s], [geometry('geo-a', 'stock-a')], [stock('stock-a', 54)])

    expect(resolveSetupWorkOffset(p, s)).toMatchObject({
      fixtureOffset: 55,
      setup: { wcs: { fixtureOffset: 55, label: 'G55' } },
    })
    expect(p.stocks?.[0].fixtureOffset).toBe(54)
  })

  it('keeps the legacy setup default when a stock has no assigned offset', () => {
    const s = setup('legacy', 54, 'stock-a', [operation('op', 'geo-a')])
    const p = project([s], [geometry('geo-a', 'stock-a')], [stock('stock-a')])
    const resolved = resolveSetupWorkOffset(p, s)
    expect(resolved.fixtureOffset).toBe(54)
    expect(resolved.setup.wcs).toEqual(s.wcs)
  })

  it('preserves an unbound legacy setup offset', () => {
    const s = setup('unbound', 58)
    const p = project([s], [], [])
    expect(resolveSetupWorkOffset(p, s)).toMatchObject({
      fixtureOffset: 58,
      setup: { wcs: { fixtureOffset: 58, label: 'G58' } },
    })
  })

  it('treats originBinding as authoritative over a stale legacy stockId', () => {
    const s = setup('reader-flip', 54)
    s.wcs.stockId = 'stock-a'
    s.wcs.originBinding = {
      kind: 'stock_corner',
      stockId: 'stock-b',
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
    }
    const p = project([s], [], [stock('stock-a', 55), stock('stock-b', 56)])
    expect(resolveSetupWorkOffset(p, s)).toMatchObject({
      fixtureOffset: 56,
      stockId: 'stock-b',
    })
  })

  it('fails loud on dangling and mismatched stock bindings', () => {
    const dangling = setup('dangling', 54, 'ghost')
    const danglingProject = project([dangling], [], [stock('stock-a', 55)])
    expect(() => resolveSetupWorkOffset(danglingProject, dangling)).toThrow(
      WorkOffsetResolutionError,
    )
    try {
      resolveSetupWorkOffset(danglingProject, dangling)
    } catch (error) {
      expect((error as WorkOffsetResolutionError).code).toBe('WORK_OFFSET_STOCK_MISSING')
    }

    const mismatch = setup('mismatch', 54, 'stock-b', [operation('op', 'geo-a')])
    const mismatchProject = project(
      [mismatch],
      [geometry('geo-a', 'stock-a')],
      [stock('stock-a', 55), stock('stock-b', 56)],
    )
    expect(() => resolveSetupWorkOffset(mismatchProject, mismatch)).toThrow(
      /operations cut stock "stock-a"/,
    )
  })

  it('survives a project JSON save/load round trip', () => {
    const p = project([], [], [stock('stock-a', 57)])
    const loaded = migrateProjectToHierarchy(JSON.parse(JSON.stringify(p)) as Project)
    expect(loaded.stocks?.find((item) => item.id === 'stock-a')?.fixtureOffset).toBe(57)
  })

  it('drives post output and separate-file naming from the owning stock', () => {
    const op = operation('op', 'geo-a')
    const s = setup('post', 54, 'stock-a', [op])
    const p = project([s], [geometry('geo-a', 'stock-a')], [stock('stock-a', 55)])
    stampGenerationCurrent(p, s, op, p.toolLibrary[0])

    const combined = postProject(p, [s], UCCNC_CONFIG, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'part',
      ext: 'nc',
    })
    expect(combined.ok).toBe(true)
    expect(combined.combined?.gcode.split('\n')).toContain('G55')
    expect(combined.combined?.gcode.split('\n')).not.toContain('G54')

    const separate = postProject(p, [s], UCCNC_CONFIG, {
      mode: 'separate',
      pauseBetweenSetups: false,
      baseName: 'part',
      ext: 'nc',
    })
    expect(separate.ok).toBe(true)
    expect(separate.files?.[0].filename).toBe('part-G55.nc')
  })

  it('allows multiple setups on the same stock to share its assigned offset', () => {
    const opA = operation('op-a', 'geo-a')
    const opB = operation('op-b', 'geo-b')
    const a = setup('a', 54, 'stock-a', [opA])
    const b = setup('b', 55, 'stock-a', [opB])
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-a')],
      [stock('stock-a', 57)],
    )
    stampGenerationCurrent(p, a, opA, p.toolLibrary[0])
    stampGenerationCurrent(p, b, opB, p.toolLibrary[0])

    const result = postProject(p, [a, b], UCCNC_CONFIG, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'part',
      ext: 'nc',
    })

    expect(result.ok).toBe(true)
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'DUPLICATE_WORK_OFFSET',
    )).toBe(false)
    expect(result.combined?.gcode.split('\n').filter((line) => line === 'G57').length)
      .toBeGreaterThanOrEqual(2)
  })

  it('fails loud when different stocks share one assigned offset', () => {
    const opA = operation('op-a', 'geo-a')
    const opB = operation('op-b', 'geo-b')
    const a = setup('a', 54, 'stock-a', [opA])
    const b = setup('b', 56, 'stock-b', [opB])
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-b')],
      [stock('stock-a', 55), stock('stock-b', 55)],
    )
    stampGenerationCurrent(p, a, opA, p.toolLibrary[0])
    stampGenerationCurrent(p, b, opB, p.toolLibrary[0])

    const result = postProject(p, [a, b], UCCNC_CONFIG, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'part',
      ext: 'nc',
    })

    expect(result.ok).toBe(false)
    expect(result.combined).toBeUndefined()
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'DUPLICATE_WORK_OFFSET',
    )).toBe(true)
  })

  it('posts distinct setup-owned offsets for two setups on one stock', () => {
    const opA = operation('op-a', 'geo-a')
    const opB = operation('op-b', 'geo-b')
    const a = setup('a', 54, 'stock-a', [opA])
    const b = setup('b', 55, 'stock-a', [opB])
    ;(a.wcs as typeof a.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    ;(b.wcs as typeof b.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-a')],
      [stock('stock-a', 54)],
    )
    stampGenerationCurrent(p, a, opA, p.toolLibrary[0])
    stampGenerationCurrent(p, b, opB, p.toolLibrary[0])

    const result = postProject(p, [a, b], UCCNC_CONFIG, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'part',
      ext: 'nc',
    })

    expect(result.ok).toBe(true)
    expect(result.combined?.gcode.split('\n')).toContain('G54')
    expect(result.combined?.gcode.split('\n')).toContain('G55')
  })
})

describe('canonical stock work-offset store action', () => {
  const originalProject = useCamStore.getState().project

  afterEach(() => {
    useCamStore.setState({ project: originalProject, projectHistory: [] })
  })

  it('writes the stock and mirrors every setup bound to it', () => {
    const a = setup('store-a', 54, 'stock-a')
    const b = setup('store-b', 55, 'stock-a')
    useCamStore.setState({
      project: project([a, b], [], [stock('stock-a')]),
      projectHistory: [],
    })

    expect(() =>
      useCamStore.getState().setStockFixtureOffset('stock-a', 57),
    ).not.toThrow()
    const next = useCamStore.getState().project
    expect(next.stocks?.[0].fixtureOffset).toBe(57)
    expect(next.setups.map((setup) => setup.wcs.fixtureOffset)).toEqual([57, 57])
    expect(next.setups.map((setup) => setup.wcs.label)).toEqual(['G57', 'G57'])
  })

  // WO-2999 (operator ruling 10-20 "share G54, separate files only"): a shared offset is
  // allowed here; only Combined output refuses it, in the post.
  it('shares an occupied offset and refuses invalid and missing assignments', () => {
    const a = setup('a', 54, 'stock-a')
    useCamStore.setState({
      project: project([a], [], [stock('stock-a', 54), stock('stock-b', 55)]),
      projectHistory: [],
    })

    useCamStore.getState().setStockFixtureOffset('stock-b', 54)
    expect(useCamStore.getState().project.stocks?.map((s) => s.fixtureOffset)).toEqual([54, 54])
    expect(() => useCamStore.getState().setStockFixtureOffset('ghost', 56))
      .toThrow(/no PhysicalStock/)
    expect(() =>
      useCamStore.getState().setStockFixtureOffset('stock-b', 60 as never),
    ).toThrow(/invalid/)
  })
})
