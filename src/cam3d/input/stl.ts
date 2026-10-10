// cam3d input pipeline: STL importer (binary + ascii).
//
// WHY a parser here instead of reusing the app's STL path: the only existing
// STL import lives inside src/lib/viewport/CNCViewport.ts via three.js
// STLLoader -- a render-layer dependency that returns a non-indexed
// three.BufferGeometry and silently tolerates malformed input. The cam3d
// engine deliberately does not import viewport/three code (L2 boundary
// discipline, D-001), and the importer must fail loud, so a small
// self-contained parser is the cleaner reuse decision.
//
// Units: STL is unitless; per app-wide convention coordinates are treated as
// mm (kernel/types.ts: units mm, Z-up).
//
// Vertices are welded by exact Float32 bit equality while parsing, so a
// well-formed solid becomes a properly indexed, watertight mesh instead of a
// 3-vertices-per-triangle soup.

import type { PartImportResult } from './types';
import { sanitizeTriangleMesh } from './sanitize';

export type StlFormat = 'binary' | 'ascii';

/** Reserved: no STL options exist yet; present so the signature is stable. */
export interface StlImportOptions {
  readonly reservedForFutureUse?: never;
}

export interface ParsedStl {
  positions: Float32Array;
  indices: Uint32Array;
  format: StlFormat;
}

const BINARY_HEADER_BYTES = 80;
const BINARY_TRIANGLE_BYTES = 50; // 12 f32 (normal + 3 vertices) + u16 attribute

/**
 * Detect binary vs ascii STL, failing loud when the bytes satisfy neither
 * contract. The binary size equation is checked FIRST because real-world
 * binary files often start with the ascii marker "solid" in their comment
 * header; file size is the reliable discriminator.
 */
export function detectStlFormat(data: ArrayBuffer): StlFormat {
  if (data.byteLength >= BINARY_HEADER_BYTES + 4) {
    const triCount = new DataView(data).getUint32(BINARY_HEADER_BYTES, true);
    if (BINARY_HEADER_BYTES + 4 + BINARY_TRIANGLE_BYTES * triCount === data.byteLength) {
      return 'binary';
    }
  }
  const probe = new TextDecoder().decode(
    new Uint8Array(data, 0, Math.min(512, data.byteLength)),
  );
  if (/^\s*solid\b/i.test(probe)) return 'ascii';
  throw new Error(
    `STL import: unrecognized file. Not binary STL (size ${data.byteLength} does not equal ` +
      `84 + 50 x triangle-count) and not ascii STL (no leading "solid" keyword). ` +
      `If this is a nonstandard binary STL with attribute payloads, it is unsupported -- ` +
      `re-export it as standard binary or ascii STL.`,
  );
}

/** Exact-bits vertex welder shared by both parse paths. */
class VertexWelder {
  readonly positions: number[] = [];
  private readonly byKey = new Map<string, number>();

