// Run with `node e2e/sandbox-journey.mjs --installer <LienCAM-*-setup.exe> --out <dir> [--source <sha>]`.
// The fresh-PC journey (release gate G5) in Windows Sandbox: the guest gets
// ONLY the installer (read-only mapping); the driver (portable node, Playwright
// core, e2e/lib, e2e/steps, the three sample files the journey imports) comes
// over a tokenized HTTP endpoint, and every piece of evidence goes back the
// same way. Nothing on the host is mapped writable. Foreground only.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpuAllowsSandbox, safeFile, sandboxConfig } from './stranger-test.mjs'
import { IMPORTS } from './steps/design-steps.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i]
  return args
}

function cpuSamples() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', '$s = 1..5 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep -Seconds 1 }; ConvertTo-Json -Compress @($s)'], { encoding: 'utf8', windowsHide: true }).trim())
}

/** The guest driver directory: what the zip carries into the Sandbox. */
export function buildGuest(guest, samplesDir) {
  mkdirSync(guest, { recursive: true })
  copyFileSync(process.execPath, path.join(guest, 'node.exe'))
  cpSync(path.join(ROOT, 'node_modules/playwright-core'), path.join(guest, 'driver'), { recursive: true })
  cpSync(path.join(ROOT, 'e2e/lib'), path.join(guest, 'lib'), { recursive: true })
  cpSync(path.join(ROOT, 'e2e/steps'), path.join(guest, 'steps'), { recursive: true })
  const harness = path.join(guest, 'lib/harness.mjs')
  const source = readFileSync(harness, 'utf8')
  if (!source.includes("from 'playwright'")) throw new Error('harness.mjs no longer imports playwright; inspect before adapting')
  writeFileSync(harness, source.replace("from 'playwright'", "from '../driver/index.mjs'"))
  copyFileSync(path.join(ROOT, 'e2e/fresh-pc-journey.mjs'), path.join(guest, 'fresh-pc-journey.mjs'))
  copyFileSync(path.join(ROOT, 'e2e/sandbox/journey-guest.mjs'), path.join(guest, 'guest.mjs'))
  mkdirSync(path.join(guest, 'samples'))
  for (const part of IMPORTS) copyFileSync(path.join(samplesDir, part.file), path.join(guest, 'samples', part.file))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.installer || !args.out) throw new Error('usage: node e2e/sandbox-journey.mjs --installer <setup.exe> --out <dir> [--source <sha>]')
  const installer = path.resolve(args.installer)
  const out = path.resolve(args.out)
  const run = new Date().toISOString().replace(/[:.]/g, '-')
  const runtime = path.join(tmpdir(), 'liencam-journey', run)
  mkdirSync(runtime, { recursive: true })
  mkdirSync(out, { recursive: true })
  const record = {
    run, source: args.source ?? null, status: 'NOT RUN', progress: [],
    installer: { name: path.basename(installer), bytes: statSync(installer).size, sha256: createHash('sha256').update(readFileSync(installer)).digest('hex') },
  }
  const finish = () => writeFileSync(path.join(out, 'sandbox.json'), `${JSON.stringify(record, null, 2)}\n`)
  try {
    // The box runs other lanes; wait (bounded) for headroom rather than start a
    // Sandbox whose timeouts would then read as product failures.
    const waitUntil = Date.now() + 30 * 60_000
    for (;;) {
      record.cpuSamples = cpuSamples()
      if (cpuAllowsSandbox(record.cpuSamples)) break
      if (Date.now() > waitUntil) { record.status = 'BLOCKED'; record.reason = 'CPU average >= 60% for 30 minutes; Sandbox not launched.'; return }
      await new Promise(done => setTimeout(done, 30_000))
    }
    const input = path.join(runtime, 'installer-only')
    mkdirSync(input)
    copyFileSync(installer, path.join(input, path.basename(installer)))
    const guest = path.join(runtime, 'guest')
    buildGuest(guest, path.join(ROOT, 'Sample Parts'))
    const guestZip = path.join(runtime, 'guest.zip')
    // System32's bsdtar: a GNU tar earlier on PATH (Git Bash) reads C: as a host.
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', guestZip, '-C', guest, '.'], { windowsHide: true })
    const token = randomBytes(24).toString('hex')
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
          if (suffix === 'started') { started = true; record.status = 'RUNNING'; console.log('guest started') }
          else if (suffix === 'progress') { const line = String(data); record.progress.push(line); console.log(`guest: ${line}`) }
          else if (suffix === 'result') { Object.assign(record, JSON.parse(data)); completed = true }
          else if (suffix.startsWith('evidence/')) {
            const file = safeFile(out, `/${suffix.slice(9)}`)
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, data)
          } else throw new Error('Unknown upload')
          res.end('ok'); return
        }
        if (suffix === 'bootstrap.ps1') {
          res.end(readFileSync(path.join(ROOT, 'e2e/sandbox/bootstrap.ps1'), 'utf8').replaceAll('__BASE__', `http://${req.headers.host}/${token}`)); return
        }
        if (suffix === 'guest.zip') { res.end(readFileSync(guestZip)); return }
        res.writeHead(404).end()
      } catch (error) { res.writeHead(400).end(error.message) }
    })
    await new Promise(done => server.listen(0, '0.0.0.0', done))
    const host = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } | Select-Object -First 1).IPv4Address.IPAddress'], { encoding: 'utf8', windowsHide: true }).trim()
    const config = path.join(runtime, `journey-${run}.wsb`)
    writeFileSync(config, sandboxConfig(input, `http://${host}:${server.address().port}/${token}/bootstrap.ps1`))
    writeFileSync(path.join(out, 'sandbox-config.wsb'), sandboxConfig(input, 'http://HOST:TOKEN_PORT/TOKEN/bootstrap.ps1'))
    const launchAt = Date.now()
    const child = spawn('WindowsSandbox.exe', [config], { windowsHide: true, stdio: 'ignore' })
    let launchError
    child.on('error', e => { launchError = e.message })
    child.on('exit', code => { record.launcherExit = code; if (code !== 0 && !completed) launchError = `WindowsSandbox.exe exited ${code}` })
    try {
      while (!completed && !launchError && Date.now() - launchAt < (started ? 90 * 60_000 : 180_000)) await new Promise(done => setTimeout(done, 500))
      if (!completed) {
        record.status = 'BLOCKED'
        record.reason = launchError ?? (started ? 'Guest journey timed out after 90 minutes' : 'Sandbox did not reach bootstrap in 180 seconds')
      }
      record.ms = Date.now() - launchAt
    } finally {
      if (child.exitCode === null) child.kill()
      // Stop only the Sandbox client whose command line names THIS config.
      const closeOwned = `$configPath = '${config.replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name = 'WindowsSandboxRemoteSession.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($configPath) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`
      execFileSync('powershell.exe', ['-NoProfile', '-Command', closeOwned], { windowsHide: true })
      await new Promise(done => server.close(done))
    }
  } catch (e) { record.status = 'BLOCKED'; record.reason = String(e.stack ?? e) }
  finally {
    // In finally so the CPU-wait return above still reports and exits nonzero.
    finish()
    console.log(`SANDBOX ${record.status}${record.reason ? ` ${record.reason}` : ''}`)
    process.exitCode = record.status === 'PASS' ? 0 : 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
