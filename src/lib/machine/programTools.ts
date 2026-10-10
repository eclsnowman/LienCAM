// programTools - which tools a loaded G-code program calls, and the diameter
// the program itself states for each (WO-1978).
//
// Operator ruling 2026-09-25: loading a program on the Control tab should put every tool
// it calls in the tool table, ready to measure. A tool is CALLED by a T word in
// the code (T19 M6, or a bare T19 on a machine that selects tools that way) -
// never by a comment. A diameter is read from what the post wrote in a comment:
// Fusion and most posts write '(T19 D=3.15 CR=0. - ZMIN=-6.45 - flat end mill)'
// in the header and '(... D=3.15 ...)' on the T line itself.
//
// Pure module: text in, facts out. The table write lives in
// machineToolTableStore (`fillToolTableFromProgram`).

import { stripGcodeComments } from '../gcode/text'

export interface ProgramToolCall {
  /** T number the code selects (>= 1). */
  tool: number
  /** Diameter in MILLIMETRES as the program states it, or null when it says
   *  nothing about this tool. */
  dia: number | null
}

const INCH_MM = 25.4

/** Diameter spellings posts write in a tool comment. Tried in order; the
 *  first that matches a line wins. `D=3.15` (Fusion, most posts), `DIA=6`,
 *  `DIAMETER: 6`, Mastercam's `TOOL DIA. - .25`. */
const DIA_PATTERNS: RegExp[] = [
  /(?:^|[\s(|,;])D(?:IA(?:METER)?)?\s*[=:]\s*(\d*\.?\d+)/i,
  /TOOL\s+DIA\.?\s*-\s*(\d*\.?\d+)/i,
]

function statedDiameter(text: string): number | null {
  for (const pattern of DIA_PATTERNS) {
    const m = pattern.exec(text)
    if (m) {
      const value = Number(m[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return null
}

/** Everything on the raw line that is NOT code: the parenthesised and ';'
 *  comments. A comment may itself contain parentheses (Fusion writes
 *  `1/8"(.1250")` inside one), so this takes from the first '(' or ';' to the
 *  end of the line rather than trusting the pairs. */
function commentText(raw: string): string {
  const paren = raw.indexOf('(')
  const semi = raw.indexOf(';')
  const starts = [paren, semi].filter((i) => i >= 0)
  return starts.length === 0 ? '' : raw.slice(Math.min(...starts))
}

/** The program's length unit, from the first G20/G21 in the code. Posts state
 *  tool diameters in program units; the tool table holds millimetres. */
function programIsInches(lines: string[]): boolean {
  for (const raw of lines) {
    const m = /(?:^|[^0-9.])G(2[01])(?![0-9.])/i.exec(stripGcodeComments(raw))
    if (m) return m[1] === '20'
  }
  return false
}

/**
 * Every tool the program calls, in the order it first calls them, each with
 * the diameter the program states for it (null when it states none). T0 is
 * "no tool" on every controller that knows the word, so it is not a tool to
 * measure and is not returned.
 */
export function programToolCalls(text: string): ProgramToolCall[] {
  const lines = text.split(/\r?\n/)
  const scale = programIsInches(lines) ? INCH_MM : 1
  const called: number[] = []
  const stated = new Map<number, number>()
  for (const raw of lines) {
    const code = stripGcodeComments(raw)
    const tWord = /(?:^|[^A-Z])T\s*(\d+)(?![0-9.])/i.exec(code)
    const codeTool = tWord ? Number(tWord[1]) : null
    if (codeTool !== null && codeTool > 0 && !called.includes(codeTool)) called.push(codeTool)
    const comment = commentText(raw)
    if (!comment) continue
    const dia = statedDiameter(comment)
    if (dia === null) continue
    // The tool a stated diameter belongs to: the one this line's code calls,
    // else the one the comment itself names ('(T19 D=3.15 ...)').
    const named = /(?:^|[^A-Z])T\s*(\d+)(?![0-9.])/i.exec(comment)
    const owner = codeTool ?? (named ? Number(named[1]) : null)
    if (owner === null || owner <= 0 || stated.has(owner)) continue
    stated.set(owner, Number((dia * scale).toFixed(4)))
  }
  return called.map((tool) => ({ tool, dia: stated.get(tool) ?? null }))
}
