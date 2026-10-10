import { setFraming, setVendorWord, type VendorReader } from './index'
import { balanced, splitArguments, unquote } from './text'

// Independently written for LienCAM. The PureCutCNC adapter informed the
// callback/format idioms; no Lua interpreter or vendor runtime is involved.
const luaTokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(=*)\[[\s\S]*?\]\1\]|\b(?:function|if|for|while|do|repeat|until|end)\b/g

function cleanLua(source: string): string {
  return source.replace(/\r\n?/g, '\n').replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|\[(=*)\[[\s\S]*?\]\2\]/g,
    token => token.startsWith('--') ? token.replace(/[^\n]/g, ' ') : token)
}

/** Balanced callback boundaries, including nested loops and long strings.
 * Last definition wins, as it does in Lua. Keywords in strings are inert. */
function callbacks(text: string): Map<string, string> {
  const result = new Map<string, string>()
  const code = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(=*)\[[\s\S]*?\]\1\]/g,
    token => token.replace(/[^\n]/g, ' '))
  for (const match of code.matchAll(/\bfunction\s+(On\w+)\s*\([^)]*\)/g)) {
    const start = match.index! + match[0].length
    let depth = 1
    let loopDo = 0
    for (const token of text.slice(start).matchAll(luaTokens)) {
      const word = token[0]
      if (word === 'end' || word === 'until') depth--
      else if (word === 'for' || word === 'while') { depth++; loopDo++ }
      else if (word === 'do' && loopDo) loopDo--
      else if (['function', 'if', 'repeat', 'do'].includes(word)) depth++
      if (!depth) { result.set(match[1], text.slice(start, start + token.index!)); break }
    }
  }
  return result
}

/** Preserve offsets while removing procedural branches from framing. Reading
 * their literal output as unconditional would emit both sides of a unit test. */
function directBody(body: string): string {
  let depth = 0
  let loopDo = 0
  let start = 0
  const ranges: [number, number][] = []
  for (const token of body.matchAll(luaTokens)) {
    const word = token[0]
    if (['function', 'if', 'for', 'while', 'repeat', 'do'].includes(word)) {
      if (word === 'do' && loopDo) { loopDo--; continue }
      if (!depth) start = token.index!
      depth++
      if (word === 'for' || word === 'while') loopDo++
    } else if ((word === 'end' || word === 'until') && depth && !--depth) {
      // repeat's condition is procedural too, through the end of its line.
      const end = word === 'until' ? body.indexOf('\n', token.index!) : token.index! + word.length
      ranges.push([start, end < 0 ? body.length : end])
    }
  }
  if (depth) ranges.push([start, body.length])
  return ranges.reduceRight((text, [from, to]) => text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to), body)
}

function calls(body: string): { method: string; args: string[] }[] {
  const result: { method: string; args: string[] }[] = []
  // Scan past strings as a whole, so a string containing post.Text is data.
  const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(=*)\[[\s\S]*?\]\1\]|\b([\w.:]+)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    if (!match[2]) continue
    const start = match.index + match[0].length - 1
    const args = balanced(body, start, '(', ')')
    if (match[2].startsWith('post.')) result.push({ method: match[2].slice(5), args: splitArguments(args) })
    pattern.lastIndex = start + args.length + 2
  }
  return result
}

