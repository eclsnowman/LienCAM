// @vitest-environment node
//
// WO UI-14A-R2, criterion 4 (Option B): "a test that the generation is never
// incremented in any post-await continuation (scan or runtime assert -- your
// choice, justify)."
//
// CHOICE: SOURCE SCAN. Justification -- the property is "this write never
// executes inside a promise continuation". A runtime assert would have to
// observe, from inside beginPushPullGestureEnd, whether its caller's stack is a
// macrotask or a microtask resumption. JavaScript exposes no portable hook for
// that: async_hooks/AsyncLocalStorage are Node-only and never run in the app's
// real environment (browser + jsdom), and Error.stack cannot distinguish an
// awaited resumption from a direct call because the await boundary erases the
// synchronous frames. Any runtime "assert" would therefore be a proxy for the
// real property, and the standing rule of this WO chain is that a check which
// cannot fail on the real defect is not a gate.
//
// The scan instead checks the exact STRUCTURE that makes the property true, and
// each clause fails loudly on the specific edit that would break it:
//
//   1. pushPullGenerationRef is written in exactly ONE place, and that place is
//      beginPushPullGestureEnd.               (a new bump anywhere -> fails)
//   2. beginPushPullGestureEnd contains no `await` and no `.then(` -- so the
//      bump can never itself be preceded by a suspension point within its own
//      body.                                  (adding one -> fails)
//   3. Both gesture-end handlers call beginPushPullGestureEnd BEFORE their
//      first `await` -- i.e. in the synchronous prefix of the DOM-event handler
//      that invoked them.                     (moving it after an await -> fails)
//   4. handlePushPullCommit never mentions handlePushPullCancel. This is the
//      audited defect verbatim: "after awaiting commit validation,
//      handlePushPullCommit calls handlePushPullCancel, whose synchronous
//      prefix increments the generation."     (reinstating it -> fails)
//   5. The single-flight lock is taken in beginPushPullGestureEnd, released in
//      exactly the two handlers' `finally` blocks, and consulted at the top of
//      runPushPullPreview.                    (dropping any -> fails)
//
// Clauses 1-4 together are the whole "no post-await increment" invariant:
// the only writer is await-free (1, 2) and is only ever reached from a
// synchronous DOM-event prefix (3, 4). Clause 5 is what makes the invariant
// SAFE rather than merely true -- see the runtime tests in
// SolidsWorkbenchPage.pushPull.test.tsx, which prove the lock's behaviour.

import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE_PATH = fileURLToPath(new URL('../../components/model3d/SolidsWorkbenchPage.tsx', import.meta.url))

/** Blanks out comments and string/template literals (preserving every byte
 *  offset and newline, so slice arithmetic on the result maps 1:1 back onto the
 *  original file). A single left-to-right scanner, so an apostrophe inside a
 *  comment cannot open a "string" and a `//` inside a string cannot open a
 *  comment -- the two failure modes a pair of independent regexes would hit.
 *  Regex literals are deliberately NOT tracked: this file contains none, and
 *  the anchor assertions below fail loudly if the scan ever mangles the source. */
function blankCommentsAndLiterals(src: string): string {
  const out = src.split('')
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && next === '*') {
      blank(i++)
      blank(i++)
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++)
      if (i < src.length) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      blank(i++)
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') blank(i++)
        if (i < src.length) blank(i++)
      }
      if (i < src.length) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

/** Slices one `const <name> = useCallback(...)` binding out of the component
 *  body: from its declaration to the next top-level (2-space-indented) binding
 *  or hook call. Fail-closed -- if the anchors move, every clause below reports
 *  a missing anchor rather than silently passing on an empty slice. */
