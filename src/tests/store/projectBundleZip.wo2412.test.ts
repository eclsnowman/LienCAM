// @vitest-environment jsdom
import { inflateRawSync } from 'node:zlib'
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { cacheSTL, loadCachedSTL } from '../../lib/stlCache'
import { cacheStep } from '../../lib/stepCache'
import { bytesToDataUrl } from '../../referenceImage/imageData'
import { exportBinaryStl } from '../../mesh/stl'
import { unitCube } from '../mesh/fixtures'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'
import { stashLoadedDocument } from '../../doc/documentHolder'
import { createDocumentArchive } from '../../doc/persist'
import { newSeededModelDag } from '../../doc/seedModelArchive'
import type { Project } from '../../types'

// Independent reader: ZIP central directory + Node's DEFLATE implementation.
// Neither this reader nor its CRC check calls the production fflate library.
function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(bytes)
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const entries = new Map<string, Buffer>()
  let cursor = zip.readUInt32LE(end + 16)
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50)
    const method = zip.readUInt16LE(cursor + 10)
    const size = zip.readUInt32LE(cursor + 20)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const local = zip.readUInt32LE(cursor + 42)
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const compressed = zip.subarray(start, start + size)
    expect([0, 8]).toContain(method)
    const data = method === 8 ? inflateRawSync(compressed) : compressed
    expect(data.length).toBe(zip.readUInt32LE(cursor + 24))
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    expect((crc ^ 0xffffffff) >>> 0).toBe(zip.readUInt32LE(cursor + 16))
    expect(entries.has(name)).toBe(false)
    entries.set(name, data)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

