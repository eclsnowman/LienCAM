#!/usr/bin/env node
import { isMain } from '../lib/is-main.mjs';
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const timeoutMessage = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"'
const count = value => Number.isSafeInteger(value) && value >= 0

// Vitest's suite count includes nested describe blocks, not just files. Compare
// files against the console summary; reconcile assertions separately with JSON.
// A file whose tests are all skipped at describe level (describe.skipIf) is reported "passed" with zero assertions;
// vitest prints it as "↓ <path> (0 test)". Only that console proof lets a zero-assertion file through (public run
// 38035495500 shard 1: src/tests/examples/_exampleGenerate.probe.test.ts).
function skippedInConsole(output, name) {
  if (typeof output !== 'string') return false
  const text = stripVTControlCharacters(output).replaceAll('\r\n', '\n').replaceAll('\\', '/')
  const file = name.replaceAll('\\', '/')
  return [...text.matchAll(/^ *↓ (\S+) \(0 tests?\)\s*$/gm)].some(match => file.endsWith('/' + match[1]))
}

export function validateReport(report, output) {
  const fields = ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']
  if (!report || fields.some(key => !count(report[key]))) return false
  if (report.success !== true || report.numFailedTestSuites !== 0 || report.numFailedTests !== 0 || report.numPendingTestSuites !== 0) return false
  if (report.snapshot?.failure || report.snapshot?.unmatched > 0) return false
  if (report.numPassedTestSuites !== report.numTotalTestSuites) return false
  if (!Array.isArray(report.testResults) || !report.testResults.length || report.numTotalTestSuites < report.testResults.length) return false
  const assertions = { passed: 0, skipped: 0, todo: 0 }
  const names = new Set()
  for (const file of report.testResults) {
    if (!file || typeof file.name !== 'string' || !file.name || names.has(file.name)) return false
    names.add(file.name)
    if (!['passed', 'skipped'].includes(file.status) || file.message !== '' || !Array.isArray(file.assertionResults)) return false
    if (file.status === 'passed' && file.assertionResults.length === 0 && !skippedInConsole(output, file.name)) return false
    for (const assertion of file.assertionResults) {
      if (!assertion || !Object.hasOwn(assertions, assertion.status) || !Array.isArray(assertion.failureMessages) || assertion.failureMessages.length) return false
      assertions[assertion.status]++
    }
  }
  return assertions.passed === report.numPassedTests
    && assertions.skipped === report.numPendingTests
    && assertions.todo === report.numTodoTests
    && Object.values(assertions).reduce((a, b) => a + b, 0) === report.numTotalTests
}

function summary(text, label) {
  const matches = [...text.matchAll(new RegExp(`^\\s*${label} +(.+) \\((\\d+)\\)\\s*$`, 'gm'))]
  if (matches.length !== 1) return null
  const statuses = {}
  for (const part of matches[0][1].split(' | ')) {
    const match = part.trim().match(/^(\d+) (passed|skipped|todo)$/)
    if (!match || Object.hasOwn(statuses, match[2])) return null
    statuses[match[2]] = Number(match[1])
  }
  const total = Number(matches[0][2])
  return Object.values(statuses).reduce((a, b) => a + b, 0) === total ? { total, ...statuses } : null
}

