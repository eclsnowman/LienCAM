// The recorded M8 plate, through the same planner and journal replay as Model.
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildStlModelBodyModel, type StlModelBodyModel, type StlModelFeature } from '../../components/model3d/workbench/stlModelBody'
import { planStlFeatureEdits } from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { createMeshEditRecord } from '../../mesh/edit'
import { weldMesh } from '../../mesh/recognition/topology'
import type { Vec3 } from '../../mesh/types'

const bytes = readFileSync(new URL('../evidence/WO-2935/attempt3/Plate-NEMA17.stl', import.meta.url))
const identity = { geoId: 'wo3113', name: 'Plate-NEMA17.stl', bytes }
function face(body: StlModelBodyModel, axis = 2): StlModelFeature {
 const found = body.features.filter(f => f.target.family === 'flat' && f.target.face.plane.normal[axis] > .999)
 .sort((a,b) => (b.target.family === 'flat' ? b.target.face.plane.point[axis] : 0) - (a.target.family === 'flat' ? a.target.face.plane.point[axis] : 0))[0]
 if (!found) throw new Error('The recorded plate has no outward top face')
 return found
}
function corners(body: Pick<StlModelBodyModel,'mesh'|'sourceFacetIds'>, ids: readonly number[]): Vec3[] {
 const wanted = new Set(ids)
 return Array.from(body.sourceFacetIds).flatMap((id,f) => wanted.has(id) ? [0,1,2].map(c => {
  const at = body.mesh.indices[f*3+c]*3
  return Array.from(body.mesh.positions.slice(at,at+3)) as Vec3
 }) : [])
}
function plan(body: StlModelBodyModel, top: StlModelFeature, distanceMm: number) {
 const result = planStlFeatureEdits(body,[{tool:'push-pull',feature:top,distanceMm}])
 if (!result.ok) throw new Error(result.reason)
 return result
}
function displacement(before: StlModelBodyModel, after: Pick<StlModelBodyModel,'mesh'|'sourceFacetIds'>, top: StlModelFeature, mm: number, axis = 2) {
 const original = corners(before,top.sourceFacetIds), moved = corners(after,top.sourceFacetIds)
 expect(moved).toHaveLength(original.length)
 moved.forEach((p,i) => p.forEach((v,a) => expect(v-original[i][a]).toBeCloseTo(a === axis ? mm : 0,5)))
}
function solid(body: Pick<StlModelBodyModel,'mesh'>) {
 const w=weldMesh(body.mesh)
 const mesh={positions:Float32Array.from(w.positions),indices:Uint32Array.from(w.facets)}
 const health=analyzeMesh(mesh,{checkSelfIntersections:true})
 expect(health.watertight).toBe(true)
 expect(health.nonManifoldEdgeCount).toBe(0)
 expect(health.windingConflictEdgeCount).toBe(0)
 expect(health.selfIntersections).toBe(false)
 expect(measureMesh(mesh).signedVolume).toBeGreaterThan(0)
}

describe('WO-3113: the typed plate Push/Pull distance', () => {
 let body: StlModelBodyModel, top: StlModelFeature
 let pulled: ReturnType<typeof plan> | undefined
 const pull = () => pulled ??= plan(body,top,3)
 // Let Vitest receive its reporting RPC replies between synchronous mesh plans.
 afterEach(() => new Promise<void>(resolve => setTimeout(resolve,20)))
 // Initial recognition also precedes a long plan: drain its reporting before
 // the first test, just as the rotated case does between its two phases.
 beforeAll(async () => {
  body=buildStlModelBodyModel({...identity,meshEdits:[]}); top=face(body)
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setTimeout(resolve,20))
 },120000)
 it('moves the real NEMA17 plate top by the typed +3 mm', () => {
  const moved=pull()
  displacement(body,moved,top,3)
  expect(moved.edits[0].note).toBeUndefined()
  expect(moved.edits[0].edit.parameters).toEqual({distanceMm:3})
  solid(moved)
  // Bottom and counterbore shoulder remain fixed; every original top XY and
  // every hole radius survive. Vertical outer corner chamfers stretch, rather
  // than dragging the bottom face upward as a rigid carried blend.
  body.sourceFacetIds.forEach((id,f) => {
   const old = corners(body,[id])
   if (old.every(p=>p[2]===0) || old.every(p=>Math.abs(p[2]-1.8)<1e-6)) {
    expect(corners(moved,[id])).toEqual(old)
   }
   if (id !== f) throw new Error('unexpected recorded fixture ancestry')
  })
 },120000)
 it.each([0.5,-0.5])('applies a valid %s mm edit without changing the opposite face', mm => {
  const moved=plan(body,top,mm)
  displacement(body,moved,top,mm)
  expect(moved.edits[0].note).toBeUndefined()
  solid(moved)
 },120000)
 it.each([-4,-2.2])('retains the genuine inward limit for a %s mm request', requested => {
  // Overshoots and the nominal drawing dimension must leave the actual
  // Float32 mesh closed, not round its top onto the counterbore shoulder.
  const moved=plan(body,top,requested)
  displacement(body,moved,top,-2.19)
  expect(moved.edits[0].note).toContain('at 2.20 mm')
  expect(moved.edits[0].edit.parameters).toEqual({distanceMm:requested,reachedMm:-2.19})
  solid(moved)
 },120000)
 it('commits and replays the requested millimetres with stable body/source identity', () => {
  const moved=pull()
  const record=createMeshEditRecord(body.mesh,{...moved.edits[0].edit,sourceFacetIds:body.sourceFacetIds})
  const committed=buildStlModelBodyModel({...identity,meshEdits:[record]})
  expect(committed.geoId).toBe(body.geoId)
  expect(committed.sourceFacetIds).toEqual(body.sourceFacetIds)
  displacement(body,committed,top,3)
 },120000)
 it('uses millimetres along a translated, rotated plate normal', async () => {
  // Same recorded STL, rotated (x,y,z)->(z,x,y), then translated. No
  // axis-specific Z shortcut and no display-unit scale may enter the edit.
  const transformed=Buffer.from(bytes)
  for(let f=0;f<transformed.readUInt32LE(80);f++) for(let c=0;c<3;c++) {
   const at=84+f*50+12+c*12
   const [x,y,z]=[0,4,8].map(a=>transformed.readFloatLE(at+a))
   transformed.writeFloatLE(z+100,at); transformed.writeFloatLE(x-50,at+4); transformed.writeFloatLE(y+25,at+8)
  }
  const rotated=buildStlModelBodyModel({...identity,bytes:transformed,meshEdits:[]}), selected=face(rotated,0)
  // Service reporting between recognition and the independent offset plan.
  // Immediate turns alone can outrun the IPC reply; reuse the afterEach pause.
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setTimeout(resolve,20))
  const moved=plan(rotated,selected,3)
  displacement(rotated,moved,selected,3,0)
  solid(moved)
 },120000)
})
