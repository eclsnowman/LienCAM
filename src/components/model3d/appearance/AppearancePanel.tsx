// WO UI-4 acceptance #5: appearance panel UI. Color-swatch idiom matches
// src/components/panels/DesignTree.tsx's existing part-color picker (native
// `<input type="color">`, read-only reference -- never edited by this WO),
// re-expressed with this app's 3D-viewport token set (FeatureTree.tsx/
// DialogShell.tsx) rather than the 2D tree's own inline styles.

import { useText } from '../../../i18n'
import { catalogChildren } from '../catalogChildren'
import type { RGB } from './appearanceStore'
import type { AppearanceSessionState } from './useAppearanceSession'

export interface AppearancePanelProps {
  state: AppearanceSessionState
  onFilterModeChange(mode: 'face' | 'body'): void
  onColorChange(color: RGB): void
  onClear(): void
}

function toHex(color: RGB | undefined): string {
  if (color === undefined) return '#cccccc'
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${c(color[0])}${c(color[1])}${c(color[2])}`
}

function fromHex(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

export function AppearancePanel({ state, onFilterModeChange, onColorChange, onClear }: AppearancePanelProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <div
      data-testid="appearance-panel"
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
          data-testid="appearance-filter-face"
          aria-pressed={state.filterMode === 'face'}
          onClick={() => onFilterModeChange('face')}
          style={{
            background: state.filterMode === 'face' ? 'var(--select-ui-bg)' : 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {workbenchText('AppearancePanel.face')}</button>
        <button
          type="button"
          data-testid="appearance-filter-body"
          aria-pressed={state.filterMode === 'body'}
          onClick={() => onFilterModeChange('body')}
          style={{
            background: state.filterMode === 'body' ? 'var(--select-ui-bg)' : 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {workbenchText('AppearancePanel.body')}</button>
      </div>
      {state.target === null ? (
        <div style={{ color: 'var(--text-muted)' }} data-testid="appearance-empty">
          {catalogChildren(workbenchText('AppearancePanel.pickAToColor', { filterMode: '\u0000value1\u0000' }), { value1: state.filterMode })}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label
            data-testid="appearance-swatch-label"
            style={{
              display: 'inline-flex',
              width: 22,
              height: 22,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              overflow: 'hidden',
              cursor: 'pointer',
              background: toHex(state.currentColor),
            }}
          >
            <input
              type="color"
              data-testid="appearance-color-input"
              value={toHex(state.currentColor)}
              onChange={(ev) => onColorChange(fromHex(ev.target.value))}
              style={{ opacity: 0, width: '100%', height: '100%', border: 'none', padding: 0, cursor: 'pointer' }}
            />
          </label>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="appearance-target-label">
            {state.target.kind === 'face' ? state.target.id : workbenchText('AppearancePanel.body2', { value1: String(state.target.bodyId) })}
          </span>
          <button
            type="button"
            data-testid="appearance-clear"
            onClick={onClear}
            disabled={state.currentColor === undefined}
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            {workbenchText('AppearancePanel.clear')}</button>
        </div>
      )}
    </div>
  )
}
