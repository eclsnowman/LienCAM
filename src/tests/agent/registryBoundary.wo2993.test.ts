// WO-2993 (WO-2951 Order B) T9: the registry's boundary.
//
//   - MODEL_COMMAND_ALLOW_LIST is frozen data and equals the registry's keys.
//   - Every command schema uses only the documented JSON Schema subset, and the
//     validator is the one that runs (schema.ts).
//   - No module under src/lib/agent, and none of the src/doc modules they pull
//     in, imports a path ADR-0055 decision 2.2 bans; the eslint block refuses
//     the same imports.
//   - A command never writes store state or reaches a window.__ hook.
//   - Results are frozen copies: mutating one does not change the model.
//
// Negative control (rule 6): a banned import added to a scratch copy of
// registry.ts fails both the module-graph scan and the lint; the recorded output
// is src/tests/evidence/WO-2993/negative-controls.json.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, schemaKeywordsOutsideSubset } from '../../lib/agent/schema'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const AGENT_DIR = join(ROOT, 'src/lib/agent')

afterEach(() => resetDocumentHolder())

const BANNED = [
  /(^|\/)machine(\/|$)/,
  /(^|\/)store\/machine[^/]*$/,
  /(^|\/)probeRoutineStore$/,
  /(^|\/)gcode\/appCommand$/,
  /(^|\/)pendant(\/|$)/,
]

