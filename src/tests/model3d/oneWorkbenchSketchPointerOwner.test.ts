// WO SKC-15C (S3): the workbench has EXACTLY ONE sketch draw machine, and it is not in
// src/components/model3d -- it is THE Sketcher package (src/lib/sketch/sketcher/**), reached through
// the mount. This scan is what keeps the severing severed.
//
// It is the model3d twin of src/tests/sketch/oneSketchPointerOwner.test.ts, which enforces the same
// property inside the CAM sketcher ecosystem. That file's own header dated the omission this file
// closes: "src/components/model3d/SolidsWorkbenchPage.tsx and src/sketch3d/** still own their own
// (doomed) 4-tool interaction layer and are therefore NOT in scope for this WO -- S3 mounts the
// component there and S5 deletes the remains, and the S3 WO extends ECOSYSTEM_ROOTS below to cover
// them." This is that extension, scoped to the model3d roots (the S3 severing target), leaving the
// CAM file frozen exactly as the parent WO required.
//
// THE CRITIC'S LAW (docs/3d/SKETCH-CRITIC-REPORT.md): "A guard of the form 'A imports from B' or 'X
// is defined once (by name)' is satisfiable while forking. Divergence is structurally hard only when
// there is no file in which a second version could be written." So this scan runs five independent
// nets over the same tree:
//
//   (a) BY NAME: no file under src/components/model3d may call the sketch3d draw-tool machine
//       (stepDrawTool), the grab-site resolver (pickGrabTarget), or the draw-tool predicate
//       (isSketch3dDrawTool). Those are the three functions the inline machine was built from; a
//       reintroduction cannot avoid at least one of them without reimplementing arc/line/grab math
//       from scratch (which the arc-atan2 scan in shareDoNotFork.test.ts would then catch).
//
//   (b) BY NAME: none of the BANNED_POINTER_STATE identifiers -- the fields and handlers the inline
//       machine held -- may appear. A name-based backstop, labelled as one.
//
//   (c) BY-NAME BACKSTOP: no pointer handler (raw addEventListener OR a JSX prop) anywhere under these
//       roots may drive one of the KNOWN sketch gesture verbs. This is a third by-name net, kept as a
//       backstop -- but it is NOT the structural teeth. (WO SKC-15C-R1, S3 gate MAJOR 2: the S3 gate
//       audit proved this net evadable -- a page machine renamed to `advanceInlineSketch` calling
//       generic `projectToPlane`/`appendSegment`, or a raw `pointerleave`/`pointercancel` owner, slid
//       past it, because it recognizes only legacy names and only pointerdown/move/up/dblclick/context.)
//
//   (d) STRUCTURAL BINDING BOUNDARY, name-free (WO SKC-15C-R1): this is the net with real teeth. It
//       AST-parses the SEVERING TARGET -- SolidsWorkbenchPage.tsx and its `workbench/**` mount helpers,
//       the only place a workbench second-owner could physically live -- and enforces the ownership at
//       the BINDING, not at what the handler calls: on the page's <canvas>, the ONLY permitted pointer/
//       mouse event bindings are `onClick` (pick modes) and `onPointerMove` (the idle measure/appearance
//       hover); ANY `onPointerDown`/`onPointerUp`/`onPointerLeave`/`onPointerCancel` (or mousedown/up,
//       dblclick, contextmenu) JSX prop, and ANY raw `addEventListener` for those events, is a second
//       sketch pointer owner BY CONSTRUCTION -- it does not matter what it is named or what it calls,
//       because a draw gesture cannot begin without a down/up it is now forbidden to bind. The package's
//       SketchInteraction.attach() owns those natively, from inside src/lib/sketch/sketcher (out of this
//       tree), so the severing holds regardless of any rename.
//
//   (e) PROJECT CAPABILITY PLACEMENT (WO SKC-26B-R2): the primary proof is the real-page runtime
//       command-boundary test. This smaller secondary net scans every model3d production source,
//       independent of JSX/render shape, and confines Project resolve/build/append/click capability
//       to one direct bindDeps adapter and one document-port forwarder.
//
// Comments are stripped before every by-name scan (the severed page's header comments NAME the deleted
// functions on purpose -- that documentation must not read as a call site). Net (d) parses the AST, so
// commented-out code is not a binding and never trips it. Non-vacuity is proved by committed fixtures of
// the REAL deleted shapes (the inline draw-click and grab-drag) AND, for net (d), the auditor's own
// evasions: a RENAMED-verb pointerdown owner and raw pointerleave/pointercancel owners -- each must trip
// (d); the real measure/appearance hover path must not.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const SRC_ROOT = join(__dirname, '..', '..')

/**
 * Canonical production sources for the Project / Use capability. The gate below derives callable
 * names from these files instead of carrying a second, hand-maintained verb list that can drift as
 * soon as a resolver or commit sibling is added.
 */
const PROJECT_USE_SOURCE = join(SRC_ROOT, 'lib', 'sketch', 'projectUse.ts')
const PROJECT_GEOMETRY_SOURCE = join(SRC_ROOT, 'components', 'model3d', 'workbench', 'projectGeometry.ts')
const PROJECT_CONTROLLER_SOURCE = join(SRC_ROOT, 'lib', 'sketch', 'sketcher', 'toolController.ts')
const PROJECT_SKETCHER_INDEX_SOURCE = join(SRC_ROOT, 'lib', 'sketch', 'sketcher', 'index.ts')
const PROJECT_SKETCHER_PORTS_SOURCE = join(SRC_ROOT, 'lib', 'sketch', 'sketcher', 'ports.ts')
const PROJECT_PAGE_SOURCE = join(SRC_ROOT, 'components', 'model3d', 'SolidsWorkbenchPage.tsx')
const PROJECT_SESSION_STORE_SOURCE = join(
  SRC_ROOT, 'components', 'model3d', 'workbench', 'sketchSessionStore.ts',
)
const PROJECT_DOCUMENT_PORT_SOURCE = join(
  SRC_ROOT, 'components', 'model3d', 'workbench', 'workbenchSketchDocumentPort.ts',
)

// These mutation cases reparse the full model3d production source set. They take about 1.3s
// directly, but need explicit headroom when a repository campaign contends for CPU.
const PROJECT_CAPABILITY_MUTATION_TIMEOUT_MS = 15_000

// The severing target: the whole model3d component tree. `src/sketch3d/**` is deliberately NOT here
// -- that lane still owns the sketch3d MODEL, its regen executor and its lab page (Sketch3dLabPage),
// which legitimately run the inline machine as its ONE remaining consumer (shareDoNotFork.test.ts
// pins that). This scan is about the WORKBENCH not having a second one.
const ECOSYSTEM_ROOTS = [join(SRC_ROOT, 'components', 'model3d')]

const slash = (p: string) => p.split('\\').join('/')

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectTsFiles(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
}

function ecosystemFiles(): string[] {
  const files: string[] = []
  for (const root of ECOSYSTEM_ROOTS) if (existsSync(root)) collectTsFiles(root, files)
  // Production source only -- a test may legitimately reference these names in prose/fixtures (this
  // very file does). Same scope discipline as shareDoNotFork.test.ts.
  return files.filter((f) => !slash(f).includes('/tests/'))
}

/** Comments are prose, not capability. Same helper, same reason, as oneSketchPointerOwner.test.ts:104. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ---- (a) the three sketch3d draw-machine functions, BY NAME -----------------------------------

/** A CALL, not a mention: `stepDrawTool(` / `pickGrabTarget(` / `isSketch3dDrawTool(`. The `\b` and
 *  the trailing `\(` mean a comment saying "we used to call stepDrawTool" (no paren) does not trip
 *  it, and neither does `mystepDrawTool`. */
