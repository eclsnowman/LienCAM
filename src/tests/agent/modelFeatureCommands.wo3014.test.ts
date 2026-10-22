// @vitest-environment jsdom
//
// WO-3014: model.revolve, model.fillet, model.chamfer and model.hole on a real ModelSession.
// T1-T9 of docs/design/WO-2951-modeling-mcp.md "Test protocol", for the four feature commands.
//
// The reference for "what the dialog does" is the REAL dialog: its component is mounted on the
// session's own dag and history and its Apply button is clicked, so the payload the agent writes is
// compared with the one RevolveDialog / FilletDialog / ChamferDialog / HoleDialog write, not with a
// copy of it. The session's kernel op is a plain "ok" stub: the DAG, the history and the scheduler
// are real. The refusal words come from the same locale keys the dialogs and the page use.

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession, type ModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { createDocumentArchive, stableStringify } from '../../doc/persist'
import { RevolveDialog } from '../../components/model3d/dialogs'
import { ChamferDialog } from '../../components/model3d/dialogs/ChamferDialog'
import { FilletDialog } from '../../components/model3d/dialogs/FilletDialog'
import { HoleDialog } from '../../components/model3d/dialogs/HoleDialog'
import { textFor } from '../../i18n'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, schemaKeywordsOutsideSubset, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'

const workbenchText = textFor('sketch-and-model-workbench')
const COMMANDS = ['model.revolve', 'model.fillet', 'model.chamfer', 'model.hole'] as const

const AXIS_NODE = {
  datumType: 'axis',
  payloadSchema: 1,
  name: 'Axis A',
  definition: { kind: 'two-points', flip: false },
  lastGoodAxis: { origin: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, length: 40 },
}

/** SK1 profile (no plane), SK2 empty, SKF flat across world Z, AX1 an axis datum along X. */
function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID, kernelOp?: Parameters<typeof createModelSession>[0]['kernelOp']): ModelSession {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
  dag.insertNode({ id: 'SK2', kind: 'sketch', payload: { name: 'Empty', regions: [] } })
  dag.insertNode({
    id: 'SKF',
    kind: 'sketch',
    payload: { name: 'Flat', regions: [{ sketchId: 'SKF', plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }, loops: [] }] },
  })
  dag.insertNode({ id: 'AX1', kind: 'datum', payload: AXIS_NODE })
  const s = createModelSession({ modelItemId, dag, map: new ElementMap(), kernelOp: kernelOp ?? (async () => ({ ok: true, diagnostics: [] })) })
  registerModelSession(s)
  return s
}

afterEach(() => {
  cleanup()
  resetDocumentHolder()
})

function run(id: string, args?: unknown, options = {}): Promise<ModelCommandResult> {
  return modelCommands.run(id, args, options)
}

