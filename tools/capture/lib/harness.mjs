/**
 * Shared application capture boundary. A capture script supplies only the
 * project/action/provenance that makes its evidence unique; this module owns
 * Vite, Chromium, app readiness, error collection, screenshots, and JSON.
 */
import { chromium } from 'playwright'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  captureProvenancedScreenshot,
  withViteCaptureServer,
} from './provenance.mjs'

export { captureProvenancedScreenshot, withViteCaptureServer } from './provenance.mjs'

export const CHROMIUM_CAPTURE_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
]

const shotRecord = ({ bytes, hash, sourceProvenance }) => ({
  ...sourceProvenance, screenshotBytes: bytes, screenshotSha256: hash,
})

/** Atomically persist the live source identity for one or more screenshots. */
export function persistCaptureProvenance({ provenancePath, shots }) {
  const absolutePath = path.resolve(provenancePath)
  const tempPath = `${absolutePath}.tmp`
  const entries = Object.entries(shots || {})
  if (!entries.length) throw new TypeError('CAPTURE PROVENANCE HARD-FAIL: at least one shot result is required')
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  rmSync(absolutePath, { force: true })
  rmSync(tempPath, { force: true })
  try {
    writeFileSync(tempPath, `${JSON.stringify({
      schemaVersion: 1,
      shots: Object.fromEntries(entries.map(([name, result]) => [name, shotRecord(result)])),
    }, null, 2)}\n`)
    renameSync(tempPath, absolutePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    rmSync(absolutePath, { force: true })
    throw new Error(`CAPTURE PROVENANCE HARD-FAIL: could not persist provenance.json: ${errorText(error)}`)
  }
  return absolutePath
}

/** Dismiss the forced-choice modal without leaving its dimming scrim behind. */
export async function dismissMachineModal(page) {
  const backdrop = page.locator('.modal-backdrop')
  let hadModal = false
  try {
    await backdrop.first().waitFor({ state: 'visible', timeout: 4000 })
    hadModal = true
  } catch { /* no modal */ }

  let viaButton = false
  if (hadModal) {
    const useBtn = page.getByRole('button', { name: /use this machine/i })
    try {
      if (await useBtn.count()) {
        await useBtn.first().click({ timeout: 2000 })
        viaButton = true
      }
    } catch { /* disabled: the store fallback below is authoritative */ }
    await page.evaluate(() => {
      const state = window.__camStore?.getState?.()
      if (!state?.machineChoiceRequired) return
      const library = state.machineLibrary || []
      const selected = library.find(machine => machine.id === state.appSettings?.defaultMachineId)
        || library[0]
      if (selected && state.setProjectMachine && state.addMachineToLibrary) {
        const bound = { ...selected, id: 'capture-machine', name: 'Capture Machine' }
        if (!library.some(machine => machine.id === bound.id)) state.addMachineToLibrary(bound)
        state.setProjectMachine({ ...bound })
      }
      window.__camStore.getState().setMachineChoiceRequired(false)
    })
    await backdrop.first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  return { dismissed: await backdrop.count() === 0, hadModal, viaButton }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one evidence script against the production app and fail closed on any
 * page or console error. `run` receives { page, capture, loadProject }.
 */
export async function runCaptureHarness({
  port,
  outDir,
  repoRoot = process.cwd(),
  viewport = { width: 1680, height: 900 },
  deviceScaleFactor = 1,
  projectFile,
  resultName = 'capture-result.json',
  timeoutMs = 90_000,
}, run) {
  if (typeof run !== 'function') throw new TypeError('CAPTURE HARNESS HARD-FAIL: run callback is required')
  const outputDirectory = path.resolve(outDir || 'tools/capture/out')
  const resultPath = path.join(outputDirectory, resultName)
  mkdirSync(outputDirectory, { recursive: true })
  rmSync(resultPath, { force: true })

  return withViteCaptureServer({ port, repoRoot, timeoutMs }, async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
    const context = await browser.newContext({ viewport, deviceScaleFactor })
    const page = await context.newPage()
    const pageErrors = []
    const consoleErrors = []
    const shots = {}
    page.on('pageerror', error => pageErrors.push(errorText(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    const loadProject = async (file = projectFile) => {
      if (!file) throw new Error('CAPTURE HARNESS HARD-FAIL: no .camproject path supplied')
      await page.setInputFiles('input[type="file"][accept=".camproject"]', file)
      await page.waitForSelector('[data-testid="project-open-indicator"]', {
        state: 'detached', timeout: 300_000,
      })
      await dismissMachineModal(page)
    }
    const capture = async (name, options = {}) => {
      if (!name || path.basename(name) !== name) {
        throw new Error('CAPTURE HARNESS HARD-FAIL: capture name must be a filename')
      }
      if (options.size) await page.setViewportSize(options.size)
      const shot = await captureProvenancedScreenshot({
        page,
        target: options.target || page,
        outputPath: path.join(outputDirectory, name),
        repoRoot,
        provenance: options.provenance,
        minimumBytes: options.minimumBytes,
        sourcePaths: options.sourcePaths,
        sourceExcludePaths: options.sourceExcludePaths,
        screenshotOptions: options.screenshotOptions,
      })
      shots[name] = shot
      return shot
    }

    let value
    let failure
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForFunction(() => Boolean(window.__camStore), null, { timeout: 30_000 })
      await page.waitForSelector('canvas', { state: 'attached', timeout: 60_000 })
      await dismissMachineModal(page)
      if (projectFile) await loadProject()
      value = await run({ page, capture, loadProject, baseUrl })
      if (pageErrors.length || consoleErrors.length) {
        throw new Error(`CAPTURE HARNESS HARD-FAIL: browser errors: ${JSON.stringify({ pageErrors, consoleErrors })}`)
      }
    } catch (error) {
      failure = error
    } finally {
      if (failure && (pageErrors.length || consoleErrors.length)) {
        for (const shot of Object.values(shots)) rmSync(shot.outputPath, { force: true })
      }
      const result = { value: value ?? null, shots, pageErrors, consoleErrors }
      if (failure) result.failure = errorText(failure)
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
      await context.close()
      await browser.close()
    }
    if (failure) throw failure
    return { value, shots, pageErrors, consoleErrors, resultPath }
  })
}