export function classifyResult(rawExit, output, report, signal = null) {
  const unchanged = { exitCode: rawExit ?? 1, converted: false, errorCount: 0 }
  if (signal) return { ...unchanged, exitCode: rawExit || 1 }
  if (rawExit !== 1 || !validateReport(report, output)) return unchanged
  const text = stripVTControlCharacters(output).replaceAll('\r\n', '\n')
  // WO-2723: never generalize this to arbitrary worker errors. A collection
  // failure, teardown crash or incomplete update must remain red.
  // Process-level crash signals only. A bare "OOM"/"killed" word also appears in passing test names and in-test logs
  // (public run 38035495500: "...without OOM", a WASM "Aborted(OOM)" inside a passing perf ladder); an actually
  // crashed worker also leaves an incomplete report, which validateReport rejects.
  if (/worker.*(?:exited|killed)|out of memory|heap limit|SIG(?:KILL|SEGV|ABRT)|segmentation fault|segfault|^Killed\s*$|Some tests are still running/im.test(text)) return unchanged
  const fileSummary = summary(text, 'Test Files')
  const testSummary = summary(text, 'Tests')
  if (!fileSummary || fileSummary.total !== report.testResults.length || fileSummary.todo
    || !testSummary || testSummary.total !== report.numTotalTests
    || (testSummary.passed ?? 0) !== report.numPassedTests
    || (testSummary.skipped ?? 0) !== report.numPendingTests
    || (testSummary.todo ?? 0) !== report.numTodoTests) return unchanged
  const errors = [...text.matchAll(/^\s*Errors +(\d+) errors?\s*$/gm)]
  const caught = [...text.matchAll(/^Vitest caught (\d+) unhandled errors? during the test run\.$/gm)]
  if (errors.length !== 1 || caught.length !== 1) return unchanged
  const errorCount = Number(errors[0][1])
  if (!errorCount || Number(caught[0][1]) !== errorCount) return unchanged
  // Parse every error block, not occurrences of a message somewhere in stdout.
  // Reject unfamiliar block contents instead of guessing whether they are safe.
  const blocks = [...text.matchAll(/^[\u23af\u2500-\u257f-]+ (Unhandled [^\n]+?) [\u23af\u2500-\u257f-]+\n([\s\S]*?)(?=^[\u23af\u2500-\u257f-]+|$(?![\s\S]))/gm)]
    .filter(match => match[1] !== 'Unhandled Errors')
  if (blocks.length !== errorCount) return unchanged
  for (const block of blocks) {
    const lines = block[2].trim().split('\n')
    if (block[1] !== 'Unhandled Error' || lines[0] !== timeoutMessage
      || lines.slice(1).some(line => line.trim() && !/^\s*(?:\u276f|at) .+:\d+:\d+\)?\s*$/.test(line))) return unchanged
  }
  // Passing tests intentionally print console errors (public job 114143460158).
  // Only Vitest's unhandled region describes runner errors; require its unique
  // banner and closing summary so missing/ambiguous boundaries stay red.
  const banners = [...text.matchAll(/^[\u23af\u2500-\u257f-]+ Unhandled Errors [\u23af\u2500-\u257f-]+\s*$/gm)]
  const summaryStart = text.search(/^ *Test Files +/m)
  if (banners.length !== 1 || summaryStart <= banners[0].index) return unchanged
  const unhandled = text.slice(banners[0].index, summaryStart)
  const errorLines = unhandled.split('\n').filter(line => /\b\w*Error:/.test(line))
  if (errorLines.length !== errorCount || errorLines.some(line => line !== timeoutMessage)) return unchanged
  // Nothing may report an error from the summary onwards (a teardown or reporter failure printed after the report was
  // written, Rholand 10-10). In-test console errors print earlier, before the unhandled region, and stay allowed.
  if (text.slice(summaryStart).split('\n').some(line => /\b\w*Error:|\bfatal\b/i.test(line))) return unchanged
  return { exitCode: 0, converted: true, errorCount }
}

export function checkCoverage(expected, shards) {
  if (shards.length !== 4) throw new Error('Expected all four shard reports')
  const seen = new Set()
  for (const shard of shards) {
    if (!validateReport(shard.report, shard.output)) throw new Error('Incomplete or failed shard report')
    if (classifyResult(shard.rawExit, shard.output, shard.report, shard.signal).exitCode !== 0) throw new Error('Failed shard exit')
    if (typeof shard.root !== 'string' || !shard.root) throw new Error('Missing shard root')
    // Artifacts originate on Linux CI, but support Windows paths in local proof.
    const root = shard.root.replaceAll('\\', '/').replace(/\/$/, '') + '/'
    for (const file of shard.report.testResults) {
      const name = file.name.replaceAll('\\', '/')
      if (!name.startsWith(root)) throw new Error(`File outside shard root: ${name}`)
      const path = name.slice(root.length)
      if (path.split('/').some(part => !part || /^[.]{1,2}$/.test(part))) throw new Error(`Invalid file path: ${path}`)
      if (seen.has(path)) throw new Error(`Duplicate file: ${path}`)
      seen.add(path)
    }
  }
  const wanted = new Set(expected)
  const missing = expected.filter(path => !seen.has(path))
  const extra = [...seen].filter(path => !wanted.has(path))
  if (!wanted.size || wanted.size !== expected.length || missing.length || extra.length) throw new Error(`Coverage mismatch; missing: ${missing.join(', ')}; unexpected: ${extra.join(', ')}`)
  return seen.size
}

