import { setFraming, setVendorWord, type VendorReader } from './index'
import { balanced, functionBody, splitArguments, staticStatements, stripComments, unquote } from './text'

export function readFusion(source: string, reader: VendorReader): boolean {
  const text = stripComments(source.replace(/\r\n?/g, '\n'))
  if (!/\b(?:description\s*=|function\s+onOpen\s*\(|xyzFormat\s*=\s*createFormat)/.test(text)) return false
  const { config } = reader
  const unit = /\bunit\s*=\s*(MM|IN)\s*;/.exec(text)?.[1]
  if (unit) { config.format.units = unit === 'MM' ? 'mm' : 'inch'; reader.carry('units', config.format.units) }
  const propertiesMatch = /\bproperties\s*=\s*\{/.exec(text)
  const properties = propertiesMatch ? balanced(text, propertiesMatch.index + propertiesMatch[0].length - 1, '{', '}') : ''
  const property = (name: string): string | undefined => {
    const match = new RegExp(`\\b${name}\\s*:\\s*`).exec(properties)
    if (!match) return undefined
    const tail = properties.slice(match.index + match[0].length)
    const raw = tail.startsWith('{') ? /\bvalue\s*:\s*([^,}\n]+)/.exec(balanced(tail, 0, '{', '}'))?.[1] : /^[^,}\n]+/.exec(tail)?.[0]
    return raw?.trim()
  }
  for (const [name, field] of [['xyzFormat', 'coordinate decimals'], ['feedFormat', 'feed decimals']] as const) {
    const match = new RegExp(`\\b${name}\\s*=\\s*createFormat\\s*\\(\\s*\\{([^}]*)\\}`).exec(text)
    const ternary = /decimals\s*:\s*\(?\s*unit\s*===?\s*MM\s*\?\s*(\d+)\s*:\s*(\d+)/.exec(match?.[1] ?? '')
    const decimal = ternary ? ternary[config.format.units === 'mm' ? 1 : 2] : /decimals\s*:\s*(\d+)\b/.exec(match?.[1] ?? '')?.[1]
    if (decimal !== undefined && Number(decimal) <= 8) {
      config.format[field === 'coordinate decimals' ? 'xyzDecimals' : 'feedDecimals'] = Number(decimal)
      reader.carry(field, decimal)
    }
    if (/forceDecimal|zeropad/.test(match?.[1] ?? '')) reader.unsupported(`${name} forceDecimal/zeropad formatting`)
  }
  const numbers = property('showSequenceNumbers')
  if (numbers === 'true' || numbers === 'false') {
    config.format.lineNumbers = numbers === 'true'
    reader.carry('line numbers', numbers)
  } else if (numbers) reader.unsupported('showSequenceNumbers expression; kept LienCAM default')
  const increment = property('sequenceNumberIncrement')
  if (increment && /^\d+$/.test(increment) && Number(increment) >= 1 && Number(increment) <= 1000) {
    config.format.lineNumberStep = Number(increment); reader.carry('line number step', increment)
  } else if (increment) reader.unsupported('sequenceNumberIncrement expression; kept LienCAM default')
  if (property('sequenceNumberStart')) reader.unsupported('sequenceNumberStart; LienCAM starts at the step')
  const circular = functionBody(text, 'onCircular')
  if (circular !== undefined) {
    const radius = property('useRadius')
    config.capabilities.arcs = /(?:gMotionModal|gFormat)\s*\.format\(\s*clockwise\s*\?\s*2\s*:\s*3\s*\)/.test(circular)
      || /["']G0?[23]["']/.test(circular)
    config.capabilities.arcCenterMode = radius === 'true' || (radius !== 'false' && /(?:rOutput\.format|["']R["']\s*\+)/.test(circular)) ? 'r' : 'ijk'
    reader.carry('arcs', config.capabilities.arcs ? config.capabilities.arcCenterMode : 'lines only')
    if (radius && radius !== 'true' && radius !== 'false') reader.unsupported('useRadius expression; static arc style used')
  }
  const comment = functionBody(text, 'formatComment')
  if (comment && /return\s*["'];/.test(comment)) { config.capabilities.comment = 'semicolon'; reader.carry('comments', 'semicolon') }
  else if (comment && /["']\(["']/.test(comment)) { config.capabilities.comment = 'paren'; reader.carry('comments', 'paren') }
  const expression = (value: string): string | undefined => {
    const literal = unquote(value)
    if (literal !== undefined) return literal
    const format = /^(g\w*|mFormat)\.format\(\s*(\d+)\s*\)$/.exec(value)
    if (format) return `${format[1][0].toUpperCase()}${Number(format[2])}`
    if (/^gUnitModal\.format\(unit\s*===?\s*MM\s*\?\s*21\s*:\s*20\)$/.test(value)) return '{units}'
    return undefined
  }
  const framing = (name: string): string[] => {
    const body = functionBody(text, name)
    if (body === undefined) return []
    const lines: string[] = []
    for (const statement of staticStatements(body)) {
      const call = /^(writeBlock|writeln|writeComment)\s*\(([\s\S]*)\)$/.exec(statement)
      if (!call) { if (statement) reader.unsupported(`${name} procedural statement`); continue }
      const words = splitArguments(call[2]).map(expression)
      if (words.some((word) => word === undefined)) { reader.unsupported(`${name} dynamic output`); continue }
      const line = words.join(call[1] === 'writeBlock' ? ' ' : '')
      lines.push(call[1] === 'writeComment' ? config.capabilities.comment === 'paren' ? `(${line})` : `; ${line}` : line)
    }
    if (/\b(if|for|while|switch)\b/.test(body)) reader.unsupported(`${name} conditional output`)
    return lines
  }
  setFraming(reader, 'program start', framing('onOpen'))
  setFraming(reader, 'program end', framing('onClose'))
  const section = functionBody(text, 'onSection') ?? ''
  const change = /write(?:Tool)?Block\(\s*["']T["']\s*\+\s*toolFormat\.format\(tool\.number\)\s*,\s*mFormat\.format\(\s*(6|0)\s*\)\s*\)/.exec(section)
  if (change) {
    config.capabilities.toolChange = change[1] === '6' ? 'm6' : 'pause'
    config.options.toolChangePause = change[1] === '0'
    reader.carry('tool change', config.capabilities.toolChange)
  } else if (/COMMAND_STOP|mFormat\.format\(\s*0\s*\)/.test(section)) {
    config.capabilities.toolChange = 'pause'; config.options.toolChangePause = true; reader.carry('tool change', 'pause')
  }
  const spindle = /mFormat\.format\(tool\.clockwise\s*\?\s*(\d+)\s*:\s*(\d+)\)/.exec(text)
  if (spindle) {
    setVendorWord(reader, 'spindle CW', 'vendorSpindleCW', `M${spindle[1]}`)
    setVendorWord(reader, 'spindle CCW', 'vendorSpindleCCW', `M${spindle[2]}`)
  }
  const command = functionBody(text, 'onCommand') ?? ''
  const coolant = functionBody(text, 'setCoolant') ?? ''
  for (const [name, role, key, body] of [
    ['COMMAND_STOP_SPINDLE', 'spindle stop', 'vendorSpindleStop', command],
    ['COOLANT_FLOOD', 'coolant flood', 'vendorCoolantFlood', coolant],
    ['COOLANT_MIST', 'coolant mist', 'vendorCoolantMist', coolant],
    ['COOLANT_OFF', 'coolant off', 'vendorCoolantOff', coolant],
  ]) {
    const segment = new RegExp(`case\\s+${name}\\s*:([\\s\\S]*?)(?=\\bcase\\s|\\bdefault\\s|$)`).exec(body)?.[1]
    const number = /mFormat\.format\(\s*(\d+)\s*\)|\bm\s*=\s*(\d+)\s*;/.exec(segment ?? '')
    if (number) setVendorWord(reader, role, key, `M${number[1] ?? number[2]}`)
  }
  for (const name of ['onCycle', 'onCyclePoint', 'onRapid5D', 'onLinear5D']) {
    if (functionBody(text, name) !== undefined) reader.unsupported(`${name} vendor cycle`)
  }
  reader.unsupported('vendor JavaScript runtime; source read as text only')
  return true
}
