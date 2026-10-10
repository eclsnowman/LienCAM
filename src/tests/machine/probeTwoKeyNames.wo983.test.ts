/**
 * WO-983: every profile key named by the importer must exist in Operator's real
 * profile, unless this file explains the absence explicitly.
 *
 * This audit reads the TypeScript syntax tree instead of maintaining a second
 * list of importer keys. A new reader call therefore joins the census in the
 * same edit that adds it. Dynamic key construction fails closed unless the
 * audit expands it deliberately below.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'

const ROOT = process.cwd()
const IMPORTER_PATH = resolve(ROOT, 'src/lib/machine/uccncProfileImport.ts')
const PROFILE_PATH = resolve(ROOT, 'docs/machine/profiles/LienCNCV2.pro')
const IMPORTER_SOURCE = readFileSync(IMPORTER_PATH, 'utf8')
const PROFILE = readFileSync(PROFILE_PATH, 'utf8')

const EXPLAINED_ABSENT_KEYS = new Map([
  [
    'profilename',
    'Operator\'s profile has no Profilename setting; the importer intentionally returns null.',
  ],
])

const READER_KEY_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  rawOf: [1],
  readBool: [2],
  readNum: [2],
  readPin: [2, 3, 4],
}

// `scanNum` joined them when WO-1037 split the number read in two: it takes
// the key its caller was given and hands it to `rawOf`, exactly as the other
// three do. Left out, the audit met `rawOf(s, key)` inside it, could not
// resolve `key` to a literal, and failed closed - which is the audit working
// as designed on a helper that was simply not on this list yet.
const FORWARDING_HELPERS = new Set(['readBool', 'readNum', 'readPin', 'scanNum'])

function containingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text
  }
  return undefined
}

function expandKeyArgument(argument: ts.Expression): string[] {
  if (ts.isStringLiteralLike(argument)) return [argument.text]

  // importUccncProfile asks for Homesequence1..6 in a bounded for-loop.
  if (
    ts.isTemplateExpression(argument)
    && argument.head.text === 'Homesequence'
    && argument.templateSpans.length === 1
    && argument.templateSpans[0].literal.text === ''
    && ts.isIdentifier(argument.templateSpans[0].expression)
    && argument.templateSpans[0].expression.text === 'i'
  ) {
    return Array.from({ length: 6 }, (_, index) => `Homesequence${index + 1}`)
  }

  throw new Error(
    `WO-983 key audit cannot resolve reader argument: ${argument.getText()}. `
      + 'Expand this construction explicitly so it cannot escape the profile census.',
  )
}

function requestedKeyNames(source: string): string[] {
  const file = ts.createSourceFile(
    IMPORTER_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const keys = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const argumentIndexes = READER_KEY_ARGUMENTS[node.expression.text]
      const owner = containingFunctionName(node)
      if (argumentIndexes && !FORWARDING_HELPERS.has(owner ?? '')) {
        for (const index of argumentIndexes) {
          const argument = node.arguments[index]
          if (!argument) {
            throw new Error(`${node.expression.text} has no key argument at index ${index}`)
          }
          for (const key of expandKeyArgument(argument)) keys.add(key.toLowerCase())
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...keys].sort()
}

function profileKeyNames(profile: string): Set<string> {
  const keys = new Set<string>()
  for (const rawLine of profile.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue
    const equals = line.indexOf('=')
    if (equals > 0) keys.add(line.slice(0, equals).trim().toLowerCase())
  }
  return keys
}

function unexplainedMissingKeys(source: string, profile: string): string[] {
  const available = profileKeyNames(profile)
  return requestedKeyNames(source).filter(
    (key) => !available.has(key) && !EXPLAINED_ABSENT_KEYS.has(key),
  )
}

function assertEveryRequestedKeyExists(source: string, profile: string): void {
  const missing = unexplainedMissingKeys(source, profile)
  if (missing.length > 0) {
    throw new Error(`Importer asks for keys absent from Operator's profile: ${missing.join(', ')}`)
  }
}

function replaceProfileValue(profile: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'mi')
  expect(profile.match(line), `${key} must exist in Operator's profile`).not.toBeNull()
  return profile.replace(line, `${key}=${value}`)
}

describe('WO-983 importer key names are audited against the real profile', () => {
  it('has no unexplained key name that Operator\'s profile does not contain', () => {
    const requested = requestedKeyNames(IMPORTER_SOURCE)
    const available = profileKeyNames(PROFILE)
    const absent = requested.filter((key) => !available.has(key))

    expect(absent, 'Every absent importer key must be named and explained here').toEqual(
      [...EXPLAINED_ABSENT_KEYS.keys()],
    )
    expect([...EXPLAINED_ABSENT_KEYS.values()].every((reason) => reason.length > 0)).toBe(true)
    assertEveryRequestedKeyExists(IMPORTER_SOURCE, PROFILE)
  })

  it('negative control: a fabricated reader key fails the audit by name', () => {
    // THE READER CALL, NAMED IN FULL, and that precision is the whole control.
    // This used to fabricate the first `'Velocity'` in the file. WO-1037 put a
    // CATALOGUE entry - `num('Velocity', ...)` - above the reader, so the
    // first occurrence stopped being a reader call and the negative control
    // stopped biting: it fabricated a key the audit does not census and
    // reported that no error was thrown. A guard that cannot fail is not a
    // guard, so it names the call site it is meant to corrupt.
    const READER_CALL = "readNum(s, name, 'Velocity'"
    expect(IMPORTER_SOURCE, 'the reader call this control corrupts must exist')
      .toContain(READER_CALL)
    const fabricated = IMPORTER_SOURCE.replace(
      READER_CALL, "readNum(s, name, 'VelocityThatDoesNotExist'",
    )

    expect(() => assertEveryRequestedKeyExists(fabricated, PROFILE)).toThrow(
      /velocitythatdoesnotexist/,
    )
  })
})

describe('WO-983 Probe 2 uses the names UCCNC writes', () => {
  it('resolves all three Probe 2 values from Operator\'s real profile', () => {
    const imported = importUccncProfile(PROFILE)

    // Port 0 / pin 0 - nothing is wired here - and therefore NO POLARITY:
    // `null`, not `false` (WO-995). The three keys are still all resolved by
    // name, which is what this test is for; only the unassigned pin's claim to
    // a polarity is gone.
    expect(imported.definition?.io.probe2).toEqual({ port: 0, pin: 0, negate: null })
    // The three keys are still all resolved BY NAME, which is what this test is
    // for, and the split they land in is the point: two were consumed by the
    // purpose-built `io.probe2` field above, the third was not. WO-1039 moved
    // the not-consumed side out of the text container and onto the typed model
    // (`definition.settings`), so `unsent` now holds only what nothing could
    // model at all - none of these. Same fact, asked of the container that now
    // answers it.
    const unsent = new Set(imported.unsent.map((setting) => setting.key.toLowerCase()))
    expect(unsent.has('iosetupsettings.probepin2negate')).toBe(false)
    const typed = new Set(
      (imported.definition?.settings ?? []).map((setting) => setting.key.toLowerCase()),
    )
    expect(typed.has('iosetupsettings.probeport2number')).toBe(false)
    expect(typed.has('iosetupsettings.probepin2number')).toBe(false)
    expect(typed.has('iosetupsettings.probepin2negate')).toBe(true)
  })

  it('carries assigned Probe 2 values through the same real-profile keys', () => {
    let assigned = replaceProfileValue(PROFILE, 'Probeport2number', '4')
    assigned = replaceProfileValue(assigned, 'Probepin2number', '7')
    assigned = replaceProfileValue(assigned, 'Probepin2negate', 'True')

    expect(importUccncProfile(assigned).definition?.io.probe2).toEqual({
      port: 4,
      pin: 7,
      negate: true,
    })
  })

  it('counts every real profile key in exactly one side of the read/unsent split', () => {
    const imported = importUccncProfile(PROFILE)
    const unsentKeys = imported.unsent.map((setting) => setting.key.toLowerCase())

    expect(new Set(unsentKeys).size).toBe(unsentKeys.length)
    for (const key of ['Probeport2number', 'Probepin2number']) {
      expect(unsentKeys.filter((candidate) => candidate.endsWith(`.${key.toLowerCase()}`))).toHaveLength(0)
    }
  })
})
