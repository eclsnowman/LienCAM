import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Connect, type Plugin } from 'vite'
import ts from 'typescript'
import react from '@vitejs/plugin-react'

// Git build provenance computed ONCE at config eval. Each lookup is wrapped in
// its own try/catch with a safe fallback so a build with no git available (CI
// tarball, exported source) does NOT crash. Injected via `define` below as
// compile-time constant replacements, surfaced to the user in Settings -> About.
// WO-2463: a release built from the public export has no .git, so the release
// driver names the source commit it exported (LIENCAM_BUILD_COMMIT / _BRANCH).
let gitCommit = process.env.LIENCAM_BUILD_COMMIT?.trim() || 'unknown'
if (gitCommit === 'unknown') try {
  gitCommit = execSync('git rev-parse --short HEAD').toString().trim()
} catch { /* no git -> keep fallback */ }

let gitBranch = process.env.LIENCAM_BUILD_BRANCH?.trim() || 'unknown'
if (gitBranch === 'unknown') try {
  gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
} catch { /* no git -> keep fallback */ }

let buildDate = 'unknown'
try {
  buildDate = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
} catch { /* keep fallback */ }

const projectRoot = dirname(fileURLToPath(import.meta.url))
const installedDependencyRoot = realpathSync(join(projectRoot, 'node_modules'))
const sharedRepoRoot = dirname(installedDependencyRoot)
const pendantServerPath = resolve(projectRoot, 'pendant/server.mjs')
const pendantBrokerPort = 8324
const pendantHealthUrl = `http://127.0.0.1:${pendantBrokerPort}/api/bridge/status`

export const RENDERER_BUILD_INPUTS = Object.freeze([
  'src',
  'public',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.mts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
])

function rendererBuildFiles(root: string): string[] {
  const files: string[] = []
  const visit = (relativePath: string) => {
    if (relativePath.replaceAll('\\', '/') === 'src/tests') return
    const absolutePath = join(root, relativePath)
    const stat = statSync(absolutePath)
    if (!stat.isDirectory()) {
      files.push(relativePath.replaceAll('\\', '/'))
      return
    }
    for (const name of readdirSync(absolutePath).sort()) visit(join(relativePath, name))
  }
  for (const input of RENDERER_BUILD_INPUTS) visit(input)
  return files.sort()
}

export function rendererBuildContentIdentity(root = projectRoot): string {
  const hash = createHash('sha256')
  for (const relativePath of rendererBuildFiles(root)) {
    const bytes = readFileSync(join(root, relativePath))
    hash.update(`${relativePath.length}:${relativePath}:${bytes.length}:`)
    hash.update(bytes)
  }
  return `sha256-${hash.digest('hex')}`
}

const rendererBuildProvenance = `${gitCommit}:${rendererBuildContentIdentity()}`

const TEST_FORK_BUDGET = Math.max(1, availableParallelism() - 4)
const TEST_LEASE_TTL_MS = 60_000

interface TestForkLeaseRecord {
  pid: number
  workers: number
  expiresAt: number
}

export interface TestForkLeaseOptions {
  budgetDir?: string
  budget?: number
  liveLanes?: number
  pid?: number
  ttlMs?: number
  now?: () => number
  processAlive?: (pid: number) => boolean
  sleep?: (ms: number) => void
}

