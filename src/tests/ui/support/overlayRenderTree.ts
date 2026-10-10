// WO UI-70-R1 (audit BLOCKER: "A1's closed-domain law is not implemented ...
// neither derives the floating-surface membership from the CAM/workbench React
// render trees ... a new HUD can reuse an existing positioned class and evade
// the gate entirely").
//
// This module derives the overlay domain from the RENDER TREE SOURCE. It is a
// parse-only TypeScript compiler-API walk that starts at the app's real render
// roots and follows every component reference it can resolve, classifying each
// JSX element that renders as a FLOATING SURFACE (absolute/fixed) by whichever
// route it is positioned: an app.css class, an inline style, a portal body, or
// a `className` this scanner cannot statically resolve (reported as
// INDETERMINATE and dispositioned by hand rather than assumed harmless).
//
// The identity a disposition is keyed by is the SITE THAT AUTHORS THE DOM --
// `<file>:<Component> > <tag>.<classes>` -- not a selector and not a file. That
// is the whole point of the bounce: the auditor's bypass (a new
// `<div className="sketch-prompt-bar">` rendered next to <ViewportOverlay>)
// reuses a class that IS dispositioned, but it authors DOM at a site that is
// NOT, so it lands as a brand-new key and fails by name. See
// src/tests/ui/fixtures/overlayBypass.fixture.tsx for that exact bypass, wired
// as a committed regression fixture.
//
// Parse-only (ts.createSourceFile per file + hand module resolution), never a
// full ts.Program: the walk must run inside a vitest slice in seconds, and it
// needs no type information -- every question it asks is syntactic.
import ts from 'typescript'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// app.css: which classes carry position:absolute|fixed
// ---------------------------------------------------------------------------

/** Comments are prose, not declarations. Stripping them in place (blanking the
 *  non-newline characters) keeps every reported line number pointing at the
 *  real source line -- and stops the scanner reading an app.css comment that
 *  says "with `position:fixed`" as a positioned rule (a false positive this
 *  census's own first run produced in UI-70 round 0). */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(?<![:\w])\/\/.*$/gm, '')
}

export interface PositionedClass {
  /** app.css line of the rule that positions it. */
  line: number
  /** `fixed` matters on its own: a fixed surface floats over the viewport from
   *  ANYWHERE in the tree, so it joins the domain even when it is authored
   *  outside a viewport host (SetupModal's `.vertex-pick-banner` is the live
   *  example -- a modal file rendering a real in-viewport banner). */
  positions: Set<string>
}

/** The position values that make an element a floating surface.
 *
 *  `absolute|fixed` is what the STATIC census has always scanned for, and it is
 *  the default so that census's domain is unchanged. The RUNTIME census
 *  (UI-70-R2, amendment A4) also passes `sticky`: "Every element whose computed
 *  or inline position is absolute, fixed, or sticky is in-domain wherever it is
 *  authored". That is not a hypothetical widening -- the runtime census's first
 *  workbench mount immediately found four live `position: sticky` surfaces that
 *  no static round had ever scanned for, because `sticky` was not in this
 *  regex. A whole position value was outside the domain and nothing said so. */
export const DEFAULT_POSITION_VALUES = ['absolute', 'fixed'] as const

/** Every class name whose own rule block declares one of `positionValues`.
 *  Keyed by class name (not selector) because the render walk knows an
 *  element's classes, never its selector. A rule like
 *  `.viewport-dropzone-active::after` counts: an element carrying that class
 *  hosts a floating pseudo-element, so the surface is real. */
