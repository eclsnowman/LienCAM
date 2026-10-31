// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Project, ToolpathMove } from '../../types'
import { operationDependsOnPredecessors, projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import * as operationStock from '../../store/operationStockInputs'
import { getOperationStockDomain, useCamStore } from '../../store'
import { saveMachineToolRecord, useMachineToolTable } from '../../store/machineToolTableStore'
import { makeMachine } from '../post/helpers'

beforeEach(() => {
  const machine = makeMachine({ id: 'wo3125-transaction', name: 'Saved definition', rapidRate: 2500 })
  const live = { ...machine, name: 'Connection snapshot', rapidRate: 1234 }
  useCamStore.setState(s => ({ machineLibrary: [machine], project: { ...s.project, machine },
    control: { ...s.control, sessionMachine: live, appliedMachine: { ...live, rapidRate: 1200 } } }))
  useMachineToolTable.setState({ byMachine: {}, availableMeasurement: null })
})

describe('WO-3125 atomic operator tool record', () => {
  it('publishes library, project, session and applied copies in one observable transaction', () => {
    const machine = useCamStore.getState().project.machine
    const cache = useMachineToolTable.getState()
    cache.addTool(machine.id, 9)
    cache.recordProbedZ(machine.id, 9, -42.125, 123)
    cache.setReference(machine.id, 9)
    cache.setProbeConfig(machine.id, { fastFeed: 270 })
    cache.addProbePad(machine.id, 12.7)
    const seen: ReturnType<typeof useCamStore.getState>[] = []
    const off = useCamStore.subscribe(state => { seen.push(state) })
    try { saveMachineToolRecord(machine) } finally { off() }
    expect(seen, 'one complete tool-record publication, with no intermediate stale copy').toHaveLength(1)
    const state = seen[0]
    const copies = [state.machineLibrary[0], state.project.machine, state.control.sessionMachine!, state.control.appliedMachine!]
    for (const copy of copies) {
      expect(copy.toolTable).toEqual({ reference: 9, tools: [expect.objectContaining({ tool: 9, probedMachineZ: -42.125, measuredAt: 123 })] })
      expect(copy.probeOverrides).toEqual({ fastFeed: 270 })
      expect(copy.probePads).toEqual([{ id: 'pad-1', thickness: 12.7 }])
      expect(copy.activeProbePadId).toBe('pad-1')
    }
    expect(state.control.sessionMachine!.rapidRate).toBe(1234)
    expect(state.control.appliedMachine!.rapidRate).toBe(1200)
    expect(state.control.sessionMachine!.name).toBe(state.project.machine.name)
  })

  it('keeps cache-only writes isolated and does not create an orphan record or replace another project', () => {
    const state = useCamStore.getState()
    const machine = state.project.machine
    useMachineToolTable.getState().addTool(machine.id, 3)
    expect(useCamStore.getState()).toBe(state)
    const other = makeMachine({ id: 'different-project' })
    useCamStore.setState(s => ({ project: { ...s.project, machine: other } }))
    saveMachineToolRecord(machine)
    expect(useCamStore.getState().project.machine).toBe(other)
    expect(useCamStore.getState().machineLibrary[0].toolTable!.tools[0].tool).toBe(3)
    const before = useCamStore.getState()
    saveMachineToolRecord(makeMachine({ id: 'absent' }))
    expect(useCamStore.getState()).toBe(before)
  })

  it('retains adoption and existing stock observers rather than suppressing subscribers', () => {
    const machine = useCamStore.getState().project.machine
    const originalGeometry = useCamStore.getState().project.geometry
    useMachineToolTable.getState().addTool(machine.id, 1)
    const observe = vi.spyOn(operationStock, 'observeOperationStockState')
    try {
      saveMachineToolRecord(machine)
      expect(observe, 'the raw-edit-aware stock observer sees the completed transaction').toHaveBeenCalledTimes(1)
    } finally { observe.mockRestore() }
    const after = useCamStore.getState()
    expect(after.project.geometry).toBe(originalGeometry)
    expect(after.project.machine.toolTable).toBe(after.machineLibrary[0].toolTable)
    expect(after.project.machine.controllerDefinition).toEqual(machine.controllerDefinition)
  })
})


// WO-3085/2953: raw writes must still inspect every move value, preserve eager
// invalidation and restored Face witnesses, even when unchanged JSON is reused.
afterEach(() => vi.restoreAllMocks())
function stockFixture() {
  const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')) as Project
  useCamStore.setState({ project, toolLibrary: project.toolLibrary, machineLibrary: [project.machine] })
  const setup = project.setups[0]
  const domain = getOperationStockDomain(setup.id, setup.wcs.stockId!)
  useCamStore.setState({ project }) // settle the domain's initial serial
  return { project, setup, domain, op: setup.operations[0],
    write: () => useCamStore.setState({ project }) }
}
function containsMoves(value: unknown, moves: Set<unknown>, depth = 0): boolean {
  return moves.has(value) || (depth < 6 && Array.isArray(value) && value.some(v => containsMoves(v, moves, depth + 1)))
}

describe('WO-3125 lossless eager stock observation', () => {
  it('scans unchanged completed moves without serializing them on a real tool-record publication', () => {
    const { project } = stockFixture()
    const moves = new Set(project.setups.flatMap(s => s.operations.map(op => op.toolpathMoves)))
    moves.delete(undefined)
    useMachineToolTable.getState().addTool(project.machine.id, 1)
    const stringify = vi.spyOn(JSON, 'stringify')
    saveMachineToolRecord(project.machine)
    const replayed = stringify.mock.calls.filter(([value]) => containsMoves(value, moves))
    expect(replayed, 'unchanged completed moves are value-scanned, never reserialized during tool-record publication').toHaveLength(0)
  })

  it.each(['type', 'x', 'y', 'z', 'a', 'b', 'c', 'feed', 'cx', 'cy', 'role', 'engagement', 'dwellMs'] as const)(
    'eagerly detects same-array same-count raw %s edits and edit-away/back', key => {
      const { op, write, domain } = stockFixture()
      const moves = op.toolpathMoves!, move = moves[1]
      const original = { ...move }
      const reconcile = vi.spyOn(domain.authority, 'reconcile')
      Object.assign(move, { [key]: key === 'type' ? 'arc_cw' : key === 'role' ? 'link' : 41.125 })
      write()
      expect(op.toolpathMoves).toBe(moves)
      expect(reconcile).toHaveBeenCalledTimes(1)
      for (const k of Object.keys(move)) delete (move as unknown as Record<string, unknown>)[k]
      Object.assign(move, original)
      write()
      expect(reconcile, 'edit-away/back must reconcile twice even with the original array').toHaveBeenCalledTimes(2)
    })

  it('checks nested extensions, array order/length and JSON key order without an identity shortcut', () => {
    const { op, write, domain } = stockFixture()
    const moves = op.toolpathMoves!
    const move = moves[1] as ToolpathMove & { extension?: { values: number[] } }
    move.extension = { values: [1, 2] }; write()
    const reconcile = vi.spyOn(domain.authority, 'reconcile')
    move.extension.values[1] = 3; write()
    expect(reconcile).toHaveBeenCalledTimes(1)
    move.extension.values[1] = 2; write()
    expect(reconcile).toHaveBeenCalledTimes(2)
    op.toolpathMoves = JSON.parse(JSON.stringify(moves)); write()
    expect(reconcile, 'equal replacement has exactly the same JSON value').toHaveBeenCalledTimes(2)
    op.toolpathMoves![1] = Object.fromEntries(Object.entries(op.toolpathMoves![1]).reverse()) as unknown as ToolpathMove
    write(); expect(reconcile).toHaveBeenCalledTimes(3)
    op.toolpathMoves!.reverse(); write(); expect(reconcile).toHaveBeenCalledTimes(4)
    op.toolpathMoves!.push({ type: 'rapid', x: 1, y: 2, z: 3 }); write()
    expect(reconcile).toHaveBeenCalledTimes(5)
  })

  it.each(['result', 'status', 'error', 'heights', 'height-plan', 'predecessors', 'semantic', 'tool',
    'geometry', 'placement', 'setup', 'stock', 'order'] as const)('keeps eager %s invalidation', kind => {
    const { project, setup, op, write, domain } = stockFixture()
    const reconcile = vi.spyOn(domain.authority, 'reconcile')
    switch (kind) {
      case 'result': op.generationFingerprint += '-edited'; break
      case 'status': op.status = 'computing'; break
      case 'error': op.errorMessage = 'changed'; break
      case 'heights': op.resolvedHeights!.machine.clearance += 1; break
      case 'height-plan': op.resolvedHeightPlan!.machining.physicalTarget!.machineMm += 1; break
      case 'predecessors': Object.assign(op, { dependsOnPredecessors: !operationDependsOnPredecessors(op) }); break
      case 'semantic': op.passes.stepover += 1; break
      case 'tool': useCamStore.getState().toolLibrary[0].diameter += 1; break
      case 'geometry': project.geometry[0].name += '-edited'; break
      case 'placement': project.modelItemPlacements = [{ modelItemId: 'part', position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }]; break
      case 'setup': setup.wcs.origin.z += 1; break
      case 'stock': project.stocks![0].bounds.size.z += 1; break
      case 'order': setup.operations.reverse(); break
    }
    write()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('retains native JSON handling for omitted, nonfinite and toJSON extension values', () => {
    const { op, write, domain } = stockFixture()
    const move = op.toolpathMoves![0] as ToolpathMove & { extension?: unknown }
    const reconcile = vi.spyOn(domain.authority, 'reconcile')
    move.extension = undefined; write()
    expect(reconcile).not.toHaveBeenCalled()
    move.extension = NaN; write(); expect(reconcile).toHaveBeenCalledTimes(1)
    move.extension = Infinity; write(); expect(reconcile).toHaveBeenCalledTimes(1)
    let value = 1
    move.extension = { toJSON: () => ({ value }) }; write()
    expect(reconcile).toHaveBeenCalledTimes(2)
    write(); expect(reconcile).toHaveBeenCalledTimes(2)
    value = 2; write(); expect(reconcile).toHaveBeenCalledTimes(3)
    const callable = Object.assign(() => {}, { toJSON: () => ({ value }) })
    move.extension = callable; write(); expect(reconcile).toHaveBeenCalledTimes(3)
    value = 3; write(); expect(reconcile).toHaveBeenCalledTimes(4)
  })

  it('keeps live authority tokens and epoch disposal synchronous', async () => {
    const { project, setup, domain, write } = stockFixture()
    const request = { beforeOperationId: setup.operations[0].id, frame: domain.frame, maxCellMm: Number.MAX_VALUE }
    let read = domain.authority.readBefore(request)
    // WO-3126 deliberately yields preparation to a renderer timer. Wait for
    // real settlement; the token invalidation/disposal assertions stay sync.
    for (let i = 0; i < 100 && read.status === 'recomputing'; i++) {
      await operationStock.nextOperationStockChange(domain.authority)
      read = domain.authority.readBefore(request)
    }
    expect(read.status, JSON.stringify(read)).toBe('ready') // no predecessors: exact initial stock
    const query = { kind: 'highest-material' as const, frame: domain.frame,
      bounds: { minX: -1, minY: -1, minZ: -8, maxX: 1, maxY: 1, maxZ: 0 } }
    expect(domain.authority.query(read.token, query)).toMatchObject({ status: 'ready', value: 0 })
    setup.wcs.origin.z += 1; write()
    expect(domain.authority.query(read.token, query).status).toBe('unavailable')
    const dispose = vi.spyOn(domain.authority, 'disposeProject')
    project.id += '-new-epoch'; write()
    expect(dispose).toHaveBeenCalledOnce()
    expect(domain.authority.query(read.token, query).status).toBe('unavailable')
  })
})


describe('WO-3125 restored Face stock witness', () => {
  it('retains a saved Face witness until predecessor values change, then rejects it immediately', () => {
    const { project, setup, domain, op, write } = stockFixture()
    const face = structuredClone(op)
    face.id = 'wo3125-restored-face'
    face.name = 'Restored Face'
    // Install a fresh epoch with an actually current saved Face after a simple
    // predecessor. No machine/toolpath generation or test-only approval occurs.
    op.type = 'contour_2d'
    Object.assign(op, { dependsOnPredecessors: false })
    Object.assign(face, { dependsOnPredecessors: false })
    setup.operations = [op, face]
    for (const candidate of setup.operations) candidate.generationFingerprint = projectOperationFingerprint(
      { ...project, toolLibrary: useCamStore.getState().toolLibrary }, setup, candidate, candidate.resolvedHeights!)
    project.id += '-restored'; write()
    const restored = getOperationStockDomain(setup.id, setup.wcs.stockId!)
    const inputs = () => operationStock.buildOperationStockInputs({ epoch: restored.frame.projectEpoch!,
      project, setup, toolLibrary: useCamStore.getState().toolLibrary, stockId: setup.wcs.stockId!,
      stockBounds: { min: { x: -62.5, y: -45, z: -8 }, max: { x: 62.5, y: 45, z: 0 } },
      stockIdOf: () => setup.wcs.stockId!, resultIsCurrent: candidate => candidate === op })
    expect(inputs().operations[1].removal.status, 'a current saved shared-stock Face retains its restored witness').toBe('ready')
    const reconcile = vi.spyOn(restored.authority, 'reconcile')
    op.toolpathMoves![1].x += 0.125; write()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(inputs().operations[1].removal.status, 'same-count raw predecessor edits invalidate the restored Face').toBe('missing')
    // No old domain is reused across the changed epoch.
    expect(restored.authority).not.toBe(domain.authority)
  })
})
