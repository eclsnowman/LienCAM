#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const defaultRemote = 'https://github.com/eclsnowman/LienCAM.wiki.git'
const name = 'LienCAM Project'
const email = 'liencam@users.noreply.github.com'

function validateSource(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error('Wiki source must be a directory')
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Git metadata would overwrite the fresh clone; links could copy private inputs.
    if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) {
      throw new Error(`Unsupported wiki input: ${entry.name}`)
    }
    if (entry.isDirectory()) validateSource(join(directory, entry.name))
    else if (!entry.isFile()) throw new Error(`Unsupported wiki input: ${entry.name}`)
  }
}

export function publishWiki({ source = join(root, 'docs/wiki'), remote = defaultRemote } = {}) {
  source = resolve(source)
  validateSource(source)
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
  }
  if (process.env.GITHUB_TOKEN && remote === defaultRemote) {
    // Keep credentials out of argv, .git/config and the remote URL.
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}`
  }
  const scratch = mkdtempSync(join(tmpdir(), 'liencam-wiki-publish-'))
  const clone = join(scratch, 'wiki')
  function git(args, cwd = clone) {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
    })
    if (result.error || result.status !== 0) {
      // Do not echo argv or remote diagnostics that might contain credentials.
      throw new Error(`Wiki git ${args[0]} failed (exit ${result.status ?? 'unavailable'})`)
    }
    return result.stdout.trim()
  }
  try {
    git(['clone', '--quiet', '--', remote, clone], scratch)
    const branch = git(['symbolic-ref', '--short', 'HEAD'])
    for (const entry of readdirSync(clone)) {
      if (entry !== '.git') rmSync(join(clone, entry), { recursive: true, force: true })
    }
    for (const entry of readdirSync(source)) {
      cpSync(join(source, entry), join(clone, entry), { recursive: true })
    }
    // Force includes image paths even if a copied .gitignore would exclude them.
    git(['add', '--all', '--force', '--', '.'])
    if (!git(['diff', '--cached', '--name-only'])) {
      console.log('Wiki unchanged; no commit or push.')
      return { changed: false }
    }
    git(['commit', '--quiet', '-m', 'Sync wiki from docs/wiki'])
    git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`])
    const commit = git(['rev-parse', 'HEAD'])
    console.log(`Wiki published: ${commit}`)
    return { changed: true, commit }
  } finally {
    // This path is our fresh temporary clone, never a project worktree.
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index += 2) {
      const key = { '--source': 'source', '--remote': 'remote' }[args[index]]
      if (!key || !args[index + 1]) throw new Error('Usage: wiki-publish.mjs [--source <directory>] [--remote <git URL or path>]')
      options[key] = args[index + 1]
    }
    publishWiki(options)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