function ok(result: ModelCommandResult): ModelCommandSuccess<any> {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

/** A box-like body to dress up: an extrude node F1 that built. */
async function withBody(s: ModelSession, modelItemId?: string): Promise<void> {
  ok(await run('model.extrude', { sketchId: 'SK1', distance: 10 }, modelItemId === undefined ? {} : { modelItemId }))
  expect(s.dag.has('F1')).toBe(true)
}

function fingerprint(s: ModelSession) {
  return {
    dag: stableStringify(JSON.parse(s.dag.serialize())),
    depth: s.history.size(),
    revision: s.revision(),
    statuses: s.dag.nodeIds().map((id) => `${id}:${s.scheduler.statusOf(id)}`).join(','),
  }
}

function serialized(s: ModelSession): string {
  return stableStringify(JSON.parse(s.dag.serialize()))
}

function statuses(s: ModelSession): string[] {
  return s.dag.nodeIds().map((id) => `${id}:${s.scheduler.statusOf(id)}`)
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function choose(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

/** The dialog's Apply, then the page's fullResync after it. */
async function applied(s: ModelSession, id: string | null): Promise<void> {
  expect(id).not.toBeNull()
  s.scheduler.markDirty(id as string)
  await s.scheduler.run(s.params.executor)
}

const noop = (): void => {}

/** Mounts the real RevolveDialog on the session, sets its fields, clicks Apply. */
async function revolveDialog(s: ModelSession, fields: { sketchId: string; angleDeg?: number; axisDatumId?: string }): Promise<void> {
  let id: string | null = null
  render(createElement(RevolveDialog, {
    dag: s.dag, history: s.history, mode: 'create', sketchOptions: [{ id: fields.sketchId, label: fields.sketchId }],
    onApplied: (f: string) => { id = f }, onClose: noop,
  }))
  if (fields.axisDatumId !== undefined) choose('revolve-axis', fields.axisDatumId)
  if (fields.angleDeg !== undefined) commitField('revolve-angle', String(fields.angleDeg))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  cleanup()
  await applied(s, id)
}

async function filletDialog(s: ModelSession, f: { ownerId: string; edges: string[]; radius: number }): Promise<void> {
  let id: string | null = null
  render(createElement(FilletDialog, { dag: s.dag, history: s.history, mode: 'create', ownerId: f.ownerId, edgeIds: f.edges, onApplied: (x: string) => { id = x }, onClose: noop }))
  commitField('fillet-radius', String(f.radius))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await Promise.resolve()
  cleanup()
  await applied(s, id)
}

async function chamferDialog(s: ModelSession, f: { ownerId: string; edges: string[]; distance: number }): Promise<void> {
  let id: string | null = null
  render(createElement(ChamferDialog, { dag: s.dag, history: s.history, mode: 'create', ownerId: f.ownerId, edgeIds: f.edges, onApplied: (x: string) => { id = x }, onClose: noop }))
  commitField('chamfer-distance', String(f.distance))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await Promise.resolve()
  cleanup()
  await applied(s, id)
}

interface HoleFields {
  ownerId: string
  faceId: string
  seed: { x: number; y: number; z: number }
  normal?: { x: number; y: number; z: number }
  style: { kind: 'simple' | 'counterbore' | 'countersink'; diameter: number; cbDiameter?: number; cbDepth?: number; csDiameter?: number; csAngleDeg?: number }
  depth: { kind: 'blind' | 'throughAll'; distance?: number }
  placement?: { kind: 'single' | 'linear' | 'circular'; count?: number; spacing?: number; radius?: number; startAngleDeg?: number }
}

function holeDialogMounted(s: ModelSession, f: HoleFields, onApplied: (id: string) => void): void {
  render(createElement(HoleDialog, { dag: s.dag, history: s.history, mode: 'create', ownerId: f.ownerId, faceId: f.faceId, origin: f.seed, normal: f.normal ?? { x: 0, y: 0, z: 0 }, onApplied, onClose: noop }))
  choose('hole-style-select', f.style.kind)
  commitField('hole-diameter', String(f.style.diameter))
  if (f.style.kind === 'counterbore') {
    commitField('hole-cb-diameter', String(f.style.cbDiameter))
    commitField('hole-cb-depth', String(f.style.cbDepth))
  }
  if (f.style.kind === 'countersink') {
    commitField('hole-cs-diameter', String(f.style.csDiameter))
    commitField('hole-cs-angle', String(f.style.csAngleDeg))
  }
  choose('hole-depth-select', f.depth.kind)
  if (f.depth.kind === 'blind') commitField('hole-blind-distance', String(f.depth.distance))
  if (f.placement !== undefined) {
    choose('hole-placement-select', f.placement.kind)
    if (f.placement.kind !== 'single') commitField('hole-pattern-count', String(f.placement.count))
    if (f.placement.kind === 'linear') commitField('hole-pattern-spacing', String(f.placement.spacing))
    if (f.placement.kind === 'circular') {
      commitField('hole-pattern-radius', String(f.placement.radius))
      commitField('hole-pattern-start-angle', String(f.placement.startAngleDeg))
    }
  }
}

async function holeDialog(s: ModelSession, f: HoleFields): Promise<void> {
  let id: string | null = null
  holeDialogMounted(s, f, (x) => { id = x })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await Promise.resolve()
  cleanup()
  await applied(s, id)
}

const BASE_HOLE: HoleFields = {
  ownerId: 'F1',
  faceId: 'face#top',
  seed: { x: 5, y: 7.5, z: 10 },
  normal: { x: 0, y: 0, z: 1 },
  style: { kind: 'simple', diameter: 6 },
  depth: { kind: 'blind', distance: 5 },
}

describe('WO-3014 feature commands T1 schema refusals', () => {
  const bad: Array<[string, unknown, string]> = [
    ['model.revolve', {}, '$.sketchId'],
    ['model.revolve', { sketchId: 'SK1', colour: 'red' }, '$.colour'],
    ['model.revolve', { sketchId: 'SK1', angleDeg: '90' }, '$.angleDeg'],
    ['model.revolve', { sketchId: 7 }, '$.sketchId'],
    ['model.fillet', { edges: ['e1'], radius: 1 }, '$.ownerId'],
    ['model.fillet', { ownerId: 'F1', radius: 1 }, '$.edges'],
    ['model.fillet', { ownerId: 'F1', edges: ['e1'] }, '$.radius'],
    ['model.fillet', { ownerId: 'F1', edges: 'e1', radius: 1 }, '$.edges'],
    ['model.fillet', { ownerId: 'F1', edges: [3], radius: 1 }, '$.edges[0]'],
    ['model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1, propagateTangent: false }, '$.propagateTangent'],
    ['model.chamfer', { ownerId: 'F1', edges: ['e1'] }, '$.distance'],
    ['model.chamfer', { ownerId: 'F1', edges: ['e1'], distance: '1' }, '$.distance'],
    ['model.chamfer', { edges: ['e1'], distance: 1 }, '$.ownerId'],
    ['model.hole', { ...BASE_HOLE, faceId: undefined }, '$.faceId'],
    ['model.hole', { ...BASE_HOLE, seed: { x: 1, y: 2 } }, '$.seed.z'],
    ['model.hole', { ...BASE_HOLE, style: { kind: 'tapered', diameter: 6 } }, '$.style.kind'],
    ['model.hole', { ...BASE_HOLE, depth: { kind: 'upTo' } }, '$.depth.kind'],
    ['model.hole', { ...BASE_HOLE, placement: { kind: 'grid' } }, '$.placement.kind'],
    ['model.hole', { ...BASE_HOLE, placement: { kind: 'linear', count: 2.5 } }, '$.placement.count'],
    ['model.hole', { ...BASE_HOLE, extra: 1 }, '$.extra'],
  ]
  for (const [id, args, path] of bad) {
    it(`${id} ${JSON.stringify(args)}: refused at ${path}, nothing changed`, async () => {
      const s = openModel()
      await withBody(s)
      const before = fingerprint(s)
      expect(await run(id, args)).toMatchObject({ ok: false, code: 'invalid-arguments', path })
      expect(fingerprint(s)).toEqual(before)
    })
  }

  it('a non-object argument is refused for every command', async () => {
    const s = openModel()
    const before = fingerprint(s)
    for (const id of COMMANDS) expect(await run(id, 'F1')).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$' })
    expect(fingerprint(s)).toEqual(before)
  })

  it('with no Model page mounted: one plain sentence, nothing thrown', async () => {
    resetDocumentHolder()
    for (const id of COMMANDS) {
      const args = id === 'model.revolve' ? { sketchId: 'SK1' } : id === 'model.hole' ? BASE_HOLE : { ownerId: 'F1', edges: ['e1'], radius: 1, distance: 1 }
      const r = await run(id, id === 'model.fillet' ? { ownerId: 'F1', edges: ['e1'], radius: 1 } : id === 'model.chamfer' ? { ownerId: 'F1', edges: ['e1'], distance: 1 } : args)
      expect(r, id).toMatchObject({ ok: false, code: 'no-model-open' })
    }
  })
})

describe('WO-3014 feature commands T2 same path as the real dialog', () => {
  it('model.revolve equals RevolveDialog Apply: full turn, a part turn, and about an axis datum', async () => {
    const cases: Array<{ sketchId: string; angleDeg?: number; axisDatumId?: string }> = [
      { sketchId: 'SK1' },
      { sketchId: 'SK1', angleDeg: 90 },
      { sketchId: 'SK1', angleDeg: 270, axisDatumId: 'AX1' },
      { sketchId: 'SKF', axisDatumId: 'AX1' },
    ]
    for (const fields of cases) {
      const dialog = openModel('item-A')
      await revolveDialog(dialog, fields)
      const agent = openModel('item-B')
      const result = ok(await run('model.revolve', fields, { modelItemId: 'item-B' }))
      expect(result.value, JSON.stringify(fields)).toMatchObject({ featureId: 'F1', status: 'ok', diagnostics: [] })
      expect(serialized(agent), JSON.stringify(fields)).toBe(serialized(dialog))
      expect(statuses(agent)).toEqual(statuses(dialog))
      expect(agent.dag.getNode('F1')?.consumes).toEqual(dialog.dag.getNode('F1')?.consumes)
    }
  })

  it('model.fillet equals FilletDialog Apply, edges in the picker order', async () => {
    const dialog = openModel('item-A')
    await withBody(dialog, 'item-A')
    await filletDialog(dialog, { ownerId: 'F1', edges: ['edge#b', 'edge#a'], radius: 2.5 })
    const agent = openModel('item-B')
    await withBody(agent, 'item-B')
    const result = ok(await run('model.fillet', { ownerId: 'F1', edges: ['edge#b', 'edge#a'], radius: 2.5 }, { modelItemId: 'item-B' }))
    expect(result.value).toMatchObject({ featureId: 'F2', status: 'ok', diagnostics: [] })
    expect(serialized(agent)).toBe(serialized(dialog))
    expect(statuses(agent)).toEqual(statuses(dialog))
    expect(agent.dag.getNode('F2')?.consumes).toEqual(['F1'])
  })

  it('model.chamfer equals ChamferDialog Apply', async () => {
    const dialog = openModel('item-A')
    await withBody(dialog, 'item-A')
    await chamferDialog(dialog, { ownerId: 'F1', edges: ['edge#a'], distance: 1.25 })
    const agent = openModel('item-B')
    await withBody(agent, 'item-B')
    const result = ok(await run('model.chamfer', { ownerId: 'F1', edges: ['edge#a'], distance: 1.25 }, { modelItemId: 'item-B' }))
    expect(result.value).toMatchObject({ featureId: 'F2', status: 'ok', diagnostics: [] })
    expect(serialized(agent)).toBe(serialized(dialog))
    expect(statuses(agent)).toEqual(statuses(dialog))
  })

  const holeCases: Array<[string, HoleFields]> = [
    ['simple blind', BASE_HOLE],
    ['through all', { ...BASE_HOLE, depth: { kind: 'throughAll' } }],
    ['counterbore', { ...BASE_HOLE, style: { kind: 'counterbore', diameter: 5, cbDiameter: 9, cbDepth: 3 } }],
    ['countersink', { ...BASE_HOLE, style: { kind: 'countersink', diameter: 5, csDiameter: 10, csAngleDeg: 82 } }],
    ['linear pattern', { ...BASE_HOLE, placement: { kind: 'linear', count: 4, spacing: 8 } }],
    ['circular pattern on a tilted face', { ...BASE_HOLE, normal: { x: 0, y: 0.6, z: 0.8 }, placement: { kind: 'circular', count: 5, radius: 12, startAngleDeg: 15 } }],
  ]
  for (const [name, fields] of holeCases) {
    it(`model.hole ${name} equals HoleDialog Apply (points, style, depth, placement)`, async () => {
      const dialog = openModel('item-A')
      await withBody(dialog, 'item-A')
      await holeDialog(dialog, fields)
      const agent = openModel('item-B')
      await withBody(agent, 'item-B')
      const result = ok(await run('model.hole', fields, { modelItemId: 'item-B' }))
      expect(result.value).toMatchObject({ featureId: 'F2', status: 'ok', diagnostics: [] })
      expect(serialized(agent)).toBe(serialized(dialog))
      expect(statuses(agent)).toEqual(statuses(dialog))
    })
  }
})

describe('WO-3014 feature commands T2b a single hole needs no normal', () => {
  const dropNormal = (s: ModelSession, id: string): string => {
    const doc = JSON.parse(s.dag.serialize()) as { nodes: Array<{ id: string; payload: Record<string, unknown> }> }
    delete doc.nodes.find((n) => n.id === id)?.payload.normal
    return stableStringify(doc)
  }

  it('a single hole with the normal left out builds what the mounted HoleDialog route builds on the same face', async () => {
    const { normal: _omitted, ...fields } = BASE_HOLE
    const dialog = openModel('item-A')
    await withBody(dialog, 'item-A')
    await holeDialog(dialog, fields)
    const agent = openModel('item-B')
    await withBody(agent, 'item-B')
    const result = ok(await run('model.hole', fields, { modelItemId: 'item-B' }))
    expect(result.value).toMatchObject({ featureId: 'F2', status: 'ok', diagnostics: [] })
    // The dialog always stores the pick's normal; the agent had none to store, and nothing else differs.
    expect(agent.dag.getNode('F2')?.payload.normal).toBeUndefined()
    expect(dropNormal(agent, 'F2')).toBe(dropNormal(dialog, 'F2'))
    expect(statuses(agent)).toEqual(statuses(dialog))
    expect(agent.dag.getNode('F2')?.payload.points).toEqual([BASE_HOLE.seed])
  })

  it('a single hole with a zero normal equals the dialog route byte for byte', async () => {
    const fields = { ...BASE_HOLE, normal: { x: 0, y: 0, z: 0 } }
    const dialog = openModel('item-A')
    await withBody(dialog, 'item-A')
    await holeDialog(dialog, fields)
    const agent = openModel('item-B')
    await withBody(agent, 'item-B')
    ok(await run('model.hole', fields, { modelItemId: 'item-B' }))
    expect(serialized(agent)).toBe(serialized(dialog))
    expect(statuses(agent)).toEqual(statuses(dialog))
  })
})

describe('WO-3014 feature commands T3 determinism', () => {
  async function script(): Promise<{ results: string[]; archive: string }> {
    const s = openModel()
    const results: string[] = []
    results.push(JSON.stringify(await run('model.extrude', { sketchId: 'SK1', distance: 10 })))
    results.push(JSON.stringify(await run('model.fillet', { ownerId: 'F1', edges: ['e1', 'e2'], radius: 1.5 })))
    results.push(JSON.stringify(await run('model.chamfer', { ownerId: 'F2', edges: ['e3'], distance: 0.5 })))
    results.push(JSON.stringify(await run('model.hole', { ...BASE_HOLE, ownerId: 'F3', placement: { kind: 'circular', count: 4, radius: 6, startAngleDeg: 0 } })))
    results.push(JSON.stringify(await run('model.revolve', { sketchId: 'SK1', angleDeg: 180 })))
    results.push(JSON.stringify(await run('model.undo')))
    const archive = Buffer.from(createDocumentArchive({ dag: s.dag, elementMapDeltas: [] })).toString('base64')
    resetDocumentHolder()
    return { results, archive }
  }

  it('the same script on two fresh sessions gives byte-identical result JSON and archives', async () => {
    const first = await script()
    const second = await script()
    expect(second.results).toEqual(first.results)
    expect(second.archive).toBe(first.archive)
    expect(first.results.join('\n')).not.toMatch(/\b1[67]\d{11}\b/)
    expect(JSON.parse(first.results[3]).ok).toBe(true)
  })
})

describe('WO-3014 feature commands T4 one call, one step', () => {
  it('each call adds one "Agent: ..." step and one node; Undo removes it; a refused call adds none', async () => {
    const s = openModel()
    await withBody(s)
    const depth = s.history.size()
    const steps: Array<[string, unknown, string]> = [
      ['model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }, 'Agent: Fillet'],
      ['model.chamfer', { ownerId: 'F2', edges: ['e2'], distance: 1 }, 'Agent: Chamfer'],
      ['model.hole', { ...BASE_HOLE, ownerId: 'F3' }, 'Agent: Hole'],
      ['model.revolve', { sketchId: 'SK1' }, 'Agent: Revolve'],
    ]
    let n = depth
    for (const [id, args, label] of steps) {
      const r = ok(await run(id, args))
      n += 1
      expect(r.step, id).toBe(label)
      expect(s.history.size(), id).toBe(n)
      expect(s.history.lastAppliedCommand()?.label, id).toBe(label)
      expect(r.changed.created, id).toHaveLength(1)
      expect(r.changed.edited).toEqual([])
    }
    expect(s.dag.nodeIds().filter((x) => /^F\d+$/.test(x))).toEqual(['F1', 'F2', 'F3', 'F4', 'F5'])

    expect((await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 0 })).ok).toBe(false)
    expect(s.history.size()).toBe(n)

    for (const id of ['F5', 'F4', 'F3', 'F2']) {
      await s.undo()
      expect(s.dag.has(id), id).toBe(false)
    }
    expect(s.dag.has('F1')).toBe(true)
    expect(s.history.size()).toBe(depth)
  })

  it('the step labels are localised in all four locales, with the dialogs\' own feature names', async () => {
    const { default: de } = await import('../../i18n/locales/de/sketch-and-model-workbench')
    const { default: es } = await import('../../i18n/locales/es/sketch-and-model-workbench')
    const { default: fr } = await import('../../i18n/locales/fr/sketch-and-model-workbench')
    const { default: en } = await import('../../i18n/locales/en/sketch-and-model-workbench')
    for (const words of [en, de, es, fr] as Array<{ AgentCommands: Record<string, string> }>) {
      for (const key of ['revolve', 'fillet', 'chamfer', 'hole']) expect(words.AgentCommands[key], key).toMatch(/\S/)
    }
    const labels = [en, de, es, fr].map((w) => (w as unknown as { AgentCommands: Record<string, string> }).AgentCommands)
    for (const key of ['revolve', 'fillet', 'chamfer', 'hole']) expect(new Set(labels.map((l) => l[key])).size, `${key} differs per locale`).toBeGreaterThan(1)
    expect([en.AgentCommands.revolve, en.AgentCommands.fillet, en.AgentCommands.chamfer, en.AgentCommands.hole]).toEqual(['Agent: Revolve', 'Agent: Fillet', 'Agent: Chamfer', 'Agent: Hole'])
    const s = openModel()
    await withBody(s)
    ok(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }))
    expect(s.dag.getNode('F2')?.payload.name).toBe(workbenchText('FilletDialog.fillet2', { id: 'F2' }))
  })
})

describe('WO-3014 feature commands T5 the dialogs\' words', () => {
  it('revolve: a flat profile is refused in RevolveDialog\'s exact words; so are an empty sketch and a missing axis', async () => {
    const s = openModel()
    const before = fingerprint(s)
    const flat = await run('model.revolve', { sketchId: 'SKF' })
    const worldZ = workbenchText('RevolveDialog.revolveRefusedTheSelectedProfileLiesInAPlane', { axisWords: workbenchText('RevolveDialog.worldZ') })
    expect(flat).toMatchObject({ ok: false, code: 'refused', message: worldZ })
    // The dialog shows the same sentence as its blocked-reason line.
    render(createElement(RevolveDialog, { dag: s.dag, history: s.history, mode: 'create', sketchOptions: [{ id: 'SKF', label: 'Flat' }], onApplied: noop, onClose: noop }))
    expect(screen.getByTestId('revolve-apply-blocked-reason').textContent).toBe(worldZ)
    cleanup()
    expect(await run('model.revolve', { sketchId: 'SK2' })).toMatchObject({ ok: false, code: 'refused', message: workbenchText('regionSelector.thisSketchNoLongerHasAClosedProfile') })
    expect(await run('model.revolve', { sketchId: 'SK9' })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(await run('model.revolve', { sketchId: 'AX1' })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(await run('model.revolve', { sketchId: 'SK1', axisDatumId: 'nope' })).toMatchObject({ ok: false, code: 'missing-target', message: expect.stringContaining(workbenchText('SolidsWorkbenchPage.axisHasNoResolvedLine', { axisDatumId: 'nope' })) })
    expect(await run('model.revolve', { sketchId: 'SK1', axisDatumId: 'SK1' })).toMatchObject({ ok: false, code: 'missing-target' })
    for (const angleDeg of [0, -90, 361, 720]) {
      expect(await run('model.revolve', { sketchId: 'SK1', angleDeg }), String(angleDeg)).toMatchObject({ ok: false, code: 'refused' })
    }
    expect(fingerprint(s)).toEqual(before)
  })

  it('fillet and chamfer: no edge, a size at or below zero, and a body that is not live are refused; nothing changes', async () => {
    const s = openModel()
    await withBody(s)
    ok(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }))
    const before = fingerprint(s)
    const consumed = (id: string) => workbenchText(id === 'fillet' ? 'SolidsWorkbenchPage.filletOwnerHasNoLiveBodyMissingOrAlready' : 'SolidsWorkbenchPage.chamferOwnerHasNoLiveBodyMissingOrAlready', { ownerId: 'F1' })
    expect(await run('model.fillet', { ownerId: 'F2', edges: [], radius: 1 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.fillet', { ownerId: 'F2', edges: [''], radius: 1 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.fillet', { ownerId: 'F2', edges: ['e1'], radius: 0 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.fillet', { ownerId: 'F2', edges: ['e1'], radius: -2 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 })).toMatchObject({ ok: false, code: 'refused', message: consumed('fillet') })
    expect(await run('model.fillet', { ownerId: 'F9', edges: ['e1'], radius: 1 })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(await run('model.fillet', { ownerId: 'SK1', edges: ['e1'], radius: 1 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.chamfer', { ownerId: 'F2', edges: [], distance: 1 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 0 })).toMatchObject({ ok: false, code: 'refused' })
    expect(await run('model.chamfer', { ownerId: 'F1', edges: ['e1'], distance: 1 })).toMatchObject({ ok: false, code: 'refused', message: consumed('chamfer') })
    expect(await run('model.chamfer', { ownerId: 'F9', edges: ['e1'], distance: 1 })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(fingerprint(s)).toEqual(before)
  })

  it('hole: a style, depth or pattern HoleDialog refuses is refused with the sentence the dialog shows', async () => {
    const s = openModel()
    await withBody(s)
    const before = fingerprint(s)
    const cases: Array<[string, HoleFields, string]> = [
      ['zero diameter', { ...BASE_HOLE, style: { kind: 'simple', diameter: 0 } }, workbenchText('HoleDialog.holeDiameterMustBeGreaterThanZero')],
      ['counterbore diameter', { ...BASE_HOLE, style: { kind: 'counterbore', diameter: 5, cbDiameter: 0, cbDepth: 2 } }, workbenchText('HoleDialog.counterboreDiameterMustBeGreaterThanZero')],
      ['counterbore depth', { ...BASE_HOLE, style: { kind: 'counterbore', diameter: 5, cbDiameter: 9, cbDepth: -1 } }, workbenchText('HoleDialog.counterboreDepthMustBeGreaterThanZero')],
      ['countersink diameter', { ...BASE_HOLE, style: { kind: 'countersink', diameter: 5, csDiameter: 0, csAngleDeg: 90 } }, workbenchText('HoleDialog.countersinkDiameterMustBeGreaterThanZero')],
      ['countersink angle', { ...BASE_HOLE, style: { kind: 'countersink', diameter: 5, csDiameter: 9, csAngleDeg: 180 } }, workbenchText('HoleDialog.countersinkAngleMustBeBetween0And180Degrees')],
      ['blind depth', { ...BASE_HOLE, depth: { kind: 'blind', distance: 0 } }, workbenchText('HoleDialog.blindDepthMustBeGreaterThanZero')],
      ['pattern count', { ...BASE_HOLE, placement: { kind: 'linear', count: 1, spacing: 5 } }, workbenchText('HoleDialog.holePatternCountMustBeAtLeast2')],
      ['linear spacing', { ...BASE_HOLE, placement: { kind: 'linear', count: 3, spacing: 0 } }, workbenchText('HoleDialog.holePatternSpacingMustBeGreaterThanZero')],
      ['circular radius', { ...BASE_HOLE, placement: { kind: 'circular', count: 3, radius: -1, startAngleDeg: 0 } }, workbenchText('HoleDialog.holePatternRadiusMustBeGreaterThanZero')],
    ]
    for (const [name, fields, message] of cases) {
      expect(await run('model.hole', fields), name).toMatchObject({ ok: false, code: 'refused', message })
    }
    expect(await run('model.hole', { ...BASE_HOLE, depth: { kind: 'blind' } })).toMatchObject({ ok: false, code: 'refused', message: workbenchText('HoleDialog.blindDepthMustBeGreaterThanZero') })
    expect(await run('model.hole', { ...BASE_HOLE, faceId: '' })).toMatchObject({ ok: false, code: 'refused' })
    // A pattern is laid out in the face plane, so a missing or zero normal is refused for it (and only for it).
    for (const placement of [{ kind: 'linear', count: 3, spacing: 5 }, { kind: 'circular', count: 3, radius: 5, startAngleDeg: 0 }] as const) {
      const { normal: _omitted, ...withoutNormal } = BASE_HOLE
      expect(await run('model.hole', { ...withoutNormal, placement }), placement.kind).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('needs the face') })
      expect(await run('model.hole', { ...BASE_HOLE, normal: { x: 0, y: 0, z: 0 }, placement }), placement.kind).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('needs the face') })
    }
    expect(await run('model.hole', { ...BASE_HOLE, ownerId: 'F9' })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(fingerprint(s)).toEqual(before)

    // HoleDialog's NumericInput clamps every field to its minimum, so these states are not
    // reachable by typing; the sentences are the dialog's own locale keys, which the cases above
    // pin one by one.
  })
})

describe('WO-3014 feature commands T6 rule 11: do what the dialog does, say nothing extra', () => {
  it('a repeated edge is picked once, like the dialog\'s toggle; a hole pattern left bare takes the dialog\'s starting values', async () => {
    const s = openModel()
    await withBody(s)
    ok(await run('model.fillet', { ownerId: 'F1', edges: ['e1', 'e2', 'e1'], radius: 1 }))
    expect(s.dag.getNode('F2')?.payload.edges).toEqual(['e1', 'e2'])

    const dialog = openModel('item-A')
    await withBody(dialog, 'item-A')
    await holeDialog(dialog, { ...BASE_HOLE, placement: { kind: 'circular', count: 3, radius: 10, startAngleDeg: 0 } })
    const agent = openModel('item-B')
    await withBody(agent, 'item-B')
    ok(await run('model.hole', { ...BASE_HOLE, placement: { kind: 'circular' } }, { modelItemId: 'item-B' }))
    expect(serialized(agent)).toBe(serialized(dialog))
  })

  it('a counterbore or countersink left bare takes the dialog\'s starting values (9 / 2, 9 / 90)', async () => {
    const s = openModel()
    await withBody(s)
    ok(await run('model.hole', { ...BASE_HOLE, style: { kind: 'counterbore', diameter: 5 } }))
    expect(s.dag.getNode('F2')?.payload.style).toEqual({ kind: 'counterbore', diameter: 5, cbDiameter: 9, cbDepth: 2 })
    ok(await run('model.hole', { ...BASE_HOLE, ownerId: 'F2', style: { kind: 'countersink', diameter: 5 } }))
    expect(s.dag.getNode('F3')?.payload.style).toEqual({ kind: 'countersink', diameter: 5, csDiameter: 9, csAngleDeg: 90 })
  })

  it('style fields of another kind are left out of the node, as the dialog leaves them out', async () => {
    const s = openModel()
    await withBody(s)
    ok(await run('model.hole', { ...BASE_HOLE, style: { kind: 'simple', diameter: 4, cbDiameter: 9, csAngleDeg: 90 } }))
    expect(s.dag.getNode('F2')?.payload.style).toEqual({ kind: 'simple', diameter: 4 })
  })
})

describe('WO-3014 feature commands T7 shared Undo', () => {
  it('model.undo / model.redo and the screen Undo step each command on one history', async () => {
    const s = openModel()
    await withBody(s)
    const calls: Array<[string, unknown, string]> = [
      ['model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }, 'Agent: Fillet'],
      ['model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 1 }, 'Agent: Chamfer'],
      ['model.hole', { ...BASE_HOLE, ownerId: 'F3' }, 'Agent: Hole'],
      ['model.revolve', { sketchId: 'SK1' }, 'Agent: Revolve'],
    ]
    for (const [id, args] of calls) ok(await run(id, args))
    for (const [index, [, , label]] of [...calls].reverse().entries()) {
      const nodeId = `F${calls.length + 1 - index}`
      if (index % 2 === 0) {
        expect(ok(await run('model.undo')).value).toEqual({ undone: label })
      } else {
        await s.undo() // the Undo button's path
      }
      expect(s.dag.has(nodeId), nodeId).toBe(false)
    }
    expect(ok(await run('model.redo')).value).toEqual({ redone: 'Agent: Fillet' })
  })
})

describe('WO-3014 feature commands T8 replay and revision', () => {
  it('a repeated requestId returns the first result and adds nothing; a stale expectRevision refuses', async () => {
    const s = openModel()
    await withBody(s)
    const first = ok(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }, { requestId: 'r1' }))
    const depth = s.history.size()
    expect(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }, { requestId: 'r1' })).toBe(first)
    expect(s.history.size()).toBe(depth)
    for (const [id, args] of [
      ['model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 1 }],
      ['model.hole', { ...BASE_HOLE, ownerId: 'F2' }],
      ['model.revolve', { sketchId: 'SK1' }],
      ['model.fillet', { ownerId: 'F2', edges: ['e1'], radius: 1 }],
    ] as Array<[string, unknown]>) {
      const stale = await run(id, args, { expectRevision: s.revision() - 1 })
      expect(stale, id).toMatchObject({ ok: false, code: 'stale-revision' })
      expect(s.history.size()).toBe(depth)
    }
    const current = ok(await run('model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 1 }, { expectRevision: s.revision() }))
    expect(current.revision).toBe(s.revision())
  })
})

describe('WO-3014 feature commands T9 boundary', () => {
  it('all four are in the frozen allow-list and tools list, describe a closed schema, and results are frozen copies', async () => {
    expect(Object.isFrozen(MODEL_COMMAND_ALLOW_LIST)).toBe(true)
    for (const id of COMMANDS) {
      expect(MODEL_COMMAND_ALLOW_LIST).toContain(id)
      expect(modelCommands.list().find((c) => c.id === id)?.effect).toBe('edit')
      const described = modelCommands.describe(id)
      expect(described?.input).toMatchObject({ type: 'object', additionalProperties: false })
      expect(schemaKeywordsOutsideSubset(described?.input), id).toEqual([])
      expect(schemaKeywordsOutsideSubset(described?.output), id).toEqual([])
    }
    expect(modelCommands.describe('model.revolve')?.input).toMatchObject({ required: ['sketchId'] })
    expect(modelCommands.describe('model.fillet')?.input).toMatchObject({ required: ['ownerId', 'edges', 'radius'] })
    expect(modelCommands.describe('model.chamfer')?.input).toMatchObject({ required: ['ownerId', 'edges', 'distance'] })
    expect(modelCommands.describe('model.hole')?.input).toMatchObject({ required: ['ownerId', 'faceId', 'seed', 'style', 'depth'] })
    const s = openModel()
    await withBody(s)
    const r = ok(await run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }))
    expect(Object.isFrozen(r)).toBe(true)
    expect(() => { (r.value as { featureId: string }).featureId = 'X' }).toThrow()
    expect(s.dag.has('F2')).toBe(true)
  })
})

describe('WO-3014 feature commands output schema', () => {
  it('a success and a failed-rebuild result with diagnostics both satisfy each command\'s declared output schema', async () => {
    const good = openModel()
    await withBody(good)
    const calls: Array<[string, unknown]> = [
      ['model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 }],
      ['model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 1 }],
      ['model.hole', { ...BASE_HOLE, ownerId: 'F3' }],
      ['model.revolve', { sketchId: 'SK1' }],
    ]
    for (const [id, args] of calls) {
      const result = ok(await run(id, args))
      expect(firstSchemaProblem(modelCommands.describe(id)?.output as JsonSchema, result.value), id).toBeUndefined()
      expect(result.value.diagnostics, id).toEqual([])
    }
    resetDocumentHolder()
    // A kernel that builds the extrude and refuses every later feature: a result, not a refusal.
    const failing = openModel(LEGACY_MODEL_ITEM_ID, async (node) => (node.id === 'F1'
      ? { ok: true, diagnostics: [] }
      : { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'dress-up', reason: 'edge not found' } }] }) as never)
    await withBody(failing)
    const bad = ok(await run('model.fillet', { ownerId: 'F1', edges: ['stale-edge'], radius: 1 }))
    expect(bad.value.status).toBe('failed')
    expect(bad.value.diagnostics).toEqual([{ code: 'KERNEL_OP_FAILED', message: 'KERNEL_OP_FAILED: op=dress-up, reason=edge not found' }])
    expect(firstSchemaProblem(modelCommands.describe('model.fillet')?.output as JsonSchema, bad.value)).toBeUndefined()
    ok(await run('model.undo'))
    expect(failing.dag.has('F2')).toBe(false)
  })
})
