// WO-2911: "Report this problem" AT the failure (docs/research/solidcraft-recon/ROUND-2.md part 1).
//
// A failure context is frozen the moment the operator clicks the report action
// on a console line or an error screen: what failed, where, the error text the
// operator was shown and the steps that led there. It opens the existing
// Report a problem dialog prefilled; nothing is saved or sent until the
// operator does it there, after seeing the exact files.
//
// reproduction.md is the bundle section written for an agent: the build, the
// route, the operation or feature, the exact error, expected vs actual, the
// steps, the files with their hashes and what was left out. The same facts sit
// as versioned JSON under `reproduction` in manifest.json. Never a controller
// command: a report is replayed on a desk or simulator, never on the machine.
//
// Everything here is pure, so the same context gives the same bytes.

import type { StackFrame } from './schema'
import type { OperationSettingsSnapshot } from './sources'

export const REPRODUCTION_FORMAT_VERSION = 1

/** Where the report was started. 'help' = Help > Report a problem, no failure. */
export type FailureRoute = 'cam' | 'model' | 'app' | 'app-error-screen' | 'view-error-screen' | 'help'

export interface FailureContext {
  route: Exclude<FailureRoute, 'help'>
  /** Console source ('compute', 'model', ...) or the error screen name. */
  source: string
  /** The exact text the operator was shown. */
  errorText: string
  /** Milliseconds since epoch when the failure was shown (console line time). */
  shownAt: number
  /** Milliseconds since epoch when the operator clicked Report. */
  reportedAt: number
  /** The app view at report time (setup, sketch, toolpath, simulate, model...). */
  view: string | null
  operation: {
    name: string
    family: string
    setupName: string | null
    settings: OperationSettingsSnapshot | null
  } | null
  /** Error screens: code locations only (same filter as the event history). */
  frames: StackFrame[]
}

/** How the picture was taken. Only 'app-window' and 'browser-tab' show the whole app. */
export type CaptureKind = 'app-window' | 'browser-tab' | 'view-only' | 'chosen-file'

export interface CaptureInfo {
  kind: CaptureKind
  width: number | null
  height: number | null
  /** Seconds between the capture and building this report. */
  ageSeconds: number | null
  /** The open project changed after the picture was taken. */
  projectChangedAfter: boolean
}

export interface ReproductionSource {
  failure: FailureContext | null
  expected: string
  actual: string
  steps: string
}

const ROUTE_TITLE: Record<FailureRoute, string> = {
  cam: 'CAM operation failed or was refused',
  model: 'Model (3D modelling) failure',
  app: 'App message',
  'app-error-screen': 'The app stopped with an error screen',
  'view-error-screen': 'The 3D view stopped with an error screen',
  help: 'Help > Report a problem (no failure attached)',
}

const CAPTURE_TITLE: Record<CaptureKind, string> = {
  'app-window': 'whole app window, taken by the desktop app',
  'browser-tab': 'whole app tab, taken with the browser tab-capture permission',
  'view-only': '3D view only (the panels and dialogs are not in this picture)',
  'chosen-file': 'an image file the operator chose',
}

/** Console sources that come from CAM generation, posting or tools. */
const CAM_SOURCES = new Set(['compute', 'toolpath', 'post', 'tool', 'setup', 'stock'])
/** Console sources that come from the Model or sketch workbench. */
const MODEL_SOURCES = new Set(['model', 'workbench', 'sketch', 'import'])

export function routeForConsoleSource(source: string, opRef: boolean): FailureContext['route'] {
  if (opRef || CAM_SOURCES.has(source)) return 'cam'
  if (MODEL_SOURCES.has(source)) return 'model'
  return 'app'
}

/** Steps the operator starts from. They are shown and editable; nothing is guessed silently. */
export function suggestedSteps(f: FailureContext | null): string {
  if (!f) return ''
  const open = '1. Open the project in this report (project-current.camproject), or describe the part.'
  switch (f.route) {
    case 'cam':
      return f.operation
        ? [open,
          `2. In setup "${f.operation.setupName ?? '?'}", select the operation "${f.operation.name}" (${f.operation.family}).`,
          '3. Generate its toolpath.',
          `4. The console shows: ${f.errorText}`].join('\n')
        : [open, '2. (what you did)', `3. The console shows: ${f.errorText}`].join('\n')
    case 'model':
      return [open, '2. Open the Model workspace.', '3. (the feature or command you used, and its values; or "none, it appears when the workspace opens")', `4. The console shows: ${f.errorText}`].join('\n')
    case 'app':
      return [open, '2. (what you did)', `3. The console shows: ${f.errorText}`].join('\n')
    case 'app-error-screen':
    case 'view-error-screen':
      return [open, `2. (what you did${f.view ? ` in the ${f.view} view` : ''})`, `3. The error screen shows: ${f.errorText}`].join('\n')
  }
}

