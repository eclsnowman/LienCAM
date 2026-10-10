import type { AdaptiveLevelPlanRequest, AdaptivePlannerPool } from './adaptivePlanCache';
import type { FeatureResult } from './engineEntry';

/** Observe actual passes without changing the pool's terminal-response protocol.
 * Only the transport copy has a channel name: cache keys stay geometry-only. */
export async function planWithProgress(
  pool: AdaptivePlannerPool,
  request: AdaptiveLevelPlanRequest,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<FeatureResult> {
  const channel = new BroadcastChannel(`adaptive-plan-${crypto.randomUUID()}`);
  channel.onmessage = event => {
    if (!signal.aborted && typeof event.data === 'number' && Number.isFinite(event.data)) {
      onProgress(Math.max(0, Math.min(1, event.data)));
    }
  };
  try {
    return await pool.plan({
      feature: request.feature,
      params: { ...request.params, plannerProgressChannel: channel.name },
    }, signal);
  } finally {
    channel.close();
  }
}
