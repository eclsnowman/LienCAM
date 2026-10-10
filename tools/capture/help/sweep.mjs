// Foreground route replay. Failures are retained individually, never silently skipped.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
// WO-2708: Windows can reserve 62396-63095 (Hyper-V excluded ports). CAPTURE_PORT_BASE
// moves the four fixed route ports (62492-62495) to BASE..BASE+3.
const port = p => process.env.CAPTURE_PORT_BASE ? String(Number(process.env.CAPTURE_PORT_BASE) + Number(p) - 62492) : p
const jobs = [
  ['WO-2129', 'shoot-help.mjs', port('62492')],
  ['WO-2133', 'walk.mjs', 'setup', 'stock', 'tools', 'op', 'planes', 'membership', 'workholding'],
  ['WO-2133', 'pictures.mjs'],
  ['WO-2134', 'shoot.mjs', 'pictures', 'wizard,source-picker,feedrate-tab,hole-table,bore-passes,tree'],
  ['WO-2134', 'publish.mjs', 'creating-operations__wizard', 'operation-sources__source-picker', 'feeds-speeds__feedrate-tab', 'drill__hole-table', 'bore__bore-passes', 'generation-failures__status-badges', 'cut-time__estimate', 'operation-folders__tree-folders'],
  ['WO-2131', 'capture.mjs'],
  ['WO-2252', 'pictures.mjs'],
  ['WO-2132', 'pictures.mjs'],
  ['WO-2130', 'walk.mjs', 'imports', 'stl', 'step', 'multibody', 'ops', 'cleanup', 'convert', 'model', 'badges'],
  ['WO-2130', 'make-pictures.mjs'],
  ['WO-2135', 'walk.mjs', port('62493'), '--only', 'sim'],
  ['WO-2135', 'walk.mjs', port('62494'), '--only', 'post'],
  ['WO-2135', 'walk.mjs', port('62495'), '--only', 'nest'],
  ['WO-2135', 'make-pictures.mjs'],
]
const dir = 'src/tests/evidence/WO-2491'
const results = []
const selected = process.argv.slice(2)
// WO-2708: one capture run id for every route this sweep starts, so a lane's
// publisher accepts only pictures its shooter took in this same run. Set
// CAPTURE_RUN_ID yourself to span several sweep invocations.
const runId = process.env.CAPTURE_RUN_ID || `sweep-${new Date().toISOString()}`
console.log('CAPTURE_RUN_ID', runId)
for (let i = 0; i < jobs.length; i++) {
  if (selected.length && !selected.includes(String(i))) continue
  const args = jobs[i]
  console.log('ROUTE', i, args.join(' '))
  const log = fs.openSync(`${dir}/route-${i}.log`, 'w')
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, ['tools/capture/help/route.mjs', ...args], { stdio: ['ignore', log, log], env: { ...process.env, CAPTURE_RUN_ID: runId } })
  fs.closeSync(log)
  results.push({ index: i, args, runId, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message ?? null })
  fs.writeFileSync(`${dir}/route-results${selected.length ? '-' + selected.join('-') : ''}.json`, JSON.stringify(results, null, 2) + '\n')
  console.log('RESULT', i, result.status, result.error?.message ?? '')
}
