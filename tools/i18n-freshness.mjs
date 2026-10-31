// WO-2942: offline source association, never a review verdict.
// WO-2943: the runtime fallback list is generated here, never computed in the browser.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { Script } from 'node:vm'
import ts from 'typescript'
import { isMain } from './lib/is-main.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const STATES = ['current', 'missing', 'source-changed', 'translation-unverified', 'obsolete']
const sorted = values => [...new Set(values)].sort()
const own = (object, key) => Object.hasOwn(object, key)
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

/** Same <language>/<area>.ts contract as catalogs.ts's glob. No roster. */
export function discoverCatalogs(root = ROOT) {
  const directory = resolve(root, 'src/i18n/locales')
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name < b.name ? -1 : 1)
    .flatMap(language => readdirSync(resolve(directory, language.name), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts')).sort((a, b) => a.name < b.name ? -1 : 1)
      .map(entry => ({ language: language.name, area: entry.name.slice(0, -3), file: `src/i18n/locales/${language.name}/${entry.name}` })))
}

/** Extends help-to-wiki.loadHelp's isolated transpile/cache pattern to catalogs.
 * Run repository-owned modules only. This VM is not an untrusted-code sandbox.
 * Imports are confined to catalog/Help sources; unknown forms fail explicitly. */
function sourceLoader(root) {
  const allowed = ['src/i18n/locales', 'src/help'].map(path => resolve(root, path) + sep)
  const cache = new Map()
  const files = new Set()
  function load(file) {
    if (!allowed.some(prefix => file.startsWith(prefix))) throw new Error(`Freshness import outside catalog/Help sources: ${file}`)
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    files.add(file.slice(resolve(root).length + 1).split(sep).join('/'))
    const result = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    })
    const errors = (result.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (errors.length) throw new Error(`${file}: ${errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`)
    function localRequire(specifier) {
      if (!specifier.startsWith('.')) throw new Error(`Freshness requires a local TS import: ${file} -> ${specifier}`)
      const base = resolve(dirname(file), specifier)
      const target = [base.endsWith('.ts') ? base : `${base}.ts`, resolve(base, 'index.ts')].find(path => existsSync(path))
      if (!target) throw new Error(`Freshness cannot resolve TS import: ${file} -> ${specifier}`)
      return load(target)
    }
    new Script(result.outputText, { filename: file }).runInNewContext({ module, exports: module.exports, require: localRequire })
    return module.exports
  }
  return { load, files }
}

/** Fail on malformed trees/collisions rather than silently losing keys. */
export function flatten(tree, prefix = '', result = {}) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) throw new Error(`Invalid catalog tree: ${prefix}`)
  for (const key of Object.keys(tree).sort()) {
    const path = prefix ? `${prefix}.${key}` : key
    const value = tree[key]
    if (typeof value === 'string') {
      if (own(result, path)) throw new Error(`Duplicate catalog key: ${path}`)
      Object.defineProperty(result, path, { value, enumerable: true, configurable: true, writable: true })
    } else flatten(value, path, result)
  }
  return result
}

/** Context binds positional Help leaves to their English section, including
 * kinds, headings, columns and cells. Equal text under different table columns
 * or moved between warning/paragraph sections must not reuse an association. */
export function helpContexts(topics) {
  const result = {}
  for (const topic of topics) {
    let heading = null
    topic.sections.forEach((section, index) => {
      if (section.kind === 'heading') heading = section.text
      result[`help.topics.${topic.id}.sections.${index}`] = canonical({ section, heading })
    })
  }
  return result
}

export function makeSnapshot(english, locales, contexts = {}, files = []) {
  const source = Object.fromEntries(Object.keys(english).sort().map(key => {
    let parent = key, context = null
    while (parent.includes('.')) {
      parent = parent.slice(0, parent.lastIndexOf('.'))
      if (own(contexts, parent)) { context = contexts[parent]; break }
    }
    return [key, { text: english[key], fingerprint: fingerprint({ text: english[key], context }) }]
  }))
  const translations = Object.fromEntries(Object.keys(locales).sort().map(language => [language,
    Object.fromEntries(Object.keys(locales[language]).sort().map(key => [key, {
      text: locales[language][key], fingerprint: fingerprint(locales[language][key]),
    }]))]))
  return { schemaVersion: 1, source, translations, files: sorted(files) }
}

