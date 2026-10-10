# GRBL 1.1 protocol digest (implementation reference)

Researched 2026-07-30 from gnea/grbl wiki + doc/ CSVs, cncjs GrblController,
UGS, gSender, Candle. This is the ground-truth contract the machine-control
subsystem is built against. Sources at bottom.

## Serial fundamentals

- 115200 baud, 8-N-1. Commands are ASCII lines terminated `\n` (`\r\n` ok).
- Every accepted line answers `ok` or `error:N` (N = 1..38, see
  gnea/grbl `doc/csv/error_codes_en_US.csv`). Nothing in an errored line ran.
- Unsolicited push messages (independent of request/response):
  `<...>` status reports, `ALARM:N`, `[MSG:..]`, `[GC:..]`, `[VER:..]`,
  `[PRB:..]`, `$x=val` dump lines.
- Welcome banner `Grbl 1.1h ['$' for help]` on power-up and after soft
  reset -- detect it to confirm the device is GRBL and re-init is done.
- Soft reset = byte 0x18 (Ctrl-X). Halts immediately, reprints banner,
  clears parser/planner, PRESERVES alarm lock.
- Boot lands in ALARM when homing is enabled and not yet run, or after
  hard-limit/abort. All g-code answers error:9 until $X or $H.
- Alarm codes (doc/csv/alarm_codes_en_US.csv): 1 hard limit, 2 soft limit
  (position retained), 3 abort during cycle (position LOST), 4/5 probe fail,
  6-10 homing fails.

## Streaming: character-counting (the standard)

- GRBL RX buffer = 128 bytes; planner look-ahead ~15 blocks.
- Simple send-one-wait-ok starves the planner on short-segment paths
  (exactly what our CAM emits) -> stutter. Character-counting keeps the
  buffer full: send line N+1.. while inFlight + len(line)+1 <= LIMIT;
  pop the oldest line's byte count on each ok/error.
- cncjs uses LIMIT = 128 - 8 = 120 (safety margin). Do the same.
- Real-time bytes (below) BYPASS the RX buffer -- never count them.
- Pitfalls: never split a long line (error:11 is the controller's own
  overflow report); strip `%` program markers; strip comments before
  counting; on error:N the ALREADY-BUFFERED lines keep executing until
  the buffer drains -- a hard stop needs active intervention (stop feeding
  + feed hold). GRBL's advice: pre-validate with $C check mode.
- Error policy: default halt-and-surface on error:N mid-stream (cncjs
  default); optional ignore-errors mode later.
- Reference implementation: gnea/grbl doc/script/stream.py.

## Real-time commands (single bytes, act immediately, no line ending)

| Byte | Meaning |
|------|---------|
| `?` 0x3F | status report query |
| `~` 0x7E | cycle start / resume |
| `!` 0x21 | feed hold (decelerate, HOLD state) |
| 0x18 | soft reset |
| 0x84 | safety door |
| 0x85 | jog cancel (flush jog queue, back to Idle) |
| 0x90 | feed override reset 100% |
| 0x91 / 0x92 | feed override +10% / -10% |
| 0x93 / 0x94 | feed override +1% / -1% |
| 0x95 / 0x96 / 0x97 | rapid override 100% / 50% / 25% |
| 0x99 | spindle override reset 100% |
| 0x9A / 0x9B | spindle override +10% / -10% |
| 0x9C / 0x9D | spindle override +1% / -1% |
| 0x9E | spindle stop toggle (HOLD only) |
| 0xA0 / 0xA1 | flood / mist coolant toggle |

0x98 reserved/unused. Values are deliberately outside the typeable range.

## Status reports

- Query `?` -> `<State|Field|Field...>` in ~5-20ms.
  Example: `<Run|MPos:10.500,-2.300,0.000|FS:800,12000|Ov:100,100,100>`
- States: Idle, Run, Hold:0/1, Jog, Alarm, Door:0-3, Check, Home, Sleep.
- Position: MPos (machine) or WPos (work) per $10 mask. WPos = MPos - WCO.
- WCO:x,y,z arrives only every 10-30 reports or after offset changes --
  CACHE the last WCO and derive the missing one every report.
