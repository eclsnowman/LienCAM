// Sketch3d Lab (WO INT-2, M2 gate demo surface): a query-param-gated ("?sketch3dlab=1", see
// App.tsx) standalone page that wires the SKC-2/SKC-3 sketch3d stack (src/sketch3d) into a
// user-drivable 2D sketch canvas - draw lines/arcs/circles, drag-solve, apply every constraint
// kind through a visible tool, see constraint glyphs + hover/select/delete, watch the DOF chip
// and conflict panel live. Mirrors src/components/model3d/Lab3DView.tsx's pattern (a plain
// <canvas> plus absolutely-positioned HTML overlay panels, all keyed with data-testid so both
// vitest/jsdom component tests and a real-Chromium Playwright script can drive it identically).
//
// The canvas is the single interactive surface: pointer events are converted to WORLD
// coordinates via geometry2d's fixed origin/scale transform (independent of the canvas
// element's own layout size), so the exact same math resolves a click in a real browser and in
// jsdom (whose canvas has a zero-size bounding rect). Canvas 2D drawing itself is best-effort -
// jsdom ships no 2D context backend, so getContext('2d') returns null there and the paint effect
// simply no-ops; every piece of state a test needs to assert on (DOF chip label, conflict panel
// entries, glyph list, selection) is also rendered as plain HTML, never canvas-only.
import { useText } from '../../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  computeConflictPanel,
  computeConstraintGlyphs,
  computeDofChip,
  createSketch3dSolveService,
  deleteConstraintGlyph,
  hoverConstraintGlyph,
  inferLineDrawCandidates,
  commitInferenceCandidate,
  selectConstraintGlyph,
  Sketch3dDragSession,
  type Sketch3dConstraintGlyph,
  type Sketch3dDocument,
  type Sketch3dDrawToolState,
  type Sketch3dEntity,
  type Sketch3dInferenceCandidate,
  type Sketch3dPointRef,
  type Sketch3dSolveResult,
  type Sketch3dSolveService,
  type Sketch3dVec2,
} from '../../sketch3d'
import { applyConstraintFromSelection, EMPTY_SELECTION, SKETCH3DLAB_CONSTRAINT_KINDS, type Sketch3dLabConstraintKind, type Sketch3dLabSelection } from './constraintActions'
import { translateEntity } from './draftEntities'
import { sampleArcPoints, screenToWorld, worldToScreen, SKETCH3DLAB_VIEW } from './geometry2d'
import { addVec2, pickEntity, pickGrabTarget, pickPoint, pointPositionOf, type Sketch3dGrabTarget } from './picking'
// WO SKC-8 (criterion 3, share-do-not-fork): the draw-tool state machine lives ONLY in the
// shared module -- POINTS_NEEDED is grep-able to exactly this one definition.
import { isSketch3dDrawTool, stepDrawTool } from '../sketch3d-shared/drawTool'

export type Sketch3dLabTool = 'select' | 'line' | 'circle' | 'arc' | 'drag'

const DRAW_TOOLS: Sketch3dLabTool[] = ['select', 'line', 'circle', 'arc', 'drag']
const GLYPH_PICK_TOLERANCE = 0.9

function emptyDocument(): Sketch3dDocument {
  return { id: 'sketch3dlab', entities: [], constraints: [] }
}

function pointRefKey(ref: Sketch3dPointRef): string {
  return `${ref.entityId}:${ref.site}`
}

function togglePoint(selection: Sketch3dLabSelection, ref: Sketch3dPointRef): Sketch3dLabSelection {
  const key = pointRefKey(ref)
  const exists = selection.points.some((p) => pointRefKey(p) === key)
  return exists
    ? { ...selection, points: selection.points.filter((p) => pointRefKey(p) !== key) }
    : { ...selection, points: [...selection.points, ref] }
}

function toggleEntity(selection: Sketch3dLabSelection, entityId: string): Sketch3dLabSelection {
  const exists = selection.entities.includes(entityId)
  return exists
    ? { ...selection, entities: selection.entities.filter((e) => e !== entityId) }
    : { ...selection, entities: [...selection.entities, entityId] }
}

declare global {
  interface Window {
    // Test/e2e-only seam (mirrors src/components/model3d/Lab3DView.tsx's __lab3dTestHooks):
    // entity positions move every time a new constraint solves, so a scripted driver (this
    // page's own jsdom component test, or the M2 Playwright demo script) needs the CURRENT
    // document to compute where to click next - never a snapshot of where something was drawn.
    __sketch3dlabTestHooks?: {
      getDocument(): Sketch3dDocument
    }
  }
}

export interface Sketch3dLabPageProps {
  createSolveService?: () => Promise<Sketch3dSolveService>
}

