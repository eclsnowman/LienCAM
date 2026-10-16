import { useText } from '../../../../i18n'
import { useEffect, useRef } from 'react'
import type { SketcherOverlaySurface, SketcherOverlaysPort } from './port'

// WYSIWYG in-canvas text entry (Operator: "wysiwyg typing in the workspace would
// be best"; then: "having a text box floating, and the real text appearing next
// to each other is confusing ... why have a second box"). A KEYSTROKE-CAPTURING
// but VISUALLY INVISIBLE DOM <input> anchored to the text entity's baseline-left
// origin (worldToScreen(entity.at)), shown while a text entity is being PLACED
// or EDITED (port.useTextEditId() != null). The input has NO border / NO
// background / transparent text + transparent caret and a ~2px footprint, so it
// is never seen: it exists ONLY to receive focus + keystrokes. What the user
// types is pushed LIVE onto the entity (port.setTextValue ->
// applyTextEditPatch) so the REAL glyphs render/grow in place in the sketch
// layer -- that live-rendered text is the SINGLE WYSIWYG surface (no duplicate
// visible box). The sketch layer tints the entity whose id is the edit target
// (cyan glow) as the active-edit indicator so the user knows typing is live.
// The visible INSERTION CARET is drawn by the sketch layer too (M1b): this
// component mirrors the DOM caret (selectionStart) through
// port.setTextCaretIndex, and the layer renders a white caret tick through
// the same layout pipeline as the glyphs (textCaretWorldSegment) -- on the
// curve for on-path text, at the anchor+rotation for free text.
// Enter / click-away COMMITS (port.commitTextEdit); Esc routes to
// port.cancelTextEdit. The HOST owns the semantics: on a fresh placement,
// Esc with typed text COMMITS (typed work is never silently destroyed) and an
// empty placement -- Esc or empty commit -- is removed WITH a status-bar
// notice (never a silent no-op); editing EXISTING text, Esc reverts to the
// pre-edit entity. Every one of those transitions mutates the document AND the
// undo stack, which is why they stayed with the host (SKC-14B inventory row 9).
//
// Mirrors SketchDrawValueInput: rendered by <SketcherOverlays/>, positioned by
// the surface's worldToScreen per animation frame (so it tracks pan/zoom without
// a React re-render), and it stops pointer-down propagation so clicking the
// field never falls through to the canvas.

interface Props {
  port: SketcherOverlaysPort
}

