// WO-2911: a report started at the failure - the bundle contract.
// reproduction.md + manifest.reproduction, the new categories (console lines,
// current project), the app picture's label, and the personal-text list/hide.
import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import {
  CATEGORY_IDS, DEFAULT_CHOICES, FAILURE_CHOICES, buildReport,
  type ReportChoices, type ReportSources,
} from '../../lib/diagnostics/report'
import {
  findPrivateText, hidePrivateText, routeForConsoleSource, suggestedSteps, type FailureContext,
} from '../../lib/diagnostics/failure'
import { pngSize } from '../../lib/diagnostics/capture'

const ALL_OFF = Object.fromEntries(CATEGORY_IDS.map((id) => [id, false])) as ReportChoices

const FAILURE: FailureContext = {
  route: 'cam', source: 'toolpath',
  errorText: '"Pocket 1": region 1 of 1 stopped early because there was nothing left to cut',
  shownAt: Date.UTC(2026, 9, 17, 15, 0, 0), reportedAt: Date.UTC(2026, 9, 17, 15, 0, 12), view: 'toolpath',
  operation: { name: 'Pocket 1', family: 'pocket_2d', setupName: 'Setup 1', settings: null }, frames: [],
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 6, 0x90, 0, 0, 3, 0xd3, 8, 6, 0, 0, 0])

function sources(over: Partial<ReportSources> = {}): ReportSources {
  return {
    appVersions: { appVersion: '0.36.0-alpha.2', build: 'abc1234', buildDate: '2026-10-13', surface: 'web' },
    basicEnvironment: null, preciseEnvironment: null, incident: null, machineState: null, operationSettings: null,
    project: null, program: null, image: null,
    reproduction: { failure: FAILURE, expected: 'A pocket toolpath', actual: 'No passes', steps: suggestedSteps(FAILURE) },
    consoleTail: { lines: ['15:00:00 warning toolpath: saved to C:\\Users\\jdoe\\Desktop\\job.nc via 198.51.100.20'], total: 1 },
    currentProject: { bytes: new TextEncoder().encode('{"name":"Bracket","source":"/home/jdoe/parts/bracket.step"}') },
    ...over,
  }
}

const unzip = (zip: Uint8Array) => unzipSync(zip)

describe('WO-2911 routes and steps', () => {
  it('a console line with an operation, or a CAM source, is a CAM failure; model/workbench lines are Model', () => {
    expect(routeForConsoleSource('compute', true)).toBe('cam')
    expect(routeForConsoleSource('toolpath', false)).toBe('cam')
    expect(routeForConsoleSource('model', false)).toBe('model')
    expect(routeForConsoleSource('workbench', false)).toBe('model')
    expect(routeForConsoleSource('machine', false)).toBe('app')
  })

  it('suggested steps name the setup, the operation and the exact text shown; Help starts empty', () => {
    const steps = suggestedSteps(FAILURE)
    expect(steps).toContain('setup "Setup 1"')
    expect(steps).toContain('"Pocket 1" (pocket_2d)')
    expect(steps).toContain(FAILURE.errorText)
    expect(suggestedSteps(null)).toBe('')
  })
})

describe('WO-2911 personal text', () => {
  it('finds user-folder paths, shares, IPv4/IPv6/MAC and emails, but not versions, clock times or G-code', () => {
    const text = 'C:\\Users\\jdoe\\a.nc "C:\\\\Users\\\\jdoe\\\\b.nc" \\\\FILESERVER\\share\\c /home/jdoe/d /Users/bob/e 203.0.113.44 fe80::1 00:1A:2B:3C:4D:5E a@example.com'
    expect(findPrivateText(text).map((m) => m.kind)).toEqual(['path', 'path', 'path', 'path', 'path', 'ip', 'ip', 'ip', 'email'])
    for (const safe of ['v0.36.0-alpha.2', '10:20:30', 'G1 X1.5 Y-2 F500', '1.2.3.4.5', 'C:\\Program Files\\LienCAM', 'std::vector<int>', 'BRep_Tool::Surface']) {
      expect(findPrivateText(safe), safe).toEqual([])
    }
    const hidden = hidePrivateText(text)
    expect(findPrivateText(hidden)).toEqual([])
    expect(hidden).toContain('<path removed>')
  })
})

