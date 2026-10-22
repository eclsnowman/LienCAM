#!/usr/bin/env python3
"""Fake AXBB-E board for the DLL test oracle (track B, phase B0).

Answers UC100.dll the way the real board did in the August captures, so
the vendor DLL (2190 ONLY) can run against it, and logs every frame the
DLL sends. That log is the reference corpus for Uc100Net.

Runs only on the private Hyper-V switch "UC-Oracle" (10.10.10.10 =
host/DLL, 10.10.10.11 = this fake). See docs/ORACLE.md.

Safety:
- The discovery reply ALWAYS reports firmware "1005", the image embedded
  in DLL 2190, so the DLL never decides to flash. If anything still arrives
  on the bootloader port other than a discovery probe, it is logged as a
  FIRMWARE-UPDATE ATTEMPT and never answered.
- It binds only to 10.10.10.11 and never sends anything unsolicited.

Reply templates are plaintext from the real board (uccnc.pcapng), with the
nonce swapped in and re-encoded the way the board encodes (little-endian
checksum). The discovery template's MAC and serial are replaced with
dummies.

Usage: python tools/fake_board.py --log work/oracle/run1.jsonl --duration 60
Stdlib only.
"""
import argparse
import collections
import json
import math
import os
import select
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uc_proto  # noqa: E402

FAKE_IP = "10.10.10.11"
DISCOVERY_PORT = 4910
SESSION_PORT = 4912
FAKE_SERIAL = b"0BEEF0"
FAKE_MAC = bytes([0x02, 0x00, 0x00, 0x00, 0x00, 0x01])  # locally administered

# Real discovery reply (docs/WIRE-PROTOCOL.md section 4) with nonce/csum zeroed.
DISCOVERY = bytearray.fromhex(
    "232d3ec0000068271932ba210a0a0a0b0a0a0a0affffff000031303030000314"
    "0a1b4344303935410031303035000a0a0a0b0a0a0a0affffff00ff0000")
DISCOVERY[0x06:0x0C] = FAKE_MAC
DISCOVERY[0x22:0x28] = FAKE_SERIAL
assert len(DISCOVERY) == 61 and DISCOVERY[0x29:0x2D] == b"1005"

# Idle 153-byte status reply (uccnc.pcapng, t=10-18 s) and fixed replies.
STATUS_IDLE = bytes.fromhex(
    "232d3e0e00000000000000000000000000000000000000000000000000000001"
    "089d00000060000000000000000000c6dc013fbe2f0000000000000000000000"
    "000000000000000000000000000000000000000000000000002a080000000000"
    "0000000000000000000000000000000000000000000000000000000000000000"
    "00000000000000000000000000000000000000000000000000")
STOP_REPLY = bytes.fromhex("232d3e06000000012a0000")
MOTION_REPLY = bytes.fromhex("232d3e0200002a0000")
assert len(STATUS_IDLE) == 153


# Board-side buffer model, from the 2190 decompile (docs/ORACLE.md):
# - status bytes 30..31 (u16 BE) = buffer fill; the idle board reports 1;
# - the DLL's capacity is 10 + int(781 * USBPufferSize) records, i.e. the
#   board consumes ~781 records/s (one per 1.28 ms);
# - status bytes 33..34 (u16 BE) = board clock in 10 us units (the DLL
#   divides deltas by 100000).
# INFERRED, and not yet checked against a real board run: one record drains
# per 1.28 ms regardless of its type.
DRAIN_PER_S = 781.25
STATUS_FILL = 30
STATUS_CLOCK = 33
STATUS_POS = 6           # six int32 BE axis positions in steps, bytes 6..29
# Board state, MEASURED on the real board (uccnc.pcapng) and matched to the
# 2190 GetStatus mapping: byte 32 bit0 = Jog, bit1 = E-stop, bit2 = busy,
# bit3 = ready (idle), bit4 = Home, bit6 = hard limit; byte 53 = per-axis
# moving mask. Real values: idle 0x08, jog 0x05, home 0x14, e-stop idle 0x0a.
STATUS_FLAGS = 32
STATUS_AXES = 53
STATUS_PROBE_RUNNING = 0x40   # byte 53 bit 6 while a probe move runs (docs/CALLS.md 4)
STATUS_PROBE_FLAGS = 87       # bit 2 = probe contact latched
STATUS_PROBE_POS = 151        # six int32 BE latched step counters, in a 177-byte reply
HOME_SECONDS = 1.0       # how long a fake homing cycle takes
# 0x02 payload: byte 6 = record count, then 48-byte records of six LE doubles.
# MEASURED on the oracle corpus (program1): ordinary records are absolute
# X Y Z A B C positions in units, one per 1.28 ms. Records whose slot 0 is
# FLT_MIN or FLT_MAX (as a double) are command records and carry no position.
SENTINELS = (struct.unpack("<d", bytes.fromhex("0000000000001038"))[0],
             struct.unpack("<d", bytes.fromhex("000000e0ffffef47"))[0])


