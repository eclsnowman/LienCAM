// WO-3306: the registry the shell reads, provided by context so a test (or a story) can hand the
// shell its own. Without a provider it is the app's one registry.
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { workspaceRegistry } from './default'
import type { WorkspaceRegistry } from './types'

const Context = createContext<WorkspaceRegistry>(workspaceRegistry)

export function WorkspaceRegistryProvider({ registry, children }: { registry: WorkspaceRegistry; children: ReactNode }) {
  return <Context.Provider value={registry}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspaceRegistry(): WorkspaceRegistry {
  return useContext(Context)
}

/** The registry's version: reading it makes the caller redraw when a registration or mode changes. */
// eslint-disable-next-line react-refresh/only-export-components
export function useRegistryVersion(): number {
  const registry = useWorkspaceRegistry()
  return useSyncExternalStore(registry.subscribe, registry.version)
}
