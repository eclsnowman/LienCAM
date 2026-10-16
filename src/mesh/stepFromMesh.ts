// WO-2823: a closed STL mesh written as a STEP solid, so the Model screen's own
// Import STEP route can land it as a body every kernel tool takes - Boolean
// against a STEP body or another STL in both directions first of all.
//
// The solid is the mesh's own geometry, exactly: triangles that lie in one
// plane and touch are one flat face (a plate's top is one face, not a
// thousand); every other triangle - a curved wall's facets - is a flat face of
// its own. Every face boundary runs through every mesh vertex on it (none is
// collapsed for being in line with its neighbours), so two faces always share
// whole edges and the shell is closed edge to edge, the way the mesh is.
//
// WHAT IT REFUSES, and only that (LIENCAM.md rule 11): a mesh with no
// triangles, one that is not watertight (open edges or an edge three faces
// share - no solid has that boundary), or one no orientation can make
// consistent. Inside-out or mixed winding is re-oriented and said so, the
// same way Edit as model does (WO-1453).
//
// Decide-and-log (rule 3): AP214 with millimetre units; the product and the
// face planes carry nothing but geometry. Vertices are welded at 1e-6 of the
// part's diagonal (the prismatic converter's tolerance), and a triangle joins
// its neighbour's face when their normals agree to 1e-6 rad and its corners
// sit within 1e-5 of the diagonal of that face's plane - float32 STL noise on
// a CAD-exported flat face, far below any curved facet's turn.

import { analyzeMesh, computeBoundingBox, orientMesh } from './analysis';
import type { MeshBuffers, Vec3 } from './types';

export type StepFromMeshResult =
  | { ok: true; step: string; faceCount: number; triangleCount: number; notes: string[] }
  | { ok: false; message: string };

const WELD_FRACTION = 1e-6;
const PLANE_FRACTION = 1e-5;
const SAME_NORMAL_COS = Math.cos(1e-6);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = length(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/** STEP real: always a decimal point, `E` exponent. */
function real(x: number): string {
  if (x === 0 || Object.is(x, -0)) return '0.';
  return x.toExponential(12).replace('e', 'E');
}

function weld(mesh: MeshBuffers, tol: number): MeshBuffers {
  const key = (x: number, y: number, z: number) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
  const index = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(mesh.positions.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const k = key(x, y, z);
    let id = index.get(k);
    if (id === undefined) {
      id = positions.length / 3;
      index.set(k, id);
      positions.push(x, y, z);
    }
    remap[v] = id;
  }
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]], b = remap[mesh.indices[t + 1]], c = remap[mesh.indices[t + 2]];
    // a triangle welded flat (two corners in one place) is no surface at all
    if (a !== b && b !== c && c !== a) indices.push(a, b, c);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Write `mesh` as an AP214 STEP file holding one closed solid named `name`. */
