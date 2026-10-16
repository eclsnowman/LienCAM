// @vitest-environment jsdom
//
// WO-2651: THE G-CODE EDITOR - one editor for the Post Process preview and
// Control > program panel. Operator ruling, 2026-10-06: "A way to edit the gcodes is a
// requirement. That's a real gap. And we need to make it work well."
//
// Proven here on the rendered component: typing reaches the host, undo/redo
// replay it (typing and replace-all alike), find/replace and go-to-line move
// the caret, the reader's marks show with its own message, read-only says why,
// a CRLF file stays CRLF, and a 100,000-line file opens and scrolls inside the
// test budget because only the rows on screen are drawn. Then the Post Process
// screen, rendered: the unedited preview and download are main's (pin); an M0
// added after a chosen line is in the downloaded bytes and in what Send to
// Control hands Control; a re-post under hand edits asks to keep them or
// re-post; a line the reader cannot run is marked, never refused.

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project, Setup } from '../../types'
import { makeTool, makeOp, makeWcs, makeMachine, makeStock, stampGenerationCurrent } from '../post/helpers'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')
const { takeProgramForControl } = await import('../../components/gcode/editedProgram')
import { GcodeEditor, GCODE_EDITOR_LINE_PX, type GcodeEditorJump } from '../../components/gcode/GcodeEditor'
import {
  describeLineChanges,
  gcodeTokens,
  lineChanges,
  readerMarks,
  withoutContextStamp,
  type ChangeWords,
  type GcodeLineMark,
} from '../../components/gcode/gcodeEditing'

afterEach(cleanup)

const WORDS: ChangeWords = {
  added: (count, after) => `${count} added after ${after}`,
  addedAtStart: (count) => `${count} added at start`,
  removed: (count, from) => `${count} removed from ${from}`,
  replacedOne: (line) => `line ${line} changed`,
  replaced: (from, to, count) => `${from}-${to} replaced by ${count}`,
  several: (changed, places) => `${changed} in ${places}`,
  none: () => 'none',
}

function program(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `G1 X${i} Y${i % 7} F600`).join('\n')
}

function Host(props: {
  initial: string
  readOnly?: boolean
  reason?: string
  marks?: GcodeLineMark[]
  onText?: (text: string) => void
  jump?: GcodeEditorJump | null
}) {
  const [text, setText] = useState(props.initial)
  return (
    <>
      <GcodeEditor
        value={text}
        onChange={(next) => { setText(next); props.onText?.(next) }}
        readOnly={props.readOnly}
        readOnlyReason={props.reason}
        marks={props.marks}
        jumpTo={props.jump}
        testId="ed"
      />
      <output data-testid="host-text">{text}</output>
    </>
  )
}

const area = () => screen.getByTestId('ed-text') as HTMLTextAreaElement
const hostText = () => screen.getByTestId('host-text').textContent
/** Right-click line `line` of the editor's text (rows are GCODE_EDITOR_LINE_PX tall, 4 px padding). */
const rightClickLine = (line: number) =>
  fireEvent.contextMenu(area(), { clientX: 40, clientY: 4 + (line - 1) * GCODE_EDITOR_LINE_PX + 5 })
const menuItem = (id: string) => screen.getByTestId(`ed-menu-${id}`) as HTMLButtonElement