// --- Personal details in outgoing text ---------------------------------------

export type PrivateKind = 'path' | 'ip' | 'email'
export interface PrivateMatch { kind: PrivateKind; text: string }

// A user-folder path (Windows, macOS, Linux) or a network share, up to the next
// space or quote; an IPv4 address with four octets 0-255 (so "0.36.0" versions
// stay); an IPv6 or MAC address; an email address.
const PATTERNS: Array<{ kind: PrivateKind; re: RegExp }> = [
  { kind: 'path', re: /[A-Za-z]:\\{1,2}(?:Users|Documents and Settings|Profiles)\\{1,2}[^\s"'<>|]+/g },
  { kind: 'path', re: /(?<![A-Za-z0-9:\\])\\{2,4}[A-Za-z0-9._-]+\\{1,2}[^\s"'<>|]+/g },
  { kind: 'path', re: /\/(?:home|Users)\/[^\s"'<>|/]+(?:\/[^\s"'<>|]*)?/g },
  { kind: 'ip', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g },
  { kind: 'ip', re: /(?<![0-9A-Fa-f:])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?![0-9A-Fa-f:])/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
]

/** An IPv6 address ("::" or eight groups) or a MAC address (six two-digit groups).
 *  A clock time such as 10:20:30 is neither. */
function isAddress(s: string): boolean {
  const groups = s.split(':')
  if (groups.some((g) => g.length > 4)) return false
  if (groups.length === 6 && groups.every((g) => /^[0-9A-Fa-f]{2}$/.test(g))) return true
  // "::1" or "fe80::1"; not "std::vector", whose "d::" has one group and no leading "::".
  if (s.includes('::')) return groups.filter((g) => g.length > 0).length >= (s.startsWith('::') ? 1 : 2)
  return groups.length === 8 && groups.every((g) => g.length > 0)
}

/** Every personal path, network address and email in the text, in order. */
export function findPrivateText(text: string): PrivateMatch[] {
  const found: Array<PrivateMatch & { at: number }> = []
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (kind === 'ip' && m[0].includes(':') && !isAddress(m[0])) continue
      found.push({ kind, text: m[0], at: m.index ?? 0 })
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ kind, text }) => ({ kind, text }))
}

const PLACEHOLDER: Record<PrivateKind, string> = { path: '<path removed>', ip: '<address removed>', email: '<email removed>' }

/** The same text with every match replaced by a visible placeholder. */
export function hidePrivateText(text: string): string {
  let out = text
  for (const m of findPrivateText(text)) out = out.split(m.text).join(PLACEHOLDER[m.kind])
  return out
}

/** Every string inside a JSON-shaped value (keys and values), for the preview list. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)])
  return []
}

/** The same value with every string hidden one by one, so JSON written from it
 *  stays valid (hiding the serialized text could eat an escape such as \"). */
export function hidePrivateInValue<T>(value: T): T {
  if (typeof value === 'string') return hidePrivateText(value) as T
  if (Array.isArray(value)) return value.map(hidePrivateInValue) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [hidePrivateText(k), hidePrivateInValue(v)])) as T
  }
  return value
}

// --- reproduction.md and its JSON twin --------------------------------------

export interface ReproductionFiles {
  /** Every other file in the report, with its hash (reproduction.md itself excluded). */
  files: Array<{ name: string; sha256: string }>
  build: { appVersion: string; build: string; surface: string } | null
  notIncluded: string[]
  unavailable: string[]
  /** The app picture in this report, when the app took it. */
  capture: CaptureInfo | null
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)

function block(text: string): string {
  const trimmed = text.trim()
  return trimmed ? trimmed : '(not written)'
}

