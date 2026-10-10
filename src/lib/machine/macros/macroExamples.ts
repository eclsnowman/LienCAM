// WO-1714 - the macro help screen's examples library: a handful of ready
// macro bodies an operator can drop straight into the editor. Real macro
// syntax, not documentation prose - a test runs every body through
// `checkMacroBody` so a broken example never ships.

export interface MacroExample {
  id: string
  name: string
  description: string
  body: string
}

export const MACRO_EXAMPLES: MacroExample[] = [
  {
    id: 'park-at-a-spot',
    name: 'Park at a spot',
    description: 'Rapids to one machine position, Z first so the tool clears the part before X/Y moves.',
    body: "goTo({ x: 0, y: 0, z: 0 })\nsay('Parked.')",
  },
  {
    id: 'vacuum-on-off',
    name: 'Vacuum on, then off',
    description: 'Switches an output on, waits, then switches it back off - rename "Vacuum" to whatever this machine calls it.',
    body: "output('Vacuum', true)\nwait(2000)\noutput('Vacuum', false)",
  },
  {
    id: 'probe-then-retract',
    name: 'Probe down, then retract',
    description: 'Sends a probe move toward the part, then backs off a short distance once it is done.',
    body: "line('G38.2 Z-10 F100')\nline('G91 G0 Z5')\nline('G90')\nsay('Probe done, retracted 5 mm.')",
  },
  {
    id: 'check-then-hold',
    name: 'Check position, then wait for CYCLE START',
    description: 'Reads the live status, prints it, then holds until the operator presses CYCLE START to continue.',
    body: "const s = status()\nsay('Homed: ' + s.homed)\nhold()\nsay('Continuing.')",
  },
  {
    id: 'loop-stops',
    name: 'Loop: step over positions',
    description: 'Loops over a list of X positions, moving to each one in turn - a pattern for a repeated tool check or multi-spot routine.',
    body: "const xs = [0, 25, 50, 75]\nfor (let i = 0; i < xs.length; i++) {\n  goTo({ x: xs[i], y: 0, z: 5 })\n  say('At stop ' + (i + 1) + ' of ' + xs.length)\n}",
  },
  {
    id: 'confirm-vacuum',
    name: 'Ask first: vacuum on?',
    description: 'Pops up an OK / Cancel question and only switches the vacuum on after OK - Cancel just skips it.',
    body: "if (confirm('Turn the vacuum on?')) {\n  output('Vacuum', true)\n} else {\n  say('Vacuum left off.')\n}",
  },
  {
    id: 'choose-a-corner',
    name: 'Decision tree: pick a corner',
    description: 'Pops up one button per corner and moves to the one picked - each answer is its own branch.',
    body: "const corner = choose('Move to which corner?', ['Front left', 'Back right'])\nif (corner === 'Front left') {\n  goTo({ x: 0, y: 0, z: 0 })\n} else if (corner === 'Back right') {\n  goTo({ x: 500, y: 500, z: 0 })\n} else {\n  say('No corner picked.')\n}",
  },
  {
    id: 'ask-a-depth',
    name: 'Entry field: type a depth',
    description: 'Pops up a field pre-filled with 5 and moves down (work coordinates) by what was typed.',
    body: "const depth = ask('Plunge depth in mm?', 5)\nif (typeof depth === 'number') {\n  goTo({ z: -depth }, { machine: false })\n} else {\n  say('No depth - nothing moved.')\n}",
  },
]
