// WO-3085: the same reach and finish-link algorithms, off the page. Inputs are
// copied, never transferred: viewport and predecessor buffers remain owned by
// the store. Keep the synchronous implementation for hosts without workers.
import { i18n } from '../i18n'
import sourceMessages from '../i18n/locales/en/console-and-operator-messages'
import { trimToToolReachInPartFrame, type ToolReachInPartFrameInput } from './toolReachCalculation'
import { lowerFinishLinksAfterEarlierOperations } from './finishLinks'
import { applyConservativeStockOperation, createConservativeStockColumns, type ConservativeStockColumns, type StockCut } from '../lib/cam/stockState'
import { stockMoveWitnessSteps, type PreparedMoveWitness, stockCutSteps, runStockSteps, prepareStockCapture, type OperationStockBackend, type OperationStockInputs, type StockBeforeRequest, type StockReplay, type Captured } from '../lib/cam/operationStockAuthority'
import type { ToolpathMove } from '../types'
import type { FrameRef } from '../lib/geometry/coordinateFrames'

type ReachResult = ReturnType<typeof trimToToolReachInPartFrame>
type LinkInput = Parameters<typeof lowerFinishLinksAfterEarlierOperations>[0]
type LinkResult = ReturnType<typeof lowerFinishLinksAfterEarlierOperations>
export type Request = { kind: 'move-witness'; input: { moves: readonly ToolpathMove[] } } | { kind: 'stock-cuts'; input: { moves: readonly ToolpathMove[]; replay: StockReplay | undefined; frame: FrameRef<'world'> } } | { kind: 'stock-capture'; input: { inputs: OperationStockInputs; request: StockBeforeRequest } } | { kind: 'reach'; input: ToolReachInPartFrameInput } | { kind: 'links'; input: LinkInput } | {kind:'stock';input:{stock:ConservativeStockColumns;cuts:readonly StockCut[]}}
export type Reply = { ok: true; result: ReachResult | LinkResult | ConservativeStockColumns | readonly StockCut[] | string | Captured | PreparedMoveWitness } | { ok: false; error: string }
const WORKER_NAME = 'toolpath-postprocess'

function runOffPage<T>(request: Request, fallback: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (typeof Worker === 'undefined' || typeof Worker.prototype.addEventListener !== 'function') return Promise.resolve().then(fallback)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./toolpathPostprocess.worker.ts', import.meta.url), {type:'module',name:WORKER_NAME})
    } catch { resolve(fallback()); return }
    const abort = () => { stop(); reject(new DOMException('Aborted', 'AbortError')) }
    const stop = () => { signal?.removeEventListener('abort',abort); worker.terminate() }
    signal?.addEventListener('abort',abort,{once:true})
    worker.onmessage = (event: MessageEvent<Reply>) => {
      stop()
      if (event.data.ok) resolve(event.data.result as T)
      else reject(new Error(event.data.error))
    }
    worker.onerror = event => {
      event.preventDefault()
      stop()
      // Preserve the same method on a host that cannot start a module worker.
      try { resolve(fallback()) } catch (error) { reject(error) }
    }
    try { worker.postMessage({request,messages:{...sourceMessages,...i18n.getResourceBundle(i18n.language,'console-and-operator-messages')}}) }
    catch { stop(); try { resolve(fallback()) } catch (error) { reject(error) } }
  })
}

export function trimToToolReachOffPage(input: ToolReachInPartFrameInput, signal?: AbortSignal): Promise<ReachResult> {
  return runOffPage({kind:'reach',input}, () => trimToToolReachInPartFrame(input),signal)
}
export function lowerFinishLinksOffPage(input: LinkInput, signal?: AbortSignal): Promise<LinkResult> {
  return runOffPage({kind:'links',input}, () => lowerFinishLinksAfterEarlierOperations(input),signal)
}

// The authority already checks token currency after every awaited backend
// result. Only replay changes threads; whole-cell envelope math is identical.
export const offPageStockBackend: OperationStockBackend = {
  create: initial => createConservativeStockColumns(initial.bounds,initial.resolutionMm,initial.maxColumns),
  apply: async (stock,cuts) => {
    const result = await runOffPage({kind:'stock',input:{stock,cuts}},() => applyConservativeStockOperation(stock,cuts))
    return Object.freeze({...result,bounds:Object.freeze({...result.bounds}),
      topZ:Object.freeze([...result.topZ]),warnings:Object.freeze([...result.warnings])})
  },
}

export function prepareStockCutsOffPage(moves: readonly ToolpathMove[], replay: StockReplay | undefined, frame: FrameRef<'world'>): Promise<readonly StockCut[] | string> {
  return runOffPage({ kind: 'stock-cuts', input: { moves, replay, frame } },
    () => runStockSteps(stockCutSteps(moves, replay, frame)))
}
export function captureStockOffPage(inputs: OperationStockInputs, request: StockBeforeRequest): Promise<Captured> {
  return runOffPage({ kind: 'stock-capture', input: { inputs, request } }, () => prepareStockCapture(inputs, request))
}

export function prepareMoveWitnessOffPage(moves: readonly ToolpathMove[], signal?: AbortSignal): Promise<PreparedMoveWitness> {
  return runOffPage({ kind: 'move-witness', input: { moves } }, () => runStockSteps(stockMoveWitnessSteps(moves)), signal)
}
