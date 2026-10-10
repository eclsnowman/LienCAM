import { describe, it, expect } from 'vitest'
import { buildPostInput, MISSING_TOOL_ID } from '../../lib/post/buildPostInput'
import { validateToolNumbers } from '../../lib/post/validate'
import { makeTool, makeMachine, makeOp, makeOverride, makeWcs } from './helpers'
import type { PhysicalStock, Project, Setup, Tool } from '../../types'

function makeProject(tools: Tool[], setup: Setup, stocks?: PhysicalStock[]): Project {
  return {
    id: 'p1',
    name: 'P',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: tools,
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks,
    notes: '',
  }
}

function makeSetup(ops: Setup['operations']): Setup {
  return {
    id: 's1',
    name: 'Setup 1',
    wcs: makeWcs(),
    stock: {} as Setup['stock'],
    operations: ops,
    notes: '',
  }
}

describe('buildPostInput', () => {
  it('maps a 2-op setup, preserving order', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const t2 = makeTool({ id: 't2', toolNumber: 2 })
    const setup = makeSetup([
      makeOp({ id: 'a', toolId: 't1' }),
      makeOp({ id: 'b', toolId: 't2' }),
    ])
    const input = buildPostInput(makeProject([t1, t2], setup), setup)
    expect(input.setup.operations.map((o) => o.op.id)).toEqual(['a', 'b'])
    expect(input.setup.operations[0].tool.id).toBe('t1')
    expect(input.setup.operations[1].tool.id).toBe('t2')
    expect(input.machine.controller).toBe('uccnc')
  })

  it('skips disabled ops', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const setup = makeSetup([
      makeOp({ id: 'a', toolId: 't1' }),
      makeOp({ id: 'b', toolId: 't1', enabled: false }),
    ])
    const input = buildPostInput(makeProject([t1], setup), setup)
    expect(input.setup.operations.map((o) => o.op.id)).toEqual(['a'])
  })

  it('carries project.stocks to PostInput.stocks', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const setup = makeSetup([makeOp({ toolId: 't1' })])
    const stocks: PhysicalStock[] = [{
      id: 'st1',
      name: 'Stock',
      mode: 'explicit',
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 }, center: { x: 0, y: 0, z: 0 } },
      position: { x: 0, y: 0, z: 0 },
    }]
    const input = buildPostInput(makeProject([t1], setup, stocks), setup)
    expect(input.stocks).toBe(stocks)
  })

  it('substitutes a fail-loud sentinel when the tool is not found', () => {
    const setup = makeSetup([makeOp({ id: 'a', toolId: 'ghost' })])
    const input = buildPostInput(makeProject([], setup), setup)
    const po = input.setup.operations[0]
    expect(po.tool.id).toBe(MISSING_TOOL_ID)
    expect(po.tool.toolNumber).toBeUndefined()
    // The missing tool surfaces through validation rather than being dropped.
    const diags = validateToolNumbers(input.setup.operations)
    expect(diags.some((d) => d.code === 'TOOL_NUMBER_MISSING')).toBe(true)
  })

  it('resolves spindle and coolant onto each PostOperation', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const setup = makeSetup([makeOp({ toolId: 't1' })])
    const input = buildPostInput(makeProject([t1], setup), setup)
    expect(input.setup.operations[0].spindle.rpm).toBe(12000)
    expect(input.setup.operations[0].coolant).toBe('flood')
  })

  it('carries an enabled operation RPM override into the resolved post input', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const setup = makeSetup([
      makeOp({ toolId: 't1' }),
      makeOp({
        id: 'finish',
        toolId: 't1',
        feedrateOverride: makeOverride({ rpm: 8000 }),
      }),
    ])
    const input = buildPostInput(makeProject([t1], setup), setup)

    expect(input.setup.operations.map((operation) => operation.spindle.rpm)).toEqual([12000, 8000])
  })
})
