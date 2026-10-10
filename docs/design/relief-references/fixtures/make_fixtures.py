"""Builds the relief test fixtures and the reference renders used by
docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md.

Design reference only - not product code, never shipped in the app.

Inputs (downloaded once, see LICENCES.txt):
  src/lincoln.jpg   Wikimedia Commons, Abraham Lincoln O-77 (Gardner 1863), public domain
  src/terrain.png   Wikimedia Commons, "Hand made terrain heightmap" (Drummyfish), CC0
Generated here (CC0, made for LienCAM):
  fixture-03-text-sign.png, fixture-04-hammered-texture-16bit.png, fixture-05-dome-rings-16bit.png

Run:  python make_fixtures.py   (numpy, scipy, Pillow >= 10.1)
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_NUM = os.path.join(HERE, "..", "numbers")
os.makedirs(OUT_NUM, exist_ok=True)
rng = np.random.default_rng(20260928)


def save16(path, a):
    """Save a 0..1 float array as a 16-bit greyscale PNG."""
    a = np.clip(a, 0, 1)
    Image.fromarray((a * 65535 + 0.5).astype(np.uint16)).save(path)


def load01(path):
    im = Image.open(path)
    if im.mode in ("I;16", "I;16B", "I"):
        a = np.asarray(im, dtype=np.float64) / 65535.0
    else:
        a = np.asarray(im.convert("L"), dtype=np.float64) / 255.0
    return a


# ---------------------------------------------------------------- fixtures
def fixture_lincoln():
    im = Image.open(os.path.join(HERE, "src", "lincoln.jpg")).convert("L")
    im = im.resize((1000, int(round(1000 * im.height / im.width))), Image.LANCZOS)
    im.save(os.path.join(HERE, "fixture-01-portrait-photo-lincoln.jpg"), quality=90)


def fixture_terrain():
    im = Image.open(os.path.join(HERE, "src", "terrain.png"))
    im = im.getchannel(0) if im.mode in ("LA", "RGBA", "RGB") else im.convert("L")
    im = im.resize((1200, 1200), Image.LANCZOS)
    im.save(os.path.join(HERE, "fixture-02-terrain-heightmap.png"))


def fixture_text():
    # Black lettering on white paper: the most common real input (a scanned or
    # exported logo). Light = high would sink the letters, so this fixture
    # proves the Auto rule "light border -> invert".
    W, H = 1600, 800
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    f1 = ImageFont.load_default(size=300)   # Aileron Regular, CC0 (bundled in Pillow)
    f2 = ImageFont.load_default(size=90)
    d.rounded_rectangle((40, 40, W - 40, H - 40), radius=60, outline=0, width=24)
    d.text((W / 2, 330), "LienCAM", font=f1, fill=0, anchor="mm", stroke_width=9, stroke_fill=0)
    d.text((W / 2, 610), "EST. 2026  -  FINE TEXT", font=f2, fill=0, anchor="mm", stroke_width=2, stroke_fill=0)
    im.save(os.path.join(HERE, "fixture-03-text-sign.png"))


def fixture_hammered():
    # Tileable hammered texture: overlapping spherical dimples on a Poisson-ish
    # scatter, 16-bit. Height = 1 - dimple depth (light = high).
    N = 512
    h = np.ones((N, N))
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    pts = rng.uniform(0, N, size=(240, 2))
    rads = rng.uniform(14, 30, size=240)
    for (px, py), r in zip(pts, rads):
        dx = (xx - px + N / 2) % N - N / 2    # wrap -> tileable
        dy = (yy - py + N / 2) % N - N / 2
        d2 = dx * dx + dy * dy
        m = d2 < r * r
        dep = (np.sqrt(np.maximum(r * r - d2, 0)) / r) * 0.55   # spherical cap
        h = np.where(m, np.minimum(h, 1 - dep), h)
    h = ndi.gaussian_filter(h, 1.5, mode="wrap")
    h = (h - h.min()) / (h.max() - h.min())
    save16(os.path.join(HERE, "fixture-04-hammered-texture-16bit.png"), h)


def fixture_dome():
    # Known-math soft gradients: a cosine dome with shallow rings and a slow
    # linear ramp. Saved 16-bit (true) and 8-bit (terraces) so a test can show
    # the pipeline keeps 16-bit input and that 8-bit terracing is removed.
    N = 768
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    r = np.hypot(xx - N / 2, yy - N / 2) / (N / 2)
    dome = np.where(r < 1, 0.5 * (1 + np.cos(np.pi * r)), 0.0)
    rings = 0.06 * np.cos(2 * np.pi * r * 6) * dome
    ramp = 0.12 * (xx / N)
    h = np.clip(0.8 * dome + rings + ramp, 0, None)
    h = h / h.max()
    save16(os.path.join(HERE, "fixture-05-dome-rings-16bit.png"), h)
    Image.fromarray((h * 255 + 0.5).astype(np.uint8)).save(
        os.path.join(HERE, "fixture-05b-dome-rings-8bit.png"))


# ---------------------------------------------------------------- pipeline
def classify(a, is16):
    """What kind of picture is this? Drives the Auto button.
    artwork  - two tones (logo, text, silhouette): >= 85 % of pixels near black or white
    heightmap - a true height map: 16-bit, or smooth (median |pixel - 3x3 median| < 0.6 grey level)
    photo    - everything else (continuous tone with grain/noise)"""
    lo, hi = np.percentile(a, [0.5, 99.5])
    b = np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
    if np.mean((b < 0.15) | (b > 0.85)) >= 0.85:
        return "artwork"
    noise = np.median(np.abs(a - ndi.median_filter(a, 3))) * 255
    if is16 or noise < 0.6:
        return "heightmap"
    return "photo"


def auto_adjust(a, pitch_mm, is16=False, sigma_px=None):
    """The recommended Auto button, in order. Returns (heights 0..1, kind, inverted)."""
    kind = classify(a, is16)
    inverted = False
    if kind == "artwork":
        border = np.concatenate([a[:4].ravel(), a[-4:].ravel(), a[:, :4].ravel(), a[:, -4:].ravel()])
        if np.median(border) > 0.5:          # dark art on light paper -> the art rises
            a, inverted = 1 - a, True
        clip, sig_mm, med = 0.0, 0.15, False
    elif kind == "heightmap":
        clip, sig_mm, med = 0.0, (0.5 if is16 else 2.0) * pitch_mm, False
    else:
        clip, sig_mm, med = 0.005, 0.20, True
    if med:
        a = ndi.median_filter(a, 3)           # speckle / film grain
    lo, hi = np.percentile(a, [clip * 100, 100 - clip * 100])
    a = np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
    s = sig_mm / pitch_mm if sigma_px is None else sigma_px
    if s > 0:
        a = ndi.gaussian_filter(a, s)         # float, never re-quantised
    return a, kind, inverted


def shade(hmm, pitch_mm, el_deg=35, exag=1.0):
    """Lambert shading of a height field (mm), light from the upper left
    (the convention every relief preview uses)."""
    gy, gx = np.gradient(hmm * exag, pitch_mm)   # gy: +down the image
    nz = 1 / np.sqrt(gx * gx + gy * gy + 1)
    nx, ny = -gx * nz, -gy * nz
    el = np.radians(el_deg)
    c = np.cos(el) * np.sqrt(0.5)
    lam = np.clip(nx * -c + ny * -c + nz * np.sin(el), 0, 1)
    return np.clip(0.12 + 0.88 * lam, 0, 1)


def to_img(s, tint=(0.93, 0.80, 0.62)):
    rgb = np.stack([s * tint[0], s * tint[1], s * tint[2]], -1)
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))


def label(im, text):
    d = ImageDraw.Draw(im)
    f = ImageFont.load_default(size=max(14, im.width // 28))
    d.rectangle((0, 0, im.width, f.size + 10), fill=(20, 20, 20))
    d.text((6, 4), text, font=f, fill=(255, 255, 255))
    return im


def row(images, path, q=85):
    w = sum(i.width for i in images) + 8 * (len(images) - 1)
    h = max(i.height for i in images)
    out = Image.new("RGB", (w, h), (255, 255, 255))
    x = 0
    for i in images:
        out.paste(i, (x, 0))
        x += i.width + 8
    if out.width > 1600:
        out = out.resize((1600, int(out.height * 1600 / out.width)), Image.LANCZOS)
    out.save(path, quality=q)


def ball_opening(hmm, pitch_mm, R_mm):
    """What a ball nose of radius R can actually cut (ideal zero-stepover
    finish): grey opening of the surface by the ball."""
    k = int(np.ceil(R_mm / pitch_mm))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1] * pitch_mm
    d2 = xx * xx + yy * yy
    ball = np.where(d2 <= R_mm * R_mm, np.sqrt(np.maximum(R_mm * R_mm - d2, 0)) - R_mm, -1e9)
    return ndi.grey_opening(hmm, structure=ball)


# ---------------------------------------------------------------- figures
def figures():
    # A) 8-bit terraces vs 16-bit vs 8-bit + smooth, dome at 100 mm, 3 mm deep
    d16 = load01(os.path.join(HERE, "fixture-05-dome-rings-16bit.png"))
    d8 = load01(os.path.join(HERE, "fixture-05b-dome-rings-8bit.png"))
    size, depth = 100.0, 3.0
    p = size / d16.shape[1]
    tiles = []
    for a, t in [(d8, "8-bit, no smooth"), (d8, "8-bit, smooth 1 px"),
                 (d8, "8-bit, smooth 2 px"), (d16, "16-bit, no smooth")]:
        if "1 px" in t:
            a = ndi.gaussian_filter(a, 1.0)
        if "2 px" in t:
            a = ndi.gaussian_filter(a, 2.0)
        s = shade(a[192:576, 192:576] * depth, p, el_deg=25)
        tiles.append(label(to_img(s), t))
    row(tiles, os.path.join(OUT_NUM, "num-01-8bit-terraces-vs-smooth-vs-16bit.jpg"))

    # B) portrait at 100 mm wide, 2.5 mm deep: smoothing sigma 0 / 0.5 / 1 / 2 px
    L = load01(os.path.join(HERE, "fixture-01-portrait-photo-lincoln.jpg"))
    size = 100.0
    p = size / L.shape[1]            # 0.1 mm per px -> 10 px/mm
    crop = (slice(180, 560), slice(300, 680))
    tiles = []
    for sg in (0.0, 0.5, 1.0, 2.0):
        a, _, _ = auto_adjust(L, p, sigma_px=sg)
        s = shade(a[crop] * 2.5, p, el_deg=30)
        tiles.append(label(to_img(s).resize((500, 500), Image.NEAREST), f"smooth {sg} px ({sg*p:.2f} mm)"))
    row(tiles, os.path.join(OUT_NUM, "num-02-portrait-smoothing-0-05-1-2px.jpg"))

    # C) what a ball can cut: portrait 100 mm wide, 2.5 mm deep, R = 0.4/0.8/1.6/3.2 mm
    a, _, _ = auto_adjust(L, p)
    hmm = a * 2.5
    tiles = [label(to_img(shade(hmm[crop], p)).resize((500, 500), Image.LANCZOS), "model (10 px/mm)")]
    for R in (0.4, 0.8, 1.6, 3.2):
        cut = ball_opening(hmm, p, R)
        tiles.append(label(to_img(shade(cut[crop], p)).resize((500, 500), Image.LANCZOS), f"ball D {2*R:.1f} mm"))
    row(tiles, os.path.join(OUT_NUM, "num-03-ball-size-vs-detail-portrait.jpg"))

    # D) default look of every fixture (Auto + default depth rule), studio light
    specs = [
        ("fixture-01-portrait-photo-lincoln.jpg", 70.0),
        ("fixture-02-terrain-heightmap.png", 100.0),
        ("fixture-03-text-sign.png", 100.0),
        ("fixture-04-hammered-texture-16bit.png", 60.0),
        ("fixture-05-dome-rings-16bit.png", 60.0),
    ]
    for fn, width_mm in specs:
        raw = load01(os.path.join(HERE, fn))
        h_px, w_px = raw.shape
        height_mm = width_mm * h_px / w_px
        depth = default_depth(width_mm, height_mm)
        pitch = width_mm / w_px
        a, kind, inv = auto_adjust(raw, pitch, is16="16bit" in fn)
        s = shade(a * depth, pitch, el_deg=35)
        print(fn, kind, inv, depth)
        im = to_img(s)
        im.thumbnail((900, 900), Image.LANCZOS)
        label(im, f"Auto: {kind}{', inverted' if inv else ''} | {width_mm:.0f} x {height_mm:.0f} mm, {depth} mm deep")
        im.save(os.path.join(OUT_NUM, "default-" + fn.split(".")[0] + ".jpg"), quality=85)


def default_depth(w_mm, h_mm):
    """Recommended default depth: 4 % of the shorter side, 0.5..10 mm,
    rounded to 0.25 mm (below 1 mm: to 0.05 mm)."""
    d = 0.04 * min(w_mm, h_mm)
    d = min(max(d, 0.5), 10.0)
    return round(d * 4) / 4 if d >= 1 else round(d * 20) / 20


if __name__ == "__main__":
    fixture_lincoln()
    fixture_terrain()
    fixture_text()
    fixture_hammered()
    fixture_dome()
    figures()
    print("done")
