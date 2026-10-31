// Only pure calculations enter this bundle. UI preferences import the store
// and its other worker clients, so the client sends the current message words.
import i18next from 'i18next'
import { installOperatorTextLookup } from '../i18n/locales/en/console-and-operator-messages'
import { trimToToolReachInPartFrame } from './toolReachCalculation'
import { lowerFinishLinksAfterEarlierOperations } from './finishLinks'
import { applyConservativeStockOperation } from '../lib/cam/stockState'
import { stockMoveWitnessSteps, stockCutSteps, captureStock } from '../lib/cam/operationStockAuthority'
import type { Request, Reply } from './toolpathPostprocess'

const scope = globalThis as unknown as {
  onmessage: (event:MessageEvent<{request:Request;messages:Record<string,string>}>) => void
  postMessage(reply:Reply):void
}
scope.onmessage = async event => {
  try {
    const text = i18next.createInstance()
    await text.init({lng:'worker',fallbackLng:'worker',initAsync:false,
      resources:{worker:{'console-and-operator-messages':event.data.messages}},
      interpolation:{escapeValue:false}})
    installOperatorTextLookup(text.getFixedT('worker','console-and-operator-messages'))
    const request = event.data.request
    if (request.kind === 'move-witness') {
      const steps = stockMoveWitnessSteps(request.input.moves)
      let step = steps.next()
      while (!step.done) step = steps.next()
      scope.postMessage({ ok: true, result: step.value })
      return
    }
    if (request.kind === 'stock-cuts') {
      const steps = stockCutSteps(request.input.moves, request.input.replay, request.input.frame)
      let step = steps.next()
      while (!step.done) step = steps.next()
      scope.postMessage({ ok: true, result: step.value })
      return
    }
    if (request.kind === 'stock-capture') {
      const captured = captureStock(request.input.inputs, request.input.request, false)
      const parts = [captured.baseKey]
      captured.prefixKeys = captured.predecessors.map(op => {
        parts.push(JSON.stringify(op))
        return JSON.stringify(parts)
      })
      scope.postMessage({ ok: true, result: captured })
      return
    }
    scope.postMessage({ok:true,result:request.kind === 'reach'
      ? trimToToolReachInPartFrame(request.input)
      : request.kind === 'links' ? lowerFinishLinksAfterEarlierOperations(request.input)
        : applyConservativeStockOperation(request.input.stock,request.input.cuts)})
  } catch (error) { scope.postMessage({ok:false,error:error instanceof Error ? error.message : String(error)}) }
}
