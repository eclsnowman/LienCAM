#!/usr/bin/env python3
"""UC100 Ethernet frame (de)obfuscation and a pcapng reader.

Clean-room reimplementation from the decompiled UC100.dll
(FUN_1800383c0 encode / FUN_1800385a0 decode in the 2204 build; see
docs/RE-FINDINGS.md section 3), checked against real AXBB-E captures by
`python tools/uc_proto.py <capture.pcapng>`.

Frame plaintext: '#' '-' '>' CMD nonceHi nonceLo payload... csumHi csumLo.
csum = 16-bit sum of bytes 0..n-3, big-endian. Bytes 4..5 (the nonce) are
sent in clear; every other byte has a keystream byte ADDED mod 256. The
keystream comes from a 32-bit LFSR seeded with 0x20140000 + nonce: each step
shifts right and feeds back bit0^bit2^bit4^bit6^bit31 into bit 31, and the
keystream byte is the sum of the four bytes of the new state.

Read-only analysis tool, stdlib only.
"""
import struct
import sys
from collections import Counter

SEED_BASE = 0x20140000


def lfsr_step(s):
    fb = (s ^ (s >> 2) ^ (s >> 4) ^ (s >> 6) ^ (s >> 31)) & 1
    return (fb << 31) | (s >> 1)


def _kbyte(s, skip_byte2=False):
    b = (s & 0xFF) + ((s >> 8) & 0xFF) + (s >> 24)
    if not skip_byte2:
        b += (s >> 16) & 0xFF
    return b & 0xFF


def keystream_positions(n):
    """Byte offsets that carry keystream, in keystream order."""
    return [0, 1, 2, 3] + list(range(6, n))


def decode(frame, warmup=2, quirk_byte2=False):
    """Return the plaintext of one obfuscated frame (bytes).

    warmup: LFSR steps discarded before byte 0. The DLL seeds, steps twice
    (FUN_180030950 in 2190), then steps once more per keystream byte.
    quirk_byte2: reproduce the decompiled decoder's missing (s>>16) term at
    byte 2. Which variant matches the wire is what main() measures.
    """
    p = bytearray(frame)
    s = SEED_BASE + (p[4] << 8 | p[5])
    for _ in range(warmup):
        s = lfsr_step(s)
    for i in keystream_positions(len(p)):
        s = lfsr_step(s)
        p[i] = (p[i] - _kbyte(s, quirk_byte2 and i == 2)) & 0xFF
    return bytes(p)


def encode(plain, warmup=2, from_board=False):
    """Inverse of decode() (default variant); fills in the checksum.

    from_board=True writes the checksum little-endian, as the board does
    (see frame_ok); used to synthesize board replies for tests and the fake
    board.
    """
    p = bytearray(plain)
    csum = sum(p[:-2]) & 0xFFFF
    hi, lo = csum >> 8, csum & 0xFF
    p[-2], p[-1] = (lo, hi) if from_board else (hi, lo)
    s = SEED_BASE + (p[4] << 8 | p[5])
    for _ in range(warmup):
        s = lfsr_step(s)
    for i in keystream_positions(len(p)):
        s = lfsr_step(s)
        p[i] = (p[i] + _kbyte(s)) & 0xFF
    return bytes(p)


def frame_ok(plain, from_board=False):
    """(magic ok, checksum ok) for a decoded frame.

    The host writes the checksum big-endian (FUN_1800383c0). The board writes
    it LITTLE-endian: measured 2890/2890 on uccnc.pcapng, vs 13/2890
    big-endian, i.e. chance. The DLL's decoder tests big-endian and evidently
    ignores the result for replies.
    """
    magic = plain[:3] == b"#->"
    stored = (plain[-1] << 8 | plain[-2]) if from_board else (plain[-2] << 8 | plain[-1])
    csum = (sum(plain[:-2]) & 0xFFFF) == stored
    return magic, csum


# ---------------------------------------------------------------- pcapng

