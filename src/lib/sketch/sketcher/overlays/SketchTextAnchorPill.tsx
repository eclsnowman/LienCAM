import { useText, textFor } from '../../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useRef } from 'react'
import type { SketcherOverlaysPort } from './port'
import type {
  Sketch, SketchEntity, SketchTextEntity, TextPathAlign,
} from '../../types'
import {
  pathLUT, isSampleablePath, effectiveStartOffsetMm, textEntityAdvanceMm,
  type ArcLengthLUT,
} from '../../textOnPath'

// ON-PATH text ANCHOR PILL (spec T3): a small floating button row [L] [C] [R]
// [F] + Flip + Mirror that hovers under the text while an ON-PATH text entity
// is the SINGLE selected entity (the port's selection) or the open edit target
// (the port's text-edit cursor). Free text, multi-select, at rest: NOT rendered
// (UI placement gate -- nothing new at rest). The buttons drive the id-scoped
// host actions setTextPathAlignById (F keeps the resolved position),
// setTextPathFlipById (flip-SIDE) and setTextMirrorById
// (flip-TEXT / mirrored glyphs, T5b -- free text reaches the same property
// via the toolbox text section instead).
//
// Mirrors SketchDrawValueInput: rendered by <SketcherOverlays/>, positioned per animation
// frame from the viewport's worldToScreen by mutating root.style.transform
// (no per-frame React re-render -- React re-renders only when the target /
// align / flip change). The anchor point is the text's RESOLVED on-path
// midpoint: the same shared helpers render/bake/pick use
// (effectiveStartOffsetMm + textEntityAdvanceMm on the path's arc-length
// LUT), so the pill rides the glyphs through every align mode, flip, path
// edit, pan and zoom.
//
// FOCUS: the pill must never steal the caret from the open WYSIWYG text edit
// (SketchTextInput). Pointer-down on the pill calls preventDefault, so focus
// never leaves the text input and its commit-on-blur cannot fire at all; as
// a second layer, SketchTextInput's blur allowlist (relatedTarget tag check)
// already treats BUTTON targets -- these buttons -- as "adjust while typing",
// not click-away.

interface Props {
  port: SketcherOverlaysPort
}

// Constant screen gap (px) between the text's on-path midpoint and the pill.
const PILL_GAP_PX = 18

const ALIGN_BUTTONS: { mode: TextPathAlign; label: string; hint: string }[] = [
  { mode: 'left', label: 'L', get hint() { return workbenchText('SketchTextAnchorPill.alignToTheStartOfTheCurve') } },
  { mode: 'center', label: 'C', get hint() { return workbenchText('SketchTextAnchorPill.centerOnTheCurve') } },
  { mode: 'right', label: 'R', get hint() { return workbenchText('SketchTextAnchorPill.alignToTheEndOfTheCurve') } },
  { mode: 'free', label: 'F', get hint() { return workbenchText('SketchTextAnchorPill.freeSlideAnywhereAlongTheCurveKeepsTheCurrent') } },
]

/** The on-path text entity the pill targets, or null. EDIT target wins (the
 *  open WYSIWYG edit is the most specific intent); otherwise the SINGLE
 *  selected entity. The path must actually resolve to a sampleable curve --
 *  when it does not, the text renders with the loud free-layout fallback
 *  (resolveTextPath) and alignment has nothing to align to.
 *
 *  WO SKC-14C: takes the four values it always read rather than a store state
 *  object, so the resolution is package-owned and a host supplies only data. */
function pillTargetId(
  isSketch: boolean,
  sketch: { entities: SketchEntity[] } | null,
  textEditId: string | null,
  selectedIds: string[],
): string | null {
  if (!isSketch || !sketch) return null
  const id = textEditId ?? (selectedIds.length === 1 ? selectedIds[0] : null)
  if (!id) return null
  const e = sketch.entities.find((x) => x.id === id)
  if (!e || e.kind !== 'text' || !e.pathId) return null
  const path = sketch.entities.find((x) => x.id === e.pathId)
  return path && path.id !== e.id && isSampleablePath(path) ? id : null
}

/** The targeted entity, or null. Active states are read straight off it (one source of truth; the
 *  pill also targets selected-but-not-editing text, where the host's text-edit mirrors are stale). */
function pillTarget(sketch: Sketch | null, targetId: string | null): SketchTextEntity | null {
  if (!sketch || !targetId) return null
  const e = sketch.entities.find((x) => x.id === targetId)
  return e && e.kind === 'text' ? e : null
}

