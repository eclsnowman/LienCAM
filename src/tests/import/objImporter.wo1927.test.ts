// @vitest-environment jsdom
//
// WO-1927: a .obj mesh file imports like an STL. Proves, through the REAL
// production dispatch entry point (importGeometryFile), that:
//   1. an OBJ fixture imports as a type:'mesh', format:'obj' geometry with the
//      same triangle count and bounding box as the equivalent STL fixture;
//   2. a malformed OBJ (a face referencing a nonexistent vertex index) is
//      refused with a message naming the file and the 1-based bad line, never a
//      partial/garbled mesh;
//   3. polygonal (non-triangular) faces import fan-triangulated;
//   4. both file pickers offer .obj;
//   5. the existing STL and STEP dispatch arms are unchanged (negative control).
//
// The viewport is the production seam: the test installs the same three.js
// STLLoader the real CNCViewport.addSTL uses as window.__cncViewport.addSTL, so
// the buffer handed across the seam is parsed exactly as production parses it.
// Only the IndexedDB-backed caches are mocked (no real IndexedDB in jsdom),
// mirroring importGeometryFileConsole.test.ts.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { typedMock } from '../support/typedMock'

// Harness copied from importGeometryFileConsole.test.ts: jsdom's default
// localStorage trips zustand's persist middleware here; a plain in-memory shim
// sidesteps it (this file only cares about the consoleEvents slice).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { parseObj, objToBinaryStl } = await import('../../lib/import/objImporter')

const here = dirname(fileURLToPath(import.meta.url))
const OBJ_TEXT = readFileSync(join(here, '../evidence/WO-1927/box.obj'), 'utf8')
const STL_BYTES = readFileSync(join(here, '../evidence/WO-1927/box.stl'))

interface Box3 { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
interface MeshSeen { triangles: number; min: Box3['min']; max: Box3['max'] }

// Install the production viewport seam. addSTL parses the buffer with the SAME
// three.js STLLoader CNCViewport.addSTL uses and records what it saw.
function installFakeViewport(): MeshSeen[] {
  const seen: MeshSeen[] = []
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    addSTL: async (buffer: ArrayBuffer): Promise<Box3> => {
      const geom = new STLLoader().parse(buffer)
      geom.computeBoundingBox()
      const bb = geom.boundingBox!
      const position = geom.getAttribute('position')
      seen.push({
        triangles: position.count / 3,
        min: { x: bb.min.x, y: bb.min.y, z: bb.min.z },
        max: { x: bb.max.x, y: bb.max.y, z: bb.max.z },
      })
      return { min: { x: bb.min.x, y: bb.min.y, z: bb.min.z }, max: { x: bb.max.x, y: bb.max.y, z: bb.max.z } }
    },
  }
  return seen
}

function makeDeps() {
  return { importBrepGeometry: vi.fn(), addGeometry: vi.fn() }
}

beforeEach(() => {
  useCamStore.setState({
    consoleEvents: [],
    consoleReadThroughId: 0,
    promptAndApplyImportStockChoice: vi.fn().mockResolvedValue(undefined),
  })
})

