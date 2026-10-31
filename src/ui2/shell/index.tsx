// WO-3285 (UI M2 W1-H): the New UI test-drive shell, behind ?newui=1. App bar, six flat workspace
// tabs, the ribbon, a Browser card and a Properties card around the clear view, and the console
// strip, with today's panels hosted unchanged inside (./hosts). Theme and scale switch live. The
// shell reads no geometry or CAM state of its own: every tab and ribbon press is a store action
// the shipped UI already has. WO-3306: the ribbon, Browser, Properties, overlays, strip, windows and
// commands come from the workspace registry (../registry); a slot nobody registered keeps today's
// hosted panel. The kit gallery answers at ?newui=1&gallery=1.
import { useEffect, useState, type CSSProperties } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { textFor, useText } from '../../i18n'
import { Card } from '../../components/kit'
import { READY, bindDeclaredShortcuts, createDialogStack, createShortcutManager, installShortcutListener } from '../../commands'
import { resolveMessage } from '../../notices'
import type { MessageKey } from '../../notices/types'
import { useCamStore } from '../../store'
import { KitGallery } from '../gallery'
import { useRegistryVersion, useWorkspaceRegistry, type WorkspaceRegistry } from '../registry'
import { AppBar } from './AppBar'
import {
  BrowserHost, ConsoleHost, ControlWorkspaceHost, ModelWorkspaceHost, PropertiesHost, ViewportHost, WindowHosts, useAppWiring,
} from './hosts'
import { frameMetrics } from './layout'
import { resolveScale, useShellPrefs, useWindowSize } from './prefs'
import { Ribbon } from './RibbonBand'
import { ViewOverlays } from './ViewOverlays'
import { WORKSPACE_IDS, enterWorkspace, useActiveWorkspaceId, workspaceIdFor, type WorkspaceId } from './workspaces'
import './shell.css'

const shellText = textFor('app-shell-settings-menus')
const TAB_LABEL_KEY = {
  setup: 'app-shell-settings-menus:ModeTabStrip.setup', sketch: 'app-shell-settings-menus:ModeTabStrip.sketch',
  model: 'app-shell-settings-menus:ModeTabStrip.model', toolpath: 'app-shell-settings-menus:ModeTabStrip.toolpath',
  simulate: 'app-shell-settings-menus:ModeTabStrip.simulate', control: 'app-shell-settings-menus:ModeTabStrip.control',
} as const satisfies Record<WorkspaceId, MessageKey>

/** Number keys 1 to 6 pick a workspace, like the tabs, and every lane command that declares a
 *  shortcut answers to it, through the registry's command registry and the shortcut manager (a key
 *  typed into a field never reaches them). Nothing happens, and nothing is refused, with a window
 *  open, while a sketch owns the keys, or inside Control (its keys are its own) for the number
 *  keys. W1-E mounts the app's one listener; this hook is then the one place to delete. */
function useWorkspaceKeys(registry: WorkspaceRegistry, version: number): void {
  useEffect(() => {
    const commands = registry.commandRegistry
    const manager = createShortcutManager({
      registry: commands,
      dialogs: createDialogStack(),
      context: () => ({ workspace: workspaceIdFor(useCamStore.getState().workspace, useCamStore.getState().viewer.mode) }),
    })
    const undo: (() => void)[] = []
    let unbind = () => {}
    let uninstall = () => {}
    const cleanup = () => { uninstall(); unbind(); for (const remove of undo) remove() }
    try {
      WORKSPACE_IDS.forEach((id, i) => {
        const remove = commands.register({
          id: `workspace.${id}`,
          labelKey: TAB_LABEL_KEY[id],
          place: 'global',
          group: 'workspace',
          kind: 'choice',
          availability: () => READY,
          run: () => {
            const s = useCamStore.getState()
            if (s.activeModal !== null || s.workspace === 'control' || s.activeSketch !== null) return
            enterWorkspace(id)
          },
        })
        undo.push(remove)
        manager.bind(String(i + 1), `workspace.${id}`)
      })
      unbind = bindDeclaredShortcuts(manager, commands)
      uninstall = installShortcutListener(document, manager)
    } catch (error) {
      cleanup()
      throw error
    }
    return cleanup
    // the registry's version is the change signal: a lane's commands come and go with it
  }, [registry, version])
}

