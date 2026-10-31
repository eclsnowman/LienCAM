# SPDX-License-Identifier: GPL-3.0-or-later
"""A FAKE `linuxcnc` module for the gateway's unit tests (WO-1986).

NOT LinuxCNC and not evidence of how LinuxCNC behaves. The behaviours it
copies were MEASURED on the WO-1982 simulator (LinuxCNC 2.9.4, axis_mm) and are
marked so; the Tier 2 proof is sim_drive.py against the real thing.

  - RCS_DONE is 1, not 0 (LinuxCNC's constants; lcnc-suite's fake got this wrong).
  - While a program runs, AUTO_RUN / AUTO_PAUSE / AUTO_RESUME never read
    RCS_DONE: wait_complete times out (-1). Measured.
  - A home request while motion is in teleop mode reads RCS_DONE and does
    nothing. Measured.
  - A joint whose (shared) home switch is closed is refused on the error
    channel, one message per joint, while the others home. Measured.
  - teleop jogging needs every joint homed; joint jogging needs teleop off.
  - AUTO_RESUME in auto mode with nothing paused leaves the interpreter
    reading as busy (the next load is refused). Measured.
  - abort and E-STOP take effect at once but are ACKNOWLEDGED late: RCS_DONE
    ~100 ms (abort) and ~400 ms (E-STOP) after the call, while the status
    already shows the machine idle / in E-STOP. Measured (estop_raw.py, and
    the stopJob reply times in tier2-sim-drive.json).

Knobs (environment): FAKE_LCNC_COORDINATES ("XYZ", "XYYZ"), FAKE_LCNC_MIN_HARD_LIMIT
(comma list of joints whose min hard limit is tripped, in stat.joint[j] as on
LinuxCNC 2.9.4; stat.limit stays 0 - audit 16),
FAKE_LCNC_HANG ("mdi": an MDI never completes), FAKE_LCNC_SWITCH_CLOSED
(comma list of joints whose home switch is made), FAKE_LCNC_HOMED=1 (boot homed),
FAKE_LCNC_HOME_S (seconds one joint takes to home), FAKE_LCNC_HOME_FAILS (comma
list of joints whose homing stops WITHOUT setting the homed bit, with an error -
a stand-in for a switch that never trips; the sentence is the fake's, not
LinuxCNC's), FAKE_LCNC_JOG_ACK_S (seconds before a continuous jog reads
RCS_DONE; it moves at once), FAKE_LCNC_ABORT_ACK_S (seconds before an abort
reads RCS_DONE; default 0.1), FAKE_LCNC_RESUME_REFUSES (a sentence: an
AUTO_RESUME of a PAUSED program is refused with it and the program stays
paused - the sentence is the fake's, not LinuxCNC's).

A program line "(fake-error: <sentence>)" is an interpreter error when the
program reaches it: the sentence goes on the error channel and the program
ends there, as LinuxCNC aborts a program on an interpreter error (the
sentence is the fake's, not LinuxCNC's).

An MDI line that is one (LOGOPEN,<path>) / (LOG,<text>) / (LOGCLOSE) comment
writes the log file as LinuxCNC's interpreter does, #<n> in a LOG replaced by
that parameter's value (%f, machine units; the work-offset rows at #5221 +
20 x (P - 1) + axis). Measured on the WO-1982 simulator (audit 20): the file
is complete once the LOGCLOSE line completes, nothing goes on the error
channel, and three comments on one line write nothing.

A program line's M3/M4 S<rpm> turns the commanded spindle on; M5, M2 and M30
turn it off (audit 15). Program lines move no axis in this fake.

FAKE_LCNC_REFUSE_ABORT (any value): abort() of a RUNNING program is refused and it keeps
running (WO-1986 audit 9). FAKE_LCNC_HANG=abort: abort() of a RUNNING program
is never answered and it keeps running (WO-1986 audit 10). FAKE_LCNC_ABORT_RAISES
(any value): abort() of a RUNNING program raises and it keeps running (audit 12).
FAKE_LCNC_HOME_SYNC (comma list of joints, e.g. "1,2"): a synchronized group, as
a negative HOME_SEQUENCE makes it - homing any one homes them all, and a home of
an already-homed member is silently ignored (LinuxCNC ini-homing docs; audit 13).

FAKE_LCNC_ERROR_WITH_REFUSAL (a sentence): the first command refused while a
program runs is followed on the error channel, in the same read, by an
interpreter error with this sentence, and the program ends there - a genuine
program error colliding with a refusal (the sentence is the fake's).

FAKE_LCNC_PROBE (WO-2099, e.g. "Z-20"): a surface the probe input touches -
an MDI G38.2..G38.5 move crossing machine Z -20 stops there. Measured on the
WO-1982 simulator and copied: the G38 MDI answers RCS_DONE only when its move
ends; `probe_tripped` is cleared as a probe move starts and set on contact;
`probed_position` is MACHINE coordinates (the contact, or where a miss
ended); a G38.2/G38.4 miss answers RCS_DONE with "G38.2 move finished without
making contact." on the error channel - unless FAKE_LCNC_PROBE_ERROR_TAKEN is
set: Axis read that queue first (measured 4 times in 5), and the gateway sees
nothing; a probe move starting in contact is refused, "Probe is already
tripped when starting G38.2 or G38.3 move". G90/G91 are modal (default G90).

FAKE_LCNC_OTHER_CLIENT_ABORT_LINE (a line number): when the running program
reaches that line, ANOTHER LinuxCNC client (Axis's Stop on the machine PC)
aborts it through its own command channel (audit 14). Measured on the WO-1982
simulator: the abort leaves the machine idle and still exactly as an end does,
nothing on the error channel, and stat.mcodes[1] (the stopping group) at -1;
a program that ran to its M2/M30 reads 2/30 there, and a new run resets it.

M6 (WO-2100), measured on the WO-1982 simulator (src/tests/evidence/WO-2100/
m6-raw.txt): a program line's `M6` with a tool (its own T word, else the last T
read) other than the one in the spindle stops the program there - interp still
READING, motion queue empty, in position, `read_line` the M6 line - with
iocontrol's `tool-change` high and `tool-prep-number` the tool, until the pin
that answers it is set: `hal_manualtoolchange.change_button` (or, with
FAKE_HAL_TOOL_WIRING=unlinked, `iocontrol.0.tool-changed`) at 1, written by the
fake halcmd into FAKE_HAL_DIR/setp.json. Then `tool_in_spindle` is the tool and
the program runs on. An M6 to the tool already in the spindle asks nothing.
An abort or E-STOP drops the request with the tool unchanged. The pins are
shared with the fake halcmd through FAKE_HAL_DIR/iocontrol.json.
FAKE_LCNC_TOOL: the tool in the spindle at boot (default 0).

WCS rotation (WO-2185), measured on the WO-1982 simulator (.planning/
research-linuxcnc-g10-rotation-2026-09-29.md): `G10 L2 Pn R<deg>` sets that
system's rotation and leaves its X Y Z; a G10 without R leaves R; the active
system's rotation is `stat.rotation_xy`; R is parameter #5230 + 20 x (P - 1).
With FAKE_LCNC_INI naming an INI whose [RS274NGC] PARAMETER_FILE (relative to
the INI) exists, the fake restores each R from that file at start and writes
the file on every mode command and abort - NOT on the G10 - as LinuxCNC does
(src/tests/evidence/WO-2185/var-raw-2.txt). Moves are NOT rotated in this fake:
the rotated motion is proven on the real simulator (WO-2185 Tier 2).
"""

