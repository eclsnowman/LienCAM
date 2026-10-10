import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/theme/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const appCss = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
function opacity(selector: string, p: (key: string) => string) {
  const body = [...appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors, body]) => selectors.split(',').some(s => s.trim() === selector) && /opacity:/.test(body)).at(-1)?.[2]
  expect(body, selector).toBeDefined()
  const value = /opacity:\s*([^;]+);/.exec(body!)?.[1]
  expect(value, selector).toBeDefined()
  const ref = /var\((--[\w-]+),\s*([\d.]+)\)/.exec(value!)
  return Number(ref ? p(ref[1]) || ref[2] : value)
}
function composite(fg: string, bg: string, alpha: number) {
  const bytes = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16))
  const back = bytes(bg)
  return '#' + bytes(fg).map((v, i) => Math.round(v * alpha + back[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
}

for (const theme of ['default', 'amber']) {
  for (const [selector, role] of [
    ['.modal-btn-primary:disabled', '--role-primary-fill'],
    ['.sp-btn-confirm:disabled', '--role-primary-fill'],
    ['.props-primary-btn:disabled', '--role-primary-fill'],
    ['.sketch-tool-btn:disabled', '--text-secondary'],
    ['.probe-routine-run-row .modal-btn:disabled', '--role-primary-fill'],
  ]) {
    it(`${theme} light ${selector} visibly differs from enabled`, () => {
      const p = palette(theme, 'light')
      const alpha = opacity(selector, p)
      expect(alpha).toBeGreaterThanOrEqual(0.45)
      expect(alpha).toBeLessThanOrEqual(0.55)
      // 2:1 is a regression floor for the state cue, not a WCAG text floor.
      for (const surface of ['--surface-1', '--surface-2']) {
        expect(contrast(p(role), composite(p(role), p(surface), alpha))).toBeGreaterThanOrEqual(2)
      }
    })
  }
  it(`${theme} light operation handle stays readable before row hover`, () => {
    const p = palette(theme, 'light')
    const rest = opacity('.tree-op-drag-handle', p)
    const hover = opacity('.tree-op:hover .tree-op-drag-handle', p)
    expect(hover).toBe(1)
    expect(rest).toBe(1)
    expect(contrast(composite(p('--text-muted'), p('--surface-1'), rest), p('--surface-1'))).toBeGreaterThanOrEqual(4.5)
    // .tree-op-active paints this translucent identity tint over its panel.
    const activeRow = composite(p('--role-identity'), p('--surface-1'), 0.1)
    expect(contrast(p('--text-primary'), activeRow)).toBeGreaterThanOrEqual(4.5)
  })
}
function palette(theme: string, mode: string) {
  const vars: Record<string, string> = {}
  for (const [, selector, body] of css.matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)) {
    const t = /data-theme="([^"]+)"/.exec(selector)?.[1]
    const m = /data-color-mode="([^"]+)"/.exec(selector)?.[1]
    if ((t && t !== theme) || (m && m !== mode)) continue
    for (const [, key, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[key] = value.trim()
  }
  const resolve = (key: string): string => {
    const value = vars[key]
    const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) ([\d.]+)%, (#[\da-f]{6})\)$/.exec(value)
    if (mix) return composite(resolve(mix[1]), mix[3], Number(mix[2]) / 100)
    const ref = /^var\((--[\w-]+)\)/.exec(value)
    return ref ? resolve(ref[1]) : value
  }
  return resolve
}
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    expect(hex).toMatch(/^#[\da-f]{6}$/i)
    const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
for (const theme of ['default', 'amber']) {
  for (const mode of ['dark', 'light']) {
    describe(`${theme} x ${mode}`, () => {
      const p = palette(theme, mode)
      for (const surface of ['--surface-selected', '--surface-banner']) {
        for (const foreground of ['--text-primary', '--text-active']) {
          it(`${foreground} remains readable on ${surface}`, () => {
            expect(contrast(p(foreground), p(surface))).toBeGreaterThanOrEqual(4.5)
          })
        }
      }
      for (const surface of ['--surface-page', '--surface-input', '--surface-hover', '--surface-selected']) {
        it(`focus ring clears ${surface}`, () => {
          expect(contrast(p('--focus-ring'), p(surface))).toBeGreaterThanOrEqual(3)
        })
      }
      if (mode === 'light') {
        it('keeps the Machine Definition Z label readable in both identities', () => {
          expect(p('--axis-z')).toBe(p('--vp-axis-z'))
          expect(contrast(p('--axis-z'), p('--surface-1'))).toBeGreaterThanOrEqual(4.5)
        })
        // Offset outlines contrast with the host plane, independently of button fill.
        for (const surface of ['--surface-1', '--surface-2']) {
          it(`offset focus remains visible against ${surface}`, () => {
            expect(contrast(p('--focus-ring'), p(surface))).toBeGreaterThanOrEqual(3)
          })
        }
        for (const surface of ['--surface-1', '--surface-hover', '--surface-selected']) {
          it(`disabled text recedes on ${surface}`, () => {
            expect(contrast(p('--text-disabled'), p(surface))).toBeGreaterThanOrEqual(2.5)
          })
        }
        // Checkbox, listbox and field outlines consume border-strong in production.
        for (const surface of ['--surface-1', '--surface-input']) {
          it(`real control boundaries clear ${surface}`, () => {
            expect(contrast(p('--border-strong'), p(surface))).toBeGreaterThanOrEqual(3)
          })
        }
        it('primary action labels remain readable', () => {
          expect(contrast(p('--text-on-accent'), p('--role-primary-fill'))).toBeGreaterThanOrEqual(4.5)
        })
      }
    })
  }
}

for (const theme of ['default', 'amber']) {
  describe(`${theme} light viewport chrome`, () => {
    const p = palette(theme, 'light')
    for (const surface of ['--surface-viewport-dimension', '--surface-viewport-badge', '--surface-viewport-machine', '--surface-viewport-machine-hover', '--surface-viewport-selection', '--surface-viewport-legend', '--surface-viewport-transport', '--vp-cube-face', '--vp-cube-hover']) {
      it(`keeps labels readable on ${surface}`, () => {
        expect(contrast(p('--text-secondary'), p(surface))).toBeGreaterThanOrEqual(4.5)
      })
    }
  })
}

for (const theme of ['default', 'amber']) {
  for (const alpha of [0.26, 0.40]) {
    it(`${theme} light E-STOP label clears its normal/hover tint at ${alpha}`, () => {
      const p = palette(theme, 'light')
      const bytes = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16))
      const bg = bytes(p('--surface-1'))
      const tint = '#' + bytes(p('--red-500')).map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
      expect(contrast(p('--text-danger'), tint)).toBeGreaterThanOrEqual(4.5)
    })
  }
}
function oklab(hex: string) {
  const [r, g, b] = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b)
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b)
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b)
  const L = .2104542553*l + .793617785*m - .0040720468*s
  const a = 1.9779984951*l - 2.428592205*m + .4505937099*s
  const b2 = .0259040371*l + .7827717662*m - .808675766*s
  return { L: L * 100, a, b: b2, C: Math.hypot(a, b2), h: (Math.atan2(b2, a) * 180 / Math.PI + 360) % 360 }
}

