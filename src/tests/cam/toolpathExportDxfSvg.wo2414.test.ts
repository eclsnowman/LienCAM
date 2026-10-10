import { afterEach, describe, expect, it, vi } from 'vitest'
// jsdom is already a test dependency; this checkout has no @types/jsdom.
// @ts-expect-error untyped test-only XML reader
import { JSDOM } from 'jsdom'
import { typedMock } from '../support/typedMock'

// Replace browser transports only; both CAM engines and the compute store
// action remain real, using the established solid/height scenario harness.
vi.mock('../../lib/stepCache', async (original) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await original<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (id: string) => (await import('../helpers/heightScenario')).solidStepBytes(id),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (original) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await original<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (original) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await original<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarios.inProcessCam3dClient(), disposeCam3dClient: () => {},
  }))

import * as scenarios from '../helpers/heightScenario'
import { useCamStore } from '../../store'
import { toolpathDxf, toolpathSvg } from '../../lib/cam/toolpathExport'
import { exportOperationToolpath } from '../../components/panels/exportOperationToolpath'
import type { ToolpathMove } from '../../types'

scenarios.installRealToolpathWorker()
afterEach(() => vi.unstubAllGlobals())

type ReadPath = { layer: string; vertices: number[][] }

// Independent DXF reader: parse group-code records, never call the writer's
// grouping/coordinate helpers. Assert the standard 3D flags on every entity.
function readDxf(text: string): ReadPath[] {
  const lines = text.trim().split(/\r?\n/)
  const records: Array<Map<number, string>> = []
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1]
    if (code === 0) records.push(new Map())
    records.at(-1)?.set(code, value)
  }
  const paths: ReadPath[] = []
  let current: ReadPath | undefined
  for (const record of records) {
    const type = record.get(0)
    if (type === 'POLYLINE') {
      expect(record.get(100)).toBe('AcDb3dPolyline')
      expect(Number(record.get(70)) & 8).toBe(8)
      current = { layer: record.get(8)!, vertices: [] }; paths.push(current)
    } else if (type === 'VERTEX') {
      expect(record.get(100)).toBe('AcDb3dPolylineVertex')
      expect(Number(record.get(70)) & 32).toBe(32)
      expect(record.get(8)).toBe(current?.layer)
      current!.vertices.push([10, 20, 30].map(code => Number(record.get(code))))
    } else if (type === 'SEQEND') current = undefined
  }
  expect(records.at(-1)?.get(0)).toBe('EOF')
  expect(text).toContain('$INSUNITS\n70\n4\n')
  return paths
}

function readSvg(text: string): ReadPath[] {
  const dom = new JSDOM(text, { contentType: 'image/svg+xml' })
  const document: Document = dom.window.document
  expect(document.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg')
  expect(document.documentElement.getAttribute('width')).toMatch(/mm$/)
  expect(document.querySelector('g')?.getAttribute('transform')).toBe('scale(1,-1)')
  const result = Array.from(document.querySelectorAll('polyline')).map(element => ({
    layer: element.getAttribute('data-layer')!,
    vertices: element.getAttribute('points')!.trim().split(/\s+/).map(pair => pair.split(',').map(Number)),
  }))
  dom.window.close()
  return result
}

function matchesSource(paths: ReadPath[], moves: readonly ToolpathMove[], dimensions: 2 | 3) {
  expect(new Set(paths.map(p => p.layer))).toEqual(new Set(['CUT', 'RAPID']))
  let cursor = 0, count = 0
  const coords = (move: ToolpathMove) => [move.x, move.y, move.z].slice(0, dimensions)
  const close = (actual: number[], expected: number[]) => {
    expect(actual.length).toBe(dimensions)
    actual.forEach((n, i) => expect(Math.abs(n - expected[i])).toBeLessThanOrEqual(1e-6))
  }
  for (let p = 0; p < paths.length; p++) {
    const path = paths[p]
    if (p) close(path.vertices[0], coords(moves[cursor - 1]))
    for (const vertex of path.vertices.slice(p ? 1 : 0)) {
      const move = moves[cursor++]
      expect(path.layer).toBe(move.type === 'rapid' || move.role === 'rapid' ? 'RAPID' : 'CUT')
      close(vertex, coords(move))
      count++
    }
  }
  expect(count).toBe(moves.length)
  expect(paths.reduce((n, p) => n + p.vertices.length, 0)).toBe(moves.length + paths.length - 1)
}

async function exportStoredOperation() {
  const setup = useCamStore.getState().project.setups[0]
  const op = setup.operations[0]
  expect(op.status, op.errorMessage).toBe('ready')
  expect(op.toolpathMoves!.length).toBeGreaterThan(20)
  const save = vi.fn(async (_name: string, _data: string) => 'saved')
  vi.stubGlobal('liencamHost', { saveFile: save })
  await exportOperationToolpath(setup.id, op.id, 'dxf')
  await exportOperationToolpath(setup.id, op.id, 'svg')
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[0][0]).toMatch(/\.dxf$/)
  expect(save.mock.calls[1][0]).toMatch(/\.svg$/)
  matchesSource(readDxf(save.mock.calls[0][1]), op.toolpathMoves!, 3)
  matchesSource(readSvg(save.mock.calls[1][1]), op.toolpathMoves!, 2)
  console.log(`WO-2414 ${op.type}: ${op.toolpathMoves!.length} source vertices; DXF XYZ and SVG XY match within 1e-6 mm`)
}

