import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc'
import {
  bodyFeatureIds,
  resolveBodyTargetLineage,
} from '../../components/model3d/bodyLineage'
import { buildExtrudeRequest } from '../../components/model3d/workbench/extrudeParams'
import type { BodyHandle, ProfileRegion } from '../../geom/geom-service'

const MODEL_ITEM = 'MODEL-1'
const ROOT_HANDLE = 41 as BodyHandle
const MERGED_HANDLE = 42 as BodyHandle
const PROFILE: ProfileRegion = {
  sketchId: 'SK-END',
  plane: {
    origin: { x: 0, y: 0, z: 0 },
    xDir: { x: 1, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  },
  loops: [[
    { kind: 'line', a: [0, 0], b: [4, 0], srcId: 'SK-END.e0' },
    { kind: 'line', a: [4, 0], b: [4, 4], srcId: 'SK-END.e1' },
    { kind: 'line', a: [4, 4], b: [0, 4], srcId: 'SK-END.e2' },
    { kind: 'line', a: [0, 4], b: [0, 0], srcId: 'SK-END.e3' },
  ]],
}

const SUBSHAPE_CASES = [
  ['face', 'toFace', 'ROOT:BOX:+Z'],
  ['vertex', 'toVertex', '(ROOT:BOX:+X<AND>ROOT:BOX:+Y<AND>ROOT:BOX:+Z)'],
] as const

function mergeDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK-ROOT', kind: 'sketch', payload: {} })
  dag.insertNode({ id: 'SK-TOOL', kind: 'sketch', payload: {} })
  dag.insertNode({ id: 'ROOT', kind: 'feature', consumes: ['SK-ROOT'], payload: { opType: 'extrude' } })
  dag.insertNode({ id: 'TOOL', kind: 'feature', consumes: ['SK-TOOL'], payload: { opType: 'extrude' } })
  dag.insertNode({
    id: 'MERGED',
    kind: 'feature',
    consumes: ['ROOT', 'TOOL'],
    payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'ROOT', toolFeatureId: 'TOOL' },
  })
  return dag
}

describe('WO-254 persisted face and vertex targets across a body merge', () => {
  it.each(SUBSHAPE_CASES)(
    'keeps an unchanged %s target on its original live body',
    (kind, endCondition, stableId) => {
      const dag = mergeDag()
      const census = bodyFeatureIds(dag)
      const lookedUp: string[] = []
      const build = buildExtrudeRequest({
        featureId: 'END',
        payload: {
          direction: 'up',
          boolMode: 'newBody',
          endCondition,
          endTarget: { modelItemId: MODEL_ITEM, bodyFeatureId: 'ROOT', subshape: { kind, stableId } },
        },
        profiles: [PROFILE],
        distance: 1,
        modelItemId: MODEL_ITEM,
        lookupTarget: (id) => {
          lookedUp.push(id)
          return id === 'ROOT' ? ROOT_HANDLE : undefined
        },
        resolveBodyTarget: (id) => resolveBodyTargetLineage(dag, census, ['ROOT'], id),
      })

      expect(build.ok).toBe(true)
      expect(lookedUp).toEqual(['ROOT'])
      if (!build.ok) return
      expect(build.req.end).toEqual({
        kind: endCondition,
        direction: 1,
        target: {
          identity: { modelItemId: MODEL_ITEM, bodyFeatureId: 'ROOT', subshape: { kind, stableId } },
          body: ROOT_HANDLE,
        },
        offset: 0,
      })
    },
  )

  it.each(SUBSHAPE_CASES)(
    'refuses a remapped %s target by subshape and body name before live-body lookup',
    (kind, endCondition, stableId) => {
      const dag = mergeDag()
      const census = bodyFeatureIds(dag)
      const lookedUp: string[] = []
      const build = buildExtrudeRequest({
        featureId: 'END',
        payload: {
          direction: 'up',
          boolMode: 'newBody',
          endCondition,
          endTarget: { modelItemId: MODEL_ITEM, bodyFeatureId: 'ROOT', subshape: { kind, stableId } },
        },
        profiles: [PROFILE],
        distance: 1,
        modelItemId: MODEL_ITEM,
        lookupTarget: (id) => {
          lookedUp.push(id)
          return id === 'MERGED' ? MERGED_HANDLE : undefined
        },
        resolveBodyTarget: (id) => resolveBodyTargetLineage(dag, census, ['MERGED'], id),
      })

      expect(build).toEqual({
        ok: false,
        reason: `extrude end target ${kind} '${stableId}' on body 'ROOT' is lost after body remap to 'MERGED'`,
      })
      expect(lookedUp).toEqual([])
    },
  )
})
