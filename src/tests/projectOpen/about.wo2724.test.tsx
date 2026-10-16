// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AboutModal } from '../../components/modals/AboutModal'
import { TopToolbar } from '../../components/toolbar/TopToolbar'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('WO-2724 exposes About beside Help in the main toolbar', () => {
  const onAbout = vi.fn()
  render(<TopToolbar onAbout={onAbout} />)
  fireEvent.click(screen.getByRole('button', { name: 'About LienCAM' }))
  expect(onAbout).toHaveBeenCalledOnce()
  expect(screen.getByTestId('toolbar-help')).toBeTruthy()
})
it('WO-2724 supplies new-tab web links and routes desktop clicks to the system browser', () => {
  render(<AboutModal isOpen onClose={() => {}} />)
  const repo = screen.getByRole('link', { name: 'GitHub project' })
  expect(repo.getAttribute('href')).toBe('https://github.com/eclsnowman/LienCAM')
  expect(repo.getAttribute('target')).toBe('_blank')
  expect(screen.getByRole('link', { name: 'Releases' }).getAttribute('href')).toBe('https://github.com/eclsnowman/LienCAM/releases')
  const openProjectLink = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('liencamHost', { openProjectLink })
  fireEvent.click(repo)
  expect(openProjectLink).toHaveBeenCalledWith('https://github.com/eclsnowman/LienCAM')
})
