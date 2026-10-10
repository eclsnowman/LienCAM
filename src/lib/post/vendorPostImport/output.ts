import type { PostConfig, PostInput } from '../types'
import { resolveCoolantWord, resolveVacuum } from '../resolve'
import { fmtNum } from '../format'

/** A lines-only vendor post can still post a ready operation containing arcs.
 * Subdivide in canonical mm before the existing unit/coordinate formatter.
 * R posts split explicit full circles, since one R block has no unique centre. */
export function vendorPostInput(input: PostInput, config: PostConfig): PostInput {
  if (!config.options.vendorPost || (config.capabilities.arcs && config.capabilities.arcCenterMode !== 'r')) return input
  return { ...input, setup: { ...input.setup, operations: input.setup.operations.map((op) => {
    let previous: typeof op.moves[number] | undefined
    const moves = op.moves.flatMap((move) => {
      const start = previous
      previous = move
      if (!start || (move.type !== 'arc_cw' && move.type !== 'arc_ccw') || move.cx === undefined || move.cy === undefined) return [move]
      const radius = Math.hypot(start.x - move.cx, start.y - move.cy)
      const from = Math.atan2(start.y - move.cy, start.x - move.cx)
      const to = Math.atan2(move.y - move.cy, move.x - move.cx)
      const direction = move.type === 'arc_cw' ? -1 : 1
      const sweep = ((direction * (to - from) + Math.PI * 2) % (Math.PI * 2)) || Math.PI * 2
      const tolerance = Number(config.options.arcTolerance ?? 0.05)
      const step = config.capabilities.arcs ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - Math.max(0.0001, tolerance) / Math.max(radius, 0.0001)))
      const count = Math.max(1, Math.ceil(sweep / Math.max(0.001, step)))
      return Array.from({ length: count }, (_, index) => {
        const fraction = (index + 1) / count
        const angle = from + direction * sweep * fraction
        return {
          ...move,
          type: config.capabilities.arcs ? move.type : 'feed' as const,
          x: index === count - 1 ? move.x : move.cx! + radius * Math.cos(angle),
          y: index === count - 1 ? move.y : move.cy! + radius * Math.sin(angle),
          z: start.z + (move.z - start.z) * fraction,
          dwellMs: index === count - 1 ? move.dwellMs : undefined,
        }
      })
    })
    return { ...op, moves }
  }) } }
}

/** Both public posting routes use this seam. Framing stays verbatim; generated
 * spindle/accessory words are translated once, without changing any motion or
 * tool/coolant state in emitSetupSection (WO-1650 and multi-setup incidents). */
export function vendorOutputLines(lines: string[], config: PostConfig, inputs: readonly PostInput[]): string[] {
  if (!config.options.vendorPost) return lines
  const substitutions = new Map<string, string>()
  for (const [word, key] of [['M3', 'vendorSpindleCW'], ['M4', 'vendorSpindleCCW'], ['M5', 'vendorSpindleStop'], ['M9', 'vendorCoolantOff']]) {
    const replacement = config.options[key]
    if (typeof replacement === 'string' && /^M\d+$/.test(replacement)) substitutions.set(word, replacement)
  }
  for (const input of inputs) {
    for (const [role, key] of [['flood', 'vendorCoolantFlood'], ['mist', 'vendorCoolantMist']] as const) {
      const word = resolveCoolantWord(input.machine, role)
      const replacement = config.options[key]
      // A shared word cannot be rewritten for coolant without also rewriting
      // the independently requested vacuum channel. Keep the machine meaning.
      if (word && word !== resolveVacuum(input.machine) && typeof replacement === 'string' && /^M\d+$/.test(replacement)) substitutions.set(word, replacement)
    }
  }
  const endLines = config.options.programEndMode === 'custom'
    ? String(config.options.programEndCustom ?? '').split('\n').filter((line) => line.trim()).length : 0
  let sequence = 0
  let x = 0
  let y = 0
  let motion = ''
  return lines.map((line, index) => {
    const body = index >= config.framing.programStart.length && index < lines.length - endLines
    let translated = body ? line.replace(/^M\d+(?=\s+S[\d.]|$)/, (word) => substitutions.get(word) ?? word) : line
    if (body && !/^[;(]/.test(line.trim())) {
      const mode = /\bG([0123])\b/.exec(line)
      if (mode) motion = `G${mode[1]}`
      const value = (letter: string): number | undefined => {
        const match = new RegExp(`\\b${letter}(-?\\d+(?:\\.\\d+)?)`).exec(line)
        return match ? Number(match[1]) : undefined
      }
      const endX = value('X') ?? x
      const endY = value('Y') ?? y
      const i = value('I')
      const j = value('J')
      if (config.capabilities.arcCenterMode === 'r' && (motion === 'G2' || motion === 'G3') && i !== undefined && j !== undefined) {
        const from = Math.atan2(-j, -i)
        const to = Math.atan2(endY - y - j, endX - x - i)
        const sweep = ((motion === 'G2' ? from - to : to - from) + Math.PI * 2) % (Math.PI * 2)
        const radius = Math.hypot(i, j) * (sweep > Math.PI + 1e-7 ? -1 : 1)
        translated = translated.replace(/\bI-?\d+(?:\.\d+)?\s+J-?\d+(?:\.\d+)?/, `R${fmtNum(radius, config.format.xyzDecimals)}`)
      }
      x = endX; y = endY
    }
    if (config.format.lineNumbers && translated.trim() && translated.trim() !== '%') {
      sequence += config.format.lineNumberStep || 10
      translated = `N${sequence} ${translated}`
    }
    return translated
  })
}
