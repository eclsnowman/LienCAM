// WO-3306: the workspace registry. Registrations are plain data (see ./types); this collects them,
// refuses a second holder of a one-thing slot before adding anything, and answers the shell's
// questions per workspace. Everything is derived from the list of registrations, so an undo
// restores exactly what was there before.
import { createCommandRegistry } from '../../commands'
import { WORKSPACES } from '../../commands/types'
import {
  HOSTED_WINDOW_IDS, RegistryConflictError,
  type HostedWindowId, type ModeRegistration, type OwnerId, type RegistryScope, type RibbonActionSpec, type RibbonGroupRegistration,
  type Workspace, type WorkspaceRegistration, type WorkspaceRegistry,
} from './types'

/** The owner of the shell's own table (its ribbon groups and Show rows). */
export const SHELL_OWNER: OwnerId = 'shell'

export function scopeIncludes(scope: RegistryScope, workspace: Workspace): boolean {
  return scope === 'all' || scope === workspace || (typeof scope !== 'string' && scope.includes(workspace))
}

function scopeWorkspaces(scope: RegistryScope): readonly Workspace[] {
  return WORKSPACES.filter(w => scopeIncludes(scope, w))
}

interface Entry { readonly registration: WorkspaceRegistration }

type PartKey = Exclude<keyof WorkspaceRegistration, 'owner'>
type Part<K extends PartKey> = NonNullable<WorkspaceRegistration[K]>[number]

/** Every item a registration declares in one part, tagged with its owner. */
function owned<K extends PartKey>(registration: WorkspaceRegistration, key: K): { owner: OwnerId; item: Part<K> }[] {
  const items = (registration[key] ?? []) as readonly Part<K>[]
  return items.map(item => ({ owner: registration.owner, item }))
}

const byOrder = <T extends { readonly order: number }>(a: { item: T }, b: { item: T }) => a.item.order - b.item.order

