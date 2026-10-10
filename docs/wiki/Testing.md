# Testing

LienCAM's tests are its safety net: they pin what each part is supposed to do so a change in one place cannot quietly break another.

## Running the public tests

```
npm ci
npm run test:public
```

`npm run test:public` runs the tests that ship in the public repository. While you work on one thing, run only its files:

```
npx vitest run src/tests/<area>/<file>.test.ts
```

`npm run build` type-checks and builds the app, and `npm run lint` runs the linter. Run the build when your change can affect compilation.

## Where tests live

Tests are under `src/tests/`, in a folder named for the area (for example `gcode`, `heights`, `geometry`, `components`). The file name says what the test pins.

## What a good test looks like

- **It checks behaviour, not wording.** Run the real function, or drive the real screen, and assert on what comes out: the moves, the G-code, the number on the screen. A test that searches the source for a string proves nothing about what the program does.
- **It fails without the fix.** Write the test, watch it fail on the old code, then fix. A test that never failed has not shown it can.
- **It uses the real entry point.** To test what the application draws or posts, go through the same function the application calls. A hand-built payload sent straight to an engine is a useful control but not proof of what users see.
- **It is small and named.** One idea per test, a `describe` for the area and an `it` that reads as a sentence.
- **It does not depend on the order or the clock.** No shared state between tests, no real waiting.
- **Nothing in it is private.** No personal paths, names or machine addresses; fixtures are small and committed.

## Sending your change

Run the tests for the area you touched, add one for what you changed, and describe what you ran in the pull request. See `CONTRIBUTING.md` for the sign-off and licence terms: contributions are accepted under the Apache License 2.0 with a Developer Certificate of Origin sign-off (`git commit -s`).