import os
import re
import time

version = '2.9.4-fake'

RCS_DONE, RCS_EXEC, RCS_ERROR = 1, 2, 3
STATE_ESTOP, STATE_ESTOP_RESET, STATE_OFF, STATE_ON = 1, 2, 3, 4
MODE_MANUAL, MODE_AUTO, MODE_MDI = 1, 2, 3
INTERP_IDLE, INTERP_READING, INTERP_PAUSED, INTERP_WAITING = 1, 2, 3, 4
TRAJ_MODE_FREE, TRAJ_MODE_COORD, TRAJ_MODE_TELEOP = 1, 2, 3
JOG_STOP, JOG_CONTINUOUS, JOG_INCREMENT = 0, 1, 2
AUTO_RUN, AUTO_PAUSE, AUTO_RESUME, AUTO_STEP = 0, 1, 2, 3
SPINDLE_FORWARD, SPINDLE_REVERSE, SPINDLE_OFF = 1, -1, 0
NML_ERROR, NML_TEXT, NML_DISPLAY = 1, 2, 3
OPERATOR_ERROR, OPERATOR_TEXT, OPERATOR_DISPLAY = 11, 12, 13

HOME_S = float(os.environ.get('FAKE_LCNC_HOME_S', '0.15'))
ABORT_ACK_S = float(os.environ.get('FAKE_LCNC_ABORT_ACK_S') or 0.1)
ESTOP_ACK_S = 0.4
LINE_S = 0.04
AXES = 'XYZABC'


