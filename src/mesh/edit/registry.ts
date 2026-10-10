// WO-1845 / ADR-0051 s3: the operation registry.
//
// The framework knows NOTHING about any particular edit. An operation slice
// (WO-1846..1851) adds one file, exports a MeshEditOperation and registers it
// here; nothing in this directory changes for it. That is the whole point of
// the registry: WO-1845 is the only order that may change the framework.

import type { MeshEditOperation, MeshEditRecord } from './types';

const OPERATIONS = new Map<string, MeshEditOperation<never>>();

/** Register an edit operation. Re-registering the SAME object is a no-op (a
 *  module evaluated twice under vitest's module graph must not explode);
 *  registering a DIFFERENT operation under a live kind throws, because two
 *  meanings for one `kind` would replay an operator's journal as the wrong
 *  edit (ADR-0003 - no silent fallback). */
export function registerMeshEditOperation<P>(operation: MeshEditOperation<P>): void {
  const existing = OPERATIONS.get(operation.kind);
  if (existing !== undefined) {
    if (existing === (operation as unknown as MeshEditOperation<never>)) return;
    throw new Error(
      `Mesh edit operation "${operation.kind}" is already registered by a different module. ` +
        'Each edit kind must have exactly one implementation.',
    );
  }
  OPERATIONS.set(operation.kind, operation as unknown as MeshEditOperation<never>);
}

/** The operation for this kind, or undefined when nothing registered it (an
 *  older project carrying an edit this build does not ship). */
export function getMeshEditOperation(kind: string): MeshEditOperation<never> | undefined {
  return OPERATIONS.get(kind);
}

/** Every registered operation, in registration order. */
export function listMeshEditOperations(): MeshEditOperation<never>[] {
  return [...OPERATIONS.values()];
}

/** The one line the properties panel and the console use to name an edit.
 *  Falls back to the raw kind for a record this build cannot replay - the
 *  operator still sees WHAT is on his part and can remove it. */
export function describeMeshEdit(record: MeshEditRecord): string {
  const operation = OPERATIONS.get(record.kind);
  if (!operation) return `${record.kind} (not available in this build)`;
  try {
    return operation.describe(record);
  } catch {
    return operation.label;
  }
}
