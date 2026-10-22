// WO-2759: build the problem-report ZIP (design section 6). The order is fixed:
// freeze the selected sources, filter once, build the exact output bytes, then
// preview THAT immutable result. Save writes the same `zip` bytes the preview
// was built from - never a second read of live state.
//
// The only files every report has are README.txt and manifest.json (format
// version, what is included, what is not). An all-off report is valid and
// carries no app, device or incident value. An omitted category leaves no
// name, hash or value behind.

import { zipSync, type Zippable } from 'fflate'
import { REPORT_FORMAT_VERSION, type DiagnosticEvent, type Omissions } from './schema'
import type {
  AppVersions, BasicEnvironment, MachineStateSnapshot, OperationSettingsSnapshot, PreciseEnvironment,
} from './sources'
import {
  captureLine, findPrivateText, hidePrivateInValue, hidePrivateText, stringsIn, reproductionMarkdown, reproductionRecord,
  type CaptureInfo, type PrivateMatch, type ReproductionSource,
} from './failure'

export const CATEGORY_IDS = [
  'reproduction', 'appVersions', 'basicEnvironment', 'eventHistory', 'consoleTail', 'machineState',
  'operationSettings', 'preciseEnvironment', 'currentProject', 'originalProject', 'originalProgram', 'appImage',
] as const
export type CategoryId = typeof CATEGORY_IDS[number]
export type ReportChoices = Record<CategoryId, boolean>

/** Recommended basics on; everything that can reveal the job or the PC off. */
export const DEFAULT_CHOICES: ReportChoices = {
  appVersions: true, basicEnvironment: true, eventHistory: true, machineState: true,
  operationSettings: false, preciseEnvironment: false, originalProject: false, originalProgram: false, appImage: false,
  reproduction: false, consoleTail: false, currentProject: false,
}

/** WO-2911: started from a failure, the operator asked to report THAT failure, so
 *  its description, the console lines around it, the failed operation's settings
 *  and the app picture start ticked. Each is shown in full and can be unticked;
 *  nothing is saved or sent until the operator does it. The whole project stays
 *  off: it holds the full design. */
export const FAILURE_CHOICES: Partial<ReportChoices> = {
  reproduction: true, consoleTail: true, operationSettings: true, appImage: true,
}

/** The fixed archive entry names. Nothing else may enter a report. */
export const CATEGORY_FILES: Record<CategoryId, readonly string[]> = {
  appVersions: ['app-versions.json'],
  basicEnvironment: ['environment.json'],
  eventHistory: ['events.jsonl'],
  machineState: ['machine-state.json'],
  operationSettings: ['operation-settings.json'],
  preciseEnvironment: ['environment-precise.json'],
  originalProject: ['project.camproject'],
  originalProgram: ['program.nc'],
  appImage: ['app-image.png', 'app-image.jpg'],
  reproduction: ['reproduction.md'],
  consoleTail: ['console-tail.txt'],
  currentProject: ['project-current.camproject'],
}

export const CATEGORY_TITLES: Record<CategoryId, string> = {
  appVersions: 'App and component versions',
  basicEnvironment: 'Basic environment',
  eventHistory: 'Event history',
  machineState: 'Machine incident state',
  operationSettings: 'Operation settings and referenced tool',
  preciseEnvironment: 'Precise GPU, driver and display',
  originalProject: 'Original project',
  originalProgram: 'Original G-code',
  appImage: 'App image',
  reproduction: 'Problem description and how to reproduce it',
  consoleTail: 'Console lines',
  currentProject: 'Current project as open now',
}

/** Section 6 writer limits. */
export const LIMITS = {
  zipBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  attachmentBytes: 25 * 1024 * 1024,
  entries: 32,
}

export interface Attachment {
  bytes: Uint8Array
  kind?: 'png' | 'jpg'
  /** WO-2911: set when the app took the picture itself (not a chosen file). */
  capture?: CaptureInfo
}

/** WO-2911: the last console lines, exactly as the operator saw them. */
export interface ConsoleTailSource { lines: string[]; total: number }

export interface IncidentSource {
  /** Report-local label, e.g. "this session" / "earlier session 2". */
  label: string
  events: DiagnosticEvent[]
  dropped: number
  omissions: Omissions
}

/** Everything a report can be built from, frozen when the dialog read it.
 *  `null` = unavailable (never collected, not connected, nothing chosen). */
export interface ReportSources {
  appVersions: AppVersions | null
  basicEnvironment: BasicEnvironment | null
  preciseEnvironment: PreciseEnvironment | null
  incident: IncidentSource | null
  machineState: MachineStateSnapshot | null
  operationSettings: OperationSettingsSnapshot | null
  project: Attachment | null
  program: Attachment | null
  image: Attachment | null
  /** WO-2911. Optional in the type so a caller without them still builds. */
  reproduction?: ReproductionSource | null
  consoleTail?: ConsoleTailSource | null
  currentProject?: Attachment | null
}

