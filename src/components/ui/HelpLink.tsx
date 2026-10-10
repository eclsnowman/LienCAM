import { textFor, useText } from '../../i18n'
// WO-413 - the one help affordance every surface uses: a small '?' (optionally
// with a word of label) that opens the Help Center AT a topic, through
// openHelpTopic. No new floating surface; the Help Center is the existing
// modal. It stops its click so a clickable header it sits inside does not
// also fire. The topic title (from the eager index) names the control for
// the tooltip and screen readers.

import type { MouseEvent } from 'react'
import { CircleHelp } from 'lucide-react'
import { helpIndexEntry } from '../../help/registry'
import { openHelpTopic } from '../../help/helpOpen'

const shellText = textFor('app-shell-settings-menus')

export interface HelpLinkProps {
  /** A HelpTopic id (compile-checked against the index by the census test). */
  topic: string
  /** A heading / table-row anchor inside the topic to scroll to. */
  anchor?: string
  /** Optional visible word next to the icon ("Help"); icon-only by default. */
  label?: string
  /** Overrides the tooltip / aria-label ("Help: <topic title>" by default). */
  title?: string
  testId?: string
}

export function HelpLink({ topic, anchor, label, title, testId }: HelpLinkProps) {
  useText('app-shell-settings-menus')
  const entry = helpIndexEntry(topic)
  const text = title ?? shellText('HelpLink.help', { value: entry?.title ?? topic })
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.preventDefault()
    openHelpTopic(topic, anchor ?? null)
  }
  return (
    <button
      type="button"
      className={`help-link${label ? ' help-link-labelled' : ''}`}
      data-testid={testId ?? `help-link-${topic}${anchor ? `-${anchor}` : ''}`}
      data-help-topic={topic}
      data-help-anchor={anchor ?? undefined}
      data-tooltip={text}
      aria-label={text}
      onClick={onClick}
    >
      <CircleHelp size={12} aria-hidden="true" />
      {label && <span>{label}</span>}
    </button>
  )
}
