import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import viteConfig from '../../../vite.config.mts'

it('allows both the worktree and its resolved shared node_modules target', () => {
  const projectRoot = dirname(fileURLToPath(new URL('../../../vite.config.mts', import.meta.url)))
  const dependencyRoot = realpathSync(join(projectRoot, 'node_modules'))
  const allow = 'server' in viteConfig ? viteConfig.server?.fs?.allow : undefined

  expect(allow).toEqual([projectRoot, dependencyRoot])
})
