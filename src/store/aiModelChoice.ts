/**
 * WO-2979 (WO-2956 order M1): the remembered AI model pick, on this computer.
 *
 * Shape: { [projectId]: { [harnessId]: AiModelRef } }, under the registry's
 * `aiModelChoice` key. Kept out of the .camproject and out of backups on
 * purpose (see the registry entry). No cap: one short entry per project and
 * harness, and a pick is never dropped silently.
 *
 * Written only by an operator pick the core accepted. Nothing else (a reload,
 * an Unavailable model, AI off, a project switch) writes or erases it.
 */
import {
  rememberedAiModel,
  sameAiModel,
  type AiModelChoiceState,
  type AiModelEvent,
  type AiModelRef,
  type AiRememberedChoices,
} from '../lib/ai/modelChoice'
import { readRegisteredLocalData, writeRegisteredLocalData } from './persistedKeys'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asModelRef(value: unknown): AiModelRef | null {
  if (!isRecord(value) || typeof value.modelId !== 'string' || value.modelId.length === 0) return null
  const providerId = value.providerId ?? null
  if (providerId !== null && typeof providerId !== 'string') return null
  return { providerId, modelId: value.modelId }
}

/** The stored record as written, or null when there is none; 'unreadable' when it is not a JSON object. */
function readStoredRecord(): Record<string, unknown> | null | 'unreadable' {
  const raw = readRegisteredLocalData('aiModelChoice')
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Every remembered pick that reads as one; a malformed entry is skipped, not repaired. */
export function readAiModelChoices(): AiRememberedChoices {
  const stored = readStoredRecord()
  if (stored === null || stored === 'unreadable') return {}
  const choices: Record<string, Record<string, AiModelRef>> = {}
  for (const [projectId, byHarness] of Object.entries(stored)) {
    if (!isRecord(byHarness)) continue
    for (const [harnessId, value] of Object.entries(byHarness)) {
      const ref = asModelRef(value)
      if (ref) (choices[projectId] ??= {})[harnessId] = ref
    }
  }
  return choices
}

/**
 * Why a pick was not saved. 'not-a-pick': the event was not an operator pick
 * the core accepted (nothing to save). 'unreadable': the stored record is not
 * one this version can read, so it is left as it is. 'write-failed': the
 * browser refused the write (storage full or blocked). The host tells the
 * operator about the last two; a pick is never dropped silently.
 */
export type AiPickSaveResult =
  | { saved: true }
  | { saved: false; reason: 'not-a-pick' | 'unreadable' | 'write-failed' }

/**
 * Saves the pick after `event` when, and only when, it is an operator pick the
 * core accepted into `next`. The write merges one entry into what is stored, so
 * other projects' picks (and entries this version cannot read) are kept.
 */
export function saveOperatorAiModelPick(event: AiModelEvent, next: AiModelChoiceState): AiPickSaveResult {
  if (event.type !== 'operator-select') return { saved: false, reason: 'not-a-pick' }
  const projectId = next.projectId
  const harnessId = next.harness?.id
  if (projectId === null || !harnessId) return { saved: false, reason: 'not-a-pick' }
  if (!sameAiModel(rememberedAiModel(next.remembered, projectId, harnessId), event.model)) {
    return { saved: false, reason: 'not-a-pick' }
  }
  const stored = readStoredRecord()
  if (stored === 'unreadable') return { saved: false, reason: 'unreadable' }
  const record = stored ?? {}
  const existing = record[projectId]
  const byHarness = isRecord(existing) ? existing : {}
  const pick: AiModelRef = { providerId: event.model.providerId ?? null, modelId: event.model.modelId }
  try {
    writeRegisteredLocalData('aiModelChoice', JSON.stringify({
      ...record,
      [projectId]: { ...byHarness, [harnessId]: pick },
    }))
  } catch {
    return { saved: false, reason: 'write-failed' }
  }
  return { saved: true }
}
