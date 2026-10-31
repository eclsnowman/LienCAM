import type { PostConfig } from './types'

// Conservative RS274 range also accepted by GRBL (whose upper limit is larger).
// Labels may repeat after rollover; they are not physical operation-span indices.
const LAST = 99999
// RS274 allows spaces/tabs anywhere outside comments, including within an N
// label, and parameter assignments may immediately follow that label.
const AUTHORED_NUMBER = /^[ \t]*(?:\/[ \t]*)?N((?:[ \t]*\d)+(?:[ \t]*\.(?:[ \t]*\d)+)?)(?=[ \t\rA-Za-z(#;/]|$)/i

/** Final format pass shared by built-in, user and vendor posts. Context is
 * appended AFTER this pass: its private comments keep their certified lengths
 * and its digest is bound to the actual numbered program. No lines are added
 * or removed, so the emitter's physical operation spans remain authoritative. */
export function sequenceNumberLines(lines: string[], config: PostConfig): string[] {
  if (!config.format.lineNumbers) return lines
  const configured = config.format.lineNumberStep
  // WO-3132 rollback: vendor imports already started at their increment.
  // Preserve that convention (including the legacy zero/missing fallback 10);
  // the newly working built-in/user switch starts at N10 with modal fallback 5.
  const vendor = Boolean(config.options.vendorPost)
  const step = Number.isInteger(configured) && configured >= 1 && configured <= 1000 ? configured : vendor ? 10 : 5
  const first = vendor ? step : 10
  // Never replace an authored label or generate another copy of it: custom
  // framing/macros may refer to those labels. Existing words stay byte-for-byte.
  const reserved = new Set(lines.flatMap(line => line.split('\n').flatMap(block => {
    const match = AUTHORED_NUMBER.exec(block)
    return match ? [Number(match[1].replace(/[ \t]/g, ''))] : []
  })))
  let next = first
  const advance = () => { next = next + step > LAST ? first : next + step }
  return lines.map(line => line.replace(/[^\n]+/g, block => {
    if (!block.trim() || block.trim() === '%' || AUTHORED_NUMBER.test(block)) return block
    for (let tries = 0; reserved.has(next); tries++) {
      // A custom program can reserve the entire range. Keep such blocks valid
      // and unnumbered rather than overwriting a jump target or refusing export.
      if (tries >= reserved.size) return block
      advance()
    }
    const number = next
    advance()
    // RS274 block-delete slash precedes the optional N word.
    const slash = /^[ \t]*\/[ \t]*/.exec(block)?.[0] ?? ''
    return `${slash}N${number} ${block.slice(slash.length)}`
  }))
}
