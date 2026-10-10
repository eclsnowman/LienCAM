// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LocalQrCode } from '../../components/common/LocalQrCode'

describe('LocalQrCode', () => {
  it('renders the fixed version 10 matrix with its required quiet border', () => {
    const { container } = render(
      <LocalQrCode value="http://192.0.2.10:8324/?pair=1234567890abcdef" />,
    )
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 65 65')
    expect(container.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(5_000)
  })

  it('renders an offline SVG and changes its payload for a different pairing URL', () => {
    const first = render(<LocalQrCode value="http://192.0.2.20:8324/?pair=aaaaaaaaaaaaaaaa" />)
    const firstPath = first.container.querySelector('path')?.getAttribute('d')
    cleanup()
    const second = render(<LocalQrCode value="http://192.0.2.20:8324/?pair=bbbbbbbbbbbbbbbb" />)
    const secondPath = second.container.querySelector('path')?.getAttribute('d')
    expect(firstPath).not.toBe(secondPath)
    expect(screen.getByRole('img', { name: /pairing QR code/i }).tagName.toLowerCase()).toBe('svg')
  })
})
