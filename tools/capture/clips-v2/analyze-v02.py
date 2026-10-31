"""Independently decode the delivered V02; tests call --verify-only."""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from analyze import inspect, run, ROOT
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location("pace_v02", Path(__file__).with_name("pace-v02.py"))
pacing = module_from_spec(spec)
spec.loader.exec_module(pacing)

OUT = ROOT / 'src/tests/evidence/WO-2572'
VIDEO = ROOT / 'docs/media/clips-v2/V02.mp4'


def visible_holes(image):
    # Delivered-frame check, not a fabricated CAM payload. In Compare, the
    # supplied target top is pale blue and its fourteen apertures are darker.
    # Restrict to the model region; component size excludes stock sides, UI,
    # the tool shaft and thin outer edges. Partial cutter overlap is allowed.
    r, g, b = image[:, :, 0], image[:, :, 1], image[:, :, 2]
    mask = (r >= 60) & (r <= 125) & (g >= 120) & (g <= 180) & (b >= 170) & (b <= 215)
    mask[:180] = False
    mask[820:] = False
    mask[:, :500] = False
    mask[:, 1450:] = False
    seen, holes = set(), []
    for y, x in zip(*np.where(mask)):
        if (y, x) in seen:
            continue
        stack, points = [(int(y), int(x))], []
        seen.add((y, x))
        while stack:
            yy, xx = stack.pop()
            points.append((yy, xx))
            for q in [(yy-1, xx), (yy+1, xx), (yy, xx-1), (yy, xx+1)]:
                if 0 <= q[0] < 1080 and 0 <= q[1] < 1920 and mask[q] and q not in seen:
                    seen.add(q)
                    stack.append(q)
        ys, xs = zip(*points)
        width, height = max(xs)-min(xs)+1, max(ys)-min(ys)+1
        # The reframed native WCS arrow tip is a 128-pixel blue component,
        # not an aperture. Actual decoded apertures are 343-504 pixels.
        # Keep the fourteen-hole assertion and covered-hole control unchanged.
        if 200 <= len(points) <= 1500 and 10 <= width <= 45 and 8 <= height <= 40:
            holes.append({'pixels': len(points), 'bounds': [min(xs), min(ys), width, height]})
    return holes



def visible_motion(frames, capture, telemetry):
    """Every sliding three-frame (100 ms) cutting window, in delivered pixels.

    Legacy take projection reconstructs the orthographic camera from its own
    pose/zoom and recorded orbit endpoints. New takes retain direct projection.
    Stock comparison excludes the cutter neighbourhood and all application UI.
    """
    origin = capture['frames'][0]['timestamp']
    orbit = next(a for a in capture['actions'] if a['action'] == 'orbit')
    # Recorded pointer endpoints are native viewport fractions in v02.json.
    width = (orbit['to']['x'] - orbit['from']['x']) / (.65 - .59)
    height = (orbit['to']['y'] - orbit['from']['y']) / (.50 - .48)
    left = orbit['from']['x'] - width * .59
    top = orbit['from']['y'] - height * .48
    target = np.array(list(capture['prep']['initialCamera']['target'].values()))
    frustum = capture['prep']['initialCamera']['frustumSize']
    times = np.array([s['wallTime'] - origin for s in telemetry])
    samples = []
    for i in range(len(frames)):
        # Last completed rAF before the screenshot; no future readback.
        source_t = pacing.source_time(capture['edit'], i/30) if 'edit' in capture else i/30
        if source_t is None:
            samples.append(None)
            continue
        j = max(0, min(len(times)-1, int(np.searchsorted(times, source_t+1/30, side='right')-1)))
        s = telemetry[j]
        if 'toolScreen' in s:
            xy = np.array(s['toolScreen'])
        else:
            backward = np.array(s['camera']) - target
            backward = backward / np.linalg.norm(backward)
            right = np.cross([0,0,1], backward); right /= np.linalg.norm(right)
            up = np.cross(backward, right)
            rel = np.array(s['toolPosition']) - target
            scale = height * s['zoom'] / frustum
            xy = np.array([left+width/2+np.dot(rel,right)*scale,
                           top+height/2-np.dot(rel,up)*scale])
        samples.append((s, xy))
    failures, checked = [], 0
    for i in range(len(frames)-3):
        # Only explicit dissolve windows are exempt, including windows that straddle them.
        if any(s is None for s in samples[i:i+4]): continue
        a, pa = samples[i]; b, pb = samples[i+3]
        if not a['playing'] or b['sim'] <= a['sim']: continue
        checked += 1
        movement = float(np.linalg.norm(pb-pa))
        if movement >= 2: continue
        delta = np.abs(frames[i+3].astype(np.int16)-frames[i].astype(np.int16))
        mask = np.zeros(delta.shape, dtype=bool)
        mask[45:225,135:400] = True
        for pt in [pa,pb]:
            x,y = np.round(pt/4).astype(int)
            mask[max(0,y-15):min(270,y+15),max(0,x-15):min(480,x+15)] = False
        stock_changed = bool(np.any(delta[mask] > 8))
        if not stock_changed:
            failures.append(dict(start=i/30, duration=.1, simStart=a['sim'], simEnd=b['sim'], cutterPixels=movement))
    return dict(windowSeconds=.1, cutterThresholdPixels=2, stockThresholdGray=8,
                checkedWindows=checked, failures=failures,
                fadeWindows=capture.get('edit', {}).get('fadeWindows', []),
                projection='direct camera projection' if 'toolScreen' in telemetry[0] else 'reconstructed orthographic camera from take readbacks')


