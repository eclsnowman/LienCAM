import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readGcodeProgram,
  type GcodeReaderOptions,
  type GcodeReadProgram,
  type GcodeReadRefusal,
} from '../../lib/gcode'

const OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
}

function read(text: string, options: Partial<GcodeReaderOptions> = {}): ReturnType<typeof readGcodeProgram> {
  return readGcodeProgram(text, { ...OPTIONS, ...options })
}

function program(text: string, options: Partial<GcodeReaderOptions> = {}): GcodeReadProgram {
  const result = read(text, options)
  expect(result.ok, result.ok ? undefined : result.refusal.message).toBe(true)
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program
}

function refused(text: string, reason: RegExp, options: Partial<GcodeReaderOptions> = {}): GcodeReadRefusal {
  const result = read(text, options)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected the whole file to be refused')
  expect(result.refusal.message).toMatch(/^Line \d+:/)
  expect(result.refusal.reason).toMatch(reason)
  expect('program' in result).toBe(false)
  return result.refusal
}

describe('WO-1288 semantic table', () => {
  it('1 resolves absent file units from the machine and refuses when both are unknown', () => {
    const mm = program('G90\nG0 X25.4\nM30', { machineUnits: 'mm' })
    expect(mm.moves[0]).toMatchObject({ x: 25.4 })
    const inch = program('G90\nG0 X1\nM30', { machineUnits: 'inch' })
    expect(inch.moves[0]).toMatchObject({ x: 25.4 })
    refused('G90\nG0 X25.4\nM30', /machine units are unknown/)
  })

  it('2 resolves G20 coordinates, centres and feeds into canonical millimetres', () => {
    const result = program('G20 G90\nG0 X1 Y0 Z0\nG2 X2 I0.5 J0 F10\nM30')
    expect(result.moves[0]).toMatchObject({ x: 25.4, y: 0, z: 0 })
    expect(result.moves[1]).toMatchObject({ x: 50.8, cy: 0, feed: 254 })
    expect(result.moves[1].cx).toBeCloseTo(38.1)
    expect(result.end.units).toBe('inch')
  })

  it('3 resolves G53 through a known work offset and refuses it when the offset is unknown', () => {
    const text = 'G21 G90\nG53 G0 X100 Y60 Z30\nM30'
    const result = program(text, {
      workOffsets: { G54: { x: 10, y: 20, z: 5 } },
    })
    expect(result.moves[0]).toMatchObject({ x: 90, y: 40, z: 25 })
    refused(text, /G53 cannot be resolved.*G54 offset is unknown/)
    expect(program('G21\nG53 X100\nM30', {
      workOffsets: { G54: { x: 0, y: 0, z: 0 } },
    }).moves[0]).toMatchObject({ type: 'rapid', x: 100 })
  })

  it('4 resolves G28 against the machine home position, and against machine zero when none is named', () => {
    // WO-1337: `G28` resolves the way `G53` does - work = machine - offset.
    // WO-1644: it does not require homing. UCCNC and LinuxCNC rapid to the
    // stored G28 position, which is machine zero until something sets it.
    const homed = program('G21\nG0 X1 Y1 Z1\nG28 G91 Z0\nM30', {
      machineHome: { x: -1, y: -2, z: -3 },
      workOffsets: { G54: { x: 10, y: 20, z: 5 } },
    })
    expect(homed.moves[1]).toMatchObject({ type: 'rapid', x: 1, y: 1, z: -8 })
    const unnamed = program('G21\nG0 X1 Y1 Z1\nG28 G91 Z0\nM30',
      { workOffsets: { G54: { x: 10, y: 20, z: 5 } } })
    expect(unnamed.moves[1]).toMatchObject({ type: 'rapid', x: 1, y: 1, z: -5 })
    // G30's second reference point IS stored in a controller nothing here
    // reads back, and it is still refused for exactly that.
    refused('G21\nG30\nM30', /G30 via-point return/)
  })

  it('5 accepts G43 H and carries its number, whatever H carries', () => {
    // The reader carries H's number; the length it shifts Z by is whatever the
    // caller's tool table answers (`toolLengthMm`, WO-1677), zero with none. A malformed G43 - no H, or a non-positive one - is
    // still a refusal.
    const result = program('G21\nG43 H7\nM30')
    expect(result.items).toContainEqual({
      kind: 'tool-length-offset', line: 2, enabled: true, tool: 7,
    })
    refused('G21\nG43\nM30', /G43 requires a positive integer H/)
    refused('G21\nG43 H0\nM30', /G43 requires a positive integer H/)
  })

  it('5 keeps Z resolvable across G43 and G49, because the staged shift is known', () => {
    // These three used to refuse: a G43 left `toolLengthShiftMm` null, which
    // made every later Z "unknown" and took a G53 Z with it. A known shift -
    // the tool table's length, or zero when none is passed -
    // resolves all of them, and the first case is the exact opening of Operator's
    // Fusion file - G53 Z retract, G43 H19, then the first XY rapid.
    const afterG53 = program(
      'G21 G90\nG53 G0 Z128\nG43 H19\nG0 X272.278 Y113.588\nM30',
      { workOffsets: { G54: { x: 0, y: 0, z: 0 } } },
    )
    expect(afterG53.moves.at(-1)).toMatchObject({ x: 272.278, y: 113.588, z: 128 })

    const acrossG49 = program('G21 G90\nG0 X0 Y0 Z50\nG43 H19 G0 Z10\nG49\nG0 X10 Y10\nM30')
    expect(acrossG49.moves.at(-1)).toMatchObject({ x: 10, y: 10, z: 10 })

    const established = program(
      'G21 G90\nG0 X0 Y0 Z50\nG43 H19 G0 Z10\nG0 X10 Y10\nG49 G0 Z50\nG0 X20 Y20\nM30',
    )
    expect(established.moves.at(-1)).toMatchObject({ x: 20, y: 20, z: 50 })
  })

  it('5 resolves a G53 Z while a G43 tool-length frame is active', () => {
    const zMove = program(
      'G21 G90\nG0 X0 Y0 Z50\nG43 H19\nG53 G0 Z128\nG0 X10 Y10\nM30',
      { workOffsets: { G54: { x: 0, y: 0, z: 0 } } },
    )
    expect(zMove.moves.at(-1)).toMatchObject({ x: 10, y: 10, z: 128 })

    const xyOnly = program(
      'G21 G90\nG43 H19 G0 X0 Y0 Z10\nG53 G0 X100 Y60\nG0 X10 Y10\nM30',
      { workOffsets: { G54: { x: 10, y: 20, z: 5 } } },
    )
    expect(xyOnly.moves[1]).toMatchObject({ x: 90, y: 40, z: 10 })

    const repeatedH = program('G21 G90\nG43 H19 G0 X0 Y0 Z10\nG43 H19\nG0 X10 Y10\nM30')
    expect(repeatedH.moves.at(-1)).toMatchObject({ x: 10, y: 10, z: 10 })
  })

  it('6 refuses G41 and G42 cutter compensation by name, with the word table sentence', () => {
    refused('G21\nG41 G1 X1 F100\nM30', /^G41 is not in the UCCNC G-code word table/)
    refused('G21\nG42 G1 X1 F100\nM30', /^G42 is not in the UCCNC G-code word table/)
  })

  it('7 tracks work-offset switches and rebases carried axes through known offsets', () => {
    const result = program('G21 G90\nG54 G0 X0 Y0 Z10\nG55 G0 X50 Y50\nM30', {
      workOffsets: {
        G54: { x: 0, y: 0, z: -10 },
        G55: { x: 0, y: 0, z: -40 },
      },
    })
    expect(result.moveWcs).toEqual(['G54', 'G55'])
    expect(result.moves[1]).toMatchObject({ x: 50, y: 50, z: 40 })
    expect(result.items).toEqual(expect.arrayContaining([
      { kind: 'work-offset', line: 2, wcs: 'G54' },
      { kind: 'work-offset', line: 3, wcs: 'G55' },
      { kind: 'move', line: 3, moveIndex: 1, wcs: 'G55' },
    ]))
    expect(result.end.wcs).toBe('G55')
  })

  it('7 refuses a partial move after an unresolved work-offset change instead of carrying position', () => {
    const result = refused(
      'G21 G90\nG54 G0 X0 Y0 Z10\nG55 G0 X50 Y50\nM30',
      /G0 cannot resolve Z in G55.*does not establish every unknown axis/,
    )
    expect(result.line).toBe(3)

    const established = program('G21 G90\nG54 G0 X0 Y0 Z10\nG55 G0 X50 Y50 Z10\nM30')
    expect(established.moves[1]).toMatchObject({ x: 50, y: 50, z: 10 })
  })

  it('7 refuses an active canned cycle at a work-offset boundary', () => {
    refused(
      'G21 G90\nG0 Z10\nG99 G81 X5 Y5 Z-5 R2 F900\nG55\nG80\nM30',
      /G55 work-offset change cannot carry an active G81 canned cycle.*G80/,
    )
  })

  it('8 preserves an I/J centre-form arc as one native arc move', () => {
    const result = program('G21 G90\nG0 X0 Y0 Z0\nG3 X10 Y0 I5 J0 F600\nM30')
    expect(result.moves).toHaveLength(2)
    expect(result.moves[1]).toEqual({
      type: 'arc_ccw', role: 'cut', x: 10, y: 0, z: 0,
      cx: 5, cy: 0, feed: 600,
    })
  })

  it('9 resolves the R-form minor arc and refuses the ambiguous greater-than-180-degree form', () => {
    const result = program('G21 G90\nG0 X0 Y0\nG2 X10 Y0 R10 F100\nM30')
    expect(result.moves[1].type).toBe('arc_cw')
    expect(result.moves[1].cx).toBeCloseTo(5)
    expect(result.moves[1].cy).toBeCloseTo(-8.660254)
    refused('G21 G90\nG0 X0 Y0\nG2 X10 Y0 R-10 F100\nM30', /negative R.*greater-than-180-degree/)
  })

  it('10 resolves an unambiguous I/J full circle and refuses an R-form full circle', () => {
    const result = program('G21 G90\nG0 X0 Y0 Z0\nG2 I5 J0 F100\nM30')
    expect(result.moves[1]).toMatchObject({ type: 'arc_cw', x: 0, y: 0, cx: 5, cy: 0 })
    refused('G21 G90\nG0 X0 Y0\nG2 R5 F100\nM30', /R-form full circle is undefined/)
  })

  it('11 reads an XY HELICAL arc as one arc move carrying the Z it ramps to (WO-1337)', () => {
    // This refusal said the wire could not carry a helix, which was never true
    // of the wire: `ToolpathMove` has an endpoint Z and the bridge submits
    // `AddCircularMoveP(X, Y, Z, CX, CY, CZ, ...)`. One move, ramping.
    const result = program('G21 G90\nG0 X0 Y0 Z0\nG3 X10 Y0 Z-5 I5 J0 F100\nM30')
    expect(result.moves).toHaveLength(2)
    expect(result.moves[1]).toEqual({
      type: 'arc_ccw', role: 'cut', feed: 100, cx: 5, cy: 0, x: 10, y: 0, z: -5,
    })
    // And the XY facts it always checked are still checked while it ramps.
    refused('G21 G90\nG0 X0 Y0 Z0\nG3 X10 Y5 Z-5 I5 J0 F100\nM30', /not equidistant/)
  })

  it('12 linearises XZ and YZ arcs into feed segments within the declared tolerance', () => {
    const xz = program('G21 G18 G90\nG0 X0 Y2 Z0\nG2 X10 Z0 I5 K0 F100\nM30')
    expect(xz.moves.slice(1).every((move) => move.type === 'feed' && move.y === 2)).toBe(true)
    expect(xz.moves.at(-1)).toMatchObject({ x: 10, y: 2, z: 0 })
    expect(xz.moves.length).toBeGreaterThan(2)

    const yz = program('G21 G19 G90\nG0 X3 Y0 Z0\nG3 Y10 Z0 J5 K0 F100\nM30')
    expect(yz.moves.slice(1).every((move) => move.type === 'feed' && move.x === 3)).toBe(true)
    expect(yz.moves.at(-1)).toMatchObject({ x: 3, y: 10, z: 0 })
  })

  it('13 expands a modal G81 canned cycle into positioning, plunge and retract moves', () => {
    const result = program([
      'G21 G90',
      'G0 Z10',
      'G99 G81 X5 Y5 Z-5 R2 F900',
      'X10',
      'G80',
      'M30',
    ].join('\n'))
    expect(result.moves.filter((move) => move.role === 'plunge')).toHaveLength(2)
    expect(result.moves.at(-1)).toMatchObject({ type: 'rapid', x: 10, y: 5, z: 2 })
    expect(result.moveLines.filter((line) => line === 4).length).toBeGreaterThan(1)
    refused('G21 G90\nG0 Z10\nG81 X5 Y5 Z-5 R2\nG80\nM30', /G81 canned cycle has no positive feed rate/)
  })

  it('13 retracts before XY when entering below R and never traverses below R', () => {
    const result = program([
      'G21 G90',
      'G0 Z-2',
      'G81 X5 Y5 Z-5 R2 F900',
      'X10',
      'G80',
      'M30',
    ].join('\n'))
    const cycleMoves = result.moves.slice(1)
    expect(cycleMoves[0]).toMatchObject({ type: 'rapid', x: 0, y: 0, z: 2 })
    expect(cycleMoves[1]).toMatchObject({ type: 'rapid', x: 5, y: 5, z: 2 })
    const xyTraverses = cycleMoves.filter((move, index) => index > 0
      && (move.x !== cycleMoves[index - 1].x || move.y !== cycleMoves[index - 1].y))
    expect(xyTraverses.every((move) => move.z >= 2)).toBe(true)
  })

  it('13 defaults to safer G98 and distinguishes G98 from G99 return height', () => {
    const base = ['G21 G90', 'G0 Z10', 'MODE G81 X5 Y5 Z-5 R2 F900', 'G80', 'M30']
    const g98 = program(base.map((line) => line.replace('MODE', 'G98')).join('\n'))
    const g99 = program(base.map((line) => line.replace('MODE', 'G99')).join('\n'))
    const defaultMode = program(base.map((line) => line.replace('MODE ', '')).join('\n'))
    expect(g98.moves.at(-1)?.z).toBe(10)
    expect(g99.moves.at(-1)?.z).toBe(2)
    expect(defaultMode.moves.at(-1)?.z).toBe(10)
  })

  it('13/14 measures an incremental canned-cycle depth from the R plane', () => {
    const absolute = program([
      'G21 G90',
      'G0 X0 Y0 Z-5',
      'G99 G81 X5 Y5 R2 Z-18 F900',
      'G80',
      'M30',
    ].join('\n'))
    const incremental = program([
      'G21 G90',
      'G0 X0 Y0 Z-5',
      'G91',
      'G99 G81 X5 Y5 R7 Z-20 F900',
      'G80',
      'G90',
      'M30',
    ].join('\n'))
    const plunge = (result: GcodeReadProgram) => result.moves.find((move) => move.role === 'plunge')
    expect(plunge(absolute)).toMatchObject({ x: 5, y: 5, z: -18 })
    expect(plunge(incremental)).toEqual(plunge(absolute))
  })

  it('14 resolves G91 after a G53 move from the resolved machine-frame endpoint', () => {
    const result = program('G21 G91\nG53 G0 X100 Y50 Z20\nG1 X5 Y-2 Z1 F100\nM30', {
      workOffsets: { G54: { x: 10, y: 10, z: 5 } },
    })
    expect(result.moves[0]).toMatchObject({ x: 90, y: 40, z: 15 })
    expect(result.moves[1]).toMatchObject({ x: 95, y: 38, z: 16 })
    expect(result.end.distanceMode).toBe('incremental')
  })

  it('15 resolves dwell P by dialect and refuses an unrecognised dialect', () => {
    const text = 'G21\nG4 P1500\nM30'
    expect(program(text).items).toContainEqual({ kind: 'dwell', line: 2, seconds: 1.5 })
    expect(program(text, { dialect: 'linuxcnc' }).items).toContainEqual({
      kind: 'dwell', line: 2, seconds: 1500,
    })
    refused(text, /dialect "mystery" is not recognised/, {
      dialect: 'mystery' as GcodeReaderOptions['dialect'],
    })
  })

  it('16 marks G64 path blending without changing geometry', () => {
    const result = program('G21 G64\nG0 X1\nM30')
    expect(result.items).toContainEqual({ kind: 'path-control', line: 1, mode: 'continuous' })
    expect(result.moves).toHaveLength(1)
  })

  it('17 represents M0 as a required program pause', () => {
    expect(program('G21\nM0\nM30').items).toContainEqual({
      kind: 'pause', line: 2, optional: false,
    })
  })

  it('18 refuses M2001 by name with no partial program result', () => {
    const result = refused('G21\nG0 X1\nM2001\nM30', /M2001 calls a UCCNC user macro, and this route does not run macros/)
    expect(result.line).toBe(3)
  })
})

