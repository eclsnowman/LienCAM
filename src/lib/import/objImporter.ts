/* WO-1927: Wavefront OBJ mesh importer.
 *
 * An operator with a mesh exported as OBJ (common from mesh-editing and scan
 * tools that do not emit STL) imports it the same way an STL does: this parser
 * reads the subset the product's mesh pipeline actually consumes - `v` vertex
 * lines and `f` face lines - triangulates polygonal faces by fanning them the
 * same way the other mesh importers in this codebase do, and re-emits the result
 * as a deterministic binary STL ArrayBuffer. That is byte-for-byte the shape
 * CNCViewport.addSTL -> three STLLoader already consumes for an .stl, so the OBJ
 * part flows through the identical viewport load / cache / downstream path
 * instead of being told to re-export (LIENCAM.md rule 11).
 *
 * `vt`/`vn`/`vc`/groups/materials/comments are ignored: nothing downstream reads
 * them. The binary serializer is reused from src/mesh/stl (port, don't re-derive).
 *
 * Malformed input is refused BY NAME AND 1-BASED LINE - an `f` referencing a
 * vertex index that does not exist, a face with fewer than 3 vertices, no
 * vertices - never a partial/garbled mesh silently accepted.
 */

import { exportBinaryStl } from '../../mesh/stl'
import type { MeshBuffers } from '../../mesh/types'

const OBJ_LINE = /^[-+]?\d+$/

/** The welded indexed mesh shape an STL import produces (positions/indices). */
export interface ParsedObj {
  positions: Float32Array
  indices: Uint32Array
  triangleCount: number
}

function fail(filename: string | undefined, line: number, why: string): never {
  const who = filename ? `"${filename}"` : 'OBJ'
  throw new Error(`OBJ import: malformed ${who} at line ${line}: ${why}`)
}

/**
 * Parse OBJ text into an indexed triangle mesh, refusing malformed input by
 * name and 1-based line. Face vertex references may be `v`, `v/vt`, `v//vn` or
 * `v/vt/vn`; the vertex index is the part before the first slash. Indices are
 * 1-based (negative values count back from the vertices defined so far).
 */
export function parseObj(text: string, filename?: string): ParsedObj {
  const lines = text.split(/\r?\n/)
  const verts: number[] = []
  const indices: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const hash = lines[i].indexOf('#')
    const body = (hash >= 0 ? lines[i].slice(0, hash) : lines[i]).trim()
    if (body.length === 0) continue

    const toks = body.split(/\s+/)
    const kw = toks[0].toLowerCase()

    if (kw === 'v') {
      if (toks.length < 4) {
        fail(filename, lineNo, `vertex needs 3 coordinates, got ${toks.length - 1}`)
      }
      const x = Number(toks[1])
      const y = Number(toks[2])
      const z = Number(toks[3])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        fail(filename, lineNo, 'vertex coordinates must be finite numbers')
      }
      verts.push(x, y, z)
    } else if (kw === 'f') {
      const count = verts.length / 3
      const face: number[] = []
      for (let t = 1; t < toks.length; t++) {
        const raw = toks[t].split('/')[0]
        if (!OBJ_LINE.test(raw)) {
          fail(filename, lineNo, `face vertex "${toks[t]}" is not an integer index`)
        }
        const n = parseInt(raw, 10)
        const resolved = n < 0 ? count + n + 1 : n
        if (resolved < 1 || resolved > count) {
          fail(filename, lineNo, `face references vertex ${raw} but only ${count} vertices are defined`)
        }
        face.push(resolved - 1)
      }
      if (face.length < 3) {
        fail(filename, lineNo, `face has ${face.length} vertices; a face needs at least 3`)
      }
      // Fan-triangulate: (0, k, k+1) for every interior edge, the same
      // polygon->triangle rule the other mesh importers use.
      for (let k = 1; k + 1 < face.length; k++) {
        indices.push(face[0], face[k], face[k + 1])
      }
    }
    // Every other keyword (vt, vn, vc, o, g, s, usemtl, mtllib, ...) is ignored.
  }

  if (verts.length === 0) fail(filename, 1, 'no vertices defined')
  if (indices.length === 0) fail(filename, lines.length, 'no faces defined')

  return {
    positions: new Float32Array(verts),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
  }
}

export interface ObjStlResult {
  bytes: ArrayBuffer
  triangleCount: number
}

/**
 * Parse OBJ text and re-emit it as a deterministic binary STL ArrayBuffer, the
 * exact byte shape the STL import path hands to the viewport, plus the triangle
 * count so the caller can record it on the landed geometry. Refusal is by name
 * and 1-based line through parseObj.
 */
export function objToBinaryStl(text: string, filename?: string): ObjStlResult {
  const parsed = parseObj(text, filename)
  const mesh: MeshBuffers = { positions: parsed.positions, indices: parsed.indices }
  return { bytes: exportBinaryStl(mesh).bytes, triangleCount: parsed.triangleCount }
}
