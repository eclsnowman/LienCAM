// WO UI-4 acceptance #1/#2: measure panel UI. Presentational -- all pick/
// measure logic lives in useMeasureSession.ts + measureLogic.ts; this
// component only renders a MeasureSessionState and forwards mode/clear
// intents. Visual language matches FeatureTree.tsx/DialogShell.tsx's token
// set (no hardcoded colors, unlike the older Lab3DView demo surface).

import { useText } from '../../../i18n'
import { useState } from 'react'
import { formatReadout, isFailure, type MeasureOutcome } from './measureLogic'
import type { MeasureMode, MeasureSessionState } from './useMeasureSession'

export interface MeasurePanelProps {
  state: MeasureSessionState
  onModeChange(mode: MeasureMode): void
  onClear(): void
}

function OutcomeRow({ outcome }: { outcome: MeasureOutcome }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [open, setOpen] = useState(false)
  if (isFailure(outcome)) {
    return (
      <div data-testid="measure-outcome-error" style={{ color: 'var(--status-error, #e05252)' }}>
        {outcome.error}
      </div>
    )
  }
  return (
    <div data-testid="measure-outcome" style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{formatReadout(outcome)}</span>
        {outcome.ids.length > 0 && (
          <button
            type="button"
            data-testid="measure-outcome-ids-toggle"
            onClick={() => setOpen((o) => !o)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
              padding: 0,
            }}
          >
            {open ? workbenchText('MeasurePanel.hideId') : workbenchText('MeasurePanel.showId')}
          </button>
        )}
      </div>
      {outcome.note !== undefined && (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{outcome.note}</div>
      )}
      {open && outcome.ids.length > 0 && (
        <div data-testid="measure-outcome-ids" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all' }}>
          {outcome.ids.join(', ')}
        </div>
      )}
    </div>
  )
}

export function MeasurePanel({ state, onModeChange, onClear }: MeasurePanelProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <div
      data-testid="measure-panel"
      style={{
        background: 'var(--surface-1)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--font-size-md)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 8,
        minWidth: 220,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <button
          type="button"
          data-testid="measure-mode-single"
          aria-pressed={state.mode === 'single'}
          onClick={() => onModeChange('single')}
          style={{
            background: state.mode === 'single' ? 'var(--select-ui-bg)' : 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {workbenchText('MeasurePanel.single')}</button>
        <button
          type="button"
          data-testid="measure-mode-between"
          aria-pressed={state.mode === 'between'}
          onClick={() => onModeChange('between')}
          style={{
            background: state.mode === 'between' ? 'var(--select-ui-bg)' : 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {workbenchText('MeasurePanel.betweenTwo')}</button>
        <button
          type="button"
          data-testid="measure-clear"
          onClick={onClear}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {workbenchText('MeasurePanel.clear')}</button>
      </div>
      {state.mode === 'between' && state.armedCount < 2 && (
        <div style={{ color: 'var(--text-muted)', marginBottom: 4 }} data-testid="measure-armed-hint">
          {workbenchText('MeasurePanel.pick')}{2 - state.armedCount}{workbenchText('MeasurePanel.moreEntit', { value1: String((2 - state.armedCount === 1 ? 'y' : 'ies')) })}</div>
      )}
      {state.busy && (
        <div data-testid="measure-busy" style={{ color: 'var(--text-muted)' }}>
          {workbenchText('MeasurePanel.measuring')}</div>
      )}
      {!state.busy && state.outcomes.length === 0 && (
        <div style={{ color: 'var(--text-muted)' }} data-testid="measure-empty">
          {workbenchText('MeasurePanel.nothingSelected')}</div>
      )}
      {!state.busy && state.outcomes.map((o, i) => <OutcomeRow key={i} outcome={o} />)}
    </div>
  )
}