interface TakeTestForkLeaseOptions extends TestForkLeaseOptions {
  waitTimeoutMs?: number
  warn?: (message: string) => void
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function configuredLiveLanes(environment: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(environment.LIENCAM_TEST_LIVE_LANES)
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  return 1
}

export function resolveTestForkBudgetDir(
  repoRoot = sharedRepoRoot,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  if (environment.LIENCAM_TEST_BUDGET_DIR) return environment.LIENCAM_TEST_BUDGET_DIR
  const worktreeRoot = join(repoRoot, '.worktrees')
  return pathExists(worktreeRoot) ? join(worktreeRoot, 'test-budget') : null
}

export function acquireTestForkLease(options: TestForkLeaseOptions = {}) {
  const budgetDir = options.budgetDir ?? resolveTestForkBudgetDir()
  if (budgetDir === null) return null
  const budget = options.budget || TEST_FORK_BUDGET
  const liveLanes = options.liveLanes || configuredLiveLanes()
  const pid = options.pid || process.pid
  const ttlMs = options.ttlMs || TEST_LEASE_TTL_MS
  const now = options.now || Date.now
  const isAlive = options.processAlive || processAlive
  const sleep = options.sleep || ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const lockDir = join(budgetDir, '.lock')
  mkdirSync(budgetDir, { recursive: true })
  for (;;) {
    try { mkdirSync(lockDir); break } catch {
      try { if (now() - statSync(lockDir).mtimeMs > ttlMs) rmSync(lockDir, { recursive: true, force: true }) } catch { /* another contender won */ }
      sleep(25)
    }
  }
  try {
    let reserved = 0
    for (const name of readdirSync(budgetDir).filter(name => name.endsWith('.json'))) {
      const path = join(budgetDir, name)
      try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as TestForkLeaseRecord
        if (record.expiresAt <= now() || !isAlive(record.pid)) rmSync(path, { force: true })
        else reserved += record.workers
      } catch { rmSync(path, { force: true }) }
    }
    const workers = Math.min(Math.max(1, Math.floor(budget / liveLanes)), budget - reserved)
    if (workers < 1) return null
    const path = join(budgetDir, `${pid}-${now()}-${Math.random().toString(36).slice(2)}.json`)
    const temporaryPath = `${path}.tmp`
    const write = () => {
      writeFileSync(temporaryPath, JSON.stringify({ pid, workers, expiresAt: now() + ttlMs } satisfies TestForkLeaseRecord))
      renameSync(temporaryPath, path)
    }
    write()
    return { workers, path, renew: write, release: () => { rmSync(path, { force: true }); rmSync(temporaryPath, { force: true }) } }
  } finally { rmSync(lockDir, { recursive: true, force: true }) }
}

export function takeTestForkLease(options: TakeTestForkLeaseOptions = {}) {
  const budgetDir = options.budgetDir ?? resolveTestForkBudgetDir()
  if (budgetDir === null) return TEST_FORK_BUDGET
  const leaseOptions = { ...options, budgetDir }
  const sleep = options.sleep || ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const warn = options.warn || console.error
  const waitTimeoutMs = options.waitTimeoutMs ?? 5_000
  const waitStarted = Date.now()
  let lease = acquireTestForkLease(leaseOptions)
  if (!lease) warn(`[WO-1241] Vitest fork budget exhausted; waiting up to ${waitTimeoutMs} ms for a lease.`)
  while (!lease && Date.now() - waitStarted < waitTimeoutMs) {
    sleep(Math.min(100, waitTimeoutMs - (Date.now() - waitStarted)))
    lease = acquireTestForkLease(leaseOptions)
  }
  if (!lease) {
    warn('[WO-1241] Vitest fork budget wait expired; proceeding with one worker to avoid a silent lane stall.')
    return 1
  }
  const heartbeat = setInterval(lease.renew, Math.floor(TEST_LEASE_TTL_MS / 3)).unref()
  const release = () => { clearInterval(heartbeat); lease.release() }
  process.once('exit', release)
  process.once('SIGINT', () => { release(); process.exit(130) })
  process.once('SIGTERM', () => { release(); process.exit(143) })
  return lease.workers
}

export function shouldTakeTestForkLease(environment: NodeJS.ProcessEnv = process.env) {
  return environment.VITEST === 'true' && environment.VITEST_WORKER_ID === undefined
}

const testForkWorkers = shouldTakeTestForkLease() ? takeTestForkLease() : TEST_FORK_BUDGET

interface PendantHealth {
  ok?: boolean
  service?: string
}

async function pendantBrokerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(pendantHealthUrl, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const payload = await response.json() as PendantHealth
    return payload.ok === true && payload.service === 'liencam-pendant-bridge'
  } catch {
    return false
  }
}