export function positionedClasses(
  rawCss: string,
  positionValues: readonly string[] = DEFAULT_POSITION_VALUES,
): Map<string, PositionedClass> {
  const lines = stripComments(rawCss).split(/\r?\n/)
  const found = new Map<string, PositionedClass>()
  const pattern = new RegExp(`position:\\s*(${positionValues.join('|')})\\s*;`)
  let selector = ''
  let selectorLine = 0
  lines.forEach((raw, i) => {
    const openIdx = raw.indexOf('{')
    if (openIdx !== -1 && /^\s*[.#a-zA-Z[]/.test(raw)) {
      selector = raw.slice(0, openIdx).trim()
      selectorLine = i + 1
    }
    const m = pattern.exec(raw)
    if (m !== null && selector !== '') {
      for (const cm of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
        const prior = found.get(cm[1])
        if (prior === undefined) found.set(cm[1], { line: selectorLine, positions: new Set([m[1]]) })
        else prior.positions.add(m[1])
      }
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export type SurfaceRoute =
  /** The element's own inline style sets position:absolute|fixed. */
  | 'inline-position'
  /** The element carries a class that app.css positions absolute|fixed. */
  | 'positioned-class'
  /** The element is the body of a createPortal() call -- it escapes its parent
   *  stacking context entirely, so it floats regardless of how it is styled. */
  | 'portal-body'
  /** The scanner could NOT statically resolve this element's className or
   *  style, so it cannot prove the element is not a floating surface. Reported
   *  and dispositioned by hand -- never assumed harmless. */
  | 'indeterminate'

export interface Surface {
  /** `<relpath>:<Component> > <tag>.<class>.<class>` (+ `#n` when the same
   *  component authors the same shape more than once). THE disposition key. */
  key: string
  file: string
  component: string
  tag: string
  classes: string[]
  line: number
  /** 1-based column of the element's `<`. Paired with `line` and `file` it is
   *  THE JSX authoring site, and it is what the UI-70-R2 RUNTIME census keys on:
   *  React's own `fiber._debugStack` reports the same file:line:column for the
   *  element it created, so a live DOM node resolves back to exactly one
   *  authoring key -- including the `#2` ordinals, which a component-name key
   *  cannot tell apart (both banners are `ViewportOverlay > div.viewport-mode-banner`). */
  column: number
  route: SurfaceRoute
  detail: string
  /** True when this surface floats over a viewport: either it is authored
   *  inside a viewport host's element subtree (or inside a component reached
   *  from one), or it is position:fixed and therefore paints over the viewport
   *  from wherever it is authored. Only these need a disposition -- an
   *  absolutely-positioned widget inside a modal form is mechanically excluded,
   *  not hand-waved out. */
  inViewport: boolean
  /** Why inViewport is true/false, in the census output. */
  domainReason: string
}

export interface WalkResult {
  surfaces: Surface[]
  /** `<relpath>:<Component>` for every component body the walk entered. */
  visited: string[]
  /** The viewport HOST elements the walk found, derived (never hand-listed):
   *  a JSX element with a direct `<canvas>` / `.viewport-canvas` child IS the
   *  container the 3D scene paints into, so anything floating inside it floats
   *  over the viewport by construction. */
  hosts: Array<{ file: string; component: string; line: number; tag: string }>
  /** `<relpath>:<Component>` of every component reachable from inside a host
   *  element's subtree -- the transitive in-viewport render tree. */
  viewportReachable: string[]
  /** JSX component references the walk could NOT resolve to a declaration --
   *  each one is a hole in the closure and must be dispositioned. */
  unresolved: Array<{ site: string; name: string; line: number; inViewport: boolean }>
  /** Bare module specifiers whose components the walk treats as non-authoring
   *  (they render no LienCNC surface). Each must be allowlisted. */
  externals: string[]
}

const EXT_ORDER = ['.tsx', '.ts', '/index.tsx', '/index.ts']

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  // `allowImportingTsExtensions` is on in tsconfig.app.json, so a specifier may
  // already carry its extension (`./App.tsx`).
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of EXT_ORDER) {
    const candidate = base + ext
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Symbolic evaluation of a `className` expression to the set of class strings
 *  it can produce. `complete` is false when any part of the expression is
 *  opaque to a parse-only scan (an identifier, a prop, a helper call) -- the
 *  caller must then treat the element as INDETERMINATE rather than clean.
 *
 *  A conditional's CONDITION is deliberately ignored: `hidden ? 'a' : 'b'`
 *  emits 'a' or 'b', never the identifier `hidden`, so the condition being
 *  opaque does not make the class set opaque. */
export function evalClassExpression(node: ts.Node): { classes: string[]; complete: boolean } {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { classes: splitClasses(node.text), complete: true }
  }
  if (ts.isJsxExpression(node)) {
    return node.expression === undefined ? { classes: [], complete: true } : evalClassExpression(node.expression)
  }
  if (ts.isParenthesizedExpression(node)) return evalClassExpression(node.expression)
  if (ts.isTemplateExpression(node)) {
    const parts = [splitClasses(node.head.text), ...node.templateSpans.map((s) => splitClasses(s.literal.text))]
    const spans = node.templateSpans.map((s) => evalClassExpression(s.expression))
    return {
      classes: [...parts.flat(), ...spans.flatMap((s) => s.classes)],
      complete: spans.every((s) => s.complete),
    }
  }
  if (ts.isConditionalExpression(node)) {
    const a = evalClassExpression(node.whenTrue)
    const b = evalClassExpression(node.whenFalse)
    return { classes: [...a.classes, ...b.classes], complete: a.complete && b.complete }
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    // `cond && 'cls'` emits the right side only; the left is a condition.
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return evalClassExpression(node.right)
    if (
      kind === ts.SyntaxKind.BarBarToken
      || kind === ts.SyntaxKind.QuestionQuestionToken
      || kind === ts.SyntaxKind.PlusToken
    ) {
      const a = evalClassExpression(node.left)
      const b = evalClassExpression(node.right)
      return { classes: [...a.classes, ...b.classes], complete: a.complete && b.complete }
    }
  }
  // An identifier, a prop, a helper call, a computed join: opaque.
  return { classes: [], complete: false }
}

function splitClasses(text: string): string[] {
  return text.split(/\s+/).filter((c) => c.length > 0)
}

/** The set of `position:` values an inline `style` expression can produce.
 *  `complete` is false when the scan cannot see the whole object (an identifier,
 *  a spread) and therefore cannot rule a position out. */
export function evalStylePosition(node: ts.Node): { values: string[]; complete: boolean } {
  if (ts.isJsxExpression(node)) {
    return node.expression === undefined ? { values: [], complete: true } : evalStylePosition(node.expression)
  }
  if (ts.isParenthesizedExpression(node)) return evalStylePosition(node.expression)
  if (ts.isConditionalExpression(node)) {
    const a = evalStylePosition(node.whenTrue)
    const b = evalStylePosition(node.whenFalse)
    return { values: [...a.values, ...b.values], complete: a.complete && b.complete }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const values: string[] = []
    let complete = true
    for (const prop of node.properties) {
      // `{...base}` can carry a position this scan cannot see.
      if (ts.isSpreadAssignment(prop)) { complete = false; continue }
      if (!ts.isPropertyAssignment(prop)) continue
      const name = prop.name
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
      if (key !== 'position') continue
      const value = prop.initializer
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) values.push(value.text)
      else {
        const nested = evalStylePosition(value)
        // A non-literal position value (`position: x ? 'absolute' : 'relative'`)
        // resolves through the conditional arm above; anything else is opaque.
        values.push(...nested.values)
        if (nested.values.length === 0) complete = false
      }
    }
    return { values, complete }
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    // `style={'position:absolute'}` is not valid React; nothing to read.
    return { values: [], complete: true }
  }
  return { values: [], complete: false }
}

function jsxAttributes(node: ts.JsxOpeningLikeElement): ts.JsxAttributes {
  return node.attributes
}

function findAttr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const attr of jsxAttributes(node).properties) {
    if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === name) return attr
  }
  return null
}