for (const theme of ['default', 'amber']) {
  describe(`${theme} light WO-1254 palette structure`, () => {
    const p = palette(theme, 'light')
    it('uses tinted planes with raised panels and stronger selection than hover', () => {
      for (const role of ['--surface-page', '--surface-canvas', '--surface-1', '--surface-2', '--surface-input', '--surface-hover']) {
        expect(oklab(p(role)).C, role).toBeGreaterThanOrEqual(.005)
        expect(p(role)).not.toBe('#ffffff')
      }
      expect(oklab(p('--surface-1')).L).toBeGreaterThan(oklab(p('--surface-page')).L)
      expect(oklab(p('--surface-1')).L).toBeGreaterThan(oklab(p('--surface-input')).L)
      expect(contrast(p('--surface-1'), p('--surface-selected'))).toBeGreaterThan(contrast(p('--surface-1'), p('--surface-hover')))
    })
    it('keeps five distinct text registers and the established axes', () => {
      expect(new Set(['--text-primary', '--text-secondary', '--text-muted', '--text-dim', '--text-disabled'].map(p)).size).toBe(5)
      expect(p('--axis-x')).toBe('#b42318')
      expect(p('--axis-y')).toBe('#286f32')
      expect(p('--vp-axis-x')).toBe('#b42318')
      expect(p('--vp-axis-y')).toBe('#287239')
    })
    // Ramp/helix and lead-in/out are intentionally the same move-family color.
    for (const [family, roles] of [
      ['toolpath', ['--hue-cut', '--hue-finish', '--hue-lead-in', '--hue-plunge', '--hue-stepover', '--hue-fast-traverse', '--hue-wall-follow', '--gold-wcs', '--hue-rapid', '--hue-helix']],
      ['status', ['--green-500', '--red-500', '--orange-500', '--status-stale', '--violet-500']],
    ] as const) {
      it(`separates ${family} roles by lightness or hue`, () => {
        const colors = roles.map(role => ({ role, ...oklab(p(role)) }))
        for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
          const a = colors[i], b = colors[j]
          const dh = Math.abs(a.h - b.h)
          expect(Math.abs(a.L - b.L) >= 8 || Math.min(dh, 360 - dh) >= 30, `${a.role}/${b.role}: dL=${Math.abs(a.L-b.L)}, dHue=${Math.min(dh,360-dh)}`).toBe(true)
        }
        if (family === 'toolpath') expect(Math.max(...colors.map(c => c.L)) - Math.min(...colors.map(c => c.L))).toBeGreaterThanOrEqual(22)
      })
    }
  })
}
it('restores cross-theme identity separation', () => {
  const a = oklab(palette('default', 'light')('--role-identity'))
  const b = oklab(palette('amber', 'light')('--role-identity'))
  expect(Math.hypot((a.L-b.L)/100, a.a-b.a, a.b-b.b)*100).toBeGreaterThanOrEqual(25)
})