// Approx px height per world-mm at the current zoom, so the in-canvas font
// reads roughly in-place. Uses two worldToScreen probes 1mm apart in Y.
function screenPxPerMm(vp: SketcherOverlaySurface): number {
  const a = vp.worldToScreen(0, 0, 0)
  const b = vp.worldToScreen(0, 1, 0)
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function SketchTextInput({ port }: Props) {
  const workbenchText = useText('sketch-and-model-workbench')
  const isSketch = port.useIsSketchActive()
  const editId = port.useTextEditId()
  // The LIVE entity string drives the controlled input: typing mutates the
  // entity, the entity re-renders on canvas, and this field re-renders in
  // lockstep -- one source of truth (WYSIWYG).
  const text = port.useTextDraft()
  // Height/rotation feed the field's visual sizing so it reads in-place.
  const setValue = port.setTextValue
  const setCaretIndex = port.setTextCaretIndex
  const commit = port.commitTextEdit
  const cancel = port.cancelTextEdit

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const active = isSketch && !!editId

  // Push the DOM caret (selectionStart) to the host so the sketch layer can
  // draw the IN-CANVAS caret (M1b: this input is invisible, so the canvas
  // caret is the only one the user sees). Wired on change/select/keyup/click/
  // focus -- everything that can move the DOM caret; the host action dedupes
  // unchanged values so the fan-out stays cheap.
  const syncCaret = () => {
    const input = inputRef.current
    if (!input) return
    setCaretIndex(input.selectionStart)
  }

  // Auto-focus the in-canvas input the moment an edit opens (placement or
  // double-click) so the user types immediately, in the workspace.
  useEffect(() => {
    if (!active) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    const n = input.value.length
    input.setSelectionRange(n, n)
    // Push the placed DOM caret to the host immediately: the focus event
    // fires BEFORE setSelectionRange above, so its sync may have read a
    // stale selectionStart (browser-dependent). This keeps the in-canvas
    // caret honest from the very first frame of the edit.
    setCaretIndex(n)
  }, [active, editId, setCaretIndex])

  // Per-frame position + size sync at the entity anchor (tracks pan/zoom)
  // WITHOUT a React re-render. Reads the current edited entity each frame so a
  // rotation/height change from the toolbox restyles the box live.
  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vp = port.getSurface()
      const root = rootRef.current
      const input = inputRef.current
      if (!vp || !root || !input) return
      const id = port.getTextEditId()
      const e = id ? port.getSketch()?.entities.find((x) => x.id === id) : null
      if (!e || e.kind !== 'text') return
      const screen = vp.worldToScreen(e.at.x, e.at.y, 0)
      // Sit the box just above the baseline anchor (glyphs grow upward from the
      // baseline in world Y; screen Y grows downward, so offset up by ~height).
      const px = screenPxPerMm(vp) * e.height
      const clamped = Math.max(11, Math.min(px, 48))
      input.style.fontSize = `${clamped.toFixed(1)}px`
      root.style.transform =
        `translate(${screen.x.toFixed(1)}px, ${(screen.y - clamped - 4).toFixed(1)}px)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [active, port])

  if (!active) return null

  return (
    <div
      ref={rootRef}
      className="sketch-text-editor"
      style={{ transform: 'translate(-1000px, -1000px)' }}
    >
      <input
        ref={inputRef}
        className="sketch-text-input"
        type="text"
        value={text}
        spellCheck={false}
        aria-label={workbenchText('SketchTextInput.sketchText')}
        // VISUALLY INVISIBLE: no border, no background, transparent glyphs AND
        // transparent caret, ~2px footprint. The input captures focus + keys
        // only; the user sees ONLY the real cyan-tinted text in the sketch
        // layer (single WYSIWYG surface -- no second visible box). Inline so
        // the invisibility is assertable in the render smoke test (jsdom does
        // not apply app.css).
        style={{
          border: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'transparent',
          padding: 0,
          width: '2px',
          minWidth: '2px',
          outline: 'none',
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          setValue(e.target.value)
          syncCaret() // typing moved the insertion point with it
        }}
        onSelect={syncCaret}
        onKeyUp={syncCaret} // arrow keys / Home / End land here
        onClick={syncCaret}
        onFocus={syncCaret}
        onBlur={(e) => {
          // Click-away COMMITS -- but moving focus to a TOOLBOX control
          // (height / angle / font, all <input>/<select>/<button>) must NOT
          // end the edit; those are legitimate "adjust while typing" paths.
          // The same tag allowlist covers the on-canvas ANCHOR PILL's
          // buttons (SketchTextAnchorPill: align + flip) -- though the pill
          // also preventDefault()s its pointer-down so focus normally never
          // leaves this input at all (this branch is the fallback for
          // keyboard/Tab focus travel).
          const next = e.relatedTarget as HTMLElement | null
          if (
            next && (
              next.tagName === 'INPUT' ||
              next.tagName === 'SELECT' ||
              next.tagName === 'BUTTON' ||
              next.tagName === 'TEXTAREA' ||
              next.isContentEditable
            )
          ) return
          commit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            inputRef.current?.blur() // blur (relatedTarget null) -> commit
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // May COMMIT (fresh placement with typed text) or cancel -- the
            // host owns it. Either way the edit id is null afterwards,
            // so the blur this unmount can fire finds no open edit and
            // commit() no-ops (no double commit, no fight with the cancel).
            cancel()
          }
        }}
      />
    </div>
  )
}