export async function loadSnapshot(root = ROOT) {
  const loader = sourceLoader(root)
  const trees = {}
  const catalogs = discoverCatalogs(root)
  for (const catalog of catalogs) {
    trees[catalog.language] ??= {}
    trees[catalog.language][catalog.area] = loader.load(resolve(root, catalog.file)).default
  }
  if (!trees.en) throw new Error('Freshness needs English catalogs in src/i18n/locales/en')
  if (own(trees.en, 'help')) throw new Error('English Help has two sources: use registry.loadEnglishHelpCatalog(), not en/help.ts')
  const registry = loader.load(resolve(root, 'src/help/registry.ts'))
  trees.en.help = await registry.loadEnglishHelpCatalog()
  const topics = []
  for (const category of Object.keys(registry.CATEGORY_LOADERS).sort()) topics.push(...await registry.loadCategoryTopics(category))
  const english = flatten(trees.en)
  const locales = Object.fromEntries(Object.keys(trees).filter(language => language !== 'en').map(language => [language, flatten(trees[language])]))
  return makeSnapshot(english, locales, helpContexts(topics), loader.files)
}

/** One association per line keeps a whole-catalog metadata file small and its
 * diffs per key. Any JSON layout parses the same. */
export function formatMetadata(metadata) {
  const { entries, ...rest } = metadata
  const head = JSON.stringify(rest, null, 2).slice(0, -2)
  const languages = Object.keys(entries).sort().map(language => {
    const keys = Object.keys(entries[language]).sort()
    return `    ${JSON.stringify(language)}: {\n${keys.map(key => `      ${JSON.stringify(key)}: ${JSON.stringify(entries[language][key])}`).join(',\n')}\n    }`
  })
  return `${head}${Object.keys(rest).length ? ',' : ''}\n  "entries": {\n${languages.join(',\n')}\n  }\n}\n`
}

export function emptyMetadata() { return { schemaVersion: 1, entries: {} } }

/** Bootstrap is observation only. Never overwrites an existing association,
 * review, stale record, or obsolete record; only explicitly selected keys. */
export function bootstrap(snapshot, metadata = emptyMetadata(), { keys = [], evidence } = {}) {
  validateMetadata(metadata)
  if (!evidence?.trim()) throw new Error('Bootstrap requires observation evidence')
  const result = structuredClone(metadata)
  for (const language of Object.keys(snapshot.translations).sort()) {
    for (const key of sorted(keys)) {
      const source = snapshot.source[key], translation = snapshot.translations[language][key]
      if (!source || !translation?.text.trim() || result.entries[language]?.[key]) continue
      result.entries[language] ??= {}
      result.entries[language][key] = {
        sourceFingerprint: source.fingerprint, translationFingerprint: translation.fingerprint,
        provenance: { kind: 'bootstrap-observed', evidence }, review: { status: 'unreviewed' },
      }
    }
  }
  return result
}

/** WO-2943: record an actual translation decision for selected keys of one
 * language: the live English and translation are associated, with evidence.
 * Any earlier review is kept but no longer applies (its bindings differ). */
export function associate(snapshot, metadata = emptyMetadata(), { language, keys = [], evidence } = {}) {
  validateMetadata(metadata)
  if (!evidence?.trim()) throw new Error('Association requires evidence of the translation decision')
  if (!language || !own(snapshot.translations, language)) throw new Error(`Unknown translation language: ${language}`)
  if (!keys.length) throw new Error('Association needs explicit --key values')
  const result = structuredClone(metadata)
  for (const key of sorted(keys)) {
    const source = snapshot.source[key], translation = snapshot.translations[language][key]
    if (!source || !translation?.text.trim()) throw new Error(`Nothing to associate for ${language} ${key}`)
    const previous = result.entries[language]?.[key]
    result.entries[language] ??= {}
    result.entries[language][key] = {
      sourceFingerprint: source.fingerprint, translationFingerprint: translation.fingerprint,
      provenance: { kind: 'source-associated', evidence }, review: previous?.review || { status: 'unreviewed' },
    }
  }
  return result
}

