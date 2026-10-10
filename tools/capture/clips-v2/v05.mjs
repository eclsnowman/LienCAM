import { runClip } from './rehearse.mjs'
const result = await runClip('V05', process.argv[2] || process.env.CLIP_OUTPUT_DIR)
if (result.status !== 'PASS') process.exitCode = 1
