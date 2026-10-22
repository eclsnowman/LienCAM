// The JSON Schema subset an agent command declares its input with
// (WO-2993, WO-2951 "Schema validation").
//
// A spec's `input` is a plain literal that uses ONLY the keywords below, and the
// very same literal is what a later MCP `tools/list` / `describe_command` hands
// the agent, so the schema the agent reads is the schema that runs. The checker
// is deliberately small: it validates exactly this subset and nothing else, and
// schemaKeywordsOutsideSubset() lets a test refuse a spec that reaches past it.
// Strict from day one -- there is no Warn level: an unknown argument, a missing
// required one or a wrong type is refused before anything runs.
//
// Pure and dependency-free. Messages are one plain sentence naming the argument
// and what to send instead (LIENCAM.md rule 11), never a schema dump.

export type JsonSchemaType = 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'

export interface JsonSchema {
  /** One type, or a list of them (`['string', 'null']`: text, or null). */
  readonly type: JsonSchemaType | readonly JsonSchemaType[]
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  /** Objects only, and only `false`: an unknown key is always refused. */
  readonly additionalProperties?: false
  readonly enum?: readonly (string | number | boolean)[]
  readonly minimum?: number
  readonly maximum?: number
  readonly items?: JsonSchema
}

/** The only keywords a command schema may use. */
export const SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'minimum',
  'maximum',
  'items',
])

export interface SchemaProblem {
  /** JSON path of the first problem, `$` for the whole value. */
  path: string
  message: string
}

const TYPE_WORDS: Record<JsonSchemaType, string> = {
  object: 'an object',
  string: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  null: 'null',
}

function childPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`
}

function nameOf(path: string): string {
  return path === '$' ? 'The arguments' : `Argument "${path.slice(2)}"`
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
  }
}

function typesOf(schema: JsonSchema): readonly JsonSchemaType[] {
  return typeof schema.type === 'string' ? [schema.type] : schema.type
}

/** The first problem `value` has against `schema`, or undefined when it fits. */
export function firstSchemaProblem(schema: JsonSchema, value: unknown, path = '$'): SchemaProblem | undefined {
  const types = typesOf(schema)
  if (!types.some((type) => matchesType(type, value))) {
    return { path, message: `${nameOf(path)} must be ${types.map((type) => TYPE_WORDS[type]).join(' or ')}.` }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) {
    return { path, message: `${nameOf(path)} must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.` }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { path, message: `${nameOf(path)} must be at least ${schema.minimum}.` }
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { path, message: `${nameOf(path)} must be at most ${schema.maximum}.` }
    }
  }
  if (types.includes('object') && matchesType('object', value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
        return { path: childPath(path, key), message: `Argument "${childPath(path, key).slice(2)}" is required.` }
      }
    }
    const known = schema.properties ?? {}
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(known, key)) {
        if (schema.additionalProperties === false) {
          return { path: childPath(path, key), message: `"${childPath(path, key).slice(2)}" is not an argument of this command.` }
        }
        continue
      }
      const problem = firstSchemaProblem(known[key], record[key], childPath(path, key))
      if (problem !== undefined) return problem
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const list = value as unknown[]
    for (let i = 0; i < list.length; i++) {
      const problem = firstSchemaProblem(schema.items, list[i], childPath(path, i))
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/** Every keyword in `schema` (at any depth) that is not in SCHEMA_KEYWORDS, as
 *  `path:keyword`. A spec test requires this to be empty. */
export function schemaKeywordsOutsideSubset(schema: unknown, path = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  const out: string[] = []
  for (const [key, child] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYWORDS.includes(key)) {
      out.push(`${path}:${key}`)
      continue
    }
    if (key === 'properties' && typeof child === 'object' && child !== null) {
      for (const [name, sub] of Object.entries(child as Record<string, unknown>)) {
        out.push(...schemaKeywordsOutsideSubset(sub, childPath(path, name)))
      }
    } else if (key === 'items') {
      out.push(...schemaKeywordsOutsideSubset(child, `${path}[]`))
    }
  }
  return out
}
