'use strict'

// WO-2883: semver precedence for the main-process update route. Same rules as
// src/lib/update/releaseCheck.ts compareVersions (the renderer's WO-2720 check);
// src/tests/lib/update/updateVersion.wo2883.test.ts holds the two to one table.

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(value))
  if (!match) return null
  const pre = match[4] ? match[4].split('.') : []
  if (pre.some((id) => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) return null
  return { core: match.slice(1, 4), pre }
}

// Compare decimal strings without losing precision on long numeric identifiers.
function compareNumeric(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/** Semver precedence; build metadata has no effect; null when either side is invalid. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i], right.core[i])
    if (order) return order
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    return nx && ny ? compareNumeric(x, y) : nx !== ny ? (nx ? -1 : 1) : x < y ? -1 : 1
  }
  return 0
}

module.exports = { compareVersions }