const BANNED_CALLS = [/\bstepDrawTool\s*\(/, /\bpickGrabTarget\s*\(/, /\bisSketch3dDrawTool\s*\(/]

// ---- (b) the inline machine's private pointer STATE, BY NAME ----------------------------------

/** Fields and handlers the deleted inline draw/select machine held. A reintroduction that keeps any
 *  of these names trips here even if net (c) somehow missed it. */
const BANNED_POINTER_STATE = [
  'handleSketchPointerDown', 'handleSketchPointerMove', 'handleSketchPointerUp',
  'handleSketchCanvasPointerDown', 'handleSketchCanvasPointerMove',
  'handleSketchDrawClick', 'finalizeSketchDrag', 'previewSketchEntity',
  'commitSketchDocumentMutation', 'updateSketchHoverHighlight',
  'sketchDragRef', 'sketchGrabArmRef', 'sketchHoverGrabTarget', 'sketchHoverLineRef',
  'sketchDraftPoints', 'setSketchTool',
]

// ---- (c) STRUCTURAL: a pointer handler that drives sketch draw/grab machinery -----------------

/** A pointer handler, raw OR JSX. The JSX recognizer is the one the pre-SKC-14 scans lacked. */
const RAW_HANDLER = /addEventListener\(\s*['"](?:pointerdown|pointermove|pointerup|dblclick|contextmenu)['"]/
const JSX_HANDLER = /\bon(?:PointerDown|PointerMove|PointerUp|ContextMenu|DoubleClick)\s*=/
/** ...that drives SKETCH DRAW/GRAB machinery. These verbs are what an inline sketch draw/select
 *  machine cannot avoid: it either steps the draw-tool state, resolves a grab target, translates the
 *  grabbed entity, previews it, or commits the document edit. The measure/appearance hover handler
 *  the page keeps drives NONE of them (it calls `measure.handlePointerMove` / `appearance.*`), so it
 *  is not a sketch pointer owner and does not trip this. */
const SKETCH_GESTURE = new RegExp(
  [
    'stepDrawTool\\(', 'pickGrabTarget\\(', 'isSketch3dDrawTool\\(',
    'translateEntity\\(', 'withPointAt\\(',
    'previewSketchEntity\\(', 'finalizeSketchDrag\\(', 'commitSketchDocumentMutation\\(',
    'handleSketchDrawClick\\(', 'handleSketchPointerDown\\(', 'handleSketchPointerMove\\(',
    'sketchDragRef', 'sketchGrabArmRef',
  ].join('|'),
)

function handlesSketchPointer(rawSrc: string): boolean {
  const src = stripComments(rawSrc)
  return (RAW_HANDLER.test(src) || JSX_HANDLER.test(src)) && SKETCH_GESTURE.test(src)
}

// ---- The REAL deleted shapes, verbatim (non-vacuity fixtures) ---------------------------------
//
// Copied out of SolidsWorkbenchPage.tsx as it stood at wo/SKC-15B (git show d35ce1f5:<file>), before
// this WO deleted them. If any pattern above is ever weakened, these go green and this file fails --
// the only way a capability scan proves it still has teeth.

/** The inline DRAW-CLICK handler: a JSX pointer path into `stepDrawTool` + `commitSketchDocumentMutation`. */
const FIXTURE_INLINE_DRAW_CLICK = `
  const handleSketchDrawClick = useCallback(
    (local: Sketch3dVec2): void => {
      if (sketchMode.kind !== 'editing' || !isSketch3dDrawTool(sketchTool)) return
      const nodeId = sketch3dNodeId(sketchMode.sketchId)
      const document = (dag.getNode(nodeId)!.payload as Sketch3dNodePayload).document
      const step = stepDrawTool(sketchTool, sketchDraftPoints, local, () => nextSketchEntityId(document, sketchTool))
      setSketchDraftPoints(step.draftPoints)
      if (step.entity === undefined) return
      void commitSketchDocumentMutation((doc) => ({ ...doc, entities: [...doc.entities, step.entity] }))
    },
    [sketchMode, sketchTool, sketchDraftPoints, dag, commitSketchDocumentMutation],
  )
  const jsx = <canvas onPointerDown={(e) => handleSketchCanvasPointerDown({ clientX: e.clientX, clientY: e.clientY })} />
`

/** The inline GRAB-DRAG handler: a JSX pointer path into `pickGrabTarget` + a drag ref + `translateEntity`. */
const FIXTURE_INLINE_GRAB_DRAG = `
  const handleSketchPointerMove = useCallback(
    (local: Sketch3dVec2): void => {
      const drag = sketchDragRef.current
      if (drag) { previewSketchEntity(translateEntity(drag.baseEntity, local.x, local.y)); return }
      const document = (dag.getNode(nodeId)!.payload as Sketch3dNodePayload).document
      const hoverTarget = pickGrabTarget(document, local)
      setSketchHoverGrabTarget(hoverTarget)
    },
    [],
  )
  const jsx = <canvas onPointerMove={(e) => handleSketchCanvasPointerMove({ clientX: e.clientX, clientY: e.clientY })} />
`

/** The measure/appearance hover handler the page KEEPS. It has a JSX pointer prop, but drives no
 *  sketch gesture -- it must stay legal, or the scan cries wolf and gets deleted. */
const FIXTURE_KEPT_MEASURE_HOVER = `
  const jsx = <canvas onPointerMove={(e) => {
    if (activeUi4Tool !== 'none' && sketchMode.kind === 'none') {
      const ray = computeUi4Ray(e.clientX, e.clientY)
      if (ray !== null) { if (activeUi4Tool === 'measure') measure.handlePointerMove(ray); else appearance.handlePointerMove(ray) }
    }
  }} />
`

// ---- (d) STRUCTURAL BINDING BOUNDARY: an AST net over the severing target ----------------------
//
// The severing target is the ONLY place a workbench second-owner could physically live: the page and
// its `workbench/**` mount helpers. Everything else under model3d (Lab3DView, UI4Demo, ...) is a
// SEPARATE consumer with its own legitimate pointer bindings and is deliberately out of this net's
// scope (nets a/b/c still cover the legacy verbs tree-wide).
const SEVERING_TARGET_SUBPATHS = ['/model3d/SolidsWorkbenchPage.tsx', '/model3d/workbench/']
const isSeveringTarget = (f: string): boolean => SEVERING_TARGET_SUBPATHS.some((s) => slash(f).includes(s))

/** The ONLY pointer/mouse event bindings the page's own canvas may carry. `onClick` is the pick-mode
 *  path (push/pull, dress-up, measure/appearance click, sketch-on-face pick); `onPointerMove` is the
 *  idle measure/appearance hover. A draw gesture cannot begin without a down/up -- both forbidden -- so
 *  this allowlist cannot host a sketch draw machine. */
const ALLOWED_CANVAS_EVENT_PROPS = new Set(['onClick', 'onPointerMove'])
/** A JSX prop is a pointer/mouse EVENT binding (as opposed to `style`, `ref`, `data-testid`, ...). */
const POINTER_MOUSE_EVENT_PROP = /^on(?:Pointer|Mouse)(?:Down|Up|Move|Enter|Leave|Over|Out|Cancel)$|^on(?:Click|DoubleClick|ContextMenu)$/
/** Raw `addEventListener` event types that can start/carry a gesture. `pointermove`/`mousemove`/`click`
 *  are absent -- the severing target has no raw hover/click owner (the hover is a JSX prop), and this
 *  set is the down/up/leave/cancel boundary the S3 gate audit named, plus the mouse + dbl/context peers. */
const FORBIDDEN_RAW_EVENTS = new Set([
  'pointerdown', 'pointerup', 'pointerleave', 'pointercancel',
  'mousedown', 'mouseup', 'dblclick', 'contextmenu',
])

/** AST-walk a source string and return every canvas pointer-ownership violation, by construction. */
function canvasPointerBindingViolations(src: string, label: string): string[] {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  const out: string[] = []

  const visit = (node: ts.Node): void => {
    // (d.1) ANY JSX element in the severing target: no forbidden pointer/mouse event prop.
    // S3 gate audit round 2 (opus): keying on tag === 'canvas' admitted the SAME renamed-verb
    // evasion relocated onto a wrapper element (pointerdown bubbles from the canvas to its
    // wrappers, so `<div onPointerDown={renamed}>` around the canvas is a working fork).
    // onClick + onPointerMove stay allowlisted EVERYWHERE (buttons use onClick; the measure/
    // appearance hover uses onPointerMove), so widening to every element adds no false positive.
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf)
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue
        const name = attr.name.getText(sf)
        if (POINTER_MOUSE_EVENT_PROP.test(name) && !ALLOWED_CANVAS_EVENT_PROPS.has(name)) {
          out.push(`${label}: <${tag}> binds ${name} (only ${[...ALLOWED_CANVAS_EVENT_PROPS].join('/')} allowed on any element in the severing target)`)
        }
      }
    }
    // (d.2) raw x.addEventListener('<forbidden>', ...): a second native owner, whatever the receiver.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener' &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const evt = node.arguments[0].text
      if (FORBIDDEN_RAW_EVENTS.has(evt)) {
        out.push(`${label}: addEventListener('${evt}', ...) -- a raw gesture-capable pointer owner`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ---- (e) SOURCE-DERIVED PROJECT CAPABILITY BOUNDARY -------------------------------------------

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  if (
    ts.isComputedPropertyName(name)
    && (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))
  ) return name.expression.text
  return null
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text
  }
  return null
}

/** Exported result types that structurally carry a named accept payload field. */
function exportedResultTypeNamesWithProperty(src: string, label: string, property: string): Set<string> {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  const containsProperty = (root: ts.Node): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isPropertySignature(node) && propertyNameText(node.name) === property) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }
  for (const statement of sf.statements) {
    if (!hasExportModifier(statement)) continue
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      && containsProperty(statement)
    ) names.add(statement.name.text)
  }
  return names
}

/** Exported function/const APIs with named or structural Project accept payloads. */
function exportedCallableNamesReturningTypes(
  src: string,
  label: string,
  resultTypes: ReadonlySet<string>,
  structuralProperty: 'candidate' | 'commit',
): Set<string> {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  const typeCarriesProperty = (type: ts.TypeNode | undefined): boolean => {
    if (type === undefined) return false
    if ([...resultTypes].some((typeName) => new RegExp(`\\b${typeName}\\b`).test(type.getText(sf)))) return true
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isPropertySignature(node) && propertyNameText(node.name) === structuralProperty) found = true
      else ts.forEachChild(node, visit)
    }
    visit(type)
    return found
  }
  const bodyCarriesProperty = (body: ts.ConciseBody): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found || (node !== body && ts.isFunctionLike(node))) return
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === structuralProperty) found = true
      else ts.forEachChild(node, visit)
    }
    visit(body)
    return found
  }
  const matches = (callable: ts.FunctionLikeDeclaration): boolean =>
    typeCarriesProperty(callable.type)
    || (callable.body !== undefined && bodyCarriesProperty(callable.body))

  for (const statement of sf.statements) {
    if (!hasExportModifier(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && matches(statement)) {
      names.add(statement.name.text)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const initializer = declaration.initializer
        if (
          initializer !== undefined
          && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          && matches(initializer)
        ) names.add(declaration.name.text)
      }
    }
  }
  return names
}

