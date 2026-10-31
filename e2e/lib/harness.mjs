// The fresh-PC journey's harness: launch the packaged app on a chosen profile,
// record everything it prints, run numbered steps, and write the verdicts.
//
// Nothing here writes to the app's state. The only things the harness does
// that a person at the keyboard does not are:
//   - size the window to 1920x1080 so every PNG has the same frame, and
//   - answer the operating system's Save dialog with a path (a person types a
//     file name there; the app's own code still writes the bytes).
// Release smoke additionally runs with an empty update feed and no HTTP egress.
import { _electron as electron } from 'playwright'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const WIDTH = 1920
export const HEIGHT = 1080

export class Journey {
  constructor({ appPath, outDir, shots, offline = false }) {
    this.appPath = appPath
    this.outDir = outDir
    this.shots = shots
    this.offline = offline
    this.network = { mode: offline ? 'offline' : 'normal', requests: [] }
    this.logPath = path.join(outDir, 'journey.log')
    this.steps = []
    this.current = null
    this.app = null
    this.page = null
    this.startedAt = new Date().toISOString()
    mkdirSync(outDir, { recursive: true })
    if (shots) mkdirSync(path.join(outDir, 'scenes'), { recursive: true })
    writeFileSync(this.logPath, `# LienCAM fresh-PC journey ${this.startedAt}\n# app ${appPath}\n`)
  }

  log(line) {
    const stamped = `${new Date().toISOString()} ${this.current ? `[step ${this.current.n}] ` : ''}${line}`
    appendFileSync(this.logPath, `${stamped}\n`)
  }

  /** An error-level entry the current step did not expect. */
  recordError(kind, text) {
    this.log(`${kind.toUpperCase()} ${text}`)
    const step = this.current
    if (!step) return
    if (step.expect.some((pattern) => pattern.test(text))) {
      step.expectedErrors.push(`${kind}: ${text}`)
      return
    }
    step.errors.push(`${kind}: ${text}`)
  }

  async launch(profileDir) {
    try {
      return await this.launchOnce(profileDir)
    } catch (error) {
      // A window that never paints (hidden behind others on a busy desktop) is
      // the desktop's doing more often than the app's; say so and try once more.
      const reason = String(error?.message ?? error).split(/\r?\n/)[0]
      this.note(`The app window did not come up on the first try (${reason}); closed it and launched again.`)
      await this.close()
      return this.launchOnce(profileDir)
    }
  }

