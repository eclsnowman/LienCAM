// WO-3035 (alpha.3 A3-23, step 2): G-81 characterisation on engine `current`.
// A Face with boundary source 'rest' (stock minus the earlier pockets, WO-1820)
// after a pocket that was never generated; then the pocket's loops are edited.
// Does the Face become outdated? This test PINS today's verdict as a value; it
// is not a fix and passes on today's code whatever the verdict is.
//
// Production route, as faceKernelPilot.wo2944: the store's
// computeOperationToolpath through the real toolpathWorker, edits through the
// store's own actions (updateOperation = the pocket dialog's loop pick,
// updateGeometryTransform = moving the pocket's part).
// WO3035_EVIDENCE=1 writes src/tests/evidence/WO-3035/face-rest-ungenerated-pocket.json.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { buildFaceSmartHeightIntent, buildPlanarRoughSmartHeightIntent } from '../../lib/cam/smartHeights'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ImportedGeometry, Project } from '../../types'

const donor = JSON.parse(readFileSync('src/tests/evidence/WO-2694/journey-1009-scratch.camproject', 'utf8')) as Project
let active: RealWorker | undefined
let requests: WorkerRequestMsg[] = []
const evidence: Record<string, unknown> = {}
const workerSelf: {
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  postMessage: (data: WorkerResponseMsg) => void
} = { onmessage: null, postMessage: data => { active?.onmessage?.({ data }) } }
class RealWorker {
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((error: ErrorEvent) => void) | null = null
  postMessage(request: WorkerRequestMsg) {
    active = this
    requests.push(structuredClone(request))
    void workerSelf.onmessage!({ data: structuredClone(request) })
  }
  terminate() {}
}
beforeAll(async () => {
  vi.stubGlobal('self', workerSelf)
  vi.stubGlobal('Worker', RealWorker)
  vi.stubEnv('LIENCAM_ENGINE', 'current')
  await import('../../lib/cam/toolpathWorker')
})
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (process.env.WO3035_EVIDENCE !== '1') return
  mkdirSync('src/tests/evidence/WO-3035', { recursive: true })
  writeFileSync('src/tests/evidence/WO-3035/face-rest-ungenerated-pocket.json', JSON.stringify({
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    command: 'WO3035_EVIDENCE=1 npx vitest run src/tests/kernel/freshnessFaceRestUngeneratedPocket.wo3035.test.ts',
    entry: 'computeOperationToolpath -> real toolpathWorker -> store edit actions',
    engine: 'current',
    gap: 'G-81 (GAP-040 b)',
    cases: evidence,
  }, null, 2) + '\n')
})

const POCKET_ID = 'rest-prior'

// The WO-2944 rest fixture (donor stock, 40 x 30 pocket loop, Face floor below
// the pocket's), plus a second, smaller loop the pocket's edit can pick.
function install() {
  requests = []
  const project = structuredClone(donor)
  const setup = project.setups[0]
  const face = setup.operations.find(candidate => candidate.type === 'face')!
  setup.operations = [face]
  project.modelItems = []; project.modelItemPlacements = []; project.modelItemDocuments = undefined
  const stock = project.stocks![0]
  stock.mode = 'explicit'
  project.sceneStock = { ...project.sceneStock, mode: 'fixed', autoStocks: [], fixedStocks: [{
    id: stock.id, name: stock.name, width: stock.bounds.size.x, height: stock.bounds.size.y,
    depth: stock.bounds.size.z, position: { ...stock.bounds.min },
  }] }
  face.toolpathMoves = undefined; face.generationFingerprint = undefined
  project.stocks![0].position = { ...project.stocks![0].bounds.min }
  const rect = (x: number, y: number) => [{ x: -x, y: -y }, { x, y: -y }, { x, y }, { x: -x, y }]
  project.geometry = [{
    id: 'rest-pocket', name: 'Rest pocket', filename: 'rest.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, stockId: project.stocks![0].id,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: -20, y: -15, z: 0 }, max: { x: 20, y: 15, z: 0 },
      size: { x: 40, y: 30, z: 0 }, center: { x: 0, y: 0, z: 0 } },
    loops: [
      { id: 'pocket-loop', layerId: 'outline', closed: true, type: 'contour', points: rect(20, 15) },
      { id: 'small-loop', layerId: 'outline', closed: true, type: 'contour', points: rect(10, 8) },
    ],
    layers2d: [{ id: 'outline', name: 'Outline', color: '#fff', visible: true }],
  }] as ImportedGeometry[]
  const pocket = structuredClone(donor.setups[0].operations.find(op => op.type === 'pocket_2d')!)
  pocket.id = 'rest-prior'; pocket.enabled = true; pocket.status = 'pending'
  pocket.toolpathMoves = undefined; pocket.generationFingerprint = undefined
  pocket.resolvedHeights = undefined; pocket.resolvedHeightPlan = undefined
  pocket.params = { ...pocket.params, geometryId: 'rest-pocket', loopIds: ['pocket-loop'],
    fillStrategy: 'outside_in', stepoverLeadIn: 'none', finishContour: false }
  pocket.linking = { ...pocket.linking, entryType: 'plunge' }
  pocket.smartHeight = { kind: 'smart_v2', intent: buildPlanarRoughSmartHeightIntent({
    setupId: setup.id, operationType: 'pocket_2d', geometryIds: ['rest-pocket'],
    safetyIntent: face.heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: -6,
  }) }
  face.params = { ...face.params, boundarySource: 'rest' }
  face.smartHeight = { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({
    setupId: setup.id, stockId: project.stocks![0].id, safetyIntent: face.heights.heightIntent!,
    mode: 'explicit_depth', explicitTargetWcsMm: -5,
  }) }
  setup.operations.unshift(pocket)
  useCamStore.setState({ project, toolLibrary: structuredClone(project.toolLibrary), toolpathBatch: null })
}

