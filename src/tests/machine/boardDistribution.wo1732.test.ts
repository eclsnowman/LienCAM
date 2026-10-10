import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// WO-1732 - the canonical Windows desk build must ship the board data beside
// the executable, and the existing smoke must drive that data through the real
// bridge loader. This is intentionally not a second JSON/schema parser.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const BUILD_SCRIPT = join(BRIDGE_DIR, 'desk-build.ps1')
const SMOKE = join(BRIDGE_DIR, 'smoke.mjs')
const SOURCE_BOARDS = join(BRIDGE_DIR, 'boards')
const BUILD_DIR = join(tmpdir(), 'liencam-bridge-desk')
const BUILT_BOARDS = join(BUILD_DIR, 'boards')
const PORT = '18432'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').toUpperCase()

let buildOutput = ''
let smokeOutput = ''

describe.skipIf(process.platform !== 'win32')('WO-1732 board data distribution', () => {
  beforeAll(() => {
    mkdirSync(BUILT_BOARDS, { recursive: true })
    writeFileSync(join(BUILT_BOARDS, 'stale.json'), '{"deviceType":999}')

    buildOutput = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUILD_SCRIPT,
    ], { encoding: 'utf8', timeout: 120_000 })
    console.log(buildOutput.trim())

    smokeOutput = execFileSync(process.execPath, [
      SMOKE, PORT, '--board-distribution-only',
    ], { encoding: 'utf8', timeout: 120_000 })
    console.log(smokeOutput.trim())
  }, 240_000)

  it('replaces stale output with an exact byte-for-byte copy of shipped tables', () => {
    const sourceNames = readdirSync(SOURCE_BOARDS).filter((name) => name.endsWith('.json')).sort()
    const builtNames = readdirSync(BUILT_BOARDS).filter((name) => name.endsWith('.json')).sort()
    expect(sourceNames).toEqual(['uc100.json'])
    expect(builtNames).toEqual(sourceNames)

    const source = readFileSync(join(SOURCE_BOARDS, 'uc100.json'))
    const built = readFileSync(join(BUILT_BOARDS, 'uc100.json'))
    expect(built.equals(source)).toBe(true)
    expect(buildOutput).toContain(`board    uc100.json ${source.length} bytes sha256 ${sha256(source)}`)
    expect(existsSync(join(BUILD_DIR, 'liencam-bridge.exe'))).toBe(true)
    expect(buildOutput).toMatch(/sha256\s+[A-F0-9]{64}/)
  })

  it('exercises shipped UC100, built-in AXBB-E and unknown refusal through the real loader', () => {
    expect(smokeOutput).toContain('UC100 table loads from the distributed boards directory')
    expect(smokeOutput).toContain('demo UC100 selects the shipped table through the real board gate')
    expect(smokeOutput).toContain('AXBB-E still selects its unchanged built-in table')
    expect(smokeOutput).toContain('unknown demo type 999 retains the truthful pin-table refusal')
    expect(smokeOutput).toMatch(/\d+ passed, 0 failed/)
  })
})
