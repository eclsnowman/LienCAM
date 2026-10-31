// WO-3306: the app's one registry: the shell's own table, then every lane's registration.
import { shellRegistration } from './builtin'
import { collectRegistrations, type RegistrationModule } from './collect'
import { createWorkspaceRegistry } from './registry'
import type { WorkspaceRegistry } from './types'

/** A registry holding the shell's table and the registrations found in `modules` (the lane
 *  folders by default). A conflict throws here, so it fails the build or the first test. */
export function createDefaultRegistry(options: { readonly modules?: Readonly<Record<string, RegistrationModule>> } = {}): WorkspaceRegistry {
  const registry = createWorkspaceRegistry()
  registry.register(shellRegistration)
  for (const registration of collectRegistrations(options.modules)) registry.register(registration)
  return registry
}

export const workspaceRegistry: WorkspaceRegistry = createDefaultRegistry()
