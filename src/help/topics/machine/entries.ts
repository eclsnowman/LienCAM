// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'control-tab-overview',
    title: 'The Control tab',
    category: 'machine',
    summary: 'Control turns the app into a machine sender: the toolpath preview stays the biggest element, surrounded by connection, jog, program, and safety panels.',
    keywords: 'control tab sender machine grbl uccnc uc100 bridge panels preview dro safety estop feed hold cycle start layout',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'control-connect',
    title: 'Connecting to the machine',
    category: 'machine',
    summary: 'The sender connects over Web Serial for a GRBL-family board, through the local UCCNC/UC100 bridge, or to LinuxCNC through its gateway: pick the port, keep the default baud unless your controller differs, and watch the status readout.',
    keywords: 'connect serial port usb baud grbl uccnc linuxcnc gateway uc100 bridge status idle alarm hold homing h x unlock web serial browser clear software stop latched e-stop estop first connect',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'moving-to-a-new-pc',
    title: 'Moving LienCAM to a new or rebuilt PC',
    category: 'machine',
    summary: "Install LienCAM and UCCNC, copy your UCCNC profile, then Restore bundle: your shop data and this machine's connection settings come back from the backup, with no file to hand-edit. Two things a backup cannot carry are listed here, with why.",
    keywords: 'new pc rebuilt reinstall move migrate computer failure disaster backup restore bundle uccnc install profile pro driver dll defender antivirus exclusion shortcut bat environment variable bridge port board install folder',
    contextKeys: ['workspace:control', 'modal:settings'],
  },
  {
    id: 'connect-linuxcnc',
    title: 'Connecting to LinuxCNC',
    category: 'machine',
    summary: 'Run the small LienCAM gateway on the LinuxCNC PC, type that PC\'s address on Machine > Definition > Controller, then Connect - on the same PC or across your network.',
    keywords: 'linuxcnc gateway network connect python3 gateway.py host 0.0.0.0 port 8327 firewall address another pc axis gmoccapy ini hal link watch probe g38 tool change m6 simulator hardware tested',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'control-jog-zero',
    title: 'Jogging and setting zero',
    category: 'machine',
    summary: 'The Jog panel moves the machine in steps or continuously, and the Work offsets panel sets X0/Y0/Z0 - by button, or through the probe pad for Z.',
    keywords: 'jog step continuous zero x0 y0 z0 work offset probe pad touch plate park position dro machine coordinates offsets tab push changed set from position fixture name rotation g54 g59 not sent',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'control-run-job',
    title: 'Running a job',
    category: 'machine',
    summary: 'Post a setup straight into the sender or load a file, trace the job outline first if you want, then run with hold, resume, and live overrides.',
    keywords: 'run job send program post setup gcode file cycle start feed hold resume override feed spindle mid-program start line fit trace outline cycle log console edit program insert line m0 pause apply discard find replace run from here right-click single block stop reset est remaining time refused load canned drilling g81 g82 g83 g98 g99 vacuum output readback path check brief jump travel unset work zero zoom pan re-arm from start rearm line 1 tool change change tool grbl fit tool',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'machine-choice',
    title: 'The machine prompt when opening a project',
    category: 'machine',
    summary: 'A project saved with a machine this installation does not have asks you to choose - the app never switches your machine silently.',
    keywords: 'machine prompt choice load open project unknown default first selected library dialect no silent switch',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'probing-tab',
    title: 'The Probing tab',
    category: 'machine',
    summary: 'Probing finds edges, corners, bores, bosses, surfaces and tool lengths with a touch probe, shows the plan on a diagram, and writes an offset only after you confirm.',
    keywords: 'probing probe tab edge corner bore boss rectangle angle z surface tool length touch probe tip radius compensation work offset confirm diagram guided cycle manual touch path clear stopped reason did not start refused',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'probe-routines',
    title: 'Probe routines',
    category: 'machine',
    summary: 'A probe routine is a small data file - inputs, moves, touches, arithmetic and proposals - that LienCAM previews with real machine numbers before anything moves.',
    keywords: 'probe routine routines custom probing edit inputs steps move touch calc check branch preview expand proposal confirm work offset tool length report factory user imported reviewed quarantined import export restore factory json liencam-probe errors E_ codes envelope stale',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'program-context',
    title: 'Setup information on a loaded program',
    category: 'machine',
    summary: 'The chip next to the program name and the Intended stock card say which setup a program was posted from, and whether that is still true.',
    keywords: 'program context setup chip intended stock card current stale none unverified setup changed program changed no setup information cannot verify g54 lcx1 context block exported file control program panel',
    contextKeys: ['workspace:control'],
  },
  {
    id: 'mesh-viewer',
    title: 'Surface mesh flatness viewer',
    category: 'machine',
    summary: 'Click the Mesh chip in Control to see the probed surface as a turnable shape, colored low to high, with the flatness range in numbers.',
    keywords: 'mesh viewer flatness plane surface map bed mesh visualization chip modal range min max exaggerated orbit heatmap probed points',
    contextKeys: ['workspace:control', 'modal:mesh-viewer'],
  },
  {
    id: 'machine-definition-catalog',
    title: 'The Machine definition page',
    category: 'machine',
    summary: 'Control > Machine > Machine definition holds the wiring, homing and controller-specific settings a homebuilt machine needs - grouped into catalog sections you can filter down to only what you use.',
    keywords: 'machine definition page catalog group used only show everything hide empty classify wiring homing backlash steps per unit controller settings',
    contextKeys: ['workspace:control'],
  },
  {
  "id": "control-simulator",
  "title": "The in-app machine simulator",
  "category": "machine",
  "summary": "Choose Simulator in Control to practice running programs, jogging and probing against a virtual machine using the selected machine settings.",
  "keywords": "simulator simulation virtual machine practice dry run offline no hardware in-app simulated part drill canned cycles g81 g82 g83 g98 g99 tool setter",
  "contextKeys": [
    "workspace:control",
    "controller:simulator"
  ]
},
  {
  "id": "control-tool-setter",
  "title": "The fixed tool setter",
  "category": "machine",
  "summary": "A fixed setter measures a tool at a known machine position; the tool table keeps the contact and compares it with a measured reference tool to apply length.",
  "keywords": "tool setter fixed probe touch off tool length measure tool measure tn reference ref tool table apply length tlo g43.1 calibration probing simulator virtual setter",
  "contextKeys": [
    "workspace:control",
    "panel:tools"
  ]
},
]
