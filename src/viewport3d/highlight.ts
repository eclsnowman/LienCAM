// viewport3d: hover/selection highlighting via a per-vertex color-attribute
// patch, no re-tessellation (WO UI-2; docs/3d-modeling-plan.md 3.3). Colors
// are written directly onto each CachedBody's existing `geometry`/
// `edgeGeometry` BufferGeometry -- cheap because the number of triangles/edge
// segments touched per hover/select change is tiny relative to a re-tess.
//
// Body mesh vertices are per-face-unique (see fixtures.ts / geom-engine.ts
// tessellate(): each face's mesh is appended to the position array as its own
// contiguous block, never shared with a neighboring face -- confirmed by
// reading both the mock fixtures and the real GEO-1 tessellate()), so writing
// a triangle's 3 vertex colors from its faceId never bleeds into a
// differently-colored neighboring face by aliasing a shared vertex.
//
// Vertex picks return a BridgeVertexRef, not a StableId (UI-1 ruling,
// restated in the WO's binding rulings): SelectionState's public API stays
// StableId-only and is NOT changed here. A caller wanting to highlight a
// picked vertex's adjacent edges composes that from `paintEdgeColor`, calling
// it once per id in `hit.id.adjacentEdgeIds` -- see geomBridgeSession
// consumers.

import * as THREE from 'three';
import type { CachedBody } from './GeometryCache';
import type { SelectionState } from './SelectionState';
import type { HighlightKind, StableId } from './types';

export interface HighlightColorSet {
  base: readonly [number, number, number];
  hovered: readonly [number, number, number];
  selected: readonly [number, number, number];
}

/** 0-1 float RGB triples (THREE vertex-color convention). Judgment call --
 *  no existing design-token source for 3D viewport highlight colors at time
 *  of writing: neutral gray base, amber hover (CAD-common "about to select"),
 *  blue selected (CAD-common "confirmed selection", also distinct from
 *  amber for colorblind-safety). */
export const DEFAULT_HIGHLIGHT_COLORS: HighlightColorSet = {
  base: [0.8, 0.8, 0.82],
  hovered: [1.0, 0.75, 0.2],
  selected: [0.15, 0.55, 1.0],
};

/** Q-48 (2026-07-22, GEO-24 soft-studio pick, coordination/work-orders/GEO-24.md
 *  + GEO-24-R1.md): the rest-state edge overlay reads noticeably darker than the
 *  softened body base so silhouette/feature edges stay legible under the gentler
 *  soft-studio lighting -- Operator's original ask ("edges are not very visible...
 *  edges to be more visible in shaded with edges mode"). hovered/selected stay
 *  shared with DEFAULT_HIGHLIGHT_COLORS (unchanged amber/blue). */
export const DEFAULT_EDGE_HIGHLIGHT_COLORS: HighlightColorSet = {
  base: [0.28, 0.32, 0.36],
  hovered: DEFAULT_HIGHLIGHT_COLORS.hovered,
  selected: DEFAULT_HIGHLIGHT_COLORS.selected,
};

function colorFor(kind: HighlightKind, colors: HighlightColorSet): readonly [number, number, number] {
  switch (kind) {
    case 'selected':
      return colors.selected;
    case 'hovered':
      return colors.hovered;
    case 'none':
      return colors.base;
  }
}

function attachBaseColorAttribute(
  geometry: THREE.BufferGeometry,
  base: readonly [number, number, number],
): void {
  const positionAttr = geometry.getAttribute('position');
  const vertexCount = positionAttr === undefined ? 0 : positionAttr.count;
  const array = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    array[i * 3] = base[0];
    array[i * 3 + 1] = base[1];
    array[i * 3 + 2] = base[2];
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(array, 3));
}

/** Add a 'color' BufferAttribute (itemSize 3) to both `body.geometry` and
 *  `body.edgeGeometry`, sized to each geometry's own vertex count and filled
 *  with the base color. Call once per CachedBody (e.g. right after
 *  GeometryCache.ingest()) before applyFaceHighlights/applyEdgeHighlights. */
export function attachHighlightAttributes(
  body: CachedBody,
  colors: HighlightColorSet = DEFAULT_HIGHLIGHT_COLORS,
  edgeColors: HighlightColorSet = colors,
): void {
  attachBaseColorAttribute(body.geometry, colors.base);
  attachBaseColorAttribute(body.edgeGeometry, edgeColors.base);
}

function requireColorAttribute(geometry: THREE.BufferGeometry, what: string): THREE.BufferAttribute {
  const attr = geometry.getAttribute('color');
  if (attr === undefined) {
    throw new Error(`viewport3d: ${what} has no 'color' attribute -- call attachHighlightAttributes() first`);
  }
  return attr as THREE.BufferAttribute;
}

/** Repaint every triangle's 3 vertex colors from its faceId's current
 *  highlightFor() state. O(triangle count); batches the GPU upload flag to a
 *  single needsUpdate at the end. */