/** Exported builders whose declared result structurally carries a `commit` field. */
function projectCommitBuilderNames(src: string, label: string): Set<string> {
  const commitResultTypes = exportedResultTypeNamesWithProperty(src, label, 'commit')
  return exportedCallableNamesReturningTypes(src, label, commitResultTypes, 'commit')
}

/**
 * Derive the document commit sink from the real Project dataflow: builder result -> `.commit` ->
 * member call argument. Today this discovers `append`; a future renamed/replaced sink is picked up
 * from production without sweeping in unrelated object-literal calls from the controller.
 */
function projectCommitSinkNames(
  src: string,
  label: string,
  projectCommitBuilders: ReadonlySet<string>,
): Set<string> {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const builderResults = new Set<string>()
  const commitValues = new Set<string>()
  const names = new Set<string>()

  const collectValues = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
    ) {
      if (ts.isCallExpression(node.initializer)) {
        const called = callName(node.initializer.expression)
        if (called !== null && projectCommitBuilders.has(called)) builderResults.add(node.name.text)
      } else if (
        ts.isPropertyAccessExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && builderResults.has(node.initializer.expression.text)
        && node.initializer.name.text === 'commit'
      ) {
        commitValues.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectValues)
  }
  collectValues(sf)

  const containsCommitValue = (root: ts.Node): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isIdentifier(node) && (commitValues.has(node.text) || builderResults.has(node.text))) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }

  const visit = (node: ts.Node): void => {
    const isCommitPayloadArgument = (argument: ts.Expression): boolean => {
      if (ts.isIdentifier(argument) && commitValues.has(argument.text)) return true
      if (
        ts.isPropertyAccessExpression(argument)
        && ts.isIdentifier(argument.expression)
        && builderResults.has(argument.expression.text)
        && argument.name.text === 'commit'
      ) return true
      return ts.isObjectLiteralExpression(argument) && containsCommitValue(argument)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.arguments.some(isCommitPayloadArgument)
    ) {
      names.add(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) current = current.expression
  return current
}

function sketcherCommandEntryNames(src: string, label: string): {
  objects: Set<string>
  entries: Set<string>
} {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const objects = new Set<string>()
  const entries = new Set<string>()
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (!ts.isObjectLiteralExpression(initializer)) continue
      for (const member of initializer.properties) {
        if (propertyNameText(member.name) !== 'click') continue
        objects.add(declaration.name.text)
        if (ts.isShorthandPropertyAssignment(member)) entries.add(member.name.text)
        if (ts.isPropertyAssignment(member)) {
          const value = unwrapExpression(member.initializer)
          if (ts.isIdentifier(value)) entries.add(value.text)
        }
      }
    }
  }
  return { objects, entries }
}

interface CanonicalProjectCapabilities {
  hostResolvers: Set<string>
  commitBuilders: Set<string>
  commitSinks: Set<string>
  commandObjects: Set<string>
  commandEntries: Set<string>
}

function derivedProjectCapabilities(): CanonicalProjectCapabilities {
  const projectUseSrc = readFileSync(PROJECT_USE_SOURCE, 'utf8')
  const projectGeometrySrc = readFileSync(PROJECT_GEOMETRY_SOURCE, 'utf8')
  const resolveResultTypes = exportedResultTypeNamesWithProperty(
    projectUseSrc, slash(PROJECT_USE_SOURCE), 'candidate',
  )
  const hostResolvers = exportedCallableNamesReturningTypes(
    projectGeometrySrc, slash(PROJECT_GEOMETRY_SOURCE), resolveResultTypes, 'candidate',
  )
  const commitBuilders = projectCommitBuilderNames(projectUseSrc, slash(PROJECT_USE_SOURCE))
  const commitSinks = projectCommitSinkNames(
    readFileSync(PROJECT_CONTROLLER_SOURCE, 'utf8'), slash(PROJECT_CONTROLLER_SOURCE), commitBuilders,
  )
  const command = sketcherCommandEntryNames(
    readFileSync(PROJECT_CONTROLLER_SOURCE, 'utf8'), slash(PROJECT_CONTROLLER_SOURCE),
  )
  return {
    hostResolvers,
    commitBuilders,
    commitSinks,
    commandObjects: command.objects,
    commandEntries: command.entries,
  }
}

type ProjectCapabilityTag =
  | 'host-resolver'
  | 'project-builder'
  | 'workbench-port'
  | 'workbench-port-append'
  | 'workbench-port-resolver'
  | 'sketcher-tools'
  | 'sketcher-click'
  | 'session-deps'

interface ProjectCapabilitySource { label: string; src: string }
interface ProjectImportBinding { moduleKey: string; importedName: string }
interface ProjectSourceUnit {
  label: string
  key: string
  sf: ts.SourceFile
  imports: Map<string, ProjectImportBinding>
  namespaceImports: Map<string, string>
  typeImports: Map<string, ProjectImportBinding>
  typeNamespaceImports: Map<string, string>
  reExports: Map<string, ProjectImportBinding>
  exports: Map<string, string>
  values: Map<string, ts.Expression>
  destructures: Map<string, { source: ts.Expression; member: string }>
}
interface ProjectCapabilityCandidate {
  unit: ProjectSourceUnit
  member: ts.ObjectLiteralElementLike
  body: ProjectCapabilityBody
  location: string
}
interface ProjectAdapterCandidate extends ProjectCapabilityCandidate {
  receiver: ts.Expression
}
interface ProjectForwarderCandidate extends ProjectCapabilityCandidate {
  declaration: ts.VariableDeclaration
}
interface ProjectPlacementScan {
  violations: string[]
  adapterCount: number
  forwarderCount: number
  capabilities: CanonicalProjectCapabilities
}

type ProjectCapabilityBody = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

const sourceModuleKey = (path: string): string => slash(path).replace(/\.(?:ts|tsx|js|jsx)$/, '')

function projectProductionSources(overrides: ReadonlyMap<string, string> = new Map()): ProjectCapabilitySource[] {
  const paths = new Set([
    ...ecosystemFiles(),
    PROJECT_USE_SOURCE,
    PROJECT_CONTROLLER_SOURCE,
    PROJECT_SKETCHER_INDEX_SOURCE,
  ])
  return [...paths].sort().map((path) => ({
    label: path,
    src: overrides.get(sourceModuleKey(path)) ?? readFileSync(path, 'utf8'),
  }))
}

function projectObjectMemberBody(member: ts.ObjectLiteralElementLike): ProjectCapabilityBody | null {
  if (ts.isMethodDeclaration(member)) return member
  if (!ts.isPropertyAssignment(member)) return null
  const value = unwrapExpression(member.initializer)
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null
}

function nodeIsInside(node: ts.Node, owner: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (current === owner) return true
    current = current.parent
  }
  return false
}

