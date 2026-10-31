import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface PublicList { kept: string[]; excluded: { path: string; reasons: string[] }[] }
const ROOT = process.cwd()
const EVIDENCE = resolve(ROOT, 'src/tests/evidence/WO-2462')
const directories: string[] = []
// Independent expectations: adding another exception or changing its reason
// must be reviewed here as well as in the release selector.
const expectedReasons: Record<string, string> = {
  'src/tests/adaptive-clearing/engine/_bytestab-fingerprint.test.ts':
    'platform-only: ARM floating-point divergence changes nine adaptive fixture hashes and pass counts.',
  'src/tests/adaptive-clearing/engine/b8-routearound-stage3.test.ts':
    'platform-only: ARM floating-point divergence changes the stage-three route-around hash.',
  'src/tests/adaptive-clearing/engine/conventional-direction.test.ts':
    'platform-only: ARM conventional cut stream takes one fewer cut; material-side split is 0.015756 against a 0.01 bound.',
  'src/tests/adaptive-clearing/engine/goodspec-tripwires.test.ts':
    'platform-only: ARM floating-point divergence changes adaptive lift/cut counts by one or two.',
  'src/tests/adaptive-clearing/engine/loopback-fillet.test.ts':
    'platform-only: ARM floating-point divergence changes Barbell pct25 traverses from 44 to 51.',
  'src/tests/adaptive-clearing/engine/process-feature.test.ts':
    'platform-only: ARM floating-point divergence changes one island keep-out link.',
  'src/tests/machine/bridgeFirstRun.wo1183.test.ts':
    'platform-only: first-run bridge fixtures require the Windows .NET Framework C# compiler and Windows executable hosting.',
  'src/tests/machine/rehearsalProfileIsolated.wo2030.test.ts':
    'desktop runtime: profile-isolation journey requires an Electron binary and a built desktop renderer, not just public source inputs.',
}
const face = 'src/tests/components/faceCreateOnFreshProject.wo2333.test.tsx'
const selector = pathToFileURL(join(ROOT, 'tools/release/public-tests.mjs')).href

function publicList(root: string, manifest: object): PublicList & { summary: string } {
  // Use the production native ESM loading route, as public CI does.
  const script = `import {buildPublicTestList,printPublicTestSummary} from ${JSON.stringify(selector)};
    const list=buildPublicTestList(${JSON.stringify(root)},${JSON.stringify(manifest)});
    printPublicTestSummary(list, summary => list.summary=summary);
    console.log(JSON.stringify(list));`
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  }))
}

function temporaryDirectory(label: string) {
  mkdirSync(EVIDENCE, { recursive: true })
  const directory = mkdtempSync(join(EVIDENCE, `${label}-`))
  directories.push(directory)
  return directory
}

