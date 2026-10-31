"""Drive a running LienCAM UCCNC bridge through its WebSocket the way
LienCAM does (calls recorded in the handoff's 07-ws-frames), and check the
machine position its status frames report (track A test T1, PLAN.md).

    python -I tools/wine/ws_drive.py [--host 127.0.0.1] [--port 8325]

Sequence: refreshState, resetToIdle, homeAxes Z X Y; jog X -5 mm; a 20 mm square as a job;
pauseJob part way (the position must stop), resumeJob, wait for the end
(back at the start); stopJob. Use it only against a demo board (--board <= 0)
or a fake: it moves the machine. Exit 0 when every check passes. Stdlib only.
"""
import argparse
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ws_probe import frames, handshake  # noqa: E402


class Bridge:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=10)
        rest = handshake(self.sock, host, port)
        self.sock.settimeout(None)
        self.seq = 0
        self.replies = {}
        self.status = None
        self.hello = None
        self.cv = threading.Condition()
        threading.Thread(target=self.reader, args=(rest,), daemon=True).start()

    def reader(self, rest):
        for text in frames(self.sock, rest):
            msg = json.loads(text)
            with self.cv:
                if msg.get("t") == "reply":
                    self.replies[msg.get("seq")] = msg
                elif msg.get("t") == "status":
                    self.status = msg.get("v")
                elif msg.get("t") == "hello":
                    self.hello = msg.get("v")
                self.cv.notify_all()

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + n.to_bytes(2, "big"))
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def call(self, method, args=None, timeout=10):
        self.seq += 1
        seq = self.seq
        self.send({"t": "call", "seq": seq, "m": method, "a": args or {}})
        with self.cv:
            self.cv.wait_for(lambda: seq in self.replies, timeout)
            reply = self.replies.get(seq)
        print(f"  {method} {json.dumps(args or {})[:80]} -> {json.dumps(reply)[:160] if reply else 'NO REPLY'}")
        return reply

    def pos(self):
        with self.cv:
            p = (self.status or {}).get("machinePos") or {}
        return p.get("x"), p.get("y"), p.get("z")

    def state(self):
        with self.cv:
            return (self.status or {}).get("state")

    def wait_still(self, timeout=20, quiet=1.0):
        """Wait until the position has not changed for `quiet` seconds."""
        end, last, since = time.monotonic() + timeout, None, time.monotonic()
        while time.monotonic() < end:
            p = self.pos()
            if p != last:
                last, since = p, time.monotonic()
            elif time.monotonic() - since >= quiet:
                return p
            time.sleep(0.1)
        return self.pos()


def close(a, b, tol=0.01):
    return a is not None and abs(a - b) <= tol


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8325)
    a = ap.parse_args(argv)
    deadline = time.monotonic() + 30
    while True:
        try:
            br = Bridge(a.host, a.port)
            break
        except OSError:
            if time.monotonic() > deadline:
                print("no bridge listening")
                return 2
            time.sleep(0.5)
    time.sleep(1.5)
    fails = []
    print(f"connected; board {((br.hello or {}).get('uccnc') or {}).get('board')}, state {br.state()}, pos {br.pos()}")
    br.call("refreshState")
    br.call("resetToIdle")
    # The bridge refuses a job until X, Y and Z are homed this session.
    r = br.call("homeAxes", {"axes": ["Z", "X", "Y"]}, timeout=60)
    if not (r and r.get("ok")):
        fails.append("homeAxes refused")
    time.sleep(1.0)
    start = br.wait_still(timeout=60, quiet=2.0)
    print(f"after homing {start}, state {br.state()}")

    # Homing ends at the top of each axis, so move toward -X / -Y.
    br.call("jog", {"axis": "X", "deltaMm": -5, "feedMmMin": 1000})
    p = br.wait_still()
    print(f"after jog X -5: {p}")
    if not close(p[0], start[0] - 5):
        fails.append(f"jog: X {p[0]} not {start[0] - 5}")

    x0, y0 = p[0], p[1]
    square = [(x0 - 20, y0), (x0 - 20, y0 - 20), (x0, y0 - 20), (x0, y0)]
    moves = [{"id": i + 1, "kind": "line", "to": {"x": x, "y": y}, "feedMmMin": 1200, "machineAbsolute": True}
             for i, (x, y) in enumerate(square)]
    r = br.call("loadMoves", {"moves": moves, "frame": "work"})
    if not (r and r.get("ok")):
        fails.append("loadMoves refused")
    br.call("startJob")
    time.sleep(1.5)
    br.call("pauseJob")
    time.sleep(0.5)
    p1 = br.pos()
    time.sleep(1.0)
    p2 = br.pos()
    print(f"paused at {p1}, 1 s later {p2}")
    if p1 != p2:
        fails.append(f"pause did not hold: {p1} -> {p2}")
    if close(p1[0], x0) and close(p1[1], y0):
        fails.append("the job had not moved before the pause")
    br.call("resumeJob")
    time.sleep(0.5)
    p = br.wait_still(timeout=30)
    print(f"after the job: {p}")
    if not (close(p[0], x0) and close(p[1], y0)):
        fails.append(f"job ended at {p}, not back at {x0, y0}")
    br.call("stopJob")
    print("PASS" if not fails else "FAIL: " + "; ".join(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
