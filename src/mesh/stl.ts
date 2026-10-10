import { analyzeAndMeasure } from './analysis';
import type { MeshBuffers, StlExportResult, StlImportOptions, StlImportResult, Vec3 } from './types';

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRIANGLE_BYTES = 50;

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HEADER_BYTES + COUNT_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + COUNT_BYTES + triangleCount * TRIANGLE_BYTES;
  if (expected === bytes.byteLength) return true;
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 256))).trimStart().toLowerCase();
  return !prefix.startsWith('solid');
}

export function parseStl(data: ArrayBuffer | Uint8Array | string, options?: StlImportOptions): StlImportResult {
  return importStl(data, options);
}

export function importStl(data: ArrayBuffer | Uint8Array | string, options: StlImportOptions = {}): StlImportResult {
  const bytes = toBytes(data);
  const parsed = looksBinary(bytes) ? parseBinary(bytes) : parseAscii(bytes);
  // BK-17b: single shared buildTopology pass for the bundled report + measures.
  const { report, measures } = analyzeAndMeasure(parsed.mesh, {
    checkSelfIntersections: options.checkSelfIntersections === true,
  });
  return { ...parsed, report, measures };
}

function parseBinary(bytes: Uint8Array): Pick<StlImportResult, 'mesh' | 'format'> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + COUNT_BYTES + triangleCount * TRIANGLE_BYTES;
  if (expected > bytes.byteLength) {
    throw new Error('malformed binary STL: expected ' + String(expected) + ' bytes, got ' + String(bytes.byteLength));
  }

  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  let cursor = HEADER_BYTES + COUNT_BYTES;
  let positionOffset = 0;

  for (let tri = 0; tri < triangleCount; tri++) {
    cursor += 12;
    for (let vertex = 0; vertex < 3; vertex++) {
      positions[positionOffset] = view.getFloat32(cursor, true);
      positions[positionOffset + 1] = view.getFloat32(cursor + 4, true);
      positions[positionOffset + 2] = view.getFloat32(cursor + 8, true);
      indices[tri * 3 + vertex] = tri * 3 + vertex;
      positionOffset += 3;
      cursor += 12;
    }
    cursor += 2;
  }

  return { mesh: { positions, indices }, format: 'binary' };
}

function parseAscii(bytes: Uint8Array): Pick<StlImportResult, 'mesh' | 'format'> {
  const text = new TextDecoder().decode(bytes);
  const coords: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() !== 'vertex') continue;
    if (parts.length !== 4) throw new Error('malformed ascii STL: vertex line must have 3 coordinates');
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const z = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('malformed ascii STL: vertex coordinates must be finite numbers');
    }
    coords.push(x, y, z);
  }

  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw new Error('malformed ascii STL: expected complete facet vertex triples');
  }

  const positions = new Float32Array(coords);
  const indices = new Uint32Array(coords.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  return { mesh: { positions, indices }, format: 'ascii' };
}
export function exportBinaryStl(mesh: MeshBuffers): StlExportResult {
  if (mesh.indices.length % 3 !== 0) throw new Error('mesh indices length is not divisible by 3');
  const triangleCount = mesh.indices.length / 3;
  const bytes = new Uint8Array(HEADER_BYTES + COUNT_BYTES + triangleCount * TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('LienCAM deterministic binary STL').slice(0, HEADER_BYTES));
  view.setUint32(HEADER_BYTES, triangleCount, true);

  let cursor = HEADER_BYTES + COUNT_BYTES;
  for (let tri = 0; tri < triangleCount; tri++) {
    const a = point(mesh, mesh.indices[tri * 3]);
    const b = point(mesh, mesh.indices[tri * 3 + 1]);
    const c = point(mesh, mesh.indices[tri * 3 + 2]);
    const normal = normalize(cross(sub(b, a), sub(c, a)));

    writeVec(view, cursor, normal);
    cursor += 12;
    writeVec(view, cursor, a);
    cursor += 12;
    writeVec(view, cursor, b);
    cursor += 12;
    writeVec(view, cursor, c);
    cursor += 12;
    view.setUint16(cursor, 0, true);
    cursor += 2;
  }

  return { bytes: arrayBufferFrom(bytes), triangleCount };
}

export function exportStl(mesh: MeshBuffers): StlExportResult {
  return exportBinaryStl(mesh);
}

function point(mesh: MeshBuffers, index: number): Vec3 {
  const offset = index * 3;
  return [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
}

function writeVec(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value[0], true);
  view.setFloat32(offset + 4, value[1], true);
  view.setFloat32(offset + 8, value[2], true);
}
