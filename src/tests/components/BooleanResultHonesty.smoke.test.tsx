// @vitest-environment jsdom
// MSH-4-BOOLEAN-EDIT Stage 2: the honesty surfaces render correctly - the
// Properties Panel facts (exact vs approximate + op + operands + stats) and the
// DesignTree approx/exact badge. Render-gate rule: real render, not just logic.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

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

const { GeometryProperties } = await import('../../components/panels/PropertiesPanel')
import type { ImportedGeometry } from '../../types'

afterEach(cleanup)

function resultGeo(approximate: boolean): ImportedGeometry {
  return {
    id: 'r1', name: 'scan (subtract)', filename: 'scan (subtract).stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    approximate,
    booleanProvenance: {
      op: 'difference', sourceMeshId: 'm', sourceMeshName: 'scan', modelBodyId: 'b', modelBodyName: 'Block',
      triangleCount: 240, volumeMm3: 874.5, curvedFaceCount: approximate ? 3 : 0,
    },
  }
}
const plainGeo: ImportedGeometry = {
  id: 'g1', name: 'part', filename: 'part.stl', type: 'mesh', format: 'stl',
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 }, center: { x: .5, y: .5, z: .5 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
}

describe('boolean result honesty facts (Properties Panel)', () => {
  // WO-2007 fix round (CS 21): Result, Boolean op, Source mesh, Model body, Triangles, Volume and Curved
  // faces are provenance read-outs - gone from Properties. Exact/approx honesty stays on the DesignTree
  // badge (BooleanBadge.designTree.test.tsx); the result keeps its one editable control, Edit boolean.
  it.each([false, true])('a boolean result (approximate=%s) shows no provenance rows, only Edit boolean', (approximate) => {
    const { queryByTestId, queryByText, getByTestId } = render(<GeometryProperties geo={resultGeo(approximate)} />)
    expect(queryByTestId('geo-boolean-fidelity')).toBeNull()
    for (const gone of ['Result', 'Boolean op', 'Source mesh', 'Model body', 'Triangles', 'Volume', 'Curved faces', '874.50 mm3']) {
      expect(queryByText(gone)).toBeNull()
    }
    expect(getByTestId('pp-edit-boolean')).toBeTruthy()
  })

  it('a plain imported mesh shows NO boolean facts (never mislabels an import)', () => {
    const { queryByTestId } = render(<GeometryProperties geo={plainGeo} />)
    expect(queryByTestId('geo-boolean-fidelity')).toBeNull()
  })
})
