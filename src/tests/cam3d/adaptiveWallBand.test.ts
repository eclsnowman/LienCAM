import { beforeAll, describe, expect, it } from 'vitest'
import { processFeature } from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { difference, ensureEngineClipperReady, netArea, offsetClosed, offsetOpenRound } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildSideEntrySeed } from '../../cam3d/rough/sideSeed'
import { loopToRing } from '../../cam3d/rough/convert'
import { ensureGeom2dReady } from '../../cam3d/geom2d'

beforeAll(async()=>{await Promise.all([ensureEngineClipperReady(),ensureGeom2dReady()])})

describe('3D adaptive wall-band ownership', () => {
  for (const millingDirection of ['climb','conventional'] as const) {
    it(`clears the square perimeter once in ${millingDirection} direction`, () => {
      const stock=[{x:-5,y:-5},{x:45,y:-5},{x:45,y:45},{x:-5,y:45}]
      const part=[{x:0,y:0},{x:40,y:0},{x:40,y:40},{x:0,y:40}]
      const radius=4.76, arcTol=0.00625
      const feature={boundary:offsetClosed([stock],2*radius,arcTol)[0],holes:[offsetClosed([part],0.05,0.001)[0].reverse()]}
      const result=processFeature(feature,{
        toolRadius:radius,stepOver:0.4,tolerance:0.05,arcTol,helixDiameter:3,
        millingDirection,wallFinish:true,singleWallPass:true,boundedPathCleanup:true,
        wallCleanupAsWeGo:true,integralWallFollow:true,landingUncutCap:0,
        skipOuterBoundaryCleanup:true,clearedSeed:buildSideEntrySeed([loopToRing(stock)],radius),
      })
      expect(result.stats.aborted).toBeUndefined()
      expect(result.passes.some(pass=>pass.type==='finish')).toBe(false)
      let remaining=difference([stock],[part]),length=0,wallSegments=0
      const wallDistance=(p:{x:number;y:number})=>Math.hypot(Math.max(-p.x,0,p.x-40),Math.max(-p.y,0,p.y-40))
      for(const pass of result.passes) {
        if(!('points' in pass))continue
        if(pass.type==='cut'||pass.type==='wallfollow')remaining=difference(remaining,offsetOpenRound(pass.points,radius,0.001))
        if(pass.type==='link'&&pass.jumpType===2)continue
        for(let i=1;i<pass.points.length;i++) {
          const a=pass.points[i-1],b=pass.points[i]
          length+=Math.hypot(b.x-a.x,b.y-a.y)
          // Bulk cuts can peel away from the wall into remaining stock; their material
          // side is defined by that stock, not by winding about the retained model.
          // Check the wall rides and at-depth links that must retain wall direction.
          if(pass.type==='cut')continue
          if(Math.abs(wallDistance(a)-radius)>0.1||Math.abs(wallDistance(b)-radius)>0.1)continue
          const turn=Math.atan2(b.y-20,b.x-20)-Math.atan2(a.y-20,a.x-20)
          // WO-1896: climb keeps the retained part on the cutter's right -> clockwise around it.
          const signed=Math.atan2(Math.sin(turn),Math.cos(turn))*(millingDirection==='climb'?-1:1)
          expect(signed,`${pass.type} reverses along the wall: ${JSON.stringify({a,b,index:i})}`).toBeGreaterThanOrEqual(-1e-7)
          wallSegments++
        }
      }
      expect(wallSegments).toBeGreaterThan(20)
      // Only the explicit .05 mm model margin remains, not an uncleared band.
      expect(netArea(remaining)).toBeLessThan(9)
      expect(length).toBeLessThan(500)
      expect(result.stats.residualArea).toBeLessThan(0.1)
    },30000)
  }
})
