// WO UI-57-R4 -- DISPATCH ROUTE derivation (the R3 audit's B1 BLOCKER).
//
// WHAT WENT WRONG IN R3, in the auditor's words: "the runtime census does not
// execute every named delta-producing dispatch route on an alias-carrying
// fixture. makeRevolve and makeSweep are exercised only with op:'newBody' ...
// while their separate add branches reach #applyToolBoolean at geom-engine.ts
// :1466 and :1799. ... The B1(b) cross-check then collapses coverage to a
// METHOD-NAME SET ..., so a genesis call to makeRevolve or makeSweep falsely
// certifies its unexecuted add route."
//
// Its proof: inserting a refusal in makeRevolve for op:'add' ONLY left the
// verdict-bearing census green at 45/45 with EXIT CODE: 0.
//
// THE DEFECT IS THE UNIT, NOT THE COVERAGE. `makeRevolve` is not one behaviour.
// `req.op === 'newBody'` mints a fresh body from #assignSweptFaceIds; every
// other value falls through to #applySweepBoolean -> #applyToolBoolean, which
// then picks fuse/cut/intersectWithHistory by that same `op`. Those are
// DIFFERENT PRODUCERS reached through the SAME METHOD NAME, and a census whose
// domain is names cannot tell them apart -- V8 reports one `makeRevolve`
// whichever branch ran. So the name census certified an add route no test had
// ever executed. Widening the recipe list would have fixed today's gap and
// left the class of gap wide open: the next `op`-shaped method ships the same
// hole on day one.
//
// SO THE DOMAIN IS DERIVED, AND IT IS ROUTES:
//
//   A route is (engine method, ONE dispatch discriminant pinned to ONE of its
//   declared literal values). A DISCRIMINANT is a request property whose type
//   is a union of >= 2 string literals AND which the method's own body compares
//   against a string literal -- an `if (req.op === 'newBody')`, a `switch
//   (req.kind)`. That is not a list of fields anyone maintains: it is read from
//   the checker (the values) and the AST (the comparison), so `op`, `kind`, and
//   whatever the next one is called all arrive by themselves.
//
// The literal set comes from the DECLARED TYPE, never from the comparisons, so
// a value the code handles only in an `else` (revolve's 'intersect' -- compared
// nowhere, dispatched all the same) is still a route that must be executed.
// Reading the branches to find the discriminant and the type to find its values
// is the whole trick: each half covers the other's blind spot.
//
// WHERE THIS SITS: this module derives the DOMAIN. aliasProducerRuntimeCensus
// .test.ts EXECUTES it and records, per route, the delta that route actually
// returned. A route observed by neither is RED by name -- which is what makes
// the auditor's revolve-add refusal impossible to ship green again (proven, not
// asserted: tools/mutation/ui57-heal-mutation.mjs target `r4-revolve-add-
// refusal` re-applies that exact mutation every mutation run).
import ts from 'typescript'
import { repoRelative, type AliasProgram } from './aliasProgramDerivation.ts'

/** One executable dispatch route through the engine's public surface. */
export interface DispatchRoute {
  /** `makeRevolve:op=add` -- the name a RED message must be readable by. */
  id: string
  /** The GeomEngine method. */
  method: string
  /** The request property that selects this route, or null when the method has
   *  no dispatch discriminant at all (one method, one route). */
  field: string | null
  /** The literal this route pins `field` to. */
  value: string | null
  file: string
  line: number
  /** Every literal the discriminant's DECLARED type admits -- context for a RED
   *  message, and the proof the value set came from the type. */
  siblings: string[]
  /** Where the body compares this discriminant, so a reader can go look. Empty
   *  for a route whose value the code handles only by falling through. */
  comparedAt: number[]
}

const routeId = (method: string, field: string | null, value: string | null): string =>
  field === null || value === null ? method : `${method}:${field}=${value}`

/** The route a CONCRETE request pins -- derived from the ACTUAL argument object
 *  at call time, never from a label a recipe claims. This is what makes the
 *  runtime census's driven-set an observation rather than an assertion. */
export function routesOfRequest(routes: readonly DispatchRoute[], method: string, req: unknown): string[] {
  const forMethod = routes.filter((r) => r.method === method)
  if (forMethod.length === 0) return []
  const hits: string[] = []
  for (const r of forMethod) {
    if (r.field === null) { hits.push(r.id); continue }
    const actual = (req as Record<string, unknown> | null | undefined)?.[r.field]
    if (typeof actual === 'string' && actual === r.value) hits.push(r.id)
  }
  return hits
}

