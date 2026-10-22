import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, dirname, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}
function imports(path: string, text = readFileSync(path, 'utf8')): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) found.push(arg.text)
      else found.push('<nonliteral-import>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
const pure = new Set(['src/types', 'src/lib/cam/types', 'src/lib/cam/heightIntent', 'src/lib/cam/stockCuttingRoles', 'src/lib/post/index', 'src/lib/geometry/coordinateFrames'])
// Posix form on every platform: Windows path.relative gives src\kernel\..., which never matched 'src/kernel/' (audit 10-17).
const rel = (path: string) => relative(root, path).split(sep).join('/')
const schemaAdapters = new Set(['adaptive3d', 'parallel3d', 'waterline3d', 'steepShallow3d', 'rest3d', 'pencil3d', 'scallop3d']
  .map(stem => `src/cam3d/integration/${stem}Operation.ts`))
const schemaModules = new Set(['src/kernel/parameterDefaults', 'src/kernel/parameterTypes', 'src/kernel/schema'])
// Reviewed geometry-facade edges (WO-2996, WO-2998): these engine files may import the
// facade index only, never a geometry submodule, the planners or any other kernel module.
const geometryFacadeConsumers = new Set(['src/lib/cam/contour2d.ts', 'src/cam3d/rough/cutRegion.ts'])
// Reviewed policy-record edge (WO-3018): the adaptive engine reads its numbers from the
// kernel's pure policy record and may import nothing else of the kernel.
const adaptivePolicyConsumer = (path: string) => rel(path).startsWith('src/lib/cam/adaptiveClearing2d/engine/')
function violations(path: string, text?: string): string[] {
  const kernel = rel(path).startsWith('src/kernel/')
  // WO-2905 owns the compatibility manifest; engines still cannot import planners.
  const schemaAdapter = schemaAdapters.has(rel(path))
  const registryExport = rel(path) === 'src/lib/cam/operationManifest.ts'
  // WO-2944: the toolpath worker is the old/new switch (dispatch, not an engine) and may reach the kernel directly.
  const kernelDispatch = rel(path) === 'src/lib/cam/toolpathWorker.ts'
  const geometryConsumer = geometryFacadeConsumers.has(rel(path))
  const policyConsumer = adaptivePolicyConsumer(path)
  return imports(path, text).filter(specifier => {
    const target = rel(resolve(dirname(path), specifier)).replace(/\.(ts|tsx)$/, '')
    return kernel
      ? !(specifier.startsWith('.') && (target.startsWith('src/kernel/') || pure.has(target)))
      : (target.startsWith('src/kernel/') && !kernelDispatch && !((registryExport && target === 'src/kernel/registry') || (schemaAdapter && schemaModules.has(target)) || (geometryConsumer && target === 'src/kernel/geometry') || (policyConsumer && target === 'src/kernel/ops/adaptive/policy'))) || /(?:^|\/)kernel\//.test(specifier) && !specifier.startsWith('.')
  })
}

describe('WO-2904 engine import boundary', () => {
  it('limits engine kernel imports to the manifest registry, granted adapter schema modules and the reviewed geometry-facade edges', () => {
    const paths = [...files(resolve('src/lib/cam')), ...files(resolve('src/cam3d'))]
    expect(paths.flatMap(path => violations(path).map(imported => `${relative(root, path)} -> ${imported}`))).toEqual([])
  })
  it('allows the kernel only explicit pure modules and its own files', () => {
    expect(files(resolve('src/kernel')).flatMap(path => violations(path))).toEqual([])
  })
  it('rejects a deliberate current-engine import (negative control)', () => {
    expect(violations(resolve('src/lib/cam/negative-control.ts'), "import '../../kernel/planning'"))
      .toEqual(['../../kernel/planning'])
    expect(violations(resolve('src/lib/cam/operationManifest.ts'), "export * from '../../kernel/registry'")).toEqual([])
    expect(violations(resolve('src/lib/cam/operationManifest.ts'), "export * from '../../kernel/planning'"))
      .toEqual(['../../kernel/planning'])
    expect(violations(resolve('src/lib/cam/negative-control.ts'), "import '../../kernel/registry'"))
      .toEqual(['../../kernel/registry'])
    expect(violations(resolve('src/cam3d/integration/parallel3dOperation.ts'), "export { readParallel3dParams } from '../../kernel/schema'" )).toEqual([])
    expect(violations(resolve('src/cam3d/integration/parallel3dOperation.ts'), "import '../../kernel/planning'" )).toEqual(['../../kernel/planning'])
    expect(violations(resolve('src/cam3d/integration/otherOperation.ts'), "import '../../kernel/schema'" )).toEqual(['../../kernel/schema'])
    expect(violations(resolve('src/lib/cam/contour2d.ts'), "import { createGeometryService } from '../../kernel/geometry'")).toEqual([])
    expect(violations(resolve('src/cam3d/rough/cutRegion.ts'), "import { cam3dAdapter } from '../../kernel/geometry'")).toEqual([])
    expect(violations(resolve('src/lib/cam/contour2d.ts'), "import { faceAdapter } from '../../kernel/geometry/adapters'"))
      .toEqual(['../../kernel/geometry/adapters'])
    expect(violations(resolve('src/lib/cam/contour2d.ts'), "import '../../kernel/planning'")).toEqual(['../../kernel/planning'])
    expect(violations(resolve('src/lib/cam/drill2d.ts'), "import '../../kernel/geometry'")).toEqual(['../../kernel/geometry'])
    expect(violations(resolve('src/cam3d/rough/emit.ts'), "import '../../kernel/geometry'")).toEqual(['../../kernel/geometry'])
    expect(violations(resolve('src/kernel/negative-control.ts'), "export * from '../store'"))
      .toEqual(['../store'])
  })
  it('allows the adaptive engine the policy record only (WO-3018)', () => {
    const engine = resolve('src/lib/cam/adaptiveClearing2d/engine/processFeature.ts')
    expect(violations(engine, "import { ADAPTIVE_POLICY } from '../../../../kernel/ops/adaptive/policy'")).toEqual([])
    expect(violations(engine, "import { createAdaptivePlanner } from '../../../../kernel/ops/adaptive'"))
      .toEqual(['../../../../kernel/ops/adaptive'])
    expect(violations(engine, "import '../../../../kernel/planning'")).toEqual(['../../../../kernel/planning'])
    expect(violations(resolve('src/lib/cam/pocket2d.ts'), "import '../../kernel/ops/adaptive/policy'"))
      .toEqual(['../../kernel/ops/adaptive/policy'])
    expect(violations(resolve('src/kernel/ops/adaptive/policy.ts'), "import '../../../lib/cam/adaptiveClearing2d/engine'"))
      .toEqual(['../../../lib/cam/adaptiveClearing2d/engine'])
  })
})

// WO-3020: the kernel heights service is called by no app path until a family switches (P6).
describe('WO-3020 kernel heights service has no app caller', () => {
  it('no file under src outside the service and src/tests imports src/kernel/heights', () => {
    const callers = files(resolve('src'))
      .filter(path => !rel(path).startsWith('src/kernel/heights/') && !rel(path).startsWith('src/tests/'))
      .flatMap(path => imports(path)
        .filter(specifier => specifier.startsWith('.') && rel(resolve(dirname(path), specifier)).startsWith('src/kernel/heights'))
        .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(callers).toEqual([])
    // Negative control: a store import of the service is seen.
    expect(imports(resolve('src/store/negative-control.ts'), "import { createHeightsService } from '../kernel/heights'")
      .filter(specifier => rel(resolve(resolve('src/store'), specifier)).startsWith('src/kernel/heights'))).toEqual(['../kernel/heights'])
  })
})
