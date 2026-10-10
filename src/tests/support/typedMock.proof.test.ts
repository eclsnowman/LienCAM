// WO-960: the typed helper works where it has to work - inside a HOISTED
// `vi.mock` factory, at runtime, over a real product module.
//
// The rule test next door proves the SYNTAX is required. This proves the
// required syntax is usable: `vi.mock` calls are hoisted above the imports, so
// "the factory returns through an imported helper" is a claim about vitest's
// module graph and not only about the compiler. If this ever went red, the rule
// would be forcing every mock in the repo into a spelling that does not run.

import { describe, it, expect, vi } from 'vitest'
import { typedMock } from './typedMock'
import { formatUccncSettingValue } from '../../lib/machine/uccncProfileImport'

vi.mock('../../lib/machine/uccncProfileImport', () => typedMock<typeof import('../../lib/machine/uccncProfileImport')>({
  formatUccncSettingValue: vi.fn(() => 'MOCKED'),
}))

describe('WO-960 the typed helper runs inside a hoisted vi.mock factory', () => {
  it('replaces the export it names', () => {
    expect(formatUccncSettingValue({ kind: 'number', value: 3 })).toBe('MOCKED')
  })

  it('leaves the helper itself an identity at runtime', () => {
    const shape = { formatUccncSettingValue }
    expect(typedMock<typeof import('../../lib/machine/uccncProfileImport')>(shape)).toBe(shape)
  })
})
