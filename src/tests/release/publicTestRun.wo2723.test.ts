import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Public Node ESM tool has no declaration file.
import { checkCoverage, classifyResult, validateReport } from '../../../tools/release/public-test-run.mjs'

const directory = resolve(import.meta.dirname, '../../../test_fixtures/release/public-test-run')
const fixture = (name: string) => ({
  report: JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8')),
  // A Windows checkout may hold the captured logs with CRLF; the mutations below are written for LF as on CI.
  output: readFileSync(resolve(directory, `${name}.log`), 'utf8').replaceAll('\r\n', '\n'),
  rawExit: Number(readFileSync(resolve(directory, `${name}.exit`), 'utf8')),
})
const timeout = () => fixture('timeout')
const classify = (data: ReturnType<typeof fixture>) => classifyResult(data.rawExit, data.output, data.report)

describe('WO-2723 narrow public result conversion', () => {
  it('converts only the captured all-pass RPC timeout and preserves its error count', () => {
    const data = timeout()
    expect(data.rawExit).toBe(1)
    expect(classify(data)).toEqual({ exitCode: 0, converted: true, errorCount: 1 })
  })
  it('leaves a real clean exit unchanged', () => {
    expect(classify(fixture('pass'))).toEqual({ exitCode: 0, converted: false, errorCount: 0 })
  })
  it('converts the real public job stderr and two timeout blocks', () => {
    expect(classify(fixture('public-stderr'))).toEqual({ exitCode: 0, converted: true, errorCount: 2 })
  })
  it('rejects an unknown error inside the public job unhandled region, outside error blocks', () => {
    const data = fixture('public-stderr')
    data.output = readFileSync(resolve(directory, 'public-stderr-unknown.log'), 'utf8')
    expect(classify(data)).toEqual({ exitCode: 1, converted: false, errorCount: 0 })
  })
  // Rholand 10-10 negative control: an error printed after the summary (report already written) must stay red.
  it.each(['Error: unexpected teardown', 'TypeError: reporter failed', 'fatal: worker channel closed'])(
    'rejects an unknown diagnostic after the summary: %s', tail => {
      const data = timeout()
      data.output += `\n${tail}\n`
      expect(classify(data)).toEqual({ exitCode: 1, converted: false, errorCount: 0 })
      const real = fixture('public-stderr')
      real.output += `\n${tail}\n`
      expect(classify(real)).toEqual({ exitCode: 1, converted: false, errorCount: 0 })
    })
  // Public run 38035495500: shards 3 and 4 passed every test but carried the word OOM in a passing test name and in a
  // WASM log line inside a passing test; those are not crashes.
  it.each([
    ' ✓ large lifted import: partitioned solve under the fixed WASM heap > solves the real BMG.dxf lift without OOM  3528ms',
    'stderr | src/tests/sketch3d/dragPerfLadder.test.ts > measures median/p95 solve-per-move\nAborted(OOM)',
  ])('converts despite an in-test OOM word: %s', line => {
    const data = timeout()
    data.output = `${line}\n${data.output}`
    expect(classify(data)).toEqual({ exitCode: 0, converted: true, errorCount: 1 })
  })
  it.each(['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'Killed'])(
    'still rejects a process-level crash line: %s', line => {
      const data = timeout()
      data.output = `${line}\n${data.output}`
      expect(classify(data)).toEqual({ exitCode: 1, converted: false, errorCount: 0 })
    })
  it.each(['assertion', 'collection', 'unknown', 'crash'])('rejects captured %s failure', name => {
    const data = fixture(name)
    expect(data.rawExit).toBe(1)
    expect(classify(data).exitCode).toBe(1)
  })
  it.each([2, 137, null])('does not reinterpret exit %s', rawExit => {
    const data = timeout()
    expect(classifyResult(rawExit, data.output, data.report).exitCode).toBe(rawExit ?? 1)
  })
  it('rejects a signal even with otherwise valid results', () => {
    const data = timeout()
    expect(classifyResult(null, data.output, data.report, 'SIGTERM').exitCode).toBe(1)
  })
  it.each([undefined, null, '{corrupt', {}, []])('rejects missing or malformed JSON %s', report => {
    const data = timeout()
    expect(classifyResult(1, data.output, report).exitCode).toBe(1)
  })
  it.each([
    ['zero files', (r: any) => { r.testResults = [] }],
    ['failed suite without tests', (r: any) => { r.numFailedTestSuites = 1; r.testResults[0].assertionResults = [] }],
    ['failed file hidden by counters', (r: any) => { r.testResults[0].status = 'failed' }],
    ['failed assertion hidden by counters', (r: any) => { r.testResults[0].assertionResults[0].status = 'failed' }],
    ['uncollected file', (r: any) => { r.testResults[0].assertionResults = [] }],
    ['missing file result', (r: any) => { delete r.testResults[0].status }],
    ['missing count', (r: any) => { delete r.numFailedTests }],
    ['inconsistent count', (r: any) => { r.numTotalTests = 2 }],
    ['pending suite', (r: any) => { r.numPendingTestSuites = 1 }],
    ['pending assertion', (r: any) => { r.testResults[0].assertionResults[0].status = 'pending'; r.numPassedTests = 0; r.numPendingTests = 1 }],
    ['failure message', (r: any) => { r.testResults[0].assertionResults[0].failureMessages = ['failure'] }],
    ['duplicate JSON file', (r: any) => { r.testResults.push(r.testResults[0]) }],
    ['unsuccessful report', (r: any) => { r.success = false }],
    ['snapshot failure', (r: any) => { r.snapshot.failure = true }],
  ] as const)('rejects %s', (_name, mutate) => {
    const data = timeout()
    mutate(data.report)
    expect(classify(data).exitCode).toBe(1)
  })
  it.each([
    ['error count mismatch', (s: string) => s.replace('Errors  1 error', 'Errors  2 errors')],
    ['caught count mismatch', (s: string) => s.replace('caught 1 unhandled', 'caught 2 unhandled')],
    ['missing summary', (s: string) => s.replace(/Test Files.*\n/, '')],
    ['missing tests summary', (s: string) => s.replace(/Tests {2}1 passed.*\n/, '')],
    ['missing error count', (s: string) => s.replace(/Errors {2}1 error/, '')],
    ['missing file coverage', (s: string) => s.replace('1 passed (1)', '2 passed (2)')],
    ['unknown timeout method', (s: string) => s.replace('onTaskUpdate', 'onFinished')],
    ['unknown unhandled error', (s: string) => s.replace('[vitest-worker]: Timeout calling "onTaskUpdate"', 'unknown failure')],
    ['worker crash', (s: string) => s + '\nWorker exited unexpectedly\n'],
    ['killed', (s: string) => s + '\nKilled\n'],
    ['OOM', (s: string) => s + '\nFATAL ERROR: Reached heap limit\n'],
    ['segfault', (s: string) => s + '\nSIGSEGV\n'],
    ['other Error', (s: string) => s.replace(' Test Files', 'Error: unexpected teardown\n Test Files')],
    ['other TypeError', (s: string) => s.replace(' Test Files', 'TypeError: unexpected teardown\n Test Files')],
    ['missing unhandled banner', (s: string) => s.replace('Unhandled Errors', 'Missing banner')],
    ['repeated unhandled banner', (s: string) => s.replace(' Test Files', '\u23af Unhandled Errors \u23af\n Test Files')],
    ['ambiguous repeated summary', (s: string) => s + '\nTest Files  1 passed (1)\n'],
    ['unfinished runner warning', (s: string) => s + '\nWARNING: Some tests are still running when generating the JSON report.\n'],
    ['unknown block content', (s: string) => s.replace('Error: [vitest-worker]', 'unrecognized diagnostic\nError: [vitest-worker]')],
  ] as const)('rejects %s output', (_name, mutate) => {
    const data = timeout()
    data.output = mutate(data.output)
    expect(classify(data).exitCode).toBe(1)
  })
  it('allows ANSI/CRLF formatting without weakening the exact message check', () => {
    const data = timeout()
    data.output = '\u001b[31m' + data.output.replaceAll('\n', '\r\n') + '\u001b[0m'
    expect(classify(data).exitCode).toBe(0)
  })
  it('accepts multiple exact timeout blocks only with matching error counts', () => {
    const data = timeout()
    const start = data.output.indexOf('Unhandled Error ')
    const header = data.output.lastIndexOf('\n', start) + 1
    const end = data.output.indexOf('\n\u23af', start)
    const block = data.output.slice(header, end)
    data.output = data.output.slice(0, end) + '\n' + block + data.output.slice(end)
    data.output = data.output.replace('caught 1 unhandled error', 'caught 2 unhandled errors').replace('Errors  1 error', 'Errors  2 errors')
    expect(classify(data)).toEqual({ exitCode: 0, converted: true, errorCount: 2 })
  })
  it('accepts nested suite counts and explicit skipped assertions', () => {
    const data = timeout()
    data.report.numTotalTestSuites = data.report.numPassedTestSuites = 3
    data.report.numTotalTests = 2
    data.report.numPendingTests = 1
    data.report.testResults[0].assertionResults.push({ status: 'skipped', failureMessages: [] })
    data.output = data.output.replace('Tests  1 passed (1)', 'Tests  1 passed | 1 skipped (2)')
    expect(classify(data).exitCode).toBe(0)
  })
})

const expected = [1, 2, 3, 4].map(n => `src/tests/example${n}.test.ts`)
const shards = () => expected.map(path => {
  const data = fixture('pass')
  data.report.testResults[0].name = `/fixture/${path}`
  return { ...data, root: '/fixture', signal: null }
})

describe('WO-2723 complete shard union', () => {
  it('accepts the exact union of four reports', () => {
    expect(checkCoverage(expected, shards())).toBe(4)
  })
  it('rejects a missing report', () => {
    expect(() => checkCoverage(expected, shards().slice(1))).toThrow(/four/)
  })
  it('rejects a missing expected file', () => {
    expect(() => checkCoverage([...expected, 'missing.test.ts'], shards())).toThrow(/missing/)
  })
  it('rejects a duplicate file across shards', () => {
    const reports = shards()
    reports[1].report.testResults[0].name = reports[0].report.testResults[0].name
    expect(() => checkCoverage(expected, reports)).toThrow(/Duplicate/)
  })
  it('rejects an unexpected file', () => {
    expect(() => checkCoverage(expected.slice(1), shards())).toThrow(/unexpected/)
  })
  it('does not allow a passed-looking JSON report to hide a failing exit', () => {
    const reports = shards()
    reports[0].rawExit = 1
    expect(() => checkCoverage(expected, reports)).toThrow(/exit/)
  })
  it('rejects incomplete JSON even when raw exit is zero', () => {
    const reports = shards()
    reports[0].report.testResults[0].status = 'pending'
    expect(() => checkCoverage(expected, reports)).toThrow(/report/)
  })
  it('accepts a converted timeout only after checking the raw log again', () => {
    const reports = shards()
    reports[0].rawExit = 1
    reports[0].output = timeout().output
    expect(checkCoverage(expected, reports)).toBe(4)
  })
  it('rejects paths outside the recorded root and traversal', () => {
    for (const name of ['/other/src/tests/example1.test.ts', '/fixture/../src/tests/example1.test.ts']) {
      const reports = shards()
      reports[0].report.testResults[0].name = name
      expect(() => checkCoverage(expected, reports)).toThrow(/path|root/)
    }
  })
  it('requires complete report counters rather than truthy strings', () => {
    const report = timeout().report
    report.numFailedTests = '0'
    expect(validateReport(report)).toBe(false)
  })
  // Public run 38035495500 shard 1: a describe.skipIf file is "passed" with zero assertions and printed "↓ <path> (0 test)".
  it('accepts a zero-assertion passed file only when the console marks that file skipped', () => {
    const data = timeout()
    const name = data.report.testResults[0].name
    const relative = name.replaceAll('\\', '/').split('/').slice(-2).join('/')
    data.report.testResults[0].assertionResults = []
    data.report.numPassedTests = 0
    data.report.numTotalTests = 0
    expect(validateReport(data.report)).toBe(false)
    expect(validateReport(data.report, 'no skip marker here')).toBe(false)
    expect(validateReport(data.report, ` ↓ other/${relative} (0 test)`)).toBe(false)
    expect(validateReport(data.report, ` ↓ ${relative} (0 test)`)).toBe(true)
  })
})
