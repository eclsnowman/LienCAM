// WO-3283 (UI M2 W1-F): every operation type's parameter schema, by the operation type id the
// store uses. Wave 1 pilots Pocket; each later operation is one more file here.
import type { OpSchema } from '..'
import { POCKET_SCHEMA } from './pocket'

export { POCKET_SCHEMA }

const SCHEMAS: ReadonlyMap<string, OpSchema> = new Map([[POCKET_SCHEMA.opType, POCKET_SCHEMA]])

/** The schema for an operation type, or undefined while that type has none yet. */
export function schemaFor(opType: string): OpSchema | undefined {
  return SCHEMAS.get(opType)
}
