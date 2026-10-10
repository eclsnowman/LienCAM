#!/usr/bin/env node
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { GEOMETRY_ID, OPERATION_ID, PROJECT_ID, makeReloadFixture } from './fixture.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-243')
const CAPTURE_BEFORE = process.argv.includes('--capture-before')
const PORT = 4193
const URL = `http://localhost:${PORT}/`
const RESEED_URL = `${URL}src/tests/e2e-project-reload/storage-reseed.html`

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

function waitForServer(timeoutMs = 60_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => http.get(URL, (res) => { res.resume(); resolve() }).on('error', () => {
      if (Date.now() - started > timeoutMs) reject(new Error(`dev server did not start at ${URL}`))
      else setTimeout(tick, 300)
    })
    tick()
  })
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: true, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

async function launchChromium(profileDir) {
  try {
    return await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1400, height: 900 },
    })
  } catch (error) {
    if (!/Executable doesn't exist/.test(error instanceof Error ? error.message : String(error))) throw error
    console.log('[reload-smoke] Chromium missing; installing it once...')
    await runToCompletion('npx', ['playwright', 'install', 'chromium'])
    return chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1400, height: 900 },
    })
  }
}

function killTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    return
  }
  // spawn reports a missing executable ASYNCHRONOUSLY; the listener is what
  // keeps that from becoming an unhandled 'error' event.
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    killer.once('error', () => {})
  } catch { /* the tree is already gone */ }
}

async function readState(page) {
  return page.evaluate(({ geometryId, operationId }) => {
    const state = window.__camStore.getState()
    const viewport = window.__cncViewport
    const geometry = state.project.geometry.find((item) => item.id === geometryId)
    const operation = state.project.setups.flatMap((setup) => setup.operations)
      .find((item) => item.id === operationId)
    const group = viewport?.partGroups?.get(geometryId)
    let meshCount = 0
    let vertexCount = 0
    group?.traverse((child) => {
      if (!child.isMesh) return
      meshCount += 1
      vertexCount += child.geometry?.getAttribute?.('position')?.count ?? 0
    })
    return {
      projectId: state.project.id,
      geometry: geometry && { loaded: geometry.loaded, hidden: geometry.hidden, format: geometry.format },
      operation: operation && {
        status: operation.status,
        geometrySelections: operation.geometrySelections,
        moveCount: operation.toolpathMoves?.length ?? 0,
      },
      brepImportError: state.brepImportError,
      scene: group && { visible: group.visible, attached: group.parent != null, meshCount, vertexCount },
    }
  }, { geometryId: GEOMETRY_ID, operationId: OPERATION_ID })
}

async function waitForHydration(page) {
  await page.waitForFunction(() => window.__camStore?.persist?.hasHydrated?.() === true, null, { timeout: 30_000 })
}

async function waitForDurableProject(page) {
  await page.waitForFunction(async (projectId) => {
    const key = 'cnc-cam-project'
    try {
      const root = await navigator.storage.getDirectory()
      const safeKey = encodeURIComponent(key)
      const pointerFile = await root.getFileHandle(`liencam-user-space--${safeKey}--pointer.json`)
      const pointer = JSON.parse(await (await pointerFile.getFile()).text())
      const generationFile = await root.getFileHandle(
        `liencam-user-space--${safeKey}--generation--${encodeURIComponent(pointer.current)}.json`,
      )
      const envelope = JSON.parse(await (await generationFile.getFile()).text())
      return JSON.parse(envelope.payload)?.state?.project?.id === projectId
    } catch { return false }
  }, PROJECT_ID, { timeout: 30_000 })
}