def measure():
    frames, info = inspect(VIDEO, 30)
    capture = json.loads((OUT / 'capture.json').read_text())
    telemetry = json.loads((OUT / 'telemetry.json').read_text())
    if 'edit' in capture:
        edit = capture['edit']
        expected = pacing.timeline(edit['plan'])
        for key in ['durationSeconds', 'decodedFrames', 'segments', 'fadeWindows']:
            if edit[key] != expected[key]: raise RuntimeError('Invalid pacing map: ' + key)
        source = ROOT / edit['sourceFile']
        if hashlib.sha256(source.read_bytes()).hexdigest() != edit['sourceSha256']:
            raise RuntimeError('Pacing source hash mismatch')
        if len(frames) != edit['decodedFrames']: raise RuntimeError('Pacing frame count mismatch')
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
    # WO-2572 measures playback and camera motion. The native opacity range
    # intentionally renders in 0.05 steps; its readbacks are checked separately.
    windows += [[a['motion']['beganWallTime'] - stamps[0], a['motion']['endedWallTime'] - stamps[0]] for a in capture['actions'] if a['action'] in ['orbit', 'zoom']]
    if 'edit' in capture:
        info['sourceMotionWindows'] = windows
        mapped = [pacing.source_time(capture['edit'], i/30) for i in range(len(frames))]
        enabled = [t is not None and any(a <= t < b for a, b in windows) for t in mapped]
        windows, begin = [], None
        for i, active_frame in enumerate(enabled + [False]):
            if active_frame and begin is None: begin = i
            if not active_frame and begin is not None:
                windows.append([begin/30, i/30]); begin = None
    info['motionWindows'] = windows
    info['activeNearDuplicateRunsAtLeast100ms'] = [r for r in info['nearDuplicateRunsAtLeast100ms'] if any(min(r['start'] + r['duration'], b) - max(r['start'], a) >= .1 - 1e-6 for a, b in windows)]
    info['visibleMotion'] = visible_motion(frames, capture, telemetry)
    if 'edit' in capture:
        differences = []
        for segment in edit['segments']:
            decoded = run('-ss', segment['sourceStart'], '-i', source, '-t', segment['sourceEnd']-segment['sourceStart'],
                          '-vf', 'scale=480:270,format=gray', '-f', 'rawvideo', '-')
            originals = np.frombuffer(decoded.stdout, dtype=np.uint8).reshape(-1, 270, 480)
            for i in range(round(segment['outputStart']*30), round(segment['outputEnd']*30)):
                st = pacing.source_time(edit, i/30)
                if st is None: continue
                local = round((st-segment['sourceStart'])*30)
                differences.append(float(np.abs(originals[local].astype(np.int16)-frames[i].astype(np.int16)).mean()))
        info['unfadedSourceCorrespondence'] = dict(checkedFrames=len(differences), maximumMad=max(differences),
                                                  meanMad=float(np.mean(differences)))
    tgaps = np.diff([x['t'] for x in telemetry])
    info['appRafGapMs'] = {k: float(v * 1000) for k, v in [('median', np.median(tgaps)), ('p95', np.percentile(tgaps,95)), ('max', np.max(tgaps))]}
    info['simulationStartEndMs'] = [telemetry[0]['sim'], telemetry[-1]['sim']]
    duration = capture['prep']['durationMs']
    source_duration = capture.get('edit', {}).get('plan', {}).get('sourceDurationSeconds', info['durationSeconds'])
    tail = [x for x in telemetry if x['t'] >= source_duration - 5]
    if 'edit' in capture:
        info['edit'] = capture['edit']
        info['sourceCaptureFrames'] = len(capture['frames'])
    info['finishedTailSamples'] = len(tail)
    info['finishedTailExact'] = bool(tail) and all(abs(x['sim']-duration) <= 1 and abs(x['stockMs']-duration) <= 1 and x['stockSync'] == 'exact' and not x['playing'] for x in tail)
    # Tie the terminal app readback/screenshot to the actual decoded last frame.
    with Image.open(OUT / 'finished.png') as image:
        last = np.asarray(image.convert('L').resize((480,270)), dtype=np.int16)
    info['lastFrameVsFinishedScreenshotMad'] = float(np.mean(np.abs(last - frames[-1].astype(np.int16))))
    full_tail = run('-ss', info['durationSeconds'] - 5, '-i', VIDEO, '-t', '5',
                    '-vf', 'fps=1,format=rgb24', '-f', 'rawvideo', '-')
    last_seconds = np.frombuffer(full_tail.stdout, dtype=np.uint8).reshape(-1, 1080, 1920, 3)
    holes = [visible_holes(image) for image in last_seconds]
    info['lastSecondsVisibleHoleCounts'] = [len(h) for h in holes]
    info['lastSecondsHoleBounds'] = holes
    # Negative image control: cover one aperture in a decoded-frame COPY.
    # The delivered artifact is never modified.
    control = last_seconds[-1].copy()
    if holes[-1]:
        x, y, w, h = holes[-1][0]['bounds']
        control[y:y+h, x:x+w] = [171, 207, 229]
    info['coveredHoleControlCount'] = len(visible_holes(control))
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