function setup() { return useCamStore.getState().project.setups[0] }
function liveProject() { return { ...useCamStore.getState().project, toolLibrary: useCamStore.getState().toolLibrary } }
function face() { return setup().operations[1] }
function pocket() { return setup().operations[0] }
function faceVerdict() {
  const project = liveProject()
  return { faceStatus: face().status, faceCurrent: operationGenerationIsCurrent(project, project.setups[0], face()) }
}

/** Compute the Face over the never-generated pocket and record what happened. */
async function computeFaceOverUngeneratedPocket() {
  const before = { status: pocket().status, moves: pocket().toolpathMoves?.length ?? 0 }
  expect(before).toEqual({ status: 'pending', moves: 0 })
  await useCamStore.getState().computeOperationToolpath(setup().id, face().id)
  const faceRequest = requests.filter(request => request.type === 'COMPUTE_FACE').at(-1)
  return {
    pocketBefore: before,
    pocketAfter: { status: pocket().status, generated: (pocket().toolpathMoves?.length ?? 0) > 0 },
    faceRegionHoles: faceRequest?.type === 'COMPUTE_FACE' ? faceRequest.payload.regionHoles?.length : undefined,
    face: { ...faceVerdict(), errorMessage: face().errorMessage },
  }
}

describe('WO-3035 G-81: Face rest after a never-generated pocket, pocket loops edited (current engine, characterisation)', () => {
  it('edit the pocket\'s loop pick - pins today\'s verdict', async () => {
    install()
    const computed = await computeFaceOverUngeneratedPocket()
    useCamStore.getState().updateOperation(setup().id, POCKET_ID, {
      params: { ...pocket().params, loopIds: ['small-loop'] },
    })
    const observed = { ...computed, afterPocketLoopEdit: faceVerdict() }
    evidence.pocketLoopPick = observed
    // TODAY'S VERDICT (2026-10-21, engine current): NO hole. A rest Face reads
    // the material its earlier operations removed, so computing it generates
    // the never-generated pocket first (readyFaceSmartRuntime); the pocket's
    // footprint is subtracted, and editing the pocket's loops outdates the Face
    // through its predecessor fingerprint.
    expect(observed).toEqual({
      pocketBefore: { status: 'pending', moves: 0 },
      pocketAfter: { status: 'ready', generated: true },
      faceRegionHoles: 1,
      face: { faceStatus: 'ready', faceCurrent: true, errorMessage: undefined },
      afterPocketLoopEdit: { faceStatus: 'outdated', faceCurrent: false },
    })
  }, 120_000)

  it('move the pocket\'s part (its loops move) - pins today\'s verdict', async () => {
    install()
    const computed = await computeFaceOverUngeneratedPocket()
    useCamStore.getState().updateGeometryTransform('rest-pocket', { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    const observed = { ...computed, afterPocketGeometryMove: faceVerdict() }
    evidence.pocketGeometryMove = observed
    // TODAY'S VERDICT: NO hole. The move does not flip the Face's status, but
    // its saved fingerprint (every part's cut shape and placement) stops
    // matching, which is the check Post and Run make before they recompute it.
    expect(observed).toEqual({
      pocketBefore: { status: 'pending', moves: 0 },
      pocketAfter: { status: 'ready', generated: true },
      faceRegionHoles: 1,
      face: { faceStatus: 'ready', faceCurrent: true, errorMessage: undefined },
      afterPocketGeometryMove: { faceStatus: 'ready', faceCurrent: false },
    })
  }, 120_000)

  it('a pocket that cannot generate - the Face is never ready over it, so it cannot go stale', async () => {
    install()
    useCamStore.getState().updateOperation(setup().id, POCKET_ID, { toolId: 'no-such-tool' })
    const computed = await computeFaceOverUngeneratedPocket()
    evidence.ungeneratablePocket = computed
    expect(computed.pocketAfter).toEqual({ status: 'error', generated: false })
    expect(computed.face.faceStatus).toBe('error')
    expect(computed.face.faceCurrent).toBe(false)
    expect(computed.face.errorMessage).toContain('\'Pocket\' failed')
    expect(face().toolpathMoves).toBeUndefined()
  }, 120_000)
})