async function waitForDurableProjectToQuiesce(page) {
  const deadline = Date.now() + 30_000
  let stableGeneration = null
  let stableSince = 0
  while (Date.now() < deadline) {
    const durable = await page.evaluate(async (projectId) => {
      const key = 'cnc-cam-project'
      try {
        const root = await navigator.storage.getDirectory()
        const safeKey = encodeURIComponent(key)
        const pointerFile = await root.getFileHandle(`liencam-user-space--${safeKey}--pointer.json`)
        const pointer = JSON.parse(await (await pointerFile.getFile()).text())
        const generationFile = await root.getFileHandle(
          `liencam-user-space--${safeKey}--generation--${encodeURIComponent(pointer.current)}.json`,
        )
        const envelope = JSON.parse(await (await generationFile.getFile()).text())
        return {
          generation: pointer.current,
          matchesProject: JSON.parse(envelope.payload)?.state?.project?.id === projectId,
        }
      } catch { return null }
    }, PROJECT_ID)
    if (durable?.matchesProject && durable.generation === stableGeneration) {
      if (Date.now() - stableSince >= 1_000) return
    } else if (durable?.matchesProject) {
      stableGeneration = durable.generation
      stableSince = Date.now()
    } else {
      stableGeneration = null
      stableSince = 0
    }
    await page.waitForTimeout(100)
  }
  throw new Error('durable project writes did not quiesce before OPFS reseeding')
}

