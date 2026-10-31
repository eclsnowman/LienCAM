// WO-3282 (UI M2 W1-E): the command registry (M2-PLAN standard 6). Each command is declared once;
// the ribbon, command search, shortcuts, tooltips and the unavailable look all read it here.
// A command's "cannot do this now" comes only from its own availability() (LIENCAM.md rule 11):
// the registry never invents a reason, and an availability() that throws is a programming error
// that reaches the caller as an error, never as a refusal the operator sees.
import { isActionKind } from '../../components/kit/types'
import type { MessageKey } from '../../notices/types'
import { matchScore } from '../search/match'
import {
  WORKSPACES, type CommandContext, type CommandFilter, type CommandId, type CommandRegistry, type CommandSpec, type RunResult,
} from '../types'

/** The registry plus a change signal, so a ribbon or the search list redraws when a workspace
 *  declares or removes its commands. */
export interface LiveCommandRegistry<Ctx extends CommandContext = CommandContext> extends CommandRegistry<Ctx> {
  subscribe(listener: () => void): () => void
}

const ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

function checkSpec(spec: CommandSpec<never>): void {
  if (!ID.test(spec.id)) throw new Error(`command id ${spec.id} is not '<area>.<verb>'`)
  if (spec.place !== 'global' && !(WORKSPACES as readonly string[]).includes(spec.place)) {
    throw new Error(`command ${spec.id} has place ${String(spec.place)}; use a workspace or 'global'`)
  }
  if (!isActionKind(spec.kind)) throw new Error(`command ${spec.id} has kind ${String(spec.kind)}; use momentary, latched, choice or transport`)
}

export function createCommandRegistry<Ctx extends CommandContext = CommandContext>(): LiveCommandRegistry<Ctx> {
  const specs = new Map<CommandId, CommandSpec<Ctx>>()
  const listeners = new Set<() => void>()
  const changed = () => { for (const l of [...listeners]) l() }
  const known = (id: CommandId) => {
    const spec = specs.get(id)
    if (!spec) throw new Error(`unknown command ${id}`)
    return spec
  }
  return {
    register(spec) {
      if (specs.has(spec.id)) throw new Error(`command ${spec.id} is already declared`)
      checkSpec(spec as CommandSpec<never>)
      specs.set(spec.id, spec)
      changed()
      return () => {
        if (specs.get(spec.id) !== spec) return
        specs.delete(spec.id)
        changed()
      }
    },
    get: id => specs.get(id),
    list(filter: CommandFilter = {}) {
      return [...specs.values()].filter(s => (filter.place === undefined || s.place === filter.place) && (filter.group === undefined || s.group === filter.group))
    },
    availability: (id, ctx) => known(id).availability(ctx),
    async run(id, ctx): Promise<RunResult> {
      const spec = known(id)
      const availability = spec.availability(ctx)
      if (!availability.ready) return { ran: false, availability }
      await spec.run(ctx)
      return { ran: true }
    },
    search(query, resolveLabel?: (key: MessageKey) => string) {
      return [...specs.values()]
        .map((spec, order) => ({ spec, order, score: matchScore(query, { label: resolveLabel?.(spec.labelKey) ?? '', id: spec.id }) }))
        .filter(m => m.score !== null)
        .sort((a, b) => a.score! - b.score! || a.order - b.order)
        .map(m => m.spec)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
