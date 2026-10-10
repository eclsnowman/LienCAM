import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Journey, assert, waitUntil } from './lib/harness.mjs'
import { firstLaunch } from './steps/setup-steps.mjs'
import { answerMachineChoice } from './lib/app.mjs'
import { simulateToEnd } from './steps/simulate-steps.mjs'
import { packagedStarterExample } from './installed-example.mjs'
import { startScreenVideo } from './video.mjs'

const [appPath, base] = process.argv.slice(2)
const outDir = 'C:\\Evidence'
mkdirSync(outDir, { recursive: true })
const journey = new Journey({ appPath, outDir, shots: true })
let traceContext
let exampleReadback
let stopVideo
let recordingError
try {
  await journey.step(1, 'launch clean installed app', async () => {
    await journey.launch('C:\\FreshProfile')
    traceContext = journey.page.context()
    await traceContext.tracing.start({ screenshots: true, snapshots: true, sources: true })
    stopVideo = await startScreenVideo(journey.page, outDir)
    await firstLaunch(journey)
  })
  if (journey.steps[0].status !== 'PASS') throw new Error(journey.steps[0].reason)
  await journey.step(2, 'open installed starter kit Fixture Plate', async () => {
    // Read only the installed asar, not a host example or private source tree.
    const example = await journey.app.evaluate(packagedStarterExample)
    exampleReadback = { name: example.name, sha256: example.sha256 }
    const file = path.join(outDir, example.name)
    writeFileSync(file, example.contents)
    const [chooser] = await Promise.all([journey.page.waitForEvent('filechooser'), journey.page.getByRole('button', { name: 'Open project', exact: true }).click()])
    await chooser.setFiles(file)
    await answerMachineChoice(journey, { timeout: 5000 })
    await journey.page.getByTestId('mode-tab-setup').click()
    await journey.page.getByTestId('tree-name-setup').first().waitFor()
    await waitUntil(async () => /fixture/i.test(await journey.page.getByTestId('tree-name-project').innerText()), { what: 'fixture plate project title' })
    assert(example.contents.length > 100, 'Empty installed example')
    journey.log(`INSTALLED EXAMPLE ${example.name} ${example.contents.length} bytes`)
  })
  if (journey.steps.at(-1).status === 'PASS') await journey.step(3, 'simulate same installed starter kit to end', () => simulateToEnd({ journey, data: {} }))
  await journey.step(4, 'open installed Help', async () => {
    await journey.page.getByTestId('toolbar-help').click()
    await journey.page.getByTestId('help-center').waitFor()
  })
} catch (error) { journey.log(String(error.stack ?? error)) }
finally {
  if (stopVideo) await stopVideo().catch(error => { recordingError = error.message; journey.log(`VIDEO FAIL ${recordingError}`) })
  if (traceContext) await traceContext.tracing.stop({ path: path.join(outDir, 'trace.zip') })
  await journey.close()
  journey.finish()
  for (const file of readdirSync(outDir)) {
    if (!/\.(png|zip|json|txt|log|webm)$/.test(file)) continue
    const response = await fetch(`${base}/evidence/${encodeURIComponent(file)}`, { method: 'POST', body: readFileSync(path.join(outDir, file)) })
    if (!response.ok) throw new Error(`Upload ${file}: ${response.status}`)
  }
  const steps = [{ name: 'install exported setup', status: 'PASS', ms: Number(process.env.STRANGER_INSTALL_MS) }, ...journey.steps]
  const status = !recordingError && journey.steps.length === 4 && journey.steps.every(s => s.status === 'PASS') ? 'PASS' : 'FAIL'
  await fetch(`${base}/result`, { method: 'POST', body: JSON.stringify({ status, steps, example: exampleReadback, reason: recordingError }) })
}
