import { describe, expect, it } from 'vitest'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { emitProgram } from '../../lib/post/emit'
import { resolveCoolant, resolveSpindle, resolveVacuum } from '../../lib/post/resolve'
import type { MachineMCode } from '../../types'
import { adoptMachineDocument } from '../../store'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'

function emittedFor(
  machine: ReturnType<typeof makeMachine>,
  vacuum: MachineMCode | null | undefined = undefined,
): string[] {
  const tool = makeTool()
  const op = makeOp({
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 1000, role: 'cut' }),
    ],
  })
  return emitProgram({
    machine,
    setup: {
      wcs: makeWcs(),
      operations: [{
        op,
        tool,
        feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
        spindle: resolveSpindle(op, tool, machine),
        coolant: resolveCoolant(tool, machine),
        ...(vacuum === undefined ? {} : { vacuum }),
        moves: op.toolpathMoves ?? [],
      }],
    },
  }, UCCNC_CONFIG).lines
}

/** Two operations on ONE tool, so the emitter takes its same-tool branch between
 *  them. Each entry names the accessory state that operation asks for; `vacuum`
 *  is omitted entirely when the case wants the machine-definition fallback. */
function emittedForOps(
  machine: ReturnType<typeof makeMachine>,
  ops: ReadonlyArray<{
    coolant?: 'none' | 'flood' | 'mist' | 'air'
    vacuum?: MachineMCode | null
    stated?: boolean
  }>,
): string[] {
  const tool = makeTool()
  return emitProgram({
    machine,
    setup: {
      wcs: makeWcs(),
      operations: ops.map((entry, i) => {
        const op = makeOp({
          id: `op${i + 1}`,
          name: `Op ${i + 1}`,
          toolId: tool.id,
          toolpathMoves: [
            move({ type: 'rapid', x: i * 10, y: 0, z: 5, role: 'rapid' }),
            move({ type: 'feed', x: i * 10 + 5, y: 0, z: 0, feed: 1000, role: 'cut' }),
          ],
        })
        return {
          op,
          tool,
          feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
          spindle: resolveSpindle(op, tool, machine),
          coolant: entry.coolant ?? resolveCoolant(tool, machine),
          ...(entry.stated === false ? {} : { vacuum: entry.vacuum ?? null }),
          moves: op.toolpathMoves ?? [],
        }
      }),
    },
  }, UCCNC_CONFIG).lines
}

/** Where the second operation's own lines begin: its section comment. */
function secondOpStart(lines: string[]): number {
  const at = lines.indexOf('( Op 2 )')
  expect(at, 'the second operation must have its own section comment').toBeGreaterThan(0)
  return at
}

