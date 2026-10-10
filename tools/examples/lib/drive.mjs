import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VIEWPORT = { width: 1600, height: 1000 }

// Read the app's own durable snapshot: production builds have no dev-store hook.
// In particular, never import a second store instance or seed a synthetic project.
export async function readAppState(page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const state = await page.evaluate(async () => {
        const key = 'cnc-cam-project'
        if (navigator.storage?.getDirectory) {
          try {
            const root = await navigator.storage.getDirectory()
            const prefix = `liencam-user-space--${encodeURIComponent(key)}--`
            const text = async (name) => (await (await root.getFileHandle(name)).getFile()).text()
            const pointer = JSON.parse(await text(`${prefix}pointer.json`))
            const generation = JSON.parse(await text(`${prefix}generation--${encodeURIComponent(pointer.current)}.json`))
            return JSON.parse(generation.payload).state
          } catch (error) {
            if (error.name !== 'NotFoundError') throw error
          }
        }
        const text = localStorage.getItem(key)
        return text ? JSON.parse(text).state : null
      })
      return state
    } catch (error) {
      // OPFS generations rotate under an active app. Retry only file-rotation
      // races, never arbitrary script/permission errors or a failed predicate.
      if (!/NotReadableError|NotFoundError|SyntaxError/.test(error.message)) throw error
    }
    await page.waitForTimeout(100)
  }
  throw new Error('Application autosave state unavailable after 30 reads')
}

