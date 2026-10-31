"""Decode captured motion, not just container fps. No image interpolation."""
import json
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'src/tests/evidence/WO-2551'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def run(*args):
    return subprocess.run([FFMPEG, '-hide_banner', '-threads', '2', '-filter_threads', '2', *map(str, args)], check=True, capture_output=True)


def inspect(file, fps):
    # Full UI and a fixed central workspace ROI. Pointer motion alone must not
    # pass for moving geometry. Same decoded-stream check applies to old clips.
    result = run('-i', file, '-vf', 'scale=480:270,format=gray', '-f', 'rawvideo', '-')
    stream = result.stderr.decode(errors='replace')
    header = next(line for line in stream.splitlines() if 'Video:' in line)
    rate = re.search(r'([\d.]+) fps', header)
    if not rate or float(rate.group(1)) != fps or '1920x1080' not in header:
        raise RuntimeError(f'Unexpected decoded input stream: {header}')
    frames = np.frombuffer(result.stdout, dtype=np.uint8).reshape(-1, 270, 480)
    roi = frames[:, 45:225, 135:400]
    delta = np.mean(np.abs(roi[1:].astype(np.int16) - roi[:-1].astype(np.int16)), axis=(1, 2))
    # Small JPEG variation is not meaningful animation.
    moving = delta > 0.35
    duplicate = delta < 0.01
    runs = []
    begin = None
    for i, same in enumerate([*duplicate, False]):
        if same and begin is None:
            begin = i
        if not same and begin is not None:
            if (i - begin) / fps >= .1:
                runs.append({'start': begin / fps, 'duration': (i - begin) / fps})
            begin = None
    windows = []
    for start in range(max(1, len(delta) - 5 * fps)):
        windows.append(float(np.mean(moving[start:start + 5 * fps])))
    busy = int(np.argmax(windows))
    return frames, {
        'file': str(file.relative_to(ROOT)), 'decodedFrames': len(frames),
        'verifiedStreamFps': fps, 'verifiedResolution': [1920, 1080], 'roi': [135, 45, 400, 225], 'madThreshold': 0.35,
        'motionChangedFraction': float(np.mean(moving)),
        'busiest5sStart': busy / fps, 'busiest5sChangedFraction': windows[busy],
        'busiest5sMeanDelta': float(np.mean(delta[busy:busy + 5 * fps])),
        'perSecondChangedFractions': [float(np.mean(moving[i:i + fps])) for i in range(0, len(moving), fps)],
        'nearDuplicateMadThreshold': .01, 'nearDuplicateRunsAtLeast100ms': runs,
        'orbitNearDuplicateFractions': [float(np.mean(duplicate[round(a * fps):round(b * fps)])) for a, b in [(7.5, 11), (17.5, 21)]],
    }


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    if '--old' in sys.argv:
        results = []
        strip = Image.new('RGB', (480 * 5, 270 * 9 + 24 * 9), '#151a21')
        draw = ImageDraw.Draw(strip)
        for n in range(1, 10):
            frames, info = inspect(ROOT / f'docs/media/V{n:02d}.mp4', 25)
            results.append(info)
            y = (n - 1) * 294
            draw.text((5, y + 4), f'V{n:02d} - evenly spaced samples', fill='white')
            for j in range(5):
                strip.paste(Image.fromarray(frames[min(len(frames) - 1, int((j + .5) * len(frames) / 5))]).convert('RGB'), (480 * j, y + 24))
        strip.save(OUT / 'old-clips-strip.jpg', quality=90)
        (OUT / 'old-motion.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps([{k: r[k] for k in ['file', 'decodedFrames', 'motionChangedFraction', 'busiest5sChangedFraction']} for r in results], indent=2))
    else:
        file = ROOT / 'docs/media/clips-v2/proof.mp4'
        frames, info = inspect(file, 30)
        capture = json.loads((OUT / 'capture.json').read_text())
        stamps = np.array([x['timestamp'] for x in capture['frames']])
        gaps = np.diff(stamps)
        info['captureFrames'] = len(stamps)
        info['captureSpanSeconds'] = float(stamps[-1] - stamps[0])
        info['captureGapMs'] = {'median': float(np.median(gaps) * 1000), 'p95': float(np.percentile(gaps, 95) * 1000), 'max': float(np.max(gaps) * 1000)}
        info['captureGapsOver100ms'] = [{'start': float(stamps[i] - stamps[0]), 'duration': float(gap)} for i, gap in enumerate(gaps) if gap > .1]
        telemetry = json.loads((OUT / 'telemetry.json').read_text())
        tgaps = np.diff([x['t'] for x in telemetry])
        info['appRafGapMs'] = {'median': float(np.median(tgaps) * 1000), 'p95': float(np.percentile(tgaps, 95) * 1000), 'max': float(np.max(tgaps) * 1000)}
        info['simulationStartEndMs'] = [telemetry[0]['sim'], telemetry[-1]['sim']]
        dump = OUT / 'busiest-5s'
        dump.mkdir(exist_ok=True)
        for old in dump.glob('frame-*.jpg'):
            old.unlink()
        # Full resolution, EVERY frame at deliverable rate, not a selected subset.
        run('-y', '-ss', info['busiest5sStart'], '-i', file, '-t', '5', '-q:v', '2', dump / 'frame-%03d.jpg')
        info['fullRateDumpFrames'] = len(list(dump.glob('frame-*.jpg')))
        for name, second in [('play-click', 2.85), ('orbit', 9), ('pause-click', 24.85)]:
            preview = OUT / f'{name}.jpg'
            if preview.exists():
                preview.unlink()
            run('-y', '-ss', second, '-i', file, '-frames:v', '1', '-q:v', '2', preview)
        sheet = Image.new('RGB', (320 * 10, 180 * 15), '#111')
        for i, frame in enumerate(sorted(dump.glob('frame-*.jpg'))):
            with Image.open(frame) as im:
                sheet.paste(im.resize((320, 180)).convert('RGB'), (i % 10 * 320, i // 10 * 180))
        sheet.save(OUT / 'busiest-5s-sheet.jpg', quality=95)
        (OUT / 'motion.json').write_text(json.dumps(info, indent=2) + '\n')
        print(json.dumps(info, indent=2))
        if '--keep-raw' not in sys.argv:
            raw = OUT / 'raw'
            if raw.exists():
                for file in raw.iterdir():
                    if re.fullmatch(r'frame-\d+\.jpg|frames\.txt', file.name):
                        file.unlink()
                raw.rmdir()  # refuses unknown files, never recursively deletes
