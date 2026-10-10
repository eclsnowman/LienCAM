// WO-2332: after a project is reopened, Post Process checks the model
// references itself instead of telling the operator to open each Model Item
// first.
//
// The state a reopen leaves (loadProjectFromFile): the project's ops keep their
// saved 'ready' status and toolpaths, the Model document is held by the
// documentHolder, no Model workbench is mounted, and modelRefsVerifiedSinceLoad
// is false. Post Process (PostProcessModal: on open, and again before every
// export) calls the store's verifyModelReferences, then posts with the fresh
// evidence. This suite drives that same sequence against a REAL kernel
// (createLocalGeomService) replaying a real STEP-import document - no window,
// no workbench hooks, so nothing but the headless check can verify anything.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { Operation, Project, Setup, Stock } from '../../types'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))

const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { buildImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const { __setModelBodyHeadlessClientFactoryForTests } = await import('../../lib/cam/modelBodyHoleRecognition')
const { useCamStore } = await import('../../store')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')

const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step')
const CACHE_KEY = 'wo2332-cache-key'
const POST_OPTS = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

function fixtureBytes(): ArrayBuffer {
  const source = readFileSync(STEP_FIXTURE)
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
}

/** A real face stable id of the imported body 'IMP1', named by the kernel
 *  itself (the same importStep the replay runs, the same resolve()). */
async function realFaceId(): Promise<string> {
  const client = createLocalGeomService()
  try {
    await client.init()
    const imported = await client.importStep(fixtureBytes(), 'IMP1')
    const body = imported.bodies[0]
    const resolved = await client.resolve(body.handle, body.elementMap.generated)
    const face = resolved.find((r) => r.status === 'exact' && r.type === 'face')
    if (face === undefined) throw new Error('fixture has no face')
    return face.id
  } finally {
    await client.terminate().catch(() => undefined)
  }
}

function boundOp(stableIds: string[], bodyId = 'IMP1'): Operation {
  return makeOp({
    id: 'op-face',
    name: 'Face Pocket',
    toolId: 't1',
    modelReferences: [{ bodyId, stableIds, role: 'machining-boundary' }],
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

function reopenedProject(op: Operation): { project: Project; setup: Setup } {
  const setup: Setup = {
    id: 's1',
    name: 'Front',
    wcs: makeWcs({ id: 'wcs-s1', label: 'G54', fixtureOffset: 54 }),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
    operations: [op],
    notes: '',
  }
  const project = {
    ...useCamStore.getState().project,
    id: 'wo2332-project',
    name: 'Reopened',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [],
    setups: [setup],
    activeSetupId: 's1',
    activeOperationId: null,
  } as Project
  stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return { project, setup }
}

/** What a reopen leaves: saved project, held document, nothing verified. */
function leaveReopenedState(project: Project): void {
  stepBytes.set(CACHE_KEY, fixtureBytes())
  stashLoadedDocument(buildImportedStepModelArchive({
    fileName: 'fix_single_hole_block.step', cacheKey: CACHE_KEY, name: 'Assembly',
  }))
  useCamStore.setState({
    project,
    toolLibrary: project.toolLibrary,
    activeModelItemId: null,
    modelRefsVerifiedSinceLoad: false,
    consoleEvents: [],
  })
}

/** Post Process's sequence: check the references, then post from fresh state. */
async function postProcess(): Promise<ReturnType<typeof postProject>> {
  await useCamStore.getState().verifyModelReferences?.()
  const s = useCamStore.getState()
  return postProject({ ...s.project, toolLibrary: s.toolLibrary }, s.project.setups, UCCNC_CONFIG, {
    ...POST_OPTS,
    modelRefsVerifiedSinceLoad: s.modelRefsVerifiedSinceLoad,
  })
}

function consoleText(): string {
  return useCamStore.getState().consoleEvents.map((e) => e.message).join('\n')
}

describe('WO-2332: Post Process after a reopen checks the model references itself', () => {
  beforeEach(() => {
    resetDocumentHolder()
    stepBytes.clear()
    __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  })

  afterEach(() => {
    __setModelBodyHeadlessClientFactoryForTests(null)
    resetDocumentHolder()
    stepBytes.clear()
  })

  it('a reference that resolves posts straight away, byte-identical to the pre-save post', async () => {
    expect(typeof window).toBe('undefined') // no Model tab, no workbench hooks
    const faceId = await realFaceId()
    const { project, setup } = reopenedProject(boundOp([faceId]))

    // Before the save: the session had verified the reference.
    const before = postProject(project, [setup], UCCNC_CONFIG, { ...POST_OPTS, modelRefsVerifiedSinceLoad: true })
    expect(before.ok).toBe(true)

    leaveReopenedState(project)
    const after = await postProcess()

    expect(after.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(after.ok).toBe(true)
    expect(after.combined?.gcode).toBe(before.combined?.gcode)
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toBe(true)
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')
    expect(useCamStore.getState().modelRefCheckInFlight).toBe(false)
    expect(consoleText()).toMatch(/Checked 1 model reference on the project model: all resolve\./)
  }, 60_000)

  it('opening the dialog and pressing Export at once run ONE check, not two', async () => {
    const faceId = await realFaceId()
    const { project } = reopenedProject(boundOp([faceId]))
    leaveReopenedState(project)

    const first = useCamStore.getState().verifyModelReferences()
    expect(useCamStore.getState().modelRefCheckInFlight).toBe(true)
    const second = useCamStore.getState().verifyModelReferences()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(useCamStore.getState().consoleEvents.filter((e) => e.message.startsWith('Checked '))).toHaveLength(1)
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toBe(true)
  }, 60_000)

  it('a face that no longer exists stops that operation, named with the face', async () => {
    const goneFace = 'IMP1:face:deleted-in-a-later-edit'
    const { project } = reopenedProject(boundOp([goneFace]))
    leaveReopenedState(project)

    const res = await postProcess()

    expect(res.ok).toBe(false)
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ code: 'OP_DEGRADED', opId: 'op-face' }))
    expect(res.diagnostics.some((d) => d.code === 'OP_MODEL_REFS_UNVERIFIED')).toBe(false)
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('degraded')
    expect(consoleText()).toContain(`Operation "Face Pocket": the machining boundary geometry it was picked on (${goneFace}`)
    expect(consoleText()).toMatch(/re-pick it in the operation/)
  }, 60_000)

  it('a body that no longer exists in the model stops that operation the same way', async () => {
    const { project } = reopenedProject(boundOp(['GONE:face:1'], 'GONE'))
    leaveReopenedState(project)

    const res = await postProcess()

    expect(res.ok).toBe(false)
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ code: 'OP_DEGRADED', opId: 'op-face' }))
    expect(consoleText()).toContain('(GONE:face:1 on body "GONE") no longer exists')
  }, 60_000)

  it('a model that cannot be rebuilt here is never marked verified - the post still refuses, and the console says why', async () => {
    const faceId = await realFaceId()
    const { project } = reopenedProject(boundOp([faceId]))
    leaveReopenedState(project)
    stepBytes.clear() // the import's STEP bytes are gone: the replay cannot rebuild IMP1

    const res = await postProcess()

    expect(res.ok).toBe(false)
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ code: 'OP_MODEL_REFS_UNVERIFIED', opId: 'op-face' }))
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toBe(false)
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')
    expect(consoleText()).toMatch(/Could not check the model references on the project model in the background: .*missing from IndexedDB/)
  }, 60_000)
})
