// viewport3d progressiveTessellate: two-phase coarse->display sequencing and
// no-leak cache reuse (WO UI-2 acceptance #2). Fake client, no real kernel --
// distinguishable fixtures for the two tiers (different featureId -> distinct
// faceIds) so a wrong-buffers-landed bug would show up as a wrong faceId
// prefix, not just a silent pass.

import { describe, expect, it, vi } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import {
  progressiveTessellate,
  type TessellatingClient,
  type TessPaintPhase,
} from '../../viewport3d/progressiveTessellate';
import { COARSE_TESS_QUALITY, DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';
import type { BodyHandle, TessBuffers, TessQuality } from '../../geom/geom-service';

const FAKE_HANDLE = 1 as BodyHandle;

function makeFakeClient(coarse: TessBuffers, display: TessBuffers): TessellatingClient & { calls: TessQuality[] } {
  const calls: TessQuality[] = [];
  return {
    calls,
    tessellate: async (handle: BodyHandle, quality: TessQuality): Promise<TessBuffers> => {
      expect(handle).toBe(FAKE_HANDLE);
      calls.push(quality);
      return quality === COARSE_TESS_QUALITY ? coarse : display;
    },
  };
}

describe('progressiveTessellate', () => {
  it('tessellates coarse then display, in that order, ingesting both under the same bodyId', async () => {
    const coarse = makeBoxTessBuffers({ featureId: 'COARSE' });
    const display = makeBoxTessBuffers({ featureId: 'DISPLAY' });
    const client = makeFakeClient(coarse, display);
    const cache = new GeometryCache();

    const paints: TessPaintPhase[] = [];
    const result = await progressiveTessellate(client, cache, 'body-1', FAKE_HANDLE, (phase) => {
      paints.push(phase);
    });

    expect(paints).toEqual(['coarse', 'display']);
    expect(client.calls).toEqual([COARSE_TESS_QUALITY, DISPLAY_TESS_QUALITY]);
    expect(result.coarse.faceIds[0]).toBe('COARSE:BOX:face#0');
    expect(result.display.faceIds[0]).toBe('DISPLAY:BOX:face#0');
    // The cache's live entry for this bodyId is the DISPLAY tier, not coarse.
    expect(cache.get('body-1')).toBe(result.display);
  });

  it('disposes the coarse tier exactly once when the display tier lands (cache reuse, not a leak)', async () => {
    const coarse = makeBoxTessBuffers({ featureId: 'COARSE' });
    const display = makeBoxTessBuffers({ featureId: 'DISPLAY' });
    const client = makeFakeClient(coarse, display);
    const cache = new GeometryCache();

    let coarseDisposeSpy: ReturnType<typeof vi.spyOn> | undefined;
    let coarseEdgeDisposeSpy: ReturnType<typeof vi.spyOn> | undefined;

    await progressiveTessellate(client, cache, 'body-1', FAKE_HANDLE, (phase, body) => {
      if (phase === 'coarse') {
        // Attach spies right after the coarse tier lands, before the display
        // tier's ingest() disposes it -- mirrors geometryCache.test.ts's
        // dispose-spy pattern.
        coarseDisposeSpy = vi.spyOn(body.geometry, 'dispose');
        coarseEdgeDisposeSpy = vi.spyOn(body.edgeGeometry, 'dispose');
      }
    });

    expect(coarseDisposeSpy).toHaveBeenCalledTimes(1);
    expect(coarseEdgeDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('onPaint is optional -- resolves fine without a callback', async () => {
    const coarse = makeBoxTessBuffers({ featureId: 'COARSE' });
    const display = makeBoxTessBuffers({ featureId: 'DISPLAY' });
    const client = makeFakeClient(coarse, display);
    const cache = new GeometryCache();

    const result = await progressiveTessellate(client, cache, 'body-1', FAKE_HANDLE);
    expect(result.display.faceIds[0]).toBe('DISPLAY:BOX:face#0');
  });
});
