#!/usr/bin/env node
// Build committed public bytes, never the private working tree or its shared install.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const RELEASE_VERSION = '0.36.0-alpha.1'
const LEGAL = ['LICENSE', 'THIRD_PARTY_LICENSES.md', 'NOTICE-GEO9.md', 'patches']

export function assertExportIsolation(root) {
  for (const name of ['.git', 'queue', '.planning', 'src/tests/evidence', 'node_modules']) {
    if (existsSync(join(root, name))) throw new Error(`Export contains forbidden path: ${name}`)
  }
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Export contains a link: ${file}`)
      if (stat.isDirectory()) visit(file)
    }
  }
  visit(root)
}

export function stampVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) throw new Error('Invalid release version')
  for (const name of ['package.json', 'package-lock.json']) {
    const file = join(root, name)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.version = version
    if (name === 'package-lock.json' && data.packages?.['']) data.packages[''].version = version
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  }
}

export function describeArtifacts(directory, version) {
  return ['setup', 'portable'].map(kind => {
    const name = `LienCAM-${version}-win-x64-${kind}.exe`
    const file = join(directory, name)
    const size = statSync(file).size
    if (size < 10 * 1024 * 1024 || size > 4 * 1024 ** 3) throw new Error(`Implausible artifact size: ${name}: ${size}`)
    return { kind, name, size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
  })
}

function command(root, out, label, args, env = {}) {
  const log = join(out, `${label}.log`)
  console.log(`${label}: ${args.join(' ')}`)
  const childEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete childEnv[key]
  const run = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    // Inherited Node resolution hooks must not reach the private install.
    env: childEnv,
  })
  writeFileSync(log, `${run.stdout ?? ''}${run.stderr ?? ''}`)
  if (run.error || run.status !== 0) throw new Error(`${label} failed (${run.status}): ${run.error?.message ?? `see ${log}`}`)
}

// A retained export below the private checkout needs explicit resolution boundaries.
// The Node hook covers npm/build-tool imports; the Vite plugin covers its own resolver.
export function prepareExportBuildIsolation(root, npm) {
  const nodeGuard = join(root, '.liencam-release-node-guard.mjs')
  const viteConfig = join(root, '.liencam-release-vite.config.mjs')
  const config = ['vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js']
    .find(name => existsSync(join(root, name))) ?? 'vite.config.mts'
  writeFileSync(nodeGuard, `import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const roots = ${JSON.stringify([root, dirname(dirname(npm))])}.map(p => realpathSync(p));
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith('file:')) {
    const file = realpathSync(fileURLToPath(result.url));
    if (!roots.some(root => { const rel = relative(root, file); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }))
      throw new Error('Release isolation: Node resolved outside export/toolchain: ' + file);
  }
  return result;
} });
`)
  writeFileSync(viteConfig, `import original from ${JSON.stringify('./' + config)};
import { mergeConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
const root = realpathSync(${JSON.stringify(root)});
function check(id) {
  const file = id.split('?')[0];
  if (!isAbsolute(file)) return;
  const rel = relative(root, realpathSync(file));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Release isolation: Vite resolved outside export: ' + file);
}
export default async env => mergeConfig(typeof original === 'function' ? await original(env) : await original, {
  plugins: [{ name: 'liencam-release-isolation', enforce: 'pre',
    async resolveId(source, importer, options) {
      const result = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (result && !result.external) check(result.id);
      return result;
    },
    load(id) { check(id); return null; },
  }],
});
`)
  return {
    viteConfig,
    env: { GIT_CEILING_DIRECTORIES: dirname(root), NODE_PATH: '',
      NODE_OPTIONS: `--import=${pathToFileURL(nodeGuard).href}` },
  }
}

// WO-2463: the export has no .git, so the build is told which commit it is.
// vite.config.mts reads these; About shows the commit label.
export function buildCommitLabel(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`Export did not name its source commit: ${commit}`)
  return commit.slice(0, 12)
}

export function releaseBuildEnv(commit) {
  return { LIENCAM_BUILD_COMMIT: buildCommitLabel(commit), LIENCAM_BUILD_BRANCH: 'public-export' }
}

// The desktop app offers its examples through Help walkthroughs ("Open this
// example"); each ships as dist/help/<topic>/<name>.camproject.
export function shippedExamples(root) {
  const help = join(root, 'dist/help')
  const examples = []
  if (existsSync(help)) {
    for (const topic of readdirSync(help).sort()) {
      if (!statSync(join(help, topic)).isDirectory()) continue
      for (const file of readdirSync(join(help, topic)).sort()) {
        if (file.endsWith('.camproject')) examples.push({ topic, file, search: file.replace(/\.camproject$/, '').replace(/-/g, ' ') })
      }
    }
  }
  if (!examples.length) throw new Error(`No shipped examples under ${help}`)
  return examples
}

// A shipped example is a model: an open that never shows a body is an empty
// model, whatever the open itself reported. The Form kernel takes ~20-25 s cold.
export async function waitForBodies(readCount, { timeout = 180_000, interval = 250,
  sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now } = {}) {
  const started = now()
  for (;;) {
    const count = await readCount()
    if (count > 0) return { bodies: count, ms: now() - started }
    if (now() - started >= timeout) throw new Error(`Example opened with 0 bodies after ${timeout} ms (empty model)`)
    await sleep(interval)
  }
}

// Everything the release record must show before it may say PASS.
export function smokeProblems(smoke, { version, commit, examples }) {
  const problems = []
  if (smoke?.verdict !== 'PASS') problems.push(`smoke verdict ${smoke?.verdict}`)
  if (smoke?.aboutText !== `Version ${version}`) problems.push(`About reads "${smoke?.aboutText}", expected "Version ${version}"`)
  if (smoke?.aboutCommit !== commit) problems.push(`About commit reads "${smoke?.aboutCommit}", expected "${commit}"`)
  for (const example of examples) {
    const opened = smoke?.examples?.find(item => item.topic === example.topic && item.file === example.file)
    if (!opened) problems.push(`example ${example.topic}/${example.file} was not opened`)
    else if (!(opened.bodies > 0)) problems.push(`example ${example.topic}/${example.file} opened with ${opened.bodies} bodies`)
  }
  return problems
}

export async function smokePackagedApp({ appPath, outDir, version, commit, examples, harnessRoot = ROOT }) {
  // The CLI advertises --only but runs every step. Reuse its actual step-1
  // implementation to keep this packaging check within its declared slice.
  const { Journey, assert } = await import(pathToFileURL(join(harnessRoot, 'e2e/lib/harness.mjs')).href)
  const { firstLaunch } = await import(pathToFileURL(join(harnessRoot, 'e2e/steps/setup-steps.mjs')).href)
  const journey = new Journey({ appPath, outDir, shots: true })
  let aboutText = ''
  let aboutCommit = ''
  const opened = []
  try {
    await journey.step(1, 'first launch on an empty profile', async () => {
      await journey.launch(join(outDir, 'profile'))
      await firstLaunch(journey)
    })
    if (journey.steps[0].status !== 'PASS') throw new Error(journey.steps[0].reason)
    await journey.step(2, 'packaged About version and build commit', async () => {
      const page = journey.page
      await page.getByTestId('toolbar-help').click()
      // WO-2831 put an About button in the header too; this is Help's.
      await page.getByTestId('help-center').getByRole('button', { name: 'About LienCAM', exact: true }).click()
      aboutText = await page.getByTestId('about-modal').locator('.about-version').innerText()
      assert(aboutText === `Version ${version}`, `About reads ${aboutText}; expected Version ${version}`)
      aboutCommit = await page.getByTestId('about-modal').locator('.about-build dd').first().innerText() // "Build commit"
      journey.log(`ABOUT ${aboutText} commit ${aboutCommit}`)
      await journey.shot('about-version')
      assert(aboutCommit === commit, `About commit reads ${aboutCommit}; expected ${commit}`)
      await page.getByRole('button', { name: 'Close About LienCAM' }).click()
    })
    // Each example on its own empty profile, so a body count is never the
    // previous example's; the open goes through Help's "Open this example".
    // WO-2390 captured 0 bodies 0.3 s after the open: the model was still
    // computing, and the old check passed on the feature row alone.
    for (const [index, example] of examples.entries()) {
      await journey.step(3 + index, `open shipped example ${example.search}`, async () => {
        await journey.close()
        await journey.launch(join(outDir, `profile-${example.topic}`))
        await firstLaunch(journey)
        const page = journey.page
        await page.getByTestId('toolbar-help').click()
        await page.getByTestId('help-search').fill(example.search)
        await page.getByTestId(`help-topic-${example.topic}`).click()
        await page.getByTestId('help-open-example').first().click()
        await page.getByTestId('help-center').waitFor({ state: 'detached', timeout: 30_000 })
        await page.getByTestId('solids-workbench-root').waitFor({ timeout: 60_000 })
        const count = page.getByTestId('workbench-status-bodies')
        const result = await waitForBodies(async () => Number.parseInt(await count.innerText().catch(() => '0'), 10) || 0)
        await page.waitForTimeout(1_000) // let the viewport paint the body before the capture
        const status = (await count.locator('..').innerText()).replace(/\s+/g, ' ')
        journey.log(`EXAMPLE ${example.topic}/${example.file}: ${result.bodies} bodies after ${result.ms} ms; status ${status}`)
        opened.push({ ...example, ...result, status })
      })
    }
  } finally {
    await journey.close()
    journey.finish({ version, aboutText, aboutCommit, examples: opened })
  }
  if (journey.steps.some(step => step.status !== 'PASS')) throw new Error(`Packaged smoke failed: see ${outDir}`)
  return { version, aboutText, aboutCommit, examples: opened, steps: journey.steps.length, verdict: 'PASS' }
}

export async function buildFromExport({ source = 'HEAD', version = RELEASE_VERSION, outDir,
  root = ROOT, platform = process.platform, exporter, run = command, smoke = smokePackagedApp } = {}) {
  if (platform !== 'win32') throw new Error('Windows installer builds require Windows')
  const evidenceRoot = resolve(root, 'archive', 'evidence')
  if (outDir == null) mkdirSync(evidenceRoot, { recursive: true })
  const out = resolve(outDir ?? mkdtempSync(join(evidenceRoot, 'release-')))
  mkdirSync(out, { recursive: true })
  if (readdirSync(out).length) throw new Error(`Evidence output must be empty: ${out}`)
  // A plain new directory, never a git worktree and never a dependency link.
  // Retained on success/failure so the artifact and build inputs stay reviewable.
  const exportRoot = resolve(root, 'archive', 'retired-exports')
  mkdirSync(exportRoot, { recursive: true })
  const tree = mkdtempSync(join(exportRoot, 'release-build-'))
  const record = { version, source, exportedTree: tree, artifactDirectory: join(tree, 'release') }
  writeFileSync(join(out, 'inputs.json'), `${JSON.stringify(record, null, 2)}\n`)
  try {
    exporter ??= (await import('./export-public.mjs')).exportPublic
    const exported = exporter(source, tree, { cwd: root, log: line => appendFileSync(join(out, 'export.log'), `${line}\n`) })
    record.sourceCommit = exported.commit
    record.scanHits = exported.hits // The public-content scanner has its own release gate.
    assertExportIsolation(tree)
    writeFileSync(join(out, 'export-isolation.json'), `${JSON.stringify({ forbiddenPaths: [], links: [], ...exported }, null, 2)}\n`)
    stampVersion(tree, version)
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const isolation = prepareExportBuildIsolation(tree, npm)
    run(tree, out, 'npm-ci', [npm, 'ci', '--no-audit', '--no-fund'], isolation.env)
    record.buildCommit = buildCommitLabel(exported.commit)
    run(tree, out, 'build', [npm, 'run', 'build', '--', '--config', isolation.viteConfig],
      { ...isolation.env, ...releaseBuildEnv(exported.commit) })
    record.examples = shippedExamples(tree)
    run(tree, out, 'package', [join(tree, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', 'portable', '--x64', '-c.forceCodeSigning=false'], isolation.env)
    const resources = join(tree, 'release/win-unpacked/resources')
    const listing = []
    const visit = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) visit(join(directory, entry.name), `${name}/`)
      else listing.push({ name, size: statSync(join(directory, entry.name)).size })
    })
    visit(resources)
    writeFileSync(join(out, 'resources.json'), `${JSON.stringify(listing, null, 2)}\n`)
    for (const name of LEGAL) if (!existsSync(join(resources, name))) throw new Error(`Missing packaged legal resource: ${name}`)
    record.artifacts = describeArtifacts(record.artifactDirectory, version)
    record.smoke = await smoke({ appPath: join(tree, 'release/win-unpacked/LienCAM.exe'), outDir: join(out, 'smoke'), version,
      commit: record.buildCommit, examples: record.examples, harnessRoot: root })
    const problems = smokeProblems(record.smoke, { version, commit: record.buildCommit, examples: record.examples })
    if (problems.length) throw new Error(`Packaged smoke did not confirm the release stamp: ${problems.join('; ')}`)
    record.verdict = 'PASS'
    writeFileSync(join(out, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
    return record
  } catch (error) {
    writeFileSync(join(out, 'failure.json'), `${JSON.stringify({ ...record, verdict: 'FAIL', reason: error.message }, null, 2)}\n`)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--source': 'source', '--version': 'version', '--out': 'outDir' }[args[i]]
    if (!key || !args[i + 1]) throw new Error('Usage: build-from-export.mjs [--source commit] [--version version] [--out empty-directory]')
    options[key] = args[i + 1]
  }
  try { console.log(JSON.stringify(await buildFromExport(options), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
