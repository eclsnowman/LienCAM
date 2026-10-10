// The combined two-work-offset program WO-1297 posts, extracted here by
// WO-1298 so both orders send ONE program rather than each inventing its own.
//
// WO-1297 asks whether the SIMULATOR executes it correctly; WO-1298 asks
// whether GrblController, driving a device over the wire protocol, reports
// where it landed. Those are different code paths (CONVENTIONS 0b), and the
// only thing they may legitimately share is the fixture itself.

import { expect } from 'vitest'
import type { MachineVec3, WcsId } from '../../../lib/machine/types'
import { postProject } from '../../../lib/post/postProject'
import type { PostConfig } from '../../../lib/post/types'
import type { Operation, Project, Setup, Stock } from '../../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../../post/helpers'

/** Machine coordinates of each work zero the program's two setups use. */
export const TWO_SETUP_OFFSETS: Record<'G54' | 'G55', MachineVec3> = {
  G54: { x: 10, y: 20, z: 0 },
  G55: { x: 100, y: 200, z: 0 },
}

/**
 * Where the machine stands after each MOTION line of the program, in machine
 * coordinates, with the offsets above in force. Derived by hand from the
 * program text and the offset table - this is the EXPECTATION the controller
 * is measured against, never a number any device or double supplies.
 *
 *   G54  G0 X10 Y20 Z5  ->  ( 20,  40, 5)
 *        G1 X30 F2000   ->  ( 40,  40, 5)   <- first setup's cutting move
 *        G0 Z5          ->  ( 40,  40, 5)   (no change)
 *   G55  G0 X10 Y20 Z5  ->  (110, 220, 5)
 *        G1 X40 F2000   ->  (140, 220, 5)   <- second setup's cutting move
 *        G0 Z5          ->  (140, 220, 5)   (no change)
 */
export const TWO_SETUP_MACHINE_PATH: MachineVec3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 20, y: 40, z: 5 },
  { x: 40, y: 40, z: 5 },
  { x: 110, y: 220, z: 5 },
  { x: 140, y: 220, z: 5 },
]

/** The two cutting moves, in the order the program runs them. */
export const TWO_SETUP_CUTS: Record<'first' | 'second', MachineVec3> = {
  first: { x: 40, y: 40, z: 5 },
  second: { x: 140, y: 220, z: 5 },
}

function makeStock(): Stock {
  return {
    type: 'rectangular', width: 100, depth: 100, height: 20,
    origin: { x: 0, y: 0, z: 0 }, material: 'aluminum',
  } as unknown as Stock
}

function cuttingOp(id: string, cutX: number): Operation {
  return makeOp({
    id,
    name: id,
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: cutX, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

function setup(id: string, fixtureOffset: 54 | 55, op: Operation): Setup {
  return {
    id,
    name: id,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(),
    operations: [op],
    notes: '',
  }
}

/**
 * Post the two-setup program in `config`'s dialect and locate its two cutting
 * moves. `cutLines` are 1-based SOURCE line numbers in the returned text.
 */
export function postedTwoSetupProgram(config: PostConfig): { gcode: string; cutLines: number[] } {
  const setups = [setup('first', 54, cuttingOp('cut-first', 30)), setup('second', 55, cuttingOp('cut-second', 40))]
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const project: Project = {
    id: 'two-setup-fixture', name: 'two-setup dialect fixture', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(), toolLibrary: [tool], geometry: [], setups,
    activeSetupId: 'first', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const candidate of setups) stampGenerationCurrent(project, candidate, candidate.operations[0], tool)

  const posted = postProject(project, setups, config, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'dialect', ext: 'nc', modelRefsVerifiedSinceLoad: true,
  })
  if (!posted.ok || !posted.combined) throw new Error('two-setup fixture did not post')

  const lines = posted.combined.gcode.trimEnd().split('\n')
  const firstWcs = lines.indexOf('G54')
  const secondWcs = lines.indexOf('G55')
  const firstCut = lines.findIndex((line, index) => index > firstWcs && index < secondWcs && /^G1 X30(?:\.0+)?\b/.test(line))
  const secondCut = lines.findIndex((line, index) => index > secondWcs && /^G1 X40(?:\.0+)?\b/.test(line))
  expect([firstCut, secondCut]).not.toContain(-1)
  return { gcode: posted.combined.gcode, cutLines: [firstCut + 1, secondCut + 1] }
}

/** The offset table above, typed the way a device double wants it. */
export const TWO_SETUP_OFFSET_TABLE: Partial<Record<WcsId, MachineVec3>> = {
  G54: TWO_SETUP_OFFSETS.G54,
  G55: TWO_SETUP_OFFSETS.G55,
}
