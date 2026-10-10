// WO-2177 (workholding assemblies, slice 3): the keep-out CAM is given and the
// setups a workholding edit outdates.
//
// Shapes are plain boxes served through the resolver's reader seam; every
// expected place is worked out by hand in the comment beside it.

import { describe, expect, it } from 'vitest'
import {
  outdateOperationsForWorkholdingScopes, resolveWorkholdingObstacles, withWorkholdingModel, workholdingChangeScopes,
} from '../../store/fixtureObstacles'
import type { LocalMesh, WorkholdingShapeReader } from '../../lib/workholding/shapes'
import type { ImportedGeometry, Setup, Vec3, WorkholdingDefinition, WorkholdingInstance, WorkholdingModel } from '../../types'

const ZERO = { x: 0, y: 0, z: 0 }

function boxLocal(min: Vec3, max: Vec3): LocalMesh {
  const positions: number[] = []
  for (const z of [min.z, max.z]) for (const y of [min.y, max.y]) for (const x of [min.x, max.x]) positions.push(x, y, z)
  return { positions, indices: [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5] }
}

function xRange(positions: ArrayLike<number>): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < positions.length; i += 3) { lo = Math.min(lo, positions[i]); hi = Math.max(hi, positions[i]) }
  return [lo, hi]
}

function row(id: string): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -4, y: -20, z: 0 }, max: { x: 4, y: 20, z: 20 }, size: { x: 8, y: 40, z: 20 }, center: { x: 0, y: 0, z: 10 } },
    position: { x: 999, y: 0, z: 0 }, rotation: ZERO, loaded: true, workholding: true,
  } as ImportedGeometry
}

const BOX = boxLocal({ x: -4, y: -20, z: 0 }, { x: 4, y: 20, z: 20 })
const reader: WorkholdingShapeReader = { stl: async () => BOX, step: async () => null }

// Instance at X -40 (the fixed body), jaw local X 38, slide +X:
// opening 20 -> jaw centre X -40 + 38 + 20 = 18; opening 50 -> X 48. Boxes are 8 wide.
const VISE: WorkholdingDefinition = {
  id: 'def-vise', revision: 1, name: 'Vise', kind: 'vise',
  components: [
    { id: 'fixed', name: 'Fixed', geometryId: 'vise-fixed', localPose: { position: ZERO, rotation: ZERO } },
    {
      id: 'moving', name: 'Jaw', geometryId: 'vise-jaw', localPose: { position: { x: 38, y: 0, z: 0 }, rotation: ZERO },
      joint: { kind: 'linear', axis: { x: 1, y: 0, z: 0 }, minMm: 0, maxMm: 100, closedAtMm: 0 },
    },
  ],
}

function vise(opening: number, setupIds = ['setup-a']): WorkholdingInstance {
  return {
    id: 'vise-1', definitionId: 'def-vise', definitionRevision: 1, setupScope: { kind: 'setups', setupIds },
    worldPose: { position: { x: -40, y: 0, z: 0 }, rotation: ZERO }, jointValuesMm: { moving: opening },
  }
}

const model = (instances: WorkholdingInstance[]): WorkholdingModel => ({ definitions: [VISE], instances })
const geometry = [row('vise-fixed'), row('vise-jaw'), row('loose-clamp')]

describe('WO-2177: the keep-out follows the vise opening, in its setups only', () => {
  it('opening 20 puts the jaw at X 14..22, opening 50 at X 44..52; the fixed body stays at X -44..-36', async () => {
    for (const [opening, jaw] of [[20, [14, 22]], [50, [44, 52]]] as const) {
      const { meshes, notices } = await resolveWorkholdingObstacles(
        geometry, [], [], reader, { workholding: model([vise(opening)]), setupId: 'setup-a' },
      )
      expect(notices).toEqual([])
      // Instances first (fixed, jaw), then the loose marked clamp at its own row pose (X 995..1003).
      expect(meshes.map((m) => xRange(m.positions))).toEqual([[-44, -36], jaw, [995, 1003]])
    }
  })

  it('another setup sees neither the vise nor its bodies at their rows; a loose marked body stays in every setup', async () => {
    const { meshes } = await resolveWorkholdingObstacles(
      geometry, [], [], reader, { workholding: model([vise(20)]), setupId: 'setup-b' },
    )
    expect(meshes.map((m) => xRange(m.positions))).toEqual([[995, 1003]])
  })

  it('an operation that machines the jaw (soft jaw) does not keep clear of the jaw; it still keeps clear of the fixed body (WO-1572)', async () => {
    const { meshes } = await resolveWorkholdingObstacles(
      geometry, [], ['vise-jaw'], reader, { workholding: model([vise(20)]), setupId: 'setup-a' },
    )
    expect(meshes.map((m) => xRange(m.positions))).toEqual([[-44, -36], [995, 1003]])
  })
})

describe('WO-2177: a workholding edit outdates the setups it touches, and no others', () => {
  const setups = (): Setup[] => ['setup-a', 'setup-b'].map((id) => ({
    id, operations: [{ id: `op-${id}`, status: 'ready', toolpathMoves: [] }, { id: `pending-${id}`, status: 'pending' }],
  })) as unknown as Setup[]
  const statuses = (list: Setup[]) => list.map((s) => s.operations.map((o) => o.status))

  it('a new opening touches only the vise\'s setup', () => {
    const scopes = workholdingChangeScopes(model([vise(20)]), model([vise(50)]))
    expect(scopes).toEqual([{ kind: 'setups', setupIds: ['setup-a'] }, { kind: 'setups', setupIds: ['setup-a'] }])
    expect(statuses(outdateOperationsForWorkholdingScopes(setups(), scopes))).toEqual([['outdated', 'pending'], ['ready', 'pending']])
  })

  it('moving the vise to another setup touches both', () => {
    const scopes = workholdingChangeScopes(model([vise(20)]), model([vise(20, ['setup-b'])]))
    expect(statuses(outdateOperationsForWorkholdingScopes(setups(), scopes))).toEqual([['outdated', 'pending'], ['outdated', 'pending']])
  })

  it('making or removing a vise touches every setup (its bodies were obstacles everywhere)', () => {
    expect(workholdingChangeScopes(undefined, model([vise(20)]))).toEqual([{ kind: 'all' }])
    expect(workholdingChangeScopes(model([vise(20)]), { definitions: [], instances: [] })).toEqual([{ kind: 'all' }])
  })

  it('an unchanged model touches nothing and returns the same setups', () => {
    const list = setups()
    expect(workholdingChangeScopes(model([vise(20)]), model([vise(20)]))).toEqual([])
    const project = { setups: list, workholding: model([vise(20)]) }
    expect(withWorkholdingModel(project, model([vise(20)])).setups).toBe(list)
  })

  it('withWorkholdingModel writes the model and outdates the touched setup', () => {
    const project = { setups: setups(), workholding: model([vise(20)]) }
    const next = withWorkholdingModel(project, model([vise(50)]))
    expect(next.workholding?.instances[0].jointValuesMm.moving).toBe(50)
    expect(statuses(next.setups)).toEqual([['outdated', 'pending'], ['ready', 'pending']])
  })
})
