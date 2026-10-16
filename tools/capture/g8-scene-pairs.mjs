import sharp from 'sharp'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const out = 'src/tests/evidence/WO-2848/round2'
const git = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { maxBuffer: 1 << 26 })
const stats = async (a, b) => {
  const [x, y] = await Promise.all([a, b].map(buf => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })))
  let n = 0
  for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 24) n++
  return { changedPixels: n, percent: +(100 * n / (x.info.width * x.info.height)).toFixed(3) }
}
const label = (text, w) => Buffer.from(`<svg width="${w}" height="60"><rect width="100%" height="100%" fill="#12161c"/><text x="20" y="42" font-size="34" font-family="Arial" fill="#eef0f3">${text}</text></svg>`)
const scores = {}
for (const id of ['S02','S03','S04','S05','S06','S07','S08','S09','S10','S11','S12','S13','S14','S15','S16','SP']) {
  const after = fs.readFileSync(`docs/media/${id}.png`)
  scores[id] = { vsMainAlpha1: await stats(git('main', `docs/media/${id}.png`), after), vsBranchHead: await stats(git('HEAD', `docs/media/${id}.png`), after) }
}
fs.writeFileSync(`${out}/scores.json`, JSON.stringify(scores, null, 2) + '\n')
for (const id of ['S02', 'S08', 'S09']) {
  const before = git('main', `docs/media/${id}.png`), after = fs.readFileSync(`docs/media/${id}.png`)
  const { width: w, height: h } = await sharp(after).metadata()
  await sharp({ create: { width: w * 2 + 20, height: h + 60, channels: 3, background: '#12161c' } })
    .composite([{ input: label(`${id} BEFORE (main = alpha.1 / committed)`, w), left: 0, top: 0 }, { input: before, left: 0, top: 60 },
      { input: label(`${id} AFTER (fix round 2, one run, build da49f09f54)`, w), left: w + 20, top: 0 }, { input: after, left: w + 20, top: 60 }])
    .png().toFile(`${out}/${id}-pair.png`)
}
console.log(JSON.stringify(scores))
