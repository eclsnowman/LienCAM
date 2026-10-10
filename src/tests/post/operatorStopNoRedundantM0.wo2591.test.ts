import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { postProject } from '../../lib/post/postProject'
import { GENERIC_CONFIG, GRBL_CONFIG, LINUXCNC_CONFIG, UCCNC_CONFIG, parseUserPostConfig, serializeUserPostConfig, type PostConfig } from '../../lib/post'
import type { MachineAction, Operation, Project, Setup, Stock } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'

function post(config: PostConfig, stopAt?: number, twoTools = false): string {
  const operations: Operation[] = [0, 1].map(i => makeOp({
    id: `op${i}`, name: `Cut ${i}`, toolId: twoTools && i === 1 ? 't2' : 't1',
    toolpathMoves: [move({ type: 'rapid', x: i * 20, y: 10, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: i * 20 + 10, y: 10, z: -1, feed: 400, role: 'cut' })],
  }))
  const actions: MachineAction[] = stopAt === undefined ? [] : [{
    id: 'stop', kind: 'operator_stop', name: 'Operator stop', enabled: true,
    afterOpId: stopAt === 0 ? null : operations[stopAt - 1].id, message: 'Secure the stock',
  }]
  const setup: Setup = { id: 's1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
    operations, machineActions: actions, notes: '' }
  const project: Project = { id: 'wo2591', name: 'WO-2591', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(), toolLibrary: [makeTool(), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [], setups: [setup], activeSetupId: null, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '' }
  for (const op of operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find(t => t.id === op.toolId)!)
  const result = postProject(project, [setup], config, { mode: 'combined', pauseBetweenSetups: false, baseName: 'wo2591', ext: 'nc' })
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  const gcode = result.combined!.gcode
  if (process.env.WO2591_CAPTURE && (stopAt === 1 || twoTools)
      && [UCCNC_CONFIG, GENERIC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG].includes(config)) {
    writeFileSync(`src/tests/evidence/WO-2591/${config.id}-${twoTools ? 'two-tool' : 'operator-stop'}.nc`, gcode)
  }
  return gcode
}
const executable = (gcode: string) => gcode.split(/\r?\n/).map(l => l.replace(/\([^)]*\)/g, '').split(';')[0].trim()).filter(Boolean)

describe('WO-2591 operator stop emitted through postProject', () => {
  for (const config of [UCCNC_CONFIG, GENERIC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG]) {
    for (const stopAt of [0, 1, 2]) it(`${config.id}: stop at boundary ${stopAt}`, () => {
      const lines = executable(post(config, stopAt))
      if (config.id === 'uccnc') {
        expect(lines.filter(l => l === 'M2001')).toHaveLength(1)
        const at = lines.indexOf('M2001')
        expect(lines.slice(at + 1, at + 3)).not.toContain('M0')
        expect(lines).not.toContain('M0')
      } else {
        expect(lines.filter(l => l === 'M0')).toHaveLength(1)
        expect(lines).not.toContain('M2001')
      }
      expect(lines).toContain('M5')
    })
    it(`${config.id}: two-tool job preserves its tool-change behavior`, () => {
      const lines = executable(post(config, undefined, true))
      if (config.id === 'grbl') expect(lines.filter(l => l === 'M0')).toHaveLength(1)
      else {
        // The first tool is preloaded; the second needs the one change.
        expect(lines.filter(l => /\bM6\b/.test(l))).toHaveLength(1)
        expect(lines).not.toContain('M0')
      }
    })
  }
  it('invalid and absent operator macros still emit the standalone M0', () => {
    for (const macro of [undefined, '', 'M2001\nM0', 'invalid']) {
      const lines = executable(post({ ...UCCNC_CONFIG, options: { ...UCCNC_CONFIG.options, operatorStopMacro: macro } }, 1))
      expect(lines.filter(l => l === 'M0')).toHaveLength(1)
      expect(lines).not.toContain('M2001')
    }
  })
  for (const macro of ['M9', 'M2002']) {
    for (const stopAt of [0, 1, 2]) it(`imported ${macro}: stop at boundary ${stopAt} retains M0`, () => {
      const imported = parseUserPostConfig(serializeUserPostConfig({
        ...LINUXCNC_CONFIG, options: { ...LINUXCNC_CONFIG.options, operatorStopMacro: macro },
      }))
      expect(imported.ok).toBe(true)
      if (!imported.ok) throw new Error(imported.error)
      expect(imported.config.builtin).toBe(false)
      expect(imported.config.options.operatorStopMacro).toBe(macro)
      const gcode = post(imported.config, stopAt)
      const lines = executable(gcode)
      expect(lines.filter(l => l === 'M0')).toHaveLength(1)
      // M9 also appears in coolant/end framing; bind the macro to this stop.
      expect(lines[lines.indexOf('M0') - 1]).toBe(macro)
      if (process.env.WO2591_FIX_CAPTURE) {
        writeFileSync(`src/tests/evidence/WO-2591/fix-imported-${macro}-boundary-${stopAt}.nc`, gcode)
      }
    })
  }
  it('imported UCCNC M2001 still emits only the holding macro', () => {
    const imported = parseUserPostConfig(serializeUserPostConfig(UCCNC_CONFIG))
    expect(imported.ok).toBe(true)
    if (!imported.ok) throw new Error(imported.error)
    const lines = executable(post(imported.config, 1))
    expect(lines.filter(l => l === 'M2001')).toHaveLength(1)
    expect(lines).not.toContain('M0')
  })
  for (const config of [GENERIC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG,
    { ...UCCNC_CONFIG, id: 'user-import-wo2591' }]) {
    for (const stopAt of [0, 1, 2]) it(`imported ${config.id} M2001: boundary ${stopAt} retains M0`, () => {
      const imported = parseUserPostConfig(serializeUserPostConfig({
        ...config, options: { ...config.options, operatorStopMacro: ' M2001 ' },
      }))
      expect(imported.ok).toBe(true)
      if (!imported.ok) throw new Error(imported.error)
      expect(imported.config.id).toBe(config.id)
      expect(imported.config.builtin).toBe(false)
      const gcode = post(imported.config, stopAt)
      const lines = executable(gcode)
      expect(lines.filter(l => l === 'M2001')).toHaveLength(1)
      expect(lines.filter(l => l === 'M0')).toHaveLength(1)
      expect(lines[lines.indexOf('M2001') + 1]).toBe('M0')
      if (process.env.WO2591_BOUNDARY_CAPTURE) {
        writeFileSync(`src/tests/evidence/WO-2591/boundary-${config.id}-stop-${stopAt}.nc`, gcode)
      }
    })
  }
})