describe('WO-1288 named M-code items', () => {
  it('represents tool change, pause, spindle, coolant and program end without dropping them', () => {
    const result = program([
      'G21 G90',
      'T7 M6',
      'S12000 M3',
      'M8',
      'M0',
      'M9',
      'M5',
      'M30',
    ].join('\n'))
    expect(result.items).toEqual(expect.arrayContaining([
      { kind: 'tool-change', line: 2, tool: 7 },
      { kind: 'spindle', line: 3, on: true, direction: 'cw', rpm: 12000 },
      { kind: 'coolant', line: 4, flood: true, mist: false, standardCode: 8 },
      { kind: 'pause', line: 5, optional: false },
      { kind: 'coolant', line: 6, flood: false, mist: false, standardCode: 9 },
      { kind: 'program-end', line: 8, code: 'M30' },
    ]))
    refused('G21\nM10\nM30', /^M10 is not in the UCCNC G-code word table/)
  })
})

describe('WO-1288 strict block validation', () => {
  it('refuses conflicting units words instead of selecting millimetres', () => {
    const result = refused('G21 G20 G90\nM30', /G21 and G20 conflict in the units modal group/)
    expect(result.line).toBe(1)
  })

  it('refuses conflicting motion words instead of selecting the first one', () => {
    refused('G21 G90\nG1 G0 X10 Y0 F100\nM30', /G1 and G0 conflict in the motion modal group/)
  })

  it('refuses a repeated axis address instead of selecting the first coordinate', () => {
    refused('G21 G90\nG0 X10 X20 Y0\nM30', /address X appears more than once/)
  })

  it('refuses a repeated feed address instead of selecting the first feed', () => {
    refused('G21 G90\nG1 X10 F100 F999\nM30', /address F appears more than once/)
  })
})

