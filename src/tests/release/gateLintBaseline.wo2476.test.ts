import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const gate = pathToFileURL(join(root, 'tools/test-gate.mjs')).href
const eslint = join(root, 'node_modules/eslint/bin/eslint.js')
const cacheFor = (cwd: string) => join(tmpdir(), `liencam-gate-eslint-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`)
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
const duplicate = 'switch (value) { case 1: break; case 1: break }\n'
const clean = 'export const value = 1\n'
const fatalMessage = 'No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present'

function fixture(files: Record<string, string>, parser = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'wo2476-lint-'))
  const config = `import { createRequire } from 'node:module';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const espree = createRequire(${JSON.stringify(eslint)})('espree');
const parser = { meta: { name: 'wo2476-environment-parser', version: '1' }, parse(text, options) {
  appendFileSync(join(process.cwd(), 'parser.log'), 'parse\\n');
  if (existsSync(join(process.cwd(), 'second-root/tsconfig.json'))) throw new Error(${JSON.stringify(fatalMessage)});
  return espree.parse(text, options);
}};
export default [{ files: ['src/**/*.js'], ${parser ? 'languageOptions: { parser },' : ''} rules: { 'no-duplicate-case': 'error' } },
{ files: ['src/nested/*.js'], rules: { 'no-alert': 'error' } }];\n`
  writeFileSync(join(cwd, 'eslint.config.mjs'), config)
  for (const [file, text] of Object.entries(files)) put(cwd, file, text)
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'wo2476@example.invalid'])
  git(cwd, ['config', 'user.name', 'WO-2476'])
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'main fixture'])
  git(cwd, ['checkout', '-b', 'work'])
  return cwd
}

function put(cwd: string, file: string, source: string) {
  mkdirSync(resolve(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), source)
}

function dispose(cwd: string) {
  // These are freshly initialized fixture repos, never worktrees or linked installs.
  expect(cwd.startsWith(join(tmpdir(), 'wo2476-lint-'))).toBe(true)
  rmSync(cwd, { recursive: true, force: true })
  rmSync(cacheFor(cwd), { force: true })
}

type Measurement = { result: { green: boolean; reason: string }; elapsedMs: number; baselineSpawns: number; wholeSpawns: number; gitCommands: string[][] }

function run(cwd: string): Measurement {
  // Observe real child launches, not an injected lint implementation. Limit the
  // old per-file route to two launches so a negative control cannot take hours.
  const script = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
let baselineSpawns = 0, wholeSpawns = 0; const gitCommands = [];
cp.spawnSync = function(command, args, options) {
  if (command === 'git') gitCommands.push(args);
  if (command === process.execPath) {
    if (args.includes('--stdin') || args.includes('--input-type=module')) {
      baselineSpawns++;
      if (baselineSpawns > 1) return { status: 2, stdout: '', stderr: 'baseline spawn ceiling exceeded' };
    } else if (args.includes('--format')) wholeSpawns++;
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
const tool = await import(${JSON.stringify(gate)});
const start = Date.now(); const result = tool.runWholeTreeLint();
console.log(JSON.stringify({ result, elapsedMs: Date.now() - start, baselineSpawns, wholeSpawns, gitCommands }));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, encoding: 'utf8', timeout: 90_000, windowsHide: true,
    env: { ...process.env, LIENCAM_TEST_ROOT: cwd, LIENCAM_MAIN_COMMIT: 'main', LIENCAM_ESLINT_PATH: eslint },
  })
  expect(child.status, child.error?.message || child.stderr).toBe(0)
  const measured = JSON.parse(child.stdout) as Measurement
  console.info('WO-2476 measurement:', JSON.stringify({ ...measured, gitCommands: undefined }))
  return measured
}

