import type { MachineConfig } from '../../types'
import { DEFAULT_MACHINE_PROBE_DEFAULTS } from './toolTable'

/** A public, editable example, never an operator's imported machine. */
export function createSampleMachine(): MachineConfig {
  return {
    // Keep the chooser's placeholder identity: this is not a chosen real machine.
    id: 'default-machine',
    name: 'Sample hobby router (GRBL)',
    type: 'gantry_router',
    kind: 'router',
    controller: 'grbl',
    // WO-2280's target dimensions, from the starter recommendation in
    // .planning/research-common-hobby-cnc-2026-09-30.md; source listed there:
    // https://cncrouterinfo.com/routers/shapeoko-5-pro/
    travel: { x: 406, y: 406, z: 95 },
    noHomingSwitches: false,
    // WO-2712 (Operator 10-09): the home end is NOT stored here. GRBL's default
    // ($23 = 0, every axis homes to its max end = machine zero) is supplied by
    // machineHomeConvention() for this GRBL sample while nothing is stored, so a
    // copy switched to another controller inherits nothing and anything the
    // operator saves always wins (audit 10-09 7:31 PM).
    // The research cites the Carbide Compact Router's manual speed range:
    // https://shop.carbide3d.com/products/shapeoko5
    minSpindleRpm: 10000,
    maxSpindleRpm: 31000,
    // Existing product defaults, not claimed vendor machine specifications.
    probing: { ...DEFAULT_MACHINE_PROBE_DEFAULTS },
    rapidRate: 5000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    axisLimits: {
      x: { maxCutting: 3000, maxRapid: 5000 },
      y: { maxCutting: 3000, maxRapid: 5000 },
      z: { maxCutting: 1000, maxRapid: 3000 },
    },
    notes: 'Sample hobby router sized like the Shapeoko 5 Pro Standard class (406 x 406 x 95 mm), with homing switches and a 10,000-31,000 RPM compact trim router. Edit or replace this sample with your own machine.\nFeed, rapid, acceleration, probing and other setup values are editable LienCAM defaults, not published machine figures. No controller definition is supplied.',
  }
}
