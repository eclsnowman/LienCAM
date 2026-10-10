// WO-2651: THE G-CODE EDITOR - one editor for the two places a user edits a
// program: the Post Process preview and Control > program panel.
//
// Operator ruling, 2026-10-06: "A way to edit the gcodes is a requirement. That's a real
// gap. And we need to make it work well. Edit at post processor stage, or on
// control screen."
//
// How it stays fast on a 100,000-line file: the text lives in ONE native
// textarea (the browser's own caret, selection, typing, IME and clipboard),
// drawn transparent over a coloured copy of only the lines on screen. The line
// numbers and the colouring are virtualised - a 100k-line file renders the
// same ~60 rows as a 60-line one. Undo/redo is the editor's own edit list (one
// span per edit, never a copy of the whole text), so find/replace and
// replace-all undo exactly like typing does.
//
// What it never does: refuse a line (rule 11). Lines the reader cannot run
// arrive as `marks` from the host and are shown with the reader's own message.
//
// NO PERMANENT CHROME (the operator's amendment, 10-06 ~11:00 PM CT: "what I don't
// wanna do is add more UI elements for editing"): there is no toolbar. A
// right-click on a line opens the line menu (the host's own items such as Run
// from here, then Insert line, Find / Replace, Go to line, Undo, Redo); Find /
// Replace and Go to line are small popovers over the text that close again;
// Ctrl+F / Ctrl+H / Ctrl+G / Ctrl+Z / Ctrl+Y reach the same. The position, the
// marks and a read-only reason are chips laid over the text's corners.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { useText } from '../../i18n'
import {
  applyTextEdit,
  findAll,
  gcodeTokens,
  invertTextEdit,
  lineOfOffset,
  mergeTypingEdit,
  offsetOfLine,
  replaceAll,
  textEdit,
  type GcodeLineMark,
  type TextEdit,
} from './gcodeEditing'
import { GcodeLineMenu, type GcodeLineMenuItem } from './GcodeLineMenu'
import './GcodeEditor.css'

/** Row height in px - the textarea and the coloured copy share it. */
export const GCODE_EDITOR_LINE_PX = 18
const PAD_Y = 4
const PAD_X = 8
const OVERSCAN = 20
/** jsdom and a not-yet-laid-out panel report 0; draw a screenful anyway. */
const FALLBACK_VIEW_PX = 600
const TYPING_MERGE_MS = 1000
const HISTORY_LIMIT = 1000
/** Wall-clock ms for typing-merge timing; event handlers only (kept out of render for react-hooks/purity). */
const clockMs = () => Date.now()

/** A request from the host to show a line (a listing row, a mark). `seq`
 *  makes a second request for the same line a new request. */
export interface GcodeEditorJump {
  line: number
  seq: number
}

/** A host's request to open a tool at a line: the find / replace or go-to
 *  popover, or Insert line (a new empty line after `line`, caret on it). */
export interface GcodeEditorToolRequest {
  kind: 'find' | 'goto' | 'insert'
  line?: number
  seq: number
}

/** A host's own entry at the top of the line menu (Control: Run from here). */
export interface GcodeEditorLineAction {
  id: string
  label: string
  onSelect: (line: number) => void
  disabled?: boolean
}

export interface GcodeEditorProps {
  value: string
  onChange?: (text: string) => void
  readOnly?: boolean
  readOnlyReason?: string | null
  marks?: readonly GcodeLineMark[]
  jumpTo?: GcodeEditorJump | null
  tool?: GcodeEditorToolRequest | null
  lineActions?: (line: number) => GcodeEditorLineAction[]
  /** Escape with no popover or menu open (the host may close the editor). */
  onEscape?: () => void
  testId?: string
  /** Height of the whole editor; it fills its parent (flex) when omitted. */
  height?: number | string
}

interface History {
  undo: TextEdit[]
  redo: TextEdit[]
  lastAt: number
}

