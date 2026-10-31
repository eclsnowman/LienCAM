// WO-3234: model.extrude carries Thin the way the Extrude dialog does.
//
// The reference is the dialog's own create-mode Apply payload for Thin
// (ExtrudeDialog handleApply: wallMode 'thin', wallThickness, wallSide) and the
// one shared builder (buildExtrudeRequest) the page, the headless replay and
// this command all call. The session's kernel op is a stub; the DAG, history
// and scheduler are real.

import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession, type ModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { stableStringify } from '../../doc/persist'
import { textFor } from '../../i18n'
import { modelCommands } from '../../lib/agent/commands'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import type { ProfileRegion } from '../../geom/geom-service'

const workbenchText = textFor('sketch-and-model-workbench')
const thinText = textFor('thin-extrude.wo3234')
const REGION = { sketchId: 'SK1', loops: [] } as unknown as ProfileRegion

function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID): ModelSession {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [REGION] } })
  const s = createModelSession({ modelItemId, dag, map: new ElementMap(), kernelOp: async () => ({ ok: true, diagnostics: [] }) })
  registerModelSession(s)
  return s
}

afterEach(() => resetDocumentHolder())

const extrude = (args: unknown): Promise<ModelCommandResult> => modelCommands.run('model.extrude', args, {})

function ok(result: ModelCommandResult): ModelCommandSuccess<any> {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

const snapshot = (s: ModelSession) => ({ dag: stableStringify(JSON.parse(s.dag.serialize())), depth: s.history.size() })

function requestOf(s: ModelSession, id: string) {
  const payload = s.dag.getNode(id)!.payload
  return buildExtrudeRequest({
    featureId: id,
    payload: payload as ExtrudeParamsInput,
    profiles: [REGION],
    distance: payload.distance as number,
    lookupTarget: () => undefined,
    modelItemId: s.modelItemId,
  })
}

describe('WO-3234 model.extrude Thin', () => {
  it('writes the dialog\'s thin payload key for key and builds the kernel thin request', async () => {
    const s = openModel()
    const result = ok(await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'thin', wallThickness: 2, wallSide: 'outside' }))
    expect(result.value).toMatchObject({ featureId: 'F1', status: 'ok' })
    expect(s.dag.getNode('F1')!.payload).toEqual({
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 8,
      direction: 'up',
      endCondition: 'blind',
      boolMode: 'newBody',
      wallMode: 'thin',
      wallThickness: 2,
      wallSide: 'outside',
      name: workbenchText('ExtrudeDialog.extrude2', { id: 'F1' }),
    })
    expect(s.history.size()).toBe(1)
    const build = requestOf(s, 'F1')
    expect(build.ok && build.req.thin).toEqual({ thickness: 2, side: 'outside' })
    expect(build.ok && build.req.end).toEqual({ kind: 'blind', distance: 8 })
  })

  it('defaults the side to Inside and runs Symmetric for midplane', async () => {
    const s = openModel()
    ok(await extrude({ sketchId: 'SK1', distance: 10, direction: 'midplane', wallMode: 'thin', wallThickness: 1.5 }))
    const payload = s.dag.getNode('F1')!.payload
    expect(payload).toMatchObject({ endCondition: 'symmetric', wallMode: 'thin', wallThickness: 1.5, wallSide: 'inside' })
    const build = requestOf(s, 'F1')
    expect(build.ok && build.req.thin).toEqual({ thickness: 1.5, side: 'inside' })
    expect(build.ok && build.req.end).toEqual({ kind: 'symmetric', distance: 10 })
  })

  it('keeps the ordinary solid payload unchanged and never reads a stray thickness', async () => {
    const plain = openModel('item-A')
    ok(await modelCommands.run('model.extrude', { sketchId: 'SK1', distance: 8 }, { modelItemId: 'item-A' }))
    const stray = openModel('item-B')
    ok(await modelCommands.run('model.extrude', { sketchId: 'SK1', distance: 8, wallMode: 'solid', wallThickness: -3, wallSide: 'center' }, { modelItemId: 'item-B' }))
    expect(stray.dag.getNode('F1')!.payload).toEqual(plain.dag.getNode('F1')!.payload)
    expect(stray.dag.getNode('F1')!.payload.wallThickness).toBeUndefined()
    const build = requestOf(stray, 'F1')
    expect(build.ok && build.req.thin).toBeUndefined()
  })

  it('refuses a missing, zero or negative thickness with the builder\'s words and changes nothing', async () => {
    const s = openModel()
    const before = snapshot(s)
    for (const wallThickness of [undefined, 0, -1]) {
      const result = await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'thin', ...(wallThickness === undefined ? {} : { wallThickness }) })
      expect(result).toMatchObject({
        ok: false,
        code: 'refused',
        message: thinText('thicknessMustBePositive', { thickness: String(wallThickness) }),
      })
      expect(snapshot(s)).toEqual(before)
    }
  })

  it('refuses an unknown wall mode or side at the schema, with nothing changed', async () => {
    const s = openModel()
    const before = snapshot(s)
    expect(await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'shell' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.wallMode' })
    expect(await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'thin', wallThickness: 1, wallSide: 'sideways' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.wallSide' })
    // WO-3324: 'left' became a schema-valid open-chain side in WO-3237, so on this closed sketch it is refused downstream, not at the schema.
    expect(await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'thin', wallThickness: 1, wallSide: 'left' })).toMatchObject({ ok: false, code: 'refused' })
    expect(await extrude({ sketchId: 'SK1', distance: 8, wallMode: 'thin', wallThickness: '1' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.wallThickness' })
    expect(snapshot(s)).toEqual(before)
  })
})