export function reproductionRecord(src: ReproductionSource, files: ReproductionFiles) {
  const f = src.failure
  const has = (name: string) => files.files.some((x) => x.name === name)
  return {
    version: REPRODUCTION_FORMAT_VERSION,
    route: (f?.route ?? 'help') as FailureRoute,
    build: files.build,
    failure: f ? {
      source: f.source,
      errorText: f.errorText,
      shownAtUtc: clock(f.shownAt),
      reportedAfterSeconds: Math.max(0, Math.round((f.reportedAt - f.shownAt) / 1000)),
      view: f.view,
      operation: f.operation ? { name: f.operation.name, family: f.operation.family, setupName: f.operation.setupName } : null,
      frames: f.frames,
    } : null,
    expected: src.expected.trim(),
    actual: src.actual.trim(),
    steps: src.steps.split('\n').map((s) => s.trim()).filter(Boolean),
    capture: files.capture,
    project: has('project-current.camproject') ? 'project-current.camproject'
      : has('project.camproject') ? 'project.camproject' : null,
    files: files.files,
    notIncluded: files.notIncluded,
    unavailable: files.unavailable,
    replay: 'Desk or simulator only. Never send machine or controller commands from this report.',
  }
}

export function reproductionMarkdown(src: ReproductionSource, files: ReproductionFiles): string {
  const r = reproductionRecord(src, files)
  const f = src.failure
  const lines: string[] = [
    '# LienCAM problem report: how to reproduce',
    '',
    `Reproduction format: ${REPRODUCTION_FORMAT_VERSION} (the same facts are under "reproduction" in manifest.json).`,
    `Build: ${r.build ? `${r.build.appVersion} (${r.build.build}, ${r.build.surface})` : 'not included - ask the reporter which version'}`,
    `Started from: ${ROUTE_TITLE[r.route]}`,
    '',
  ]
  // The picture first: a person (the owner, 10-17) sees the problem before reading about it.
  const picture = files.files.find((x) => /^app-image\.(png|jpg)$/.test(x.name))
  if (picture) {
    lines.push('## What it looked like', '', `![The app when this was reported](${picture.name})`, '')
    const c = files.capture
    if (c) {
      lines.push(`- ${CAPTURE_TITLE[c.kind]}${c.width ? `, ${c.width}x${c.height}` : ''}`)
      if (c.ageSeconds !== null) lines.push(`- Taken ${c.ageSeconds} s before this report was built`)
      if (c.projectChangedAfter) lines.push('- The project changed after the picture was taken; it may not match the project file')
      lines.push('')
    } else {
      lines.push('- A picture the reporter chose', '')
    }
  }
  lines.push('## What failed')
  if (f) {
    lines.push(`- Shown by: ${f.source}${f.view ? ` (view: ${f.view})` : ''}`)
    if (f.operation) lines.push(`- Operation: "${f.operation.name}" (${f.operation.family}) in setup "${f.operation.setupName ?? '?'}"`)
    lines.push('- Error text, exactly as shown:', '', '```text', f.errorText, '```', '')
    lines.push(`- Shown at ${clock(f.shownAt)} UTC; report started ${r.failure!.reportedAfterSeconds} s later`)
    if (f.frames.length) lines.push(`- Code locations: ${f.frames.map((x) => `${x.file}:${x.line}:${x.col}`).join(', ')}`)
    if (f.operation?.settings) lines.push('- Operation settings: operation-settings.json')
  } else {
    lines.push('- No failure was attached; see Actual below.')
  }
  lines.push('', '## Expected', block(src.expected), '', '## Actual', block(src.actual), '', '## Steps', block(src.steps), '')
  lines.push('## For an agent: reproduce it', '')
  const project = r.project
  lines.push(`1. Use build ${r.build ? r.build.build : '(unknown - see above)'}; check out that commit if it differs from yours.`)
  lines.push(project
    ? `2. Copy ${project} (SHA-256 below) and open the copy in LienCAM. Never the reporter's original.`
    : '2. No project is in this report. Ask the reporter for one or for a small example; the steps alone may not reproduce it.')
  lines.push('3. Follow the Steps above through the app (its buttons or store actions, not a hand-built engine call).')
  lines.push(f ? '4. Reproduced when the app shows the error text above, exactly.' : '4. Reproduced when you see what Actual describes.')
  lines.push('5. Desk or simulator only. Never send machine or controller commands from this report.')
  lines.push('', '## Files in this report')
  for (const x of r.files) lines.push(`- ${x.name}  SHA-256 ${x.sha256}`)
  if (!r.files.length) lines.push('- none besides README.txt and manifest.json')
  lines.push('', `Not included: ${r.notIncluded.join('; ') || 'none'}`, `Unavailable: ${r.unavailable.join('; ') || 'none'}`, '')
  return lines.join('\n')
}

/** The report's README line for the picture, when there is one. */
export function captureLine(c: CaptureInfo): string {
  return `App picture: ${CAPTURE_TITLE[c.kind]}${c.projectChangedAfter ? '; the project changed after it was taken' : ''}`
}
