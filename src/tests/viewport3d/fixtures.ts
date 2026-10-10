// viewport3d test fixtures: mock TessBuffers (WO UI-1 -- NO kernel dependency,
// these are hand-built, not produced by geom-service). Two shapes:
//  - makeBoxFixture: a flat-shaded box, 6 faces / 12 edges / 8 vertices, with
//    independently-derived expected ids for every corner and edge so picking
//    tests assert an actual match rather than a tautology against the
//    PickEngine's own derivation.
//  - makeLargeMeshFixture: a single-face flat grid with >=100k triangles,
//    for the AC5 performance guard (no edges/vertices -- perf-only).

import type { TessBuffers } from '../../viewport3d/types';

type Vec3 = [number, number, number];

export interface BoxFixture {
  buffers: TessBuffers;
  size: { sx: number; sy: number; sz: number };
  faceIds: {
    negX: string;
    posX: string;
    negY: string;
    posY: string;
    negZ: string;
    posZ: string;
  };
  corners: Array<{ position: Vec3; expectedAdjacentEdgeIds: string[] }>;
  edgeSamples: Array<{ midpoint: Vec3; expectedEdgeId: string }>;
}

export function makeBoxFixture(sx = 40, sy = 20, sz = 10): BoxFixture {
  const v: Vec3[] = [
    [0, 0, 0], // v0
    [sx, 0, 0], // v1
    [sx, sy, 0], // v2
    [0, sy, 0], // v3
    [0, 0, sz], // v4
    [sx, 0, sz], // v5
    [sx, sy, sz], // v6
    [0, sy, sz], // v7
  ];

  const faceIds = {
    negX: 'F1:BOX:negX',
    posX: 'F1:BOX:posX',
    negY: 'F1:BOX:negY',
    posY: 'F1:BOX:posY',
    negZ: 'F1:BOX:negZ',
    posZ: 'F1:BOX:posZ',
  };

  // Each face: 4 corner indices in CCW order as seen from outside (so
  // cross(p1-p0, p2-p0) yields the listed outward normal), + its id.
  const faces: Array<{ quad: [number, number, number, number]; normal: Vec3; id: string }> = [
    { quad: [1, 2, 6, 5], normal: [1, 0, 0], id: faceIds.posX },
    { quad: [0, 4, 7, 3], normal: [-1, 0, 0], id: faceIds.negX },
    { quad: [2, 3, 7, 6], normal: [0, 1, 0], id: faceIds.posY },
    { quad: [0, 1, 5, 4], normal: [0, -1, 0], id: faceIds.negY },
    { quad: [4, 5, 6, 7], normal: [0, 0, 1], id: faceIds.posZ },
    { quad: [0, 3, 2, 1], normal: [0, 0, -1], id: faceIds.negZ },
  ];

  const position = new Float32Array(faces.length * 4 * 3);
  const normal = new Float32Array(faces.length * 4 * 3);
  const index = new Uint32Array(faces.length * 2 * 3);
  const triFace = new Uint32Array(faces.length * 2);

  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (let k = 0; k < 4; k++) {
      const corner = v[face.quad[k]];
      position.set(corner, (base + k) * 3);
      normal.set(face.normal, (base + k) * 3);
    }
    const triBase = faceIndex * 6;
    // quad (p0,p1,p2,p3) -> triangles (p0,p1,p2),(p0,p2,p3)
    index.set([base, base + 1, base + 2, base, base + 2, base + 3], triBase);
    triFace[faceIndex * 2] = faceIndex;
    triFace[faceIndex * 2 + 1] = faceIndex;
  });

  // 12 box edges: endpoint vertex indices + the two faces they border.
  const edgeDefs: Array<{ a: number; b: number; faces: [string, string] }> = [
    { a: 0, b: 1, faces: [faceIds.negY, faceIds.negZ] },
    { a: 1, b: 2, faces: [faceIds.posX, faceIds.negZ] },
    { a: 2, b: 3, faces: [faceIds.posY, faceIds.negZ] },
    { a: 3, b: 0, faces: [faceIds.negX, faceIds.negZ] },
    { a: 4, b: 5, faces: [faceIds.negY, faceIds.posZ] },
    { a: 5, b: 6, faces: [faceIds.posX, faceIds.posZ] },
    { a: 6, b: 7, faces: [faceIds.posY, faceIds.posZ] },
    { a: 7, b: 4, faces: [faceIds.negX, faceIds.posZ] },
    { a: 0, b: 4, faces: [faceIds.negX, faceIds.negY] },
    { a: 1, b: 5, faces: [faceIds.posX, faceIds.negY] },
    { a: 2, b: 6, faces: [faceIds.posX, faceIds.posY] },
    { a: 3, b: 7, faces: [faceIds.negX, faceIds.posY] },
  ];

  const edgeIds = edgeDefs.map((e) => {
    const sortedFaces = [...e.faces].sort();
    return `E:${sortedFaces[0]}|${sortedFaces[1]}`;
  });

  const edgePositions = new Float32Array(edgeDefs.length * 2 * 3);
  const edgeOffsets = new Uint32Array(edgeDefs.length + 1);
  edgeDefs.forEach((e, i) => {
    edgePositions.set(v[e.a], i * 2 * 3);
    edgePositions.set(v[e.b], i * 2 * 3 + 3);
    edgeOffsets[i] = i * 2;
  });
  edgeOffsets[edgeDefs.length] = edgeDefs.length * 2;

  const buffers: TessBuffers = {
    position,
    normal,
    index,
    triFace,
    faceIds: faces.map((f) => f.id),
    edgePositions,
    edgeOffsets,
    edgeIds,
  };

  // Independently derive, from the same box topology (not from PickEngine),
  // the sorted adjacent edge ids every corner's BridgeVertexRef should carry
  // -- mirrors PickEngine.verticesFor()'s derivation rule so tests can
  // assert an actual match instead of a tautology.
  const edgesByVertex = new Map<number, string[]>();
  edgeDefs.forEach((e, i) => {
    for (const vi of [e.a, e.b]) {
      const list = edgesByVertex.get(vi) ?? [];
      list.push(edgeIds[i]);
      edgesByVertex.set(vi, list);
    }
  });

  const corners = v.map((cornerPos, vi) => {
    const adjacent = [...(edgesByVertex.get(vi) ?? [])].sort();
    return { position: cornerPos, expectedAdjacentEdgeIds: adjacent };
  });

  const edgeSamples = edgeDefs.map((e, i) => {
    const [ax, ay, az] = v[e.a];
    const [bx, by, bz] = v[e.b];
    const midpoint: Vec3 = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
    return { midpoint, expectedEdgeId: edgeIds[i] };
  });

  return { buffers, size: { sx, sy, sz }, faceIds, corners, edgeSamples };
}

