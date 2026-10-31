// WO-3281 (UI M2 W1-D): the notice API (standard 7) and the one catalogue resolver. A notice is
// a level plus a catalogue key; refuse() is the one refusal route (LIENCAM.md rule 11).
import type { Availability, CommandId } from '../commands/types'
import { i18n, SOURCE_LANGUAGE } from '../i18n'
import { isNoticeLevel } from './types'
import type { MessageKey, MessageParams, Notice, NoticeApi, NoticeInput, NoticeListener, ResolveMessage } from './types'

export * from './types'

/** Whether a catalogue key resolves (the English catalogue is the source every language falls back to). */
export function hasMessage(key: MessageKey): boolean {
  if (typeof key !== 'string') return false
  const at = key.indexOf(':')
  // A leaf string only: a branch of the catalogue is not a message.
  return at > 0 && typeof i18n.getResource(SOURCE_LANGUAGE, key.slice(0, at), key.slice(at + 1)) === 'string'
}

export function createNoticeApi(now: () => number = Date.now): NoticeApi {
  let notices: readonly Notice[] = []
  let next = 1
  const listeners = new Set<NoticeListener>()
  const emit = () => { for (const l of listeners) l(notices) }
  const api: NoticeApi = {
    post(input: NoticeInput) {
      if (!isNoticeLevel(input.level)) throw new Error(`notice level '${String(input.level)}' is not one of info, warning, cannot-do-this, error`)
      if (!hasMessage(input.key)) throw new Error(`notice key '${input.key}' is not in the message catalogue`)
      const id = `notice-${next++}`
      notices = [...notices, { ...input, id, at: now() }]
      emit()
      return id
    },
    dismiss(id) {
      const kept = notices.filter(n => n.id !== id)
      if (kept.length === notices.length) return
      notices = kept
      emit()
    },
    list: () => notices,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refuse(commandId: CommandId, availability: Availability) {
      if (availability.ready) return null
      const same = notices.find(n => n.level === 'cannot-do-this' && n.commandId === commandId && n.key === availability.reason
        && JSON.stringify(n.params ?? null) === JSON.stringify(availability.params ?? null))
      if (same) return same.id
      return api.post({ level: 'cannot-do-this', key: availability.reason, params: availability.params, commandId })
    },
  }
  return api
}

/** The one catalogue resolver: '<area>:<key>' through the app's i18n instance. */
export const resolveMessage: ResolveMessage = (key: MessageKey, params?: MessageParams) => {
  const at = key.indexOf(':')
  return i18n.t(key.slice(at + 1), { ns: key.slice(0, at), ...params } as never) as string
}

/** The app's one notice API. */
export const notices: NoticeApi = createNoticeApi()