function projectCapabilityPlacementScan(sources: readonly ProjectCapabilitySource[]): ProjectPlacementScan {
  const capabilities = derivedProjectCapabilities()
  const units = new Map<string, ProjectSourceUnit>()
  const moduleKey = (unit: ProjectSourceUnit, specifier: string): string => specifier.startsWith('.')
    ? sourceModuleKey(join(dirname(unit.label), specifier))
    : specifier

  for (const source of sources) {
    const sf = ts.createSourceFile(source.label, source.src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const key = sourceModuleKey(source.label)
    units.set(key, {
      label: source.label,
      key,
      sf,
      imports: new Map(),
      namespaceImports: new Map(),
      typeImports: new Map(),
      typeNamespaceImports: new Map(),
      reExports: new Map(),
      exports: new Map(),
      values: new Map(),
      destructures: new Map(),
    })
  }

  const findUnit = (key: string): ProjectSourceUnit | undefined => units.get(key) ?? units.get(key + '/index')
  for (const unit of units.values()) {
    const index = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause
        if (clause === undefined) return
        const target = moduleKey(unit, node.moduleSpecifier.text)
        if (clause.name !== undefined) {
          const binding = { moduleKey: target, importedName: 'default' }
          unit.typeImports.set(clause.name.text, binding)
          if (!clause.isTypeOnly) unit.imports.set(clause.name.text, binding)
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const binding of clause.namedBindings.elements) {
            const imported = {
              moduleKey: target,
              importedName: binding.propertyName?.text ?? binding.name.text,
            }
            unit.typeImports.set(binding.name.text, imported)
            if (!clause.isTypeOnly && !binding.isTypeOnly) {
              unit.imports.set(binding.name.text, imported)
            }
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          unit.typeNamespaceImports.set(clause.namedBindings.name.text, target)
          if (!clause.isTypeOnly) unit.namespaceImports.set(clause.namedBindings.name.text, target)
        }
        return
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        if (node.isTypeOnly) return
        for (const binding of node.exportClause.elements) {
          if (binding.isTypeOnly) continue
          const exportedName = binding.name.text
          const importedName = binding.propertyName?.text ?? binding.name.text
          unit.exports.set(exportedName, importedName)
          if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
            unit.reExports.set(exportedName, {
              moduleKey: moduleKey(unit, node.moduleSpecifier.text),
              importedName,
            })
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && hasExportModifier(node)) {
        unit.exports.set(node.name.text, node.name.text)
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
          unit.values.set(node.name.text, node.initializer)
          const statement = node.parent.parent
          if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
            unit.exports.set(node.name.text, node.name.text)
          }
        }
        if (ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            const member = propertyNameText(element.propertyName ?? element.name)
            if (member !== null) {
              unit.destructures.set(element.name.text, { source: node.initializer, member })
            }
          }
        }
      }
      ts.forEachChild(node, index)
    }
    index(unit.sf)
  }

  const geometryKey = sourceModuleKey(PROJECT_GEOMETRY_SOURCE)
  const projectUseKey = sourceModuleKey(PROJECT_USE_SOURCE)
  const controllerKey = sourceModuleKey(PROJECT_CONTROLLER_SOURCE)
  const pageKey = sourceModuleKey(PROJECT_PAGE_SOURCE)
  const sessionStoreKey = sourceModuleKey(PROJECT_SESSION_STORE_SOURCE)
  const portKey = sourceModuleKey(PROJECT_DOCUMENT_PORT_SOURCE)
  const sketcherIndexKey = sourceModuleKey(PROJECT_SKETCHER_INDEX_SOURCE)
  const exportCache = new Map<string, Set<ProjectCapabilityTag>>()
  const resolvingExports = new Set<string>()

  const memberProvenance = (
    base: ReadonlySet<ProjectCapabilityTag>, member: string,
  ): Set<ProjectCapabilityTag> => {
    const out = new Set<ProjectCapabilityTag>()
    for (const tag of base) {
      if (tag === 'workbench-port') {
        if (capabilities.commitSinks.has(member)) out.add('workbench-port-append')
        if (member === 'resolveProjectSource') out.add('workbench-port-resolver')
      }
      if (tag === 'sketcher-tools' && member === 'click') out.add('sketcher-click')
      if (tag === 'session-deps' && member === 'resolveProjectSource') out.add('workbench-port-resolver')
    }
    return out
  }

  function resolveExport(key: string, name: string): Set<ProjectCapabilityTag> {
    const cacheKey = key + ':' + name
    const cached = exportCache.get(cacheKey)
    if (cached !== undefined) return new Set(cached)
    if (resolvingExports.has(cacheKey)) return new Set()
    resolvingExports.add(cacheKey)
    const out = new Set<ProjectCapabilityTag>()
    if (key === geometryKey && capabilities.hostResolvers.has(name)) out.add('host-resolver')
    if (key === projectUseKey && capabilities.commitBuilders.has(name)) out.add('project-builder')
    if (key === portKey && name === 'workbenchSketchDocumentPort') out.add('workbench-port')
    if (key === controllerKey && capabilities.commandObjects.has(name)) out.add('sketcher-tools')
    if (key === controllerKey && capabilities.commandEntries.has(name)) out.add('sketcher-click')
    const unit = findUnit(key)
    const reExport = unit?.reExports.get(name)
    if (reExport !== undefined) {
      for (const tag of resolveExport(reExport.moduleKey, reExport.importedName)) out.add(tag)
    } else if (unit !== undefined) {
      const local = unit.exports.get(name)
      if (local !== undefined && local !== name) {
        for (const tag of localProvenance(unit, local, new Set())) out.add(tag)
      } else if (local !== undefined && unit.values.has(local)) {
        for (const tag of expressionProvenance(unit, unit.values.get(local)!, new Set())) out.add(tag)
      }
    }
    resolvingExports.delete(cacheKey)
    exportCache.set(cacheKey, out)
    return new Set(out)
  }

  function localProvenance(
    unit: ProjectSourceUnit, name: string, seen: Set<string>,
  ): Set<ProjectCapabilityTag> {
    const key = unit.key + ':' + name
    if (seen.has(key)) return new Set()
    const nextSeen = new Set(seen).add(key)
    const imported = unit.imports.get(name)
    if (imported !== undefined) return resolveExport(imported.moduleKey, imported.importedName)
    const destructured = unit.destructures.get(name)
    if (destructured !== undefined) {
      return memberProvenance(expressionProvenance(unit, destructured.source, nextSeen), destructured.member)
    }
    const value = unit.values.get(name)
    return value === undefined ? new Set() : expressionProvenance(unit, value, nextSeen)
  }

  function expressionProvenance(
    unit: ProjectSourceUnit, raw: ts.Expression, seen: Set<string>,
  ): Set<ProjectCapabilityTag> {
    const expression = unwrapExpression(raw)
    if (ts.isIdentifier(expression)) return localProvenance(unit, expression.text, seen)
    if (ts.isPropertyAccessExpression(expression)) {
      if (ts.isIdentifier(expression.expression)) {
        const namespace = unit.namespaceImports.get(expression.expression.text)
        if (namespace !== undefined) return resolveExport(namespace, expression.name.text)
      }
      return memberProvenance(expressionProvenance(unit, expression.expression, seen), expression.name.text)
    }
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      if (ts.isIdentifier(expression.expression)) {
        const namespace = unit.namespaceImports.get(expression.expression.text)
        if (namespace !== undefined) return resolveExport(namespace, expression.argumentExpression.text)
      }
      return memberProvenance(
        expressionProvenance(unit, expression.expression, seen), expression.argumentExpression.text,
      )
    }
    if (
      ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === 'sketchSessionStore'
      && expression.expression.name.text === 'getDeps'
    ) return new Set<ProjectCapabilityTag>(['session-deps'])
    return new Set()
  }

  const model3dKey = sourceModuleKey(join(SRC_ROOT, 'components', 'model3d'))
  const model3dUnits = [...units.values()].filter((unit) =>
    unit.key === model3dKey || unit.key.startsWith(model3dKey + '/'),
  )
  const location = (unit: ProjectSourceUnit, node: ts.Node): string => {
    const at = unit.sf.getLineAndCharacterOfPosition(node.getStart(unit.sf))
    return slash(unit.label) + ':' + (at.line + 1) + ':' + (at.character + 1)
  }
  const resolvesImportedExport = (
    unit: ProjectSourceUnit,
    raw: ts.Expression,
    expectedModuleKey: string,
    expectedExport: string,
  ): boolean => {
    const expression = unwrapExpression(raw)
    if (ts.isIdentifier(expression)) {
      const binding = unit.imports.get(expression.text)
      return binding?.moduleKey === expectedModuleKey && binding.importedName === expectedExport
    }
    if (
      ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
    ) {
      return unit.namespaceImports.get(expression.expression.text) === expectedModuleKey
        && expression.name.text === expectedExport
    }
    if (
      ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && ts.isStringLiteralLike(expression.argumentExpression)
    ) {
      return unit.namespaceImports.get(expression.expression.text) === expectedModuleKey
        && expression.argumentExpression.text === expectedExport
    }
    return false
  }
  const canonicalSketcherUnit = findUnit(sketcherIndexKey)
  const resolvesCanonicalSketchDocumentPortType = (
    unit: ProjectSourceUnit,
    type: ts.TypeNode | undefined,
  ): boolean => {
    if (canonicalSketcherUnit === undefined || type === undefined || !ts.isTypeReferenceNode(type)) {
      return false
    }
    const sameCanonicalModule = (key: string): boolean => findUnit(key) === canonicalSketcherUnit
    if (ts.isIdentifier(type.typeName)) {
      const binding = unit.typeImports.get(type.typeName.text)
      return binding !== undefined
        && sameCanonicalModule(binding.moduleKey)
        && binding.importedName === 'SketchDocumentPort'
    }
    if (ts.isQualifiedName(type.typeName) && ts.isIdentifier(type.typeName.left)) {
      const target = unit.typeNamespaceImports.get(type.typeName.left.text)
      return target !== undefined
        && sameCanonicalModule(target)
        && type.typeName.right.text === 'SketchDocumentPort'
    }
    return false
  }
  const adapterCandidates: ProjectAdapterCandidate[] = []
  const forwarderCandidates: ProjectForwarderCandidate[] = []
  for (const unit of model3dUnits) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'bindDeps'
        && node.arguments[0]
        && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const member of node.arguments[0].properties) {
          if (propertyNameText(member.name) !== 'resolveProjectSource') continue
          const body = projectObjectMemberBody(member)
          if (body !== null) {
            adapterCandidates.push({
              unit,
              member,
              body,
              receiver: node.expression.expression,
              location: location(unit, member),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.sf)
  }
  for (const unit of model3dUnits) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'workbenchSketchDocumentPort'
        && node.initializer !== undefined
      ) {
        const initializer = unwrapExpression(node.initializer)
        if (ts.isObjectLiteralExpression(initializer)) {
          for (const member of initializer.properties) {
            if (propertyNameText(member.name) !== 'resolveProjectSource') continue
            const body = projectObjectMemberBody(member)
            if (body !== null) {
              forwarderCandidates.push({
                unit,
                member,
                body,
                declaration: node,
                location: location(unit, member),
              })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.sf)
  }

  const violations = new Set<string>()
  const adapterBodies: ProjectCapabilityBody[] = []
  for (const candidate of adapterCandidates) {
    const canonicalOwner = candidate.unit.key === pageKey
    const canonicalReceiver = resolvesImportedExport(
      candidate.unit, candidate.receiver, sessionStoreKey, 'sketchSessionStore',
    )
    if (canonicalOwner && canonicalReceiver) {
      adapterBodies.push(candidate.body)
      continue
    }
    violations.add(
      candidate.location
      + (canonicalOwner
        ? ' host resolver adapter owner violation: bindDeps receiver does not resolve to canonical sketchSessionStore import'
        : ' noncanonical host resolver adapter owner: expected SolidsWorkbenchPage.tsx'),
    )
  }
  const forwarderBodies: ProjectCapabilityBody[] = []
  for (const candidate of forwarderCandidates) {
    const statement = candidate.declaration.parent.parent
    const canonicalOwner = candidate.unit.key === portKey
    const canonicalDeclaration = ts.isVariableStatement(statement)
      && hasExportModifier(statement)
      && resolvesCanonicalSketchDocumentPortType(candidate.unit, candidate.declaration.type)
    if (canonicalOwner && canonicalDeclaration) {
      forwarderBodies.push(candidate.body)
      continue
    }
    violations.add(
      candidate.location
      + (canonicalOwner
        ? ' document-port resolver declaration-owner violation: expected exported workbenchSketchDocumentPort with canonical sketcher SketchDocumentPort type provenance'
        : ' noncanonical document-port resolver forwarder owner: expected workbenchSketchDocumentPort.ts'),
    )
  }
  if (capabilities.hostResolvers.size !== 1) {
    violations.add('canonical host resolver census: expected 1, got ' + capabilities.hostResolvers.size)
  }
  if (capabilities.commitBuilders.size === 0) violations.add('canonical Project commit-builder census is empty')
  if (capabilities.commitSinks.size === 0) violations.add('canonical Project commit-sink census is empty')
  if (capabilities.commandObjects.size === 0 || capabilities.commandEntries.size === 0) {
    violations.add('canonical sketcherTools.click provenance is empty')
  }
  if (adapterBodies.length !== 1) {
    violations.add('host resolver adapter census: expected 1, got ' + adapterBodies.length)
  }
  if (forwarderBodies.length !== 1) {
    violations.add('document-port resolver forwarder census: expected 1, got ' + forwarderBodies.length)
  }

  const inAdapter = (node: ts.Node): boolean => adapterBodies.some((body) => nodeIsInside(node, body))
  const inForwarder = (node: ts.Node): boolean => forwarderBodies.some((body) => nodeIsInside(node, body))
  const reportTags = (
    unit: ProjectSourceUnit, node: ts.Node, tags: ReadonlySet<ProjectCapabilityTag>,
  ): void => {
    for (const tag of tags) {
      if (tag === 'host-resolver' && !inAdapter(node)) {
        violations.add(location(unit, node) + ' host resolver capability outside canonical adapter')
      }
      if (tag === 'project-builder') {
        violations.add(location(unit, node) + ' Project builder acquisition')
      }
      if (tag === 'workbench-port-append') {
        violations.add(location(unit, node) + ' provenance-bound workbenchSketchDocumentPort.append acquisition')
      }
      if (tag === 'workbench-port-resolver' && !inForwarder(node)) {
        violations.add(location(unit, node) + ' resolver seam access outside canonical forwarder')
      }
      if (tag === 'sketcher-click') {
        violations.add(location(unit, node) + ' package command entry acquisition (sketcherTools.click)')
      }
    }
  }
  const identifierIsRuntimeReference = (node: ts.Identifier): boolean => {
    const parent = node.parent
    if (
      ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)
      || ts.isExportSpecifier(parent) || ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)
      || ts.isBindingElement(parent)
    ) return false
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
    if (ts.isClassDeclaration(parent) && parent.name === node) return false
    if (ts.isParameter(parent) && parent.name === node) return false
    if (ts.isMethodDeclaration(parent) && parent.name === node) return false
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return false
    if (ts.isPropertySignature(parent) && parent.name === node) return false
    if (ts.isMethodSignature(parent) && parent.name === node) return false
    if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false
    if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false
    if (ts.isPropertyAccessExpression(parent)) return false
    if (ts.isElementAccessExpression(parent) && parent.expression === node) return false
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false
    return true
  }

  for (const unit of model3dUnits) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node))
        && propertyNameText(node.name) === 'resolveProjectSource'
      ) {
        const body = projectObjectMemberBody(node)
        if (
          body === null
          || (!adapterBodies.includes(body) && !forwarderBodies.includes(body))
        ) {
          violations.add(
            location(unit, node) + ' resolver capability declaration outside canonical adapter/forwarder',
          )
        }
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const binding of node.exportClause.elements) {
          if (binding.isTypeOnly) continue
          const tags = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
            ? resolveExport(moduleKey(unit, node.moduleSpecifier.text), binding.propertyName?.text ?? binding.name.text)
            : localProvenance(unit, binding.propertyName?.text ?? binding.name.text, new Set())
          reportTags(unit, binding, tags)
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
        const base = expressionProvenance(unit, node.initializer, new Set())
        for (const element of node.name.elements) {
          const member = propertyNameText(element.propertyName ?? element.name)
          if (member === null) continue
          const tags = memberProvenance(base, member)
          if (member === 'resolveProjectSource') tags.add('workbench-port-resolver')
          reportTags(unit, element, tags)
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        const tags = expressionProvenance(unit, node, new Set())
        if (node.name.text === 'resolveProjectSource') tags.add('workbench-port-resolver')
        reportTags(unit, node, tags)
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        const tags = expressionProvenance(unit, node, new Set())
        if (node.argumentExpression.text === 'resolveProjectSource') tags.add('workbench-port-resolver')
        reportTags(unit, node, tags)
      }
      if (ts.isIdentifier(node) && identifierIsRuntimeReference(node)) {
        reportTags(unit, node, localProvenance(unit, node.text, new Set()))
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.sf)
  }
  return {
    violations: [...violations],
    adapterCount: adapterBodies.length,
    forwarderCount: forwarderBodies.length,
    capabilities,
  }
}