/** Repo-relative path with forward slashes on every platform (Windows `relative` uses backslashes). */
function repoPath(file: string): string {
  return relative(ROOT, file).replace(/\\/g, '/')
}

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return listSources(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/** Banned specifiers reachable from `entry` through relative imports that stay under src/lib/agent or src/doc. */
function bannedImportsReachableFrom(entries: string[], readSource: (file: string) => string = (f) => readFileSync(f, 'utf8')): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiers(readSource(file))) {
      if (BANNED.some((re) => re.test(spec))) found.push(`${repoPath(file)} -> ${spec}`)
      if (!spec.startsWith('.')) continue
      const target = resolveRelative(file, spec)
      if (target === undefined) continue
      const rel = repoPath(target)
      if (rel.startsWith('src/doc/') || rel.startsWith('src/lib/agent/')) queue.push(target)
    }
  }
  return found
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('WO-2993 T9 registry boundary', () => {
  it('MODEL_COMMAND_ALLOW_LIST is frozen and equals the registry keys', () => {
    expect(Object.isFrozen(MODEL_COMMAND_ALLOW_LIST)).toBe(true)
    expect([...MODEL_COMMAND_ALLOW_LIST].sort()).toEqual(['model.chamfer', 'model.extrude', 'model.feature.delete', 'model.fillet', 'model.hole', 'model.parameter.set', 'model.parameters', 'model.redo', 'model.revolve', 'model.sketch.create', 'model.summary', 'model.undo'])
    expect(modelCommands.list().map((c) => c.id).sort()).toEqual([...MODEL_COMMAND_ALLOW_LIST].sort())
    expect(Object.isFrozen(modelCommands)).toBe(true)
    // The read allow-list is unchanged: model is a property of the hook, not a read command.
    expect(modelCommands.list().find((c) => c.id === 'model.parameter.set')?.effect).toBe('edit')
    expect(modelCommands.list().find((c) => c.id === 'model.parameters')?.effect).toBe('read')
  })

  it('every command schema stays inside the documented keyword subset, and the validator checks exactly that subset', () => {
    for (const id of MODEL_COMMAND_ALLOW_LIST) {
      const described = modelCommands.describe(id)
      expect(described, id).not.toBeNull()
      expect(schemaKeywordsOutsideSubset(described?.input), `${id} input`).toEqual([])
      expect(schemaKeywordsOutsideSubset(described?.output), `${id} output`).toEqual([])
      expect(described?.input).toMatchObject({ type: 'object', additionalProperties: false })
    }
    expect(modelCommands.describe('model.sketch.new')).toBeNull()
    // A spec reaching past the subset is caught.
    expect(schemaKeywordsOutsideSubset({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } })).toEqual(['$.a:pattern'])
    expect(schemaKeywordsOutsideSubset({ type: 'array', items: { type: 'number', multipleOf: 2 } })).toEqual(['$[]:multipleOf'])
    // The validator: required, additionalProperties:false, enum, minimum/maximum, items, types.
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['n'],
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 3 },
        kind: { type: 'string', enum: ['a', 'b'] },
        list: { type: 'array', items: { type: 'boolean' } },
      },
    } as const
    expect(firstSchemaProblem(schema, { n: 2, kind: 'a', list: [true] })).toBeUndefined()
    expect(firstSchemaProblem(schema, {})?.path).toBe('$.n')
    expect(firstSchemaProblem(schema, { n: 0 })?.path).toBe('$.n')
    expect(firstSchemaProblem(schema, { n: 4 })?.path).toBe('$.n')
    expect(firstSchemaProblem(schema, { n: 1.5 })?.path).toBe('$.n')
    expect(firstSchemaProblem(schema, { n: 1, kind: 'c' })?.path).toBe('$.kind')
    expect(firstSchemaProblem(schema, { n: 1, list: [true, 1] })?.path).toBe('$.list[1]')
    expect(firstSchemaProblem(schema, { n: 1, extra: 1 })?.path).toBe('$.extra')
    expect(firstSchemaProblem(schema, [])?.path).toBe('$')
    // A type list: text or null, nothing else.
    const nullable = { type: ['string', 'null'] } as const
    expect(firstSchemaProblem(nullable, 'a')).toBeUndefined()
    expect(firstSchemaProblem(nullable, null)).toBeUndefined()
    expect(firstSchemaProblem(nullable, 1)?.message).toBe('The arguments must be text or null.')
  })

  it('no module under src/lib/agent, and none of the src/doc modules they import, imports a banned path', () => {
    const entries = listSources(AGENT_DIR)
    expect(entries.map(repoPath)).toEqual(expect.arrayContaining([
      'src/lib/agent/registry.ts',
      'src/lib/agent/schema.ts',
      'src/lib/agent/model/parameterSet.ts',
      'src/lib/agent/commands.ts',
    ]))
    expect(bannedImportsReachableFrom(entries)).toEqual([])
  })

  it('the scan sees a banned import added to registry.ts (scratch copy)', () => {
    const registry = join(AGENT_DIR, 'registry.ts')
    const poisoned = (file: string) =>
      file === registry ? `import { jog } from '../machine/jogControls'\n${readFileSync(file, 'utf8')}` : readFileSync(file, 'utf8')
    expect(bannedImportsReachableFrom([registry], poisoned)).toEqual(['src/lib/agent/registry.ts -> ../machine/jogControls'])
  })

  it('the eslint block refuses every banned import under src/lib/agent and permits the allowed ones', async () => {
    const engine = new ESLint({ cwd: ROOT })
    const refuse = async (spec: string) => {
      const [r] = await engine.lintText(`import ${JSON.stringify(spec)}\n`, { filePath: 'src/lib/agent/wo2993Scratch.ts' })
      return r.messages.some((m) => m.message.includes('ADR-0055: src/lib/agent may not import'))
    }
    for (const spec of [
      '../machine/jogControls',
      '../../lib/machine/session',
      '../../store/machineLibrary',
      '../../store/probeRoutineStore',
      '../gcode/appCommand',
      '../../../pendant/uccnc-bridge/thing',
    ]) {
      expect(await refuse(spec), spec).toBe(true)
    }
    for (const spec of ['../../doc/documentHolder', '../../store', '../cam/generationFingerprint']) {
      expect(await refuse(spec), spec).toBe(false)
    }
    // The block sits beside the other lane blocks without replacing them.
    const [cam] = await engine.lintText("import '../../store'\n", { filePath: 'src/lib/cam/wo2993Scratch.ts' })
    expect(cam.messages.some((m) => m.message.includes('lib/cam may not import store, post, or components'))).toBe(true)
  })

  it('no command writes store state or reaches a window.__ hook', () => {
    for (const rel of ['registry.ts', 'schema.ts', 'model/parameterSet.ts']) {
      const code = stripComments(readFileSync(join(AGENT_DIR, rel), 'utf8'))
      expect(code, rel).not.toMatch(/\.setState\b/)
      expect(code, rel).not.toMatch(/window\.__|globalThis\.__/)
      expect(code, rel).not.toMatch(/useCamStore/)
    }
    // The one named exception (design "Undo and redo"): with a Form open, model.undo / model.redo call
    // the Form store's own undo / redo, exactly as the button does. No other store is reached.
    const commands = stripComments(readFileSync(join(AGENT_DIR, 'model/parameterSet.ts'), 'utf8'))
    expect([...commands.matchAll(/\buse\w+Store\b/g)].map((m) => m[0]).every((n) => n === 'useFormStore')).toBe(true)
    expect([...commands.matchAll(/\bform\.(\w+)\(/g)].map((m) => m[1]).sort()).toEqual(['redo', 'undo'])
    for (const rel of ['registry.ts', 'schema.ts']) {
      expect(stripComments(readFileSync(join(AGENT_DIR, rel), 'utf8')), rel).not.toMatch(/\buse\w+Store\b/)
    }
  })

  it('results are frozen copies: mutating one does not change the model', async () => {
    const dag = new FeatureDag()
    const session = createModelSession({ modelItemId: LEGACY_MODEL_ITEM_ID, dag, map: new ElementMap() })
    registerModelSession(session)
    const set = await modelCommands.run('model.parameter.set', { name: 'w', expression: '5' })
    const read = await modelCommands.run('model.parameters')
    if (!set.ok || !read.ok) throw new Error('expected success')
    const dagBefore = dag.serialize()
    for (const r of [set, read]) {
      expect(Object.isFrozen(r)).toBe(true)
      expect(Object.isFrozen(r.value)).toBe(true)
      expect(Object.isFrozen(r.changed)).toBe(true)
    }
    expect(() => { (set.value as { value: number }).value = 99 }).toThrow(TypeError)
    expect(() => { (read.value as { parameters: unknown[] }).parameters.push({}) }).toThrow(TypeError)
    expect(session.params.valueOf('w')).toBe(5)
    expect(dag.serialize()).toBe(dagBefore)
    // The schema describe() hands out is a copy as well.
    const described = modelCommands.describe('model.parameter.set')
    expect(Object.isFrozen(described)).toBe(true)
  })
})