/** WO-2911: report-wide options that change file contents, not which files. */
export interface ReportOptions {
  /** Replace personal paths, addresses and emails in the files the app wrote. */
  hidePrivate?: boolean
}

export interface PrivateFinding extends PrivateMatch {
  file: string
  /** Hidden in this report (only files the app wrote; originals stay byte for byte). */
  hidden: boolean
}

export interface ReportFile {
  name: string
  category: CategoryId | 'manifest'
  bytes: Uint8Array
  size: number
  sha256: string
  /** Escaped-on-render text for text files; null for binary content. */
  text: string | null
}

export interface BuiltReport {
  files: ReportFile[]
  zip: Uint8Array
  included: CategoryId[]
  notIncluded: CategoryId[]
  unavailable: CategoryId[]
  problems: string[]
  /** WO-2911: personal paths, addresses and emails found in the outgoing text. */
  privateText: PrivateFinding[]
}

const encoder = new TextEncoder()
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** DOS dates start at 1980; a local-time constructor keeps the stored value
 *  identical in every time zone, so two builds of one report match byte for byte. */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0)

function eventRecords(incident: IncidentSource, excludedSeqs: ReadonlySet<number>): unknown[] {
  return incident.events
    .filter((e) => !excludedSeqs.has(e.seq))
    // Fields stay under their own key: machine.alarm's own `code` field (the alarm number)
    // once overwrote the event code when spread flat (astra audit 5, report.ts:121).
    .map((e) => ({ v: e.v, seq: e.seq, t: e.t, code: e.code, fields: e.fields }))
}

function sourceAvailable(id: CategoryId, s: ReportSources): boolean {
  switch (id) {
    case 'appVersions': return s.appVersions !== null
    case 'basicEnvironment': return s.basicEnvironment !== null
    case 'eventHistory': return s.incident !== null
    case 'machineState': return s.machineState !== null
    case 'operationSettings': return s.operationSettings !== null
    case 'preciseEnvironment': return s.preciseEnvironment !== null
    case 'originalProject': return s.project !== null
    case 'originalProgram': return s.program !== null
    case 'appImage': return s.image !== null
    case 'reproduction': return (s.reproduction ?? null) !== null
    case 'consoleTail': return (s.consoleTail ?? null) !== null
    case 'currentProject': return (s.currentProject ?? null) !== null
  }
}

function readme(r: {
  appVersion: string | null; included: CategoryId[]; notIncluded: CategoryId[]; unavailable: CategoryId[]
  names: string[]; incident: IncidentSource | null; excluded: number; settingsCaptured: boolean; originals: string[]
  capture: CaptureInfo | null; hidden: number
}): string {
  const list = (ids: CategoryId[]) => (ids.length ? ids.map((id) => CATEGORY_TITLES[id]).join('; ') : 'none')
  const filtering = r.incident
    ? `${r.incident.omissions.unknownCodes} unknown events, ${r.incident.omissions.unknownFields + r.incident.omissions.invalidFields} unknown or invalid fields and ${r.incident.omissions.oversizeEvents} oversize events were left out when recorded; ${r.excluded} events removed by you`
    : 'not included'
  return [
    'LienCAM problem report',
    `Report format: ${REPORT_FORMAT_VERSION}`,
    `Application build: ${r.appVersion ?? 'not included'}`,
    '',
    'Creating this ZIP did not upload it. You decide whether to share it.',
    'A report attached to a public GitHub issue is available to anyone.',
    'Removing an attachment later cannot retract copies.',
    '',
    `Included: ${r.included.length ? `${list(r.included)} (${r.names.join(', ')})` : 'none'}`,
    `Not included: ${list(r.notIncluded)}`,
    `Unavailable or incomplete: ${[list(r.unavailable), r.incident && r.incident.dropped > 0 ? `${r.incident.dropped} older events expired or dropped` : ''].filter((x) => x && x !== 'none').join('; ') || 'none'}`,
    `Incident coverage: ${r.incident ? `${r.incident.label}, ${r.incident.events.length - r.excluded} events` : 'not included'}`,
    `Settings captured: ${r.settingsCaptured ? 'when report was created' : 'not included'}`,
    `Filtering: ${filtering}`,
    '',
    'Filtering was applied to diagnostic fields. Automatic filtering cannot',
    'guarantee removal of private content from messages or selected attachments.',
    'Review every included file, including comments, names, coordinates and images.',
    'Original project files can contain embedded source/model data not visible as text.',
    '',
    `Original attachments: ${r.originals.length ? r.originals.join(', ') : 'none'}`,
    'Modified attachments: none',
    ...(r.capture ? [captureLine(r.capture)] : []),
    ...(r.hidden ? [`Personal paths, addresses and emails: ${r.hidden} replaced in the files the app wrote (originals are unchanged)`] : []),
    'Missing details may prevent reproduction and make a fix less likely.',
    'A small example can help without sharing the full job.',
    '',
  ].join('\n')
}

