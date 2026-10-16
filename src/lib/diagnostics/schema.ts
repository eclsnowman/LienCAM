// WO-2759: the typed diagnostic event contract (docs/design/REPORT-A-PROBLEM-V2.md
// section 4). Only events whose code is in EVENT_FIELDS persist, and only the
// fields that code declares, each checked against a finite enum, a bounded
// number, a boolean or a capped list of stack locations. Anything else is
// dropped and COUNTED - the rejected value itself is never kept or reported.
// There is no free-text field anywhere in this file, on purpose: messages,
// names, paths, URLs and coordinates have no slot to land in.

import { ALL_OPERATION_TYPES } from '../../store/opModelOriginGuard'

export const EVENT_SCHEMA_VERSION = 1
export const REPORT_FORMAT_VERSION = 1

/** Section 4 limits. */
export const MAX_EVENT_BYTES = 8 * 1024
export const MAX_STACK_FRAMES = 64

type FieldRule =
  | { kind: 'enum'; values: readonly string[]; nullable?: boolean }
  | { kind: 'int'; min: number; max: number; nullable?: boolean }
  | { kind: 'number'; min: number; max: number; nullable?: boolean }
  | { kind: 'bool' }
  | { kind: 'frames' }

const MACHINE_STATES = ['unknown', 'idle', 'run', 'hold', 'jog', 'alarm', 'door', 'check', 'home', 'sleep'] as const
const STREAMER_PHASES = ['empty', 'ready', 'streaming', 'paused', 'failed', 'complete'] as const
const OPERATION_OUTCOMES = ['pending', 'computing', 'ready', 'error', 'outdated', 'degraded', 'unsupported'] as const
const LINES = { kind: 'int', min: 0, max: 50_000_000 } as const

export const EVENT_FIELDS = {
  'session.start': { surface: { kind: 'enum', values: ['desktop', 'web'] } },
  'session.previous-ended-unexpectedly': {},
  'renderer.uncaught-error': {
    kind: { kind: 'enum', values: ['error', 'rejection', 'boundary'] },
    frames: { kind: 'frames' },
  },
  'cam.generation.started': {
    family: { kind: 'enum', values: ALL_OPERATION_TYPES },
    operation: { kind: 'int', min: 1, max: 10_000 },
  },
  'cam.generation.finished': {
    family: { kind: 'enum', values: ALL_OPERATION_TYPES },
    operation: { kind: 'int', min: 1, max: 10_000 },
    outcome: { kind: 'enum', values: OPERATION_OUTCOMES },
    ms: { kind: 'number', min: 0, max: 86_400_000, nullable: true },
  },
  'machine.connection': {
    phase: { kind: 'enum', values: ['disconnected', 'connecting', 'connected'] },
    transport: { kind: 'enum', values: ['serial', 'simulator', 'bridge', 'gateway'], nullable: true },
  },
  'machine.state': { state: { kind: 'enum', values: MACHINE_STATES } },
  'machine.alarm': {
    code: { kind: 'int', min: 0, max: 100_000, nullable: true },
    positionLost: { kind: 'bool' },
  },
  'machine.job': {
    phase: { kind: 'enum', values: STREAMER_PHASES },
    totalLines: LINES,
    sentLines: LINES,
    ackedLines: LINES,
  },
} as const satisfies Record<string, Record<string, FieldRule>>

export type EventCode = keyof typeof EVENT_FIELDS
export const EVENT_CODES = Object.keys(EVENT_FIELDS) as EventCode[]

/** Failures, refusals and transitions: kept in the reserved share of the
 *  history budget so ordinary chatter cannot evict them (section 5). */
export const PRIORITY_CODES: ReadonlySet<EventCode> = new Set<EventCode>([
  'session.previous-ended-unexpectedly',
  'renderer.uncaught-error',
  'cam.generation.finished',
  'machine.connection',
  'machine.alarm',
  'machine.job',
])

/** A code whose presence marks a session as holding a failure worth reporting. */
export function isFailureEvent(event: Pick<DiagnosticEvent, 'code' | 'fields'>): boolean {
  if (event.code === 'renderer.uncaught-error' || event.code === 'machine.alarm') return true
  if (event.code === 'session.previous-ended-unexpectedly') return true
  if (event.code === 'cam.generation.finished') return event.fields.outcome === 'error' || event.fields.outcome === 'unsupported'
  if (event.code === 'machine.job') return event.fields.phase === 'failed'
  return false
}

export interface StackFrame { file: string; line: number; col: number }
export type FieldValue = string | number | boolean | null | StackFrame[]

export interface DiagnosticEvent {
  v: typeof EVENT_SCHEMA_VERSION
  code: EventCode
  /** Monotonic per session; the export orders by it, never by clocks. */
  seq: number
  /** Milliseconds since the session started. */
  t: number
  fields: Record<string, FieldValue>
}

