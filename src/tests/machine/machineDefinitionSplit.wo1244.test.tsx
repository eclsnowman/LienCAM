import { readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const directory = resolve('src/components/machine/definition')
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const root = parse(resolve(directory, '../MachineDefinitionPanel.tsx'))
const sections = readdirSync(directory).filter(name => name.endsWith('.tsx')).map(name => parse(resolve(directory, name)))

describe('WO-1244 definition section ownership', () => {
  it('keeps record content, controller setup, and layout independently editable', () => {
    const imports = root.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text)
    for (const section of ['ControllerDefinitionSection', 'ControllerSetupSection', 'DefinitionNavigation', 'OverviewCards', 'MachineArea', 'SpindleArea', 'OutputsSection', 'ProbingArea', 'ControllerArea', 'AllSettingsTable']) {
      expect(imports).toContain(`./definition/${section}`)
    }
    const functions = root.statements.filter(ts.isFunctionDeclaration)
    // WO-3071 5cbd034755 adds the separately owned Linux setup surface.
    expect(functions.map(node => node.name?.text)).toEqual(['LinuxControllerNetworkSetup', 'MachineDefinitionPanel'])
    expect(root.text).not.toMatch(/\buse(?:State|Effect|LayoutEffect|SyncExternalStore)\(/)
  })

  it('has no runtime import cycle between the extracted sections', () => {
    const edges = new Map(sections.map(source => [basename(source.fileName, '.tsx'), source.statements
      .filter(ts.isImportDeclaration)
      .filter(node => !node.importClause?.isTypeOnly)
      .filter(node => {
        const bindings = node.importClause?.namedBindings
        return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(spec => !spec.isTypeOnly)
      })
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text)
      .filter(path => path.startsWith('./'))
      .map(path => path.slice(2))]))
    function walk(name: string, path: string[]) {
      expect(path, `Runtime import cycle through ${name}`).not.toContain(name)
      for (const next of edges.get(name) ?? []) walk(next, [...path, name])
    }
    for (const name of edges.keys()) walk(name, [])
  })

  it('preserves the public census and validation exports at the original entry point', () => {
    const exported = root.statements.filter(ts.isExportDeclaration).flatMap(node =>
      node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(spec => spec.name.text) : [])
    expect(exported).toEqual(expect.arrayContaining([
      'MachineDefinitionPanelProps', 'unmarkedControlsIn', 'doublyMarkedControlsIn', 'definitionProblemGroup',
    ]))
  })
})
