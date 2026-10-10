#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""WO-2099 test fixture, SIMULATOR ONLY: a probe that touches at a known place.

The stock sim leaves `motion.probe-input` unlinked, so a G38 move there never
touches. This wires a realtime window comparator (`wcomp`, one instance named
`lcprobe`) between one joint's feedback position and the probe input: the
input goes TRUE while the joint is past `position` in `direction` - a surface
at machine Z -20 probed from above is `wire Z - -20`, a wall at machine X 30
probed moving +X is `wire X + 30`. `move` changes the surface of a wired
probe; `unwire` takes it back out, leaving the probe input unlinked as the
sim boots (the comparator stays loaded, out of the thread and unconnected).
`set 0|1` drives an UNWIRED probe input by hand.

Never run this on a machine: it rewires the probe input in the running HAL.

    python3 sim_probe.py wire Z - -20
    python3 sim_probe.py move -25
    python3 sim_probe.py unwire
"""

import json
import subprocess
import sys

import linuxcnc

NAME = 'lcprobe'
SIGNAL_POS = 'lcprobe-pos'
SIGNAL_OUT = 'lcprobe-touch'
FAR = 1.0e6


def hal(*args: str, check: bool = True) -> str:
    done = subprocess.run(['halcmd', *args], capture_output=True, text=True)
    if check and done.returncode != 0:
        raise SystemExit(f'halcmd {" ".join(args)}: {done.stderr.strip() or done.stdout.strip()}')
    return done.stdout


def joint_of(axis: str) -> int:
    s = linuxcnc.stat()
    s.poll()
    written = linuxcnc.ini(s.ini_filename).find('TRAJ', 'COORDINATES') or 'XYZ'
    coordinates = ''.join(ch for ch in written if ch.isalpha()).upper()
    if axis not in coordinates:
        raise SystemExit(f'no {axis} joint in COORDINATES={coordinates}')
    return coordinates.index(axis)


def loaded() -> bool:
    return f'{NAME}.in' in hal('-s', 'show', 'pin', f'{NAME}.in', check=False)


def window(direction: str, position: float) -> tuple:
    # TRUE while min < in < max: past the surface in the probing direction.
    return (-FAR, position) if direction == '-' else (position, FAR)


def wire(axis: str, direction: str, position: float) -> None:
    unwire()
    joint = joint_of(axis)
    # Loaded once and left loaded: on the WO-1982 simulator an unloadrt of it
    # fails quietly and a second loadrt then fails (measured 2026-09-27).
    if not loaded():
        hal('loadrt', 'wcomp', f'names={NAME}')
    hal('addf', NAME, 'servo-thread')
    lo, hi = window(direction, position)
    hal('setp', f'{NAME}.min', repr(lo))
    hal('setp', f'{NAME}.max', repr(hi))
    hal('net', SIGNAL_POS, f'joint.{joint}.pos-fb', f'{NAME}.in')
    hal('net', SIGNAL_OUT, f'{NAME}.out', 'motion.probe-input')
    state = {'axis': axis, 'direction': direction, 'position': position}
    with open('/tmp/lcprobe.json', 'w', encoding='utf-8') as fh:
        json.dump(state, fh)


def move(position: float) -> None:
    with open('/tmp/lcprobe.json', encoding='utf-8') as fh:
        state = json.load(fh)
    lo, hi = window(state['direction'], position)
    hal('setp', f'{NAME}.min', repr(lo))
    hal('setp', f'{NAME}.max', repr(hi))
    state['position'] = position
    with open('/tmp/lcprobe.json', 'w', encoding='utf-8') as fh:
        json.dump(state, fh)


def unwire() -> None:
    hal('unlinkp', 'motion.probe-input', check=False)
    hal('delsig', SIGNAL_OUT, check=False)
    hal('delsig', SIGNAL_POS, check=False)
    if loaded():
        hal('delf', NAME, 'servo-thread', check=False)
    hal('setp', 'motion.probe-input', '0', check=False)


def main(argv: list) -> int:
    if not argv:
        print(__doc__)
        return 2
    verb = argv[0]
    if verb == 'wire':
        wire(argv[1].upper(), argv[2], float(argv[3]))
    elif verb == 'move':
        move(float(argv[1]))
    elif verb == 'unwire':
        unwire()
    elif verb == 'set':
        unwire()
        hal('setp', 'motion.probe-input', '1' if argv[1] in ('1', 'true', 'TRUE') else '0')
    else:
        print(__doc__)
        return 2
    print(hal('-s', 'show', 'pin', 'motion.probe-input').strip())
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
