// WO-3307 (UI M2 W2-2b): the 3D operation types' parameter schemas, by the operation type id the
// store uses. schemas/index.ts (WO-3295) registers them for schemaFor once it lands; until then
// a screen asks schema3dFor.
import { applyEdit, type OpSchema, type ParamValues, type StoredOperation } from '../..'
import { ADAPTIVE_3D_SCHEMA } from './adaptive'
import { PARALLEL_3D_SCHEMA } from './parallel'
import { PENCIL_3D_SCHEMA } from './pencil'
import { SCALLOP_3D_SCHEMA } from './scallop'
import { STEEP_SHALLOW_3D_SCHEMA } from './steepShallow'
import { WATERLINE_3D_SCHEMA } from './waterline'

export { ADAPTIVE_3D_SCHEMA, PARALLEL_3D_SCHEMA, PENCIL_3D_SCHEMA, SCALLOP_3D_SCHEMA, STEEP_SHALLOW_3D_SCHEMA, WATERLINE_3D_SCHEMA }
export type { Edit3dContext, Op3dContext } from './common'

export const SCHEMAS_3D: readonly OpSchema[] = [
  PARALLEL_3D_SCHEMA, WATERLINE_3D_SCHEMA, ADAPTIVE_3D_SCHEMA, SCALLOP_3D_SCHEMA, STEEP_SHALLOW_3D_SCHEMA, PENCIL_3D_SCHEMA,
]

const BY_TYPE: ReadonlyMap<string, OpSchema> = new Map(SCHEMAS_3D.map(s => [s.opType, s]))

/** The schema for a 3D operation type, or undefined for any other type. */
export function schema3dFor(opType: string): OpSchema | undefined {
  return BY_TYPE.get(opType)
}

/** The op.params a new 3D operation stores for these values: each value in its stored form, as
 *  an edit stores it (a blank optional number is absent, a blank grid size is automatic). */
export function storedParamsOf(schema: OpSchema, values: ParamValues): Readonly<Record<string, unknown>> {
  let op: StoredOperation = { params: {} }
  for (const p of schema.params) {
    if (!p.key.startsWith('params.') || !(p.key in values)) continue
    op = { ...op, ...applyEdit(schema, op, p.key, values[p.key], { creating: true }) }
  }
  return op.params as Readonly<Record<string, unknown>>
}
