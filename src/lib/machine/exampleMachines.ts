import type { MachineConfig, MachineMacro } from '../../types'
import { createSampleMachine } from './sampleMachine'

interface ExampleMachine {
  key: string
  name: string
  specs: Partial<MachineConfig>
  defaults: string
  detail: string
}

// The variants and figures below are the rows of the 2026-09-30 hobby CNC
// research, not interchangeable sizes/options of the same brand. Controller
// selects the post family; no connection, board identity or wiring is supplied.
export const EXAMPLE_MACHINES: readonly ExampleMachine[] = [
  // https://shop.carbide3d.com/products/shapeoko5
  // https://cncrouterinfo.com/routers/shapeoko-5-pro/
  {
    key: 'shapeoko-standard', name: 'Shapeoko 5 Pro / 4 Standard', specs: {},
    defaults: '',
    detail: 'Shapeoko Standard-class size, using the Carbide Compact Router option. GRBL post family; Carbide Motion protocol detail is unverified.',
  },
  // https://www.sainsmart.com/products/genmitsu-3018-prover-v2-upgraded-semi-assembled-cnc-router-kit
  // https://www.manualslib.com/manual/3567589/Genmitsu-3018-Prover-V2.html
  {
    key: 'genmitsu-3018', name: 'Genmitsu 3018-PROVer V2',
    specs: { travel: { x: 300, y: 180, z: 45 }, minSpindleRpm: 1000, maxSpindleRpm: 10000 },
    defaults: 'homing switches', detail: 'GRBL 1.1. Z limit-switch equipment varies; check your own machine.',
  },
  // https://www.onefinitycnc.com/product-page/journeymanelite
  // https://www.cncsourced.com/cnc-routers/onefinity-cnc-review/
  // https://forum.onefinitycnc.com/
  {
    key: 'onefinity-woodworker', name: 'Onefinity Woodworker',
    specs: { controller: 'generic', travel: { x: 813, y: 813, z: 165 }, minSpindleRpm: undefined, maxSpindleRpm: undefined },
    defaults: 'minimum and maximum spindle RPM (unset)',
    detail: '32 x 32 in class, approximately 813 x 813 mm. Classic/Pro uses Buildbotics; Elite uses MASSO. Generic post because neither has a matching built-in dialect. This example does not configure a controller connection.',
  },
  // https://github.com/Sienci-Labs/Resources/blob/main/lmmk2/lmk2-the-basics/lmk2-mk2-specs.md
  // https://sienci.com/2021/12/30/all-about-the-longmill-mk2/
  {
    key: 'longmill-30x30', name: 'Sienci LongMill MK2 30x30',
    specs: {
      controller: 'grblhal', travel: { x: 820, y: 868, z: 125 }, minSpindleRpm: 15000, maxSpindleRpm: 25000,
      axisLimits: {
        x: { maxCutting: 4000, maxRapid: 5000 },
        y: { maxCutting: 4000, maxRapid: 5000 },
        z: { maxCutting: 3000, maxRapid: 3000 },
      },
    },
    defaults: 'homing switches',
    detail: 'SuperLongBoard grblHAL option (older LongBoard uses GRBL). Z travel is approximately 125 mm. Published maximum cutting feeds: X/Y 4000, Z 3000 mm/min. Homing equipment is optional on MK2.',
  },
  // https://builds.openbuilds.com/builds/lead-cnc-1010-40-x-40.7832/
  // https://cncrouterinfo.com/guides/openbuilds-lead-1010-guide/
  {
    key: 'lead-1010', name: 'OpenBuilds LEAD 1010',
    specs: { travel: { x: 750, y: 750, z: 100 }, minSpindleRpm: undefined, maxSpindleRpm: undefined },
    defaults: 'minimum and maximum spindle RPM (unset)',
    detail: 'BlackBox GRBL 1.1 option; newer X32 uses grblHAL. Research work area is approximate, including about 100 mm Z. Router/spindle is user supplied.',
  },
  // https://easel.com/partners/machines/foxalien-masuter-pro
  // https://cncrouterinfo.com/routers/foxalien-masuter-pro/
  // https://www.foxalien.com/blogs/news/foxalien-cnc-router-masuter-pro-masuter-3-and-masuter-3s-buying-guide
  {
    key: 'masuter-pro', name: 'FoxAlien Masuter Pro',
    specs: { travel: { x: 400, y: 380, z: 60 }, minSpindleRpm: 3000, maxSpindleRpm: 12000 },
    defaults: 'homing switches',
    detail: 'GRBL 1.1, 300 W DC spindle option. Research gives Y as 380-400 mm; this is its 380 mm variant. Homing equipment was not confirmed.',
  },
  // https://www.amazon.com/Genmitsu-Machine-PROVerXL-Controlled-Engraving/dp/B08L6314MW
  // https://cncrouterinfo.com/routers/genmitsu-proverxl-4030/
  {
    key: 'proverxl-4030', name: 'Genmitsu PROVerXL 4030',
    specs: { travel: { x: 400, y: 300, z: 110 }, minSpindleRpm: undefined, maxSpindleRpm: undefined },
    defaults: 'minimum and maximum spindle RPM (unset)',
    detail: 'GRBL 1.1, original 4030 size. The research gives no RPM range for this variant; the 4040-PRO RPM is not a 4030 specification.',
  },
  // https://cdn.hackaday.io/files/255641093730176/CNC%206040%20Manual%20and%20Mach3%20Guide%202015120416433598141.pdf
  // https://www.china-cncrouter.com/products/CNC-6040.htm
  // http://www.forum.cncdrive.com/viewtopic.php?f=2&t=2003
  {
    key: '6040-class', name: '6040-class Chinese gantry',
    specs: { controller: 'uccnc', travel: { x: 600, y: 400, z: 75 }, minSpindleRpm: 6000, maxSpindleRpm: 24000 },
    defaults: 'homing switches',
    detail: 'Mach3 / UCCNC family, with a UCCNC post. Approximately 75 mm Z travel and a VFD spindle option. Wiring, spindle and homing vary across suppliers. A UCCNC conversion requires the user to set up their own connection.',
  },
  // https://www.cnc-dad.com/blog/best-cnc-router-for-beginners/
  // https://bestcncmachines.com/best-hobby-cnc-routers/
  {
    key: 'x-carve-1000', name: 'X-Carve 1000',
    specs: { travel: { x: 750, y: 750, z: 65 }, minSpindleRpm: 16000, maxSpindleRpm: 27000 },
    defaults: 'homing switches',
    detail: 'GRBL-based X-Controller, legacy 1000 mm kit, DeWalt router option (approximately 16,000-27,000 RPM). Homing equipment varies on older kits.',
  },
  // Research's market-tier source: https://www.kiddofspeed.com/best-hobby-cnc-routers/
  // Maximum RPM independently confirmed (the research dimensions stay defaults):
  // https://knowledgebase.tormach.com/pcnc-440/machine-specifications
  {
    key: 'pcnc-440', name: 'Tormach PCNC 440',
    specs: { type: 'vertical_mill', controller: 'linuxcnc', minSpindleRpm: undefined, maxSpindleRpm: 10000 },
    defaults: 'X/Y/Z travel (406 x 406 x 95 mm sample size; research dimensions unverified), minimum spindle RPM (unset)',
    detail: 'PathPilot is LinuxCNC-based; LinuxCNC post. This example does not configure a PathPilot connection.',
  },
]

