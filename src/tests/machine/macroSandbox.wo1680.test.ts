// WO-1680: THE MACRO SANDBOX. A macro body is JavaScript run by our own
// interpreter: the language works (loops, conditions, functions), the API is
// the only door out, and nothing reaches the page - no window, no eval, no
// Function, no road back through `constructor`. Every API call is yielded to
// whoever drives the walk, which is what makes a run pausable and stoppable.

import { describe, expect, it } from 'vitest'
import {
  MacroBudgetError,
  MacroRuntimeError,
  MacroSyntaxError,
  STEP_BUDGET,
  parseMacro,
  runMacroProgram,
} from '../../lib/machine/macros/interpreter'
import { goToLines, MACRO_API } from '../../lib/machine/macros/macroRuntime'

interface Call { name: string; args: unknown[] }

/** Drive a body to the end, answering each API call with `answer`. */
function run(body: string, answer: (call: Call) => unknown = () => undefined): { calls: Call[]; slices: number } {
  const calls: Call[] = []
  let slices = 0
  const walk = runMacroProgram(parseMacro(body), MACRO_API)
  let input: unknown
  for (;;) {
    const step = walk.next(input)
    input = undefined
    if (step.done) break
    if (step.value.kind === 'slice') {
      slices++
      continue
    }
    const call = { name: step.value.name, args: step.value.args }
    calls.push(call)
    input = answer(call)
  }
  return { calls, slices }
}

function said(body: string, answer?: (call: Call) => unknown): unknown[] {
  return run(body, answer).calls.filter((c) => c.name === 'say').map((c) => c.args[0])
}

describe('the language', () => {
  it('loops, conditions and functions come from JavaScript', () => {
    const { calls } = run(`
      function cut(depth) { return 'G1 Z' + (-depth) }
      const depths = [1, 2, 3]
      for (let i = 0; i < depths.length; i++) {
        if (depths[i] === 2) continue
        line(cut(depths[i]))
      }
      let n = 0
      while (true) { n++; if (n >= 2) break }
      do { n += 10 } while (n < 30)
      for (const d of depths) say(\`d=\${d}\`)
      const twice = (x) => x * 2
      say(twice(n))
    `)
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([
      ['line', 'G1 Z-1'],
      ['line', 'G1 Z-3'],
      ['say', 'd=1'],
      ['say', 'd=2'],
      ['say', 'd=3'],
      ['say', 64],
    ])
  })

  it('objects, arrays, strings, Math and the usual operators', () => {
    expect(said(`
      const p = { x: 10, y: 20 }
      p.z = p.x + p.y
      say(p.z)
      const list = [3, 1]
      list.push(2)
      say(list.join('-'))
      say('abc'.toUpperCase().slice(1))
      say(Math.max(4, 9) ** 2 % 7)
      say(null ?? 'fallback')
      say(typeof nothingHere)
      say((5).toFixed(2))
      let k = 1
      k += 4
      k *= 2
      say(k > 9 && k < 11 ? 'ten' : 'other')
    `)).toEqual([30, '3-1-2', 'BC', 4, 'fallback', 'undefined', '5.00', 'ten'])
  })

  it('an API call returns its result into the body (status())', () => {
    const out = said(`
      const s = status()
      if (s.homed && s.machine.x > 5) { say('far') } else { say('near') }
    `, (call) => (call.name === 'status' ? { homed: true, machine: { x: 7, y: 0, z: 0 } } : undefined))
    expect(out).toEqual(['far'])
  })

  it('a function can recurse, and runaway recursion is a row, not a crash', () => {
    expect(said(`function f(n) { return n <= 1 ? 1 : n * f(n - 1) }; say(f(5))`)).toEqual([120])
    expect(() => run(`function f() { return f() }; f()`)).toThrow(MacroRuntimeError)
  })
})

