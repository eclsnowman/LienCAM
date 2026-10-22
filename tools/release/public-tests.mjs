#!/usr/bin/env node
import { isMain } from '../lib/is-main.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const slash = path => path.replaceAll('\\', '/')
const contains = (parent, path) => path === parent.replace(/\/$/, '') || path.startsWith(`${parent.replace(/\/$/, '')}/`)
const isTest = path => /\.test\.tsx?$/.test(path)

// WO-2462: exact public-run exceptions, not export exclusions or private-suite
// skips. The ARM/Linux findings are recorded in SPARK-PLATFORM-RED.md.
// WO-2390 exports e2e/, so faceCreateOnFreshProject stays in the public run.
const publicRunExceptions = Object.freeze({
  'src/tests/cam3d/inputStep.test.ts':
    'manifest private-only: PRIVATE-ONLY - requires obj_1_Platte C.stl, excluded from redistribution for missing rights.',
  'src/tests/cam3d/inputStl.test.ts':
    'manifest private-only: PRIVATE-ONLY - requires obj_1_Platte C.stl, excluded from redistribution for missing rights.',
  'src/tests/benchmark/full.test.ts':
    'main-red: WO-2488 Spark main 7d1578019 has five baseline metric cells outside the landing band; reproduced alone (3 pass, 1 fail).',
  'src/tests/store/int17aR1ConsumerCensus.test.ts':
    'main-red: WO-2488 Spark main 7d1578019 has an unclassified lib/post/setupSheet.ts geometry reader; reproduced alone (1 pass, 1 fail).',
  'src/tests/adaptive-clearing/engine/_bytestab-fingerprint.test.ts':
    'platform-only: ARM floating-point divergence changes nine adaptive fixture hashes and pass counts.',
  'src/tests/adaptive-clearing/engine/b8-routearound-stage3.test.ts':
    'platform-only: ARM floating-point divergence changes the stage-three route-around hash.',
  'src/tests/adaptive-clearing/engine/conventional-direction.test.ts':
    'platform-only: ARM conventional cut stream takes one fewer cut; material-side split is 0.015756 against a 0.01 bound.',
  'src/tests/adaptive-clearing/engine/goodspec-tripwires.test.ts':
    'platform-only: ARM floating-point divergence changes adaptive lift/cut counts by one or two.',
  'src/tests/adaptive-clearing/engine/loopback-fillet.test.ts':
    'platform-only: ARM floating-point divergence changes Barbell pct25 traverses from 44 to 51.',
  'src/tests/adaptive-clearing/engine/process-feature.test.ts':
    'platform-only: ARM floating-point divergence changes one island keep-out link.',
  'src/tests/machine/bridgeFirstRun.wo1183.test.ts':
    'platform-only: first-run bridge fixtures require the Windows .NET Framework C# compiler and Windows executable hosting.',
  'src/tests/machine/rehearsalProfileIsolated.wo2030.test.ts':
    'desktop runtime: profile-isolation journey requires an Electron binary and a built desktop renderer, not just public source inputs.',
})

export function discoverTests(root) {
  const files = []
  const visit = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && isTest(path)) files.push(slash(relative(root, path)))
    }
  }
  visit(join(root, 'src/tests'))
  return files.sort()
}

// Ordered selection is the exporter's contract, including capture-proof's
// re-inclusion. A missing private input must stay private in the exported tree.
export function selectedForExport(path, manifest) {
  let selected = false
  for (const entry of manifest.selection) {
    if (contains(entry.path, path)) selected = entry.action === 'include'
  }
  return selected
}

// WO-2629: public-run skips cannot repair tsc's include:[src]. Inspect actual
// exported modules, independently of platform/runtime skips and fixture reads.
export function incompleteTestImports(root) {
  root = resolve(root)
  const modules = []
  const collect = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (/\.[cm]?[jt]sx?$/.test(path)) modules.push(slash(relative(root, path)))
    }
  }
  collect(join(root, 'src/tests'))
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true }
  const cache = ts.createModuleResolutionCache(root, path => path, options)
  const graph = new Map()
  const describe = path => {
    if (graph.has(path)) return graph.get(path)
    const result = { dependencies: [], missing: [] }
    graph.set(path, result)
    if (!/\.[cm]?[jt]sx?$/.test(path)) return result
    const text = readFileSync(join(root, path), 'utf8')
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!specifier.startsWith('.')) continue // Packages are installed by npm ci.
      const input = specifier.split(/[?#]/)[0]
      const target = ts.resolveModuleName(input, join(root, path), options, ts.sys, cache).resolvedModule
      const asset = resolve(root, dirname(path), input)
      const resolved = target?.resolvedFileName
        ?? (existsSync(asset) && statSync(asset).isFile() ? asset : null)
      if (!resolved) result.missing.push(`${path} imports ${specifier} -> ${slash(relative(root, asset))}`)
      else result.dependencies.push(slash(relative(root, resolved)))
    }
    return result
  }
  return modules.sort().flatMap(path => {
    const visited = new Set()
    const reasons = new Set()
    const visit = current => {
      if (visited.has(current)) return
      visited.add(current)
      const description = describe(current)
      for (const reason of description.missing) reasons.add(reason)
      for (const dependency of description.dependencies) visit(dependency)
    }
    visit(path)
    return reasons.size ? [{ path, reasons: [...reasons].sort() }] : []
  })
}