/** The auditor's own evasions -- each MUST trip net (d). */
/** RENAMED verb: a page canvas whose onPointerDown calls a freshly-named machine (generic geom verbs).
 *  Nets (a)/(b)/(c) all miss it; net (d) flags the pointerdown binding itself. */
const FIXTURE_RENAMED_POINTERDOWN = `
  const jsx = <canvas onPointerDown={(e) => advanceInlineSketch(e)} onPointerMove={(e) => hover(e)} />
`
/** A raw pointerleave owner -- the verb net (c) omits entirely. */
const FIXTURE_RAW_POINTERLEAVE = `
  const el = canvasRef.current
  el.addEventListener('pointerleave', (e) => finishSketchStroke(e))
`
/** A raw pointercancel owner -- likewise omitted by (c). */
const FIXTURE_RAW_POINTERCANCEL = `
  const el = canvasRef.current
  el.addEventListener('pointercancel', (e) => abortSketchStroke(e))
`
/** S3 gate round-2 evasion (opus audit): the SAME renamed handler relocated onto a NON-canvas
 *  wrapper element. pointerdown bubbles from the canvas to its wrappers, so this is a working
 *  fork; a tag==='canvas'-keyed (d.1) admitted it. Must trip the widened (d.1). */
const FIXTURE_WRAPPER_POINTERDOWN = `
  const jsx = <div onPointerDown={(e) => advanceInlineSketch(e)}><canvas onPointerMove={(e) => hover(e)} /></div>
`

/** The existing categorically-forbidden pointerdown uses only real production entry points. */
const FIXTURE_SECOND_PROJECT_POINTERDOWN_OWNER = `
  const handleProjectPointerDown = (event) => {
    const resolved = resolveProjectGeometry(projectInput(event.clientX, event.clientY))
    if (!resolved.ok) return
    const built = buildProjectCommit(resolved.candidate, false)
    if (built.ok) workbenchSketchDocumentPort.append(built.commit, [])
  }
  const jsx = <canvas onPointerDown={handleProjectPointerDown} />
`

const PROJECT_FIXTURE_ROOT = join(
  SRC_ROOT, 'components', 'model3d', '__projectCapabilityFixtures__',
)

function projectFixture(name: string, src: string): ProjectCapabilitySource {
  return { label: join(PROJECT_FIXTURE_ROOT, name), src }
}

const FIXTURE_PROJECT_IMPORTS = [
  "import { resolveProjectGeometry } from '../workbench/projectGeometry'",
  "import { workbenchSketchDocumentPort } from '../workbench/workbenchSketchDocumentPort'",
  "import { buildProjectCommit } from '../../../lib/sketch/projectUse'",
].join('\n')

