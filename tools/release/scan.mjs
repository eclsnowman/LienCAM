#!/usr/bin/env node

import { isMain } from '../lib/is-main.mjs';
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MANIFEST_PATH = fileURLToPath(new URL('./manifest.json', import.meta.url))

const COMMERCIAL_PATTERN = /\b(?:Mastercam|MeshCAM|Onshape|SolidWorks|Vectric|Aspire|Carveco|Esprit|Easel|PathPilot|Tormach|Estlcam|ArtCAM|PowerMill|HSMWorks|Autodesk|Fusion\s+360|Mach3|Mach4|Masso|Centroid\s+(?:Acorn|CNC12)|CNC12|Carbide\s+Create)\b/gi
const COMMERCIAL_RULES = new Map([
  ['mastercam', 'mastercam'], ['meshcam', 'meshcam'], ['onshape', 'onshape'],
  ['solidworks', 'solidworks'], ['vectric', 'vectric'], ['aspire', 'aspire'],
  ['carveco', 'carveco'], ['esprit', 'esprit'], ['easel', 'easel'],
  ['pathpilot', 'pathpilot'], ['tormach', 'tormach'], ['estlcam', 'estlcam'],
  ['artcam', 'artcam'], ['powermill', 'powermill'], ['hsmworks', 'hsmworks'],
  ['autodesk', 'autodesk'], ['fusion 360', 'fusion-360'], ['mach3', 'mach3'],
  ['mach4', 'mach4'], ['masso', 'masso'], ['centroid acorn', 'centroid-acorn'],
  ['centroid cnc12', 'centroid-cnc12'], ['cnc12', 'centroid-cnc12'],
  ['carbide create', 'carbide-create'],
])

const PERSONAL_RULES = [
  ['personal:eric', /\bEric\b/gi, 'personal owner name'],
  ['personal:lien', /\bLien\b/gi, 'personal surname'],
  ['personal:eclsnowman', /\beclsnowman\b/gi, 'personal account name'],
  ['personal:eclien', /\beclien\b/gi, 'personal account name'],
  ['personal:c-users-path', /\bC:[\\/]+Users[\\/]+/gi, 'local C: user path'],
  ['personal:d-dev-path', /\bD:[\\/]+dev(?:[\\/]+|$)/gi, 'local D: development path'],
  ['personal:msys-d-dev-path', /\/d\/dev(?:\/|$)/gi, 'local MSYS development path'],
  ['personal:liencnc2', /\bLienCNC2\b/gi, 'private machine hostname'],
]

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[A-Z0-9_./+=-]{8,}/gi
const SECRET_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Z0-9_]{20,}|github_pat_[A-Z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Z0-9_-]{20,}|xox[baprs]-[A-Z0-9-]{10,})\b/gi

function normalizePath(path) {
  return path.split(sep).join('/')
}

function manifestFromDisk() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

function isAllowedEmailDomain(domain, entries) {
  const normalized = domain.toLowerCase()
  return entries.some(({ value }) => {
    const allowed = value.toLowerCase()
    return allowed.startsWith('.')
      ? normalized.endsWith(allowed)
      : normalized === allowed || normalized.endsWith(`.${allowed}`)
  })
}

function isPrivateIpv4(value) {
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => octet < 0 || octet > 255)) return false
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

function matchesException(hit, exceptions) {
  return exceptions.some(exception => {
    if (exception.rule !== hit.rule && exception.rule !== '*') return false
    const exceptionPath = exception.path.replaceAll('\\', '/')
    return exceptionPath.endsWith('/')
      ? hit.file.startsWith(exceptionPath)
      : hit.file === exceptionPath
  })
}

function addPatternHits(hits, file, lineNumber, line, rules) {
  for (const [rule, pattern, description] of rules) {
    pattern.lastIndex = 0
    for (const _match of line.matchAll(pattern)) {
      hits.push({ file, line: lineNumber, rule, detail: `forbidden ${description}` })
    }
  }
}

