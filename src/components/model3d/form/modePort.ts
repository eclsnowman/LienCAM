// WO-3301 (UI M2 W2-8): how a mode session that lives inside the Model page is reached from the
// New UI ribbon. The page owns the session (its hook runs there, against the page's scene); the
// session publishes itself to a port, and the ribbon reads the port. Nothing here changes what a
// session does. The port notifies only when `signature` changes (what the ribbon shows), never on
// every page render, but `get()` always returns the newest session so a press runs fresh closures.
import { useSyncExternalStore } from 'react'

export interface ModePort<S> {
  get(): S | null
  version(): number
  /** Store the newest session (null when the page unmounts); notify when `signature` differs. `owner` names the
   *  publishing instance, so that its release clears only what it published. */
  update(session: S | null, signature: string, owner?: object): void
  /** The instance `owner` is gone: clear the port unless another instance has published since. */
  release(owner: object): void
  subscribe(listener: () => void): () => void
}

export function createModePort<S>(): ModePort<S> {
  let current: S | null = null
  let holder: object | null = null
  let signature = ''
  let version = 0
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    version: () => version,
    update(session, next, owner) {
      current = session
      holder = owner ?? null
      if (next === signature) return
      signature = next
      version += 1
      for (const listener of [...listeners]) listener()
    },
    release(owner) {
      if (holder !== owner) return
      this.update(null, 'gone')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The published session, redrawing the caller when what the ribbon shows changes. */
export function useModePortSession<S>(port: ModePort<S>): S | null {
  useSyncExternalStore(port.subscribe, port.version, port.version)
  return port.get()
}

/** What a rail shows, as one string: a change in any tool's label, lamp or availability changes it. */
export function railSignature(active: boolean, sections: ReadonlyArray<{ tools: ReadonlyArray<{ testId: string; label: string; active?: boolean; disabled?: boolean }> }>): string {
  const tools = sections.flatMap((s) => s.tools.map((t) => `${t.testId}:${t.label}:${t.active === true ? 1 : 0}${t.disabled === true ? 1 : 0}`))
  return `${active ? 'on' : 'off'}|${tools.join('|')}`
}
