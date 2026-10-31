#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""WO-2099 test fixture, SIMULATOR ONLY: a part on the simulator's table.

A userspace HAL component (LinuxCNC's own `hal` module) that reads the X, Y
and Z joint feedback positions every ~0.5 ms and drives `motion.probe-input`
TRUE while a tip of radius `tip` whose bottom is at that point touches the
part: a block with holes (bores, pockets), round bosses and a tool setter,
all in MACHINE coordinates (mm), from the JSON given as the first argument. LinuxCNC's own
motion controller latches `probed_position` when the input trips, so a G38
move stops on this part as it would on a real one (to the fixture's ~1 ms
latency - at 400 mm/min about 0.01 mm).

It exits (and HAL unlinks its pin) when killed. Never run it on a machine:
it takes over the probe input of the running HAL.

    python3 sim_part.py '{"tip": 1.5, "block": {"x0": 50, ...}, ...}'
"""

import json
import math
import signal
import subprocess
import sys
import time

import hal

NAME = 'lcpart'
SIGNAL = 'lcpart-touch'


def rect_dist(x, y, x0, x1, y0, y1):
    return math.hypot(max(x0 - x, 0.0, x - x1), max(y0 - y, 0.0, y - y1))


def in_hole(hole, x, y):
    if hole['kind'] == 'circle':
        return math.hypot(x - hole['cx'], y - hole['cy']) < hole['r']
    return hole['x0'] < x < hole['x1'] and hole['y0'] < y < hole['y1']


def hole_wall(hole, x, y):
    """XY distance from a point inside the hole to its wall."""
    if hole['kind'] == 'circle':
        return hole['r'] - math.hypot(x - hole['cx'], y - hole['cy'])
    return min(x - hole['x0'], hole['x1'] - x, y - hole['y0'], hole['y1'] - y)


def block_touch(block, holes, x, y, z, tip):
    if z > block['top'] + 1e-9:
        return False
    for hole in holes:
        if in_hole(hole, x, y):
            # Inside a hole: its wall within the tip radius, or its floor.
            return hole_wall(hole, x, y) <= tip + 1e-9 or z <= hole['floor'] + 1e-9
    return rect_dist(x, y, block['x0'], block['x1'], block['y0'], block['y1']) <= tip + 1e-9


def cylinder_touch(c, x, y, z, tip):
    return z <= c['top'] + 1e-9 and math.hypot(x - c['cx'], y - c['cy']) <= c['r'] + tip + 1e-9


def touching(part, x, y, z):
    """The controlled point is the TIP's bottom (the tool tip, as LienCAM's
    probe routines take it): a top is touched at its own Z, a side at the tip
    radius from it in XY - the model routineGuardedDescent.wo2073's fake board
    uses."""
    tip = float(part.get('tip', 0.0))
    if part.get('block') and block_touch(part['block'], part.get('holes', []), x, y, z, tip):
        return True
    return any(cylinder_touch(c, x, y, z, tip) for c in part.get('cylinders', []))


def main(argv):
    part = json.loads(argv[0])
    comp = hal.component(NAME)
    comp.newpin('touch', hal.HAL_BIT, hal.HAL_OUT)
    comp.ready()
    subprocess.run(['halcmd', 'unlinkp', 'motion.probe-input'], capture_output=True)
    subprocess.run(['halcmd', 'net', SIGNAL, f'{NAME}.touch', 'motion.probe-input'], check=True)
    running = [True]
    signal.signal(signal.SIGTERM, lambda *_: running.__setitem__(0, False))
    print(json.dumps({'ready': True, 'part': part}), flush=True)
    try:
        while running[0]:
            x = hal.get_value('joint.0.pos-fb')
            y = hal.get_value('joint.1.pos-fb')
            z = hal.get_value('joint.2.pos-fb')
            comp['touch'] = touching(part, x, y, z)
            time.sleep(0.0005)
    finally:
        comp['touch'] = False
        subprocess.run(['halcmd', 'unlinkp', 'motion.probe-input'], capture_output=True)
        subprocess.run(['halcmd', 'delsig', SIGNAL], capture_output=True)
        comp.exit()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