describe('WO-1927: OBJ import through the real dispatch path', () => {
  it('lands type:mesh format:obj with the same triangle count + bounding box as the equivalent STL', async () => {
    const objSeen = installFakeViewport()
    const objDeps = makeDeps()
    await importGeometryFile(new File([OBJ_TEXT], 'box.obj'), objDeps)

    expect(objDeps.addGeometry).toHaveBeenCalledTimes(1)
    const objGeo = objDeps.addGeometry.mock.calls[0][0]
    expect(objGeo.type).toBe('mesh')
    expect(objGeo.format).toBe('obj')
    expect(objGeo.filename).toBe('box.obj')
    expect(objGeo.loaded).toBe(true)
    expect(objGeo.faceCount).toBe(12)

    const stlSeen = installFakeViewport()
    const stlDeps = makeDeps()
    await importGeometryFile(new File([STL_BYTES], 'box.stl'), stlDeps)

    const stlGeo = stlDeps.addGeometry.mock.calls[0][0]
    expect(stlGeo.type).toBe('mesh')
    expect(stlGeo.format).toBe('stl')

    // Same shape: identical triangle count and bounding box through the SAME
    // production seam (the viewport), not a hand-called parser.
    expect(objSeen).toHaveLength(1)
    expect(stlSeen).toHaveLength(1)
    expect(objSeen[0].triangles).toBe(12)
    expect(objSeen[0].triangles).toBe(stlSeen[0].triangles)
    expect(objGeo.boundingBox.min).toEqual(stlGeo.boundingBox.min)
    expect(objGeo.boundingBox.max).toEqual(stlGeo.boundingBox.max)
    expect(objGeo.boundingBox.max).toEqual({ x: 10, y: 20, z: 5 })
  })

  it('refuses a malformed OBJ by file name and 1-based line, importing nothing', async () => {
    const seen = installFakeViewport()
    const bad = [
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'f 1 2 9',
    ].join('\n')
    const deps = makeDeps()

    await expect(importGeometryFile(new File([bad], 'bad.obj'), deps)).rejects.toThrow(/bad\.obj/)

    expect(seen).toHaveLength(0)
    expect(deps.addGeometry).not.toHaveBeenCalled()
    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ severity: 'error', source: 'import' })
    expect(events[0].message).toContain('bad.obj')
    expect(events[0].message).toContain('line 4')
  })

  it('fan-triangulates polygonal faces (a pentagon becomes 3 triangles)', async () => {
    const pentagon = [
      'v 0 0 0',
      'v 2 0 0',
      'v 3 1 0',
      'v 1 2 0',
      'v -1 1 0',
      'f 1 2 3 4 5',
    ].join('\n')

    expect(parseObj(pentagon).triangleCount).toBe(3)
    expect(parseObj(pentagon).indices.length).toBe(9)

    const seen = installFakeViewport()
    const deps = makeDeps()
    await importGeometryFile(new File([pentagon], 'pent.obj'), deps)
    expect(deps.addGeometry.mock.calls[0][0].faceCount).toBe(3)
    expect(seen[0].triangles).toBe(3)
  })

  it('objToBinaryStl refuses an OBJ with no vertices', () => {
    expect(() => objToBinaryStl('# nothing here\n', 'empty.obj')).toThrow(/empty\.obj.*line 1/)
  })

  it('both file pickers accept .obj', () => {
    const srcRoot = join(here, '../..')
    for (const rel of ['components/panels/DesignTree.tsx', 'components/modals/NestModal.tsx']) {
      const source = readFileSync(join(srcRoot, rel), 'utf8')
      expect(source).toMatch(/accept="[^"]*\bobj\b[^"]*"/)
    }
  })

  it('negative control: existing STL and STEP dispatch arms are unchanged', async () => {
    // STL still routes to the viewport and lands format:'stl'.
    const seen = installFakeViewport()
    const stlDeps = makeDeps()
    await importGeometryFile(new File([STL_BYTES], 'box.stl'), stlDeps)
    expect(seen).toHaveLength(1)
    expect(stlDeps.addGeometry.mock.calls[0][0].format).toBe('stl')
    expect(stlDeps.importBrepGeometry).not.toHaveBeenCalled()

    // STEP still routes through the B-rep worker pipeline, not the mesh path.
    const stepDeps = makeDeps()
    const stepFile = new File(['ISO-10303-21;\nEND-ISO-10303-21;'], 'part.step')
    await importGeometryFile(stepFile, stepDeps)
    expect(stepDeps.importBrepGeometry).toHaveBeenCalledTimes(1)
    expect(stepDeps.importBrepGeometry).toHaveBeenCalledWith(stepFile)
    expect(stepDeps.addGeometry).not.toHaveBeenCalled()
  })
})