export function Ui2Shell() {
  const t = useText('ui2-shell.wo3285')
  useText('app-shell-settings-menus')
  const registry = useWorkspaceRegistry()
  const version = useRegistryVersion()
  const prefs = useShellPrefs()
  const win = useWindowSize()
  const scale = resolveScale(prefs.scaleChoice, win.width, win.pixelRatio)
  const m = frameMetrics(win.width, win.height, scale)
  const active = useActiveWorkspaceId()
  const workspace = useCamStore(s => s.workspace)
  const viewerMode = useCamStore(s => s.viewer.mode)
  const modelItemId = useCamStore(s => s.activeModelItemId)
  // Model and Control mount on first entry and stay mounted (hidden) afterwards, as in the shipped shell
  const [modelEverMounted, setModelEverMounted] = useState(workspace === 'part')
  const [controlEverMounted, setControlEverMounted] = useState(workspace === 'control')
  if (workspace === 'part' && !modelEverMounted) setModelEverMounted(true)
  if (workspace === 'control' && !controlEverMounted) setControlEverMounted(true)
  // the rail's flyout belongs to the tab it was opened on and closes with it
  const [railOpenOn, setRailOpenOn] = useState<WorkspaceId | null>(null)
  if (railOpenOn !== null && railOpenOn !== active) setRailOpenOn(null)
  const railOpen = railOpenOn === active
  const [aboutOpen, setAboutOpen] = useState(false)
  const gallery = new URLSearchParams(window.location.search).get('gallery') === '1'
  useAppWiring()
  useWorkspaceKeys(registry, version)
  const sections = registry.browserSections(active)
  const propertiesCardId = useCamStore(st => registry.propertiesCards(active).find(c => c.matches(st))?.id)
  const propertiesCard = registry.propertiesCards(active).find(c => c.id === propertiesCardId)
  const stripItems = registry.stripItems(active)

  const vars = {
    '--ui2-scale': String(scale),
    '--ui2-browser-w': `${m.browserWidth}px`,
    '--ui2-props-w': `${m.propertiesWidth}px`,
    '--ui2-band-h': `${m.groupBand}px`,
    '--ui2-strip-h': `${m.strip}px`,
  } as CSSProperties
  const sizeAttrs = { 'data-ui2-width': m.sizeClass.width, 'data-ui2-short': m.sizeClass.short }
  const rootAttrs = { 'data-ui2': '', 'data-ui2-theme': prefs.theme }

  if (gallery) {
    return (
      <div className="ui2-shell ui2-shell-gallery" data-testid="ui2-shell" style={vars} {...rootAttrs} {...sizeAttrs}>
        <KitGallery prefs={prefs} />
      </div>
    )
  }

  const cam = workspace === 'cam'
  return (
    <>
      <div className="ui2-shell" data-testid="ui2-shell" data-workspace={active} style={vars} {...rootAttrs} {...sizeAttrs}>
        <AppBar prefs={prefs} />
        <Ribbon active={active} captions={m.groupCaptions} searchFolded={m.searchFolded} />
        <main className="ui2-main">
          <div className="ui2-cam" data-active={cam}>
            <div
              className="ui2-slot ui2-slot-browser"
              data-ui2-card="browser"
              data-testid="ui2-card-browser"
              data-railed={m.browserRailed}
              data-open={railOpen}
            >
              {m.browserRailed && (
                <button
                  type="button"
                  className="ui2-rail-button"
                  data-testid="ui2-rail-button"
                  aria-expanded={railOpen}
                  aria-label={railOpen ? t('browserClose') : t('browserOpen')}
                  onClick={() => setRailOpenOn(railOpen ? null : active)}
                >
                  <PanelLeftOpen size={16} aria-hidden="true" />
                </button>
              )}
              <Card title={t('browser')} testId="ui2-browser" onClose={m.browserRailed ? () => setRailOpenOn(null) : undefined} closeLabel={t('browserClose')}>
                {sections.length > 0
                  ? (
                    <div className="ui2-sections" data-registry="browser">
                      {sections.map(section => (
                        <section key={section.id} className="ui2-section" data-testid={`ui2-browser-section-${section.id}`} aria-label={resolveMessage(section.titleKey)}>
                          <section.Component />
                        </section>
                      ))}
                    </div>
                  )
                  : <div className="ui2-host panel-left"><BrowserHost /></div>}
              </Card>
            </div>
            <div className="ui2-view" data-ui2-card="view" data-testid="ui2-view">
              <div className="ui2-viewport"><ViewportHost suspended={!cam} resetKey={viewerMode} /></div>
              {cam && <ViewOverlays workspace={active} />}
            </div>
            <div className="ui2-slot ui2-slot-properties" data-ui2-card="properties" data-testid="ui2-card-properties">
              <Card title={propertiesCard?.titleKey ? resolveMessage(propertiesCard.titleKey) : t('properties')} testId="ui2-properties">
                {propertiesCard
                  ? <div className="ui2-sections" data-registry="properties" data-testid={`ui2-properties-card-${propertiesCard.id}`}><propertiesCard.Component /></div>
                  : <div className="ui2-host panel-right"><PropertiesHost /></div>}
              </Card>
            </div>
          </div>
          {modelEverMounted && (
            <div className="ui2-full" data-active={workspace === 'part'} data-ui2-card="workspace-model" data-testid="part-workspace-host">
              <ModelWorkspaceHost modelItemId={modelItemId ?? undefined} loading={shellText('App.loadingModel')} />
            </div>
          )}
          {controlEverMounted && (
            <div className="ui2-full" data-active={workspace === 'control'} data-ui2-card="workspace-control" data-testid="control-workspace-host">
              <ControlWorkspaceHost loading={shellText('App.loadingControl')} />
            </div>
          )}
        </main>
        {cam && (
          <footer className="ui2-strip" data-ui2-card="strip" data-testid="ui2-strip" aria-label={t('console')}>
            <div className="ui2-strip-inner">
              {stripItems.length > 0 && (
                <div className="ui2-strip-extra" data-registry="strip">
                  {stripItems.map(item => <item.Component key={item.id} />)}
                </div>
              )}
              <ConsoleHost />
            </div>
          </footer>
        )}
      </div>
      {/* the windows mount beside the shell, so they carry the chosen theme and scale themselves */}
      <div className="ui2-windows" data-testid="ui2-windows" style={vars} {...rootAttrs}>
        <WindowHosts aboutOpen={aboutOpen} onAbout={() => setAboutOpen(true)} onAboutClose={() => setAboutOpen(false)} replaced={registry.replacedWindows()} />
        {registry.windows().map(w => <w.Component key={w.id} />)}
      </div>
    </>
  )
}
