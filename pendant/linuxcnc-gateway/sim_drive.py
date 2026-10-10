#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""WO-1986 Tier 2: drive the gateway against a RUNNING LinuxCNC and measure.

Starts gateway.py as its own process on a loopback port, connects to it as a
WebSocket client exactly as LienCAM does, and exercises status, E-STOP, reset,
home, jog, continuous jog + stop, MDI, work offsets, program load/run/pause/
resume/stop, a stop during a running program, socket loss and the one-session
rule. Prints ONE JSON object of measurements on the last stdout line.

Run inside the WO-1982 simulator container:
    python3 sim_drive.py
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gateway as gw  # noqa: E402

PROGRAM = """(WO-1986 drive program)
G21 G90 G17
G0 X5 Y5 Z-1
G1 X15 F600
G1 Y15
G4 P1.0
G1 X5
G1 Y5
"""

LONG_PROGRAM = "G21 G90\nG0 X0 Y0 Z-1\n" + "".join(
    f"G1 X{20 + (i % 2) * 20} Y{(i % 5) * 4} F300\n" for i in range(40))


class Client:
    def __init__(self, conn: gw.WsConnection):
        self.conn = conn
        self.frames: List[Dict[str, Any]] = []
        self.seq = 0
        self.replies: Dict[int, asyncio.Future] = {}
        self.status: Optional[Dict[str, Any]] = None
        self.status_at = 0.0
        self.task = asyncio.ensure_future(self.pump())

    async def pump(self) -> None:
        try:
            while True:
                msg = json.loads(await self.conn.recv_text())
                msg['_at'] = time.monotonic()
                self.frames.append(msg)
                if msg['t'] == 'status':
                    self.status = msg['v']
                    self.status_at = msg['_at']
                elif msg['t'] == 'reply':
                    fut = self.replies.pop(msg['seq'], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
        except Exception:
            pass

    async def call(self, m: str, a: Optional[Dict[str, Any]] = None, timeout: float = 15.0) -> Dict[str, Any]:
        self.seq += 1
        fut = asyncio.get_event_loop().create_future()
        self.replies[self.seq] = fut
        await self.conn.send_text(json.dumps({'t': 'call', 'seq': self.seq, 'm': m, 'a': a or {}}))
        return await asyncio.wait_for(fut, timeout)

    def hold(self, every: float = 0.075) -> 'asyncio.Task':
        """jogHold on the panel's cadence (JogPanel.tsx: first hold at once,
        then every 75 ms), fire-and-forget as uccncController sends it. Cancel
        the task to let go of the button."""
        async def keep() -> None:
            while True:
                self.seq += 1
                await self.conn.send_text(json.dumps({'t': 'call', 'seq': self.seq, 'm': 'jogHold', 'a': {}}))
                await asyncio.sleep(every)
        return asyncio.ensure_future(keep())

    async def until(self, predicate: Callable[[Dict[str, Any]], bool], timeout: float, what: str) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.status is not None and predicate(self.status):
                return self.status
            await asyncio.sleep(0.01)
        raise RuntimeError(f'timed out waiting for {what}; last status {json.dumps(self.status)[:600]}')

    async def event(self, t: str, predicate: Callable[[Dict[str, Any]], bool], since: int, timeout: float, what: str) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for f in self.frames[since:]:
                if f['t'] == t and predicate(f['v']):
                    return f
            await asyncio.sleep(0.01)
        raise RuntimeError(f'timed out waiting for {what}')

    async def close(self) -> None:
        await self.conn.close()
        self.task.cancel()


def first_estop_ms(c: 'Client', t0: float) -> Optional[float]:
    """From the call to the first status FRAME reporting E-STOP, by the frame's
    own arrival time - not by when this script got round to looking."""
    for f in c.frames:
        if f['t'] == 'status' and f['_at'] >= t0 and (f['v'].get('inputs') or {}).get('estop'):
            return round((f['_at'] - t0) * 1000, 1)
    return None


def x_of(status: Dict[str, Any]) -> float:
    return status['machinePos']['x']


async def stationary(c: Client, gap: float = 0.3) -> Dict[str, float]:
    a = dict(c.status['machinePos'])
    await asyncio.sleep(gap)
    b = dict(c.status['machinePos'])
    return {'before': a['x'], 'after': b['x'], 'moved': round(abs(b['x'] - a['x']), 6)}


async def drive(port: int, out: Dict[str, Any]) -> Dict[str, Any]:
    c = Client(await gw.ws_client('127.0.0.1', port))
    await c.until(lambda s: True, 5, 'first status')
    hello = next(f for f in c.frames if f['t'] == 'hello')['v']
    out['firstFrame'] = c.frames[0]['t']
    out['hello'] = {k: hello[k] for k in ('protocol', 'bridge', 'controller', 'linuxcncVersion', 'coordinates', 'capabilities', 'positionKnowledge', 'homingCycle')}

    # One session at a time: a second client is refused while this one lives.
    try:
        second = await gw.ws_client('127.0.0.1', port)
        await second.close()
        out['secondSessionRefused'] = False
    except ConnectionError as error:
        out['secondSessionRefused'] = str(error)

    # E-STOP from whatever state the simulator was left in, timed to the
    # status frame that reports it.
    t0 = time.monotonic()
    r = await c.call('emergencyStop')
    await c.until(lambda s: s['inputs']['estop'], 3, 'estop in status')
    out['estopReply'] = {k: r.get(k) for k in ('ok', 'outcome')}
    out['estopReplyMs'] = round((r['_at'] - t0) * 1000, 1)
    out['estopToStatusMs'] = first_estop_ms(c, t0)
    out['stateInEstop'] = c.status['state']

    r = await c.call('resetToIdle')
    out['resetToIdle'] = r.get('v')
    await c.until(lambda s: not s['inputs']['estop'] and s['state'] in ('idle', 'jog'), 5, 'idle after reset')

    # Home: the reply accepts the cycle; the `homed` push reports it.
    mark = len(c.frames)
    out['homedBeforeHome'] = dict(c.status['homed'])
    r = await c.call('home')
    out['homeReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    # A machine homed by an earlier run re-homes: see the cycle START before
    # waiting for it to finish, or the wait would pass on stale flags.
    await c.until(lambda s: s['state'] == 'home' or not all(s['homed'].values()), 10, 'homing to start')
    await c.until(lambda s: all(s['homed'].values()), 60, 'all axes homed')
    homed_pushes = [f['v'] for f in c.frames[mark:] if f['t'] == 'homed']
    out['homedPushes'] = homed_pushes
    out['positionKnowledgeAfterHome'] = c.status['positionKnowledge']
    await c.until(lambda s: s['state'] == 'idle', 10, 'idle after home')

    # Incremental jog.
    x0 = x_of(c.status)
    r = await c.call('jog', {'axis': 'X', 'deltaMm': 2, 'feedMmMin': 600})
    out['jogReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await c.until(lambda s: abs(x_of(s) - (x0 + 2)) < 0.001 and s['state'] == 'idle', 10, 'jog +2')
    out['jogDelta'] = round(x_of(c.status) - x0, 6)

    # Continuous jog held by the panel's jogHold keepalive, then the
    # dedicated stop. The holds start before the start's reply, as the panel's.
    x0 = x_of(c.status)
    holding = c.hold()
    r = await c.call('jogStart', {'axis': 'X', 'direction': 1, 'feedMmMin': 300})
    out['jogContinuousReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await c.until(lambda s: x_of(s) - x0 > 0.5, 5, 'continuous jog moving')
    x1 = x_of(c.status)
    await asyncio.sleep(0.8)  # > three deadman windows, held throughout
    out['heldJog'] = {'movedWhileHeld': round(x_of(c.status) - x1, 3), 'state': c.status['state']}
    t0 = time.monotonic()
    r = await c.call('jogStop')
    holding.cancel()
    out['jogStopReplyMs'] = round((time.monotonic() - t0) * 1000, 1)
    await c.until(lambda s: s['state'] == 'idle', 3, 'idle after jogStop')
    out['afterJogStop'] = await stationary(c)

    # The deadman: holds cease while the socket stays open (a frozen panel).
    x0 = x_of(c.status)
    holding = c.hold()
    await c.call('jogStart', {'axis': 'X', 'direction': -1, 'feedMmMin': 300})
    await c.until(lambda s: x0 - x_of(s) > 0.5, 5, 'deadman jog moving')
    await asyncio.sleep(0.3)
    mark = len(c.frames)
    holding.cancel()
    released = time.monotonic()
    await c.until(lambda s: s['state'] == 'idle', 3, 'idle after the deadman')
    out['deadmanStopMs'] = round((time.monotonic() - released) * 1000, 1)
    out['afterDeadman'] = await stationary(c)
    await asyncio.sleep(0.1)
    out['deadmanConsole'] = [f['v']['text'] for f in c.frames[mark:] if f['t'] == 'console' and 'deadman' in f['v']['text']]

    # MDI.
    r = await c.call('sendCommandAwait', {'text': 'G21 G90 G0 X10 Y5 Z-1'})
    out['mdiReply'] = r.get('v')
    await c.until(lambda s: s['state'] == 'idle', 10, 'idle after MDI')
    out['afterMdi'] = c.status['machinePos']

    # MDI that LinuxCNC refuses: its own sentence comes back.
    r = await c.call('sendCommandAwait', {'text': 'G99999'})
    out['mdiRefused'] = r.get('v')

    # Work offsets: set G54 to the current machine position; workPos -> 0.
    r = await c.call('selectWcs', {'wcs': 'G54'})
    r = await c.call('setWorkOffset', {'wcs': 'G54', 'x': 10, 'y': 5, 'z': -1})
    out['setWorkOffset'] = r.get('v')
    await asyncio.sleep(0.3)
    out['workPosAfterSetOffset'] = c.status['workPos']
    r = await c.call('sendCommandAwait', {'text': 'G21 G90 G0 X3'})
    await c.until(lambda s: s['state'] == 'idle', 10, 'idle after X3')
    r = await c.call('zeroWorkAxis', {'axis': 'X'})
    out['zeroWorkAxis'] = r.get('v')
    await asyncio.sleep(0.3)
    out['workPosAfterZero'] = c.status['workPos']
    out['machinePosAfterZero'] = c.status['machinePos']
    await c.call('setWorkOffset', {'wcs': 'G54', 'x': 0, 'y': 0, 'z': 0})

    # Program: load (no M2 - the gateway ends it and says so), run to the end,
    # sampling LinuxCNC's three line numbers (the research doc's open question).
    r = await c.call('loadJob', {'programText': PROGRAM})
    load = r.get('v') or {}
    out['loadJob'] = {k: load.get(k) for k in ('ok', 'reason', 'lines', 'appendedEnd', 'notes')}
    mark = len(c.frames)
    t0 = time.monotonic()
    r = await c.call('startJob')
    out['startJobReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    samples = []
    done = None
    while time.monotonic() - t0 < 60:
        s = c.status
        lc = s.get('linuxcnc') or {}
        sample = (lc.get('motionLine'), lc.get('currentLine'), lc.get('readLine'), s['state'])
        if not samples or samples[-1][1:] != sample:
            samples.append((round(time.monotonic() - t0, 3),) + sample)
        done = next((f for f in c.frames[mark:] if f['t'] == 'jobEvent' and f['v']['event'] in ('completed', 'failed', 'stopped')), None)
        if done:
            break
        await asyncio.sleep(0.02)
    out['jobEvents'] = [f['v']['event'] for f in c.frames[mark:] if f['t'] == 'jobEvent']
    out['jobSeconds'] = round((done['_at'] - t0), 3) if done else None
    out['lineSamples'] = [{'t': t, 'motionLine': m, 'currentLine': cur, 'readLine': rd, 'state': st} for t, m, cur, rd, st in samples]
    out['stateAtCompleted'] = c.status['state']

    # Resume with nothing paused: LinuxCNC's answer, never "accepted".
    mark = len(c.frames)
    r = await c.call('resumeJob')
    out['resumeNotPaused'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await asyncio.sleep(0.2)
    out['resumeNotPausedEvents'] = [f['v']['event'] for f in c.frames[mark:] if f['t'] == 'jobEvent']

    # Pause / resume / stop on a longer program.
    r = await c.call('loadJob', {'programText': LONG_PROGRAM})
    out['longLoad'] = {k: (r.get('v') or {}).get(k) for k in ('ok', 'reason')}
    mark = len(c.frames)
    r = await c.call('startJob')
    out['longStartReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await c.until(lambda s: s['state'] == 'run', 5, 'running')
    await asyncio.sleep(0.5)
    r = await c.call('resumeJob')
    out['resumeWhileRunning'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    r = await c.call('pauseJob')
    out['pauseReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await c.until(lambda s: s['state'] == 'hold', 5, 'hold')
    # LinuxCNC reports the pause as it starts decelerating: one Tier 2 run
    # read 0.0034 mm of that ramp as 'moved'. Stillness is measured once the
    # ramp (a few ms at 300 mm/min) is over.
    await asyncio.sleep(0.1)
    out['whilePaused'] = await stationary(c)
    r = await c.call('resumeJob')
    out['resumeReply'] = {k: r.get(k) for k in ('ok', 'outcome', 'error')}
    await c.until(lambda s: s['state'] == 'run', 5, 'running again')
    await asyncio.sleep(0.3)
    t0 = time.monotonic()
    r = await c.call('stopJob')
    out['stopJobReplyMs'] = round((time.monotonic() - t0) * 1000, 1)
    await c.until(lambda s: s['state'] == 'idle', 5, 'idle after stopJob')
    out['afterStopJob'] = await stationary(c)
    out['pauseResumeStopEvents'] = [f['v']['event'] for f in c.frames[mark:] if f['t'] == 'jobEvent']

    # E-STOP during a running program.
    r = await c.call('loadJob', {'programText': LONG_PROGRAM})
    mark = len(c.frames)
    await c.call('startJob')
    await c.until(lambda s: s['state'] == 'run', 5, 'running for estop')
    await asyncio.sleep(0.4)
    t0 = time.monotonic()
    await c.call('emergencyStop')
    await c.until(lambda s: s['inputs']['estop'], 3, 'estop during run')
    out['estopDuringRunToStatusMs'] = first_estop_ms(c, t0)
    out['afterEstopDuringRun'] = await stationary(c)
    out['estopDuringRunEvents'] = [(f['t'], f['v'].get('event') or f['v'].get('message')) for f in c.frames[mark:] if f['t'] in ('jobEvent', 'alarm')]
    out['homedAfterEstop'] = c.status['homed']

    # Socket loss stops a continuous jog.
    await c.call('resetToIdle')
    await c.until(lambda s: not s['inputs']['estop'], 5, 'reset after run estop')
    holding = c.hold()
    r = await c.call('jogStart', {'axis': 'X', 'direction': 1, 'feedMmMin': 300})
    await c.until(lambda s: s['state'] == 'jog', 5, 'jogging before socket loss')
    holding.cancel()  # the socket goes before the deadman's window ends
    await c.close()
    await asyncio.sleep(0.5)
    c2 = Client(await gw.ws_client('127.0.0.1', port))
    await c2.until(lambda s: True, 5, 'status after reconnect')
    out['afterSocketLoss'] = await stationary(c2)
    out['stateAfterSocketLoss'] = c2.status['state']
    await c2.call('emergencyStop')
    await c2.close()
    return out


def main() -> int:
    program_dir = '/tmp/wo1986-programs'
    result: Dict[str, Any] = {}
    # Simulator-only fixture: back to where the stock sim boots (see sim_reset.py).
    reset = subprocess.run([sys.executable, os.path.join(HERE, 'sim_reset.py')], capture_output=True, text=True, timeout=120)
    result['simReset'] = {'rc': reset.returncode, 'out': reset.stdout.strip()[-500:], 'err': reset.stderr.strip()[-500:]}
    if reset.returncode != 0:
        result['ok'] = False
        result['error'] = 'sim_reset.py could not put the simulator back at its boot position'
        print(json.dumps(result, sort_keys=True))
        return 1
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, 'gateway.py'), '--port', '0',
                             '--program-dir', program_dir], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline()
        if not line:
            print(proc.stderr.read(), file=sys.stderr)
            return 1
        ready = json.loads(line)
        result['gatewayReady'] = ready
        asyncio.run(drive(ready['listening'], result))
        result['ok'] = True
    except Exception as error:
        result['ok'] = False
        result['error'] = f'{type(error).__name__}: {error}'
    finally:
        proc.terminate()
        try:
            _out, err = proc.communicate(timeout=5)
        except Exception:
            proc.kill()
            err = ''
    result['gatewayStderr'] = (err or '')[-2000:]
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