function hasSpreadAttr(node: ts.JsxOpeningLikeElement): boolean {
  return jsxAttributes(node).properties.some((p) => ts.isJsxSpreadAttribute(p))
}

interface FileInfo {
  sf: ts.SourceFile
  path: string
}

const parseCache = new Map<string, FileInfo>()

function parse(file: string): FileInfo {
  const cached = parseCache.get(file)
  if (cached !== undefined) return cached
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX)
  const info = { sf, path: file }
  parseCache.set(file, info)
  return info
}

/** Where a name declared in `file` actually lives: either here, or behind an
 *  import, a barrel re-export, or a `lazy(() => import('./x').then(m => ({default: m.Y})))`.
 *
 *  All three indirections are load-bearing in this tree and a walk that stops
 *  at any of them silently loses domain: App.tsx mounts the whole workbench
 *  through `lazy`, and `lib/sketch/sketcher/index.ts` re-exports SketcherOverlays
 *  -- the eight sketch overlays the WO names as seeds live behind that barrel. */
function resolveName(
  file: string,
  name: string,
  seen: Set<string> = new Set(),
): { file: string; name: string } | { external: string } | null {
  const guard = `${file}#${name}`
  if (seen.has(guard)) return null
  seen.add(guard)
  const { sf } = parse(file)
  const starExports: string[] = []
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause
      if (clause === undefined) continue
      const spec = stmt.moduleSpecifier.text
      if (clause.name !== undefined && clause.name.text === name) {
        const target = resolveModule(file, spec)
        return target === null ? { external: spec } : { file: target, name: 'default' }
      }
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text !== name) continue
          const target = resolveModule(file, spec)
          return target === null ? { external: spec } : { file: target, name: (el.propertyName ?? el.name).text }
        }
      }
    }
    // `export { SketcherOverlays } from './SketcherOverlays'` (barrel).
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text
      const clause = stmt.exportClause
      if (clause === undefined) { starExports.push(spec); continue }
      if (!ts.isNamedExports(clause)) continue
      for (const el of clause.elements) {
        if (el.name.text !== name) continue
        const target = resolveModule(file, spec)
        return target === null ? { external: spec } : { file: target, name: (el.propertyName ?? el.name).text }
      }
    }
  }
  // Declared locally?
  if (findDeclaration(sf, name) !== null) return { file, name }
  // `export * from './x'`: the name may live behind any of them.
  for (const spec of starExports) {
    const target = resolveModule(file, spec)
    if (target === null) continue
    const hit = resolveName(target, name, seen)
    if (hit !== null) return hit
  }
  return null
}

