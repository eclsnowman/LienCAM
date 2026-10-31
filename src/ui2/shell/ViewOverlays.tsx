// WO-3285 (UI M2 W1-H): the View cube (lower left of the clear view) and the Show card (bottom
// right; its header is the button and the list opens upward), spec 5. They act on the viewport
// that exists today: the cube asks its camera for a standard view, the card flips the same viewer
// flags the viewport already reads. WO-3306: the Show rows and any extra overlays come from the
// workspace registry (the shell's own six rows are its first registration).
import { useEffect, useRef, type RefObject } from 'react'
import { useText } from '../../i18n'
import { ShowCard, ViewCube, type ShowItem, type ViewPreset, type ViewStyle } from '../../components/kit'
import { resolveMessage } from '../../notices'
import { useCamStore } from '../../store'
import type { ShadingMode } from '../../types'
import { useRegistryVersion, useWorkspaceRegistry, type ViewOverlayRegistration, type Workspace } from '../registry'

const VIEW_LABEL = {
  top: 'viewTop', bottom: 'viewBottom', front: 'viewFront', back: 'viewBack', left: 'viewLeft', right: 'viewRight', iso: 'viewIso',
} as const satisfies Record<ViewPreset, string>

/** The kit's view styles that the viewport has a mode for; the others have none today. */
const STYLE_TO_MODE: Partial<Record<ViewStyle, ShadingMode>> = { shaded: 'shaded-no-edges', 'shaded-edges': 'shaded-edges' }

function styleOf(mode: ShadingMode): ViewStyle {
  return mode === 'shaded-no-edges' ? 'shaded' : 'shaded-edges'
}

function viewportCamera(): { setCameraView?(view: ViewPreset): void } | undefined {
  return Reflect.get(window, '__cncViewport') as { setCameraView?(view: ViewPreset): void } | undefined
}

/** The viewport lifts its own bottom controls above the playback bar by publishing the bar's height
 *  as --sim-panel-h on its root; this mirrors it onto the overlay holder so the cube and the Show
 *  card ride above the bar the same way. */
function useSimPanelHeight(holder: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const view = holder.current?.closest('.ui2-view')
    if (!view || !holder.current) return
    const el = holder.current
    const sync = () => {
      const root = view.querySelector('.viewport-root')
      const h = root ? getComputedStyle(root).getPropertyValue('--sim-panel-h').trim() : ''
      el.style.setProperty('--ui2-sim-h', h === '' ? '0px' : h)
    }
    sync()
    const watch = new MutationObserver(sync)
    watch.observe(view, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
    return () => watch.disconnect()
  }, [holder])
}

function ExtraOverlays({ items }: { items: readonly ViewOverlayRegistration[] }) {
  if (items.length === 0) return null
  return (
    <div className="ui2-overlay-extra" data-registry="overlays">
      {items.map(item => <item.Component key={item.id} />)}
    </div>
  )
}

export function ViewOverlays({ workspace }: { workspace: Workspace }) {
  const t = useText('ui2-shell.wo3285')
  const registry = useWorkspaceRegistry()
  useRegistryVersion()
  const viewer = useCamStore(s => s.viewer)
  const setShading = useCamStore(s => s.setShadingMode)
  const rows = registry.showRows(workspace)
  const lit = useCamStore(s => rows.map(r => (r.isOn(s) ? '1' : '0')).join(''))
  const holder = useRef<HTMLDivElement>(null)
  useSimPanelHeight(holder)
  const items: ShowItem[] = rows.map((r, i) => ({ id: r.id, label: resolveMessage(r.labelKey), visible: lit[i] === '1' }))
  const faceLabels = Object.fromEntries(
    (Object.keys(VIEW_LABEL) as ViewPreset[]).map(v => [v, t(VIEW_LABEL[v])]),
  ) as Record<ViewPreset, string>
  return (
    <div className="ui2-overlays" ref={holder}>
      <div className="ui2-overlay ui2-overlay-left">
        <ExtraOverlays items={registry.viewOverlays(workspace, 'left')} />
        <ViewCube
          testId="ui2-viewcube"
          faceLabels={faceLabels}
          style={styleOf(viewer.shadingMode)}
          onView={view => viewportCamera()?.setCameraView?.(view)}
          onStyle={style => { const mode = STYLE_TO_MODE[style]; if (mode) setShading(mode) }}
        />
      </div>
      <div className="ui2-overlay ui2-overlay-right">
        <ExtraOverlays items={registry.viewOverlays(workspace, 'right')} />
        <ShowCard
          testId="ui2-showcard"
          title={t('showTitle')}
          items={items}
          onToggle={id => rows.find(r => r.id === id)?.toggle()}
        />
      </div>
    </div>
  )
}
