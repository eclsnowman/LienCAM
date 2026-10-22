import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // '.worktrees' holds full checkouts of THIS repository, each with its own
  // src/. Without it here, `eslint .` walks every one of them and reports
  // their problems as if they were LienCAM's: on 2026-08-17 that turned a real
  // 965 into 11,280 (7,716 flagged file headers under .worktrees against 2,131
  // under the real src/), which made the lint gate meaningless and slow.
  // WO-1905: the authoring-lint fixtures are deliberately non-conforming source that overlayAuthoringLint/overlayGatePair assert against by line; linting them would mean editing them.
  // '.wo*' holds judges' scratch checkouts (2026-09-27: a WO-2096 auditor's .wo2096-audit/branch on the Spark
  // turned WO-2089's merge lint red while it existed).
  // .test-scratch holds whole-repo copies tests export (gitignored); linting it gives every
  // file two tsconfig roots, and the gate then baseline-lints thousands of files one by one.
  globalIgnores(['dist', 'archive', '.worktrees', '.wo*', '.test-scratch', 'src/tests/ui/fixtures/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    // BK-5: the config previously failed to LOAD (CommonJS package.json vs ESM
    // config), so none of the below had ever actually run repo-wide. Rules
    // downgraded to 'warn' here are pre-existing, repo-wide patterns newly
    // surfaced by the fix, out of this WO's scope to bulk-fix; each is one line.
    rules: {
      // pre-existing `any` usage across the codebase; type-strictness, not a bug.
      '@typescript-eslint/no-explicit-any': 'warn',
      // pre-existing `interface X extends Y {}` / `{}` type patterns; style-only.
      '@typescript-eslint/no-empty-object-type': 'warn',
      // repo convention prefixes intentionally-unused args/vars with `_`; honor it.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // new stricter react-hooks/react-compiler rules; pervasive pre-existing
      // patterns across components, real fixes are a separate effort.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      // pre-existing dead-store patterns scattered across cam/mesh/sketch; hygiene.
      'no-useless-assignment': 'warn',
      // fast-refresh co-location convention; dev-experience, not a correctness bug.
      'react-refresh/only-export-components': 'warn',
      // mechanical let-vs-const / regex-escape hygiene, pre-existing, out of scope.
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      // single pre-existing instances outside this WO's ownership manifest.
      'no-fallthrough': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['src/lib/cam/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/cam/flipSetup.ts', // legacy: cam -> store and post
      'src/lib/cam/modelBodyDerive.ts', // legacy: cam -> store
      'src/lib/cam/modelBodyHoleRecognition.ts', // legacy: cam -> components
      'src/lib/cam/nesting/instanceToolpath.ts', // legacy: cam -> store
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/store', '**/store/**', '**/post/**', '**/components/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: lib/cam may not import store, post, or components.',
      }] }],
    },
  },
  {
    files: ['src/lib/post/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/post/postProject.ts', // legacy: post -> store
      'src/lib/post/workOffsets.ts', // legacy: post -> store
      'src/lib/post/buildPostInput.ts', // legacy: post -> cam
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/store', '**/store/**', '**/components/**', '**/cam/**', '!**/cam/types', '!**/cam/feedrates'],
        allowTypeImports: true,
        message: 'Architecture boundary: lib/post may not import store, components, or cam except cam/types and cam/feedrates.',
      }] }],
    },
  },
  {
    files: ['src/lib/sketch/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/sketch/demoSeed.ts', // legacy: sketch -> store
      'src/lib/sketch/sketcher/sketchLayer.ts', // legacy: sketch -> store
      'src/lib/sketch/sketcher/index.ts', // legacy: sketch -> components
      'src/lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx', // legacy: sketch -> components
      'src/lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx', // legacy: sketch -> components
      'src/lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx', // legacy: sketch -> components
      'src/lib/sketch/sketcher/overlays/SketchPromptBar.tsx', // legacy: sketch -> components
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/store', '**/store/**', '**/components/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: lib/sketch may not import store or components.',
      }] }],
    },
  },
  {
    files: ['src/lib/program/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/program/buildMachineProgram.ts', // legacy: program -> machine
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/store', '**/store/**', '**/post/**', '**/components/**', '**/machine/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: lib/program must remain neutral.',
      }] }],
    },
  },
  {
    // machineControlStore is the sanctioned edge (ARCHITECTURE.md); only the UI layer
    // and the store aggregate (store/index.ts) are refused. Burn down the list below.
    files: ['src/lib/machine/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/machine/machineSession.ts', // legacy: machine -> store/index
      'src/lib/machine/pendantMachine.ts', // legacy: machine -> store/index
      'src/lib/machine/macros/macroRuntime.ts', // legacy: machine -> store/index and components
    ],
    rules: {
      // A gitignore-style '**/store' would also match store/machineControlStore,
      // so store/index is named by regex.
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/components/**', '**/pages/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: lib/machine may not import the UI layer or store/index (machineControlStore is allowed).',
      }, {
        regex: '(^|/)store(/index(\\.[cm]?[jt]sx?)?)?$',
        allowTypeImports: true,
        message: 'Architecture boundary: lib/machine may not import store/index (machineControlStore is allowed).',
      }] }],
    },
  },
  {
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/lib/cam/*2d/**', '**/lib/cam/adaptiveClearing2d/**', '**/lib/cam/**/engine/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: components may not import CAM operation builders or engines.',
      }] }],
    },
  },
  {
    files: ['src/store/**/*.{ts,tsx}'],
    ignores: [
      'src/store/index.ts', // legacy: store -> components
      'src/store/headlessModelBodyReplay.ts', // legacy: store -> components
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/components/**'],
        allowTypeImports: true,
        message: 'Architecture boundary: store may not import components.',
      }] }],
    },
  },
  {
    // ADR-0055 decision 2.2 (WO-2993): the agent command layer never reaches the
    // machine. No machine module, machine store, probe routine store, appCommand
    // G-code helper or pendant code. Its own rule key block, over files no other
    // no-restricted-imports block matches, so it replaces nothing.
    files: ['src/lib/agent/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: [
          '**/machine',
          '**/machine/**',
          '**/store/machine*',
          '**/store/probeRoutineStore',
          '**/gcode/appCommand',
          '**/pendant/**',
        ],
        message: 'ADR-0055: src/lib/agent may not import machine, machine store, probe routine store, appCommand or pendant code.',
      }] }],
    },
  },
  {
    // These two boundaries use 'no-restricted-syntax', not 'no-restricted-imports':
    // flat config replaces (never merges) a repeated rule KEY across matching
    // configs, and this block's 'files' (src/**) is a superset of the five
    // lane-specific no-restricted-imports blocks above. Sharing the same rule key
    // here would silently win last and disable all five (caught by audit on
    // attempt 1 - see src/tests/tools/importBoundaries.wo1834.test.ts for the
    // regression test). A different rule key cannot collide: ESLint merges
    // distinct rule keys from every matching config instead of replacing.
    //
    // The two exception lists are disjoint (nothing is both a node: exception
    // and a react exception), so a file that needs only ONE exemption cannot
    // share a single 'no-restricted-syntax' block with a file that needs the
    // other - that collapsed both selectors into one 'ignores' union on attempt
    // 2 and silently exempted src/components from the node: check (and spikes
    // from the react check) even though only one exemption was earned (caught
    // by audit - see the same test file for the regression tests). Instead this
    // is three blocks with non-overlapping 'files', so no two of them ever set
    // 'no-restricted-syntax' for the same file:
    //  - the main block below: both selectors, everything except both exception
    //    lists.
    //  - the node-exception files (spikes, fixturePaths.ts): react selector
    //    only - they still must not import react.
    //  - the react-exception files (components, entry points, hooks, sketcher
    //    overlays): node selector only - they still must not import node:.
    // src/tests/** gets neither selector: it is exempt from both by acceptance.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/tests/**', // test code is Node-hosted by design
      'src/spikes/**', // self-contained research area, own vitest config, no build entrypoint
      'src/cam3d/input/fixturePaths.ts', // NODE-TEST-ONLY per its own header, never bundled
      'src/components/**',
      'src/App.tsx', // legacy: entry point -> react
      'src/main.tsx', // legacy: entry point -> react
      'src/hooks/useControlJogKeys.ts', // legacy: hook -> react
      'src/hooks/useDialogFocus.ts', // legacy: hook -> react
      'src/hooks/useGlobalShortcuts.ts', // legacy: hook -> react
      'src/hooks/useSectionPlaneDrag.ts', // legacy: hook -> react
      'src/lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchContextMenu.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchPromptBar.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchTextAnchorPill.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketchTextInput.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/overlays/SketcherOverlays.tsx', // legacy: sketch -> react
      'src/lib/sketch/sketcher/useSketcherTool.ts', // legacy: sketch -> react
    ],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "ImportDeclaration[importKind!='type'][source.value=/^node:/]",
          message: 'Architecture boundary: browser-reachable code may not import node: builtins.',
        },
        {
          selector: "ImportDeclaration[importKind!='type'][source.value=/^(react|react-dom)(\\/.*)?$/]",
          message: 'Architecture boundary: react and react-dom belong in src/components.',
        },
      ],
    },
  },
  {
    // node: exception files: still subject to the react boundary - they are
    // not src/components or src/tests, so a react import here must still fail.
    files: [
      'src/spikes/**/*.{ts,tsx}',
      'src/cam3d/input/fixturePaths.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "ImportDeclaration[importKind!='type'][source.value=/^(react|react-dom)(\\/.*)?$/]",
        message: 'Architecture boundary: react and react-dom belong in src/components.',
      }],
    },
  },
  {
    // react exception files: still subject to the node: boundary - being
    // allowed to import react does not make them Node-hosted.
    files: [
      'src/components/**/*.{ts,tsx}',
      'src/App.tsx',
      'src/main.tsx',
      'src/hooks/useControlJogKeys.ts',
      'src/hooks/useDialogFocus.ts',
      'src/hooks/useGlobalShortcuts.ts',
      'src/hooks/useSectionPlaneDrag.ts',
      'src/lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx',
      'src/lib/sketch/sketcher/overlays/SketchContextMenu.tsx',
      'src/lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx',
      'src/lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx',
      'src/lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx',
      'src/lib/sketch/sketcher/overlays/SketchPatternEditor.tsx',
      'src/lib/sketch/sketcher/overlays/SketchPromptBar.tsx',
      'src/lib/sketch/sketcher/overlays/SketchTextAnchorPill.tsx',
      'src/lib/sketch/sketcher/overlays/SketchTextInput.tsx',
      'src/lib/sketch/sketcher/overlays/SketcherOverlays.tsx',
      'src/lib/sketch/sketcher/useSketcherTool.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "ImportDeclaration[importKind!='type'][source.value=/^node:/]",
        message: 'Architecture boundary: browser-reachable code may not import node: builtins.',
      }],
    },
  },
])
