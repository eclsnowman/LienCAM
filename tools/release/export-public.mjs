#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { printScanReport, scanDirectory } from './scan.mjs'
import { buildPublicTestList, incompleteTestImports, printPublicTestSummary } from './public-tests.mjs'

const MANIFEST_REPOSITORY_PATH = 'tools/release/manifest.json'

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  }).trim()
}

function assertReasonedEntry(entry, label) {
  if (!entry || typeof entry.reason !== 'string' || entry.reason.trim() === '' || /[\r\n]/.test(entry.reason)) {
    throw new Error(`${label} needs a one-line reason`)
  }
}

function validateManifest(manifest) {
  if (manifest?.version !== 1) throw new Error('release manifest version must be 1')
  if (!Array.isArray(manifest.selection) || manifest.selection.length === 0) {
    throw new Error('release manifest selection must be a non-empty array')
  }
  for (const [index, entry] of manifest.selection.entries()) {
    assertReasonedEntry(entry, `selection entry ${index + 1}`)
    if (entry.action !== 'include' && entry.action !== 'exclude') {
      throw new Error(`selection entry ${index + 1} has an invalid action`)
    }
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.includes('\\')
        || entry.path.startsWith('/') || entry.path.includes(':')
        || entry.path.split('/').includes('..') || entry.path === '.git' || entry.path.startsWith('.git/')) {
      throw new Error(`selection entry ${index + 1} has an unsafe repository path`)
    }
    if (entry.destination !== undefined) {
      if (entry.action !== 'include' || typeof entry.destination !== 'string'
          || entry.destination === '' || entry.destination.includes('\\')
          || entry.destination.startsWith('/') || entry.destination.includes(':')
          || entry.destination.replace(/\/$/, '').split('/').some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
        throw new Error(`selection entry ${index + 1} has an unsafe export destination`)
      }
    }
  }

  if (!manifest.scan || typeof manifest.scan !== 'object') {
    throw new Error('release manifest scan allowlists are missing')
  }
  for (const name of ['allowedNames', 'allowedEmailDomains', 'allowedBinaryExtensions', 'ruleExceptions']) {
    const entries = manifest.scan[name]
    if (!Array.isArray(entries)) throw new Error(`release manifest scan.${name} must be an array`)
    for (const [index, entry] of entries.entries()) {
      assertReasonedEntry(entry, `scan.${name} entry ${index + 1}`)
    }
  }
  for (const [index, entry] of (manifest.prohibitedContent ?? []).entries()) {
    assertReasonedEntry(entry, `prohibitedContent entry ${index + 1}`)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`prohibitedContent entry ${index + 1} needs a SHA-256 digest`)
    }
  }
  return manifest
}

function pathContains(parent, child) {
  const parentPath = parent.endsWith('/') ? parent : `${parent}/`
  return child === parent || child.startsWith(parentPath)
}

