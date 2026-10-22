import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { migrateProjectData } from '../../store/migrations/projectMigrations'
import { createOperation, createHeadlessPlanner } from '../../kernel/headless'
import { editOperation } from '../../kernel/schema'
import { canonicalPlanText, derivePlanRecord, planItemKey, type GeneratedOperation, type Provenance } from '../../kernel/contracts/plan'
import { mergePlanOperations } from '../../kernel/session/planMerge'
import { deletePlanOperation, movePlanOperation } from '../../kernel/session/planEdits'
import { generationFingerprint } from '../../lib/cam/generationFingerprint'
import type { Operation } from '../../types'

const generator = 'test-only-stub'
const provenance: Provenance = { generatorKind: 'ruleset', generatorId: generator,
  ruleId: 'AL6061-FLAT-ADAPTIVE-01', rulesetVersion: '1.0.0', featureId: 'model:face-42', reason: 'Rough the pocket.', inputDigest: 'inputs-1' }
const user = (id: string) => createOperation('pocket_2d', { id, name: id, toolId: 'T1' })
// No product generator: this stub is the only producer of proposals.
function proposal(key: string, params: Record<string, unknown> = {}, owner = generator): GeneratedOperation {
  return { ...user(`proposal-${key}`), params: { stepdown: 2, stepover: 1, nested: { a: 1, b: 2 }, ...params },
    provenance: { ...provenance, generatorId: owner }, itemKey: key }
}
const setup = (operations: Operation[], deletedItemKeys?: Record<string, string[]>) => ({ id: 'setup', operations,
  ...(deletedItemKeys ? { deletedItemKeys } : {}) })

