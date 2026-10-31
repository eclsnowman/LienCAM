"""Replay a recorded LienCAM session (handoff 07-ws-frames) against a running
bridge and compare its replies with the ones recorded on the real machine.

    python -I tools/b6/replay_session.py <session.ws-frames.ndjson> [--port 18325] [--max-gap 2.0]

Sends every call the browser sent ("tx"), in order, except queryStatus and
refreshState (the bridge pushes status anyway). Before each call it waits the
recorded gap, capped at --max-gap seconds; when the recorded gap was longer,
it also waits (up to the gap, at most --settle seconds) until the machine has
stopped moving, so a call recorded after a job ended is not sent while the
replayed job still runs. Use it only against a fake board: it moves the
machine.

Prints each call whose reply differs in ok / error from the recording, and a
summary by method. Also compares the state and machine position of the last
status frame before each call (recorded vs replayed) and prints where the
position first diverges by more than --pos-tol mm.

--probe-file PATH (the fake's --probe-file): before each probe call, writes
the travel the real machine made to its contact (recorded start position to
the recorded "at"), or "miss" for a recorded probe without contact, so the
fake touches where the real workpiece was. Stdlib only.
"""
import argparse
import collections
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "wine"))
from ws_drive import Bridge  # noqa: E402

SKIP = {"queryStatus", "refreshState"}


def load(path):
    """Calls the browser sent, each with the last status frame recorded before it."""
    calls, replies, status = [], {}, None
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        p = json.loads(r["payload"])
        if r["dir"] == "tx" and p.get("t") == "call":
            calls.append((r["t"] / 1000.0, p, status))
        elif r["dir"] == "rx" and p.get("t") == "reply":
            replies[p.get("seq")] = p
        elif r["dir"] == "rx" and p.get("t") == "status":
            status = p.get("v")
    return calls, replies


def outcome(reply):
    if reply is None:
        return "no reply"
    if not reply.get("ok"):
        return "error"
    v = reply.get("v")
    if isinstance(v, dict) and v.get("ok") is False:
        return "refused"
    if v is False:
        return "false"
    return "ok"


def probe_spec(p, rec_status, rec_reply):
    """The fake's per-probe contact, from the recorded start and reply."""
    ax = (p.get("a", {}).get("axis") or "").upper()
    v = (rec_reply or {}).get("v")
    at = (v or {}).get("at") if isinstance(v, dict) else None
    start = ((rec_status or {}).get("machinePos") or {}).get(ax.lower())
    if ax not in ("X", "Y", "Z") or not at or start is None:
        return "miss"
    return f"{'XYZ'.index(ax)},{abs(at[ax.lower()] - start):.4f}"


def xyz(status):
    p = (status or {}).get("machinePos") or {}
    return tuple(p.get(k) for k in "xyz")


def dist(a, b):
    if None in a or None in b:
        return None
    return max(abs(u - v) for u, v in zip(a, b))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("session")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18325)
    ap.add_argument("--max-gap", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=60.0)
    ap.add_argument("--pos-tol", type=float, default=0.05)
    ap.add_argument("--probe-file")
    a = ap.parse_args(argv)
    calls, recorded = load(a.session)
    deadline = time.monotonic() + 60   # the bridge waits for the board before it listens
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
    by_method = collections.defaultdict(lambda: [0, 0])
    state_diff = collections.Counter()
    pos_diffs = []
    last_t = None
    sent = 0
    for t, p, rec_status in calls:
        m = p.get("m")
        if m in SKIP:
            continue
        if last_t is not None:
            gap = max(t - last_t, 0)
            time.sleep(min(gap, a.max_gap))
            if gap > a.max_gap:
                br.wait_still(timeout=min(gap - a.max_gap, a.settle), quiet=1.0)
        last_t = t
        rec_state, now_state = (rec_status or {}).get("state"), br.state()
        if rec_state != now_state:
            state_diff[(rec_state, now_state)] += 1
        d = dist(xyz(rec_status), br.pos())
        if d is not None and d > a.pos_tol:
            pos_diffs.append((p.get("seq"), m, xyz(rec_status), br.pos()))
        want = outcome(recorded.get(p.get("seq")))
        if m == "probe" and a.probe_file:
            with open(a.probe_file, "w", encoding="utf-8") as f:
                f.write(probe_spec(p, rec_status, recorded.get(p.get("seq"))))
        br.seq += 1
        seq = br.seq
        br.send({"t": "call", "seq": seq, "m": m, "a": p.get("a", {})})
        with br.cv:
            br.cv.wait_for(lambda: seq in br.replies, 60)
            reply = br.replies.get(seq)
        got = outcome(reply)
        sent += 1
        by_method[m][0] += 1
        if got != want:
            by_method[m][1] += 1
            detail = (reply or {}).get("error") or json.dumps((reply or {}).get("v"))[:160]
            print(f"#{p.get('seq')} {m} {json.dumps(p.get('a', {}))[:100]}: recorded {want}, now {got}: {detail}",
                  flush=True)
    print(f"\n{sent} calls replayed; differences by method:")
    for m, (n, d) in sorted(by_method.items(), key=lambda kv: -kv[1][1]):
        print(f"  {m:24s} {n:5d} sent, {d:4d} differ")
    print("state before the call, recorded -> replayed (only where they differ):")
    for (r, n), c in state_diff.most_common():
        print(f"  {r} -> {n}: {c}")
    print(f"machine position differs by > {a.pos_tol} mm before {len(pos_diffs)} calls; first 10:")
    for seq, m, r, n in pos_diffs[:10]:
        print(f"  #{seq} {m}: recorded {r}, replayed {n}")
    print(f"bridge state at the end: {br.state()}, position {br.pos()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
