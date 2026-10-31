// WO-3275 (UI M2 Wave 0): the command registry contract (M2-PLAN standard 6).
// Each command is declared ONCE: id, label key, icon, workspace and group, action kind, shortcut,
// and availability() returning ready or a reason. The ribbon, command search, shortcuts, tooltips
// and the unavailable look all come from that one declaration. One shortcut manager and one
// dialog stack replace the per-screen keydown listeners: Escape closes the top dialog and
// nothing else listens.
// Wave 1 (W1-E) replaces the stubs in ./index.ts; only the Wave 0 owner changes this file.
import type { ActionKind } from '../components/kit/types'
import type { MessageKey, MessageParams } from '../notices/types'

/** Dotted command id, '<workspace or area>.<verb>', e.g. 'toolpath.generate'. */
export type CommandId = `${string}.${string}`

/** The six workspace tabs, plus 'global' for commands that live in every workspace
 *  (command search, undo, settings). No feature adds a workspace (spec 6.2). */
export const WORKSPACES = ['setup', 'sketch', 'model', 'toolpath', 'simulate', 'control'] as const
export type Workspace = (typeof WORKSPACES)[number]
export type CommandPlace = Workspace | 'global'

/** An icon id from the LienCAM icon source (W1-I owns the set). */
export type IconId = string

/** Ready, or the reason the software cannot run the command now (LIENCAM.md rule 11: only
 *  what it truly cannot do). The reason is a catalogue key that says why and what makes it
 *  available (spec 7). lock = an interlock holds it (the unavailable look adds a lock glyph). */
export type Availability =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: MessageKey; readonly params?: MessageParams; readonly lock?: boolean }

export const READY: Availability = Object.freeze({ ready: true }) as Availability

/** A key chord in one portable form: modifiers in the order Mod, Ctrl, Alt, Shift, then the key,
 *  joined by '+'. 'Mod' is Ctrl on Windows and Linux and Cmd on macOS; bind with 'Mod', never
 *  'Ctrl' (on Windows and Linux the Ctrl key reads as 'Mod'; 'Ctrl' names the macOS Control key).
 *  Keys are KeyboardEvent.key names with letters upper case, except two that cannot be spelled
 *  between '+' signs: the space bar is 'Space' and the plus key is 'Plus'.
 *  Examples: 'G', 'Shift+D', 'Mod+Shift+P', 'Escape', 'Delete', 'Space', 'Mod+Plus'. */
export type Shortcut = string

/** What a command sees when it checks availability or runs. Workspaces extend it through the
 *  registry's type parameter; the base carries only the active workspace. */
export interface CommandContext {
  readonly workspace: Workspace
}

export interface CommandSpec<Ctx extends CommandContext = CommandContext> {
  readonly id: CommandId
  readonly labelKey: MessageKey
  /** Tooltip and command-search help line. */
  readonly helpKey?: MessageKey
  readonly icon?: IconId
  readonly place: CommandPlace
  /** Ribbon group id within the workspace ('exit' is the context-mode Exit group). */
  readonly group: string
  readonly kind: ActionKind
  readonly shortcut?: Shortcut
  availability(ctx: Ctx): Availability
  run(ctx: Ctx): void | Promise<void>
  /** momentary press-and-hold commands (a jog key): called when the press ends. */
  release?(ctx: Ctx): void
  /** latched: whether it is on now (the lamp). choice: whether it is the selected option.
   *  The ribbon reads this to draw the Button's on/selected state. */
  isOn?(ctx: Ctx): boolean
}

/** The result of asking the registry to run a command: it ran, or it was not available
 *  (and nothing moved). */
export type RunResult =
  | { readonly ran: true }
  | { readonly ran: false; readonly availability: Availability }

export interface CommandFilter {
  readonly place?: CommandPlace
  readonly group?: string
}

export interface CommandRegistry<Ctx extends CommandContext = CommandContext> {
  /** Declare a command; a second declaration of the same id throws. Returns the undo. */
  register(spec: CommandSpec<Ctx>): () => void
  get(id: CommandId): CommandSpec<Ctx> | undefined
  /** Commands in declaration order, optionally narrowed. */
  list(filter?: CommandFilter): readonly CommandSpec<Ctx>[]
  /** The command's own availability(). An unknown id is a programming error and throws; it is
   *  never shown to the operator as a refusal. */
  availability(id: CommandId, ctx: Ctx): Availability
  /** Checks availability() first; never runs an unavailable command. An unknown id throws. */
  run(id: CommandId, ctx: Ctx): Promise<RunResult>
  /** Command search: matches the query against ids and resolved labels (resolveLabel turns a
   *  label key into the operator's language). */
  search(query: string, resolveLabel?: (key: MessageKey) => string): readonly CommandSpec<Ctx>[]
}

/** The subset of a KeyboardEvent the shortcut manager reads (so it is testable without a DOM). */
export interface KeyChord {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  /** The key landed in a text entry (input, textarea, contenteditable). The manager then handles
   *  only Escape and chords with Mod, so typing a 'G' into a field never runs a command. */
  readonly editable?: boolean
}

export interface ShortcutManager {
  /** Bind a shortcut to a command; a shortcut already bound throws. Returns the unbind. */
  bind(shortcut: Shortcut, commandId: CommandId): () => void
  /** The command bound to a chord, if any (platform 'Mod' resolved). */
  lookup(chord: KeyChord): CommandId | undefined
  /** The one key handler: Escape goes to the dialog stack first; a bound chord runs its command
   *  through the registry. Returns true when the key was handled. */
  handle(chord: KeyChord): boolean
  /** Every binding, for the shortcut list and conflict checks. */
  bindings(): ReadonlyMap<Shortcut, CommandId>
}

/** The ONE keydown listener (W1-E mounts it once, at the app root of the New UI): it reads each
 *  keydown into a KeyChord (editable set from the event target), passes it to the manager, and
 *  calls preventDefault when the manager handled it. Returns the uninstall. No other code adds a
 *  keydown listener in the New UI. */
export type InstallShortcutListener = (target: EventTarget, manager: ShortcutManager) => () => void

export interface DialogStack {
  /** Open a dialog on top; onEscape runs when Escape reaches it. Returns the close (idempotent). */
  push(id: string, onEscape: () => void): () => void
  /** The id of the top dialog, if any. */
  top(): string | undefined
  readonly size: number
  /** Escape closes the top dialog and nothing else. Returns true when a dialog took it. */
  handleEscape(): boolean
}