export function createWorkspaceRegistry(): WorkspaceRegistry {
  const entries: Entry[] = []
  const listeners = new Set<() => void>()
  const activeModes = new Map<Workspace, string>()
  const commandRegistry = createCommandRegistry()
  let version = 0
  let cache = new Map<string, unknown>()

  const changed = () => {
    version += 1
    cache = new Map()
    for (const l of [...listeners]) l()
  }
  const memo = <T,>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make())
    return cache.get(key) as T
  }

  /** All items of a part across registrations, in registration order. */
  const all = <K extends PartKey>(key: K) => entries.flatMap(e => owned(e.registration, key))

  const replacedGroupIds = (list: readonly Entry[]) => {
    const out = new Set<string>()
    for (const e of list) for (const g of e.registration.ribbonGroups ?? []) if (g.replaces !== undefined) out.add(g.replaces)
    return out
  }

  function validate(incoming: WorkspaceRegistration): void {
    const owner = incoming.owner
    const clash = (slot: string, key: string, first: OwnerId) => { throw new RegistryConflictError(slot, key, first, owner) }
    const checkIds = (slot: string, key: PartKey) => {
      const held = new Map<string, OwnerId>()
      for (const { owner: o, item } of all(key)) held.set(item.id, o)
      for (const { item } of owned(incoming, key)) {
        const first = held.get(item.id)
        if (first !== undefined) clash(slot, item.id, first)
        held.set(item.id, owner)
      }
    }

    // ribbon groups: ids are unique among the groups still standing; `replaces` takes over a shell group
    const replaced = replacedGroupIds(entries)
    const shellGroups = new Set((entries.find(e => e.registration.owner === SHELL_OWNER)?.registration.ribbonGroups ?? []).map(g => g.id))
    for (const g of incoming.ribbonGroups ?? []) {
      if (g.replaces === undefined) continue
      if (g.replaces === g.id) throw new Error(`ribbon group "${g.id}" of "${owner}" replaces itself; give the replacement its own id`)
      if (!shellGroups.has(g.replaces) || replaced.has(g.replaces)) {
        throw new Error(`ribbon group "${g.id}" of "${owner}" replaces "${g.replaces}", which is not a group of the shell left to take over`)
      }
    }
    const incomingReplaced = new Set((incoming.ribbonGroups ?? []).flatMap(g => (g.replaces === undefined ? [] : [g.replaces])))
    const standing = new Map<string, OwnerId>()
    for (const { owner: o, item } of all('ribbonGroups')) if (!replaced.has(item.id)) standing.set(item.id, o)
    for (const id of incomingReplaced) standing.delete(id)
    for (const { item } of owned(incoming, 'ribbonGroups')) {
      const first = standing.get(item.id)
      if (first !== undefined) clash('ribbon group', item.id, first)
      standing.set(item.id, owner)
    }

    checkIds('mode', 'modes')
    checkIds('Browser section', 'browserSections')
    checkIds('Properties card', 'propertiesCards')
    checkIds('view overlay', 'viewOverlays')
    checkIds('Show row', 'showRows')
    checkIds('window', 'windows')
    checkIds('app bar item', 'appBarItems')
    checkIds('strip item', 'stripItems')
    checkIds('command', 'commands')

    // the shell owns the workspace.<id> tab commands and the number keys 1 to 6; a shortcut is held once
    const chords = new Map<string, OwnerId>(WORKSPACES.map((_, i) => [String(i + 1), SHELL_OWNER]))
    for (const { owner: o, item } of all('commands')) if (item.shortcut !== undefined) chords.set(item.shortcut, o)
    for (const spec of incoming.commands ?? []) {
      if (spec.id.startsWith('workspace.')) clash('command', spec.id, SHELL_OWNER)
      if (spec.shortcut === undefined) continue
      const first = chords.get(spec.shortcut)
      if (first !== undefined) clash(`shortcut "${spec.shortcut}" of command`, spec.id, first)
      chords.set(spec.shortcut, owner)
    }

    // a Properties card per selection kind and workspace
    const kinds = new Map<string, OwnerId>()
    for (const { owner: o, item } of all('propertiesCards')) for (const w of scopeWorkspaces(item.workspace)) kinds.set(`${w}/${item.kind}`, o)
    for (const card of incoming.propertiesCards ?? []) {
      for (const w of scopeWorkspaces(card.workspace)) {
        const first = kinds.get(`${w}/${card.kind}`)
        if (first !== undefined) clash(`Properties card for "${card.kind}" in ${w}, card`, card.id, first)
        kinds.set(`${w}/${card.kind}`, owner)
      }
    }

    // a hosted window is taken over by one window only
    const hosts = new Map<string, OwnerId>()
    for (const { owner: o, item } of all('windows')) if (item.replaces !== undefined) hosts.set(item.replaces, o)
    for (const w of incoming.windows ?? []) {
      if (w.replaces === undefined) continue
      if (!(HOSTED_WINDOW_IDS as readonly string[]).includes(w.replaces)) {
        throw new Error(`window "${w.id}" of "${owner}" replaces "${w.replaces}", which is not a hosted window`)
      }
      const first = hosts.get(w.replaces)
      if (first !== undefined) clash('hosted window', w.replaces, first)
      hosts.set(w.replaces, owner)
    }
  }

  const allModes = (): ModeRegistration[] => all('modes').map(m => m.item)
  const activeMode = (workspace: Workspace) => {
    const id = activeModes.get(workspace)
    return id === undefined ? undefined : allModes().find(m => m.id === id)
  }

  const exitGroup = (mode: ModeRegistration): RibbonGroupRegistration => ({
    id: 'exit',
    workspace: mode.workspace,
    order: 0,
    captionKey: mode.labelKey,
    actions: [{ id: 'exit', labelKey: mode.exitLabelKey, run: () => registry.exitMode(mode.workspace) }],
  })

  const registry: WorkspaceRegistry = {
    commandRegistry,
    register(registration) {
      validate(registration)
      const entry: Entry = { registration }
      const undoCommands: (() => void)[] = []
      try {
        for (const spec of registration.commands ?? []) undoCommands.push(commandRegistry.register(spec))
      } catch (error) {
        for (const undo of undoCommands) undo()
        throw error
      }
      entries.push(entry)
      changed()
      return () => {
        const at = entries.indexOf(entry)
        if (at < 0) return
        entries.splice(at, 1)
        for (const undo of undoCommands) undo()
        for (const m of registration.modes ?? []) if (activeModes.get(m.workspace) === m.id) activeModes.delete(m.workspace)
        changed()
      }
    },
    ribbonGroups(workspace) {
      return memo(`groups/${workspace}`, () => {
        const mode = activeMode(workspace)
        const replaced = replacedGroupIds(entries)
        const groups = all('ribbonGroups')
          .filter(({ item }) => !replaced.has(item.id) && scopeIncludes(item.workspace, workspace) && (mode ? item.mode === mode.id : item.mode === undefined))
          .sort(byOrder)
          .map(({ item }) => item)
        return mode ? [...groups, exitGroup(mode)] : groups
      })
    },
    ribbonPlaces() {
      return memo('places', () => {
        const seen = new Set<string>()
        const out: { workspace: Workspace; group: RibbonGroupRegistration; action: RibbonActionSpec }[] = []
        const replaced = replacedGroupIds(entries)
        for (const workspace of WORKSPACES) {
          const groups = all('ribbonGroups')
            .filter(({ item }) => !replaced.has(item.id) && item.mode === undefined && scopeIncludes(item.workspace, workspace))
            .sort(byOrder)
          for (const { item: group } of groups) {
            for (const action of group.actions) {
              if (seen.has(action.id)) continue
              seen.add(action.id)
              out.push({ workspace, group, action })
            }
          }
        }
        return out
      })
    },
    browserSections: workspace => memo(`browser/${workspace}`, () => all('browserSections').filter(({ item }) => scopeIncludes(item.workspace, workspace)).sort(byOrder).map(x => x.item)),
    propertiesCards: workspace => memo(`properties/${workspace}`, () => all('propertiesCards').filter(({ item }) => scopeIncludes(item.workspace, workspace)).sort(byOrder).map(x => x.item)),
    viewOverlays: (workspace, placement) => memo(`overlays/${workspace}/${placement}`, () => all('viewOverlays').filter(({ item }) => item.placement === placement && scopeIncludes(item.workspace, workspace)).sort(byOrder).map(x => x.item)),
    showRows: workspace => memo(`show/${workspace}`, () => all('showRows').filter(({ item }) => scopeIncludes(item.workspace, workspace)).sort(byOrder).map(x => x.item)),
    windows: () => memo('windows', () => all('windows').map(x => x.item)),
    replacedWindows: () => memo('replaced', () => new Set<HostedWindowId>(all('windows').flatMap(({ item }) => (item.replaces === undefined ? [] : [item.replaces])))),
    appBarItems: area => memo(`appbar/${area}`, () => all('appBarItems').filter(({ item }) => item.area === area).sort(byOrder).map(x => x.item)),
    stripItems: workspace => memo(`strip/${workspace}`, () => all('stripItems').filter(({ item }) => scopeIncludes(item.workspace, workspace)).sort(byOrder).map(x => x.item)),
    modes: workspace => memo(`modes/${workspace}`, () => allModes().filter(m => m.workspace === workspace)),
    activeMode,
    enterMode(id) {
      const mode = allModes().find(m => m.id === id)
      if (!mode) throw new Error(`unknown mode "${id}"`)
      activeModes.set(mode.workspace, id)
      changed()
    },
    exitMode(workspace) {
      const mode = activeMode(workspace)
      if (activeModes.delete(workspace)) changed()
      mode?.onExit?.()
    },
    version: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return registry
}
