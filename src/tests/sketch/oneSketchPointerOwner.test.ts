// WO SKC-14, zero-regression gate criterion 4(a) + 4(c): CAPABILITY SCANS --
//   (a) exactly ONE module may handle a sketch pointer event, and
//   (c) exactly ONE module may paint sketch hover/preview feedback geometry.
//
// Both are the critic's DE-2 pattern (docs/3d/SKETCH-CRITIC-REPORT.md): a capability scan, not a
// name-grep. The critic's law that motivates them:
//
//   "A guard of the form 'A imports from B' or 'X is defined once (by name)' is satisfiable while
//    forking. Divergence is structurally hard only when there is no file in which a second
//    version could be written."
//
// ---------------------------------------------------------------------------------------------
// WO SKC-14-R1 -- WHY THIS FILE WAS REBUILT.
//
// SKC-14's audit found the previous scan GREEN over two second owners that were sitting in the
// committed tree the whole time:
//
//   1. SketchDimensionOverlay.tsx owned a complete dimension-label drag: a JSX `onPointerDown`
//      handler that installed `window` pointermove/pointerup listeners, pushed history itself, and
//      moved the label. The old scan never saw it, because it recognised a pointer handler ONLY as
//      a raw `addEventListener` call -- JSX props were invisible to it.
//   2. Viewport.tsx owned the right-button context-menu gesture (rightDownRef press position,
//      pan-vs-menu discrimination, preventDefault). Invisible for the same reason, and its
//      no-pointer-state check read CNCViewport.ts and nothing else.
//
// A scan that stays green while a second owner exists IS VOID. So this one is rebuilt around four
// independent nets, at least one of which is STRUCTURAL (name-free) for each known shape:
//
//   (a) CAPABILITY: [installs a pointer/context handler -- raw addEventListener OR a JSX prop, in
//       ANY ecosystem file] AND [drives sketch gesture machinery]. Comments are stripped first, so
//       prose about a handler can neither trip the scan nor satisfy it.
//   (b) NO MOUNT POINTER STATE: banned identifiers, now swept across EVERY ecosystem file rather
//       than CNCViewport alone. A name-based backstop, and labelled as one.
//   (d) STRUCTURAL: only the component may register a window/document `pointerdown`, `pointerup`,
//       `contextmenu` or `dblclick` listener. A DRAG needs a press and a release, so this rule
//       kills the overlay-drag shape by construction, whatever it is named. (`pointermove` on
//       `window` stays legal: a passive cursor-follow -- the smart-dimension preview label -- has
//       no gesture in it, and no drag can be built from moves alone.)
//   (e) STRUCTURAL: only the component may discriminate the RIGHT pointer button. Navigation is
//       the one allowlisted exception (navPresetController maps buttons to orbit/pan verbs). This
//       kills the Viewport context-menu shape by construction.
//
// And the scans are proved non-vacuous against the REAL committed bytes of both shapes (plus the
// CNCViewport raw-listener shape), embedded verbatim as fixtures below -- so a future rewrite that
// weakens a pattern turns this file red rather than silently green.
//
// SCOPE: the CAM sketcher ecosystem + the component. `src/components/model3d/SolidsWorkbenchPage.tsx`
// and `src/sketch3d/**` still own their own (doomed) 4-tool interaction layer and are therefore
// NOT in scope for this WO -- S3 mounts the component there and S5 deletes the remains, and the
// S3 WO extends ECOSYSTEM_ROOTS below to cover them. Recording that here so the omission is a
// dated hand-off, not a silent hole (critic DE-1: every layer left forked carries a named owner).
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC_ROOT = join(__dirname, '..', '..')

const ECOSYSTEM_ROOTS = [
  join(SRC_ROOT, 'lib', 'sketch'), // includes lib/sketch/sketcher/**
  join(SRC_ROOT, 'lib', 'viewport'),
  join(SRC_ROOT, 'components', 'viewport'),
  join(SRC_ROOT, 'components', 'panels', 'sketch'),
  join(SRC_ROOT, 'components', 'sketch3d-shared'),
]
const REQUIRED_ROOTS = [
  join(SRC_ROOT, 'lib', 'sketch'),
  join(SRC_ROOT, 'lib', 'viewport'),
  join(SRC_ROOT, 'components', 'viewport'),
]

