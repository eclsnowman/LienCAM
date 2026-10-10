// WO-2003: every setup of Example Projects/Full Suite.camproject must
// pass the Post tool-number check (no TOOL_NUMBER_MISSING / _DUPLICATE).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { validateToolNumbers } from '../../lib/post/validate'
import type { Project } from '../../types'

const FILE = path.resolve(__dirname, '../../../Example Projects/Full Suite.camproject')
const project = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Project

describe('Full Suite.camproject tool numbers (WO-2003)', () => {
  it('every tool in the library has a unique numeric toolNumber', () => {
    const nums = project.toolLibrary.map((t) => t.toolNumber)
    expect(nums.every((n) => typeof n === 'number')).toBe(true)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it.each(project.setups.map((s) => [s.name, s] as const))(
    'setup %s posts with no tool-number diagnostics',
    (_name, setup) => {
      const input = buildPostInput(project, setup)
      expect(validateToolNumbers(input.setup.operations)).toEqual([])
    },
  )
})
