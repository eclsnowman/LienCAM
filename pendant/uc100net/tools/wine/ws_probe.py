"""Connect to a running LienCAM UCCNC bridge's WebSocket and report what it
says (track A test T1, PLAN.md): the hello frame, how many status frames
arrive per second, and one status sample. Read-only: it sends no calls.

    python -I tools/wine/ws_probe.py [--host 127.0.0.1] [--port 8325] [--seconds 5]

Exit 0 when a hello and at least one status per second arrived. Stdlib only.
"""
import argparse
import base64
import collections
import json
import os
import socket
import sys
import time


def handshake(sock, host, port):
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1024)
        if not chunk:
            raise ConnectionError("closed during handshake")
        head += chunk
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise ConnectionError(f"handshake refused: {status!r}")
    return head.split(b"\r\n\r\n", 1)[1]


def frames(sock, buf):
    """Yield text payloads of unmasked server frames (fragments not expected)."""
    while True:
        while len(buf) < 2:
            buf += sock.recv(65536)
        b0, b1 = buf[0], buf[1]
        n, i = b1 & 0x7F, 2
        if n == 126:
            while len(buf) < 4:
                buf += sock.recv(65536)
            n, i = int.from_bytes(buf[2:4], "big"), 4
        elif n == 127:
            while len(buf) < 10:
                buf += sock.recv(65536)
            n, i = int.from_bytes(buf[2:10], "big"), 10
        while len(buf) < i + n:
            buf += sock.recv(65536)
        payload, buf = buf[i:i + n], buf[i + n:]
        if b0 & 0x0F == 0x8:
            return
        if b0 & 0x0F == 0x1:
            yield payload.decode("utf-8", "replace")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8325)
    ap.add_argument("--seconds", type=float, default=5.0)
    a = ap.parse_args(argv)
    deadline = time.monotonic() + 30
    while True:
        try:
            sock = socket.create_connection((a.host, a.port), timeout=5)
            break
        except OSError:
            if time.monotonic() > deadline:
                print("no bridge listening")
                return 2
            time.sleep(0.5)
    sock.settimeout(a.seconds + 5)
    rest = handshake(sock, a.host, a.port)
    counts, hello, status = collections.Counter(), None, None
    t0 = time.monotonic()
    for text in frames(sock, rest):
        msg = json.loads(text)
        counts[msg.get("t")] += 1
        if msg.get("t") == "hello" and hello is None:
            hello = msg.get("v", {})
        if msg.get("t") == "status" and status is None:
            status = msg.get("v")
        if time.monotonic() - t0 > a.seconds:
            break
    sock.close()
    elapsed = time.monotonic() - t0
    if hello:
        u = hello.get("uccnc", {})
        print(f"hello: bridge {hello.get('bridge')} protocol {hello.get('protocol')} readOnly {hello.get('readOnly')} "
              f"board {u.get('board')} profile {u.get('profile')} uc100Dll {u.get('uc100Dll')}")
    print(f"messages in {elapsed:.1f} s: {dict(counts)}")
    if status is not None:
        print("status sample:", json.dumps(status)[:600])
    rate = counts.get("status", 0) / max(elapsed, 0.1)
    print(f"status rate {rate:.1f} /s")
    return 0 if hello and rate >= 1 else 1


if __name__ == "__main__":
    sys.exit(main())