const SKETCHER_PKG = join(SRC_ROOT, 'lib', 'sketch', 'sketcher')
const THE_INTERACTION = join(SKETCHER_PKG, 'sketchInteraction.ts')
const THE_FEEDBACK_PAINTER = join(SKETCHER_PKG, 'overlayPainter.ts')
const THE_SKETCHER = join(SKETCHER_PKG, 'index.ts')
const CAM_VIEWPORT_COMPONENT = join(SRC_ROOT, 'components', 'viewport', 'Viewport.tsx')
const CAM_VIEWPORT_ENGINE = join(SRC_ROOT, 'lib', 'viewport', 'CNCViewport.ts')

/** Navigation legitimately maps pointer BUTTONS to orbit/pan/zoom verbs. It is the only file
 *  outside the component allowed to know what the right button is (rule (e)). */
const RIGHT_BUTTON_ALLOWLIST = [join(SRC_ROOT, 'lib', 'viewport', 'navPresetController.ts')]

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
  return files.filter((f) => !slash(f).includes('/tests/'))
}

const inSketcherPkg = (f: string) => slash(f).includes('lib/sketch/sketcher/')

/**
 * Comments are prose, not capability. Stripping them first is what lets this file's OWN patterns
 * be written down in the sketcher package's header comments, and stops a `// pushHistory + solve`
 * note in a panel from ever standing in for the real thing. (The `[^:]` guard keeps `https://`
 * inside a string literal from eating the rest of a line.)
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ---- (a) the sketch-pointer-owner capability -------------------------------------------------

/** Installs a pointer/context gesture handler the RAW way. CNCViewport and navPresetController
 *  legitimately do this for part/face picking and orbit navigation -- which is why the SKETCH
 *  conjunction below is what makes this a capability and not a blanket ban. */
