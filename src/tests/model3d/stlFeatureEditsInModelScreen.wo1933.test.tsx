// @vitest-environment jsdom
// WO-1933 (COHESION-STANDARD s19): changing an STL's geometry is modelling, so
// Setup's Properties panel no longer shows the recognised-feature sections that
// existed only to drive those edits - Round features, Edge blends, Flat faces.
// Everything else the panel shows for the same part stays.
//
// The part is the WO-1846 acceptance plate (through hole, counterbore,
// countersink, boss), served from the STL cache exactly as the app reads it, so
// with the sections still present they WOULD render here (negative control: run
// this file against main's PropertiesPanel.tsx and the absence checks fail).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {}, loadCachedStep: async () => null, removeCachedStep: async () => {},
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async () => {},
  removeCachedSTL: async () => {},
  loadCachedSTL: async () => {
    const plate = readFileSync(resolve(__dirname, '../evidence/WO-1846/acceptance-plate.stl'))
    return plate.buffer.slice(plate.byteOffset, plate.byteOffset + plate.byteLength) as ArrayBuffer
  },
}))

const { GeometryProperties } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

function plateRow(): ImportedGeometry {
  return {
    id: 'plate', name: 'acceptance plate', filename: 'acceptance-plate.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 80, z: 12 }, size: { x: 80, y: 80, z: 12 }, center: { x: 40, y: 40, z: 6 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

describe('WO-1933: Setup does not show an STL\'s recognised-feature sections', () => {
  it('the plate\'s panel has no Round features, Edge blends or Flat faces - and keeps the rest', async () => {
    const geo = plateRow()
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } })) })
    render(<GeometryProperties geo={geo} />)

    // The panel is up and its cached-plate read has had time to settle (the
    // removed sections came off that read). WO-1961 moved the shape editor
    // this used to wait on to the Model screen.
    await waitFor(() => expect(screen.getByTestId('geo-bbox-size')).toBeTruthy(), { timeout: 10000 })
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })

    for (const gone of ['pp-round-features', 'pp-round-feature', 'pp-edge-blends', 'pp-edge-blend', 'pp-flat-faces', 'pp-flat-face']) {
      expect(screen.queryAllByTestId(gone)).toHaveLength(0)
    }
    for (const label of ['Round features', 'Edge blends', 'Flat faces']) {
      expect(screen.queryByText(label)).toBeNull()
    }

    // Everything else for this part renders as before.
    expect(screen.getByText('File')).toBeTruthy()
    expect(screen.getByText('acceptance-plate.stl')).toBeTruthy()
    expect(screen.getByText('Format')).toBeTruthy()
    expect(screen.getByText('STL')).toBeTruthy()
    expect(screen.getByTestId('geo-bbox-size')).toBeTruthy()
    // WO-1961: "Add or cut a shape" is the Model screen's Boolean now.
    expect(screen.queryByText('Add or cut a shape')).toBeNull()
  }, 30000)
})
