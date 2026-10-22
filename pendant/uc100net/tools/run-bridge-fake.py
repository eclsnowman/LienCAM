#!/usr/bin/env python3
"""Foreground fake-board smoke/replay; run only in the isolated bench container.
The container must have --network none. No host networking or hardware route.
"""
import argparse
import os
from pathlib import Path
import subprocess
import shutil
import sys
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--session', help='read-only recording; omit to run the T1 smoke')
a = p.parse_args()
root = Path('/repo')
evidence = root / 'src/tests/evidence/WO-2895'
name = 'replay' if a.session else 'smoke'
# NET_ADMIN is confined to this container's namespace. It has no outside NIC.
for command in [
    ['ip', 'link', 'add', 'oracle0', 'type', 'dummy'],
    ['ip', 'addr', 'add', '10.10.10.10/24', 'dev', 'oracle0'],
    ['ip', 'addr', 'add', '10.10.10.11/24', 'dev', 'oracle0'],
    ['ip', 'link', 'set', 'oracle0', 'up'],
    ['ip', 'route', 'add', '255.255.255.255', 'dev', 'oracle0', 'src', '10.10.10.10'],
]:
    subprocess.run(command, check=True)
# Prove namespace isolation before any discovery.
interfaces = sorted(Path('/sys/class/net').iterdir())
if [x.name for x in interfaces] != ['lo', 'oracle0']:
    raise SystemExit('not an isolated fake-board namespace')
base = root / 'pendant/uc100net'
# Keep package inputs pristine: the bridge writes runtime records beside its
# executable, so fake-board runs use a separate copy under ignored work/.
bundle = base / 'work' / f'native-{name}'
shutil.copytree(base / 'publish/linux-arm64', bundle, dirs_exist_ok=True)
probe = evidence / f'{name}-probe.txt'
for file in [bundle / 'liencam-bridge.definition.json', probe]:
    file.unlink(missing_ok=True)
env = {**os.environ, 'UC100NET_INTERFACES': '10.10.10.10', 'UC100NET_RT_PRIORITY': '40',
       'LIENCAM_BRIDGE_HOST_CONSOLE': '1'}
children = []
try:
    with (evidence / f'{name}-fake-out.log').open('w') as fake_out, (evidence / f'{name}-bridge-out.log').open('w') as bridge_out:
        children.append(subprocess.Popen([
            sys.executable, '-I', str(base / 'tools/fake_board.py'), '--duration', '3600',
            '--log', str(evidence / f'{name}-fake.jsonl'), '--probe-file', str(probe),
        ], stdout=fake_out, stderr=subprocess.STDOUT, env=env))
        time.sleep(1.5)
        children.append(subprocess.Popen([
            str(bundle / 'liencam-bridge'), '--install-root', '/handoff/work/wine/UCCNC12115',
            '--profile', 'LienCNCV2.pro', '--board', 'auto', '--port', '18325', '--bind', '127.0.0.1',
        ], stdout=bridge_out, stderr=subprocess.STDOUT, env=env))
        if a.session:
            command = [sys.executable, '-I', str(base / 'tools/b6/replay_session.py'), a.session,
                       '--port', '18325', '--probe-file', str(probe)]
        else:
            command = [sys.executable, '-I', str(base / 'tools/wine/ws_drive.py'), '--port', '18325']
        result = subprocess.run(command, env=env)
        print(f'{name} exit {result.returncode}', flush=True)
        raise SystemExit(result.returncode)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