function pendantBrokerLifecycle(): Plugin {
  let child: ChildProcess | null = null
  let startPromise: Promise<void> | null = null
  let stderr = ''

  const stop = async () => {
    const owned = child
    child = null
    startPromise = null
    if (!owned || owned.exitCode !== null || owned.killed) return
    await new Promise<void>((done) => {
      const timeout = setTimeout(done, 1_000)
      owned.once('exit', () => {
        clearTimeout(timeout)
        done()
      })
      owned.kill()
    })
  }

  const start = async () => {
    if (await pendantBrokerHealthy()) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      stderr = ''
      const launched = spawn(
        process.execPath,
        [pendantServerPath, '--bridge', '--port', String(pendantBrokerPort)],
        { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      child = launched
      launched.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-2_000)
      })
      launched.once('exit', () => {
        if (child === launched) child = null
      })
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await pendantBrokerHealthy()) return
        if (launched.exitCode !== null) break
        await new Promise((done) => setTimeout(done, 50))
      }
      await stop()
      throw new Error(stderr.trim() || 'The local pendant service did not become ready.')
    })().finally(() => { startPromise = null })
    return startPromise
  }

  const install = (middlewares: Connect.Server, onClose: (callback: () => void) => void) => {
    middlewares.use(async (req, res, next) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!pathname.startsWith('/__liencam/pendant-broker/')) return next()
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      if (req.method !== 'POST' || req.headers['x-liencam-host'] !== 'pendant') {
        res.statusCode = 403
        res.end(JSON.stringify({ ok: false, error: 'Pendant host request refused.' }))
        return
      }
      try {
        if (pathname.endsWith('/start')) {
          await start()
          res.end(JSON.stringify({
            ok: true,
            brokerUrl: `ws://127.0.0.1:${pendantBrokerPort}/bridge`,
            port: pendantBrokerPort,
          }))
          return
        }
        if (pathname.endsWith('/stop')) {
          await stop()
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'Unknown pendant host action.' }))
      } catch (error) {
        res.statusCode = 503
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    })
    onClose(() => { void stop() })
  }

  return {
    name: 'liencam-pendant-broker-lifecycle',
    configureServer(server) {
      install(server.middlewares, (callback) => server.httpServer?.once('close', callback))
    },
    configurePreviewServer(server) {
      install(server.middlewares, (callback) => server.httpServer?.once('close', callback))
    },
  }
}

// WO-2334: the static web build carries the licence files and the source offer
// for our patched OCCT at the root of dist/ - the same four items the desktop
// installer carries in its resources/ folder (electron-builder.yml).
export const RELEASE_LEGAL_FILES = Object.freeze(['LICENSE', 'THIRD_PARTY_LICENSES.md', 'NOTICE-GEO9.md', 'patches'])

function releaseLegalFiles(): Plugin {
  const files = (relativePath: string): string[] => statSync(join(projectRoot, relativePath)).isDirectory()
    ? readdirSync(join(projectRoot, relativePath)).sort().flatMap((name) => files(`${relativePath}/${name}`))
    : [relativePath]
  return {
    name: 'liencam-release-legal-files',
    apply: 'build',
    generateBundle() {
      for (const fileName of RELEASE_LEGAL_FILES.flatMap(files)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(join(projectRoot, fileName)) })
      }
    },
  }
}

// WO-2485: workers have independent module graphs. Build the LGPL engine once
// and route every deep import to a namespace in that replaceable ES module.
// Merely assigning manual chunks would duplicate it in each worker bundle.
const adaptiveEngineRoot = resolve(projectRoot, 'src/lib/cam/adaptiveClearing2d/engine')
const sharedFaceClipper = resolve(projectRoot, 'src/lib/cam/face2d/clipperOffset.ts')
const adaptiveEngineFile = 'assets/adaptive2d-engine.js'
const oclWasmFile = 'assets/opencamlib.wasm'
const adaptiveModules = readdirSync(adaptiveEngineRoot).filter(name => name.endsWith('.ts')).sort()
const lgplChunkModules: Record<string, string[]> = {}
let adaptiveBuild: Promise<Awaited<ReturnType<typeof build>>> | undefined