export function sheetcamName(source: string): string {
  return /^\s*(?:postName|description)\s*=\s*["']([^"']+)/im.exec(cleanLua(source))?.[1] ?? ''
}

export function readSheetcam(source: string, reader: VendorReader): boolean {
  const text = cleanLua(source)
  const blocks = callbacks(text)
  if (!['OnInit', 'OnMove', 'OnRapid', 'OnFinish', 'OnToolChange'].some(name => blocks.has(name))) return false
  const { config } = reader
  const body = (name: string) => blocks.get(name) ?? ''
  const unit = /^\s*units\s*=\s*["'](mm|inch|in)["']/im.exec(text)?.[1]?.toLowerCase()
  if (unit) { config.format.units = unit === 'mm' ? 'mm' : 'inch'; reader.carry('units', config.format.units) }
  for (const [prefix, field] of [['X', 'coordinate decimals'], ['F', 'feed decimals']] as const) {
    const call = calls(body('OnMove')).find(call => /^(?:Non)?(?:Modal)?Number$/.test(call.method) && unquote(call.args[0] ?? '')?.trim() === prefix)
    const format = unquote(call?.args[2] ?? '')
    if (format && /^[0#]+(?:\.[0#]+)?$/.test(format)) {
      const decimals = format.split('.')[1]?.length ?? 0
      if (decimals <= 8) {
        config.format[field === 'coordinate decimals' ? 'xyzDecimals' : 'feedDecimals'] = decimals
        reader.carry(field, String(decimals))
      }
    } else if (call) reader.unsupported(`OnMove ${prefix} number format expression; kept LienCAM default`)
  }
  const comment = calls(body('OnInit')).find(call => call.method === 'SetCommentChars')
  const chars = unquote(comment?.args[0] ?? '')
  if (chars?.startsWith('(') || chars?.startsWith(';')) {
    config.capabilities.comment = chars.startsWith(';') ? 'semicolon' : 'paren'
    reader.carry('comments', config.capabilities.comment)
  }
  if (blocks.has('OnNewLine')) {
    const number = calls(body('OnNewLine')).some(call => unquote(call.args[0] ?? '')?.trim() === 'N')
    config.format.lineNumbers = number
    const increment = /\blineNumber\s*=\s*lineNumber\s*\+\s*(\d+)\s*(?:;|\n|$)/.exec(body('OnNewLine'))?.[1]
    if (increment && Number(increment) >= 1 && Number(increment) <= 1000) config.format.lineNumberStep = Number(increment)
    reader.carry('line numbers', number ? `step ${config.format.lineNumberStep}` : 'off')
    if (number && !increment) reader.unsupported('OnNewLine increment expression; kept LienCAM default step')
    if (/\blineNumber\s*=/.test(text.replace(body('OnNewLine'), ''))) reader.unsupported('line number start; LienCAM starts at the step')
  }
  if (blocks.has('OnArc') || blocks.has('OnMove')) {
    const arcCalls = calls(body('OnArc'))
    const literals = arcCalls.map(call => unquote(call.args[0] ?? '') ?? '').join(' ')
    config.capabilities.arcs = /\bG0?[23]\b/.test(literals)
    const radius = arcCalls.some(call => unquote(call.args[0] ?? '')?.trim() === 'R')
    const center = arcCalls.some(call => /^[IJ]$/.test(unquote(call.args[0] ?? '')?.trim() ?? ''))
    if (radius !== center) config.capabilities.arcCenterMode = radius ? 'r' : 'ijk'
    else if (config.capabilities.arcs) reader.unsupported('OnArc mixed or dynamic arc centers; kept LienCAM default')
    reader.carry('arcs', config.capabilities.arcs ? config.capabilities.arcCenterMode : 'lines only')
  }
  const framing = (name: string): string[] => {
    const direct = directBody(body(name))
    if (direct !== body(name)) reader.unsupported(`${name} conditional output; kept LienCAM unit selection`)
    let line = ''
    const lines: string[] = []
    let dynamic = false
    const flush = () => {
      if (dynamic) reader.unsupported(`${name} dynamic output`)
      else if (line.trim()) lines.push(line.trim())
      line = ''; dynamic = false
    }
    for (const call of calls(direct)) {
      if (call.method === 'Eol') { flush(); continue }
      if (call.method === 'SetCommentChars') continue
      if (call.method === 'Text' || call.method === 'ModalText') {
        let literal = call.args.length === 1 ? unquote(call.args[0]) : undefined
        if (literal === undefined) {
          dynamic = true
          // A trailing literal still defines line boundaries after dynamic
          // metadata. Drop its dynamic line, then retain subsequent literals.
          literal = unquote(call.args[call.args.length - 1] ?? '')
          if (literal === undefined) continue
        }
        const parts = literal.split('\n')
        parts.forEach((part, index) => { if (index) flush(); line += part })
      } else if (/Number|Comment/.test(call.method)) dynamic = true
    }
    flush()
    return lines
  }
  const startLines = framing('OnInit')
  // A units-only conditional header still needs the selected unit mode. Do
  // not choose a Lua branch or import its other conditional output.
  if (!startLines.length && calls(body('OnInit')).some(call => /^(?:Modal)?Text$/.test(call.method)
    && /\bG(?:20|21)\b/.test(unquote(call.args[0] ?? '') ?? ''))) startLines.push('{units}')
  setFraming(reader, 'program start', startLines)
  setFraming(reader, 'program end', framing('OnFinish'))
  const changeWords = calls(directBody(body('OnToolChange'))).map(call => unquote(call.args[0] ?? '') ?? '').join(' ')
  if (/\bM0*6\b/.test(changeWords) || /\bM0*0\b/.test(changeWords)) {
    config.capabilities.toolChange = /\bM0*6\b/.test(changeWords) ? 'm6' : 'pause'
    config.options.toolChangePause = /\bM0*0\b/.test(changeWords)
    reader.carry('tool change', config.capabilities.toolChange)
  }
  if (directBody(body('OnToolChange')) !== body('OnToolChange')) reader.unsupported('OnToolChange conditional output')
  for (const [name, role, key] of [
    ['OnSpindleCW', 'spindle CW', 'vendorSpindleCW'], ['OnSpindleCCW', 'spindle CCW', 'vendorSpindleCCW'],
    ['OnSpindleOff', 'spindle stop', 'vendorSpindleStop'], ['OnFloodOn', 'coolant flood', 'vendorCoolantFlood'],
    ['OnMistOn', 'coolant mist', 'vendorCoolantMist'], ['OnCoolantOff', 'coolant off', 'vendorCoolantOff'],
  ]) {
    const words = calls(directBody(body(name))).filter(call => /^(?:Modal)?Text$/.test(call.method)).map(call => unquote(call.args[0] ?? '') ?? '').join(' ')
    if (/\bM\d+\b/.test(words)) setVendorWord(reader, role, key, words)
    else if (blocks.has(name)) reader.unsupported(`${name} dynamic command; kept LienCAM default`)
  }
  const known = new Set(['OnInit', 'OnFinish', 'OnMove', 'OnRapid', 'OnArc', 'OnNewLine', 'OnToolChange', 'OnSpindleCW', 'OnSpindleCCW', 'OnSpindleOff', 'OnFloodOn', 'OnMistOn', 'OnCoolantOff'])
  for (const name of blocks.keys()) if (!known.has(name)) reader.unsupported(`${name} vendor callback${/OnPenDown|OnPenUp/.test(name) ? ' (plasma / torch height)' : ''}`)
  reader.unsupported('vendor Lua runtime; source read as text only')
  return true
}
