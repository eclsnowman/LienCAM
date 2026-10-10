import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import privateConfig from './vite.config.mts'
// @ts-expect-error The release list tool is a Node ESM module.
import { buildPublicTestList, printPublicTestSummary } from './tools/release/public-tests.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const list = buildPublicTestList(root)
printPublicTestSummary(list)

export default defineConfig({
  ...privateConfig,
  root,
  test: {
    ...(privateConfig as { test?: object }).test,
    include: list.kept,
  },
})
