import { GENERIC_CONFIG } from '../dialects/base'
import { GRBL_CONFIG } from '../dialects/grbl'
import { LINUXCNC_CONFIG } from '../dialects/linuxcnc'
import { UCCNC_CONFIG } from '../dialects/uccnc'
import { parseUserPostConfig, serializeUserPostConfig, withUserPostWordTable, type UserPostImportResult } from '../userPostConfig'
import type { PostConfig } from '../types'
import { readVectric } from './vectric'
import { readFusion } from './fusion'
import { readSheetcam, sheetcamName } from './sheetcam'
import { readMastercam, mastercamName } from './mastercam'

export type VendorPostImportResult = UserPostImportResult & { report?: string[] }
export interface VendorReader {
  config: PostConfig
  mapped: Set<string>
  report: string[]
  carry: (field: string, detail: string) => void
  unsupported: (detail: string) => void
}

/** One import seam for the existing picker, storage and sharing path. */
export function importPostFile(source: string, filename: string): VendorPostImportResult {
  const extension = filename.split('.').at(-1)?.toLowerCase()
  if (extension !== 'pp' && extension !== 'cps' && extension !== 'scpost' && extension !== 'pst') return parseUserPostConfig(source)
  const report: string[] = []
  // Pick a controller only from its declared name, not incidental code comments.
  const declaration = extension === 'scpost' ? sheetcamName(source) : extension === 'pst' ? mastercamName(source)
    : /(?:POST_NAME|description)\s*=\s*["']([^"']+)/i.exec(source)?.[1] ?? ''
  const base = /grbl/i.test(declaration) ? GRBL_CONFIG
    : /linuxcnc/i.test(declaration) ? LINUXCNC_CONFIG
    : /uccnc|mach3|mach4/i.test(declaration) ? UCCNC_CONFIG : GENERIC_CONFIG
  const config = structuredClone(base)
  config.builtin = false
  delete config.capabilities.programContextEnvelope
  config.label = declaration || filename.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
  config.id = 'vendor-import'
  config.options.vendorPost = extension
  const mapped = new Set<string>()
  const reader: VendorReader = {
    config, mapped, report,
    carry: (field, detail) => { mapped.add(field); report.push(`Mapped ${field}: ${detail}`) },
    unsupported: (detail) => { const line = `Not supported: ${detail}`; if (!report.includes(line)) report.push(line) },
  }
  try {
    const readable = extension === 'pp' ? readVectric(source, reader) : extension === 'cps' ? readFusion(source, reader)
      : extension === 'scpost' ? readSheetcam(source, reader) : readMastercam(source, reader)
    if (!readable) return { ok: false, error: 'File is not a readable vendor post' }
    for (const field of ['units', 'coordinate decimals', 'feed decimals', 'line numbers', 'arcs', 'comments', 'tool change', 'program start', 'program end', 'spindle CW', 'spindle CCW', 'spindle stop', 'coolant flood', 'coolant mist', 'coolant off', 'dwell units', 'work offsets', 'arc tolerance']) {
      if (!mapped.has(field)) report.push(`Defaulted ${field}: ${base.label}`)
    }
    const normalized = withUserPostWordTable(config)
    for (const [key, original] of Object.entries({ vendorSpindleCW: 'M3', vendorSpindleCCW: 'M4', vendorSpindleStop: 'M5', vendorCoolantFlood: 'M8', vendorCoolantMist: 'M7', vendorCoolantOff: 'M9' })) {
      const replacement = config.options[key]
      if (typeof replacement !== 'string' || replacement === original) continue
      const entry = normalized.wordTable.entries.find((item) => item.word === original)
      if (!entry) continue
      normalized.wordTable = {
        ...normalized.wordTable,
        entries: [...normalized.wordTable.entries.filter((item) => item.word !== replacement),
          { ...entry, word: replacement, value: Number(replacement.slice(1)) }],
      }
    }
    return { ...parseUserPostConfig(serializeUserPostConfig(normalized)), report }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Post could not be read' }
  }
}

export function setVendorWord(reader: VendorReader, role: string, key: string, line: string): void {
  const word = /\bM0*(\d+)\b/i.exec(line)
  if (!word) { reader.unsupported(`${role} expression; kept LienCAM default`); return }
  reader.config.options[key] = `M${Number(word[1])}`
  reader.carry(role, String(reader.config.options[key]))
}

export function setFraming(reader: VendorReader, field: 'program start' | 'program end', lines: string[]): void {
  if (!lines.length) return
  if (field === 'program start') {
    const unitWord = lines.find((line) => !/^[;(]/.test(line.trim()) && /\bG(?:20|21)\b/.test(line))?.match(/\bG(20|21)\b/)?.[1]
    if (unitWord && !reader.mapped.has('units')) {
      reader.config.format.units = unitWord === '20' ? 'inch' : 'mm'
      reader.carry('units', reader.config.format.units)
    }
    reader.config.framing.programStart = lines.map((line) => line.split(/(\([^)]*\)|;.*$)/).map((part) =>
      /^[;(]/.test(part) ? part : part.replace(/\bG(?:20|21)\b/g, '{units}')).join(''))
    if (!reader.config.framing.programStart.some((line) => /\{units\}/.test(line))) reader.config.framing.programStart.push('{units}')
  } else {
    reader.config.framing.programEnd = [...lines]
    // The existing custom-end mode owns the entire footer (no duplicate M30).
    reader.config.options.programEndMode = 'custom'
    reader.config.options.programEndCustom = lines.join('\n')
  }
  reader.carry(field, `${lines.length} lines`)
}