class _World:
    def __init__(self):
        self.coords = re.sub(r'[^A-Z]', '', os.environ.get('FAKE_LCNC_COORDINATES', 'XYZ').upper())
        n = len(self.coords)
        self.n = n
        self.joint_pos = [0.0] * n
        booted_homed = os.environ.get('FAKE_LCNC_HOMED') == '1'
        self.homed = [booted_homed] * n
        self.homing_until = [None] * n
        self.switch_closed = {int(j) for j in os.environ.get('FAKE_LCNC_SWITCH_CLOSED', '').split(',') if j.strip()}
        self.home_fails = {int(j) for j in os.environ.get('FAKE_LCNC_HOME_FAILS', '').split(',') if j.strip()}
        self.task_state = STATE_ESTOP
        self.task_mode = MODE_MANUAL
        self.motion_mode = TRAJ_MODE_FREE
        self.interp = INTERP_IDLE
        self.g5x_index = 1
        self.offsets = {p: [0.0] * 9 for p in range(1, 10)}
        self.rotations = {p: 0.0 for p in range(1, 10)}
        self.var_file = _var_file()
        self.read_rotations()
        self.moves = []  # [(joint, target, velocity)]
        self.cont = {}   # joint -> velocity
        self.program = []
        self.program_file = ''
        self.line = 0
        self.next_line_at = None
        self.stop_code = -1  # stat.mcodes[1]: 2/30 once the program's M2/M30 ran
        self.feed = self.rapid = self.spindle_override = 1.0
        self.spindle = {'speed': 0.0, 'direction': 0, 'enabled': 0}
        self.errors = []
        self.serial = 0
        self.echo = 0
        self.status = RCS_DONE
        self.pending = {}  # serial -> (done_at, rc) for delayed completions
        self.last = time.monotonic()
        self.mdi_log = []
        self.probe = False
        self.incremental = False
        self.probe_tripped = False
        self.probed = [0.0] * 9
        self.tool_in_spindle = int(os.environ.get('FAKE_LCNC_TOOL') or 0)
        self.prepped = 0
        self.tool_wait = None  # the tool a program's M6 is waiting for
        self.publish_tools()

    def read_rotations(self):
        """WO-2185: LinuxCNC restores each system's R from its var file."""
        if not self.var_file or not os.path.exists(self.var_file):
            return
        with open(self.var_file, encoding='utf-8') as handle:
            for line in handle:
                parts = line.split()
                if len(parts) >= 2 and parts[0].isdigit():
                    p, rest = divmod(int(parts[0]) - 5230, 20)
                    if rest == 0 and 0 <= p < 9:
                        self.rotations[p + 1] = float(parts[1])

    def write_rotations(self):
        """WO-2185: LinuxCNC writes the var file on a mode change or abort."""
        if not self.var_file or not os.path.exists(self.var_file):
            return
        with open(self.var_file, encoding='utf-8') as handle:
            lines = handle.read().splitlines()
        keep = [line for line in lines if not (line.split() and line.split()[0] in
                                               {str(5230 + 20 * (p - 1)) for p in range(1, 10)})]
        keep += ['%d\t%f' % (5230 + 20 * (p - 1), r) for p, r in sorted(self.rotations.items())]
        with open(self.var_file, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(sorted(keep, key=lambda l: int(l.split()[0]) if l.split() else 0)) + '\n')

    # ---------------------------------------------------------- simulation
    def advance(self):
        now = time.monotonic()
        dt = now - self.last
        self.last = now
        for j, until in enumerate(self.homing_until):
            if until is not None and now >= until:
                self.homing_until[j] = None
                if j in self.home_fails:
                    self.error(f'fake: joint {j} homing ended without finding its switch')
                    continue
                self.homed[j] = True
                self.joint_pos[j] = 0.0
        for j, vel in list(self.cont.items()):
            self.joint_pos[j] += vel * dt
        still = []
        for j, target, vel in self.moves:
            step = vel * dt
            d = target - self.joint_pos[j]
            if abs(d) <= step:
                self.joint_pos[j] = target
            else:
                self.joint_pos[j] += step if d > 0 else -step
                still.append((j, target, vel))
        self.moves = still
        if self.tool_wait is not None and self.tool_answered():
            self.tool_in_spindle = self.tool_wait
            self.tool_wait = None
            self.publish_tools()
            if self.interp == INTERP_READING:
                self.next_line_at = now + LINE_S
        if (self.interp == INTERP_READING and self.tool_wait is None and self.next_line_at is not None
                and now >= self.next_line_at):
            self.line += 1
            if self.line <= len(self.program):
                self.spindle_words(self.program[self.line - 1])
                if self.tool_words(self.program[self.line - 1]):
                    self.next_line_at = None
                    return
            fault = re.search(r'\(fake-error:\s*(.*?)\)', self.program[self.line - 1]) if self.line <= len(self.program) else None
            if fault:
                self.error(fault.group(1))
                self.interp = INTERP_IDLE
                self.next_line_at = None
                self.status = RCS_DONE
            elif self.line >= len(self.program):
                self.interp = INTERP_IDLE
                self.next_line_at = None
                self.status = RCS_DONE
                # Measured: M2/M30 reads 2/30; a %-delimited end with neither, -1.
                ends = [m.group(2) for m in (re.match(r'^(N\d+\s*)?M0*(2|30)\b', ln.strip().upper())
                                             for ln in self.program) if m]
                self.stop_code = int(ends[0]) if ends else -1
            elif self.line == int(os.environ.get('FAKE_LCNC_OTHER_CLIENT_ABORT_LINE') or -1):
                command().abort()  # another client's own command channel
            else:
                self.next_line_at = now + LINE_S

    def spindle_words(self, text):
        # A program line's M3/M4 S<rpm> starts the spindle; M5, M2 and M30
        # stop it, as LinuxCNC does (audit 15: a run from a line must reach
        # its start line with the spindle on).
        code = re.sub(r'\(.*?\)|;.*', '', text).upper()
        m = re.search(r'\bM0*([2345]|30)\b', code)
        if not m:
            return
        if m.group(1) in ('3', '4'):
            s = re.search(r'S\s*([\d.]+)', code)
            speed = float(s.group(1)) if s else self.spindle['speed']
            self.spindle = {'speed': speed, 'direction': 1 if m.group(1) == '3' else -1, 'enabled': 1}
        else:
            self.spindle = {'speed': 0.0, 'direction': 0, 'enabled': 0}

    def tool_words(self, text):
        """WO-2100: T preselects; M6 to another tool waits for the answer."""
        code = re.sub(r'\(.*?\)|;.*', '', text).upper()
        t = re.search(r'\bT\s*(\d+)', code)
        if t:
            self.prepped = int(t.group(1))
        if not re.search(r'\bM0*6\b', code) or self.prepped == self.tool_in_spindle:
            return False
        self.tool_wait = self.prepped
        self.publish_tools()
        return True

    def tool_answered(self):
        folder = os.environ.get('FAKE_HAL_DIR')
        path = os.path.join(folder, 'setp.json') if folder else None
        if not path or not os.path.exists(path):
            return False
        import json
        try:
            with open(path, encoding='utf-8') as handle:
                pins = json.load(handle)
        except ValueError:
            return False
        pin = ('iocontrol.0.tool-changed' if os.environ.get('FAKE_HAL_TOOL_WIRING') == 'unlinked'
               else 'hal_manualtoolchange.change_button')
        return str(pins.get(pin)) == '1'

    def drop_tool_wait(self):
        if self.tool_wait is not None:
            self.tool_wait = None
            self.publish_tools()

    def publish_tools(self):
        folder = os.environ.get('FAKE_HAL_DIR')
        if not folder:
            return
        import json
        path = os.path.join(folder, 'iocontrol.json')
        with open(path + '.tmp', 'w', encoding='utf-8') as handle:
            json.dump({'tool-change': self.tool_wait is not None, 'tool-changed': False,
                       'tool-prep-number': self.tool_wait if self.tool_wait is not None else self.prepped,
                       'tool-number': self.tool_in_spindle}, handle)
        os.replace(path + '.tmp', path)

    def moving(self):
        return bool(self.moves) or bool(self.cont)

    def error(self, text):
        self.errors.append((OPERATOR_ERROR, text))

    def joints_of(self, letter):
        return [j for j, c in enumerate(self.coords) if c == letter]



