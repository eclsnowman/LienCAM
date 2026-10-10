export type ProjectOpenTimingPhase =
  | 'reading-file'
  | 'validating-project'
  | 'validating-model-documents'
  | 'restoring-checkpoints'
  | 'installing-project'
  | 'restoring-scene'

export interface ProjectOpenTimingProgress {
  requestId: number
  phase: ProjectOpenTimingPhase
}

export interface ProjectOpenPhaseTiming {
  readonly phase: ProjectOpenTimingPhase
  readonly durationMs: number
}

export interface ProjectOpenTimingSample {
  readonly outcome: 'ended' | 'superseded'
  readonly phases: readonly ProjectOpenPhaseTiming[]
  readonly totalMs: number
}

export interface ProjectOpenTimingSource {
  getSnapshot: () => ProjectOpenTimingProgress | null
  subscribe: (listener: (progress: ProjectOpenTimingProgress | null) => void) => () => void
}

interface ActiveTiming {
  requestId: number
  startedAt: number
  phase: ProjectOpenTimingPhase
  phaseStartedAt: number
  phases: ProjectOpenPhaseTiming[]
}

interface RecorderOptions {
  now: () => number
  onSample?: (sample: ProjectOpenTimingSample) => void
}

export interface ProjectOpenTimingRecorder {
  observe: (progress: ProjectOpenTimingProgress | null) => void
  getLatestSample: () => ProjectOpenTimingSample | null
}

interface SubscribeOptions {
  now?: () => number
  emitInfo: (message: string) => void
}

function copySample(sample: ProjectOpenTimingSample | null): ProjectOpenTimingSample | null {
  if (!sample) return null
  return {
    outcome: sample.outcome,
    phases: sample.phases.map((phase) => ({ ...phase })),
    totalMs: sample.totalMs,
  }
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export function createProjectOpenTimingRecorder({
  now,
  onSample,
}: RecorderOptions): ProjectOpenTimingRecorder {
  let active: ActiveTiming | null = null
  let latest: ProjectOpenTimingSample | null = null
  let lastNow = 0
  let hasTime = false

  const readNow = (): number => {
    const candidate = now()
    if (!Number.isFinite(candidate)) return hasTime ? lastNow : 0
    const safeCandidate = Math.max(0, candidate)
    lastNow = hasTime ? Math.max(lastNow, safeCandidate) : safeCandidate
    hasTime = true
    return lastNow
  }

  const finish = (endedAt: number, outcome: ProjectOpenTimingSample['outcome']): void => {
    if (!active) return
    const phases = [
      ...active.phases,
      { phase: active.phase, durationMs: endedAt - active.phaseStartedAt },
    ]
    latest = {
      outcome,
      phases,
      totalMs: endedAt - active.startedAt,
    }
    active = null
    onSample?.(copySample(latest)!)
  }

  const begin = (progress: ProjectOpenTimingProgress, startedAt: number): void => {
    active = {
      requestId: progress.requestId,
      startedAt,
      phase: progress.phase,
      phaseStartedAt: startedAt,
      phases: [],
    }
  }

  return {
    observe(progress) {
      if (!progress) {
        if (active) finish(readNow(), 'ended')
        return
      }

      if (!active) {
        begin(progress, readNow())
        return
      }

      if (active.requestId !== progress.requestId) {
        const transitionAt = readNow()
        finish(transitionAt, 'superseded')
        begin(progress, transitionAt)
        return
      }

      if (active.phase === progress.phase) return
      const transitionAt = readNow()
      active.phases.push({
        phase: active.phase,
        durationMs: transitionAt - active.phaseStartedAt,
      })
      active.phase = progress.phase
      active.phaseStartedAt = transitionAt
    },
    getLatestSample: () => copySample(latest),
  }
}

function formatSummary(sample: ProjectOpenTimingSample): string {
  const phases = sample.phases
    .map(({ phase, durationMs }) => `${phase} ${Math.round(durationMs)} ms`)
    .join(', ')
  return `Project open timing (${sample.outcome}): ${phases}; total ${Math.round(sample.totalMs)} ms.`
}

let latestProjectOpenTimingSample: ProjectOpenTimingSample | null = null

/** Returns a detached, content-free diagnostic sample from the latest ended attempt. */
export function getLatestProjectOpenTimingSample(): ProjectOpenTimingSample | null {
  return copySample(latestProjectOpenTimingSample)
}

/**
 * Connects the store-shaped progress source to the timing core. The source is
 * injected so this module never imports the application store or participates
 * in its module initialization graph.
 */
export function subscribeToProjectOpenTiming(
  source: ProjectOpenTimingSource,
  { now = defaultNow, emitInfo }: SubscribeOptions,
): () => void {
  const recorder = createProjectOpenTimingRecorder({
    now,
    onSample: (sample) => {
      latestProjectOpenTimingSample = copySample(sample)
      emitInfo(formatSummary(sample))
    },
  })
  const unsubscribe = source.subscribe(recorder.observe)
  recorder.observe(source.getSnapshot())
  return unsubscribe
}
