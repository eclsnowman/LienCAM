// WO-2404 - a body with a relief comes out of tessellation closed.
//
// Found by WO-2379 (release kit part 07, the relief medallion): a 60 mm disc
// imported as STEP, a 24 mm picture relief applied to its top face through the
// app's own Relief palette, then Adaptive Rough (3D) refused the body as "not a
// closed, watertight solid ... 366 open edges". The app-saved project is
// src/tests/evidence/WO-2404/relief-only.camproject.
//
// The cause: the workbench paints the blank (coarse, then display tessellation)
// before the relief is applied, which leaves a triangulation on every face. The
// relief sews the untouched faces back in with new edges; they kept their old
// triangulation, so per-face meshing reused it and the disc's wall no longer met
// its top and bottom. A relief applied to a never-painted blank was closed, which
// is why the engine-only relief tests never saw it.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine, type ReliefEditRequest } from '../../geom/worker/geom-engine'
import type { BodyHandle, TessBuffers } from '../../geom/geom-service'
import { isReliefFeaturePayload, pictureOf, reliefKernelFields, type ReliefFeaturePayload } from '../../relief/reliefFeature'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import { COARSE_TESS_QUALITY, DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const PROJECT = path.resolve(__dirname, '../evidence/WO-2404/relief-only.camproject')

let engine: GeomEngine
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
}, 120_000)
afterAll(async () => { await engine.disposeKernel() })

function closed(t: TessBuffers): { boundaryEdges: number; oversharedEdges: number } {
  const c = sanitizeTriangleMesh(Float32Array.from(t.position), Uint32Array.from(t.index))
  return { boundaryEdges: c.boundaryEdges, oversharedEdges: c.oversharedEdges }
}

interface SavedRelief { blank: ArrayBuffer; payload: ReliefFeaturePayload; faceKey: string }

async function savedRelief(): Promise<SavedRelief> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const project = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
  const doc = JSON.parse(strFromU8(unzipSync(Buffer.from(project.document, 'base64'))['document.json']))
  const imp = doc.dag.nodes.find((n: { kind: string }) => n.kind === 'import')
  const rel = doc.dag.nodes.find((n: { payload?: { opType?: string } }) => n.payload?.opType === 'relief')
  const step = Buffer.from(project.binaries[imp.payload.cacheKey].step, 'base64')
  if (!isReliefFeaturePayload(rel.payload)) throw new Error('no relief payload')
  return { blank: step.buffer.slice(step.byteOffset, step.byteOffset + step.byteLength), payload: rel.payload, faceKey: rel.refs[0].id }
}

/** The workbench order: import, paint (coarse then display), apply the relief, paint again. */
async function paintedRelief(sizeMm?: number) {
  const { blank, payload, faceKey } = await savedRelief()
  const settings = sizeMm === undefined ? payload.settings : { ...payload.settings, widthMm: sizeMm, heightMm: sizeMm }
  const imported = await engine.importStep(blank, 'IMP1')
  const body: BodyHandle = imported.bodies[0].handle
  await engine.tessellate(body, COARSE_TESS_QUALITY)
  await engine.tessellate(body, DISPLAY_TESS_QUALITY)
  const fields = reliefKernelFields(await pictureOf(payload.image), { ...payload, settings })
  const req: ReliefEditRequest = {
    featureId: 'REL1', body, featureKey: faceKey, delta: 0, kind: 'relief',
    relief: {
      ...fields.frame, n: fields.poles.n, heights: fields.poles.heights,
      ...(fields.detail !== undefined ? { detail: { cols: fields.detail.cols, rows: fields.detail.rows, heights: fields.detail.heights } } : {}),
    },
  }
  const r = await engine.editFeature(req)
  expect(r.ok).toBe(true)
  await engine.tessellate(r.body!, COARSE_TESS_QUALITY)
  return { r, mesh: fields.detail !== undefined, t: await engine.tessellate(r.body!, DISPLAY_TESS_QUALITY) }
}

describe('WO-2404 a body with a relief comes out closed', () => {
  it('the saved relief medallion (24 mm exact relief on a painted 60 mm disc) tessellates with 0 open edges, the disc keeping its face ids', async () => {
    const { r, mesh, t } = await paintedRelief()
    const c = closed(t)
    console.log(`WO-2404 exact relief 24 mm: ${t.index.length / 3} triangles, ${c.boundaryEdges} open edges, ${c.oversharedEdges} overshared; faces ${t.faceIds.join(' ')}`)
    expect(mesh).toBe(false)
    expect(c).toEqual({ boundaryEdges: 0, oversharedEdges: 0 })
    // the disc's wall and bottom are the import's faces still - only the top is modified, the relief generated
    expect(r.elementMap).toMatchObject({ deleted: [], generated: ['REL1:EDIT:new#0'], modified: { 'IMP1:step:face#1': ['IMP1:step:face#1'] } })
    expect([...t.faceIds].sort()).toEqual(['IMP1:step:face#0', 'IMP1:step:face#1', 'IMP1:step:face#2', 'REL1:EDIT:new#0'])
  }, 300_000)

  it('the same picture as a 42 mm mesh relief on the painted disc tessellates with 0 open edges', async () => {
    const { mesh, t } = await paintedRelief(42)
    const c = closed(t)
    console.log(`WO-2404 mesh relief 42 mm: ${t.index.length / 3} triangles, ${c.boundaryEdges} open edges, ${c.oversharedEdges} overshared`)
    expect(mesh).toBe(true)
    expect(c).toEqual({ boundaryEdges: 0, oversharedEdges: 0 })
  }, 300_000)
})
