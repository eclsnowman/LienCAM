import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// Each picture's provenance commit must contain the change it has to show:
// W5-3/W5-4 the holding method example 08 ships with, W7-1 the alpha Form
// palette without "Pull to body" (WO-2504). A reshoot from an older tree fails.
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const isAncestor = (older: string, newer: string) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' }); return true } catch { return false }
}
// Commits that touched a shipped example only to re-stamp it (toolpath moves byte-identical, so no picture of it changes).
// WO-2975 1935f923b0: gear pair re-saved under camgen-v4 stamps, compute times and thumbnail only.
const STAMP_ONLY = new Set(['1935f923b0f6dd05c99e3129cfa2a4b4c9ec7c0f'])
const lastTouch = (path: string) => git('log', '--format=%H', '--', path).split('\n').find(sha => sha && !STAMP_ONLY.has(sha)) ?? ''
const wo2504 = git('log', '-1', '--format=%H', '--grep=WO-2504 Hide Pull to body')

const shots = [
  { id: 'W5-3', needs: () => lastTouch('examples/08-gear-pair/gear-pair.camproject') },
  { id: 'W5-4', needs: () => lastTouch('examples/08-gear-pair/gear-pair.camproject') },
  { id: 'W7-1', needs: () => wo2504 },
]

describe('walkthrough pictures show the shipped examples (WO-2542)', () => {
  for (const { id, needs } of shots) {
    it(`${id} was shot at or after the change it must show`, () => {
      const prov = JSON.parse(readFileSync(`docs/media/walkthroughs/${id}.json`, 'utf8')).shots[`${id}.png`]
      expect(needs()).toBeTruthy()
      expect(isAncestor(needs(), prov.commit)).toBe(true)
    })
    it(`${id} wiki copy is the provenanced picture`, () => {
      const prov = JSON.parse(readFileSync(`docs/media/walkthroughs/${id}.json`, 'utf8')).shots[`${id}.png`]
      for (const p of [`docs/media/walkthroughs/${id}.png`, `docs/wiki/images/walkthroughs/${id}.png`])
        expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(prov.screenshotSha256)
    })
  }
})
