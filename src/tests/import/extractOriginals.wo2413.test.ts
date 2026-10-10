// @vitest-environment jsdom
// Real import/store/UI/saveFile paths. Only IDB storage and the STEP worker
// boundary are substituted; saved files are independently read below.
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js'
import helvetiker from 'three/examples/fonts/helvetiker_regular.typeface.json'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'
import { installSvgPathGeometry } from './svgPathGeometryPolyfill'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'

const caches = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>(), step: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { caches.stl.set(id, bytes.slice(0)) },
  loadCachedSTL: async (id) => caches.stl.get(id) ?? null,
  removeCachedSTL: async (id) => { caches.stl.delete(id) },
}))
vi.mock('../../lib/stepCache', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/stepCache')>()
  return typedMock<typeof actual>({ ...actual,
    cacheStep: async (id, bytes) => { caches.step.set(id, bytes.slice(0)) },
    loadCachedStep: async (id) => caches.step.get(id) ?? null,
    removeCachedStep: async (id) => { caches.step.delete(id) },
  })
})
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: async () => {},
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof actual>({ ...actual, readStep: async () => ({
    faceCount: 1, edgeCount: 0, solidCount: 1, bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    mesh: { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), faceRanges: new Uint32Array([0, 3]) },
    edges: { positions: new Float32Array(), edgeRanges: new Uint32Array() }, faceTypes: new Uint8Array([0]),
  } satisfies BrepModelPayload) })
})
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: async () => ({ partCount: 1 }),
}))
vi.mock('../../geom', async (importActual) => {
  const actual = await importActual<typeof import('../../geom')>()
  // The real IGES importer/kernel runs locally instead of in a browser worker.
  return typedMock<typeof actual>({ ...actual, createGeomService: actual.createLocalGeomService })
})

import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { ExportModal } from '../../components/modals/ExportModal'
import { DesignTree } from '../../components/panels/DesignTree'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { saveGeometryOriginal, saveOriginalFile } from '../../lib/import/originalFile'
import { fontOriginalFile } from '../../lib/sketch/fontImport'
import { collectProjectBinaries, hydrateCachesFromBinaries } from '../../lib/projectBinaries'
import { ReferenceImage2dInsert, referenceImage2dUi } from '../../components/panels/sketch/ReferenceImage2d'

const saved: Array<{ name: string; bytes: Buffer }> = []
const nativeReader = globalThis.FileReader
const nativeFile = globalThis.File
beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('ArrayBuffer', Buffer.alloc(0).buffer.constructor)
  // Production fallback uses the exact file bytes in environments without FileReader.
  vi.stubGlobal('FileReader', undefined)
  vi.stubGlobal('liencamHost', { saveFile: async (name: string, bytes: Uint8Array) => {
    saved.push({ name, bytes: Buffer.from(bytes) }); return name
  } })
  saved.length = 0
  caches.stl.clear(); caches.step.clear()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  useCamStore.getState().newProject()
  useCamStore.setState({ activeModal: null })
  useUiPrefs.setState({ treeGeometryExpanded: true, collapsedPartIds: [], collapsedFolderIds: [] })
  installSvgPathGeometry(window)
  Object.assign(window, { __cncViewport: {
    addSTL: async (bytes: ArrayBuffer) => {
      const mesh = new STLLoader().parse(bytes)
      mesh.computeBoundingBox()
      const bounds = mesh.boundingBox!
      return { min: bounds.min, max: bounds.max }
    }, add2DGeometry: () => {},
  } })
})
afterEach(() => { cleanup(); referenceImage2dUi.setState({ host: null, id: null }); vi.unstubAllGlobals() })

const dxf = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nCIRCLE\r\n8\r\nOutline\r\n10\r\n5\r\n20\r\n5\r\n40\r\n2\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n'
const svg = '\ufeff<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"><!-- original spelling -->\r\n<path d="M0 0 L10 0 L10 10 Z" fill="none" stroke="red"/></svg>'
const stl = readFileSync('src/tests/mesh/fixtures/prismatic-plate.stl')
const step = readFileSync('src/tests/model3d/fixtures/wo1455/closed-box-30x20x10.step')
const igesSolid = readFileSync('src/tests/evidence/WO-1824/fixtures/box-with-hole.solid.igs')
const igesSurfaces = readFileSync('src/tests/evidence/WO-1824/fixtures/box-with-hole.surfaces.igs')

