#!/usr/bin/env node
/**
 * deriveSetupClosure.mjs - CAM-12-R3 mechanical dereference-closure extraction.
 *
 * WHY: the CAM-12 STOP ruling (coordination/DECISIONS.md, 2026-07-15) found that
 * three rounds of hand-derived "census" tables each missed a real dereferenced
 * Setup field (operations -> setup records -> setup.wcs), because a prose/hand
 * list is not mechanically tied to what the code actually reads. This script
 * builds a real ts.Program over src/ (the same tsconfig the app build uses) and
 * walks EVERY property access, element access, and destructuring pattern whose
 * receiver's CHECKER-RESOLVED type is Setup, WCS, Stock, or Operation (or an
 * array/union thereof). It requires no call-graph tracing: a helper's own
 * internal accesses on a WCS/Setup/Stock/Operation-typed parameter are picked up
 * directly at the helper's own source location, because the checker resolves the
 * parameter's declared type at that location regardless of caller.
 *
 * OUTPUT (stdout, JSON): { fieldPaths: string[], violations: Violation[] }
 *   fieldPaths  - every distinct "<TypeName>.<field>" path dereferenced anywhere
 *                 in src/, e.g. "Setup.wcs", "WCS.origin", "Operation.params".
 *   violations  - ElementAccessExpressions with a computed key that cannot be
 *                 resolved to a finite literal union on a tracked type
 *                 (Setup/WCS/Stock/Operation). Literal unions such as
 *                 `op[key]` where `key: 'status' | 'toolpathMoves'` are fully
 *                 enumerable and are recorded. Other computed keys remain a
 *                 named failure rather than being silently skipped (WO
 *                 CAM-12-R3 requirement 1's honesty rule).
 *
 * SCOPE: only Setup, WCS, Stock, Operation are tracked + recursed (the four
 * named types). Any other field type (Vec3, HeightParams, PassParams,
 * Record<string,unknown>, geometry/nests/tools/stocks/machine records, ...) is a
 * LEAF: the field path rooted at one of the four tracked types is recorded, but
 * the script does not recurse into ITS fields. This is a deliberate stopping
 * rule (CAM-12-R3 preflight "Scope boundary text"), not an omission - Vec3 in
 * particular is a leaf (finite-Vec3 is validated as a shape, never per-axis
 * recursed further) and non-Setup/WCS/Stock/Operation records are out of scope
 * for this WO even where a Setup consumer reaches them by id.
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const TRACKED_TYPE_NAMES = new Set(['Setup', 'WCS', 'Stock', 'Operation'])

function loadProgram() {
  const configPath = resolve(REPO_ROOT, 'tsconfig.app.json')
  const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'))
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  return program
}

/** Every distinct tracked-type name (Setup/WCS/Stock/Operation) a type
 *  resolves to DIRECTLY (as a plain object type, never an array of it),
 *  after stripping union members (undefined, null, other non-tracked
 *  constituents). Deliberately does NOT unwrap Array<T>/T[] - a property
 *  access on an ARRAY (e.g. `setup.operations.filter(...)`) reads a method of
 *  the ARRAY, not a field of the element type, and must never be recorded as
 *  one (that bug produced bogus paths like "Operation.filter"/"Setup.push" in
 *  an earlier draft of this script - array membership is walked separately,
 *  see `arrayElementTrackedTypeNames`). A type can resolve to more than one
 *  tracked name only in a union (e.g. `Setup | Operation`, which does not occur
 *  in this codebase but is handled honestly rather than assumed away). */
function trackedTypeNames(type) {
  const found = new Set()
  const visit = (t) => {
    if (t.isUnion()) {
      for (const sub of t.types) visit(sub)
      return
    }
    const sym = t.getSymbol()
    if (sym && TRACKED_TYPE_NAMES.has(sym.getName())) found.add(sym.getName())
  }
  visit(type)
  return found
}

