// Explicit manual capture entry; inherit the production benchmark environment.
import config from '../../../vite.config.mts'

export default {
  ...config,
  test: {
    ...(config as { test?: object }).test,
    include: ['src/tests/benchmark/alpha3Capture.capture.ts'],
  },
}
