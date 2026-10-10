import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8')
const machine = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8')

function methodBody(source: string, signature: string, nextSignature: string) {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start + signature.length)
  expect(start, `${signature} is present`).toBeGreaterThanOrEqual(0)
  expect(end, `${nextSignature} follows ${signature}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const estopByReturnCode =
  'statusRcWait == (int)UC100.ReturnVal.UC100_ESTOP || st.Estop'

describe('WO-1314 homing E-stop reachability', () => {
  it.each([
    ['WaitHome', 'bool WaitHome(', 'bool WaitMoving('],
    ['WaitMoving', 'bool WaitMoving(', 'bool WaitSettled('],
    ['WaitSettled', 'bool WaitSettled(', 'bool WaitIdle('],
    ['WaitIdle', 'bool WaitIdle(', 'public Json.Obj Probe('],
  ])('%s treats GetStatus rc=7 as E-stop even if Stat was not filled', (_name, start, end) => {
    const body = methodBody(machine, start, end)
    expect(body).toContain('statusRcWait = UC100.GetStatus(ref st)')
    expect(body).toContain(estopByReturnCode)
  })

  it('posts homing as a long operation while E-stop stays a preempting stop', () => {
    const homeDispatch = methodBody(bridge, 'case "homeAxes":', '// ---- the live apply')
    const stopDispatch = methodBody(bridge, 'case "emergencyStop":', 'case "resetToIdle":')

    expect(homeDispatch).toContain(
      'PostCall(ws, seq, BoardOwner.Class.Long, "a homing cycle"',
    )
    expect(stopDispatch).toContain(
      'PostCall(ws, seq, BoardOwner.Class.StopNow, "emergencyStop"',
    )
    expect(stopDispatch).toContain('machine.EmergencyStop()')
  })

  it('pumps the stop queue from every active homing wait', () => {
    const waitHome = methodBody(machine, 'bool WaitHome(', 'bool WaitMoving(')
    const waitMoving = methodBody(machine, 'bool WaitMoving(', 'bool WaitSettled(')
    const waitSettled = methodBody(machine, 'bool WaitSettled(', 'bool WaitIdle(')
    const waitIdle = methodBody(machine, 'bool WaitIdle(', 'public Json.Obj Probe(')

    for (const body of [waitHome, waitMoving, waitSettled, waitIdle]) {
      expect(body).toContain('BoardOwner.Pump(')
      expect(body).toContain('BoardOwner.AbortRequested')
    }
  })
})
