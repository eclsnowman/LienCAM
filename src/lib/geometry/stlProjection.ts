import type { Loop2D, Layer2D } from '../../types'
import { assignStableLoopIds } from './loopId'

// ── Snap helpers ──────────────────────────────────────────────────────────────
const SNAP = 0.01  // 10 microns

function sk(x: number, y: number) {
  return `${Math.round(x / SNAP)},${Math.round(y / SNAP)}`
}
function snapped(x: number, y: number) {
  return { x: Math.round(x / SNAP) * SNAP, y: Math.round(y / SNAP) * SNAP }
}

// ── Slice-plane cross-section ─────────────────────────────────────────────────
// Intersects each triangle with the Z=sliceZ plane.
// Returns XY line segments wherever the plane cuts through the mesh.
// This is the slicer approach: every region transition (solid→void) appears as
// a closed loop, capturing outer contours AND internal holes correctly.
//
// A vertex exactly on the plane counts as BELOW it, so every vertex is on one
// side or the other and a section at exactly h is the section a hair above h
// (a removal ceiling, ridge or pocket floor at h included). Each triangle with
// vertices on both sides then yields exactly one segment, and a shared edge's
// crossing is computed from its below-endpoint in both triangles, so a closed
// mesh always chains into closed loops. Zero-length segments (a vertex on the
// plane) are dropped; that keeps every chain vertex at even degree.
function sliceAtZ(
  pos: Float32Array,
  idx: Uint32Array | Uint16Array | null,
  sliceZ: number
): Array<[{x:number,y:number},{x:number,y:number}]> {
  const result: Array<[{x:number,y:number},{x:number,y:number}]> = []

  const below = (v: number) => pos[v*3+2] <= sliceZ
  // lo is below the plane, hi above it
  const crossing = (lo: number, hi: number) => {
    const lz = pos[lo*3+2]
    const t = (sliceZ - lz) / (pos[hi*3+2] - lz)
    return snapped(pos[lo*3] + t*(pos[hi*3]-pos[lo*3]), pos[lo*3+1] + t*(pos[hi*3+1]-pos[lo*3+1]))
  }

  const processTriangle = (ai: number, bi: number, ci: number) => {
    const a = below(ai), b = below(bi), c = below(ci)
    if (a === b && b === c) return
    // The vertex alone on its side; both edges leaving it cross the plane
    const [lone, o1, o2] = a === b ? [ci, ai, bi] : a === c ? [bi, ci, ai] : [ai, bi, ci]
    const p = below(lone) ? crossing(lone, o1) : crossing(o1, lone)
    const q = below(lone) ? crossing(lone, o2) : crossing(o2, lone)
    if (sk(p.x,p.y) !== sk(q.x,q.y)) result.push([p, q])
  }

  if (idx) {
    for (let i=0;i<idx.length;i+=3) processTriangle(idx[i],idx[i+1],idx[i+2])
  } else {
    const n = pos.length/3
    for (let i=0;i<n;i+=3) processTriangle(i,i+1,i+2)
  }

  return result
}

// ── Loop building ─────────────────────────────────────────────────────────────
function buildLoops(segs: Array<[{x:number,y:number},{x:number,y:number}]>): {x:number,y:number}[][] {
  const eFrom: string[]=[], eTo: string[]=[], eUsed: boolean[]=[]
  const vEdges = new Map<string, number[]>()
  const vPts   = new Map<string, {x:number,y:number}>()

  for (const [p1,p2] of segs) {
    const k1=sk(p1.x,p1.y), k2=sk(p2.x,p2.y)
    if (k1===k2) continue
    vPts.set(k1,p1); vPts.set(k2,p2)
    const ei=eFrom.length
    eFrom.push(k1); eTo.push(k2); eUsed.push(false)
    if (!vEdges.has(k1)) vEdges.set(k1,[])
    if (!vEdges.has(k2)) vEdges.set(k2,[])
    vEdges.get(k1)!.push(ei)
    vEdges.get(k2)!.push(ei)
  }

  const getOther=(ei:number,curr:string)=>eFrom[ei]===curr?eTo[ei]:eFrom[ei]

  const loops: {x:number,y:number}[][] = []
  for (let si=0;si<eFrom.length;si++) {
    if (eUsed[si]) continue
    eUsed[si]=true
    const startKey=eFrom[si]
    const chain: {x:number,y:number}[]=[vPts.get(startKey)!, vPts.get(eTo[si])!]
    let curr=eTo[si]
    while (chain.length<200000) {
      const nbrs=vEdges.get(curr)??[]
      const nextEi=nbrs.find(ei=>!eUsed[ei])
      if (nextEi===undefined) break
      eUsed[nextEi]=true
      const nextKey=getOther(nextEi,curr)
      if (nextKey===startKey) { loops.push(chain); break }
      chain.push(vPts.get(nextKey)!)
      curr=nextKey
    }
  }
  return loops
}

