// WO-2697: a GRBL post carries no other machine's vacuum M7.
//
// The operator asked for this fix on 10-09. The audit (AUDIT-journey-1009 M3) found the Full Suite Setup 5
// program posted in the GRBL format while the imported LienCNC V2 was the
// project machine carried LienCNC V2's Vacuum output word M7 after every M3
// (walkthrough nc/f06-setup5-grbl-Full_Suite.gcode lines 7, 1443, 12180). That
// M7 is how LienCNC V2's UCCNC starts its dust extraction (a relay on port 3
// pin 16); on a GRBL board M7 is mist coolant.
//
// The rule (WO-2285: picking another format in Post Process is "to post for
// another controller"; types/index.ts MachineVacuumCapability: the on-code is
// "only how this machine starts it"): a machine's own output words go out only
// in its own controller's format. Its own format keeps them.
//
// Production path: the shipped Full Suite example, its Setup 5, posted through
// postProject - the function the Post Process dialog calls.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GRBL_CONFIG, UCCNC_CONFIG, extForConfig, postProject } from '../../lib/post'
import type { PostConfig } from '../../lib/post/types'
import { adoptMachineDocument } from '../../store'
import type { MachineConfig, Project } from '../../types'
import { move, stampGenerationCurrent } from './helpers'

function lienCncV2(): MachineConfig {
  return adoptMachineDocument(JSON.parse(readFileSync(
    resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8',
  )) as MachineConfig)
}

/** Full Suite with `machine` as the project machine and Setup 5 generated. */
function fullSuiteSetup5(machine: MachineConfig): Project {
  const project = JSON.parse(readFileSync(
    resolve('Example Projects/Full Suite.camproject'), 'utf8',
  )) as Project
  project.machine = machine
  const setup = project.setups.find((candidate) => candidate.name === 'Setup 5')
  if (!setup) throw new Error('Full Suite has no Setup 5')
  project.activeSetupId = setup.id
  setup.operations.forEach((operation, index) => {
    const tool = project.toolLibrary.find((candidate) => candidate.id === operation.toolId)
    if (!tool) throw new Error(`Full Suite fixture has no tool ${operation.toolId}`)
    operation.status = 'ready'
    stampGenerationCurrent(project, setup, operation, tool)
    const { clearance, bottom } = operation.resolvedHeights!.machine
    operation.toolpathMoves = [
      move({ type: 'rapid', role: 'rapid', x: index * 10, y: 0, z: clearance }),
      move({ type: 'feed', role: 'plunge', x: index * 10, y: 0, z: bottom, feed: 300 }),
      move({ type: 'feed', role: 'cut', x: index * 10 + 5, y: 5, z: bottom, feed: 1200 }),
      move({ type: 'rapid', role: 'rapid', x: index * 10 + 5, y: 5, z: clearance }),
    ]
  })
  return project
}

function postSetup5(machine: MachineConfig, config: PostConfig): string[] {
  const project = fullSuiteSetup5(machine)
  const setup = project.setups.find((candidate) => candidate.id === project.activeSetupId)!
  const result = postProject(project, [setup], config, {
    mode: 'combined',
    pauseBetweenSetups: false,
    baseName: 'Full_Suite',
    ext: extForConfig(config),
    modelRefsVerifiedSinceLoad: true,
  })
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return result.combined!.gcode.split(/\r?\n/)
}

/** The word that follows each spindle start. */
function wordsAfterSpindleStart(lines: string[]): string[] {
  return lines.flatMap((line, index) => /^M[34]\b/.test(line) ? [lines[index + 1]] : [])
}

describe('WO-2697 a post writes a machine\'s accessory words only in its own format', () => {
  it('Full Suite Setup 5 on LienCNC V2, posted in the GRBL format, carries no M7', () => {
    const machine = lienCncV2()
    expect(machine.controller).toBe('uccnc')
    const lines = postSetup5(machine, GRBL_CONFIG)

    // Setup 5 starts the spindle three times (three tools), as the walkthrough file did.
    expect(lines.filter((line) => /^M3\b/.test(line))).toHaveLength(3)
    expect(lines).not.toContain('M7')
    expect(wordsAfterSpindleStart(lines).every((line) => !/^M\d+$/.test(line))).toBe(true)
  })

  it('LienCNC V2 posting Setup 5 in its own UCCNC format keeps its vacuum M7 after every M3', () => {
    const lines = postSetup5(lienCncV2(), UCCNC_CONFIG)

    expect(lines.filter((line) => /^M3\b/.test(line))).toHaveLength(3)
    expect(lines.filter((line) => line === 'M7')).toHaveLength(3)
  })

  it('a GRBL machine whose own definition has a vacuum keeps its word in the GRBL format', () => {
    const sampleWithVacuum: MachineConfig = adoptMachineDocument({
      ...JSON.parse(readFileSync(resolve('Example Projects/Full Suite.camproject'), 'utf8')).machine,
      coolant: false,
      coolantCapability: { mist: false, flood: false, vacuum: { onCode: 'M7' } },
    } as MachineConfig)
    expect(sampleWithVacuum.controller).toBe('grbl')
    const lines = postSetup5(sampleWithVacuum, GRBL_CONFIG)

    expect(lines.filter((line) => line === 'M7')).toHaveLength(3)
  })
})
