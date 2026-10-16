// WO UI-4 acceptance #4: viewport-side hide/isolate controls. Face-level
// hide/isolate has no tree row to live on (the design tree is DAG-node/body
// granularity -- see FeatureTree.tsx's new visibility prop for the body-
// level half of this feature), so it acts on whatever the currently active
// pick tool (measure or appearance) has selected -- consistent with how
// most CAD viewport hide/isolate commands read "the current selection"
// rather than owning a dedicated pick mode of their own.

import { useText } from '../../../i18n'
import type { CSSProperties } from 'react'
import type { StableId } from '../../../geom/geom-service'

export interface VisibilityPanelProps {
  selectedFaceIds: readonly StableId[]
  selectedBodyIds: readonly string[]
  isolateActive: boolean
  onHideSelectedFaces(): void
  onIsolateSelection(): void
  onClearIsolate(): void
  onShowAll(): void
}

export function VisibilityPanel({
  selectedFaceIds,
  selectedBodyIds,
  isolateActive,
  onHideSelectedFaces,
  onIsolateSelection,
  onClearIsolate,
  onShowAll,
}: VisibilityPanelProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const hasSelection = selectedFaceIds.length > 0 || selectedBodyIds.length > 0
  return (
    <div
      data-testid="visibility-panel"
      style={{
        background: 'var(--surface-1)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--font-size-md)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 8,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        data-testid="visibility-hide-selected-faces"
        disabled={selectedFaceIds.length === 0}
        onClick={onHideSelectedFaces}
        style={buttonStyle()}
      >
        {workbenchText('VisibilityPanel.hideFace', { value1: String((selectedFaceIds.length > 1 ? 's' : '')) })}</button>
      <button
        type="button"
        data-testid="visibility-isolate"
        disabled={!hasSelection}
        aria-pressed={isolateActive}
        onClick={onIsolateSelection}
        style={buttonStyle(isolateActive)}
      >
        {workbenchText('VisibilityPanel.isolateSelection')}</button>
      {isolateActive && (
        <button type="button" data-testid="visibility-clear-isolate" onClick={onClearIsolate} style={buttonStyle()}>
          {workbenchText('VisibilityPanel.exitIsolate')}</button>
      )}
      <button type="button" data-testid="visibility-show-all" onClick={onShowAll} style={buttonStyle()}>
        {workbenchText('VisibilityPanel.showAll')}</button>
    </div>
  )
}

function buttonStyle(active = false): CSSProperties {
  return {
    background: active ? 'var(--select-ui-bg)' : 'transparent',
    color: 'var(--text-primary)',
    border: "1px solid var(--border-subtle)",
    borderRadius: 'var(--radius-md)',
    padding: '2px 8px',
    cursor: 'pointer',
  }
}