def reply_to(template, nonce_hi, nonce_lo):
    p = bytearray(template)
    p[4], p[5] = nonce_hi, nonce_lo
    return uc_proto.encode(bytes(p), from_board=True)


def ack(cmd, nonce_hi, nonce_lo):
    return reply_to(bytes([0x23, 0x2D, 0x3E, cmd, 0, 0, 0, 0]), nonce_hi, nonce_lo)


class FakeBoard:
    def __init__(self, log, steps_per_unit=400.0, estop_windows=None, probe_at=None, estop_file=None, probe_file=None, softtrip_file=None):
        self.log = log
        self.first_settings = True
        self.counts = {}
        self.flash_attempts = 0
        self.last_discovery = -1.0
        self.queue = collections.deque()   # records in the board buffer beyond the idle 1
        self.budget = 0.0                  # fractional records the clock owes us
        self.last_drain = time.monotonic()
        self.records_in = 0
        self.pos = [0.0] * 6               # units; reported as steps
        self.steps_per_unit = steps_per_unit
        self.jog = {}                      # axis -> signed speed, units/s
        self.home = {}                     # axis -> monotonic end time
        self.estop_windows = estop_windows or []   # [(start_s, duration_s)]
        # E-stop input held while this file exists, so a test can press and
        # release it at a moment of its choosing; checked at most every 10 ms.
        self.estop_file = estop_file
        self.estop_file_state, self.estop_file_checked = False, -1.0
        # Board-side soft-limit trip (reply byte 32 bit 5, docs/CALLS.md 5.1)
        # held while this file exists. What the real board does on a trip is
        # unknown (FROM CODE ONLY: the DLL's reaction); the fake halts its own
        # motion as on e-stop, so the host's reaction is all that is tested.
        self.softtrip_file = softtrip_file
        self.softtrip_state, self.softtrip_checked = False, -1.0
        # Probe model (docs/CALLS.md 4.3, FROM CODE ONLY: no real capture has a
        # hit): a surface at probe_at = (axis, position); armed by 0x0F.
        self.probe_at = probe_at
        self.probe_armed = False
        self.probe_hit = None              # latched step counters after contact
        # Or per probe: at each probe start, PATH holds "AXIS,DIST" (contact
        # after DIST units of travel on AXIS from where the probe started) or
        # "miss". Lets a replay reproduce recorded contacts whatever host
        # offsets apply (tools/b6/replay_session.py --probe-file).
        self.probe_file = probe_file
        self.probe_rel = None
        self.probe_start = None
        self.socks = {}
        for port in (DISCOVERY_PORT, SESSION_PORT):
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            # Bound to 10.10.10.11 only: on Windows subnet broadcasts on
            # UC-Oracle still arrive (tested), and probes from the home LAN or
            # other adapters can't reach this socket. Linux delivers a
            # broadcast only to a wildcard-bound socket, so there the
            # discovery port binds the wildcard; handle() still ignores
            # anything from outside 10.10.10.x.
            wildcard = port == DISCOVERY_PORT and sys.platform != "win32"
            s.bind(("" if wildcard else FAKE_IP, port))
            self.socks[s] = port
        self.t0 = time.monotonic()

    def record(self, port, src, raw, plain, valid, note=""):
        cmd = plain[3]
        self.counts[(port, cmd, len(raw))] = self.counts.get((port, cmd, len(raw)), 0) + 1
        if self.log:
            self.log.write(json.dumps({
                "t": round(time.monotonic() - self.t0, 6), "wall": round(time.time(), 6),
                "port": port, "src": f"{src[0]}:{src[1]}",
                "cmd": cmd, "len": len(raw), "valid": valid, "plain": plain.hex(), "note": note}) + "\n")

    def handle(self, sock, port):
        raw, src = sock.recvfrom(2048)
        if len(raw) < 8 or not src[0].startswith("10.10.10."):
            return  # never answer anything outside the private oracle subnet
        plain = uc_proto.decode(raw)
        magic, csum = uc_proto.frame_ok(plain)
        valid = magic and csum
        cmd, nh, nl = plain[3], plain[4], plain[5]
        if port == DISCOVERY_PORT:
            if valid and cmd == 0xC0 and len(raw) == 8:
                # UC-Oracle carries two host addresses, so one ListDevices scan
                # broadcasts twice; answer once per scan, or the DLL lists the
                # fake twice.
                now = time.monotonic()
                if now - self.last_discovery < 0.5:
                    self.record(port, src, raw, plain, valid, "discovery (duplicate in scan, not answered)")
                    return
                self.last_discovery = now
                self.record(port, src, raw, plain, valid, "discovery")
                # The real AXBB-E answers to 255.255.255.255:<probe port>, not
                # to the sender (every capture in the 2026-10-15 handoff).
                sock.sendto(reply_to(DISCOVERY, nh, nl), ("255.255.255.255", src[1]))
            else:
                self.flash_attempts += 1
                self.record(port, src, raw, plain, valid, "FIRMWARE-UPDATE ATTEMPT - not answered")
                print(f"!!! FIRMWARE-UPDATE ATTEMPT on :4910 from {src}: cmd 0x{cmd:02x} len {len(raw)}",
                      flush=True)
            return
        if not valid:
            self.record(port, src, raw, plain, valid, "invalid - not answered")
            return
        self.drain()
        note = ""
        if cmd == 0x0E:
            out = reply_to(self.status(), nh, nl)
            note = f"fill {1 + len(self.queue)}"
        elif cmd == 0x06:
            # Stop flushes the buffer and ends board-side motion (INFERRED).
            self.queue.clear()
            self.jog.clear()
            self.home.clear()
            # The DLL sends Stop as soon as a reply shows the probe finished, so
            # the hit has been seen; clearing it here keeps the next probe's
            # first poll from re-reporting it (INFERRED: the real board's
            # behaviour is unknown, docs/CALLS.md 4.3 point 5).
            self.probe_armed = False
            self.probe_hit = None
            out = reply_to(STOP_REPLY, nh, nl)
        elif cmd == 0x04:   # jog: axis byte + LE double signed speed, units/s
            if not self.estopped():
                self.jog[plain[6]] = struct.unpack_from("<d", plain, 7)[0]
            note = f"jog axis {plain[6]} {struct.unpack_from('<d', plain, 7)[0]:+.4f}/s"
            out = ack(0xAB, nh, nl)
        elif cmd == 0x05:   # jog stop: axis byte
            self.jog.pop(plain[6], None)
            note = f"jog off axis {plain[6]}"
            out = ack(0xAB, nh, nl)
        elif cmd == 0x08:   # home: axis byte + 2 LE doubles (fast, slow)
            if not self.estopped():
                self.home[plain[6]] = time.monotonic() + HOME_SECONDS
            note = f"home axis {plain[6]}"
            out = ack(0xAB, nh, nl)
        elif cmd == 0x02:
            n = plain[6]
            # After a probe contact the board waits for the host's Stop; records
            # still in flight are dropped, not run past the surface (INFERRED,
            # docs/CALLS.md 4.3: the host streams in the same tick it polls).
            for i in range(0 if self.probe_hit is not None else n):
                self.queue.append(struct.unpack_from("<6d", plain, 7 + 48 * i))
            self.records_in += n
            note = f"{n} records"
            out = reply_to(MOTION_REPLY, nh, nl)
        elif cmd == 0x0F:
            # Probe start: payload = 1 << axis. Arm; the next records are the probe move.
            self.probe_armed = True
            self.probe_hit = None
            self.probe_rel, self.probe_start = None, list(self.pos)
            if self.probe_file and os.path.exists(self.probe_file):
                spec = open(self.probe_file, encoding="utf-8").read().strip()
                if spec == "miss":
                    self.probe_rel = "miss"
                elif spec:
                    ax, dist = spec.split(",")
                    self.probe_rel = (int(ax), float(dist))
            note = f"probe start mask 0x{plain[6]:02x}"
            out = ack(0xAB, nh, nl)
        elif cmd == 0x01:
            # Axis-position reset (FUN_1800315d0 / the DLL's simulation branch,
            # work/decode-calls.md section 3): every step counter to 0, A to the
            # payload's int32 steps (non-zero only with a tangential cutter).
            a_steps = struct.unpack_from("<i", plain, 6)[0]
            self.pos = [0.0] * 6
            self.pos[3] = a_steps / self.steps_per_unit
            note = f"position reset, A {a_steps} steps"
            out = ack(0xAB, nh, nl)
        elif cmd == 0x0D and self.first_settings:
            self.first_settings = False
            out = ack(0xAA, nh, nl)
        else:
            out = ack(0xAB, nh, nl)
        self.record(port, src, raw, plain, valid, note)
        sock.sendto(out, src)

    def estopped(self):
        t = time.monotonic() - self.t0
        if self.estop_file and t - self.estop_file_checked >= 0.01:
            self.estop_file_state, self.estop_file_checked = os.path.exists(self.estop_file), t
        return self.estop_file_state or any(a <= t < a + d for a, d in self.estop_windows)

    def softtripped(self):
        t = time.monotonic() - self.t0
        if self.softtrip_file and t - self.softtrip_checked >= 0.01:
            self.softtrip_state, self.softtrip_checked = os.path.exists(self.softtrip_file), t
        return self.softtrip_state

    def drain(self):
        now = time.monotonic()
        dt = now - self.last_drain
        if self.estopped() or self.softtripped():   # the board halts everything on e-stop
            self.queue.clear()
            self.jog.clear()
            self.home.clear()
        for ax, v in self.jog.items():
            self.pos[ax] += v * dt
        self.home = {ax: end for ax, end in self.home.items() if end > now}
        self.budget += dt * DRAIN_PER_S
        self.last_drain = now
        while self.queue and self.budget >= 1.0:
            rec = self.queue.popleft()
            self.budget -= 1.0
            if rec[0] not in SENTINELS:
                hit = self.contact(rec) if self.probe_armed else None
                if hit:
                    # Contact: the board stops and latches its counters there.
                    ax, at = hit
                    self.pos[ax] = at
                    self.probe_hit = [int(round(v * self.steps_per_unit)) for v in self.pos]
                    self.probe_armed = False
                    self.queue.clear()
                    break
                self.pos = list(rec)
        if not self.queue:
            self.budget = 0.0

    def contact(self, rec):
        """(axis, position) where the armed probe move to rec touches, or None."""
        if self.probe_rel == "miss":
            return None
        if self.probe_rel:
            ax, dist = self.probe_rel
            d = rec[ax] - self.probe_start[ax]
            if d != 0 and abs(d) >= dist:
                return ax, self.probe_start[ax] + math.copysign(dist, d)
            return None
        if self.probe_at and self.crosses(rec):
            return self.probe_at
        return None

    def crosses(self, rec):
        ax, at = self.probe_at
        a, b = self.pos[ax], rec[ax]
        return min(a, b) <= at <= max(a, b) and a != b

    def status(self):
        p = bytearray(STATUS_IDLE)
        fill = min(0xFFFF, 1 + len(self.queue))
        p[STATUS_FILL], p[STATUS_FILL + 1] = fill >> 8, fill & 0xFF
        for ax, v in enumerate(self.pos):
            struct.pack_into(">i", p, STATUS_POS + 4 * ax, int(round(v * self.steps_per_unit)))
        busy = bool(self.jog or self.home)
        flags = (0x04 if busy else 0x08) | (0x01 if self.jog else 0) | (0x10 if self.home else 0)
        if self.estopped():
            flags |= 0x02
        if self.softtripped():
            flags |= 0x20
        p[STATUS_FLAGS] = flags
        mask = 0
        for ax in list(self.jog) + list(self.home):
            mask |= 1 << ax
        if self.probe_armed:
            mask |= STATUS_PROBE_RUNNING
        p[STATUS_AXES] = mask
        if self.probe_hit is not None:
            # The longer reply the DLL's parser expects with a hit: positions at 151..174.
            p[STATUS_PROBE_FLAGS] |= 0x04
            p = p[:151] + bytearray(24) + bytearray(2)
            for i, v in enumerate(self.probe_hit):
                struct.pack_into(">i", p, STATUS_PROBE_POS + 4 * i, v)
        clock = int((time.monotonic() - self.t0) * 100000) & 0xFFFF
        p[STATUS_CLOCK], p[STATUS_CLOCK + 1] = clock >> 8, clock & 0xFF
        return bytes(p)

    def run(self, duration):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select(list(self.socks), [], [], 0.2)
            for s in ready:
                self.handle(s, self.socks[s])


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fake AXBB-E board for the DLL oracle")
    ap.add_argument("--log", help="JSONL file for every received frame")
    ap.add_argument("--duration", type=float, default=60.0, help="seconds to run")
    ap.add_argument("--steps-per-unit", type=float, default=400.0,
                    help="steps/unit used to report positions (LienCNCV2.pro: 400)")
    ap.add_argument("--estop-at", action="append", default=[], metavar="T,D",
                    help="assert e-stop from T s for D s after start (repeatable)")
    ap.add_argument("--estop-file", metavar="PATH",
                    help="assert e-stop while this file exists")
    ap.add_argument("--softtrip-file", metavar="PATH",
                    help="report a board-side soft-limit trip (reply byte 32 bit 5) while this file exists")
    ap.add_argument("--probe-file", metavar="PATH",
                    help='per probe: "AXIS,DIST" (contact after DIST of travel) or "miss", read at each probe start')
    ap.add_argument("--probe-at", metavar="AXIS,POS",
                    help="a probe surface: an armed probe move touches it at POS on AXIS (0..5)")
    a = ap.parse_args(argv)
    # Line-buffered: the log survives a kill (docker stop) and can be read while it grows.
    log = open(a.log, "w", encoding="utf-8", buffering=1) if a.log else None
    try:
        windows = [tuple(float(x) for x in w.split(",")) for w in a.estop_at]
        probe = None
        if a.probe_at:
            ax, at = a.probe_at.split(",")
            probe = (int(ax), float(at))
        fb = FakeBoard(log, a.steps_per_unit, windows, probe, a.estop_file, a.probe_file, a.softtrip_file)
        print(f"fake AXBB-E on {FAKE_IP} (fw 1005, serial {FAKE_SERIAL.decode()}) for {a.duration:.0f} s",
              flush=True)
        fb.run(a.duration)
    finally:
        if log:
            log.close()
    print(f"motion records received: {fb.records_in}", flush=True)
    print("frames received:", flush=True)
    for (port, cmd, ln), n in sorted(fb.counts.items()):
        print(f"  :{port} cmd 0x{cmd:02x} len {ln:>3}  x{n}", flush=True)
    if fb.flash_attempts:
        print(f"!!! {fb.flash_attempts} FIRMWARE-UPDATE ATTEMPT(S) - treat this run as failed", flush=True)
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
