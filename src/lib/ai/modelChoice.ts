/**
 * WO-2979 (WO-2956 order M1): the AI model choice core.
 *
 * Two values are always known: the model the operator picked for this project
 * and harness ("requested"), and the model actually running plus who said so
 * ("running": served by the reply, reported by the harness, or unknown).
 *
 * Pure and headless: no React, no network or IPC, no i18n (notice codes only),
 * no import from the CAD model session (WO-2951) or any machine path. The
 * reducer is intent-only: when it wants the harness switched it says so in
 * `pending`; it never calls a harness. LienCAM never picks a model on its own:
 * no fallback list, no "auto" route, no retry on another model.
 *
 * Rules kept on every event (WO-2956 PLAN.md section 3):
 * - I1 the pick changes only by an operator pick, or by loading the project's
 *   or harness's own remembered pick;
 * - I2 a send never names a model other than the pick;
 * - I3 a model's claim about itself never moves "running";
 * - I4 AI off lists and sends nothing;
 * - I5 the remembered pick is written only by an operator pick.
 */

/** Ids exactly as the harness gave them. */
export interface AiModelRef {
  providerId: string | null
  modelId: string
}

export type AiRoute = 'mcp-client' | 'acp' | 'endpoint'

export interface AiHarnessInfo {
  id: string
  route: AiRoute
  name: string
  version?: string
  canList: boolean
  canSwitch: boolean
}

/** 'served' = named in the reply, 'harness' = the harness's own record, 'none' = unknown. */
export type AiRunningSource = 'served' | 'harness' | 'none'

export interface AiRunningModel {
  model: AiModelRef | null
  source: AiRunningSource
}

export type AiModelNotice =
  | 'unavailable'
  | 'not-listed'
  | 'no-model'
  | 'switch-failed'
  | 'requested-not-active'
  | 'mismatch'
  | 'not-confirmed'
  | 'not-checked'
  | 'switch-not-offered'
  | 'choice-cannot-apply'
  | 'switch-pending'
  | 'ai-off'
  | 'send-failed'

export interface AiModelListing {
  status: 'not-listed' | 'listed' | 'list-failed'
  offers: readonly AiModelRef[]
}

/** projectId -> harnessId -> the operator's pick. The shape kept on this computer. */
export type AiRememberedChoices = Readonly<Record<string, Readonly<Record<string, AiModelRef>>>>

/** One turn as the transcript and the bug report record it. No URLs, keys or account names. */
export interface AiTurnRecord {
  harness: { route: AiRoute; name: string; version?: string }
  requested: AiModelRef | null
  running: AiModelRef | null
  source: AiRunningSource
}

export interface AiModelChoiceState {
  aiOn: boolean
  projectId: string | null
  harness: AiHarnessInfo | null
  listing: AiModelListing
  requested: AiModelRef | null
  running: AiRunningModel
  /** A switch the core wants the harness to make (intent only). */
  pending: AiModelRef | null
  notice: AiModelNotice | null
  remembered: AiRememberedChoices
  sendCount: number
  /** The model named by the last send; null when that send named none (agent, MCP client). */
  lastSentModel: AiModelRef | null
  lastTurn: AiTurnRecord | null
}

export type AiModelEvent =
  | { type: 'ai-on' }
  | { type: 'ai-off' }
  | { type: 'project-opened'; projectId: string }
  | { type: 'harness-connected'; harness: AiHarnessInfo; current?: AiModelRef | null }
  | { type: 'listing'; offers: readonly AiModelRef[] }
  | { type: 'listing-failed'; message?: string }
  | { type: 'operator-select'; model: AiModelRef }
  /** The harness's answer to a switch; `current` is its own record of the active model. */
  | { type: 'switch-confirmed'; current: AiModelRef }
  | { type: 'switch-refused'; message?: string }
  /** The harness changed its model by itself. */
  | { type: 'harness-config-update'; current: AiModelRef }
  /** What a model says about itself; never a source. */
  | { type: 'agent-text'; text: string }
  | { type: 'send' }
  /** An endpoint reply; `model` absent or null means the reply did not say. */
  | { type: 'turn-served'; model?: AiModelRef | null }
  | { type: 'send-failed'; code: string; message?: string }

export type AiSendGate = { ok: true } | { ok: false; code: AiModelNotice }

const NO_LISTING: AiModelListing = { status: 'not-listed', offers: [] }
const UNKNOWN: AiRunningModel = { model: null, source: 'none' }

export function sameAiModel(a: AiModelRef | null | undefined, b: AiModelRef | null | undefined): boolean {
  return !!a && !!b && a.modelId === b.modelId && (a.providerId ?? null) === (b.providerId ?? null)
}

export function initialAiModelChoiceState(remembered: AiRememberedChoices = {}): AiModelChoiceState {
  return {
    aiOn: false,
    projectId: null,
    harness: null,
    listing: NO_LISTING,
    requested: null,
    running: UNKNOWN,
    pending: null,
    notice: null,
    remembered,
    sendCount: 0,
    lastSentModel: null,
    lastTurn: null,
  }
}

export function rememberedAiModel(
  remembered: AiRememberedChoices,
  projectId: string | null,
  harnessId: string | null | undefined,
): AiModelRef | null {
  if (projectId === null || !harnessId) return null
  return remembered[projectId]?.[harnessId] ?? null
}

function rememberedFor(s: AiModelChoiceState): AiModelRef | null {
  return rememberedAiModel(s.remembered, s.projectId, s.harness?.id)
}