function engineNamespace(name: string) { return name.replace(/\.ts$/, '') }

function runtimeExports(name: string): string[] {
  const javascript = ts.transpileModule(readFileSync(name === 'faceClipper' ? sharedFaceClipper : join(adaptiveEngineRoot, name), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
  const source = ts.createSourceFile(name, javascript, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const names: string[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map(element => element.name.text))
    } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.push(statement.name.text)
    }
  }
  return [...new Set(names)]
}

function lgplModules(worker = false): Plugin {
  const facadePrefix = '\0liencam-adaptive-facade:'
  return {
    name: 'liencam-replaceable-lgpl-modules',
    apply: 'build',
    enforce: 'pre',
    async buildStart() {
      if (worker) return
      adaptiveBuild ??= build({
        configFile: false, root: projectRoot, base: './', logLevel: 'warn',
        plugins: [{
          name: 'liencam-adaptive-entry',
          resolveId(id) { if (id === 'liencam-adaptive-entry') return '\0liencam-adaptive-entry' },
          load(id) {
            if (id === '\0liencam-adaptive-entry') return [
              ...adaptiveModules.map(name =>
                `export * as ${engineNamespace(name)} from ${JSON.stringify(join(adaptiveEngineRoot, name).replaceAll('\\', '/'))};`),
              // Pocket and V-carve initialise this wrapper before the engine's
              // workholding helpers use it. Preserve ONE instance per realm.
              `export * as faceClipper from ${JSON.stringify(sharedFaceClipper.replaceAll('\\', '/'))};`,
            ].join('\n')
          },
        }],
        build: {
          target: 'esnext', write: false, minify: false,
          lib: { entry: 'liencam-adaptive-entry', formats: ['es'] },
          rollupOptions: { input: 'liencam-adaptive-entry', output: { entryFileNames: adaptiveEngineFile, inlineDynamicImports: true } },
        },
      })
      // Vite library builds return an array even for the one ES format.
      const built = await adaptiveBuild
      const outputs = Array.isArray(built) ? built : [built]
      if (outputs.length !== 1 || !('output' in outputs[0])) throw new Error('WO-2485: expected a single engine output')
      const output = outputs[0]
      for (const item of output.output) {
        this.emitFile({ type: 'asset', fileName: item.fileName, source: item.type === 'chunk' ? item.code : item.source })
        if (item.type === 'chunk') lgplChunkModules[item.fileName] = Object.keys(item.modules)
      }
    },
    resolveId(id, importer) {
      if (id === './adaptive2d-engine.js') return { id, external: true }
      if (!importer || !id.startsWith('.')) return
      const absolute = resolve(dirname(importer), id)
      if (absolute.replace(/\.ts$/, '') === sharedFaceClipper.replace(/\.ts$/, '')) return facadePrefix + 'faceClipper'
      const name = absolute === adaptiveEngineRoot ? 'index.ts' : absolute.slice(adaptiveEngineRoot.length + 1).replace(/\.ts$/, '') + '.ts'
      if ((absolute === adaptiveEngineRoot || absolute.startsWith(adaptiveEngineRoot + '/')) || absolute.startsWith(adaptiveEngineRoot + '\\')) {
        if (adaptiveModules.includes(name)) return facadePrefix + name
      }
    },
    load(id) {
      if (!id.startsWith(facadePrefix)) return
      const name = id.slice(facadePrefix.length)
      return `import { ${engineNamespace(name)} as engine } from './adaptive2d-engine.js';\n` +
        runtimeExports(name).map(symbol => `export const ${symbol} = engine.${symbol};`).join('\n')
    },
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/@opencamlib/opencamlib/browser.js')) return
      const binary = /'data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)'/g
      const matches = [...code.matchAll(binary)]
      if (matches.length !== 1) throw new Error('WO-2485: OpenCAMLib embedded WASM format changed')
      const reference = this.emitFile({ type: 'asset', fileName: oclWasmFile, source: Buffer.from(matches[0][1], 'base64') })
      return code.replace(binary, `import.meta.ROLLUP_FILE_URL_${reference}`)
        .replace('wasmBinaryFile = locateFile(wasmBinaryFile);', '// The emitted URL is already absolute.')
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === 'chunk') lgplChunkModules[item.fileName] = Object.keys(item.modules)
      if (!worker) this.emitFile({ type: 'asset', fileName: 'lgpl-modules.json', source: JSON.stringify({
        adaptiveEngine: adaptiveEngineFile, openCamLibWasm: oclWasmFile, chunks: lgplChunkModules,
      }, null, 2) })
    },
  }
}

