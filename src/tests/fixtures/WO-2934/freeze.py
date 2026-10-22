"""Reproduce frozen legacy-output projects; no CAM, stamping, or re-generation.
Run at repo root. Output is deliberately not a shipped example or hardware job.
"""
import gzip
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
LEGACY = '43b41aab32bdc3335345feea730b5b54152a8c86'
CURRENT = '5c8751c92b5b33d8444d0e84ab605094a57f278f'

def read(rev, file):
    raw = subprocess.check_output(['git', 'show', f'{rev}:{file}'])
    return json.loads(raw), hashlib.sha256(raw).hexdigest()

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

records = []
for kit, rough in [('07-relief-medallion', '3D Rough 2'), ('06-knob-handwheel', '3D Rough 1')]:
    name = 'relief-medallion' if kit.startswith('07') else 'knob-handwheel'
    file = f'examples/{kit}/{name}.camproject'
    legacy, legacy_sha = read(LEGACY, file)
    current, current_sha = read(CURRENT, file)
    old_ops = legacy['setups'][0]['operations']
    ops = current['setups'][0]['operations']
    index = next(i for i, op in enumerate(ops) if op['name'] == rough)
    # Drop only later operations: the retained rough's predecessor inputs remain
    # identical. Retain complete geometry, documents and binaries for real Open.
    current['setups'][0]['operations'] = ops[:index + 1]
    old_rough = next(op for op in old_ops if op['name'] == rough)
    new_rough = ops[index]
    # WO-2926 changed generated results and added predecessor bookkeeping, not
    # authored machining inputs. Check all operation inputs, not a cherry-picked
    # list. No generation fingerprint is calculated or rewritten here.
    generated = {'toolpathMoves', 'generationFingerprint', 'computeTimeMs',
                 'estimatedCutTimeMs', 'estimatedCutTimeMsError', 'dependsOnPredecessors'}
    assert {k:v for k,v in old_rough.items() if k not in generated} == {
        k:v for k,v in new_rough.items() if k not in generated}
    for key in ['geometry', 'stocks', 'sceneStock', 'machine']:
        assert legacy[key] == current[key], key
    assert legacy['setups'][0]['wcs'] == current['setups'][0]['wcs']
    assert legacy['setups'][0]['stock'] == current['setups'][0]['stock']
    retained_tools = {op['toolId'] for op in ops[:index + 1]}
    assert [t for t in legacy['toolLibrary'] if t['id'] in retained_tools] == [
        t for t in current['toolLibrary'] if t['id'] in retained_tools]
    # Freeze the authentic pre-fix rough moves with exactly the same resolved
    # height authority and machining inputs. The current stamp attests INPUTS,
    # not the path output, so it is retained verbatim, never manufactured.
    new_rough['toolpathMoves'] = old_rough['toolpathMoves']
    output = f'{name}-legacy.camproject'
    raw = (json.dumps(current, separators=(',', ':')) + '\n').encode()
    (ROOT / output).write_bytes(raw)
    records.append({'file': f'src/tests/fixtures/WO-2934/{output}', 'rough': rough,
                    'sha256': hashlib.sha256(raw).hexdigest(),
                    'legacySource': LEGACY, 'legacyFile': file, 'legacySourceSha256': legacy_sha,
                    'inputSource': CURRENT, 'inputSourceSha256': current_sha,
                    'roughMovesSha256': digest(old_rough['toolpathMoves']),
                    'operations': [{'id': op['id'], 'name': op['name'],
                                    'fingerprint': op['generationFingerprint'],
                                    'moveCount': len(op['toolpathMoves'])}
                                   for op in current['setups'][0]['operations']]})
(ROOT / 'provenance.json').write_text(json.dumps(records, indent=2) + '\n')
