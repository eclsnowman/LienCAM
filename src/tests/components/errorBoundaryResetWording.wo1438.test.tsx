// @vitest-environment jsdom
//
// WO-1438: the last-resort reset button in ErrorBoundary clears the whole
// `cnc-cam-project` durable-state key, which holds the project PLUS the tool
// library, holder library, machine library, app settings and imported fonts
// (see persistPartialize in src/store/index.ts and the activeProject entry in
// src/store/persistedKeys.ts). The confirmation copy used to say only that it
// "clears the saved project". This gate fails while that copy undersells the
// true scope and passes once it names everything the reset destroys.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Component } from 'react'
import { ErrorBoundary } from '../../components/ErrorBoundary'

afterEach(cleanup)

class ThrowsOnRender extends Component {
  render(): never {
    throw new Error('SYNTHETIC-WO1438-RENDER-THROW')
  }
}

function lastResortCopy(): string {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(
      <ErrorBoundary>
        <ThrowsOnRender />
      </ErrorBoundary>,
    )
    return (screen.getByText(/Still broken after reloading/i).textContent ?? '').toLowerCase()
  } finally {
    consoleSpy.mockRestore()
  }
}

describe('WO-1438 reset confirmation wording names the true reset scope', () => {
  it('names the tool, holder and machine libraries plus settings and fonts, not only the project', () => {
    const copy = lastResortCopy()

    expect(copy).toContain('project')
    expect(copy).toContain('tool library')
    expect(copy).toContain('holder library')
    expect(copy).toContain('machine library')
    expect(copy).toContain('settings')
    expect(copy).toContain('font')

    expect(copy).toContain('everything')
    expect(copy).toContain('cannot be undone')
  })
})