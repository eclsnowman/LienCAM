const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** Paths cannot walk prototypes. This is a programmer API, never an operation
 * validator or operator refusal. Arrays can be preserved whole or by index. */
export function planPathParts(path: string): string[] {
  const parts = path.split('.')
  if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new TypeError(`Invalid operation edit path: ${path}`)
  }
  return parts
}
export function lookupPlanPath(object: unknown, parts: string[]): { present: boolean; value?: unknown } {
  let value = object
  for (const part of parts) {
    if (!record(value) || !owns(value, part)) return { present: false }
    value = value[part]
  }
  return { present: true, value }
}
const arrayIndex = (key: string): number => {
  const index = Number(key)
  if (!/^(0|[1-9]\d*)$/.test(key) || index >= 0xffffffff) {
    throw new TypeError(`Not an array element path: ${key}`)
  }
  return index
}

/** When a proposal dropped an edited array element, restore the source prefix
 * needed to reach it. Never create holes (ordinary reference consumers iterate
 * every element), and keep any elements the proposal still supplies. */
function fillArrayPrefix(target: unknown, key: string, template: unknown): void {
  if (!Array.isArray(target)) return
  const index = arrayIndex(key)
  while (target.length < index) {
    if (!Array.isArray(template) || !owns(template, String(target.length))) {
      throw new TypeError('An operation edit cannot create a sparse array')
    }
    target.push(structuredClone(template[target.length]))
  }
}

export function setPlanPath(object: object, parts: string[], source: { present: boolean; value?: unknown },
  sourceRoot?: object): void {
  let target = object as Record<string, unknown>
  let template: unknown = sourceRoot
  for (const [index, part] of parts.slice(0, -1).entries()) {
    const original = record(template) && owns(template, part) ? template[part] : undefined
    if (source.present) fillArrayPrefix(target, part, template)
    // A missing array element is an ordinary typed record, not just the leaf
    // we edited. Retain its other fields when the proposal supplies no element.
    if (source.present && Array.isArray(target) && !owns(target, part) && record(original)) {
      target[part] = structuredClone(original)
    }
    if (!owns(target, part) || !record(target[part]) ||
      (record(original) && Array.isArray(original) !== Array.isArray(target[part]))) {
      // A preserved absent path must not manufacture empty parent objects.
      if (!source.present) return
      if (owns(target, part) && target[part] !== undefined && !record(target[part]) && !record(original)) {
        throw new TypeError(`An operation edit cannot traverse a primitive: ${parts.slice(0, index + 1).join('.')}`)
      }
      // The old record supplies actual container types during merge, including
      // numeric-key objects. New authored parents use an index to imply arrays.
      target[part] = record(original) ? (Array.isArray(original) ? [] : {})
        : /^(0|[1-9]\d*)$/.test(parts[index + 1]) ? [] : {}
    }
    target = target[part] as Record<string, unknown>
    template = original
  }
  const key = parts[parts.length - 1]
  if (source.present) {
    fillArrayPrefix(target, key, template)
    target[key] = structuredClone(source.value)
  }
  else if (Array.isArray(target)) target.splice(arrayIndex(key), 1)
  else delete target[key]
}
export function samePlanValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!record(a) || !record(b) || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => owns(b, key) && samePlanValue(a[key], b[key]))
}