function pickIsOffered(s: AiModelChoiceState): boolean {
  return s.listing.offers.some((offer) => sameAiModel(offer, s.requested))
}

/**
 * An agent that can switch is set to the operator's own pick when it is offered
 * and not active (reload, project switch, the agent moving itself). This is the
 * pick, never a fallback; a pick the agent no longer offers is Unavailable.
 */
function applyPickToAgent(s: AiModelChoiceState): void {
  if (!s.requested || s.harness?.route !== 'acp' || !s.harness.canSwitch || s.listing.status !== 'listed') return
  if (!pickIsOffered(s)) {
    s.notice = 'unavailable'
    return
  }
  if (!sameAiModel(s.running.model, s.requested)) s.pending = s.requested
}

/** Can a message be sent now; if not, the one-line reason. A closed gate moves nothing. */
export function aiSendGate(s: AiModelChoiceState): AiSendGate {
  if (!s.aiOn || !s.harness) return { ok: false, code: 'ai-off' }
  if (s.pending) return { ok: false, code: 'switch-pending' }
  // An endpoint request must name a model; only the endpoint's own answer can say it is missing (rule 11).
  if (s.harness.route === 'endpoint' && !s.requested) return { ok: false, code: 'no-model' }
  if (s.harness.route === 'acp' && s.requested) {
    // An agent can only be set to a model it offers.
    if (s.listing.status === 'listed' && !pickIsOffered(s)) return { ok: false, code: 'unavailable' }
    if (s.harness.canSwitch && s.running.model && !sameAiModel(s.running.model, s.requested)) {
      return { ok: false, code: 'requested-not-active' }
    }
  }
  return { ok: true }
}

export function reduceAiModelChoice(state: AiModelChoiceState, event: AiModelEvent): AiModelChoiceState {
  const s: AiModelChoiceState = { ...state }
  switch (event.type) {
    case 'ai-on':
      s.aiOn = true
      break
    case 'ai-off':
      // Off disconnects and forgets the session, never the remembered picks.
      Object.assign(s, {
        aiOn: false, harness: null, listing: NO_LISTING, requested: null, running: UNKNOWN, pending: null, notice: null,
      })
      break
    case 'project-opened':
      s.projectId = event.projectId
      s.requested = rememberedFor(s)
      s.pending = null
      s.notice = null
      applyPickToAgent(s)
      break
    case 'harness-connected':
      if (!s.aiOn) {
        s.notice = 'ai-off'
        break
      }
      s.harness = event.harness
      s.requested = rememberedFor(s)
      s.running = event.current ? { model: event.current, source: 'harness' } : UNKNOWN
      s.listing = NO_LISTING
      s.pending = null
      s.notice = s.requested && !s.harness.canSwitch && s.harness.route !== 'endpoint' ? 'choice-cannot-apply' : null
      break
    case 'listing':
      if (!s.aiOn || !s.harness) break
      s.listing = { status: 'listed', offers: event.offers }
      if (s.notice === 'unavailable' || s.notice === 'not-listed' || s.notice === 'not-checked') s.notice = null
      if (s.requested && !pickIsOffered(s) && s.harness.route === 'endpoint') s.notice = 'not-listed'
      applyPickToAgent(s)
      break
    case 'listing-failed':
      if (!s.aiOn || !s.harness) break
      s.listing = { status: 'list-failed', offers: [] }
      s.notice = 'not-checked'
      break
    case 'operator-select': {
      if (!s.harness?.canSwitch || s.projectId === null) {
        s.notice = 'switch-not-offered'
        break
      }
      s.requested = event.model
      s.remembered = {
        ...s.remembered,
        [s.projectId]: { ...s.remembered[s.projectId], [s.harness.id]: event.model },
      }
      s.notice = null
      if (s.harness.route === 'acp') s.pending = event.model
      break
    }
    case 'switch-confirmed':
      s.pending = null
      s.running = { model: event.current, source: 'harness' }
      s.notice = sameAiModel(event.current, s.requested) ? null : 'switch-failed'
      break
    case 'switch-refused':
      s.pending = null
      s.notice = 'switch-failed'
      break
    case 'harness-config-update':
      s.running = { model: event.current, source: 'harness' }
      s.notice = s.requested && !sameAiModel(event.current, s.requested) ? 'mismatch' : null
      if (s.notice) applyPickToAgent(s)
      break
    case 'agent-text':
      break
    case 'send': {
      const gate = aiSendGate(s)
      if (!gate.ok) {
        s.notice = gate.code
        break
      }
      s.sendCount += 1
      s.lastSentModel = s.harness?.route === 'endpoint' ? s.requested : null
      break
    }
    case 'turn-served': {
      if (!s.harness) break
      const named = event.model ?? null
      if (named) s.running = { model: named, source: 'served' }
      else if (s.harness.route === 'endpoint') s.running = UNKNOWN
      const { route, name, version } = s.harness
      s.lastTurn = {
        harness: version === undefined ? { route, name } : { route, name, version },
        requested: s.requested,
        running: s.running.model,
        source: s.running.source,
      }
      if (named && s.requested && !sameAiModel(named, s.requested)) s.notice = 'mismatch'
      if (!named && s.harness.route === 'endpoint') s.notice = 'not-confirmed'
      break
    }
    case 'send-failed':
      // The harness's own refusal, shown as is; never retried on another model.
      s.notice = event.code === 'model-not-found' ? 'unavailable' : 'send-failed'
      break
  }
  // A closed gate always says why.
  const gate = aiSendGate(s)
  if (!gate.ok && !s.notice) s.notice = gate.code
  return s
}