describe('WO-1058 post vacuum channel', () => {
  it('runs custom vacuum before requested flood on a combined machine', () => {
    const machine = makeMachine({
      coolant: true,
      coolantCapability: { mist: true, flood: true, vacuum: { onCode: 'M200' } },
    })
    const lines = emittedFor(machine, resolveVacuum(machine))

    expect(lines.indexOf('M200')).toBeLessThan(lines.indexOf('M8'))
    expect(lines.lastIndexOf('M9')).toBeGreaterThan(lines.indexOf('M8'))
  })

  it('runs only profile-derived M8 vacuum on a vacuum-only machine', () => {
    const machine = makeMachine({
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: { onCode: 'M8' } },
    })
    const lines = emittedFor(machine)

    expect(resolveCoolant(makeTool(), machine)).toBe('none')
    expect(lines.filter((line) => line === 'M8')).toHaveLength(1)
    expect(lines.lastIndexOf('M9')).toBeGreaterThan(lines.indexOf('M8'))
  })

  it('emits no accessory words when neither capability exists', () => {
    const machine = makeMachine({
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: false },
    })
    const lines = emittedFor(machine)

    expect(lines).not.toContain('M7')
    expect(lines).not.toContain('M8')
    expect(lines).not.toContain('M9')
  })

  it('relocates a colliding M8 vacuum rather than merely dropping it', () => {
    // The round-12 audit's note about this test: accepting "one M8" was true
    // whether the vacuum had been RELOCATED or silently thrown away, and those
    // are very different machines. The relocation happens ONCE, when the
    // document enters the store (`adoptMachineDocument`), so the post reads it
    // raw like every other surface - the vacuum moved to the first free code
    // and still runs, ahead of the flood that kept M8.
    const machine = adoptMachineDocument(makeMachine({
      coolant: true,
      coolantCapability: { mist: true, flood: true, vacuum: { onCode: 'M8' } },
    }))
    expect(machine.coolantCapability?.vacuum).toEqual({ onCode: 'M10' })
    expect(resolveVacuum(machine)).toBe('M10')

    const lines = emittedFor(machine, resolveVacuum(machine))

    expect(resolveCoolant(makeTool(), machine)).toBe('flood')
    expect(lines.filter((line) => line === 'M8')).toHaveLength(1)
    expect(lines.filter((line) => line === 'M10')).toHaveLength(1)
    expect(lines.indexOf('M10')).toBeLessThan(lines.indexOf('M8'))
  })

  it('resolves the vacuum the same way whether the caller passes it or not', () => {
    // `emitProgram` falls back to `resolveVacuum(input.machine)` when the
    // PostOperation carries no vacuum. That fallback is the path a real post
    // takes, and it is the one the audit's probe caught disagreeing with the
    // Control page. Both read the STORED document now, which is the migrated
    // one: the legacy record went in on M8 and is kept on M10.
    const stored = makeMachine({
      coolant: false,
      coolantCapability: { vacuum: { onCode: 'M8' } },
    })
    expect(stored.coolantCapability?.vacuum).toEqual({ onCode: 'M8' })
    const machine = adoptMachineDocument(stored)
    expect(machine.coolantCapability?.vacuum).toEqual({ onCode: 'M10' })
    expect(resolveVacuum(machine)).toBe('M10')

    expect(emittedFor(machine)).toEqual(emittedFor(machine, resolveVacuum(machine)))
    expect(emittedFor(machine).filter((line) => line === 'M10')).toHaveLength(1)
    expect(emittedFor(machine)).not.toContain('M8')
  })

  it('refuses reserved program and spindle words at the direct PostOperation seam', () => {
    const machine = makeMachine({
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: false },
    })
    for (const reserved of ['M3', 'M4', 'M5', 'M30'] as const) {
      const lines = emittedFor(machine, reserved)

      const expectedProgramUses = reserved === 'M5' || reserved === 'M30' ? 1 : 0
      expect(lines.filter((line) => line === reserved), `${reserved} is not a vacuum start`)
        .toHaveLength(expectedProgramUses)
    }
  })
  it('turns Vacuum OFF for a same-tool operation whose contract says it is dry', () => {
    // The blocking finding of the design-pass audit. `vacuum: null` is documented
    // in post/types.ts as "explicitly disables vacuum for a directly constructed
    // operation". Before this, the emitter only changed accessories after a tool
    // change or a pause restart, so an explicitly dry second operation CUT with
    // the vacuum still running and M9 arrived only at the program end.
    const machine = makeMachine({
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: { onCode: 'M200' } },
    })
    const lines = emittedForOps(machine, [
      { coolant: 'none', vacuum: 'M200' },
      { coolant: 'none', vacuum: null },
    ])

    const start = secondOpStart(lines)
    expect(lines.indexOf('M200'), 'the first operation runs the vacuum').toBeLessThan(start)
    // The vacuum is stopped BEFORE the dry operation's first motion, not at the
    // program end. Everything from the section comment to the first move.
    const beforeMotion = lines.slice(start, lines.findIndex((l, i) => i > start && l.startsWith('G0 ')))
    expect(beforeMotion, 'the dry operation stops the vacuum before it cuts').toContain('M9')
    // And it does not quietly start again.
    expect(lines.slice(start).filter((l) => l === 'M200'), 'nothing restarts the vacuum')
      .toHaveLength(0)
  })

  it('keeps Flood running when only the Vacuum is turned off between operations', () => {
    // M9 is the SHARED accessory stop, so turning the vacuum off necessarily
    // stops the coolant too. The truthful emission is M9 followed by the coolant
    // the operation still asks for - never a bare M9 that silently drops flood.
    const machine = makeMachine({
      coolant: true,
      coolantCapability: { mist: true, flood: true, vacuum: { onCode: 'M200' } },
    })
    const lines = emittedForOps(machine, [
      { coolant: 'flood', vacuum: 'M200' },
      { coolant: 'flood', vacuum: null },
    ])

    const start = secondOpStart(lines)
    const tail = lines.slice(start)
    const off = tail.indexOf('M9')
    expect(off, 'the shared stop runs for the dry operation').toBeGreaterThanOrEqual(0)
    expect(tail.indexOf('M8'), 'flood is restarted after the shared stop')
      .toBeGreaterThan(off)
    expect(tail.filter((l) => l === 'M200'), 'the vacuum is not restarted').toHaveLength(0)
    // The restart happens before the operation cuts, not somewhere later.
    expect(tail.indexOf('M8')).toBeLessThan(tail.findIndex((l) => l.startsWith('G1 ')))
  })

  it('starts the Vacuum for a same-tool operation that asks for it after a dry one', () => {
    // The transition is symmetric: the finding is about accessory state being
    // ignored, not about "off" specifically.
    const machine = makeMachine({
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: { onCode: 'M200' } },
    })
    const lines = emittedForOps(machine, [
      { coolant: 'none', vacuum: null },
      { coolant: 'none', vacuum: 'M200' },
    ])

    const start = secondOpStart(lines)
    expect(lines.slice(0, start), 'the dry operation ran no accessory').not.toContain('M200')
    expect(lines.slice(start), 'the wet operation starts the vacuum').toContain('M200')
    expect(lines.slice(start).indexOf('M200'))
      .toBeLessThan(lines.slice(start).findIndex((l) => l.startsWith('G1 ')))
  })

  it('says nothing at all between same-tool operations that ask for the same accessories', () => {
    // The regression guard for every existing program: a builder-produced input
    // takes its coolant from the tool and its vacuum from the machine, so every
    // same-tool operation asks for the same words and the emitted program must
    // be byte-identical to the one-transition-free output it always had.
    const machine = makeMachine({
      coolant: true,
      coolantCapability: { mist: true, flood: true, vacuum: { onCode: 'M200' } },
    })
    const stated = emittedForOps(machine, [
      { coolant: 'flood', vacuum: 'M200' },
      { coolant: 'flood', vacuum: 'M200' },
    ])
    const fallback = emittedForOps(machine, [{ stated: false }, { stated: false }])

    expect(fallback, 'the machine-definition fallback resolves the same words each time')
      .toEqual(stated)
    // Exactly one start of each accessory, and exactly one stop, at the end.
    expect(stated.filter((l) => l === 'M200')).toHaveLength(1)
    expect(stated.filter((l) => l === 'M8')).toHaveLength(1)
    expect(stated.filter((l) => l === 'M9')).toHaveLength(1)
    expect(stated.lastIndexOf('M9')).toBeGreaterThan(secondOpStart(stated))
    expect(stated.slice(secondOpStart(stated)).findIndex((l) => l.startsWith('G1 ')))
      .toBeLessThan(stated.slice(secondOpStart(stated)).indexOf('M9'))
  })
})