describe('the sandbox', () => {
  it.each([
    ['window', 'window.location'],
    ['globalThis', 'globalThis.fetch'],
    ['document', 'document.body'],
    ['eval', 'eval("1")'],
    ['Function', 'Function("return 1")'],
    ['fetch', 'fetch("http://example.com")'],
    ['setTimeout', 'setTimeout(() => 1, 1)'],
    ['localStorage', 'localStorage.getItem("x")'],
  ])('%s is not defined', (name, body) => {
    expect(() => run(body)).toThrow(new RegExp(`"${name}" is not defined`))
  })

  it('no road back through constructor, __proto__ or prototype', () => {
    expect(said(`
      say(typeof [].constructor)
      say(typeof ''.constructor)
      say(typeof ({}).constructor)
      say(typeof (() => 1).constructor)
      say(typeof line.constructor)
      say(typeof ({}).__proto__)
      say(typeof Math.max.call)
      say(typeof [].map)
    `)).toEqual(Array(8).fill('undefined'))
    // Calling what came back is an error, never the host's Function.
    expect(() => run(`[].constructor.constructor('return this')()`)).toThrow(MacroRuntimeError)
  })

  it('an object the macro makes inherits nothing from the host', () => {
    expect(said(`const o = {}; say(typeof o.toString); say(typeof o.hasOwnProperty)`)).toEqual(['undefined', 'undefined'])
  })

  // WO-1707: + lines(...), a block through runMachineAction (former custom buttons).
  // WO-1715: + confirm, choose, ask - the questions a macro asks the operator.
  it('the API is exactly line, lines, goTo, output, wait, hold, status, say, clampPause, toolChange, confirm, choose, ask (WO-1715)', () => {
    expect([...MACRO_API].sort()).toEqual([
      'ask', 'choose', 'clampPause', 'confirm', 'goTo', 'hold', 'line', 'lines', 'output', 'say', 'status', 'toolChange', 'wait',
    ])
    expect(said(MACRO_API.map((name) => `say(typeof ${name})`).join('\n'))).toEqual(MACRO_API.map(() => 'function'))
  })
})

describe('runaway bodies and bad bodies', () => {
  it('while(true){} ends by the step budget, yielding to the UI on the way', () => {
    let slices = 0
    const walk = runMacroProgram(parseMacro('while(true){}'), MACRO_API)
    let error: unknown = null
    try {
      for (;;) {
        const step = walk.next()
        if (step.done) break
        if (step.value.kind === 'slice') slices++
      }
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(MacroBudgetError)
    expect((error as MacroBudgetError).line).toBe(1)
    expect((error as Error).message).toContain(String(STEP_BUDGET))
    // It handed the thread back many times before the budget ran out.
    expect(slices).toBeGreaterThan(10)
  })

  it('a loop that calls the machine is never cut off by the budget', () => {
    const { calls } = run(`for (let i = 0; i < 3; i++) { for (let j = 0; j < ${STEP_BUDGET / 20}; j++) {} ; wait(1) }`)
    expect(calls.filter((c) => c.name === 'wait')).toHaveLength(3)
  })

  it('a syntax error names its line and column and parses nothing', () => {
    try {
      parseMacro('line("M8")\nfor (let i = 0; i < 4 i++) {}\n')
      throw new Error('parsed')
    } catch (err) {
      expect(err).toBeInstanceOf(MacroSyntaxError)
      expect((err as MacroSyntaxError).line).toBe(2)
      expect((err as MacroSyntaxError).column).toBe(23)
    }
  })

  it('an undeclared name is a runtime row naming the line', () => {
    try {
      run('say(1)\nsay(2)\nnope()')
      throw new Error('ran')
    } catch (err) {
      expect(err).toBeInstanceOf(MacroRuntimeError)
      expect((err as MacroRuntimeError).line).toBe(3)
    }
  })
})

describe('goTo lines', () => {
  it('Z first by default, in machine coordinates, millimetres absolute', () => {
    expect(goToLines({ x: 10, y: 10, z: -5 }, { machine: true })).toEqual([
      'G21 G90 G53 G0 Z-5',
      'G21 G90 G53 G0 X10 Y10',
    ])
    expect(goToLines({ x: 10, y: 10 }, { machine: true })).toEqual(['G21 G90 G53 G0 X10 Y10'])
  })

  it('zFirst: false moves X Y first; machine: false moves in work coordinates', () => {
    expect(goToLines({ x: 1, z: 2 }, { machine: false, zFirst: false })).toEqual(['G21 G90 G0 X1', 'G21 G90 G0 Z2'])
  })
})
