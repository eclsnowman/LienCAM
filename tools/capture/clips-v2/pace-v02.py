"""WO-2572: explicit half-second dissolves across repeated cuts, no time scaling."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from analyze import ROOT, run

OUT = ROOT / 'src/tests/evidence/WO-2572'
MEDIA = ROOT / 'docs/media/clips-v2'


def timeline(plan):
    if plan['version'] != 1 or plan['fps'] != 30 or plan['fadeSeconds'] != .5:
        raise ValueError('Expected V02 30 fps and half-second fades')
    segments = plan['segments']
    if len(segments) < 2 or segments[0][0] != 0 or segments[-1][1] != plan['sourceDurationSeconds']:
        raise ValueError('Keep the opening and completed ending')
    cursor, previous, entries, fades = 0, 0, [], []
    for index, (start, end) in enumerate(segments):
        if not (previous <= start < end <= plan['sourceDurationSeconds']) or end-start <= 1:
            raise ValueError('Invalid nonoverlapping source intervals')
        if any(abs(t*30-round(t*30)) > 1e-6 for t in [start, end]):
            raise ValueError('Intervals must use whole frames')
        if index:
            cursor -= .5
            fades.append([cursor, cursor+.5])
        entries.append(dict(sourceStart=start, sourceEnd=end, outputStart=cursor, outputEnd=cursor+end-start))
        cursor += end-start
        previous = end
    return dict(durationSeconds=cursor, decodedFrames=round(cursor*30), segments=entries, fadeWindows=fades)


def source_time(edit, time):
    # During a dissolve there is deliberately no single source time.
    if any(a <= time < b for a, b in edit['fadeWindows']):
        return None
    for s in edit['segments']:
        if s['outputStart'] <= time < s['outputEnd']:
            return s['sourceStart'] + time-s['outputStart']
    raise ValueError('Unmapped output frame')


def render():
    plan = json.loads((ROOT / 'tools/capture/clips-v2/v02-pacing.json').read_text())
    edit = timeline(plan)
    source = MEDIA / 'V02-source.mp4'
    receipt = json.loads((OUT / 'capture-source.json').read_text())
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if receipt['sha256'] != digest:
        raise ValueError('Source take does not match capture receipt')
    # Independent input seeks avoid buffering minutes of 1080p split frames.
    inputs, filters = [], []
    for i, s in enumerate(edit['segments']):
        inputs += ['-ss', s['sourceStart'], '-t', s['sourceEnd']-s['sourceStart'], '-i', source]
        filters.append('[%d:v]settb=AVTB,setpts=PTS-STARTPTS,fps=30[s%d]' % (i, i))
    previous = 's0'
    for i, (start, _) in enumerate(edit['fadeWindows'], 1):
        filters.append('[%s][s%d]xfade=transition=fade:duration=0.5:offset=%s,fps=30[x%d]' % (previous, i, start, i))
        previous = 'x%d' % i
    # xfade's inclusive overlap can leave EOF one tick short. Only the
    # already completed static hold may be padded; cap output at the edit length.
    filters.append('[%s]tpad=stop_mode=clone:stop_duration=0.1[delivery]' % previous)
    target = MEDIA / 'V02.mp4'
    target.unlink(missing_ok=True)
    encoded = run('-y', *inputs, '-filter_complex_threads', '2', '-filter_complex', ';'.join(filters), '-map', '[delivery]',
        '-frames:v', edit['decodedFrames'], '-r', '30', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '17',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target)
    (OUT / 'pacing-ffmpeg.txt').write_bytes(encoded.stderr)
    edit.update(sourceFile='docs/media/clips-v2/V02-source.mp4', sourceSha256=digest, plan=plan)
    receipt.update(sha256=hashlib.sha256(target.read_bytes()).hexdigest(), bytes=target.stat().st_size, edit=edit)
    (OUT / 'capture.json').write_text(json.dumps(receipt, indent=2)+'\n')
    (OUT / 'pacing.json').write_text(json.dumps(edit, indent=2)+'\n')
    strip = MEDIA / 'V02-strip-1fps.jpg'
    strip.unlink(missing_ok=True)
    run('-y', '-i', target, '-vf', 'fps=1,scale=480:270,tile=8x%d' % ((int(edit['durationSeconds'])+7)//8), '-frames:v', '1', strip)
    print(json.dumps(edit, indent=2))


if __name__ == '__main__':
    try:
        render()
    except subprocess.CalledProcessError as error:
        print(error.stderr.decode(errors='replace'), file=sys.stderr)
        raise
