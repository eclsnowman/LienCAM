#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""WO-1986 test fixture, SIMULATOR ONLY: put the stock sim back where it boots.

LinuxCNC's sim configs simulate home switches from joint position, and the
axis_mm config shares one home switch between joints. A joint left on the
switch side by an earlier run makes LinuxCNC refuse to home the others -
"Cannot home while shared home switch is closed" (measured 2026-09-26). This
drives LinuxCNC directly (not through the gateway) to: E-STOP reset, machine
on, manual, joint mode, unhome all, and joint-jog every joint back to 0, which
is where the simulator boots and homes cleanly. Never run this on a machine.
"""

import json
import subprocess
import sys
import time

import linuxcnc

TIMEOUT = 20.0


def main() -> int:
    s = linuxcnc.stat()
    c = linuxcnc.command()
    s.poll()
    for state in (linuxcnc.STATE_ESTOP_RESET, linuxcnc.STATE_ON):
        c.state(state)
        c.wait_complete(2)
    c.abort()
    c.wait_complete(2)
    c.mode(linuxcnc.MODE_MANUAL)
    c.wait_complete(2)
    c.teleop_enable(0)
    c.wait_complete(2)
    c.unhome(-1)
    c.wait_complete(2)
    s.poll()
    joints = int(s.joints)
    for j in range(joints):
        pos = float(s.joint[j]['input'])
        if abs(pos) > 1e-4:
            c.jog(linuxcnc.JOG_INCREMENT, True, j, 20.0, -pos)
            c.wait_complete(2)
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        s.poll()
        if s.inpos and all(abs(float(s.joint[j]['input'])) < 1e-3 for j in range(joints)):
            break
        time.sleep(0.05)
    # The simulated switches compare MOTOR position (simulated_home.hal), and
    # a previous homing left a motor offset behind, so joint 0 can still sit
    # on the switch. Back each joint off until its switch opens.
    def closed(pin: str) -> bool:
        return subprocess.run(["halcmd", "getp", pin], capture_output=True, text=True).stdout.strip().upper() == "TRUE"
    backed = {}
    for j in range(joints):
        pin = f'joint.{j}.home-sw-in'
        steps = 0
        while steps < 20 and closed(pin):
            c.jog(linuxcnc.JOG_INCREMENT, True, j, 20.0, -2.0)
            c.wait_complete(2)
            end = time.monotonic() + 3
            while time.monotonic() < end:
                s.poll()
                if s.inpos:
                    break
                time.sleep(0.05)
            time.sleep(0.05)
            steps += 1
        backed[j] = steps
    s.poll()
    switches = {j: bool(closed(f"joint.{j}.home-sw-in")) for j in range(joints)}
    result = {'homed': list(s.homed)[:joints], 'joints': [round(float(s.joint[j]['input']), 4) for j in range(joints)],
              'taskState': s.task_state, 'backedOffSteps': backed, 'homeSwitchClosed': switches}
    print(json.dumps(result))
    return 0 if not any(switches.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