// WO-2449 moved original-file saves from individual tree/panel buttons into
// the shared Export window. Keep the independent byte and format readbacks.
function saveFromExport(row: string) {
  cleanup()
  render(createElement(ExportModal))
  act(() => useCamStore.getState().openModal('export'))
  fireEvent.click(screen.getByTestId(`export-save-original:${row}`))
}

describe('WO-2413 exact original extraction', () => {
  for (const [name, source] of [['Plate.STL', stl], ['Box.stp', step], ['Drawing.dxf', Buffer.from(dxf)], ['Drawing.svg', Buffer.from(svg)], ['Solid.IGS', igesSolid], ['Surfaces.iges', igesSurfaces]] as const) {
    it(`imports and saves ${name} through Export, including cold project/cache restore`, async () => {
      await importGeometryFile(new File([new Uint8Array(source)], name), useCamStore.getState())
      const imported = useCamStore.getState().project.geometry.at(-1)!
      expect(imported).toBeDefined()
      expect(imported.loaded).toBe(true)
      if (/\.(igs|iges)$/i.test(name)) {
        // The display cache is STEP, so it cannot be the IGES original.
        expect(Buffer.from(caches.step.get(imported.id)!).toString('utf8')).toMatch(/^ISO-10303-21/)
      }
      const binaries = await collectProjectBinaries(useCamStore.getState().project.geometry)
      const project = JSON.parse(JSON.stringify({ ...useCamStore.getState().project, binaries }))
      caches.stl.clear(); caches.step.clear()
      if (project.binaries) await hydrateCachesFromBinaries(project.binaries)
      // Renaming/editing the parsed object must leave the picked name/bytes intact.
      project.geometry[0].name = 'Renamed after import'
      useCamStore.getState().setProject(project)
      saveFromExport(`geo:${imported.id}`)
      await waitFor(() => expect(saved).toHaveLength(1))
      expect(saved[0].name).toBe(name)
      expect(saved[0].bytes.equals(source)).toBe(true)
      // Independent readers: no use of the source-encoding helper for assertions.
      if (name.endsWith('STL')) expect(new STLLoader().parse(new Uint8Array(saved[0].bytes).buffer).getAttribute('position').count).toBeGreaterThan(0)
      if (name.endsWith('stp')) {
        const { createLocalGeomService } = await import('../../geom')
        const reader = createLocalGeomService()
        try {
          await reader.init()
          const parsed = await reader.importStep(new Uint8Array(saved[0].bytes).buffer, 'saved-original')
          expect(parsed.bodies).toHaveLength(1)
        } finally { reader.terminate() }
      }
      if (/\.(igs|iges)$/i.test(name)) {
        const { createLocalGeomService } = await import('../../geom')
        const reader = createLocalGeomService()
        try {
          await reader.init()
          const parsed = await reader.importIges(new Uint8Array(saved[0].bytes).buffer, 'saved-iges-original')
          expect(parsed.bodies.length).toBeGreaterThan(0)
          expect(parsed.content.faces).toBeGreaterThan(0)
          expect(parsed.content.solids).toBe(name === 'Solid.IGS' ? 1 : 0)
        } finally { await reader.terminate() }
      }
      if (name.endsWith('dxf')) expect(saved[0].bytes.toString('utf8').split(/\r?\n/)).toContain('CIRCLE')
      if (name.endsWith('svg')) expect(new DOMParser().parseFromString(saved[0].bytes.toString('utf8'), 'image/svg+xml').querySelector('path')?.getAttribute('d')).toBe('M0 0 L10 0 L10 10 Z')
      if (imported.originalFile && imported.layers2d?.length) {
        saveFromExport(`geo:${imported.id}`)
        await waitFor(() => expect(saved).toHaveLength(2))
        expect(saved[1].bytes.equals(source)).toBe(true)
      }
    })
  }

  it('preserves the font file in the project through the real font-store import and Export save', async () => {
    const source = Buffer.from('\ufeff' + JSON.stringify(helvetiker, null, 2) + '\r\n')
    await useCamStore.getState().importSketchFont(new File([source], 'Original.typeface.json'))
    const project = JSON.parse(JSON.stringify(useCamStore.getState().project))
    const [id, asset] = Object.entries(project.fonts!)[0] as [string, { family: string; typeface: unknown }]
    expect(fontOriginalFile(asset)?.fileName).toBe('Original.typeface.json')
    useCamStore.getState().setProject(project)
    saveFromExport(`font:${id}`)
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('Original.typeface.json')
    expect(saved[0].bytes.equals(source)).toBe(true)
    const parsed = JSON.parse(saved[0].bytes.toString('utf8').replace(/^\ufeff/, ''))
    expect(new FontLoader().parse(parsed).generateShapes('A', 10).length).toBeGreaterThan(0)
  })

  it('saves an imported TTF as original binary font bytes, rather than converted typeface JSON', async () => {
    const source = readFileSync('node_modules/three/examples/fonts/ttf/kenpixel.ttf')
    await useCamStore.getState().importSketchFont(new File([source], 'Kenpixel.TTF'))
    const project = JSON.parse(JSON.stringify(useCamStore.getState().project))
    const id = Object.keys(project.fonts)[0]
    expect(id).toBeDefined()
    useCamStore.getState().setProject(project)
    saveFromExport(`font:${id}`)
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('Kenpixel.TTF')
    expect(saved[0].bytes.equals(source)).toBe(true)
    const typeface = new TTFLoader().parse(new Uint8Array(saved[0].bytes).buffer)
    expect(new FontLoader().parse(typeface).generateShapes('A', 10).length).toBeGreaterThan(0)
  })

  it('imports a PNG through the 2D picker, then saves exact bytes after reopening Export', async () => {
    const source = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64')
    vi.stubGlobal('Image', class {
      naturalWidth = 1; naturalHeight = 1; onload?: () => void
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    useCamStore.setState({ viewer: { ...useCamStore.getState().viewer, mode: 'sketch' } })
    referenceImage2dUi.setState({ host: { canvas: document.createElement('canvas'), runtime: {
      camera: new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000),
      addObject: () => {}, removeObject: () => {}, requestRender: () => {}, projectToCanvas: () => ({ x: 0, y: 0 }),
    } } })
    const onInserted = vi.fn()
    render(createElement(ReferenceImage2dInsert, { onInserted }))
    fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [new File([source], 'Photo.PNG', { type: 'image/png' })] } })
    await waitFor(() => expect(onInserted).toHaveBeenCalledOnce())
    cleanup()
    const image = useCamStore.getState().project.referenceImages2d![0]
    saveFromExport(`image:${image.id}`)
    await waitFor(() => expect(saved).toHaveLength(1))
    cleanup()
    saveFromExport(`image:${image.id}`)
    await waitFor(() => expect(saved).toHaveLength(2))
    for (const output of saved) {
      expect(output.name).toBe('Photo.PNG')
      expect(output.bytes.equals(source)).toBe(true)
      expect(output.bytes.subarray(1, 4).toString()).toBe('PNG')
      expect(output.bytes.readUInt32BE(16)).toBe(image.payload.image.widthPx)
    }
  })

  it('retains exact image bytes through the browser FileReader production branch too', async () => {
    vi.stubGlobal('FileReader', nativeReader)
    const { fileDataUrl } = await import('../../referenceImage/imageData')
    const file = new nativeFile([new Uint8Array([0, 255, 128, 13, 10])], 'source.png', { type: 'image/png' })
    const dataUrl = await fileDataUrl(file, new Uint8Array([0, 255, 128, 13, 10]), 'image/png')
    await saveOriginalFile({ fileName: file.name, dataUrl })
    expect(saved[0].bytes).toEqual(Buffer.from([0, 255, 128, 13, 10]))
  })

  it('does not manufacture original bytes from a legacy DXF with only parsed loops', async () => {
    await importGeometryFile(new File([dxf], 'old.dxf'), useCamStore.getState())
    const geo = { ...useCamStore.getState().project.geometry[0], originalFile: undefined }
    expect(await saveGeometryOriginal(geo)).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('does not offer or save converted STEP as an original for legacy IGES rows', async () => {
    await importGeometryFile(new File([igesSolid], 'legacy.igs'), useCamStore.getState())
    const project = JSON.parse(JSON.stringify(useCamStore.getState().project))
    delete project.geometry[0].originalFile
    useCamStore.getState().setProject(project)
    render(createElement(DesignTree))
    expect(screen.queryByTestId(`save-original-${project.geometry[0].id}`)).toBeNull()
    expect(await saveGeometryOriginal(project.geometry[0])).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('does not write an empty file when image metadata precedes source-byte hydration', async () => {
    expect(await saveOriginalFile({ fileName: 'restoring.png', dataUrl: '' })).toBeNull()
    expect(saved).toHaveLength(0)
  })
})