/** The portable fields Save preserves; runtime compute status/moves are transient. */
export function portableSnapshot(project, tools = project.toolLibrary ?? []) {
  // Matches the Save packaging contract: clearing operations carry their own
  // toolId, rather than a second tool hidden in the parent operation's params.
  const usedIds = new Set(project.setups.flatMap(setup => setup.operations.map(op => op.toolId)))
  return {
    id: project.id,
    machine: project.machine,
    sceneStock: project.sceneStock,
    stocks: project.stocks,
    geometry: project.geometry.map(geometry => geometry.format === 'model' && geometry.modelBody
      ? { ...geometry, modelBody: { ref: geometry.modelBody.ref } } : geometry),
    setups: project.setups.map(setup => ({
      id: setup.id, name: setup.name, wcs: setup.wcs,
      operations: setup.operations.map(op => ({
        id: op.id, name: op.name, type: op.type, toolId: op.toolId,
        params: op.params, heights: op.heights, smartHeight: op.smartHeight,
      })),
    })),
    tools: tools.filter(tool => usedIds.has(tool.id)).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export class ExampleDriver {
  constructor(browser, baseUrl, outDir) {
    this.browser = browser
    this.baseUrl = baseUrl
    this.outDir = outDir
    this.steps = []
    this.contexts = []
    // Delete known evidence first: a failed rerun must never leave a prior
    // success capture or log masquerading as the current run's result.
    for (const name of ['steps.json', 'reopened.png', 'round-trip.json', 'failed.png']) this.output(name)
  }

  output(name) {
    const file = path.resolve(this.outDir, name)
    if (!file.startsWith(`${this.outDir}${path.sep}`)) throw new Error('Output must stay inside outDir')
    mkdirSync(path.dirname(file), { recursive: true })
    rmSync(file, { force: true })
    return file
  }

  async open() {
    const context = await this.browser.newContext({ viewport: VIEWPORT, acceptDownloads: true })
    this.contexts.push(context)
    this.page = await context.newPage()
    this.page.setDefaultTimeout(30_000)
    await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' })
    await this.page.getByRole('button', { name: 'New project', exact: true }).waitFor()
    return this.page
  }

  readState() { return readAppState(this.page) }

  async step(label, action, check, { timeoutMs = 30_000 } = {}) {
    if (typeof check !== 'function') throw new TypeError('Every step needs a state predicate')
    const entry = { step: this.steps.length + 1, label, startedAt: new Date().toISOString() }
    this.steps.push(entry)
    try {
      await action(this.page)
      const deadline = Date.now() + timeoutMs
      let state
      do {
        state = await this.readState()
        if (state && await check(state)) {
          entry.status = 'passed'
          entry.projectId = state.project.id
          entry.readback = {
            stock: state.project.sceneStock.fixedStocks,
            tools: state.toolLibrary.map(({ name, diameter, libraryId }) => ({ name, diameter, libraryId })),
            setups: state.project.setups.map(({ id, wcs, operations }) => ({
              id, wcs, operations: operations.map(({ type, toolId }) => ({ type, toolId })),
            })),
          }
          console.log(`[pass] ${label}`)
          return state
        }
        await this.page.waitForTimeout(100)
      } while (Date.now() < deadline)
      entry.observed = state
      throw new Error(`State check failed: ${label}`)
    } catch (error) {
      entry.status = 'failed'
      entry.error = error.message
      throw error
    } finally {
      entry.finishedAt = new Date().toISOString()
      writeFileSync(this.output('steps.json'), `${JSON.stringify(this.steps, null, 2)}\n`)
    }
  }

  async newProject() {
    const before = await this.readState()
    return this.step('Create a new project', page => page.getByRole('button', { name: 'New project', exact: true }).click(),
      state => state.project.id !== before?.project.id && state.project.setups.length === 0)
  }

  async setStock({ width, height, depth }, { expectedWidth = width } = {}) {
    const before = (await this.readState()).project.sceneStock.fixedStocks?.length ?? 0
    await this.step('Add fixed stock', page => page.getByTestId('stock-add-fixed').click(),
      state => state.project.sceneStock.fixedStocks.length === before + 1)
    const node = this.page.locator('.fixed-stock-node').filter({ has: this.page.getByTestId('fixed-stock-gizmo-btn') }).last()
    if (!await node.locator('.stock-number-input').count()) await node.locator('.fixed-stock-header').click()
    for (const [label, field, value] of [['Width (X)', 'width', width], ['Height (Y)', 'height', height], ['Depth (Z)', 'depth', depth]]) {
      await this.step(`Set stock ${field} to ${value} mm`, async () => {
        const input = node.locator('.stock-field-row').filter({ hasText: label }).locator('input')
        await input.fill(String(value))
        await input.press('Enter')
      }, state => state.project.sceneStock.fixedStocks.at(-1)[field] === (field === 'width' ? expectedWidth : value),
      { timeoutMs: 3000 })
    }
    return (await this.readState()).project.sceneStock.fixedStocks.at(-1)
  }

  async importTools(file) {
    const full = path.resolve(ROOT, file)
    const expected = JSON.parse(readFileSync(full, 'utf8'))
    const before = (await this.readState()).toolLibrary.length
    await this.page.getByTestId('mode-tab-toollibrary').click()
    const modal = this.page.locator('.tool-modal')
    await this.step(`Import ${path.basename(file)}`, async page => {
      const chooser = page.waitForEvent('filechooser')
      await modal.getByRole('button', { name: 'Import', exact: true }).click()
      await (await chooser).setFiles(full)
    }, state => {
      // A reopened project can already embed a library of the same name. The
      // import appends a fresh one; read its tools, not the earlier library.
      const library = state.toolLibraries.findLast(lib => lib.name === path.basename(file, '.json'))
      const tools = state.toolLibrary.filter(tool => tool.libraryId === library?.id)
      return state.toolLibrary.length === before + expected.length && tools.length === expected.length &&
        expected.every(record => tools.some(tool => tool.name === record.name && tool.diameter === record.diameter))
    })
    await modal.locator('.modal-close-btn').click()
    return expected
  }

  async addFacingOperation(toolName) {
    const stock = (await this.readState()).project.sceneStock.fixedStocks.at(-1)
    await this.page.getByRole('button', { name: 'Add setup', exact: true }).click()
    await this.page.locator('.wcs-stock-select').selectOption(stock.id)
    await this.step('Create setup bound to fixed stock', page => page.getByRole('button', { name: 'Create Setup', exact: true }).click(),
      state => state.project.setups.length === 1 && state.project.setups[0].wcs.stockId === stock.id)
    await this.page.getByRole('button', { name: 'Add operation', exact: true }).click()
    await this.page.locator('.op-type-card').filter({ hasText: '2D Face' }).click()
    await this.page.locator('.op-modal-tab').filter({ hasText: 'Tool' }).click()
    await this.page.locator('.op-tool-row').filter({ hasText: toolName }).click()
    await this.page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
    await this.page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
    await this.page.getByTestId('face-height-mode').selectOption('explicit_depth')
    await this.page.getByTestId('face-explicit-target').locator('input').fill('-0.5')
    await this.page.getByTestId('face-explicit-target').locator('input').press('Tab')
    return this.step('Create facing operation with starter end mill', page => page.getByTestId('op-create').click(),
      state => state.project.setups[0].operations.some(op => op.type === 'face' &&
        state.toolLibrary.find(tool => tool.id === op.toolId)?.name === toolName))
  }

  async saveAndReopen(name) {
    const file = this.output(name)
    const before = await this.readState()
    await this.step('Save project through Save', async page => {
      const download = page.waitForEvent('download', { timeout: 120_000 })
      await page.getByRole('button', { name: 'Save project', exact: true }).click()
      await (await download).saveAs(file)
    }, state => state.project.id === before.project.id && statSync(file).size > 0)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const expected = portableSnapshot(saved)
    assert.equal(expected.tools.length, saved.toolLibrary.length, 'Every saved tool must be used by the project')
    assert.deepEqual(portableSnapshot(before.project, before.toolLibrary), expected, 'Saved file must match the built project')
    const originalPage = this.page
    await this.open()
    assert.notEqual((await this.readState())?.project.id, saved.id, 'Fresh page must not already contain the saved project')
    await this.step('Reopen saved project in a fresh context', async page => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(file)
    }, state => {
      if (state.project.id !== saved.id) return false
      assert.equal(state.toolLibrary.length, saved.toolLibrary.length, 'Fresh library must match the saved tool count')
      assert.deepEqual(portableSnapshot(state.project, state.toolLibrary), expected)
      return true
    }, { timeoutMs: 120_000 })
    await originalPage.context().close()
    const capture = this.output('reopened.png')
    await this.page.screenshot({ path: capture })
    writeFileSync(this.output('round-trip.json'), `${JSON.stringify({ saved: expected, reopened: portableSnapshot((await this.readState()).project, (await this.readState()).toolLibrary) }, null, 2)}\n`)
    return saved
  }
}

/** Serve only the already-built renderer, in this checkout, on an ephemeral port. */
export async function withExampleDriver({ outDir, repoRoot = ROOT, port = 0 }, run) {
  const dist = path.resolve(repoRoot, 'dist')
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Build the app first: npm run build')
  const output = path.resolve(repoRoot, outDir)
  mkdirSync(output, { recursive: true })
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const file = path.resolve(dist, `.${urlPath === '/' ? '/index.html' : urlPath}`)
      if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end(); return
      }
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
      res.end(readFileSync(file))
    } catch { res.writeHead(500).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  let browser, driver
  try {
    // Software rendering by default (deterministic pictures). LIENCAM_DRIVE_ANGLE=d3d11 (Windows) or gl-egl
    // (Linux) opts one run into the GPU. (The knob kit's 10-09 timeout was a ~85 s Simulate-entry freeze, not rendering.)
    const angle = process.env.LIENCAM_DRIVE_ANGLE || 'swiftshader'
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', `--use-angle=${angle}`, ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : ['--ignore-gpu-blocklist'])] })
    driver = new ExampleDriver(browser, `http://127.0.0.1:${server.address().port}/`, output)
    await driver.open()
    return await run(driver)
  } catch (error) {
    if (driver?.page && !driver.page.isClosed()) await driver.page.screenshot({ path: driver.output('failed.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}

export async function selfCheck({ negativeControl = false } = {}) {
  return withExampleDriver({ outDir: `src/tests/evidence/WO-2372/${negativeControl ? 'negative-control' : 'self-check'}` }, async driver => {
    driver.output('self-check.camproject')
    await driver.newProject()
    await driver.setStock({ width: 100, height: 80, depth: 12 }, { expectedWidth: negativeControl ? 101 : 100 })
    await driver.importTools('examples/tools/starter-tools-metric.json')
    await driver.importTools('examples/tools/starter-tools-inch.json')
    await driver.addFacingOperation('6 mm flat end mill')
    return driver.saveAndReopen('self-check.camproject')
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--self-check')) throw new Error('Usage: node tools/examples/lib/drive.mjs --self-check [--negative-control]')
  await selfCheck({ negativeControl: process.argv.includes('--negative-control') })
}