function write(root: string, path: string, content = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    // Only disposable fixture folders created above; never a worktree or install.
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('WO-2462 public platform test list', () => {
  it('excludes exactly eight named files with individual reasons while keeping Face and neighboring tests', () => {
    const root = temporaryDirectory('selection')
    const neighbors = Object.keys(expectedReasons).map(path => path.replace('.test.ts', '.neighbor.test.ts'))
    for (const path of [...Object.keys(expectedReasons), ...neighbors, face]) write(root, path)
    // An importer must stay eligible: exceptions apply to the test file itself,
    // not the entire graph of tests sharing its helpers.
    write(root, 'src/tests/public.test.ts', "import './adaptive-clearing/engine/process-feature.test'")
    const manifest = { selection: [{ action: 'include', path: 'src/' }] }
    const list = publicList(root, manifest)
    expect(list.excluded).toEqual(Object.keys(expectedReasons).sort().map(path => ({ path, reasons: [expectedReasons[path]] })))
    expect(list.kept).toEqual([...neighbors, face, 'src/tests/public.test.ts'].sort())
    expect(list.summary).toContain('kept 10, left out 8')
    expect(list.summary).toContain('platform-only 7, desktop runtime 1')
  })

  it('preserves private-input reasons alongside the public-run exception', () => {
    const root = temporaryDirectory('privacy')
    const path = 'src/tests/adaptive-clearing/engine/process-feature.test.ts'
    write(root, path, "readFileSync('src/tests/evidence/private.json')")
    write(root, 'src/tests/private.test.ts', "readFileSync('src/tests/evidence/private.json')")
    const list = publicList(root, { selection: [{ action: 'include', path: 'src/' }] })
    expect(list.kept).toEqual([])
    expect(list.excluded).toHaveLength(2)
    expect(list.excluded[0].reasons).toContain(expectedReasons[path])
    expect(list.excluded.every(entry => entry.reasons.some(reason => reason.startsWith('evidence read')))).toBe(true)
  })

  it('removes only the eight candidates from the real repository list', () => {
    const root = temporaryDirectory('control')
    const source = readFileSync(join(ROOT, 'tools/release/public-tests.mjs'), 'utf8')
    const condition = '    if (Object.hasOwn(publicRunExceptions, test)) reasons.add(publicRunExceptions[test])'
    expect(source).toContain(condition)
    // Remove just the exception application; privacy/dependency logic is identical.
    const original = join(root, 'selector-before.mjs')
    // WO-2488/2537 added distinct main-red and private-only exceptions.
    // This control removes only WO-2462's eight platform/runtime exceptions.
    // The copied selector lives outside tools/release, so its relative is-main import is made absolute.
    const isMain = JSON.stringify(pathToFileURL(join(ROOT, 'tools/lib/is-main.mjs')).href)
    writeFileSync(original, source.replace(/['"]\.\.\/lib\/is-main\.mjs['"]/g, isMain).replace(condition,
      `    if (!Object.hasOwn(${JSON.stringify(expectedReasons)}, test) && Object.hasOwn(publicRunExceptions, test)) reasons.add(publicRunExceptions[test])`))
    const script = `import {buildPublicTestList as before} from ${JSON.stringify(pathToFileURL(original).href)};
      import {buildPublicTestList as after} from './tools/release/public-tests.mjs';
      console.log(JSON.stringify({before:before(), after:after()}));`
    const lists: { before: PublicList; after: PublicList } = JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }))
    const removed = lists.before.kept.filter(path => !lists.after.kept.includes(path))
    // WO-3266: a candidate that is already excluded as private (the goodspec
    // tripwire now imports a private host-independent helper) cannot be "newly
    // removed" by the platform exceptions.
    expect(Object.keys(expectedReasons)).toHaveLength(8)
    const alreadyPrivate = new Set(lists.before.excluded.map(entry => entry.path))
    expect(removed).toEqual(Object.keys(expectedReasons).filter(path => !alreadyPrivate.has(path)).sort())
    expect(lists.after.kept.filter(path => !lists.before.kept.includes(path))).toEqual([])
    const candidates = new Set(Object.keys(expectedReasons))
    expect(lists.after.excluded.filter(entry => !candidates.has(entry.path)))
      .toEqual(lists.before.excluded.filter(entry => !candidates.has(entry.path)))
    // A candidate that was already private keeps its privacy reasons and gains the
    // platform one; it is simply not part of the newly removed set.
    for (const path of Object.keys(expectedReasons).filter(path => alreadyPrivate.has(path))) {
      expect(lists.after.excluded.find(entry => entry.path === path)?.reasons).toContain(expectedReasons[path])
    }
    for (const path of removed) expect(lists.after.excluded.find(entry => entry.path === path)?.reasons).toEqual([expectedReasons[path]])
    expect(lists.after.kept).toContain(face)
  }, 120_000)

  it('imports the Face journey using only exported e2e files without launching Electron', () => {
    const root = temporaryDirectory('public-e2e')
    const script = `import {cpSync,readFileSync} from 'node:fs';
      import {join,relative} from 'node:path'; import {pathToFileURL} from 'node:url';
      import {selectedForExport} from ${JSON.stringify(selector)};
      const repo=${JSON.stringify(ROOT)}, root=${JSON.stringify(root)};
      const manifest=JSON.parse(readFileSync(join(repo,'tools/release/manifest.json'),'utf8'));
      if (!selectedForExport('e2e/fresh-pc-journey.mjs',manifest)) throw new Error('Face journey not exported');
      cpSync(join(repo,'e2e'),join(root,'e2e'),{recursive:true,
        filter:source=>selectedForExport(relative(repo,source).replaceAll('\\\\','/'),manifest)});
      const {automaticFaceOperations}=await import(pathToFileURL(join(root,'e2e/fresh-pc-journey.mjs')));
      const {OPERATIONS}=await import(pathToFileURL(join(root,'e2e/steps/cam-steps.mjs')));
      console.log(JSON.stringify({operations:automaticFaceOperations(OPERATIONS), original:OPERATIONS}));`
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    }))
    expect(result.operations[0]).toEqual({ name: 'Journey Face', type: '2D Face', tool: 'Journey 6mm end mill' })
    expect(result.operations.slice(1)).toEqual(result.original.slice(1))
    expect(result.original[0].face).toEqual({ targetWcs: -1 })
  })
})
