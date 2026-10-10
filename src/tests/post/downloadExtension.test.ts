import { describe, it, expect } from 'vitest'
import {
  downloadFilenameForConfig,
  extForConfig,
} from '../../lib/post/downloadExtension'
import { postProject } from '../../lib/post/postProject'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GENERIC_CONFIG } from '../../lib/post/dialects/base'
import {
  makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent,
} from './helpers'
import type { Operation, Project, Setup, Stock } from '../../types'
import type { PostConfig } from '../../lib/post/types'

// ---------------------------------------------------------------------------
// Commit 1: download extension chosen by CONTROLLER IDENTITY, not comment style.
// The built-in GRBL dialect uses PAREN comments; on the old code its extension
// wrongly fell through to '.nc'. It must be '.gcode'.
// ---------------------------------------------------------------------------

describe('extForConfig — extension by controller identity', () => {
  it('built-in GRBL (paren comments) -> gcode (regression: was .nc)', () => {
    expect(GRBL_CONFIG.capabilities.comment).toBe('paren') // guards the fixture
    expect(extForConfig(GRBL_CONFIG)).toBe('gcode')
  })

  it('GRBL with semicolon comments -> gcode (comment style is irrelevant)', () => {
    const grblSemi: PostConfig = {
      ...GRBL_CONFIG,
      capabilities: { ...GRBL_CONFIG.capabilities, comment: 'semicolon' },
    }
    expect(extForConfig(grblSemi)).toBe('gcode')
  })

  it('GRBL variant id (e.g. grbl-1.1) still -> gcode', () => {
    const grblVariant: PostConfig = { ...GRBL_CONFIG, id: 'grbl-1.1' }
    expect(extForConfig(grblVariant)).toBe('gcode')
  })

  it('LinuxCNC -> ngc', () => {
    expect(extForConfig(LINUXCNC_CONFIG)).toBe('ngc')
  })

  it('UCCNC (fallback controller) -> nc', () => {
    expect(extForConfig(UCCNC_CONFIG)).toBe('nc')
  })

  it('Generic / custom fallback -> nc', () => {
    expect(extForConfig(GENERIC_CONFIG)).toBe('nc')
  })
})

describe('Post Process modal combined download filename', () => {
  it('uses the production filename builder for every controller family', () => {
    const grblSemi: PostConfig = {
      ...GRBL_CONFIG,
      capabilities: { ...GRBL_CONFIG.capabilities, comment: 'semicolon' },
    }

    expect(downloadFilenameForConfig('Ext Test', GRBL_CONFIG)).toBe('Ext_Test.gcode')
    expect(downloadFilenameForConfig('Ext Test', grblSemi)).toBe('Ext_Test.gcode')
    expect(downloadFilenameForConfig('Ext Test', LINUXCNC_CONFIG)).toBe('Ext_Test.ngc')
    expect(downloadFilenameForConfig('Ext Test', GENERIC_CONFIG)).toBe('Ext_Test.nc')
    expect(downloadFilenameForConfig('   ', UCCNC_CONFIG)).toBe('program.nc')
  })
})

// ---------------------------------------------------------------------------
// The extension only names the file — the emitted g-code BYTES are identical
// regardless of which extension is chosen for a given config.
// ---------------------------------------------------------------------------

function makeStock(): Stock {
  return {
    type: 'rectangular',
    width: 100,
    depth: 100,
    height: 20,
    origin: { x: 0, y: 0, z: 0 },
  } as unknown as Stock
}

function twoMoveOp(id: string, name: string): Operation {
  return makeOp({
    id,
    name,
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

function makeSetup(): Setup {
  return {
    id: 's1',
    name: 'Front',
    wcs: makeWcs({ id: 'wcs-s1', label: 'G54', fixtureOffset: 54 }),
    stock: makeStock(),
    operations: [twoMoveOp('op-a', 'Profile A')],
    notes: '',
  }
}

function makeProject(setups: Setup[]): Project {
  const project: Project = {
    id: 'p1',
    name: 'Ext Test',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [],
    stocks: undefined,
    setups,
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  // CAM-15 (52ac9e3e7): ready ops must be fingerprint-current or posting
  // refuses them as OP_OUTDATED.
  for (const setup of setups) {
    for (const op of setup.operations) {
      if (op.status !== 'ready') continue
      const tool = project.toolLibrary.find((t) => t.id === op.toolId)!
      stampGenerationCurrent(project, setup, op, tool)
    }
  }
  return project
}

describe('download extension is orthogonal to emitted bytes', () => {
  it('same GRBL config posts identical g-code bytes for any ext value', () => {
    const setups = [makeSetup()]
    const project = makeProject(setups)
    const base = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part' }

    const asGcode = postProject(project, setups, GRBL_CONFIG, { ...base, ext: 'gcode' })
    const asNc = postProject(project, setups, GRBL_CONFIG, { ...base, ext: 'nc' })

    expect(asGcode.ok).toBe(true)
    expect(asNc.ok).toBe(true)
    expect(asGcode.combined!.gcode).toBe(asNc.combined!.gcode)
  })
})