describe('WO-2651: what changed, in words', () => {
  it('names an inserted M0 by the original line it follows', () => {
    const before = program(300)
    const lines = before.split('\n')
    lines.splice(240, 0, 'M0')
    const changes = lineChanges(before, lines.join('\n'))
    expect(changes).toMatchObject({ added: 1, removed: 0, changed: 1, coarse: false })
    expect(describeLineChanges(changes, WORDS)).toBe('1 added after 240')
  })

  it('names a removal, a one-line change, a span and several places', () => {
    const before = program(20)
    const lines = before.split('\n')
    expect(describeLineChanges(lineChanges(before, lines.filter((_, i) => i !== 4).join('\n')), WORDS)).toBe('1 removed from 5')
    const changed = [...lines]
    changed[9] = 'G0 Z5'
    expect(describeLineChanges(lineChanges(before, changed.join('\n')), WORDS)).toBe('line 10 changed')
    const twoPlaces = [...lines]
    twoPlaces[2] = 'M0'
    twoPlaces[15] = 'M1'
    expect(describeLineChanges(lineChanges(before, twoPlaces.join('\n')), WORDS)).toBe('2 in 2')
    expect(describeLineChanges(lineChanges(before, `M0\n${before}`), WORDS)).toBe('1 added at start')
    expect(describeLineChanges(lineChanges(before, before), WORDS)).toBe('none')
  })

  it('colours every character exactly once', () => {
    const line = 'N10 G1 X1.5 Y-2 F600 (cut) M3 S12000 T2 ; tail'
    const tokens = gcodeTokens(line)
    expect(tokens.map((tk) => tk.text).join('')).toBe(line)
    expect(tokens.find((tk) => tk.text === 'G1')?.kind).toBe('g')
    expect(tokens.find((tk) => tk.text === 'M3')?.kind).toBe('m')
    expect(tokens.find((tk) => tk.text === '(cut)')?.kind).toBe('comment')
    expect(tokens.at(-1)).toEqual({ text: '; tail', kind: 'comment' })
  })

  it('marks the line the shared reader stops at, in its own words, and nothing in a clean file', () => {
    expect(readerMarks('G21 G90\nG0 X0 Y0\nM0\nG1 X1 F100\nM30', null)).toEqual([])
    const marks = readerMarks('G21 G90\nG0 X0 Y0\nG1 X1 F100\nQQQ\nM30', null)
    expect(marks).toHaveLength(1)
    expect(marks[0].line).toBe(4)
    expect(marks[0].message.length).toBeGreaterThan(0)
  })
})