const PROJECT_CAPABILITY_FIXTURES: readonly ProjectCapabilitySource[] = [
  projectFixture('r1-bubbling-owner.tsx', FIXTURE_PROJECT_IMPORTS + '\n' + [
    'const duplicateProjectOwner = (event) => {',
    '  const resolved = resolveProjectGeometry(projectInput(event))',
    '  if (!resolved.ok) return',
    '  const built = buildProjectCommit(resolved.candidate, false)',
    '  if (built.ok) workbenchSketchDocumentPort.append(built.commit, [])',
    '}',
    'const jsx = <div onClick={duplicateProjectOwner}><WorkbenchCanvas /></div>',
  ].join('\n')),
  projectFixture('resolver-only-owner.tsx', [
    "import { resolveProjectGeometry } from '../workbench/projectGeometry'",
    'const owner = () => resolveProjectGeometry(projectInput())',
    'const jsx = <div onClick={owner}><WorkbenchCanvas /></div>',
  ].join('\n')),
  projectFixture('commit-only-owner.tsx', [
    "import { workbenchSketchDocumentPort } from '../workbench/workbenchSketchDocumentPort'",
    'const owner = () => workbenchSketchDocumentPort.append({ entities: [], constraints: [] }, [])',
    'const jsx = <WorkbenchCanvas onClick={owner} />',
  ].join('\n')),
  projectFixture('renamed-builder-owner.tsx', [
    "import { buildProjectCommit as makeProject } from '../../../lib/sketch/projectUse'",
    'const owner = () => makeProject(candidate(), false)',
  ].join('\n')),
  projectFixture('namespace-resolver-owner.tsx', [
    "import * as projectGeometry from '../workbench/projectGeometry'",
    'const owner = () => projectGeometry.resolveProjectGeometry(projectInput())',
  ].join('\n')),
  projectFixture('resolver-barrel.ts', [
    "export { resolveProjectGeometry as forwardedResolver } from '../workbench/projectGeometry'",
  ].join('\n')),
  projectFixture('reexported-resolver-owner.tsx', [
    "import { forwardedResolver } from './resolver-barrel'",
    'const owner = () => forwardedResolver(projectInput())',
  ].join('\n')),
  projectFixture('append-alias-owner.tsx', [
    "import { workbenchSketchDocumentPort } from '../workbench/workbenchSketchDocumentPort'",
    'const appendProject = workbenchSketchDocumentPort.append',
    'appendProject({ entities: [], constraints: [] }, [])',
  ].join('\n')),
  projectFixture('unrelated-append-green.tsx', [
    'const unrelated = { append: (value) => value }',
    'const appendValue = unrelated.append',
    'appendValue(1)',
  ].join('\n')),
  projectFixture('stored-resolver-owner.tsx', [
    "import { sketchSessionStore } from '../workbench/sketchSessionStore'",
    'const stored = sketchSessionStore.getDeps()',
    'const resolver = stored?.resolveProjectSource',
  ].join('\n')),
  projectFixture('direct-port-resolver-owner.tsx', [
    "import { workbenchSketchDocumentPort } from '../workbench/workbenchSketchDocumentPort'",
    'const resolver = workbenchSketchDocumentPort.resolveProjectSource',
  ].join('\n')),
  projectFixture('aliased-adapter-owner.tsx', [
    "import { sketchSessionStore } from '../workbench/sketchSessionStore'",
    'const store = sketchSessionStore',
    'store.bindDeps({ resolveProjectSource: () => null })',
  ].join('\n')),
  projectFixture('click-direct-owner.tsx', [
    "import { sketcherTools } from '../../../lib/sketch/sketcher'",
    'sketcherTools.click(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('click-alias-owner.tsx', [
    "import { sketcherTools } from '../../../lib/sketch/sketcher'",
    'const executeProject = sketcherTools.click',
    'executeProject(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('click-destructure-owner.tsx', [
    "import { sketcherTools } from '../../../lib/sketch/sketcher'",
    'const { click: executeProject } = sketcherTools',
    'executeProject(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('click-namespace-owner.tsx', [
    "import * as sketcher from '../../../lib/sketch/sketcher'",
    'sketcher.sketcherTools.click(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('click-barrel.ts', [
    "export { sketcherTools as commands } from '../../../lib/sketch/sketcher'",
  ].join('\n')),
  projectFixture('click-reexport-owner.tsx', [
    "import { commands } from './click-barrel'",
    'commands.click(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('click-underlying-owner.tsx', [
    "import { click as executeProject } from '../../../lib/sketch/sketcher/toolController'",
    'executeProject(point(), 1, null, false)',
  ].join('\n')),
  projectFixture('legal-presentation-green.tsx', [
    "import { sketcherTools } from '../../../lib/sketch/sketcher'",
    'const opaquePresentationCallback = props.onAction',
    "sketcherTools.armTool('project')",
    'sketcherTools.toggleConstruction()',
    'sketcherTools.end()',
    'const jsx = <WorkbenchCanvas onClick={opaquePresentationCallback} />',
  ].join('\n')),
]

function replaceExactlyOnce(src: string, find: string, replacement: string): string {
  const first = src.indexOf(find)
  if (first < 0 || src.indexOf(find, first + find.length) >= 0) {
    throw new Error('fixture mutation expected exactly one source match: ' + find)
  }
  return src.slice(0, first) + replacement + src.slice(first + find.length)
}

function projectSourceOverrides(path: string, src: string): ReadonlyMap<string, string> {
  return new Map([[sourceModuleKey(path), src]])
}

