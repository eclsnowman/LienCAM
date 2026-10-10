import { textFor, useText } from '../../i18n'
// WO UI-11A: bottom console shell for the typed session event log
// (src/store/index.ts consoleEvents slice). Collapsed strip shows the latest
// event + an unread-error badge; expanding reveals the full scrollable
// timeline with severity filter chips and a clear button. Clicking a
// timeline row that carries an entityRef reuses the store's existing
// selection actions (setActiveOperation / setSelectedGeometry — the same
// ones DesignTree's row clicks use) so the Properties panel / viewport
// follow the click.
import { useMemo, useState, type ComponentType } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, CircleHelp, Info, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useCamStore, selectUnreadConsoleErrorCount } from '../../store'
import type { ConsoleEvent, ConsoleEventSeverity } from '../../store'

const shellText = textFor('app-shell-settings-menus')

const SEVERITIES: ConsoleEventSeverity[] = ['info', 'success', 'warning', 'error']

const SEVERITY_ICON: Record<ConsoleEventSeverity, ComponentType<{ size?: number }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
}

function formatEventTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export interface BottomConsoleProps {
  /** WO UI-13B (additive-only, Scope item 3): the workbench route mounts
   *  this SAME component and wants its timeline visible without an extra
   *  click (the INT-5 scanner's own frozen walkthrough checks workbench
   *  testids straight off a page load, never expanding anything itself).
   *  Defaults to false -- byte-identical collapsed-on-load behavior for the
   *  base app (App.tsx's own <BottomConsole/> call site is unchanged). */
  defaultExpanded?: boolean
}

export function BottomConsole({ defaultExpanded = false }: BottomConsoleProps = {}) {
  useText('app-shell-settings-menus')
  const events = useCamStore(s => s.consoleEvents)
  const unreadErrorCount = useCamStore(selectUnreadConsoleErrorCount)
  const clearConsoleEvents = useCamStore(s => s.clearConsoleEvents)
  const markConsoleRead = useCamStore(s => s.markConsoleRead)
  const setActiveOperation = useCamStore(s => s.setActiveOperation)
  const setSelectedGeometry = useCamStore(s => s.setSelectedGeometry)
  const setActiveSetup = useCamStore(s => s.setActiveSetup)
  const openModal = useCamStore(s => s.openModal)

  const [expanded, setExpanded] = useState(defaultExpanded)
  const [filter, setFilter] = useState<ConsoleEventSeverity | 'all'>('all')

  const latest = events.length > 0 ? events[events.length - 1] : null

  const toggleExpanded = () => {
    setExpanded(prev => {
      const next = !prev
      // "unread since last expand" (mission :19): mark read on the way IN,
      // so the badge that was visible while collapsed is what the user saw.
      if (next) markConsoleRead()
      return next
    })
  }

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter(e => e.severity === filter)),
    [events, filter],
  )
  // Newest first — a console reads top-down like a log tail.
  const timeline = useMemo(() => [...filtered].reverse(), [filtered])

  // BK-80: dispatch EVERY kind the ConsoleEventEntityRef union permits (kept
  // exhaustive via the `never` default branch below — adding a new kind to
  // the union without a case here is now a compile error, not a silent
  // no-op). 'setup' selects the setup the same way DesignTree's own setup
  // row click does (setActiveSetup + clear geometry selection) — previously
  // this kind reached the timeline (BottomConsole already typed it) but the
  // click handler had no branch for it, so it silently did nothing (BK-80).
  const handleEntityClick = (ref: ConsoleEvent['entityRef']) => {
    if (!ref) return
    if (ref.kind === 'op') setActiveOperation(ref.id)
    else if (ref.kind === 'geometry') setSelectedGeometry(ref.id)
    else if (ref.kind === 'setup') { setActiveSetup(ref.id); setSelectedGeometry(null) }
    else { const _exhaustive: never = ref.kind; void _exhaustive }
  }

  return (
    <div className={`bottom-console${expanded ? ' bottom-console-expanded' : ''}`}>
      <div
        className="console-strip"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="console-strip"
        onClick={toggleExpanded}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded() } }}
      >
        {latest ? (
          <span className={`console-strip-msg console-severity-${latest.severity}`}>
            {(() => { const Icon = SEVERITY_ICON[latest.severity]; return <Icon size={12} /> })()}
            <span className="console-strip-text" title={latest.message}>{latest.message}</span>
          </span>
        ) : (
          <span className="console-strip-empty">{shellText('BottomConsole.noEventsYet')}</span>
        )}
        {unreadErrorCount > 0 && (
          <span className="badge badge-danger badge-counter" data-testid="console-unread-badge">{unreadErrorCount}</span>
        )}
        <span className="console-strip-chevron">{expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</span>
      </div>

      {expanded && (
        <div className="console-panel">
          <div className="console-toolbar">
            <div className="console-filters">
              {(['all', ...SEVERITIES] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  className={`console-filter-chip${filter === f ? ' console-filter-chip-active' : ''}`}
                  onClick={() => setFilter(f)}
                  data-testid={`console-filter-${f}`}
                >
                  {consoleFilterLabel(f)}
                </button>
              ))}
            </div>
            <div className="console-toolbar-actions">
              <button
                type="button"
                className="btn-ghost-sm console-help-btn"
                data-testid="console-help"
                onClick={() => openModal('help-errors')}
              >
                <CircleHelp size={11} />{shellText('BottomConsole.troubleshoot')}</button>
              <button type="button" className="btn-ghost-sm console-clear-btn" onClick={clearConsoleEvents}>
                <X size={11} />{shellText('BottomConsole.clear')}</button>
            </div>
          </div>
          <div className="console-timeline" data-testid="console-timeline">
            {timeline.length === 0 ? (
              <div className="console-empty">{shellText('BottomConsole.noEvents')}</div>
            ) : (
              timeline.map((e) => {
                const Icon = SEVERITY_ICON[e.severity]
                return (
                  <div
                    key={e.id}
                    className={`console-event console-severity-${e.severity}${e.entityRef ? ' console-event-clickable' : ''}`}
                    data-testid={`console-event-${e.id}`}
                    onClick={() => handleEntityClick(e.entityRef)}
                  >
                    <Icon size={12} />
                    <span className="console-event-time">{formatEventTime(e.at)}</span>
                    <span className="console-event-source">{e.source}</span>
                    <span className="console-event-message">{e.message}</span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function consoleFilterLabel(value: 'all' | ConsoleEventSeverity): string {
  switch(value) {
    case 'all': return shellText('BottomConsole.all')
    case 'info': return shellText('BottomConsole.info')
    case 'success': return shellText('BottomConsole.success')
    case 'warning': return shellText('BottomConsole.warning')
    case 'error': return shellText('BottomConsole.error')
  }
}
