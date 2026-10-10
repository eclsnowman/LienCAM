import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { PERSISTED_USER_DATA_REGISTRY } from '../store/persistedKeys'
import { resetUserSpaceStateStorage } from '../store/userSpaceStorage'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

const PERSIST_KEY = PERSISTED_USER_DATA_REGISTRY.activeProject.key

export async function resetProjectDataAndReload(
  clearProjectData: () => Promise<unknown> = () => resetUserSpaceStateStorage(PERSIST_KEY),
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  try {
    await clearProjectData()
  } catch (error) {
    // The storage helper normally converts OPFS failures into a pending reset.
    // Keep reload available even if an unexpected adapter failure escapes.
    console.error('[LienCAM] Project-data reset will retry after reload:', error)
  } finally {
    reload()
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[LienCAM] Unhandled render error:', error, info)
  }

  handlePlainReload = () => {
    // Primary action, no data loss: the persisted project is left untouched.
    // Most render errors are a one-off glitch or a view-scoped bug that a
    // clean reload (re-reading the SAME saved project) resolves.
    window.location.reload()
  }

  handleResetLastResort = () => {
    void resetProjectDataAndReload()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '16px',
        fontFamily: 'sans-serif',
        background: 'var(--surface-page, #1a1a1a)',
        color: 'var(--text-primary, #e0e0e0)',
        padding: '32px',
        boxSizing: 'border-box',
      }}>
        {/* Q74-ERROR-STYLE-TUNE (Operator): heading text in the app's normal brand heading
            color (--text-primary); the warning is carried by ONE restrained non-text
            element -- a small --text-danger triangle beside it -- matching the sibling
            ViewportErrorBoundary and the app's ConfirmModal danger header. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <AlertTriangle
            size={20}
            strokeWidth={2}
            aria-hidden="true"
            style={{ color: 'var(--text-danger, #f28b8b)', flexShrink: 0 }}
          />
          <h2 style={{ margin: 0, fontSize: '20px', color: 'var(--text-primary, #e0e0e0)' }}>
            LienCAM encountered an error
          </h2>
        </div>
        <p style={{ margin: 0, maxWidth: '480px', textAlign: 'center', color: 'var(--text-muted, #aaa)', fontSize: '14px' }}>
          Something went wrong while rendering. Your saved project has not been touched --
          reloading is usually all that is needed.
        </p>
        {this.state.error && (
          <pre style={{
            background: 'var(--surface-canvas, #111)',
            border: '1px solid var(--border-subtle, #333)',
            borderRadius: '4px',
            padding: '12px 16px',
            fontSize: '12px',
            color: 'var(--red-300, #f08080)',
            maxWidth: '600px',
            overflowX: 'auto',
            margin: 0,
          }}>
            {this.state.error.message}
          </pre>
        )}
        <button
          onClick={this.handlePlainReload}
          style={{
            marginTop: '8px',
            padding: '10px 24px',
            background: 'var(--blue-500, #3b6fc0)',
            color: 'var(--text-on-accent, #fff)',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Reload
        </button>
        <p style={{ margin: 0, maxWidth: '480px', textAlign: 'center', color: 'var(--text-muted, #aaa)', fontSize: '12px' }}>
          Still broken after reloading? Last resort: clears everything the app has saved --
          the current project, your tool library, holder library, machine library, app
          settings and imported fonts -- and cannot be undone. Only use it if a plain
          reload keeps hitting the same error.
        </p>
        <button
          onClick={this.handleResetLastResort}
          style={{
            padding: '6px 16px',
            background: 'transparent',
            color: 'var(--text-danger, #f28b8b)',
            border: '1px solid var(--border-subtle, #333)',
            borderRadius: '6px',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Reset Project Data &amp; Reload (last resort)
        </button>
      </div>
    )
  }
}
