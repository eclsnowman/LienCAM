// WO-3281: the New UI's message catalogue keys and the Notice part's look. The words are in
// src/i18n/locales/<lang>/ui2-notices.wo3281.ts (four languages, same keys); code names a message
// only through these constants, so a key that is not in the catalogue is a tsc or test failure.
import type { ThemeTokens } from '../../theme/tokens'
import type { MessageKey, NoticeLevel } from '../types'

type Role = Exclude<keyof ThemeTokens, 'name'>

/** The level word the Notice part shows beside its text (so a level is never told by colour alone). */
export const LEVEL_LABEL: Readonly<Record<NoticeLevel, MessageKey>> = {
  info: 'ui2-notices.wo3281:levels.info',
  warning: 'ui2-notices.wo3281:levels.warning',
  'cannot-do-this': 'ui2-notices.wo3281:levels.cannotDoThis',
  error: 'ui2-notices.wo3281:levels.error',
}

/** Why a field could not read what was typed (ParseResult.reason). */
export const UNIT_REASON = {
  /** The catalogue's existing "Enter a number" (reused, not re-worded). */
  notANumber: 'sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber',
  wrongUnit: 'ui2-notices.wo3281:units.wrongUnit',
  wrongMark: 'ui2-notices.wo3281:units.wrongMark',
} as const satisfies Readonly<Record<string, MessageKey>>

/** Theme roles of each level: text and level word on the ground, and the edge band. Status roles
 *  stay on status; a refusal is neutral (not an alarm); the safety red is never used here. */
export interface NoticeLook { readonly ground: Role; readonly ink: Role; readonly label: Role; readonly edge: Role }
export const NOTICE_LOOK: Readonly<Record<NoticeLevel, NoticeLook>> = {
  info: { ground: 'panel', ink: 'tx', label: 'accInk', edge: 'acc' },
  warning: { ground: 'panel', ink: 'tx', label: 'warn', edge: 'warn' },
  'cannot-do-this': { ground: 'panel', ink: 'tx', label: 'tx2', edge: 'tx3' },
  error: { ground: 'panel', ink: 'tx', label: 'err', edge: 'err' },
}
