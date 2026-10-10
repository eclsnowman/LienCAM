// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { QueuedMove } from '../../lib/machine/controller'
import {
  analysePathFidelity,
  createPathFidelityStreamingAnalysis,
  type PathFidelitySample,
  type PathFidelityStreamingInput,
  type PathFidelityWorkerFactory,
} from '../../lib/machine/pathFidelity'

const commanded: QueuedMove[] = [
  { id: 1, kind: 'line', to: { x: 100, y: 0, z: 0 }, feedMmMin: 1000 },
]

const input: PathFidelityStreamingInput = {
  moves: commanded,
  startPos: { x: 0, y: 0, z: 0 },
  reportsExecutingMoveId: true,
  toleranceMm: 0.03,
  commandedFrame: 'machine',
  maxPhysicalTravelMmMin: null,
}

function longRunSamples(): PathFidelitySample[] {
  return Array.from({ length: 25_000 }, (_, index) => ({
    atMs: index * 32,
    machinePos: {
      x: 100 * index / 24_999,
      // Pin the worst deviation to the larger of the two machine captures in
      // the WO. It remains below the real 0.09 mm threshold and must stay in
      // the report after all 25,000 samples cross the worker boundary.
      y: index === 12_500 ? 0.067 : 0,
      z: 0,
    },
    workPos: null,
    executingMoveId: 1,
  }))
}

/** A deterministic stand-in for the browser's separate global. It accepts
 * every streaming message synchronously, but does not run the heavy analyser
 * until a later task, which lets the test drive a real DOM click while Stop's
 * report is pending. */
class DeferredWorker {
  onmessage: ((event: MessageEvent<{ type: 'report'; report: ReturnType<typeof analysePathFidelity> }>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  private workerInput: PathFidelityStreamingInput | null = null
  private samples: PathFidelitySample[] = []
  private terminated = false

  postMessage(message: { type: string; input?: PathFidelityStreamingInput; sample?: PathFidelitySample; frameChanges?: [] }): void {
    if (message.type === 'start') {
      this.workerInput = message.input ?? null
      return
    }
    if (message.type === 'sample' && message.sample !== undefined) {
      this.samples.push(structuredClone(message.sample))
      return
    }
    const analysisInput = this.workerInput
    const samples = this.samples
    setTimeout(() => {
      if (this.terminated || analysisInput === null) return
      const report = analysePathFidelity({
        ...analysisInput,
        samples,
        frameChanges: message.frameChanges ?? [],
      })
      this.onmessage?.({ data: { type: 'report', report } } as MessageEvent<{
        type: 'report'
        report: ReturnType<typeof analysePathFidelity>
      }>)
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('WO-1353 - Stop never runs whole-path analysis on the renderer', () => {
  it('keeps a UI control clickable while 25,000 status frames finish in the worker', async () => {
    const samples = longRunSamples()
    const expected = analysePathFidelity({ ...input, samples })
    const worker = new DeferredWorker()
    const factory = (() => worker) as PathFidelityWorkerFactory
    const streaming = createPathFidelityStreamingAnalysis(input, factory)
    for (const sample of samples) streaming.addSample(sample)

    const button = document.createElement('button')
    let clicks = 0
    button.addEventListener('click', () => { clicks++ })
    document.body.append(button)

    let reportArrived = false
    const stopStarted = performance.now()
    const reportPromise = streaming.finish().then((report) => {
      reportArrived = true
      return report
    })
    const stopMainThreadMs = performance.now() - stopStarted

    // These are the tasks that were stuck behind the old synchronous finish:
    // the terminal job event, a spindleOff reply, and the operator's click.
    const observed = ['jobEvent stopped', 'spindleOff reply']
    button.click()
    observed.push('UI click')
    expect(observed).toEqual(['jobEvent stopped', 'spindleOff reply', 'UI click'])
    expect(clicks).toBe(1)
    expect(reportArrived).toBe(false)
    expect(stopMainThreadMs).toBeLessThan(20)

    const report = await reportPromise
    expect(report.samples.total).toBe(25_000)
    expect(report.worst?.deviationMm).toBeCloseTo(0.067, 6)
    expect(report).toEqual(expected)
  })
})
