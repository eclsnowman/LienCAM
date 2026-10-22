#!/usr/bin/env python3
"""One bridge UDP loss/return regression, only in a --network none container.
Uses the real native bridge, isolated fake serial 0BEEF0, and existing WebSocket
client. No real network or hardware route is permitted. Run in the foreground.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--label', choices=['old', 'new'], required=True)
a = p.parse_args()
root = Path('/repo')
base = root / 'pendant/uc100net'
evidence = root / 'src/tests/evidence/WO-2895'
for command in [
    ['ip', 'link', 'add', 'oracle0', 'type', 'dummy'],
    ['ip', 'addr', 'add', '10.10.10.10/24', 'dev', 'oracle0'],
    ['ip', 'addr', 'add', '10.10.10.11/24', 'dev', 'oracle0'],
    ['ip', 'link', 'set', 'oracle0', 'up'],
    ['ip', 'route', 'add', '255.255.255.255', 'dev', 'oracle0', 'src', '10.10.10.10'],
]:
    subprocess.run(command, check=True)
assert sorted(x.name for x in Path('/sys/class/net').iterdir()) == ['lo', 'oracle0']
sys.path.insert(0, str(base / 'tools/wine'))
from ws_drive import Bridge  # noqa: E402

# Each run gets fresh runtime records; never touch packaged resources or a
# machine definition. .NET build's canonical output path is unchanged.
bundle = base / 'work' / f'link-loss-bridge-{a.label}'
if bundle.exists():
    shutil.rmtree(bundle)
shutil.copytree(root / 'pendant/uccnc-bridge/bin/Release/net10.0', bundle)
for record in bundle.glob('liencam-bridge.*.json*'):
    if record.name not in ['liencam-bridge.deps.json', 'liencam-bridge.runtimeconfig.json']:
        record.unlink()
log = evidence / f'link-loss-bridge-{a.label}.log'
wire = evidence / f'link-loss-bridge-{a.label}-wire.jsonl'
env = {**os.environ, 'DOTNET_ROOT': '/dotnet', 'UC100NET_INTERFACES': '10.10.10.10',
       'UC100NET_RT_PRIORITY': '40', 'LIENCAM_BRIDGE_HOST_CONSOLE': '1'}
children = []
br = None


def wait_for(predicate, seconds, message):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(message)


try:
    with (evidence / f'link-loss-bridge-{a.label}-fake.log').open('w') as fake_out, log.open('w') as bridge_out:
        fake = subprocess.Popen([sys.executable, '-I', str(base / 'tools/fake_board.py'),
                                 '--duration', '120', '--log', str(wire)],
                                stdout=fake_out, stderr=subprocess.STDOUT, env=env)
        children.append(fake)
        time.sleep(1.2)
        assert fake.poll() is None
        bridge = subprocess.Popen(['/dotnet/dotnet', str(bundle / 'liencam-bridge.dll'),
                                   '--install-root', '/handoff/work/wine/UCCNC12115',
                                   '--profile', 'LienCNCV2.pro', '--board', 'auto',
                                   '--port', '18325', '--bind', '127.0.0.1'],
                                  cwd=bundle, stdout=bridge_out, stderr=subprocess.STDOUT, env=env)
        children.append(bridge)
        wait_for(lambda: 'Listening' in log.read_text() or 'listening' in log.read_text(), 20, 'bridge did not listen')
        br = Bridge('127.0.0.1', 18325)
        wait_for(lambda: br.hello is not None and br.state() == 'idle', 10, 'no live initial status')
        print('initial fake-board readback:', json.dumps(br.status), flush=True)
        fake.send_signal(signal.SIGSTOP)
        wait_for(lambda: '*** THE CONTROLLER LINK IS GONE ***' in log.read_text(), 5,
                 'dead UDP link must reach the existing bridge lost-board handler')
        assert log.read_text().count('*** THE CONTROLLER LINK IS GONE ***') == 1
        wait_for(lambda: br.state() == 'unknown', 3, 'lost board must not report idle')
        print('lost fake-board status:', json.dumps(br.status), flush=True)
        reply = br.call('jog', {'axis': 'X', 'deltaMm': -1, 'feedMmMin': 60})
        assert reply and reply.get('ok') is True and reply.get('v') is False, 'jog must not queue on a lost board'
        time.sleep(0.3)
        assert log.read_text().count('*** THE CONTROLLER LINK IS GONE ***') == 1
        fake.send_signal(signal.SIGCONT)
        wait_for(lambda: 'THE CONTROLLER IS OPEN AGAIN' in log.read_text(), 15, 'bridge did not reopen the returned fake')
        wait_for(lambda: br.state() == 'idle', 5, 'reopened board must report live idle')
        print('reopened fake-board readback:', json.dumps(br.status), flush=True)
        assert log.read_text().count('*** THE CONTROLLER LINK IS GONE ***') == 1
        # Machine.Open sends a dummy sentinel at each successful configuration.
        # Permit exactly those two Rest records, never a position/jog trajectory.
        rows = [json.loads(row) for row in wire.read_text().splitlines()]
        motions = [row for row in rows if row['port'] == 4912 and bytes.fromhex(row['plain'])[3] == 2]
        rest = bytes.fromhex('0000000000001038') + bytes(24) + bytes([3]) + bytes(15)
        assert len(motions) == 2, f'expected the two Open sentinels, got {len(motions)}'
        for row in motions:
            plain = bytes.fromhex(row['plain'])
            assert plain[6] == 1 and plain[7:55] == rest, 'unexpected trajectory record'
        assert br.pos() == (0, 0, 0)
        assert br.status['buffer']['moves'] == 0
        print('PASS: one lost-link console line; jog refused; explicit bridge reopen; only two nonmoving Open sentinels, zero position records', flush=True)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
