import { describe, expect, it } from 'vitest'
import { boundedCleanPath } from '../../lib/cam/adaptiveClearing2d/engine/boundedCleanPath'
import { cleanPath } from '../../lib/cam/adaptiveClearing2d/engine/geom'

const pointSegmentDistance = (p: {x:number;y:number}, a: {x:number;y:number}, b: {x:number;y:number}) => {
  const dx = b.x-a.x, dy = b.y-a.y, l = dx*dx+dy*dy
  const t = l ? Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/l)) : 0
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)
}

describe('3D adaptive path cleanup preserves the sampled boundary', () => {
  it('bounds the whole source arc instead of accumulating a series of local merges', () => {
    const radius = 8, tolerance = 0.0125
    const source = Array.from({length:1001}, (_,i) => ({x:radius*Math.cos(i*Math.PI/2000),y:radius*Math.sin(i*Math.PI/2000)}))
    const maxError = (path: typeof source) => Math.max(...source.map(p =>
      Math.min(...path.slice(1).map((b,i) => pointSegmentDistance(p,path[i],b)))))
    // This is the failure mechanism observed on the uploaded dome.
    expect(maxError(cleanPath(source,tolerance))).toBeGreaterThan(tolerance*4)
    const result = boundedCleanPath(source,tolerance)
    expect(result.length).toBeLessThan(source.length)
    expect(maxError(result)).toBeLessThanOrEqual(tolerance+1e-12)
    expect(result[0]).toBe(source[0])
    expect(result.at(-1)).toBe(source.at(-1))
  })

  it('retains every protected nibble/transition sample and closes a loop exactly', () => {
    const source = Array.from({length:361},(_,i)=>({x:10*Math.cos(i*Math.PI/180),y:10*Math.sin(i*Math.PI/180)}))
    source[source.length-1] = source[0]
    const protectedPoints = new Set(source.slice(42,63))
    const result = boundedCleanPath(source,0.05,protectedPoints)
    for (const p of protectedPoints) expect(result.includes(p)).toBe(true)
    expect(result[0]).toBe(result.at(-1))
  })
})
