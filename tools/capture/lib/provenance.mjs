import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const DEFAULT_SERVER_TIMEOUT_MS = 90_000
const DEFAULT_MINIMUM_BYTES = 1_024
// The product bundle is sourced from src/. Test and evidence artifacts do not
// execute in the app, so they are excluded unless a caller names another scope.
const DEFAULT_SOURCE_PATHS = ['src']
const DEFAULT_SOURCE_EXCLUDE_PATHS = ['src/tests']
const hashesWrittenThisRun = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function requestAnswers(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume()
      resolve(true)
    })
    request.setTimeout(1_000, () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

async function waitForServer(url, server, timeoutMs, output, childReportedReady) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(
        `CAPTURE SERVER HARD-FAIL: vite exited with code ${server.exitCode} before ${url} answered\n${output()}`,
      )
    }
    if (childReportedReady() && await requestAnswers(url)) return
    await sleep(300)
  }
  throw new Error(`CAPTURE SERVER HARD-FAIL: server not up at ${url} after ${timeoutMs}ms\n${output()}`)
}

async function waitForExit(server, timeoutMs) {
  if (server.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    server.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function stopProcessTree(server) {
  if (!server.pid || server.exitCode !== null) return

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
    await waitForExit(server, 5_000)
    return
  }

  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    try { server.kill('SIGTERM') } catch { /* already gone */ }
  }
  if (await waitForExit(server, 5_000)) return
  try {
    process.kill(-server.pid, 'SIGKILL')
  } catch {
    try { server.kill('SIGKILL') } catch { /* already gone */ }
  }
  await waitForExit(server, 5_000)
}

/**
 * Run a capture against this checkout's own Vite process. The callback shape
 * makes teardown part of the helper instead of an obligation each caller can
 * forget. A caller-supplied port and --strictPort are mandatory.
 */
export async function withViteCaptureServer({
  port,
  repoRoot = process.cwd(),
  host = '127.0.0.1',
  timeoutMs = DEFAULT_SERVER_TIMEOUT_MS,
}, run) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('CAPTURE SERVER HARD-FAIL: caller must supply a dedicated integer port from 1 to 65535')
  }
  if (typeof run !== 'function') {
    throw new TypeError('CAPTURE SERVER HARD-FAIL: caller must supply a run callback')
  }

  const root = path.resolve(repoRoot)
  const viteEntry = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteEntry)) {
    throw new Error(`CAPTURE SERVER HARD-FAIL: vite entry not found for this checkout at ${viteEntry}`)
  }

  const baseUrl = `http://${host}:${port}/`
  if (await requestAnswers(baseUrl)) {
    throw new Error(
      `CAPTURE SERVER HARD-FAIL: dedicated port ${port} already answers at ${baseUrl} before branch Vite was started`,
    )
  }

  const server = spawn(process.execPath, [
    viteEntry,
    '--host', host,
    '--port', String(port),
    '--strictPort',
  ], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let serverOutput = ''
  const recordOutput = (chunk) => {
    const text = chunk.toString()
    serverOutput = `${serverOutput}${text}`.slice(-8_000)
    process.stdout.write(`[capture:vite] ${text}`)
  }
  server.stdout.on('data', recordOutput)
  server.stderr.on('data', recordOutput)

  try {
    console.log(`[capture] starting branch server at ${baseUrl} (--strictPort)`)
    await waitForServer(
      baseUrl,
      server,
      timeoutMs,
      () => serverOutput,
      // Vite 8 colours the number even on a pipe; strip ANSI before matching.
      () => /\bready in \d+ ms\b/i.test(serverOutput.replace(/\x1b\[[0-9;]*m/g, '')),
    )
    console.log(`[capture] branch server answered at ${baseUrl}`)
    return await run({ baseUrl, server })
  } finally {
    await stopProcessTree(server)
    console.log(`[capture] branch server stopped at ${baseUrl}`)
  }
}

function removeInvalidOutput(outputPath) {
  try { rmSync(outputPath, { force: true }) } catch { /* report the primary failure */ }
}

function normalizeSourcePaths(repoRoot, sourcePaths) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new TypeError('SOURCE PROVENANCE HARD-FAIL: sourcePaths must contain at least one path')
  }

  return [...new Set(sourcePaths.map((sourcePath) => {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || path.isAbsolute(sourcePath)) {
      throw new TypeError('SOURCE PROVENANCE HARD-FAIL: sourcePaths must be non-empty relative paths')
    }
    const absolutePath = path.resolve(repoRoot, sourcePath)
    const relativePath = path.relative(repoRoot, absolutePath)
    if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || relativePath === '..') {
      throw new TypeError('SOURCE PROVENANCE HARD-FAIL: sourcePaths must stay inside repoRoot')
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`SOURCE PROVENANCE HARD-FAIL: source path does not exist: ${sourcePath}`)
    }
    return relativePath.split(path.sep).join('/')
  }))].sort()
}

