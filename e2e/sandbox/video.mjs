import { spawn } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'

// Electron's CDP screencast produced only a white startup frame in Sandbox.
// Sample the SAME page used for actions instead. Real step timings live in JSON;
// this is a 1 fps visual record, alongside the full Playwright action trace.
export async function startScreenVideo(page, outDir) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
  const directory = readdirSync(cache).find(name => name.startsWith('ffmpeg-'))
  const ffmpeg = spawn(path.join(cache, directory, 'ffmpeg-win64.exe'), [
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', '1', '-i', 'pipe:0',
    '-vf', 'scale=960:540', '-c:v', 'libvpx', '-y', path.join(outDir, 'desktop-journey.webm'),
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  const errors = []
  ffmpeg.stderr.on('data', chunk => errors.push(String(chunk)))
  const finished = once(ffmpeg, 'exit')
  let stopped = false, frames = 0
  const sampling = (async () => {
    while (!stopped) {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 })
      if (!ffmpeg.stdin.write(jpeg)) await once(ffmpeg.stdin, 'drain')
      frames++
      await new Promise(done => setTimeout(done, 1000))
    }
  })()
  // Attach a handler immediately so a recording error cannot become an
  // unhandled rejection during a long simulation. Stop still propagates it.
  const outcome = sampling.then(() => null, error => error)
  return async () => {
    stopped = true
    const error = await outcome
    ffmpeg.stdin.end()
    const [code] = await finished
    writeFileSync(path.join(outDir, 'video.json'), JSON.stringify({ frames, format: '1 fps sampled Playwright page screenshots', exit: code }, null, 2))
    writeFileSync(path.join(outDir, 'video.log'), errors.join('').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/[ \t]+$/gm, ''))
    if (error) throw error
    if (code !== 0 || frames < 2) throw new Error(`Video failed: ffmpeg ${code}, ${frames} frames`)
  }
}
