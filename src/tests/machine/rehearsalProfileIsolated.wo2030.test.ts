import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fmtMachineLength } from '../../lib/ui/unitFormat'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runRoot = mkdtempSync(path.join(tmpdir(), 'liencam-wo2030-'))
const controlledDefaultProfile = path.join(runRoot, 'default-profile')
const rehearsalProfile = path.join(runRoot, 'native-probe-profile')
const noUccncHere = path.join(runRoot, 'no-uccnc-install')

mkdirSync(controlledDefaultProfile, { recursive: true })
mkdirSync(noUccncHere, { recursive: true })

const runningApps = new Set<ElectronApplication>()

afterEach(async () => {
  await Promise.all([...runningApps].map(async (app) => {
    try { await app.close() } finally { runningApps.delete(app) }
  }))
})
afterAll(() => rmSync(runRoot, { recursive: true, force: true }))

interface ProfileValues {
  g54: { x: number; y: number; z: number }
  tool: number
  setterZ: number
}

interface OpenDesktop {
  app: ElectronApplication
  page: Page
  userData: string
}

function cleanLaunchEnvironment(userData?: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  env.LIENCAM_UCCNC_SEARCH_ROOT = noUccncHere
  delete env.ELECTRON_RUN_AS_NODE
  delete env.LIENCAM_BRIDGE_EXECUTABLE
  delete env.LIENCAM_BRIDGE_ARGS_JSON
  delete env.LIENCAM_USER_DATA_DIR
  if (userData !== undefined) env.LIENCAM_USER_DATA_DIR = userData
  return env
}

async function openDesktop(userData?: string, chromiumUserData?: string): Promise<OpenDesktop> {
  const app = await electron.launch({
    args: [
      '.',
      '--disable-gpu',
      ...(chromiumUserData === undefined ? [] : [`--user-data-dir=${chromiumUserData}`]),
    ],
    cwd: root,
    env: cleanLaunchEnvironment(userData),
  })
  runningApps.add(app)
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    await page.getByTestId('mode-tab-control').waitFor({ timeout: 30_000 })
    // A first-run profile opens the "Try an example" picker. That decision is
    // unrelated to this boundary proof; the default project machine is already
    // the record whose offsets and tool table the UI below edits. Answer it as
    // an operator does, through its own Close button: removing React-owned
    // backdrop nodes by hand later crashed the renderer on the Control tab
    // ("insertBefore ... not a child", WO-2650/WO-2652).
    await page.locator('#liencam-splash').waitFor({ state: 'detached', timeout: 30_000 })
    const picker = page.locator('.modal-backdrop').filter({ hasText: 'Try an example' })
    try {
      await picker.first().waitFor({ state: 'visible', timeout: 10_000 })
      await picker.first().getByRole('button', { name: 'Close example picker' }).click()
      await picker.first().waitFor({ state: 'detached', timeout: 10_000 })
    } catch (error) {
      if (await picker.count()) throw error
    }
    const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    return { app, page, userData: resolvedUserData }
  } catch (error) {
    await app.close()
    runningApps.delete(app)
    throw error
  }
}

async function closeDesktop(desktop: OpenDesktop): Promise<void> {
  try { await desktop.app.close() } finally { runningApps.delete(desktop.app) }
}

async function enterControl(page: Page): Promise<void> {
  await page.getByTestId('mode-tab-control').click({ force: true })
  try {
    await page.getByTestId('control-page').waitFor({ timeout: 30_000 })
  } catch (error) {
    // WO-2650: retain the real renderer on failure; never substitute a green fixture.
    // WO-2652: keep it outside the run directory afterAll removes, and outside
    // private evidence, so this stays a public test (WO-2462 list contract).
    const kept = mkdtempSync(path.join(tmpdir(), 'liencam-wo2030-failure-'))
    await page.screenshot({ path: path.join(kept, 'rehearsal-control-timeout.png') })
    writeFileSync(path.join(kept, 'rehearsal-control-timeout.html'), await page.content())
    throw new Error(`Control page did not open; renderer kept in ${kept}`, { cause: error })
  }
}

async function commitInput(locator: Locator, value: string): Promise<void> {
  await locator.fill(value)
  await locator.press('Enter')
}

async function waitForNumericValue(locator: Locator, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000
  let actual = ''
  while (Date.now() < deadline) {
    actual = await locator.inputValue()
    // Control shows millimetre lengths through fmtMachineLength (2 decimals
    // since WO-2474). Compare the rendered readback with the app's own
    // formatting of the written value; the directory identity assertion
    // separately proves byte identity.
    if (actual === fmtMachineLength(expected, 'mm') || Math.abs(Number(actual) - expected) <= 0.001) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`expected input value ${expected}, received ${actual}`)
}

