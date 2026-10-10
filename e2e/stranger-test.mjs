// Run with `node e2e/stranger-test.mjs`. No hashbang: a CRLF checkout of one breaks
// Vitest's module transform for strangerTest.wo2526 (WO-2652).
// One foreground release rehearsal. Generated exports and profiles never enter git.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { simulateToEnd } from './steps/simulate-steps.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const EXAMPLE = 'fixture-plate'
export const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

export function runtimeDirectory(run, temporaryRoot = tmpdir()) {
  if (!/^[\w-]+$/.test(run)) throw new Error('Invalid runtime run ID')
  const runtime = path.resolve(temporaryRoot, 'liencam-stranger', run)
  const relative = path.relative(ROOT, runtime)
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('Runtime must be outside the repository')
  return runtime
}

export function sandboxConfig(installerDirectory, bootstrapUrl) {
  // ONLY the installer is mapped. Driver and evidence travel over a tokenized
  // HTTP endpoint; a writable host directory would defeat the clean-PC boundary.
  return `<Configuration><VGpu>Disable</VGpu><Networking>Enable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><MappedFolders><MappedFolder><HostFolder>${xml(installerDirectory)}</HostFolder><SandboxFolder>C:\\Installer</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>${xml(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing '${bootstrapUrl}' -OutFile C:\\bootstrap.ps1; & C:\\bootstrap.ps1"`)}</Command></LogonCommand></Configuration>\n`
}

export function safeFile(root, pathname) {
  const file = path.resolve(root, `.${decodeURIComponent(pathname)}`)
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Path escapes evidence root')
  return file
}

export function cpuAllowsSandbox(samples) {
  return samples.length > 0 && samples.every(n => Number.isFinite(n) && n >= 0 && n <= 100) && samples.reduce((a, b) => a + b, 0) / samples.length < 60
}

export async function recordStep(page, steps, directory, name, action) {
  const start = Date.now()
  const item = { name, status: 'PASS', ms: 0, findings: [] }
  const error = e => item.findings.push(`pageerror: ${e.message}`)
  const consoleError = msg => { if (msg.type() === 'error') item.findings.push(`console: ${msg.text()}`) }
  page.on('pageerror', error)
  page.on('console', consoleError)
  try { await action(item) } catch (e) { item.status = 'FAIL'; item.reason = String(e.stack ?? e) }
  try {
    item.screenshot = `${String(steps.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`
    await page.screenshot({ path: path.join(directory, item.screenshot) })
  } catch (e) { item.status = 'FAIL'; item.findings.push(`screenshot: ${e.message}`) }
  page.off('pageerror', error)
  page.off('console', consoleError)
  if (item.findings.length) item.status = 'FAIL'
  item.ms = Date.now() - start
  steps.push(item)
  console.log(`${item.status} ${name} ${item.ms} ms`)
  writeFileSync(path.join(directory, 'steps.json'), JSON.stringify(steps, null, 2))
  return item
}

export function findingsMarkdown(record) {
  const lines = ['# Stranger test findings', '', `Source main: ${record.sourceCommit}`, `Run: ${record.run}`, '', '## Browser', '']
  lines.push(`Evidence: src/tests/evidence/WO-2526/${record.browserEvidenceRun ?? record.run}/browser/`, '')
  for (const step of record.browser ?? []) {
    lines.push(`- ${step.status}: ${step.name} (${step.ms} ms), screenshot ${step.screenshot ?? 'unavailable'}`)
    if (step.reason) lines.push(`  Finding: ${step.reason.split('\n')[0]}`)
    for (const finding of step.findings ?? []) lines.push(`  Finding: ${finding}`)
  }
  lines.push('', '## Windows Sandbox', '', `Status: ${record.sandbox?.status ?? 'NOT RUN'}`, record.sandbox?.reason ?? '', `Evidence: src/tests/evidence/WO-2526/${record.run}/sandbox/`, '')
  for (const step of record.sandbox?.steps ?? []) lines.push(`- ${step.status}: ${step.name} (${step.ms} ms) ${step.reason ?? ''}`.trimEnd())
  lines.push('', '## Limits and decisions', '', ...(record.notes ?? []).map(note => `- ${note}`), '', 'No product fixes were made. The architect owns follow-up orders.', '')
  return lines.join('\n')
}

function command(args, cwd, log, env = {}) {
  const run = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 ** 2 })
  writeFileSync(log, `${run.stdout ?? ''}${run.stderr ?? ''}`)
  if (run.status !== 0 || run.error) throw new Error(`${args[0]} failed (${run.status}): ${run.error?.message ?? log}`)
}

async function buildExport(runtime, record, resume, onPages) {
  const tree = path.join(runtime, 'export')
  if (!resume) {
    mkdirSync(tree)
    const { exportPublic } = await import('../tools/release/export-public.mjs')
    const log = []
    record.export = exportPublic(record.sourceCommit, tree, { cwd: ROOT, log: line => log.push(line) })
    writeFileSync(path.join(runtime, 'export.log'), log.join('\n'))
  } else {
    const prior = JSON.parse(readFileSync(path.join(ROOT, 'src/tests/evidence/WO-2526', resume, 'result.json'), 'utf8'))
    if (!prior.export || prior.export.commit !== prior.sourceCommit) throw new Error('Resume requires a completed export with matching source SHA')
    // Other lanes can advance main during this foreground rehearsal. A resume
    // must keep the original source identity rather than relabel old bytes.
    if (record.sourceCommit !== prior.sourceCommit) record.notes.push(`Main advanced to ${record.sourceCommit} during rehearsal; resumed original main snapshot.`)
    record.sourceCommit = prior.sourceCommit
    record.export = prior.export
    record.notes.push(`Reused completed export from ${resume}; rebuilt outputs and new evidence.`)
  }
  // External exports cannot resolve dependencies through the checkout's
  // ancestors. Link only the existing install; do not install or copy it.
  const dependencies = realpathSync(path.join(ROOT, 'node_modules'))
  const dependencyLink = path.join(tree, 'node_modules')
  if (!existsSync(dependencyLink)) symlinkSync(dependencies, dependencyLink, process.platform === 'win32' ? 'junction' : 'dir')
  if (realpathSync(dependencyLink) !== dependencies) throw new Error('Export dependency link does not match the existing install')
  // The exported config assumes a local install for its dev-server allowlist.
  // Redirect that single dependency lookup, retaining exported product bytes.
  const configFile = path.join(tree, 'vite.config.mts')
  const config = readFileSync(configFile, 'utf8')
  const lookup = "realpathSync(join(projectRoot, 'node_modules'))"
  const adapted = `realpathSync(${JSON.stringify(path.join(ROOT, 'node_modules'))})`
  if (!config.includes(lookup) && !config.includes(adapted)) throw new Error('Export dependency lookup changed; inspect before adapting')
  writeFileSync(configFile, config.replace(lookup, adapted))
  record.notes.push('External export links the existing shared dependency install; no dependencies were installed or copied. Runtime config adapts only the dev-server dependency allowlist.')
  const env = { LIENCAM_BUILD_COMMIT: record.sourceCommit.slice(0, 12), LIENCAM_BUILD_BRANCH: 'public-export', VITE_DEMO_BUILD: 'true' }
  console.log('Build exported Pages/demo')
  // Delete only generated Pages output under this run's verified owned runtime.
  // Never recursively delete an export or its shared dependency link.
  const pages = safeFile(runtime, '/export/dist-pages')
  rmSync(pages, { recursive: true, force: true })
  command([path.join(tree, 'tools/release/build-pages.mjs')], tree, path.join(runtime, 'pages-build.log'), env)
  await onPages(pages)
  console.log('Build exported desktop')
  command([path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], tree, path.join(runtime, 'desktop-build.log'), { ...env, VITE_DEMO_BUILD: 'false' })
  console.log('Package exported installer')
  const electronVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version
  record.electronVersion = electronVersion
  command([path.join(ROOT, 'node_modules/electron-builder/cli.js'), '--projectDir', tree, '--win', 'nsis', '--x64', '-c.forceCodeSigning=false', `-c.electronVersion=${electronVersion}`], tree, path.join(runtime, 'installer-build.log'))
  const installers = readdirSync(path.join(tree, 'release')).filter(name => name.endsWith('-setup.exe'))
  if (installers.length !== 1) throw new Error(`Expected one installer; got ${installers}`)
  const installer = path.join(tree, 'release', installers[0])
  record.installer = { name: installers[0], bytes: statSync(installer).size, sha256: createHash('sha256').update(readFileSync(installer)).digest('hex') }
  return { pages: path.join(tree, 'dist-pages'), installer }
}

export async function browserJourney(pages, out, record) {
  mkdirSync(out, { recursive: true })
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.camproject': 'application/json' }
  const server = createServer((req, res) => {
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/LienCAM(?=\/)/, '')
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = safeFile(pages, pathname)
      if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return }
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
      res.end(readFileSync(file))
    } catch { res.writeHead(400).end() }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  let browser, context
  const steps = record.browser = []
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    await recordStep(page, steps, out, 'read home page', async item => {
      await page.goto(`${base}/LienCAM/`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('heading', { level: 1 }).waitFor()
      item.heading = await page.getByRole('heading', { level: 1 }).innerText()
      if ((await context.cookies()).length) throw new Error('Home set unexpected cookies')
    })
    const demo = await recordStep(page, steps, out, 'follow Try it in your browser', async item => {
      const link = page.getByRole('link', { name: /Try it in (your|the) browser/i }).first()
      const href = await link.getAttribute('href')
      item.destination = href
      // Pages is unavailable until publication. Preserve its actual link in
      // evidence and route exactly that destination to the local export.
      if (href?.startsWith('https://eclsnowman.github.io/LienCAM/app/')) {
        record.notes.push(`Local preview remapped published demo URL ${href} to the same exported app on loopback.`)
        await page.route('https://eclsnowman.github.io/LienCAM/app/**', route => route.fulfill({ status: 302, headers: { location: `${base}${new URL(route.request().url()).pathname}` } }))
      }
      await link.click()
      await page.getByRole('dialog', { name: 'Try an example' }).waitFor()
      await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
    })
    if (demo.status === 'PASS') {
      const opened = await recordStep(page, steps, out, 'open starter kit Fixture Plate', async item => {
        const picker = page.getByRole('dialog', { name: 'Try an example' })
        const choice = picker.getByRole('button', { name: /Fixture Plate.*CNC starter kit/i })
        item.exampleUrl = await choice.getAttribute('data-example-url')
        await choice.click()
        await picker.waitFor({ state: 'detached' })
        await page.getByTestId('mode-tab-setup').click()
        await page.getByTestId('tree-name-setup').first().waitFor()
        item.project = await page.getByTestId('tree-name-project').innerText()
        if (!/fixture/i.test(item.project)) throw new Error(`Wrong project: ${item.project}`)
      })
      if (opened.status === 'PASS') await recordStep(page, steps, out, 'simulate starter kit to end', async item => {
        const journey = { page, log: text => (item.readbacks ??= []).push(text), shot: name => page.screenshot({ path: path.join(out, `${name}.png`) }), scene: async () => {} }
        await simulateToEnd({ journey, data: item })
      })
      await recordStep(page, steps, out, 'open Help', async item => {
        await page.getByTestId('toolbar-help').click()
        await page.getByTestId('help-center').waitFor()
        item.text = (await page.getByTestId('help-center').innerText()).slice(0, 1500)
        if (item.text.includes('Setup and WCS')) record.notes.push('Finding: Help after simulation opens Setup and WCS while the setup remains selected. A beginner may expect Simulation guidance; see the Help capture.')
      })
    }
  } finally {
    if (context) { await context.tracing.stop({ path: path.join(out, 'trace.zip') }); await context.close() }
    if (browser) await browser.close()
    await new Promise(done => server.close(done))
  }
}

async function sandboxJourney(installer, runtime, evidence, record) {
  const samples = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', '$samples = 1..5 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep -Seconds 1 }; ConvertTo-Json -Compress @($samples)'], { encoding: 'utf8', windowsHide: true }).trim())
  record.sandbox = { status: 'NOT RUN', cpuSamples: samples }
  if (!cpuAllowsSandbox(samples)) { record.sandbox.reason = 'CPU average >= 60%, or invalid CPU samples; Sandbox not launched.'; return }
  const input = path.join(runtime, `installer-only-${record.run}`)
  mkdirSync(input)
  copyFileSync(installer, path.join(input, path.basename(installer)))
  const token = randomBytes(24).toString('hex')
  const guest = path.join(runtime, `guest-driver-${record.run}`)
  mkdirSync(guest)
  copyFileSync(process.execPath, path.join(guest, 'node.exe'))
  cpSync(path.join(ROOT, 'node_modules/playwright-core'), path.join(guest, 'driver'), { recursive: true })
  const ffmpeg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(item => item.name === 'ffmpeg')
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright')
  cpSync(path.join(cache, `ffmpeg-${ffmpeg.revision}`), path.join(guest, 'browsers', `ffmpeg-${ffmpeg.revision}`), { recursive: true })
  cpSync(path.join(ROOT, 'e2e/lib'), path.join(guest, 'lib'), { recursive: true })
  cpSync(path.join(ROOT, 'e2e/steps'), path.join(guest, 'steps'), { recursive: true })
  const harness = path.join(guest, 'lib/harness.mjs')
  writeFileSync(harness, readFileSync(harness, 'utf8').replace("from 'playwright'", "from '../driver/index.mjs'").replace('executablePath: this.appPath,', "executablePath: this.appPath, recordVideo: { dir: this.outDir },"))
  copyFileSync(path.join(ROOT, 'e2e/sandbox/guest.mjs'), path.join(guest, 'guest.mjs'))
  copyFileSync(path.join(ROOT, 'e2e/sandbox/installed-example.mjs'), path.join(guest, 'installed-example.mjs'))
  copyFileSync(path.join(ROOT, 'e2e/sandbox/video.mjs'), path.join(guest, 'video.mjs'))
  const guestZip = path.join(runtime, `guest-${record.run}.zip`)
  execFileSync('tar.exe', ['-a', '-cf', guestZip, '-C', guest, '.'], { windowsHide: true })
  mkdirSync(path.join(evidence, 'sandbox'), { recursive: true })
  let completed = false, started = false
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith(`/${token}/`)) { res.writeHead(404).end(); return }
      const suffix = url.pathname.slice(token.length + 2)
      if (req.method === 'POST') {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 256 * 1024 ** 2) throw new Error('Evidence too large'); chunks.push(chunk) }
        const data = Buffer.concat(chunks)
        if (suffix === 'started') { started = true; record.sandbox.status = 'RUNNING' }
        else if (suffix === 'result') {
          record.sandbox = { ...record.sandbox, ...JSON.parse(data) }
          if (record.sandbox.status === 'PASS') {
            const example = record.browser.find(step => step.exampleUrl)?.exampleUrl
            const expected = createHash('sha256').update(readFileSync(path.join(runtime, 'export/dist-pages/app', example))).digest('hex')
            if (record.sandbox.example?.sha256 !== expected) {
              record.sandbox.status = 'FAIL'
              record.sandbox.reason = 'Installed starter example hash differs from exported browser example'
            }
          }
          completed = true
        }
        else if (suffix.startsWith('evidence/')) writeFileSync(safeFile(path.join(evidence, 'sandbox'), `/${suffix.slice(9)}`), data)
        else throw new Error('Unknown upload')
        res.end('ok'); return
      }
      if (suffix === 'bootstrap.ps1') {
        const base = `http://${req.headers.host}/${token}`
        res.end(readFileSync(path.join(ROOT, 'e2e/sandbox/bootstrap.ps1'), 'utf8').replaceAll('__BASE__', base)); return
      }
      if (suffix === 'guest.zip') { res.end(readFileSync(guestZip)); return }
      res.writeHead(404).end()
    } catch (error) { res.writeHead(400).end(error.message) }
  })
  await new Promise(done => server.listen(0, '0.0.0.0', done))
  // Host's default-route IPv4 is reachable through Sandbox's virtual switch.
  const host = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } | Select-Object -First 1).IPv4Address.IPAddress'], { encoding: 'utf8', windowsHide: true }).trim()
  const config = path.join(runtime, `stranger-${record.run}.wsb`)
  writeFileSync(config, sandboxConfig(input, `http://${host}:${server.address().port}/${token}/bootstrap.ps1`))
  // Keep the generated, token-free mapping as durable boundary evidence.
  writeFileSync(path.join(evidence, 'sandbox-config.wsb'), sandboxConfig(input, 'http://HOST:TOKEN_PORT/TOKEN/bootstrap.ps1'))
  const launchAt = Date.now()
  const child = spawn('WindowsSandbox.exe', [config], { windowsHide: true, stdio: 'ignore' })
  let launchError
  child.on('error', e => { launchError = e.message })
  child.on('exit', code => {
    record.sandbox.launcherExit = code
    // A successful launcher may delegate to the Sandbox client process.
    if (code !== 0 && !completed) launchError = `WindowsSandbox.exe exited ${code} before guest evidence returned`
  })
  try {
    while (!completed && !launchError && Date.now() - launchAt < (started ? 20 * 60_000 : 120_000)) await new Promise(done => setTimeout(done, 500))
    if (!completed) {
      record.sandbox.status = 'BLOCKED'
      record.sandbox.reason = launchError ?? (started ? 'Guest journey timed out; see guest evidence' : 'Sandbox did not reach bootstrap in 120 seconds. Feature/virtualization or guest-to-host network unavailable; feature not enabled by worker.')
    }
    record.sandbox.ms = Date.now() - launchAt
  } finally {
    if (child.exitCode === null) child.kill()
    // The Store launcher delegates to another process. Stop only the client
    // whose command line names THIS generated config, never another Sandbox.
    const closeOwned = `$configPath = '${config.replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name = 'WindowsSandboxRemoteSession.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($configPath) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`
    execFileSync('powershell.exe', ['-NoProfile', '-Command', closeOwned], { windowsHide: true })
    await new Promise(done => server.close(done))
  }
}

