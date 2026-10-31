// WO-3282 (UI M2 W1-E): the command registry, the one shortcut manager and its keydown listener,
// command search and the one dialog stack, behind the WO-3275 contracts in ./types. Each part
// lives in its own folder; this barrel keeps the names the Wave 0 stub exported.
export * from './types'
export { createCommandRegistry, type LiveCommandRegistry } from './registry'
export {
  bindDeclaredShortcuts, camRemappedBindings, camShortcutSource, chordFromEvent, chordToShortcut, createShortcutManager, hasMod,
  declaredShiftProblem, installShortcutListener, isMacPlatform, normalizeShortcut, shortcutText, typedShortcut, useShortcutListener,
  type CamShortcutCommands, type LiveShortcutManager, type ShortcutManagerOptions,
} from './shortcuts'
export { searchCommands, type CommandSearchOptions, type CommandSearchRow } from './search'
export { CommandSearch, type CommandSearchProps } from './search/CommandSearch'
export { createDialogStack, dialogStack, useDialogEntry, type LiveDialogStack } from './dialogStack'
