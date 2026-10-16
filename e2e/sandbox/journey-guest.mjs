// Runs INSIDE Windows Sandbox (started by e2e/sandbox/bootstrap.ps1 as
// `node guest.mjs <installed LienCAM.exe> <host base url>`): the whole
// fresh-PC journey (G5.1-G5.9) against the app the installer just put there,
// on an empty profile. Evidence goes back to the host over HTTP; nothing on
// the host is mapped writable.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [appPath, base] = process.argv.slice(2)
const outDir = 'C:\\Evidence'

async function post(suffix, body) {
  const response = await fetch(`${base}/${suffix}`, { method: 'POST', body })
  if (!response.ok) throw new Error(`POST ${suffix}: ${response.status}`)
}

export function evidenceFiles(root, dir = root) {
  const files = []
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) files.push(...evidenceFiles(root, file))
    else files.push(path.relative(root, file).split(path.sep).join('/'))
  }
  return files
}

// PASS needs the journey child to have exited 0 with all nine steps recorded
// as PASS; a partial result left behind by a crash between steps is BLOCKED.
export function guestStatus({ error, exitCode, journey }) {
  if (error || !journey) return 'BLOCKED'
  if (journey.verdict !== 'PASS') return journey.verdict ?? 'BLOCKED'
  const steps = Array.isArray(journey.steps) ? journey.steps : []
  return exitCode === 0 && steps.length === 9 && steps.every(s => s.status === 'PASS') ? 'PASS' : 'BLOCKED'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now()
  let exitCode = null
  let error
  try {
    const args = [path.join(HERE, 'fresh-pc-journey.mjs'), '--app', appPath, '--out', outDir,
      '--samples', path.join(HERE, 'samples'), '--profile', 'C:\\FreshProfile', '--shots']
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = ''
    const relay = chunk => {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop()
      for (const line of lines) if (line.trim()) post('progress', line).catch(() => {})
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    exitCode = await new Promise(done => child.on('exit', code => done(code)))
  } catch (e) { error = String(e.stack ?? e) }
  let uploaded = 0
  try {
    for (const file of evidenceFiles(outDir)) {
      await post(`evidence/${file.split('/').map(encodeURIComponent).join('/')}`, readFileSync(path.join(outDir, file)))
      uploaded++
    }
  } catch (e) { error = `${error ?? ''}\nupload: ${e.message}`.trim() }
  let journey = null
  try { journey = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8')) } catch {}
  const status = guestStatus({ error, exitCode, journey })
  await post('result', JSON.stringify({ status, exitCode, error, uploaded, installMs: Number(process.env.STRANGER_INSTALL_MS), journeyMs: Date.now() - started }))
  // Exit 0 whatever the verdict: the verdict is in the result just posted, and
  // bootstrap.ps1 would overwrite it with BLOCKED on a nonzero exit.
}