/** What a rejected input cost: categories and counts only, never values. */
export interface Omissions {
  unknownCodes: number
  unknownFields: number
  invalidFields: number
  oversizeEvents: number
}

export function emptyOmissions(): Omissions {
  return { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 }
}

/** App-relative code locations only: `assets/x.js`, `src/a/b.tsx`. No scheme,
 *  host, drive letter, query or user folder can pass. */
const SAFE_FILE = /^(?:assets|src|electron)\/[A-Za-z0-9_.\-/]{1,160}$/

function cleanFrames(value: unknown): StackFrame[] | undefined {
  if (!Array.isArray(value)) return undefined
  const frames: StackFrame[] = []
  for (const raw of value.slice(0, MAX_STACK_FRAMES)) {
    if (raw === null || typeof raw !== 'object') return undefined
    const { file, line, col } = raw as Record<string, unknown>
    if (typeof file !== 'string' || !SAFE_FILE.test(file) || file.includes('..')) return undefined
    if (!Number.isInteger(line) || !Number.isInteger(col)) return undefined
    if ((line as number) < 0 || (line as number) > 10_000_000 || (col as number) < 0 || (col as number) > 10_000_000) return undefined
    frames.push({ file, line: line as number, col: col as number })
  }
  return frames
}

function cleanField(rule: FieldRule, value: unknown): { ok: true; value: FieldValue } | { ok: false } {
  if (value === null && 'nullable' in rule && rule.nullable) return { ok: true, value: null }
  switch (rule.kind) {
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? { ok: true, value } : { ok: false }
    case 'int':
      return Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max
        ? { ok: true, value: value as number } : { ok: false }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max
        ? { ok: true, value: Math.round(value * 1000) / 1000 } : { ok: false }
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false }
    case 'frames': {
      const frames = cleanFrames(value)
      return frames ? { ok: true, value: frames } : { ok: false }
    }
  }
}

/**
 * Validate one producer call. Returns the event's allowlisted fields, or null
 * when the code is unknown or a declared field is missing/invalid (the whole
 * event is dropped then - a half-filled event would read as a different fact).
 * Undeclared fields are dropped individually and counted.
 */
export function validateEventFields(
  code: string,
  fields: Record<string, unknown>,
  omissions: Omissions,
): { code: EventCode; fields: Record<string, FieldValue> } | null {
  if (!Object.prototype.hasOwnProperty.call(EVENT_FIELDS, code)) {
    omissions.unknownCodes += 1
    return null
  }
  const rules = EVENT_FIELDS[code as EventCode] as Record<string, FieldRule>
  const clean: Record<string, FieldValue> = {}
  for (const key of Object.keys(fields)) {
    if (!Object.prototype.hasOwnProperty.call(rules, key)) omissions.unknownFields += 1
  }
  for (const [key, rule] of Object.entries(rules)) {
    const result = cleanField(rule, fields[key])
    if (!result.ok) {
      omissions.invalidFields += 1
      return null
    }
    clean[key] = result.value
  }
  return { code: code as EventCode, fields: clean }
}

/** Re-validate an event read back from storage (a tampered or older record
 *  must not bypass the allowlist on its way into a report). */
export function revalidateStoredEvent(raw: unknown, omissions: Omissions): DiagnosticEvent | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== EVENT_SCHEMA_VERSION || !Number.isInteger(r.seq) || typeof r.t !== 'number' || !Number.isFinite(r.t)) {
    omissions.invalidFields += 1
    return null
  }
  if (typeof r.code !== 'string' || r.fields === null || typeof r.fields !== 'object') return null
  const checked = validateEventFields(r.code, r.fields as Record<string, unknown>, omissions)
  if (!checked) return null
  return { v: EVENT_SCHEMA_VERSION, code: checked.code, seq: r.seq as number, t: Math.max(0, Math.round(r.t)), fields: checked.fields }
}

const encoder = new TextEncoder()
export function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

/**
 * Turn an Error's stack into app-relative locations. A frame whose URL is not
 * this app's own origin (or app:// scheme) is dropped - an extension, a data
 * URL or a native path never reaches the record. The message is never read.
 */
export function stackLocations(stack: unknown, origins: readonly string[]): StackFrame[] {
  if (typeof stack !== 'string') return []
  const frames: StackFrame[] = []
  const pattern = /((?:https?|app|file|liencam):\/\/[^\s()]+?):(\d+):(\d+)/g
  for (const match of stack.slice(0, 64 * 1024).matchAll(pattern)) {
    if (frames.length >= MAX_STACK_FRAMES) break
    const url = match[1]
    const origin = origins.find((o) => url.startsWith(o))
    if (!origin) continue
    const file = url.slice(origin.length).replace(/^\/+/, '').split(/[?#]/)[0]
    if (!SAFE_FILE.test(file) || file.includes('..')) continue
    frames.push({ file, line: Number(match[2]), col: Number(match[3]) })
  }
  return frames
}