export default defineConfig({
  // The desktop shell serves the packaged build from a secure custom origin.
  // Relative URLs keep every emitted HTML entry portable inside app.asar.
  base: './',
  plugins: [react(), pendantBrokerLifecycle(), releaseLegalFiles(), lgplModules()],
  worker: { format: 'es', plugins: () => [lgplModules(true)] },
  server: {
    fs: {
      // Isolated Windows worktrees share node_modules through a junction to the
      // main checkout. Vite resolves that junction before its filesystem guard,
      // so both the worktree and the installed dependency target must be allowed.
      allow: [projectRoot, installedDependencyRoot],
    },
    // Ignore generated caches, legacy in-root worktrees, bridge compiler output
    // and the agent/runner bookkeeping folders (.planning alone holds 200k+ log
    // files) so unrelated writes cannot reload, crash or bloat the dev server.
    watch: {
      ignored: [
        '**/.worktrees/**',
        '**/.vite-cache/**',
        '**/pendant/uccnc-bridge/bin/**',
        '**/.planning/**',
        '**/.claude/**',
        '**/.opencode/**',
        '**/queue/**',
        '**/.git/**',
      ],
    },
  },
  define: {
    // WO-1272: identify the bytes built, including dirty-tree content, rather
    // than only a commit that may not describe the build input.
    __APP_GIT_COMMIT__: JSON.stringify(rendererBuildProvenance),
    __APP_GIT_BRANCH__: JSON.stringify(gitBranch),
    __APP_BUILD_DATE__: JSON.stringify(buildDate),
  },
  // Keep dependency optimization local even when node_modules is shared.
  cacheDir: join(projectRoot, '.vite-cache'),
  optimizeDeps: {
    // Scan product entry points explicitly so generated/private trees are not crawled.
    entries: [
      'index.html',
      'pendant/app/index.html',
      'src/components/model3d/demo/index.html',
      'src/components/model3d/tree/demo/index.html',
      'src/tests/tools/capture-proof/fixture.html',
    ],
    include: ['three'],
    // WASM packages keep stable unhashed module URLs; three remains pre-bundled.
    exclude: ['occt-wasm', '@salusoft89/planegcs', 'clipper2-wasm'],
  },
  build: {
    target: 'esnext',
    manifest: true,
    rollupOptions: {
      input: {
        app: resolve(projectRoot, 'index.html'),
        pendant: resolve(projectRoot, 'pendant/app/index.html'),
        // The WO-958 evidence page is private: the public export leaves it out,
        // so build it only where it exists.
        ...(existsSync(resolve(projectRoot, 'electron/evidence.html'))
          ? { wo958Evidence: resolve(projectRoot, 'electron/evidence.html') }
          : {}),
      },
    },
  },
  // @ts-expect-error vitest 3 no longer augments vite's UserConfigExport; test key is passed through at runtime
  test: {
    environment: 'node',
    // INT-17A-R7: global boundary guard for the jsdom broken-localStorage
    // class (src/tests/setup/localStoragePolyfill.ts) -- installs a working
    // in-memory localStorage before each jsdom suite's own imports run (see
    // that file's header for the setupFiles-runs-before-collect ordering
    // proof), so no suite needs a per-file polyfill import.
    setupFiles: ['src/tests/setup/localStoragePolyfill.ts'],
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'],
    // Share one optional machine-wide worker budget when the private runner
    // supplies it; a public checkout uses the local processor budget directly.
    maxWorkers: testForkWorkers,
    // Heavy UI tests need more than Vitest's default timeout under lane load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
