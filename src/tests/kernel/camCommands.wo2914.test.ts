import { validFacts } from './authoringFacts.wo2914'
import { textFor } from '../../i18n'
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import type { CamCommand } from '../../kernel/camCommands'
import { AGENT_COMMAND_ALLOW_LIST, liencamCommands } from '../../lib/agent/commands'

const state = () => useCamStore.getState()
const setupId = () => state().project.setups[0].id
const op = (id: string) => ({ ...structuredClone(state().project.setups[0].operations[0]), id, name: id })
const run = (commands: CamCommand[]) => state().executeCamCommands(commands)
const add = (id: string): CamCommand => ({ kind: 'operation.add', setupId: setupId(), operation: op(id) })
const edit = (id: string, name: string): CamCommand => ({ kind: 'operation.update', setupId: setupId(), operationId: id, patch: { name } })

beforeEach(async () => {
  await state().loadProjectFromFile(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
  useCamStore.setState({ projectHistory: [], projectFuture: [], sketchHistory: [], sketchFuture: [],
    toolSlicesHistory: [], toolSlicesFuture: [], canUndo: false, canRedo: false })
  await Promise.resolve()
})

describe('WO-2914 shared CAM transactions on a real opened project', () => {
  it('gives consecutive same-turn calls one undo/redo each', () => {
    expect(run([add('a')]).ok).toBe(true)
    expect(run([edit('a', 'second')]).ok).toBe(true)
    expect(state().projectHistory).toHaveLength(2)
    state().undo()
    expect(state().project.setups[0].operations.at(-1)?.name).toBe('a')
    state().undo()
    expect(state().project.setups[0].operations.some(op => op.id === 'a')).toBe(false)
    state().redo()
    state().redo()
    expect(state().project.setups[0].operations.at(-1)?.name).toBe('second')
  })
  it('publishes a multi-operation batch once and undoes it as one action', () => {
    const before = state().project.setups[0].operations.map(op => op.id)
    expect(run([add('clearing'), add('carve'), edit('clearing', 'floor')]).ok).toBe(true)
    expect(state().projectHistory).toHaveLength(1)
    state().undo()
    expect(state().project.setups[0].operations.map(op => op.id)).toEqual(before)
  })
  it('leaves project, selection, console and both history directions identical on a failed batch', () => {
    run([add('a')]); state().undo()
    const before = state()
    const result = run([add('would-have-been-partial'), edit('missing', 'no')])
    expect(result).toMatchObject({ ok: false, code: 'missing-target' })
    for (const key of ['project', 'viewer', 'consoleEvents', 'projectHistory', 'projectFuture',
      'sketchHistory', 'sketchFuture', 'toolSlicesHistory', 'toolSlicesFuture'] as const) {
      expect(state()[key]).toBe(before[key])
    }
  })
  it('rejects a duplicate id without a phantom undo step or input mutation', () => {
    const operation = op('duplicate')
    const copy = structuredClone(operation)
    const before = state().project
    expect(run([{ kind: 'operation.add', setupId: setupId(), operation }, add('duplicate')])).toMatchObject({ ok: false, code: 'duplicate-id' })
    expect(state().project).toBe(before)
    expect(state().projectHistory).toHaveLength(0)
    expect(operation).toEqual(copy)
  })
  it('preserves generated provenance and tracks authored edits, but never result publications', () => {
    const operation = { ...op('generated'), provenance: { generatorKind: 'ruleset' as const,
      generatorId: 'script', rulesetVersion: '1', reason: 'ordered', inputDigest: 'input' }, itemKey: 'key' }
    run([{ kind: 'operation.add', setupId: setupId(), operation }])
    run([edit('generated', 'mine')])
    const current = () => state().project.setups[0].operations.find(op => op.id === 'generated')!
    expect(current().provenance).toEqual(operation.provenance)
    expect(current().userEdited).toEqual(['name'])
    const depth = state().projectHistory.length
    state().updateOperation(setupId(), 'generated', { status: 'computing', progress: 0 })
    expect(current().toolpathMoves).toBeUndefined()
    expect(current().generationFingerprint).toBeUndefined()
    expect(state().projectHistory).toHaveLength(depth)
    expect(current().userEdited).toEqual(['name'])
    expect(state().project.setups[0].operations[0]).not.toHaveProperty('provenance')
  })
  it('keeps legacy multi-write panel handlers coalesced without changing explicit call semantics', async () => {
    state().pushHistory()
    const id = state().project.setups[0].operations[0].id
    state().updateOperation(setupId(), id, { name: 'panel' })
    state().updateOperation(setupId(), id, { enabled: false })
    expect(state().projectHistory).toHaveLength(1)
    await Promise.resolve()
    state().updateOperation(setupId(), id, { name: 'next action' })
    expect(state().projectHistory).toHaveLength(2)
  })
  it('returns the screen words and changes no state for a rejected operation draft', () => {
    const before = state()
    const facts = { ...validFacts('contour_2d'), toolId: '' }
    const text = textFor('cam-operations-new-operation')
    const result = state().executeCamCommands([add('rejected')], { kind: 'operation', facts, text })
    expect(result).toEqual({ ok: false, code: 'invalid-draft',
      message: text('NewOperationModalBody.Go_to_the_Tool_tab_and_select_a_tool') })
    expect(state()).toBe(before)
  })
  it('keeps a rejected setup draft atomic across a batch', () => {
    const before = state()
    expect(state().executeCamCommands([add('rejected')], { kind: 'setup', facts: {
      heightsResolved: true, fixtureStackError: null,
      mustPickStock: false, originMode: 'bore', boreBound: false, secondSide: 'none',
    } })).toEqual({ ok: false, code: 'invalid-draft' })
    expect(state()).toBe(before)
  })
  it('returns the existing Smart Height failure without partial edits or mutating the input', () => {
    const operation = op('missing-height')
    delete operation.smartHeight
    const before = state()
    const result = run([add('would-be-partial'), { kind: 'operation.add', setupId: setupId(), operation }])
    expect(result).toMatchObject({ ok: false, code: 'invalid-draft' })
    if (!result.ok) expect(result.message).toContain('Smart Height V2')
    expect(state()).toBe(before)
    expect(operation.smartHeight).toBeUndefined()
  })
  it('refuses machine and machine-action commands and leaves external commands read-only', () => {
    const before = state()
    for (const command of [{ kind: 'machine.start' }, { kind: 'setup.update', setupId: setupId(), patch: { machineActions: [] } },
      { kind: 'operation.update', setupId: setupId(), operationId: state().project.setups[0].operations[0].id, patch: { type: 'run_macro' } }]) {
      expect(run([command as unknown as CamCommand]).ok).toBe(false)
    }
    expect(state().project).toBe(before.project)
    expect(state().projectHistory).toBe(before.projectHistory)
    expect(AGENT_COMMAND_ALLOW_LIST).toEqual(['project_summary', 'feature_details', 'tool_library', 'machine_limits'])
    expect(Object.keys(liencamCommands)).toEqual(AGENT_COMMAND_ALLOW_LIST)
  })
  it('keeps machine state unchanged on every successful CAM command route', () => {
    const before = state()
    const setup = { ...structuredClone(before.project.setups[0]), id: 'second-setup', operations: [] }
    delete setup.machineActions
    for (const command of [
      { kind: 'setup.add', setup },
      { kind: 'setup.update', setupId: 'second-setup', patch: { name: 'CAM only' } },
      add('cam-only'), edit('cam-only', 'edited'),
      { kind: 'operation.remove', setupId: setupId(), operationId: 'cam-only' },
    ] as CamCommand[]) {
      expect(run([command]).ok).toBe(true)
      expect(state().project.machine).toBe(before.project.machine)
      for (const key of ['control', 'machineLibrary', 'machineWorkOffsets', 'machineDatumRevokedAxes'] as const) {
        expect(state()[key]).toBe(before[key])
      }
    }
  })
  it('preserves explicit zero, undefined and absent metadata through shared edits', () => {
    const id = state().project.setups[0].operations[0].id
    expect(run([{ kind: 'operation.update', setupId: setupId(), operationId: id,
      patch: { params: { ...state().project.setups[0].operations[0].params, explicitZero: 0, explicitUndefined: undefined } } }]).ok).toBe(true)
    const operation = state().project.setups[0].operations[0]
    expect(operation.params.explicitZero).toBe(0)
    expect(Object.hasOwn(operation.params, 'explicitUndefined')).toBe(true)
    expect(operation).not.toHaveProperty('provenance')
    expect(operation).not.toHaveProperty('userEdited')
  })
  it('applies setup edits through the same path with one undo and keeps machine configuration intact', () => {
    const before = state().project
    expect(run([{ kind: 'setup.update', setupId: setupId(), patch: { name: 'shared', notes: 'zero hidden defaults' } }]).ok).toBe(true)
    expect(state().project.setups[0]).toMatchObject({ name: 'shared', notes: 'zero hidden defaults' })
    expect(state().project.machine).toBe(before.machine)
    expect(state().projectHistory).toHaveLength(1)
    state().undo()
    expect(state().project.setups[0].name).toBe(before.setups[0].name)
  })
})
