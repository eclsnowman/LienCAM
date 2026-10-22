import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emissionIdentityAt, emissionInputHashes, expectCurrentEmission, expectEmissionCheckout,
  git } from './emissionReceipt.wo2914'

// An explicit production Open -> staging -> post capture. No GOLD is regenerated.
// Long-running 56-chain stick captures remain owned by the shared Spark harness;
// this named test checks the 45 browser-produced programs against inherited 2906.
describe('WO-2914 production emission identity', () => {
  it.skipIf(!process.env.WO2914_CAPTURE)('preserves every emitted byte from the inherited branch', async () => {
    const source = git('rev-parse', 'HEAD').trim()
    expectEmissionCheckout(source)
    const inputs = emissionInputHashes()
    const result = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e',
      "import { postAll } from './tools/examples/post-all.mjs'; const result = await postAll({check:true}); console.log('WO2914_RESULT='+JSON.stringify(result));"],
    { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${error}\n${stdout}\n${stderr}`)) : resolve(stdout)))
    const line = result.split(/\r?\n/).find(line => line.startsWith('WO2914_RESULT='))!
    const capture = JSON.parse(line.slice('WO2914_RESULT='.length))
    const before = JSON.parse(readFileSync('src/tests/evidence/WO-2906/paired-current-20261017/branch-gcode.json', 'utf8'))
    writeFileSync('src/tests/evidence/WO-2914/receipt-v2-production-gcode.json', JSON.stringify({
      source, identity: emissionIdentityAt(source), inputs, result: capture,
      historical: { path: 'src/tests/evidence/WO-2906/paired-current-20261017/branch-gcode.json',
        differences: before.differences },
    }, null, 2) + '\n')
    expectEmissionCheckout(source)
    expect(emissionInputHashes()).toEqual(inputs)
    expectCurrentEmission(capture, before)
  }, 650_000)
})