/** Union members that are string literals; [] for anything else. A single
 *  string-literal type is NOT a discriminant -- there is nothing to dispatch on
 *  when only one value exists. */
function stringLiteralUnion(type: ts.Type): string[] {
  const parts = type.isUnion() ? type.types : [type]
  const values: string[] = []
  for (const p of parts) {
    // An OPTIONAL property's type includes undefined; it is not a value, and
    // dropping it would silently turn `op?: 'a' | 'b'` into a non-discriminant.
    if (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue
    if (!p.isStringLiteral()) return []
    values.push(p.value)
  }
  return values.length >= 2 ? values : []
}

/** Every `x.prop` compared against a string literal inside `body`, by property
 *  name -> the lines where it happens. Covers `===`/`!==` and `switch`/`case`,
 *  which are the two forms this engine actually dispatches with. */
function comparedProperties(body: ts.Node, sf: ts.SourceFile): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const note = (name: string, n: ts.Node): void => {
    const at = out.get(name) ?? []
    at.push(line(n))
    out.set(name, at)
  }
  ;(function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind
      if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        for (const [a, b] of [[node.left, node.right], [node.right, node.left]] as const) {
          if (ts.isPropertyAccessExpression(a) && ts.isStringLiteral(b)) note(a.name.text, node)
        }
      }
    }
    if (ts.isSwitchStatement(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text
      for (const cl of node.caseBlock.clauses) {
        if (ts.isCaseClause(cl) && ts.isStringLiteral(cl.expression)) note(name, cl)
      }
    }
    node.forEachChild(visit)
  })(body)
  return out
}

/**
 * The dispatch routes of `methodNames` on the GeomEngine class.
 *
 * A method with no discriminant contributes exactly one route (itself), so this
 * derivation is a strict WIDENING of the R3 method-name domain: nothing that was
 * censused stops being censused, and the methods that hid four behaviours behind
 * one name now declare all four.
 */
export function deriveDispatchRoutes(
  ap: AliasProgram,
  engineFile: string,
  methodNames: readonly string[],
): DispatchRoute[] {
  const sf = ap.program.getSourceFiles().find((f) => repoRelative(f.fileName) === engineFile)
  if (sf === undefined) {
    throw new Error(`deriveDispatchRoutes: ${engineFile} is not in the Program -- the route domain would be silently EMPTY, which is the fail-open case this derivation exists to close`)
  }
  const wanted = new Set(methodNames)
  const out: DispatchRoute[] = []
  const seenMethods = new Set<string>()

  ;(function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text) && node.body !== undefined) {
      const method = node.name.text
      // An overload's signatures have no body and are filtered above; a real
      // duplicate would double the domain, so it fails loud instead.
      if (seenMethods.has(method)) throw new Error(`deriveDispatchRoutes: ${method} is declared more than once with a body in ${engineFile}`)
      seenMethods.add(method)
      const file = repoRelative(sf.fileName)
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const compared = comparedProperties(node.body, sf)

      const discriminants: DispatchRoute[] = []
      for (const param of node.parameters) {
        const ptype = ap.checker.getTypeAtLocation(param)
        for (const prop of ap.checker.getPropertiesOfType(ptype)) {
          const at = compared.get(prop.getName())
          if (at === undefined) continue // the body never dispatches on it
          const values = stringLiteralUnion(ap.checker.getTypeOfSymbolAtLocation(prop, param))
          if (values.length === 0) continue
          for (const value of values) {
            discriminants.push({
              id: routeId(method, prop.getName(), value), method, field: prop.getName(), value,
              file, line, siblings: values, comparedAt: at,
            })
          }
        }
      }
      out.push(...(discriminants.length > 0
        ? discriminants
        : [{ id: routeId(method, null, null), method, field: null, value: null, file, line, siblings: [], comparedAt: [] }]))
    }
    node.forEachChild(visit)
  })(sf)

  const missing = [...wanted].filter((m) => !seenMethods.has(m))
  if (missing.length > 0) {
    throw new Error(
      `deriveDispatchRoutes: ${missing.length} method(s) the worker's Comlink surface exposes have NO declaration in ` +
      `${engineFile}: ${missing.join(', ')}. The route domain cannot be trusted while a delegated method cannot be found.`,
    )
  }
  return out
}