function normalizeExcludePaths(repoRoot, excludePaths) {
  if (!Array.isArray(excludePaths)) {
    throw new TypeError('SOURCE PROVENANCE HARD-FAIL: sourceExcludePaths must be an array')
  }
  return [...new Set(excludePaths.map((excludePath) => {
    if (typeof excludePath !== 'string' || excludePath.length === 0 || path.isAbsolute(excludePath)) {
      throw new TypeError(
        'SOURCE PROVENANCE HARD-FAIL: sourceExcludePaths must contain non-empty relative paths',
      )
    }
    const relativePath = path.relative(repoRoot, path.resolve(repoRoot, excludePath))
    if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || relativePath === '..') {
      throw new TypeError('SOURCE PROVENANCE HARD-FAIL: sourceExcludePaths must stay inside repoRoot')
    }
    return relativePath.split(path.sep).join('/')
  }))].sort()
}

function collectSourceFiles(repoRoot, sourcePaths, sourceExcludePaths) {
  const files = new Map()
  const isExcluded = (relativePath) => sourceExcludePaths.some(
    (excludePath) => relativePath === excludePath || relativePath.startsWith(`${excludePath}/`),
  )

  const visit = (relativePath) => {
    const normalizedPath = relativePath.split(path.sep).join('/')
    if (isExcluded(normalizedPath)) return
    const absolutePath = path.join(repoRoot, relativePath)
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `SOURCE PROVENANCE HARD-FAIL: symbolic source paths are unsupported: ${relativePath}`,
      )
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        visit(path.join(relativePath, entry))
      }
      return
    }
    if (stat.isFile()) {
      files.set(relativePath.split(path.sep).join('/'), absolutePath)
    }
  }

  for (const sourcePath of sourcePaths) visit(sourcePath)
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right))
}

/**
 * Identify the live source bytes at capture time. HEAD is retained for
 * traceability, but the source hash is built from the current files so a
 * temporarily substituted tree cannot masquerade as the checked-out commit.
 * Dirtiness is scoped to the same named paths to keep generated screenshots
 * elsewhere in the worktree from making identical source look different.
 */
export function captureSourceProvenance({
  repoRoot = process.cwd(),
  sourcePaths = DEFAULT_SOURCE_PATHS,
  sourceExcludePaths = DEFAULT_SOURCE_EXCLUDE_PATHS,
} = {}) {
  const root = path.resolve(repoRoot)
  const normalizedPaths = normalizeSourcePaths(root, sourcePaths)
  const normalizedExcludes = normalizeExcludePaths(root, sourceExcludePaths)
  const sourceFiles = collectSourceFiles(root, normalizedPaths, normalizedExcludes)
  if (sourceFiles.length === 0) {
    throw new Error('SOURCE PROVENANCE HARD-FAIL: sourcePaths contain no files')
  }

  let commit
  let status
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    status = execFileSync(
      'git',
      [
        'status', '--porcelain=v1', '--untracked-files=all', '--',
        ...normalizedPaths,
        ...normalizedExcludes.map((excludePath) => `:(exclude)${excludePath}`),
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    ).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`SOURCE PROVENANCE HARD-FAIL: git metadata unavailable: ${detail}`)
  }

  const hash = createHash('sha256')
  for (const [relativePath, absolutePath] of sourceFiles) {
    const content = readFileSync(absolutePath)
    hash.update(`path:${Buffer.byteLength(relativePath)}:`)
    hash.update(relativePath)
    hash.update(`\nbytes:${content.length}:\n`)
    hash.update(content)
    hash.update('\n')
  }

  return {
    commit,
    workingTreeDirty: status.length > 0,
    workingTreeScope: normalizedPaths,
    sourceExcludes: normalizedExcludes,
    sourceHash: hash.digest('hex'),
    sourceHashAlgorithm: 'sha256-path-and-content-v1',
    sourceFileCount: sourceFiles.length,
  }
}

