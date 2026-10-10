import { textFor } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  /**
   * Changing this value (App.tsx passes `viewer.mode`) auto-clears a caught
   * error and retries rendering children -- this is how a user "leaves" a
   * broken view by switching tabs (Setup/Sketch/Toolpath/Simulate), with no
   * full-page reload.
   */
  resetKey?: unknown
}

interface State {
  error: Error | null
}

/**
 * View-level React ErrorBoundary for the CAM viewport.
 *
 * ADAPTIVE-VIEW-CRASH follow-up (docs/planning/POST-MERGE-WORKPLAN.md): the
 * minimal fix at a9934ed9e only scoped the simulation frame-build EFFECT
 * (SimulationPanel.tsx). A RENDER-time throw anywhere else in the viewport --
 * Viewport.tsx's own render/effects (e.g. the toolpath-display effect that
 * calls into the CNCViewport engine), the CNCViewport Three.js engine itself,
 * or SimulationPanel's render -- still had no boundary of its own and would
 * propagate to the APP-LEVEL src/components/ErrorBoundary.tsx, tearing down
 * the whole app (tree, properties, other tabs) for a problem scoped to one
 * view. This boundary catches that class of failure IN PLACE.
 *
 * One persistent <Viewport> instance serves all four view modes (Setup,
 * Sketch, Toolpath, Simulate -- docs/UI-ARCHITECTURE.md sec 4); there is no
 * separate per-mode subtree to hang a narrower boundary on, so this wraps the
 * whole Viewport mount (App.tsx, the view-container level). A throw in any
 * mode is contained here rather than reaching the app boundary -- strictly
 * safer than the toolpath/simulation-only scope this follow-up was booked
 * for.
 *
 * ADR-0003 (no silent fallbacks): the caught error's real message is always
 * shown by name in the fallback -- never a generic "something went wrong"
 * alone.
 */
export class ViewportErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[LienCAM] Viewport view failed to render; keeping the app alive:', error, info)
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      // The user switched tabs (or an equivalent view-identity change) --
      // that is "leaving" the broken view; retry fresh on the new identity.
      this.setState({ error: null })
    }
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        data-testid="viewport-error-boundary"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 300,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          fontFamily: 'sans-serif',
          background: 'var(--surface-page, #1a1a1a)',
          color: 'var(--text-primary, #e0e0e0)',
          padding: '32px',
          boxSizing: 'border-box',
        }}
      >
        {/* Q74-ERROR-STYLE-TUNE (Operator): the heading text stays in the app's normal
            brand heading color (--text-primary), same as .modal-title. The "this is a
            problem" signal lives in ONE restrained non-text element -- a small warning
            triangle in --text-danger beside the heading -- exactly the pattern the app's
            own alert dialog (ConfirmModal danger header) already uses, so the error
            screens read as siblings of it rather than an off-brand orange takeover. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            style={{ color: 'var(--text-danger, #f28b8b)', flexShrink: 0 }}
          />
          <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary, #e0e0e0)' }}>{tx('ViewportErrorBoundary.This_view_failed_to_render')}</h3>
        </div>
        <p style={{
          margin: 0, maxWidth: '440px', textAlign: 'center',
          color: 'var(--text-muted, #aaa)', fontSize: '13px',
        }}>{tx('ViewportErrorBoundary.The_3D_view_hit_an_error_and_stopped_rendering')}</p>
        <pre
          data-testid="viewport-error-boundary-message"
          style={{
            background: 'var(--surface-canvas, #111)',
            border: '1px solid var(--border-subtle, #333)',
            borderRadius: '4px',
            padding: '10px 14px',
            fontSize: '12px',
            color: 'var(--red-300, #f08080)',
            maxWidth: '560px',
            overflowX: 'auto',
            margin: 0,
          }}
        >
          {error.message || error.name || tx('ViewportErrorBoundary.Unknown_error')}
        </pre>
        <button
          onClick={this.handleRetry}
          data-testid="viewport-error-boundary-retry"
          style={{
            marginTop: '4px',
            padding: '8px 20px',
            // Q74-ERROR-STYLE-TUNE: the primary action uses the brand accent (--blue-500),
            // the SAME token+fallback the app-level ErrorBoundary's Reload button uses, so
            // the two error surfaces share one design system.
            background: 'var(--blue-500, #3b6fc0)',
            color: 'var(--text-on-accent, #fff)',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >{tx('ViewportErrorBoundary.Retry_this_view')}</button>
      </div>
    )
  }
}
