import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applySectionCapPairVisibility } from '../../components/model3d/sceneRuntime'
import {
  applyModeledBodyShadingToMaterial,
  captureMaterialBaseline,
} from '../../lib/viewport/displayModes'

const RUNTIME_PATH = join(process.cwd(), 'src', 'components', 'model3d', 'sceneRuntime.ts')
const WORKBENCH_PATH = join(process.cwd(), 'src', 'components', 'model3d', 'SolidsWorkbenchPage.tsx')
const FAKE_RUNTIME_PATH = join(process.cwd(), 'src', 'tests', 'model3d', 'fakeSceneRuntime.ts')

// WO-123: this census parses every product TS/TSX file. Under concurrent
// worker load it can legitimately cross Vitest's 5s default without changing
// its deterministic result, so keep the larger budget local to that census.
const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

interface ParameterFact {
  name: string
  type: string
  optional: boolean
  rest: boolean
  initialized: boolean
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function parameterFacts(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  file: ts.SourceFile,
): ParameterFact[] {
  return parameters.map((parameter) => ({
    name: parameter.name.getText(file),
    type: parameter.type?.getText(file) ?? '<inferred>',
    optional: parameter.questionToken !== undefined,
    rest: parameter.dotDotDotToken !== undefined,
    initialized: parameter.initializer !== undefined,
  }))
}

function sceneRuntimeMethodParameters(): ParameterFact[] {
  const file = parse(RUNTIME_PATH)
  const runtime = file.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'SceneRuntime',
  )
  if (runtime === undefined) throw new Error('SceneRuntime interface not found')

  const method = runtime.members.find(
    (member): member is ts.MethodSignature =>
      ts.isMethodSignature(member)
      && ts.isIdentifier(member.name)
      && member.name.text === 'setSectionableVisible',
  )
  if (method === undefined) throw new Error('SceneRuntime.setSectionableVisible not found')

  return parameterFacts(method.parameters, file)
}

function implementationParameters(path: string): ParameterFact[][] {
  const file = parse(path)
  const implementations: ParameterFact[][] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'setSectionableVisible'
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      implementations.push(parameterFacts(node.initializer.parameters, file))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return implementations
}

function sourceFiles(root: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) paths.push(...sourceFiles(path))
    else if (entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx'))) paths.push(path)
  }
  return paths
}

function productCallArguments(): Array<{ path: string; line: number; count: number }> {
  const calls: Array<{ path: string; line: number; count: number }> = []
  for (const path of sourceFiles(join(process.cwd(), 'src'))) {
    if (path.includes(`${join('src', 'tests')}`)) continue
    const file = parse(path)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'setSectionableVisible'
      ) {
        calls.push({
          path: path.slice(process.cwd().length + 1),
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          count: node.arguments.length,
        })
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
  }
  return calls
}

describe('UI-84-R1 frozen SceneRuntime contract', () => {
  it('keeps setSectionableVisible at exactly (mesh, visible)', () => {
    expect(sceneRuntimeMethodParameters()).toEqual([
      {
        name: 'mesh', type: 'THREE.Mesh', optional: false, rest: false, initialized: false,
      },
      {
        name: 'visible', type: 'boolean', optional: false, rest: false, initialized: false,
      },
    ])
  })

  it('keeps the production implementation, fake, and every product call at two arguments', () => {
    const expectedImplementation = [[
      {
        name: 'mesh', type: '<inferred>', optional: false, rest: false, initialized: false,
      },
      {
        name: 'visible', type: '<inferred>', optional: false, rest: false, initialized: false,
      },
    ]]
    expect(implementationParameters(RUNTIME_PATH)).toEqual(expectedImplementation)
    expect(implementationParameters(FAKE_RUNTIME_PATH)).toEqual(expectedImplementation)

    const calls = productCallArguments()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((call) => call.count !== 2)).toEqual([])
    expect(calls.some((call) => call.path.endsWith('SolidsWorkbenchPage.tsx'))).toBe(true)
    expect(parse(WORKBENCH_PATH).text.length).toBeGreaterThan(0)
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)
})

describe('UI-84-R1 production section-cap visibility', () => {
  it('hides the real helper pair for topology-only Unshaded and restores it afterward', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2)
    const material = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const pair = {
      back: new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()),
      front: new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()),
    }
    const baseline = captureMaterialBaseline(material)

    applyModeledBodyShadingToMaterial(material, baseline, 'translucent')
    applySectionCapPairVisibility(mesh, pair, true)
    expect([pair.back.visible, pair.front.visible]).toEqual([true, true])

    applyModeledBodyShadingToMaterial(material, baseline, 'unshaded')
    applySectionCapPairVisibility(mesh, pair, true)
    expect(material.opacity).toBe(0)
    expect([pair.back.visible, pair.front.visible]).toEqual([false, false])

    applyModeledBodyShadingToMaterial(material, baseline, 'translucent')
    applySectionCapPairVisibility(mesh, pair, true)
    expect(material.opacity).toBe(0.35)
    expect([pair.back.visible, pair.front.visible]).toEqual([true, true])
  })
})
