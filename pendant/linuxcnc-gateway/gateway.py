#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
#
# LienCAM LinuxCNC gateway (WO-1986).
#
# A separate process on the LinuxCNC PC. It imports LinuxCNC's own Python
# module (`linuxcnc`, the NML channels Axis and gmoccapy use - NOT
# linuxcncrsh) and speaks LienCAM's bridge protocol over a WebSocket -
# loopback by default, the network with `--host 0.0.0.0` (WO-2101): docs/machine/BRIDGE-PROTOCOL.md, with the LinuxCNC-specific
# facts in docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md.
#
# Arm's length on purpose (docs/research/2026-09-10-lcnc-suite-and-linuxcnc.md
# section 5): `import linuxcnc` makes this file a derivative of LinuxCNC
# (GPL-2-or-later), so it lives in its own process behind a documented socket.
# Ideas are from lcnc-suite's gateway (GPL-3, bildobodo/lcnc-suite); no code
# is copied from it.
#
# Standard library only, Python >= 3.9: nothing to pip-install on the machine.
#
# Threading: there is none. Every NML touch happens on the asyncio loop
# thread, so the non-thread-safe C extension is never entered twice. Ordinary
# calls are serialised behind one asyncio lock and wait for LinuxCNC in short
# slices, yielding between them; STOP calls use their own command channel and
# are issued the moment their frame is parsed, never behind that lock.

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import ipaddress
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

GATEWAY_NAME = 'liencam-linuxcnc-gateway/0.1'
PROTOCOL = 1
AXES = 'XYZABC'
# RFC 6455 section 1.3. A mistyped copy of this constant shipped in the first
# commit and passed every test, because the test client carried the same typo;
# headless Chromium refused it ("Incorrect 'Sec-WebSocket-Accept' header
# value"). The test client now takes it from the RFC, not from this file.
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
LOOPBACK_HOSTS = {'127.0.0.1', '::1', 'localhost'}

# Status cadence, BRIDGE-PROTOCOL.md "Cadence": on change, repeated at least
# every 100 ms, or every 500 ms only while CONFIDENTLY idle.
POLL_S = 0.02
REPEAT_S = 0.1
IDLE_REPEAT_S = 0.5
WAIT_SLICE_S = 0.005
STOP_ACK_S = 2.0
HOME_REFUSAL_WINDOW_S = 0.3
HOME_TIMEOUT_S = 120.0
# WO-2099: an awaited MDI line answers only when its move ENDS (measured on
# the WO-1982 simulator: RCS_DONE 4.06 s after a 20 mm G38.2 search at
# 300 mm/min; a 150 mm rapid to the tool setter outlasted the 5 s call
# deadline). So sendCommandAwait waits while LinuxCNC is visibly moving, up to
# this cap; `unknown` comes after --call-timeout with NO motion, or at the cap.
# The UCCNC bridge's probe call allows the same 5.5 minutes
# (uccncController.ts PROBE_CALL_TIMEOUT_MS).
MOTION_CAP_S = 330.0
# G38.2 .. G38.5 in an MDI line, comments removed first.
PROBE_WORD = re.compile(r'G\s*0*38\s*\.\s*([2-5])(?![0-9])', re.IGNORECASE)
REFUSAL_TEXT_WAIT_S = 0.2
# The continuous-jog deadman (controller.ts `jogHold`): a jog that runs until
# stopped is stopped by the gateway itself when the client's holds stop
# arriving - a frozen browser cannot drive an axis into a limit. 250 ms, the
# UCCNC bridge's window: the panel holds every 75 ms.
JOG_DEADMAN_S = 0.25
# How long a new connection waits for the last session's socket-loss stop to
# finish before it is refused (that stop waits up to 1 s for LinuxCNC's abort).
RELEASE_WAIT_S = 3.0
# WO-2101: a session from ANOTHER computer can die without a close - a pulled
# cable, a sleeping laptop - and TCP says nothing for minutes. So the gateway
# pings a network session and ends it (running the socket-loss stop) once
# nothing at all - a pong, a call, anything - has arrived for this long.
# Browsers and Node answer pings in their network stack, with no page code.
# A loopback session needs none: its socket closes when the page dies.
LINK_TIMEOUT_S = 1.0


# WO-2097: the standard LinuxCNC pins whose HAL links the Definition page
# shows - (group, pin). Motion's probe input, iocontrol's E-STOP chain and
# coolant outputs, and spindle 0's command/feedback pins. Pin names are
# LinuxCNC's own; what each is wired to is whatever the running HAL says.
IO_PINS = (
    ('probe', 'motion.probe-input'),
    ('estop', 'iocontrol.0.user-enable-out'),
    ('estop', 'iocontrol.0.emc-enable-in'),
    ('coolant', 'iocontrol.0.coolant-flood'),
    ('coolant', 'iocontrol.0.coolant-mist'),
    ('spindle', 'spindle.0.on'),
    ('spindle', 'spindle.0.forward'),
    ('spindle', 'spindle.0.reverse'),
    ('spindle', 'spindle.0.speed-out'),
    ('spindle', 'spindle.0.speed-in'),
    ('spindle', 'spindle.0.at-speed'),
)
SPINDLE_KEYS = ('MAX_FORWARD_VELOCITY', 'MIN_FORWARD_VELOCITY', 'MAX_REVERSE_VELOCITY', 'MIN_REVERSE_VELOCITY')
HAL_ARROWS = ('<==', '==>', '<=>')
HALCMD_TIMEOUT_S = 1.5  # two reads stay inside the client's 5 s hello wait

# WO-2100: LinuxCNC's own M6. iocontrol raises `tool-change` with the tool in
# `tool-prep-number` and waits - the program with it - until `tool-changed`
# rises. Measured on the WO-1982 simulator (src/tests/evidence/WO-2100/
# m6-raw.txt): the wait is interp READING with the motion queue empty and in
# position, so the pins are read (halcmd, ~1.5 ms) only then, at this cadence.
TOOL_PINS = 'iocontrol.0.tool'
TOOL_READ_S = 0.1
# Axis's hal_manualtoolchange answers with `changed`; its `change_button` input
# is LinuxCNC's own "Continue" for a button wired outside the dialog. Pressed,
# the change ended 167 ms later on the simulator; the press is released only
# once `tool-change` has fallen (a button left high would answer the NEXT M6
# the moment its dialog opened).
TOOL_ANSWER_S = 5.0


def now_ms() -> int:
    return int(time.time() * 1000)


def probe_word(text: str) -> Optional[str]:
    """The G38 word an MDI line runs ('G38.2' .. 'G38.5'), or None."""
    code = re.sub(r'\([^)]*\)|;.*', '', str(text))
    m = PROBE_WORD.search(code)
    return f'G38.{m.group(1)}' if m else None


# --------------------------------------------------------------------------
# WebSocket (RFC 6455), server and client, text frames only.
# --------------------------------------------------------------------------

class WsClosed(Exception):
    pass


