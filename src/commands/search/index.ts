// WO-3282 (UI M2 W1-E): command search (spec 6.2: "Search runs any command by name and shows its
// ribbon place"). It finds commands by their label in the operator's language and by shortcut,
// and lists an unavailable command too, with the reason its own availability() gives, so the
// operator learns what makes it available instead of finding nothing.
import type { MessageKey, ResolveMessage } from '../../notices/types'
import type { Availability, CommandContext, CommandId, CommandPlace, CommandRegistry, CommandSpec, Shortcut } from '../types'
import { isMacPlatform, shortcutText, typedShortcut } from '../shortcuts/spelling'
import { matchScore } from './match'

export interface CommandSearchRow<Ctx extends CommandContext = CommandContext> {
  readonly spec: CommandSpec<Ctx>
  readonly id: CommandId
  readonly label: string
  readonly help?: string
  readonly place: CommandPlace
  readonly group: string
  readonly shortcut?: Shortcut
  readonly availability: Availability
  /** The unavailable reason in the operator's language. */
  readonly reason?: string
}

export interface CommandSearchOptions<Ctx extends CommandContext> {
  readonly context: Ctx
  readonly resolve: ResolveMessage | ((key: MessageKey) => string)
  /** The bindings in force (ShortcutManager.bindings()). */
  readonly shortcuts?: ReadonlyMap<Shortcut, CommandId>
  readonly limit?: number
  /** Cmd is Mod; default read from the browser. Typed 'Ctrl+G' / 'Cmd+G' are read the same way. */
  readonly isMac?: boolean
}

/** Matching commands, best first; at the same rank a ready command comes before an unavailable
 *  one, then declaration order. An empty query finds nothing. */
export function searchCommands<Ctx extends CommandContext>(
  registry: CommandRegistry<Ctx>, query: string, options: CommandSearchOptions<Ctx>,
): CommandSearchRow<Ctx>[] {
  const shortcutOf = new Map<CommandId, Shortcut>()
  for (const [shortcut, id] of options.shortcuts ?? []) if (!shortcutOf.has(id)) shortcutOf.set(id, shortcut)
  const isMac = options.isMac ?? isMacPlatform()
  const queryShortcut = typedShortcut(query, isMac)
  const resolve = options.resolve as ResolveMessage
  const rows = registry.list().flatMap((spec, order) => {
    const label = resolve(spec.labelKey)
    const shortcut = shortcutOf.get(spec.id)
    const score = matchScore(query, { label, id: spec.id, shortcut, shortcutText: shortcut && shortcutText(shortcut, isMac), queryShortcut })
    if (score === null) return []
    let availability: Availability
    try {
      availability = registry.availability(spec.id, options.context)
    } catch (error) {
      // a broken check is a programming error: report it, never show it as a reason
      console.error(`command ${spec.id} availability failed`, error)
      return []
    }
    const row: CommandSearchRow<Ctx> = {
      spec, id: spec.id, label, place: spec.place, group: spec.group, availability,
      ...(spec.helpKey ? { help: resolve(spec.helpKey) } : {}),
      ...(shortcut ? { shortcut } : {}),
      ...(availability.ready ? {} : { reason: resolve(availability.reason, availability.params) }),
    }
    return [{ row, order, score, ready: availability.ready ? 0 : 1 }]
  })
  rows.sort((a, b) => a.score - b.score || a.ready - b.ready || a.order - b.order)
  return rows.slice(0, options.limit ?? rows.length).map(r => r.row)
}