export function applyFaceHighlights(
  body: CachedBody,
  selection: SelectionState,
  colors: HighlightColorSet = DEFAULT_HIGHLIGHT_COLORS,
): void {
  const colorAttr = requireColorAttribute(body.geometry, 'body.geometry');
  const index = body.geometry.getIndex();
  if (index === null) {
    throw new Error('viewport3d: body.geometry has no index buffer');
  }
  const triCount = body.triFace.length;
  for (let t = 0; t < triCount; t++) {
    const faceIndex = body.triFace[t];
    const faceId = body.faceIds[faceIndex];
    const kind = selection.highlightFor(faceId);
    const [r, g, b] = colorFor(kind, colors);
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(t * 3 + k);
      colorAttr.setXYZ(vi, r, g, b);
    }
  }
  colorAttr.needsUpdate = true;
}

/** Per-edge destination vertex offsets into edgeGeometry's (non-indexed,
 *  segment-duplicated) position/color arrays -- mirrors buildEdgeLineGeometry
 *  (tessGeometry.ts)'s write order exactly (edges walked 0..edgeIds.length-1,
 *  each contributing (pointCount-1)*2 duplicated vertices), so offsets[e] is
 *  always the correct destination range for edge e regardless of how many
 *  polyline points it has. */
export function computeEdgeVertexOffsets(body: CachedBody): Uint32Array {
  const { edgeOffsets, edgeIds } = body;
  const offsets = new Uint32Array(edgeIds.length + 1);
  let w = 0;
  for (let e = 0; e < edgeIds.length; e++) {
    offsets[e] = w;
    const start = edgeOffsets[e];
    const end = edgeOffsets[e + 1];
    const segmentCount = end > start + 1 ? end - start - 1 : 0;
    w += segmentCount * 2;
  }
  offsets[edgeIds.length] = w;
  return offsets;
}

/** Repaint every edge's segment colors from its edgeId's current
 *  highlightFor() state. */
export function applyEdgeHighlights(
  body: CachedBody,
  selection: SelectionState,
  colors: HighlightColorSet = DEFAULT_HIGHLIGHT_COLORS,
): void {
  const colorAttr = requireColorAttribute(body.edgeGeometry, 'body.edgeGeometry');
  const offsets = computeEdgeVertexOffsets(body);
  for (let e = 0; e < body.edgeIds.length; e++) {
    const kind = selection.highlightFor(body.edgeIds[e]);
    const [r, g, b] = colorFor(kind, colors);
    for (let vi = offsets[e]; vi < offsets[e + 1]; vi++) colorAttr.setXYZ(vi, r, g, b);
  }
  colorAttr.needsUpdate = true;
}

/** Tint an ENTIRE body's mesh + edges to one flat color (WO INT-1-R1.1).
 *  Body-kind hover/select has no per-face/edge StableId to key off (BodyId
 *  is not a StableId -- see types.ts) so unlike applyFaceHighlights/
 *  applyEdgeHighlights, which read per-id state from SelectionState, this
 *  paints every vertex the SAME color unconditionally. Callers only invoke
 *  this for 'hovered'/'selected' -- there is no 'none' case because
 *  reverting to "not body-highlighted" just means NOT calling this at all
 *  (the caller's own applyFaceHighlights/applyEdgeHighlights pass already
 *  repainted every vertex from its per-id state). */
export function applyBodyHighlight(
  body: CachedBody,
  kind: 'hovered' | 'selected',
  colors: HighlightColorSet = DEFAULT_HIGHLIGHT_COLORS,
): void {
  const color = kind === 'selected' ? colors.selected : colors.hovered;

  const geomColorAttr = requireColorAttribute(body.geometry, 'body.geometry');
  for (let i = 0; i < geomColorAttr.count; i++) geomColorAttr.setXYZ(i, color[0], color[1], color[2]);
  geomColorAttr.needsUpdate = true;

  const edgeColorAttr = requireColorAttribute(body.edgeGeometry, 'body.edgeGeometry');
  for (let i = 0; i < edgeColorAttr.count; i++) edgeColorAttr.setXYZ(i, color[0], color[1], color[2]);
  edgeColorAttr.needsUpdate = true;
}

/** Lower-level primitive: color just the segments belonging to one edge id,
 *  bypassing SelectionState entirely. Used by applyEdgeHighlights (via the
 *  loop above) and directly by callers highlighting a picked vertex's
 *  adjacent edges (BridgeVertexRef.adjacentEdgeIds are edge StableIds, but a
 *  BridgeVertexRef itself is NOT a StableId and can't go through
 *  SelectionState -- see this file's header). No-op if `edgeId` isn't present
 *  on this body. */
export function paintEdgeColor(
  body: CachedBody,
  edgeId: StableId,
  color: readonly [number, number, number],
): void {
  const colorAttr = requireColorAttribute(body.edgeGeometry, 'body.edgeGeometry');
  const edgeIndex = body.edgeIds.indexOf(edgeId);
  if (edgeIndex === -1) return;
  const offsets = computeEdgeVertexOffsets(body);
  const start = offsets[edgeIndex];
  const end = offsets[edgeIndex + 1];
  for (let vi = start; vi < end; vi++) colorAttr.setXYZ(vi, color[0], color[1], color[2]);
  colorAttr.needsUpdate = true;
}