describe('WO-2651: the editor', () => {
  it('types into the host, and undo / redo replay it (buttons and keys)', () => {
    const seen: string[] = []
    render(<Host initial={'G0 X0\nG1 X1 F100\nM30'} onText={(t) => seen.push(t)} />)
    fireEvent.change(area(), { target: { value: 'G0 X0\nG1 X1 F100\nM0\nM30' } })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM0\nM30')
    expect(seen).toHaveLength(1)

    rightClickLine(2)
    fireEvent.click(menuItem('undo'))
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM30')
    rightClickLine(2)
    fireEvent.click(menuItem('redo'))
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM0\nM30')
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM30')
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true, shiftKey: true })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM0\nM30')
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    fireEvent.keyDown(area(), { key: 'y', ctrlKey: true })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM0\nM30')
  })

  it('finds, replaces one, replaces all, and undoes a replace-all in one step', () => {
    render(<Host initial={'G1 X1 F100\nG1 X2 F100\nG1 X3 F100'} />)
    expect(screen.queryByTestId('ed-find-popover')).toBeNull()
    fireEvent.keyDown(area(), { key: 'h', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('ed-find'))
    fireEvent.change(screen.getByTestId('ed-find'), { target: { value: 'f100' } })
    expect(screen.getByTestId('ed-find-note').textContent).toBe('3 matches')
    fireEvent.click(screen.getByTestId('ed-find-next'))
    expect(screen.getByTestId('ed-find-note').textContent).toBe('1 of 3')
    expect(area().selectionStart).toBe(6)
    expect(area().selectionEnd).toBe(10)
    fireEvent.click(screen.getByTestId('ed-find-next'))
    expect(screen.getByTestId('ed-find-note').textContent).toBe('2 of 3')

    fireEvent.change(screen.getByTestId('ed-replace'), { target: { value: 'F250' } })
    fireEvent.click(screen.getByTestId('ed-replace-btn'))
    expect(hostText()).toBe('G1 X1 F100\nG1 X2 F250\nG1 X3 F100')

    fireEvent.click(screen.getByTestId('ed-replace-all'))
    expect(hostText()).toBe('G1 X1 F250\nG1 X2 F250\nG1 X3 F250')
    expect(screen.getByTestId('ed-find-note').textContent).toBe('Replaced 2')

    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe('G1 X1 F100\nG1 X2 F250\nG1 X3 F100')
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe('G1 X1 F100\nG1 X2 F100\nG1 X3 F100')

    fireEvent.change(screen.getByTestId('ed-find'), { target: { value: 'G4' } })
    fireEvent.click(screen.getByTestId('ed-find-next'))
    expect(screen.getByTestId('ed-find-note').textContent).toBe('No matches')
    // Escape closes the popover; nothing of it stays on screen.
    fireEvent.keyDown(screen.getByTestId('ed-find'), { key: 'Escape' })
    expect(screen.queryByTestId('ed-find-popover')).toBeNull()
  })

  it('goes to a line: caret at its start, the position readout and the row on screen', () => {
    render(<Host initial={program(500)} />)
    fireEvent.keyDown(area(), { key: 'g', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('ed-goto'))
    fireEvent.change(screen.getByTestId('ed-goto'), { target: { value: '321' } })
    fireEvent.click(screen.getByTestId('ed-goto-btn'))
    expect(screen.queryByTestId('ed-goto-popover')).toBeNull()
    const text = hostText()!
    const start = text.split('\n').slice(0, 320).join('\n').length + 1
    expect(area().selectionStart).toBe(start)
    expect(screen.getByTestId('ed-position').textContent).toContain('Ln 321, Col 1')
    expect(screen.getByTestId('ed-gutter').textContent).toContain('321')
    // The line menu's Go to line opens the same popover at the clicked line.
    rightClickLine(3)
    fireEvent.click(menuItem('goto'))
    expect((screen.getByTestId('ed-goto') as HTMLInputElement).value).toBe(String(3 + Math.floor(area().scrollTop / GCODE_EDITOR_LINE_PX)))
  })

  it('right-click a line -> Insert line: a new line after it, caret on it, typing fills it, one undo removes it', () => {
    render(<Host initial={'G0 X0\nG1 X1 F100\nG1 X2\nM30'} />)
    rightClickLine(2)
    expect(screen.getByTestId('ed-menu').getAttribute('aria-label')).toBe('Line 2')
    fireEvent.click(menuItem('insert'))
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\n\nG1 X2\nM30')
    expect(area().selectionStart).toBe('G0 X0\nG1 X1 F100\n'.length)
    expect(screen.getByTestId('ed-position').textContent).toContain('Ln 3, Col 1')
    fireEvent.change(area(), { target: { value: 'G0 X0\nG1 X1 F100\nM0\nG1 X2\nM30' } })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nM0\nG1 X2\nM30')
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe('G0 X0\nG1 X1 F100\nG1 X2\nM30')
  })

  it("puts the host's own line action first in the menu (Control: Run from here)", () => {
    const ran: number[] = []
    render(
      <GcodeEditor
        value={program(20)}
        testId="ed"
        lineActions={(line) => [{ id: 'run-from', label: 'Run from here', onSelect: () => ran.push(line) }]}
      />,
    )
    rightClickLine(7)
    const items = [...screen.getByTestId('ed-menu').querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(items).toEqual(['Run from here', 'Insert line', 'Find / Replace', 'Go to line', 'Undo', 'Redo'])
    fireEvent.click(menuItem('run-from'))
    expect(ran).toEqual([7])
    expect(screen.queryByTestId('ed-menu')).toBeNull()
  })

  it('adds no permanent editing chrome: no toolbar, no buttons, nothing but the text until a menu or popover opens', () => {
    render(<Host initial={program(50)} />)
    const editor = screen.getByTestId('ed')
    expect(editor.querySelector('[role="toolbar"]')).toBeNull()
    expect(editor.querySelectorAll('button, input')).toHaveLength(0)
  })

  it("follows the host's jump to a listing line", () => {
    const { rerender } = render(<Host initial={program(400)} jump={null} />)
    rerender(<Host initial={program(400)} jump={{ line: 250, seq: 1 }} />)
    expect(screen.getByTestId('ed-position').textContent).toContain('Ln 250, Col 1')
  })

  it("shows a marked line with the reader's message, in the gutter and above the text", () => {
    render(<Host initial={program(30)} marks={[{ line: 12, message: 'Unknown word QQQ' }]} />)
    expect(screen.getByTestId('ed-mark-12').textContent).toBe('Line 12: Unknown word QQQ')
    expect(screen.getByTestId('ed-mark-gutter-12').getAttribute('title')).toContain('Unknown word QQQ')
    fireEvent.click(screen.getByTestId('ed-mark-12'))
    expect(screen.getByTestId('ed-position').textContent).toContain('Ln 12, Col 1')
  })

  it('a reader message that already names its line is not prefixed twice (capture, 10-06)', () => {
    render(<Host initial={program(30)} marks={[{ line: 11, message: 'Line 11: G38.2 probes toward the named point' }]} />)
    expect(screen.getByTestId('ed-mark-11').textContent).toBe('Line 11: G38.2 probes toward the named point')
  })

  it('a Ctrl+Z pressed while read-only keeps the staged edit undoable once editable again (review 10-07)', () => {
    const initial = 'G0 X0\nG1 X1 F100\nM30'
    const edited = 'G0 X0\nG1 X1 F100\nM0\nM30'
    const view = render(<Host initial={initial} />)
    fireEvent.change(area(), { target: { value: edited } })
    view.rerender(<Host initial={initial} readOnly />)
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe(edited)
    view.rerender(<Host initial={initial} />)
    fireEvent.keyDown(area(), { key: 'z', ctrlKey: true })
    expect(hostText()).toBe(initial)
  })

  it('read-only says why, offers no replace or undo, and the text cannot change', () => {
    render(<Host initial={program(10)} readOnly reason="Stop the program to edit it." />)
    expect(screen.getByTestId('ed-readonly-reason').textContent).toBe('Stop the program to edit it.')
    expect(area().readOnly).toBe(true)
    fireEvent.keyDown(area(), { key: 'f', ctrlKey: true })
    expect(screen.getByTestId('ed-find')).toBeTruthy()
    expect(screen.queryByTestId('ed-replace')).toBeNull()
    rightClickLine(1)
    const items = [...screen.getByTestId('ed-menu').querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(items).toEqual(['Find', 'Go to line'])
    expect(screen.getByTestId('ed-position').textContent).toContain('Read-only')
  })

  it('keeps a CRLF file CRLF', () => {
    render(<Host initial={'G0 X0\r\nG1 X1 F100\r\nM30\r\n'} />)
    expect(area().value).toBe('G0 X0\nG1 X1 F100\nM30\n')
    fireEvent.change(area(), { target: { value: 'G0 X0\nG1 X1 F100\nM0\nM30\n' } })
    expect(hostText()).toBe('G0 X0\r\nG1 X1 F100\r\nM0\r\nM30\r\n')
  })

  it('opens and scrolls a 100,000-line file in budget, drawing only the rows on screen', () => {
    const big = program(100_000)
    const opened = performance.now()
    render(<Host initial={big} />)
    const openMs = performance.now() - opened
    const rows = () => screen.getByTestId('ed-paint').querySelectorAll('.gce-row')
    expect(rows().length).toBeLessThan(120)
    expect(screen.getByTestId('ed-position').textContent).toContain('100,000 lines')

    const scrolled = performance.now()
    act(() => {
      area().scrollTop = 50_000 * GCODE_EDITOR_LINE_PX
      fireEvent.scroll(area())
    })
    const scrollMs = performance.now() - scrolled
    const shown = [...rows()].map((row) => Number(row.getAttribute('data-line')))
    expect(shown).toContain(50_001)
    expect(rows().length).toBeLessThan(120)
    expect(rows()[0].textContent).toMatch(/^G1 X\d+ Y\d F600$/)

    // Typing one line into the middle of it stays inside the budget too.
    const typed = performance.now()
    const lines = big.split('\n')
    lines.splice(50_000, 0, 'M0')
    fireEvent.change(area(), { target: { value: lines.join('\n') } })
    const typeMs = performance.now() - typed
    expect(hostText()!.split('\n')).toHaveLength(100_001)

    expect(openMs).toBeLessThan(3000)
    expect(scrollMs).toBeLessThan(500)
    expect(typeMs).toBeLessThan(1000)
  })
})

// ---- the Post Process screen (production entry point: the rendered modal) ----

describe('WO-2651: editing at the Post Process screen', () => {
  const saved: Array<{ name: string; text: string }> = []

  beforeEach(() => {
    saved.length = 0
    ;(globalThis as { liencamHost?: unknown }).liencamHost = {
      saveFile: async (name: string, data: string | Uint8Array) => {
        saved.push({ name, text: typeof data === 'string' ? data : new TextDecoder().decode(data) })
        return name
      },
    }
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.getState().setWorkspace('cam')
      const tool = makeTool()
      const op = makeOp({ toolId: tool.id })
      const setup = { id: 'setup-1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), operations: [op], notes: '' }
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      const project = { ...s.project, name: 'EditProject', machine: makeMachine(), setups: [setup] }
      stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, op, tool)
      useCamStore.setState({ project, toolLibrary: [tool], consoleEvents: [], consoleReadThroughId: 0 } as never)
    })
    takeProgramForControl()
  })

  afterEach(() => {
    delete (globalThis as { liencamHost?: unknown }).liencamHost
  })

  const postConsole = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'post').map((e) => e.message)
  const editorText = () => screen.getByTestId('post-gcode-editor-text') as HTMLTextAreaElement
  const withM0After = (text: string, line: number) => {
    const lines = text.split('\n')
    lines.splice(line, 0, 'M0')
    return lines.join('\n')
  }

  function open() {
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })
  }

  it('unedited: the preview is the read-only posted text and Export writes exactly it (pin)', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    expect(posted.length).toBeGreaterThan(0)
    expect(screen.queryByTestId('post-gcode-editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Export \.nc/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    // Main's own behaviour, unchanged: Export re-posts, and the only bytes a
    // re-post changes are the context block's stamp (generatedAt, checksum).
    expect(withoutContextStamp(saved[0].text)).toBe(withoutContextStamp(posted))
    expect(postConsole().join('\n')).not.toContain('hand edits')
  })

  it('M0 added after a chosen line: the screen says so, and the downloaded file has it', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    expect(editorText().value).toBe(posted)
    const edited = withM0After(posted, 5)
    fireEvent.change(editorText(), { target: { value: edited } })
    expect(screen.getByTestId('post-hand-edited').textContent).toContain('Hand-edited: 1 line added after line 5')
    // Amendment item 6: the notice sits in the preview head, never a row above the editor.
    expect(screen.getByTestId('post-hand-edited').closest('.preview-head')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Export \.nc/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].text).toBe(edited)
    expect(saved[0].text.split('\n')[5]).toBe('M0')
    expect(postConsole().join('\n')).toContain('with hand edits: 1 line added after line 5')
  })

  it('header and editor count the edited buffer alike; an edited mark is not hidden behind a green "assembled cleanly" (review 10-07)', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    const postedCount = posted.replace(/\n$/, '').split('\n').length
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const linesIn = (s: string) => Number(/([\d,]+) lines/.exec(s)![1].replace(/,/g, ''))
    const header = () => linesIn(document.querySelector('.preview-head .lib-meta')!.textContent!)
    const editorCount = () => linesIn(screen.getByTestId('post-gcode-editor-position').textContent!)
    expect(header()).toBe(postedCount)
    expect(editorCount()).toBe(postedCount)
    fireEvent.change(editorText(), { target: { value: withM0After(withM0After(posted, 5), 3).replace('M0', 'G38.2 Z-5 F100') } })
    expect(header()).toBe(postedCount + 2)
    expect(editorCount()).toBe(postedCount + 2)
    await waitFor(() => expect(screen.getByTestId('post-edited-marks-diag').textContent).toMatch(/Edited program: \d+ marked line/))
    expect(screen.queryByText('No diagnostics. Program assembled cleanly.')).toBeNull()
  })

  it('Send to Control carries the edited text to Control and opens it', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const edited = withM0After(posted, 7)
    fireEvent.change(editorText(), { target: { value: edited } })
    fireEvent.click(screen.getByTestId('post-send-to-control'))
    await waitFor(() => expect(useCamStore.getState().workspace).toBe('control'))
    expect(useCamStore.getState().activeModal).not.toBe('post-process')
    const sent = takeProgramForControl()
    expect(sent?.text).toBe(edited)
    expect(sent?.name).toMatch(/\.nc$/)
    expect(postConsole().join('\n')).toContain('hand-edited: 1 line added after line 7')
  })

  it('a re-post under hand edits asks: keep them, or re-post - never drops them silently', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const edited = withM0After(posted, 5)
    fireEvent.change(editorText(), { target: { value: edited } })

    // A post setting changes under the edit: export units mm -> inch.
    const units = (value: 'mm' | 'inch') => {
      if (!screen.queryByTestId('post-export-units')) fireEvent.click(screen.getByTestId('disclosure-output-format'))
      fireEvent.click(screen.getByTestId('post-export-units').querySelector(`input[value="${value}"]`)!)
    }
    units('inch')
    expect(screen.getByTestId('post-stale-edits').textContent).toContain('Re-posting replaces your hand edits')
    expect(screen.getByTestId('post-stale-edits').closest('.preview-head')).not.toBeNull()
    expect(editorText().value).toBe(edited)

    fireEvent.click(screen.getByTestId('post-keep-edits'))
    expect(screen.queryByTestId('post-stale-edits')).toBeNull()
    expect(editorText().value).toBe(edited)
    expect(screen.getByTestId('post-hand-edited')).toBeTruthy()

    units('mm')
    expect(screen.getByTestId('post-stale-edits')).toBeTruthy()
    fireEvent.click(screen.getByTestId('post-repost'))
    expect(screen.queryByTestId('post-stale-edits')).toBeNull()
    expect(screen.queryByTestId('post-hand-edited')).toBeNull()
    // Re-post: back to the read-only preview of the new post, edits gone.
    const reposted = screen.getByTestId('post-gcode-preview').textContent!
    expect(reposted).toContain('G21')
    expect(withoutContextStamp(reposted)).toBe(withoutContextStamp(posted))
  })

  it("marks a line the reader cannot run with the reader's message, and still exports it (rule 11)", async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const lines = posted.split('\n')
    lines.splice(4, 0, 'QQQ')
    fireEvent.change(editorText(), { target: { value: lines.join('\n') } })
    await waitFor(() => expect(screen.getByTestId('post-gcode-editor-mark-5').textContent).toMatch(/^Line 5: /))
    fireEvent.click(screen.getByRole('button', { name: /Export \.nc/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].text.split('\n')[4]).toBe('QQQ')
  })

  it('separate files: an edit stays with its setup when the output scope changes; it never exports as another setup (review 10-07)', async () => {
    act(() => {
      const state = useCamStore.getState()
      const a = state.project.setups[0]
      const op = makeOp({ id: 'op-b', name: 'Operation B' })
      const b = { ...a, id: 'setup-b', name: 'Setup B', wcs: makeWcs({ id: 'w-b', label: 'G55', fixtureOffset: 55 }), operations: [op] }
      const project = { ...state.project, setups: [a, b] }
      stampGenerationCurrent({ ...project, toolLibrary: state.toolLibrary } as unknown as Project, b as unknown as Setup, op, state.toolLibrary[0])
      useCamStore.setState({ project: project as unknown as Project })
    })
    open()
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[1])
    fireEvent.click(screen.getByRole('button', { name: /Separate files/i }))
    const first = screen.getByTestId('post-gcode-preview').textContent!
    expect(first).toContain('G54')
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const edited = withM0After(first, 5)
    fireEvent.change(editorText(), { target: { value: edited } })
    // WO-2862: the master box mirrors its setups, so unticking setup A alone
    // leaves only setup B in scope.
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[0])
    expect(Array.from(document.querySelectorAll('.scope-setup-cb')).map((cb) => (cb as HTMLInputElement).checked)).toEqual([false, true])
    fireEvent.click(screen.getByRole('button', { name: /Export/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toMatch(/G55[.]nc$/)
    expect(saved[0].text).toContain('G55')
    expect(saved[0].text).not.toBe(edited)
  })

  it('separate files: a project rename keeps the hand edit in Export (review 10-07, third)', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Separate files/i }))
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const edited = withM0After(posted, 5)
    fireEvent.change(editorText(), { target: { value: edited } })
    act(() => { useCamStore.getState().closeModal() })
    act(() => { useCamStore.getState().updateProjectMeta({ name: 'RenamedProject' }) })
    act(() => { useCamStore.getState().openModal('post-process') })
    fireEvent.click(screen.getByRole('button', { name: /Export/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toMatch(/^RenamedProject/)
    expect(saved[0].text.includes('M0')).toBe(true)
    expect(saved[0].text).not.toBe(posted)
  })

  it('a combined hand edit belongs to its project: New Project exports its own program (review 10-07, fourth)', async () => {
    open()
    const posted = screen.getByTestId('post-gcode-preview').textContent!
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    const edited = withM0After(posted, 5)
    fireEvent.change(editorText(), { target: { value: edited } })
    const oldId = useCamStore.getState().project.id
    act(() => { useCamStore.getState().closeModal() })
    act(() => { useCamStore.getState().newProject() })
    act(() => {
      const state = useCamStore.getState()
      const tool = makeTool()
      const op = makeOp({ id: 'op-new', name: 'New project operation', toolId: tool.id })
      const setup = { id: 'setup-new', name: 'New setup', wcs: makeWcs({ id: 'w-new', label: 'G55', fixtureOffset: 55 }), stock: makeStock(), operations: [op], notes: '' }
      const project = { ...state.project, name: 'NewProject', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
      stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, op, tool)
      useCamStore.setState({ project, toolLibrary: [tool] } as never)
    })
    expect(useCamStore.getState().project.id).not.toBe(oldId)
    act(() => { useCamStore.getState().openModal('post-process') })
    fireEvent.click(screen.getByRole('button', { name: /Export/i }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].text).toContain('G55')
    expect(saved[0].text).toContain('New project operation')
    expect(saved[0].text).not.toBe(edited)
  })
})
