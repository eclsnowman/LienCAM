// cam3d rough: the SINGLE read-only bridge to the 2D adaptive-clearing engine.
//
// The 3D rougher reuses the proven 2D adaptive engine
// (src/lib/cam/adaptiveClearing2d) to clear one per-level compartment at a time.
// That engine is imported READ-ONLY -- it is never modified. Concentrating the
// cross-package imports here (rather than sprinkling deep relative paths through
// feature.ts / emit.ts / the strategy) keeps the dependency on the 2D engine
// visible in ONE place and easy to audit against the "do not touch the 2D
// engine" constraint.
//
// Only the engine's documented entry points are re-exported: the async wasm
// init (SEPARATE from geom2d's), the synchronous per-feature clearer, and the
// value/type shapes strategies pass across the boundary.

import {
  processFeature as engineProcessFeature,
  type ProcessParams as EngineProcessParams,
  type Feature,
  type FeatureResult,
} from '../../lib/cam/adaptiveClearing2d/engine/processFeature';

export type ProcessParams = EngineProcessParams & {
  /** WO-2406: observation transport only; stripped before calling the engine. */
  plannerProgressChannel?: string;
};

export function processFeature(
  feature: Feature,
  params: ProcessParams,
  onPassProgress?: (fraction: number) => void,
): FeatureResult {
  if (params.plannerProgressChannel === undefined) {
    return engineProcessFeature(feature, params, onPassProgress);
  }
  const { plannerProgressChannel, ...engineParams } = params;
  const channel = new BroadcastChannel(plannerProgressChannel);
  let lastSentAt = -Infinity;
  try {
    return engineProcessFeature(feature, engineParams, fraction => {
      onPassProgress?.(fraction);
      const now = performance.now();
      // Equal coverage still means another real pass ran. Never send a timer
      // heartbeat: a stuck engine must remain visible to the stall watchdog.
      if (now - lastSentAt >= 1_000) {
        lastSentAt = now;
        channel.postMessage(fraction);
      }
    });
  } finally {
    channel.close();
  }
}

export {
  type Feature,
  type FeatureResult,
  type AdaptivePass,
  type AdaptiveEntry,
} from '../../lib/cam/adaptiveClearing2d/engine/processFeature';
export {
  ensureEngineClipperReady,
  type Pt as EnginePt,
  type Loop as EngineLoop,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine';
