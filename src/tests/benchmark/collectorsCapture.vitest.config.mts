import config from '../../../vite.config.mts'
export default { ...config, test: { ...(config as { test?: object }).test,
  include: ['src/tests/benchmark/collectorsCapture.capture.ts'] } }
