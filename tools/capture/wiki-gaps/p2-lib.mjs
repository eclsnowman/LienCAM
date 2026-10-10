// WO-2710 shared pieces for the P2 wiki-gap shoot (p2.mjs): the production
// build + `vite preview` server, a fresh browser context per gap, real-UI
// helpers (clicks and file pickers only - no store writes, no test hooks),
// candidate output, crops and the per-picture sidecar.
import { chromium } from 'playwright'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { captureSourceProvenance } from '../lib/provenance.mjs'

export const ROOT = process.cwd()
export const EVIDENCE = path.resolve(ROOT, 'src/tests/evidence/WO-2710')
export const OUT = path.join(EVIDENCE, 'candidates')
export const DEBUG = path.join(EVIDENCE, 'debug')
export const VIEWPORT = { width: 1920, height: 1080 }
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Build the app into `outDir` (production; `demo` sets VITE_DEMO_BUILD=true). */
export function build({ outDir, demo = false }) {
  const env = { ...process.env }
  if (demo) env.VITE_DEMO_BUILD = 'true'
  else delete env.VITE_DEMO_BUILD
  const args = ['--max-old-space-size=8192', 'node_modules/vite/bin/vite.js', 'build', '--outDir', outDir, '--emptyOutDir']
  console.log('[build]', demo ? 'demo' : 'release', outDir)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('vite build failed: ' + (r.stderr || r.stdout).slice(-4000))
}

/** Hash of a build's index.html: ties every picture to the exact bundle it shows. */
export function buildIdentity(outDir) {
  const html = fs.readFileSync(path.join(ROOT, outDir, 'index.html'))
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

/** `vite preview` of a built folder on a fixed port; resolves to { baseUrl, stop }. */
export async function preview({ outDir, port }) {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let log = ''
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })
  const baseUrl = `http://127.0.0.1:${port}/`
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(baseUrl)).ok) break } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error('vite preview exited: ' + log)
    await sleep(200)
    if (i === 149) throw new Error('vite preview did not answer on ' + baseUrl)
  }
  const stop = () => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill('SIGTERM')
  }
  return { baseUrl, stop }
}

/**
 * One browser at a time is the load rule; this gate only waits out a spike
 * from other work before the next browser starts. Other seats keep the dev
 * box near 60% on their own, so after maxWaitMs it proceeds (one browser).
 */
export async function waitForCpu(limit = Number(process.env.CAPTURE_CPU_LIMIT || 65), maxWaitMs = 3 * 60_000) {
  const started = Date.now()
  for (;;) {
    let load = 0
    try {
      load = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'],
      { encoding: 'utf8', windowsHide: true }).trim())
    } catch { load = 0 }
    if (load < limit) return load
    if (Date.now() - started > maxWaitMs) { console.log(`[cpu] ${load}% after ${maxWaitMs / 1000}s - proceeding with one browser`); return load }
    console.log(`[cpu] ${load}% - waiting`)
    await sleep(15_000)
  }
}

let sourceCache = null
/** Source identity, computed once per run (the build is fixed for the run). */
export function sourceIdentity() {
  if (!sourceCache) {
    const s = captureSourceProvenance({ repoRoot: ROOT, sourcePaths: ['src', 'index.html', 'public'], sourceExcludePaths: ['src/tests', 'public/help'] })
    sourceCache = { sourceCommit: s.commit, sourceTreeDirty: s.workingTreeDirty, sourceScope: s.workingTreeScope, sourceHash: s.sourceHash }
  }
  return sourceCache
}

export async function launch() {
  return chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
}

/**
 * One gap = one fresh context (empty storage = a first start), at 1920x1080.
 * Returns helpers bound to the page.
 */
