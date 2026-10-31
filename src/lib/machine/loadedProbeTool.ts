/**
 * WO-2157: THE SPINDLE STAYS OFF WHILE A PROBE TOOL IS THE LOADED TOOL - AND ONLY THEN.
 *
 * Operator ruling 2026-09-28: "Using a tool as a probe still should not spin the spindle
 * while probing... but don't accidently make it so I cannot use an endmill
 * because I probed with it." So the one question every spindle-on route asks
 * is "is the tool in the spindle RIGHT NOW a tool-library entry of type Probe?"
 * - read fresh at the moment of the request, never remembered. An end mill that
 * touched off a moment ago is an end mill; nothing here holds a flag, a latch
 * or a "probed recently" state.
 *
 * A LEAF MODULE: pure functions over the active tool number, the library and
 * the G-code text. machineSession supplies the live facts.
 */
import type { Tool } from '../../types'

/**
 * The library entry for the tool in the spindle - the same answer the Probing
 * screen gives (ProbingPanel's activeToolFromLibrary, WO-1634/WO-2105): the one
 * entry with that T-number, and among duplicates the one whose diameter is the
 * machine's tool table's for that T. Never a guess.
 */
export function libraryToolForActive(
  activeTool: number | null,
  toolLibrary: readonly Tool[],
  tableDiaMm: number | null = null,
): Tool | null {
  if (activeTool === null) return null
  const matches = toolLibrary.filter((tool) => tool.toolNumber === activeTool)
  if (matches.length === 1) return matches[0]
  if (tableDiaMm === null || !(tableDiaMm > 0)) return null
  return matches.find((tool) => Math.abs(tool.diameter - tableDiaMm) < 0.001) ?? null
}

/** The loaded tool when it is a Probe-type library entry, else null. */
export function loadedProbeTool(
  activeTool: number | null,
  toolLibrary: readonly Tool[],
  tableDiaMm: number | null = null,
): Tool | null {
  const tool = libraryToolForActive(activeTool, toolLibrary, tableDiaMm)
  return tool !== null && tool.type === 'probe' ? tool : null
}

/** The one console line every route says, e.g.
 *  "Spindle not started: T19 TP05C probe is a probe." */
export function probeSpindleRefusal(probe: Pick<Tool, 'name' | 'toolNumber'>): string {
  const number = probe.toolNumber === undefined ? '' : `T${probe.toolNumber} `
  return `Spindle not started: ${number}${probe.name} is a probe.`
}

/** The index ranges of a raw line that are G-code, not comment: parentheses
 *  and everything after `;` are skipped. */
function codeSpans(raw: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let start = 0
  let inParen = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inParen) {
      if (ch === ')') {
        inParen = false
        start = i + 1
      }
      continue
    }
    if (ch === '(') {
      if (i > start) spans.push([start, i])
      inParen = true
      continue
    }
    if (ch === ';') {
      if (i > start) spans.push([start, i])
      return spans
    }
  }
  if (!inParen && raw.length > start) spans.push([start, raw.length])
  return spans
}

const SPINDLE_START_WORD = /M\s*0*[34](?![0-9.])/gi
const SPEED_WORD = /S\s*[-+]?(?:\d+\.?\d*|\.\d+)/gi
const TOOL_WORD = /T\s*(\d+)(?![0-9.])/i
const TOOL_CHANGE_WORD = /M\s*0*6(?![0-9.])/i

// Immutable source-line facts only. Active tool/probe answers remain live.
const sourceCode = new Map<string, string>()
function codeOf(raw: string): string {
  const cached = sourceCode.get(raw)
  if (cached !== undefined) return cached
  const code = codeSpans(raw).map(([from, to]) => raw.slice(from, to)).join(' ')
  if (sourceCode.size >= 32768) sourceCode.delete(sourceCode.keys().next().value!)
  sourceCode.set(raw, code)
  return code
}

/** Does this line carry an M3 or M4? (Not M30, M40, M03.5.) */
export function lineStartsSpindle(raw: string): boolean {
  SPINDLE_START_WORD.lastIndex = 0
  return SPINDLE_START_WORD.test(codeOf(raw))
}

/** The line with its M3/M4 words removed (and its S words too when `speed`),
 *  comments untouched. Everything else on the line is kept as written. */
export function withoutSpindleStart(raw: string, options: { speed?: boolean } = {}): string {
  let out = ''
  let at = 0
  for (const [from, to] of codeSpans(raw)) {
    out += raw.slice(at, from)
    let code = raw.slice(from, to).replace(SPINDLE_START_WORD, '')
    if (options.speed) code = code.replace(SPEED_WORD, '')
    out += code
    at = to
  }
  out += raw.slice(at)
  return out
}

/** True when nothing but line numbers and whitespace is left to run. */
export function lineIsEmptyCode(raw: string): boolean {
  return codeOf(raw).replace(/N\s*\d+/gi, '').trim() === ''
}

/**
 * A text program as the controller should run it: every M3/M4 that the file
 * reaches while the tool in effect is a probe is removed from its line (the
 * line and its other words stay, so line numbers and speeds are unchanged).
 * The tool in effect starts as the loaded tool and becomes `Tn` at each M6.
 *
 * `raw` is read for T and M6 (a staged copy may have turned an M6 into a hold);
 * `staged` is what gets the words removed. `probeFor` answers the library
 * question for a tool number. Lines before `fromLine` (1-based) are not sent
 * and are copied as they are. `kept` lists the (1-based) lines changed.
 */
export function keepSpindleOffForProbe(
  raw: readonly string[],
  staged: readonly string[],
  startTool: number | null,
  probeFor: (tool: number | null) => Tool | null,
  fromLine = 1,
): { lines: string[]; probe: Tool | null; kept: number[] } {
  let tool = startTool
  let selected = startTool
  let first: Tool | null = null
  const kept: number[] = []
  const lines = staged.map((line, index) => {
    if (index + 1 < fromLine) return line
    const code = codeOf(raw[index] ?? line)
    const select = TOOL_WORD.exec(code)
    if (select) selected = Number(select[1])
    if (TOOL_CHANGE_WORD.test(code)) tool = selected
    SPINDLE_START_WORD.lastIndex = 0
    if (!SPINDLE_START_WORD.test(code)) return line
    const probe = probeFor(tool)
    if (probe === null) return line
    first ??= probe
    kept.push(index + 1)
    return withoutSpindleStart(line)
  })
  return { lines, probe: first, kept }
}