  async launchOnce(profileDir) {
    this.log(`LAUNCH profile=${profileDir}`)
    this.app = await electron.launch({
      executablePath: this.appPath,
      // Keep painting and timers running when the window is covered by others.
      args: ['--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        // This applies from process start, before Playwright can intercept the
        // first window. Never let the initial update request race the route.
        ...(this.offline ? ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
          '--host-resolver-rules=MAP * ~NOTFOUND'] : [])],
      env: { ...process.env, LIENCAM_USER_DATA_DIR: profileDir },
      timeout: 120_000,
    })
    if (this.offline) {
      await this.app.context().route(/^https?:\/\//, async route => {
        const url = new URL(route.request().url())
        const feed = url.hostname === 'api.github.com'
          && /^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname)
        const action = feed ? 'empty-update-feed' : 'blocked'
        this.network.requests.push({ url: url.href, action })
        this.log(`OFFLINE ${action} ${url.href}`)
        if (feed) await route.fulfill({ status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' })
        else await route.abort('internetdisconnected')
      })
      this.log('OFFLINE launch proxy and DNS guard active; HTTP requests intercepted')
    }
    const proc = this.app.process()
    proc.stdout?.on('data', (chunk) => this.log(`MAIN stdout ${String(chunk).trimEnd()}`))
    proc.stderr?.on('data', (chunk) => this.log(`MAIN stderr ${String(chunk).trimEnd()}`))
    const page = await this.app.firstWindow({ timeout: 120_000 })
    this.page = page
    page.on('console', (message) => {
      const type = message.type()
      const text = message.text()
      if (type === 'error') this.recordError('console.error', text)
      else this.log(`console.${type} ${text}`)
    })
    page.on('pageerror', (error) => this.recordError('pageerror', String(error?.stack ?? error)))
    page.on('crash', () => this.recordError('crash', 'renderer crashed'))
    await this.app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.unmaximize()
      window.setContentSize(size.width, size.height)
      window.center()
    }, { width: WIDTH, height: HEIGHT })
    await page.waitForLoadState('domcontentloaded')
    await page.bringToFront().catch(() => {})
    await page.getByTestId('mode-tab-setup').waitFor({ timeout: 90_000 })
    await page.waitForTimeout(1_500)
    this.log(`WINDOW ${JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]))}`)
    return page
  }

  async close() {
    if (!this.app) return
    this.log('CLOSE app')
    const app = this.app
    this.app = null
    this.page = null
    await app.close().catch((error) => this.log(`close failed: ${error}`))
  }

  /**
   * The next Save dialog the app opens is answered with the file name the app
   * suggested, placed in `dir` (with `prefix` in front). Returns a function
   * that resolves to the path the dialog answered, once the app has asked.
   */
  async answerNextSaveDialog(dir, prefix = '') {
    await this.app.evaluate(({ dialog }, { dir, prefix, sep }) => {
      globalThis.__journeySaved = null
      dialog.showSaveDialog = async (...args) => {
        const options = args.find((a) => a && typeof a === 'object' && 'defaultPath' in a) ?? {}
        const base = String(options.defaultPath ?? 'file').split(/[\\/]/).pop()
        const filePath = `${dir}${sep}${prefix}${base}`
        globalThis.__journeySaved = filePath
        return { canceled: false, filePath }
      }
    }, { dir, prefix, sep: path.sep })
    return async () => {
      const saved = await waitUntil(() => this.app.evaluate(() => globalThis.__journeySaved), { timeout: 30_000, what: 'the app to open its Save dialog' })
      this.log(`SAVE-DIALOG answered ${saved}`)
      return saved
    }
  }

  /**
   * The next Open dialog the app opens is answered with `filePath` (a person
   * picks that file; the app's own code reads it). Since WO-2725 (f9019502e5,
   * 2026-10-10) the desktop Open project goes through the main process's
   * native dialog, not a renderer file input. Returns a function that resolves
   * once the app has asked.
   */
  async answerNextOpenDialog(filePath) {
    await this.app.evaluate(({ dialog }, filePath) => {
      globalThis.__journeyOpened = null
      dialog.showOpenDialog = async () => {
        globalThis.__journeyOpened = filePath
        return { canceled: false, filePaths: [filePath] }
      }
    }, filePath)
    return async () => {
      const opened = await waitUntil(() => this.app.evaluate(() => globalThis.__journeyOpened), { timeout: 30_000, what: 'the app to open its Open dialog' })
      this.log(`OPEN-DIALOG answered ${opened}`)
      return opened
    }
  }

  async shot(name) {
    const file = path.join(this.outDir, `${name}.png`)
    await this.page.screenshot({ path: file })
    this.log(`PNG ${file}`)
    return file
  }

  async scene(name) {
    if (!this.shots) return
    const file = path.join(this.outDir, 'scenes', `${name}.png`)
    await this.page.screenshot({ path: file })
    this.log(`SCENE ${file}`)
  }

  note(text) {
    this.log(`NOTE ${text}`)
    this.current?.notes.push(text)
  }

  /**
   * Run one numbered step. `body` throws to fail it; any unexpected
   * page error, unhandled rejection or error-level console line fails it too.
   */
  async step(n, name, body, { expect = [] } = {}) {
    const step = { n, name, status: 'PASS', reason: '', errors: [], expectedErrors: [], notes: [], pngs: [], ms: 0, expect }
    this.current = step
    const started = Date.now()
    this.log(`=== STEP ${n} ${name}`)
    try {
      await body(step)
    } catch (error) {
      step.status = 'FAIL'
      step.reason = String(error?.message ?? error).split('\n')[0]
      this.log(`STEP ${n} threw: ${String(error?.stack ?? error)}`)
    }
    if (this.page) {
      try {
        step.pngs.push(await this.shot(`step-${String(n).padStart(2, '0')}-${slug(name)}`))
      } catch (error) {
        this.log(`STEP ${n} final PNG failed: ${error}`)
      }
    }
    if (step.status === 'PASS' && step.errors.length) {
      step.status = 'FAIL'
      step.reason = `unexpected error output: ${step.errors[0].slice(0, 300)}${step.errors.length > 1 ? ` (+${step.errors.length - 1} more)` : ''}`
    }
    step.ms = Date.now() - started
    delete step.expect
    this.steps.push(step)
    this.current = null
    const line = stepLine(step)
    this.log(line)
    console.log(line)
    return step
  }

  finish(extra = {}) {
    const lines = this.steps.map(stepLine)
    writeFileSync(path.join(this.outDir, 'result.txt'), `${lines.join('\n')}\n`)
    writeFileSync(path.join(this.outDir, 'result.json'), `${JSON.stringify({
      app: this.appPath,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      verdict: this.steps.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL',
      steps: this.steps,
      ...extra,
    }, null, 2)}\n`)
  }
}

/** `STEP n PASS|FAIL <reason or name>`, with the count of findings the step recorded. */
export function stepLine(step) {
  const findings = step.notes.length ? ` (findings: ${step.notes.length}, see result.json)` : ''
  return `STEP ${step.n} ${step.status} ${step.reason || step.name}${findings}`
}

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A pointer click the way a hand makes one: arrive, settle, press. */
export async function clickAt(page, x, y) {
  await page.mouse.move(x - 10, y - 10)
  await page.mouse.move(x, y, { steps: 5 })
  await page.waitForTimeout(150)
  await page.mouse.click(x, y)
  await page.waitForTimeout(300)
}

/** The input that follows a visible label (the app's panels put the label beside the box). */
export function inputAfterLabel(scope, label) {
  return scope.locator(`xpath=.//*[normalize-space(text())="${label}"]/following::*[self::input or self::select][1]`).first()
}

/** A `.mform-row` field (Machine Library and Tool Library use this form layout). */
export function formRow(scope, label) {
  return scope.locator('.mform-row', { has: scope.page().locator('label', { hasText: new RegExp(`^${escapeRegex(label)}$`) }) })
    .locator('input,select').first()
}

export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function waitUntil(fn, { timeout = 30_000, interval = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? `: ${last.message.split('\n')[0]}` : ''}`)
}