// ── Douglas-Peucker ──────────────────────────────────────────────────────────
function perpDist(p:{x:number,y:number}, a:{x:number,y:number}, b:{x:number,y:number}): number {
  const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy
  if (len2===0) return Math.hypot(p.x-a.x, p.y-a.y)
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2))
  return Math.hypot(p.x-a.x-t*dx, p.y-a.y-t*dy)
}
function dp(pts:{x:number,y:number}[], tol:number): {x:number,y:number}[] {
  if (pts.length<=2) return pts
  let max=0, idx=0
  for (let i=1;i<pts.length-1;i++) { const d=perpDist(pts[i],pts[0],pts[pts.length-1]); if(d>max){max=d;idx=i} }
  if (max>tol) return [...dp(pts.slice(0,idx+1),tol).slice(0,-1), ...dp(pts.slice(idx),tol)]
  return [pts[0], pts[pts.length-1]]
}

// ── Signed area (shoelace) ───────────────────────────────────────────────────
function signedArea(pts:{x:number,y:number}[]): number {
  let a=0; const n=pts.length
  for (let i=0;i<n;i++){const j=(i+1)%n; a+=pts[i].x*pts[j].y-pts[j].x*pts[i].y}
  return a/2
}

// WO-2935: buildLoops chains UNDIRECTED edges. Its winding says nothing about
// solid versus void. Use the same strict-area / first-vertex containment parity
// as path2d.ts: exterior, hole, island, hole. Do not reverse or re-order points
// (their coordinates, signed-content IDs and projection frame must stay intact).
function classifyByContainment(loops: Loop2D[]): Loop2D[] {
  const inside = (point: { x: number; y: number }, polygon: Loop2D['points']) => {
    let contains = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j]
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) contains = !contains
    }
    return contains
  }
  return loops.map(loop => {
    const depth = loops.reduce((count, other) => count + (
      other.area > loop.area && inside(loop.points[0], other.points) ? 1 : 0
    ), 0)
    return { ...loop, type: depth % 2 === 0 ? 'contour' : 'hole' }
  })
}

// ── Public API ───────────────────────────────────────────────────────────────
// `dp` (Douglas-Peucker simplification) exported alongside sliceAtZ/buildLoops
// for CAM-BINDING Stage 5 (modelBodyDerive.ts's deriveModelBodyFace): a
// boundary-of-triangle-subset trace needs the SAME simplification pass this
// module already applies to a slice, and the repo's own "port, don't
// re-derive" convention says reuse this proven implementation rather than
// write a second Douglas-Peucker.
export { sliceAtZ, buildLoops, dp }
export interface ProjectionOptions { simplificationTolerance: number; minPerimeter: number; sliceZ?: number }

// ── Plane-frame helpers (no THREE dependency) ────────────────────────────────
type V3 = { x: number; y: number; z: number }
const v3cross = (a: V3, b: V3): V3 => ({ x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x })
const v3norm  = (v: V3): V3 => { const l = Math.sqrt(v.x**2+v.y**2+v.z**2); return l<1e-10?{x:0,y:0,z:1}:{x:v.x/l,y:v.y/l,z:v.z/l} }

/** Orthonormal 2-D frame whose Z is the given unit normal. */
export interface PlaneFrame {
  origin: V3
  xAxis:  V3
  yAxis:  V3
  normal: V3
}

/** Build consistent X/Y axes perpendicular to a given (unit) normal. */
export function buildPlaneFrame(N: V3): { xAxis: V3; yAxis: V3 } {
  const n = v3norm(N)
  const temp = Math.abs(n.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const X = v3norm(v3cross(temp, n))
  const Y = v3norm(v3cross(n, X))
  return { xAxis: X, yAxis: Y }
}

/**
 * Slice a mesh (flat non-indexed world-space Float32Array, 9 values per triangle)
 * with an arbitrary plane defined by normal N, origin O, and frame axes X/Y.
 * Returns 2-D line segments in the plane's (u, v) coordinate frame.
 */
export function sliceAtPlane(
  worldPos: Float32Array,
  N: V3, O: V3, X: V3, Y: V3
): Array<[{ x: number; y: number }, { x: number; y: number }]> {
  const result: Array<[{ x: number; y: number }, { x: number; y: number }]> = []

  const project = (vx: number, vy: number, vz: number) => {
    const dx = vx-O.x, dy = vy-O.y, dz = vz-O.z
    return { z: dx*N.x+dy*N.y+dz*N.z, u: dx*X.x+dy*X.y+dz*X.z, v: dx*Y.x+dy*Y.y+dz*Y.z }
  }

  const triCount = Math.floor(worldPos.length / 9)
  for (let t = 0; t < triCount; t++) {
    const b = t * 9
    const pa = project(worldPos[b],   worldPos[b+1], worldPos[b+2])
    const pb = project(worldPos[b+3], worldPos[b+4], worldPos[b+5])
    const pc = project(worldPos[b+6], worldPos[b+7], worldPos[b+8])
    const verts = [pa, pb, pc]
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < 3; i++) {
      const p1 = verts[i], p2 = verts[(i+1)%3]
      if (p1.z * p2.z < 0) {
        const t2 = p1.z / (p1.z - p2.z)
        pts.push(snapped(p1.u + t2*(p2.u-p1.u), p1.v + t2*(p2.v-p1.v)))
      }
    }
    if (pts.length === 2 && sk(pts[0].x,pts[0].y) !== sk(pts[1].x,pts[1].y)) {
      result.push([pts[0], pts[1]])
    }
  }
  return result
}

