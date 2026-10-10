// CycleLogPanel - the cycle event log (UCCNC-hitlist tier 1): a plain
// start/stop history of program runs this session. Collapsed by default -
// it is a glance-when-needed view, and the left column's safety cluster and
// probe tools come first.

import { ChevronDown, ChevronUp } from 'lucide-react'
import { useMachineControl, type CycleEvent } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'

const EVENT_LABEL: Record<CycleEvent['event'], string> = {
  started: 'Started',
  paused: 'Paused',
  resumed: 'Resumed',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'FAILED',
}

function hms(at: number): string {
  return new Date(at).toLocaleTimeString()
}

export function CycleLogPanel() {
  const events = useMachineControl((s) => s.cycleEvents)
  const collapsed = useUiPrefs((s) => s.machineCycleLogCollapsed)

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">Cycle log</span>
        {events.length > 0 && <span className="control-cyclelog-count">{events.length}</span>}
        <button
          className="panel-action-btn"
          data-testid="control-cyclelog-toggle"
          onClick={() => useUiPrefs.setState({ machineCycleLogCollapsed: !collapsed })}
          data-tooltip={collapsed ? 'Show the program run history' : 'Collapse the run history'}
          aria-label={collapsed ? 'Expand the cycle log' : 'Collapse the cycle log'}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
      {!collapsed && (
        <div className="panel-body control-cyclelog-body" data-testid="control-cyclelog">
          {events.length === 0 ? (
            <div className="panel-empty">No program runs yet this session.</div>
          ) : (
            [...events].reverse().map((e) => (
              <div
                key={e.id}
                className={`control-cyclelog-row ${e.event === 'failed' ? 'control-cyclelog-failed' : ''}`}
              >
                <span className="control-cyclelog-time">{hms(e.at)}</span>
                <span className="control-cyclelog-event">{EVENT_LABEL[e.event]}</span>
                <span className="control-cyclelog-name">
                  {e.name ?? '(unnamed)'}
                  {e.line !== null ? ` - line ${e.line}` : ''}
                  {/* WO-382: the operation the event happened in, only when the
                      context was verified current at that moment. */}
                  {e.operation !== null && (
                    <span className="control-cyclelog-operation" data-testid="control-cyclelog-operation">
                      {` - ${e.operation}`}
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}
