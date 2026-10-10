import { describe, expect, it } from 'vitest'
import { classifyGrblLine, parseStatusReport } from '../../lib/machine/grbl/lines'

describe('classifyGrblLine', () => {
  it('classifies ok', () => {
    expect(classifyGrblLine('ok')).toEqual({ kind: 'ok' })
  })

  it('classifies error with decoded message', () => {
    const r = classifyGrblLine('error:9')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.code).toBe(9)
      expect(r.message).toMatch(/refused the G-code because it is in an alarm or a jog/i)
    }
  })

  it('classifies alarms with decoded message', () => {
    const r = classifyGrblLine('ALARM:1')
    expect(r.kind).toBe('alarm')
    if (r.kind === 'alarm') expect(r.message).toMatch(/hard limit/i)
  })

  it('classifies the welcome banner across version letters', () => {
    for (const banner of ["Grbl 1.1h ['$' for help]", "Grbl 1.1f ['$' for help]"]) {
      const r = classifyGrblLine(banner)
      expect(r.kind).toBe('welcome')
      if (r.kind === 'welcome') expect(r.version).toMatch(/^1\.1/)
    }
  })

  it('classifies settings dump lines', () => {
    const r = classifyGrblLine('$110=2000.000')
    expect(r).toEqual({ kind: 'setting', key: 110, value: '2000.000' })
  })

  it('classifies bracketed feedback messages', () => {
    const msg = classifyGrblLine("[MSG:'$H'|'$X' to unlock]")
    expect(msg.kind).toBe('feedback')
    if (msg.kind === 'feedback') expect(msg.label).toBe('MSG')
    const prb = classifyGrblLine('[PRB:0.000,0.000,-5.203:1]')
    expect(prb.kind).toBe('feedback')
  })

  it('falls back to other for unknown text, never throws', () => {
    expect(classifyGrblLine('')).toEqual({ kind: 'other', text: '' })
    expect(classifyGrblLine('<garbage|nonsense')).toMatchObject({ kind: 'other' })
    expect(classifyGrblLine('<NotAState|MPos:0,0,0>')).toMatchObject({ kind: 'other' })
  })
})

describe('parseStatusReport', () => {
  it('parses a minimal idle report', () => {
    const r = parseStatusReport('Idle|MPos:0.000,0.000,0.000|FS:0,0')
    expect(r).not.toBeNull()
    expect(r!.state).toBe('idle')
    expect(r!.mpos).toEqual({ x: 0, y: 0, z: 0 })
    expect(r!.feed).toBe(0)
    expect(r!.spindleRpm).toBe(0)
    expect(r!.wco).toBeNull()
  })

  it('parses a busy run report with overrides, WCO, pins, accessories', () => {
    const r = parseStatusReport(
      'Run|MPos:10.500,-2.300,0.000|FS:800,12000|Ov:120,100,90|WCO:-100.000,-50.000,-2.000|Pn:PD|A:SF|Bf:14,120|Ln:42',
    )
    expect(r!.state).toBe('run')
    expect(r!.overrides).toEqual({ feed: 120, rapid: 100, spindle: 90 })
    expect(r!.wco).toEqual({ x: -100, y: -50, z: -2 })
    expect(r!.pins).toBe('PD')
    expect(r!.accessories).toEqual({ spindle: 'cw', flood: true, mist: false })
    expect(r!.buffer).toEqual({ plannerBlocks: 14, rxBytes: 120 })
    expect(r!.line).toBe(42)
  })

  it('decodes CCW spindle and mist coolant accessory letters', () => {
    const r = parseStatusReport('Run|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:CM')
    expect(r!.accessories).toEqual({ spindle: 'ccw', flood: false, mist: true })
  })

  it('reports without an A: field parse to accessories null (absence, not off)', () => {
    expect(parseStatusReport('Idle|MPos:0.000,0.000,0.000|FS:0,0')!.accessories).toBeNull()
    expect(parseStatusReport('Run|MPos:0,0,0|FS:0,0|Ov:100,100,100')!.accessories).toBeNull()
  })

  it('parses sub-states (Hold:1, Door:2)', () => {
    expect(parseStatusReport('Hold:1|MPos:0,0,0')!.subState).toBe(1)
    const door = parseStatusReport('Door:2|WPos:1.000,2.000,3.000')!
    expect(door.state).toBe('door')
    expect(door.subState).toBe(2)
    expect(door.wpos).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('parses the F-only feed field variant', () => {
    expect(parseStatusReport('Jog|MPos:0,0,0|F:500')!.feed).toBe(500)
  })

  it('degrades malformed fields to null without rejecting the report', () => {
    const r = parseStatusReport('Idle|MPos:zap|Ov:1,2')!
    expect(r.state).toBe('idle')
    expect(r.mpos).toBeNull()
    expect(r.overrides).toBeNull()
  })

  it('ignores unknown extension fields (grblHAL/FluidNC)', () => {
    const r = parseStatusReport('Idle|MPos:0,0,0|TLO:2.500|H:1')!
    expect(r.state).toBe('idle')
    expect(r.mpos).toEqual({ x: 0, y: 0, z: 0 })
  })
})