export function stepFromMesh(mesh: MeshBuffers, name: string): StepFromMeshResult {
  if (mesh.indices.length < 12) return { ok: false, message: 'the mesh has too few triangles to close a solid' };
  const box = computeBoundingBox(mesh);
  const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
  const welded = weld(mesh, WELD_FRACTION * diagonal);
  const health = analyzeMesh(welded, { checkSelfIntersections: false });
  if (health.boundaryEdgeCount > 0 || health.nonManifoldEdgeCount > 0) {
    return {
      ok: false,
      message: `the mesh is not closed (${health.boundaryEdgeCount} open edge(s), ${health.nonManifoldEdgeCount} edge(s) shared by more than two triangles), so it bounds no solid`,
    };
  }
  const oriented = orientMesh(welded);
  if (oriented.windingConflictEdgeCount > 0) {
    return { ok: false, message: `the mesh is one-sided (${oriented.windingConflictEdgeCount} edge(s) cannot be oriented), so it has no inside to be a solid` };
  }
  const notes: string[] = [];
  if (oriented.flippedTriangleCount > 0) {
    const n = oriented.flippedTriangleCount;
    notes.push(`re-oriented ${n} triangle${n === 1 ? '' : 's'} so the mesh winds consistently`);
  }
  const positions = oriented.mesh.positions;
  const indices = oriented.mesh.indices;
  const vert = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const triCount = indices.length / 3;

  // Triangle normals and the edge -> triangles map.
  const normals: Vec3[] = [];
  const edgeTris = new Map<string, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    normals.push(unit(cross(sub(vert(b), vert(a)), sub(vert(c), vert(a)))));
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v);
      const list = edgeTris.get(k);
      if (list === undefined) edgeTris.set(k, [t]);
      else list.push(t);
    }
  }

  // Flat faces: grow from each unclaimed triangle across edges into
  // triangles in the same plane.
  const planeTol = PLANE_FRACTION * diagonal;
  const faceOf = new Int32Array(triCount).fill(-1);
  const faces: Array<{ tris: number[]; normal: Vec3; origin: Vec3 }> = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (faceOf[seed] !== -1) continue;
    const id = faces.length;
    const normal = normals[seed];
    const origin = vert(indices[seed * 3]);
    const tris = [seed];
    faceOf[seed] = id;
    for (let head = 0; head < tris.length; head++) {
      const t = tris[head];
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        for (const o of edgeTris.get(edgeKey(u, v)) ?? []) {
          if (faceOf[o] !== -1 || dot(normals[o], normal) < SAME_NORMAL_COS) continue;
          const corners = [indices[o * 3], indices[o * 3 + 1], indices[o * 3 + 2]];
          if (corners.some((vi) => Math.abs(dot(sub(vert(vi), origin), normal)) > planeTol)) continue;
          faceOf[o] = id;
          tris.push(o);
        }
      }
    }
    faces.push({ tris, normal, origin });
  }

  // Each face's boundary loops from its directed boundary half-edges: an edge
  // of one of its triangles whose other triangle belongs to another face.
  // Outward winding makes the outer loop counter-clockwise about the normal
  // and every hole clockwise - exactly the STEP bound orientation `.T.`.
  const faceLoops: number[][][] = faces.map((face, id) => {
    const next = new Map<number, number[]>();
    for (const t of face.tris) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const inside = (edgeTris.get(edgeKey(u, v)) ?? []).some((o) => o !== t && faceOf[o] === id);
        if (inside) continue;
        const list = next.get(u);
        if (list === undefined) next.set(u, [v]);
        else list.push(v);
      }
    }
    const loops: number[][] = [];
    for (const [start, ends] of next) {
      while (ends.length > 0) {
        const loop = [start];
        let cur = ends.shift() as number;
        while (cur !== start) {
          loop.push(cur);
          const outs = next.get(cur);
          if (outs === undefined || outs.length === 0) break;
          cur = outs.shift() as number;
        }
        if (loop.length >= 3) loops.push(loop);
      }
    }
    return loops;
  });

  // ---- write the STEP data section ----
  const lines: string[] = [];
  let nextId = 1;
  const add = (entity: string): number => { const id = nextId++; lines.push(`#${id}=${entity};`); return id; };
  const quoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  const point = (p: Vec3) => add(`CARTESIAN_POINT('',(${real(p[0])},${real(p[1])},${real(p[2])}))`);
  const direction = (d: Vec3) => add(`DIRECTION('',(${real(d[0])},${real(d[1])},${real(d[2])}))`);

  const vertexIds = new Map<number, number>();
  const vertexPoint = (vi: number): number => {
    let id = vertexIds.get(vi);
    if (id === undefined) {
      id = add(`VERTEX_POINT('',#${point(vert(vi))})`);
      vertexIds.set(vi, id);
    }
    return id;
  };
  // One EDGE_CURVE per mesh edge, from its lower vertex index to its higher.
  const edgeIds = new Map<string, number>();
  const edgeCurve = (a: number, b: number): { id: number; forward: boolean } => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const k = `${lo}:${hi}`;
    let id = edgeIds.get(k);
    if (id === undefined) {
      const p = vert(lo);
      const d = sub(vert(hi), p);
      const line = add(`LINE('',#${point(p)},#${add(`VECTOR('',#${direction(unit(d))},${real(length(d))})`)})`);
      id = add(`EDGE_CURVE('',#${vertexPoint(lo)},#${vertexPoint(hi)},#${line},.T.)`);
      edgeIds.set(k, id);
    }
    return { id, forward: a === lo };
  };

  const faceIds: number[] = [];
  faces.forEach((face, f) => {
    const normal = face.normal;
    const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const xDir = unit(cross(cross(normal, helper), normal));
    const plane = add(`PLANE('',#${add(`AXIS2_PLACEMENT_3D('',#${point(face.origin)},#${direction(normal)},#${direction(xDir)})`)})`);
    const loops = faceLoops[f];
    // The outer loop is the one enclosing the most area about the normal.
    const area = (loop: number[]) => {
      let s: Vec3 = [0, 0, 0];
      for (let i = 0; i < loop.length; i++) {
        const c = cross(vert(loop[i]), vert(loop[(i + 1) % loop.length]));
        s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
      }
      return dot(s, normal) / 2;
    };
    const outer = loops.reduce((best, loop, i) => (area(loop) > area(loops[best]) ? i : best), 0);
    const bounds = loops.map((loop, i) => {
      const edges = loop.map((vi, k) => {
        const e = edgeCurve(vi, loop[(k + 1) % loop.length]);
        return `#${add(`ORIENTED_EDGE('',*,*,#${e.id},${e.forward ? '.T.' : '.F.'})`)}`;
      });
      const edgeLoop = add(`EDGE_LOOP('',(${edges.join(',')}))`);
      return `#${add(`${i === outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${edgeLoop},.T.)`)}`;
    });
    faceIds.push(add(`ADVANCED_FACE('',(${bounds.join(',')}),#${plane},.T.)`));
  });
  const shell = add(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`);
  const brep = add(`MANIFOLD_SOLID_BREP(${quoted(name)},#${shell})`);

  const context = add('APPLICATION_CONTEXT(\'automotive design\')');
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${context})`);
  const productContext = add(`PRODUCT_CONTEXT('',#${context},'mechanical')`);
  const product = add(`PRODUCT(${quoted(name)},${quoted(name)},'',(#${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${context},'design')`);
  const definition = add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
  const definitionShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  const mm = add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
  const radian = add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
  const steradian = add('( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )');
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${mm},'distance_accuracy_value','')`);
  const representationContext = add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) ` +
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${radian},#${steradian})) REPRESENTATION_CONTEXT('','') )`,
  );
  const origin = add(`AXIS2_PLACEMENT_3D('',#${point([0, 0, 0])},#${direction([0, 0, 1])},#${direction([1, 0, 0])})`);
  const representation = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${quoted(name)},(#${origin},#${brep}),#${representationContext})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${representation})`);

  const fileName = quoted(`${name}.stp`);
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('LienCAM: a closed STL mesh as a solid'),'2;1');`,
    `FILE_NAME(${fileName},'',(''),(''),'LienCAM','LienCAM','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  return { ok: true, step, faceCount: faces.length, triangleCount: triCount, notes };
}