describe('WO-2476 one-process lint baseline and fatal cache recovery', () => {
  it('baselines 128 error files in one ESLint process and one Git blob batch', () => {
    const files = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`src/error ${i}.js`, duplicate + '// caf\u00e9\n']))
    const cwd = fixture(files)
    try {
      const measured = run(cwd)
      expect(measured.result).toMatchObject({ green: true, reason: expect.stringContaining('128 error(s)') })
      expect(measured.baselineSpawns).toBe(1)
      expect(measured.wholeSpawns).toBe(1)
      expect(measured.gitCommands.filter(args => args[0] === 'cat-file')).toHaveLength(1)
      expect(measured.gitCommands.some(args => args[0] === 'show')).toBe(false)
      expect(measured.elapsedMs).toBeLessThan(60_000)
    } finally { dispose(cwd) }
  }, 120_000)

  it('subtracts per-file error multiplicity across shifted lines and identifies new files', () => {
    const cwd = fixture({ 'src/changed.js': duplicate, 'src/untouched.js': duplicate })
    try {
      put(cwd, 'src/changed.js', '\n\n' + 'switch (value) { case 1: break; case 1: break; case 1: break }\n')
      put(cwd, 'src/added.js', duplicate)
      const { result, baselineSpawns } = run(cwd)
      expect(result.green).toBe(false)
      expect(result.reason).toContain('2 new error(s) on this branch (2 already on main)')
      expect(result.reason).toContain('src/added.js:1:')
      expect(baselineSpawns).toBe(1)
    } finally { dispose(cwd) }
  }, 120_000)

  it('keeps original filenames and nested config context when linting main sources', () => {
    const cwd = fixture({ 'src/nested/old.js': 'alert(1)\n', 'src/plain.js': 'alert(1)\n' })
    try {
      // ESLint 10 discovers config per file. This nested config must also apply
      // to the baseline; an external temp mirror would lose its discovery route.
      put(cwd, 'src/nested/eslint.config.mjs', "export default [{ files: ['**/*.js'], rules: { 'no-alert': 'error' } }]\n")
      git(cwd, ['add', '.'])
      git(cwd, ['commit', '-m', 'nested policy fixture'])
      const { result } = run(cwd)
      expect(result).toMatchObject({ green: true, reason: expect.stringContaining('all already on main') })
      put(cwd, 'src/nested/new.js', 'alert(2)\n')
      expect(run(cwd).result).toMatchObject({ green: false, reason: expect.stringContaining('src/nested/new.js:1:') })
    } finally { dispose(cwd) }
  }, 120_000)

  it('summarizes one fatal parser cause across 128 files and does not retain it in cache', () => {
    const cwd = fixture(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`src/file-${i}.js`, clean])), true)
    try {
      put(cwd, 'second-root/tsconfig.json', '{}')
      const measured = run(cwd)
      expect(measured.result.green).toBe(true)
      expect(measured.result.reason).toContain('fatal parse error in 128 file(s)')
      expect(measured.result.reason).toContain(`${fatalMessage} (first: src/`)
      expect(measured.result.reason.split('\n')).toHaveLength(1)
      expect(measured.baselineSpawns).toBe(1)
      expect(measured.elapsedMs).toBeLessThan(60_000)
      expect(existsSync(cacheFor(cwd))).toBe(false)
    } finally { dispose(cwd) }
  }, 120_000)

  it('evicts a legacy cached fatal result after its environment cause disappears', () => {
    const cwd = fixture({ 'src/retry.js': clean }, true)
    try {
      put(cwd, 'second-root/tsconfig.json', '{}')
      const seed = spawnSync(process.execPath, [eslint, '--format', 'json', '--cache', '--cache-strategy', 'content', '--cache-location', cacheFor(cwd), '.'], {
        cwd, encoding: 'utf8', timeout: 90_000, windowsHide: true,
      })
      expect(seed.status, seed.stderr).toBe(1)
      expect(JSON.parse(seed.stdout).some((item: { messages: { fatal?: boolean }[] }) => item.messages.some(message => message.fatal))).toBe(true)
      expect(readFileSync(cacheFor(cwd), 'utf8')).toMatch(/"fatal"\s*:\s*true/)
      const parsedBefore = readFileSync(join(cwd, 'parser.log'), 'utf8').split('\n').length
      rmSync(join(cwd, 'second-root/tsconfig.json'))
      const measured = run(cwd)
      expect(measured.result).toMatchObject({ green: true, reason: expect.stringContaining('0 errors') })
      expect(measured.baselineSpawns).toBe(0)
      expect(readFileSync(join(cwd, 'parser.log'), 'utf8').split('\n').length).toBeGreaterThan(parsedBefore)
      const parsedWarm = readFileSync(join(cwd, 'parser.log'), 'utf8')
      expect(run(cwd).result.green).toBe(true)
      expect(readFileSync(join(cwd, 'parser.log'), 'utf8')).toBe(parsedWarm)
    } finally { dispose(cwd) }
  }, 120_000)

  it('requires no baseline child for clean trees or errors only in branch-added files', () => {
    const cwd = fixture({ 'src/clean.js': clean })
    try {
      expect(run(cwd)).toMatchObject({ result: { green: true }, baselineSpawns: 0, wholeSpawns: 1 })
      put(cwd, 'src/added.js', duplicate)
      expect(run(cwd)).toMatchObject({ result: { green: false, reason: expect.stringContaining('1 new error(s)') }, baselineSpawns: 0 })
    } finally { dispose(cwd) }
  }, 120_000)
})