/**
 * Build the frozen report. Pure: the same choices, sources and exclusions give
 * the same bytes. `excludedSeqs` drops individual events from the export copy
 * only - the stored history is untouched.
 */
export async function buildReport(
  choices: ReportChoices,
  sources: ReportSources,
  excludedSeqs: ReadonlySet<number> = new Set(),
  options: ReportOptions = {},
): Promise<BuiltReport> {
  const included: CategoryId[] = []
  const notIncluded: CategoryId[] = []
  const unavailable: CategoryId[] = []
  for (const id of CATEGORY_IDS) {
    if (!choices[id]) notIncluded.push(id)
    else if (!sourceAvailable(id, sources)) unavailable.push(id)
    else included.push(id)
  }
  const raw: Array<{ name: string; category: CategoryId; bytes: Uint8Array; text: string | null }> = []
  // Files the app writes may have personal text hidden; chosen originals never
  // change. Every match is listed for the preview either way.
  const privateText: PrivateFinding[] = []
  const hide = (text: string) => (options.hidePrivate ? hidePrivateText(text) : text)
  const written = (name: string, text: string) => {
    for (const m of findPrivateText(text)) privateText.push({ ...m, file: name, hidden: options.hidePrivate === true })
    return hide(text)
  }
  const addText = (name: string, category: CategoryId, text: string) => {
    const out = written(name, text)
    raw.push({ name, category, bytes: encoder.encode(out), text: out })
  }
  // JSON is hidden string by string, never as serialized text, so it stays valid.
  const listed = <T>(name: string, value: T): T => {
    for (const str of stringsIn(value)) {
      for (const m of findPrivateText(str)) privateText.push({ ...m, file: name, hidden: options.hidePrivate === true })
    }
    return options.hidePrivate ? hidePrivateInValue(value) : value
  }
  const addJson = (name: string, category: CategoryId, value: unknown) => {
    const out = json(listed(name, value))
    raw.push({ name, category, bytes: encoder.encode(out), text: out })
  }
  for (const id of included) {
    switch (id) {
      case 'appVersions': addJson('app-versions.json', id, sources.appVersions); break
      case 'basicEnvironment': addJson('environment.json', id, sources.basicEnvironment); break
      case 'preciseEnvironment': addJson('environment-precise.json', id, sources.preciseEnvironment); break
      case 'eventHistory': {
        const lines = listed('events.jsonl', eventRecords(sources.incident!, excludedSeqs)).map((r) => JSON.stringify(r))
        const out = lines.join('\n') + (lines.length > 0 ? '\n' : '')
        raw.push({ name: 'events.jsonl', category: id, bytes: encoder.encode(out), text: out })
        break
      }
      case 'machineState': addJson('machine-state.json', id, sources.machineState); break
      case 'operationSettings': addJson('operation-settings.json', id, sources.operationSettings); break
      case 'originalProject': raw.push({ name: 'project.camproject', category: id, bytes: sources.project!.bytes, text: null }); break
      case 'originalProgram': {
        const bytes = sources.program!.bytes
        for (const m of findPrivateText(new TextDecoder('utf-8', { fatal: false }).decode(bytes))) privateText.push({ ...m, file: 'program.nc', hidden: false })
        raw.push({ name: 'program.nc', category: id, bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) })
        break
      }
      case 'appImage': raw.push({ name: sources.image!.kind === 'jpg' ? 'app-image.jpg' : 'app-image.png', category: id, bytes: sources.image!.bytes, text: null }); break
      case 'consoleTail': {
        const tail = sources.consoleTail!
        addText('console-tail.txt', id, `${tail.lines.join('\n')}\n${tail.total > tail.lines.length ? `(${tail.total - tail.lines.length} older lines not included)\n` : ''}`)
        break
      }
      case 'currentProject': raw.push({ name: 'project-current.camproject', category: id, bytes: sources.currentProject!.bytes, text: null }); break
      case 'reproduction': break // written last, once every other file and its hash is known
    }
  }

  const files: ReportFile[] = []
  for (const f of raw) files.push({ ...f, size: f.bytes.length, sha256: await sha256(f.bytes) })
  // Projects are written byte for byte (an app that opens them must read them
  // back), so their personal text is listed, never changed.
  for (const f of files) {
    if (f.category === 'originalProject' || f.category === 'currentProject') {
      for (const m of findPrivateText(new TextDecoder('utf-8', { fatal: false }).decode(f.bytes))) privateText.push({ ...m, file: f.name, hidden: false })
    }
  }
  const capture = included.includes('appImage') ? sources.image!.capture ?? null : null
  const repro = included.includes('reproduction') ? sources.reproduction! : null
  const reproFacts = {
    capture,
    files: files.map((f) => ({ name: f.name, sha256: f.sha256 })),
    build: included.includes('appVersions') && sources.appVersions
      ? { appVersion: sources.appVersions.appVersion, build: sources.appVersions.build, surface: sources.appVersions.surface } : null,
    notIncluded: notIncluded.map((id) => CATEGORY_TITLES[id]),
    unavailable: unavailable.map((id) => CATEGORY_TITLES[id]),
  }
  if (repro) {
    const text = written('reproduction.md', reproductionMarkdown(repro, reproFacts))
    const bytes = encoder.encode(text)
    files.unshift({ name: 'reproduction.md', category: 'reproduction', bytes, text, size: bytes.length, sha256: await sha256(bytes) })
  }
  const excludedCount = included.includes('eventHistory') && sources.incident
    ? sources.incident.events.filter((e) => excludedSeqs.has(e.seq)).length : 0
  const originals = files.filter((f) => f.category === 'originalProject' || f.category === 'originalProgram' || (f.category === 'appImage' && !capture)).map((f) => f.name)

  const manifest = {
    reportFormat: REPORT_FORMAT_VERSION,
    eventSchema: included.includes('eventHistory') ? 1 : undefined,
    files: files.map((f) => ({ name: f.name, category: f.category, bytes: f.size, sha256: f.sha256 })),
    notIncluded,
    unavailable,
    settingsCaptured: included.includes('operationSettings') ? 'when report was created' : 'not included',
    reproduction: repro ? (options.hidePrivate ? hidePrivateInValue(reproductionRecord(repro, reproFacts)) : reproductionRecord(repro, reproFacts)) : undefined,
  }
  const readmeText = readme({
    appVersion: included.includes('appVersions') ? `${sources.appVersions!.appVersion} (${sources.appVersions!.build})` : null,
    included, notIncluded, unavailable, names: files.map((f) => f.name),
    incident: included.includes('eventHistory') ? sources.incident : null,
    excluded: excludedCount, settingsCaptured: included.includes('operationSettings'), originals,
    capture, hidden: privateText.filter((m) => m.hidden).length,
  })
  const head: ReportFile[] = []
  for (const [name, text] of [['README.txt', readmeText], ['manifest.json', json(manifest)]] as const) {
    const bytes = encoder.encode(text)
    head.push({ name, category: 'manifest', bytes, size: bytes.length, sha256: await sha256(bytes), text })
  }
  const all = [...head, ...files]

  const problems: string[] = []
  for (const f of files) {
    if ((f.category === 'originalProject' || f.category === 'originalProgram' || f.category === 'appImage') && f.size > LIMITS.attachmentBytes) {
      problems.push(`${f.name} is larger than ${LIMITS.attachmentBytes / 1024 / 1024} MiB. Leave it out or attach a smaller example.`)
    }
  }
  const total = all.reduce((sum, f) => sum + f.size, 0)
  if (total > LIMITS.totalBytes) problems.push(`The report would hold ${(total / 1024 / 1024).toFixed(1)} MiB; the limit is ${LIMITS.totalBytes / 1024 / 1024} MiB. Leave out a large file.`)
  if (all.length > LIMITS.entries) problems.push(`The report would hold ${all.length} files; the limit is ${LIMITS.entries}.`)

  const zippable: Zippable = {}
  for (const f of all) zippable[f.name] = [f.bytes, { mtime: FIXED_MTIME, level: f.text === null ? 0 : 6 }]
  const zip = problems.length ? new Uint8Array() : zipSync(zippable, { mtime: FIXED_MTIME })
  if (zip.length > LIMITS.zipBytes) problems.push(`The ZIP would be ${(zip.length / 1024 / 1024).toFixed(1)} MiB; the limit is ${LIMITS.zipBytes / 1024 / 1024} MiB.`)
  return { files: all, zip: problems.length ? new Uint8Array() : zip, included, notIncluded, unavailable, problems, privateText }
}

/** Fixed outer filename: no project name, user name or path. */
export const REPORT_FILENAME = 'liencam-problem-report.zip'