function run() {
  const program = loadProgram()
  const checker = program.getTypeChecker()
  const fieldPaths = new Set()
  const violations = []

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (!sourceFile.fileName.includes('/src/') && !sourceFile.fileName.includes('\\src\\')) continue

    const typeAt = (expr) => {
      try {
        return checker.getTypeAtLocation(expr)
      } catch {
        return undefined
      }
    }

    const recordAccess = (receiverExpr, propName) => {
      const type = typeAt(receiverExpr)
      if (!type) return
      const names = trackedTypeNames(type)
      for (const typeName of names) fieldPaths.add(`${typeName}.${propName}`)
    }

    /**
     * Return every finite string/number literal represented by a computed key,
     * or undefined when even one constituent is wider than a literal. This
     * lets a `keyof Operation` or `as const` key union remain mechanically
     * visible while preserving the STOP ruling for arbitrary string indexes.
     */
    const finiteLiteralKeys = (expr) => {
      const type = typeAt(expr)
      if (!type) return undefined
      const keys = new Set()
      const visitKeyType = (t) => {
        if (t.isUnion()) return t.types.every(visitKeyType)
        if (t.isStringLiteral() || t.isNumberLiteral()) {
          keys.add(String(t.value))
          return true
        }
        return false
      }
      return visitKeyType(type) ? keys : undefined
    }

    const recordBindingElement = (containerExpr, element) => {
      // A rest element (`...rest`) captures "everything else", not one named
      // field - `{ toolpathMoves: _moves, ...op }` on an Operation must NOT be
      // recorded as a field literally called "op" (an earlier draft of this
      // script did exactly that, producing the bogus paths "Operation.op" and
      // "Operation.rest").
      if (element.dotDotDotToken) return
      const type = typeAt(containerExpr)
      if (!type) return
      const names = trackedTypeNames(type)
      if (names.size === 0) return
      const propName = element.propertyName
        ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined)
        : (ts.isIdentifier(element.name) ? element.name.text : undefined)
      if (!propName) return
      for (const typeName of names) fieldPaths.add(`${typeName}.${propName}`)
    }

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        // Direct-type check only (no array unwrap): `arr.filter(...)` where
        // arr: Operation[] must NOT be recorded as "Operation.filter" - that is
        // a method of the ARRAY, not a field of the element type.
        recordAccess(node.expression, node.name.text)
      } else if (ts.isElementAccessExpression(node)) {
        const receiverType = typeAt(node.expression)
        const directNames = receiverType ? trackedTypeNames(receiverType) : new Set()
        if (directNames.size === 0) {
          // Not a bracket access directly on a tracked object (ordinary array
          // indexing like `operations[i]` falls here even though the element
          // type is tracked - ordinary indexing is never a blind spot; the
          // element's own fields are captured by separate PropertyAccess nodes
          // on the result, e.g. `operations[i].toolpathMoves`).
        } else {
          const arg = node.argumentExpression
          const literalKeys = ts.isStringLiteralLike(arg)
            ? new Set([arg.text])
            : ts.isNumericLiteral(arg)
              ? new Set([arg.text])
              : finiteLiteralKeys(arg)
          if (literalKeys) {
            for (const literalKey of literalKeys) {
              for (const typeName of directNames) fieldPaths.add(`${typeName}.${literalKey}`)
            }
          } else {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
            violations.push({
              file: sourceFile.fileName.replace(REPO_ROOT, '').replace(/\\/g, '/'),
              line: line + 1,
              column: character + 1,
              types: [...directNames],
              text: node.getText(sourceFile).slice(0, 120),
            })
          }
        }
      } else if (ts.isObjectBindingPattern(node)) {
        // Container expression: a variable declaration's initializer, a
        // parameter's own declared type (no expression - use the pattern's
        // parent Parameter node's type via the checker on the pattern itself),
        // or a nested pattern's parent BindingElement.
        const parent = node.parent
        let containerExpr = null
        if (ts.isVariableDeclaration(parent) && parent.initializer) {
          containerExpr = parent.initializer
        } else {
          // Parameter destructuring or a nested BindingElement: the checker can
          // resolve the pattern node's own type directly (the type of the value
          // that will be destructured into it), so use the pattern itself as
          // the "container expression" for getTypeAtLocation purposes.
          containerExpr = node
        }
        for (const element of node.elements) {
          if (ts.isOmittedExpression(element)) continue
          recordBindingElement(containerExpr, element)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return { fieldPaths: [...fieldPaths].sort(), violations }
}

const result = run()
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (result.violations.length > 0) {
  process.exitCode = 1
}
