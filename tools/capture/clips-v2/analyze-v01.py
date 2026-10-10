"""Independently decode the delivered V01; tests call --verify-only."""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from analyze import inspect, run, ROOT

OUT = ROOT / 'src/tests/evidence/WO-2571'
VIDEO = ROOT / 'docs/media/clips-v2/V01.mp4'


def measure():
    frames, info = inspect(VIDEO, 30)
    capture = json.loads((OUT / 'capture.json').read_text())
    telemetry = json.loads((OUT / 'telemetry.json').read_text())
    info.pop('orbitNearDuplicateFractions')
    info['durationSeconds'] = len(frames) / 30
    info['sha256'] = hashlib.sha256(VIDEO.read_bytes()).hexdigest()
    if info['sha256'] != capture['sha256']:
        raise RuntimeError('Capture receipt does not identify the delivered file')
    stamps = np.array([f['timestamp'] for f in capture['frames']])
    gaps = np.diff(stamps)
    info['captureFrames'] = len(stamps)
    info['captureSpanSeconds'] = float(stamps[-1] - stamps[0])
    info['captureGapMs'] = {k: float(v * 1000) for k, v in [('median', np.median(gaps)), ('p95', np.percentile(gaps, 95)), ('max', np.max(gaps))]}
    info['captureGapsOver100ms'] = [{'start': float(stamps[i]-stamps[0]), 'duration': float(g)} for i, g in enumerate(gaps) if g >= .1]
    active = [x for x in telemetry if x['playing']]
    windows = [[active[0]['wallTime'] - stamps[0], active[-1]['wallTime'] - stamps[0]]]
    # WO-2552 measures playback and camera motion. The native opacity range
    # intentionally renders in 0.05 steps; its readbacks are checked separately.
    windows += [[a['motion']['beganWallTime'] - stamps[0], a['motion']['endedWallTime'] - stamps[0]] for a in capture['actions'] if a['action'] in ['orbit', 'zoom']]
    info['motionWindows'] = windows
    info['activeNearDuplicateRunsAtLeast100ms'] = [r for r in info['nearDuplicateRunsAtLeast100ms'] if any(min(r['start'] + r['duration'], b) - max(r['start'], a) >= .1 - 1e-6 for a, b in windows)]
    tgaps = np.diff([x['t'] for x in telemetry])
    info['appRafGapMs'] = {k: float(v * 1000) for k, v in [('median', np.median(tgaps)), ('p95', np.percentile(tgaps,95)), ('max', np.max(tgaps))]}
    info['simulationStartEndMs'] = [telemetry[0]['sim'], telemetry[-1]['sim']]
    duration = capture['prep']['durationMs']
    tail = [x for x in telemetry if x['t'] >= info['durationSeconds'] - 5]
    info['finishedTailSamples'] = len(tail)
    info['finishedTailExact'] = bool(tail) and all(abs(x['sim']-duration) <= 1 and abs(x['stockMs']-duration) <= 1 and x['stockSync'] == 'exact' and not x['playing'] for x in tail)
    # Tie the terminal app readback/screenshot to the actual decoded last frame.
    with Image.open(OUT / 'finished.png') as image:
        last = np.asarray(image.convert('L').resize((480,270)), dtype=np.int16)
    info['lastFrameVsFinishedScreenshotMad'] = float(np.mean(np.abs(last - frames[-1].astype(np.int16))))
    return frames, info


if __name__ == '__main__':
    if '--verify-only' not in sys.argv:
        for name in ['busiest-5s-sheet.jpg', 'last-5s-sheet.jpg', 'last-5s.mp4',
                     'play-click.jpg', 'cutting.jpg', 'finished-decoded.jpg', 'motion.json']:
            (OUT / name).unlink(missing_ok=True)
    frames, info = measure()
    if '--verify-only' not in sys.argv:
        dump = OUT / 'busiest-5s'
        dump.mkdir(exist_ok=True)
        for f in dump.glob('frame-*.jpg'):
            f.unlink()
        run('-y', '-ss', info['busiest5sStart'], '-i', VIDEO, '-t', '5', '-q:v', '2', dump / 'frame-%03d.jpg')
        info['fullRateDumpFrames'] = len(list(dump.glob('frame-*.jpg')))
        sheet = Image.new('RGB', (3200,2700), '#111')
        for i, f in enumerate(sorted(dump.glob('frame-*.jpg'))):
            with Image.open(f) as image:
                sheet.paste(image.resize((320,180)), (i % 10 * 320, i // 10 * 180))
        sheet.save(OUT / 'busiest-5s-sheet.jpg', quality=95)
        tail_dump = OUT / 'last-5s'
        tail_dump.mkdir(exist_ok=True)
        for f in tail_dump.glob('frame-*.jpg'):
            f.unlink()
        run('-y', '-ss', info['durationSeconds'] - 5, '-i', VIDEO, '-t', '5', '-q:v', '2', tail_dump / 'frame-%03d.jpg')
        info['last5sDumpFrames'] = len(list(tail_dump.glob('frame-*.jpg')))
        for i, f in enumerate(sorted(tail_dump.glob('frame-*.jpg'))):
            with Image.open(f) as image:
                sheet.paste(image.resize((320,180)), (i % 10 * 320, i // 10 * 180))
        sheet.save(OUT / 'last-5s-sheet.jpg', quality=95)
        run('-y', '-ss', info['durationSeconds'] - 5, '-i', VIDEO, '-t', '5', '-c:v', 'libx264', '-threads', '2', '-crf', '17', '-pix_fmt', 'yuv420p', OUT / 'last-5s.mp4')
        for name, second in [('play-click', 7.15), ('cutting', 25), ('finished-decoded', info['durationSeconds'] - 1/30)]:
            f = OUT / (name + '.jpg')
            f.unlink(missing_ok=True)
            run('-y', '-ss', second, '-i', VIDEO, '-frames:v', '1', '-q:v', '2', f)
        (OUT / 'motion.json').write_text(json.dumps(info, indent=2) + '\n')
        if '--keep-raw' not in sys.argv and (OUT / 'raw').exists():
            raw = OUT / 'raw'
            for f in raw.glob('frame-*.jpg'):
                f.unlink()
            (raw / 'frames.txt').unlink(missing_ok=True)
            raw.rmdir()
    print(json.dumps(info, indent=2))