  add(x: number, y: number, z: number): number {
    // Quantize through f32 first so the weld key matches what will actually
    // be stored in the Float32Array (ascii input is parsed in f64).
    const fx = Math.fround(x);
    const fy = Math.fround(y);
    const fz = Math.fround(z);
    const key = `${fx}|${fy}|${fz}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const idx = this.positions.length / 3;
    this.positions.push(fx, fy, fz);
    this.byKey.set(key, idx);
    return idx;
  }
}

function parseBinaryStl(data: ArrayBuffer): ParsedStl {
  const view = new DataView(data);
  const triCount = view.getUint32(BINARY_HEADER_BYTES, true);
  if (triCount === 0) {
    throw new Error('STL import: binary STL declares 0 triangles; nothing to import');
  }
  const welder = new VertexWelder();
  const indices = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    // 50-byte record: normal (12 bytes, ignored -- normals are recomputable
    // and frequently garbage in the wild), 3 vertices, u16 attribute.
    const base = BINARY_HEADER_BYTES + 4 + t * BINARY_TRIANGLE_BYTES + 12;
    for (let v = 0; v < 3; v++) {
      indices[t * 3 + v] = welder.add(
        view.getFloat32(base + v * 12, true),
        view.getFloat32(base + v * 12 + 4, true),
        view.getFloat32(base + v * 12 + 8, true),
      );
    }
  }
  return { positions: new Float32Array(welder.positions), indices, format: 'binary' };
}

function parseAsciiStl(data: ArrayBuffer): ParsedStl {
  const text = new TextDecoder().decode(data);
  const lines = text.split(/\r?\n/);
  const welder = new VertexWelder();
  const indices: number[] = [];

  // Line-oriented state walk with 1-based line numbers in every error, so a
  // malformed export is diagnosable without opening a hex editor.
  const fail = (lineNo: number, why: string): never => {
    throw new Error(`STL import: malformed ascii STL at line ${lineNo}: ${why}`);
  };
  const num = (tok: string, lineNo: number): number => {
    const v = Number(tok);
    if (!Number.isFinite(v)) fail(lineNo, `"${tok}" is not a finite number`);
    return v;
  };

  let i = 0;
  const nextTokens = (): { toks: string[]; lineNo: number } | null => {
    while (i < lines.length) {
      const raw = lines[i++].trim();
      if (raw.length > 0) return { toks: raw.split(/\s+/), lineNo: i };
    }
    return null;
  };

  let sawSolid = false;
  for (;;) {
    const head = nextTokens();
    if (head === null) break;
    if (head.toks[0].toLowerCase() !== 'solid') {
      fail(head.lineNo, `expected "solid", got "${head.toks[0]}"`);
    }
    sawSolid = true;
    // facets until endsolid
    for (;;) {
      const t = nextTokens();
      if (t === null) fail(lines.length, 'unexpected end of file inside "solid" block');
      const kw = t!.toks[0].toLowerCase();
      if (kw === 'endsolid') break;
      if (kw !== 'facet' || (t!.toks[1] ?? '').toLowerCase() !== 'normal' || t!.toks.length < 5) {
        fail(t!.lineNo, `expected "facet normal nx ny nz" or "endsolid", got "${t!.toks.join(' ')}"`);
      }
      // normal components must parse (validated) but are ignored, same as binary.
      num(t!.toks[2], t!.lineNo);
      num(t!.toks[3], t!.lineNo);
      num(t!.toks[4], t!.lineNo);

      const loop = nextTokens();
      if (
        loop === null ||
        loop.toks[0].toLowerCase() !== 'outer' ||
        (loop.toks[1] ?? '').toLowerCase() !== 'loop'
      ) {
        fail(loop?.lineNo ?? lines.length, 'expected "outer loop"');
      }
      for (let v = 0; v < 3; v++) {
        const vt = nextTokens();
        if (vt === null || vt.toks[0].toLowerCase() !== 'vertex' || vt.toks.length < 4) {
          fail(vt?.lineNo ?? lines.length, 'expected "vertex x y z"');
        }
        indices.push(
          welder.add(num(vt!.toks[1], vt!.lineNo), num(vt!.toks[2], vt!.lineNo), num(vt!.toks[3], vt!.lineNo)),
        );
      }
      const endloop = nextTokens();
      if (endloop === null || endloop.toks[0].toLowerCase() !== 'endloop') {
        fail(endloop?.lineNo ?? lines.length, 'expected "endloop"');
      }
      const endfacet = nextTokens();
      if (endfacet === null || endfacet.toks[0].toLowerCase() !== 'endfacet') {
        fail(endfacet?.lineNo ?? lines.length, 'expected "endfacet"');
      }
    }
  }
  if (!sawSolid || indices.length === 0) {
    throw new Error('STL import: ascii STL contains no facets; nothing to import');
  }
  return {
    positions: new Float32Array(welder.positions),
    indices: new Uint32Array(indices),
    format: 'ascii',
  };
}

/** Parse STL bytes (auto-detected binary/ascii) into a welded indexed mesh. */
export function parseStl(data: ArrayBuffer): ParsedStl {
  const format = detectStlFormat(data);
  return format === 'binary' ? parseBinaryStl(data) : parseAsciiStl(data);
}

/**
 * Import STL bytes into a PartMesh (units mm). Runs the shared sanity/repair
 * pass; degenerate triangles are dropped with a warning, NaN/Inf rejects
 * loudly, non-watertight input imports with a warning.
 */
export async function importStlToPartMesh(
  data: ArrayBuffer,
  opts: StlImportOptions = {},
): Promise<PartImportResult> {
  void opts; // reserved
  const parsed = parseStl(data);
  const clean = sanitizeTriangleMesh(parsed.positions, parsed.indices);
  return {
    mesh: {
      positions: clean.positions,
      indices: clean.indices,
      bounds: clean.bounds,
      source: 'stl',
    },
    warnings: clean.warnings,
    triangleCount: clean.indices.length / 3,
  };
}