def ws_unmask(data: bytes, mask: bytes, offset: int) -> bytes:
    """XOR `data` with the frame mask, `data` starting `offset` bytes into the payload."""
    n = len(data)
    if not n:
        return data
    k = offset % 4
    key = ((mask[k:] + mask[:k]) * (n // 4 + 1))[:n]
    return (int.from_bytes(data, 'big') ^ int.from_bytes(key, 'big')).to_bytes(n, 'big')


RX_CHUNK = 65536


async def ws_read_frame(reader: asyncio.StreamReader,
                        on_rx: Optional[Callable[[], None]] = None) -> Tuple[int, bytes, bool]:
    """One frame. `on_rx` runs each time bytes of it arrive, so a large frame
    still streaming in counts as a live link (WO-2101 link watch)."""
    head = await reader.readexactly(2)
    if on_rx:
        on_rx()
    fin = bool(head[0] & 0x80)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack('!H', await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack('!Q', await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b''
    parts: List[bytes] = []
    got = 0
    while got < length:
        chunk = await reader.read(min(RX_CHUNK, length - got))
        if not chunk:
            raise asyncio.IncompleteReadError(b''.join(parts), length)
        if on_rx:
            on_rx()
        parts.append(ws_unmask(chunk, mask, got) if masked else chunk)
        got += len(chunk)
    return opcode, b''.join(parts), fin


def ws_encode(opcode: int, payload: bytes, mask: bool) -> bytes:
    head = bytearray([0x80 | opcode])
    n = len(payload)
    bit = 0x80 if mask else 0
    if n < 126:
        head.append(bit | n)
    elif n < 65536:
        head.append(bit | 126)
        head += struct.pack('!H', n)
    else:
        head.append(bit | 127)
        head += struct.pack('!Q', n)
    if mask:
        key = os.urandom(4)
        head += key
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return bytes(head) + payload


class WsConnection:
    """One WebSocket end. `mask` is True for a client (RFC 6455 5.3)."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, mask: bool):
        self.reader = reader
        self.writer = writer
        self.mask = mask
        self.closed = False
        self.last_rx = time.monotonic()  # when bytes last arrived (WO-2101 link watch)

    async def send_text(self, text: str) -> None:
        if self.closed:
            raise WsClosed()
        self.writer.write(ws_encode(0x1, text.encode('utf-8'), self.mask))
        await self.writer.drain()

    def stamp_rx(self) -> None:
        self.last_rx = time.monotonic()

    async def recv_text(self) -> str:
        parts: List[bytes] = []
        while True:
            opcode, payload, fin = await ws_read_frame(self.reader, self.stamp_rx)
            if opcode == 0x8:
                self.closed = True
                try:
                    self.writer.write(ws_encode(0x8, payload[:2], self.mask))
                    await self.writer.drain()
                except Exception:
                    pass
                raise WsClosed()
            if opcode == 0x9:
                self.writer.write(ws_encode(0xA, payload, self.mask))
                await self.writer.drain()
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x0):
                parts.append(payload)
                if fin:
                    return b''.join(parts).decode('utf-8')
                continue
            raise WsClosed()  # binary frames are not part of this protocol

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            try:
                self.writer.write(ws_encode(0x8, struct.pack('!H', 1000), self.mask))
                await self.writer.drain()
            except Exception:
                pass
        try:
            self.writer.close()
        except Exception:
            pass


async def ws_client(host: str, port: int, timeout: float = 5.0) -> WsConnection:
    """A minimal client - used by the simulator drive and the tests."""
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write((
        f'GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n'
        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n').encode())
    await writer.drain()
    head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout)
    if b' 101 ' not in head.split(b'\r\n', 1)[0]:
        writer.close()
        raise ConnectionError(head.split(b'\r\n', 1)[0].decode(errors='replace'))
    return WsConnection(reader, writer, mask=True)


def peer_ip(address: Optional[str]) -> Optional[Any]:
    """The connecting computer's address as an ip_address (an IPv4-mapped IPv6
    address read as the IPv4 it carries), or None when it is not one."""
    if not address:
        return None
    try:
        ip = ipaddress.ip_address(address.split('%', 1)[0])
    except ValueError:
        return None
    return getattr(ip, 'ipv4_mapped', None) or ip


def is_loopback_peer(address: Optional[str]) -> bool:
    """True when the connecting computer is this one."""
    ip = peer_ip(address)
    return ip.is_loopback if ip is not None else (not address or address in LOOPBACK_HOSTS)


def origin_allowed(origin: Optional[str], extra: List[str], peer: Optional[str] = None) -> bool:
    """Loopback pages, the desktop shell's file:// origin ('null'), no Origin at
    all (a local script), an origin the operator named with --allow-origin, or
    (WO-2101) an http(s) page served from the connecting computer's own
    address - LienCAM opened by its network address on the PC it runs on.
    Any web page can open a WebSocket from the operator's browser; the Origin
    check is what stops a random site from jogging the machine."""
    if origin is None or origin == 'null' or origin in extra:
        return True
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    if parsed.scheme not in ('http', 'https', 'file', 'app'):
        return False
    host = parsed.hostname or ''
    if host in LOOPBACK_HOSTS | {''}:
        return True
    client = peer_ip(peer)
    return parsed.scheme in ('http', 'https') and client is not None and peer_ip(host) == client


# --------------------------------------------------------------------------
# LinuxCNC facade: the only code that touches the `linuxcnc` module.
# --------------------------------------------------------------------------

class Outcome:
    """ADR-0054 item 1: an ordinary command has THREE outcomes. `unknown` is
    the client having stopped waiting - it may still be doing it."""
    ACCEPTED = 'accepted'
    REFUSED = 'refused'
    UNKNOWN = 'unknown'


class Lcnc:
    def __init__(self, lc: Any, ini_path: Optional[str], halcmd: str = 'halcmd'):
        self.lc = lc
        self.halcmd = halcmd
        self.stat = lc.stat()
        self.stat.poll()
        self.cmd = lc.command()
        # STOP channel: its own NML command object, so a stop is never an
        # ordinary command waiting for another one's serial number.
        self.stop_cmd = lc.command()
        self.err = lc.error_channel()
        self.ini_path = ini_path or getattr(self.stat, 'ini_filename', None)
        self.coordinates = self._read_coordinates()
        self.axis_joints: Dict[str, List[int]] = {}
        for j, letter in enumerate(self.coordinates):
            self.axis_joints.setdefault(letter, []).append(j)
        self.axes = [a for a in AXES if a in self.axis_joints]
        self.var_path = self._read_var_path()
        self._var_seen: Optional[Tuple[int, int, float]] = None
        self._var_rotations: Optional[Dict[int, float]] = None
        self.var_written: Optional[float] = None  # the file's mtime (time.time() clock)

    def _read_var_path(self) -> Optional[str]:
        """WO-2185: LinuxCNC's parameter file ([RS274NGC] PARAMETER_FILE,
        relative to the INI's folder) - where it keeps every work system's
        offsets and rotation between runs."""
        if not self.ini_path:
            return None
        try:
            name = self.lc.ini(self.ini_path).find('RS274NGC', 'PARAMETER_FILE')
        except Exception:
            return None
        if not isinstance(name, str) or not name.strip():
            return None
        return os.path.join(os.path.dirname(os.path.abspath(self.ini_path)), os.path.expanduser(name.strip()))

    def var_rotations(self) -> Optional[Dict[int, float]]:
        """WO-2185: each work system's XY rotation (degrees) as LinuxCNC's
        parameter file holds it: G54 R is #5230 and each next system 20 on
        (G55 R = #5250), P 1..9. Measured on the WO-1982 simulator (LinuxCNC
        2.9.4, src/tests/evidence/WO-2185/var-raw*.txt): LinuxCNC restores R
        from this file at startup, but a G10 does NOT write it - LinuxCNC
        writes the whole file on its next mode change, abort or interpreter
        reset. So the file can be older than LinuxCNC's own value;
        `var_written` says when it was written. Re-read when the file
        changes, and at least once a second (a same-size rewrite inside one
        mtime tick); None when there is no file to read."""
        if not self.var_path:
            return None
        try:
            info = os.stat(self.var_path)
        except OSError:
            # A file being rewritten may be missing for a moment (not
            # measured): the last values read stand.
            return self._var_rotations
        now = time.monotonic()
        seen = self._var_seen
        if seen and seen[:2] == (info.st_mtime_ns, info.st_size) and now - seen[2] < 1.0:
            return self._var_rotations
        rotations: Dict[int, float] = {}
        try:
            with open(self.var_path, encoding='utf-8', errors='replace') as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) < 2 or not parts[0].isdigit():
                        continue
                    p, rest = divmod(int(parts[0]) - 5230, 20)
                    if rest != 0 or not 0 <= p < 9:
                        continue
                    try:
                        value = float(parts[1])
                    except ValueError:
                        continue
                    if math.isfinite(value):
                        rotations[p + 1] = value
        except OSError:
            return self._var_rotations
        self._var_seen, self._var_rotations = (info.st_mtime_ns, info.st_size, now), rotations
        self.var_written = info.st_mtime
        return rotations

    def _read_coordinates(self) -> str:
        """Joint -> axis letter, trivkins convention: [TRAJ]COORDINATES lists
        one letter per joint, so a slaved gantry reads XYYZ."""
        coords = None
        if self.ini_path:
            try:
                ini = self.lc.ini(self.ini_path)
                coords = ini.find('TRAJ', 'COORDINATES') or ini.find('KINS', 'COORDINATES')
            except Exception:
                coords = None
        if not coords:
            mask = int(getattr(self.stat, 'axis_mask', 7))
            coords = ''.join(a for i, a in enumerate(AXES) if mask & (1 << i))
        letters = re.sub(r'[^A-Za-z]', '', coords).upper()
        joints = int(getattr(self.stat, 'joints', len(letters)) or len(letters))
        return letters[:joints] if joints else letters

    # ---- WO-2097: the machine facts in LinuxCNC's own config, for the
    # Definition page. Values are the INI's own strings, in the INI's own
    # units (LINEAR_UNITS / ANGULAR_UNITS per second; RPM for spindles) - never
    # converted, never filled in: a key the INI does not set is null.
    def read_config(self) -> Dict[str, Any]:
        ini = None
        if self.ini_path:
            try:
                ini = self.lc.ini(self.ini_path)
            except Exception:
                ini = None

        def find(section: str, key: str) -> Optional[str]:
            if ini is None:
                return None
            try:
                value = ini.find(section, key)
            except Exception:
                return None
            return value.strip() if isinstance(value, str) and value.strip() else None

        axes = []
        for letter in self.axes:
            section = f'AXIS_{letter}'
            axes.append({
                'axis': letter,
                'units': find('TRAJ', 'ANGULAR_UNITS') if letter in 'ABC' else find('TRAJ', 'LINEAR_UNITS'),
                'minLimit': find(section, 'MIN_LIMIT'),
                'maxLimit': find(section, 'MAX_LIMIT'),
                'maxVelocity': find(section, 'MAX_VELOCITY'),
            })
        try:
            spindle_count = max(1, int(find('TRAJ', 'SPINDLES') or '1'))
        except ValueError:
            spindle_count = 1
        spindles = []
        for n in range(spindle_count):
            row: Dict[str, Any] = {'spindle': n}
            for key in SPINDLE_KEYS:
                row[key] = find(f'SPINDLE_{n}', key)
            spindles.append(row)
        return {
            'ini': self.ini_path,
            'linearUnits': find('TRAJ', 'LINEAR_UNITS'),
            'angularUnits': find('TRAJ', 'ANGULAR_UNITS'),
            'axes': axes,
            'spindles': spindles,
            'io': self.read_hal_io(),
        }

    def run_halcmd(self, *args: str) -> str:
        """`halcmd -s ...` on the RUNNING HAL: `show` (read-only), and `setp`
        only from set_pin. A `.py` halcmd is the test stand-in, run with this
        Python."""
        argv = [self.halcmd, '-s', *args]
        if self.halcmd.endswith('.py'):
            argv.insert(0, sys.executable)
        done = subprocess.run(argv, capture_output=True, text=True, timeout=HALCMD_TIMEOUT_S)
        if done.returncode != 0:
            raise RuntimeError((done.stderr or done.stdout).strip() or f'halcmd exited {done.returncode}')
        return done.stdout

    def read_hal_io(self) -> Dict[str, Any]:
        """Each IO_PINS pin: whether the running HAL has it, the signal it is
        on and every other pin on that signal (with halcmd's own arrows:
        `<==` drives the signal, `==>` reads it, `<=>` both)."""
        try:
            pin_text = self.run_halcmd('show', 'pin')
            sig_text = self.run_halcmd('show', 'sig')
        except Exception as error:
            return {'read': False, 'error': f'halcmd could not read the running HAL: {error}', 'pins': []}
        pins: Dict[str, Dict[str, Any]] = {}
        for line in pin_text.splitlines():
            tokens = line.split()
            # owner type dir value name [arrow signal]
            if len(tokens) < 5:
                continue
            signal = tokens[6] if len(tokens) >= 7 and tokens[5] in HAL_ARROWS else None
            pins[tokens[4]] = {'dir': tokens[2], 'signal': signal}
        signals: Dict[str, List[Dict[str, str]]] = {}
        for line in sig_text.splitlines():
            tokens = line.split()
            # type value name (arrow pin)*
            if len(tokens) < 3:
                continue
            ends = tokens[3:]
            signals[tokens[2]] = [{'arrow': ends[i], 'pin': ends[i + 1]}
                                  for i in range(0, len(ends) - 1, 2) if ends[i] in HAL_ARROWS]
        out = []
        for group, name in IO_PINS:
            pin = pins.get(name)
            signal = pin['signal'] if pin else None
            out.append({
                'group': group,
                'pin': name,
                'inHal': pin is not None,
                'dir': pin['dir'] if pin else None,
                'signal': signal,
                'linked': [end for end in signals.get(signal, []) if end['pin'] != name] if signal else [],
            })
        return {'read': True, 'error': None, 'pins': out}

    # ---- WO-2100: the tool-change handshake. Pin names are iocontrol's own;
    # what answers `tool-changed` is whatever the running HAL wires to it.
    @staticmethod
    def parse_pins(text: str) -> Dict[str, Dict[str, Any]]:
        """`halcmd -s show pin ...` -> name: {dir, value, signal}."""
        pins: Dict[str, Dict[str, Any]] = {}
        for line in text.splitlines():
            tokens = line.split()
            if len(tokens) < 5:
                continue
            signal = tokens[6] if len(tokens) >= 7 and tokens[5] in HAL_ARROWS else None
            pins[tokens[4]] = {'dir': tokens[2], 'value': tokens[3], 'signal': signal}
        return pins

    def read_tool_pins(self) -> Dict[str, Dict[str, Any]]:
        return self.parse_pins(self.run_halcmd('show', 'pin', TOOL_PINS))

    def tool_change_answer(self, tool_pins: Dict[str, Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
        """(what answers LinuxCNC's tool change, the pin LienCAM presses for
        the operator's Continue - or None when there is none it can press).
        `iocontrol.0.tool-changed` on no signal: that pin itself. On a signal
        driven by a component with an unlinked `change_button` input
        (hal_manualtoolchange): that input."""
        changed = tool_pins.get('iocontrol.0.tool-changed')
        if changed is None:
            return None, None
        signal = changed.get('signal')
        if not signal:
            return 'iocontrol.0.tool-changed', 'iocontrol.0.tool-changed'
        writer = None
        for line in self.run_halcmd('show', 'sig', signal).splitlines():
            tokens = line.split()
            if len(tokens) >= 3 and tokens[2] == signal:
                ends = tokens[3:]
                writer = next((ends[i + 1] for i in range(0, len(ends) - 1, 2) if ends[i] == '<=='), None)
        if writer is None or '.' not in writer:
            return writer, None
        button = writer.rsplit('.', 1)[0] + '.change_button'
        found = self.parse_pins(self.run_halcmd('show', 'pin', button)).get(button)
        if found is None or found['dir'] != 'IN' or found['signal']:
            return writer, None
        return writer, button

    def set_pin(self, pin: str, value: str) -> None:
        """`halcmd setp` on an UNLINKED input pin - the one write this gateway
        makes to the HAL (WO-2100: the operator's Continue at a tool change)."""
        self.run_halcmd('setp', pin, value)

    # ---- units: stat positions are MACHINE units; the wire is millimetres.
    def mm(self, value: float) -> float:
        lu = float(getattr(self.stat, 'linear_units', 1.0) or 1.0)
        return float(value) / lu

    def machine_units(self, mm: float) -> float:
        lu = float(getattr(self.stat, 'linear_units', 1.0) or 1.0)
        return float(mm) * lu

    def drain_errors(self) -> List[Tuple[str, str]]:
        out = []
        for _ in range(32):
            try:
                item = self.err.poll()
            except Exception:
                return out
            if not item:
                return out
            kind, text = item
            severity = 'error' if kind in (getattr(self.lc, 'NML_ERROR', 1), getattr(self.lc, 'OPERATOR_ERROR', 11)) else 'info'
            out.append((severity, str(text)))
        return out


class Gateway:
    def __init__(self, lcnc: Lcnc, program_dir: str, call_timeout: float, log: Callable[[str], None],
                 home_timeout: float = HOME_TIMEOUT_S, jog_deadman: float = JOG_DEADMAN_S,
                 motion_cap: float = MOTION_CAP_S, link_timeout: float = LINK_TIMEOUT_S):
        self.l = lcnc
        self.lc = lcnc.lc
        self.program_dir = program_dir
        self.call_timeout = call_timeout
        self.home_timeout = home_timeout
        self.motion_cap = motion_cap
        self.jog_deadman = jog_deadman
        self.link_timeout = link_timeout
        # When the running continuous jog is stopped unless a hold arrives
        # first (time.monotonic()); None = no continuous jog is held.
        self.jog_due: Optional[float] = None
        self.motion_stops = 0  # stops that end motion, so a start can tell one overtook it
        self.log = log
        self.lock = asyncio.Lock()
        self.conn: Optional[WsConnection] = None
        # The one-session slot: None = free; 'open' = a session holds it; a
        # Future = that session's socket is gone and its socket-loss stop is
        # still running (resolved once the slot is free). It is released only
        # after that stop, so the stop can never act on the next session.
        self.slot: Any = None
        self.send_lock = asyncio.Lock()
        self.errors: List[Tuple[int, str, str]] = []  # (serial, severity, text)
        # Serials of error-channel sentences that were a gateway call's own
        # refusal. LinuxCNC's error channel is shared; those belong to the call
        # that was refused, never to a running program.
        self.claimed: set = set()
        # Gateway commands still waiting for LinuxCNC's answer: an error read
        # meanwhile may yet turn out to be one of their refusals.
        self.answers_awaited = 0
        self.console_pending: List[Tuple[str, str]] = []
        self.error_serial = 0
        self.homing_cycle: Dict[str, Optional[int]] = {a: None for a in lcnc.axes}
        self.prev_homed: Optional[Dict[str, bool]] = None
        self.prev_alarm = {'estop': None, 'hard': None, 'soft': None}
        self.last_frame: Optional[str] = None
        self.last_sent = 0.0
        # A run from a line is one file: set-up lines, then the program from
        # its start line (audit 15). LinuxCNC numbers that file's lines; the
        # app knows its own program's. The first `line_head` file lines are
        # set-up (reported 0, as the text controllers' prelude is sourceLine
        # 0); file line line_head + 1 is program line line_from + 1.
        self.line_head = 0
        self.line_from = 0
        self.end_coded = True  # the loaded program ends in an M2/M30 (audit 14)
        self.single_block = False
        self.job: Optional[Dict[str, Any]] = None
        self.poll_ok = True
        self.last_status: Optional[Dict[str, Any]] = None
        # One generation per session. A call belongs to the session it arrived
        # on; losing that socket ends the generation, and nothing the dead
        # session sent may reach the machine or a later session after that.
        self.generation = 0
        self.ordinary_tasks: set = set()
        self.readback_serial = 0  # offset_row_mm: one tag per readback
        # WO-2185: each system's rotation as LinuxCNC last read back to this
        # gateway (setWorkOffset with r), and when (time.time()) - for a system
        # that is not active, newer than a parameter file written before it.
        self.rotations: Dict[str, Tuple[float, float]] = {}
        # WO-2100: LinuxCNC waiting at an M6 for the operator - {tool, line,
        # inSpindle, answeredBy, press} - or None. Read from iocontrol's pins.
        self.tool_change: Optional[Dict[str, Any]] = None
        self.tool_read_at = 0.0
        self.tool_read_failed: Optional[str] = None
        self.quiet_resume = False  # the last resume answered an MDI M6

    # ---------------------------------------------------------------- errors
    def pump_errors(self) -> List[Tuple[str, str]]:
        fresh = self.l.drain_errors()
        for severity, text in fresh:
            self.error_serial += 1
            self.errors.append((self.error_serial, severity, text))
            # Every message reaches the console, whichever path drained it -
            # LinuxCNC's error channel is read once and then it is gone.
            self.console_pending.append((severity, text))
        del self.errors[:-64]
        self.claimed &= {s for s, _sev, _t in self.errors}
        return fresh

    def claim_refusal(self, mark: int) -> Optional[str]:
        """A refused command claims exactly ONE sentence: the first unclaimed
        error read since `mark`, the command's own window. That sentence is
        the refusal its reply carries; any other error in the same window -
        a program's, say, arriving in the same poll - stays unclaimed."""
        for s, sev, text in self.errors:
            if s > mark and sev == 'error' and s not in self.claimed:
                self.claimed.add(s)
                return text
        return None

    def refusals_since(self, mark: int) -> List[str]:
        """The sentences commands issued since `mark` claimed as their refusal."""
        return [t for s, sev, t in self.errors if s > mark and sev == 'error' and s in self.claimed]

    def program_errors_since(self, serial: int) -> List[str]:
        return [t for s, sev, t in self.errors if s > serial and sev == 'error' and s not in self.claimed]

    # ------------------------------------------------------------ completion
    async def complete(self, cmd: Any, timeout: Optional[float] = None, motion_cap: Optional[float] = None) -> str:
        """Wait for LinuxCNC's RCS answer in short slices. RCS_DONE accepted,
        RCS_ERROR refused, no answer by the deadline UNKNOWN - never a guess.
        With `motion_cap` (WO-2099), the deadline moves on while LinuxCNC is
        moving, up to `motion_cap` seconds in all."""
        wait = timeout if timeout is not None else self.call_timeout
        started = time.monotonic()
        deadline = started + wait
        mark = self.error_serial
        self.answers_awaited += 1
        try:
            while True:
                r = cmd.wait_complete(WAIT_SLICE_S)
                if r == self.lc.RCS_DONE:
                    return Outcome.ACCEPTED
                if r == self.lc.RCS_ERROR:
                    # The refusal's SENTENCE travels on the error channel, which
                    # can lag the RCS_ERROR status: wait briefly for it, so the
                    # reply carries LinuxCNC's words rather than a bare "refused".
                    grace = time.monotonic() + REFUSAL_TEXT_WAIT_S
                    while True:
                        self.pump_errors()
                        if self.program_errors_since(mark) or time.monotonic() >= grace:
                            break
                        await asyncio.sleep(0.01)
                    self.claim_refusal(mark)
                    return Outcome.REFUSED
                if time.monotonic() >= deadline:
                    t = time.monotonic()
                    if motion_cap is None or t >= started + motion_cap or not self.moving():
                        return Outcome.UNKNOWN
                    deadline = min(t + wait, started + motion_cap)
                await asyncio.sleep(0.005)
        finally:
            self.answers_awaited -= 1

    def moving(self) -> bool:
        s = self.l.stat
        s.poll()
        return abs(float(s.current_vel)) > 1e-9 or int(s.queue) > 0 or not s.inpos

    async def observe(self, predicate: Callable[[Any], bool], timeout: float, mark: int) -> str:
        """Acceptance BY EFFECT. Measured on the WO-1982 simulator (LinuxCNC
        2.9.4): while a program runs, the task's RCS status stays EXEC, so
        AUTO_RUN, AUTO_PAUSE and AUTO_RESUME never read RCS_DONE - waiting for
        it reported every one of them as unknown. The evidence is gathered
        AFTER the command (ADR-0054 item 1): the state it asked for, or an
        error on LinuxCNC's error channel; neither by the deadline is UNKNOWN."""
        deadline = time.monotonic() + timeout
        self.answers_awaited += 1
        try:
            while True:
                self.l.stat.poll()
                if predicate(self.l.stat):
                    return Outcome.ACCEPTED
                self.pump_errors()
                if self.claim_refusal(mark) is not None:
                    return Outcome.REFUSED
                if time.monotonic() >= deadline:
                    return Outcome.UNKNOWN
                await asyncio.sleep(0.01)
        finally:
            self.answers_awaited -= 1

    async def wait_for(self, predicate: Callable[[Any], bool], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.l.stat.poll()
            if predicate(self.l.stat):
                return True
            await asyncio.sleep(0.02)
        return False

    async def ensure_mode(self, mode: int) -> Tuple[str, Optional[str]]:
        self.l.stat.poll()
        if self.l.stat.task_mode == mode:
            return Outcome.ACCEPTED, None
        mark = self.error_serial
        self.l.cmd.mode(mode)
        outcome = await self.complete(self.l.cmd)
        if outcome == Outcome.ACCEPTED:
            await self.wait_for(lambda s: s.task_mode == mode, 1.0)
            return outcome, None
        names = {self.lc.MODE_MANUAL: 'manual', self.lc.MODE_MDI: 'MDI', self.lc.MODE_AUTO: 'auto'}
        said = self.refusals_since(mark)
        because = f': {said[-1]}' if said else ''
        return outcome, f'LinuxCNC did not switch to {names.get(mode, mode)} mode{because}'

    # ---------------------------------------------------------------- status
    def axis_homed(self, stat: Any) -> Dict[str, bool]:
        homed = list(stat.homed)
        return {a: all(bool(homed[j]) for j in js) for a, js in self.l.axis_joints.items()}

    def build_status(self) -> Dict[str, Any]:
        lc, s, l = self.lc, self.l.stat, self.l
        try:
            s.poll()
            self.poll_ok = True
        except Exception as error:  # a status read that cannot ask reports unknown
            self.poll_ok = False
            return {'state': 'unknown', 'subState': None, 'machinePos': None, 'workPos': None,
                    'feedMmMin': None, 'spindleRpm': None, 'overrides': None, 'executingMoveId': None,
                    'buffer': None, 'inputs': None, 'homed': None, 'spindle': None,
                    'positionKnowledge': 'unknown', 'homingCycle': dict(self.homing_cycle),
                    'linuxcnc': {'pollError': str(error)}}
        pos = list(s.actual_position)
        g5x = list(s.g5x_offset)
        g92 = list(s.g92_offset)
        tool = list(s.tool_offset)
        rot = math.radians(float(getattr(s, 'rotation_xy', 0.0) or 0.0))

        def vec(values: List[float]) -> Dict[str, float]:
            out = {}
            for i, a in enumerate(AXES):
                if a in l.axis_joints or a in 'XYZ':
                    v = values[i] if i < len(values) else 0.0
                    out[a.lower()] = round(l.mm(v) if i < 3 else float(v), 6)
            return out

        work = [pos[i] - g5x[i] - tool[i] for i in range(len(pos))]
        if rot:
            x, y = work[0], work[1]
            work[0] = x * math.cos(-rot) - y * math.sin(-rot)
            work[1] = x * math.sin(-rot) + y * math.cos(-rot)
        work = [work[i] - g92[i] for i in range(len(work))]

        estop = s.task_state == lc.STATE_ESTOP
        # Audit 16: each JOINT's own limit flags (stat.joint[j], present on
        # LinuxCNC 2.9.4 - measured), never stat.limit, whose index the docs
        # call an axis: on XYYZ a joint-indexed read reported Z's limit as Y.
        # Bits: 1 min hard, 2 max hard, 4 min soft, 8 max soft.
        limits = [(1 if j.get('min_hard_limit') else 0) | (2 if j.get('max_hard_limit') else 0)
                  | (4 if j.get('min_soft_limit') else 0) | (8 if j.get('max_soft_limit') else 0)
                  for j in list(s.joint)[:len(l.coordinates)]]
        hard = any(int(m) & 3 for m in limits[:len(l.coordinates)])
        soft = any(int(m) & 12 for m in limits[:len(l.coordinates)])
        homed = self.axis_homed(s)
        interp = s.interp_state
        if estop or hard:
            state = 'alarm'
        elif interp == lc.INTERP_PAUSED or bool(getattr(s, 'paused', False)):
            state = 'hold'
        elif any(bool(j.get('homing')) for j in list(s.joint)[:len(l.coordinates)]):
            state = 'home'
        elif interp != lc.INTERP_IDLE:
            state = 'run'
        elif not s.inpos or abs(float(s.current_vel)) > 1e-9:
            # Measured on the WO-1982 simulator: `inpos` stays TRUE through a
            # teleop continuous jog, so velocity is read as well.
            state = 'jog' if s.task_mode == lc.MODE_MANUAL else 'run'
        elif s.task_state != lc.STATE_ON:
            state = 'alarm'  # machine OFF: LinuxCNC refuses motion until it is on
        else:
            state = 'idle'
        tool_change = self.watch_tool_change(s)
        if tool_change is not None and state == 'run':
            # WO-2100: LinuxCNC holds the program at its M6 until the operator
            # answers - a hold, which Cycle Start (resumeJob) answers.
            state = 'hold'

        def per_axis(bits: int) -> Optional[Dict[str, bool]]:
            if not all(a in l.axis_joints for a in 'XYZ'):
                return None
            return {a.lower(): any(int(limits[j]) & bits for j in l.axis_joints[a]) for a in 'XYZ'}

        spindle0 = s.spindle[0] if len(s.spindle) else {}
        joints = []
        for j, letter in enumerate(l.coordinates):
            jd = s.joint[j]
            joints.append({'joint': j, 'axis': letter, 'homed': bool(jd.get('homed')),
                           'homing': bool(jd.get('homing')), 'position': round(l.mm(jd.get('input', 0.0)) if letter in 'XYZ' else float(jd.get('input', 0.0)), 6),
                           'ferror': jd.get('ferror_current'), 'fault': bool(jd.get('fault'))})
        all_homed = all(homed.values()) if homed else False
        return {
            'state': state,
            'subState': None,
            'machinePos': vec(pos),
            'workPos': vec(work),
            'feedMmMin': round(l.mm(float(s.current_vel)) * 60.0, 3),
            # LinuxCNC's stat carries the COMMANDED spindle speed only; a
            # commanded number wearing a measured field's name is a lie.
            'spindleRpm': None,
            'overrides': {'feed': round(float(s.feedrate) * 100, 3),
                          'rapid': round(float(s.rapidrate) * 100, 3),
                          'spindle': round(float(spindle0.get('override', 1.0)) * 100, 3) if spindle0 else None},
            'executingMoveId': None,
            'buffer': {'moves': int(s.queue), 'capacitySeconds': None},
            'inputs': {'estop': estop, 'hardLimit': hard, 'softLimit': soft,
                       'probe': bool(s.probe_val), 'limits': per_axis(3), 'door': None,
                       'hold': bool(getattr(s, 'paused', False)),
                       'limitMinus': {a: any(int(limits[j]) & 1 for j in l.axis_joints[a]) for a in l.axes},
                       'limitPlus': {a: any(int(limits[j]) & 2 for j in l.axis_joints[a]) for a in l.axes}},
            'homed': homed,
            'spindle': None,
            # LinuxCNC keeps a real homed bit per joint, unlike UC100.
            'positionKnowledge': 'yes' if all_homed else 'no',
            'homingCycle': dict(self.homing_cycle),
            'linuxcnc': {
                'taskState': s.task_state, 'taskMode': s.task_mode, 'interpState': interp,
                'execState': s.exec_state, 'motionLine': self.program_line(s.motion_line),
                'currentLine': self.program_line(s.current_line),
                'readLine': self.program_line(s.read_line), 'file': s.file or None, 'wcsIndex': s.g5x_index,
                'wcsRotation': self.wcs_rotation(s),
                'spindleCommanded': {'speed': spindle0.get('speed'), 'direction': spindle0.get('direction'),
                                     'enabled': bool(spindle0.get('enabled'))} if spindle0 else None,
                'joints': joints,
                'toolChange': tool_change,
            },
        }

    def wcs_rotation(self, s: Any) -> Dict[str, Optional[float]]:
        """WO-2185: every work system's XY rotation, degrees CCW from +Z
        (LinuxCNC's `G10 L2 Pn R`). The ACTIVE system's is stat.rotation_xy,
        read this tick. The others are the newer of LinuxCNC's parameter file
        (written on LinuxCNC's mode changes, not on the G10 - measured) and
        what LinuxCNC last read back to this gateway; null = not known."""
        saved = self.l.var_rotations()
        written = self.l.var_written
        out: Dict[str, Optional[float]] = {}
        for p, wcs in enumerate(self.WCS, start=1):
            mine = self.rotations.get(wcs)
            if saved is not None and p in saved and (mine is None or (written is not None and written > mine[1])):
                value: Optional[float] = saved[p]
            else:
                value = mine[0] if mine else None
            out[wcs] = round(float(value), 6) if value is not None else None
        index = int(s.g5x_index or 0)
        if 1 <= index <= len(self.WCS):
            out[self.WCS[index - 1]] = round(float(getattr(s, 'rotation_xy', 0.0) or 0.0), 6)
        return out

    def watch_tool_change(self, s: Any) -> Optional[Dict[str, Any]]:
        """WO-2100: is LinuxCNC waiting at an M6 for the operator? iocontrol's
        `tool-change` high and `tool-changed` low. Read only while a program or
        MDI line is busy with its motion drained and in position - the shape
        of the wait, measured - and at most every TOOL_READ_S. The first read
        of a wait puts one console line up saying which tool to fit."""
        lc = self.lc
        if self.is_paused(s):
            return self.tool_change  # a pause on top of the wait: still waiting
        if s.interp_state == lc.INTERP_IDLE or int(s.queue) != 0 or not s.inpos:
            self.tool_change = None
            return None
        now = time.monotonic()
        if now < self.tool_read_at + TOOL_READ_S:
            return self.tool_change
        self.tool_read_at = now
        try:
            pins = self.l.read_tool_pins()
        except Exception as error:
            if self.tool_read_failed is None:
                said = (f'halcmd could not read iocontrol\'s tool-change pins ({error}), so a tool change '
                        'LinuxCNC asks for does not reach LienCAM - answer it on the LinuxCNC PC.')
                self.log(said)
                self.console_pending.append(('warn', said))
            self.tool_read_failed = str(error)
            self.tool_read_at = now + 2.0
            return self.tool_change
        self.tool_read_failed = None
        if pins.get('iocontrol.0.tool-change', {}).get('value') != 'TRUE' \
                or pins.get('iocontrol.0.tool-changed', {}).get('value') == 'TRUE':
            self.tool_change = None
            return None
        if self.tool_change is None:
            try:
                tool = int(pins.get('iocontrol.0.tool-prep-number', {}).get('value') or 0)
            except ValueError:
                tool = 0
            try:
                answered_by, press = self.l.tool_change_answer(pins)
            except Exception as error:
                answered_by, press = f'(halcmd: {error})', None
            line = self.program_line(s.read_line) if s.task_mode == lc.MODE_AUTO else 0
            in_spindle = int(getattr(s, 'tool_in_spindle', 0) or 0)
            self.tool_change = {'tool': tool, 'line': line or None, 'inSpindle': in_spindle,
                                'answeredBy': answered_by, 'press': press}
            fit = f'fit T{tool}' if tool > 0 else 'take the tool out'
            held = f'T{in_spindle} is in the spindle' if in_spindle > 0 else 'no tool is recorded in the spindle'
            where = f' on line {line}' if line else ''
            said = f'LinuxCNC is waiting at the tool change{where}: {fit} ({held}), then press Cycle Start.'
            if press is None:
                said += (f' LienCAM cannot answer it on this machine: {answered_by or "nothing in its HAL"} '
                         'answers LinuxCNC\'s tool change - answer it there.')
            self.console_pending.append(('info', said))
        return self.tool_change

    async def answer_tool_change(self):
        """WO-2100: the operator's Continue at LinuxCNC's M6 - the answering
        pin pressed until iocontrol drops `tool-change`, then released.
        Accepted only when LinuxCNC then has the requested tool in the
        spindle: the tool number and its length offset are LinuxCNC's own."""
        tc = self.tool_change
        press = tc['press']
        if press is None:
            return (False, None, f'LinuxCNC\'s tool change on this machine is answered by '
                    f'{tc["answeredBy"] or "nothing in its HAL"}, which LienCAM cannot press. Answer it '
                    'there; the program then continues.', Outcome.REFUSED)
        try:
            self.l.set_pin(press, '1')
        except Exception as error:
            return False, None, f'The tool change was not answered: halcmd could not set {press} ({error}).', Outcome.REFUSED
        fell = False
        try:
            deadline = time.monotonic() + TOOL_ANSWER_S
            while time.monotonic() < deadline:
                await asyncio.sleep(0.02)
                try:
                    pins = self.l.read_tool_pins()
                except Exception:
                    continue
                if pins.get('iocontrol.0.tool-change', {}).get('value') != 'TRUE':
                    fell = True
                    break
        finally:
            try:
                self.l.set_pin(press, '0')
            except Exception as error:
                said = (f'{press} could not be released ({error}): the next tool change may be answered '
                        'without anyone pressing Continue. Set it to 0 on the LinuxCNC PC (halcmd setp).')
                self.log(said)
                self.console_pending.append(('error', said))
        self.l.stat.poll()
        in_spindle = int(getattr(self.l.stat, 'tool_in_spindle', -1))
        tool = tc['tool']
        if fell:
            self.tool_change = None
            self.tool_read_at = 0.0
            if in_spindle == tool:
                return True, True, None, Outcome.ACCEPTED
            return False, None, f'LinuxCNC\'s tool change ended with T{in_spindle} in the spindle, not T{tool}.', Outcome.REFUSED
        return (False, None, f'LinuxCNC had not taken the tool change {TOOL_ANSWER_S:g} s after {press} was '
                'pressed. It may still - watch the status.', Outcome.UNKNOWN)

    def program_line(self, file_line: Any) -> int:
        """A line of the file LinuxCNC runs, as a line of the app's program:
        0 for a set-up line (audit 15)."""
        n = int(file_line or 0)
        return 0 if n <= self.line_head else n - self.line_head + self.line_from

    def confidently_idle(self, status: Dict[str, Any]) -> bool:
        inputs = status.get('inputs') or {}
        return (self.poll_ok and status['state'] == 'idle' and self.job is None
                and not inputs.get('estop') and not inputs.get('hardLimit') and not inputs.get('softLimit'))

    async def send(self, message: Dict[str, Any]) -> None:
        conn = self.conn
        if conn is None or conn.closed:
            return
        async with self.send_lock:
            try:
                await conn.send_text(json.dumps(message, separators=(',', ':')))
            except Exception:
                pass

    async def status_tick(self, force: bool = False) -> None:
        self.pump_errors()
        pending, self.console_pending = self.console_pending, []
        for severity, text in pending:
            await self.send({'t': 'console', 'v': {'dir': 'rx', 'text': text, 'severity': severity}})
        status = self.build_status()
        self.last_status = status
        await self.edges(status)
        frame = json.dumps(status, separators=(',', ':'), sort_keys=True)
        t = time.monotonic()
        repeat = IDLE_REPEAT_S if self.confidently_idle(status) else REPEAT_S
        if force or frame != self.last_frame or t - self.last_sent >= repeat:
            self.last_frame = frame
            self.last_sent = t
            await self.send({'t': 'status', 'v': status})

    async def edges(self, status: Dict[str, Any]) -> None:
        """homed, alarm and job-terminal pushes, each RAISED by the code that
        knows the outcome (BRIDGE-PROTOCOL.md contract v3)."""
        if status.get('homed') is not None:
            homed = status['homed']
            if self.prev_homed is not None:
                fresh = [a for a in self.l.axes if homed.get(a) and not self.prev_homed.get(a)]
                if fresh:
                    stamp = now_ms()
                    for a in fresh:
                        self.homing_cycle[a] = stamp
                    await self.send({'t': 'homed', 'v': {'axes': fresh, 'homingCycle': dict(self.homing_cycle)}})
            else:
                # A homed bit that was already set when this process started
                # has no cycle this process observed: stays null, never "now".
                pass
            self.prev_homed = dict(homed)
        inputs = status.get('inputs')
        if inputs is not None:
            for key, field, message in (('estop', 'estop', 'LinuxCNC is in E-STOP.'),
                                        ('hard', 'hardLimit', 'A hard limit input tripped.'),
                                        ('soft', 'softLimit', 'LinuxCNC stopped at a soft limit.')):
                value = bool(inputs[field])
                if value and self.prev_alarm[key] is False:
                    lost = key != 'soft' and status.get('positionKnowledge') != 'yes'
                    await self.send({'t': 'alarm', 'v': {'code': None, 'message': message, 'positionLost': lost}})
                    if self.job is not None and key != 'soft':
                        await self.finish_job('stopped', None)
                self.prev_alarm[key] = value
        await self.job_tick(status)

    async def job_tick(self, status: Dict[str, Any]) -> None:
        job = self.job
        lc, s = self.lc, self.l.stat
        if job is None or not self.poll_ok or job.get('stopping'):
            return
        if s.interp_state != lc.INTERP_IDLE:
            job['idleTicks'] = 0
            return
        # COMPLETED MEANS EXECUTED: interpreter idle, motion queue empty, in
        # position, and the position unchanged across two consecutive polls.
        position = tuple(round(float(v), 6) for v in s.actual_position[:6])
        if int(s.queue) == 0 and s.inpos and position == job.get('lastPosition'):
            job['idleTicks'] = job.get('idleTicks', 0) + 1
        else:
            job['idleTicks'] = 0
        job['lastPosition'] = position
        if job['idleTicks'] >= 2:
            # Only an error no gateway call has claimed as its own refusal is
            # the program's: a jog refused because the program is running
            # already said so in its reply. While a command still waits for
            # LinuxCNC's answer, an error may yet be its refusal - wait a tick.
            failures = self.program_errors_since(job['errorSerial'])
            if failures and self.answers_awaited:
                return
            if failures:
                await self.finish_job('failed', {'code': None, 'message': failures[-1],
                                                 'line': self.program_line(s.current_line) or None, 'moveId': None})
            elif self.ran_to_end(s, job):
                await self.finish_job('completed', None)
            else:
                # Idle and still short of the end: another LinuxCNC client
                # (Axis's Stop) aborted it. Not a finished part (audit 14).
                await self.finish_job('stopped', None)

    def ran_to_end(self, s: Any, job: Dict[str, Any]) -> bool:
        """An abort from another LinuxCNC client ends idle and still, exactly
        as the program's end does. Measured on the WO-1982 simulator (2.9.4):
        after the program's M2/M30, stat.mcodes[1] (the stopping group) reads
        2/30; after an abort it stays -1, with motion_line behind current_line
        (6 vs 11). A %-delimited program with no M2/M30 ends at -1 with them
        equal (13, 13) - the only end that leaves no stopping code."""
        if int(s.mcodes[1]) in (2, 30):
            return True
        return not job.get('endCoded', True) and int(s.motion_line) == int(s.current_line)

    async def finish_job(self, event: str, fault: Optional[Dict[str, Any]]) -> None:
        if self.job is None:
            return
        self.job = None
        await self.send({'t': 'jobEvent', 'v': {'event': event, 'fault': fault}})

    # ----------------------------------------------------------------- hello
    def hello(self) -> Dict[str, Any]:
        status = self.build_status()
        return {
            'protocol': PROTOCOL,
            'bridge': GATEWAY_NAME,
            'controller': 'linuxcnc',
            'linuxcncVersion': getattr(self.lc, 'version', None),
            'ini': self.l.ini_path,
            'coordinates': self.l.coordinates,
            'capabilities': {
                'geometryQueue': False,
                'executingMoveId': False,
                'bufferSeconds': False,
                'gcodeText': True,
                'perAxisHoming': True,
                'ownsSpindle': True,
                'spindleCommands': True,
                'overrides': {'feed': True, 'rapid': True, 'spindle': True},
            },
            'readOnly': False,
            'positionKnowledge': status.get('positionKnowledge', 'unknown'),
            'homingCycle': dict(self.homing_cycle),
            'vfd': {'present': False, 'verified': False, 'name': None},
            # WO-2097: read per session, from the INI/HAL LinuxCNC is running.
            'config': self.l.read_config(),
        }

    # ----------------------------------------------------------- stop paths
    # Never gated, never behind the ordinary lock, never waiting on an
    # ordinary command (ADR-0054 item 3). Each is issued synchronously on the
    # frame-read path, the moment the frame is parsed.
    def jog_stop_all(self) -> None:
        lc, sc = self.lc, self.l.stop_cmd
        self.l.stat.poll()
        teleop = self.l.stat.motion_mode == getattr(lc, 'TRAJ_MODE_TELEOP', 3)
        if teleop:
            for i, a in enumerate(AXES):
                if a in self.l.axis_joints:
                    sc.jog(lc.JOG_STOP, False, i)
        else:
            for j in range(len(self.l.coordinates)):
                sc.jog(lc.JOG_STOP, True, j)

    def program_active(self) -> bool:
        self.l.stat.poll()
        return self.l.stat.task_mode == self.lc.MODE_AUTO and self.l.stat.interp_state != self.lc.INTERP_IDLE

    def is_paused(self, s: Any) -> bool:
        return s.interp_state == self.lc.INTERP_PAUSED or bool(getattr(s, 'paused', False))

    def homing_now(self, s: Any) -> bool:
        return any(bool(j.get('homing')) for j in list(s.joint)[:len(self.l.coordinates)])

    def busy_refusal(self, what: str) -> Optional[str]:
        """The call table's state gate (queue/WO-1986, "Call table"). A call
        is refused here, before anything is sent, only in a state where the
        state it would be accepted by is ALREADY true - so no LinuxCNC answer
        could prove this call did anything. The UCCNC bridge refuses the same
        calls in the same states (Machine.cs RefuseMotion's long-operation
        gate, StartJob's "a program is already running", StepJob while the
        run owns the program)."""
        s = self.l.stat
        s.poll()
        if self.homing_now(s):
            return (f'LinuxCNC is homing, and the homing cycle owns the machine until it finishes, '
                    f'so {what} was not sent. Wait for it to finish, or stop it first.')
        if what in ('the program start', 'the single-block step', 'the program load'):
            running = s.interp_state != self.lc.INTERP_IDLE
            if running and self.is_paused(s) and what == 'the single-block step':
                return None  # stepping a paused program is what a step is
            if running and self.is_paused(s):
                return (f'A program is paused on LinuxCNC, so {what} was not sent. '
                        'Resume it with resumeJob, or stop it first.')
            if running:
                return (f'A program is already running on LinuxCNC, so {what} was not sent. '
                        'Pause it first, or stop it.' if what == 'the single-block step'
                        else f'A program is already running on LinuxCNC, so {what} was not sent. Stop it first.')
            if self.job is not None:
                return (f'The last program has not been reported finished yet, so {what} was not sent. '
                        'Wait for its end, or press Stop.')
        return None

    def stop_now(self, m: str) -> Tuple[bool, Any, Optional[str]]:
        lc, sc = self.lc, self.l.stop_cmd
        # A stop that ends motion ends the held jog: nothing is left for the
        # deadman. spindleOff moves nothing, so a jog running through it keeps
        # its deadman - disarming there would leave that jog unbounded.
        if m != 'spindleOff':
            self.jog_due = None
            self.motion_stops += 1
        if m == 'emergencyStop':
            sc.state(lc.STATE_ESTOP)
        elif m in ('jogCancel', 'jogStop'):
            self.jog_stop_all()
        elif m == 'stopJob' or m == 'reset':
            sc.abort()
        elif m == 'feedHold' or m == 'pauseJob':
            if self.program_active():
                if self.is_paused(self.l.stat):
                    # Already paused: the state it asks for already holds, and
                    # there is no transition to raise a `paused` event for.
                    return True, 'already paused', None
                sc.auto(lc.AUTO_PAUSE)
                return True, 'paused', None
            self.jog_stop_all()
        elif m == 'spindleOff':
            sc.spindle(lc.SPINDLE_OFF)
        return True, None, None

    # ------------------------------------------------------------- dispatch
    STOP_CALLS = ('emergencyStop', 'jogCancel', 'jogStop', 'stopJob', 'reset',
                  'feedHold', 'pauseJob', 'spindleOff')

    def hold_jog(self) -> bool:
        """`jogHold`: the operator is STILL holding the button - the
        continuous jog keeps running. It pushes the deadman back and touches
        nothing in LinuxCNC. It is never behind the ordinary lock: a keepalive
        queued behind a long call arrives late and stops a jog still held.
        With no continuous jog running it arms nothing (a hold that races
        ahead of its own jogStart is covered: the start arms the
        deadman when LinuxCNC takes the jog)."""
        if self.jog_due is None:
            return False
        self.jog_due = time.monotonic() + self.jog_deadman
        return True

    async def jog_deadman_watch(self) -> None:
        """Stops the continuous jog when its holds stop arriving. Its own
        task, not part of the status ticker: a stop must not depend on a
        reporting loop staying alive."""
        while True:
            await asyncio.sleep(POLL_S)
            due = self.jog_due
            if due is None or time.monotonic() <= due:
                continue
            # Disarm FIRST: a stop that throws must not be retried every tick.
            self.jog_due = None
            try:
                self.jog_stop_all()
                said = (f'The jog deadman fired - no jogHold arrived for {self.jog_deadman * 1000:g} ms, '
                        'so the jog was stopped. If the button was still held, the browser stopped '
                        'talking to this gateway.')
                severity = 'info'
            except Exception as error:
                said = (f'THE JOG DEADMAN COULD NOT STOP THE JOG: {error} - press Stop/Reset, '
                        'and the E-STOP if the machine is still moving.')
                severity = 'error'
            self.log(said)
            self.console_pending.append((severity, said))

    async def handle_frame(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if not isinstance(msg, dict) or msg.get('t') != 'call':
            return
        seq, m, a = msg.get('seq'), msg.get('m'), msg.get('a') or {}
        if m == 'jogHold':
            await self.reply(seq, True, self.hold_jog(), None, Outcome.ACCEPTED)
            return
        if m in self.STOP_CALLS:
            self.pump_errors()
            mark = self.error_serial
            ends_job = m in ('stopJob', 'reset', 'emergencyStop')
            if ends_job and self.job is not None:
                # BEFORE the stop is issued: LinuxCNC takes a task cycle or
                # more to acknowledge an abort (~100 ms measured on the
                # simulator), and in that window the machine goes idle and
                # still - which job_tick would otherwise read as COMPLETED.
                # A stop is never reported as a finished part.
                self.job['stopping'] = True
            try:
                _ok, kind, _e = self.stop_now(m)
            except Exception as error:
                # Nothing was issued: the program is still tracked, so its
                # real end is still reported (audit 12).
                if ends_job and self.job is not None:
                    self.job.pop('stopping', None)
                await self.reply(seq, False, None, f'LinuxCNC did not take the {m} command: {error}')
                return
            # The stop is ISSUED. Its acknowledgement (~400 ms for an E-STOP on
            # the simulator) is awaited off the frame-read path, so a second
            # stop arriving meanwhile is issued at once too, not queued.
            asyncio.ensure_future(self.acknowledge_stop(seq, m, kind, mark, ends_job, self.generation))
            return
        # Registered before it first runs, so a socket lost while it is still
        # only scheduled cancels it too.
        self.ordinary_tasks.add(asyncio.ensure_future(self.ordinary(seq, m, a, self.generation)))

    async def acknowledge_stop(self, seq: Any, m: str, kind: Any, mark: int, ends_job: bool,
                               generation: Optional[int] = None) -> None:
        # A stop's acceptance is still read, on the stop channel only. A
        # pause during a program is read by its effect (see observe()).
        if kind == 'paused':
            outcome = await self.observe(self.is_paused, STOP_ACK_S, mark)
        elif kind == 'already paused':
            outcome = Outcome.ACCEPTED  # nothing was sent; the pause already holds
        else:
            outcome = await self.complete(self.l.stop_cmd, STOP_ACK_S)
        if generation is not None and generation != self.generation:
            return  # its socket is gone: a later session never gets this reply
        if ends_job and self.job is not None:
            ended = self.abort_ended_program(outcome)
            if ended and outcome == Outcome.ACCEPTED:
                # Audit 18: stops share one command channel, so an 'accepted'
                # may be another stop's answer - the program is ended only
                # once LinuxCNC's interpreter actually goes idle.
                ended = await self.wait_for(lambda s: s.interp_state == self.lc.INTERP_IDLE, STOP_ACK_S)
                if not ended:
                    outcome = Outcome.UNKNOWN
            if ended:
                await self.finish_job('stopped', None)
            else:
                self.job.pop('stopping', None)
        if m == 'pauseJob' and kind == 'paused' and outcome == Outcome.ACCEPTED and self.job is not None:
            await self.send({'t': 'jobEvent', 'v': {'event': 'paused', 'fault': None}})
        if outcome == Outcome.ACCEPTED:
            await self.reply(seq, True, None, None, outcome)
        else:
            self.pump_errors()
            await self.reply(seq, False, None, self.sentence(m, outcome, self.refusals_since(mark), STOP_ACK_S), outcome)

    async def reply(self, seq: Any, ok: bool, value: Any, error: Optional[str], outcome: Optional[str] = None) -> None:
        out: Dict[str, Any] = {'t': 'reply', 'seq': seq, 'ok': ok}
        if ok and value is not None:
            out['v'] = value
        if not ok:
            out['error'] = error
        if outcome:
            out['outcome'] = outcome
        await self.send(out)

    def sentence(self, what: str, outcome: str, errors: List[str], waited: Optional[float] = None) -> str:
        if outcome == Outcome.UNKNOWN:
            return (f'LinuxCNC had not answered the {what} command after {waited or self.call_timeout:g} s. '
                    'It may still be doing it - watch the status before trying again.')
        if errors:
            return f'LinuxCNC refused {what}: {errors[-1]}'
        return f'LinuxCNC refused {what}.'

    async def ordinary(self, seq: Any, m: str, a: Dict[str, Any], generation: Optional[int] = None) -> None:
        if generation is None:
            generation = self.generation
        task = asyncio.current_task()
        self.ordinary_tasks.add(task)
        try:
            await self.run_ordinary(seq, m, a, generation)
        except asyncio.CancelledError:
            if generation == self.generation:
                raise
            # on_socket_lost cancelled it: the call dies with its socket.
            self.log(f'{m} (seq {seq}) dropped: the socket that sent it closed')
        finally:
            self.ordinary_tasks.discard(task)

    async def run_ordinary(self, seq: Any, m: str, a: Dict[str, Any], generation: int) -> None:
        handler = getattr(self, 'call_' + str(m), None)
        if handler is None:
            await self.reply(seq, False, None, f'The LinuxCNC gateway has no "{m}" call. '
                             'LinuxCNC\'s own INI configures this machine.')
            return
        async with self.lock:
            if generation != self.generation:
                # Queued on the lock when its socket closed: the socket-loss
                # stop has run, and nothing is issued after it.
                self.log(f'{m} (seq {seq}) dropped: the socket that sent it closed')
                return
            self.pump_errors()
            mark = self.error_serial
            try:
                ok, value, error, outcome = await handler(**a)
            except TypeError as error:
                await self.reply(seq, False, None, f'"{m}" was sent the wrong arguments: {error}')
                return
            except Exception as error:
                await self.reply(seq, False, None, f'The gateway failed running {m}: {error}')
                return
            if not ok and error is None:
                self.pump_errors()
                error = self.sentence(m, outcome or Outcome.REFUSED, self.refusals_since(mark))
        await self.reply(seq, ok, value, error, outcome)
        if ok and m in ('startJob', 'resumeJob', 'cycleResume') and outcome == Outcome.ACCEPTED \
                and not (m != 'startJob' and self.quiet_resume):
            await self.send({'t': 'jobEvent', 'v': {'event': 'started' if m == 'startJob' else 'resumed', 'fault': None}})

    def abort_ended_program(self, outcome: str) -> bool:
        """Did an abort end the program? Accepted yes, refused no; an
        unanswered one is read by its effect - the interpreter idle. Every
        abort path (resetToIdle, stopJob/reset/E-STOP, socket loss) asks this,
        so none reports a program stopped while it still runs (audits 10, 11)."""
        if outcome == Outcome.ACCEPTED:
            return True
        if outcome == Outcome.REFUSED:
            return False
        self.l.stat.poll()
        return self.l.stat.interp_state == self.lc.INTERP_IDLE

    async def run_cmd(self, issue: Callable[[], None], timeout: Optional[float] = None) -> Tuple[bool, Any, Optional[str], str]:
        issue()
        outcome = await self.complete(self.l.cmd, timeout)
        return outcome == Outcome.ACCEPTED, None, None, outcome

    # ----------------------------------------------------------------- calls
    async def call_queryStatus(self):
        await self.status_tick(force=True)
        return True, None, None, None

    async def call_resetToIdle(self):
        """E-STOP reset, then machine on - the two steps an operator presses on
        Axis. Replies { ok, reason } as the contract declares."""
        lc = self.lc
        # Its abort ends a running program. Marked BEFORE the abort, as the
        # stop calls do: an aborted program goes idle and still, which
        # job_tick would otherwise report as a COMPLETED part.
        if self.job is not None:
            self.job['stopping'] = True
        abort_mark = self.error_serial
        try:
            self.l.cmd.abort()
        except Exception:
            # Nothing was issued: keep tracking the program (audit 12).
            if self.job is not None:
                self.job.pop('stopping', None)
            raise
        aborted = await self.complete(self.l.cmd, 2.0)
        if aborted == Outcome.UNKNOWN and self.abort_ended_program(aborted):
            aborted = Outcome.ACCEPTED
        if aborted != Outcome.ACCEPTED:
            # A refused or unanswered abort stopped nothing: the reset did not
            # happen and a running program runs on - say so, never report
            # success (audits 9, 10).
            if self.job is not None:
                self.job.pop('stopping', None)
            self.pump_errors()
            reason = self.sentence('abort', aborted, self.refusals_since(abort_mark), 2.0)
            return True, {'ok': False, 'reason': reason}, None, aborted
        if self.job is not None:
            await self.finish_job('stopped', None)
        for state, label in ((lc.STATE_ESTOP_RESET, 'E-STOP reset'), (lc.STATE_ON, 'machine on')):
            mark = self.error_serial
            self.l.cmd.state(state)
            outcome = await self.complete(self.l.cmd)
            if outcome != Outcome.ACCEPTED:
                self.pump_errors()
                reason = self.sentence(label, outcome, self.refusals_since(mark))
                return True, {'ok': False, 'reason': reason}, None, outcome
        return True, {'ok': True, 'reason': None}, None, Outcome.ACCEPTED

    async def call_unlock(self):
        ok, value, _e, outcome = await self.call_resetToIdle()
        return bool(value and value['ok']), bool(value and value['ok']), (value or {}).get('reason'), outcome

    def joints_for(self, axis: str) -> List[int]:
        return self.l.axis_joints.get(str(axis).upper(), [])

    def homing_started(self, before: Tuple[bool, ...]) -> Callable[[Any], bool]:
        """Homing is read by its effect: a joint homing, or a homed flag that
        moved. Measured on the WO-1982 simulator: a home issued while motion
        was still in teleop mode read RCS_DONE and did NOTHING."""
        return lambda s: (any(bool(j.get('homing')) for j in list(s.joint)[:len(self.l.coordinates)])
                          or tuple(bool(h) for h in list(s.homed)[:len(self.l.coordinates)]) != before)

    async def joint_mode(self) -> None:
        """LinuxCNC homes in joint (free) mode; teleop left on by a jog makes a
        home request a no-op."""
        self.l.cmd.teleop_enable(0)
        await self.complete(self.l.cmd)
        await self.wait_for(lambda s: s.motion_mode != getattr(self.lc, 'TRAJ_MODE_TELEOP', 3), 1.0)

    async def call_home(self):
        busy = self.busy_refusal('the home request')
        if busy:
            return False, None, busy, Outcome.REFUSED
        outcome, why = await self.ensure_mode(self.lc.MODE_MANUAL)
        if outcome != Outcome.ACCEPTED:
            return False, None, why, outcome
        await self.joint_mode()
        self.pump_errors()
        mark = self.error_serial
        self.l.stat.poll()
        before = tuple(bool(h) for h in list(self.l.stat.homed)[:len(self.l.coordinates)])
        self.l.cmd.home(-1)
        outcome = await self.observe(self.homing_started(before), self.call_timeout, mark)
        if outcome == Outcome.ACCEPTED:
            # One joint starting is not the whole request: LinuxCNC refuses the
            # others one by one on its error channel ("Cannot home while
            # shared home switch is closed j=2", measured on the simulator
            # while Y homed). Give it a moment to say so.
            await asyncio.sleep(HOME_REFUSAL_WINDOW_S)
            self.pump_errors()
            refused = self.claim_refusal(mark)
            if refused is not None:
                return False, None, 'LinuxCNC refused part of the homing: ' + refused, Outcome.REFUSED
        ok = outcome == Outcome.ACCEPTED
        return ok, ok, None, outcome

    async def call_homeAxes(self, axes: List[str]):
        """Homes the JOINTS behind each letter, in the order asked. LinuxCNC
        owns its HOME_SEQUENCE; if it will not home a joint out of sequence it
        says so on its error channel and that sentence is the refusal - this
        gateway never reorders a request or refuses on LinuxCNC's behalf."""
        unknown = [a for a in axes if not self.joints_for(a)]
        if unknown:
            return False, None, f'This LinuxCNC machine has no {", ".join(unknown)} axis (COORDINATES={self.l.coordinates}).', Outcome.REFUSED
        busy = self.busy_refusal('the home request')
        if busy:
            return False, None, busy, Outcome.REFUSED
        outcome, why = await self.ensure_mode(self.lc.MODE_MANUAL)
        if outcome != Outcome.ACCEPTED:
            return False, None, why, outcome
        await self.joint_mode()
        done: List[str] = []
        # Audit 13: a synchronized group (negative HOME_SEQUENCE) homes as one
        # when any member is asked; LinuxCNC then ignores a home of the other
        # member. Every joint seen homing in this request is not asked again.
        n = len(self.l.coordinates)
        homed_here: set = set()

        def seen_homing(s: Any) -> None:
            for i, x in enumerate(list(s.joint)[:n]):
                if bool(x.get('homing')):
                    homed_here.add(i)

        for axis in axes:
            for j in self.joints_for(axis):
                if j in homed_here:
                    continue
                self.pump_errors()
                mark = self.error_serial
                self.l.stat.poll()
                before = tuple(bool(h) for h in list(self.l.stat.homed)[:len(self.l.coordinates)])
                self.l.cmd.home(j)
                started = self.homing_started(before)
                outcome = await self.observe(lambda s: (seen_homing(s), started(s))[1], self.call_timeout, mark)
                if outcome != Outcome.ACCEPTED:
                    return False, None, None, outcome
                # The reply is "boolean after all finish": a joint counts only
                # once its homing has STOPPED with its homed bit set. LinuxCNC
                # homes one request at a time, so the next joint waits for it.
                finished = await self.wait_for(
                    lambda s: (seen_homing(s), not any(bool(x.get('homing')) for x in list(s.joint)[:n]))[1],
                    self.home_timeout)
                self.l.stat.poll()
                homed_here.update(i for i, h in enumerate(list(self.l.stat.homed)[:n]) if h and not before[i])
                so_far = f' ({", ".join(done)} homed before it.)' if done else ''
                if not finished:
                    return False, None, (f'{axis} (joint {j}) was still homing after {self.home_timeout:g} s. '
                                         f'It may still be homing - watch the homed status before trying again.{so_far}'), Outcome.UNKNOWN
                self.l.stat.poll()
                if not bool(list(self.l.stat.homed)[j]):
                    self.pump_errors()
                    said = self.claim_refusal(mark)
                    because = ': ' + said if said is not None else '.'
                    return False, None, f'LinuxCNC stopped homing {axis} (joint {j}) without homing it{because}{so_far}', Outcome.REFUSED
            done.append(axis)
        return True, True, None, Outcome.ACCEPTED

    async def jog_target(self, axis: str) -> Tuple[Optional[Tuple[bool, int]], Optional[str]]:
        """(jointMode, index) for a jog, switching LinuxCNC between joint and
        teleop jogging as its homed state requires."""
        letter = str(axis).upper()
        js = self.joints_for(letter)
        if not js:
            return None, f'This LinuxCNC machine has no {letter} axis (COORDINATES={self.l.coordinates}).'
        busy = self.busy_refusal('the jog')
        if busy:
            return None, busy
        outcome, why = await self.ensure_mode(self.lc.MODE_MANUAL)
        if outcome != Outcome.ACCEPTED:
            return None, why
        homed = self.axis_homed(self.l.stat)
        if all(homed.values()):
            self.l.cmd.teleop_enable(1)
            await self.complete(self.l.cmd)
            await self.wait_for(lambda s: s.motion_mode == getattr(self.lc, 'TRAJ_MODE_TELEOP', 3), 1.0)
            return (False, AXES.index(letter)), None
        if len(js) > 1:
            return None, (f'{letter} is {len(js)} joints ({", ".join("joint " + str(j) for j in js)}). '
                          'Before homing LinuxCNC jogs joints one at a time, which would rack them; '
                          'home the machine and the jog moves them together.')
        self.l.cmd.teleop_enable(0)
        await self.complete(self.l.cmd)
        return (True, js[0]), None

    async def call_jog(self, axis: str, deltaMm: float, feedMmMin: float):
        target, why = await self.jog_target(axis)
        if target is None:
            return False, None, why, Outcome.REFUSED
        joint_mode, index = target
        vel = self.l.machine_units(abs(float(feedMmMin)) / 60.0)
        dist = self.l.machine_units(float(deltaMm)) if str(axis).upper() in 'XYZ' else float(deltaMm)
        ok, _v, err, outcome = await self.run_cmd(
            lambda: self.l.cmd.jog(self.lc.JOG_INCREMENT, joint_mode, index, vel, dist))
        return ok, ok, err, outcome

    async def call_jogStart(self, axis: str, direction: int, feedMmMin: float):
        target, why = await self.jog_target(axis)
        if target is None:
            return False, None, why, Outcome.REFUSED
        joint_mode, index = target
        vel = self.l.machine_units(abs(float(feedMmMin)) / 60.0) * (1 if int(direction) >= 0 else -1)
        # Read with no await before the jog is issued: a stop counted after
        # this point was issued after the jog, and has already stopped it.
        stops = self.motion_stops
        ok, _v, err, outcome = await self.run_cmd(
            lambda: self.l.cmd.jog(self.lc.JOG_CONTINUOUS, joint_mode, index, vel))
        if outcome != Outcome.REFUSED and self.motion_stops == stops:
            # Armed on every jog that may be running, an UNKNOWN one too: the
            # jog runs only while the client keeps holding it.
            self.jog_due = time.monotonic() + self.jog_deadman
        return ok, ok, err, outcome

    async def mdi(self, text: str, wait_motion: bool, timeout: Optional[float] = None,
                  motion_cap: Optional[float] = None) -> Tuple[bool, Optional[str], str]:
        outcome, why = await self.ensure_mode(self.lc.MODE_MDI)
        if outcome != Outcome.ACCEPTED:
            return False, why, outcome
        self.l.cmd.mdi(text)
        outcome = await self.complete(self.l.cmd, timeout, motion_cap)
        if outcome != Outcome.ACCEPTED:
            return False, None, outcome
        if wait_motion:
            lc = self.lc
            wait = timeout if timeout is not None else self.call_timeout
            started = time.monotonic()
            while True:
                done = await self.wait_for(lambda s: s.interp_state == lc.INTERP_IDLE and s.inpos and int(s.queue) == 0, wait)
                if done:
                    break
                if motion_cap is None or time.monotonic() >= started + motion_cap or not self.moving():
                    return False, None, Outcome.UNKNOWN
        self.pump_errors()
        return True, None, Outcome.ACCEPTED

    async def call_sendCommand(self, text: str):
        ok, why, outcome = await self.mdi(str(text), False)
        return ok, ok, why, outcome

    async def call_sendCommandAwait(self, text: str):
        mark = self.error_serial
        word = probe_word(text)
        ok, why, outcome = await self.mdi(str(text), True, motion_cap=self.motion_cap)
        # WO-2099 Tier 2: the answer means "the move has ended", and the client
        # acts on it at once - a probe cycle's next touch checks the machine is
        # idle. The status frame saying so used to follow on the next 20 ms
        # tick, so the check read the frame from DURING the move ("The machine
        # must be idle to start a probe cycle", measured on the simulator in a
        # Bore). The frame goes first.
        await self.status_tick(force=True)
        if ok and word:
            return self.probe_answer(word, mark)
        if ok:
            return True, {'ok': True, 'message': None}, None, outcome
        errors = self.refusals_since(mark)
        return True, {'ok': False, 'message': why or self.sentence('the MDI line', outcome, errors)}, None, outcome

    def probe_reading(self, word: str) -> Dict[str, Any]:
        """WO-2099: what LinuxCNC's status says about the probe move that just
        ended. `probed_position` is MACHINE coordinates (measured: G54 Z 5 set,
        a touch at machine Z -20 read -20.006, not -25), converted to mm;
        `probe_tripped` is cleared as each probe move starts, so read after an
        accepted G38 line it is that line's answer."""
        s = self.l.stat
        s.poll()
        probed = list(s.probed_position)
        at = {a.lower(): round(self.l.mm(probed[i]), 6) for i, a in enumerate('XYZ') if i < len(probed)}
        return {'word': word, 'tripped': bool(s.probe_tripped), 'at': at}

    def probe_answer(self, word: str, mark: int) -> Tuple[bool, Any, Optional[str], str]:
        """A G38 line LinuxCNC ran to its end. G38.2/G38.4 without contact is a
        miss: measured, LinuxCNC answers the MDI RCS_DONE, and its own sentence
        ("G38.2 move finished without making contact.") goes to whichever
        error-channel reader polls first - Axis took it 4 times in 5. So the
        miss is read from `probe_tripped`, and LinuxCNC's sentence is carried
        when the gateway got it. G38.3/G38.5 end quietly at the target."""
        probe = self.probe_reading(word)
        if probe['tripped'] or word in ('G38.3', 'G38.5'):
            return True, {'ok': True, 'message': None, 'probe': probe}, None, Outcome.ACCEPTED
        self.pump_errors()
        said = self.claim_refusal(mark)
        message = said or f"{word} move finished without making contact (LinuxCNC's probe input never tripped)."
        return True, {'ok': False, 'message': message, 'probe': probe}, None, Outcome.ACCEPTED

    async def call_jogToWorkXY(self, x: float, y: float, feedMmMin: float):
        busy = self.busy_refusal('the move')
        if busy:
            return False, None, busy, Outcome.REFUSED
        ok, why, outcome = await self.mdi(f'G21 G90 G1 X{float(x):.4f} Y{float(y):.4f} F{abs(float(feedMmMin)):.1f}', False)
        return ok, ok, why, outcome

    async def call_jogToMachineZ(self, z: float, feedMmMin: float):
        busy = self.busy_refusal('the move')
        if busy:
            return False, None, busy, Outcome.REFUSED
        ok, why, outcome = await self.mdi(f'G21 G90 G53 G1 Z{float(z):.4f} F{abs(float(feedMmMin)):.1f}', False)
        return ok, ok, why, outcome

    WCS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3']

    def active_wcs(self) -> str:
        self.l.stat.poll()
        index = int(self.l.stat.g5x_index or 1)
        return self.WCS[index - 1] if 1 <= index <= len(self.WCS) else 'G54'

    def active_offset_mm(self) -> Dict[str, float]:
        self.l.stat.poll()
        g5x = list(self.l.stat.g5x_offset)
        row = {a.lower(): round(self.l.mm(g5x[i]), 6) for i, a in enumerate('XYZ')}
        # Audit 21: the machine's rotary axes are in the row too (degrees).
        for a in self.rotary_axes():
            row[a.lower()] = round(float(g5x[3 + 'ABC'.index(a)]), 6)
        return row

    def rotary_axes(self) -> List[str]:
        return [a for a in 'ABC' if a in self.l.axes]

    async def call_selectWcs(self, wcs: str):
        if wcs not in self.WCS:
            return False, None, f'LinuxCNC has no work system called {wcs}.', Outcome.REFUSED
        ok, why, outcome = await self.mdi(wcs, True)
        return ok, ok, why, outcome

    async def call_zeroWorkAxis(self, axis: str):
        """G10 L20: set the ACTIVE system so the tool's current position reads
        zero. The receipt's offset is a READBACK of stat.g5x_offset after
        LinuxCNC applied it - LinuxCNC has the register the AXBB-E lacks."""
        letter = str(axis).upper()
        wcs = self.active_wcs()
        p = self.WCS.index(wcs) + 1
        ok, why, outcome = await self.mdi(f'G21 G10 L20 P{p} {letter}0', True)
        # Audit 19: BRIDGE-PROTOCOL.md's receipt, the shape the app's bridge
        # client reads - { ok, reason, wcs, axis, offset }, or a refusal.
        if not ok:
            return True, {'ok': False, 'reason': why, 'offset': None}, None, outcome
        return True, {'ok': True, 'reason': None, 'wcs': wcs, 'axis': letter.lower(),
                      'offset': self.active_offset_mm()}, None, outcome

    async def call_setWorkOffset(self, wcs: str, x: Optional[float] = None, y: Optional[float] = None,
                                 z: Optional[float] = None, a: Optional[float] = None,
                                 b: Optional[float] = None, c: Optional[float] = None, r: Any = None):
        """BRIDGE-PROTOCOL.md: setWorkOffset { wcs, x?, y?, z? } - flat axis
        arguments. An absent axis is left alone, never written as 0.

        WO-2185: `r` is the system's XY rotation in degrees - LinuxCNC's own
        `G10 L2 Pn R`: about the system's origin, CCW positive seen from +Z;
        a G10 with R and no X Y Z leaves them as they were, one without R
        leaves R (measured, docs/design/WCS-ROTATION.md); 0 clears it.
        LinuxCNC saves it to its parameter file on its next mode change and
        restores it at startup. With `r` the receipt also carries `rotation`,
        LinuxCNC's READBACK after the G10 (null when it could not be read)."""
        rotating = r is not None
        refused: Dict[str, Any] = {'ok': False, 'offset': None, **({'rotation': None} if rotating else {})}
        if wcs not in self.WCS:
            return True, {**refused, 'reason': f'LinuxCNC has no work system called {wcs}.'}, None, Outcome.REFUSED
        if rotating:
            try:
                value = float(r)
            except (TypeError, ValueError):
                value = math.nan
            if isinstance(r, bool) or not math.isfinite(value):
                return True, {**refused, 'reason': f'A rotation of {r} is not a number of degrees.'}, None, Outcome.REFUSED
        offset = {k: v for k, v in (('x', x), ('y', y), ('z', z), ('a', a), ('b', b), ('c', c)) if v is not None}
        if rotating:
            offset['r'] = value
        words = ' '.join(f'{k.upper()}{float(v):.6f}' for k, v in offset.items())
        if not words:
            return True, {**refused, 'reason': 'No axis value was given to set.'}, None, Outcome.REFUSED
        p = self.WCS.index(wcs) + 1
        mark = self.error_serial
        ok, why, outcome = await self.mdi(f'G21 G10 L2 P{p} {words}', True)
        if not ok:
            what = 'the work rotation' if rotating and len(offset) == 1 else 'the work offset'
            reason = why or self.sentence(what, outcome, self.refusals_since(mark))
            return True, {**refused, 'reason': reason}, None, outcome
        rotation: Optional[float] = None
        if wcs == self.active_wcs():
            row = self.active_offset_mm()  # a real readback for the active system
            if rotating:
                rotation = round(float(getattr(self.l.stat, 'rotation_xy', 0.0) or 0.0), 6)
        else:
            if rotating:
                read = await self.read_params([5210 + 20 * p])
                rotation = round(read[0], 6) if read else None
            # Audit 20: the WHOLE row BRIDGE-PROTOCOL.md requires, read back
            # from LinuxCNC - never the axes just written. None when LinuxCNC
            # could not be read: the app then records nothing.
            row = await self.offset_row_mm(p)
        if not rotating:
            return True, {'ok': True, 'reason': None, 'offset': row}, None, outcome
        if rotation is not None:
            self.rotations[wcs] = (rotation, time.time())
        return True, {'ok': True, 'reason': None, 'offset': row, 'rotation': rotation}, None, outcome

    async def offset_row_mm(self, p: int) -> Optional[Dict[str, float]]:
        """One work system's row as LinuxCNC now holds it, in mm (audit 20).

        stat carries only the ACTIVE system (g5x_offset); every system lives
        in LinuxCNC's parameters, G54 X at #5221 and each next system 20 on
        (G55 X = #5241). The interpreter writes them out with its own
        LOGOPEN/LOG/LOGCLOSE comments, into a file this gateway reads - the
        gateway runs on the machine PC beside LinuxCNC, as the program files
        it writes for LinuxCNC to open do. Measured on the WO-1982 simulator
        (LinuxCNC 2.9.4): the file is complete once the LOGCLOSE line
        completes (50/50), nothing reaches the error channel, and the values
        are MACHINE units (G20 G10 L2 X1 on the mm sim logged 25.400000) -
        converted here exactly as g5x_offset is. A (DEBUG, ...) readback on
        the error channel was measured and rejected: that channel is a queue
        Axis also reads, and 23 of 100 DEBUG lines never reached this
        gateway. The three comments must be three MDI lines (on one line the
        log was never written - measured)."""
        base = 5201 + 20 * p
        rotary = self.rotary_axes()
        values = await self.read_params([base, base + 1, base + 2] + [base + 3 + 'ABC'.index(a) for a in rotary])
        if values is None:
            return None
        row = {a: round(self.l.mm(v), 6) for a, v in zip('xyz', values)}
        # Audit 21: rotary axes are degrees - no length conversion.
        row.update({a.lower(): round(v, 6) for a, v in zip(rotary, values[3:])})
        return row

    async def read_params(self, params: List[int]) -> Optional[List[float]]:
        """LinuxCNC's own values of numbered parameters, through its
        LOGOPEN/LOG/LOGCLOSE comments (offset_row_mm says why that way).
        None when any line was not run or the file does not hold them all."""
        self.readback_serial += 1
        tag = f'LCGW{os.getpid()}-{self.readback_serial}'
        path = self.readback_path()
        try:
            os.remove(path)
        except OSError:
            pass
        done = True
        for line in (f'(LOGOPEN,{path})', f'(LOG,{tag} ' + ' '.join(f'#{n}' for n in params) + ')', '(LOGCLOSE)'):
            ok, _why, _outcome = await self.mdi(line, True)
            done = done and ok
        try:
            with open(path, encoding='utf-8') as handle:
                text = handle.read()
        except OSError:
            return None
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        m = re.fullmatch(re.escape(tag) + r' (\S+)' * len(params), text.strip())
        if not done or not m:
            return None
        try:
            values = [float(v) for v in m.groups()]
        except ValueError:
            return None
        if not all(math.isfinite(v) for v in values):
            return None
        return values

    def readback_path(self) -> str:
        """The file LinuxCNC's LOG comment writes: beside the programs this
        gateway hands LinuxCNC, unless that path holds a character that would
        end or split the comment."""
        name = f'.lcgw-offset-{os.getpid()}.txt'
        folder = os.path.abspath(self.program_dir)
        if re.search(r'[(),;\s]', folder):
            folder = tempfile.gettempdir()
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, name)

    async def call_setOverride(self, change: Dict[str, Any]):
        lc, s = self.lc, self.l.stat
        s.poll()
        kind = change.get('kind')
        current = {'feed': float(s.feedrate), 'rapid': float(s.rapidrate),
                   'spindle': float(s.spindle[0].get('override', 1.0)) if len(s.spindle) else 1.0}.get(kind)
        if current is None:
            return False, None, f'LinuxCNC has no "{kind}" override.', Outcome.REFUSED
        to = change.get('to')
        if to == 'reset':
            value = 1.0
        elif to == 'percent':
            value = float(change.get('percent')) / 100.0
        else:
            value = current + (0.1 if change.get('coarse') else 0.01) * (1 if int(change.get('direction', 1)) >= 0 else -1)
        value = max(0.0, value)
        issue = {'feed': lambda: self.l.cmd.feedrate(value), 'rapid': lambda: self.l.cmd.rapidrate(value),
                 'spindle': lambda: self.l.cmd.spindleoverride(value)}[kind]
        return await self.run_cmd(issue)

    async def call_spindleOn(self, direction: str, rpm: float):
        lc = self.lc
        # Only the two directions the protocol names start a spindle; anything
        # else is a malformed frame, never a guess at reverse (audit 8).
        turn = str(direction).strip().lower()
        if turn not in ('cw', 'ccw'):
            return False, None, f'Spindle direction "{direction}" is not cw or ccw.', Outcome.REFUSED
        try:
            speed = float(rpm)
        except (TypeError, ValueError):
            speed = float('nan')
        if not math.isfinite(speed) or speed < 0:
            return False, None, f'Spindle speed "{rpm}" is not a speed.', Outcome.REFUSED
        outcome, why = await self.ensure_mode(lc.MODE_MANUAL)
        if outcome != Outcome.ACCEPTED:
            return False, None, why, outcome
        d = lc.SPINDLE_FORWARD if turn == 'cw' else lc.SPINDLE_REVERSE
        ok, _v, err, outcome = await self.run_cmd(lambda: self.l.cmd.spindle(d, speed))
        return ok, ok, err, outcome

    def write_program(self, text: str) -> Tuple[str, int, bool, bool]:
        os.makedirs(self.program_dir, exist_ok=True)
        body = text.replace('\r\n', '\n')
        # LinuxCNC refuses a file with no program end. The software CAN end
        # it, so it does, and says so (rule 11).
        stripped = [ln.split(';')[0].strip().upper() for ln in body.split('\n')]
        coded = any(re.match(r'^(N\d+\s*)?(M0*2|M30)\b', ln) for ln in stripped)
        ended = coded or sum(1 for ln in stripped if ln == '%') >= 2
        appended = False
        if not ended:
            body = body.rstrip('\n') + '\nM2\n'
            appended = True
        stamp = time.strftime('%Y%m%d-%H%M%S')
        path = os.path.join(self.program_dir, f'liencam-{stamp}-{os.getpid()}-{int(time.monotonic() * 1000) % 100000}.ngc')
        with open(path, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(body if body.endswith('\n') else body + '\n')
        # The last value: the program ends in an M2/M30 (audit 14, ran_to_end).
        return path, body.count('\n'), appended, coded or appended

    @staticmethod
    def run_from_text(programText: str, start_line: int, prelude: List[str]) -> Tuple[str, int, int]:
        """Audit 15: LinuxCNC's own run-from-line (2.9) rebuilds modal state
        but does NOT start the spindle or make the approach - measured on the
        WO-1982 simulator, the spindle stayed off at 0 RPM. So a run from a
        line is what the text controllers stream: LienCAM's set-up lines,
        verbatim, then the program from its start line, as one file run from
        its top. Returns (text, set-up line count, index of the first program
        line kept)."""
        lines = programText.replace('\r\n', '\n').split('\n')
        first = max(int(start_line), 1) - 1
        head = [str(p) for p in prelude]
        lead = next((i for i, ln in enumerate(lines) if ln.strip()), None)
        if lead is not None and lines[lead].strip() == '%':
            # LinuxCNC reads a %-delimited file only when '%' comes first.
            head = ['%'] + head
            first = max(first, lead + 1)
        return '\n'.join(head + lines[first:]), len(head), first

    async def load(self, programText: str, start_line: int, prelude: Optional[List[str]]):
        lc = self.lc
        self.l.stat.poll()
        if self.l.stat.interp_state != lc.INTERP_IDLE:
            return True, {'ok': False, 'reason': 'A program is running on LinuxCNC; stop it before loading another.'}, None, Outcome.REFUSED
        busy = self.busy_refusal('the program load')
        if busy:
            return True, {'ok': False, 'reason': busy}, None, Outcome.REFUSED
        head, first = 0, 0
        if prelude is not None:
            programText, head, first = self.run_from_text(programText, start_line, prelude)
        path, lines, appended, end_coded = self.write_program(programText)
        outcome, why = await self.ensure_mode(lc.MODE_AUTO)
        if outcome != Outcome.ACCEPTED:
            return True, {'ok': False, 'reason': why}, None, outcome
        mark = self.error_serial
        self.l.cmd.reset_interpreter()
        await self.complete(self.l.cmd)
        self.l.cmd.program_open(path)
        outcome = await self.complete(self.l.cmd)
        if outcome != Outcome.ACCEPTED:
            self.pump_errors()
            return True, {'ok': False, 'reason': self.sentence('the program', outcome, self.refusals_since(mark))}, None, outcome
        self.line_head, self.line_from = head, first
        self.end_coded = end_coded
        notes = []
        if appended:
            notes.append('The program had no M2/M30; the gateway ended it with M2.')
        if prelude:
            notes.append(f'Run from line {start_line}: LinuxCNC runs the {len(prelude)} set-up lines first, '
                         f'then the program from line {start_line}.')
        for note in notes:
            await self.send({'t': 'console', 'v': {'dir': 'rx', 'text': note, 'severity': 'info'}})
        return True, {'ok': True, 'path': path, 'lines': lines, 'appendedEnd': appended,
                      'startLine': start_line, 'notes': notes}, None, outcome

    async def call_loadJob(self, programText: str):
        return await self.load(programText, 0, None)

    async def call_loadJobFrom(self, programText: str, startLine: int, prelude: List[str]):
        return await self.load(programText, int(startLine), list(prelude or []))

    async def call_startJob(self):
        """Accepted only when LinuxCNC's interpreter LEAVES idle. That state is
        already true while a program runs or is paused, so a start there could
        prove nothing - and AUTO_RUN on a running program rewinds it to its
        start line (the WO-1986 audit at bee6b29e9: line 1 back to line 0).
        So it is refused there, and nothing is sent: the UCCNC bridge's
        "a program is already running"."""
        lc = self.lc
        busy = self.busy_refusal('the program start')
        if busy:
            return False, None, busy, Outcome.REFUSED
        outcome, why = await self.ensure_mode(lc.MODE_AUTO)
        if outcome != Outcome.ACCEPTED:
            return False, None, why, outcome
        self.pump_errors()
        mark = self.error_serial
        if self.single_block:
            self.l.cmd.auto(lc.AUTO_STEP)
        else:
            # From the top: a run from a line is its own file (audit 15).
            self.l.cmd.auto(lc.AUTO_RUN, 0)
        outcome = await self.observe(lambda s: s.interp_state != lc.INTERP_IDLE, self.call_timeout, mark)
        if outcome != Outcome.REFUSED:
            # An UNKNOWN start may be running: track it, so its end is still
            # reported rather than lost.
            self.job = {'errorSerial': mark, 'idleTicks': 0, 'lastPosition': None, 'endCoded': self.end_coded}
        ok = outcome == Outcome.ACCEPTED
        return ok, ok, None, outcome

    async def call_resumeJob(self):
        """Accepted only when a PAUSED program stops being paused. "Not paused"
        is already true of an idle or running machine, so reading it alone
        replied accepted to a resume LinuxCNC refused ("Can't run a program
        when not in auto mode") - the WO-1986 attempt-2 audit.

        With nothing paused, AUTO_RESUME is NOT sent. Measured on the WO-1982
        simulator (LinuxCNC 2.9.4): after a program completed, an AUTO_RESUME
        left the interpreter reading as busy - the next loadJob was refused
        ("A program is running") and the next startJob re-ran the finished
        program. There is nothing to resume, and asking breaks the next job.

        WO-2100: while LinuxCNC waits at an M6 (and is not also paused), the
        resume IS the operator's Continue - answer_tool_change."""
        self.l.stat.poll()
        self.quiet_resume = False
        if self.tool_change is not None and not self.is_paused(self.l.stat):
            # An MDI M6 is no program: its answer raises no `resumed`.
            self.quiet_resume = self.job is None
            return await self.answer_tool_change()
        if not self.is_paused(self.l.stat):
            return False, None, 'Nothing is paused, so there is nothing to resume.', Outcome.REFUSED
        self.pump_errors()
        mark = self.error_serial
        self.l.cmd.auto(self.lc.AUTO_RESUME)
        outcome = await self.observe(lambda s: not self.is_paused(s), self.call_timeout, mark)
        ok = outcome == Outcome.ACCEPTED
        return ok, ok, None, outcome

    async def call_cycleResume(self):
        return await self.call_resumeJob()

    async def call_stepJob(self):
        """Accepted when the program's lines or interpreter state move. A
        RUNNING program moves them by itself, so a step there could prove
        nothing: refused, nothing sent (the bridge's StepJob refuses while the
        run owns the program). From idle or paused, the step is the mover."""
        lc = self.lc
        busy = self.busy_refusal('the single-block step')
        if busy:
            return False, None, busy, Outcome.REFUSED
        self.pump_errors()
        mark = self.error_serial
        self.l.stat.poll()
        before = (self.l.stat.interp_state, self.l.stat.current_line, self.l.stat.motion_line)
        self.l.cmd.auto(lc.AUTO_STEP)
        outcome = await self.observe(
            lambda s: (s.interp_state, s.current_line, s.motion_line) != before, self.call_timeout, mark)
        if self.job is None and before[0] == lc.INTERP_IDLE and outcome != Outcome.REFUSED:
            # Audit 17: a first step from idle starts the program as Start
            # does, so it is tracked and its end is reported.
            self.job = {'errorSerial': mark, 'idleTicks': 0, 'lastPosition': None, 'endCoded': self.end_coded}
        ok = outcome == Outcome.ACCEPTED
        return ok, ok, None, outcome

    async def call_setSingleBlockMode(self, on: bool):
        self.single_block = bool(on)
        return True, None, None, None

    # --------------------------------------------------------------- session
    async def on_socket_lost(self) -> None:
        """BRIDGE-PROTOCOL.md safety rule 1: losing the socket stops the
        machine - LinuxCNC's abort ends a program, a jog and an MDI move.
        Every ordinary call the dead session sent - running, or queued on the
        lock - is cancelled FIRST, so none issues a command after the stop or
        replies to a later session."""
        self.generation += 1
        self.jog_due = None
        for task in list(self.ordinary_tasks):
            if task is not asyncio.current_task():
                task.cancel()
        ended = True
        try:
            self.l.stop_cmd.abort()
            outcome = await self.complete(self.l.stop_cmd, 1.0)
            self.jog_stop_all()
            ended = self.abort_ended_program(outcome)
        except Exception as error:
            self.log(f'socket-loss stop failed: {error}')
            # A stop that raised is read by its effect too (audit 12); if even
            # the status cannot be read, the job is kept - never dropped blind.
            try:
                ended = self.abort_ended_program(Outcome.UNKNOWN)
            except Exception:
                ended = False
        if self.job is not None:
            if ended:
                self.job = None
            else:
                # The program runs on: it stays tracked, so the next session
                # still hears how it ends (audit 11).
                self.job.pop('stopping', None)
                self.log('socket-loss abort did not end the program: it is still running')

    async def link_watch(self, conn: WsConnection, peer: str) -> None:
        """WO-2101: ping a network session and end it once nothing has arrived
        for `link_timeout`. Ending it is the socket-loss stop below - the same
        stop a closed socket gets, reached without waiting on TCP."""
        interval = self.link_timeout / 4
        while True:
            await asyncio.sleep(interval)
            silent = time.monotonic() - conn.last_rx
            if silent > self.link_timeout:
                self.log(f'LienCAM at {peer} sent nothing for {silent * 1000:.0f} ms: the link is lost, '
                         'stopping the machine.')
                conn.writer.transport.abort()
                return
            try:
                conn.writer.write(ws_encode(0x9, b'', conn.mask))
            except Exception:
                return

    async def session(self, conn: WsConnection, peer: Optional[str] = None) -> None:
        self.conn = conn
        self.last_frame = None
        self.l.stat.poll()
        self.prev_homed = None
        await self.send({'t': 'hello', 'v': self.hello()})
        await self.send({'t': 'phase', 'v': {'phase': 'connected', 'version': f'LinuxCNC {getattr(self.lc, "version", "?")}'}})
        await self.status_tick(force=True)
        ticker = asyncio.ensure_future(self.ticker())
        deadman = asyncio.ensure_future(self.jog_deadman_watch())
        watched = self.link_timeout > 0 and not is_loopback_peer(peer)
        link = asyncio.ensure_future(self.link_watch(conn, str(peer))) if watched else None
        try:
            while True:
                text = await conn.recv_text()
                await self.handle_frame(text)
        except (WsClosed, asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            ticker.cancel()
            deadman.cancel()
            if link is not None:
                link.cancel()
            released = asyncio.get_running_loop().create_future()
            self.slot = released
            self.conn = None
            try:
                await conn.close()
                await self.on_socket_lost()
            finally:
                self.slot = None
                released.set_result(None)

    async def ticker(self) -> None:
        while True:
            try:
                await self.status_tick()
            except Exception as error:
                self.log(f'status tick failed: {error}')
            await asyncio.sleep(POLL_S)


async def serve(gateway: Gateway, host: str, port: int, allow_origins: List[str], ready: Callable[[int], None]) -> None:
    async def on_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5.0)
        except Exception:
            writer.close()
            return
        lines = raw.decode('latin-1').split('\r\n')
        headers = {}
        for line in lines[1:]:
            if ':' in line:
                k, v = line.split(':', 1)
                headers[k.strip().lower()] = v.strip()
        key = headers.get('sec-websocket-key')

        def refuse(code: str, why: str) -> None:
            body = why.encode()
            writer.write(f'HTTP/1.1 {code}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
            writer.close()

        if not key or 'websocket' not in headers.get('upgrade', '').lower():
            refuse('400 Bad Request', 'This is the LienCAM LinuxCNC gateway; it speaks WebSocket only.')
            return
        peername = writer.get_extra_info('peername')
        peer = peername[0] if isinstance(peername, tuple) and peername else None
        if not origin_allowed(headers.get('origin'), allow_origins, peer):
            refuse('403 Forbidden', f'Origin {headers.get("origin")} may not drive this machine.')
            return
        releasing = gateway.slot
        if isinstance(releasing, asyncio.Future):
            # The last session's socket is gone and its socket-loss stop is
            # still running. Wait for it: admitted now, this session's first
            # motion could be the thing that stop ends.
            try:
                await asyncio.wait_for(asyncio.shield(releasing), RELEASE_WAIT_S)
            except asyncio.TimeoutError:
                pass
        if isinstance(gateway.slot, asyncio.Future):
            refuse('503 Service Unavailable',
                   "The last session's socket-loss stop has not finished yet. Try again in a moment.")
            return
        if gateway.slot is not None:
            refuse('409 Conflict', 'Another LienCAM session already owns this machine. One session at a time.')
            return
        # Claimed with no await since the check, so two connections cannot both pass it.
        gateway.slot = 'open'
        try:
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                          f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())
            await writer.drain()
        except Exception:
            gateway.slot = None
            writer.close()
            return
        try:
            await gateway.session(WsConnection(reader, writer, mask=False), peer)
        finally:
            if gateway.slot == 'open':  # the session died before its own release ran
                gateway.slot = None
                gateway.conn = None

    server = await asyncio.start_server(on_client, host, port)
    bound = server.sockets[0].getsockname()[1]
    ready(bound)
    async with server:
        await server.serve_forever()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description='LienCAM LinuxCNC gateway (WebSocket, bridge protocol 1).')
    parser.add_argument('--host', default='127.0.0.1',
                        help='address to listen on (default %(default)s, this computer only); '
                             '0.0.0.0 takes LienCAM on another PC on the network')
    parser.add_argument('--port', type=int, default=8327)
    parser.add_argument('--ini', default=None, help='LinuxCNC INI (default: the running one, from stat.ini_filename)')
    parser.add_argument('--program-dir', default=os.path.join(os.path.expanduser('~'), 'liencam-programs'))
    parser.add_argument('--call-timeout', type=float, default=5.0)
    parser.add_argument('--home-timeout', type=float, default=HOME_TIMEOUT_S,
                        help='seconds homeAxes waits for one joint to finish homing (default %(default)g)')
    parser.add_argument('--motion-cap', type=float, default=MOTION_CAP_S,
                        help='seconds a sendCommandAwait line may keep LinuxCNC moving before its answer is unknown '
                             '(default %(default)g); with no motion, --call-timeout')
    parser.add_argument('--jog-deadman', type=float, default=JOG_DEADMAN_S,
                        help='seconds a continuous jog runs without a jogHold before the gateway stops it '
                             '(default %(default)g)')
    parser.add_argument('--link-timeout', type=float, default=LINK_TIMEOUT_S,
                        help='seconds a session from another computer may send nothing (not even a pong) '
                             'before the gateway treats the link as lost and stops the machine '
                             '(default %(default)g; 0 = never)')
    parser.add_argument('--allow-origin', action='append', default=[])
    parser.add_argument('--halcmd', default='halcmd',
                        help='halcmd used (read-only "show") to read the running HAL\'s I/O links (default %(default)s)')
    args = parser.parse_args(argv)

    def log(text: str) -> None:
        print(text, file=sys.stderr, flush=True)

    try:
        import linuxcnc  # noqa: E402 - LinuxCNC's own module, present on the LinuxCNC PC
    except ImportError:
        log('The Python "linuxcnc" module is not importable. Run this on the LinuxCNC PC, '
            'with LinuxCNC\'s Python on the path (e.g. the system python3 that ships with LinuxCNC).')
        return 3
    try:
        lcnc = Lcnc(linuxcnc, args.ini, args.halcmd)
    except Exception as error:
        log(f'LinuxCNC is not answering on its NML channels ({error}). Start LinuxCNC first.')
        return 4
    gateway = Gateway(lcnc, args.program_dir, args.call_timeout, log, args.home_timeout, args.jog_deadman,
                      args.motion_cap, args.link_timeout)

    def ready(port: int) -> None:
        print(json.dumps({'listening': port, 'host': args.host, 'gateway': GATEWAY_NAME,
                          'coordinates': lcnc.coordinates}), flush=True)

    try:
        asyncio.run(serve(gateway, args.host, args.port, args.allow_origin, ready))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