function findDeclaration(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (found !== null) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) { found = node; return }
    if (ts.isClassDeclaration(node) && node.name?.text === name) { found = node; return }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) { found = node; return }
    if (name === 'default' && ts.isExportAssignment(node)) { found = node; return }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  if (found === null && name === 'default') {
    // `export default function App() {}`
    ts.forEachChild(sf, (node) => {
      if (
        found === null
        && ts.isFunctionDeclaration(node)
        && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true
      ) found = node
    })
  }
  return found
}

/** `lazy(() => import('./x').then((m) => ({ default: m.Y })))` -> {file, name}. */
function resolveLazy(file: string, node: ts.Node): { file: string; name: string } | null {
  let spec: string | null = null
  let member: string | null = null
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0]
      if (arg !== undefined && ts.isStringLiteral(arg)) spec = arg.text
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'm') {
      member = n.name.text
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  if (spec === null) return null
  const target = resolveModule(file, spec)
  return target === null ? null : { file: target, name: member ?? 'default' }
}

export interface WalkOptions {
  /** Absolute path of src/. */
  srcRoot: string
  /** Render roots: `{ file, name }` of the components React actually mounts. */
  roots: Array<{ file: string; name: string }>
  /** Class -> its positioning rule, from positionedClasses(). */
  positioned: Map<string, PositionedClass>
  /** Files the walk must not enter (dev/demo routes are dispositioned at their
   *  reference site instead of dragging their whole subtree into the domain). */
  skipFiles?: string[]
  /** Which inline `position:` values count as floating. Must agree with the map
   *  passed as `positioned`; see DEFAULT_POSITION_VALUES for why the runtime
   *  census widens this to include `sticky`. */
  positionValues?: readonly string[]
}