export interface LargeMeshFixture {
  buffers: TessBuffers;
  faceId: string;
  triangleCount: number;
}

/** A flat single-face grid with at least `minTriangleCount` triangles, for
 *  the AC5 raycast performance guard. No edges/vertices -- perf-only. */
export function makeLargeMeshFixture(minTriangleCount = 100_000): LargeMeshFixture {
  const cellsPerSide = Math.ceil(Math.sqrt(minTriangleCount / 2));
  const nx = cellsPerSide;
  const ny = cellsPerSide;
  const vertsX = nx + 1;
  const vertsY = ny + 1;
  const vertexCount = vertsX * vertsY;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  for (let j = 0; j < vertsY; j++) {
    for (let i = 0; i < vertsX; i++) {
      const idx = j * vertsX + i;
      position[idx * 3] = i;
      position[idx * 3 + 1] = j;
      position[idx * 3 + 2] = 0;
      normal[idx * 3 + 2] = 1;
    }
  }

  const triangleCount = nx * ny * 2;
  const index = new Uint32Array(triangleCount * 3);
  const triFace = new Uint32Array(triangleCount); // single face: all zero

  let t = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * vertsX + i;
      const b = a + 1;
      const c = a + vertsX;
      const d = c + 1;
      // CCW viewed from +Z: (a,b,d) and (a,d,c)
      index[t * 3] = a;
      index[t * 3 + 1] = b;
      index[t * 3 + 2] = d;
      t++;
      index[t * 3] = a;
      index[t * 3 + 1] = d;
      index[t * 3 + 2] = c;
      t++;
    }
  }

  const faceId = 'F1:BOX:top-large';
  const buffers: TessBuffers = {
    position,
    normal,
    index,
    triFace,
    faceIds: [faceId],
    edgePositions: new Float32Array(0),
    edgeOffsets: new Uint32Array([0]),
    edgeIds: [],
  };

  return { buffers, faceId, triangleCount };
}
