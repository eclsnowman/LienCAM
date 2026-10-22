/**
 * WO-2979 (WO-2956 order M1): what each AI route adapter implements.
 *
 * Interface only. The ACP and compatible-endpoint adapters come with the held
 * in-app assistant orders; an attached MCP client offers no listing or switch
 * (its model is chosen in the client). The model choice core never calls an
 * adapter: the glue reads `pending` from the reducer, calls `switchModel`, and
 * feeds the answer back as a `switch-confirmed` or `switch-refused` event.
 */
import type { AiHarnessInfo, AiModelRef } from './modelChoice'

export interface AiModelOffer extends AiModelRef {
  label: string
  group?: string
  isDefault?: boolean
}

export type AiListModelsResult =
  | { ok: true; offers: AiModelOffer[] }
  | { ok: false; message: string }

/** `current` is the harness's own record of the active model after the switch. */
export type AiSwitchModelResult =
  | { ok: true; current: AiModelRef }
  | { ok: false; message: string }

export interface AiHarnessAdapter {
  info(): AiHarnessInfo
  listModels(): Promise<AiListModelsResult>
  switchModel?(ref: AiModelRef): Promise<AiSwitchModelResult>
}