export function walkRenderTree(options: WalkOptions): WalkResult {
  const { srcRoot, roots, positioned } = options
  const positionValues = options.positionValues ?? DEFAULT_POSITION_VALUES
  const skip = new Set((options.skipFiles ?? []).map((f) => path.resolve(srcRoot, f)))
  const surfaces: Array<Surface & { ownerId: string; underHost: boolean }> = []
  const visited = new Set<string>()
  const unresolvedRaw: Array<{ site: string; name: string; line: number; underHost: boolean }> = []
  const externals = new Set<string>()
  const keyCounts = new Map<string, number>()
  const hosts: Array<{ file: string; component: string; line: number; tag: string }> = []
  /** ownerId -> referenced componentIds (the render-tree edge set). */
  const edges = new Map<string, Set<string>>()
  /** componentIds referenced from INSIDE a viewport host's element subtree. */
  const hostSeeded = new Set<string>()

  const rel = (file: string): string => path.relative(srcRoot, file).split(path.sep).join('/')
  const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const columnOf = (sf: ts.SourceFile, node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).character + 1

  /** Aliases created by the barrel/lazy hops, so a surface's ownerId and the
   *  edge that reached it agree on one identity. */
  const forwardOf = new Map<string, string>()

  const enter = (file: string, name: string): void => {
    if (skip.has(file)) return
    const id = `${rel(file)}:${name}`
    if (visited.has(id)) return
    visited.add(id)
    const { sf } = parse(file)
    const decl = findDeclaration(sf, name)
    if (decl === null) {
      // The name is not declared here: this file re-exports it (a barrel) or
      // imports and re-exports it. Follow the forward, or the walk stops at the
      // barrel and silently loses everything behind it -- which is exactly what
      // hid the eight sketch overlays behind lib/sketch/sketcher/index.ts.
      const forwarded = resolveName(file, name)
      if (forwarded === null) { unresolvedRaw.push({ site: rel(file), name, line: 0, underHost: false }); return }
      if ('external' in forwarded) { externals.add(forwarded.external); return }
      if (forwarded.file === file && forwarded.name === name) {
        unresolvedRaw.push({ site: rel(file), name, line: 0, underHost: false })
        return
      }
      forwardOf.set(id, `${rel(forwarded.file)}:${forwarded.name}`)
      enter(forwarded.file, forwarded.name)
      return
    }
    // `const X = lazy(() => import('./y'))` authors no DOM of its own; the walk
    // must continue into the lazily-imported component or the domain stops at
    // the Suspense boundary.
    if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
      const lazyTarget = resolveLazy(file, decl.initializer)
      if (lazyTarget !== null) {
        forwardOf.set(id, `${rel(lazyTarget.file)}:${lazyTarget.name}`)
        enter(lazyTarget.file, lazyTarget.name)
        return
      }
    }
    walkBody(file, name, sf, decl)
  }

  /** THE viewport-host rule, derived rather than hand-listed: an element is a
   *  viewport host when one of its DIRECT children is the element the 3D scene
   *  paints into -- a `<canvas>`, or the `.viewport-canvas` div CAM's renderer
   *  mounts into. Everything floating inside such a host floats over a
   *  viewport by construction, which is the parent WO's domain law stated
   *  structurally instead of as a list someone must remember to update.
   *
   *  MC-TIER1 (2026-08-05): a host may also mount its renderer IMPERATIVELY, so
   *  there is no authored canvas to see. ProgramPreview does exactly that - it
   *  constructs a CNCViewport against a ref and THREE appends the canvas at
   *  runtime. Such a host declares itself with `data-viewport-host`, which keeps
   *  this rule structural (still read off the JSX) instead of reintroducing the
   *  hand-maintained list the rule exists to avoid. */
  const isViewportHost = (element: ts.JsxElement): boolean =>
    findAttr(element.openingElement, 'data-viewport-host') !== null ||
    element.children.some((child) => {
      const open = ts.isJsxElement(child) ? child.openingElement : ts.isJsxSelfClosingElement(child) ? child : null
      if (open === null) return false
      const tag = open.tagName.getText()
      if (tag === 'canvas') return true
      if (tag !== 'div') return false
      const cn = findAttr(open, 'className')
      return cn?.initializer !== undefined && evalClassExpression(cn.initializer).classes.includes('viewport-canvas')
    })

  const walkBody = (file: string, component: string, sf: ts.SourceFile, decl: ts.Node): void => {
    const visitAttrs = (el: ts.JsxOpeningLikeElement, underHost: boolean): void => {
      for (const prop of el.attributes.properties) visit(prop, underHost)
    }
    const visit = (node: ts.Node, underHost: boolean): void => {
      if (ts.isJsxElement(node)) {
        handleElement(file, component, sf, node.openingElement, underHost)
        visitAttrs(node.openingElement, underHost)
        const childHost = underHost || isViewportHost(node)
        if (childHost && !underHost) {
          hosts.push({
            file: rel(file),
            component,
            line: lineOf(sf, node.openingElement),
            tag: node.openingElement.tagName.getText(sf),
          })
        }
        for (const child of node.children) visit(child, childHost)
        return
      }
      if (ts.isJsxSelfClosingElement(node)) {
        handleElement(file, component, sf, node, underHost)
        visitAttrs(node, underHost)
        return
      }
      ts.forEachChild(node, (child) => visit(child, underHost))
    }
    ts.forEachChild(decl, (child) => visit(child, false))
  }

  const handleElement = (
    file: string,
    component: string,
    sf: ts.SourceFile,
    node: ts.JsxOpeningLikeElement,
    underHost: boolean,
  ): void => {
    const ownerId = `${rel(file)}:${component}`
    const tagNode = node.tagName
    const tag = tagNode.getText(sf)
    const isIntrinsic = ts.isIdentifier(tagNode) && /^[a-z]/.test(tag)
    if (!isIntrinsic) {
      // A component reference: follow it. `<Foo.Bar/>`, `<props.As/>` and the
      // like cannot be followed by a parse-only scan and are reported.
      if (!ts.isIdentifier(tagNode)) {
        unresolvedRaw.push({ site: ownerId, name: tag, line: lineOf(sf, node), underHost })
        return
      }
      if (tag === 'Fragment' || tag === 'Suspense' || tag === 'StrictMode') return
      const target = resolveName(file, tag)
      if (target === null) {
        unresolvedRaw.push({ site: ownerId, name: tag, line: lineOf(sf, node), underHost })
        return
      }
      if ('external' in target) { externals.add(target.external); return }
      const targetId = `${rel(target.file)}:${target.name}`
      const out = edges.get(ownerId) ?? new Set<string>()
      out.add(targetId)
      edges.set(ownerId, out)
      if (underHost) hostSeeded.add(targetId)
      enter(target.file, target.name)
      return
    }

    // ---- an intrinsic element: is it a floating surface? -------------------
    const classAttr = findAttr(node, 'className')
    const styleAttr = findAttr(node, 'style')
    const cls = classAttr?.initializer === undefined
      ? { classes: [] as string[], complete: true }
      : evalClassExpression(classAttr.initializer)
    const pos = styleAttr?.initializer === undefined
      ? { values: [] as string[], complete: true }
      : evalStylePosition(styleAttr.initializer)

    const positionedHit = [...new Set(cls.classes)].filter((c) => positioned.has(c))
    const inlineHit = pos.values.filter((v) => positionValues.includes(v))
    const portal = isPortalBody(node)
    // `{...rest}` can carry BOTH className and style past this scan.
    const opaque = !cls.complete || !pos.complete || hasSpreadAttr(node)

    let route: SurfaceRoute | null = null
    let detail = ''
    if (inlineHit.length > 0) {
      route = 'inline-position'
      detail = `inline style position:${[...new Set(inlineHit)].join('|')}`
    } else if (positionedHit.length > 0) {
      route = 'positioned-class'
      detail = positionedHit.map((c) => `.${c} (app.css:${positioned.get(c)?.line}, ${[...(positioned.get(c)?.positions ?? [])].join('|')})`).join(', ')
    } else if (portal) {
      route = 'portal-body'
      detail = 'createPortal body -- escapes the parent stacking context'
    } else if (opaque) {
      route = 'indeterminate'
      detail = [
        !cls.complete ? 'className not statically resolvable' : '',
        !pos.complete ? 'style not statically resolvable' : '',
        hasSpreadAttr(node) ? 'spread attributes may carry className/style' : '',
      ].filter((s) => s !== '').join('; ')
    }
    if (route === null) return

    const shape = `${ownerId} > ${tag}${[...new Set(cls.classes)].sort().map((c) => `.${c}`).join('')}`
    const n = (keyCounts.get(shape) ?? 0) + 1
    keyCounts.set(shape, n)
    // A fixed surface paints over the viewport from wherever it is authored --
    // it is in the domain even outside a host subtree. This is not theory:
    // SetupModal.tsx authors `.vertex-pick-banner` and NewOperationModal.tsx
    // authors `.loop-pick-banner`, both real in-viewport banners rendered from
    // modal files.
    const fixed = inlineHit.includes('fixed')
      || positionedHit.some((c) => positioned.get(c)?.positions.has('fixed') === true)
    surfaces.push({
      key: n === 1 ? shape : `${shape}#${n}`,
      file: rel(file),
      component,
      tag,
      classes: [...new Set(cls.classes)].sort(),
      line: lineOf(sf, node),
      column: columnOf(sf, node),
      route,
      detail,
      ownerId,
      underHost,
      inViewport: fixed || underHost,
      domainReason: fixed
        ? 'position:fixed -- paints over the viewport from anywhere in the tree'
        : underHost ? 'authored inside a viewport host element subtree' : '',
    })
  }

  const isPortalBody = (node: ts.JsxOpeningLikeElement): boolean => {
    // The element is the first argument of a createPortal(...) call.
    const element = node.parent
    const call = ts.isJsxElement(element) || ts.isJsxSelfClosingElement(element) ? element.parent : undefined
    if (call === undefined || !ts.isCallExpression(call)) return false
    const callee = call.expression.getText()
    return /(^|\.)createPortal$/.test(callee) && call.arguments[0] === element
  }

  for (const root of roots) enter(path.resolve(srcRoot, root.file), root.name)

  // Transitive closure: every component reachable from a host subtree renders
  // inside the viewport, however deep. Barrel/lazy hops are followed through
  // `forwardOf` so an alias cannot break the chain.
  const viewportReachable = new Set<string>()
  const queue = [...hostSeeded]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (viewportReachable.has(id)) continue
    viewportReachable.add(id)
    const forwarded = forwardOf.get(id)
    if (forwarded !== undefined) queue.push(forwarded)
    for (const next of edges.get(id) ?? []) queue.push(next)
  }

  for (const s of surfaces) {
    if (s.inViewport) continue
    if (!viewportReachable.has(s.ownerId)) continue
    s.inViewport = true
    s.domainReason = 'authored by a component rendered inside a viewport host subtree'
  }

  return {
    surfaces: surfaces
      .map(({ ownerId: _ownerId, underHost: _underHost, ...s }) => s)
      .sort((a, b) => a.key.localeCompare(b.key)),
    visited: [...visited].sort(),
    hosts: hosts.sort((a, b) => `${a.file}${a.line}`.localeCompare(`${b.file}${b.line}`)),
    viewportReachable: [...viewportReachable].sort(),
    unresolved: unresolvedRaw
      .map((u) => ({ ...u, inViewport: u.underHost || viewportReachable.has(u.site) }))
      .map(({ underHost: _underHost, ...u }) => u)
      .sort((a, b) => `${a.site}${a.name}${a.line}`.localeCompare(`${b.site}${b.name}${b.line}`)),
    externals: [...externals].sort(),
  }
}