async function main() {
  const args = process.argv.slice(2)
  const sandboxOnly = args[0] === '--sandbox-only'
  if (args.length && (!['--resume', '--sandbox-only'].includes(args[0]) || args.length !== (sandboxOnly ? 3 : 2) || args.slice(1).some(id => !/^[\w-]+$/.test(id)))) throw new Error('Usage: stranger-test.mjs [--resume <export-run>] [or --sandbox-only <export-run> <browser-run>]')
  const resume = args[1]
  const destination = path.join(ROOT, '.planning/public-release/alpha-1/stranger')
  const run = new Date().toISOString().replace(/[:.]/g, '-')
  const runtime = runtimeDirectory(resume ?? run)
  const evidence = path.join(ROOT, 'src/tests/evidence/WO-2526', run)
  mkdirSync(runtime, { recursive: true }); mkdirSync(evidence, { recursive: true })
  const record = { run, sourceCommit: execFileSync('git', ['rev-parse', 'main'], { cwd: ROOT, encoding: 'utf8' }).trim(), notes: ['Fresh nonpersistent Chromium context; no existing browser or desktop profile accessed.', 'Finding: Desktop starter-kit discovery needs follow-up. The driver extracts the same bundled example bytes and uses Open project; this verifies opening and simulation but does not prove a stranger can discover the hidden asset. Browser-only Try an example is absent in the non-demo desktop.', 'Guest video is a 1 fps recording of real Playwright page screenshots. Electron native video produced only a white startup frame; JSON preserves real elapsed times and the trace preserves actions.'] }
  try {
    let built
    if (sandboxOnly) {
      const prior = JSON.parse(readFileSync(path.join(ROOT, 'src/tests/evidence/WO-2526', args[2], 'result.json'), 'utf8'))
      const exported = JSON.parse(readFileSync(path.join(ROOT, 'src/tests/evidence/WO-2526', resume, 'result.json'), 'utf8'))
      if (prior.sourceCommit !== exported.sourceCommit || !prior.installer || prior.browser?.length !== 5) throw new Error('Sandbox retry requires matching built installer and completed browser record')
      const installer = path.join(runtime, 'export/release', prior.installer.name)
      if (createHash('sha256').update(readFileSync(installer)).digest('hex') !== prior.installer.sha256) throw new Error('Installer changed since prior browser run')
      Object.assign(record, { sourceCommit: prior.sourceCommit, installer: prior.installer, browser: prior.browser, browserEvidenceRun: prior.run, export: prior.export, electronVersion: prior.electronVersion })
      record.notes.push(`Sandbox-only retry; unchanged installer hash and browser evidence from ${prior.run}.`)
      record.notes.push(...prior.notes.filter(note => !record.notes.includes(note)))
      built = { installer }
    } else built = await buildExport(runtime, record, resume, pages => browserJourney(pages, path.join(evidence, 'browser'), record))
    record.runtimeRun = resume ?? run
    await sandboxJourney(built.installer, runtime, evidence, record)
  } catch (e) { record.error = String(e.stack ?? e); record.notes.push(record.error.split('\n')[0]); console.error(record.error) }
  finally {
    writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(record, null, 2))
    writeFileSync(path.join(destination, 'FINDINGS.md'), findingsMarkdown(record))
    console.log(`Evidence: ${evidence}`)
  }
  process.exitCode = record.error || record.browser?.length !== 5 || record.browser.some(s => s.status !== 'PASS') || record.sandbox?.status !== 'PASS' ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
