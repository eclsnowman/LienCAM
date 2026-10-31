"""WO-2653: small contact sheet of real wall-clock 1-fps app samples."""
import json
import math
import os
import sys
from PIL import Image, ImageDraw

scratch, output, data = sys.argv[1:]
# '@file' carries long frame lists (Windows caps a command line at 32767 chars; V04 10-09)
frames = json.loads(open(data[1:], encoding='utf-8').read() if data.startswith('@') else data)
width, height, columns = 240, 135, 8
sheet = Image.new('RGB', (columns * width, math.ceil(len(frames) / columns) * (height + 16)), '#10151a')
draw = ImageDraw.Draw(sheet)
for i, frame in enumerate(frames):
    x, y = i % columns * width, i // columns * (height + 16)
    with Image.open(os.path.join(scratch, frame['file'])) as image:
        sheet.paste(image.resize((width, height)), (x, y))
    draw.text((x + 3, y + height + 1), f"{frame['seconds']:.1f}s", fill='white')
sheet.save(output, quality=65, optimize=True)