function archiveSelection(root, commit, outputDirectory, selection) {
  const scratch = mkdtempSync(join(outputDirectory, '.liencam-public-export-'))
  try {
    for (let index = 0; index < selection.length; index += 1) {
      const entry = selection[index]
      if (entry.action !== 'include') continue

      const archivePath = join(scratch, `selection-${index}.tar`)
      const argumentsForGit = [
        'archive',
        '--format=tar',
        `--output=${archivePath}`,
        commit,
        '--',
        `:(top,literal)${entry.path.replace(/\/$/, '')}`,
      ]
      for (const laterEntry of selection.slice(index + 1)) {
        if (laterEntry.action === 'exclude' && pathContains(entry.path, laterEntry.path)) {
          argumentsForGit.push(`:(exclude,top,literal)${laterEntry.path.replace(/\/$/, '')}`)
        }
      }

      execFileSync('git', argumentsForGit, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      // Stage mapped entries separately so their private source path never enters
      // the public tree. Keep git archive's committed bytes and ordered excludes.
      const extractionDirectory = entry.destination === undefined
        ? outputDirectory : join(scratch, `mapped-${index}`)
      mkdirSync(extractionDirectory, { recursive: true })
      const archiveArgument = relative(extractionDirectory, archivePath).replaceAll('\\', '/')
      execFileSync('tar', ['-xf', archiveArgument], {
        cwd: extractionDirectory,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (entry.destination !== undefined) {
        const destination = join(outputDirectory, entry.destination)
        mkdirSync(dirname(destination), { recursive: true })
        cpSync(join(extractionDirectory, entry.path), destination, { recursive: true })
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function exportedSize(directory) {
  let files = 0
  let bytes = 0
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else {
        files += 1
        bytes += lstatSync(path).size
      }
    }
  }
  visit(directory)
  return { files, bytes }
}

// Probe only the exported ignore rules, never the operator's global excludes.
// Exact exceptions preserve shipped fixtures without admitting build output.
function preserveShippedFiles(directory) {
  const ignore = join(directory, '.gitignore')
  if (!existsSync(ignore)) return
  const paths = []
  const directories = []
  const collect = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        directories.push(relative(directory, path).replaceAll('\\', '/') + '/')
        collect(path)
      }
      else paths.push(relative(directory, path).replaceAll('\\', '/'))
    }
  }
  collect(directory)
  const scratch = mkdtempSync(join(directory, '.liencam-ignore-probe-'))
  try {
    execFileSync('git', ['init', '--bare', '--quiet', scratch], { windowsHide: true })
    const args = ['-c', 'core.bare=false', '-c', 'core.excludesFile=', `--git-dir=${scratch}`,
      `--work-tree=${directory}`, 'check-ignore', '--no-index', '-z', '--stdin']
    let ignored
    try {
      ignored = execFileSync('git', args, { cwd: directory, input: [...paths, ...directories].join('\0') + '\0', encoding: 'utf8', windowsHide: true })
    } catch (error) {
      if (error.status !== 1) throw error
      ignored = '' // check-ignore returns 1 when nothing matches.
    }
    const exceptions = new Set()
    const ignoredPaths = new Set(ignored.split('\0').filter(Boolean))
    const escape = path => path.replace(/[\\*?\[\]!# ]/g, '\\$&')
    for (const path of paths.filter(path => ignoredPaths.has(path)).sort()) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        const parent = parts.slice(0, index).join('/')
        exceptions.add(`!/${escape(parent)}/`)
        // Opening an ignored directory would otherwise expose local siblings.
        if (ignoredPaths.has(parent + '/')) exceptions.add(`/${escape(parent)}/*`)
      }
      exceptions.add(`!/${escape(path)}`)
    }
    if (exceptions.size) writeFileSync(ignore, `${readFileSync(ignore, 'utf8').trimEnd()}\n\n# WO-2629: retain every file shipped by this export.\n${[...exceptions].join('\n')}\n`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// WO-2537: path exclusions alone cannot protect redistribution rights when a
// fixture is copied or renamed. Check committed exported bytes at every path.
export function assertExportRights(directory, manifest) {
  const prohibited = new Map((manifest.prohibitedContent ?? []).map(entry => [entry.sha256, entry.reason]))
  if (prohibited.size === 0) return
  const violations = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else {
        const reason = prohibited.get(createHash('sha256').update(readFileSync(path)).digest('hex'))
        if (reason) violations.push(`${relative(directory, path).replaceAll('\\', '/')}: ${reason}`)
      }
    }
  }
  visit(directory)
  if (violations.length) throw new Error(`export contains non-redistributable content:\n${violations.join('\n')}`)
}

// npm installs node_modules later. Repository file commands, however, must
// already have their target in the published tree; keep the private package intact.
function pruneMissingNodeScripts(directory, log) {
  const packagePath = join(directory, 'package.json')
  if (!existsSync(packagePath)) return
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  let changed = false
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    const tokens = script.match(/"[^"]*"|'[^']*'|&&|\|\||[;|]|[^\s;&|]+/g) ?? []
    const unquote = token => token.replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single)
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== 'node') continue
      let target
      for (index += 1; index < tokens.length && !/^(?:&&|\|\||[;|])$/.test(tokens[index]); index += 1) {
        const token = unquote(tokens[index])
        if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(token)) break
        if (['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions'].includes(token)) { index += 1; continue }
        if (token.startsWith('-')) continue
        target = token
        break
      }
      if (!target) continue
      const path = resolve(directory, target)
      const local = relative(directory, path).replaceAll('\\', '/')
      if (local.startsWith('node_modules/')) continue
      if (local.startsWith('../') || !existsSync(path) || !lstatSync(path).isFile()) {
        delete pkg.scripts[name]
        changed = true
        log(`DROP script ${name}: Node target ${target} is not exported`)
        break
      }
    }
  }
  if (changed) writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
}

export function exportPublic(commitish, outputPath, { cwd = process.cwd(), log = console.log } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const commit = git(root, ['rev-parse', '--verify', `${commitish}^{commit}`])
  const outputDirectory = resolve(cwd, outputPath)

  if (!existsSync(outputDirectory) || !lstatSync(outputDirectory).isDirectory()) {
    throw new Error('output directory must already exist and be empty')
  }
  if (readdirSync(outputDirectory).length !== 0) {
    throw new Error('output directory must be empty')
  }

  const manifestText = git(root, ['show', `${commit}:${MANIFEST_REPOSITORY_PATH}`])
  const manifest = validateManifest(JSON.parse(manifestText))
  archiveSelection(root, commit, outputDirectory, manifest.selection)
  assertExportRights(outputDirectory, manifest)

  const omitted = incompleteTestImports(outputDirectory)
  for (const entry of omitted) {
    rmSync(join(outputDirectory, entry.path))
    const reason = `WO-2629: incomplete exported import closure: ${entry.reasons.join('; ')}`
    manifest.selection.push({ action: 'exclude', path: entry.path, reason })
    log(`OMIT ${entry.path}: ${reason}`)
  }
  if (omitted.length && existsSync(join(outputDirectory, MANIFEST_REPOSITORY_PATH))) {
    writeFileSync(join(outputDirectory, MANIFEST_REPOSITORY_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  preserveShippedFiles(outputDirectory)
  pruneMissingNodeScripts(outputDirectory, log)

  // Surface omitted test inputs during export, before a public CI run. The
  // selector traverses helper imports too and names the excluded import route.
  const tests = buildPublicTestList(outputDirectory, manifest)
  printPublicTestSummary(tests, log)
  for (const entry of tests.excluded) {
    log(`DROP ${entry.path}: ${entry.reasons.join('; ')}`)
  }

  const size = exportedSize(outputDirectory)
  log(`export: ${size.files} ${size.files === 1 ? 'file' : 'files'}, ${size.bytes} bytes from ${commit}`)
  const report = scanDirectory(outputDirectory, manifest)
  printScanReport(report, log)
  return { ...size, commit, hits: report.hits.length }
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  try {
    if (process.argv.length !== 4) {
      throw new Error('usage: node tools/release/export-public.mjs <sha> <out-dir>')
    }
    const result = exportPublic(process.argv[2], process.argv[3])
    if (result.hits > 0) process.exitCode = 1
  } catch (error) {
    console.error(`export: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
