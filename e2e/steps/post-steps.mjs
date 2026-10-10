// Step 8: post the project with every shipped dialect and save each file.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { assert, escapeRegex, waitUntil } from '../lib/harness.mjs'
import { revisitModel } from '../lib/app.mjs'
import { bringAllReady } from './cam-steps.mjs'

// The preview header reads "<dialect> <separator> <n> lines".
function linesPattern(dialect) {
  return new RegExp(`${escapeRegex(dialect)}\\s*\\S\\s*([\\d,]+) lines`)
}

/**
 * Open Post Process, wait for the preview, export the file through the Save
 * dialog. Returns { dialect, lines, file, bytes, diagnostics }.
 */
export async function postToFile(journey, dir, prefix) {
  try {
    return await postOnce(journey, dir, prefix)
  } catch (error) {
    const outdated = /OP_OUTDATED/.test(error.message)
    const unverified = /OP_MODEL_REFS_UNVERIFIED/.test(error.message)
    if (!outdated && !unverified) throw error
    await closePostModal(journey.page)
    if (unverified) {
      journey.note(`Post Process refused with OP_MODEL_REFS_UNVERIFIED ("open each referenced Model Item once ... then come back and post"); opened the Model workspace, pressed Finish, and posted again.`)
      await revisitModel(journey)
    }
    if (outdated) {
      journey.note(`Post Process refused operations as out of date right after they were generated ready (${(error.message.match(/Operation "[^"]+" is out of date/g) ?? []).join('; ')}); brought them ready again and posted again.`)
    }
    await bringAllReady(journey)
    return postOnce(journey, dir, prefix)
  }
}

async function closePostModal(page) {
  const modal = page.locator('.modal-backdrop').filter({ has: page.getByTestId('post-gcode-preview') })
  if (!(await modal.count())) return
  await modal.locator('.modal-close-btn').first().click().catch(() => page.keyboard.press('Escape'))
  await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

async function postOnce(journey, dir, prefix, postId) {
  const page = journey.page
  await page.getByTestId('mode-tab-postprocess').click()
  const preview = page.getByTestId('post-gcode-preview')
  await preview.waitFor({ timeout: 30_000 })
  if (postId) {
    await page.getByTestId('post-definition-select').click()
    await page.getByTestId(`post-definition-select-option-${postId}`).click()
  }
  const dialect = (await page.getByTestId('post-definition-select').innerText()).trim()
  const modal = page.locator('.modal-backdrop').filter({ has: preview })
  let header = ''
  const opened = Date.now()
  const outcome = await waitUntil(async () => {
    header = await modal.innerText()
    const m = header.match(linesPattern(dialect))
    if (m && Number(m[1].replace(/,/g, '')) > 0) return 'posted'
    // A refusal ([X] diagnostics) that has stood for 5 s is the answer, not a slow preview.
    if (/\[X\]/.test(header) && Date.now() - opened > 5_000) return 'refused'
    return false
  }, { timeout: 120_000, what: `the ${dialect} preview to show G-code` }).catch(() => 'timeout')
  if (outcome !== 'posted') {
    const diagnostics = (header.match(/DIAGNOSTICS([\s\S]*?)(Import Post|$)/) ?? ['', ''])[1].replace(/\s+/g, ' ').trim()
    throw new Error(`Post Process (${dialect}) produced no G-code: ${diagnostics.slice(0, 600)}`)
  }
  const lines = Number(header.match(linesPattern(dialect))[1].replace(/,/g, ''))
  const diagnostics = (header.match(/DIAGNOSTICS([\s\S]*?)(Import Post|$)/) ?? ['', ''])[1].replace(/\s+/g, ' ').trim()
  const exportButton = modal.getByRole('button', { name: /Export \./ })
  await waitUntil(() => exportButton.isEnabled(), { timeout: 30_000, what: 'Export to be available' }).catch(async () => {
    throw new Error(`Export is greyed: ${await exportButton.getAttribute('data-tooltip')}`)
  })
  const saved = await journey.answerNextSaveDialog(dir, prefix)
  await exportButton.click()
  const file = await saved()
  await waitUntil(() => existsSync(file) && statSync(file).size > 0, { timeout: 30_000, what: `${file} to be written` })
  const bytes = readFileSync(file)
  journey.log(`POST ${dialect}: ${lines} lines, ${bytes.length} bytes -> ${file}${diagnostics ? ` | diagnostics: ${diagnostics.slice(0, 300)}` : ''}`)
  await journey.scene(`post-preview-${dialect.toLowerCase().replace(/\W+/g, '-')}`)
  await modal.locator('.modal-close-btn').first().click().catch(() => page.keyboard.press('Escape'))
  await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  return { dialect, lines, file, bytes, diagnostics }
}

/** Read the shipped formats from the real Post Process picker. */
async function postOptions(journey) {
  const page = journey.page
  await page.getByTestId('mode-tab-postprocess').click()
  const picker = page.getByTestId('post-definition-select')
  await picker.click()
  const options = await page.getByRole('listbox', { name: 'Post definition' })
    .locator('.themed-listbox-group').filter({ hasText: 'Built-in templates' })
    .getByRole('option').evaluateAll(elements => elements.map(element => ({
      value: element.getAttribute('data-testid').replace('post-definition-select-option-', ''),
      label: element.textContent.trim(),
    })))
  await picker.press('Escape')
  await closePostModal(page)
  assert(options.length > 0, 'Post Process offers no built-in formats')
  return options
}

/** STEP 8 */
export async function postEveryDialect(ctx) {
  const { journey, filesDir } = ctx
  const formats = await postOptions(journey)
  journey.log(`POST formats offered: ${formats.map((format) => format.label).join(', ')}`)
  const results = []
  const failures = []
  for (const format of formats) {
    try {
      // No machine edit or regenerate/retry: a ready job must post directly
      // in every selected format, or this step records the actual failure.
      const posted = await postOnce(journey, filesDir, `post-${format.value}-`, format.value)
      results.push({ controller: format.label, dialect: posted.dialect, lines: posted.lines, bytes: posted.bytes.length, file: posted.file })
      if (format.value === 'grbl') ctx.data.grblFile = posted.file
    } catch (error) {
      failures.push(`${format.label}: ${error.message.split('\n')[0]}`)
      journey.log(`POST ${format.label} failed: ${error.stack ?? error}`)
      await journey.shot(`step-08-${format.value}-failed`).catch(() => {})
      const modal = journey.page.locator('.modal-backdrop')
      if (await modal.count()) await modal.locator('.modal-close-btn').first().click().catch(() => {})
    }
  }
  ctx.data.posts = results
  journey.log(`POST results ${JSON.stringify(results)}`)
  assert(results.length > 0, 'no dialect produced a file')
  assert(!failures.length, failures.join(' | '))
}
