/**
 * Reusable scratch-evaluation lifecycle for feature create/edit previews.
 *
 * The adapter is deliberately the only geometry-aware surface. In the model
 * workbench it can build a scratch FeatureDag/ElementMap/RegenScheduler and use
 * the same replay executor as live regeneration. This core never receives a
 * live-DAG mutation or history-command callback, so preview evaluation cannot
 * accidentally publish authored state.
 */

type MaybePromise<T> = T | Promise<T>

export interface FeaturePreviewBaseline<TBaseline> {
  /** Detached snapshot captured once when the edit session opens. */
  readonly snapshot: Readonly<TBaseline>
  /** Stable identity of the detached snapshot used by scratch replay. */
  readonly fingerprint: string
}

export type FeaturePreviewEvaluation<TCandidate> =
  | { readonly ok: true; readonly candidate: TCandidate }
  | { readonly ok: false; readonly reason: string }

export type FeaturePreviewResult =
  | { readonly status: 'ready'; readonly generation: number }
  | { readonly status: 'superseded'; readonly generation: number }
  | { readonly status: 'refused'; readonly generation: number; readonly reason: string }
  | { readonly status: 'cancelled'; readonly generation: number }
  | { readonly status: 'error'; readonly generation: number; readonly reason: string }

export interface FeaturePreviewAdapter<TBaseline, TIntent, TMaterialized, TCandidate> {
  /**
   * Capture a detached serialization of the live authored state. The session
   * freezes the returned object graph before any scratch adapter receives it.
   */
  captureBaseline(): { snapshot: TBaseline; fingerprint: string }

  /** Materialize the body immediately before the feature being created/edited. */
  materializePreFeature(context: FeaturePreviewBaseline<TBaseline>): Promise<TMaterialized>

  /** Evaluate one intent against scratch state only. */
  evaluate(context: FeaturePreviewBaseline<TBaseline> & {
    readonly generation: number
    readonly intent: Readonly<TIntent>
    readonly preFeature: TMaterialized
  }): Promise<FeaturePreviewEvaluation<TCandidate>>

  /**
   * Paint a session-owned candidate. Implementations doing asynchronous
   * tessellation must check isCurrent before and after repaint boundaries.
   */
  presentCandidate?(context: {
    readonly generation: number
    readonly candidate: TCandidate
    readonly isCurrent: () => boolean
  }): MaybePromise<void>

  disposeCandidate(candidate: TCandidate): MaybePromise<void>
  disposePreFeature?(preFeature: TMaterialized): MaybePromise<void>
  restoreOriginal?(reason: 'cancel' | 'error' | 'refused'): MaybePromise<void>
}

interface PendingRequest<TIntent> {
  readonly generation: number
  readonly intent: Readonly<TIntent>
  readonly resolve: (result: FeaturePreviewResult) => void
}

type SessionState = 'active' | 'cancelled' | 'error' | 'taken'