/**
 * The only screenshot write path in the reusable harness. It deletes stale
 * output before evaluating a mandatory live-page predicate, writes the PNG,
 * validates it, and rejects byte-identical later shots in the same process.
 */
export async function captureProvenancedScreenshot({
  page,
  target = page,
  outputPath,
  provenance,
  repoRoot = process.cwd(),
  sourcePaths = DEFAULT_SOURCE_PATHS,
  sourceExcludePaths = DEFAULT_SOURCE_EXCLUDE_PATHS,
  screenshotOptions = {},
  minimumBytes = DEFAULT_MINIMUM_BYTES,
}) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('CAPTURE HARD-FAIL: outputPath is required')
  }

  const absoluteOutputPath = path.resolve(outputPath)
  const shotName = path.basename(absoluteOutputPath)

  // This must happen before every gate, including malformed/missing gates.
  rmSync(absoluteOutputPath, { force: true })

  if (typeof provenance !== 'function') {
    throw new TypeError(
      `PROVENANCE HARD-FAIL before ${shotName}: a live-page provenance predicate is mandatory; no PNG was written`,
    )
  }

  let proven
  try {
    proven = await provenance(page, { outputPath: absoluteOutputPath, shotName })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`PROVENANCE HARD-FAIL before ${shotName}: predicate threw: ${detail}`)
  }
  if (proven !== true) {
    throw new Error(
      `PROVENANCE HARD-FAIL before ${shotName}: the live page did not satisfy this capture's predicate; no PNG was written`,
    )
  }

  if (!target || typeof target.screenshot !== 'function') {
    throw new TypeError(`CAPTURE HARD-FAIL for ${shotName}: screenshot target has no screenshot() method`)
  }
  if (!Number.isInteger(minimumBytes) || minimumBytes < 1) {
    throw new TypeError(`CAPTURE HARD-FAIL for ${shotName}: minimumBytes must be a positive integer`)
  }

  const sourceProvenance = captureSourceProvenance({
    repoRoot,
    sourcePaths,
    sourceExcludePaths,
  })

  try {
    await target.screenshot({ ...screenshotOptions, path: absoluteOutputPath })
  } catch (error) {
    removeInvalidOutput(absoluteOutputPath)
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPTURE HARD-FAIL for ${shotName}: screenshot write failed: ${detail}`)
  }

  let size
  try {
    size = statSync(absoluteOutputPath).size
  } catch {
    throw new Error(`CAPTURE HARD-FAIL for ${shotName}: screenshot returned but output file is missing`)
  }
  if (size < minimumBytes) {
    removeInvalidOutput(absoluteOutputPath)
    throw new Error(
      `CAPTURE HARD-FAIL for ${shotName}: output was ${size} bytes, below the ${minimumBytes}-byte minimum; invalid PNG removed`,
    )
  }

  const hash = createHash('sha256').update(readFileSync(absoluteOutputPath)).digest('hex')
  const earlierPath = hashesWrittenThisRun.get(hash)
  if (earlierPath && earlierPath !== absoluteOutputPath) {
    removeInvalidOutput(absoluteOutputPath)
    throw new Error(
      `DUPLICATE CAPTURE HARD-FAIL: ${shotName} is byte-identical to ${path.basename(earlierPath)}; ${shotName} was removed`,
    )
  }
  hashesWrittenThisRun.set(hash, absoluteOutputPath)

  console.log(`[capture] wrote ${shotName} (${size} bytes, sha256 ${hash})`)
  return { bytes: size, hash, outputPath: absoluteOutputPath, sourceProvenance }
}