export function GcodeEditor({
  value,
  onChange,
  readOnly = false,
  readOnlyReason = null,
  marks = [],
  jumpTo = null,
  tool = null,
  lineActions,
  onEscape,
  testId = 'gcode-editor',
  height,
}: GcodeEditorProps) {
  const t = useText('gcode-editor')
  const crlf = value.includes('\r\n')
  const text = useMemo(() => (crlf ? value.replace(/\r\n/g, '\n') : value), [value, crlf])
  const lines = useMemo(() => text.split('\n'), [text])

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const findRef = useRef<HTMLInputElement | null>(null)
  const gotoRef = useRef<HTMLInputElement | null>(null)
  const history = useRef<History>({ undo: [], redo: [], lastAt: 0 })
  const lastEmitted = useRef(text)
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [viewHeight, setViewHeight] = useState(FALLBACK_VIEW_PX)
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [targetLine, setTargetLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchIndex, setMatchIndex] = useState(-1)
  const [findNote, setFindNote] = useState<string | null>(null)
  const [gotoValue, setGotoValue] = useState('')
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 })
  const [popover, setPopover] = useState<'find' | 'goto' | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; line: number } | null>(null)

  // A text the host replaced (a re-post, another program) starts a new history.
  if (text !== lastEmitted.current) {
    lastEmitted.current = text
    history.current = { undo: [], redo: [], lastAt: 0 }
    if (historyDepth.undo !== 0 || historyDepth.redo !== 0) setHistoryDepth({ undo: 0, redo: 0 })
  }

  const matches = useMemo(() => findAll(text, query), [text, query])
  const currentMatch = matchIndex >= 0 && matchIndex < matches.length ? matches[matchIndex] : null
  const currentMatchLine = currentMatch === null ? null : lineOfOffset(text, currentMatch)
  const markedLines = useMemo(() => new Map(marks.filter((m) => m.line > 0).map((m) => [m.line, m.message])), [marks])

  // ---- layout ----
  const viewportRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setViewHeight(el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEW_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const ta = textareaRef.current
    const sel = pendingSelection.current
    if (!ta || !sel) return
    pendingSelection.current = null
    ta.setSelectionRange(sel.start, sel.end)
    updateCaret(sel.start)
  })

  const first = Math.max(0, Math.floor((scroll.top - PAD_Y) / GCODE_EDITOR_LINE_PX) - OVERSCAN)
  const last = Math.min(lines.length, Math.ceil((scroll.top + viewHeight) / GCODE_EDITOR_LINE_PX) + OVERSCAN)
  const gutterChars = Math.max(3, String(lines.length).length)

  // ---- emitting ----
  const emit = (next: string) => {
    lastEmitted.current = next
    onChange?.(crlf ? next.replace(/\n/g, '\r\n') : next)
  }

  const record = (next: string, typing: boolean) => {
    const edit = textEdit(text, next)
    if (!edit) return
    const h = history.current
    const now = clockMs()
    const previous = h.undo[h.undo.length - 1]
    const merged = typing && previous && now - h.lastAt < TYPING_MERGE_MS ? mergeTypingEdit(previous, edit) : null
    if (merged) h.undo[h.undo.length - 1] = merged
    else h.undo.push(edit)
    if (h.undo.length > HISTORY_LIMIT) h.undo.shift()
    h.redo = []
    h.lastAt = typing ? now : 0
    setHistoryDepth({ undo: h.undo.length, redo: 0 })
    emit(next)
  }

  const undo = () => {
    const h = history.current
    // Read-only first: an unavailable Ctrl+Z / Ctrl+Y must not consume history (review 10-07).
    if (readOnly) return
    const edit = h.undo.pop()
    if (!edit) return
    h.redo.push(edit)
    h.lastAt = 0
    const inverse = invertTextEdit(edit)
    pendingSelection.current = { start: inverse.at, end: inverse.at + inverse.inserted.length }
    setHistoryDepth({ undo: h.undo.length, redo: h.redo.length })
    emit(applyTextEdit(text, inverse))
  }

  const redo = () => {
    const h = history.current
    // Read-only first: an unavailable Ctrl+Z / Ctrl+Y must not consume history (review 10-07).
    if (readOnly) return
    const edit = h.redo.pop()
    if (!edit) return
    h.undo.push(edit)
    h.lastAt = 0
    pendingSelection.current = { start: edit.at + edit.inserted.length, end: edit.at + edit.inserted.length }
    setHistoryDepth({ undo: h.undo.length, redo: h.redo.length })
    emit(applyTextEdit(text, edit))
  }

  // ---- moving ----
  const updateCaret = (offset: number) => {
    const line = lineOfOffset(text, offset)
    setCaret({ line, column: offset - offsetOfLine(text, line) + 1 })
  }

  const scrollToLine = (line: number) => {
    const ta = textareaRef.current
    const top = Math.max(0, (line - 1) * GCODE_EDITOR_LINE_PX - viewHeight / 2)
    if (ta) ta.scrollTop = top
    setScroll((s) => ({ top, left: ta ? ta.scrollLeft : s.left }))
  }

  const select = (start: number, end: number, focus: boolean) => {
    const ta = textareaRef.current
    if (ta) {
      if (focus) ta.focus()
      ta.setSelectionRange(start, end)
    }
    scrollToLine(lineOfOffset(text, start))
    updateCaret(start)
  }

  const goToLine = (raw: number, focus = true) => {
    if (!Number.isFinite(raw) || lines.length === 0) return
    const line = Math.min(Math.max(1, Math.round(raw)), lines.length)
    const at = offsetOfLine(text, line)
    setTargetLine(line)
    select(at, at, focus)
  }

  useEffect(() => {
    if (jumpTo) goToLine(jumpTo.line, false)
    // A jump is a one-shot request keyed by its sequence number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.seq])

  /** Insert line: a new empty line after `line`, the caret on it - the inline
   *  field the operator types the new block into. */
  const insertLineAfter = (line: number) => {
    if (readOnly) return
    const after = Math.min(Math.max(0, Math.round(line)), lines.length)
    const at = after === 0 ? 0 : offsetOfLine(text, after + 1) - (after < lines.length ? 1 : 0)
    const insertAt = after >= lines.length ? text.length : at
    const next = after === 0 ? `\n${text}` : `${text.slice(0, insertAt)}\n${text.slice(insertAt)}`
    const caretAt = after === 0 ? 0 : insertAt + 1
    record(next, false)
    pendingSelection.current = { start: caretAt, end: caretAt }
    setTargetLine(after + 1)
    textareaRef.current?.focus()
    scrollToLine(after + 1)
  }

  const openFind = () => {
    const ta = textareaRef.current
    if (ta && ta.selectionEnd > ta.selectionStart && ta.selectionEnd - ta.selectionStart < 200) {
      setQuery(text.slice(ta.selectionStart, ta.selectionEnd))
    }
    setPopover('find')
  }
  const openGoto = (line?: number) => {
    if (line !== undefined) setGotoValue(String(line))
    setPopover('goto')
  }

  useEffect(() => {
    if (!tool) return
    if (tool.kind === 'find') openFind()
    else if (tool.kind === 'goto') openGoto(tool.line)
    else if (tool.line !== undefined) insertLineAfter(tool.line)
    // A tool request is a one-shot keyed by its sequence number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.seq])

  useLayoutEffect(() => {
    if (popover === 'find') { findRef.current?.focus(); findRef.current?.select() }
    if (popover === 'goto') { gotoRef.current?.focus(); gotoRef.current?.select() }
  }, [popover])

  const closePopover = () => {
    setPopover(null)
    textareaRef.current?.focus()
  }

  /** The 1-based line under a pointer event on the text. */
  const lineAtPointer = (clientY: number): number => {
    const ta = textareaRef.current
    const top = ta ? ta.getBoundingClientRect().top : 0
    const y = clientY - top - PAD_Y + (ta?.scrollTop ?? scroll.top)
    return Math.min(Math.max(1, Math.floor(y / GCODE_EDITOR_LINE_PX) + 1), lines.length)
  }

  const menuItems = (line: number): GcodeLineMenuItem[] => [
    ...(lineActions?.(line) ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      disabled: action.disabled,
      onSelect: () => action.onSelect(line),
    })),
    ...(readOnly ? [] : [{ id: 'insert', label: t('menu.insertLine'), onSelect: () => insertLineAfter(line), separated: true }]),
    { id: 'find', label: readOnly ? t('menu.find') : t('menu.findReplace'), onSelect: openFind, separated: readOnly },
    { id: 'goto', label: t('menu.goToLine'), onSelect: () => openGoto(line) },
    ...(readOnly ? [] : [
      { id: 'undo', label: t('menu.undo'), onSelect: undo, disabled: historyDepth.undo === 0, separated: true },
      { id: 'redo', label: t('menu.redo'), onSelect: redo, disabled: historyDepth.redo === 0 },
    ]),
  ]

  // ---- find / replace ----
  const showMatch = (index: number) => {
    if (matches.length === 0) {
      setMatchIndex(-1)
      setFindNote(query === '' ? null : t('editor.noMatches'))
      return
    }
    const wrapped = ((index % matches.length) + matches.length) % matches.length
    setMatchIndex(wrapped)
    setFindNote(null)
    select(matches[wrapped], matches[wrapped] + query.length, false)
  }

  const findFrom = (direction: 1 | -1) => {
    if (matches.length === 0) return showMatch(0)
    if (currentMatch !== null) return showMatch(matchIndex + direction)
    const caretAt = textareaRef.current?.selectionStart ?? 0
    const next = matches.findIndex((m) => m >= caretAt)
    showMatch(direction === 1 ? (next === -1 ? 0 : next) : (next === -1 ? matches.length - 1 : next - 1))
  }

  const replaceCurrent = () => {
    if (readOnly || currentMatch === null) return findFrom(1)
    const next = text.slice(0, currentMatch) + replacement + text.slice(currentMatch + query.length)
    record(next, false)
    const remaining = findAll(next, query)
    const after = remaining.findIndex((m) => m >= currentMatch + replacement.length)
    if (remaining.length === 0) {
      setMatchIndex(-1)
      setFindNote(t('editor.noMatches'))
      return
    }
    const index = after === -1 ? 0 : after
    setMatchIndex(index)
    pendingSelection.current = { start: remaining[index], end: remaining[index] + query.length }
    scrollToLine(lineOfOffset(next, remaining[index]))
  }

  const replaceEvery = () => {
    if (readOnly || query === '') return
    const replaced = replaceAll(text, query, replacement)
    if (replaced.count === 0) {
      setFindNote(t('editor.noMatches'))
      return
    }
    record(replaced.text, false)
    setMatchIndex(-1)
    setFindNote(t('editor.replacedCount', { count: replaced.count }))
  }

  // ---- keys ----
  const onEditorKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo()
    } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault()
      redo()
    } else if (mod && (key === 'f' || key === 'h')) {
      event.preventDefault()
      openFind()
    } else if (mod && key === 'g') {
      event.preventDefault()
      openGoto(caret.line)
    } else if (event.key === 'F3') {
      event.preventDefault()
      findFrom(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape' && !menu) {
      if (popover) {
        event.preventDefault()
        event.stopPropagation()
        closePopover()
      } else if (onEscape) {
        event.preventDefault()
        event.stopPropagation()
        onEscape()
      }
    }
  }

  // ---- drawing ----
  const rows: ReactNode[] = []
  const numbers: ReactNode[] = []
  for (let i = first; i < last; i++) {
    const n = i + 1
    const top = PAD_Y + i * GCODE_EDITOR_LINE_PX - scroll.top
    const mark = markedLines.get(n)
    // The line a right-click menu is open for is marked while it is open.
    const band = n === menu?.line ? 'gce-band-menu'
      : mark !== undefined ? 'gce-band-mark'
      : n === currentMatchLine ? 'gce-band-match'
        : n === targetLine ? 'gce-band-target'
          : n === caret.line ? 'gce-band-caret' : null
    if (band) rows.push(<div key={`b${n}`} className={`gce-band ${band}`} style={{ top }} />)
    rows.push(
      <div key={n} className="gce-row" style={{ top, left: PAD_X - scroll.left }} data-line={n}>
        {gcodeTokens(lines[i]).map((token, k) => (
          <span key={k} className={`gce-t-${token.kind}`}>{token.text}</span>
        ))}
      </div>,
    )
    numbers.push(
      <div
        key={n}
        className={`gce-lineno${mark !== undefined ? ' gce-lineno-mark' : ''}`}
        style={{ top }}
        data-testid={mark !== undefined ? `${testId}-mark-gutter-${n}` : undefined}
        title={mark !== undefined ? t('editor.markTip', { message: mark }) : undefined}
      >
        {mark !== undefined ? '! ' : ''}{n}
      </div>,
    )
  }

  return (
    <div
      className={`gce${readOnly ? ' gce-readonly' : ''}`}
      data-testid={testId}
      style={{ ...(height !== undefined ? { height } : {}), '--gce-line': `${GCODE_EDITOR_LINE_PX}px`, '--gce-pad-x': `${PAD_X}px`, '--gce-pad-y': `${PAD_Y}px` } as CSSProperties}
      onKeyDown={onEditorKey}
    >
      <div className="gce-body">
        <div className="gce-gutter" style={{ width: `calc(${gutterChars + 2}ch + 10px)` }} aria-hidden="true" data-testid={`${testId}-gutter`}>
          {numbers}
        </div>
        <div className="gce-code" ref={viewportRef}>
          <div className="gce-paint" aria-hidden="true" data-testid={`${testId}-paint`}>
            {rows}
          </div>
          {readOnly && readOnlyReason && (
            <div className="gce-chip gce-chip-top" data-testid={`${testId}-readonly-reason`} role="status">{readOnlyReason}</div>
          )}
          {marks.length > 0 && (
            <div className="gce-chip-stack" data-testid={`${testId}-marks`}>
              {marks.map((mark) => (
                <button
                  key={`${mark.line}:${mark.message}`}
                  type="button"
                  className="gce-chip gce-mark"
                  data-testid={`${testId}-mark-${mark.line}`}
                  onClick={() => { if (mark.line > 0) goToLine(mark.line) }}
                >
                  {/* A reader message that already names its line ("Line 11: ...") is shown as it is. */}
                  {mark.line > 0 && /^line \d+\s*:/i.test(mark.message)
                    ? mark.message
                    : mark.line > 0
                    ? t('editor.markedLine', { line: mark.line, message: mark.message })
                    : t('editor.markedProgram', { message: mark.message })}
                </button>
              ))}
            </div>
          )}
          <span className="gce-chip gce-position" data-testid={`${testId}-position`}>
            {readOnly ? `${t('editor.readOnly')} - ` : ''}
            {t('editor.position', { line: caret.line, column: caret.column, lines: (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length).toLocaleString() })}
          </span>
          <textarea
            ref={textareaRef}
            className="gce-text"
            data-testid={`${testId}-text`}
            aria-label={t('editor.label')}
            value={text}
            readOnly={readOnly}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(e) => record(e.target.value, true)}
            onScroll={(e) => {
              const { scrollTop, scrollLeft } = e.currentTarget
              setScroll({ top: scrollTop, left: scrollLeft })
            }}
            onSelect={(e) => updateCaret(e.currentTarget.selectionStart)}
            onClick={() => setTargetLine(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, line: lineAtPointer(e.clientY) })
            }}
          />
          {popover === 'goto' && (
            <div className="gce-popover" data-testid={`${testId}-goto-popover`} role="dialog" aria-label={t('editor.goToLine')}>
              <input
                ref={gotoRef}
                className="mform-input mform-input-sm mform-input-mono gce-goto"
                data-testid={`${testId}-goto`}
                aria-label={t('editor.goToLine')}
                placeholder={t('editor.goToLinePlaceholder')}
                type="text"
                inputMode="numeric"
                value={gotoValue}
                onChange={(e) => setGotoValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    goToLine(Number(gotoValue))
                    setPopover(null)
                  }
                }}
              />
              <button
                className="modal-btn modal-btn-ghost gce-btn"
                data-testid={`${testId}-goto-btn`}
                onClick={() => { goToLine(Number(gotoValue)); setPopover(null) }}
              >
                {t('editor.go')}
              </button>
              <button className="modal-btn modal-btn-ghost gce-btn" aria-label={t('editor.close')} data-testid={`${testId}-popover-close`} onClick={closePopover}>x</button>
            </div>
          )}
          {popover === 'find' && (
            <div className="gce-popover" data-testid={`${testId}-find-popover`} role="dialog" aria-label={t('editor.find')}>
              <input
                ref={findRef}
                className="mform-input mform-input-sm mform-input-mono gce-find"
                data-testid={`${testId}-find`}
                aria-label={t('editor.find')}
                placeholder={t('editor.findPlaceholder')}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setMatchIndex(-1)
                  setFindNote(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    findFrom(e.shiftKey ? -1 : 1)
                  }
                }}
              />
              <button className="modal-btn modal-btn-ghost gce-btn" data-testid={`${testId}-find-prev`} aria-label={t('editor.findPrevious')} onClick={() => findFrom(-1)}>
                {'<'}
              </button>
              <button className="modal-btn modal-btn-ghost gce-btn" data-testid={`${testId}-find-next`} aria-label={t('editor.findNext')} onClick={() => findFrom(1)}>
                {'>'}
              </button>
              {!readOnly && (
                <>
                  <input
                    className="mform-input mform-input-sm mform-input-mono gce-find"
                    data-testid={`${testId}-replace`}
                    aria-label={t('editor.replacePlaceholder')}
                    placeholder={t('editor.replacePlaceholder')}
                    type="text"
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        replaceCurrent()
                      }
                    }}
                  />
                  <button className="modal-btn modal-btn-ghost gce-btn" data-testid={`${testId}-replace-btn`} disabled={query === ''} onClick={replaceCurrent}>
                    {t('editor.replace')}
                  </button>
                  <button className="modal-btn modal-btn-ghost gce-btn" data-testid={`${testId}-replace-all`} disabled={query === ''} onClick={replaceEvery}>
                    {t('editor.replaceAll')}
                  </button>
                </>
              )}
              <span className="gce-note" data-testid={`${testId}-find-note`}>
                {findNote ?? (query === '' ? '' : currentMatch !== null
                  ? t('editor.matchOf', { index: matchIndex + 1, count: matches.length })
                  : matches.length > 0 ? t('editor.matchCount', { count: matches.length }) : t('editor.noMatches'))}
              </span>
              <button className="modal-btn modal-btn-ghost gce-btn" aria-label={t('editor.close')} data-testid={`${testId}-popover-close`} onClick={closePopover}>x</button>
            </div>
          )}
        </div>
      </div>
      {menu && (
        <GcodeLineMenu
          at={{ x: menu.x, y: menu.y }}
          title={t('menu.title', { line: menu.line })}
          items={menuItems(menu.line)}
          onClose={() => setMenu(null)}
          testId={`${testId}-menu`}
        />
      )}
    </div>
  )
}
