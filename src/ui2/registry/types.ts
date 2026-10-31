// WO-3306 (UI M2 Wave 2 seam): the workspace registry contract. A lane adds to the New UI shell
// from its own folder by exporting one `registration` (a WorkspaceRegistration) from
// `src/ui2/<folder>/registration.ts` or `.tsx`; the shell collects every such file and reads only
// the registry, so no lane edits a shared shell file. A slot nobody registered keeps today's
// hosted panel. After this lands, only the Wave 0 owner changes this file (one-line requests on
// the PR).
import type { ComponentType } from 'react'
import type { CommandRegistry, CommandSpec, Workspace } from '../../commands/types'
import type { useCamStore } from '../../store'
import type { MessageKey } from '../../notices/types'

export type { Workspace }

/** Who registered a thing: the lane's folder name under src/ui2/ ('setup', 'toolpath'), or 'shell'. */
export type OwnerId = string

/** The workspaces a registration appears in: one, several, or every one. */
export type RegistryScope = Workspace | readonly Workspace[] | 'all'

/** The store, read by selectors: a Show row's lamp, a Properties card's selection test. */
export type RegistryState = ReturnType<typeof useCamStore.getState>

/** One button in a ribbon group. It runs a command by id (the way across lanes, W1-E) or a plain
 *  `run`; with `commandId` the command's availability() draws the button's unavailable look. A
 *  `commandId` nobody has registered (its lane has not landed) falls back to `run`; with no `run`
 *  either the button is not drawn. */
export interface RibbonActionSpec {
  readonly id: string
  readonly labelKey: MessageKey
  readonly commandId?: `${string}.${string}`
  run?(): void
}

/** A group of tools in the ribbon band. `order` sorts groups across lanes (lower first; ties keep
 *  registration order). A group with `mode` shows only while that mode is active, and while a mode
 *  is active only its groups and the Exit group show. `replaces` names a group of the shell's own
 *  table (owner 'shell') that this group takes over; it is the only way to take a group over. */
export interface RibbonGroupRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly order: number
  readonly captionKey: MessageKey
  readonly actions: readonly RibbonActionSpec[]
  readonly mode?: string
  readonly replaces?: string
}

/** A mode of one workspace (Form, Relief and Drawing in Model; Nest in Setup): its own ribbon
 *  groups (groups that name its id in `mode`) and an Exit that returns to the workspace's own
 *  ribbon. Lanes enter and leave through `registry.enterMode(id)` / `registry.exitMode(workspace)`. */
export interface ModeRegistration {
  readonly id: string
  readonly workspace: Workspace
  readonly labelKey: MessageKey
  readonly exitLabelKey: MessageKey
  onExit?(): void
}

/** A section of the Browser card, in `order`. Once a workspace has any section registered the
 *  sections replace its hosted Browser panel. */
export interface BrowserSectionRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly order: number
  readonly titleKey: MessageKey
  readonly Component: ComponentType
}

/** The Properties card for one selection kind of a workspace. `kind` is unique per workspace;
 *  `matches` reads the store; with several matching, the lowest `order` wins. A selection no card
 *  matches keeps today's hosted Properties panel. */
export interface PropertiesCardRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly kind: string
  readonly order: number
  readonly titleKey?: MessageKey
  matches(state: RegistryState): boolean
  readonly Component: ComponentType
}

/** Something drawn over the clear view, beside the View cube (left) or the Show card (right). */
export interface ViewOverlayRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly order: number
  readonly placement: 'left' | 'right'
  readonly Component: ComponentType
}

/** A row of the Show card. `isOn` reads the store; `toggle` flips it. */
export interface ShowRowRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly order: number
  readonly labelKey: MessageKey
  isOn(state: RegistryState): boolean
  toggle(): void
}

/** The ids of today's hosted windows (src/ui2/shell/hosts.tsx WindowHosts). A window registration
 *  names one in `replaces` to take it over; the hosted one then stops mounting. */