describe('WO-2414 production operation toolpath export', () => {
  it('round-trips a production-computed 2D pocket through the button action and independent readers', async () => {
    const reading = await scenarios.runHeightScenario({
      part: { kind: 'sketch_2d', z: 0, loops: [scenarios.rectLoop('pocket', 0, 0, 40, 30)] },
      stock: { kind: 'fixed', width: 60, height: 50, depth: 10, position: { x: -10, y: -10, z: 0 } },
      operation: 'pocket_2d', loopIds: ['pocket'], toolDiameter: 6,
      bottomRow: { reference: 'stock_top', offsetMm: -3 },
    })
    expect(reading.status, reading.errorMessage).toBe('ready')
    await exportStoredOperation()
    // A pending operation can compute on demand from this same export action.
    const stateBefore = useCamStore.getState()
    const setupBefore = stateBefore.project.setups[0]
    const opBefore = setupBefore.operations[0]
    useCamStore.setState({ project: { ...stateBefore.project, setups: [{ ...setupBefore,
      operations: [{ ...opBefore, status: 'pending', toolpathMoves: undefined }],
    }] } })
    await exportOperationToolpath(setupBefore.id, opBefore.id, 'dxf')
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.status, computed.errorMessage).toBe('ready')
    expect(computed.toolpathMoves).toEqual(opBefore.toolpathMoves)
    const saved = (globalThis as unknown as { liencamHost: { saveFile: ReturnType<typeof vi.fn> } }).liencamHost.saveFile
    matchesSource(readDxf(saved.mock.calls.at(-1)![1]), computed.toolpathMoves!, 3)
    if (process.env.WRITE_EVIDENCE === '1') {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const state = useCamStore.getState()
      const directory = 'src/tests/evidence/WO-2414'
      mkdirSync(directory, { recursive: true })
      writeFileSync(`${directory}/pocket-scene.json`, JSON.stringify({ project: state.project, toolLibrary: state.toolLibrary }))
    }
  }, 180_000)

  it('round-trips a production-computed 3D parallel finish with 3D DXF vertices', async () => {
    const [reading] = await scenarios.runSolidScenario({
      part: 'closed_box', z: 0,
      stock: { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z: 0 } },
      operations: [{ kind: 'parallel_3d', toolDiameter: 6 }],
    })
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(new Set(reading.worldMoves.map(m => m.z)).size).toBeGreaterThan(1)
    await exportStoredOperation()
  }, 180_000)

  it('preserves alternating layer joins, duplicate vertices, arc endpoints, roles and full precision', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: -2.123456789, y: 4, z: 9 },
      { type: 'feed', x: -2.123456789, y: 4, z: -3.987654321, role: 'plunge' },
      { type: 'arc_ccw', x: 5, y: 6, z: -2, cx: 1, cy: 2 },
      { type: 'feed', x: 5, y: 6, z: -2 },
      { type: 'feed', role: 'rapid', x: 7, y: 8, z: 9 },
      { type: 'feed', role: 'fast_traverse', x: 10, y: 11, z: 12 },
    ]
    matchesSource(readDxf(toolpathDxf(moves)), moves, 3)
    matchesSource(readSvg(toolpathSvg(moves)), moves, 2)
  })

  it('exports empty and singleton documents without invalid bounds, and rejects non-finite coordinates', () => {
    expect(readDxf(toolpathDxf([]))).toEqual([])
    expect(readSvg(toolpathSvg([]))).toEqual([])
    const moves: ToolpathMove[] = [{ type: 'rapid', x: 1, y: 2, z: 3 }]
    expect(readDxf(toolpathDxf(moves))[0].vertices).toEqual([[1, 2, 3]])
    expect(readSvg(toolpathSvg(moves))[0].vertices).toEqual([[1, 2]])
    expect(() => toolpathDxf([{ ...moves[0], z: NaN }])).toThrow('non-finite')
    expect(() => toolpathSvg([{ ...moves[0], x: Infinity }])).toThrow('non-finite')
  })

  it('exports a saved path regardless of posting eligibility, sanitizes names and preserves cancellation', async () => {
    const state = useCamStore.getState()
    const setup = state.project.setups[0]
    const op = setup.operations[0]
    useCamStore.setState({ project: { ...state.project, setups: [{ ...setup, operations: [{ ...op,
      name: 'Pocket / cut?', status: 'outdated', enabled: false,
      toolpathMoves: [{ type: 'feed', x: 1, y: 2, z: 3 }],
    }] }] } })
    const save = vi.fn(async (_name: string, _data: string) => null)
    vi.stubGlobal('liencamHost', { saveFile: save })
    expect(await exportOperationToolpath(setup.id, op.id, 'dxf')).toBeNull()
    expect(save.mock.calls[0][0]).toBe('Pocket _ cut_.dxf')
    expect(readDxf(save.mock.calls[0][1])[0].vertices).toEqual([[1, 2, 3]])
    await expect(exportOperationToolpath(setup.id, 'missing', 'svg')).rejects.toThrow('no longer exists')
    expect(save).toHaveBeenCalledTimes(1)
    const current = useCamStore.getState()
    const currentSetup = current.project.setups[0]
    useCamStore.setState({ project: { ...current.project, setups: [{ ...currentSetup, operations: [{
      ...currentSetup.operations[0], name: `Pocket${String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i))}cut`,
    }] }] } })
    expect(await exportOperationToolpath(setup.id, op.id, 'svg')).toBeNull()
    expect(save.mock.calls[1][0]).toBe(`Pocket${'_'.repeat(32)}cut.svg`)
    expect(readSvg(save.mock.calls[1][1])[0].vertices).toEqual([[1, 2]])
  })
})