def _var_file():
    """[RS274NGC] PARAMETER_FILE of FAKE_LCNC_INI, relative to that INI."""
    path = os.environ.get('FAKE_LCNC_INI')
    if not path:
        return None
    name = ini(path).find('RS274NGC', 'PARAMETER_FILE')
    return os.path.join(os.path.dirname(os.path.abspath(path)), name) if name else None


def _reset_world():
    global W
    W = _World()


class stat:
    def poll(self):
        W.advance()
        n = W.n
        self.task_state = W.task_state
        self.task_mode = W.task_mode
        self.interp_state = W.interp
        self.exec_state = 1
        self.motion_mode = W.motion_mode
        self.joints = n
        self.axis_mask = sum(1 << AXES.index(c) for c in set(W.coords))
        self.ini_filename = '/fake/sim.ini'
        self.linear_units = 1.0
        pos = [0.0] * 9
        for j, c in enumerate(W.coords):
            pos[AXES.index(c)] = W.joint_pos[j]
        self.actual_position = tuple(pos)
        self.position = tuple(pos)
        self.g5x_offset = tuple(W.offsets[W.g5x_index])
        self.g5x_index = W.g5x_index
        self.g92_offset = (0.0,) * 9
        self.tool_offset = (0.0,) * 9
        self.rotation_xy = W.rotations[W.g5x_index]
        self.homed = tuple(1 if h else 0 for h in W.homed) + (0,) * (16 - n)
        tripped = {int(k) for k in os.environ.get('FAKE_LCNC_MIN_HARD_LIMIT', '').split(',') if k.strip()}
        self.joint = tuple({'homed': 1 if W.homed[j] else 0, 'homing': 1 if W.homing_until[j] else 0,
                            'input': W.joint_pos[j], 'output': W.joint_pos[j], 'ferror_current': 0.0,
                            'fault': 0, 'min_hard_limit': 1 if j in tripped else 0, 'max_hard_limit': 0,
                            'min_soft_limit': 0, 'max_soft_limit': 0} for j in range(n)) + tuple({} for _ in range(16 - n))
        self.limit = (0,) * 16
        self.inpos = not W.moving() and (W.interp == INTERP_IDLE or W.tool_wait is not None)
        self.current_vel = 5.0 if W.moving() else 0.0
        self.queue = len(W.moves)
        self.paused = W.interp == INTERP_PAUSED
        self.feedrate = W.feed
        self.rapidrate = W.rapid
        self.spindle = ({'speed': W.spindle['speed'], 'direction': W.spindle['direction'],
                         'enabled': W.spindle['enabled'], 'override': W.spindle_override},)
        self.probe_val = W.probe
        self.probe_tripped = W.probe_tripped
        self.probed_position = tuple(W.probed)
        self.motion_line = W.line
        self.current_line = W.line
        self.mcodes = (W.line, W.stop_code, 5, -1, 9, -1, 48, -1, 53, 0)
        self.read_line = (W.line if W.tool_wait is not None else len(W.program)) if W.interp != INTERP_IDLE else 0
        self.tool_in_spindle = W.tool_in_spindle
        self.pocket_prepped = W.prepped
        self.file = W.program_file
        self.echo_serial_number = W.echo
        self.state = W.status