export async function openApp(browser, baseUrl, { gap, runId, buildId, route }) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) return
    errors.push('console: ' + m.text())
  })
  const tid = (id) => page.getByTestId(id)
  const pictures = []
  const h = {
    page, context, tid, errors, pictures,
    async goto() {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.waitForSelector('canvas', { state: 'attached', timeout: 120_000 })
      await page.waitForTimeout(1500)
    },
    /** The first-start machine choice: the operator presses "Use this machine". */
    async chooseStarterMachine() {
      const use = page.getByRole('button', { name: /use this machine/i })
      try { await use.first().waitFor({ state: 'visible', timeout: 8000 }) } catch { return false }
      await use.first().click()
      await page.locator('.modal-backdrop').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
      return true
    },
    /** Open a shipped .camproject through the real Open button's file picker. */
    async openProject(file) {
      const [fc] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        page.getByRole('button', { name: 'Open project', exact: true }).click(),
      ])
      await fc.setFiles(path.resolve(ROOT, file))
      // Open may ask Save / Discard / Cancel over the empty start project.
      const discard = page.getByTestId('confirm-dialog-alt').filter({ hasText: /^Discard$/ })
      await discard.waitFor({ timeout: 3000 }).then(() => discard.click(), () => {})
      await page.waitForSelector('[data-testid="project-open-indicator"]', { state: 'detached', timeout: 300_000 }).catch(() => {})
      await page.waitForTimeout(1500)
      await h.chooseStarterMachine()
    },
    async debug(name) {
      fs.mkdirSync(DEBUG, { recursive: true })
      const base = path.join(DEBUG, `${gap}-${name}`)
      await page.screenshot({ path: base + '.png' })
      const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid]')]
        .filter((el) => el.getClientRects().length)
        .map((el) => el.getAttribute('data-testid')))
      fs.writeFileSync(base + '.txt', (await page.locator('body').innerText()) + '\n\n--- visible testids ---\n' + [...new Set(ids)].join('\n'))
      console.log('[debug]', base)
    },
    /** Whole frame, delete-first. */
    async shot(name) {
      const file = path.join(OUT, name)
      for (const f of [file, file.replace(/\.png$/, '.json')]) fs.rmSync(f, { force: true })
      await page.mouse.move(1, 1)
      await page.waitForTimeout(400)
      await page.screenshot({ path: file, animations: 'disabled' })
      return file
    },
    /** Crop an already-shot whole frame into `cropName` (box in frame pixels). */
    async crop(name, cropName, box) {
      const src = path.join(OUT, name)
      const dst = path.join(OUT, cropName)
      for (const f of [dst, dst.replace(/\.png$/, '.json')]) fs.rmSync(f, { force: true })
      const left = Math.max(0, Math.floor(box.x)), top = Math.max(0, Math.floor(box.y))
      const width = Math.min(VIEWPORT.width - left, Math.ceil(box.width + (box.x - left)))
      const height = Math.min(VIEWPORT.height - top, Math.ceil(box.height + (box.y - top)))
      await sharp(src).extract({ left, top, width, height }).png().toFile(dst)
      return dst
    },
    async box(locator) {
      const b = await (typeof locator === 'string' ? page.locator(locator) : locator).first().boundingBox()
      if (!b) throw new Error('no box for ' + locator)
      return b
    },
    /** Sidecar JSON next to a finished candidate. */
    sidecar(name, { appState, crop = null, wholeFrame = null, extra = {} }) {
      const file = path.join(OUT, name)
      if (!fs.existsSync(file)) throw new Error('candidate missing: ' + name)
      const json = {
        order: 'WO-2710', gap, picture: name, bytes: fs.statSync(file).size,
        capturedAt: new Date().toISOString(), captureRunId: runId,
        ...sourceIdentity(), buildId, served: 'vite preview of a production build (npm run build output)',
        route, viewport: [VIEWPORT.width, VIEWPORT.height], deviceScaleFactor: 1,
        wholeFrame, crop, appState, ...extra,
      }
      fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify(json, null, 2) + '\n')
      pictures.push(name)
      console.log('[candidate]', name, json.bytes, 'bytes')
      return json
    },
  }
  return h
}

export const union = (...boxes) => {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.width)), btm = Math.max(...boxes.map((b) => b.y + b.height))
  return { x, y, width: r - x, height: btm - y }
}
export const pad = (b, p) => ({ x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p })