export async function runTests(args, { root = process.cwd(), directory = process.env.PUBLIC_TEST_RESULTS_DIR } = {}) {
  const shard = args.find(arg => arg.startsWith('--shard='))?.slice(8) ?? 'local'
  directory = resolve(directory ?? `public-test-results/public-tests-${shard.split('/')[0]}`)
  mkdirSync(directory, { recursive: true })
  // Never let a killed launch inherit JSON or a verdict from an earlier run.
  for (const name of ['report.json', 'output.log', 'result.json']) rmSync(resolve(directory, name), { force: true })
  const reportPath = resolve(directory, 'report.json')
  const cli = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
  const child = spawn(process.execPath, [cli, 'run', '--config', 'vitest.public.config.mts', ...args, '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] })
  let output = ''
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8')
    stream.on('data', data => { output += data; target.write(data) })
  }
  const forwardInterrupt = () => child.kill('SIGINT')
  const forwardTerminate = () => child.kill('SIGTERM')
  process.on('SIGINT', forwardInterrupt)
  process.on('SIGTERM', forwardTerminate)
  let launchError
  child.on('error', error => { launchError = error.message })
  const [rawExit, signal] = await new Promise(resolve => child.on('close', (code, signal) => resolve([code, signal])))
  process.off('SIGINT', forwardInterrupt)
  process.off('SIGTERM', forwardTerminate)
  let report
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { /* Keep the raw failure. */ }
  const verdict = classifyResult(rawExit, output, report, signal)
  writeFileSync(resolve(directory, 'output.log'), output)
  writeFileSync(resolve(directory, 'result.json'), JSON.stringify({ root: resolve(root), run: shard, rawExit, signal, launchError, ...verdict }, null, 2) + '\n')
  if (verdict.converted) console.log(`public tests ${shard}: accepted ${verdict.errorCount} onTaskUpdate timeout error(s); every test passed; raw exit ${rawExit} retained in ${relative(root, directory)}`)
  return verdict.exitCode
}

async function main(args) {
  if (args[0] !== '--summary') return runTests(args)
  if (args.length !== 2) throw new Error('Usage: public-test-run.mjs --summary <artifact-directory>')
  const directory = resolve(args[1])
  const expectedNames = [1, 2, 3, 4].map(index => `public-tests-${index}`)
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expectedNames)) throw new Error('Missing or unexpected shard artifacts')
  const shards = expectedNames.map((name, index) => {
    const read = file => readFileSync(resolve(directory, name, file), 'utf8')
    const result = JSON.parse(read('result.json'))
    if (result.run !== `${index + 1}/4` || result.signal !== null || !Number.isInteger(result.rawExit)) throw new Error(`Invalid shard identity: ${name}`)
    return { ...result, report: JSON.parse(read('report.json')), output: read('output.log') }
  })
  // CLI-only dependency: the selector contains private path names as exclusion
  // rules, not fixture inputs for this module's public classifier tests.
  const { buildPublicTestList } = await import(new URL('./public-tests.mjs', import.meta.url).href)
  console.log(`public tests summary: ${checkCoverage(buildPublicTestList().kept, shards)} files covered exactly once`)
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error(`public tests: ${error.message}`)
    process.exitCode = 1
  })
}