function freezeObjectGraph<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(object as Record<string, unknown>)) {
    freezeObjectGraph(child, seen)
  }
  return Object.freeze(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One feature-preview session. Requests are single-flight: while evaluation is
 * running, only the latest requested intent is retained. Ownership of the
 * accepted candidate stays here until takeCandidate() transfers it to Apply.
 */
export class FeaturePreviewSession<TBaseline, TIntent, TMaterialized, TCandidate> {
  readonly baseline: FeaturePreviewBaseline<TBaseline>

  private readonly adapter: FeaturePreviewAdapter<TBaseline, TIntent, TMaterialized, TCandidate>
  private state: SessionState = 'active'
  private generation = 0
  private running = false
  private pending: PendingRequest<TIntent> | null = null
  private preFeature: TMaterialized | undefined
  private preFeaturePromise: Promise<TMaterialized> | null = null
  private candidate: TCandidate | undefined
  private readonly disposedCandidates = new Set<TCandidate>()
  private preFeatureDisposed = false
  private restored = false
  private terminalCleanup: Promise<void> | null = null

  constructor(adapter: FeaturePreviewAdapter<TBaseline, TIntent, TMaterialized, TCandidate>) {
    this.adapter = adapter
    const captured = adapter.captureBaseline()
    this.baseline = Object.freeze({
      snapshot: freezeObjectGraph(captured.snapshot),
      fingerprint: captured.fingerprint,
    })
  }

  request(intent: TIntent): Promise<FeaturePreviewResult> {
    if (this.state !== 'active') {
      return Promise.resolve({
        status: this.state === 'cancelled' ? 'cancelled' : 'error',
        generation: this.generation,
        reason: this.state === 'cancelled' ? undefined : `Preview session is ${this.state}.`,
      } as FeaturePreviewResult)
    }

    this.generation += 1
    const generation = this.generation
    const frozenIntent = freezeObjectGraph(intent)
    return new Promise<FeaturePreviewResult>((resolve) => {
      const request: PendingRequest<TIntent> = { generation, intent: frozenIntent, resolve }
      if (this.running) {
        this.pending?.resolve({ status: 'superseded', generation: this.pending.generation })
        this.pending = request
        return
      }
      this.running = true
      void this.run(request)
    })
  }

  /** Transfer the already-evaluated candidate to Apply exactly once. */
  async takeCandidate(): Promise<TCandidate> {
    if (this.state !== 'active') throw new Error(`Preview candidate is unavailable: session is ${this.state}.`)
    if (this.running || this.pending) throw new Error('Preview candidate is unavailable while evaluation is pending.')
    if (this.candidate === undefined) throw new Error('Preview candidate is unavailable: no accepted preview exists.')

    const transferred = this.candidate
    this.candidate = undefined
    this.state = 'taken'
    this.generation += 1
    await this.disposePreFeatureOnce()
    return transferred
  }

  /** Cancel is idempotent and never disposes a candidate transferred to Apply. */
  cancel(): Promise<void> {
    if (this.state === 'taken') return Promise.resolve()
    if (this.terminalCleanup) return this.terminalCleanup
    this.state = 'cancelled'
    this.generation += 1
    if (this.pending) {
      this.pending.resolve({ status: 'cancelled', generation: this.pending.generation })
      this.pending = null
    }
    this.terminalCleanup = this.cleanupTerminal('cancel')
    return this.terminalCleanup
  }

  private async run(request: PendingRequest<TIntent>): Promise<void> {
    let evaluatedCandidate: TCandidate | undefined
    try {
      const preFeature = await this.ensurePreFeature()
      if (!this.isCurrent(request.generation)) {
        request.resolve(this.state === 'cancelled'
          ? { status: 'cancelled', generation: request.generation }
          : { status: 'superseded', generation: request.generation })
        return
      }

      const evaluated = await this.adapter.evaluate({
        ...this.baseline,
        generation: request.generation,
        intent: request.intent,
        preFeature,
      })
      if (!evaluated.ok) {
        if (this.isCurrent(request.generation)) {
          await this.disposeCandidateOnce(this.candidate)
          this.candidate = undefined
          await this.restoreOnce('refused')
          request.resolve({ status: 'refused', generation: request.generation, reason: evaluated.reason })
        } else {
          request.resolve({ status: 'superseded', generation: request.generation })
        }
        return
      }
      evaluatedCandidate = evaluated.candidate

      if (!this.isCurrent(request.generation)) {
        await this.disposeCandidateOnce(evaluatedCandidate)
        evaluatedCandidate = undefined
        request.resolve(this.state === 'cancelled'
          ? { status: 'cancelled', generation: request.generation }
          : { status: 'superseded', generation: request.generation })
        return
      }

      await this.adapter.presentCandidate?.({
        generation: request.generation,
        candidate: evaluatedCandidate,
        isCurrent: () => this.isCurrent(request.generation),
      })
      if (!this.isCurrent(request.generation)) {
        await this.disposeCandidateOnce(evaluatedCandidate)
        evaluatedCandidate = undefined
        request.resolve(this.state === 'cancelled'
          ? { status: 'cancelled', generation: request.generation }
          : { status: 'superseded', generation: request.generation })
        return
      }

      await this.disposeCandidateOnce(this.candidate)
      this.candidate = evaluatedCandidate
      evaluatedCandidate = undefined
      // A prior refusal may have restored the source presentation. Accepting a
      // later candidate paints preview state again, so a subsequent Cancel or
      // error must be allowed to restore the original presentation once more.
      this.restored = false
      request.resolve({ status: 'ready', generation: request.generation })
    } catch (error) {
      // Evaluation may already have minted a native candidate before an
      // asynchronous presentation boundary throws. Until the candidate is
      // accepted into this.candidate, this local owns it and must release it
      // on both current errors and superseded/stale paint failures.
      await this.disposeCandidateOnce(evaluatedCandidate)
      const reason = errorMessage(error)
      if (this.state === 'active' && this.generation !== request.generation) {
        // A newer intent owns the session. Failure of superseded scratch work
        // must not poison that newer generation or prevent it from running.
        request.resolve({ status: 'superseded', generation: request.generation })
      } else if (this.state === 'active') {
        this.state = 'error'
        this.generation += 1
        this.terminalCleanup = this.cleanupTerminal('error')
        await this.terminalCleanup
        request.resolve({ status: 'error', generation: request.generation, reason })
      } else {
        request.resolve(this.state === 'cancelled'
          ? { status: 'cancelled', generation: request.generation }
          : { status: 'superseded', generation: request.generation })
      }
    } finally {
      this.running = false
      const next = this.pending
      this.pending = null
      if (next && this.state === 'active') {
        this.running = true
        void this.run(next)
      } else if (next) {
        next.resolve(this.state === 'cancelled'
          ? { status: 'cancelled', generation: next.generation }
          : { status: 'error', generation: next.generation, reason: `Preview session is ${this.state}.` })
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state === 'active' && this.generation === generation
  }

  private ensurePreFeature(): Promise<TMaterialized> {
    if (this.preFeature !== undefined) return Promise.resolve(this.preFeature)
    if (this.preFeaturePromise) return this.preFeaturePromise
    this.preFeaturePromise = this.adapter.materializePreFeature(this.baseline).then(async (materialized) => {
      if (this.state !== 'active') {
        this.preFeature = materialized
        await this.disposePreFeatureOnce()
        throw new Error('Preview session closed while materializing its pre-feature body.')
      }
      this.preFeature = materialized
      return materialized
    })
    return this.preFeaturePromise
  }

  private async cleanupTerminal(reason: 'cancel' | 'error'): Promise<void> {
    await this.disposeCandidateOnce(this.candidate)
    this.candidate = undefined
    await this.disposePreFeatureOnce()
    await this.restoreOnce(reason)
  }

  private async disposeCandidateOnce(candidate: TCandidate | undefined): Promise<void> {
    if (candidate === undefined || this.disposedCandidates.has(candidate)) return
    this.disposedCandidates.add(candidate)
    await this.adapter.disposeCandidate(candidate)
  }

  private async disposePreFeatureOnce(): Promise<void> {
    if (this.preFeature === undefined || this.preFeatureDisposed) return
    this.preFeatureDisposed = true
    await this.adapter.disposePreFeature?.(this.preFeature)
  }

  private async restoreOnce(reason: 'cancel' | 'error' | 'refused'): Promise<void> {
    if (this.restored) return
    this.restored = true
    await this.adapter.restoreOriginal?.(reason)
  }
}
