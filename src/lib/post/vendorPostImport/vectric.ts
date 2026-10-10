import { setFraming, setVendorWord, type VendorReader } from './index'
import { unquote } from './text'

export function readVectric(source: string, reader: VendorReader): boolean {
  const text = source.replace(/\r\n?/g, '\n').split('\n').filter((line) => !line.trimStart().startsWith('+')).join('\n')
  if (!/^\s*(POST_NAME\s*=|begin\s+HEADER\b|VAR\s+X_POSITION\s*=)/im.test(text)) return false
  const blocks = new Map<string, string[]>()
  let block: string[] | undefined
  for (const raw of text.split('\n')) {
    const begin = /^\s*begin\s+(\w+)/i.exec(raw)
    if (begin) { block = []; blocks.set(begin[1].toUpperCase(), block); continue }
    const literal = unquote(raw)
    if (block && literal !== undefined) block.push(literal)
  }
  const { config } = reader
  if (/^\s*FILE_EXTENSION\s*=/im.test(text)) reader.unsupported('FILE_EXTENSION; LienCAM uses the base post extension')
  if (/^\s*VAR\s+\w+\s*=/im.test(text)) reader.unsupported('VAR modal flags and zero padding; LienCAM keeps its number formatter')
  const units = /^\s*UNITS\s*=\s*"?(MM|INCH(?:ES)?|IN)"?/im.exec(text)?.[1]?.toUpperCase()
  if (units) { config.format.units = units === 'MM' ? 'mm' : 'inch'; reader.carry('units', config.format.units) }
  for (const [name, field] of [['X_POSITION', 'coordinate decimals'], ['FEED_RATE', 'feed decimals']] as const) {
    const format = new RegExp(`^\\s*VAR\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`, 'im').exec(text)
    const precision = format?.[1].split('|').at(-1)?.match(/\.(\d+)$/)?.[1]
    if (precision !== undefined && Number(precision) <= 8) {
      config.format[field === 'coordinate decimals' ? 'xyzDecimals' : 'feedDecimals'] = Number(precision)
      reader.carry(field, precision)
    }
  }
  const numbers = [...blocks.values()].flat().some((line) => /\[N\]/i.test(line))
  config.format.lineNumbers = numbers
  const increment = /^\s*LINE_NUMBER_INCREMENT\s*=\s*"?(\d+)/im.exec(text)?.[1]
  config.format.lineNumberStep = numbers ? Math.max(1, Math.min(1000, Number(increment ?? 10))) : 0
  reader.carry('line numbers', numbers ? `step ${config.format.lineNumberStep}` : 'off')
  if (/^\s*LINE_NUMBER_START\s*=/im.test(text)) reader.unsupported('line number start; LienCAM starts at the step')
  const arcs = [blocks.get('FIRST_CW_ARC_MOVE'), blocks.get('CW_ARC_MOVE'), blocks.get('FIRST_CCW_ARC_MOVE'), blocks.get('CCW_ARC_MOVE')].flatMap((lines) => lines ?? [])
  if (blocks.has('FEED_MOVE') || arcs.length) {
    config.capabilities.arcs = arcs.length > 0
    config.capabilities.arcCenterMode = arcs.some((line) => /\[R(?:ADIUS)?\]|\bR\[/i.test(line)) ? 'r' : 'ijk'
    reader.carry('arcs', arcs.length ? config.capabilities.arcCenterMode : 'lines only')
  }
  const comment = /^\s*COMMENT_START\s*=\s*["']([;(])/im.exec(text)?.[1]
  if (comment) { config.capabilities.comment = comment === ';' ? 'semicolon' : 'paren'; reader.carry('comments', config.capabilities.comment) }
  const translate = (lines: string[], tool = false): string[] => lines.flatMap((line) => {
    let value = line.replace(/\[N\]/gi, '')
    if (/^\s*M\d+\s*\[S\]\s*$/i.test(value)) {
      setVendorWord(reader, 'spindle CW', 'vendorSpindleCW', value)
      return [] // The existing per-operation spindle start supplies the RPM.
    }
    if (tool) value = value.replace(/T?\[T\]/gi, 'T{tool}')
    if (/\[[^\]]+\]/.test(value)) { reader.unsupported(`template ${line}; dynamic vendor tokens`); return [] }
    return value.trim() ? [value.trim()] : []
  })
  setFraming(reader, 'program start', translate(blocks.get('HEADER') ?? []))
  setFraming(reader, 'program end', translate(blocks.get('FOOTER') ?? []))
  const change = translate(blocks.get('TOOLCHANGE') ?? blocks.get('TOOL_CHANGE') ?? [], true)
  if (change.length) {
    const body = change.join('\n')
    config.capabilities.toolChange = /\bM0*6\b/.test(body) ? 'm6' : /\bM0*0\b/.test(body) ? 'pause' : 'macro'
    if (config.capabilities.toolChange === 'macro') config.options.toolChangeMacro = body
    config.options.toolChangePause = /\bM0*0\b/.test(body)
    reader.carry('tool change', config.capabilities.toolChange)
    if (change.length > 1 && config.capabilities.toolChange !== 'macro') {
      config.capabilities.toolChange = 'macro'; config.options.toolChangeMacro = body; config.options.toolChangePause = false
    }
  }
  for (const [name, role, key] of [
    ['SPINDLE_ON', 'spindle CW', 'vendorSpindleCW'], ['SPINDLE_ON_CW', 'spindle CW', 'vendorSpindleCW'],
    ['SPINDLE_ON_CCW', 'spindle CCW', 'vendorSpindleCCW'], ['SPINDLE_OFF', 'spindle stop', 'vendorSpindleStop'],
    ['COOLANT_ON', 'coolant flood', 'vendorCoolantFlood'], ['COOLANT_FLOOD', 'coolant flood', 'vendorCoolantFlood'],
    ['COOLANT_MIST', 'coolant mist', 'vendorCoolantMist'], ['COOLANT_OFF', 'coolant off', 'vendorCoolantOff'],
  ]) {
    const lines = blocks.get(name)
    if (lines) setVendorWord(reader, role, key, lines.join(' '))
  }
  const known = /^(HEADER|FOOTER|(?:FIRST_)?(?:CW_ARC|CCW_ARC|RAPID|FEED)_MOVE|TOOLCHANGE|TOOL_CHANGE|SPINDLE_(?:ON(?:_CW|_CCW)?|OFF)|COOLANT_(?:ON|FLOOD|MIST|OFF))$/
  for (const name of blocks.keys()) if (!known.test(name)) reader.unsupported(`${name} vendor block`)
  return true
}
