# SPDX-License-Identifier: GPL-3.0-or-later
"""A FAKE `halcmd` for the gateway's unit tests (WO-2097). Pass it as
`gateway.py --halcmd testing/halcmd.py`.

NOT LinuxCNC. It answers only `-s show pin` and `-s show sig`, with lines
copied from the WO-1982 simulator's own `halcmd -s show pin|sig` (LinuxCNC
2.9.4, sim/axis/axis_mm.ini), trimmed to the pins the gateway reads - plus
`probe-in`, which that simulator does not wire, so the fake can show a linked
probe. FAKE_HALCMD_FAIL (a sentence): print it on stderr and exit 1, as
halcmd does when no HAL is running.

WO-2100: `show pin iocontrol.0.tool`, `show sig tool-changed`, `show pin
hal_manualtoolchange.change_button` and `setp <pin> <value>`, sharing the
tool-change pins with the fake linuxcnc module through FAKE_HAL_DIR (see
_tool_state and _setp); each setp is also appended to FAKE_HAL_DIR/setp.log.
"""

import json
import os
import sys

PINS = """\
motmod bit   IN FALSE motion.probe-input <== probe-in
iocontrol bit   IN FALSE iocontrol.0.emc-enable-in <== estop-loop
iocontrol bit   OUT FALSE iocontrol.0.user-enable-out ==> estop-loop
iocontrol bit   OUT FALSE iocontrol.0.coolant-flood ==> flood
iocontrol bit   OUT FALSE iocontrol.0.coolant-mist ==> mist
motmod bit   IN TRUE spindle.0.at-speed <== spindle-at-speed
motmod bit   OUT FALSE spindle.0.forward
motmod bit   OUT FALSE spindle.0.on
motmod bit   OUT FALSE spindle.0.reverse
motmod float IN 0 spindle.0.speed-in <== spindle-rps-filtered
motmod float OUT 0 spindle.0.speed-out ==> spindle-speed-cmd
"""

SIGS = """\
bit    FALSE  estop-loop ==> iocontrol.0.emc-enable-in <== iocontrol.0.user-enable-out
bit    FALSE  flood ==> and2.0.in0 <== iocontrol.0.coolant-flood
bit    FALSE  mist ==> and2.0.in1 <== iocontrol.0.coolant-mist
bit    FALSE  probe-in ==> motion.probe-input <== parport.0.pin-15-in
bit    TRUE  spindle-at-speed <== near_speed.out ==> spindle.0.at-speed
float  0  spindle-rps-filtered <== rpm_rps.out ==> spindle.0.speed-in
float  0  spindle-speed-cmd ==> limit_speed.in ==> near_speed.in1 <== spindle.0.speed-out
"""


def _tool_state():
    """WO-2100: iocontrol's tool pins as the fake linuxcnc module left them in
    FAKE_HAL_DIR/iocontrol.json (it runs inside the gateway; this is another
    process). Without FAKE_HAL_DIR: nothing is waiting."""
    state = {'tool-change': False, 'tool-changed': False, 'tool-prep-number': 0, 'tool-number': 0}
    folder = os.environ.get('FAKE_HAL_DIR')
    if folder and os.path.exists(os.path.join(folder, 'iocontrol.json')):
        with open(os.path.join(folder, 'iocontrol.json'), encoding='utf-8') as handle:
            state.update(json.load(handle))
    return state


def _bit(value):
    return 'TRUE' if value else 'FALSE'


def _tool_pins():
    """`show pin iocontrol.0.tool`, copied from the WO-1982 simulator. The
    wiring (FAKE_HAL_TOOL_WIRING): `manual` (default, the simulator's -
    hal_manualtoolchange answers), `unlinked` (tool-changed on no signal) or
    `other` (a component with no change_button answers)."""
    s = _tool_state()
    wiring = os.environ.get('FAKE_HAL_TOOL_WIRING', 'manual')
    changed = '' if wiring == 'unlinked' else ' <== tool-changed'
    return (f"iocontrol bit   OUT {_bit(s['tool-change'])} iocontrol.0.tool-change ==> tool-change\n"
            f"iocontrol bit   IN {_bit(s['tool-changed'])} iocontrol.0.tool-changed{changed}\n"
            f"iocontrol s32   OUT {s['tool-number']} iocontrol.0.tool-number\n"
            f"iocontrol s32   OUT {s['tool-prep-number']} iocontrol.0.tool-prep-number ==> tool-prep-number\n"
            f"iocontrol bit   OUT FALSE iocontrol.0.tool-prepare ==> tool-prep-loop\n"
            f"iocontrol bit   IN FALSE iocontrol.0.tool-prepared <== tool-prep-loop\n")


def _setp(pin, value):
    folder = os.environ.get('FAKE_HAL_DIR')
    if not folder:
        sys.stderr.write(f'fake halcmd: no FAKE_HAL_DIR for setp {pin}\n')
        return 1
    path = os.path.join(folder, 'setp.json')
    pins = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as handle:
            pins = json.load(handle)
    pins[pin] = value
    with open(path + '.tmp', 'w', encoding='utf-8') as handle:
        json.dump(pins, handle)
    os.replace(path + '.tmp', path)
    with open(os.path.join(folder, 'setp.log'), 'a', encoding='utf-8') as handle:
        handle.write(f'{pin} {value}\n')
    return 0


def main(argv):
    failure = os.environ.get('FAKE_HALCMD_FAIL')
    if failure:
        sys.stderr.write(failure + '\n')
        return 1
    args = [a for a in argv if a != '-s']
    if args == ['show', 'pin']:
        sys.stdout.write(PINS)
        return 0
    if args == ['show', 'sig']:
        sys.stdout.write(SIGS)
        return 0
    if args == ['show', 'pin', 'iocontrol.0.tool']:
        sys.stdout.write(_tool_pins())
        return 0
    if args == ['show', 'sig', 'tool-changed']:
        writer = 'atc.0.done' if os.environ.get('FAKE_HAL_TOOL_WIRING') == 'other' else 'hal_manualtoolchange.changed'
        sys.stdout.write(f'bit    FALSE  tool-changed <== {writer} ==> iocontrol.0.tool-changed\n')
        return 0
    if args == ['show', 'pin', 'hal_manualtoolchange.change_button']:
        sys.stdout.write('hal_manualtoolchange bit   IN FALSE hal_manualtoolchange.change_button\n')
        return 0
    if args[:2] == ['show', 'pin']:
        return 0  # a pin the fake HAL does not have: halcmd prints nothing
    if len(args) == 3 and args[0] == 'setp':
        return _setp(args[1], args[2])
    sys.stderr.write('fake halcmd: only "show pin", "show sig" and the WO-2100 tool pins\n')
    return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
