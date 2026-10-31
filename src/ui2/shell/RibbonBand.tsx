// WO-3285 (UI M2 W1-H): the ribbon card (spec 6.2): the flat workspace tab row with command
// search at its right end, then the active workspace's groups of tools. Folding of groups that do
// not fit belongs to the kit's RibbonGroup lane; here the band simply never wraps or scrolls the
// window, and in the short class the captions hide (the stylesheet reads data-captions).
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useText } from '../../i18n'
import { Button, RibbonGroup, TextField } from '../../components/kit'
import type { Availability } from '../../commands'
import { resolveMessage } from '../../notices'
import { useCamStore } from '../../store'
import { useRegistryVersion, useWorkspaceRegistry, type RibbonActionSpec, type WorkspaceRegistry } from '../registry'
import type { Workspace } from '../registry'
import { WORKSPACE_IDS, enterWorkspace, type WorkspaceId } from './workspaces'

const TAB_LABEL = {
  setup: 'ModeTabStrip.setup', sketch: 'ModeTabStrip.sketch', model: 'ModeTabStrip.model',
  toolpath: 'ModeTabStrip.toolpath', simulate: 'ModeTabStrip.simulate', control: 'ModeTabStrip.control',
} as const satisfies Record<WorkspaceId, string>

/** What a ribbon button does: its command when that is registered (its availability draws the
 *  unavailable look), else its own `run`; an action with neither is not drawn. */
function actionOf(registry: WorkspaceRegistry, action: RibbonActionSpec, workspace: Workspace): { run(): void; availability?: Availability } | null {
  const ctx = { workspace }
  const spec = action.commandId === undefined ? undefined : registry.commandRegistry.get(action.commandId)
  if (spec && action.commandId !== undefined) {
    const commandId = action.commandId
    return { availability: spec.availability(ctx), run: () => void registry.commandRegistry.run(commandId, ctx) }
  }
  return action.run ? { run: action.run } : null
}

/** Redraws the ribbon when a command-backed button's availability changes with the store. */
function useAvailabilityKey(registry: WorkspaceRegistry, workspace: Workspace): string {
  const read = () => registry.ribbonGroups(workspace)
    .flatMap(g => g.actions.map(a => (actionOf(registry, a, workspace)?.availability?.ready === false ? '0' : '1'))).join('')
  return useSyncExternalStore(useCamStore.subscribe, read)
}

function CommandSearch({ folded }: { folded: boolean }) {
  const t = useText('ui2-shell.wo3285')
  const shell = useText('app-shell-settings-menus')
  const registry = useWorkspaceRegistry()
  const version = useRegistryVersion()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the registry's version is the change signal
  const places = useMemo(() => registry.ribbonPlaces(), [registry, version])
  const q = query.trim().toLowerCase()
  const found = q === '' ? [] : places.filter(p => resolveMessage(p.action.labelKey).toLowerCase().includes(q) && actionOf(registry, p.action, p.workspace) !== null)
  if (folded && !expanded) {
    return <Button kind="momentary" testId="ui2-search-fold" label={t('searchCommands')} onPress={() => setExpanded(true)} />
  }
  return (
    <div className="ui2-search" data-testid="ui2-search">
      <TextField testId="ui2-search-field" ariaLabel={t('searchCommands')} placeholder={t('searchPlaceholder')} value={query} onChange={setQuery} />
      {q !== '' && (
        <ul className="ui2-search-results" role="listbox" aria-label={t('searchCommands')}>
          {found.length === 0 && <li className="ui2-search-none">{t('searchNone', { query })}</li>}
          {found.map(p => (
            <li key={p.action.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid={`ui2-search-result-${p.action.id}`}
                onClick={() => { actionOf(registry, p.action, p.workspace)?.run(); setQuery(''); setExpanded(false) }}
              >
                <span>{resolveMessage(p.action.labelKey)}</span>
                <span className="ui2-search-place">{t('searchPlace', { workspace: shell(TAB_LABEL[p.workspace]), group: resolveMessage(p.group.captionKey) })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Ribbon({ active, captions, searchFolded }: { active: WorkspaceId; captions: boolean; searchFolded: boolean }) {
  const t = useText('ui2-shell.wo3285')
  const shell = useText('app-shell-settings-menus')
  const registry = useWorkspaceRegistry()
  useRegistryVersion()
  useAvailabilityKey(registry, active)
  const groups = registry.ribbonGroups(active)
  return (
    <div className="ui2-ribbon" data-ui2-card="ribbon" data-ui2-chrome="" data-testid="ui2-ribbon" data-captions={captions} data-bare={groups.length === 0}>
      <div className="ui2-tabrow">
        <div className="ui2-tabs" role="tablist" aria-label={t('workspaces')}>
          {WORKSPACE_IDS.map((id, i) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="ui2-tab"
              aria-selected={id === active}
              data-testid={`ui2-tab-${id}`}
              data-key={String(i + 1)}
              onClick={() => enterWorkspace(id)}
            >
              <span>{shell(TAB_LABEL[id])}</span>
              <kbd className="ui2-tab-key">{i + 1}</kbd>
            </button>
          ))}
        </div>
        <CommandSearch folded={searchFolded} />
      </div>
      {groups.length > 0 && <div className="ui2-band" role="toolbar" aria-label={shell(TAB_LABEL[active])}>
        {groups.map(g => (
          <RibbonGroup key={g.id} caption={resolveMessage(g.captionKey)} testId={`ui2-group-${g.id}`}>
            {g.actions.map(a => {
              const act = actionOf(registry, a, active)
              if (act === null) return null
              return <Button key={a.id} kind="momentary" testId={`ui2-ribbon-${a.id}`} label={resolveMessage(a.labelKey)} availability={act.availability} commandId={a.commandId} onPress={act.run} />
            })}
          </RibbonGroup>
        ))}
      </div>}
    </div>
  )
}
