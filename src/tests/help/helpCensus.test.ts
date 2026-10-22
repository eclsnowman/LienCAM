// HELP-1 census - the mechanical teeth behind the CONVENTIONS.md rule that
// every completed feature updates the help.
//   S1: structure checks (ids, categories, context-key grammar, index sync).
//   S2: surface coverage - every modal id the app compares activeModal to,
//       every selectable OperationType, and every ViewMode/Workspace member
//       must have a topic, or a NAMED exemption below stating why. Surfaces
//       are harvested from the real source at test time, so adding a modal
//       or operation type without help fails BY NAME here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { HELP_CATEGORIES } from '../../help/categories'
import { HELP_INDEX } from '../../help/index-data'
import { CATEGORY_LOADERS, loadCategoryTopics } from '../../help/registry'
import { isValidContextKey, toIndexEntry, type HelpTopic } from '../../help/types'

async function allTopics(): Promise<HelpTopic[]> {
  const cats = Object.keys(CATEGORY_LOADERS) as Array<keyof typeof CATEGORY_LOADERS>
  const loaded = await Promise.all(cats.map((c) => loadCategoryTopics(c)))
  return loaded.flat()
}

describe('help census (S1 structure)', () => {
  it('every category id is unique and known', () => {
    const ids = HELP_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('topic ids are unique and every topic sits in a known category', async () => {
    const topics = await allTopics()
    const ids = topics.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    const known = new Set(HELP_CATEGORIES.map((c) => c.id))
    for (const t of topics) {
      expect(known.has(t.category), `topic ${t.id} category ${t.category}`).toBe(true)
    }
  })

  it('every contextKey parses against the grammar', async () => {
    for (const t of await allTopics()) {
      for (const key of t.contextKeys) {
        expect(isValidContextKey(key), `topic ${t.id} contextKey "${key}"`).toBe(true)
      }
    }
  })

  it('every relatedTopicId resolves in the index', async () => {
    const ids = new Set(HELP_INDEX.map((e) => e.id))
    for (const t of await allTopics()) {
      for (const rel of t.relatedTopicIds) {
        expect(ids.has(rel), `topic ${t.id} related "${rel}"`).toBe(true)
      }
    }
  })

  it('every image section references a declared image slot', async () => {
    for (const t of await allTopics()) {
      const slots = new Set(t.images.map((i) => i.slot))
      for (const s of t.sections) {
        if (s.kind === 'image') {
          expect(slots.has(s.slot), `topic ${t.id} image slot "${s.slot}"`).toBe(true)
        }
      }
    }
  })

  it('the EAGER index matches the topic modules field for field, both directions', async () => {
    const topics = await allTopics()
    const fromModules = new Map(topics.map((t) => [t.id, toIndexEntry(t)]))
    // no index entry without a module
    for (const entry of HELP_INDEX) {
      const derived = fromModules.get(entry.id)
      expect(derived, `index entry ${entry.id} has no topic module`).toBeTruthy()
      expect(entry, `index entry ${entry.id} drifted from its module`).toEqual(derived)
    }
    // no module without an index entry
    const indexIds = new Set(HELP_INDEX.map((e) => e.id))
    for (const t of topics) {
      expect(indexIds.has(t.id), `topic module ${t.id} missing from HELP_INDEX`).toBe(true)
    }
  })

  it('every category present in the index has a body loader', () => {
    const loaderCats = new Set(Object.keys(CATEGORY_LOADERS))
    for (const entry of HELP_INDEX) {
      expect(loaderCats.has(entry.category), `category ${entry.category} has topics but no loader`).toBe(true)
    }
  })

  it('every topic declares a sinceVersion and at least one contextKey', async () => {
    for (const t of await allTopics()) {
      expect(/^\d+\.\d+\.\d+$/.test(t.sinceVersion), `topic ${t.id} sinceVersion "${t.sinceVersion}"`).toBe(true)
      expect(t.contextKeys.length, `topic ${t.id} has no contextKeys`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// S2 surface coverage - harvested from the live source, not a copied list.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Every product .ts/.tsx under src/, excluding src/tests (test fixtures open
 *  modals freely and are not user-facing surfaces). */
function productSources(): string[] {
  const testsDir = join(SRC_ROOT, 'tests')
  const files: string[] = []
  const walk = (dir: string) => {
    if (dir === testsDir) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p)
    }
  }
  walk(join(SRC_ROOT))
  return files
}

/** Modal ids the app actually uses: compared against activeModal, passed to
 *  openModal(), or set as an activeModal literal in the store. */
function harvestModalIds(): Set<string> {
  const ids = new Set<string>()
  const patterns = [
    /activeModal\s*[!=]==\s*'([a-z0-9-]+)'/g,
    /openModal\('([a-z0-9-]+)'\)/g,
    /activeModal:\s*'([a-z0-9-]+)'/g,
  ]
  for (const file of productSources()) {
    const text = readFileSync(file, 'utf8')
    for (const re of patterns) {
      for (const m of text.matchAll(re)) ids.add(m[1])
    }
  }
  return ids
}

/** String literals of an exported union type in src/types/index.ts. */
function harvestUnionMembers(typeName: string, multiline: boolean): string[] {
  const source = readFileSync(join(SRC_ROOT, 'types', 'index.ts'), 'utf8')
  const block = multiline
    ? source.match(new RegExp(`export type ${typeName} =([^]*?)\\r?\\n\\r?\\n`))?.[1]
    : source.match(new RegExp(`export type ${typeName} = (.+)`))?.[1]
  if (!block) return []
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** Exempt surfaces. Every entry must still exist in the harvest (a stale
 *  exemption fails) and must stay uncovered (cover it -> remove the entry). */
const MODAL_EXEMPTIONS: Record<string, string> = {
  help: 'the Help Center itself - deriveHelpContext suppresses it so suggestions reflect the screen behind the modal',
  'help-errors': 'error-console entry point into the same Help Center modal, same suppression',
}

const OPERATION_EXEMPTIONS: Record<string, string> = {
  steep_shallow_3d: 'selectable in WO-1190; its dedicated Help topic is tracked separately from this operation implementation',
  pencil_3d: 'selectable in WO-1193; its dedicated Help topic is tracked separately from this operation implementation',
}

function camelToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** Field names of an exported `interface <interfaceName> { ... }` block, read
 *  straight from the operation's own params declaration - never a copied
 *  list, so an added field fails BY NAME the moment it ships without help. */
function harvestParamFields(file: string[], interfaceName: string): string[] {
  const source = readFileSync(join(SRC_ROOT, ...file), 'utf8')
  const block = source.match(new RegExp(`export interface ${interfaceName} \\{([^]*?)\\n\\}`))?.[1]
  if (!block) return []
  return [...block.matchAll(/^\s*([a-zA-Z_]\w*)\??:/gm)].map((m) => camelToKebab(m[1]))
}

/**
 * Per-operation 3D parameter interfaces, harvested field-by-field so a param
 * an operation exposes to the operator (WO-1293) fails by name without help.
 * Only scallop_3d is wired in: it proves the axis on the parameter (the edge
 * overrun) WO-1293 was filed to cover. The other five 3D operations declare
 * 38 more fields between them (Adaptive3dParams 16, WaterlineParams 9,
 * SteepShallow3dParams 8, Parallel3dParams 8 minus the 1 already shared with
 * scallop's overrun convention, Pencil3dParams 5) with no per-parameter
 * topic yet - widening this table is the follow-up WO; see WO-1293's "still
 * NOT covered" section for the count and the reasoning.
 */
const OPERATION_PARAM_SOURCES: Record<string, { file: string[]; interfaceName: string }> = {
  // WO-2977: the interface moved to src/kernel/parameterTypes.ts (scallop3dOperation.ts now only re-exports it).
  scallop_3d: { file: ['kernel', 'parameterTypes.ts'], interfaceName: 'Scallop3dParams' },
}

async function coveredContextKeys(): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const t of await allTopics()) {
    for (const k of t.contextKeys) keys.add(k)
  }
  return keys
}

function assertSurfaceCovered(
  surface: string,
  ids: Iterable<string>,
  keyFor: (id: string) => string,
  covered: Set<string>,
  exemptions: Record<string, string>,
) {
  const missing = [...ids].filter((id) => !exemptions[id] && !covered.has(keyFor(id)))
  expect(
    missing.length,
    `${surface} without a help topic (add a topic with contextKey, or a justified exemption): ${missing.join(', ')}`,
  ).toBe(0)
  for (const [id, why] of Object.entries(exemptions)) {
    expect([...ids].includes(id), `stale ${surface} exemption "${id}" (${why}) - surface no longer exists, remove it`).toBe(true)
    expect(covered.has(keyFor(id)), `${surface} exemption "${id}" is now covered by a topic - remove the exemption`).toBe(false)
  }
}

describe('help census (S2 surface coverage)', () => {
  it('every modal id the app compares activeModal to has a modal:<id> topic', async () => {
    const ids = harvestModalIds()
    // Harvest sanity: 14 ids known 2026-08-02; a collapse below 10 means the
    // regexes rotted, not that the app lost half its modals.
    expect(ids.size, `modal-id harvest collapsed: ${[...ids].join(', ')}`).toBeGreaterThanOrEqual(10)
    assertSurfaceCovered('modal', ids, (id) => `modal:${id}`, await coveredContextKeys(), MODAL_EXEMPTIONS)
  })

  it('every OperationType has a selection:operation:<type> topic', async () => {
    const types = harvestUnionMembers('OperationType', true)
    expect(types.length, `OperationType harvest collapsed: ${types.join(', ')}`).toBeGreaterThanOrEqual(10)
    expect(types).toContain('contour_2d')
    assertSurfaceCovered('operation type', types, (t) => `selection:operation:${t}`, await coveredContextKeys(), OPERATION_EXEMPTIONS)
  })

  it('every ViewMode has a mode:<mode> topic', async () => {
    const modes = harvestUnionMembers('ViewMode', false)
    expect(modes.length, `ViewMode harvest collapsed: ${modes.join(', ')}`).toBeGreaterThanOrEqual(3)
    expect(modes).toContain('setup')
    assertSurfaceCovered('view mode', modes, (m) => `mode:${m}`, await coveredContextKeys(), {})
  })

  it('every Workspace has a workspace:<id> topic', async () => {
    const workspaces = harvestUnionMembers('Workspace', false)
    expect(workspaces.length, `Workspace harvest collapsed: ${workspaces.join(', ')}`).toBeGreaterThanOrEqual(2)
    expect(workspaces).toContain('cam')
    assertSurfaceCovered('workspace', workspaces, (w) => `workspace:${w}`, await coveredContextKeys(), {})
  })

  it('every ControllerType has a controller:<id> topic', async () => {
    const controllers = harvestUnionMembers('ControllerType', false)
    expect(controllers.length, `ControllerType harvest collapsed: ${controllers.join(', ')}`).toBeGreaterThanOrEqual(4)
    expect(controllers).toContain('grblhal')
    assertSurfaceCovered('controller', controllers, (c) => `controller:${c}`, await coveredContextKeys(), {})
  })

  it('every wired operation parameter has a selection:operation:<type>:<param> topic', async () => {
    const covered = await coveredContextKeys()
    for (const [opType, source] of Object.entries(OPERATION_PARAM_SOURCES)) {
      const fields = harvestParamFields(source.file, source.interfaceName)
      expect(fields.length, `${source.interfaceName} harvest collapsed: ${fields.join(', ')}`).toBeGreaterThanOrEqual(5)
      expect(fields).toContain('stock-edge-overshoot')
      assertSurfaceCovered(`${opType} parameter`, fields, (f) => `selection:operation:${opType}:${f}`, covered, {})
    }
  })
})