await mkdir(EVIDENCE, { recursive: true })
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString() })
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString() })
const profileDir = await mkdtemp(path.join(tmpdir(), 'liencam-wo243-'))
let browserContext
let page
const pageErrors = []
try {
  await waitForServer()
  browserContext = await launchChromium(profileDir)
  page = browserContext.pages()[0] ?? await browserContext.newPage()
  page.on('pageerror', (error) => pageErrors.push(`[pageerror] ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`[console.error] ${message.text()}`)
    if (message.type() === 'warning') console.log(`[browser warning] ${message.text()}`)
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.mode-tab-strip', { timeout: 30_000 })
  await waitForHydration(page)
  const baseProject = await page.evaluate(() => structuredClone(window.__camStore.getState().project))
  const fixture = await makeReloadFixture(baseProject)

  console.log('[reload-smoke] opening the minimal loaded:true STEP fixture through the real file input...')
  await page.locator('input[accept=".camproject"]').setInputFiles({
    name: 'wo243-reload-fixture.camproject',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  })
  await page.waitForFunction((projectId) => (
    window.__camStore.getState().project.id === projectId
    && window.__camStore.getState().projectOpen === null
  ), PROJECT_ID, { timeout: 60_000 })
  await page.waitForFunction((geometryId) => window.__cncViewport?.partGroups?.has(geometryId), GEOMETRY_ID, { timeout: 30_000 })
  const opened = await readState(page)
  assert(opened.scene?.visible && opened.scene.attached && opened.scene.meshCount > 0 && opened.scene.vertexCount > 0,
    `File -> Open did not draw the STEP model: ${JSON.stringify(opened)}`)
  assert(opened.operation && opened.operation.geometrySelections?.includes(GEOMETRY_ID),
    `the operation lost its STEP recompute input on File -> Open: ${JSON.stringify(opened.operation)}`)
  await waitForDurableProject(page)
  console.log('[reload-smoke] durable pointer contains the fixture project')

  // File -> Open and its camera fit can schedule a final durable write after
  // the first matching pointer appears. Deleting OPFS while that write is in
  // flight makes the harness manufacture a NotFoundError unrelated to reload.
  // Require the committed generation to remain unchanged before reseeding.
  await waitForDurableProjectToQuiesce(page)
  console.log('[reload-smoke] durable writes quiesced before OPFS reseed')

  // Seed the exact persisted-state shape through the legacy migration source,
  // then remove only the durable state envelope. The STEP/display IndexedDB
  // caches remain intact. On reload, createUserSpaceStateStorage performs its
  // real asynchronous localStorage -> OPFS migration before Zustand merges the
  // project. That deterministic async boundary is the race WO-243 fixes.
  const persistedState = await page.evaluate(() => {
    const state = window.__camStore.getState()
    const project = structuredClone(state.project)
    delete project.binaries
    delete project.document
    delete project.modelItemDocuments
    project.setups = project.setups.map((setup) => ({
      ...setup,
      operations: setup.operations.map(({ toolpathMoves: _moves, ...operation }) => operation),
    }))
    return JSON.stringify({
      state: {
        machineLibrary: state.machineLibrary,
        toolLibrary: state.toolLibrary,
        toolLibraries: state.toolLibraries,
        holders: state.holders,
        appSettings: state.appSettings,
        importedFonts: state.importedFonts,
        project,
      },
      version: 5,
    })
  })
  // Leave the app before removing OPFS state so no mounted component can
  // schedule a fresh persist write behind the harness cleanup. This same-origin
  // blank page retains access to OPFS/localStorage without running LienCAM.
  await page.goto(RESEED_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async ({ storageKey, payload }) => {
    const root = await navigator.storage.getDirectory()
    const prefix = `liencam-user-space--${encodeURIComponent(storageKey)}--`
    const names = []
    for await (const [name] of root.entries()) {
      if (name.startsWith(prefix)) names.push(name)
    }
    for (const name of names) await root.removeEntry(name)
    localStorage.setItem(storageKey, payload)
  }, { storageKey: 'cnc-cam-project', payload: persistedState })

  console.log('[reload-smoke] cold-starting the app and waiting for durable-store hydration...')
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.mode-tab-strip', { timeout: 30_000 })
  await waitForHydration(page)
  await page.waitForFunction((projectId) => window.__camStore.getState().project.id === projectId, PROJECT_ID, { timeout: CAPTURE_BEFORE ? 5_000 : 30_000 })
  if (!CAPTURE_BEFORE) {
    await page.waitForFunction((geometryId) => window.__cncViewport?.partGroups?.has(geometryId), GEOMETRY_ID, { timeout: 30_000 })
  } else {
    await page.waitForTimeout(2000)
  }

  const reloaded = await readState(page)
  const evidenceName = CAPTURE_BEFORE ? 'before.png' : 'after.png'
  await page.screenshot({ path: path.join(EVIDENCE, evidenceName) })
  console.log(`[reload-smoke] wrote ${evidenceName}`)

  assert(reloaded.projectId === PROJECT_ID, `wrong project after reload: ${JSON.stringify(reloaded)}`)
  assert(reloaded.geometry?.loaded === true && reloaded.geometry.hidden === false && reloaded.geometry.format === 'step',
    `STEP metadata did not survive reload: ${JSON.stringify(reloaded.geometry)}`)
  assert(reloaded.operation && reloaded.operation.geometrySelections?.includes(GEOMETRY_ID),
    `toolpath recompute metadata did not survive reload: ${JSON.stringify(reloaded.operation)}`)
  assert(reloaded.brepImportError === null, `reload reported a B-rep error: ${reloaded.brepImportError}`)
  const isDrawn = !!(reloaded.scene?.visible && reloaded.scene.attached
    && reloaded.scene.meshCount > 0 && reloaded.scene.vertexCount > 0)
  if (CAPTURE_BEFORE) {
    assert(!isDrawn, `baseline unexpectedly drew the STEP model: ${JSON.stringify(reloaded.scene)}`)
    console.log('PASS: captured the pre-fix real-browser failure (tree/store present, STEP scene mesh absent).')
  } else {
    assert(isDrawn, `reloaded STEP model is not drawn: ${JSON.stringify(reloaded.scene)}`)
    assert(pageErrors.length === 0, `browser reported errors:\n${pageErrors.join('\n')}`)
    console.log('PASS: real browser reloaded the project with a visible STEP mesh and preserved toolpath inputs.')
  }
} catch (error) {
  console.error('[reload-smoke] FAIL:', error)
  if (page) console.error('[reload-smoke] last state:', JSON.stringify(await readState(page).catch(() => null)))
  if (page) console.error('[reload-smoke] durable state:', JSON.stringify(await page.evaluate(async () => {
    try {
      const key = 'cnc-cam-project'
      const root = await navigator.storage.getDirectory()
      const safeKey = encodeURIComponent(key)
      const pointer = JSON.parse(await (await (await root.getFileHandle(`liencam-user-space--${safeKey}--pointer.json`)).getFile()).text())
      const generation = await root.getFileHandle(`liencam-user-space--${safeKey}--generation--${encodeURIComponent(pointer.current)}.json`)
      const envelope = JSON.parse(await (await generation.getFile()).text())
      const payload = JSON.parse(envelope.payload)
      return { pointer, projectId: payload?.state?.project?.id }
    } catch (readError) { return { error: String(readError) } }
  }).catch(() => null)))
  if (pageErrors.length > 0) console.error(pageErrors.join('\n'))
  console.error(serverOutput.slice(-4000))
  process.exitCode = 1
} finally {
  await browserContext?.close()
  await rm(profileDir, { recursive: true, force: true })
  killTree(server.pid)
}
