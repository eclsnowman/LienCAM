import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  BACKED_UP_LOCAL_STORAGE_RECORDS,
  PERSISTED_USER_DATA_REGISTRY,
} from '../../store/persistedKeys'
import {
  createShopDataBackup,
  type LegacyStorage,
} from '../../store/userSpaceStorage'

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REGISTRY_FILE = 'store/persistedKeys.ts'
const ESCAPE_PROBE_FILE = resolve(SOURCE_ROOT, 'tests/evidence/WO-245/escapeProbe.ts')

const REQUIRED_KEYS = [
  'cnc-cam-project',
  'geo26.glowCandidate',
  'liencam-boot-preferences',
  'liencam-machine-actions',
  'liencam-probe-routine-library',
  'liencam-tool-table',
  'liencam-ui-prefs',
  'liencam-user-space-reset-pending--',
  // WO-2639: the WO-1505 unload journal is registered so it can save (never backed up).
  'liencam-user-space-unload-journal--',
  'liencam.machine.programPreviewGrid',
  'liencam.userPosts',
  'liencamStockRemovalBody',
  'model3d.appearance',
] as const

interface SourceFinding {
  file: string
  line: number
  sink: string
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'tests') return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

function sourceFileFor(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function persistenceSinks(source: string, file: string): SourceFinding[] {
  const sourceFile = sourceFileFor(source, file)
  const findings: SourceFinding[] = []
  const recorded = new Set<string>()
  const record = (node: ts.Node, sink: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const identity = `${line}:${node.getStart(sourceFile)}:${sink}`
    if (recorded.has(identity)) return
    recorded.add(identity)
    findings.push({ file, line, sink })
  }
  const isBrowserStorageName = (value: string): boolean =>
    value === 'localStorage' || value === 'sessionStorage'
  const isZustandMiddleware = (value: string): boolean =>
    value === 'zustand/middleware' || value.startsWith('zustand/middleware/')

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isBrowserStorageName(node.text)) {
      record(node, node.text)
    }

    if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
      && isBrowserStorageName(node.argumentExpression.text)
    ) {
      record(node.argumentExpression, node.argumentExpression.text)
    }

    if (
      ts.isBindingElement(node)
      && node.propertyName !== undefined
      && ts.isStringLiteralLike(node.propertyName)
      && isBrowserStorageName(node.propertyName.text)
    ) {
      record(node.propertyName, node.propertyName.text)
    }

    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isZustandMiddleware(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const importsPersist = named !== undefined && ts.isNamedImports(named)
        && named.elements.some((element) => (element.propertyName ?? element.name).text === 'persist')
      const exposesWholeModule = clause?.name !== undefined || (named !== undefined && ts.isNamespaceImport(named))
      if (importsPersist || exposesWholeModule || node.moduleSpecifier.text.endsWith('/persist')) {
        record(node, 'zustand persist')
      }
    }

    if (
      ts.isCallExpression(node)
      && node.arguments[0] !== undefined
      && ts.isStringLiteralLike(node.arguments[0])
      && isZustandMiddleware(node.arguments[0].text)
      && (
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
    ) {
      record(node, 'zustand middleware dynamic access')
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

function productionPersistenceSinks(): SourceFinding[] {
  const paths = sourceFiles(SOURCE_ROOT)
  if (existsSync(ESCAPE_PROBE_FILE)) paths.push(ESCAPE_PROBE_FILE)
  return paths.flatMap((path) => {
    const file = relative(SOURCE_ROOT, path).replaceAll('\\', '/')
    if (file === REGISTRY_FILE) return []
    return persistenceSinks(readFileSync(path, 'utf8'), file)
  })
}

function registeredKeyDuplicates(): SourceFinding[] {
  const registered = new Set<string>(
    Object.values(PERSISTED_USER_DATA_REGISTRY).map((definition) => definition.key),
  )
  return sourceFiles(SOURCE_ROOT).flatMap((path) => {
    const file = relative(SOURCE_ROOT, path).replaceAll('\\', '/')
    if (file === REGISTRY_FILE) return []
    const sourceFile = sourceFileFor(readFileSync(path, 'utf8'), file)
    const findings: SourceFinding[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && registered.has(node.text)) {
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          sink: node.text,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return findings
  })
}

class MemoryLegacyStorage implements LegacyStorage {
  readonly values = new Map<string, string>()

  getItem(name: string): string | null {
    return this.values.get(name) ?? null
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeItem(name: string): void {
    this.values.delete(name)
  }
}

describe('WO-245 persisted user-data registry boundary', () => {
  it('declares the complete confirmed key inventory once with metadata', () => {
    const definitions = Object.values(PERSISTED_USER_DATA_REGISTRY)
    const keys = definitions.map((definition) => definition.key)

    expect([...keys].sort()).toEqual([...REQUIRED_KEYS].sort())
    expect(new Set(keys).size).toBe(keys.length)
    expect(definitions.every((definition) => definition.holds.length > 0)).toBe(true)
  })

  // Full-suite-only red (censuses 2026-08-21/08-21b), reproduced ALONE with no
  // other test file involved by pinning system CPU with unrelated load: this
  // scan (a real ts.createSourceFile parse of every file under src/) is
  // synchronous, and Vitest's own withTimeout retroactively rejects a
  // synchronous handler once `now() - startTime >= timeout` even though no
  // event-loop interleaving ever occurred (@vitest/runner chunk-hooks.js
  // resolve()), so wall-clock contention alone -- not any leaked global or
  // cross-file state (this test never touches localStorage/zustand at
  // runtime, only source text on disk) -- can blow the unstated 5000ms
  // default. Same evidence-supported mechanism WO-136 already named for the
  // sibling whole-source-tree scan (loadCensusCam12's CAM-12-R3 case, fixed
  // there with an explicit 60_000ms timeout at
  // src/tests/store/loadCensusCam12.test.ts:544) -- matched here rather than
  // invented fresh.
  it('makes browser storage and zustand persist unreachable outside the registry', () => {
    const escaped = productionPersistenceSinks()
    const detail = escaped
      .map(({ file, line, sink }) => `${file}:${line} -> ${sink}`)
      .join('\n')

    expect(escaped, detail || 'all production persistence sinks are registry-owned').toEqual([])
  }, 60_000)

  it('recognizes direct, aliased, destructured, and non-literal-name escape shapes', () => {
    const probes = persistenceSinks([
      "import { persist as keep } from 'zustand/middleware'",
      "const ordinaryName = ['innocuous', 'store'].join('.')",
      'const direct = globalThis.localStorage',
      "const computed = window['sessionStorage']",
      'const { localStorage: ordinaryAlias } = globalThis',
      'keep(() => ({}), { name: ordinaryName })',
      'ordinaryAlias.setItem(ordinaryName, direct?.getItem(ordinaryName) ?? String(computed))',
    ].join('\n'), 'ordinaryNamesProbe.ts')

    expect(new Set(probes.map((probe) => probe.sink))).toEqual(new Set([
      'zustand persist',
      'localStorage',
      'sessionStorage',
    ]))
  })

  it('has no registered key literal duplicated outside the registry', () => {
    const duplicates = registeredKeyDuplicates()
    const detail = duplicates
      .map(({ file, line, sink }) => `${file}:${line} -> ${sink}`)
      .join('\n')

    expect(duplicates, detail || 'registered keys are declared only once').toEqual([])
  })

  it('backs up exactly the local records selected by the registry', async () => {
    const legacyStorage = new MemoryLegacyStorage()
    for (const definition of Object.values(PERSISTED_USER_DATA_REGISTRY)) {
      legacyStorage.setItem(definition.key, JSON.stringify({ state: {}, marker: definition.key }))
    }

    const backup = await createShopDataBackup({ durableStorage: null, legacyStorage })
    const bundle = JSON.parse(backup.text) as {
      content: { localRecords: Record<string, string> }
    }
    const expectedKeys = BACKED_UP_LOCAL_STORAGE_RECORDS.map((record) => record.key).sort()

    expect(Object.keys(bundle.content.localRecords).sort()).toEqual(expectedKeys)
    expect(expectedKeys).toEqual([
      PERSISTED_USER_DATA_REGISTRY.machineActions.key,
      PERSISTED_USER_DATA_REGISTRY.machineToolTable.key,
      PERSISTED_USER_DATA_REGISTRY.probeRoutines.key,
      PERSISTED_USER_DATA_REGISTRY.uiPreferences.key,
      PERSISTED_USER_DATA_REGISTRY.programPreviewGrid.key,
      PERSISTED_USER_DATA_REGISTRY.userPosts.key,
    ].sort())
  })
})