- Bf:blocks,bytes is debug-only -- never drive streaming from it (own tally
  is authoritative; Bf may be used to sanity-check).
- FS:feed,rpm = ACTUAL values (post-override). Ov:feed,rapid,spindle
  percentages, intermittent. A:SFM accessory letters. Pn:XYZPDHRS pin
  states. Ln:N line number (optional compile feature; often absent).
- Poll rate: <= 5Hz per GRBL guidance. Activity-scaled: ~5Hz during
  Run/Jog/Hold, ~1-2Hz Idle.

## Jogging

- `$J=G91 G21 X0.5 F1000` style. Feed word REQUIRED. Does not touch
  parser modal state; per-line G20/G21/G90/G91/G53 only.
- Jog cancel 0x85 flushes jog queue instantly, no reset needed.
- Incremental buttons: one $J per click. Continuous (hold): re-send short
  $J increments every 100-250ms while held, 0x85 on release (GRBL's own
  recommended pattern; keeps stop latency low).
- Bad jog target past travel = error:15/16, harmless.

## Settings, offsets, recovery

- `$$` settings dump ($N=value lines), `$x=val` write one.
- `$#` offsets dump: G54-G59, G28/G30 positions, TLO, last PRB.
- `$G` modal state. `$I` build info. `$C` check mode toggle.
- `$H` homing (needs $22=1). `$X` alarm unlock (operator-confirmed only).
- Work offsets by g-code: `G10 L20 P1 X0` = "current position becomes X0
  in G54" (the Zero button). `G10 L2 P1..P6` sets offsets directly.
  G54-G59 select.
- Tool length: G43.1 (dynamic) and G49 only. Classic G43 H-table is NOT
  in GRBL.
- Recovery contract: on ALARM -> stop stream, disable resume, show code
  meaning, offer $H (preferred) or $X (acknowledged risk). Never
  auto-resume. Door state also kills spindle/coolant -- distinct from Hold
  in the UI.

## Web Serial API

- Chromium desktop only (Chrome/Edge/Opera). Feature-detect
  `"serial" in navigator`; show plain guidance otherwise.
- Secure context: HTTPS or localhost.
- `navigator.serial.requestPort()` REQUIRES a user gesture (click).
- `port.open({ baudRate: 115200 })`.
- READS ARRIVE IN ARBITRARY CHUNKS: a line can split across reads or
  several lines can arrive in one chunk. Persistent line buffer required:
  accumulate, split on newline, keep the trailing partial.
- Writes: TextEncoder -> writable writer; append `\n` per command.
  Real-time bytes are written raw (single byte, no newline).
- `disconnect` event on unplug: cancel reader, close, reset state to
  disconnected; treat device state as unknown until banner re-seen.
- `navigator.serial.getPorts()` returns previously granted ports -->
  "reconnect last device" flow (still needs a gesture to open).

## Ecosystem (the branch-out path)

- grblHAL: wire-compatible with GRBL 1.1 by default (COMPATIBILITY_LEVEL);
  extensions (G59.1-3, tool-change handshake) can be enabled after the
  version banner identifies it.
- FluidNC: same protocol over USB serial AND WebSocket/Telnet -- a
  transport abstraction (SerialTransport now, WebSocketTransport later)
  reaches FluidNC with the same protocol layer.

## Sender UI notes (for the Control tab design)

- cncjs: composable widgets (connection, visualizer, console, DRO+jog,
  overrides, job status).
- UGS: five dockable panels (visualizer, DRO/state, jog, overrides,
  console).
- gSender: single "Carve" workspace praised by beginners; every control
  that MOVES the machine shares one accent color so motion is never a
  surprise -- adopt this rule.

## Sources

- https://github.com/gnea/grbl/wiki (Interface, Commands, Jogging,
  Configuration pages)
- https://github.com/gnea/grbl doc/csv/error_codes_en_US.csv,
  doc/csv/alarm_codes_en_US.csv, doc/script/stream.py
- https://github.com/cncjs/cncjs src/server/controllers/Grbl/
- https://github.com/winder/Universal-G-Code-Sender
- https://github.com/Sienci-Labs/gsender
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- http://wiki.fluidnc.com/en/features/grbl_compatibility