async function writeThroughApp(page: Page, values: ProfileValues): Promise<void> {
  await enterControl(page)
  await page.getByTestId('control-view-offsets').click()
  await page.getByTestId('offsets-workspace').waitFor()
  await commitInput(page.getByTestId('offsets-workspace-g54-x'), String(values.g54.x))
  await commitInput(page.getByTestId('offsets-workspace-g54-y'), String(values.g54.y))
  await commitInput(page.getByTestId('offsets-workspace-g54-z'), String(values.g54.z))

  await page.getByTestId('control-view-tools').click()
  await page.getByTestId('control-tools-panel').waitFor()
  await page.getByTestId('control-tool-add-input').fill(String(values.tool))
  await page.getByTestId('control-tool-add').click()
  await page.getByTestId(`control-tool-row-${values.tool}`).waitFor()
  await commitInput(page.getByTestId(`control-tool-len-${values.tool}`), String(values.setterZ))
  await page.getByTestId(`control-tool-ref-${values.tool}`).click()

  // Durable project writes are asynchronous. Observing the committed values
  // after a real close/reopen below is the final authority; this pause only
  // lets the current write queue settle before Electron begins shutdown.
  await page.waitForTimeout(500)
}

async function readThroughApp(page: Page, values: ProfileValues): Promise<void> {
  await enterControl(page)
  await page.getByTestId('control-view-offsets').click()
  await page.getByTestId('offsets-workspace').waitFor()
  await waitForNumericValue(page.getByTestId('offsets-workspace-g54-x'), values.g54.x)
  await waitForNumericValue(page.getByTestId('offsets-workspace-g54-y'), values.g54.y)
  await waitForNumericValue(page.getByTestId('offsets-workspace-g54-z'), values.g54.z)

  await page.getByTestId('control-view-tools').click()
  await page.getByTestId(`control-tool-row-${values.tool}`).waitFor({ timeout: 10_000 })
  await waitForNumericValue(page.getByTestId(`control-tool-len-${values.tool}`), values.setterZ)
  await expect(page.getByTestId(`control-tool-ref-${values.tool}`).getAttribute('aria-label'))
    .resolves.toBe(`T${values.tool} is the reference tool`)
}

function directoryIdentity(directory: string): { sha256: string; files: number; bytes: number } {
  const names: string[] = []
  const visit = (current: string, relative: string) => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name)
      const nextRelative = path.join(relative, name).replaceAll('\\', '/')
      const stat = statSync(absolute)
      if (stat.isDirectory()) visit(absolute, nextRelative)
      else names.push(nextRelative)
    }
  }
  visit(directory, '')
  const hash = createHash('sha256')
  let bytes = 0
  for (const name of names) {
    const contents = readFileSync(path.join(directory, ...name.split('/')))
    bytes += contents.byteLength
    hash.update(`${name.length}:${name}:${contents.byteLength}:`)
    hash.update(contents)
  }
  return { sha256: hash.digest('hex'), files: names.length, bytes }
}

describe('WO-2030 rehearsal profile isolation', () => {
  it('keeps the default G54 and tool table byte-identical while the rehearsal profile persists its own values', async () => {
    const sampleMachineProfile: ProfileValues = {
      g54: { x: 188.7325, y: 397.655, z: 66.57 },
      tool: 1,
      setterZ: 52.125,
    }
    const simulatorProfile: ProfileValues = {
      g54: { x: 223.92, y: 388.11, z: 63.41 },
      tool: 19,
      setterZ: 41.24,
    }

    // Electron's own --user-data-dir gives this test a disposable stand-in
    // for the ordinary profile. LIENCAM_USER_DATA_DIR is absent, so the
    // production main process must leave Electron's selected default alone.
    const defaultWrite = await openDesktop(undefined, controlledDefaultProfile)
    expect(path.resolve(defaultWrite.userData)).toBe(path.resolve(controlledDefaultProfile))
    await writeThroughApp(defaultWrite.page, sampleMachineProfile)
    await closeDesktop(defaultWrite)
    const defaultBefore = directoryIdentity(defaultWrite.userData)

    const rehearsalWrite = await openDesktop(rehearsalProfile)
    expect(path.resolve(rehearsalWrite.userData)).toBe(path.resolve(rehearsalProfile))
    await writeThroughApp(rehearsalWrite.page, simulatorProfile)
    await closeDesktop(rehearsalWrite)

    const defaultAfter = directoryIdentity(defaultWrite.userData)
    expect(defaultAfter).toEqual(defaultBefore)

    const rehearsalRead = await openDesktop(rehearsalProfile)
    await readThroughApp(rehearsalRead.page, simulatorProfile)
    await closeDesktop(rehearsalRead)

    const defaultRead = await openDesktop(undefined, controlledDefaultProfile)
    expect(path.resolve(defaultRead.userData)).toBe(path.resolve(defaultWrite.userData))
    await readThroughApp(defaultRead.page, sampleMachineProfile)
    await closeDesktop(defaultRead)

    console.info(JSON.stringify({
      defaultUserData: defaultWrite.userData,
      rehearsalUserData: rehearsalProfile,
      defaultProfileBeforeAndAfter: defaultBefore,
      defaultG54: sampleMachineProfile.g54,
      rehearsalG54: simulatorProfile.g54,
      defaultToolTable: { reference: sampleMachineProfile.tool, setterZ: sampleMachineProfile.setterZ },
      rehearsalToolTable: { reference: simulatorProfile.tool, setterZ: simulatorProfile.setterZ },
    }))
  }, 120_000)
})
