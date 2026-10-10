// Step 7: save the project, close the app, reopen it and the project file;
// the operations, their toolpaths and the posted G-code must come back identical.
import { existsSync, statSync } from 'node:fs'
import { assert, waitUntil } from '../lib/harness.mjs'
import { answerMachineChoice, discardIfAsked, revisitModel } from '../lib/app.mjs'
import { bringAllReady, expandSetups, operationStatuses } from './cam-steps.mjs'
import { postToFile } from './post-steps.mjs'

const LINE_BREAK = /\r?\n/
const LCX_LINE = /^\( LCX1 /
const LCX_CHUNK = /^\( LCX1 \d+\/\d+ (\S+) \)$/

/** The posted program: every line except the LCX1 provenance trailer. */
function programLines(bytes) {
  return bytes.toString('utf8').split(LINE_BREAK).filter((line) => !LCX_LINE.test(line))
}

/** The decoded LCX1 trailer, or null when the post carries none. */
function lcxTrailer(bytes) {
  const chunks = bytes.toString('utf8').split(LINE_BREAK)
    .map((line) => line.match(LCX_CHUNK)?.[1]).filter(Boolean)
  if (!chunks.length) return null
  try {
    return JSON.parse(Buffer.from(chunks.join(''), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

async function projectFacts(page) {
  await page.getByTestId('mode-tab-toolpath').click()
  // WO-2271: the legend counts the move types of the toolpaths SHOWN, which is
  // only the selected operation when one is selected (and the selection rides
  // the saved file). Read it on the same view every time: clicking the setup
  // header selects the setup and clears the operation selection (it also
  // toggles the row, so expand again after). The chevron, not the name: a
  // click on the name can start a rename.
  const chevron = page.locator('.tree-setup-header .tree-chevron').first()
  if (await chevron.isVisible().catch(() => false)) await chevron.click()
  await expandSetups(page)
  const operations = await operationStatuses(page)
  const setupRow = (await page.locator('.tree-setup-header').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const legend = (await page.getByTestId('tp-legend-chip-badge').innerText().catch(() => '')).trim()
  return { operations, setupRow, legend }
}

/** STEP 7 */
export async function saveCloseReopen(ctx) {
  const { journey, profileDir, filesDir } = ctx
  let page = journey.page
  const before = await projectFacts(page)
  journey.log(`PROJECT before save ${JSON.stringify(before)}`)
  const postedBefore = await postToFile(journey, filesDir, 'before-save-')

  const saved = await journey.answerNextSaveDialog(filesDir, '')
  await page.getByRole('button', { name: 'Save project' }).click()
  const projectFile = await saved()
  await waitUntil(() => existsSync(projectFile) && statSync(projectFile).size > 0, { what: `${projectFile} to be written` })
  journey.log(`PROJECT saved ${projectFile} (${statSync(projectFile).size} bytes)`)
  ctx.data.projectFile = projectFile

  await journey.close()
  page = await journey.launch(profileDir)
  await answerMachineChoice(journey)
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.getByRole('button', { name: 'Open project' }).click(),
  ])
  journey.log(`FILE-DIALOG answer ${projectFile}`)
  await chooser.setFiles(projectFile)
  // Open asks Save / Discard / Cancel after the file is chosen (WO-2704); its Save
  // would open a Save dialog, so answer Discard before any other confirmation.
  await discardIfAsked(journey)
  const confirm = page.getByTestId('confirm-dialog-confirm')
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    journey.log(`CONFIRM ${await page.getByTestId('confirm-dialog').innerText()}`)
    await confirm.click()
  }
  await page.getByTestId('project-open-indicator').waitFor({ state: 'detached', timeout: 300_000 }).catch(() => {})
  await page.waitForTimeout(2_000)
  await answerMachineChoice(journey)
  const reopened = await projectFacts(page)
  journey.log(`PROJECT reopened ${JSON.stringify(reopened)}`)
  const stale = reopened.operations.filter((o) => o.state !== 'ready')
  if (stale.length) journey.note(`After reopening, ${stale.length} operation(s) were not ready (${stale.map((o) => `${o.name}: ${o.state}`).join(', ')}); pressed REGEN ALL.`)
  const regenerated = await bringAllReady(journey, before.operations.length)
  const unsupported = regenerated.filter((o) => o.state === 'unsupported')
  if (unsupported.length) {
    journey.note(`After reopening, REGEN ALL left ${unsupported.map((o) => `${o.name} "unsupported" (${o.message})`).join('; ')}; opened the Model workspace, pressed Finish, and brought the operations ready again.`)
    await revisitModel(journey)
    await bringAllReady(journey, before.operations.length)
  }
  const after = await projectFacts(page)
  journey.log(`PROJECT after regenerate ${JSON.stringify(after)}`)
  const postedAfter = await postToFile(journey, filesDir, 'after-reopen-')

  const names = (facts) => facts.operations.map((o) => `${o.name}:${o.state}`).join(', ')
  const differences = []
  if (names(after) !== names(before)) differences.push(`operations before [${names(before)}] after [${names(after)}]`)
  if (after.setupRow !== before.setupRow) differences.push(`setup row "${before.setupRow}" vs "${after.setupRow}"`)
  if (after.legend !== before.legend) differences.push(`toolpath legend count ${before.legend} vs ${after.legend}`)
  // WO-2271: the program is compared byte for byte; the LCX1 provenance trailer
  // after it is not, because it stamps the post time (generatedAt), so two
  // posts of the same program never match. Its motion digest must still match.
  const a = programLines(postedBefore.bytes)
  const b = programLines(postedAfter.bytes)
  if (a.join('\n') !== b.join('\n')) {
    const at = a.findIndex((line, i) => line !== b[i])
    differences.push(`posted G-code ${postedBefore.bytes.length} bytes / ${postedBefore.lines} lines before, ${postedAfter.bytes.length} bytes / ${postedAfter.lines} lines after; first program difference at line ${at + 1}: "${a[at]}" vs "${b[at]}"`)
  }
  const trailerBefore = lcxTrailer(postedBefore.bytes)
  const trailerAfter = lcxTrailer(postedAfter.bytes)
  if (trailerBefore?.motionDigest !== trailerAfter?.motionDigest) {
    differences.push(`posted motion digest ${trailerBefore?.motionDigest} before, ${trailerAfter?.motionDigest} after`)
  }
  const drifted = (trailerBefore?.operations ?? []).filter((op, i) =>
    op.generationFingerprint !== trailerAfter?.operations?.[i]?.generationFingerprint).map((op) => op.name)
  if (drifted.length) journey.note(`Posted program identical; the trailer's generation fingerprint changed for ${drifted.join(', ')}.`)
  ctx.data.reopenDifferences = differences
  assert(!differences.length, `after save, close and reopen: ${differences.join('; ')}`)
  ctx.data.reopen = { operations: after.operations.length, gcodeBytes: postedAfter.bytes.length, gcodeLines: postedAfter.lines }
}
