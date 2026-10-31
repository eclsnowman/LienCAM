import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

// Test-only browser clock: production Play/seekTo/carving/rendering are intact.
// Each 33/34 ms step fires at least two 16 ms rAF ticks before the screenshot.
export async function deterministicTake(page, sequence, raw) {
  rmSync(raw, { recursive: true, force: true })
  mkdirSync(raw, { recursive: true })
  const origin = await page.evaluate(() => Date.now() / 1000)
  const frames = [], actions = []
  let current = null, pointer = { x: 1380, y: 900 }, priorMs = 0
  const lerp = (a, b, u) => ({ x: a.x + (b.x-a.x)*u, y: a.y + (b.y-a.y)*u })
  for (let frame = 0; frame < sequence.durationSeconds * 30; frame++) {
    const t = frame / 30
    const step = sequence.steps.find(s => t >= s.at && t < s.at + s.duration)
    if (step && !current) {
      const rect = await page.locator('.viewport-canvas').boundingBox()
      const point = p => ({ x: rect.x + rect.width*p[0], y: rect.y + rect.height*p[1] })
      let from, to
      if (step.finished && !await page.evaluate(() => {
        const s = document.querySelector('.sim-scrubber'), p = document.querySelector('.sim-panel')
        return +s.value >= +s.max-1 && p.dataset.stockSync === 'exact'
      })) throw new Error('Finished stock not reached before final orbit')
      if (step.action === 'orbit') { from = point(step.from); to = point(step.to) }
      else if (step.action === 'opacity') {
        const r = await page.getByTestId('sim-stock-opacity').boundingBox()
        from = { x: r.x+r.width-8, y: r.y+r.height/2 }; to = { x: r.x+8, y: from.y }
      } else if (step.action === 'zoom') from = to = { x: rect.x+rect.width/2, y: rect.y+rect.height/2 }
      else {
        const target = step.action === 'play' ? page.getByRole('button', { name: 'Play', exact: true }) : page.getByTestId('sim-display-compare')
        const r = await target.boundingBox(); from = to = { x:r.x+r.width/2, y:r.y+r.height/2 }
      }
      current = { ...step, began:t, pointerStart:pointer, from, to, down:false, applied:0, motion: null }
    }
    if (current) {
      const a = current, elapsed = t-a.at
      if (elapsed < .5) pointer = lerp(a.pointerStart, a.from, elapsed/.5)
      else {
        const u = Math.min(1, (elapsed-.5)/(a.duration-.5-1/30))
        pointer = lerp(a.from, a.to, u)
        if (['orbit','opacity'].includes(a.action) && !a.down) {
          await page.mouse.move(a.from.x,a.from.y); await page.mouse.down(); a.down = true
          a.motion = { beganWallTime: await page.evaluate(() => Date.now()/1000) }
        }
        if (a.action === 'zoom') {
          const amount = a.deltaY*u
          await page.mouse.wheel(0, amount-a.applied); a.applied=amount
          a.motion ??= { beganWallTime: await page.evaluate(() => Date.now()/1000) }
        }
        if (['play','compare'].includes(a.action) && !a.clicked && elapsed >= a.duration-.2) {
          await page.mouse.move(a.to.x,a.to.y); await page.mouse.down(); a.down=true; a.clicked=true
        }
      }
      await page.mouse.move(pointer.x,pointer.y)
      if (t+1/30 >= a.at+a.duration-1e-6) {
        if (a.motion) a.motion.endedWallTime = await page.evaluate(() => Date.now()/1000)
        if (a.down) await page.mouse.up()
        a.readback = await page.evaluate(() => ({ positionMs:+document.querySelector('.sim-scrubber').value, camera:window.__cncViewport.saveCameraState(), playing:!!document.querySelector('button[aria-label="Pause"]'), stockSync:document.querySelector('.sim-panel').dataset.stockSync, stockMs:+document.querySelector('.sim-panel').dataset.stockMs, comparePressed:document.querySelector('[data-testid="sim-display-compare"]').getAttribute('aria-pressed')==='true', opacity:window.__camStore.getState().viewer.stockSimOpacity }))
        a.ended=t+1/30; actions.push(a); current=null
      }
    }
    const nextMs = Math.round((frame+1)*1000/30)
    await page.clock.runFor(nextMs-priorMs); priorMs=nextMs
    const name = `frame-${String(frame+1).padStart(6,'0')}.jpg`
    await page.screenshot({ path:path.join(raw,name), type:'jpeg', quality:95, animations:'allow', timeout:30000 })
    frames.push({ name, timestamp:origin+frame/30 })
    if (frame%300===0) console.log('Deterministic frame',frame,'/',sequence.durationSeconds*30)
  }
  return { frames, actions }
}