describe('WO-2906 optional plan data', () => {
  it('creates provenance headlessly, preserves absent fields and round trips ordinary records', () => {
    const ordinary = user('manual')
    expect(ordinary).not.toHaveProperty('provenance')
    expect(ordinary).not.toHaveProperty('userEdited')
    const generated = createOperation('pocket_2d', { id: 'gen', name: 'gen', toolId: 'T1' }, {
      provenance, itemKey: 'stable', userEdited: ['params.stepdown'],
    })
    const data = setup([ordinary, generated], { [generator]: ['deleted'] })
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
    expect(JSON.parse(JSON.stringify(derivePlanRecord([data])))).toEqual(derivePlanRecord([data]))
    expect(derivePlanRecord([data])).toMatchObject({ contract: 'kernel.plan', schemaVersion: '1.0.0',
      setups: [{ setupId: 'setup', items: [{ operationId: 'manual', orderIndex: 0, enabled: true },
        { operationId: 'gen', orderIndex: 1, provenance, itemKey: 'stable' }] }] })
    generated.provenance!.reason = 'Caller changes its copy.'
    expect(provenance.reason).toBe('Rough the pocket.')
  })
  it('preserves optional data through the production project-load migration boundary', () => {
    const original = migrateProjectData(JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')))
    const generated = { ...original.setups[0].operations[0], provenance, itemKey: 'persisted-key', userEdited: ['params.stepover'] }
    const project = structuredClone(original)
    project.setups[0].operations[0] = generated
    project.setups[0].deletedItemKeys = { [generator]: ['deleted-key'] }
    const loaded = migrateProjectData(JSON.parse(JSON.stringify(project)))
    expect(loaded).toEqual(project)
    expect(loaded.setups[0].operations[1]).not.toHaveProperty('provenance')
    expect(migrateProjectData(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })
  it('derives the plan digest independently of origin, edit history and tombstones', () => {
    const op = proposal('key')
    const first = derivePlanRecord([setup([op])])
    const changed = { ...op, provenance: { ...provenance, reason: 'Source feature no longer found.', inputDigest: 'other' }, userEdited: ['params.stepdown'] }
    expect(derivePlanRecord([setup([changed], { [generator]: ['gone'] })]).planDigest).toBe(first.planDigest)
    expect(derivePlanRecord([setup([{ ...changed, enabled: false }])]).planDigest).not.toBe(first.planDigest)
    expect(derivePlanRecord([setup([user('second'), changed])]).planDigest).not.toBe(first.planDigest)
  })
  it('keys stable feature identity with generator, rule and role rather than proposal order or data version', () => {
    const key = planItemKey(generator, provenance.ruleId, 'model:face-42', 'roughing')
    expect(planItemKey(generator, provenance.ruleId, 'model:face-42', 'roughing')).toBe(key)
    for (const args of [[generator, provenance.ruleId, 'model:face-43', 'roughing'],
      [generator, provenance.ruleId, 'model:face-42', 'finishing'], ['other', provenance.ruleId, 'model:face-42', 'roughing']] as const) {
      expect(planItemKey(args[0], args[1], args[2], args[3])).not.toBe(key)
    }
    expect(planItemKey(generator, undefined, undefined, 'roughing')).toMatch(/^plan-item-v1-/)
    expect(planItemKey('a|b', undefined, 'c', 'd')).not.toBe(planItemKey('a', 'b', 'c', 'd'))
  })
  it('excludes all plan metadata from generation freshness while a machining parameter still changes it', () => {
    const op = proposal('key')
    const fingerprint = (operation: Operation, deletedItemKeys?: Record<string, string[]>) => generationFingerprint({ operation,
      setup: { deletedItemKeys, id: 'setup', wcs: {}, stock: {} }, geometry: [], stocks: [], machine: {},
    } as unknown as Parameters<typeof generationFingerprint>[0])
    const first = fingerprint(op)
    expect(fingerprint({ ...op, provenance: { ...provenance, generatorId: 'other', reason: 'different' },
      itemKey: 'other', userEdited: ['params.stepover'] }, { [generator]: ['deleted'] })).toBe(first)
    expect(fingerprint({ ...op, params: { ...op.params, stepdown: 9 } })).not.toBe(first)
  })
})

describe('WO-2906 edit tracking and merge contract', () => {
  it('exposes the same edit boundary headlessly without invoking a generator or planner', () => {
    const api = createHeadlessPlanner(async () => { throw new Error('An edit must not plan') })
    expect(api.edit).toBe(editOperation)
    expect(api.edit(proposal('a'), [{ path: 'params.stepover', value: 0 }]).userEdited).toEqual(['params.stepover'])
  })
  it('tracks changed paths only on generated records, deduplicates them and preserves explicit zeros', () => {
    const initial = proposal('a')
    const edited = editOperation(initial, [{ path: 'params.stepover', value: 0 }, { path: 'params.nested.a', value: 8 }])
    expect(edited.userEdited).toEqual(['params.nested.a', 'params.stepover'])
    expect(editOperation(edited, [{ path: 'params.stepover', value: 0 }])).toEqual(edited)
    expect(editOperation(user('manual'), [{ path: 'params.stepover', value: 0 }])).not.toHaveProperty('userEdited')
    expect(initial.params.stepover).toBe(1)
    expect(edited.params.stepover).toBe(0)
  })
  it('adds sorted new keys after the generator last item and leaves other generators/user items alone', () => {
    const owned = proposal('old')
    const other = proposal('a', {}, 'other')
    const current = [user('first'), owned, other, user('last')]
    const result = mergePlanOperations(current, [proposal('z'), proposal('b')], generator)
    expect(result.operations.map(op => op.id)).toEqual(['first', owned.id, 'proposal-b', 'proposal-z', other.id, 'last'])
    expect(result.report.map(item => item.outcome)).toEqual(['no-longer-proposed', 'added', 'added'])
    expect(mergePlanOperations([user('manual')], [proposal('a')], generator).operations.map(op => op.id)).toEqual(['manual', 'proposal-a'])
    expect(current).toEqual([user('first'), owned, other, user('last')])
  })
  it('updates untouched values but preserves operation identity', () => {
    const current = { ...proposal('a'), id: 'persisted-id' }
    const result = mergePlanOperations([current], [proposal('a', { stepdown: 7 })], generator)
    expect(result.operations[0]).toMatchObject({ id: 'persisted-id', params: { stepdown: 7 } })
    expect(result.report[0].outcome).toBe('updated')
    expect(mergePlanOperations(result.operations, [proposal('a', { stepdown: 7 })], generator).report[0].outcome).toBe('unchanged')
  })
  it('keeps every edited nested/whole/absent path while taking proposals on unedited paths', () => {
    const edited = editOperation(proposal('a'), [
      { path: 'params.nested.a', value: 9 }, { path: 'toolId', value: 'T7' },
      { path: 'params.stepover', remove: true }, { path: 'enabled', value: false },
    ])
    const newer = { ...proposal('a', { nested: { a: 3, b: 4 }, stepdown: 6 }), toolId: 'T2' }
    const result = mergePlanOperations([edited], [newer], generator)
    expect(result.operations[0]).toMatchObject({ toolId: 'T7', enabled: false,
      params: { nested: { a: 9, b: 4 }, stepdown: 6 }, userEdited: edited.userEdited })
    expect(result.operations[0].params).not.toHaveProperty('stepover')
    expect(result.report[0]).toMatchObject({ outcome: 'user-edited', keptPaths: ['enabled', 'params.nested.a', 'params.stepover', 'toolId'] })
    expect(result.report[0].message).toContain('kept because user-edited')
  })
  it('preserves whole array/object edits and undefined rather than leaking proposal children', () => {
    const edited = editOperation(proposal('a'), [{ path: 'params.nested', value: { mine: 1 } },
      { path: 'geometrySelections', value: ['mine'] }, { path: 'params.stepover', value: undefined }])
    const result = mergePlanOperations([edited], [proposal('a')], generator).operations[0]
    expect(result.params.nested).toEqual({ mine: 1 })
    expect(result.geometrySelections).toEqual(['mine'])
    expect(result.params).toHaveProperty('stepover', undefined)
  })
  it('preserves an indexed model reference as an iterable array when the proposal omits it', () => {
    const original = { ...proposal('a'), modelReferences: [
      { bodyId: 'body-1', stableIds: ['face-1'], role: 'machining-boundary' as const },
    ] }
    const edited = editOperation(original, [{ path: 'modelReferences.0',
      value: { ...original.modelReferences[0], stableIds: ['face-user'] } }])
    const newer = proposal('a')
    const snapshot = structuredClone({ original, edited, newer })
    const result = mergePlanOperations([edited], [newer], generator)
    expect(Array.isArray(result.operations[0].modelReferences)).toBe(true)
    expect(result.operations[0].modelReferences).toEqual(edited.modelReferences)
    // The ordinary store verification consumer uses for..of, then stableIds.
    const ids: string[] = []
    for (const ref of result.operations[0].modelReferences ?? []) ids.push(...ref.stableIds)
    expect(ids).toEqual(['face-user'])
    expect(result.report[0].keptPaths).toEqual(['modelReferences.0'])
    expect({ original, edited, newer }).toEqual(snapshot)
    result.operations[0].modelReferences![0].stableIds.push('result-only')
    expect(edited.modelReferences![0].stableIds).toEqual(['face-user'])
  })
  it('fills a shorter proposed array only through the edited index with intact source elements', () => {
    const references = [0, 1, 2, 3].map(index => ({ bodyId: `body-${index}`,
      stableIds: [`face-${index}`], role: 'machining-boundary' as const }))
    const edited = editOperation({ ...proposal('a'), modelReferences: references }, [
      { path: 'modelReferences.2.stableIds.0', value: 'face-user' },
    ])
    for (const modelReferences of [undefined, [{ ...references[0], stableIds: ['proposed'] }]]) {
      const newer = { ...proposal('a'), ...(modelReferences ? { modelReferences } : {}) }
      const snapshot = structuredClone({ edited, newer })
      const merged = mergePlanOperations([edited], [newer], generator).operations[0]
      expect(Array.isArray(merged.modelReferences)).toBe(true)
      expect(merged.modelReferences).toEqual([
        modelReferences?.[0] ?? references[0], references[1],
        { ...references[2], stableIds: ['face-user'] },
      ])
      expect(JSON.parse(JSON.stringify(merged.modelReferences))).toEqual(merged.modelReferences)
      for (const ref of merged.modelReferences ?? []) expect(ref.bodyId).toMatch(/^body-/)
      expect({ edited, newer }).toEqual(snapshot)
    }
  })
  it('keeps actual nested array and numeric-key object shapes across missing or primitive proposal parents', () => {
    const edited = editOperation(proposal('a', { matrix: [[1, 2], [3, 4]], numbered: { '0': { value: 1 } } }), [
      { path: 'params.matrix.1.0', value: 9 }, { path: 'params.numbered.0.value', value: 8 },
    ])
    for (const params of [{ matrix: undefined, numbered: undefined }, { matrix: 7, numbered: false }]) {
      const result = mergePlanOperations([edited], [proposal('a', params)], generator).operations[0]
      expect(result.params.matrix).toEqual([[1, 2], [9, 4]])
      expect(result.params.numbered).toEqual({ '0': { value: 8 } })
      expect(Array.isArray(result.params.numbered)).toBe(false)
    }
  })
  it('reports every edited path differing from the original proposal, including overlapping paths', () => {
    const edited = editOperation(proposal('a'), [
      { path: 'params.nested', value: { a: 8, b: 9 } }, { path: 'params.nested.a', value: 10 },
    ])
    const result = mergePlanOperations([edited], [proposal('a')], generator)
    expect(result.operations[0].params.nested).toEqual({ a: 10, b: 9 })
    expect(result.report[0].keptPaths).toEqual(['params.nested', 'params.nested.a'])
  })
  it('preserves overlapping whole-array and indexed edits using final authored values', () => {
    const edited = editOperation(proposal('a'), [{ path: 'geometrySelections', value: ['one', 'two'] },
      { path: 'geometrySelections.1', value: 'user' }])
    const result = mergePlanOperations([edited], [{ ...proposal('a'), geometrySelections: ['new'] }], generator)
    expect(result.operations[0].geometrySelections).toEqual(['one', 'user'])
    expect(result.report[0].keptPaths).toEqual(['geometrySelections', 'geometrySelections.1'])
  })
  it('removes array elements densely and tracks their containing array so shifted edits survive reruns', () => {
    const initial = { ...proposal('a'), geometrySelections: ['first', 'second', 'third'] }
    const edited = editOperation(initial, [{ path: 'geometrySelections.2', value: 'user' },
      { path: 'geometrySelections.0', remove: true }])
    expect(edited.geometrySelections).toEqual(['second', 'user'])
    expect(edited.userEdited).toContain('geometrySelections')
    const result = mergePlanOperations([edited], [initial], generator).operations[0]
    expect(result.geometrySelections).toEqual(['second', 'user'])
    expect(JSON.parse(JSON.stringify(result.geometrySelections))).toEqual(result.geometrySelections)
    expect(initial.geometrySelections).toEqual(['first', 'second', 'third'])
  })
  it('does not manufacture missing parents for deleted nested paths', () => {
    const edited = editOperation(proposal('a'), [{ path: 'params.nested.a', remove: true }])
    const newer = proposal('a')
    delete newer.params.nested
    const result = mergePlanOperations([edited], [newer], generator)
    expect(result.operations[0].params).not.toHaveProperty('nested')
    expect(result.report[0].keptPaths).toEqual([])
    expect(result.report[0].outcome).toBe('user-edited')
  })
  it('rejects primitive traversal and sparse array authoring as programmer errors without changing inputs', () => {
    const initial = { ...proposal('a'), geometrySelections: ['first'] }
    const before = structuredClone(initial)
    for (const path of ['name.child', 'params.stepdown.child', 'geometrySelections.3', 'geometrySelections.length']) {
      expect(() => editOperation(initial, [{ path, value: 'bad' }])).toThrow(TypeError)
    }
    expect(editOperation(initial, [{ path: 'geometrySelections.1', value: 'append' }]).geometrySelections)
      .toEqual(['first', 'append'])
    expect(initial).toEqual(before)
  })
  it('reports authored history even when the proposal already agrees and uses JSON numeric canonicalization', () => {
    const edited = editOperation(proposal('a'), [{ path: 'params.stepdown', value: 8 }])
    expect(mergePlanOperations([edited], [proposal('a', { stepdown: 8 })], generator).report[0])
      .toMatchObject({ outcome: 'user-edited', keptPaths: [] })
    expect(canonicalPlanText({ a: undefined, n: -0, value: 1.1234564 }))
      .toBe(canonicalPlanText({ n: 0, value: 1.123456 }))
  })
  it('records and honors deletions per generator across a save/load and rerun', () => {
    const initial = setup([proposal('a'), proposal('b', {}, 'other')])
    const deleted = deletePlanOperation(initial, 'proposal-a')
    const loaded = JSON.parse(JSON.stringify(deleted))
    const result = mergePlanOperations(loaded.operations, [proposal('a')], generator, loaded.deletedItemKeys[generator])
    expect(result.operations).toEqual([initial.operations[1]])
    expect(result.report[0]).toMatchObject({ outcome: 'deleted', message: 'proposal-a: deleted by user, not re-added.' })
    expect(initial).not.toHaveProperty('deletedItemKeys')
    expect(mergePlanOperations([], [proposal('a', {}, 'other')], 'other', loaded.deletedItemKeys.other).operations).toHaveLength(1)
  })
  it('keeps an item no longer proposed and provenance for a feature no longer present', () => {
    const old = proposal('missing-feature')
    const result = mergePlanOperations([old], [], generator)
    expect(result.operations).toEqual([old])
    expect(result.report).toHaveLength(1)
    expect(result.report[0].outcome).toBe('no-longer-proposed')
  })
  it('keeps a user-moved position, preserves edited values and reports one line for that item', () => {
    const current = movePlanOperation([proposal('a'), user('manual'), proposal('b')], 'proposal-a', 2)
    current[2] = editOperation(current[2], [{ path: 'params.stepdown', value: 8 }])
    const result = mergePlanOperations(current, [proposal('a'), proposal('c'), proposal('b')], generator)
    expect(result.operations.map(op => op.id)).toEqual(['manual', 'proposal-b', 'proposal-a', 'proposal-c'])
    expect(result.operations[2].params.stepdown).toBe(8)
    expect(result.report.filter(item => item.itemKey === 'a')).toHaveLength(1)
    expect(result.report.find(item => item.itemKey === 'a')).toMatchObject({ outcome: 'kept-position', keptPaths: ['params.stepdown'] })
    expect(movePlanOperation([user('manual')], 'manual', 0)[0]).not.toHaveProperty('userEdited')
  })
  it('is byte deterministic for repeated inputs and shuffled proposals, without input mutation', () => {
    const current = [user('manual'), editOperation(proposal('a'), [{ path: 'params.stepover', value: 3 }])]
    const proposals = [proposal('z'), proposal('a'), proposal('b')]
    const before = JSON.stringify({ current, proposals })
    const first = mergePlanOperations(current, proposals, generator)
    expect(JSON.stringify(mergePlanOperations(current, proposals, generator))).toBe(JSON.stringify(first))
    expect(JSON.stringify(mergePlanOperations(current, [...proposals].reverse(), generator))).toBe(JSON.stringify(first))
    expect(JSON.stringify({ current, proposals })).toBe(before)
    first.operations[1].params.stepover = -10
    expect(current[1].params.stepover).toBe(3)
  })
  it('treats a prototype-named generator as ordinary dictionary data', () => {
    const op = proposal('a', {}, '__proto__')
    const result = deletePlanOperation(setup([op]), op.id)
    expect(Object.keys(result.deletedItemKeys!)).toEqual(['__proto__'])
    expect(result.deletedItemKeys!.__proto__).toEqual(['a'])
  })
  it('rejects malformed programmer proposals and prototype paths without mutating any input', () => {
    const op = proposal('a')
    expect(() => mergePlanOperations([], [op, op], generator)).toThrow('unique keys')
    expect(() => mergePlanOperations([op, { ...op, id: 'duplicate-key' }], [], generator)).toThrow('unique keys')
    expect(() => mergePlanOperations([user('proposal-a')], [op], generator)).toThrow('unique operation ids')
    expect(() => mergePlanOperations([], [proposal('a', {}, 'other')], generator)).toThrow('named generator')
    expect(() => editOperation(op, [{ path: 'params.__proto__.polluted', value: true }])).toThrow('Invalid operation edit path')
    expect({}).not.toHaveProperty('polluted')
  })
})