export const HOSTED_WINDOW_IDS = [
  'setup', 'machine-library', 'tool-library', 'new-operation', 'sketch-entry', 'model-entry', 'settings',
  'export', 'help', 'about', 'post-process', 'nest', 'project-startup', 'guided-setup', 'boolean-mesh',
  'mesh-viewer', 'confirm', 'multi-body-import', 'import-stock-choice', 'tooltip',
] as const
export type HostedWindowId = (typeof HOSTED_WINDOW_IDS)[number]

/** A window mounted once at the root of the New UI; it decides for itself when it is open. */
export interface WindowRegistration {
  readonly id: string
  readonly Component: ComponentType
  readonly replaces?: HostedWindowId
}

/** An item in the app bar: `status` beside the machine pill, `actions` among the window buttons. */
export interface AppBarItemRegistration {
  readonly id: string
  readonly order: number
  readonly area: 'status' | 'actions'
  readonly Component: ComponentType
}

/** An item in the console strip, beside today's console. */
export interface StripItemRegistration {
  readonly id: string
  readonly workspace: RegistryScope
  readonly order: number
  readonly Component: ComponentType
}

/** Everything one lane contributes. All parts optional. */
export interface WorkspaceRegistration {
  readonly owner: OwnerId
  readonly ribbonGroups?: readonly RibbonGroupRegistration[]
  readonly modes?: readonly ModeRegistration[]
  readonly browserSections?: readonly BrowserSectionRegistration[]
  readonly propertiesCards?: readonly PropertiesCardRegistration[]
  readonly viewOverlays?: readonly ViewOverlayRegistration[]
  readonly showRows?: readonly ShowRowRegistration[]
  readonly windows?: readonly WindowRegistration[]
  readonly appBarItems?: readonly AppBarItemRegistration[]
  readonly stripItems?: readonly StripItemRegistration[]
  readonly commands?: readonly CommandSpec[]
}

/** A one-thing slot was registered twice. The message names both owners. */
export class RegistryConflictError extends Error {
  readonly slot: string
  readonly key: string
  readonly first: OwnerId
  readonly second: OwnerId
  constructor(slot: string, key: string, first: OwnerId, second: OwnerId) {
    super(`${slot} "${key}" is registered by both "${first}" and "${second}"`)
    this.name = 'RegistryConflictError'
    this.slot = slot
    this.key = key
    this.first = first
    this.second = second
  }
}

export interface WorkspaceRegistry {
  /** Add a lane's registration. Throws RegistryConflictError, adding nothing, when a one-thing slot
   *  (a group id, a mode id, a Properties kind per workspace, a command id, an id of any other
   *  part) is already held. Returns the undo. */
  register(registration: WorkspaceRegistration): () => void
  /** Ribbon groups for a workspace: its mode's groups and Exit while a mode is active, else the
   *  groups without a mode; by order. */
  ribbonGroups(workspace: Workspace): readonly RibbonGroupRegistration[]
  /** Every ribbon action once, with the first place it shows (command search lists these). */
  ribbonPlaces(): readonly { readonly workspace: Workspace; readonly group: RibbonGroupRegistration; readonly action: RibbonActionSpec }[]
  browserSections(workspace: Workspace): readonly BrowserSectionRegistration[]
  propertiesCards(workspace: Workspace): readonly PropertiesCardRegistration[]
  viewOverlays(workspace: Workspace, placement: 'left' | 'right'): readonly ViewOverlayRegistration[]
  showRows(workspace: Workspace): readonly ShowRowRegistration[]
  windows(): readonly WindowRegistration[]
  /** The hosted windows a registered window took over. */
  replacedWindows(): ReadonlySet<HostedWindowId>
  appBarItems(area: 'status' | 'actions'): readonly AppBarItemRegistration[]
  stripItems(workspace: Workspace): readonly StripItemRegistration[]
  /** The live command registry every lane's `commands` are declared into (the shell adds the
   *  workspace.<id> tab commands). Ribbon buttons, shortcuts and command search read it. */
  readonly commandRegistry: CommandRegistry
  modes(workspace: Workspace): readonly ModeRegistration[]
  activeMode(workspace: Workspace): ModeRegistration | undefined
  enterMode(id: string): void
  exitMode(workspace: Workspace): void
  /** Changes whenever a registration or the active mode changes (for useSyncExternalStore). */
  readonly version: () => number
  subscribe(listener: () => void): () => void
}
