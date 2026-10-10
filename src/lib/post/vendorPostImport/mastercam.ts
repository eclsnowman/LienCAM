import { setFraming, setVendorWord, type VendorReader } from './index'
import { splitArguments, unquote } from './text'

// Mastercam MP files are data here. Independently written for PostConfig;
// PureCutCNC informed the flat-switch/string-select-table reading method.
function cleanPst(source: string): string {
  return source.replace(/\r\n?/g, '\n').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g,
    token => token.startsWith('#') ? '' : token)
}

export function mastercamName(source: string): string {
  return /^#\s*Post Name\s*:\s*(.+)$/im.exec(source)?.[1]?.trim() ?? ''
}

export function readMastercam(source: string, reader: VendorReader): boolean {
  const text = cleanPst(source)
  const lines = text.split('\n')
  const switches = new Map<string, string>()
  const table = new Map<string, string>()
  const blocks = new Map<string, string[]>()
  let block: string[] | undefined
  for (const line of lines) {
    const assignment = /^(\w+\$?)\s*:\s*(\S+)\s*$/.exec(line.trim())
    if (assignment) { switches.set(assignment[1].toLowerCase(), assignment[2].toLowerCase()); block = undefined; continue }
    const entry = /^(s[a-z][\w$]*)\s+["']?([GM]\d+)["']?\s*$/i.exec(line.trim())
    if (entry) { table.set(entry[1].toLowerCase(), entry[2].toUpperCase()); block = undefined; continue }
    // Column zero is significant: indented bare p* names are procedure calls.
    const procedure = /^(p\w+\$?)\s*$/.exec(line)
    if (procedure) { block = []; blocks.set(procedure[1].toLowerCase(), block); continue }
    if (block && line.trim()) block.push(line.trim())
  }
  if (!['pheader', 'psof', 'psof$', 'peof', 'peof$', 'ptlchg', 'ptlchg$'].some(name => blocks.has(name)) && !switches.has('arcoutput')) return false
  const { config } = reader
  const unit = switches.get('units') ?? switches.get('met_tool') ?? switches.get('metric')
  if (['mm', 'metric', '1', 'yes', 'inch', 'in', '0', 'no'].includes(unit ?? '')) {
    config.format.units = ['mm', 'metric', '1', 'yes'].includes(unit!) ? 'mm' : 'inch'
    reader.carry('units', config.format.units)
  }
  // MP fs2 specifies inch then metric precision; fmt links an address to it.
  for (const [letter, field] of [['X', 'coordinate decimals'], ['F', 'feed decimals']] as const) {
    const spec = new RegExp(`^\\s*fmt\\s+${letter}\\s+(\\d+)\\s+`, 'im').exec(text)?.[1]
    const format = spec ? new RegExp(`^\\s*fs2\\s+${spec}\\s+\\d+\\.(\\d+)(?:\\s+\\d+\\.(\\d+))?\\s*$`, 'im').exec(text) : undefined
    const decimals = format?.[config.format.units === 'mm' && format[2] !== undefined ? 2 : 1]
    if (decimals !== undefined && Number(decimals) <= 8) {
      config.format[field === 'coordinate decimals' ? 'xyzDecimals' : 'feedDecimals'] = Number(decimals)
      reader.carry(field, decimals)
    } else if (spec) reader.unsupported(`fmt ${letter} number format; kept LienCAM default`)
  }
  const omit = switches.get('omitseq')
  if (['yes', 'no', '1', '0'].includes(omit ?? '')) {
    config.format.lineNumbers = omit === 'no' || omit === '0'
    reader.carry('line numbers', config.format.lineNumbers ? 'on' : 'off')
  } else if (omit) reader.unsupported('omitseq expression; kept LienCAM default')
  const step = switches.get('seqinc') ?? switches.get('seqinc$')
  if (step && /^\d+$/.test(step) && Number(step) >= 1 && Number(step) <= 1000) {
    config.format.lineNumberStep = Number(step); reader.carry('line number step', step)
  } else if (step) reader.unsupported('seqinc expression; kept LienCAM default step')
  if (switches.has('seqno') || switches.has('seqno$')) reader.unsupported('line number start; LienCAM starts at the step')
  const arc = switches.get('arcoutput') ?? switches.get('arcoutput$')
  if (arc !== undefined && /^[012]$/.test(arc)) {
    config.capabilities.arcs = true
    config.capabilities.arcCenterMode = arc === '0' ? 'ijk' : 'r'
    reader.carry('arcs', config.capabilities.arcCenterMode)
  } else if (arc) reader.unsupported('arcoutput expression; kept LienCAM default')
  for (const [name, role, key] of [
    ['sm03', 'spindle CW', 'vendorSpindleCW'], ['sm04', 'spindle CCW', 'vendorSpindleCCW'], ['sm05', 'spindle stop', 'vendorSpindleStop'],
    ['sm08', 'coolant flood', 'vendorCoolantFlood'], ['sm08_1', 'coolant mist', 'vendorCoolantMist'], ['sm07', 'coolant mist', 'vendorCoolantMist'], ['sm09', 'coolant off', 'vendorCoolantOff'],
  ]) {
    const word = table.get(name)
    if (word) setVendorWord(reader, role, key, word)
  }
  const literalWord = (token: string): string | undefined => unquote(token) ?? table.get(token.replace(/^\*/, '').toLowerCase())
  const directLines = (body: string[], name: string): string[] => {
    let depth = 0
    return body.filter(line => {
      const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
      const nested = depth > 0 || /[\[\]]/.test(code) || /^(?:if|else|while)\b/.test(code)
      depth = Math.max(0, depth + (code.match(/\[/g)?.length ?? 0) - (code.match(/\]/g)?.length ?? 0))
      if (nested) reader.unsupported(`${name} conditional output`)
      return !nested
    })
  }
  const blockLines = (name: string): string[] => {
    const result: string[] = []
    for (const line of directLines(blocks.get(name) ?? [], name)) {
      // Entire conditional/nested-call lines are omitted, including their
      // literal fragments. An MP expression is never an output template.
      const tokens = splitArguments(line)
      const words = tokens.filter(token => !/^(?:pbld|n\$?|e\$?)$/i.test(token)).map(literalWord)
      if (words.some(word => word === undefined)) { reader.unsupported(`${name} dynamic or procedural output`); continue }
      if (words.length) result.push(words.join(' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'))
    }
    return result
  }
  const start = blocks.has('pheader') ? 'pheader' : blocks.has('psof$') ? 'psof$' : 'psof'
  const end = blocks.has('peof$') ? 'peof$' : 'peof'
  const startLines = blockLines(start)
  const endLines = blockLines(end)
  const comments = [...startLines, ...endLines].find(line => /^[;(]/.test(line))
  if (comments) { config.capabilities.comment = comments.startsWith(';') ? 'semicolon' : 'paren'; reader.carry('comments', config.capabilities.comment) }
  setFraming(reader, 'program start', startLines)
  setFraming(reader, 'program end', endLines)
  const change = blocks.get('ptlchg$') ?? blocks.get('ptlchg')
  if (change) {
    const words = directLines(change, 'tool change').flatMap(line => {
      const tokens = splitArguments(line)
      if (tokens.some(token => /^(?:if|else|while)\b/i.test(token))) return []
      return tokens.map(token => literalWord(token) ?? '').filter(Boolean)
    }).join(' ')
    if (/\bM0*6\b/.test(words) || /\bM0*0\b/.test(words)) {
      config.capabilities.toolChange = /\bM0*6\b/.test(words) ? 'm6' : 'pause'
      config.options.toolChangePause = /\bM0*0\b/.test(words)
      reader.carry('tool change', config.capabilities.toolChange)
    }
    if (change.some(line => /\b(?:if|else|while|p\w+)\b/.test(line))) reader.unsupported('tool change procedural output; static M6 / M0 only')
  }
  for (const name of switches.keys()) {
    if (!/^(units|met_tool|metric|omitseq|seqinc\$?|seqno\$?|arcoutput\$?)$/.test(name)) reader.unsupported(`${name} vendor switch`)
  }
  reader.unsupported('vendor MP runtime and postblock expressions; source read as text only')
  return true
}