def udp_packets(path):
    """Yield (t_seconds, src_ip, sport, dst_ip, dport, payload) from a pcapng.

    Handles Ethernet (linktype 1) and raw IPv4 (101/228). pktmon writes each
    frame once per stack layer, so callers de-duplicate (see dedup()).
    """
    with open(path, "rb") as f:
        data = f.read()
    off, linktypes, tsres = 0, [], []
    while off + 12 <= len(data):
        btype, blen = struct.unpack_from("<II", data, off)
        body = data[off + 8: off + blen - 4]
        if btype == 1:  # Interface Description Block
            linktypes.append(struct.unpack_from("<H", body, 0)[0])
            tsres.append(1e-6)
            o = 8  # options: look for if_tsresol (code 9)
            while o + 4 <= len(body):
                code, ln = struct.unpack_from("<HH", body, o)
                if code == 0:
                    break
                if code == 9:
                    v = body[o + 4]
                    tsres[-1] = 2.0 ** -(v & 0x7F) if v & 0x80 else 10.0 ** -v
                o += 4 + ((ln + 3) & ~3)
        elif btype == 6:  # Enhanced Packet Block
            ifid, th, tl, caplen = struct.unpack_from("<IIII", body, 0)
            pkt = body[20:20 + caplen]
            t = ((th << 32) | tl) * tsres[ifid]
            lt = linktypes[ifid]
            if lt == 1:
                if len(pkt) < 14:
                    pkt = b""
                else:
                    ethertype = struct.unpack_from(">H", pkt, 12)[0]
                    pkt = pkt[14:] if ethertype == 0x0800 else b""
            if len(pkt) >= 28 and pkt[0] >> 4 == 4 and pkt[9] == 17:
                ihl = (pkt[0] & 0x0F) * 4
                src = ".".join(map(str, pkt[12:16]))
                dst = ".".join(map(str, pkt[16:20]))
                sport, dport, ulen = struct.unpack_from(">HHH", pkt, ihl)
                yield t, src, sport, dst, dport, pkt[ihl + 8: ihl + ulen]
        off += blen


def dedup(pkts, window=0.0015):
    """Drop pktmon's per-layer copies: same 5-tuple + payload within window."""
    last = {}
    for p in pkts:
        key = p[1:]
        t0 = last.get(key)
        last[key] = p[0]
        if t0 is not None and p[0] - t0 <= window:
            continue
        yield p


POLL_CMD = 0x0E  # 25-byte status poll / 153-byte status reply


def frames(path):
    """De-duplicated UC100 frames: (t, from_board, plaintext, valid)."""
    for t, src, sport, dst, dport, payload in dedup(udp_packets(path)):
        if not (4910 <= sport <= 4950 or 4910 <= dport <= 4950) or len(payload) < 8:
            continue
        from_board = sport in (4910, 4912)
        plain = decode(payload)
        m, c = frame_ok(plain, from_board)
        yield t, from_board, plain, m and c


def main(argv):
    timeline = "--timeline" in argv
    for path in [a for a in argv if not a.startswith("--")]:
        fs = list(frames(path))
        print(f"== {path}: {len(fs)} frames (de-duplicated)")
        for fb in (False, True):
            sub = [f for f in fs if f[1] == fb]
            print(f"   {'brd->host' if fb else 'host->brd'}: {sum(f[3] for f in sub)}/{len(sub)} valid (magic + checksum)")
        cmds = Counter((f[1], f[2][3], len(f[2]), f[3]) for f in fs)
        print("   direction  cmd   len  valid  count")
        for (fb, cmd, ln, v), n in sorted(cmds.items()):
            print(f"   {'brd->host' if fb else 'host->brd'}  0x{cmd:02x}  {ln:>4}  {str(v):5}  {n}")
        polls = [f[0] for f in fs if not f[1] and f[2][3] == POLL_CMD]
        if len(polls) > 2:
            gaps = sorted(b - a for a, b in zip(polls, polls[1:]))
            print(f"   poll interval ms: median {gaps[len(gaps) // 2] * 1e3:.1f}"
                  f"  p5 {gaps[len(gaps) // 20] * 1e3:.1f}  p95 {gaps[len(gaps) * 19 // 20] * 1e3:.1f}")
        if timeline:
            t0 = fs[0][0] if fs else 0
            for t, fb, plain, v in fs:
                if plain[3] == POLL_CMD:
                    continue
                print(f"   t={t - t0:8.3f} {'<-' if fb else '->'} cmd 0x{plain[3]:02x} len {len(plain):>3}"
                      f" {'ok ' if v else 'BAD'} {plain[6:min(len(plain) - 2, 30)].hex()}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
