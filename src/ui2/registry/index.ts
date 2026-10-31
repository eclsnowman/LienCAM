// WO-3306: the workspace registry (UI M2 Wave 2 seam). Lanes import only the types from here;
// the shell reads the registry through the hooks.
export * from './types'
export { createWorkspaceRegistry, scopeIncludes, SHELL_OWNER } from './registry'
export { collectRegistrations, type RegistrationModule } from './collect'
export { createDefaultRegistry, workspaceRegistry } from './default'
export { WorkspaceRegistryProvider, useRegistryVersion, useWorkspaceRegistry } from './context'
