// WO-3306: finds the registration each lane exports. A lane folder `src/ui2/<folder>/` holds
// `registration.ts` (or `.tsx`) exporting `registration` (one WorkspaceRegistration or an array);
// nothing else lists it, so lanes land in any order.
import type { WorkspaceRegistration } from './types'

export interface RegistrationModule { readonly registration?: WorkspaceRegistration | readonly WorkspaceRegistration[] }

const MODULES = import.meta.glob<RegistrationModule>('../*/registration.{ts,tsx}', { eager: true })

/** Every lane's registrations, in path order (the order only decides ties of equal `order`). */
export function collectRegistrations(modules: Readonly<Record<string, RegistrationModule>> = MODULES): readonly WorkspaceRegistration[] {
  const out: WorkspaceRegistration[] = []
  for (const path of Object.keys(modules).sort()) {
    const exported = modules[path].registration
    if (exported === undefined) continue
    if (Array.isArray(exported)) out.push(...(exported as readonly WorkspaceRegistration[]))
    else out.push(exported as WorkspaceRegistration)
  }
  return out
}
