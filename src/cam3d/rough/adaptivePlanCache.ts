import type { Feature, FeatureResult, ProcessParams } from './engineEntry';

export interface AdaptiveLevelPlanRequest {
  readonly feature: Feature;
  readonly params: ProcessParams;
}

export interface AdaptiveLevelPlanCacheResult {
  readonly results: readonly FeatureResult[];
  readonly reused: boolean;
}

/**
 * WO-2096: runs the 2D planner for one request somewhere else (a pool of
 * planner workers) and resolves to exactly what processFeature(feature, params)
 * returns there. Rejects on cancel (AbortError) or when that planner could not
 * run; the caller then plans the request itself.
 */
export interface AdaptivePlannerPool {
  plan(request: AdaptiveLevelPlanRequest, signal?: AbortSignal): Promise<FeatureResult>;
}

const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);

function exactFloat64(value: number): string {
  floatView.setFloat64(0, value, false);
  return floatView.getUint32(0, false).toString(16).padStart(8, '0')
    + floatView.getUint32(4, false).toString(16).padStart(8, '0');
}

function exactValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return `f64:${exactFloat64(value)}`;
    case 'string':
      return `str:${JSON.stringify(value)}`;
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => (
          Object.prototype.hasOwnProperty.call(value, index) ? exactValue(item) : 'hole'
        ));
        return `array:${value.length}[${items.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `object:${keys.length}{${keys.map((key) => (
        `${JSON.stringify(key)}:${exactValue(record[key])}`
      )).join(',')}}`;
    }
    default:
      throw new Error(`adaptivePlanCache: unsupported cache-key value type '${typeof value}'`);
  }
}

/**
 * Exact, collision-free-with-respect-to-serialization key for one Z level's XY
 * planner requests. Numbers are encoded from their IEEE-754 bits: no rounding,
 * tolerance matching, or geometry hashing is allowed here.
 */
export function exactAdaptiveLevelPlanKey(
  requests: readonly AdaptiveLevelPlanRequest[],
): string {
  return exactValue(requests);
}

/** The same exact encoding for one component request (WO-2096). */
export function exactAdaptiveRequestKey(request: AdaptiveLevelPlanRequest): string {
  return exactValue(request);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * Operation-local exact cache. Construct a new instance for every computation.
 *
 * Two exact layers share one key encoding. A whole level whose request list is
 * exactly an earlier level's reuses that level's results; this is the layer the
 * hit/miss/unique accounting describes. Inside a level that misses, each
 * component request exactly equal to one planned before (the same compartment
 * reappearing beside different neighbours at a lower Z) reuses that one result
 * instead of re-running the planner (WO-2096). Both layers compare IEEE-754 bits
 * of every input, so a reused plan is the plan the planner would return.
 */
export class ExactAdaptiveLevelPlanCache {
  private readonly plans = new Map<string, readonly FeatureResult[]>();
  private readonly componentPlans = new Map<string, FeatureResult>();
  private hitCount = 0;
  private missCount = 0;
  private readonly enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get hits(): number { return this.hitCount; }
  get misses(): number { return this.missCount; }
  get uniquePlans(): number { return this.enabled ? this.plans.size : this.missCount; }

  getOrPlan(
    requests: readonly AdaptiveLevelPlanRequest[],
    planner: () => FeatureResult[],
  ): AdaptiveLevelPlanCacheResult {
    const key = exactAdaptiveLevelPlanKey(requests);
    const cached = this.levelHit(key);
    if (cached !== undefined) return cached;
    return this.storeLevel(key, requests.length, planner());
  }

  /**
   * getOrPlan with the component layer: on a level miss, `planOne` runs only
   * for requests no earlier level planned exactly, one at a time in request
   * order. It receives the request's exact key and may resolve later (an
   * off-thread plan). Level accounting (hits, misses, uniquePlans, `reused`) is
   * identical to getOrPlan's.
   */
  async getOrPlanEach(
    requests: readonly AdaptiveLevelPlanRequest[],
    planOne: (
      request: AdaptiveLevelPlanRequest,
      requestKey: string,
    ) => FeatureResult | Promise<FeatureResult>,
  ): Promise<AdaptiveLevelPlanCacheResult> {
    // exactValue of an array joins its items' encodings, so the level key is
    // assembled from the per-request keys instead of encoding the geometry twice.
    const requestKeys = requests.map((request) => exactValue(request));
    const key = `array:${requests.length}[${requestKeys.join(',')}]`;
    const cached = this.levelHit(key);
    if (cached !== undefined) return cached;
    const planned: FeatureResult[] = [];
    for (let index = 0; index < requests.length; index++) {
      const requestKey = requestKeys[index];
      if (!this.enabled) {
        planned.push(await planOne(requests[index], requestKey));
        continue;
      }
      let result = this.componentPlans.get(requestKey);
      if (result === undefined) {
        result = deepFreeze(await planOne(requests[index], requestKey));
        this.componentPlans.set(requestKey, result);
      }
      planned.push(result);
    }
    return this.storeLevel(key, requests.length, planned);
  }

  private levelHit(key: string): AdaptiveLevelPlanCacheResult | undefined {
    if (!this.enabled) return undefined;
    const cached = this.plans.get(key);
    if (cached === undefined) return undefined;
    this.hitCount++;
    return { results: cached, reused: true };
  }

  private storeLevel(
    key: string,
    requestCount: number,
    planned: FeatureResult[],
  ): AdaptiveLevelPlanCacheResult {
    this.missCount++;
    const results = deepFreeze(planned.slice()) as readonly FeatureResult[];
    if (results.length !== requestCount) {
      throw new Error(
        `adaptivePlanCache: planner returned ${results.length} results for ${requestCount} requests`,
      );
    }
    if (this.enabled) this.plans.set(key, results);
    return { results, reused: false };
  }
}