let idb: FakeIndexedDBHandle
let written: { name: string; data: string | Uint8Array }[]
beforeEach(() => {
  idb = installFakeIndexedDB()
  written = []
  vi.stubGlobal('window', {})
  // Node's File/Blob provide arrayBuffer(); align the instanceof check in the
  // real STL importer with their realm while jsdom supplies SVG's DOMParser.
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('ArrayBuffer', Buffer.alloc(0).buffer.constructor)
  vi.stubGlobal('liencamHost', { saveFile: async (name: string, data: string | Uint8Array) => {
    written.push({ name, data }); return 'test-download'
  } })
  // No renderer is mounted; retain the import viewport only during imports.
  useCamStore.setState({ activeSketch: null })
  useCamStore.setState(s => ({ project: { ...s.project, geometry: [], modelItems: [], fonts: {}, referenceImages2d: [], setups: [] } }))
  useCamStore.getState().newProject()
  useCamStore.getState().updateProjectMeta({ name: 'Bundle proof', notes: 'Keep my data' })
  vi.stubGlobal('window', { __cncViewport: {
    addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } }),
    add2DGeometry: () => {},
  } })
})
afterEach(() => { idb.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function bundle(): Promise<Map<string, Buffer>> {
  written = []
  await useCamStore.getState().exportProjectBundleToFile()
  expect(written).toHaveLength(1)
  expect(written[0].name).toBe('Bundle_proof.zip')
  expect(written[0].data).toBeInstanceOf(Uint8Array)
  return readZip(written[0].data as Uint8Array)
}

const dxf = Buffer.from('0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nCIRCLE\r\n8\r\nOutline\r\n10\r\n25\r\n20\r\n25\r\n40\r\n20\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n')
async function importFile(name: string, bytes: Uint8Array): Promise<void> {
  await importGeometryFile(new File([Uint8Array.from(bytes).buffer], name), useCamStore.getState())
}

describe('WO-2412 production project bundle action', () => {
  it('round-trips actual imported STL/DXF bytes and the exact plain Save snapshot', async () => {
    const stl = new Uint8Array(exportBinaryStl(unitCube(20)).bytes)
    await importFile('Plate.stl', stl)
    await importFile('Drawing.dxf', dxf)
    const source = useCamStore.getState().project
    const stlId = source.geometry.find(geo => geo.filename === 'Plate.stl')!.id
    await vi.waitFor(async () => expect(await loadCachedSTL(stlId)).not.toBeNull())
    await useCamStore.getState().saveProjectToFile()
    expect(written[0].name).toBe('Bundle_proof.camproject')
    const plain = written[0].data as string
    const entries = await bundle()
    expect([...entries.keys()].sort()).toEqual(['Bundle_proof.camproject', 'originals/', 'originals/Drawing.dxf', 'originals/Plate.stl'].sort())
    expect(entries.get('originals/Plate.stl')).toEqual(Buffer.from(stl))
    expect(entries.get('originals/Drawing.dxf')).toEqual(dxf)
    const json = entries.get('Bundle_proof.camproject')!.toString('utf8')
    expect(json).toBe(plain)
    vi.stubGlobal('window', {})
    useCamStore.getState().newProject()
    await useCamStore.getState().loadProjectFromFile(json)
    const reopened = useCamStore.getState().project
    expect(reopened.id).toBe(source.id)
    expect(reopened.name).toBe(source.name)
    expect(reopened.notes).toBe(source.notes)
    expect(reopened.geometry.map(g => ({ ...g, loaded: false }))).toEqual(source.geometry.map(g => ({ ...g, loaded: false })))
    expect(Buffer.from((await loadCachedSTL(stlId))!)).toEqual(Buffer.from(stl))
  })

  it('preserves conflicting original filenames in subfolders and deduplicates repeated references', async () => {
    await importFile('Drawing.dxf', dxf)
    await importFile('Drawing.dxf', Buffer.from(dxf.toString().replace('25', '30')))
    await importFile('Drawing.dxf', dxf)
    const entries = await bundle()
    expect(entries.get('originals/Drawing.dxf')).toEqual(dxf)
    expect(entries.get('originals/2/Drawing.dxf')).toEqual(Buffer.from(dxf.toString().replace('25', '30')))
    expect([...entries.keys()].filter(name => name.endsWith('.dxf'))).toHaveLength(2)
  })

  it.each(['before', 'after'] as const)('keeps numeric originals extractable %s duplicate images', async (order) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
    const otherPng = Buffer.concat([png, Buffer.from([0])])
    const numeric = [{ name: '2', bytes: png }, { name: '3', bytes: otherPng }]
    const photos = [{ name: 'Photo.png', bytes: png }, { name: 'Photo.png', bytes: otherPng }, { name: 'Photo.png', bytes: otherPng }]
    const sources = order === 'before' ? [...numeric, ...photos] : [...photos, ...numeric]
    useCamStore.setState(s => ({ project: { ...s.project,
      referenceImages2d: sources.map((source, index) => ({ id: `picture-${index}`, payload: {
        datumType: 'reference-image', name: source.name, planeNodeId: 'cam:xy',
        image: { fileName: source.name, dataUrl: bytesToDataUrl(source.bytes, 'image/png'), widthPx: 1, heightPx: 1 },
        widthMm: 1, heightMm: 1, opacity: 1,
      } })),
    } }))
    const entries = await bundle()
    const files = [...entries.keys()].filter(name => !name.endsWith('/'))
    // An independent reader must see every file without any file also being
    // another entry's parent directory (including case-insensitive extraction).
    for (const file of files) {
      expect(files.some(other => other.toLowerCase().startsWith(`${file.toLowerCase()}/`))).toBe(false)
    }
    expect(files.sort()).toEqual(['Bundle_proof.camproject', 'originals/2', 'originals/3', 'originals/Photo.png', 'originals/4/Photo.png'].sort())
    expect(entries.get('originals/2')).toEqual(png)
    expect(entries.get('originals/3')).toEqual(otherPng)
    expect(entries.get('originals/Photo.png')).toEqual(png)
    expect(entries.get('originals/4/Photo.png')).toEqual(otherPng)
  })

  it('includes STEP, SVG, OBJ, image and font originals without re-encoding them', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    const obj = Buffer.from('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n')
    await importFile('Outline.svg', svg)
    await importFile('Mesh.obj', obj)
    const geo = useCamStore.getState().project.geometry[0]
    const step = Buffer.from('ISO-10303-21;\r\noriginal STEP bytes\r\nEND-ISO-10303-21;')
    await cacheStep('step-source', Uint8Array.from(step).buffer)
    const image = new Uint8Array([137, 80, 78, 71, 0, 255])
    const font = new Uint8Array([0, 1, 0, 0, 255])
    useCamStore.setState(s => ({ project: { ...s.project,
      geometry: [...s.project.geometry, { ...geo, id: 'step-source', format: 'step', filename: 'Bracket.stp', originalFile: undefined }],
      referenceImages2d: [{ id: 'picture', payload: { datumType: 'reference-image', name: 'Ruler', planeNodeId: 'cam:xy', image: { fileName: 'Ruler.png', dataUrl: bytesToDataUrl(image, 'image/png'), widthPx: 1, heightPx: 1 }, widthMm: 1, heightMm: 1, opacity: 1 } }],
      fonts: { face: { family: 'Imported face', typeface: { _liencamOriginalFile: { fileName: 'Face.ttf', dataUrl: bytesToDataUrl(font, 'font/ttf') } } } },
    } }))
    const entries = await bundle()
    for (const [name, bytes] of [['Outline.svg', svg], ['Mesh.obj', obj], ['Bracket.stp', step], ['Ruler.png', image], ['Face.ttf', font]] as const) {
      expect(entries.get(`originals/${name}`)).toEqual(Buffer.from(bytes))
    }
  })

  it('includes model-only import nodes and 3D reference/relief images in cold archives', async () => {
    const dag = newSeededModelDag()
    dag.insertNode({ id: 'CNV1', kind: 'meshImport', consumes: [], refs: [], payload: { fileName: 'Model-only.stl', cacheKey: 'model-source' } })
    dag.insertNode({ id: 'picture', kind: 'datum', consumes: [], refs: [], payload: { datumType: 'reference-image', image: { fileName: 'Photo.jpg', dataUrl: bytesToDataUrl(new Uint8Array([255, 216, 255]), 'image/jpeg') } } })
    dag.insertNode({ id: 'relief', kind: 'datum', consumes: [], refs: [], payload: { image: { fileName: 'Relief.png', dataUrl: bytesToDataUrl(new Uint8Array([137, 80]), 'image/png') } } })
    const stl = exportBinaryStl(unitCube(10)).bytes
    await cacheSTL('model-source', stl)
    stashLoadedDocument(createDocumentArchive({ dag, elementMapDeltas: [] }))
    const entries = await bundle()
    expect(entries.get('originals/Model-only.stl')).toEqual(Buffer.from(stl))
    expect(entries.get('originals/Photo.jpg')).toEqual(Buffer.from([255, 216, 255]))
    expect(entries.get('originals/Relief.png')).toEqual(Buffer.from([137, 80]))
    const project = JSON.parse(entries.get('Bundle_proof.camproject')!.toString()) as Project
    expect(project.document).toBeTruthy()
    expect(project.binaries?.['model-source'].stl).toBeTruthy()
  })

  it('keeps original IGES rather than the converted STEP and contains unsafe names', async () => {
    await importFile('Drawing.dxf', dxf)
    const geo = useCamStore.getState().project.geometry[0]
    await cacheStep(geo.id, new Uint8Array([1, 2, 3]).buffer)
    useCamStore.setState(s => ({ project: { ...s.project, geometry: [{ ...geo, format: 'step', filename: 'Part.igs', originalFile: { fileName: '../Part.igs', dataUrl: bytesToDataUrl(new Uint8Array([9, 8, 7]), 'application/iges') } }] } }))
    const entries = await bundle()
    expect(entries.get('originals/Part.igs')).toEqual(Buffer.from([9, 8, 7]))
    expect([...entries.keys()].some(name => name.includes('..'))).toBe(false)
  })

  it('exports an empty project with an originals folder and respects host cancellation', async () => {
    const entries = await bundle()
    expect([...entries.keys()]).toEqual(['Bundle_proof.camproject', 'originals/'])
    const cancel = vi.fn(async () => null)
    vi.stubGlobal('liencamHost', { saveFile: cancel })
    await useCamStore.getState().exportProjectBundleToFile()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