// SKC-H3 (SKC-H1 audit F1, MAJOR): the canvas used to carry fixed width=760/height=620 attributes
// while its wrapper stretched via `inset:0` - for a replaced element like <canvas>, that CSS
// alone loses to the width/height presentational attributes, so the backing store (and its
// rendered box) stayed pinned to 760x620 regardless of the actual viewport, leaving a silent,
// visually-identical dead zone everywhere else in the wrapper. DEFAULT_CANVAS_SIZE is now only
// the pre-layout/no-ResizeObserver fallback (also what jsdom uses, since jsdom implements no
// ResizeObserver global - see the guard in the sizing effect below); a real browser immediately
// overwrites it with the wrapper's observed content-box size, and geometry2d's origin/scale stay
// fixed so existing world coordinates never shift.
const DEFAULT_CANVAS_SIZE = { width: 760, height: 620 }

export function Sketch3dLabPage({ createSolveService = createSketch3dSolveService }: Sketch3dLabPageProps = {}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const solveServiceRef = useRef<Sketch3dSolveService | null>(null)
  const documentRef = useRef<Sketch3dDocument>(emptyDocument())
  const dragSessionRef = useRef<Sketch3dDragSession | null>(null)
  const draggingRef = useRef(false)
  const idCountersRef = useRef<Record<string, number>>({})
  // rAF-coalesced drag (SKC-H2): pointermove during a drag never solves inline - it only
  // overwrites this single slot, and a scheduled animation frame is the ONLY thing that calls
  // Sketch3dDragSession.move(). Any number of moves landing in the same frame (including a slow
  // solve that blocks past the next frame's paint) collapse to exactly one solve+redraw using
  // whatever cursor was most recently queued when the frame fires - latest-cursor-wins.
  const pendingDragCursorRef = useRef<Sketch3dVec2 | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  // WO SKC-8 (A1, Operator's "grab-anywhere" bar): the select tool's own grab-then-drag state,
  // SEPARATE from the pre-existing 'drag' tool's refs above (which stay byte-identical, still
  // exercised by their own rAF-coalescing test suite). A pointerDown in 'select' mode ARMS a
  // grab target (if pickGrabTarget hits something) without starting anything yet -- selection
  // toggling still happens synchronously on the SAME pointerDown, unchanged, so every existing
  // select-tool test (which never fires a pointerMove) sees zero behavior change. Only the FIRST
  // pointerMove after arming actually begins a drag: a point-kind target reuses the exact same
  // Sketch3dDragSession + rAF-coalescing machinery as the 'drag' tool; a body-kind target (a line
  // grabbed away from either endpoint) is a pure kinematic rigid translate, settled with one
  // solve on release.
  const grabArmRef = useRef<{ target: Sketch3dGrabTarget; grabWorld: Sketch3dVec2 } | null>(null)
  const bodyDragRef = useRef<{ entityId: string; grabWorld: Sketch3dVec2 } | null>(null)
  const bodyDragBaseRef = useRef<Sketch3dEntity | null>(null)
  // WO SKC-8-R1 (Blocker 2): the select tool's point-kind drag pins a point INSIDE the solver
  // (Sketch3dDragSession solves the dragged point exactly at whatever cursor it is given), so
  // offset-preservation for THAT path means correcting every cursor value fed to the session by
  // this fixed (pointPosition0 - grabWorld) delta, captured once at arm-transition time (the
  // correction is applied inline via this ref + addVec2). Zero for the standalone 'drag' tool
  // (which still pins exactly at the raw click, its own pre-existing, unchanged behavior).
  const dragCursorOffsetRef = useRef<Sketch3dVec2>({ x: 0, y: 0 })

  const [canvasSize, setCanvasSize] = useState(DEFAULT_CANVAS_SIZE)
  const [status, setStatus] = useState<string>(workbenchText('Sketch3dLabPage.initializingSolver'))
  const [document, setDocument] = useState<Sketch3dDocument>(emptyDocument())
  const [result, setResult] = useState<Sketch3dSolveResult | null>(null)
  const [tool, setTool] = useState<Sketch3dLabTool>('select')
  const [draftPoints, setDraftPoints] = useState<Sketch3dVec2[]>([])
  const [inference, setInference] = useState<{ lineId: string; candidates: Sketch3dInferenceCandidate[] } | null>(null)
  const [selection, setSelection] = useState<Sketch3dLabSelection>(EMPTY_SELECTION)
  const [valueInput, setValueInput] = useState('')
  const [toolError, setToolError] = useState<string | null>(null)
  const [hoveredGlyphId, setHoveredGlyphId] = useState<string | null>(null)
  const [selectedGlyphId, setSelectedGlyphId] = useState<string | null>(null)
  // WO SKC-8-R1 (A3, share-do-not-fork): the FULL hover target (not just a boolean) -- is there
  // something grabbable under the cursor right now, in the select tool, while nothing is
  // currently being dragged, and if so WHICH entity, so the canvas can highlight that specific
  // geometry (not just switch the cursor icon). The audit's exact finding: "both surfaces only
  // expose a boolean cursor affordance, not a highlighted grabbable entity."
  const [hoveredGrabTarget, setHoveredGrabTarget] = useState<Sketch3dGrabTarget | null>(null)

  useEffect(() => {
    window.__sketch3dlabTestHooks = { getDocument: () => documentRef.current }
    return () => {
      delete window.__sketch3dlabTestHooks
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void createSolveService().then((service) => {
      if (cancelled) {
        service.dispose()
        return
      }
      solveServiceRef.current = service
      const initial = service.solve(documentRef.current)
      setResult(initial)
      setStatus(workbenchText('Sketch3dLabPage.ready'))
    })
    return () => {
      cancelled = true
      solveServiceRef.current?.dispose()
      solveServiceRef.current = null
    }
  }, [createSolveService])

  const nextId = useCallback((prefix: string): string => {
    const counters = idCountersRef.current
    counters[prefix] = (counters[prefix] ?? 0) + 1
    return `${prefix}${counters[prefix]}`
  }, [])

  const commitSolve = useCallback((nextDocument: Sketch3dDocument) => {
    const service = solveServiceRef.current
    if (!service) return
    const solveResult = service.solve(nextDocument)
    const settled: Sketch3dDocument = { id: nextDocument.id, entities: solveResult.entities, constraints: nextDocument.constraints }
    documentRef.current = settled
    setDocument(settled)
    setResult(solveResult)
  }, [])

  // Drag steps already ran their own solve inside Sketch3dDragSession - this commits that
  // result directly instead of re-solving (would double the solver work per frame).
  const commitDragResult = useCallback((constraints: Sketch3dDocument['constraints'], dragResult: Sketch3dSolveResult) => {
    const settled: Sketch3dDocument = { id: documentRef.current.id, entities: dragResult.entities, constraints }
    documentRef.current = settled
    setDocument(settled)
    setResult(dragResult)
  }, [])

  // The one and only place that calls Sketch3dDragSession.move() during a drag - see
  // pendingDragCursorRef's comment above.
  const flushDragFrame = useCallback(() => {
    dragFrameRef.current = null
    const cursor = pendingDragCursorRef.current
    pendingDragCursorRef.current = null
    const session = dragSessionRef.current
    if (!cursor || !session?.isActive) return
    const offset = dragCursorOffsetRef.current
    const moveResult = session.move(addVec2(cursor, offset.x, offset.y))
    // SKC-H2-R2 (round-2 audit fix): move() comes back coalesced when a prior slow solve left
    // the session throttled (dragSession.ts:154-160) - it only stashes `cursor` in the
    // session's own pendingCursor without solving. Force it through tick() (a synchronous
    // solve of that stashed cursor) right here, in the SAME frame, rather than leaving it
    // pending: a pointerUp landing before the next animation frame would otherwise find
    // pendingDragCursorRef already null (cleared above) while the session still holds an
    // unsolved cursor, and go straight to end() - dropping the released position.
    const result = moveResult.coalesced ? (session.tick() ?? moveResult) : moveResult
    commitDragResult(documentRef.current.constraints, result)
  }, [commitDragResult])

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
    }
  }, [])

  // WO SKC-8 (Session UX minimum): Escape cancels an in-progress draw draft (the click points
  // collected so far by the line/circle/arc tool), never a completed entity.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') setDraftPoints([])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // SKC-H3: size the canvas's backing store (device px) to its wrapper's actual content box, so
  // the interactive surface always matches what's visually presented - never a fixed constant
  // smaller than the real viewport. Guarded like the codebase's other ResizeObserver call sites
  // (e.g. SimulationPanel.tsx) because jsdom (this repo's test environment) implements no
  // ResizeObserver global at all; there, canvasSize simply stays DEFAULT_CANVAS_SIZE, matching
  // every pre-existing sketch3dlab test's assumptions unchanged.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        setCanvasSize({ width: Math.round(width), height: Math.round(height) })
      }
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const glyphs: Sketch3dConstraintGlyph[] = useMemo(
    () => computeConstraintGlyphs(document, result ?? undefined),
    [document, result],
  )
  const conflictPanel = useMemo(() => (result ? computeConflictPanel(document, result) : null), [document, result])
  const dofChip = useMemo(() => (result ? computeDofChip(result, document.constraints.length > 0) : null), [document, result])

  function worldPointFromEvent(ev: React.PointerEvent<HTMLCanvasElement>): Sketch3dVec2 {
    const rect = ev.currentTarget.getBoundingClientRect()
    return screenToWorld({ x: ev.clientX - rect.left, y: ev.clientY - rect.top })
  }

  function handleDrawClick(worldPoint: Sketch3dVec2): void {
    if (!isSketch3dDrawTool(tool)) return
    const step = stepDrawTool(tool, draftPoints, worldPoint, () => nextId(tool))
    setDraftPoints(step.draftPoints)
    const entity = step.entity
    if (!entity) return
    const nextDocument: Sketch3dDocument = { ...documentRef.current, entities: [...documentRef.current.entities, entity] }

    if (entity.kind === 'line') {
      const toolState: Sketch3dDrawToolState = { suppressInference: false }
      const candidates = inferLineDrawCandidates(nextDocument, entity.id, toolState)
      if (candidates.length > 0) setInference({ lineId: entity.id, candidates })
    }
    commitSolve(nextDocument)
  }

  // Point/entity picks take priority over a glyph hit: many glyph kinds anchor EXACTLY on a
  // point or an entity body (coincident/fixed/midpoint sit ON a point; radius/diameter sit ON
  // the entity's own ring - see constraintGeometry.ts), so a glyph-first order would make those
  // points/entities permanently unreachable for building further constraints once glyphed. A
  // glyph whose anchor isn't shadowed by geometry is still reachable by canvas click; every
  // glyph is always reachable via the constraint list in the side panel (same select/delete
  // plumbing as this click path), which is the reliable way to select an overlapping one.
  function handleSelectClick(worldPoint: Sketch3dVec2): void {
    const point = pickPoint(documentRef.current, worldPoint)
    if (point) {
      setSelection((prev) => togglePoint(prev, point))
      return
    }
    const entityId = pickEntity(documentRef.current, worldPoint)
    if (entityId) {
      setSelection((prev) => toggleEntity(prev, entityId))
      return
    }
    const glyph = selectConstraintGlyph(glyphs, worldPoint, GLYPH_PICK_TOLERANCE)
    if (glyph) setSelectedGlyphId(glyph.constraintId)
  }

  function handlePointerDown(ev: React.PointerEvent<HTMLCanvasElement>): void {
    const worldPoint = worldPointFromEvent(ev)
    if (tool === 'drag') {
      const point = pickPoint(documentRef.current, worldPoint)
      const service = solveServiceRef.current
      if (!point || !service) return
      const session = new Sketch3dDragSession(service, documentRef.current)
      dragSessionRef.current = session
      draggingRef.current = true
      dragCursorOffsetRef.current = { x: 0, y: 0 }
      commitDragResult(documentRef.current.constraints, session.begin(point, worldPoint))
      return
    }
    if (tool === 'select') {
      handleSelectClick(worldPoint)
      // WO SKC-8 (A1): arm a potential grab-anywhere drag WITHOUT starting anything yet -- the
      // selection toggle above already ran synchronously (unchanged), so this is purely additive.
      // A drag only actually begins on the first pointerMove that follows (see handlePointerMove),
      // which is what lets every pre-existing select-tool test (none of which ever moves the
      // pointer between clicks) see zero behavior change.
      const target = pickGrabTarget(documentRef.current, worldPoint)
      grabArmRef.current = target ? { target, grabWorld: worldPoint } : null
      return
    }
    handleDrawClick(worldPoint)
  }

  function handlePointerMove(ev: React.PointerEvent<HTMLCanvasElement>): void {
    const worldPoint = worldPointFromEvent(ev)
    if (tool === 'drag' && draggingRef.current && dragSessionRef.current?.isActive) {
      // rAF-coalesced drag (SKC-H2 criterion 2): never solve inline here - stash the latest
      // cursor and let flushDragFrame (at most one per animation frame) do the one solve+redraw.
      pendingDragCursorRef.current = worldPoint
      if (dragFrameRef.current === null) {
        dragFrameRef.current = requestAnimationFrame(flushDragFrame)
      }
      return
    }
    if (tool === 'select') {
      handleSelectPointerMove(worldPoint)
      return
    }
    const glyph = hoverConstraintGlyph(glyphs, worldPoint, GLYPH_PICK_TOLERANCE)
    setHoveredGlyphId(glyph ? glyph.constraintId : null)
  }

  // WO SKC-8 (A1/A3): the select tool's grab-anywhere drag continuation + hover affordance,
  // split out of handlePointerMove for readability. Exactly 3 states, checked in order: an
  // already-active POINT drag (reuse the 'drag' tool's own rAF-coalescing path verbatim), an
  // already-active BODY drag (direct kinematic translate, no solve until release), or neither --
  // in which case a still-armed grab from this same gesture transitions into one of the above on
  // THIS move, and otherwise this is just a hover query (nothing pressed).
  function handleSelectPointerMove(worldPoint: Sketch3dVec2): void {
    if (draggingRef.current && dragSessionRef.current?.isActive) {
      pendingDragCursorRef.current = worldPoint
      if (dragFrameRef.current === null) {
        dragFrameRef.current = requestAnimationFrame(flushDragFrame)
      }
      return
    }
    const bodyDrag = bodyDragRef.current
    const base = bodyDragBaseRef.current
    if (bodyDrag && base) {
      const dx = worldPoint.x - bodyDrag.grabWorld.x
      const dy = worldPoint.y - bodyDrag.grabWorld.y
      const translated = translateEntity(base, dx, dy)
      const nextDocument: Sketch3dDocument = {
        ...documentRef.current,
        entities: documentRef.current.entities.map((e) => (e.id === bodyDrag.entityId ? translated : e)),
      }
      documentRef.current = nextDocument
      setDocument(nextDocument)
      return
    }
    const armed = grabArmRef.current
    if (armed) {
      grabArmRef.current = null
      if (armed.target.kind === 'point') {
        const service = solveServiceRef.current
        if (service) {
          // WO SKC-8-R1 (Blocker 2): pin the drag session at the point's OWN current position,
          // not the raw click (which for a circle/arc ring grab sits `radius` away on the visible
          // curve, not at the center site pickGrabTarget reports) -- and remember the delta so
          // every later cursor fed into this session (flushDragFrame/handlePointerUp below) gets
          // the same correction, keeping the drag offset-preserving for the whole gesture.
          const grabbedEntity = documentRef.current.entities.find((e) => e.id === armed.target.entityId)
          const pointPosition0 = grabbedEntity ? pointPositionOf(grabbedEntity, armed.target.ref.site) : armed.grabWorld
          dragCursorOffsetRef.current = { x: pointPosition0.x - armed.grabWorld.x, y: pointPosition0.y - armed.grabWorld.y }
          const session = new Sketch3dDragSession(service, documentRef.current)
          dragSessionRef.current = session
          draggingRef.current = true
          commitDragResult(documentRef.current.constraints, session.begin(armed.target.ref, pointPosition0))
          pendingDragCursorRef.current = worldPoint
          if (dragFrameRef.current === null) {
            dragFrameRef.current = requestAnimationFrame(flushDragFrame)
          }
        }
      } else {
        const entity = documentRef.current.entities.find((e) => e.id === armed.target.entityId)
        if (entity) {
          bodyDragBaseRef.current = entity
          bodyDragRef.current = { entityId: armed.target.entityId, grabWorld: armed.grabWorld }
        }
      }
      return
    }
    setHoveredGrabTarget(pickGrabTarget(documentRef.current, worldPoint))
  }

  function handlePointerUp(): void {
    grabArmRef.current = null
    if (bodyDragRef.current) {
      // Body drag (A1/A5): the WHOLE gesture is a single kinematic preview followed by ONE
      // settle solve on release -- mirrors Sketch3dDragSession's own "drop temporaries -> final
      // solve" contract (dragSession.ts's end() doc comment) and, since nothing here ever pushed
      // intermediate history, is naturally the CAM sketcher's "ONE undo step per gesture" too.
      bodyDragRef.current = null
      bodyDragBaseRef.current = null
      commitSolve(documentRef.current)
      return
    }
    const session = dragSessionRef.current
    if (!session?.isActive) return
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
    // Flush a still-queued cursor synchronously so release never commits a stale, pre-frame
    // position (pointerUp can land before the next animation frame fires). session.move() can
    // itself come back coalesced (SKC-H2-R1 audit fix) if the session is still throttled from a
    // prior slow solve - it only stashes the cursor in the session's own pendingCursor without
    // solving in that case.
    if (pendingDragCursorRef.current) {
      const offset = dragCursorOffsetRef.current
      session.move(addVec2(pendingDragCursorRef.current, offset.x, offset.y))
      pendingDragCursorRef.current = null
    }
    // Belt-and-braces (SKC-H2-R2, closes the defect CLASS): tick() is verified as a safe no-op
    // when nothing is pending (dragSession.ts:166-172 returns null immediately without touching
    // state), so calling it unconditionally here flushes ANY coalesced cursor left in the
    // session - whether from the move() just above, or from some future call site that forgets
    // to check `coalesced` itself - before end() reads currentEntities. This is what stops the
    // whole class of "coalesced cursor reaches end() unsolved" bugs, not just this one call site.
    session.tick()
    commitDragResult(documentRef.current.constraints, session.end())
    dragCursorOffsetRef.current = { x: 0, y: 0 }
    dragSessionRef.current = null
    draggingRef.current = false
  }

  function handleAcceptInference(candidate: Sketch3dInferenceCandidate): void {
    const lineId = inference?.lineId
    const nextDocument = commitInferenceCandidate(documentRef.current, candidate)
    commitSolve(nextDocument)
    // Re-offer any OTHER-kind candidate still live after this one (e.g. a line can be both
    // "horizontal" and "coincident at its endpoint" at once) - drop the just-applied kind so the
    // now-redundant geometric fact isn't re-suggested forever.
    const remaining = lineId
      ? inferLineDrawCandidates(documentRef.current, lineId, { suppressInference: false }).filter((c) => c.kind !== candidate.kind)
      : []
    setInference(remaining.length > 0 && lineId ? { lineId, candidates: remaining } : null)
  }

  function handleSkipInference(): void {
    setInference(null)
  }

  function handleApplyConstraint(kind: Sketch3dLabConstraintKind): void {
    const trimmed = valueInput.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    const outcome = applyConstraintFromSelection(kind, documentRef.current, selection, nextId('c'), value)
    if (outcome.error || !outcome.document) {
      setToolError(outcome.error ?? workbenchText('Sketch3dLabPage.unknownConstraintError'))
      return
    }
    setToolError(null)
    setSelection(EMPTY_SELECTION)
    setValueInput('')
    commitSolve(outcome.document)
  }

  function handleClearSelection(): void {
    setSelection(EMPTY_SELECTION)
    setToolError(null)
  }

  function handleDeleteSelectedGlyph(): void {
    if (!selectedGlyphId) return
    const glyph = glyphs.find((g) => g.constraintId === selectedGlyphId)
    if (!glyph) return
    setSelectedGlyphId(null)
    commitSolve(deleteConstraintGlyph(documentRef.current, glyph))
  }

  function handleReset(): void {
    setSelection(EMPTY_SELECTION)
    setInference(null)
    setDraftPoints([])
    setSelectedGlyphId(null)
    setToolError(null)
    idCountersRef.current = {}
    grabArmRef.current = null
    bodyDragRef.current = null
    bodyDragBaseRef.current = null
    dragCursorOffsetRef.current = { x: 0, y: 0 }
    setHoveredGrabTarget(null)
    commitSolve(emptyDocument())
  }

  // Best-effort visual paint - jsdom returns a null 2D context (no canvas backend), so this
  // silently no-ops there; every value a test needs is also rendered as plain HTML below.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#101418'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // WO SKC-8-R1 (A3): a VISIBLE highlight for the hovered grabbable entity -- not just a
    // cursor-icon affordance -- distinct from the selection color so both states stay legible
    // together (hover a not-yet-selected neighbor of a selected entity, say).
    const hoveredEntityId = hoveredGrabTarget?.entityId ?? null
    for (const entity of document.entities) {
      const isSelected = selection.entities.includes(entity.id)
      const isHovered = !isSelected && entity.id === hoveredEntityId
      ctx.lineWidth = isHovered ? 3.5 : 2
      ctx.strokeStyle = isSelected ? '#4fb0ff' : isHovered ? '#ffcf5c' : '#d8e0e8'
      ctx.beginPath()
      if (entity.kind === 'line') {
        const a = worldToScreen(entity.start)
        const b = worldToScreen(entity.end)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      } else if (entity.kind === 'circle') {
        const c = worldToScreen(entity.center)
        ctx.arc(c.x, c.y, entity.radius * SKETCH3DLAB_VIEW.scale, 0, Math.PI * 2)
      } else if (entity.kind === 'arc') {
        // WO SKC-8-R1 (Blocker 3): ctx.arc's own startAngle/endAngle always sweep the
        // NON-NEGATIVE (clockwise-normalized) delta between them, same failure shape as the
        // region-output bug this WO fixes -- a major arc (endAngle < startAngle, see
        // draftEntities.ts's makeArcEntity) would silently render as its complementary minor
        // arc. sampleArcPoints (geometry2d.ts) walks the entity's own stored angles directly, so
        // it stays correct for both; trace that path instead of trusting ctx.arc's sweep math.
        const local = sampleArcPoints(entity)
        local.forEach((p, i) => {
          const s = worldToScreen(p)
          if (i === 0) ctx.moveTo(s.x, s.y)
          else ctx.lineTo(s.x, s.y)
        })
      }
      ctx.stroke()
    }

    for (const p of draftPoints) {
      const s = worldToScreen(p)
      ctx.fillStyle = '#ffd166'
      ctx.beginPath()
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    for (const glyph of glyphs) {
      const s = worldToScreen(glyph.anchor)
      const isHovered = glyph.constraintId === hoveredGlyphId
      const isSelected = glyph.constraintId === selectedGlyphId
      ctx.fillStyle =
        glyph.state === 'conflicting' ? '#ff6b6b' : glyph.state === 'redundant' ? '#ffb703' : isSelected ? '#4fb0ff' : '#8fd694'
      ctx.beginPath()
      ctx.arc(s.x, s.y, isHovered || isSelected ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '10px Consolas, monospace'
      ctx.fillText(glyph.kind, s.x + 6, s.y - 6)
    }
    // SKC-H3: canvasSize is a real paint dependency - a resize changes canvas.width/height (which
    // clears the backing store per HTML canvas semantics) without touching document/glyphs/etc,
    // so without it here a mid-sketch resize would leave the new, larger backing store blank.
  }, [document, draftPoints, glyphs, hoveredGlyphId, selectedGlyphId, selection, canvasSize, hoveredGrabTarget])

  const dofLabel = dofChip ? dofChip.label : 'solving...'
  const dofColor =
    dofChip?.status === 'fully_constrained'
      ? '#8fd694'
      : dofChip?.status === 'conflicting' || dofChip?.status === 'invalid'
        ? '#ff6b6b'
        : dofChip?.status === 'redundant'
          ? '#ffb703'
          : '#d8e0e8'

  return (
    <div
      data-testid="sketch3dlab-root"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        background: '#101418',
        color: '#d8e0e8',
        font: '13px/1.5 Consolas, monospace',
      }}
    >
      <div ref={viewportRef} style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          data-testid="sketch3dlab-canvas"
          width={canvasSize.width}
          height={canvasSize.height}
          // width/height ATTRIBUTES above are the backing store (device px, kept in sync by the
          // ResizeObserver effect); width/height 100% here is what actually stretches a replaced
          // element like <canvas> to fill `inset:0`'s containing block - inset:0 alone does not
          // (SKC-H1 audit F1: the old fixed 760/620 attributes were winning over an
          // over-constrained inset:0 with no CSS width/height of its own).
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // WO SKC-8 (A3): cursor affordance -- grab/grabbing while the select tool is over (or
            // actively holding) grabbable geometry, crosshair while drawing, default otherwise.
            cursor:
              tool === 'select' && (draggingRef.current || bodyDragRef.current)
                ? 'grabbing'
                : tool === 'select' && hoveredGrabTarget !== null
                  ? 'grab'
                  : isSketch3dDrawTool(tool)
                    ? 'crosshair'
                    : 'default',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        <div
          data-testid="sketch3dlab-hover-grabbable"
          style={{ display: 'none' }}
        >
          {String(hoveredGrabTarget !== null)}
        </div>
        {/* WO SKC-8-R1 (A3): the ACTUAL hovered entity id, not just a boolean -- lets a test
         *  assert the highlight state maps to a specific entity, matching the visible canvas
         *  highlight above (empty string when nothing is hovered). */}
        <div
          data-testid="sketch3dlab-hover-grabbable-id"
          style={{ display: 'none' }}
        >
          {hoveredGrabTarget?.entityId ?? ''}
        </div>
        <div
          data-testid="sketch3dlab-status"
          // SKC-H2 (SKC-H1 hitTargetProbe BUG): passive/informational - must never intercept a
          // canvas click. This one spans right:0 across the whole canvas width, so without
          // pointer-events:none it swallowed clicks anywhere along the top strip.
          style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, padding: '6px 10px', background: 'rgba(16,20,24,0.85)', borderBottom: '1px solid #2a3540', pointerEvents: 'none' }}
        >
          {status}
        </div>
        <div
          data-testid="sketch3dlab-tool-toolbar"
          style={{ position: 'absolute', top: 32, left: 0, zIndex: 2, padding: '6px 10px', background: 'rgba(16,20,24,0.85)', display: 'flex', gap: 4 }}
        >
          {DRAW_TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`sketch3dlab-tool-${t}`}
              aria-pressed={tool === t}
              onClick={() => {
                setTool(t)
                setDraftPoints([])
                grabArmRef.current = null
                setHoveredGrabTarget(null)
              }}
              style={{ background: tool === t ? '#2a3540' : 'transparent', color: '#d8e0e8', border: '1px solid #2a3540', padding: '4px 8px', cursor: 'pointer', textTransform: 'capitalize' }}
            >
              {t}
            </button>
          ))}
          <button type="button" data-testid="sketch3dlab-reset" onClick={handleReset} style={{ background: 'transparent', color: '#d8e0e8', border: '1px solid #2a3540', padding: '4px 8px', cursor: 'pointer' }}>
            {workbenchText('Sketch3dLabPage.reset')}</button>
        </div>
        <div
          data-testid="sketch3dlab-counts"
          // SKC-H2 (SKC-H1 hitTargetProbe BUG): passive/informational - must never intercept a
          // canvas click (see sketch3dlab-status's comment above).
          style={{ position: 'absolute', top: 60, left: 0, zIndex: 2, padding: '2px 10px', background: 'rgba(16,20,24,0.85)', color: '#8899a6', pointerEvents: 'none' }}
        >
          {workbenchText('Sketch3dLabPage.entities')}<span data-testid="sketch3dlab-entity-count">{document.entities.length}</span>{workbenchText('Sketch3dLabPage.constraints')}<span data-testid="sketch3dlab-constraint-count">{document.constraints.length}</span>
        </div>

        {inference && (
          <div data-testid="sketch3dlab-inference-panel" style={{ position: 'absolute', top: 64, left: 8, zIndex: 3, background: 'rgba(16,20,24,0.95)', border: '1px solid #2a3540', padding: 8 }}>
            <div>{workbenchText('Sketch3dLabPage.autoConstrainSuggestions')}</div>
            {inference.candidates.map((candidate) => (
              // BK-58: key by the candidate's own constraint id, not `kind` - a drawn line's
              // start AND end sites are each checked independently (endpointCandidates in
              // src/sketch3d/inference.ts), so 2 candidates can share the same kind (e.g.
              // 'coincident' at both ends when closing a loop) while having distinct ids.
              <button
                key={candidate.constraint.id}
                type="button"
                data-testid={`sketch3dlab-infer-${candidate.kind}`}
                onClick={() => handleAcceptInference(candidate)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#8fd694', border: 'none', cursor: 'pointer', padding: '2px 0' }}
              >
                {workbenchText('Sketch3dLabPage.apply', { kind: String((candidate.kind) ?? '') })}</button>
            ))}
            <button type="button" data-testid="sketch3dlab-infer-skip" onClick={handleSkipInference} style={{ background: 'transparent', color: '#d8e0e8', border: 'none', cursor: 'pointer' }}>
              {workbenchText('Sketch3dLabPage.skip')}</button>
          </div>
        )}

        <div
          data-testid="sketch3dlab-dof-chip"
          // SKC-H2 (SKC-H1 hitTargetProbe BUG, sibling decoration): passive/informational -
          // must never intercept a canvas click (see sketch3dlab-status's comment above).
          style={{ position: 'absolute', bottom: 8, left: 8, zIndex: 2, padding: '4px 10px', background: 'rgba(16,20,24,0.9)', border: `1px solid ${dofColor}`, color: dofColor, pointerEvents: 'none' }}
        >
          {dofLabel}
        </div>
      </div>

      <div style={{ width: 320, borderLeft: '1px solid #2a3540', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <div style={{ padding: 8, borderBottom: '1px solid #2a3540' }}>
          <div>{workbenchText('Sketch3dLabPage.constraintTools')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {SKETCH3DLAB_CONSTRAINT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                data-testid={`sketch3dlab-constraint-${kind}`}
                onClick={() => handleApplyConstraint(kind)}
                style={{ background: 'transparent', color: '#d8e0e8', border: '1px solid #2a3540', padding: '3px 6px', cursor: 'pointer', textTransform: 'capitalize' }}
              >
                {kind}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
            <label>
              {workbenchText('Sketch3dLabPage.value')}<input
                data-testid="sketch3dlab-value-input"
                value={valueInput}
                onChange={(ev) => setValueInput(ev.target.value)}
                style={{ width: 70 }}
              />
            </label>
            <button type="button" data-testid="sketch3dlab-clear-selection" onClick={handleClearSelection} style={{ background: 'transparent', color: '#d8e0e8', border: '1px solid #2a3540', cursor: 'pointer' }}>
              {workbenchText('Sketch3dLabPage.clearSelection')}</button>
          </div>
          <div data-testid="sketch3dlab-selection-summary" style={{ marginTop: 4, color: '#8899a6' }}>
            {workbenchText('Sketch3dLabPage.points')}{selection.points.map(pointRefKey).join(', ') || workbenchText('Sketch3dLabPage.none')}{workbenchText('Sketch3dLabPage.entities2')}{selection.entities.join(', ') || workbenchText('Sketch3dLabPage.none')}
          </div>
          {toolError && (
            <div data-testid="sketch3dlab-tool-error" style={{ color: '#ff6b6b', marginTop: 4 }}>
              {toolError}
            </div>
          )}
        </div>

        <div style={{ padding: 8, borderBottom: '1px solid #2a3540' }}>
          <div>{workbenchText('Sketch3dLabPage.constraints2', { length: String((glyphs.length) ?? '') })}</div>
          <button
            type="button"
            data-testid="sketch3dlab-delete-constraint"
            disabled={!selectedGlyphId}
            onClick={handleDeleteSelectedGlyph}
            style={{ margin: '4px 0', background: 'transparent', color: selectedGlyphId ? '#ff6b6b' : '#556', border: '1px solid #2a3540', cursor: selectedGlyphId ? 'pointer' : 'default' }}
          >
            {workbenchText('Sketch3dLabPage.deleteSelectedConstraint')}</button>
          <div data-testid="sketch3dlab-glyph-list">
            {glyphs.map((glyph) => (
              <div
                key={glyph.constraintId}
                data-testid={`sketch3dlab-glyph-${glyph.constraintId}`}
                onMouseEnter={() => setHoveredGlyphId(glyph.constraintId)}
                onMouseLeave={() => setHoveredGlyphId((prev) => (prev === glyph.constraintId ? null : prev))}
                onClick={() => setSelectedGlyphId(glyph.constraintId)}
                style={{
                  padding: '2px 4px',
                  cursor: 'pointer',
                  background: glyph.constraintId === selectedGlyphId ? '#2a3540' : 'transparent',
                  color: glyph.state === 'conflicting' ? '#ff6b6b' : glyph.state === 'redundant' ? '#ffb703' : '#d8e0e8',
                }}
              >{workbenchText('Sketch3dLabPage.combinedundefined', { value1: String((glyph.kind) ?? ''), value2: String((glyph.label) ?? '') })}</div>
            ))}
          </div>
        </div>

        <div style={{ padding: 8 }} data-testid="sketch3dlab-conflict-panel">
          <div>{workbenchText('Sketch3dLabPage.conflictsRedundancies')}</div>
          {conflictPanel?.isEmpty !== false ? (
            <div style={{ color: '#8899a6' }}>{workbenchText('Sketch3dLabPage.none2')}</div>
          ) : (
            <>
              {conflictPanel?.conflicting.map((entry) => (
                <div
                  key={entry.constraintId}
                  data-testid={`sketch3dlab-conflict-${entry.constraintId}`}
                  onClick={() => setSelectedGlyphId(entry.constraintId)}
                  style={{ cursor: 'pointer', color: '#ff6b6b' }}
                >
                  {workbenchText('Sketch3dLabPage.conflict', { label: String((entry.label) ?? '') })}</div>
              ))}
              {conflictPanel?.redundant.map((entry) => (
                <div
                  key={entry.constraintId}
                  data-testid={`sketch3dlab-redundant-${entry.constraintId}`}
                  onClick={() => setSelectedGlyphId(entry.constraintId)}
                  style={{ cursor: 'pointer', color: '#ffb703' }}
                >
                  {workbenchText('Sketch3dLabPage.redundant', { label: String((entry.label) ?? '') })}</div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
