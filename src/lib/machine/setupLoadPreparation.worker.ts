import i18next from 'i18next'
import { installOperatorTextLookup } from '../../i18n/locales/en/console-and-operator-messages'
import { prepareSetupLoad, prepareTransferLoad, type SetupLoadMessage, packSetupLoadResult, type PackedLoadReply, type TransferLoadMessage, type SetupLoadReply, type SetupLoadResult } from './setupLoadPreparation'

export interface SetupLoadWorkerScope {
  onmessage: ((event: { data: SetupLoadMessage | TransferLoadMessage }) => void) | null
  postMessage(reply: PackedLoadReply | SetupLoadReply, transfer?: Transferable[]): void
}
/** Exported so focused tests exercise the production message entry. */
export function attachSetupLoadWorker(scope: SetupLoadWorkerScope): void {
  let source: SetupLoadResult | undefined
  scope.onmessage = async ({ data }) => {
    try {
      const text = i18next.createInstance()
      await text.init({ lng: 'worker', fallbackLng: 'worker', initAsync: false,
        resources: { worker: { 'console-and-operator-messages': data.messages } }, interpolation: { escapeValue: false } })
      installOperatorTextLookup(text.getFixedT('worker', 'console-and-operator-messages'))
      if (!('kind' in data)) {
        source = prepareSetupLoad(data.request)
        // The renderer needs posted bytes to apply its live M6/probe staging,
        // plus the small freshness receipt. Keep the deep graph private until
        // both phases are complete; traverse/pack it ONCE with shared aliases.
        scope.postMessage({ ok: true, result: { posted: source.posted, freshness: source.freshness,
          context: null, analysis: null, comparison: 'no-context', perSetup: null } })
        return
      }
      const result = prepareTransferLoad(data.transfer, source?.analysis ?? undefined)
      const packed = packSetupLoadResult({ ...result, ...(source ? { sourceResult: source } : {}) })
      scope.postMessage({ ok: true, packed }, packed.map(bytes => bytes.buffer as ArrayBuffer))
    } catch (error) {
      scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
// Importing this entry on the renderer or in jsdom must not install a handler.
if (typeof document === 'undefined' && typeof self !== 'undefined' && 'postMessage' in self) {
  attachSetupLoadWorker(self as unknown as SetupLoadWorkerScope)
}