function sliceCallback(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`)
  expect(start, `anchor not found: const ${name} = useCallback(`).toBeGreaterThan(-1)
  const candidates = ['\n  const ', '\n  useEffect(', '\n  useMemo(', '\n  return ']
    .map((token) => src.indexOf(token, start + 1))
    .filter((index) => index > -1)
  expect(candidates.length, `no terminator found after ${name}`).toBeGreaterThan(0)
  const end = Math.min(...candidates)
  expect(end, `terminator precedes ${name}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('SolidsWorkbenchPage push/pull generation invariant (WO UI-14A-R2, criterion 4)', () => {
  const raw = readFileSync(SOURCE_PATH, 'utf8')
  const code = blankCommentsAndLiterals(raw)

  // Scanner sanity: if blankCommentsAndLiterals ever eats real code, these go
  // first and the clauses below never get to pass vacuously.
  it('the comment/literal scanner leaves the code anchors intact', () => {
    expect(code).toHaveLength(raw.length)
    for (const anchor of [
      'const pushPullGenerationRef = useRef(0)',
      'const pushPullEndingRef = useRef(false)',
      'const beginPushPullGestureEnd = useCallback(',
      'const restorePushPullBase = useCallback(',
      'const handlePushPullCancel = useCallback(',
      'const handlePushPullCommit = useCallback(',
      'const runPushPullPreview = useCallback(',
    ]) {
      expect(code, `anchor lost by the scanner: ${anchor}`).toContain(anchor)
    }
    // The word `await` must survive in code but be gone from prose.
    expect(code).toContain('await progressiveTessellate(')
    expect(code).not.toContain('post-await') // only ever appears in comments
  })

  it('clause 1+2: pushPullGenerationRef is written exactly once, inside an await-free beginPushPullGestureEnd', () => {
    const writes = [...code.matchAll(/pushPullGenerationRef\.current\s*(\+\+|--|\+=|-=|=(?!=))/g)]
    expect(writes.map((m) => m[0].trim())).toEqual(['pushPullGenerationRef.current +='])

    const begin = sliceCallback(code, 'beginPushPullGestureEnd')
    const writeIndex = writes[0].index ?? -1
    const beginStart = code.indexOf('const beginPushPullGestureEnd = useCallback(')
    expect(writeIndex).toBeGreaterThan(beginStart)
    expect(writeIndex).toBeLessThan(beginStart + begin.length)

    expect(begin).not.toMatch(/\bawait\b/)
    expect(begin).not.toContain('.then(')
    expect(begin).toContain('pushPullEndingRef.current = true')
  })

  it('clause 3: both gesture-end handlers take the lock + bump in their synchronous prefix, before any await', () => {
    for (const name of ['handlePushPullCancel', 'handlePushPullCommit']) {
      const body = sliceCallback(code, name)
      const acquire = body.indexOf('beginPushPullGestureEnd()')
      expect(acquire, `${name} never calls beginPushPullGestureEnd()`).toBeGreaterThan(-1)
      const firstAwait = body.search(/\bawait\b/)
      expect(firstAwait, `${name} has no await -- anchor stale`).toBeGreaterThan(-1)
      expect(acquire, `${name} acquires the lock AFTER an await`).toBeLessThan(firstAwait)
      expect(body, `${name} never releases the lock`).toContain('pushPullEndingRef.current = false')
      expect(body, `${name} does not release the lock in a finally`).toMatch(/finally\s*\{/)
    }
  })

  it('clause 4: handlePushPullCommit never re-enters handlePushPullCancel (the audited post-await bump)', () => {
    const commit = sliceCallback(code, 'handlePushPullCommit')
    expect(commit).not.toContain('handlePushPullCancel')
    // ...it uses the non-bumping restore instead.
    expect(commit).toContain('restorePushPullBase(')
    // And the restore itself neither bumps nor touches the lock.
    const restore = sliceCallback(code, 'restorePushPullBase')
    expect(restore).not.toContain('pushPullGenerationRef')
    expect(restore).not.toContain('pushPullEndingRef')
  })

  it('clause 5: the lock is acquired once, released exactly twice (the two handlers), and gates runPushPullPreview', () => {
    expect(countOccurrences(code, 'pushPullEndingRef.current = true')).toBe(1)
    expect(countOccurrences(code, 'pushPullEndingRef.current = false')).toBe(2)
    const preview = sliceCallback(code, 'runPushPullPreview')
    expect(preview).toContain('if (pushPullEndingRef.current) return')
    // The guard must precede the throttle bookkeeping, or a refused sample
    // would still be recorded as this (dead) gesture's pendingDelta.
    expect(preview.indexOf('if (pushPullEndingRef.current) return')).toBeLessThan(preview.indexOf('state.pendingDelta = delta'))
  })
})

// ===========================================================================
// WO UI-14A-R3, criterion "the major" (UI-14A-R2.audit.json finding 2).
//
// The auditor, verbatim: "The no-post-await scan does not prove its stated
// property. It bans .then only inside beginPushPullGestureEnd and clause 3
// compares the first textual beginPushPullGestureEnd occurrence with the first
// textual await in each handler. It does not ban .then in callers or prove that
// the sole writer is invoked only by the two synchronous direct call sites."
// Their mutation -- `const deferredBegin = Promise.resolve().then(() =>
// beginPushPullGestureEnd()); const begun = await deferredBegin` -- moves the
// sole generation writer into a promise continuation and passes ALL FIVE
// textual clauses, because the writer's NAME still appears before the first
// `await` in the handler's text.
//
// The textual clauses bind the writer's IDENTITY. These bind its TIMING. A
// TypeScript AST scan ENUMERATES every beginPushPullGestureEnd call site and
// rejects any that is not lexically the handler's own body -- i.e. any call
// nested in an async continuation, a .then/.catch/.finally callback, a promise
// executor, or an awaited expression. A call that survives A1+A2 provably runs
// in its handler's synchronous prefix, in the caller's own turn of the event
// loop, which is the property the whole single-flight design rests on.
//
// Why an AST scan and not a runtime assert: unchanged from the file header --
// JavaScript exposes no portable way for a callee to observe whether its
// caller's frame is a macrotask or a microtask resumption. The AST is where
// this property is decidable.
//
// The five clauses above are deliberately left UNMODIFIED (the R2 audit
// re-executed them by name); these are additive.
// ===========================================================================
describe('SolidsWorkbenchPage push/pull writer-TIMING AST scan (WO UI-14A-R3, audit finding 2)', () => {
  const source = ts.createSourceFile(SOURCE_PATH, readFileSync(SOURCE_PATH, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

  type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration

  const isFunctionLike = (n: ts.Node): n is Fn =>
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

  const walk = (root: ts.Node, visit: (n: ts.Node) => void): void => {
    visit(root)
    ts.forEachChild(root, (child) => walk(child, visit))
  }

  const lineOf = (n: ts.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1

  const enclosingFunction = (n: ts.Node): Fn | undefined => {
    let p: ts.Node | undefined = n.parent
    while (p !== undefined) {
      if (isFunctionLike(p)) return p
      p = p.parent
    }
    return undefined
  }

  /** The name of the `const <name> = useCallback(<this fn>, deps)` binding this
   *  function IS, or null when the function is nested inside something else --
   *  a .then callback, a promise executor, another arrow. Null is the whole
   *  point: a nested function's body does not run in its caller's turn. */
  const callbackNameOf = (fn: Fn): string | null => {
    const call = fn.parent
    if (call === undefined || !ts.isCallExpression(call) || call.arguments[0] !== fn) return null
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'useCallback') return null
    const decl = call.parent
    if (decl === undefined || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null
    return decl.name.text
  }

  const callbackArrow = (name: string): Fn => {
    let found: Fn | undefined
    walk(source, (n) => {
      if (!isFunctionLike(n)) return
      if (callbackNameOf(n) === name) found = n
    })
    expect(found, `no \`const ${name} = useCallback(...)\` arrow found -- anchor stale`).toBeDefined()
    return found as Fn
  }

  const callSitesOf = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = []
    walk(source, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n)
    })
    return out
  }

  /** AwaitExpressions lexically inside `fn`'s own body, NOT inside any nested
   *  function (a nested async arrow's awaits say nothing about fn's prefix). */
  const ownAwaits = (fn: Fn): ts.AwaitExpression[] => {
    const out: ts.AwaitExpression[] = []
    const visit = (n: ts.Node): void => {
      if (n !== fn && isFunctionLike(n)) return
      if (ts.isAwaitExpression(n)) out.push(n)
      ts.forEachChild(n, visit)
    }
    visit(fn)
    return out
  }

  const ancestorsUpTo = (n: ts.Node, stop: ts.Node): ts.Node[] => {
    const out: ts.Node[] = []
    let p: ts.Node | undefined = n.parent
    while (p !== undefined && p !== stop) {
      out.push(p)
      p = p.parent
    }
    return out
  }

  const isRefCurrent = (e: ts.Node, refName: string): boolean =>
    ts.isPropertyAccessExpression(e) && e.name.text === 'current' && ts.isIdentifier(e.expression) && e.expression.text === refName

  /** Every syntactic WRITE to `<refName>.current`: `=`, `+=`, `-=`, `++`, `--`. */
  const writesTo = (refName: string): ts.Node[] => {
    const out: ts.Node[] = []
    walk(source, (n) => {
      if (
        ts.isBinaryExpression(n) &&
        isRefCurrent(n.left, refName) &&
        [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)
      ) {
        out.push(n)
      }
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        isRefCurrent(n.operand, refName) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        out.push(n)
      }
    })
    return out
  }

  /** True when `n` sits inside the `finally { }` block of a try statement that
   *  is itself inside `fn` (never a nested function's own try). */
  const inFinallyBlockOf = (n: ts.Node, fn: Fn): boolean => {
    let child: ts.Node = n
    let p: ts.Node | undefined = n.parent
    while (p !== undefined && p !== fn) {
      if (ts.isTryStatement(p) && p.finallyBlock === child) return true
      if (isFunctionLike(p)) return false
      child = p
      p = p.parent
    }
    return false
  }

  it('the AST anchors resolve (fail-closed: a moved handler must not vacuously pass every clause below)', () => {
    expect(source.statements.length).toBeGreaterThan(0)
    for (const name of [
      'beginPushPullGestureEnd',
      'restorePushPullBase',
      'handlePushPullCancel',
      'handlePushPullCommit',
      'runPushPullPreview',
      'handlePushPullPick',
    ]) {
      expect(callbackNameOf(callbackArrow(name)), `anchor lost: ${name}`).toBe(name)
    }
    expect(callSitesOf('beginPushPullGestureEnd').length).toBeGreaterThan(0)
  })

  it('clause A1: every beginPushPullGestureEnd call site is a DIRECT, un-nested call in one of the two handlers -- never in a .then/.catch/.finally callback, an async continuation, or an awaited expression', () => {
    const cancel = callbackArrow('handlePushPullCancel')
    const commit = callbackArrow('handlePushPullCommit')
    const calls = callSitesOf('beginPushPullGestureEnd')

    // ENUMERATION, not sampling: exactly two call sites exist in this file.
    expect(calls, 'the generation writer must have exactly two call sites').toHaveLength(2)

    const owners: string[] = []
    for (const call of calls) {
      const fn = enclosingFunction(call)
      expect(fn, `beginPushPullGestureEnd() at line ${lineOf(call)} is not inside any function`).toBeDefined()
      const owner = callbackNameOf(fn as Fn)
      // THE AUDITOR'S MUTATION DIES HERE: `Promise.resolve().then(() =>
      // beginPushPullGestureEnd())` puts the call inside a nested arrow whose
      // parent is `.then(...)`, not a `useCallback` binding -- owner is null.
      expect(
        owner,
        `beginPushPullGestureEnd() at line ${lineOf(call)} is nested inside a function that is not a useCallback handler body ` +
          `(a .then/.catch/.finally callback, a promise executor, or another closure). Its execution is DEFERRED to a promise ` +
          `continuation, so the generation bump is no longer synchronous with the DOM event that triggered it.`,
      ).not.toBeNull()
      expect([`handlePushPullCancel`, `handlePushPullCommit`], `unexpected caller: ${owner}`).toContain(owner)
      owners.push(owner as string)

      // Belt and braces, with sharper diagnostics for the forms the identity
      // check above would only report as "nested": an awaited construction, and
      // a promise-combinator argument, anywhere between the call and its owner.
      for (const a of ancestorsUpTo(call, fn as ts.Node)) {
        expect(
          ts.isAwaitExpression(a),
          `beginPushPullGestureEnd() at line ${lineOf(call)} is inside an awaited expression -- its bump is not in the synchronous prefix`,
        ).toBe(false)
        if (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression)) {
          expect(
            ['then', 'catch', 'finally'],
            `beginPushPullGestureEnd() at line ${lineOf(call)} is an argument to .${a.expression.name.text}() -- a promise continuation`,
          ).not.toContain(a.expression.name.text)
        }
      }
    }
    expect([...owners].sort()).toEqual(['handlePushPullCancel', 'handlePushPullCommit'])
    expect(enclosingFunction(calls[0])).toBe(cancel)
    expect(enclosingFunction(calls[1])).toBe(commit)
  })

  it('clause A2: each call site textually precedes EVERY await in its own handler body (nested functions excluded) -- the synchronous prefix, decided on the AST rather than on text', () => {
    for (const call of callSitesOf('beginPushPullGestureEnd')) {
      const fn = enclosingFunction(call) as Fn
      const name = callbackNameOf(fn)
      const awaits = ownAwaits(fn)
      expect(awaits.length, `${name} has no await -- anchor stale, this clause would pass vacuously`).toBeGreaterThan(0)
      const firstAwait = Math.min(...awaits.map((a) => a.getStart(source)))
      expect(
        call.getEnd(),
        `${name} calls beginPushPullGestureEnd() at line ${lineOf(call)}, AFTER an await -- the bump would land in a promise continuation`,
      ).toBeLessThan(firstAwait)
    }
  })

  it('clause A3: pushPullGenerationRef has exactly ONE writer, it lives in beginPushPullGestureEnd, and that function is non-async, await-free, and contains no nested function that could defer the bump', () => {
    const writes = writesTo('pushPullGenerationRef')
    expect(writes, 'the generation must have exactly one syntactic writer').toHaveLength(1)
    const owner = enclosingFunction(writes[0])
    expect(owner, 'the generation write is not inside a function').toBeDefined()
    expect(callbackNameOf(owner as Fn), `the generation is written at line ${lineOf(writes[0])}, outside beginPushPullGestureEnd`).toBe(
      'beginPushPullGestureEnd',
    )

    const begin = callbackArrow('beginPushPullGestureEnd')
    const isAsync = begin.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
    expect(isAsync, 'beginPushPullGestureEnd must not be async').toBe(false)
    expect(ownAwaits(begin), 'beginPushPullGestureEnd must contain no await').toHaveLength(0)

    const nested: number[] = []
    walk(begin, (n) => {
      if (n !== begin && isFunctionLike(n)) nested.push(lineOf(n))
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        expect(['then', 'catch', 'finally'], `beginPushPullGestureEnd defers work through .${n.expression.name.text}()`).not.toContain(
          n.expression.name.text,
        )
      }
    })
    expect(nested, `beginPushPullGestureEnd contains nested function(s) at line(s) ${nested.join(', ')}`).toEqual([])
  })

  it('clause A4: the cleanup-tail token is minted only by the create/edit mount paths, retired in BOTH gesture-end handlers finally blocks, and consulted by all three gizmo seams (WO UI-14A-R3/UI-82)', () => {
    const writes = writesTo('pushPullActiveGestureRef')
    const byOwner = writes.map((w) => ({
      owner: callbackNameOf(enclosingFunction(w) as Fn),
      isNull: ts.isBinaryExpression(w) && w.right.kind === ts.SyntaxKind.NullKeyword,
      node: w,
      line: lineOf(w),
    }))

    const mints = byOwner.filter((w) => !w.isNull)
    expect(mints.map((m) => m.owner), 'the live-gesture token must be minted only by the two supported mount paths').toEqual([
      'handlePushPullPick',
      'handleEditPushPull',
    ])

    const retires = byOwner.filter((w) => w.isNull)
    expect(retires.map((r) => r.owner).sort(), 'the token must be retired by exactly the two gesture-end handlers').toEqual([
      'handlePushPullCancel',
      'handlePushPullCommit',
    ])
    for (const r of retires) {
      // A retirement outside `finally` would be skipped by a throwing handler,
      // stranding a live token on a dead mount.
      expect(
        inFinallyBlockOf(r.node, callbackArrow(r.owner as string)),
        `${r.owner} retires the token at line ${r.line}, outside its finally block`,
      ).toBe(true)
    }

    // ...and every seam a dead mount's closures can reach must CONSULT it.
    const reads = new Map<string, number>()
    walk(source, (n) => {
      if (!isRefCurrent(n, 'pushPullActiveGestureRef')) return
      const assigned = n.parent !== undefined && ts.isBinaryExpression(n.parent) && n.parent.left === n
      if (assigned) return
      const fn = enclosingFunction(n)
      const owner = fn === undefined ? '<module>' : (callbackNameOf(fn) ?? '<nested>')
      reads.set(owner, (reads.get(owner) ?? 0) + 1)
    })
    for (const seam of ['runPushPullPreview', 'handlePushPullCommit', 'handlePushPullCancel']) {
      expect(reads.get(seam) ?? 0, `${seam} never consults the live-gesture token -- a closure over a dead mount would be accepted`).toBeGreaterThan(0)
    }
  })
})