const RAW_HANDLER =
  /addEventListener\(\s*['"](?:pointerdown|pointermove|pointerup|dblclick|contextmenu)['"]/
/** ...or the JSX way. THIS is the recognizer the old scan lacked: SketchDimensionOverlay's whole
 *  label drag hung off `onPointerDown={(e) => beginLabelDrag(...)}` and scanned clean. */
const JSX_HANDLER = /\bon(?:PointerDown|PointerMove|PointerUp|ContextMenu|DoubleClick)\s*=/
/** ...and drives the sketch gesture machinery with it. Broadened past SKC-14's short list to
 *  cover BOTH found shapes: the dimension-label drag (moves a label, pushes history, sets the
 *  selection) and the context-menu router (right-button press state / menu placement). */
const SKETCH_GESTURE =
  /(SketchPickHit|dragBegin\(|trimSwipe\(|getSnap\(|toolArmed\(|lockCursor\(|moveDimLabel\(|updateDimensionLabel\(|pushHistory\(|setSketchSelection\(|rightDownRef|sketchMenuAt|labelDragMovedRef|beginLabelDrag)/

/** Builds renderable THREE objects... */
const THREE_CONSTRUCT = /new THREE\.(Line|LineLoop|LineSegments|Points|Sprite|Mesh)\(/
/** ...out of live sketch FEEDBACK (a snap result, a tool overlay, woken refs). Word-bounded so
 *  method names and prose cannot stand in for one of the package-owned feedback types. */
const FEEDBACK_TYPE = /\b(SnapResult|ToolOverlay|WokenRef)\b/

const CAM_OVERLAY_OWNER_IDENTIFIERS = [
  'sketchToolChain', 'sketchFilletRadius', 'sketchChamferSetback',
  'sketchOffsetDistance', 'sketchLinearPatternCount',
  'sketchCircularPatternCount', 'sketchCircularPatternAngleDeg',
]
const CAM_OVERLAY_PASS_THROUGH = /\brefreshSketchToolOverlay\s*\(/

const FIXTURE_CAM_REACT_OVERLAY_OWNER = `
  const sketchToolChain = useSketcherTool((s) => s.chain)
  const sketchFilletRadius = useSketcherTool((s) => s.filletRadius)
  useEffect(() => {
    viewportRef.current?.refreshSketchToolOverlay()
  }, [sketchToolChain, sketchFilletRadius, activeSketch])
`

const FIXTURE_CAM_OVERLAY_PASS_THROUGH = `
  refreshSketchToolOverlay() {
    this.sketcher.refreshToolOverlay()
  }
`

// ---- (d) + (e) the two STRUCTURAL nets -------------------------------------------------------

/** A drag needs a press and a release. `pointermove` is deliberately absent: a passive
 *  cursor-follow (the smart-dim preview label) owns no gesture and can start none. */
const WINDOW_GESTURE_LISTENER =
  /(?:window|document)\.addEventListener\(\s*['"](?:pointerdown|pointerup|contextmenu|dblclick)['"]/
/** Knowing which button is the RIGHT one is a gesture decision. */
const RIGHT_BUTTON_TEST = /\.button\s*[!=]==?\s*2\b|\bbuttons\s*[!=]==?\s*2\b/

function handlesSketchPointer(rawSrc: string): boolean {
  const src = stripComments(rawSrc)
  return (RAW_HANDLER.test(src) || JSX_HANDLER.test(src)) && SKETCH_GESTURE.test(src)
}

function paintsSketchFeedback(rawSrc: string): boolean {
  const src = stripComments(rawSrc)
  return THREE_CONSTRUCT.test(src) && FEEDBACK_TYPE.test(src)
}

function registersWindowGesture(rawSrc: string): boolean {
  return WINDOW_GESTURE_LISTENER.test(stripComments(rawSrc))
}

function discriminatesRightButton(rawSrc: string): boolean {
  return RIGHT_BUTTON_TEST.test(stripComments(rawSrc))
}

/** Private sketch pointer STATE that may live only inside the component. The first ten are the
 *  fields CNCViewport lost when SKC-14 extracted the component; the last six are the two second
 *  owners SKC-14-R1 deleted. A name-based backstop by construction -- rules (a)/(d)/(e) are the
 *  structural nets that do not depend on what a reintroduction is called. */
const BANNED_POINTER_STATE = [
  'handleSketchPointerDown', 'handleSketchPointerMove', 'handleSketchPointerUp',
  'handleSketchDoubleClick', 'sketchPointerDown', 'sketchDragActive', 'sketchSwipePath',
  'sketchMarqueeDiv', 'sketchDimDrag', 'sketchPreviewLine',
  // SKC-14-R1: the dimension-label drag and the context-menu router.
  'beginLabelDrag', 'labelDragMovedRef', 'rightDownRef', 'sketchMenuAt',
  'handleViewportPointerDown', 'handleViewportContextMenu',
]

// ---- The REAL committed second-owner shapes, verbatim ---------------------------------------
//
// Copied byte-for-byte out of the tree SKC-14's auditor read (git show 14e0320e:<file>). If any
// pattern above is ever weakened, these fixtures go green and this file fails -- which is the only
// way a capability scan can prove it still has teeth.

/** SketchDimensionOverlay.tsx:215-248 @ 14e0320e -- a JSX `onPointerDown` + window pointer
 *  listeners + its own pushHistory. Trips (a) via the JSX recognizer, (d) via `window` pointerup,
 *  and (b) via `labelDragMovedRef`. */
const FIXTURE_OVERLAY_LABEL_DRAG = `
  const beginLabelDrag = (e: React.PointerEvent, dimId: string, anchor: Vec2) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const vp = viewportRef.current
    if (!vp) return
    const startX = e.clientX
    const startY = e.clientY
    const orig = { x: anchor.x, y: anchor.y }
    let dragging = false
    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging) {
        if (dx * dx + dy * dy < 9) return // 3px threshold
        dragging = true
        labelDragMovedRef.current = true
        useCamStore.getState().pushHistory()
      }
      const wpp = vp.getWorldPerPixel()
      useCamStore.getState().updateDimensionLabel(dimId, {
        x: orig.x + dx * wpp,
        y: orig.y - dy * wpp,
      })
    }
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      setTimeout(() => { labelDragMovedRef.current = false }, 0)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }
  const jsx = <div onPointerDown={(e) => beginLabelDrag(e, d.id, disp.anchor)} />
`

/** Viewport.tsx:94-106 @ 14e0320e -- the right-button context-menu router. Trips (a) via the JSX
 *  recognizer + `rightDownRef`, (b) via `rightDownRef`/`sketchMenuAt`, and (e) via `button === 2`. */
const FIXTURE_VIEWPORT_CONTEXT_MENU = `
  const handleViewportPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button === 2) rightDownRef.current = { x: e.clientX, y: e.clientY }
  }, [])
  const handleViewportContextMenu = useCallback((e: ReactMouseEvent) => {
    if (useCamStore.getState().viewer.mode !== 'sketch') return
    e.preventDefault()
    const down = rightDownRef.current
    rightDownRef.current = null
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
      return
    }
    setSketchMenuAt({ x: e.clientX, y: e.clientY })
  }, [])
  const jsx = <div onPointerDown={handleViewportPointerDown} onContextMenu={handleViewportContextMenu} />
`

/** The shape SKC-14's auditor injected by hand: a raw inline sketch pointerdown on the mount. */
const FIXTURE_CNCVIEWPORT_RAW_LISTENER = `
  this.renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
    const hit = this.pickSketch(e.clientX, e.clientY)
    if (hit) this.sketchTools.dragBegin(hit.id, this.toWorld(e), this.tol())
  })
`

/** A passive cursor-follow: a `window` pointermove that only positions a DOM label. Legal, and it
 *  must stay legal -- the smart-dimension preview is exactly this. No press, no release, no
 *  mutation, no gesture. */
const FIXTURE_PASSIVE_CURSOR_FOLLOW = `
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      el.style.transform = \`translate(\${e.clientX}px, \${e.clientY}px)\`
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])
`

describe('WO SKC-14: capability scan -- one sketch pointer owner, one feedback painter', () => {
  it('the scan actually scans something (roots that must exist, do)', () => {
    for (const root of REQUIRED_ROOTS) expect(existsSync(root), root).toBe(true)
    expect(ecosystemFiles().length).toBeGreaterThan(50)
  })

  it('(a) exactly one module handles sketch pointer events, and it is the component', () => {
    const owners = ecosystemFiles()
      .filter((f) => handlesSketchPointer(readFileSync(f, 'utf8')))
      .map(slash)
    // FAILS-IF: any mount regrows a sketch pointer handler -- as a raw listener (the 1,114-line
    // shape SKC-14 deleted from CNCViewport) OR as a JSX prop (the dimension-label drag and the
    // context-menu router SKC-14-R1 deleted from the two viewport components).
    expect(owners).toEqual([slash(THE_INTERACTION)])
  })

  it('(b) no mount holds sketch pointer state -- swept across the whole ecosystem', () => {
    const offenders: string[] = []
    for (const f of ecosystemFiles()) {
      if (inSketcherPkg(f)) continue
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const banned of BANNED_POINTER_STATE) {
        if (src.includes(banned)) offenders.push(`${slash(f)}: ${banned}`)
      }
    }
    // FAILS-IF: any of the deleted fields/handlers reappear ANYWHERE outside the component. The
    // SKC-14 version of this check read CNCViewport.ts alone, which is how two second owners in
    // sibling files stayed green.
    expect(offenders).toEqual([])

    // ...and CNCViewport reads no store state for the sketcher (the four reads that used to live
    // inside the handlers are now port calls).
    const mount = readFileSync(join(SRC_ROOT, 'lib', 'viewport', 'CNCViewport.ts'), 'utf8')
    expect(mount).not.toMatch(
      /useCamStore\.getState\(\)\.(activeSketch|sketchTextEditId|sketchPickPathForTextId)/,
    )
  })

  it('(c) exactly one module paints sketch hover/preview feedback, and it is the component', () => {
    const painters = ecosystemFiles()
      .filter((f) => paintsSketchFeedback(readFileSync(f, 'utf8')))
      .map(slash)
    // FAILS-IF: a mount paints its own snap marker / rubber band / ghost overlay -- the A-1
    // divergence vector ("two painters") the critic named, which already shipped once as
    // SolidsWorkbenchPage's drawSketch3dOutline committing invisible geometry.
    expect(painters).toEqual([slash(THE_FEEDBACK_PAINTER)])
  })

  it('SKC-30 shared overlay owner: the package subscribes once and both CAM bridge shapes stay deleted', () => {
    const shared = stripComments(readFileSync(THE_SKETCHER, 'utf8'))
    const reactMount = stripComments(readFileSync(CAM_VIEWPORT_COMPONENT, 'utf8'))
    const engineMount = stripComments(readFileSync(CAM_VIEWPORT_ENGINE, 'utf8'))

    expect(shared.match(/sketcherToolStore\.subscribe\s*\(/g) ?? []).toHaveLength(1)
    for (const identifier of CAM_OVERLAY_OWNER_IDENTIFIERS) {
      expect(reactMount, `CAM React overlay owner regrew: ${identifier}`).not.toContain(identifier)
    }
    expect(reactMount).not.toMatch(CAM_OVERLAY_PASS_THROUGH)
    expect(engineMount).not.toMatch(CAM_OVERLAY_PASS_THROUGH)

    // Non-vacuity: these are the actual deleted React-owner and engine pass-through constructs.
    expect(CAM_OVERLAY_OWNER_IDENTIFIERS.some((id) => FIXTURE_CAM_REACT_OVERLAY_OWNER.includes(id)))
      .toBe(true)
    expect(FIXTURE_CAM_REACT_OVERLAY_OWNER).toMatch(CAM_OVERLAY_PASS_THROUGH)
    expect(FIXTURE_CAM_OVERLAY_PASS_THROUGH).toMatch(CAM_OVERLAY_PASS_THROUGH)
  })

  it('(d) STRUCTURAL: only the component registers window/document press+release listeners', () => {
    const offenders = ecosystemFiles()
      .filter((f) => !inSketcherPkg(f))
      .filter((f) => registersWindowGesture(readFileSync(f, 'utf8')))
      .map(slash)
    // FAILS-IF: a mount grows any drag whatsoever. A drag needs a release; only this package may
    // listen for one. Name-free: it would have caught the dimension-label drag no matter what its
    // author had called it.
    expect(offenders).toEqual([])
  })

  it('(e) STRUCTURAL: only the component (and navigation) discriminates the right button', () => {
    const allow = new Set(RIGHT_BUTTON_ALLOWLIST.map(slash))
    const offenders = ecosystemFiles()
      .filter((f) => !inSketcherPkg(f) && !allow.has(slash(f)))
      .filter((f) => discriminatesRightButton(readFileSync(f, 'utf8')))
      .map(slash)
    // FAILS-IF: a mount decides what a right-click means. Name-free: it would have caught
    // Viewport's context-menu router no matter what `rightDownRef` had been called.
    expect(offenders).toEqual([])
  })

  it('sanity: both allowed modules really do have the capability (the scans are not vacuous)', () => {
    // FAILS-IF: the handlers or the painter are reshaped so the scan patterns stop matching them,
    // at which point the scans above would be green against a tree full of forks.
    expect(handlesSketchPointer(readFileSync(THE_INTERACTION, 'utf8'))).toBe(true)
    expect(paintsSketchFeedback(readFileSync(THE_FEEDBACK_PAINTER, 'utf8'))).toBe(true)
    // The component is also the one place allowed to do the two structural things.
    expect(registersWindowGesture(readFileSync(THE_INTERACTION, 'utf8'))).toBe(true)
    expect(discriminatesRightButton(readFileSync(THE_INTERACTION, 'utf8'))).toBe(true)
  })

  it('the scan fails on the REAL committed second-owner shapes it once missed', () => {
    // 1. The overlay's JSX + window-listener dimension-label drag.
    expect(handlesSketchPointer(FIXTURE_OVERLAY_LABEL_DRAG)).toBe(true)
    expect(registersWindowGesture(FIXTURE_OVERLAY_LABEL_DRAG)).toBe(true)
    // 2. The Viewport right-button context-menu router.
    expect(handlesSketchPointer(FIXTURE_VIEWPORT_CONTEXT_MENU)).toBe(true)
    expect(discriminatesRightButton(FIXTURE_VIEWPORT_CONTEXT_MENU)).toBe(true)
    // 3. The raw-listener mount shape the previous scan DID catch -- still caught.
    expect(handlesSketchPointer(FIXTURE_CNCVIEWPORT_RAW_LISTENER)).toBe(true)
    // Each shape also carries banned pointer state, so rule (b) is a second net on both.
    for (const fixture of [FIXTURE_OVERLAY_LABEL_DRAG, FIXTURE_VIEWPORT_CONTEXT_MENU]) {
      expect(BANNED_POINTER_STATE.some((b) => fixture.includes(b))).toBe(true)
    }
  })

  it('the scan does NOT fire on a passive cursor-follow (no press, no release, no gesture)', () => {
    // The smart-dimension preview label follows the pointer to stay beside the cursor. It owns no
    // gesture, and rule (d) must not pretend it does -- a scan that cries wolf gets deleted.
    expect(handlesSketchPointer(FIXTURE_PASSIVE_CURSOR_FOLLOW)).toBe(false)
    expect(registersWindowGesture(FIXTURE_PASSIVE_CURSOR_FOLLOW)).toBe(false)
  })

  it('the component package is store-free (what makes the S3 workbench mount possible)', () => {
    const offenders: string[] = []
    const pkg: string[] = []
    collectTsFiles(SKETCHER_PKG, pkg)
    for (const f of pkg) {
      const src = readFileSync(f, 'utf8')
      // Import of the CAM store, not a prose mention of it in a comment.
      if (/^\s*import\s[^\n]*\bfrom\s+['"][^'"]*\/store['"]/m.test(src)) offenders.push(f)
    }
    // FAILS-IF: the component reaches back into CAM's store, re-welding it to the CAM host.
    expect(offenders).toEqual([])
  })
})