export function SketchTextAnchorPill({ port }: Props) {
  const workbenchText = useText('sketch-and-model-workbench')
  const isSketch = port.useIsSketchActive()
  const sketch = port.useSketch()
  const textEditId = port.useTextEditId()
  const selectedIds = port.useSelectedIds()
  const targetId = pillTargetId(isSketch, sketch, textEditId, selectedIds)

  // ABSENT pathAlign = legacy pathOffsetMm behavior = F.
  //
  // Derived from the document rather than read through three host selectors, so this component
  // re-renders on every solve instead of only when align/flip/mirror change. The rendered DOM is a
  // pure function of these three values, so nothing a user sees differs; the position is driven by
  // the rAF tick below, not by render. Cheap: six buttons.
  const target = pillTarget(sketch, targetId)
  const align: TextPathAlign = target?.pathAlign ?? 'free'
  const flip: boolean = target?.pathFlip ?? false
  const mirrored: boolean = target?.mirrored ?? false
  const setAlignById = port.setTextPathAlignById
  const setFlipById = port.setTextPathFlipById
  const setMirrorById = port.setTextMirrorById

  const rootRef = useRef<HTMLDivElement>(null)

  // Per-frame position sync (no React re-render). The path LUT + string
  // advance are cached BY ENTITY OBJECT REFERENCE: every solve rewrites the
  // entities array with fresh objects, so a reference match proves the cached
  // value is current and a stale cache is impossible.
  useEffect(() => {
    if (!targetId) return
    let raf = 0
    let cachedPath: SketchEntity | null = null
    let cachedLUT: ArcLengthLUT | null = null
    let cachedText: SketchTextEntity | null = null
    let cachedAdvance = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vp = port.getSurface()
      const root = rootRef.current
      if (!vp || !root) return
      const live = port.getSketch()
      const e = live?.entities.find((x) => x.id === targetId)
      if (!e || e.kind !== 'text' || !e.pathId) return
      const path = live?.entities.find((x) => x.id === e.pathId)
      if (!path) return
      if (path !== cachedPath) {
        cachedPath = path
        cachedLUT = pathLUT(path)
      }
      if (!cachedLUT) return
      if (e !== cachedText) {
        cachedText = e
        cachedAdvance = textEntityAdvanceMm(e)
      }
      // Text midpoint along the path: start offset (shared align resolver)
      // plus half the advance in the walk direction (flip walks s backward).
      const start = effectiveStartOffsetMm(e, cachedLUT, cachedAdvance)
      const dir = (e.pathFlip ?? false) ? -1 : 1
      const mid = cachedLUT.pointAt(start + (dir * cachedAdvance) / 2)
      const screen = vp.worldToScreen(mid.x, mid.y, 0)
      const px = screen.x - root.offsetWidth / 2
      const py = screen.y + PILL_GAP_PX
      root.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [targetId, port])

  if (!targetId) return null

  return (
    <div
      ref={rootRef}
      className="sketch-dim-editor sketch-text-anchor-pill"
      style={{ transform: 'translate(-1000px, -1000px)' }}
      // preventDefault: clicking the pill must NOT move focus (the click
      // still fires) -- the open text edit keeps its caret and its
      // commit-on-blur never runs. stopPropagation: never falls through to
      // the canvas as a pick/deselect.
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {ALIGN_BUTTONS.map(({ mode, label, hint }) => (
        <button
          key={mode}
          type="button"
          className={`sketch-header-toggle${align === mode ? ' sketch-header-toggle-on' : ''}`}
          aria-pressed={align === mode}
          data-tooltip={hint}
          onClick={() => setAlignById(targetId, mode)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        className={`sketch-header-toggle${flip ? ' sketch-header-toggle-on' : ''}`}
        aria-pressed={flip}
        data-tooltip={workbenchText('SketchTextAnchorPill.flipTheTextToTheOtherSideOfThe')}
        onClick={() => setFlipById(targetId, !flip)}
      >
        {workbenchText('SketchTextAnchorPill.flip')}</button>
      {/* Flip-TEXT (T5b): mirror-image the glyphs in place -- independent of
          the flip-SIDE toggle above. The same property is reachable from the
          toolbox text section (free text has no pill). */}
      <button
        type="button"
        className={`sketch-header-toggle${mirrored ? ' sketch-header-toggle-on' : ''}`}
        aria-pressed={mirrored}
        data-tooltip={workbenchText('SketchTextAnchorPill.mirrorTheGlyphsReadsReversedSamePosition')}
        onClick={() => setMirrorById(targetId, !mirrored)}
      >
        {workbenchText('SketchTextAnchorPill.mirror')}</button>
    </div>
  )
}