// WO-1257: dark declarations are outside this light-only color-presence pass. Hash repinned after WO-2357 (comment-only name scrub, no declaration changed).
it('preserves the complete dark token source byte for byte (LF normalized)', () => {
  const dark = readFileSync('src/theme/tokens.css', 'utf8').replaceAll('\r\n', '\n')
    .split(':root[data-color-mode="light"]')[0]
  expect(createHash('sha256').update(dark).digest('hex'))
    .toBe('bf1cd36e24734feebe8309763519e1c307a43a5fdb18f3ce26bcc0a555e7533a')
})
for (const theme of ['default', 'amber']) {
  describe(`${theme} light WO-1257 identity presence`, () => {
    const p = palette(theme, 'light')
    for (const role of ['--role-primary-fill', '--role-identity', '--role-identity-light']) {
      it(`${role} carries saturated identity color`, () => {
        expect(oklab(p(role)).C).toBeGreaterThanOrEqual(theme === 'amber' ? .125 : .17)
      })
    }
    it('keeps identity labels readable on panels and selected rows', () => {
      for (const surface of ['--surface-1', '--surface-2', '--surface-selected']) {
        expect(contrast(p('--role-identity-light'), p(surface))).toBeGreaterThanOrEqual(4.5)
      }
      expect(oklab(p('--surface-selected')).C).toBeGreaterThanOrEqual(theme === 'amber' ? .09 : .06)
    })
    it('preserves the established light surface depth and hairline', () => {
      const roles = ['--surface-page', '--surface-1', '--surface-2', '--surface-input', '--surface-hover', '--surface-selected']
      const lightness = roles.map(role => oklab(p(role)).L)
      expect(Math.max(...lightness) - Math.min(...lightness)).toBeGreaterThan(8)
      expect(Math.max(...lightness) - Math.min(...lightness)).toBeLessThan(12)
      expect(contrast(p('--border-subtle'), p('--surface-1'))).toBeLessThan(1.5)
      expect(p('--vp-axis-z')).toBe('#1f5d99')
    })
  })
}