function validateMetadata(metadata) {
  if (metadata?.schemaVersion !== 1 || !metadata.entries || typeof metadata.entries !== 'object' || Array.isArray(metadata.entries)) {
    throw new Error('Expected freshness metadata schemaVersion 1 with entries')
  }
  for (const [language, entries] of Object.entries(metadata.entries)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Invalid freshness entries: ${language}`)
    for (const [key, record] of Object.entries(entries)) {
      if (!record || typeof record !== 'object' || !['sourceFingerprint', 'translationFingerprint'].every(field => typeof record[field] === 'string')) {
        throw new Error(`Invalid freshness association: ${language} ${key}`)
      }
    }
  }
  for (const [key, tokens] of Object.entries(metadata.protectedTokens || {})) {
    if (!Array.isArray(tokens) || tokens.some(token => typeof token !== 'string' || !token.length)) throw new Error(`Invalid protected tokens: ${key}`)
  }
}

// Multiset comparison preserves duplicate interpolation/token requirements.
function tokens(text) {
  return (text.match(/\{\{[^{}]+\}\}|\$t\([^)]*\)|<\/?[A-Za-z][^>]*>|`[^`]+`|\b[GMTSFHD]\d+(?:\.\d+)?\b|\b(?:Ctrl|Alt|Shift|Meta)\+[A-Za-z0-9+]+|\b(?:GRBL|LinuxCNC|UCCNC|Mach3|FluidNC)\b|\.(?:nc|tap|ngc|step|stl|dxf|svg|tools|camproject)\b|\b\d+\.\d+\b/g) || []).sort()
}
export function structuralIssues(english, translation, protectedTokens = []) {
  const expected = tokens(english), actual = tokens(translation)
  const issues = JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ kind: 'protected-token-mismatch', expected, actual }]
  const markup = text => text.match(/<\/?[A-Za-z][^>]*>/g) || []
  if (JSON.stringify(markup(english)) !== JSON.stringify(markup(translation))) issues.push({ kind: 'markup-order-mismatch' })
  for (const token of sorted(protectedTokens)) {
    const expectedCount = english.split(token).length - 1, actualCount = translation.split(token).length - 1
    if (expectedCount !== actualCount) issues.push({ kind: 'declared-token-mismatch', token, expectedCount, actualCount })
  }
  return issues
}

export function reportFreshness(snapshot, metadata = emptyMetadata(), { previous } = {}) {
  validateMetadata(metadata)
  if (snapshot.schemaVersion !== 1 || previous && previous.schemaVersion !== 1) throw new Error('Expected snapshot schemaVersion 1')
  const languages = sorted([...Object.keys(snapshot.translations), ...Object.keys(metadata.entries), ...Object.keys(previous?.translations || {})])
  const rows = []
  for (const language of languages) {
    const translations = snapshot.translations[language] || {}
    const records = metadata.entries[language] || {}
    const keys = sorted([...Object.keys(snapshot.source), ...Object.keys(translations), ...Object.keys(records),
      ...Object.keys(previous?.translations[language] || {}), ...Object.keys(previous?.source || {})])
    for (const key of keys) {
      const source = snapshot.source[key], translation = translations[key], record = records[key]
      const sourceMatch = !!record && !!source && record.sourceFingerprint === source.fingerprint
      const translationMatch = !!record && !!translation && record.translationFingerprint === translation.fingerprint
      const associated = record?.provenance?.kind === 'source-associated' && !!record?.provenance?.evidence?.trim()
      const issues = source && translation?.text.trim() ? structuralIssues(source.text, translation.text, metadata.protectedTokens?.[key]) : []
      const reasons = []
      let state
      if (!source) { state = 'obsolete'; reasons.push('english-key-removed') }
      else if (!translation?.text.trim()) { state = 'missing'; reasons.push('translation-missing-or-empty') }
      else if (record && !sourceMatch) { state = 'source-changed'; reasons.push('english-source-or-help-context-changed') }
      else if (!translationMatch || !associated || issues.length) {
        state = 'translation-unverified'
        if (!record) reasons.push('no-source-association')
        else {
          if (!translationMatch) reasons.push('translation-content-changed')
          if (!associated) reasons.push(record?.provenance?.kind === 'bootstrap-observed' ? 'bootstrap-observation-only' : 'association-provenance-missing')
        }
      } else state = 'current'
      reasons.push(...sorted(issues.map(issue => issue.kind)))
      const review = record?.review || { status: 'unreviewed' }
      // Review owns its exact content/context bindings. Reassociation must not
      // revive historical approval; legacy unbound reviews remain visible only.
      const reviewApplies = state === 'current' && review.status === 'reviewed' && !!review.reviewer?.trim() && !!review.evidence?.trim()
        && review.sourceFingerprint === source?.fingerprint && review.translationFingerprint === translation?.fingerprint
        && sourceMatch && translationMatch && !issues.length && associated
      rows.push({ language, key, state, reasons, issues, sourceFingerprint: source?.fingerprint || null,
        translationFingerprint: translation?.fingerprint || null, sourceMatch, translationMatch,
        provenance: record?.provenance || null, review, reviewApplies })
    }
  }
  const deltas = []
  if (previous) for (const key of sorted([...Object.keys(snapshot.source), ...Object.keys(previous.source)])) {
    const old = previous.source[key], next = snapshot.source[key]
    if (old?.fingerprint !== next?.fingerprint) deltas.push({ key, change: !old ? 'added' : !next ? 'removed' : 'changed' })
  }
  const changedSource = new Set(deltas.map(delta => delta.key))
  const affected = rows.filter(row => {
    if (!previous) return row.state !== 'current'
    return changedSource.has(row.key)
      || previous.translations[row.language]?.[row.key]?.fingerprint !== snapshot.translations[row.language]?.[row.key]?.fingerprint
      || !own(previous.translations, row.language) && own(snapshot.translations, row.language)
  }).map(({ language, key, state }) => ({ language, key, state }))
  const summary = Object.fromEntries(languages.map(language => [language, Object.fromEntries(STATES.map(state =>
    [state, rows.filter(row => row.language === language && row.state === state).length]))]))
  return { schemaVersion: 1, policy: 'Current means explicit source/content association, not linguistic approval. Local checkout only.',
    languages, summary, deltas, affected, rows }
}