// ---------------------------------------------------------------------------
// Derivation D: imperative DOM append sites
// ---------------------------------------------------------------------------

export interface ImperativeSurface {
  key: string
  file: string
  className: string
  line: number
}

/** Overlays built with document.createElement + `el.className = '...'` rather
 *  than JSX. The audit named these explicitly ("including imperative DOM append
 *  sites") -- CNCViewport.ts appends BOTH plane overlays into the live viewport
 *  container this way, where no React walk can ever see them. */
export function imperativeSurfaces(files: string[], srcRoot: string, positioned: Map<string, PositionedClass>): ImperativeSurface[] {
  const out: ImperativeSurface[] = []
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'))
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\.className\s*=\s*['"`]([^'"`]+)['"`]/g)) {
        for (const cls of splitClasses(m[1])) {
          if (!positioned.has(cls)) continue
          out.push({
            key: `${path.relative(srcRoot, file).split(path.sep).join('/')}:${cls}`,
            file: path.relative(srcRoot, file).split(path.sep).join('/'),
            className: cls,
            line: i + 1,
          })
        }
      }
      for (const m of line.matchAll(/classList\.add\(\s*['"`]([^'"`]+)['"`]/g)) {
        const cls = m[1]
        if (!positioned.has(cls)) continue
        out.push({
          key: `${path.relative(srcRoot, file).split(path.sep).join('/')}:${cls}`,
          file: path.relative(srcRoot, file).split(path.sep).join('/'),
          className: cls,
          line: i + 1,
        })
      }
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}