describe('WO-1288 motion termination', () => {
  it('G80 clears group-1 motion so an axis-only block after a cycle refuses', () => {
    const result = refused([
      'G21 G90',
      'G0 Z10',
      'G1 X0 Y0 F500',
      'G81 X5 Y5 Z-5 R2',
      'G80',
      'X20 Y20',
      'M30',
    ].join('\n'), /coordinate word appears with no active motion mode/)
    expect(result.line).toBe(6)
  })

  it('refuses the first block after a program end instead of appending its moves', () => {
    const result = refused('G21 G90\nM30\nG0 X10', /block appears after M30 program end/)
    expect(result.line).toBe(3)
  })
})

describe('WO-1287 corpus through the strict reader', () => {
  const fixtureDir = join(__dirname, '../fixtures/foreign-gcode')
  const expected = {
    // It used to stop at line 23, because `G43 H19` on line 22 left the tool
    // length "unknown" and every Z after it unresolvable. With the shift known
    // to be zero the STRICT reader now reads all 110,615 moves and gets as far
    // as the user macro on line 110,354, which only this reader refuses - the
    // geometry route the app actually loads through REPORTS `M2001` and holds
    // at it. That is the whole file, read.
    'fusion-liencnc-v2-sample.nc': /Line 110354: M2001 calls a UCCNC user macro/,
    // WO-1644: G28 does not require homing, so neither stops for homing at its
    // opening `G28 G91 Z0`; with no work offset reported here they stop there
    // on the offset instead.
    'fusion360-drilling-excerpt.nc': /G28 cannot be resolved because the G54 work offset is unknown/,
    'fusion360-issue395-xy.nc': /G28 cannot be resolved because the G54 work offset is unknown/,
    'linuxcnc-spiral.ngc': /address O is not understood/,
  } as const

  it('pins every real posted file to complete success or a named whole-file refusal', () => {
    const files = readdirSync(fixtureDir).filter((file) => /\.(nc|ngc|gcode)$/i.test(file)).sort()
    expect(files).toEqual([...Object.keys(expected), 'liencam-own-post-baseline.nc'].sort())
    for (const filename of files) {
      const dialect = filename === 'linuxcnc-spiral.ngc' ? 'linuxcnc' : 'uccnc'
      const result = read(readFileSync(join(fixtureDir, filename), 'utf8'), {
        dialect,
        machineUnits: 'mm',
        workOffsets: filename === 'fusion-liencnc-v2-sample.nc'
          ? { G54: { x: 0, y: 0, z: 0 } }
          : undefined,
      })
      if (filename === 'liencam-own-post-baseline.nc') {
        expect(result.ok, result.ok ? undefined : result.refusal.message).toBe(true)
        if (result.ok) {
          expect(result.program.moveWcs).toContain('G54')
          expect(result.program.moveWcs).toContain('G55')
          const firstG55 = result.program.moveWcs.indexOf('G55')
          expect(firstG55).toBeGreaterThan(0)
          expect(result.program.moveWcs.slice(0, firstG55).every((wcs) => wcs === 'G54')).toBe(true)
          expect(result.program.moveWcs.slice(firstG55).every((wcs) => wcs === 'G55')).toBe(true)
        }
      } else {
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.refusal.message, filename).toMatch(expected[filename as keyof typeof expected])
          expect('program' in result).toBe(false)
        }
      }
    }
  })
})
