/**
 * WO-2979 test helper: a fake AI harness with fake model ids. No provider, no
 * network. It records every call so a test can prove who called it.
 */
import type { AiHarnessAdapter, AiListModelsResult, AiModelOffer, AiSwitchModelResult } from '../../lib/ai/harness'
import { sameAiModel, type AiHarnessInfo, type AiModelEvent, type AiModelRef } from '../../lib/ai/modelChoice'

export interface FakeHarnessOptions {
  info: AiHarnessInfo
  offers: AiModelOffer[]
  current?: AiModelRef | null
  /** Refuse every switch with this message. */
  refuseSwitch?: string
  /** The listing cannot be read. */
  listFails?: string
}

export interface FakeHarness extends AiHarnessAdapter {
  readonly calls: Array<{ method: 'listModels' | 'switchModel'; ref?: AiModelRef }>
  current: AiModelRef | null
  /** The event a host would feed the core when this harness connects. */
  connectedEvent(): AiModelEvent
}

export function fakeOffer(modelId: string, extra: Partial<AiModelOffer> = {}): AiModelOffer {
  return { providerId: 'fake', modelId, label: modelId, ...extra }
}

export function createFakeHarness(options: FakeHarnessOptions): FakeHarness {
  const calls: FakeHarness['calls'] = []
  const harness: FakeHarness = {
    calls,
    current: options.current ?? null,
    info: () => options.info,
    connectedEvent: () => ({ type: 'harness-connected', harness: options.info, current: harness.current }),
    async listModels(): Promise<AiListModelsResult> {
      calls.push({ method: 'listModels' })
      return options.listFails === undefined
        ? { ok: true, offers: options.offers.map((offer) => ({ ...offer })) }
        : { ok: false, message: options.listFails }
    },
  }
  if (options.info.canSwitch) {
    harness.switchModel = async (ref: AiModelRef): Promise<AiSwitchModelResult> => {
      calls.push({ method: 'switchModel', ref })
      if (options.refuseSwitch !== undefined) return { ok: false, message: options.refuseSwitch }
      if (!options.offers.some((offer) => sameAiModel(offer, ref))) return { ok: false, message: 'not offered' }
      harness.current = { providerId: ref.providerId, modelId: ref.modelId }
      return { ok: true, current: harness.current }
    }
  }
  return harness
}