function scanText(hits, file, text, scanAllowlist) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    COMMERCIAL_PATTERN.lastIndex = 0
    for (const match of line.matchAll(COMMERCIAL_PATTERN)) {
      const name = match[0].replace(/\s+/g, ' ')
      const ruleName = COMMERCIAL_RULES.get(name.toLowerCase())
      hits.push({ file, line: lineNumber, rule: `commercial:${ruleName}`, detail: `forbidden ${name}` })
    }
    addPatternHits(hits, file, lineNumber, line, PERSONAL_RULES)

    EMAIL_PATTERN.lastIndex = 0
    for (const match of line.matchAll(EMAIL_PATTERN)) {
      if (!isAllowedEmailDomain(match[1], scanAllowlist.allowedEmailDomains)) {
        hits.push({ file, line: lineNumber, rule: 'personal:email', detail: 'non-example email address' })
      }
    }

    IPV4_PATTERN.lastIndex = 0
    for (const match of line.matchAll(IPV4_PATTERN)) {
      if (isPrivateIpv4(match[0])) {
        hits.push({ file, line: lineNumber, rule: 'personal:rfc1918-ip', detail: 'private RFC1918 IP address' })
      }
    }

    SECRET_ASSIGNMENT_PATTERN.lastIndex = 0
    for (const _match of line.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
      hits.push({ file, line: lineNumber, rule: 'secret:assignment', detail: 'credential-like assignment' })
    }
    SECRET_TOKEN_PATTERN.lastIndex = 0
    for (const _match of line.matchAll(SECRET_TOKEN_PATTERN)) {
      hits.push({ file, line: lineNumber, rule: 'secret:token', detail: 'credential token pattern' })
    }
  }
}

function sampleContainsNull(path, size) {
  if (size === 0) return false
  const descriptor = openSync(path, 'r')
  try {
    const sample = Buffer.alloc(Math.min(size, 8192))
    const bytesRead = readSync(descriptor, sample, 0, sample.length, 0)
    return sample.subarray(0, bytesRead).includes(0)
  } finally {
    closeSync(descriptor)
  }
}

function collectFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name)
      const relativePath = normalizePath(relative(root, absolutePath))
      if (entry.isDirectory()) visit(absolutePath)
      else files.push({ absolutePath, relativePath })
    }
  }
  visit(root)
  return files
}

export function scanDirectory(directory, manifest = manifestFromDisk()) {
  const root = resolve(directory)
  const scanAllowlist = manifest.scan
  if (!scanAllowlist || !Array.isArray(scanAllowlist.allowedBinaryExtensions)
      || !Array.isArray(scanAllowlist.allowedEmailDomains)
      || !Array.isArray(scanAllowlist.ruleExceptions)) {
    throw new Error('release manifest scan allowlists are incomplete')
  }

  const allowedBinaryExtensions = new Set(
    scanAllowlist.allowedBinaryExtensions.map(({ value }) => value.toLowerCase()),
  )
  const hits = []
  const files = collectFiles(root)

  for (const { absolutePath, relativePath } of files) {
    const stat = lstatSync(absolutePath)
    scanText(hits, relativePath, relativePath, scanAllowlist)

    if (stat.isSymbolicLink()) {
      hits.push({ file: relativePath, line: 1, rule: 'binary-type', detail: 'symbolic links are not allowlisted' })
      continue
    }
    if (!stat.isFile()) {
      hits.push({ file: relativePath, line: 1, rule: 'binary-type', detail: 'non-regular files are not allowlisted' })
      continue
    }
    if (stat.size > MAX_FILE_BYTES) {
      hits.push({ file: relativePath, line: 1, rule: 'file-too-large', detail: `file is ${stat.size} bytes; limit is ${MAX_FILE_BYTES}` })
    }

    const isBinary = sampleContainsNull(absolutePath, stat.size)
    if (isBinary) {
      if (!allowedBinaryExtensions.has(extname(relativePath).toLowerCase())) {
        hits.push({ file: relativePath, line: 1, rule: 'binary-type', detail: 'binary extension is not allowlisted' })
      }
      continue
    }
    if (stat.size <= MAX_FILE_BYTES) {
      scanText(hits, relativePath, readFileSync(absolutePath, 'utf8'), scanAllowlist)
    }
  }

  const filteredHits = hits.filter(hit => !matchesException(hit, scanAllowlist.ruleExceptions))
  return { files: files.length, hits: filteredHits }
}

export function printScanReport(report, log = console.log) {
  for (const hit of report.hits) {
    log(`${hit.file}:${hit.line} [${hit.rule}] ${hit.detail}`)
  }
  if (report.hits.length === 0) {
    log(`scan: clean - ${report.files} ${report.files === 1 ? 'file' : 'files'}`)
    return
  }

  const counts = new Map()
  for (const { rule } of report.hits) counts.set(rule, (counts.get(rule) ?? 0) + 1)
  log(`scan: ${report.hits.length} ${report.hits.length === 1 ? 'hit' : 'hits'} in ${report.files} files`)
  for (const [rule, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    log(`scan: ${rule} = ${count}`)
  }
}

function isMainModule() {
  return isMain(import.meta.url)
}

if (isMainModule()) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node tools/release/scan.mjs <dir>')
    const report = scanDirectory(process.argv[2])
    printScanReport(report)
    if (report.hits.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(`scan: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