export function buildPublicTestList(root = process.cwd(), manifest = JSON.parse(readFileSync(join(root, 'tools/release/manifest.json'), 'utf8'))) {
  root = resolve(root)
  const descriptions = new Map()
  const privacy = new Map()
  const privateReason = path => {
    if (privacy.has(path)) return privacy.get(path)
    let reason = null
    if (contains('src/tests/evidence', path)) reason = 'evidence read'
    else if (contains('src/tests/tools', path) && !contains('src/tests/tools/capture-proof', path)) reason = 'harness'
    const explicit = (manifest.publicTests?.privateOnly ?? []).find(entry => contains(entry.path, path))
    if (!reason && explicit) reason = `manifest private-only: ${explicit.reason}`
    if (!reason && !selectedForExport(path, manifest)) reason = 'manifest private-only: outside export selection'
    privacy.set(path, reason)
    return reason
  }
  const repoPath = (value, from) => {
    value = slash(value)
    if (value.startsWith('.')) return slash(relative(root, resolve(root, dirname(from), value)))
    if (/^(?:src|tools|docs|pendant|electron|public|test_fixtures|queue|\.planning|\.claude|Example Projects|Sample Parts)\//.test(value)) return value
    return null
  }
  const describe = path => {
    if (descriptions.has(path)) return descriptions.get(path)
    const result = { inputs: new Set(), imports: new Set(), dependencies: new Set(), reasons: new Set() }
    descriptions.set(path, result)
    if (!existsSync(join(root, path)) || !/\.(?:[cm]?[jt]sx?)$/.test(path)) return result
    const text = readFileSync(join(root, path), 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    // Includes import types as well as static, dynamic and require imports.
    for (const input of ts.preProcessFile(text, true, true).importedFiles) result.imports.add(input.fileName)
    const literal = node => ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : null
    const addInput = value => {
      const normalized = slash(value)
      const evidence = normalized.match(/^(?:\/|https?:\/\/[^/]+\/)(src\/tests\/evidence(?:\/.*)?$)/)
      if (evidence) result.inputs.add(evidence[1])
      const input = repoPath(value, path)
      if (input) result.inputs.add(input)
    }
    const visit = node => {
      const value = literal(node)
      if (value !== null) addInput(value)
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) addInput(span.literal.text)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = literal(node.left)
        const right = literal(node.right)
        if (left !== null && right !== null) addInput(left + right)
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const value = literal(node.moduleSpecifier)
        if (value !== null) result.imports.add(value)
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source)
        if ((name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments[0]) {
          const value = literal(node.arguments[0])
          if (value !== null) result.imports.add(value)
        }
        // join/resolve often split 'src', 'tests', 'evidence' across arguments.
        if (/(?:^|\.)(?:join|resolve)$/.test(name)) {
          const pieces = node.arguments.map(literal).filter(value => value !== null)
          if (pieces.length) addInput(pieces.join('/'))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const input of result.inputs) {
      const reason = privateReason(input)
      if (reason) result.reasons.add(`${reason} (${path} -> ${input})`)
    }
    for (const specifier of result.imports) {
      // Vite query suffixes do not change which source must be exported.
      const input = repoPath(specifier.split(/[?#]/)[0], path)
      if (!input) continue
      const reason = privateReason(input)
      if (reason) { result.reasons.add(`${reason} (${path} imports ${specifier} -> ${input})`); continue }
      const base = input.replace(/\.[cm]?js$/, '')
      const candidates = [input, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${input}.mjs`, `${input}.js`, `${input}/index.ts`, `${input}/index.tsx`]
      // Resolve the source before checking privacy. In an export the private
      // source is absent; still check its resolved extension against the manifest.
      const dependency = candidates.find(candidate => existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile())
        ?? candidates.find(candidate => privateReason(candidate))
      if (dependency) {
        const reason = privateReason(dependency)
        if (reason) result.reasons.add(`${reason} (${path} imports ${specifier} -> ${dependency})`)
        else result.dependencies.add(dependency)
      }
    }
    return result
  }
  const reasonsFor = test => {
    const reasons = new Set()
    if (Object.hasOwn(publicRunExceptions, test)) reasons.add(publicRunExceptions[test])
    const visited = new Set()
    const visit = path => {
      if (visited.has(path)) return
      visited.add(path)
      const ownReason = privateReason(path)
      if (ownReason) { reasons.add(`${ownReason} (${path})`); return }
      const description = describe(path)
      for (const reason of description.reasons) reasons.add(reason)
      // TS permits .js specifiers for .ts sources. Cache resolution once per
      // helper: thousands of tests share the same production import graph.
      for (const dependency of description.dependencies) visit(dependency)
    }
    visit(test)
    return [...reasons].sort()
  }
  const kept = []
  const excluded = []
  // Release CLI checks run as exported Vitest tests, so public CI runs them
  // through this list too. wikiMatchesHelp.wo2541.test.ts invokes
  // help-to-wiki.mjs --check for both generated prose and exact picture bytes.
  for (const path of discoverTests(root)) {
    const reasons = reasonsFor(path)
    if (reasons.length) excluded.push({ path, reasons })
    else kept.push(path)
  }
  return { kept, excluded }
}

export function printPublicTestSummary(list, log = console.log) {
  const count = prefix => list.excluded.filter(entry => entry.reasons.some(reason => reason.startsWith(prefix))).length
  log(`public tests: kept ${list.kept.length}, left out ${list.excluded.length} (evidence read ${count('evidence read')}, harness ${count('harness')}, manifest private-only ${count('manifest private-only')}, platform-only ${count('platform-only')}, desktop runtime ${count('desktop runtime')}; reasons can overlap)`)
}

if (isMain(import.meta.url)) {
  const list = buildPublicTestList()
  printPublicTestSummary(list)
  for (const path of list.kept) console.log(`KEEP ${path}`)
  for (const entry of list.excluded) console.log(`DROP ${entry.path}: ${entry.reasons.join('; ')}`)
}