describe('WO-2911 bundle', () => {
  it('the existing defaults are unchanged: no new file unless its box is ticked', async () => {
    const report = await buildReport(DEFAULT_CHOICES, sources())
    expect(report.files.map((f) => f.name)).toEqual(['README.txt', 'manifest.json', 'app-versions.json'])
  })

  it('reproduction.md carries the failure, the description, the steps and every other file hash; manifest.reproduction the same as JSON', async () => {
    const report = await buildReport({ ...ALL_OFF, appVersions: true, reproduction: true, consoleTail: true, currentProject: true }, sources())
    const files = unzip(report.zip)
    const md = strFromU8(files['reproduction.md'])
    expect(md).toContain('Error text, exactly as shown:\n\n```text\n' + FAILURE.errorText + '\n```')
    expect(md).toContain('Operation: "Pocket 1" (pocket_2d) in setup "Setup 1"')
    expect(md).toContain('## Expected\nA pocket toolpath')
    expect(md).toContain('## Actual\nNo passes')
    expect(md).toContain('Build: 0.36.0-alpha.2 (abc1234, web)')
    expect(md).toContain('Copy project-current.camproject')
    expect(md).toContain('Never send machine or controller commands')
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    const r = manifest.reproduction
    expect(r.version).toBe(1)
    expect(r.route).toBe('cam')
    expect(r.failure.errorText).toBe(FAILURE.errorText)
    expect(r.failure.reportedAfterSeconds).toBe(12)
    expect(r.project).toBe('project-current.camproject')
    expect(r.steps[0]).toMatch(/^1\. Open the project/)
    // Every hash reproduction.md names is the hash of that file in the ZIP.
    for (const f of r.files as Array<{ name: string; sha256: string }>) {
      expect(md).toContain(`${f.name}  SHA-256 ${f.sha256}`)
      expect(report.files.find((x) => x.name === f.name)?.sha256).toBe(f.sha256)
    }
    expect((r.files as Array<{ name: string }>).map((f) => f.name).sort()).toEqual(['app-versions.json', 'console-tail.txt', 'project-current.camproject'])
  })

  it('a report from Help (no failure) still writes a valid reproduction.md that says no failure is attached', async () => {
    const report = await buildReport({ ...ALL_OFF, reproduction: true },
      sources({ reproduction: { failure: null, expected: '', actual: 'Looks wrong', steps: '' } }))
    const md = strFromU8(unzip(report.zip)['reproduction.md'])
    expect(md).toContain('Started from: Help > Report a problem (no failure attached)')
    expect(md).toContain('No failure was attached')
    expect(md).toContain('## Expected\n(not written)')
    expect(md).toContain('No project is in this report')
  })

  it('personal text is listed per file; hiding changes only the files the app wrote, never a project', async () => {
    const choices = { ...ALL_OFF, consoleTail: true, currentProject: true }
    const shown = await buildReport(choices, sources())
    expect(shown.privateText.map((m) => [m.file, m.kind, m.hidden])).toEqual([
      ['console-tail.txt', 'path', false], ['console-tail.txt', 'ip', false], ['project-current.camproject', 'path', false],
    ])
    const hidden = await buildReport(choices, sources(), new Set(), { hidePrivate: true })
    const files = unzip(hidden.zip)
    expect(strFromU8(files['console-tail.txt'])).not.toContain('jdoe')
    expect(strFromU8(files['console-tail.txt'])).not.toContain('198.51.100.20')
    expect(strFromU8(files['project-current.camproject'])).toContain('/home/jdoe/parts')
    expect(hidden.privateText.filter((m) => m.hidden).map((m) => m.file)).toEqual(['console-tail.txt', 'console-tail.txt'])
    expect(strFromU8(files['README.txt'])).toContain('2 replaced in the files the app wrote (originals are unchanged)')
  })

  it('hiding a quoted path inside JSON keeps every JSON file valid (pre-audit: the escape before the quote was eaten)', async () => {
    const quoted = { ...FAILURE, errorText: 'cannot read "C:\\Users\\Quinn\\part.step" or "/home/quinn/a.step"' }
    const choices = { ...ALL_OFF, ...FAILURE_CHOICES, appImage: false, machineState: true, appVersions: true }
    const report = await buildReport(choices, sources({
      reproduction: { failure: quoted, expected: 'opens "C:\\Users\\Quinn\\part.step"', actual: 'x', steps: '1. open "/home/quinn/a.step"' },
      operationSettings: { file: '"C:\\Users\\Quinn\\part.step"' } as never,
      machineState: { lastFile: 'C:\\Users\\Quinn\\job "1".nc', host: '198.51.100.20' } as never,
    }), new Set(), { hidePrivate: true })
    expect(report.problems).toEqual([])
    const files = unzip(report.zip)
    for (const name of ['manifest.json', 'operation-settings.json', 'machine-state.json']) {
      const text = strFromU8(files[name])
      expect(() => JSON.parse(text), name).not.toThrow()
      expect(text, name).not.toMatch(/Quinn|quinn|198\.51\.100/)
    }
    expect(JSON.parse(strFromU8(files['manifest.json'])).reproduction.failure.errorText).toBe('cannot read "<path removed>" or "<path removed>"')
    expect(strFromU8(files['reproduction.md'])).not.toMatch(/Quinn|quinn/)
  })

  it('an app picture is labelled as what it is, not as an original attachment; a stale one says so', async () => {
    const image = { bytes: PNG, kind: 'png' as const, capture: { kind: 'view-only' as const, width: 1680, height: 979, ageSeconds: 3, projectChangedAfter: true } }
    const report = await buildReport({ ...ALL_OFF, appImage: true, reproduction: true }, sources({ image }))
    const files = unzip(report.zip)
    const readme = strFromU8(files['README.txt'])
    expect(readme).toContain('Original attachments: none')
    expect(readme).toContain('App picture: 3D view only (the panels and dialogs are not in this picture); the project changed after it was taken')
    const md = strFromU8(files['reproduction.md'])
    expect(md).toContain('3D view only')
    expect(md).toContain('1680x979')
    expect(md).toContain('The project changed after the picture was taken')
    // A chosen file stays an original, with no picture line.
    const chosen = await buildReport({ ...ALL_OFF, appImage: true }, sources({ image: { bytes: PNG, kind: 'png' } }))
    expect(strFromU8(unzip(chosen.zip)['README.txt'])).toContain('Original attachments: app-image.png')
    expect(pngSize(PNG)).toEqual({ width: 1680, height: 979 })
  })

  it('the failure route ticks description, console lines, settings and picture, never the whole project', () => {
    expect(FAILURE_CHOICES).toEqual({ reproduction: true, consoleTail: true, operationSettings: true, appImage: true })
    expect(FAILURE_CHOICES.currentProject).toBeUndefined()
    expect(DEFAULT_CHOICES.reproduction || DEFAULT_CHOICES.consoleTail || DEFAULT_CHOICES.currentProject).toBe(false)
  })

  it('the same report built twice is byte-identical', async () => {
    const choices = { ...ALL_OFF, appVersions: true, reproduction: true, consoleTail: true, currentProject: true }
    const a = await buildReport(choices, sources())
    const b = await buildReport(choices, sources())
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true)
  })
})
