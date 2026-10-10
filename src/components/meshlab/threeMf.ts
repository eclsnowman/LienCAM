// WO INT-3: minimal 3MF (3D Manufacturing Format) reader/writer.
//
// src/mesh/** (frozen, MSH-1/MSH-2) only exports STL. Acceptance criterion 1 requires "export
// STL + 3MF" -- 3MF is a plain ZIP container around an XML mesh description, not a kernel
// operation, so it lives here at the wiring layer rather than needing a src/mesh/** change.
// Uses fflate (already a project dependency -- see src/doc/persist/format.ts's .camproject zip)
// so this adds no new dependency, per the WO's "NO new dependencies" ownership rule.
//
// Deliberately minimal: one <object> holding one <mesh>, no color/material/multi-body support --
// enough to prove a real round trip (export bytes non-empty, re-importable) for the M3 lab.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { MeshBuffers } from '../../mesh'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`

function buildModelXml(mesh: MeshBuffers): string {
  const vertexCount = mesh.positions.length / 3
  const vertices: string[] = new Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) {
    const x = mesh.positions[v * 3]
    const y = mesh.positions[v * 3 + 1]
    const z = mesh.positions[v * 3 + 2]
    vertices[v] = `<vertex x="${x}" y="${y}" z="${z}"/>`
  }
  const triangleCount = mesh.indices.length / 3
  const triangles: string[] = new Array(triangleCount)
  for (let t = 0; t < triangleCount; t++) {
    const a = mesh.indices[t * 3]
    const b = mesh.indices[t * 3 + 1]
    const c = mesh.indices[t * 3 + 2]
    triangles[t] = `<triangle v1="${a}" v2="${b}" v3="${c}"/>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>${vertices.join('')}</vertices>
        <triangles>${triangles.join('')}</triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>
`
}

export interface Export3mfResult {
  bytes: ArrayBuffer
  triangleCount: number
}

export function export3mf(mesh: MeshBuffers): Export3mfResult {
  if (mesh.indices.length % 3 !== 0) throw new Error('mesh indices length is not divisible by 3')
  const zipped = zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(buildModelXml(mesh)),
    },
    { level: 6 },
  )
  const out = new ArrayBuffer(zipped.byteLength)
  new Uint8Array(out).set(zipped)
  return { bytes: out, triangleCount: mesh.indices.length / 3 }
}

function attrNumber(el: Element, name: string): number {
  const raw = el.getAttribute(name)
  if (raw === null) throw new Error(`3mf mesh element missing required "${name}" attribute`)
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`3mf mesh element "${name}" attribute is not a finite number: ${raw}`)
  return value
}

export function import3mf(bytes: ArrayBuffer | Uint8Array): MeshBuffers {
  const zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const modelBytes = zip['3D/3dmodel.model']
  if (modelBytes === undefined) throw new Error('3mf archive is missing 3D/3dmodel.model')
  const xmlText = strFromU8(modelBytes)
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror') !== null) throw new Error('3mf 3dmodel.model is not valid XML')

  const vertexEls = doc.querySelectorAll('vertices > vertex')
  const positions = new Float32Array(vertexEls.length * 3)
  vertexEls.forEach((el, i) => {
    positions[i * 3] = attrNumber(el, 'x')
    positions[i * 3 + 1] = attrNumber(el, 'y')
    positions[i * 3 + 2] = attrNumber(el, 'z')
  })

  const triangleEls = doc.querySelectorAll('triangles > triangle')
  const indices = new Uint32Array(triangleEls.length * 3)
  triangleEls.forEach((el, i) => {
    indices[i * 3] = attrNumber(el, 'v1')
    indices[i * 3 + 1] = attrNumber(el, 'v2')
    indices[i * 3 + 2] = attrNumber(el, 'v3')
  })

  if (positions.length === 0 || indices.length === 0) throw new Error('3mf mesh has no vertices/triangles')
  return { positions, indices }
}
