// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'
import { cacheReferenceImage, loadCachedReferenceImage, referenceImageStateStorage } from '../../lib/referenceImageCache'
import { typedMock } from '../support/typedMock'
import { useCamStore, persistPartialize, persistMerge } from '../../store'
import type { ReferenceImage2d } from '../../referenceImage/referenceImage'

const saved = vi.hoisted(() => ({ text: '' }))
vi.mock('../../lib/saveFile', () => typedMock<typeof import('../../lib/saveFile')>({ saveFile: vi.fn(async (_filename, text) => { saved.text = String(text); return 'download' }) }))
const image: ReferenceImage2d = { id: 'reference-image:2d:test', payload: {
  datumType: 'reference-image', name: 'Ruler.png', planeNodeId: 'cam:xy',
  image: { dataUrl: 'data:image/png;base64,AQID', fileName: 'Ruler.png', widthPx: 400, heightPx: 200 },
  widthMm: 100, heightMm: 50, opacity: 0.5, center: { x: 20, y: 30 }, angleDeg: 30,
  flipHorizontal: true, flipVertical: true, scaleLocked: true,
} }
let idb: FakeIndexedDBHandle
const originalOptions = useCamStore.persist.getOptions()
beforeEach(() => { idb = installFakeIndexedDB(); useCamStore.getState().newProject(); saved.text = ''; vi.spyOn(useCamStore.getState(), 'solveSketch').mockImplementation(() => {}) })
afterEach(() => { useCamStore.persist.setOptions(originalOptions); idb.restore(); vi.restoreAllMocks() })
describe('WO-2305 project-owned 2D reference image', () => {
  it('recovers cached original bytes and pose through the real refresh hydration door', async () => {
    useCamStore.getState().insertReferenceImage2d(image)
    const projectId = useCamStore.getState().project.id
    const raw = JSON.stringify({ state: persistPartialize(useCamStore.getState()), version: originalOptions.version })
    await vi.waitFor(async () => expect(await loadCachedReferenceImage(projectId, image.id)).toBe(image.payload.image.dataUrl))
    useCamStore.getState().newProject()
    useCamStore.persist.setOptions({ storage: createJSONStorage(() => referenceImageStateStorage({
      getItem: () => raw, setItem: () => {}, removeItem: () => {},
    })) })
    await useCamStore.persist.rehydrate()
    expect(useCamStore.getState().project.id).toBe(projectId)
    expect(useCamStore.getState().project.referenceImages2d).toEqual([image])
    await useCamStore.getState().saveProjectToFile()
    expect(JSON.parse(saved.text).referenceImages2d).toEqual([image])
  })
  it('scopes cache reads by project and image and retains metadata on a cache miss', async () => {
    await cacheReferenceImage('other-project', image.id, 'other-bytes')
    expect(await loadCachedReferenceImage('this-project', image.id)).toBeNull()
    expect(await loadCachedReferenceImage('other-project', 'other-image')).toBeNull()
    useCamStore.getState().insertReferenceImage2d(image)
    const partial = persistPartialize(useCamStore.getState())
    partial.project.id = 'missing-project'
    const raw = JSON.stringify({ state: partial, version: originalOptions.version })
    const restored = await referenceImageStateStorage({ getItem: () => raw, setItem: () => {}, removeItem: () => {} }).getItem('project')
    expect(JSON.parse(restored!).state.project.referenceImages2d[0]).toEqual({
      ...image, payload: { ...image.payload, image: { ...image.payload.image, dataUrl: '' } },
    })
  })
  it('keeps a 6 MB original image out of the localStorage blob without changing live or file bytes', async () => {
    const large = { ...image, payload: { ...image.payload, image: { ...image.payload.image, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(6 * 1024 * 1024) } } }
    useCamStore.getState().insertReferenceImage2d(large)
    const blob = JSON.stringify(persistPartialize(useCamStore.getState()))
    expect(blob.length).toBeLessThan(100000)
    expect(blob).not.toContain(large.payload.image.dataUrl)
    expect(useCamStore.getState().project.referenceImages2d).toEqual([large])
    await useCamStore.getState().saveProjectToFile()
    expect(JSON.parse(saved.text).referenceImages2d).toEqual([large])
    useCamStore.getState().newProject()
    await useCamStore.getState().loadProjectFromFile(saved.text)
    expect(useCamStore.getState().project.referenceImages2d).toEqual([large])
  })
  it('undoes and redoes insertion, hidden state and pose independently of geometry', () => {
    const state = () => useCamStore.getState()
    state().insertReferenceImage2d(image)
    state().updateReferenceImage2d(image.id, { hidden: true })
    state().undo(); expect(state().project.referenceImages2d?.[0].hidden).toBeUndefined()
    state().redo(); expect(state().project.referenceImages2d?.[0].hidden).toBe(true)
    state().undo(); state().undo(); expect(state().project.referenceImages2d ?? []).toEqual([])
    state().redo(); expect(state().project.referenceImages2d).toEqual([image])
    expect(state().project.geometry).toEqual([])
  })
  it('retains independent picture edits when Cancel discards the sketch, with undo/redo intact', () => {
    const state = () => useCamStore.getState()
    state().setViewerMode('sketch')
    state().insertReferenceImage2d(image)
    state().updateReferenceImage2d(image.id, { hidden: true })
    state().cancelActiveSketch()
    expect(state().project.referenceImages2d?.[0].hidden).toBe(true)
    state().undo(); expect(state().project.referenceImages2d?.[0].hidden).toBeUndefined()
    state().undo(); expect(state().project.referenceImages2d ?? []).toEqual([])
    state().redo(); state().redo(); expect(state().project.referenceImages2d?.[0].hidden).toBe(true)
    expect(state().project.geometry).toEqual([])
  })
  it.each(['finish', 'tab exit'] as const)('survives an image-only %s and saves/reopens the original bytes and pose', async (route) => {
    const state = () => useCamStore.getState()
    state().setViewerMode('sketch')
    state().insertReferenceImage2d(image)
    if (route === 'finish') state().finishSketch()
    else state().setViewerMode('setup')
    expect(state().project.referenceImages2d).toEqual([image])
    await state().saveProjectToFile()
    expect(JSON.parse(saved.text).referenceImages2d).toEqual([image])
    const partial = persistPartialize(state())
    expect(persistMerge(partial, state()).project.referenceImages2d).toEqual([image])
    state().newProject(); expect(state().project.referenceImages2d).toBeUndefined()
    await state().loadProjectFromFile(saved.text)
    expect(state().project.referenceImages2d).toEqual([image])
  })
})