class error_channel:
    def poll(self):
        if W.errors:
            return W.errors.pop(0)
        return None


class ini:
    def __init__(self, path):
        self.path = path

    def find(self, section, key):
        if section == 'TRAJ' and key == 'COORDINATES':
            return ' '.join(W.coords)
        # WO-2097: FAKE_LCNC_INI names a real INI file whose other keys the
        # fake answers, first value wins as LinuxCNC's ini.find does.
        path = os.environ.get('FAKE_LCNC_INI')
        if not path:
            return None
        current = None
        with open(path, encoding='utf-8') as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line[0] in '#;':
                    continue
                if line.startswith('[') and line.endswith(']'):
                    current = line[1:-1].strip()
                elif current == section and '=' in line:
                    name, value = line.split('=', 1)
                    if name.strip() == key:
                        return value.strip()
        return None


class command:
    def __init__(self):
        self.serial = 0
        self._rc = RCS_DONE
        self._hang = False
        self._ack_at = 0.0

    # ------------------------------------------------------------ plumbing
    def _issue(self, rc=RCS_DONE, hang=False, ack_after=0.0):
        W.serial += 1
        W.echo = W.serial
        self.serial = W.serial
        self._rc = rc
        self._hang = hang
        self._ack_at = time.monotonic() + ack_after
        W.status = RCS_EXEC if hang else rc

    def wait_complete(self, timeout=5.0):
        W.advance()
        if self._hang:
            # Measured: nothing reads DONE while a program runs.
            if W.interp == INTERP_IDLE and self._hang == 'program':
                self._hang = False
                return RCS_DONE
            time.sleep(min(timeout, 0.005))
            return -1
        wait = self._ack_at - time.monotonic()
        if wait > 0:
            time.sleep(min(timeout, wait))
            if self._ack_at > time.monotonic():
                return -1
        return self._rc

    def _refuse(self, text):
        W.error(text)
        self._issue(RCS_ERROR)
        collide = os.environ.get('FAKE_LCNC_ERROR_WITH_REFUSAL')
        if collide and W.interp != INTERP_IDLE and not getattr(W, 'collided', False):
            W.collided = True
            W.error(collide)
            W.interp = INTERP_IDLE
            W.next_line_at = None

    # ------------------------------------------------------------ commands
    def state(self, s):
        if s == STATE_ESTOP:
            W.task_state = STATE_ESTOP
            W.moves, W.cont = [], {}
            W.drop_tool_wait()
            if W.interp != INTERP_IDLE:
                W.interp = INTERP_IDLE
                W.next_line_at = None
            return self._issue(ack_after=ESTOP_ACK_S)
        elif s == STATE_ESTOP_RESET:
            W.task_state = STATE_OFF if W.task_state == STATE_ESTOP else W.task_state
        elif s == STATE_ON:
            if W.task_state == STATE_ESTOP:
                return self._refuse("Can't turn machine on while in E-STOP")
            W.task_state = STATE_ON
        elif s == STATE_OFF:
            W.task_state = STATE_OFF
        self._issue()

    def mode(self, m):
        if W.interp != INTERP_IDLE and m != W.task_mode:
            return self._refuse("Can't switch mode while a program is running")
        W.task_mode = m
        W.write_rotations()  # WO-2185: a mode command writes the var file (measured)
        self._issue()

    def teleop_enable(self, on):
        if on and not all(W.homed):
            return self._refuse('all joints must be homed before going into teleop mode')
        W.motion_mode = TRAJ_MODE_TELEOP if on else TRAJ_MODE_FREE
        self._issue()

    def abort(self):
        if os.environ.get('FAKE_LCNC_REFUSE_ABORT') and W.interp != INTERP_IDLE:
            # Test knob (audit 9): LinuxCNC refuses the abort of a running
            # program; the program runs on.
            return self._refuse('fake: abort refused')
        if os.environ.get('FAKE_LCNC_HANG') == 'abort' and W.interp != INTERP_IDLE:
            # Test knob (audit 10): the abort of a running program is never
            # answered and the program runs on.
            return self._issue(hang=True)
        if os.environ.get('FAKE_LCNC_ABORT_RAISES') and W.interp != INTERP_IDLE:
            # Test knob (audit 12): issuing the abort of a running program
            # raises (a broken command channel); the program runs on.
            raise RuntimeError('fake: abort channel failed')
        W.moves, W.cont = [], {}
        W.drop_tool_wait()
        W.interp = INTERP_IDLE
        W.next_line_at = None
        W.status = RCS_DONE
        W.write_rotations()  # WO-2185: so does an abort (measured)
        self._issue(ack_after=ABORT_ACK_S)

    def unhome(self, j):
        for k in (range(W.n) if j == -1 else [j]):
            W.homed[k] = False
        self._issue()

    def home(self, j):
        if W.task_state != STATE_ON:
            return self._refuse("Can't home when the machine is not on")
        if W.motion_mode == TRAJ_MODE_TELEOP:
            self._issue()  # measured: DONE, and nothing happens
            return
        sync = {int(k) for k in os.environ.get('FAKE_LCNC_HOME_SYNC', '').split(',') if k.strip()}
        if j in sync and W.homed[j]:
            self._issue()  # documented: a rehome of a synchronized member is ignored
            return
        for k in (range(W.n) if j == -1 else sorted(sync) if j in sync else [j]):
            if k in W.switch_closed:
                W.error(f'Cannot home while shared home switch is closed j={k}')
                continue
            W.homed[k] = False
            W.homing_until[k] = time.monotonic() + HOME_S
        self._issue()

    def jog(self, kind, joint_mode, index, velocity=0.0, distance=0.0):
        if kind == JOG_STOP:
            if joint_mode:
                W.cont.pop(index, None)
                W.moves = [m for m in W.moves if m[0] != index]
            else:
                for j in W.joints_of(AXES[index]):
                    W.cont.pop(j, None)
                    W.moves = [m for m in W.moves if m[0] != j]
            return self._issue()
        if W.task_state != STATE_ON:
            return self._refuse("Can't jog when the machine is not on")
        if W.task_mode != MODE_MANUAL:
            return self._refuse("Can't jog when not in manual mode")
        if joint_mode:
            if W.motion_mode == TRAJ_MODE_TELEOP:
                return self._refuse("Can't joint-jog in teleop mode")
            joints = [index]
        else:
            if W.motion_mode != TRAJ_MODE_TELEOP:
                return self._refuse("Can't teleop-jog in joint mode")
            joints = W.joints_of(AXES[index])
        for j in joints:
            if kind == JOG_CONTINUOUS:
                W.cont[j] = float(velocity)
            else:
                W.moves.append((j, W.joint_pos[j] + float(distance), abs(float(velocity))))
        if kind == JOG_CONTINUOUS:
            return self._issue(ack_after=float(os.environ.get('FAKE_LCNC_JOG_ACK_S') or 0))
        self._issue()

    def mdi(self, text):
        if W.task_mode != MODE_MDI:
            return self._refuse("Can't send MDI when not in MDI mode")
        if W.task_state != STATE_ON:
            return self._refuse("Can't run MDI when the machine is not on")
        W.mdi_log.append(text)
        if os.environ.get('FAKE_LCNC_HANG') == 'mdi':
            return self._issue(hang=True)
        if self._log_comment(text):
            return self._issue()
        words = dict(re.findall(r'([A-Z])\s*(-?[\d.]+)', text.upper()))
        gs = re.findall(r'G\s*(\d+(?:\.\d)?)', text.upper())
        if any(float(g) > 99 for g in gs):
            return self._refuse('G-code out of range')
        if '10' in gs:
            p = int(float(words.get('P', W.g5x_index)))
            l = int(float(words.get('L', 2)))
            for i, a in enumerate('XYZABC'):  # audit 21: rotary rows too
                if a in words:
                    joints = W.joints_of(a)
                    pos = W.joint_pos[joints[0]] if joints else 0.0
                    W.offsets[p][i] = float(words[a]) if l == 2 else pos - float(words[a])
            if 'R' in words and l == 2:  # WO-2185: X Y Z untouched, as measured
                W.rotations[p] = float(words['R'])
            return self._issue()
        for g in gs:
            if g in ('54', '55', '56', '57', '58', '59'):
                W.g5x_index = int(g) - 53
            if g in ('90', '91'):
                W.incremental = g == '91'
        machine = '53' in gs
        probe = next((g for g in gs if g in ('38.2', '38.3', '38.4', '38.5')), None)
        targets = {}
        for i, a in enumerate('XYZ'):
            if a in words:
                joints = W.joints_of(a)
                here = W.joint_pos[joints[0]] if joints else 0.0
                if W.incremental and not machine:
                    targets[a] = here + float(words[a])
                else:
                    targets[a] = float(words[a]) + (0.0 if machine else W.offsets[W.g5x_index][i])
        if probe:
            return self._probe_move(probe, targets, float(words.get('F', 0) or 0) / 60.0)
        for a, target in targets.items():
            for j in W.joints_of(a):
                W.moves.append((j, target, 50.0))
        self._issue()

    def _probe_move(self, word, targets, velocity):
        surface = re.fullmatch(r'([XYZ])\s*(-?[\d.]+)', os.environ.get('FAKE_LCNC_PROBE', '').strip().upper())
        axis = next(iter(targets), None)
        if axis is None or velocity <= 0:
            return self._refuse('fake: a probe move needs one axis word and F')
        j = W.joints_of(axis)[0]
        here, target = W.joint_pos[j], targets[axis]
        step = target - here
        at = float(surface.group(2)) if surface and surface.group(1) == axis else None
        in_contact = at is not None and ((step < 0 and here <= at) or (step > 0 and here >= at))
        if in_contact:
            return self._refuse('Probe is already tripped when starting G38.2 or G38.3 move')
        hits = at is not None and min(here, target) <= at <= max(here, target)
        end = at if hits else target
        W.probe_tripped = hits
        W.probed = list(W.probed)
        for i, a in enumerate(AXES[:3]):
            joints = W.joints_of(a)
            W.probed[i] = W.joint_pos[joints[0]] if joints else 0.0
        W.probed[AXES.index(axis)] = end
        W.moves.append((j, end, velocity))
        if not hits and word in ('38.2', '38.4') and not os.environ.get('FAKE_LCNC_PROBE_ERROR_TAKEN'):
            W.error(f'G{word} move finished without making contact.')
        # Measured: the G38 MDI reads RCS_DONE only once its move has ended.
        self._issue(ack_after=abs(end - here) / velocity)

    @staticmethod
    def _log_comment(text):
        """An MDI line that is ONE LOGOPEN / LOG / LOGCLOSE comment (audit 20).
        #<n> in a LOG is the parameter's value, %f, machine units; the work
        systems live at #5221 + 20 x (P - 1) + axis. A line holding more
        than one comment writes nothing, as measured."""
        line = text.strip()
        if not re.fullmatch(r'\([^()]*\)', line):
            return False
        m = re.fullmatch(r'\((LOGOPEN|LOG|LOGCLOSE)(?:,(.*))?\)', line, re.IGNORECASE)
        if not m:
            return False
        kind, arg = m.group(1).upper(), m.group(2) or ''
        if kind == 'LOGOPEN':
            W.log_file = open(arg.strip(), 'w', encoding='utf-8')
        elif kind == 'LOGCLOSE':
            if getattr(W, 'log_file', None):
                W.log_file.close()
                W.log_file = None
        elif getattr(W, 'log_file', None):
            def value(n):
                p, i = divmod(int(n) - 5221, 20)
                if 0 <= p < 9 and i == 9:  # WO-2185: #5230 + 20 x (P - 1) is R
                    return '%f' % W.rotations[p + 1]
                return '%f' % (W.offsets[p + 1][i] if 0 <= p < 9 and 0 <= i < 9 else 0.0)
            W.log_file.write(re.sub(r'#(\d+)', lambda g: value(g.group(1)), arg) + '\n')
        return True

    def reset_interpreter(self):
        self._issue()

    def program_open(self, path):
        with open(path, encoding='utf-8') as handle:
            W.program = handle.read().splitlines()
        W.program_file = path
        W.line = 0
        W.stop_code = -1
        self._issue()

    def auto(self, kind, line=0):
        if W.task_mode != MODE_AUTO:
            return self._refuse("Can't run a program when not in auto mode")
        if kind == AUTO_RUN:
            if W.task_state != STATE_ON:
                return self._refuse("Can't run a program when the machine is not on")
            W.interp = INTERP_READING
            W.line = int(line)
            W.stop_code = -1
            W.next_line_at = time.monotonic() + LINE_S
            return self._issue(hang='program')
        if kind == AUTO_PAUSE:
            if W.interp == INTERP_READING:
                W.interp = INTERP_PAUSED
                W.next_line_at = None
            return self._issue(hang='program')
        if kind == AUTO_RESUME:
            refuses = os.environ.get('FAKE_LCNC_RESUME_REFUSES')
            if refuses and W.interp == INTERP_PAUSED:
                return self._refuse(refuses)
            if W.interp == INTERP_PAUSED:
                W.interp = INTERP_READING
                W.next_line_at = time.monotonic() + LINE_S
            elif W.interp == INTERP_IDLE:
                # Measured (WO-1986 attempt 3, simulator): AUTO_RESUME with
                # nothing paused left the interpreter reading as busy - the
                # next program_open was refused as "running". The fake keeps
                # it READING with nothing to read.
                W.interp = INTERP_READING
                W.next_line_at = None
            return self._issue(hang='program')
        if kind == AUTO_STEP:
            W.interp = INTERP_PAUSED
            W.line += 1
            if W.line >= len(W.program):
                # Audit 17: stepping onto the program end ends it, as real
                # LinuxCNC does (the end reads like a run to M2/M30).
                W.interp = INTERP_READING
                W.next_line_at = time.monotonic()
                W.line -= 1
            return self._issue(hang='program')

    def feedrate(self, v):
        W.feed = v
        self._issue()

    def rapidrate(self, v):
        W.rapid = v
        self._issue()

    def spindleoverride(self, v, spindle=0):
        W.spindle_override = v
        self._issue()

    def spindle(self, direction, speed=0.0, spindle=0, wait=False):
        if direction == SPINDLE_OFF:
            W.spindle = {'speed': 0.0, 'direction': 0, 'enabled': 0}
        else:
            if W.task_state != STATE_ON:
                return self._refuse("Can't start the spindle when the machine is not on")
            W.spindle = {'speed': float(speed), 'direction': direction, 'enabled': 1}
        self._issue()


# Created last: the world reads its INI (ini, above) as it starts.
W = _World()
