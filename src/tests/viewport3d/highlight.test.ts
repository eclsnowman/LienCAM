// viewport3d highlight: per-vertex color-attribute patch for hover/selection,
// no re-tessellation (WO UI-2, docs/3d-modeling-plan.md 3.3). No kernel --
// mock TessBuffers via viewport3d/fixtures.ts's box (6 faces x 4 unique
// vertices each = faceIndex j owns geometry vertices [j*4, j*4+4); 12 edges x
// 1 segment (2 pts) each = edge index e owns edgeGeometry vertices
// [e*2, e*2+2) -- verified by reading fixtures.ts's per-face/per-edge push
// order before relying on it here).

import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry } from 'three';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { SelectionState } from '../../viewport3d/SelectionState';
import {
  applyEdgeHighlights,
  applyFaceHighlights,
  attachHighlightAttributes,
  paintEdgeColor,
  DEFAULT_HIGHLIGHT_COLORS,
} from '../../viewport3d/highlight';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';

const BODY_ID = 'box-1';

function ingestBox() {
  const cache = new GeometryCache();
  const body = cache.ingest(BODY_ID, makeBoxTessBuffers());
  return { cache, body };
}

function readColor(attr: BufferAttribute, i: number): [number, number, number] {
  return [attr.getX(i), attr.getY(i), attr.getZ(i)];
}

/** Fixture geometries only ever carry plain (non-interleaved) attributes;
 *  this narrows getAttribute()'s BufferAttribute|InterleavedBufferAttribute
 *  return type for test readability. */
function attr(geometry: BufferGeometry, name: string): BufferAttribute {
  return geometry.getAttribute(name) as BufferAttribute;
}

/** Color attributes are backed by Float32Array, so a value written as e.g.
 *  0.82 reads back as 0.8199999928474426 -- compare component-wise with
 *  tolerance rather than exact array equality. */
function expectColorAt(colorAttr: BufferAttribute, vertexIndex: number, expected: readonly [number, number, number]): void {
  const [r, g, b] = readColor(colorAttr, vertexIndex);
  expect(r).toBeCloseTo(expected[0], 5);
  expect(g).toBeCloseTo(expected[1], 5);
  expect(b).toBeCloseTo(expected[2], 5);
}

describe('attachHighlightAttributes', () => {
  it('adds a color attribute sized to each geometry\'s own vertex count, filled with base', () => {
    const { body } = ingestBox();
    attachHighlightAttributes(body);

    const faceColor = attr(body.geometry, 'color');
    const facePosition = attr(body.geometry, 'position');
    expect(faceColor.itemSize).toBe(3);
    expect(faceColor.count).toBe(facePosition.count);
    for (let i = 0; i < faceColor.count; i++) {
      expectColorAt(faceColor, i, DEFAULT_HIGHLIGHT_COLORS.base);
    }

    const edgeColor = attr(body.edgeGeometry, 'color');
    const edgePosition = attr(body.edgeGeometry, 'position');
    expect(edgeColor.itemSize).toBe(3);
    expect(edgeColor.count).toBe(edgePosition.count);
    for (let i = 0; i < edgeColor.count; i++) {
      expectColorAt(edgeColor, i, DEFAULT_HIGHLIGHT_COLORS.base);
    }
  });
});

describe('applyFaceHighlights', () => {
  it('colors only the selected/hovered faces\' vertices; every other face stays base', () => {
    const { body } = ingestBox();
    attachHighlightAttributes(body);
    const selection = new SelectionState();
    selection.select(body.faceIds[0]);
    selection.setHover(body.faceIds[1]);

    const versionBefore = attr(body.geometry, 'color').version;
    applyFaceHighlights(body, selection);

    const color = attr(body.geometry, 'color');
    // BufferAttribute.needsUpdate is a write-only accessor (reading it back
    // is always undefined in three.js) -- version bumping is the actual,
    // readable proof that needsUpdate=true ran.
    expect(color.version).toBeGreaterThan(versionBefore);
    for (let vi = 0; vi < 4; vi++) expectColorAt(color, vi, DEFAULT_HIGHLIGHT_COLORS.selected);
    for (let vi = 4; vi < 8; vi++) expectColorAt(color, vi, DEFAULT_HIGHLIGHT_COLORS.hovered);
    for (let vi = 8; vi < attr(body.geometry, 'position').count; vi++) {
      expectColorAt(color, vi, DEFAULT_HIGHLIGHT_COLORS.base);
    }
  });

  it('throws a clear error if attachHighlightAttributes has not run yet', () => {
    const { body } = ingestBox();
    const selection = new SelectionState();
    expect(() => applyFaceHighlights(body, selection)).toThrow(/attachHighlightAttributes/);
  });
});

describe('applyEdgeHighlights', () => {
  it('colors only the selected/hovered edges\' segments; every other edge stays base', () => {
    const { body } = ingestBox();
    attachHighlightAttributes(body);
    const selection = new SelectionState();
    selection.select(body.edgeIds[0]);
    selection.setHover(body.edgeIds[1]);

    const versionBefore = attr(body.edgeGeometry, 'color').version;
    applyEdgeHighlights(body, selection);

    const color = attr(body.edgeGeometry, 'color');
    expect(color.version).toBeGreaterThan(versionBefore);
    expectColorAt(color, 0, DEFAULT_HIGHLIGHT_COLORS.selected);
    expectColorAt(color, 1, DEFAULT_HIGHLIGHT_COLORS.selected);
    expectColorAt(color, 2, DEFAULT_HIGHLIGHT_COLORS.hovered);
    expectColorAt(color, 3, DEFAULT_HIGHLIGHT_COLORS.hovered);
    for (let vi = 4; vi < color.count; vi++) {
      expectColorAt(color, vi, DEFAULT_HIGHLIGHT_COLORS.base);
    }
  });

  it('throws a clear error if attachHighlightAttributes has not run yet', () => {
    const { body } = ingestBox();
    const selection = new SelectionState();
    expect(() => applyEdgeHighlights(body, selection)).toThrow(/attachHighlightAttributes/);
  });
});

describe('paintEdgeColor', () => {
  it('colors only the given edge\'s segments, leaving every other edge untouched', () => {
    const { body } = ingestBox();
    attachHighlightAttributes(body);

    const versionBefore = attr(body.edgeGeometry, 'color').version;
    paintEdgeColor(body, body.edgeIds[3], [0, 1, 0]);

    const color = attr(body.edgeGeometry, 'color');
    expect(color.version).toBeGreaterThan(versionBefore);
    expectColorAt(color, 6, [0, 1, 0]);
    expectColorAt(color, 7, [0, 1, 0]);
    for (const vi of [0, 1, 2, 3, 4, 5, 8, 9]) {
      expectColorAt(color, vi, DEFAULT_HIGHLIGHT_COLORS.base);
    }
  });

  it('is a safe no-op for an unknown edge id', () => {
    const { body } = ingestBox();
    attachHighlightAttributes(body);
    const before = Array.from(attr(body.edgeGeometry, 'color').array);

    expect(() => paintEdgeColor(body, 'not-a-real-edge-id', [0, 1, 0])).not.toThrow();

    const after = Array.from(attr(body.edgeGeometry, 'color').array);
    expect(after).toEqual(before);
  });

  it('throws a clear error if attachHighlightAttributes has not run yet', () => {
    const { body } = ingestBox();
    expect(() => paintEdgeColor(body, body.edgeIds[0], [0, 1, 0])).toThrow(/attachHighlightAttributes/);
  });
});
