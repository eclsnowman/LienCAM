import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { emissionIdentityAt, emissionInputHashes, expectEmissionCheckout, expectMainEmission,
  git, sha256, type EmissionReceipt } from './emissionReceipt.wo2914'

// The architect requests a fresh main comparison after WO-2926 refreshed the
// example inputs and GOLD. Preserve the original captures; v2 records exact Git
// trees and actual input bytes so metadata-only main movement needs no re-post.
const phase = process.env.WO2914_EMISSION
const evidence = 'src/tests/evidence/WO-2914'

it.skipIf(!phase)('WO-2914 integrated emission matches current main with identical inputs', async () => {
  expect(['main', 'branch']).toContain(phase)
  const source = git('rev-parse', phase === 'main' ? 'main' : 'HEAD').trim()
  // For main, the worker temporarily restores only the granted product files
  // inside this worktree. Require the complete production tree to match main.
  expectEmissionCheckout(source)
  const identity = emissionIdentityAt(source)
  const inputs = emissionInputHashes()
  const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e',
    "import { postAll } from './tools/examples/post-all.mjs'; console.log('WO2914_RESULT='+JSON.stringify(await postAll({check:true})));"],
  { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (error, output, stderr) =>
    error ? reject(new Error(`${error}\n${output}\n${stderr}`)) : resolve(output)))
  const result = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('WO2914_RESULT='))!.slice('WO2914_RESULT='.length))
  const capture = { source, workingHead: git('rev-parse', 'HEAD').trim(), identity, inputs, result, stdout }
  writeFileSync(`${evidence}/receipt-v2-${phase}-gcode.json`, JSON.stringify(capture, null, 2) + '\n')
  expectEmissionCheckout(source)
  expect(emissionInputHashes()).toEqual(inputs)
  expect(result.files).toHaveLength(45)
  expect(result.differences).toEqual([])
  const comparedMainSource = git('rev-parse', 'main').trim()
  for (const file of result.files) {
    const bytes = execFileSync('git', ['show', `${comparedMainSource}:examples/gcode/${file.filename}`], { maxBuffer: 32 * 1024 * 1024 })
    expect(file.sha256, file.filename).toBe(sha256(bytes))
  }
  if (phase === 'branch') {
    const main: EmissionReceipt = JSON.parse(readFileSync(`${evidence}/receipt-v2-main-gcode.json`, 'utf8'))
    expectMainEmission(main, comparedMainSource, inputs, result)
    writeFileSync(`${evidence}/receipt-v2-main-equivalence.json`, JSON.stringify({
      recordedMainSource: main.source, comparedMainSource, branchSource: source,
      productionTreeSha256: sha256(JSON.stringify(main.identity.production)),
      consumedInputTreeSha256: sha256(JSON.stringify(main.identity.inputs)),
      consumedBytesSha256: sha256(JSON.stringify(inputs)), filesEqual: true, currentGoldDifferences: result.differences,
    }, null, 2) + '\n')
  }
}, 650_000)
