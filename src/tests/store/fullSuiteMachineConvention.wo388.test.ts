import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WO-388 Full Suite machine convention after WO-2545', () => {
  it('ships the sample router without the former private machine homing convention', () => {
    const project = JSON.parse(readFileSync(
      resolve(process.cwd(), 'Example Projects/Full Suite.camproject'),
      'utf8',
    ))

    // WO-2545 (ce62e7114) deliberately replaces the entire private machine.
    expect(project.machine.name).toBe('Sample hobby router (GRBL)')
    expect(project.machine.id).toBe('default-machine')
    expect(project.machine.controller).toBe('grbl')
    expect(project.machine.homeConvention).toBeUndefined()
  })
})