/** WO-2943 migration policy: only a translation whose recorded English source
 * fingerprint no longer matches (source-changed) falls back to English. Bootstrap
 * observations and untracked translations stay visible: unverified is not stale,
 * and no blanket English replacement happens. Missing keys already fall back. */
export const RUNTIME_FILE = 'src/i18n/freshness/stale.json'
export function runtimeFallback(report) {
  const fallback = {}
  for (const row of report.rows) if (row.state === 'source-changed') (fallback[row.language] ??= []).push(row.key)
  return { schemaVersion: 1, generatedBy: 'node tools/i18n-freshness.mjs --write-runtime',
    policy: 'Keys whose English source changed after their translation was recorded show English until the translation is updated.',
    fallback: Object.fromEntries(Object.keys(fallback).sort().map(language => [language, sorted(fallback[language])])) }
}
export const renderRuntime = runtime => JSON.stringify(runtime, null, 2) + '\n'

export function renderReport(report) {
  return [report.policy, ...report.languages.map(language => `${language}: ${Object.entries(report.summary[language]).map(([state, count]) => `${state}=${count}`).join(' ')}`),
    `Source deltas: ${report.deltas.length}; affected items: ${report.affected.length}`,
    ...report.affected.map(row => `${row.language} ${row.state} ${row.key}`)].join('\n') + '\n'
}

async function main(args) {
  const options = {}, flags = new Set(['--json', '--snapshot', '--bootstrap', '--associate', '--all', '--runtime', '--write-runtime', '--check-runtime'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (flags.has(arg)) options[arg.slice(2)] = true
    else if (['--metadata', '--previous', '--key', '--evidence', '--language'].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--key') (options.keys ??= []).push(value)
      else options[arg.slice(2)] = value
    } else throw new Error(`Unknown freshness argument: ${arg}`)
  }
  const modes = ['snapshot', 'bootstrap', 'associate', 'runtime', 'write-runtime', 'check-runtime'].filter(mode => options[mode])
  if (modes.length > 1) throw new Error(`Choose one of --${modes.join(', --')}`)
  if (options.all && !options.bootstrap) throw new Error('--all selects bootstrap keys; use it with --bootstrap')
  const snapshot = await loadSnapshot(ROOT)
  const metadata = readJson(resolve(ROOT, options.metadata || 'src/i18n/freshness/associations.json'))
  if (options.snapshot) return console.log(JSON.stringify(snapshot, null, 2))
  if (options.bootstrap) {
    // --all: every key some language translates, still observation-only.
    const keys = options.all ? sorted(Object.values(snapshot.translations).flatMap(words => Object.keys(words))) : options.keys
    return process.stdout.write(formatMetadata(bootstrap(snapshot, metadata, { keys, evidence: options.evidence })))
  }
  if (options.associate) {
    return process.stdout.write(formatMetadata(associate(snapshot, metadata, { language: options.language, keys: options.keys, evidence: options.evidence })))
  }
  const previous = options.previous ? readJson(resolve(ROOT, options.previous)) : undefined
  const report = reportFreshness(snapshot, metadata, { previous })
  if (options.runtime || options['write-runtime'] || options['check-runtime']) {
    const text = renderRuntime(runtimeFallback(report)), file = resolve(ROOT, RUNTIME_FILE)
    if (options.runtime) return process.stdout.write(text)
    // The one file this tool writes: UTF-8, no BOM, so the browser bundle imports it on every OS.
    if (options['write-runtime']) return writeFileSync(file, text)
    const committed = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') : ''
    if (committed !== text) {
      console.error(`${RUNTIME_FILE} is out of date with the catalogs: run node tools/i18n-freshness.mjs --write-runtime`)
      process.exitCode = 1
    }
    return
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : renderReport(report))
}
if (isMain(import.meta.url)) {
  try { await main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
