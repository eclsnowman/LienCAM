// GRBL RX line classification and status-report parsing. Pure functions,
// never throw: anything unrecognized classifies as kind 'other' so the raw
// text surfaces in the console instead of being silently dropped (ADR-0003).

import type {
  AccessoryState,
  GrblOffsetEntry,
  GrblParserState,
  GrblStatusReport,
  MachineState,
  MachineVec3,
  WcsId,
} from '../types'
import { GRBL_ALARM_MESSAGES, GRBL_ERROR_MESSAGES } from './constants'
import { gcodeWordTable } from '../../gcode/wordTable'

export type GrblRxLine =
  | { kind: 'ok' }
  | { kind: 'error'; code: number; message: string }
  | { kind: 'alarm'; code: number; message: string }
  | { kind: 'status'; report: GrblStatusReport }
  | { kind: 'welcome'; version: string }
  | { kind: 'setting'; key: number; value: string }
  /** Bracketed push messages: [MSG:..], [GC:..], [PRB:..], [VER:..], [OPT:..], [HLP:..]. */
  | { kind: 'feedback'; label: string; text: string }
  | { kind: 'other'; text: string }

const WELCOME_RE = /^Grbl\s+(\S+)/
const ERROR_RE = /^error:\s*(\d+)/i
const ALARM_RE = /^ALARM:\s*(\d+)/i
const SETTING_RE = /^\$(\d+)\s*=\s*(.*)$/
const FEEDBACK_RE = /^\[([A-Za-z0-9.]+):?([\s\S]*?)\]$/

const STATE_MAP: Record<string, MachineState> = {
  idle: 'idle',
  run: 'run',
  hold: 'hold',
  jog: 'jog',
  alarm: 'alarm',
  door: 'door',
  check: 'check',
  home: 'home',
  sleep: 'sleep',
}

export function classifyGrblLine(raw: string): GrblRxLine {
  const line = raw.trim()
  if (line === 'ok') return { kind: 'ok' }

  const err = ERROR_RE.exec(line)
  if (err) {
    const code = Number(err[1])
    return { kind: 'error', code, message: GRBL_ERROR_MESSAGES[code] ?? 'Unknown error code.' }
  }

  const alarm = ALARM_RE.exec(line)
  if (alarm) {
    const code = Number(alarm[1])
    return { kind: 'alarm', code, message: GRBL_ALARM_MESSAGES[code] ?? 'Unknown alarm code.' }
  }

  if (line.startsWith('<') && line.endsWith('>')) {
    const report = parseStatusReport(line.slice(1, -1))
    if (report) return { kind: 'status', report }
    return { kind: 'other', text: raw }
  }

  const welcome = WELCOME_RE.exec(line)
  if (welcome) return { kind: 'welcome', version: welcome[1] }

  const setting = SETTING_RE.exec(line)
  if (setting) return { kind: 'setting', key: Number(setting[1]), value: setting[2] }

  const feedback = FEEDBACK_RE.exec(line)
  if (feedback) return { kind: 'feedback', label: feedback[1], text: feedback[2] }

  return { kind: 'other', text: raw }
}

// WO-1644: which report words are a work offset or a motion mode is GRBL's
// word table - the motion modal group and the probe forms GRBL reports as one.
const GRBL_TABLE = gcodeWordTable('grbl')
const WCS_IDS: ReadonlySet<string> = new Set(
  GRBL_TABLE.entries.filter((e) => e.category === 'work offset').map((e) => e.word),
)
const MOTION_MODES: ReadonlySet<string> = new Set(
  GRBL_TABLE.entries.filter((e) => e.modalGroup === 'motion' || e.category === 'probe').map((e) => e.word),
)

/**
 * Parse a [GC:...] feedback body (the $G modal-state report), e.g.
 * "G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0". Unknown words are ignored so
 * grblHAL/FluidNC extensions never break the parse.
 */
export function parseParserState(body: string): GrblParserState {
  const state: GrblParserState = {
    wcs: null,
    units: null,
    distanceMode: null,
    motionMode: null,
    tool: null,
    spindle: null,
    coolant: null,
    feed: null,
    spindleRpm: null,
  }
  for (const word of body.trim().split(/\s+/)) {
    if (WCS_IDS.has(word)) state.wcs = word as WcsId
    else if (MOTION_MODES.has(word)) state.motionMode = word
    else if (word === 'G20') state.units = 'inch'
    else if (word === 'G21') state.units = 'mm'
    else if (word === 'G90') state.distanceMode = 'absolute'
    else if (word === 'G91') state.distanceMode = 'incremental'
    else if (word === 'M3') state.spindle = 'cw'
    else if (word === 'M4') state.spindle = 'ccw'
    else if (word === 'M5') state.spindle = 'off'
    else if (word === 'M7') state.coolant = 'mist'
    else if (word === 'M8') state.coolant = 'flood'
    else if (word === 'M9') state.coolant = 'off'
    else if (/^T\d+$/.test(word)) state.tool = Number(word.slice(1))
    else if (/^F[\d.]+$/.test(word)) state.feed = Number(word.slice(1))
    else if (/^S[\d.]+$/.test(word)) state.spindleRpm = Number(word.slice(1))
  }
  return state
}

