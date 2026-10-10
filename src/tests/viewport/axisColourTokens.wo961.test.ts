// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({
  arrowColors: [] as number[],
  labelPaints: [] as { letter: string; color: string }[],
}))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()

  class MockWebGLRenderer {
    setSize() {}
    setPixelRatio() {}
    render() {}
    forceContextLoss() {}
    dispose() {}
  }

  class ObservedArrowHelper extends actual.ArrowHelper {
    constructor(
      dir: import('three').Vector3,
      origin: import('three').Vector3,
      length: number,
      color: number,
    ) {
      super(dir, origin, length, color)
      observed.arrowColors.push(color)
    }
  }

  // WO-1052 FINDING: WebGLRenderer's real constructor demands an actual WebGL
  // context, which jsdom does not have, so unlike ArrowHelper this fake cannot
  // extend the real class to inherit its private members. Left untyped.
  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer,
    ArrowHelper: ObservedArrowHelper,
  }
})

import { ViewCube } from '../../components/viewport/ViewCube'
import { asHex, asNumber, refreshViewportColors } from '../../theme/viewportColors'

const camera = {
  getCamera: () => null,
  setCameraView: vi.fn(),
}

const mountCube = () => render(createElement(ViewCube, { camera }))

describe('WO-961 ViewCube axis colour ownership', () => {
  beforeEach(() => {
    observed.arrowColors.length = 0
    observed.labelPaints.length = 0
    document.documentElement.removeAttribute('data-theme')
    const style = document.createElement('style')
    style.dataset.wo961 = ''
    style.textContent = `
      :root {
        --vp-axis-x: #e05252;
        --vp-axis-y: #5ca85c;
        --vp-axis-z: #4a90d9;
      }
      :root[data-theme="high-contrast"] {
        --vp-axis-x: #e02020;
        --vp-axis-y: #5ca85c;
        --vp-axis-z: #4792e1;
      }
    `
    document.head.appendChild(style)
    refreshViewportColors()

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (contextId) {
      if (contextId !== '2d') return null
      const context = {
        fillStyle: '',
        font: '',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        fillText(letter: string) {
          observed.labelPaints.push({ letter, color: String(context.fillStyle) })
        },
      }
      return context as unknown as CanvasRenderingContext2D
    })
  })

  afterEach(() => {
    cleanup()
    document.head.querySelector('style[data-wo961]')?.remove()
    document.documentElement.removeAttribute('data-theme')
    refreshViewportColors()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('paints all three arrows and letters from the resolved default-theme tokens', () => {
    const arrowTokens = [
      asNumber('--vp-axis-x'),
      asNumber('--vp-axis-y'),
      asNumber('--vp-axis-z'),
    ]
    const labelTokens = [
      { letter: 'X', color: asHex('--vp-axis-x') },
      { letter: 'Y', color: asHex('--vp-axis-y') },
      { letter: 'Z', color: asHex('--vp-axis-z') },
    ]

    mountCube()

    expect(observed.arrowColors).toEqual(arrowTokens)
    expect(observed.labelPaints).toEqual(labelTokens)
  })

  it('moves the cube X paint when high-contrast moves the X token', () => {
    const defaultX = asNumber('--vp-axis-x')
    document.documentElement.setAttribute('data-theme', 'high-contrast')
    const highContrastX = asNumber('--vp-axis-x')
    const highContrastXHex = asHex('--vp-axis-x')

    expect(highContrastX).not.toBe(defaultX)
    mountCube()

    expect(observed.arrowColors[0]).toBe(highContrastX)
    expect(observed.labelPaints.find(({ letter }) => letter === 'X')?.color).toBe(highContrastXHex)
  })
})