function exactLocalSketchDocumentPortInterface(): string {
  const src = readFileSync(PROJECT_SKETCHER_PORTS_SOURCE, 'utf8')
  const sf = ts.createSourceFile(
    PROJECT_SKETCHER_PORTS_SOURCE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )
  const matches = sf.statements.filter((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'SketchDocumentPort',
  )
  if (matches.length !== 1) {
    throw new Error('expected exactly one canonical SketchDocumentPort interface declaration')
  }
  return matches[0].getText(sf).replace(/^export\s+/, '')
}

function hasViolationEntry(
  violations: readonly string[],
  label: string,
  ownerPhrase: string,
): boolean {
  return violations.some((violation) => violation.includes(label) && violation.includes(ownerPhrase))
}

describe('WO SKC-15C: the workbench has exactly one sketch draw machine, and it is not under src/components/model3d', () => {
  it('the scan actually scans something (the root exists and has real files)', () => {
    for (const root of ECOSYSTEM_ROOTS) expect(existsSync(root), root).toBe(true)
    expect(ecosystemFiles().length).toBeGreaterThan(30)
  })

  it('(a) no model3d file CALLS stepDrawTool / pickGrabTarget / isSketch3dDrawTool', () => {
    const offenders: string[] = []
    for (const f of ecosystemFiles()) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const call of BANNED_CALLS) {
        if (call.test(src)) offenders.push(`${slash(f)}: ${call.source}`)
      }
    }
    // FAILS-IF the inline sketch3d draw/select machine is reintroduced anywhere in the workbench.
    expect(offenders).toEqual([])
  })

  it('(b) no model3d file holds the deleted inline pointer state, by name', () => {
    const offenders: string[] = []
    for (const f of ecosystemFiles()) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const banned of BANNED_POINTER_STATE) {
        if (new RegExp(`\\b${banned}\\b`).test(src)) offenders.push(`${slash(f)}: ${banned}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('(c) BY-NAME BACKSTOP: no pointer handler under these roots drives a KNOWN sketch draw/grab verb', () => {
    const owners = ecosystemFiles()
      .filter((f) => handlesSketchPointer(readFileSync(f, 'utf8')))
      .map(slash)
    // A by-name backstop over the legacy verbs. The structural teeth are net (d) below; this net was
    // proven evadable by the S3 gate audit (renamed verbs / pointerleave), so it is no longer the
    // load-bearing net -- it stays as an extra tree-wide catch for the exact legacy shapes.
    expect(owners).toEqual([])
  })

  it('(d) STRUCTURAL: the severing target binds no down/up/leave/cancel sketch pointer, by construction', () => {
    const target = ecosystemFiles().filter(isSeveringTarget)
    // The net must actually be pointed at the page (and, once it grows any, the workbench helpers).
    expect(target.some((f) => slash(f).endsWith('/model3d/SolidsWorkbenchPage.tsx')), 'page in scope').toBe(true)
    const violations = target.flatMap((f) => canvasPointerBindingViolations(readFileSync(f, 'utf8'), slash(f)))
    // FAILS-IF the page (or a workbench helper) binds ANY gesture-capable pointer event on its canvas,
    // under ANY name -- the binding-boundary net that does not depend on what the handler is called.
    expect(violations).toEqual([])
  })

  it('(e) PROJECT CAPABILITY PLACEMENT: one adapter, one forwarder, no presentation owner', () => {
    for (const source of [
      PROJECT_USE_SOURCE,
      PROJECT_GEOMETRY_SOURCE,
      PROJECT_CONTROLLER_SOURCE,
      PROJECT_SKETCHER_INDEX_SOURCE,
      PROJECT_SKETCHER_PORTS_SOURCE,
      PROJECT_PAGE_SOURCE,
      PROJECT_DOCUMENT_PORT_SOURCE,
    ]) expect(existsSync(source), slash(source)).toBe(true)

    const scan = projectCapabilityPlacementScan(projectProductionSources())
    expect([...scan.capabilities.hostResolvers]).toEqual(['resolveProjectGeometry'])
    expect(scan.capabilities.commitBuilders).toContain('buildProjectCommit')
    expect(scan.capabilities.commitSinks).toContain('append')
    expect(scan.capabilities.commandObjects).toContain('sketcherTools')
    expect(scan.capabilities.commandEntries).toContain('click')
    expect(scan.adapterCount, 'one direct bindDeps resolver adapter').toBe(1)
    expect(scan.forwarderCount, 'one canonical document-port resolver forwarder').toBe(1)
    expect(scan.violations).toEqual([])
  })

  it('(d) non-vacuity: the auditor\'s evasions each trip the binding-boundary net', () => {
    // Renamed-verb pointerdown owner: nets (a)/(b)/(c) all pass it (proving why (d) is needed)...
    expect(handlesSketchPointer(FIXTURE_RENAMED_POINTERDOWN)).toBe(false)
    expect(BANNED_CALLS.some((c) => c.test(FIXTURE_RENAMED_POINTERDOWN))).toBe(false)
    expect(BANNED_POINTER_STATE.some((b) => FIXTURE_RENAMED_POINTERDOWN.includes(b))).toBe(false)
    // ...but net (d) catches the pointerdown BINDING regardless of the handler's name.
    expect(canvasPointerBindingViolations(FIXTURE_RENAMED_POINTERDOWN, 'renamed').length).toBeGreaterThan(0)
    // Raw pointerleave / pointercancel owners -- the verbs net (c) omits entirely -- also trip (d).
    expect(canvasPointerBindingViolations(FIXTURE_RAW_POINTERLEAVE, 'leave').length).toBeGreaterThan(0)
    expect(canvasPointerBindingViolations(FIXTURE_RAW_POINTERCANCEL, 'cancel').length).toBeGreaterThan(0)
    // S3 gate round-2 evasion: the renamed handler on a NON-canvas wrapper (bubbling fork).
    // Nets (a)/(b)/(c) pass it, exactly like the canvas-bound fixture...
    expect(handlesSketchPointer(FIXTURE_WRAPPER_POINTERDOWN)).toBe(false)
    expect(BANNED_CALLS.some((c) => c.test(FIXTURE_WRAPPER_POINTERDOWN))).toBe(false)
    // ...and the widened (d.1) catches the binding on ANY element.
    expect(canvasPointerBindingViolations(FIXTURE_WRAPPER_POINTERDOWN, 'wrapper').length).toBeGreaterThan(0)
    // SKC-26B: the existing pointerdown Project fork remains caught by the binding boundary.
    expect(handlesSketchPointer(FIXTURE_SECOND_PROJECT_POINTERDOWN_OWNER)).toBe(false)
    expect(BANNED_CALLS.some((c) => c.test(FIXTURE_SECOND_PROJECT_POINTERDOWN_OWNER))).toBe(false)
    expect(canvasPointerBindingViolations(
      FIXTURE_SECOND_PROJECT_POINTERDOWN_OWNER, 'project-pointerdown-owner',
    ).length).toBeGreaterThan(0)
  })

  it('(e) can-fail: every second-owner capability shape turns the same production scanner red', () => {
    const scan = projectCapabilityPlacementScan([
      ...projectProductionSources(),
      ...PROJECT_CAPABILITY_FIXTURES,
    ])
    const violationsFor = (name: string): string[] =>
      scan.violations.filter((violation) => violation.includes('/' + name + ':'))

    const required: readonly [string, string][] = [
      ['resolver-only-owner.tsx', 'host resolver capability'],
      ['commit-only-owner.tsx', 'workbenchSketchDocumentPort.append'],
      ['renamed-builder-owner.tsx', 'Project builder acquisition'],
      ['namespace-resolver-owner.tsx', 'host resolver capability'],
      ['resolver-barrel.ts', 'host resolver capability'],
      ['reexported-resolver-owner.tsx', 'host resolver capability'],
      ['append-alias-owner.tsx', 'workbenchSketchDocumentPort.append'],
      ['stored-resolver-owner.tsx', 'resolver seam access'],
      ['direct-port-resolver-owner.tsx', 'resolver seam access'],
      ['aliased-adapter-owner.tsx', 'resolver capability declaration'],
      ['click-direct-owner.tsx', 'sketcherTools.click'],
      ['click-alias-owner.tsx', 'sketcherTools.click'],
      ['click-destructure-owner.tsx', 'sketcherTools.click'],
      ['click-namespace-owner.tsx', 'sketcherTools.click'],
      ['click-reexport-owner.tsx', 'sketcherTools.click'],
      ['click-underlying-owner.tsx', 'sketcherTools.click'],
    ]
    for (const [name, expected] of required) {
      expect(violationsFor(name).some((violation) => violation.includes(expected)), name).toBe(true)
    }

    const r1 = violationsFor('r1-bubbling-owner.tsx').join('\n')
    expect(r1, 'exact custom-component bubbling resolver').toContain('host resolver capability')
    expect(r1, 'exact custom-component bubbling builder').toContain('Project builder acquisition')
    expect(r1, 'exact custom-component bubbling commit').toContain('workbenchSketchDocumentPort.append')
    expect(violationsFor('unrelated-append-green.tsx')).toEqual([])
    expect(violationsFor('legal-presentation-green.tsx')).toEqual([])
    expect(scan.adapterCount, 'fixtures do not manufacture adapters').toBe(1)
    expect(scan.forwarderCount, 'fixtures do not manufacture forwarders').toBe(1)
  })

  it('(e) can-fail: an adapter shell cannot hide a sibling resolver body', () => {
    const page = readFileSync(PROJECT_PAGE_SOURCE, 'utf8')
    const moved = replaceExactlyOnce(
      page,
      'return resolveProjectGeometry({',
      'return illicitProjectResolver({',
    ) + '\nfunction illicitProjectResolver(input) { return resolveProjectGeometry(input) }\n'
    const scan = projectCapabilityPlacementScan(projectProductionSources(
      projectSourceOverrides(PROJECT_PAGE_SOURCE, moved),
    ))
    expect(scan.adapterCount).toBe(1)
    expect(scan.violations.some((violation) =>
      violation.includes('host resolver capability outside canonical adapter'),
    )).toBe(true)
  })

  it('(e) can-fail: relocated adapter names its noncanonical owner', () => {
    const page = readFileSync(PROJECT_PAGE_SOURCE, 'utf8')
    const pageWithoutCanonicalAdapter = replaceExactlyOnce(
      page,
      'resolveProjectSource: (context) => {',
      'resolveProjectSourceRemoved: (context) => {',
    )
    const relocated = projectFixture('relocated-adapter-owner.tsx', [
      "import { sketchSessionStore } from '../workbench/sketchSessionStore'",
      "import { resolveProjectGeometry } from '../workbench/projectGeometry'",
      'sketchSessionStore.bindDeps({',
      '  resolveProjectSource: (context) => resolveProjectGeometry(context),',
      '})',
    ].join('\n'))
    const scan = projectCapabilityPlacementScan([
      ...projectProductionSources(projectSourceOverrides(PROJECT_PAGE_SOURCE, pageWithoutCanonicalAdapter)),
      relocated,
    ])
    const claimedLabel = '/relocated-adapter-owner.tsx:'
    const ownerPhrase = 'noncanonical host resolver adapter owner'
    expect(hasViolationEntry(scan.violations, claimedLabel, ownerPhrase)).toBe(true)
    expect(hasViolationEntry([
      claimedLabel + ' unrelated synthetic violation',
      '/different-owner.tsx:1:1 ' + ownerPhrase,
    ], claimedLabel, ownerPhrase), 'split label and owner evidence is not one entry').toBe(false)
    expect(scan.adapterCount, 'relocated adapter is not canonical').toBe(0)
    expect(scan.violations).toContain('host resolver adapter census: expected 1, got 0')
  })

  it('(e) can-fail: relocated forwarder names its noncanonical owner', () => {
    const port = readFileSync(PROJECT_DOCUMENT_PORT_SOURCE, 'utf8')
    const portWithoutCanonicalForwarder = replaceExactlyOnce(
      port,
      'resolveProjectSource: (context) => {',
      'resolveProjectSourceRemoved: (context) => {',
    )
    const relocated = projectFixture('relocated-forwarder-owner.ts', [
      "import type { SketchDocumentPort } from '../../../lib/sketch/sketcher'",
      'export const workbenchSketchDocumentPort: SketchDocumentPort = {',
      '  resolveProjectSource: () => null,',
      '}',
    ].join('\n'))
    const scan = projectCapabilityPlacementScan([
      ...projectProductionSources(projectSourceOverrides(
        PROJECT_DOCUMENT_PORT_SOURCE, portWithoutCanonicalForwarder,
      )),
      relocated,
    ])
    expect(hasViolationEntry(
      scan.violations,
      '/relocated-forwarder-owner.ts:',
      'noncanonical document-port resolver forwarder owner',
    )).toBe(true)
    expect(scan.forwarderCount, 'relocated forwarder is not canonical').toBe(0)
    expect(scan.violations).toContain('document-port resolver forwarder census: expected 1, got 0')
  })

  it('(e) can-fail: shadowed store binding is not the adapter owner', () => {
    const page = readFileSync(PROJECT_PAGE_SOURCE, 'utf8')
    const shadowed = replaceExactlyOnce(
      page,
      "import { sketchSessionStore } from './workbench/sketchSessionStore'",
      [
        "import { sketchSessionStore as importedSketchSessionStore } from './workbench/sketchSessionStore'",
        'const sketchSessionStore = { bindDeps: importedSketchSessionStore.bindDeps }',
      ].join('\n'),
    )
    const scan = projectCapabilityPlacementScan(projectProductionSources(
      projectSourceOverrides(PROJECT_PAGE_SOURCE, shadowed),
    ))
    const violations = scan.violations.join('\n')
    expect(violations).toContain('/model3d/SolidsWorkbenchPage.tsx:')
    expect(violations).toContain('bindDeps receiver does not resolve to canonical sketchSessionStore import')
    expect(scan.adapterCount, 'shadowed store wrapper is not canonical').toBe(0)
  }, PROJECT_CAPABILITY_MUTATION_TIMEOUT_MS)

  it('(e) can-fail: nonexported port declaration is not the forwarder owner', () => {
    const port = readFileSync(PROJECT_DOCUMENT_PORT_SOURCE, 'utf8')
    const nonexported = replaceExactlyOnce(
      port,
      'export const workbenchSketchDocumentPort: SketchDocumentPort = {',
      'const workbenchSketchDocumentPort: SketchDocumentPort = {',
    )
    const scan = projectCapabilityPlacementScan(projectProductionSources(
      projectSourceOverrides(PROJECT_DOCUMENT_PORT_SOURCE, nonexported),
    ))
    const violations = scan.violations.join('\n')
    expect(violations).toContain('/workbench/workbenchSketchDocumentPort.ts:')
    expect(violations).toContain('document-port resolver declaration-owner violation')
    expect(scan.forwarderCount, 'nonexported port is not canonical').toBe(0)
  }, PROJECT_CAPABILITY_MUTATION_TIMEOUT_MS)

  it('(e) can-fail: forwarder annotation proves canonical type provenance', () => {
    const port = readFileSync(PROJECT_DOCUMENT_PORT_SOURCE, 'utf8')
    const canonicalImport = "import type { SketchDocumentPort, SketchNoticeSeverity } from '../../../lib/sketch/sketcher'"
    const canonicalDeclaration = 'export const workbenchSketchDocumentPort: SketchDocumentPort = {'
    const scanPort = (
      src: string,
      extras: readonly ProjectCapabilitySource[] = [],
    ): ProjectPlacementScan => projectCapabilityPlacementScan([
      ...projectProductionSources(projectSourceOverrides(PROJECT_DOCUMENT_PORT_SOURCE, src)),
      ...extras,
    ])
    const expectRejectedProvenance = (scan: ProjectPlacementScan, label: string): void => {
      expect(scan.forwarderCount, label + ' is not the canonical forwarder type').toBe(0)
      expect(hasViolationEntry(
        scan.violations,
        '/workbench/workbenchSketchDocumentPort.ts:',
        'canonical sketcher SketchDocumentPort type provenance',
      ), label + ' reports explicit type provenance').toBe(true)
    }

    const localFork = replaceExactlyOnce(port, canonicalImport, [
      "import type { SketchNoticeSeverity } from '../../../lib/sketch/sketcher'",
      "import type { ProjectSourceResolverContext } from '../../../lib/sketch/sketcher/ports'",
      "import type { ProjectCandidate, ProjectResolveResult } from '../../../lib/sketch/projectUse'",
      "import type { TextPathAlign, Vec2 as SketchVec2 } from '../../../lib/sketch/types'",
      exactLocalSketchDocumentPortInterface(),
    ].join('\n'))
    expectRejectedProvenance(scanPort(localFork), 'exact local structural interface copy')

    const namedAlias = replaceExactlyOnce(
      replaceExactlyOnce(port, canonicalImport, [
        "import type { SketchNoticeSeverity } from '../../../lib/sketch/sketcher'",
        "import { type SketchDocumentPort as CanonicalProjectPort } from '../../../lib/sketch/sketcher'",
      ].join('\n')),
      canonicalDeclaration,
      'export const workbenchSketchDocumentPort: CanonicalProjectPort = {',
    )
    const aliasScan = scanPort(namedAlias)
    expect(aliasScan.forwarderCount, 'specifier-level type-only named alias').toBe(1)
    expect(aliasScan.violations, 'canonical named alias stays green').toEqual([])

    const namespaceAnnotation = replaceExactlyOnce(
      replaceExactlyOnce(port, canonicalImport, [
        "import type { SketchNoticeSeverity } from '../../../lib/sketch/sketcher'",
        "import type * as CanonicalSketcher from '../../../lib/sketch/sketcher/index'",
      ].join('\n')),
      canonicalDeclaration,
      'export const workbenchSketchDocumentPort: CanonicalSketcher.SketchDocumentPort = {',
    )
    const namespaceScan = scanPort(namespaceAnnotation)
    expect(namespaceScan.forwarderCount, 'one-level canonical namespace annotation').toBe(1)
    expect(namespaceScan.violations, 'canonical namespace annotation stays green').toEqual([])

    const fakeModule = projectFixture('fake-sketch-document-port.ts', [
      "import type { SketchDocumentPort as CanonicalPort } from '../../../lib/sketch/sketcher'",
      'export interface SketchDocumentPort extends CanonicalPort {}',
    ].join('\n'))
    const fakeImport = replaceExactlyOnce(port, canonicalImport, [
      "import type { SketchNoticeSeverity } from '../../../lib/sketch/sketcher'",
      "import type { SketchDocumentPort } from '../__projectCapabilityFixtures__/fake-sketch-document-port'",
    ].join('\n'))
    expectRejectedProvenance(scanPort(fakeImport, [fakeModule]), 'same-named fake-module type')
    /* 120s budget: this census runs full TS placement scans over the production
       source set several times; the 5s default flaked two merge campaigns in one
       night under fleet load (BK-160 family) while passing instantly in isolation. */
  }, 120_000)

  it('(e) can-fail: adapter and forwarder censuses reject zero and duplicates', () => {
    const page = readFileSync(PROJECT_PAGE_SOURCE, 'utf8')
    const port = readFileSync(PROJECT_DOCUMENT_PORT_SOURCE, 'utf8')
    const cases: readonly [string, string, string, string][] = [
      [
        'zero adapter',
        PROJECT_PAGE_SOURCE,
        replaceExactlyOnce(
          page,
          'resolveProjectSource: (context) => {',
          'resolveProjectSourceRemoved: (context) => {',
        ),
        'host resolver adapter census: expected 1, got 0',
      ],
      [
        'second adapter',
        PROJECT_PAGE_SOURCE,
        page + '\nsketchSessionStore.bindDeps({ resolveProjectSource: (context) => resolveProjectGeometry(context) })\n',
        'host resolver adapter census: expected 1, got 2',
      ],
      [
        'zero forwarder',
        PROJECT_DOCUMENT_PORT_SOURCE,
        replaceExactlyOnce(
          port,
          'resolveProjectSource: (context) => {',
          'resolveProjectSourceRemoved: (context) => {',
        ),
        'document-port resolver forwarder census: expected 1, got 0',
      ],
      [
        'second forwarder',
        PROJECT_DOCUMENT_PORT_SOURCE,
        replaceExactlyOnce(
          port,
          '  // 6',
          '  resolveProjectSource: (context) => deps()?.resolveProjectSource?.(context) as never,\n\n  // 6',
        ),
        'document-port resolver forwarder census: expected 1, got 2',
      ],
    ]
    for (const [label, path, mutated, expected] of cases) {
      const scan = projectCapabilityPlacementScan(projectProductionSources(
        projectSourceOverrides(path, mutated),
      ))
      expect(scan.violations, label).toContain(expected)
    }
    /* 120s budget: same heavy multi-scan census as its sibling above (BK-160). */
  }, 120_000)

  it('(d) does NOT fire on the measure/appearance hover the page keeps (onClick + onPointerMove)', () => {
    // The kept hover is a bare onPointerMove; the pick path is onClick. Both are allowlisted, so a
    // net that flagged them would force the page to delete a legitimate feature to stay green.
    expect(canvasPointerBindingViolations(FIXTURE_KEPT_MEASURE_HOVER, 'kept')).toEqual([])
    expect(canvasPointerBindingViolations(`const jsx = <canvas onClick={(e) => pickFace(e)} />`, 'click')).toEqual([])
  })

  it('the scan FAILS on the REAL deleted shapes it must catch (non-vacuity)', () => {
    // The inline draw-click and grab-drag, verbatim from d35ce1f5.
    expect(handlesSketchPointer(FIXTURE_INLINE_DRAW_CLICK)).toBe(true)
    expect(handlesSketchPointer(FIXTURE_INLINE_GRAB_DRAG)).toBe(true)
    // Both trip the by-name nets too, so (a)/(b) are second and third nets on the same shapes.
    expect(BANNED_CALLS.some((c) => c.test(FIXTURE_INLINE_DRAW_CLICK))).toBe(true)
    expect(BANNED_CALLS.some((c) => c.test(FIXTURE_INLINE_GRAB_DRAG))).toBe(true)
    expect(BANNED_POINTER_STATE.some((b) => FIXTURE_INLINE_DRAW_CLICK.includes(b))).toBe(true)
    expect(BANNED_POINTER_STATE.some((b) => FIXTURE_INLINE_GRAB_DRAG.includes(b))).toBe(true)
  })

  it('the scan does NOT fire on the measure/appearance hover handler the page keeps', () => {
    // A pointer handler that drives NO sketch gesture is not a sketch pointer owner. A scan that
    // flagged this would be a scan that forces the page to delete a legitimate feature to stay green.
    expect(handlesSketchPointer(FIXTURE_KEPT_MEASURE_HOVER)).toBe(false)
    for (const call of BANNED_CALLS) expect(call.test(FIXTURE_KEPT_MEASURE_HOVER)).toBe(false)
  })
})
