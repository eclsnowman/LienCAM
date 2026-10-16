// Capture-only copy: Full Suite now embeds our original release plate.
import fs from 'node:fs'
import { HELP_EVIDENCE } from './evidence-root.mjs'
export const demoProject = HELP_EVIDENCE + '/public-help-demo.camproject'
const source = JSON.parse(fs.readFileSync('Example Projects/Full Suite.camproject', 'utf8'))
const plate = source.geometry.find(g => g.name === 'Plate')
if (!plate || plate.filename !== 'plate.stl') throw new Error('Original release plate is missing')
const text = JSON.stringify(source)
if (text.includes('obj_1_Platte C')) throw new Error('Excluded mesh reference remains')
fs.writeFileSync(demoProject, text)