const OFFSET_LABELS: ReadonlySet<string> = new Set([
  'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G28', 'G30', 'G92', 'TLO', 'PRB',
])

/**
 * Parse one $# report entry from its feedback label + body, e.g.
 * label "G54" body "-100.000,-50.000,-2.000", or "PRB" body "0.000,1.500,-5.203:1".
 * Returns null for labels that are not offset entries.
 */
export function parseOffsetEntry(label: string, body: string): GrblOffsetEntry | null {
  if (!OFFSET_LABELS.has(label)) return null
  let valuesPart = body
  let probeSuccess: boolean | undefined
  if (label === 'PRB') {
    const sep = body.lastIndexOf(':')
    if (sep >= 0) {
      probeSuccess = body.slice(sep + 1).trim() === '1'
      valuesPart = body.slice(0, sep)
    }
  }
  const values = valuesPart.split(',').map(Number)
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) return null
  return probeSuccess === undefined ? { label, values } : { label, values, probeSuccess }
}

/**
 * Decode the A: accessory letters into structured state. Per the GRBL 1.1
 * report contract each letter present means enabled: S spindle CW, C spindle
 * CCW, F flood coolant, M mist coolant. Unknown letters are ignored.
 */
export function parseAccessoryState(letters: string): AccessoryState {
  return {
    spindle: letters.includes('S') ? 'cw' : letters.includes('C') ? 'ccw' : 'off',
    flood: letters.includes('F'),
    mist: letters.includes('M'),
  }
}

function parseVec3(csv: string): MachineVec3 | null {
  const parts = csv.split(',').map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
  return { x: parts[0], y: parts[1], z: parts[2] }
}

/**
 * Parse the body of a <...> status report (angle brackets already stripped).
 * Returns null when the mandatory state token is unrecognized; individual
 * malformed fields degrade to null without rejecting the whole report.
 */
export function parseStatusReport(body: string): GrblStatusReport | null {
  const fields = body.split('|')
  if (fields.length === 0) return null

  const stateToken = fields[0]
  const [stateName, subRaw] = stateToken.split(':')
  const state = STATE_MAP[stateName.toLowerCase()]
  if (!state) return null

  const report: GrblStatusReport = {
    state,
    subState: subRaw !== undefined && subRaw !== '' && Number.isFinite(Number(subRaw)) ? Number(subRaw) : null,
    mpos: null,
    wpos: null,
    wco: null,
    feed: null,
    spindleRpm: null,
    overrides: null,
    buffer: null,
    line: null,
    pins: null,
    accessories: null,
  }

  for (const field of fields.slice(1)) {
    const sep = field.indexOf(':')
    if (sep < 0) continue
    const key = field.slice(0, sep)
    const value = field.slice(sep + 1)
    switch (key) {
      case 'MPos':
        report.mpos = parseVec3(value)
        break
      case 'WPos':
        report.wpos = parseVec3(value)
        break
      case 'WCO':
        report.wco = parseVec3(value)
        break
      case 'FS': {
        const [f, s] = value.split(',').map(Number)
        report.feed = Number.isFinite(f) ? f : null
        report.spindleRpm = Number.isFinite(s) ? s : null
        break
      }
      case 'F': {
        const f = Number(value)
        report.feed = Number.isFinite(f) ? f : null
        break
      }
      case 'Ov': {
        const [feed, rapid, spindle] = value.split(',').map(Number)
        if ([feed, rapid, spindle].every(Number.isFinite)) report.overrides = { feed, rapid, spindle }
        break
      }
      case 'Bf': {
        const [plannerBlocks, rxBytes] = value.split(',').map(Number)
        if (Number.isFinite(plannerBlocks) && Number.isFinite(rxBytes)) {
          report.buffer = { plannerBlocks, rxBytes }
        }
        break
      }
      case 'Ln': {
        const n = Number(value)
        report.line = Number.isFinite(n) ? n : null
        break
      }
      case 'Pn':
        report.pins = value
        break
      case 'A':
        report.accessories = parseAccessoryState(value)
        break
      default:
        // Unknown field (grblHAL/FluidNC extensions) - ignore, do not reject.
        break
    }
  }

  return report
}
