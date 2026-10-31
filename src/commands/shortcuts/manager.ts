// WO-3282 (UI M2 W1-E): the one shortcut manager (M2-PLAN standard 6).
//
// What a key press does, in order:
//   1. Escape goes to the dialog stack first; the top dialog takes it and nothing else does.
//   2. While a dialog is open, no command behind it runs (the dialog owns its own keys).
//   3. A key typed into a field runs only Escape and Mod chords, so typing 'G' is a G.
//   4. A bound command runs only in its own workspace, or anywhere when its place is 'global',
//      so one letter means one thing on screen (a CAM 'N' never fires in Model).
//   5. It runs through the registry: an unavailable command posts its own availability() reason
//      through the one refusal route (notices.refuse), and nothing moves.
// A command that throws or rejects is contained and reported; it never becomes an unhandled
// rejection, even when the error handler itself throws.
import { notices } from '../../notices'
import type {
  Availability, CommandContext, CommandId, CommandRegistry, DialogStack, KeyChord, Shortcut, ShortcutManager,
} from '../types'
import { chordToShortcut, declaredShiftProblem, hasMod, isMacPlatform, normalizeShortcut } from './spelling'

export interface ShortcutManagerOptions<Ctx extends CommandContext> {
  readonly registry: CommandRegistry<Ctx>
  readonly dialogs: DialogStack
  readonly context: () => Ctx
  /** Cmd is Mod. Default: read from the browser. */
  readonly isMac?: boolean
  /** A bound command that is not available now. Default: notices.refuse (the one refusal route). */
  readonly onRefused?: (id: CommandId, availability: Availability) => void
  /** A command (or its availability check) that threw. Default: console.error. */
  readonly onError?: (id: CommandId, error: unknown) => void
  /** Bindings kept in another store and read at key time (the operator's remapped CAM keys,
   *  camRemappedBindings). They win over a declared binding of the same chord. */
  readonly remapped?: () => ReadonlyMap<Shortcut, CommandId>
  /** Commands that answer only to `remapped` (camShortcutSource): their declared binding never
   *  runs, so an unassigned row stays unassigned. */
  readonly remappedCommands?: ReadonlySet<CommandId>
}

/** The manager this module builds: the contract plus `claims`, the same decision as handle()
 *  without running anything (the listener asks it for a held key). */
export interface LiveShortcutManager extends ShortcutManager {
  claims(chord: KeyChord): boolean
}

function report(onError: ShortcutManagerOptions<CommandContext>['onError'], id: CommandId, error: unknown) {
  try {
    if (onError) onError(id, error)
    else console.error(`command ${id} failed`, error)
  } catch (handlerError) {
    console.error(`command ${id} failed, and so did its error handler`, error, handlerError)
  }
}

export function createShortcutManager<Ctx extends CommandContext>(options: ShortcutManagerOptions<Ctx>): LiveShortcutManager {
  const declared = new Map<Shortcut, CommandId>()
  const isMac = options.isMac ?? isMacPlatform()
  const onRefused = options.onRefused ?? ((id: CommandId, availability: Availability) => { notices.refuse(id, availability) })
  const remapped = () => options.remapped?.() ?? new Map<Shortcut, CommandId>()
  const remappedCommands = () => new Set([...(options.remappedCommands ?? []), ...remapped().values()])
  const runsHere = (id: CommandId | undefined, ctx: Ctx) => {
    const spec = id === undefined ? undefined : options.registry.get(id)
    return !!spec && (spec.place === 'global' || spec.place === ctx.workspace)
  }
  /** The command a chord runs now: the remapped one when it belongs here, else the declared one. */
  const resolve = (chord: KeyChord): { id: CommandId; ctx: Ctx } | undefined => {
    if (options.dialogs.size > 0) return undefined
    if (chord.editable && chord.key !== 'Escape' && !hasMod(chord, isMac)) return undefined
    const key = chordToShortcut(chord, isMac)
    const ctx = options.context()
    const own = remapped().get(key)
    if (runsHere(own, ctx)) return { id: own!, ctx }
    const id = declared.get(key)
    if (id !== undefined && !remappedCommands().has(id) && runsHere(id, ctx)) return { id, ctx }
    return undefined
  }

  const manager: LiveShortcutManager = {
    bind(shortcut, commandId) {
      const problem = declaredShiftProblem(shortcut)
      if (problem) throw new Error(problem)
      const key = normalizeShortcut(shortcut)
      if (declared.has(key)) throw new Error(`shortcut ${key} is already bound to ${declared.get(key)}`)
      declared.set(key, commandId)
      return () => { if (declared.get(key) === commandId) declared.delete(key) }
    },
    lookup(chord) {
      const key = chordToShortcut(chord, isMac)
      const own = remapped()
      if (own.has(key)) return own.get(key)
      const id = declared.get(key)
      // a remapped command answers only to its remapped chord
      return id !== undefined && !remappedCommands().has(id) ? id : undefined
    },
    handle(chord: KeyChord) {
      if (chord.key === 'Escape' && options.dialogs.handleEscape()) return true
      const found = resolve(chord)
      if (!found) return false
      const { id, ctx } = found
      let running: Promise<{ ran: boolean; availability?: Availability }>
      try {
        running = options.registry.run(id, ctx)
      } catch (error) {
        report(options.onError, id, error)
        return true
      }
      running.then(
        result => {
          if (result.ran || !result.availability) return
          try { onRefused(id, result.availability) } catch (error) { report(options.onError, id, error) }
        },
        error => report(options.onError, id, error),
      )
      return true
    },
    claims: chord => resolve(chord) !== undefined,
    bindings() {
      const all = new Map<Shortcut, CommandId>()
      const moved = remappedCommands()
      for (const [key, id] of declared) if (!moved.has(id)) all.set(key, id)
      for (const [key, id] of remapped()) all.set(key, id)
      return all
    },
  }
  return manager
}