/** Fresh nested defaults and a fresh identity on EVERY explicit add. */
export function createExampleMachine(example: typeof EXAMPLE_MACHINES[number]): MachineConfig {
  const sample = createSampleMachine()
  const defaultFeeds = example.key === 'longmill-30x30' ? '' : 'cutting feeds, '
  const machine: MachineConfig = {
    ...sample,
    ...structuredClone(example.specs),
    id: crypto.randomUUID(),
    name: `Example - ${example.name}`,
    notes: `Example built from published specifications. Check against your own machine and edit as needed. ${example.detail}\nEditable LienCAM defaults, not published machine specifications: ${defaultFeeds}rapid rates (overall and per-axis), acceleration (unset), probing, spindle direction, tool changer, coolant, home convention (unset) and other setup values${example.defaults ? `, ${example.defaults}` : ''}. No controller definition, board identity or connection is supplied.`,
  }
  machine.macros = exampleMacros(machine)
  return machine
}

// WO-2597: editable content, not another macro execution path. Hidden means
// OFF (WO-2657); show an example in the editor before calling its M-code.
// Example profiles supply no verified home convention or stock dimensions.
// Ask for those coordinates rather than inventing a positive machine origin,
// a front park, or a clearance height from nominal travel.
function exampleMacros(machine: MachineConfig): MachineMacro[] {
  const rpmDefault = (rpm: number | undefined) => rpm === undefined ? '' : `, ${rpm}`
  return [
    {
      id: 'example-part-swap', name: 'Example - Part swap', mCode: 300, hidden: true,
      body: `// Retract first, park at the BACK of travel, then M0 pauses for a part swap.
const safeZ = ask('Safe clearance Z in machine coordinates (mm)?')
const parkX = ask('Part-swap X in machine coordinates (mm)?')
const backY = ask('BACK of travel Y in machine coordinates (mm)?')
if (typeof safeZ === 'number' && typeof parkX === 'number' && typeof backY === 'number') {
  line('M5')
  goTo({ z: safeZ })
  goTo({ x: parkX, y: backY })
  say('Parked at the back. Swap the part, then press CYCLE START.')
  line('M0')
} else {
  say('Part swap cancelled; nothing moved.')
}`,
    },
    {
      id: 'example-spindle-warm-up', name: 'Example - Spindle warm-up', mCode: 301, hidden: true,
      body: `// Warm up clockwise at three RPM stages for 30 seconds each, then stop.
const low = ask('Starting warm-up RPM?'${rpmDefault(machine.minSpindleRpm)})
const high = ask('Final warm-up RPM?'${rpmDefault(machine.maxSpindleRpm)})
if (typeof low === 'number' && typeof high === 'number') {
  const speeds = [low, (low + high) / 2, high]
  for (let i = 0; i < speeds.length; i++) {
    line('M3 S' + speeds[i])
    wait(30000)
  }
  line('M5')
  say('Spindle warm-up complete.')
} else {
  say('Spindle warm-up cancelled; spindle unchanged.')
}`,
    },
    {
      id: 'example-part-trace', name: 'Example - Part trace', mCode: 302, hidden: true,
      body: `// Trace a rectangular stock/part outline in work coordinates, at safe machine Z.
const safeZ = ask('Safe clearance Z in machine coordinates (mm)?')
const left = ask('Outline minimum work X (mm)?')
const right = ask('Outline maximum work X (mm)?')
const front = ask('Outline minimum work Y (mm)?')
const back = ask('Outline maximum work Y (mm)?')
if (typeof safeZ === 'number' && typeof left === 'number' && typeof right === 'number' && typeof front === 'number' && typeof back === 'number') {
  line('M5')
  goTo({ z: safeZ })
  goTo({ x: left, y: front }, { machine: false })
  goTo({ x: right, y: front }, { machine: false })
  goTo({ x: right, y: back }, { machine: false })
  goTo({ x: left, y: back }, { machine: false })
  goTo({ x: left, y: front }, { machine: false })
  say('Part outline traced at clearance height.')
} else {
  say('Part trace cancelled; nothing moved.')
}`,
    },
  ]
}
