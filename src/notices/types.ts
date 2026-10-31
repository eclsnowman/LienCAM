// WO-3275 (UI M2 Wave 0): the notice and refusal contract (M2-PLAN standard 7).
// Every operator message (info, warning, cannot-do-this, error) goes through ONE notice API and
// one message catalogue. A command's "cannot do this now" reason comes only from that command's
// availability() (src/commands/types.ts), so LIENCAM.md rule 11 holds in one place: a ready
// command is never refused, and every refusal names a catalogue reason.
// Wave 1 (W1-D) replaces the stub in ./index.ts; only the Wave 0 owner changes this file.
import type { CatalogArea } from '../i18n'
import type { Availability, CommandId } from '../commands/types'

export const NOTICE_LEVELS = ['info', 'warning', 'cannot-do-this', 'error'] as const
export type NoticeLevel = (typeof NOTICE_LEVELS)[number]
export function isNoticeLevel(value: unknown): value is NoticeLevel {
  return typeof value === 'string' && (NOTICE_LEVELS as readonly string[]).includes(value)
}

/** A key into the message catalogue: '<area>:<key>', the area one file under
 *  src/i18n/locales/en/. Operator text is never a raw string. */
export type MessageKey = `${CatalogArea}:${string}`
/** The shape of a MessageKey at run time. The area may hold digits and dots, as order-scoped areas
 *  do ('ui2-notices.wo3281', 'tab-removal.wo3221'). */
export const MESSAGE_KEY_PATTERN = /^[a-z0-9.-]+:.+$/i
/** Values interpolated into a catalogue message ({{name}} in the catalogue text). */
export type MessageParams = Readonly<Record<string, string | number>>

export interface Notice {
  readonly id: string
  readonly level: NoticeLevel
  readonly key: MessageKey
  readonly params?: MessageParams
  /** The command this notice is about, when there is one (a refusal always has one). */
  readonly commandId?: CommandId
  /** Milliseconds since the epoch when it was posted. */
  readonly at: number
}

export type NoticeInput = Omit<Notice, 'id' | 'at'>

export type NoticeListener = (notices: readonly Notice[]) => void

export interface NoticeApi {
  /** Post a notice; returns its id. */
  post(notice: NoticeInput): string
  dismiss(id: string): void
  /** Every notice still showing, oldest first. */
  list(): readonly Notice[]
  subscribe(listener: NoticeListener): () => void
  /** The ONE refusal route. A ready availability refuses nothing and returns null; an
   *  unavailable one posts a 'cannot-do-this' notice carrying the availability's own reason
   *  key and params, and returns its id. The same refusal already showing is not posted twice
   *  (its id is returned). */
  refuse(commandId: CommandId, availability: Availability): string | null
}

/** The ONE way from a catalogue key to the operator's text (tooltips with an availability
 *  reason, field issues, notices). Screens resolve before handing text to the kit. */
export type ResolveMessage = (key: MessageKey, params?: MessageParams) => string