export interface PlaneProjectionOptions {
  simplificationTolerance: number
  minPerimeter: number
  planeNormal: V3
  planeOrigin: V3
}

/**
 * Project world-space STL triangles (flat non-indexed Float32Array) onto an
 * arbitrary plane.  Returns 2-D loops in the plane frame + the frame itself.
 */
export function projectSTLToLoopsInPlane(
  worldPos: Float32Array,
  options: PlaneProjectionOptions
): { loops: Loop2D[]; layers: Layer2D[]; frame: PlaneFrame } {
  const N = v3norm(options.planeNormal)
  const { xAxis, yAxis } = buildPlaneFrame(N)
  const frame: PlaneFrame = { origin: options.planeOrigin, xAxis, yAxis, normal: N }

  const segs = sliceAtPlane(worldPos, N, options.planeOrigin, xAxis, yAxis)
  if (!segs.length) return { loops: [], layers: [], frame }

  const rawLoops = buildLoops(segs)
  const result: Loop2D[] = []

  for (const raw of rawLoops) {
    if (raw.length < 3) continue
    const simplified = dp(raw, options.simplificationTolerance)
    if (simplified.length < 3) continue
    const perim = simplified.reduce((s,p,i)=>{ const n=simplified[(i+1)%simplified.length]; return s+Math.hypot(n.x-p.x,n.y-p.y) },0)
    if (perim < options.minPerimeter) continue
    const area = signedArea(simplified)
    result.push({
      // Stable content-derived id stamped below; placeholder recomputed.
      id: '',
      points: simplified.map(p=>({x:p.x,y:p.y})),
      closed: true,
      type: 'contour', // placeholder; containment below is authoritative
      layerId: PROJ_LAYER_ID,
      area: Math.abs(area),
    })
  }

  return {
    loops: assignStableLoopIds(classifyByContainment(result)),
    layers: [{ id: PROJ_LAYER_ID, name: 'STL Projection', color: '#00e5ff', visible: true }],
    frame,
  }
}

const PROJ_LAYER_ID = 'stl_proj_layer'

export function projectSTLToLoops(
  posArray: Float32Array,
  indexArray: Uint32Array | Uint16Array | null,
  options: ProjectionOptions
): { loops: Loop2D[]; layers: Layer2D[] } {
  // Find the Z extent of the mesh in local space
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 2; i < posArray.length; i += 3) {
    if (posArray[i] < minZ) minZ = posArray[i]
    if (posArray[i] > maxZ) maxZ = posArray[i]
  }
  if (!isFinite(minZ) || maxZ <= minZ) return { loops:[], layers:[] }

  // Use caller-supplied sliceZ or default to 0.1% above the bottom face
  const sliceZ = options.sliceZ ?? (minZ + (maxZ - minZ) * 0.001)

  const segs = sliceAtZ(posArray, indexArray, sliceZ)
  if (!segs.length) return { loops:[], layers:[] }

  const rawLoops = buildLoops(segs)
  const result: Loop2D[] = []

  for (const raw of rawLoops) {
    if (raw.length < 3) continue
    const simplified = dp(raw, options.simplificationTolerance)
    if (simplified.length < 3) continue
    const perim = simplified.reduce((s,p,i)=>{const n=simplified[(i+1)%simplified.length]; return s+Math.hypot(n.x-p.x,n.y-p.y)},0)
    if (perim < options.minPerimeter) continue
    const area = signedArea(simplified)
    result.push({
      // Stable content-derived id stamped below; placeholder recomputed.
      id: '',
      points: simplified.map(p=>({x:p.x,y:p.y})),
      closed: true,
      type: 'contour', // placeholder; containment below is authoritative
      layerId: PROJ_LAYER_ID,
      area: Math.abs(area),
    })
  }

  return {
    loops: assignStableLoopIds(classifyByContainment(result)),
    layers: [{ id: PROJ_LAYER_ID, name: 'STL Projection', color: '#00e5ff', visible: true }],
  }
}
