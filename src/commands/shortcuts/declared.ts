// WO-3282 (UI M2 W1-E): where bindings come from. A command's own `shortcut` in its declaration is
// its binding, except the CAM rows the operator can remap (WO-3257): those live in ONE store,
// uiPrefs.camShortcutOverrides, read through lib/shortcuts/camShortcutRegistry at key time, so
// a change in Settings applies to the next key press and no second copy of the map exists.
import {
  CAM_SHORTCUT_IDS, camBindingLabel, effectiveCamBindings, type CamShortcutId,
} from '../../lib/shortcuts/camShortcutRegistry'
import type { CommandContext, CommandId, CommandRegistry, Shortcut, ShortcutManager } from '../types'
import { normalizeShortcut } from './spelling'

/** Which command each remappable CAM row runs (Wave 2 registers the real Toolpath commands). */
export type CamShortcutCommands = Partial<Readonly<Record<CamShortcutId, CommandId>>>

/** The remapped CAM chords in force for the stored overrides (the same blob uiPrefs keeps), as
 *  shortcut -> command. An unassigned row binds nothing. */
export function camRemappedBindings(commands: CamShortcutCommands, stored: unknown): Map<Shortcut, CommandId> {
  const effective = effectiveCamBindings(stored)
  const out = new Map<Shortcut, CommandId>()
  for (const row of CAM_SHORTCUT_IDS) {
    const id = commands[row]
    const label = camBindingLabel(effective[row])
    if (id !== undefined && label !== null) out.set(normalizeShortcut(label), id)
  }
  return out
}

/** Bind every declared `shortcut` in the registry, except the commands in `skip` (the remapped
 *  rows, which answer only to the store). Returns the unbind of all of them. */
export function bindDeclaredShortcuts<Ctx extends CommandContext>(
  manager: ShortcutManager, registry: CommandRegistry<Ctx>, skip: ReadonlySet<CommandId> = new Set(),
): () => void {
  const unbind = registry.list()
    .filter(spec => spec.shortcut !== undefined && !skip.has(spec.id))
    .map(spec => manager.bind(spec.shortcut!, spec.id))
  return () => { for (const u of unbind) u() }
}

/** The manager options for the remappable CAM rows: the chords read from the store at key time,
 *  and the commands that answer ONLY to them, so a row the operator unassigned never runs through
 *  a declared default. Spread into createShortcutManager's options. */
export function camShortcutSource(commands: CamShortcutCommands, read: () => unknown) {
  const owned: ReadonlySet<CommandId> = new Set(Object.values(commands).filter((id): id is CommandId => id !== undefined))
  return { remapped: () => camRemappedBindings(commands, read()), remappedCommands: owned }
}
