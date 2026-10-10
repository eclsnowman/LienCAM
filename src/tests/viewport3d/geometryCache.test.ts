// viewport3d GeometryCache: attribute wiring + disposal discipline (AC1).

import { describe, expect, it, vi } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { makeBoxFixture } from './fixtures';

describe('GeometryCache', () => {
  it('wires TessBuffers onto BufferGeometry attributes zero-copy, with correct item sizes', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const entry = cache.ingest('body-1', buffers);

    const position = entry.geometry.getAttribute('position');
    const normal = entry.geometry.getAttribute('normal');
    const index = entry.geometry.getIndex();

    expect(position.itemSize).toBe(3);
    expect(normal.itemSize).toBe(3);
    expect(index?.itemSize).toBe(1);
    // Transferable buffers: same underlying typed array, not a copy.
    expect(position.array).toBe(buffers.position);
    expect(normal.array).toBe(buffers.normal);
    expect(index?.array).toBe(buffers.index);

    // Edge line geometry duplicates shared interior points per segment, so
    // it can't alias edgePositions 1:1 -- it's a copy, not a transferable.
    // On this fixture every edge is a single 2-point segment, so the copy's
    // *values* still line up 1:1 with the source polyline data.
    const edgePositionAttr = entry.edgeGeometry.getAttribute('position');
    expect(edgePositionAttr.array).not.toBe(buffers.edgePositions);
    expect(Array.from(edgePositionAttr.array)).toEqual(Array.from(buffers.edgePositions));

    expect(entry.triFace).toBe(buffers.triFace);
    expect(entry.faceIds).toEqual(buffers.faceIds);
  });

  it('has an empty (not null) edge geometry when the body has no edge polylines', () => {
    const { buffers } = makeBoxFixture();
    const noEdges = { ...buffers, edgeIds: [], edgeOffsets: new Uint32Array([0]), edgePositions: new Float32Array(0) };
    const cache = new GeometryCache();
    const entry = cache.ingest('body-1', noEdges);
    expect(entry.edgeGeometry).toBeDefined();
    expect(entry.edgeGeometry.getAttribute('position').count).toBe(0);
  });

  it('fails loud on malformed TessBuffers instead of ingesting a half-wired geometry', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const badIndex = { ...buffers, index: buffers.index.map((v, i) => (i === 0 ? 9999 : v)) };
    expect(() => cache.ingest('body-1', badIndex)).toThrow(/out of range/);
    expect(cache.get('body-1')).toBeUndefined();
  });

  it('re-ingesting the same bodyId disposes the prior geometry (no leak) and bumps version', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const first = cache.ingest('body-1', buffers);
    const disposeSpy = vi.spyOn(first.geometry, 'dispose');
    const edgeDisposeSpy = vi.spyOn(first.edgeGeometry, 'dispose');

    const second = cache.ingest('body-1', buffers);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(edgeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.version).toBe(first.version + 1);
    expect(cache.get('body-1')).toBe(second);
  });

  it('prepare() leaves the live entry and generation untouched until adoption', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const live = cache.ingest('body-1', buffers);
    const liveDisposeSpy = vi.spyOn(live.geometry, 'dispose');
    const liveEdgeDisposeSpy = vi.spyOn(live.edgeGeometry, 'dispose');

    const prepared = cache.prepare('body-1', buffers);

    expect(cache.get('body-1')).toBe(live);
    expect(prepared.version).toBe(live.version + 1);
    expect(liveDisposeSpy).not.toHaveBeenCalled();
    expect(liveEdgeDisposeSpy).not.toHaveBeenCalled();
  });

  it('disposePrepared() releases an unadopted entry exactly once without touching live state', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const live = cache.ingest('body-1', buffers);
    const prepared = cache.prepare('body-1', buffers);
    const geometryDisposeSpy = vi.spyOn(prepared.geometry, 'dispose');
    const edgeDisposeSpy = vi.spyOn(prepared.edgeGeometry, 'dispose');

    cache.disposePrepared(prepared);
    cache.disposePrepared(prepared);

    expect(geometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(edgeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(cache.get('body-1')).toBe(live);
  });

  it('adoptPrepared() publishes the exact staged geometry/BVH then disposes the prior entry once', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const live = cache.ingest('body-1', buffers);
    const liveDisposeSpy = vi.spyOn(live.geometry, 'dispose');
    const liveEdgeDisposeSpy = vi.spyOn(live.edgeGeometry, 'dispose');
    const prepared = cache.prepare('body-1', buffers);
    const preparedGeometryDisposeSpy = vi.spyOn(prepared.geometry, 'dispose');

    const adopted = cache.adoptPrepared(prepared);
    cache.disposePrepared(prepared);

    expect(adopted).toBe(prepared);
    expect(cache.get('body-1')).toBe(prepared);
    expect(adopted.geometry).toBe(prepared.geometry);
    expect(adopted.bvh).toBe(prepared.bvh);
    expect(liveDisposeSpy).toHaveBeenCalledTimes(1);
    expect(liveEdgeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(preparedGeometryDisposeSpy).not.toHaveBeenCalled();
  });

  it('batch prepared adoption rolls every body back to exact entry and generation identity', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const liveA = cache.ingest('a', buffers);
    const liveB = cache.ingest('b', buffers);
    const nextA = cache.prepare('a', buffers);
    const nextB = cache.prepare('b', buffers);
    const nextADispose = vi.spyOn(nextA.geometry, 'dispose');
    const nextBDispose = vi.spyOn(nextB.geometry, 'dispose');

    const transaction = cache.beginPreparedAdoption([nextA, nextB]);
    expect(cache.get('a')).toBe(nextA);
    expect(cache.get('b')).toBe(nextB);
    transaction.rollback();

    expect(cache.get('a')).toBe(liveA);
    expect(cache.get('b')).toBe(liveB);
    expect(nextADispose).toHaveBeenCalledTimes(1);
    expect(nextBDispose).toHaveBeenCalledTimes(1);
    const retryA = cache.prepare('a', buffers);
    const retryB = cache.prepare('b', buffers);
    expect(retryA.version).toBe(nextA.version);
    expect(retryB.version).toBe(nextB.version);
    cache.disposePrepared(retryA);
    cache.disposePrepared(retryB);
  });

  it('batch prepared adoption commits all bodies before disposing prior entries', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const liveA = cache.ingest('a', buffers);
    const liveB = cache.ingest('b', buffers);
    const liveADispose = vi.spyOn(liveA.geometry, 'dispose');
    const liveBDispose = vi.spyOn(liveB.geometry, 'dispose');
    const nextA = cache.prepare('a', buffers);
    const nextB = cache.prepare('b', buffers);

    const transaction = cache.beginPreparedAdoption([nextA, nextB]);
    expect(liveADispose).not.toHaveBeenCalled();
    expect(liveBDispose).not.toHaveBeenCalled();
    transaction.commit();

    expect(cache.get('a')).toBe(nextA);
    expect(cache.get('b')).toBe(nextB);
    expect(liveADispose).toHaveBeenCalledTimes(1);
    expect(liveBDispose).toHaveBeenCalledTimes(1);
  });

  it('restoreRetained() restores exact entry/version/BVH identity after preview replacement', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const committed = cache.ingest('body-1', buffers);
    const committedDisposeSpy = vi.spyOn(committed.geometry, 'dispose');
    const token = cache.retain('body-1');
    expect(token).toBeDefined();

    const preview = cache.ingest('body-1', buffers);
    const previewDisposeSpy = vi.spyOn(preview.geometry, 'dispose');

    expect(committedDisposeSpy).not.toHaveBeenCalled();
    expect(cache.get('body-1')).toBe(preview);
    const restored = cache.restoreRetained(token!);

    expect(restored).toBe(committed);
    expect(restored.version).toBe(committed.version);
    expect(restored.geometry).toBe(committed.geometry);
    expect(restored.edgeGeometry).toBe(committed.edgeGeometry);
    expect(restored.bvh).toBe(committed.bvh);
    expect(cache.get('body-1')).toBe(committed);
    expect(previewDisposeSpy).toHaveBeenCalledTimes(1);
    expect(committedDisposeSpy).not.toHaveBeenCalled();
    const next = cache.prepare('body-1', buffers);
    expect(next.version).toBe(preview.version + 1);
    cache.disposePrepared(next);
  });

  it('releaseRetained() keeps the preview replacement and disposes the superseded entry once', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const committed = cache.ingest('body-1', buffers);
    const committedDisposeSpy = vi.spyOn(committed.geometry, 'dispose');
    const token = cache.retain('body-1')!;
    const preview = cache.ingest('body-1', buffers);

    cache.releaseRetained(token);

    expect(cache.get('body-1')).toBe(preview);
    expect(committedDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects stale prepared adoption without replacing or disposing the live entry', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const first = cache.prepare('body-1', buffers);
    const stale = cache.prepare('body-1', buffers);
    cache.adoptPrepared(first);
    const liveDisposeSpy = vi.spyOn(first.geometry, 'dispose');
    const staleDisposeSpy = vi.spyOn(stale.geometry, 'dispose');

    expect(() => cache.adoptPrepared(stale)).toThrow(/is stale/);
    expect(cache.get('body-1')).toBe(first);
    expect(liveDisposeSpy).not.toHaveBeenCalled();

    cache.disposePrepared(stale);
    expect(staleDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('evict() disposes and removes the entry; get() returns undefined after', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const entry = cache.ingest('body-1', buffers);
    const disposeSpy = vi.spyOn(entry.geometry, 'dispose');

    cache.evict('body-1');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(cache.get('body-1')).toBeUndefined();
    expect(cache.has('body-1')).toBe(false);
  });

  it('evict() on an unknown bodyId is a safe no-op', () => {
    const cache = new GeometryCache();
    expect(() => cache.evict('nope')).not.toThrow();
  });

  it('disposeAll() disposes every live entry', () => {
    const { buffers } = makeBoxFixture();
    const cache = new GeometryCache();
    const a = cache.ingest('a', buffers);
    const b = cache.ingest('b', buffers);
    const spyA = vi.spyOn(a.geometry, 'dispose');
    const spyB = vi.spyOn(b.geometry, 'dispose');

    cache.disposeAll();

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
