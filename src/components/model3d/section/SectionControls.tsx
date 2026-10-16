// WO UI-4 acceptance #3: section-view UI -- axis select + position slider +
// flip + on/off. Presentational; all state/runtime wiring lives in
// useSectionState.ts. Token-styled port of Lab3DView's section toolbar
// (Lab3DView.tsx lines ~807-851), matching FeatureTree.tsx/DialogShell.tsx's
// visual language instead of that older demo surface's hardcoded hex.

import { useText } from '../../../i18n'
import { SECTION_AXES, type SectionController } from './useSectionState'

export interface SectionControlsProps {
  controller: SectionController
  canDrag?: boolean
}

export function SectionControls({ controller, canDrag = true }: SectionControlsProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const { state, setAxis, setPos, setFlip, setEnabled, setDragEnabled, reset } = controller
  return (
    <div
      data-testid="section-controls"
      style={{
        background: 'var(--surface-1)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--font-size-md)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          data-testid="section-enabled"
          checked={state.enabled}
          onChange={(ev) => setEnabled(ev.target.checked)}
        />
        {workbenchText('SectionControls.section')}</label>
      {SECTION_AXES.map((axis) => (
        <button
          key={axis}
          type="button"
          data-testid={`section-axis-${axis}`}
          aria-pressed={state.axis === axis}
          disabled={!state.enabled}
          onClick={() => setAxis(axis)}
          style={{
            background: state.axis === axis ? 'var(--select-ui-bg)' : 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 8px',
            cursor: state.enabled ? 'pointer' : 'default',
            textTransform: 'uppercase',
          }}
        >
          {axis}
        </button>
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          data-testid="section-flip"
          checked={state.flip}
          disabled={!state.enabled}
          onChange={(ev) => setFlip(ev.target.checked)}
        />
        {workbenchText('SectionControls.flip')}</label>
      <input
        type="range"
        data-testid="section-slider"
        disabled={!state.enabled}
        min={state.range.min}
        max={state.range.max}
        step={Math.max((state.range.max - state.range.min) / 200, 0.01)}
        value={state.pos ?? state.range.max}
        onChange={(ev) => setPos(Number(ev.target.value))}
        style={{ flex: 1, minWidth: 100 }}
      />
      <button
        type="button"
        data-testid="section-drag-mode"
        aria-pressed={state.dragEnabled}
        disabled={!canDrag}
        onClick={() => setDragEnabled(!state.dragEnabled)}
        style={{
          background: state.dragEnabled ? 'var(--select-ui-bg)' : 'transparent',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: '2px 8px',
          cursor: canDrag ? 'ns-resize' : 'default',
        }}
      >
        {workbenchText('SectionControls.dragPlane')}</button>
      <button
        type="button"
        data-testid="section-clear"
        onClick={reset}
        style={{
          background: 'transparent',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: '2px 8px',
          cursor: 'pointer',
        }}
      >
        {workbenchText('SectionControls.clear')}</button>
    </div>
  )
}
