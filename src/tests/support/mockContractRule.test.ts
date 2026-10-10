import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOCK_CONTRACT_BASELINE } from './mockContractBaseline'
import { MOCK_CONTRACT_FINDINGS } from './mockContractFindings'

const baselineKeys = Object.keys(MOCK_CONTRACT_BASELINE).sort()
const findingKeys = MOCK_CONTRACT_FINDINGS.map(({ key }) => key).sort()

describe('WO-1052: every remaining mock-contract allowance is a named finding', () => {
  it('the baseline and finding key sets are identical in both directions', () => {
    expect(new Set(findingKeys).size).toBe(findingKeys.length)
    expect(findingKeys).toEqual(baselineKeys)
    expect(baselineKeys).toEqual(findingKeys)
  })

  it('every finding gives a grouped class, reason, and retirement seam', () => {
    for (const finding of MOCK_CONTRACT_FINDINGS) {
      expect(finding.class.trim(), `${finding.key}: class`).not.toBe('')
      expect(finding.reason.trim(), `${finding.key}: reason`).not.toBe('')
      expect(finding.seam.trim(), `${finding.key}: seam`).not.toBe('')
    }
  })

  it('the committed baseline has the recorder format and values', () => {
    const source = readFileSync(new URL('./mockContractBaseline.ts', import.meta.url), 'utf8')
    const recorded = Object.fromEntries(
      [...source.matchAll(/^ {2}'([^']+)': (\d+),$/gm)]
        .map((match) => [match[1], Number(match[2])]),
    )

    expect(recorded).toEqual(MOCK_CONTRACT_BASELINE)
    expect(Object.values(recorded).every((count) => count === 1)).toBe(true)
  })
})
